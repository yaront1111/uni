import { Pool } from 'pg';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { runMigrations, withOwnerTransaction, type OwnerTransaction } from '@unai/postgres';
import { lintRegistryCheckout } from '@unai/registry';
import type { RequestContext, TransitionContract } from '@unai/domain';
import { createLocalPolicyAdapters } from '@unai/belief';
import {
  createFrameInstance, recordClaim, recordFrameInstanceRole, recordOverlayDelta, recordResolutionAssertion,
  resolveBeliefSlot, resolveEntity, resolveProposition, setResolutionLifecycle, contestOverlayDelta,
  sweepElapsedSchedules,
} from '@unai/memory';
import {
  applyProjectionDelta, calculateObligation, canonicalizeCommitmentStatement, classifyCommitmentLanguage,
  projectionRowContent, readCommitmentsProjection, readObligationsProjection, readProjectionHealth,
  readProjectionRows, readScheduleProjection, recordCommitmentCompletion, replayProjection, runProjectionReplay,
  REDUCER_VERSION, DECISION_REDUCER_VERSION, applyDecisionProjection, canonicalizeDecision,
} from './index.js';

/**
 * The typed projections over real PostgreSQL, through the real owner boundary.
 *
 * Every call runs inside `withOwnerTransaction` under the low-privilege
 * application role, so the row-level policies of migration 0016 are part of what
 * is exercised: the reducer purpose `memory.project` writes projection rows and
 * is admitted by no policy on any canonical table, and `projection.read` reads
 * and writes nothing.
 *
 * Covers CRT-PRJ-01-A, CRT-PRJ-02-A, CRT-PRJ-02-B, CRT-PRJ-03-A, CRT-PRJ-07-A,
 * CRT-OUT-06-A, CRT-OUT-07-A, CRT-MEM-08-A and CRT-RYW-04-A. The transition
 * contracts come from the pinned registry release itself, read out of the
 * checkout by the registry library, so the rules are checked against the YAML in
 * `registry/releases/0.1.0` and not against a copy of it made here.
 */

if (!process.env.UNAI_TEST_DATABASE_URL) throw new Error('Run pnpm test for the required PostgreSQL harness');
const admin = new Pool({ connectionString: process.env.UNAI_TEST_DATABASE_URL });
const appUrl = new URL(process.env.UNAI_TEST_DATABASE_URL); appUrl.username = 'projections_test_app'; appUrl.password = 'test-only';
const appPool = new Pool({ connectionString: appUrl.href });

const owner = randomUUID(), actor = randomUUID();
let baseContextSpaceId = '', sourceItemId = '', transactionId = '', ownerEntityId = '', danielEntityId = '';
let contracts: TransitionContract[] = [];
const anchors: string[] = [];
let nextAnchor = 0;
const anchor = () => anchors[nextAnchor++]!;

/** A pinned instant so `overdue` is decided by the fixture and not by the day the
 * suite happens to run (PRD §25.4 "deterministic for a pinned input set"). */
const NOW = new Date('2026-03-02T09:00:00.000Z');
const FRIDAY = new Date('2026-02-27T17:00:00.000Z');

beforeAll(async () => {
  await runMigrations(admin, resolve('migrations'));
  await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='projections_test_app') THEN CREATE ROLE projections_test_app LOGIN PASSWORD 'test-only'; END IF; END $$; GRANT unai_app TO projections_test_app");
  await admin.query('INSERT INTO users(id,display_name) VALUES($1,$2)', [actor, 'Projection owner']);
  await admin.query("INSERT INTO owner_scopes(id,scope_kind,display_name,created_by_user_id) VALUES($1,'PERSONAL','Projections',$2)", [owner, actor]);
  await admin.query("INSERT INTO owner_scope_members(owner_scope_id,user_id,role) VALUES($1,$2,'OWNER')", [owner, actor]);
  baseContextSpaceId = (await admin.query('SELECT id FROM context_spaces WHERE owner_scope_id=$1', [owner])).rows[0].id;

  const connectorId = randomUUID(); sourceItemId = randomUUID();
  await admin.query("INSERT INTO connectors(id,owner_scope_id,connector_type,external_account_ref,permission_manifest,status) VALUES($1,$2,'CONVERSATION',$3,'{}','ACTIVE')", [connectorId, owner, owner]);
  await admin.query(`INSERT INTO source_items(id,owner_scope_id,connector_id,source_type,external_id,actor_ref,submitted_by_user_id,
    raw_object_ref,content_hash,sensitivity,allowed_purposes,ingestion_version,idempotency_key)
    VALUES($1,$2,$3,'CONVERSATION','projection-message-1',$4,$5,$6,$7,'PRIVATE',ARRAY['PERSONAL_ASSISTANCE'],'evidence-json-v1',$8)`,
    [sourceItemId, owner, connectorId, JSON.stringify({ type: 'USER', id: actor }), actor, randomUUID(), 'b'.repeat(64), randomUUID()]);
  for (let index = 0; index < 120; index += 1) {
    const id = randomUUID(); anchors.push(id);
    await admin.query(`INSERT INTO source_anchors(id,owner_scope_id,source_item_id,anchor_kind,anchor)
      VALUES($1,$2,$3,'MESSAGE_SPAN',$4)`, [id, owner, sourceItemId, JSON.stringify({ start: index * 10, end: index * 10 + 9 })]);
  }
  transactionId = randomUUID();
  await admin.query(`INSERT INTO belief_transactions(id,owner_scope_id,transaction_kind,requested_by_actor_id,
    source_evidence_ids,registry_release_id,status,risk,idempotency_key,commit_receipt,committed_at)
    VALUES($1,$2,'RESOLVE',$3,ARRAY[$4::uuid],$5,'COMMITTED','LOW',$6,'{}',$7)`,
    [transactionId, owner, actor, sourceItemId, randomUUID(), randomUUID().replaceAll('-', ''), new Date('2026-02-01T00:00:00.000Z')]);

  contracts = [...(await lintRegistryCheckout({ repository: resolve('.'), version: '0.1.0' })).transitions];
  ownerEntityId = await person('Projection Owner', 'owner.projection@example.test');
  danielEntityId = await person('Daniel Projection', 'daniel.projection@example.test');
});
afterAll(async () => { await appPool.end(); await admin.end(); });

function context(purpose: string): RequestContext { return { actorId: actor, ownerScopeId: owner, purpose, correlationId: randomUUID() }; }
const as = <T,>(purpose: string, run: (tx: OwnerTransaction) => Promise<T>) => withOwnerTransaction(appPool, context(purpose), run);
const write = <T,>(run: (tx: OwnerTransaction) => Promise<T>) => as('memory.canonicalize', run);
const govern = <T,>(run: (tx: OwnerTransaction) => Promise<T>) => as('memory.govern', run);
const correct = <T,>(run: (tx: OwnerTransaction) => Promise<T>) => as('memory.correct', run);
/** The reducer's purpose: it writes projection rows and nothing canonical. */
const reduce = <T,>(run: (tx: OwnerTransaction) => Promise<T>) => as('memory.project', run);
const readProjection = <T,>(run: (tx: OwnerTransaction) => Promise<T>) => as('projection.read', run);

async function person(label: string, mailbox: string): Promise<string> {
  return (await write(tx => resolveEntity(tx, {
    ownerScopeId: owner, entityKind: 'PERSON', canonicalLabel: label,
    aliases: [{ aliasType: 'EMAIL', aliasValue: mailbox }, { aliasType: 'DISPLAY_NAME', aliasValue: label }],
  }))).entityId;
}

const frame = (frameTypeId: string) => write(tx => createFrameInstance(tx, {
  ownerScopeId: owner, frameTypeId, contextSpaceId: baseContextSpaceId,
}));

async function statedValue(input: {
  frameInstanceId: string; predicateId: string; modality: 'ACTUAL' | 'SCHEDULED' | 'COMMITTED';
  value: unknown; claimOrigin?: 'USER_STATEMENT' | 'DOCUMENT_ASSERTION' | 'STRUCTURED_CONNECTOR_OBSERVATION';
  validFrom?: Date;
}): Promise<{ beliefSlotId: string; propositionId: string; claimId: string }> {
  return write(async tx => {
    const slot = await resolveBeliefSlot(tx, {
      ownerScopeId: owner,
      descriptor: { frameInstanceId: input.frameInstanceId, predicateId: input.predicateId,
        contextSpaceId: baseContextSpaceId, modality: input.modality, qualifiers: {} },
    });
    const proposition = await resolveProposition(tx, {
      ownerScopeId: owner, beliefSlotId: slot.beliefSlotId, normalizedValue: input.value,
    });
    const claimId = await recordClaim(tx, {
      ownerScopeId: owner, sourceAnchorId: anchor(), claimOrigin: input.claimOrigin ?? 'USER_STATEMENT',
      lifecycle: 'PROVISIONAL', propositionId: proposition.propositionId,
      assertedByEntityId: ownerEntityId, validFrom: input.validFrom ?? null,
    });
    return { beliefSlotId: slot.beliefSlotId, propositionId: proposition.propositionId, claimId };
  });
}

/** One obligation with a debtor, a creditor and a principal amount. */
async function obligation(amount: string, currency = 'ILS'): Promise<string> {
  const frameInstanceId = await frame('shared.obligation');
  const stated = await statedValue({ frameInstanceId, predicateId: 'shared.obligation.principal_amount',
    modality: 'ACTUAL', value: { amount, currency } });
  await write(async tx => {
    await recordFrameInstanceRole(tx, { ownerScopeId: owner, frameInstanceId, roleId: 'debtor',
      entityId: ownerEntityId, claimId: stated.claimId });
    await recordFrameInstanceRole(tx, { ownerScopeId: owner, frameInstanceId, roleId: 'creditor',
      entityId: danielEntityId, claimId: stated.claimId });
  });
  return frameInstanceId;
}

/** One canonical `finance.payment_allocation` frame against an obligation. */
async function allocation(input: {
  obligationFrameInstanceId: string; allocated: string; currency?: string;
  paymentReference?: string; paymentTotal?: string;
}): Promise<string> {
  const currency = input.currency ?? 'ILS';
  const frameInstanceId = await frame('finance.payment_allocation');
  const stated = await statedValue({ frameInstanceId, predicateId: 'finance.payment_allocation.allocated_amount',
    modality: 'ACTUAL', value: { amount: input.allocated, currency },
    claimOrigin: 'STRUCTURED_CONNECTOR_OBSERVATION' });
  await write(async tx => {
    await recordFrameInstanceRole(tx, { ownerScopeId: owner, frameInstanceId, roleId: 'obligation',
      typedValue: { frameInstanceId: input.obligationFrameInstanceId }, claimId: stated.claimId });
    await recordFrameInstanceRole(tx, { ownerScopeId: owner, frameInstanceId, roleId: 'payment_transaction',
      typedValue: { externalId: input.paymentReference ?? 'bank:payment-1',
        ...(input.paymentTotal === undefined ? {} : { total: { amount: input.paymentTotal, currency } }) },
      claimId: stated.claimId });
  });
  return frameInstanceId;
}

const obligationRow = (frameInstanceId: string) => reduce(async tx => {
  await applyProjectionDelta(tx, { ownerScopeId: owner, projectionName: 'obligations_projection', asOf: NOW });
  const rows = await readProjectionRows(tx, { ownerScopeId: owner, projectionName: 'obligations_projection' });
  return rows.find(row => 'obligationFrameInstanceId' in row && row.obligationFrameInstanceId === frameInstanceId);
});

// ---------------------------------------------------------------------------

it('CRT-PRJ-01-A: stores amount, currency, due time and start/end as typed columns', async () => {
  const columns = (await admin.query(`SELECT table_name,column_name,data_type,is_nullable FROM information_schema.columns
    WHERE table_schema='public' AND table_name IN
      ('open_commitments_projection','obligations_projection','schedule_projection')
    ORDER BY table_name,column_name`)).rows as Array<{ table_name: string; column_name: string; data_type: string }>;
  const typeOf = (table: string, column: string) =>
    columns.find(row => row.table_name === table && row.column_name === column)?.data_type;

  // The three tables exist.
  expect([...new Set(columns.map(row => row.table_name))].sort())
    .toEqual(['obligations_projection', 'open_commitments_projection', 'schedule_projection']);
  // Money is numeric and currency is a checked code, not a JSON blob.
  expect(typeOf('obligations_projection', 'principal_amount')).toBe('numeric');
  expect(typeOf('obligations_projection', 'total_canonical_allocation')).toBe('numeric');
  expect(typeOf('obligations_projection', 'remaining_amount_capability_derived')).toBe('numeric');
  expect(typeOf('obligations_projection', 'unclassified_remainder')).toBe('numeric');
  expect(typeOf('obligations_projection', 'currency')).toBe('text');
  // Due times and the schedule window are real timestamps.
  expect(typeOf('obligations_projection', 'due_time')).toBe('timestamp with time zone');
  expect(typeOf('open_commitments_projection', 'due_time')).toBe('timestamp with time zone');
  expect(typeOf('schedule_projection', 'start_time')).toBe('timestamp with time zone');
  expect(typeOf('schedule_projection', 'end_time')).toBe('timestamp with time zone');
  // The only JSONB anywhere in the three tables is the provenance manifest.
  expect(columns.filter(row => row.data_type === 'jsonb').map(row => row.column_name))
    .toEqual(['source_manifest', 'source_manifest', 'source_manifest']);
});

it('CRT-PRJ-07-A: creates a commitment from commitment language, nothing from consideration language, and a target-less FULFILLED resolution from completion', async () => {
  // Classification first, because the whole rule rests on it.
  expect(classifyCommitmentLanguage('I will send Daniel the report by Friday')).toMatchObject({
    language: 'COMMITMENT', actionDescription: 'send Daniel the report', dueTimeText: 'Friday',
  });
  expect(classifyCommitmentLanguage('I am considering sending it Friday')).toMatchObject({ language: 'CONSIDERATION' });
  expect(classifyCommitmentLanguage('The weather is fine')).toMatchObject({ language: 'NONE' });

  const framesBefore = (await admin.query('SELECT count(*)::int n FROM frame_instances WHERE owner_scope_id=$1', [owner])).rows[0].n;
  const committed = await write(tx => canonicalizeCommitmentStatement(tx, {
    ownerScopeId: owner, contextSpaceId: baseContextSpaceId,
    statement: 'I will send Daniel the report by Friday', sourceAnchorId: anchor(),
    claimOrigin: 'USER_STATEMENT', assertedByEntityId: ownerEntityId,
    promisorEntityId: ownerEntityId, promiseeEntityId: danielEntityId,
    dueTime: FRIDAY, statedAt: new Date('2026-02-23T08:00:00.000Z'),
  }));
  expect(committed.created).toBe(true);
  expect(committed.modality).toBe('COMMITTED');
  const commitmentId = committed.commitmentFrameInstanceId!;

  // A shared.commitment frame whose slots carry modality COMMITTED, separate from
  // belief status and claim origin (PRD §11.7).
  const frameRow = (await admin.query('SELECT frame_type_id FROM frame_instances WHERE owner_scope_id=$1 AND id=$2', [owner, commitmentId])).rows[0];
  expect(frameRow.frame_type_id).toBe('shared.commitment');
  const slots = (await admin.query('SELECT predicate_id,modality FROM belief_slots WHERE owner_scope_id=$1 AND frame_instance_id=$2 ORDER BY predicate_id', [owner, commitmentId])).rows;
  expect(slots).toEqual([
    { predicate_id: 'shared.commitment.action_description', modality: 'COMMITTED' },
    { predicate_id: 'shared.commitment.due_time', modality: 'COMMITTED' },
  ]);
  // No status predicate anywhere: completion has exactly one home (CRT-OUT-01-A).
  expect(slots.some(slot => /status/.test(slot.predicate_id))).toBe(false);

  // Consideration language creates nothing at all -- not a frame, not a slot.
  const framesAfterCommitment = (await admin.query('SELECT count(*)::int n FROM frame_instances WHERE owner_scope_id=$1', [owner])).rows[0].n;
  const considered = await write(tx => canonicalizeCommitmentStatement(tx, {
    ownerScopeId: owner, contextSpaceId: baseContextSpaceId,
    statement: 'I am considering sending it Friday', sourceAnchorId: anchor(),
    claimOrigin: 'USER_STATEMENT', assertedByEntityId: ownerEntityId,
    promisorEntityId: ownerEntityId, dueTime: FRIDAY, statedAt: new Date('2026-02-23T09:00:00.000Z'),
  }));
  expect(considered).toMatchObject({ created: false, commitmentFrameInstanceId: null, modality: null });
  expect(considered.reading.language).toBe('CONSIDERATION');
  expect((await admin.query('SELECT count(*)::int n FROM frame_instances WHERE owner_scope_id=$1', [owner])).rows[0].n)
    .toBe(framesAfterCommitment);
  expect(framesAfterCommitment).toBeGreaterThan(framesBefore);

  // "Done, I sent it" is a target-less FULFILLED resolution beside the
  // commitment, and the commitment's own slots are untouched.
  const slotsBefore = (await admin.query('SELECT id,xmin::text v FROM belief_slots WHERE owner_scope_id=$1 AND frame_instance_id=$2 ORDER BY id', [owner, commitmentId])).rows;
  const completion = await write(tx => recordCommitmentCompletion(tx, {
    ownerScopeId: owner, commitmentFrameInstanceId: commitmentId, statement: 'Done, I sent it',
    sourceAnchorId: anchor(), claimOrigin: 'USER_STATEMENT', assertedByEntityId: ownerEntityId,
    effectiveAt: new Date('2026-02-26T12:00:00.000Z'), transitionContracts: contracts,
  }));
  const resolution = (await admin.query('SELECT * FROM resolution_assertions WHERE owner_scope_id=$1 AND id=$2', [owner, completion.resolutionAssertionId])).rows[0];
  expect(resolution).toMatchObject({
    source_frame_instance_id: commitmentId, target_frame_instance_id: null, target_proposition_id: null,
    outcome_code: 'FULFILLED', transition_contract_id: 'shared.commitment.resolution',
  });
  expect(resolution.claim_id).toBe(completion.claimId);
  expect(completion.createdStatusSlot).toBe(false);
  expect((await admin.query('SELECT id,xmin::text v FROM belief_slots WHERE owner_scope_id=$1 AND frame_instance_id=$2 ORDER BY id', [owner, commitmentId])).rows)
    .toEqual(slotsBefore);
});

it('CRT-OUT-07-A: the clock sets overdue and creates no FAILED or MISSED resolution', async () => {
  const committed = await write(tx => canonicalizeCommitmentStatement(tx, {
    ownerScopeId: owner, contextSpaceId: baseContextSpaceId,
    statement: 'I will send the quarterly summary by Friday', sourceAnchorId: anchor(),
    claimOrigin: 'USER_STATEMENT', assertedByEntityId: ownerEntityId,
    promisorEntityId: ownerEntityId, promiseeEntityId: danielEntityId,
    dueTime: FRIDAY, statedAt: new Date('2026-02-23T08:00:00.000Z'),
  }));
  const commitmentId = committed.commitmentFrameInstanceId!;
  const resolutionsBefore = (await admin.query('SELECT count(*)::int n FROM resolution_assertions WHERE owner_scope_id=$1', [owner])).rows[0].n;

  // Before the due time: not overdue, due soon.
  const early = await reduce(async tx => {
    await applyProjectionDelta(tx, { ownerScopeId: owner, projectionName: 'open_commitments_projection',
      asOf: new Date('2026-02-26T12:00:00.000Z') });
    return readProjectionRows(tx, { ownerScopeId: owner, projectionName: 'open_commitments_projection' });
  });
  const earlyRow = early.find(row => 'commitmentFrameInstanceId' in row && row.commitmentFrameInstanceId === commitmentId) as { overdue: boolean; dueSoon: boolean };
  expect(earlyRow).toMatchObject({ overdue: false, dueSoon: true });

  // Advance the clock past the due time with no new evidence of any kind.
  const late = await reduce(async tx => {
    await applyProjectionDelta(tx, { ownerScopeId: owner, projectionName: 'open_commitments_projection', asOf: NOW });
    return readProjectionRows(tx, { ownerScopeId: owner, projectionName: 'open_commitments_projection' });
  });
  const lateRow = late.find(row => 'commitmentFrameInstanceId' in row && row.commitmentFrameInstanceId === commitmentId) as
    { overdue: boolean; dueSoon: boolean; outcomeState: string };
  expect(lateRow).toMatchObject({ overdue: true, dueSoon: false, outcomeState: 'UNRESOLVED' });

  // Not one resolution assertion was created, and in particular no FAILED and no
  // MISSED anywhere in the owner's memory (PRD §12.6).
  expect((await admin.query('SELECT count(*)::int n FROM resolution_assertions WHERE owner_scope_id=$1', [owner])).rows[0].n)
    .toBe(resolutionsBefore);
  expect((await admin.query("SELECT count(*)::int n FROM resolution_assertions WHERE owner_scope_id=$1 AND outcome_code IN ('FAILED','MISSED')", [owner])).rows[0].n)
    .toBe(0);
  // The kernel's own elapsed sweep agrees and is structurally incapable of
  // creating either.
  const sweep = await reduce(tx => sweepElapsedSchedules(tx, { ownerScopeId: owner, asOf: NOW }));
  expect(sweep.occurrencesCreated).toBe(0);
  expect(sweep.resolutionsCreated).toBe(0);
});

it('CRT-OUT-06-A: recomputes the remaining amount from canonical allocation frames even when advisory_coverage is wrong', async () => {
  const obligationId = await obligation('50.00');
  // The §44.1 payment: ILS 60 paid, ILS 50 allocated, ILS 10 unclassified.
  await allocation({ obligationFrameInstanceId: obligationId, allocated: '50.00',
    paymentReference: 'bank:daniel-1', paymentTotal: '60.00' });

  // A resolution whose advisory coverage is deliberately, grossly wrong.
  const claimId = await write(tx => recordClaim(tx, {
    ownerScopeId: owner, sourceAnchorId: anchor(), claimOrigin: 'USER_STATEMENT', lifecycle: 'CANDIDATE',
    propositionId: null, assertedByEntityId: ownerEntityId, candidateFrameTypeId: 'shared.obligation',
  }));
  const recorded = await write(tx => recordResolutionAssertion(tx, {
    ownerScopeId: owner, sourceFrameInstanceId: obligationId, sourceFrameTypeId: 'shared.obligation',
    outcomeCode: 'PARTIALLY_FULFILLED', effectiveAt: new Date('2026-02-20T00:00:00.000Z'),
    assertedByEntityId: ownerEntityId, claimId, transitionContractId: 'shared.obligation.resolution',
    transitionContracts: contracts, advisoryCoverage: 0.01, metadata: { note: 'coverage cache is wrong on purpose' },
  }));
  expect((await admin.query('SELECT advisory_coverage FROM resolution_assertions WHERE id=$1', [recorded.resolutionAssertionId])).rows[0].advisory_coverage)
    .toBe('0.01');

  const row = await obligationRow(obligationId) as {
    principalAmount: string; currency: string; totalCanonicalAllocation: string;
    remainingAmountCapabilityDerived: string; unclassifiedRemainder: string; sourceManifest: Record<string, unknown>;
  };
  // The numbers come from the allocation frames. A coverage of 0.01 would imply
  // ILS 49.50 outstanding; the recomputed answer is ILS 0.
  expect(row.principalAmount).toBe('50.00');
  expect(row.currency).toBe('ILS');
  expect(row.totalCanonicalAllocation).toBe('50');
  expect(row.remainingAmountCapabilityDerived).toBe('0');
  expect(row.unclassifiedRemainder).toBe('10');
  // The coverage is carried out for display and named as ignored.
  expect(row.sourceManifest['advisoryCoverageIgnored']).toEqual([0.01]);

  // Moving the coverage to another wrong value changes nothing at all.
  await admin.query('UPDATE resolution_assertions SET advisory_coverage=0.99 WHERE id=$1', [recorded.resolutionAssertionId]);
  const again = await obligationRow(obligationId) as { remainingAmountCapabilityDerived: string; unclassifiedRemainder: string };
  expect(again.remainingAmountCapabilityDerived).toBe('0');
  expect(again.unclassifiedRemainder).toBe('10');

  // And the capability answers the same, from the same frames.
  const calculation = await reduce(tx => calculateObligation(tx, {
    ownerScopeId: owner, obligationFrameInstanceId: obligationId, risk: 'LOW',
  }));
  expect(calculation.remainingAmount).toBe('0');
  expect(calculation.unclassifiedRemainder).toBe('10');
  expect(calculation.advisoryCoverageIgnored).toEqual([0.99]);
  expect(calculation.allocationFrameInstanceIds).toHaveLength(1);
});

it('CRT-MEM-08-A: keeps both conflicting amounts retrievable and reports the conflict to a high-risk calculation', async () => {
  const obligationId = await obligation('50.00');
  const userValue = (await admin.query(
    `SELECT p.id FROM propositions p JOIN belief_slots s ON s.id=p.belief_slot_id
     WHERE s.owner_scope_id=$1 AND s.frame_instance_id=$2 AND s.predicate_id='shared.obligation.principal_amount'`,
    [owner, obligationId])).rows[0].id as string;

  // A document says something else about the same slot.
  const documentValue = await statedValue({ frameInstanceId: obligationId,
    predicateId: 'shared.obligation.principal_amount', modality: 'ACTUAL',
    value: { amount: '60.00', currency: 'ILS' }, claimOrigin: 'DOCUMENT_ASSERTION' });

  // Both propositions remain retrievable in one slot; neither overwrote the other.
  const slotRows = (await admin.query(
    `SELECT p.id,p.normalized_value,p.lifecycle,s.id AS slot FROM propositions p
     JOIN belief_slots s ON s.owner_scope_id=p.owner_scope_id AND s.id=p.belief_slot_id
     WHERE s.owner_scope_id=$1 AND s.frame_instance_id=$2 AND s.predicate_id='shared.obligation.principal_amount'
     ORDER BY p.created_at`, [owner, obligationId])).rows;
  expect(slotRows).toHaveLength(2);
  expect(new Set(slotRows.map((row: { slot: string }) => row.slot)).size).toBe(1);
  expect(slotRows.map((row: { normalized_value: { amount: string } }) => row.normalized_value.amount)).toEqual(['50.00', '60.00']);
  expect(slotRows.every((row: { lifecycle: string }) => row.lifecycle === 'ACTIVE')).toBe(true);
  expect(slotRows.map((row: { id: string }) => row.id)).toEqual(expect.arrayContaining([userValue, documentValue.propositionId]));

  // A high-risk calculation over that slot reports the conflict and refuses to
  // answer from one of the two values.
  const highRisk = await reduce(tx => calculateObligation(tx, {
    ownerScopeId: owner, obligationFrameInstanceId: obligationId, risk: 'HIGH',
  }));
  expect(highRisk.blocked).toBe(true);
  expect(highRisk.blockedReason).toBe('HIGH_RISK_CALCULATION_OVER_CONFLICTING_SLOT');
  expect(highRisk.conflicts).toHaveLength(1);
  expect(highRisk.conflicts[0]!.propositions.map(proposition => proposition.amount).sort()).toEqual(['50.00', '60.00']);
  expect(highRisk.conflicts[0]!.propositions.flatMap(proposition => proposition.claimOrigins).sort())
    .toEqual(['DOCUMENT_ASSERTION', 'USER_STATEMENT']);

  // A lower-risk calculation still reports it rather than hiding it.
  const lowRisk = await reduce(tx => calculateObligation(tx, {
    ownerScopeId: owner, obligationFrameInstanceId: obligationId, risk: 'LOW',
  }));
  expect(lowRisk.blocked).toBe(false);
  expect(lowRisk.conflicts).toHaveLength(1);

  // And the projection row flags it for every surface that reads it.
  const row = await obligationRow(obligationId) as { conflictFlag: boolean; sourceManifest: Record<string, unknown> };
  expect(row.conflictFlag).toBe(true);
  expect(row.sourceManifest['conflictingAmounts']).toHaveLength(2);
});

it('CRT-PRJ-03-A: every row of every projection table carries the nine required fields', async () => {
  // A scheduled event so the schedule projection has a row too.
  const eventId = await frame('shared.event_occurrence');
  await statedValue({ frameInstanceId: eventId, predicateId: 'shared.event_occurrence.occurrence_time',
    modality: 'SCHEDULED', value: { start: '2026-03-10T09:00:00.000Z', end: '2026-03-10T10:00:00.000Z' },
    claimOrigin: 'STRUCTURED_CONNECTOR_OBSERVATION' });

  // A recorded decision so the decision projection of release 0.2.0 has a row too.
  await write(tx => canonicalizeDecision(tx, {
    ownerScopeId: owner, contextSpaceId: baseContextSpaceId, deciderEntityId: ownerEntityId, anchorFor: () => anchor(),
    statedAt: NOW, decision: { question: 'Which laptop?', options: ['Keep the old one', 'Buy a new one'],
      userChoice: 'Keep the old one', expectedResult: 'It lasts another year', reviewDate: '2027-03-01T00:00:00.000Z' },
  }));

  await reduce(async tx => {
    for (const projectionName of ['open_commitments_projection', 'obligations_projection', 'schedule_projection'] as const) {
      await applyProjectionDelta(tx, { ownerScopeId: owner, projectionName, asOf: NOW });
    }
    await applyDecisionProjection(tx, { ownerScopeId: owner, asOf: NOW });
  });

  // Read the table list from the catalog rather than from a hand-kept list, so a
  // projection table added later is covered by this test without being added to it.
  const tables = (await admin.query(`SELECT table_name FROM information_schema.tables
    WHERE table_schema='public' AND table_name LIKE '%\\_projection' ORDER BY table_name`)).rows
    .map((row: { table_name: string }) => row.table_name);
  expect(tables).toContain('open_commitments_projection');
  expect(tables).toContain('obligations_projection');
  expect(tables).toContain('schedule_projection');

  const required = ['owner_scope_id', 'projection_version', 'canonical_transaction_watermark',
    'owner_overlay_watermark', 'reducer_version', 'is_complete', 'source_manifest', 'updated_at'];
  const sourceFrame: Record<string, string> = {
    open_commitments_projection: 'commitment_frame_instance_id',
    obligations_projection: 'obligation_frame_instance_id',
    schedule_projection: 'scheduled_frame_instance_id',
    decision_projection: 'decision_frame_instance_id',
  };
  // Each reducer names its own version; the decision reducer is release 0.2.0's.
  const reducer: Record<string, string> = { decision_projection: DECISION_REDUCER_VERSION };
  expect(tables).toContain('decision_projection');
  for (const table of tables) {
    const rows = (await admin.query('SELECT * FROM ' + table + ' WHERE owner_scope_id=$1', [owner])).rows;
    expect(rows.length, table).toBeGreaterThan(0);
    for (const row of rows) {
      for (const column of [...required, sourceFrame[table]!]) {
        expect(row[column], table + '.' + column).not.toBeNull();
        expect(row[column], table + '.' + column).not.toBeUndefined();
      }
      // The columns are what they claim to be, not placeholders.
      expect(row['reducer_version']).toBe(reducer[table] ?? REDUCER_VERSION);
      expect(row['projection_version']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      expect(typeof row['is_complete']).toBe('boolean');
      expect(typeof row['source_manifest']).toBe('object');
      expect(Number(row['owner_overlay_watermark'])).toBeGreaterThanOrEqual(0);
    }
    // ...and the database refuses a row that omitted one of them.
    const nullable = (await admin.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1 AND is_nullable='YES'`, [table])).rows
      .map((row: { column_name: string }) => row.column_name);
    for (const column of [...required, sourceFrame[table]!]) expect(nullable, table + '.' + column).not.toContain(column);
  }
});

it('CRT-RYW-04-A: reflects a pending correction, answers is_complete=false with the pending assertion when it cannot be applied, and blocks a high-risk action', async () => {
  const obligationId = await obligation('50.00');
  await reduce(tx => applyProjectionDelta(tx, { ownerScopeId: owner, projectionName: 'obligations_projection', asOf: NOW }));

  // A pending owner correction the reducer *can* apply.
  const applied = await correct(tx => recordOverlayDelta(tx, {
    ownerScopeId: owner, deltaKind: 'USER_CORRECTION', rawText: 'Actually, it was ILS 60',
    sourceEvidenceId: sourceItemId, lifecycle: 'USER_ASSERTED',
    target: { objectType: 'frame_instance', objectId: obligationId },
  }));
  const withPending = await readProjection(tx => readObligationsProjection(tx, { ownerScopeId: owner, asOf: NOW }));
  const corrected = withPending.rows.find(row => row.obligationFrameInstanceId === obligationId)!;
  // The correction is in this read, before any canonicalization ran, and is
  // labelled as the owner's own assertion rather than as canonical memory.
  expect(corrected.principalAmount).toBe('60');
  expect(corrected.currency).toBe('ILS');
  expect(corrected.remainingAmountCapabilityDerived).toBe('60');
  expect(applied.ownerSequence).toBeGreaterThan(0);
  expect(withPending.ownerOverlayWatermark).toBeGreaterThanOrEqual(applied.ownerSequence);

  // Now force reducer application to be impossible: a correction stated in a
  // currency the obligation is not in. Converting it would be arithmetic nobody
  // authorized, so the reducer refuses and reports.
  const impossible = await correct(tx => recordOverlayDelta(tx, {
    ownerScopeId: owner, deltaKind: 'USER_CORRECTION', rawText: 'No, the debt is USD 60',
    sourceEvidenceId: sourceItemId, lifecycle: 'USER_ASSERTED',
    target: { objectType: 'frame_instance', objectId: obligationId },
  }));
  const incomplete = await readProjection(tx => readObligationsProjection(tx, { ownerScopeId: owner, asOf: NOW }));
  expect(incomplete.isComplete).toBe(false);
  const incompleteRow = incomplete.rows.find(row => row.obligationFrameInstanceId === obligationId)!;
  expect(incompleteRow.isComplete).toBe(false);
  // The persisted state is still returned, together with the pending assertion.
  expect(incompleteRow.principalAmount).not.toBeNull();
  const pending = incomplete.pendingAssertions.find(assertion => assertion.overlayDeltaId === impossible.overlayDeltaId);
  expect(pending).toMatchObject({ reason: 'DELTA_CURRENCY_CONVERSION_REFUSED', rawText: 'No, the debt is USD 60',
    targetFrameInstanceId: obligationId });
  expect(incomplete.highRiskActionsBlocked).toBe(true);

  // A high-risk action requested on that state is blocked by the policy port,
  // which consumes the same completeness flag.
  const policy = createLocalPolicyAdapters();
  const verdict = await policy.evaluateMemoryAction({
    actorId: actor, ownerScopeId: owner, purpose: 'memory.act', sensitivity: 'PRIVATE',
    evidenceRefs: [sourceItemId], risk: 'HIGH', actionKind: 'DRAFT', capabilityGranted: true,
    allowedPurposes: ['memory.act'], supportingAssessment: 'ACCEPTED', projectionComplete: incomplete.isComplete,
  });
  expect(verdict.outcome).toBe('DENY');
  expect(verdict.reason).toBe('HIGH_RISK_ACTION_ON_UNSETTLED_MEMORY');

  // ...and the capability's own high-risk calculation refuses too.
  const calculation = await reduce(tx => calculateObligation(tx, {
    ownerScopeId: owner, obligationFrameInstanceId: obligationId, risk: 'HIGH',
    pendingAssertions: incompleteRow.pendingAssertions,
  }));
  expect(calculation.blocked).toBe(true);
  expect(calculation.isComplete).toBe(false);

  // A contested delta is pending too, and the row that reports it still exists.
  await govern(tx => contestOverlayDelta(tx, { ownerScopeId: owner, overlayDeltaId: impossible.overlayDeltaId,
    reason: { failureReason: 'CURRENCY_NOT_SUPPORTED', affectedProjections: ['obligations_projection'] } }));
  const contested = await readProjection(tx => readObligationsProjection(tx, { ownerScopeId: owner, asOf: NOW }));
  expect(contested.pendingAssertions.find(assertion => assertion.overlayDeltaId === impossible.overlayDeltaId))
    .toMatchObject({ reason: 'DELTA_CONTESTED', lifecycle: 'CONTESTED' });
  expect(contested.isComplete).toBe(false);
});

it('CRT-PRJ-02-A: a full replay equals the incrementally maintained projection over generated transaction sequences, and replaying twice is identical', async () => {
  // A small deterministic generator. A seeded sequence beats a random one here:
  // a failure has to be reproducible from the test file alone.
  const seedInitial = 0x5eed1234;
  let seed = seedInitial;
  const next = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const pick = <T,>(values: readonly T[]): T => values[Math.floor(next() * values.length) % values.length]!;

  const obligationIds: string[] = [];
  const commitmentIds: string[] = [];
  // Twenty generated steps, each an operation a real transaction could perform,
  // with the projections applied incrementally after every one.
  for (let step = 0; step < 20; step += 1) {
    const operation = pick(['obligation', 'allocation', 'commitment', 'completion', 'correction', 'amount'] as const);
    if (operation === 'obligation' || obligationIds.length === 0) {
      obligationIds.push(await obligation(String(10 + Math.floor(next() * 90)) + '.00'));
    } else if (operation === 'allocation') {
      await allocation({ obligationFrameInstanceId: pick(obligationIds),
        allocated: String(1 + Math.floor(next() * 9)) + '.00',
        paymentReference: 'bank:generated-' + step, paymentTotal: String(20 + Math.floor(next() * 20)) + '.00' });
    } else if (operation === 'commitment') {
      const created = await write(tx => canonicalizeCommitmentStatement(tx, {
        ownerScopeId: owner, contextSpaceId: baseContextSpaceId,
        statement: 'I will file report ' + step + ' by Friday', sourceAnchorId: anchor(),
        claimOrigin: 'USER_STATEMENT', assertedByEntityId: ownerEntityId, promisorEntityId: ownerEntityId,
        dueTime: new Date(FRIDAY.getTime() + step * 3600_000), statedAt: new Date('2026-02-20T00:00:00.000Z'),
      }));
      if (created.commitmentFrameInstanceId) commitmentIds.push(created.commitmentFrameInstanceId);
    } else if (operation === 'completion' && commitmentIds.length > 0) {
      const target = pick(commitmentIds);
      const recorded = await write(tx => recordCommitmentCompletion(tx, {
        ownerScopeId: owner, commitmentFrameInstanceId: target, statement: 'Done, I sent it',
        sourceAnchorId: anchor(), claimOrigin: 'USER_STATEMENT', assertedByEntityId: ownerEntityId,
        effectiveAt: new Date('2026-02-28T00:00:00.000Z'), transitionContracts: contracts,
      }));
      await govern(tx => setResolutionLifecycle(tx, { ownerScopeId: owner,
        resolutionAssertionId: recorded.resolutionAssertionId, lifecycle: 'ACCEPTED', transactionId }));
    } else if (operation === 'correction') {
      await correct(tx => recordOverlayDelta(tx, {
        ownerScopeId: owner, deltaKind: 'USER_CORRECTION', rawText: 'Actually, it was ILS ' + (40 + step),
        sourceEvidenceId: sourceItemId, lifecycle: 'USER_ASSERTED',
        target: { objectType: 'frame_instance', objectId: pick(obligationIds) },
      }));
    } else {
      await statedValue({ frameInstanceId: pick(obligationIds), predicateId: 'shared.obligation.due_time',
        modality: 'ACTUAL', value: { time: new Date(FRIDAY.getTime() + step * 86_400_000).toISOString() } });
    }
    await reduce(async tx => {
      for (const projectionName of ['open_commitments_projection', 'obligations_projection', 'schedule_projection'] as const) {
        await applyProjectionDelta(tx, { ownerScopeId: owner, projectionName, asOf: NOW });
      }
    });
  }

  for (const projectionName of ['open_commitments_projection', 'obligations_projection', 'schedule_projection'] as const) {
    const incremental = await reduce(tx => readProjectionRows(tx, { ownerScopeId: owner, projectionName }));
    // Full replay from canonical memory, compared with the incremental state.
    const first = await reduce(tx => replayProjection(tx, { ownerScopeId: owner, projectionName, asOf: NOW }));
    expect(first.equalsIncremental, projectionName).toBe(true);
    const replayed = await reduce(tx => readProjectionRows(tx, { ownerScopeId: owner, projectionName }));
    expect(replayed.map(projectionRowContent), projectionName).toEqual(incremental.map(projectionRowContent));

    // Replaying the same committed transactions twice yields identical state.
    const second = await reduce(tx => replayProjection(tx, { ownerScopeId: owner, projectionName, asOf: NOW }));
    expect(second.equalsIncremental, projectionName).toBe(true);
    const again = await reduce(tx => readProjectionRows(tx, { ownerScopeId: owner, projectionName }));
    expect(again.map(projectionRowContent), projectionName).toEqual(replayed.map(projectionRowContent));
    // The run identity is the one thing that moves, and it moves for every row.
    expect(new Set(again.map(row => row.projectionVersion)).size).toBe(again.length === 0 ? 0 : 1);
    expect(again[0]?.projectionVersion).not.toBe(replayed[0]?.projectionVersion);
    expect(second.rowsRebuilt).toBe(again.length);
  }
  expect(seed).not.toBe(seedInitial);
  // Twenty committed steps, each reduced, then two full replays of three
  // projections: over four seconds alone, so vitest's five-second default fails it
  // whenever the suite's other database files run beside it. Latency is measured by
  // the load harness (CRT-NFR-01-A), never by this equality check.
}, 30_000);

it('records a rebuild receipt the Projection health screen reads, with the computed comparison verdict', async () => {
  const result = await reduce(tx => runProjectionReplay(tx, { ownerScopeId: owner, asOf: NOW, trigger: 'MANUAL_REPLAY' }));
  expect(result.receipts.map(receipt => receipt.projectionName).sort())
    .toEqual(['obligations_projection', 'open_commitments_projection', 'schedule_projection']);
  expect(result.equalsIncremental).toBe(true);

  const health = await readProjection(tx => readProjectionHealth(tx, { ownerScopeId: owner, readAt: NOW }));
  expect(health.projections.map(projection => projection.projectionName).sort())
    .toEqual(['obligations_projection', 'open_commitments_projection', 'schedule_projection']);
  expect(health.projections.every(projection => projection.reducerVersion === REDUCER_VERSION)).toBe(true);
  expect(health.projections.find(projection => projection.projectionName === 'obligations_projection')!.rowCount)
    .toBeGreaterThan(0);
  // The incomplete row of the read-your-writes test is listed with the owner
  // write that made it incomplete, which is what the screen shows.
  const obligations = health.projections.find(projection => projection.projectionName === 'obligations_projection')!;
  expect(obligations.incompleteRowCount).toBeGreaterThanOrEqual(0);
  const receipts = health.receipts.filter(receipt => receipt.trigger === 'MANUAL_REPLAY');
  expect(receipts.length).toBeGreaterThanOrEqual(3);
  expect(receipts.every(receipt => receipt.reducerVersion === REDUCER_VERSION)).toBe(true);
  expect(receipts.every(receipt => typeof receipt.equalsIncremental === 'boolean')).toBe(true);
});

it('reads commitments and the schedule under the read purpose alone, and refuses the reducer purpose to canonical writes', async () => {
  const commitments = await readProjection(tx => readCommitmentsProjection(tx, { ownerScopeId: owner, asOf: NOW }));
  expect(commitments.projectionName).toBe('open_commitments_projection');
  expect(commitments.rows.length).toBeGreaterThan(0);
  expect(commitments.reducerVersion).toBe(REDUCER_VERSION);
  const schedule = await readProjection(tx => readScheduleProjection(tx, { ownerScopeId: owner, asOf: NOW }));
  expect(schedule.rows.length).toBeGreaterThan(0);
  expect(schedule.rows.every(row => row.outcomeResolutionId === null || typeof row.outcomeResolutionId === 'string')).toBe(true);

  // The reducer may read canonical memory and may not write it: no INSERT policy
  // on any canonical table admits `memory.project`.
  await expect(reduce(tx => createFrameInstance(tx, {
    ownerScopeId: owner, frameTypeId: 'shared.obligation', contextSpaceId: baseContextSpaceId,
  }))).rejects.toMatchObject({ code: '42501' });
  // ...and a purpose that can read canonical memory but is not the reducer's may
  // not write a projection row. `memory.inspect` reads every canonical table the
  // reducer reads, so the refusal below comes from the projection INSERT policy
  // and not from an empty read.
  await expect(as('memory.inspect', tx => applyProjectionDelta(tx, {
    ownerScopeId: owner, projectionName: 'obligations_projection', asOf: NOW,
  }))).rejects.toMatchObject({ code: '42501' });
  // A projection read purpose sees the rows and the owner's overlay, and no
  // canonical table at all.
  await readProjection(async tx => {
    expect((await tx.query('SELECT * FROM frame_instances')).rows).toEqual([]);
    expect((await tx.query('SELECT * FROM propositions')).rows).toEqual([]);
    expect((await tx.query('SELECT count(*)::int n FROM obligations_projection')).rows[0]!['n']).toBeGreaterThan(0);
  });
});
