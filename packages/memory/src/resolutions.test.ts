import { Pool } from 'pg';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { runMigrations, withOwnerTransaction, type OwnerTransaction } from '@unai/postgres';
import { lintRegistryCheckout } from '@unai/registry';
import type { RequestContext, TransitionContract } from '@unai/domain';
import {
  MEMORY_PURPOSES, canonicalizeResolutionStatement, classifyResolutionStatement, createFrameInstance,
  frameOutcomeProjection, listMemoryLinks, listResolutionAssertions, readClaim, readResolutionAssertion,
  recordClaim, recordRealization, recordResolutionAssertion, resolveBeliefSlot, resolveEntity, resolveProposition,
  setResolutionLifecycle, sweepElapsedSchedules, validateTransition,
} from './index.js';

/** Resolution assertions, protocol links and the derived outcome projection over
 * real PostgreSQL, through the real owner boundary: every call below runs inside
 * `withOwnerTransaction` under the low-privilege application role, so the
 * row-level security policies of migration 0015 are part of what these tests
 * exercise.
 *
 * Covers CRT-OUT-01-B, CRT-OUT-02-A, CRT-OUT-03-A, CRT-OUT-04-A, CRT-OUT-05-A
 * and CRT-OUT-08-A.
 *
 * The transition contracts come from the pinned registry release itself, read out
 * of the checkout by the registry library, so "the outcome code must be one the
 * contract allows" is checked against the YAML in `registry/releases/0.1.0` and
 * not against a copy of it made here. */

if (!process.env.UNAI_TEST_DATABASE_URL) throw new Error('Run pnpm test for the required PostgreSQL harness');
const admin = new Pool({ connectionString: process.env.UNAI_TEST_DATABASE_URL });
const appUrl = new URL(process.env.UNAI_TEST_DATABASE_URL); appUrl.username = 'resolutions_test_app'; appUrl.password = 'test-only';
const appPool = new Pool({ connectionString: appUrl.href });

const owner = randomUUID(), actor = randomUUID();
const GOVERN = 'memory.govern';
let baseContextSpaceId = '', sourceItemId = '', transactionId = '', ownerEntityId = '', danielEntityId = '';
let released: TransitionContract[] = [];
const anchors: string[] = [];
let nextAnchor = 0;
const anchor = () => anchors[nextAnchor++]!;

/** Release 0.1.0 declares no PREDICTED-modality frame and no transition allowing
 * CONFIRMED, REFUTED or PARTIALLY_CONFIRMED, so the prediction-review contract
 * CRT-OUT-05-A needs does not exist in the pinned release. It is declared here in
 * the registry's own shape and supplied to the store the same way a pinned
 * release's contracts are; the gap in the release is reported as a finding
 * against the node that owns the registry contracts. The test below also asserts
 * that the *pinned* contracts refuse these codes, so the gap stays visible. */
const PREDICTION_REVIEW: TransitionContract = Object.freeze({
  id: 'shared.event_occurrence.prediction_review',
  linkKind: 'RESOLVES' as const,
  sourceFrameTypes: ['shared.event_occurrence'],
  targetFrameTypes: ['shared.event_occurrence'],
  targetRequired: false,
  allowedOutcomes: ['CONFIRMED' as const, 'REFUTED' as const, 'PARTIALLY_CONFIRMED' as const],
});
const contracts = () => [...released, PREDICTION_REVIEW];

beforeAll(async () => {
  await runMigrations(admin, resolve('migrations'));
  await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='resolutions_test_app') THEN CREATE ROLE resolutions_test_app LOGIN PASSWORD 'test-only'; END IF; END $$; GRANT unai_app TO resolutions_test_app");
  await admin.query('INSERT INTO users(id,display_name) VALUES($1,$2)', [actor, 'Resolution owner']);
  await admin.query("INSERT INTO owner_scopes(id,scope_kind,display_name,created_by_user_id) VALUES($1,'PERSONAL','Resolutions',$2)", [owner, actor]);
  await admin.query("INSERT INTO owner_scope_members(owner_scope_id,user_id,role) VALUES($1,$2,'OWNER')", [owner, actor]);
  baseContextSpaceId = (await admin.query('SELECT id FROM context_spaces WHERE owner_scope_id=$1', [owner])).rows[0].id;

  const connectorId = randomUUID(); sourceItemId = randomUUID();
  await admin.query("INSERT INTO connectors(id,owner_scope_id,connector_type,external_account_ref,permission_manifest,status) VALUES($1,$2,'CONVERSATION',$3,'{}','ACTIVE')", [connectorId, owner, owner]);
  await admin.query(`INSERT INTO source_items(id,owner_scope_id,connector_id,source_type,external_id,actor_ref,submitted_by_user_id,
    raw_object_ref,content_hash,sensitivity,allowed_purposes,ingestion_version,idempotency_key)
    VALUES($1,$2,$3,'CONVERSATION','message-1',$4,$5,$6,$7,'PRIVATE',ARRAY['PERSONAL_ASSISTANCE'],'evidence-json-v1',$8)`,
    [sourceItemId, owner, connectorId, JSON.stringify({ type: 'USER', id: actor }), actor, randomUUID(), 'a'.repeat(64), randomUUID()]);
  for (let index = 0; index < 40; index += 1) {
    const id = randomUUID(); anchors.push(id);
    await admin.query(`INSERT INTO source_anchors(id,owner_scope_id,source_item_id,anchor_kind,anchor)
      VALUES($1,$2,$3,'MESSAGE_SPAN',$4)`, [id, owner, sourceItemId, JSON.stringify({ start: index * 10, end: index * 10 + 9 })]);
  }
  transactionId = randomUUID();
  await admin.query(`INSERT INTO belief_transactions(id,owner_scope_id,transaction_kind,requested_by_actor_id,
    source_evidence_ids,registry_release_id,status,risk,idempotency_key,commit_receipt,committed_at)
    VALUES($1,$2,'RESOLVE',$3,ARRAY[$4::uuid],$5,'COMMITTED','LOW',$6,'{}',now())`,
    [transactionId, owner, actor, sourceItemId, randomUUID(), randomUUID().replaceAll('-', '')]);

  released = [...(await lintRegistryCheckout({ repository: resolve('.'), version: '0.1.0' })).transitions];
  ownerEntityId = await person('Resolution Owner', 'owner.resolution@example.test');
  danielEntityId = await person('Daniel Resolution', 'daniel.resolution@example.test');
});
afterAll(async () => { await appPool.end(); await admin.end(); });

function context(purpose: string): RequestContext { return { actorId: actor, ownerScopeId: owner, purpose, correlationId: randomUUID() }; }
function as<T>(purpose: string, run: (tx: OwnerTransaction) => Promise<T>) { return withOwnerTransaction(appPool, context(purpose), run); }
const write = <T,>(run: (tx: OwnerTransaction) => Promise<T>) => as(MEMORY_PURPOSES.canonicalize, run);
const govern = <T,>(run: (tx: OwnerTransaction) => Promise<T>) => as(GOVERN, run);
const read = <T,>(run: (tx: OwnerTransaction) => Promise<T>) => as(MEMORY_PURPOSES.inspect, run);

async function person(label: string, mailbox: string): Promise<string> {
  const resolved = await write(tx => resolveEntity(tx, {
    ownerScopeId: owner, entityKind: 'PERSON', canonicalLabel: label,
    aliases: [{ aliasType: 'EMAIL', aliasValue: mailbox }, { aliasType: 'DISPLAY_NAME', aliasValue: label }],
  }));
  return resolved.entityId;
}

const frame = (frameTypeId: string) => write(tx => createFrameInstance(tx, {
  ownerScopeId: owner, frameTypeId, contextSpaceId: baseContextSpaceId,
}));

/** One value in one slot of one instance, with the claim that asserted it. */
async function statedValue(input: {
  frameInstanceId: string; predicateId: string; modality: 'ACTUAL' | 'SCHEDULED' | 'PREDICTED' | 'COMMITTED';
  value: unknown; validFrom?: Date;
}): Promise<{ beliefSlotId: string; propositionId: string; claimId: string }> {
  return write(async tx => {
    const slot = await resolveBeliefSlot(tx, {
      ownerScopeId: owner,
      descriptor: {
        frameInstanceId: input.frameInstanceId, predicateId: input.predicateId,
        contextSpaceId: baseContextSpaceId, modality: input.modality, qualifiers: {},
      },
    });
    const proposition = await resolveProposition(tx, {
      ownerScopeId: owner, beliefSlotId: slot.beliefSlotId, normalizedValue: input.value,
    });
    const claimId = await recordClaim(tx, {
      ownerScopeId: owner, sourceAnchorId: anchor(), claimOrigin: 'STRUCTURED_CONNECTOR_OBSERVATION',
      lifecycle: 'PROVISIONAL', propositionId: proposition.propositionId,
      validFrom: input.validFrom ?? null,
    });
    return { beliefSlotId: slot.beliefSlotId, propositionId: proposition.propositionId, claimId };
  });
}

const countSlots = async () => Number((await admin.query('SELECT count(*)::int AS n FROM belief_slots WHERE owner_scope_id=$1', [owner])).rows[0].n);
const countPropositions = async () => Number((await admin.query('SELECT count(*)::int AS n FROM propositions WHERE owner_scope_id=$1', [owner])).rows[0].n);

it('CRT-OUT-01-B: "It is settled", "I completed it" and "The meeting was cancelled" canonicalize as resolution assertions and create no status slot', async () => {
  const obligation = await frame('shared.obligation');
  const commitment = await frame('shared.commitment');
  const meeting = await frame('shared.event_occurrence');
  const effectiveAt = new Date('2026-03-04T10:00:00Z');

  const slotsBefore = await countSlots(), propositionsBefore = await countPropositions();
  const cases = [
    { statement: 'It is settled', frameInstanceId: obligation, frameTypeId: 'shared.obligation', contract: 'shared.obligation.resolution', outcome: 'FULFILLED' },
    { statement: 'I completed it', frameInstanceId: commitment, frameTypeId: 'shared.commitment', contract: 'shared.commitment.resolution', outcome: 'FULFILLED' },
    { statement: 'The meeting was cancelled', frameInstanceId: meeting, frameTypeId: 'shared.event_occurrence', contract: 'shared.event_occurrence.resolution', outcome: 'CANCELLED' },
  ] as const;

  for (const one of cases) {
    const canonicalized = await write(tx => canonicalizeResolutionStatement(tx, {
      ownerScopeId: owner, sourceFrameInstanceId: one.frameInstanceId, sourceFrameTypeId: one.frameTypeId,
      statement: one.statement, sourceAnchorId: anchor(), claimOrigin: 'USER_STATEMENT',
      assertedByEntityId: ownerEntityId, effectiveAt,
      transitionContractId: one.contract, transitionContracts: contracts(),
    }));
    expect(canonicalized.reading?.outcomeCode, one.statement).toBe(one.outcome);
    expect(canonicalized.createdStatusSlot).toBe(false);
    const stored = await read(tx => readResolutionAssertion(tx, { ownerScopeId: owner, resolutionAssertionId: canonicalized.resolutionAssertionId }));
    expect(stored, one.statement).toMatchObject({
      sourceFrameInstanceId: one.frameInstanceId, outcomeCode: one.outcome,
      transitionContractId: one.contract, claimId: canonicalized.claimId, lifecycle: 'PROPOSED',
    });
    // The claim is the assertion that the outcome happened. It carries no
    // proposition, because there is no slot for an outcome to be a value in.
    const claim = await read(tx => readClaim(tx, { ownerScopeId: owner, claimId: canonicalized.claimId }));
    expect(claim?.propositionId, one.statement).toBeNull();
    expect(claim?.candidateFrameTypeId).toBe(one.frameTypeId);
  }

  // The whole point of CRT-OUT-01-B: three outcome statements, and not one new
  // slot or proposition anywhere in this owner scope.
  expect(await countSlots()).toBe(slotsBefore);
  expect(await countPropositions()).toBe(propositionsBefore);
  const statusish = (await admin.query(
    `SELECT predicate_id FROM belief_slots WHERE owner_scope_id=$1 AND predicate_id ~ '(status|state|outcome|resolution|settled|cancelled|completed|done)'`,
    [owner])).rows;
  expect(statusish).toEqual([]);
});

it('CRT-OUT-01-B: a negated or future statement is not read as an outcome', async () => {
  // Reading "It is not settled" as FULFILLED would invent the very outcome the
  // sentence denies, and "I will complete it" is a commitment, not a completion
  // (PRD §12.6, §58).
  for (const statement of ['It is not settled', 'I will complete it', 'I am considering cancelling the meeting', 'It has not been paid back']) {
    expect(classifyResolutionStatement(statement), statement).toBeNull();
  }
  const obligation = await frame('shared.obligation');
  await expect(write(tx => canonicalizeResolutionStatement(tx, {
    ownerScopeId: owner, sourceFrameInstanceId: obligation, sourceFrameTypeId: 'shared.obligation',
    statement: 'It is not settled', sourceAnchorId: anchor(), claimOrigin: 'USER_STATEMENT',
    assertedByEntityId: ownerEntityId, effectiveAt: new Date('2026-03-04T10:00:00Z'),
    transitionContractId: 'shared.obligation.resolution', transitionContracts: contracts(),
  }))).rejects.toThrow('RESOLUTION_STATEMENT_UNRECOGNIZED');
  expect(await read(tx => listResolutionAssertions(tx, { ownerScopeId: owner, sourceFrameInstanceId: obligation }))).toEqual([]);
});

it('CRT-OUT-02-A: "It is settled; I paid him in cash" creates a resolution assertion with a source obligation frame, null target, outcome FULFILLED and a required claim ID', async () => {
  const obligation = await frame('shared.obligation');
  const principal = await statedValue({
    frameInstanceId: obligation, predicateId: 'shared.obligation.principal_amount',
    modality: 'ACTUAL', value: { amount: '50.00', currency: 'ILS' },
  });
  const effectiveAt = new Date('2026-03-05T08:30:00Z');

  const canonicalized = await write(tx => canonicalizeResolutionStatement(tx, {
    ownerScopeId: owner, sourceFrameInstanceId: obligation, sourceFrameTypeId: 'shared.obligation',
    statement: 'It is settled; I paid him in cash', sourceAnchorId: anchor(), claimOrigin: 'USER_STATEMENT',
    assertedByEntityId: ownerEntityId, effectiveAt,
    transitionContractId: 'shared.obligation.resolution', transitionContracts: contracts(),
  }));

  const stored = await read(tx => readResolutionAssertion(tx, { ownerScopeId: owner, resolutionAssertionId: canonicalized.resolutionAssertionId }));
  expect(stored).toMatchObject({
    sourceFrameInstanceId: obligation,
    targetFrameInstanceId: null, targetPropositionId: null,
    outcomeCode: 'FULFILLED', transitionContractId: 'shared.obligation.resolution',
    assertedByEntityId: ownerEntityId, effectiveAt: effectiveAt.toISOString(),
  });
  // Claim required (PRD §33.8): the id is on the row and it resolves to the claim
  // that said it, carrying the clause that said how.
  expect(stored?.claimId).toBe(canonicalized.claimId);
  const claim = await read(tx => readClaim(tx, { ownerScopeId: owner, claimId: stored!.claimId }));
  expect(claim?.claimOrigin).toBe('USER_STATEMENT');
  expect((claim?.metadata as Record<string, Record<string, unknown>>)['resolutionStatement']).toMatchObject({
    statement: 'It is settled; I paid him in cash', supportingDetail: 'I paid him in cash', outcomeCode: 'FULFILLED',
  });
  // Target-less means no realizing object, so the assertion is the subject of its
  // own RESOLVES link.
  const links = await read(tx => listMemoryLinks(tx, {
    ownerScopeId: owner, object: { objectType: 'frame_instance', objectId: obligation }, linkKind: 'RESOLVES', direction: 'TO',
  }));
  expect(links).toHaveLength(1);
  expect(links[0]).toMatchObject({
    fromObjectType: 'resolution_assertion', fromObjectId: canonicalized.resolutionAssertionId,
    toObjectType: 'frame_instance', toObjectId: obligation, linkKind: 'RESOLVES',
    transitionContractId: 'shared.obligation.resolution',
  });
  // The obligation it settles is untouched: same slot, same proposition, same claim.
  const after = (await admin.query('SELECT * FROM propositions WHERE owner_scope_id=$1 AND id=$2', [owner, principal.propositionId])).rows[0];
  expect(after.belief_slot_id).toBe(principal.beliefSlotId);
  expect(await read(tx => readClaim(tx, { ownerScopeId: owner, claimId: principal.claimId }))).toMatchObject({
    propositionId: principal.propositionId, lifecycle: 'PROVISIONAL',
  });
});

it('CRT-OUT-03-A: a calendar event stays SCHEDULED, attendance creates an actual occurrence with REALIZES and RESOLVES (OCCURRED) links, a cancellation creates a CANCELLED resolution, and an elapsed calendar event creates no occurrence', async () => {
  const scheduledFor = new Date('2026-04-07T10:00:00Z');
  const attended = await frame('shared.event_occurrence');
  const schedule = await statedValue({
    frameInstanceId: attended, predicateId: 'shared.event_occurrence.occurrence_time',
    modality: 'SCHEDULED', value: { start: scheduledFor.toISOString(), end: null }, validFrom: scheduledFor,
  });

  // A calendar event proves SCHEDULED and nothing else (PRD §59).
  const scheduledSlot = (await admin.query('SELECT modality FROM belief_slots WHERE owner_scope_id=$1 AND id=$2', [owner, schedule.beliefSlotId])).rows[0];
  expect(scheduledSlot.modality).toBe('SCHEDULED');
  expect(await read(tx => frameOutcomeProjection(tx, { ownerScopeId: owner, frameInstanceId: attended }))).toMatchObject({ state: 'UNRESOLVED' });

  // The user confirms attendance. The actual occurrence is a separate instance
  // (the registry's own newInstanceSignals say so), and it realizes and resolves
  // the scheduled event instead of rewriting it.
  const actual = await frame('shared.event_occurrence');
  await statedValue({
    frameInstanceId: actual, predicateId: 'shared.event_occurrence.occurrence_time',
    modality: 'ACTUAL', value: { start: scheduledFor.toISOString(), end: null }, validFrom: scheduledFor,
  });
  const realization = await write(tx => recordRealization(tx, {
    ownerScopeId: owner, sourceFrameInstanceId: attended, sourceFrameTypeId: 'shared.event_occurrence',
    actualFrameInstanceId: actual, actualFrameTypeId: 'shared.event_occurrence',
    transitionContractId: 'shared.event_occurrence.realization', transitionContracts: contracts(),
  }));
  const attendanceClaim = await write(tx => recordClaim(tx, {
    ownerScopeId: owner, sourceAnchorId: anchor(), claimOrigin: 'USER_CONFIRMATION', lifecycle: 'CANDIDATE',
    propositionId: null, candidateFrameTypeId: 'shared.event_occurrence',
  }));
  const occurred = await write(tx => recordResolutionAssertion(tx, {
    ownerScopeId: owner, sourceFrameInstanceId: attended, sourceFrameTypeId: 'shared.event_occurrence',
    targetFrameInstanceId: actual, targetFrameTypeId: 'shared.event_occurrence',
    outcomeCode: 'OCCURRED', effectiveAt: scheduledFor, assertedByEntityId: ownerEntityId, claimId: attendanceClaim,
    transitionContractId: 'shared.event_occurrence.resolution', transitionContracts: contracts(),
  }));

  const linksToSchedule = await read(tx => listMemoryLinks(tx, {
    ownerScopeId: owner, object: { objectType: 'frame_instance', objectId: attended }, direction: 'TO',
  }));
  expect(linksToSchedule.map(link => link.linkKind).sort()).toEqual(['REALIZES', 'RESOLVES']);
  expect(linksToSchedule.every(link => link.fromObjectId === actual)).toBe(true);
  expect(linksToSchedule.find(link => link.linkKind === 'REALIZES')!.memoryLinkId).toBe(realization.memoryLinkId);
  expect(await read(tx => readResolutionAssertion(tx, { ownerScopeId: owner, resolutionAssertionId: occurred.resolutionAssertionId })))
    .toMatchObject({ outcomeCode: 'OCCURRED', targetFrameInstanceId: actual, sourceFrameInstanceId: attended });

  // The scheduled event is still scheduled: realization never rewrites the source
  // (PRD §16.3, registry invariant).
  expect((await admin.query('SELECT modality FROM belief_slots WHERE owner_scope_id=$1 AND id=$2', [owner, schedule.beliefSlotId])).rows[0].modality).toBe('SCHEDULED');
  expect((await admin.query('SELECT count(*)::int AS n FROM belief_slots WHERE owner_scope_id=$1 AND frame_instance_id=$2', [owner, attended])).rows[0].n).toBe(1);

  // A calendar cancellation resolves a different event as CANCELLED, with no target.
  const cancelled = await frame('shared.event_occurrence');
  const cancelledSchedule = await statedValue({
    frameInstanceId: cancelled, predicateId: 'shared.event_occurrence.occurrence_time',
    modality: 'SCHEDULED', value: { start: '2026-04-08T10:00:00Z', end: null }, validFrom: new Date('2026-04-08T10:00:00Z'),
  });
  const cancellation = await write(tx => canonicalizeResolutionStatement(tx, {
    ownerScopeId: owner, sourceFrameInstanceId: cancelled, sourceFrameTypeId: 'shared.event_occurrence',
    statement: 'The meeting was cancelled', sourceAnchorId: anchor(),
    claimOrigin: 'STRUCTURED_CONNECTOR_OBSERVATION', assertedByEntityId: ownerEntityId,
    effectiveAt: new Date('2026-04-06T09:00:00Z'),
    transitionContractId: 'shared.event_occurrence.resolution', transitionContracts: contracts(),
  }));
  expect(await read(tx => readResolutionAssertion(tx, { ownerScopeId: owner, resolutionAssertionId: cancellation.resolutionAssertionId })))
    .toMatchObject({ outcomeCode: 'CANCELLED', targetFrameInstanceId: null });
  expect(cancelledSchedule.beliefSlotId).toBeTruthy();

  // A third event is simply left on the calendar. Its date passes and nothing
  // happens: no occurrence, no resolution, and the sweep says so in as many words.
  const ignored = await frame('shared.event_occurrence');
  await statedValue({
    frameInstanceId: ignored, predicateId: 'shared.event_occurrence.occurrence_time',
    modality: 'SCHEDULED', value: { start: '2026-04-09T10:00:00Z', end: null }, validFrom: new Date('2026-04-09T10:00:00Z'),
  });
  const sweep = await read(tx => sweepElapsedSchedules(tx, {
    ownerScopeId: owner, asOf: new Date('2026-05-01T00:00:00Z'), frameTypeId: 'shared.event_occurrence',
  }));
  expect(sweep.occurrencesCreated).toBe(0);
  expect(sweep.resolutionsCreated).toBe(0);
  const elapsedIgnored = sweep.elapsed.find(entry => entry.frameInstanceId === ignored);
  expect(elapsedIgnored).toBeDefined();
  expect(elapsedIgnored!.realizingFrameInstanceIds).toEqual([]);
  expect(elapsedIgnored!.outcome.state).toBe('UNRESOLVED');
  expect(await read(tx => listResolutionAssertions(tx, { ownerScopeId: owner, sourceFrameInstanceId: ignored }))).toEqual([]);
  // No ACTUAL occurrence was conjured for it anywhere in the owner scope.
  expect((await admin.query(
    `SELECT count(*)::int AS n FROM belief_slots WHERE owner_scope_id=$1 AND frame_instance_id=$2 AND modality='ACTUAL'`,
    [owner, ignored])).rows[0].n).toBe(0);
});

it('CRT-OUT-04-A: a resolution whose outcome the referenced transition contract does not allow, or that references no transition contract, is refused', async () => {
  const obligation = await frame('shared.obligation');
  const claimId = await write(tx => recordClaim(tx, {
    ownerScopeId: owner, sourceAnchorId: anchor(), claimOrigin: 'USER_STATEMENT', lifecycle: 'CANDIDATE',
    propositionId: null, candidateFrameTypeId: 'shared.obligation',
  }));
  const base = {
    ownerScopeId: owner, sourceFrameInstanceId: obligation, sourceFrameTypeId: 'shared.obligation',
    effectiveAt: new Date('2026-03-06T12:00:00Z'), assertedByEntityId: ownerEntityId, claimId,
    transitionContracts: contracts(),
  } as const;

  // MISSED is a real V0 outcome code -- for a scheduled event. The obligation
  // resolution contract allows FULFILLED, PARTIALLY_FULFILLED, WAIVED, CANCELLED.
  await expect(write(tx => recordResolutionAssertion(tx, {
    ...base, outcomeCode: 'MISSED', transitionContractId: 'shared.obligation.resolution',
  }))).rejects.toThrow('TRANSITION_OUTCOME_REFUSED');
  // The same code the prediction contract allows is refused under the pinned
  // release's contracts, which is what makes the missing prediction contract a
  // gap rather than a workaround.
  for (const outcomeCode of ['CONFIRMED', 'REFUTED', 'PARTIALLY_CONFIRMED'] as const) {
    await expect(write(tx => recordResolutionAssertion(tx, {
      ...base, outcomeCode, transitionContractId: 'shared.obligation.resolution', transitionContracts: released,
    })), outcomeCode).rejects.toThrow('TRANSITION_OUTCOME_REFUSED');
  }
  // No transition contract at all.
  for (const transitionContractId of [null, undefined, '']) {
    await expect(write(tx => recordResolutionAssertion(tx, {
      ...base, outcomeCode: 'FULFILLED', transitionContractId: transitionContractId as unknown as string,
    })), String(transitionContractId)).rejects.toThrow(/TRANSITION_CONTRACT_REQUIRED|invalid/i);
  }
  // A contract the pinned release does not contain, and one that governs the
  // wrong link kind, are both refused rather than treated as permissive.
  await expect(write(tx => recordResolutionAssertion(tx, {
    ...base, outcomeCode: 'FULFILLED', transitionContractId: 'shared.obligation.forgiveness',
  }))).rejects.toThrow('TRANSITION_CONTRACT_UNKNOWN');
  await expect(write(tx => recordResolutionAssertion(tx, {
    ...base, outcomeCode: 'FULFILLED', transitionContractId: 'shared.event_occurrence.realization',
  }))).rejects.toThrow('TRANSITION_LINK_KIND_REFUSED');
  // A source frame type the contract does not govern.
  await expect(write(tx => recordResolutionAssertion(tx, {
    ...base, sourceFrameTypeId: 'shared.commitment', outcomeCode: 'FULFILLED',
    transitionContractId: 'shared.obligation.resolution',
  }))).rejects.toThrow('TRANSITION_SOURCE_FRAME_TYPE_REFUSED');
  // A target the contract does not govern: the obligation resolution takes a
  // payment allocation, never a commitment.
  const otherCommitment = await frame('shared.commitment');
  await expect(write(tx => recordResolutionAssertion(tx, {
    ...base, outcomeCode: 'FULFILLED', transitionContractId: 'shared.obligation.resolution',
    targetFrameInstanceId: otherCommitment, targetFrameTypeId: 'shared.commitment',
  }))).rejects.toThrow('TRANSITION_TARGET_FRAME_TYPE_REFUSED');
  // A realization with no target at all, where the contract requires one.
  expect(() => validateTransition({
    transitionContractId: 'shared.event_occurrence.realization', transitionContracts: contracts(),
    linkKind: 'REALIZES', sourceFrameTypeId: 'shared.event_occurrence', targetFrameTypeId: null,
  })).toThrow('TRANSITION_TARGET_REQUIRED');

  // Every refusal above left nothing behind: no assertion, and no orphan link.
  expect(await read(tx => listResolutionAssertions(tx, { ownerScopeId: owner, sourceFrameInstanceId: obligation }))).toEqual([]);
  expect(await read(tx => listMemoryLinks(tx, {
    ownerScopeId: owner, object: { objectType: 'frame_instance', objectId: obligation },
  }))).toEqual([]);
});

it('CRT-OUT-05-A: a predicted release date and its claims remain unchanged and retrievable after a CONFIRMED, REFUTED or PARTIALLY_CONFIRMED resolution', async () => {
  for (const outcomeCode of ['CONFIRMED', 'REFUTED', 'PARTIALLY_CONFIRMED'] as const) {
    const predicted = await frame('shared.event_occurrence');
    const prediction = await statedValue({
      frameInstanceId: predicted, predicateId: 'shared.event_occurrence.occurrence_time',
      modality: 'PREDICTED', value: { start: '2026-06-01T00:00:00Z', end: null },
      validFrom: new Date('2026-06-01T00:00:00Z'),
    });
    const before = {
      proposition: (await admin.query('SELECT * FROM propositions WHERE owner_scope_id=$1 AND id=$2', [owner, prediction.propositionId])).rows[0],
      slot: (await admin.query('SELECT * FROM belief_slots WHERE owner_scope_id=$1 AND id=$2', [owner, prediction.beliefSlotId])).rows[0],
      claims: (await admin.query('SELECT * FROM claims WHERE owner_scope_id=$1 AND proposition_id=$2 ORDER BY id', [owner, prediction.propositionId])).rows,
    };

    // The actual release is its own occurrence; it realizes the prediction and
    // then resolves it. Neither write touches the predicted proposition.
    const actual = await frame('shared.event_occurrence');
    await statedValue({
      frameInstanceId: actual, predicateId: 'shared.event_occurrence.occurrence_time',
      modality: 'ACTUAL', value: { start: '2026-06-14T00:00:00Z', end: null },
      validFrom: new Date('2026-06-14T00:00:00Z'),
    });
    await write(tx => recordRealization(tx, {
      ownerScopeId: owner, sourceFrameInstanceId: predicted, sourceFrameTypeId: 'shared.event_occurrence',
      actualFrameInstanceId: actual, actualFrameTypeId: 'shared.event_occurrence',
      transitionContractId: 'shared.event_occurrence.realization', transitionContracts: contracts(),
    }));
    const reviewClaim = await write(tx => recordClaim(tx, {
      ownerScopeId: owner, sourceAnchorId: anchor(), claimOrigin: 'TOOL_EXECUTION_RECEIPT', lifecycle: 'CANDIDATE',
      propositionId: null, candidateFrameTypeId: 'shared.event_occurrence',
    }));
    const review = await write(tx => recordResolutionAssertion(tx, {
      ownerScopeId: owner, sourceFrameInstanceId: predicted, sourceFrameTypeId: 'shared.event_occurrence',
      sourcePropositionId: prediction.propositionId,
      targetFrameInstanceId: actual, targetFrameTypeId: 'shared.event_occurrence',
      outcomeCode, effectiveAt: new Date('2026-06-14T00:00:00Z'), assertedByEntityId: ownerEntityId,
      claimId: reviewClaim, transitionContractId: PREDICTION_REVIEW.id, transitionContracts: contracts(),
    }));
    await govern(tx => setResolutionLifecycle(tx, {
      ownerScopeId: owner, resolutionAssertionId: review.resolutionAssertionId,
      lifecycle: 'ACCEPTED', transactionId,
    }));

    // Unchanged: every column of the slot, the proposition and every claim.
    expect((await admin.query('SELECT * FROM propositions WHERE owner_scope_id=$1 AND id=$2', [owner, prediction.propositionId])).rows[0], outcomeCode)
      .toEqual(before.proposition);
    expect((await admin.query('SELECT * FROM belief_slots WHERE owner_scope_id=$1 AND id=$2', [owner, prediction.beliefSlotId])).rows[0], outcomeCode)
      .toEqual(before.slot);
    expect((await admin.query('SELECT * FROM claims WHERE owner_scope_id=$1 AND proposition_id=$2 ORDER BY id', [owner, prediction.propositionId])).rows, outcomeCode)
      .toEqual(before.claims);
    // Retrievable: the PREDICTED proposition still reads back through the store,
    // still in its own slot, still with its claim.
    const claim = await read(tx => readClaim(tx, { ownerScopeId: owner, claimId: prediction.claimId }));
    expect(claim?.propositionId, outcomeCode).toBe(prediction.propositionId);
    expect(before.slot.modality).toBe('PREDICTED');
    // A partially confirmed prediction is partially resolved; the other two
    // settle the review (PRD §16.6).
    expect(await read(tx => frameOutcomeProjection(tx, { ownerScopeId: owner, frameInstanceId: predicted })), outcomeCode)
      .toMatchObject({
        state: outcomeCode === 'PARTIALLY_CONFIRMED' ? 'PARTIALLY_RESOLVED' : 'RESOLVED',
        acceptedOutcomes: [outcomeCode],
      });
  }
});

it('CRT-OUT-08-A: a frame outcome reads UNRESOLVED, PARTIALLY_RESOLVED, RESOLVED and CONTESTED from its accepted resolutions', async () => {
  const accept = async (input: {
    frameInstanceId: string; frameTypeId: string; contract: string; outcomeCode: 'FULFILLED' | 'PARTIALLY_FULFILLED' | 'CANCELLED' | 'WAIVED';
  }) => {
    const claimId = await write(tx => recordClaim(tx, {
      ownerScopeId: owner, sourceAnchorId: anchor(), claimOrigin: 'USER_STATEMENT', lifecycle: 'CANDIDATE',
      propositionId: null, candidateFrameTypeId: input.frameTypeId,
    }));
    const recorded = await write(tx => recordResolutionAssertion(tx, {
      ownerScopeId: owner, sourceFrameInstanceId: input.frameInstanceId, sourceFrameTypeId: input.frameTypeId,
      outcomeCode: input.outcomeCode, effectiveAt: new Date('2026-03-10T12:00:00Z'),
      assertedByEntityId: danielEntityId, claimId,
      transitionContractId: input.contract, transitionContracts: contracts(),
    }));
    return govern(tx => setResolutionLifecycle(tx, {
      ownerScopeId: owner, resolutionAssertionId: recorded.resolutionAssertionId, lifecycle: 'ACCEPTED', transactionId,
    }));
  };
  const projection = (frameInstanceId: string) => read(tx => frameOutcomeProjection(tx, { ownerScopeId: owner, frameInstanceId }));

  // No accepted resolution at all.
  const unresolved = await frame('shared.obligation');
  expect(await projection(unresolved)).toMatchObject({ state: 'UNRESOLVED', acceptedOutcomes: [], conflictingOutcomes: [] });

  // A proposed resolution is not an accepted one: proposing must not move the
  // projection, or the model would be deciding outcomes (PRD §19.1).
  const proposedOnly = await frame('shared.obligation');
  await write(tx => canonicalizeResolutionStatement(tx, {
    ownerScopeId: owner, sourceFrameInstanceId: proposedOnly, sourceFrameTypeId: 'shared.obligation',
    statement: 'It is settled', sourceAnchorId: anchor(), claimOrigin: 'MODEL_EXTRACTION',
    assertedByEntityId: danielEntityId, effectiveAt: new Date('2026-03-10T12:00:00Z'),
    transitionContractId: 'shared.obligation.resolution', transitionContracts: contracts(),
  }));
  expect(await projection(proposedOnly)).toMatchObject({ state: 'UNRESOLVED' });

  // An accepted PARTIALLY_FULFILLED.
  const partial = await frame('shared.obligation');
  await accept({ frameInstanceId: partial, frameTypeId: 'shared.obligation', contract: 'shared.obligation.resolution', outcomeCode: 'PARTIALLY_FULFILLED' });
  expect(await projection(partial)).toMatchObject({ state: 'PARTIALLY_RESOLVED', acceptedOutcomes: ['PARTIALLY_FULFILLED'], conflictingOutcomes: [] });

  // An accepted FULFILLED.
  const resolved = await frame('shared.obligation');
  await accept({ frameInstanceId: resolved, frameTypeId: 'shared.obligation', contract: 'shared.obligation.resolution', outcomeCode: 'FULFILLED' });
  expect(await projection(resolved)).toMatchObject({ state: 'RESOLVED', acceptedOutcomes: ['FULFILLED'], conflictingOutcomes: [] });
  // A partial and a settling code together is a progression, not a conflict.
  await accept({ frameInstanceId: resolved, frameTypeId: 'shared.obligation', contract: 'shared.obligation.resolution', outcomeCode: 'PARTIALLY_FULFILLED' });
  expect(await projection(resolved)).toMatchObject({ state: 'RESOLVED' });

  // Two settling codes accepted at once contradict each other: an obligation is
  // not both paid off and written off, and the owner has to see that.
  const contested = await frame('shared.obligation');
  await accept({ frameInstanceId: contested, frameTypeId: 'shared.obligation', contract: 'shared.obligation.resolution', outcomeCode: 'FULFILLED' });
  await accept({ frameInstanceId: contested, frameTypeId: 'shared.obligation', contract: 'shared.obligation.resolution', outcomeCode: 'WAIVED' });
  const conflict = await projection(contested);
  expect(conflict.state).toBe('CONTESTED');
  expect([...conflict.conflictingOutcomes].sort()).toEqual(['FULFILLED', 'WAIVED']);
  expect(conflict.acceptedResolutionIds).toHaveLength(2);

  // Rejecting one of the two leaves a single accepted outcome, so the frame reads
  // RESOLVED again -- and both assertions are still on record.
  const [first] = await read(tx => listResolutionAssertions(tx, { ownerScopeId: owner, sourceFrameInstanceId: contested, lifecycle: 'ACCEPTED' }));
  await govern(tx => setResolutionLifecycle(tx, {
    ownerScopeId: owner, resolutionAssertionId: first!.resolutionAssertionId, lifecycle: 'REJECTED',
  }));
  expect(await projection(contested)).toMatchObject({ state: 'RESOLVED' });
  expect(await read(tx => listResolutionAssertions(tx, { ownerScopeId: owner, sourceFrameInstanceId: contested }))).toHaveLength(2);
});

it('CRT-OUT-01-B: accepting a resolution is a governed decision, and what the resolution said never changes', async () => {
  const commitment = await frame('shared.commitment');
  const canonicalized = await write(tx => canonicalizeResolutionStatement(tx, {
    ownerScopeId: owner, sourceFrameInstanceId: commitment, sourceFrameTypeId: 'shared.commitment',
    statement: 'Done, I sent it', sourceAnchorId: anchor(), claimOrigin: 'USER_STATEMENT',
    assertedByEntityId: ownerEntityId, effectiveAt: new Date('2026-03-11T09:00:00Z'),
    transitionContractId: 'shared.commitment.resolution', transitionContracts: contracts(),
  }));
  expect(canonicalized.outcomeCode).toBe('FULFILLED');
  // Canonicalizing may propose; it may not accept.
  await expect(write(tx => setResolutionLifecycle(tx, {
    ownerScopeId: owner, resolutionAssertionId: canonicalized.resolutionAssertionId, lifecycle: 'ACCEPTED', transactionId,
  }))).rejects.toThrow('RESOLUTION_ASSERTION_NOT_FOUND');
  // Nor may a caller write an accepted resolution without naming the transaction.
  await expect(govern(tx => setResolutionLifecycle(tx, {
    ownerScopeId: owner, resolutionAssertionId: canonicalized.resolutionAssertionId, lifecycle: 'ACCEPTED',
  }))).rejects.toThrow('RESOLUTION_ACCEPTANCE_REQUIRES_TRANSACTION');
  const accepted = await govern(tx => setResolutionLifecycle(tx, {
    ownerScopeId: owner, resolutionAssertionId: canonicalized.resolutionAssertionId, lifecycle: 'ACCEPTED', transactionId,
  }));
  expect(accepted.outcomeCode).toBe('FULFILLED');
  expect(await read(tx => frameOutcomeProjection(tx, { ownerScopeId: owner, frameInstanceId: commitment }))).toMatchObject({ state: 'RESOLVED' });
  // The RESOLVES link follows the assertion's lifecycle and nothing else moves.
  const links = await read(tx => listMemoryLinks(tx, {
    ownerScopeId: owner, object: { objectType: 'frame_instance', objectId: commitment }, linkKind: 'RESOLVES', direction: 'TO',
  }));
  expect(links[0]).toMatchObject({ lifecycle: 'ACTIVE', transitionContractId: 'shared.commitment.resolution' });
});
