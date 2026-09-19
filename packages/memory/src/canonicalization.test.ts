import { Pool } from 'pg';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { runMigrations, withOwnerTransaction, type OwnerTransaction } from '@unai/postgres';
import type { RequestContext } from '@unai/domain';
import {
  MEMORY_PURPOSES, canonicalizeClaim, classifySourceAttribution, resolveCanonicalContext,
  classifyTemporalUpdate, listClaimRelations, recordChange, recordCorrection,
  listInstanceMatchCandidates, mayReuseInstance, recordInstanceMatchCandidate, resolveFrameInstance, scoreInstanceMatch,
  queryBeliefState, queryCorrectedHistoricalState, queryCurrentState, queryHistoricalBeliefState,
  readBeliefTimeline, recordBeliefStateVersion,
  createFrameInstance, listClaimsForProposition, readClaim, recordClaim, resolveEntity, resolveBeliefSlot, resolveProposition,
} from './index.js';

/** Canonicalization, frame-instance matching and the bitemporal query modes over
 * real PostgreSQL, through the real owner boundary: every call below runs inside
 * `withOwnerTransaction` under the low-privilege application role, so the
 * row-level security policies of migrations 0010, 0012 and 0013 are part of what
 * these tests exercise.
 *
 * Covers CRT-REG-06-A, CRT-MEM-11-A, CRT-MEM-11-C, CRT-PRJ-06-A, CRT-MEM-09-A,
 * CRT-MEM-06-A and CRT-MEM-06-B. */

if (!process.env.UNAI_TEST_DATABASE_URL) throw new Error('Run pnpm test for the required PostgreSQL harness');
const admin = new Pool({ connectionString: process.env.UNAI_TEST_DATABASE_URL });
const appUrl = new URL(process.env.UNAI_TEST_DATABASE_URL); appUrl.username = 'canonicalization_test_app'; appUrl.password = 'test-only';
const appPool = new Pool({ connectionString: appUrl.href });

const owner = randomUUID(), actor = randomUUID();
let baseContextSpaceId = '', sourceItemId = '', anchorId = '', secondAnchorId = '', thirdAnchorId = '', transactionId = '';

const GOVERN = 'memory.govern';

beforeAll(async () => {
  await runMigrations(admin, resolve('migrations'));
  await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='canonicalization_test_app') THEN CREATE ROLE canonicalization_test_app LOGIN PASSWORD 'test-only'; END IF; END $$; GRANT unai_app TO canonicalization_test_app");
  await admin.query('INSERT INTO users(id,display_name) VALUES($1,$2)', [actor, 'Canonicalization owner']);
  await admin.query("INSERT INTO owner_scopes(id,scope_kind,display_name,created_by_user_id) VALUES($1,'PERSONAL','Canonicalization',$2)", [owner, actor]);
  await admin.query("INSERT INTO owner_scope_members(owner_scope_id,user_id,role) VALUES($1,$2,'OWNER')", [owner, actor]);
  baseContextSpaceId = (await admin.query('SELECT id FROM context_spaces WHERE owner_scope_id=$1', [owner])).rows[0].id;

  const connectorId = randomUUID(); sourceItemId = randomUUID();
  await admin.query("INSERT INTO connectors(id,owner_scope_id,connector_type,external_account_ref,permission_manifest,status) VALUES($1,$2,'CONVERSATION',$3,'{}','ACTIVE')", [connectorId, owner, owner]);
  await admin.query(`INSERT INTO source_items(id,owner_scope_id,connector_id,source_type,external_id,actor_ref,submitted_by_user_id,
    raw_object_ref,content_hash,sensitivity,allowed_purposes,ingestion_version,idempotency_key)
    VALUES($1,$2,$3,'CONVERSATION','message-1',$4,$5,$6,$7,'PRIVATE',ARRAY['PERSONAL_ASSISTANCE'],'evidence-json-v1',$8)`,
    [sourceItemId, owner, connectorId, JSON.stringify({ type: 'USER', id: actor }), actor, randomUUID(), 'a'.repeat(64), randomUUID()]);
  anchorId = randomUUID(); secondAnchorId = randomUUID(); thirdAnchorId = randomUUID();
  await admin.query(`INSERT INTO source_anchors(id,owner_scope_id,source_item_id,anchor_kind,anchor) VALUES
    ($1,$4,$5,'MESSAGE_SPAN','{"start":0,"end":24}'),($2,$4,$5,'MESSAGE_SPAN','{"start":25,"end":48}'),
    ($3,$4,$5,'MESSAGE_SPAN','{"start":49,"end":72}')`,
    [anchorId, secondAnchorId, thirdAnchorId, owner, sourceItemId]);

  // The governed transaction every recorded assessment names. The write governor
  // owns proposing, validating and committing one (CRT-WRT-02-A/B); this suite
  // needs only a committed transaction to attribute its verdicts to.
  transactionId = randomUUID();
  await admin.query(`INSERT INTO belief_transactions(id,owner_scope_id,transaction_kind,requested_by_actor_id,
    source_evidence_ids,registry_release_id,status,risk,idempotency_key,commit_receipt,committed_at)
    VALUES($1,$2,'CANONICALIZE',$3,ARRAY[$4::uuid],$5,'COMMITTED','LOW',$6,'{}',now())`,
    [transactionId, owner, actor, sourceItemId, randomUUID(), randomUUID().replaceAll('-', '')]);
});
afterAll(async () => { await appPool.end(); await admin.end(); });

function context(purpose: string): RequestContext { return { actorId: actor, ownerScopeId: owner, purpose, correlationId: randomUUID() }; }
function as<T>(purpose: string, run: (tx: OwnerTransaction) => Promise<T>) { return withOwnerTransaction(appPool, context(purpose), run); }
const write = <T,>(run: (tx: OwnerTransaction) => Promise<T>) => as(MEMORY_PURPOSES.canonicalize, run);
const govern = <T,>(run: (tx: OwnerTransaction) => Promise<T>) => as(GOVERN, run);
const read = <T,>(run: (tx: OwnerTransaction) => Promise<T>) => as(MEMORY_PURPOSES.inspect, run);

const ILS = (amount: string) => ({ amount, currency: 'ILS' });
async function person(label: string, mailbox: string): Promise<string> {
  const resolved = await write(tx => resolveEntity(tx, {
    ownerScopeId: owner, entityKind: 'PERSON', canonicalLabel: label,
    aliases: [{ aliasType: 'EMAIL', aliasValue: mailbox }, { aliasType: 'DISPLAY_NAME', aliasValue: label }],
  }));
  return resolved.entityId;
}

it('[AC44.16] CRT-REG-06-A: "Daniel says" and "Daniel believes" both canonicalize into the BASE context with source attribution, and extractor-chosen context is refused', async () => {
  const daniel = await person('Daniel Reported', 'daniel.reported@example.test');
  const me = await person('Owner Reported', 'owner.reported@example.test');
  const shared = {
    ownerScopeId: owner, frameTypeId: 'shared.obligation', predicateId: 'shared.obligation.principal_amount',
    modality: 'ACTUAL' as const, normalizedValue: ILS('50.00'),
    roles: [{ roleId: 'creditor', entityId: daniel }, { roleId: 'debtor', entityId: me }],
    identityAnchorRoles: ['creditor', 'debtor'],
    claimOrigin: 'EXTERNAL_PERSON_ASSERTION' as const, assertedByEntityId: daniel,
  };

  const says = await write(tx => canonicalizeClaim(tx, {
    ...shared, sourceAnchorId: anchorId, statement: 'Daniel says I owe ILS 50',
    instanceSignals: { explicitReference: null },
  }));
  // The second utterance refers to the same obligation -- same creditor, same
  // debtor, "the same one" -- so it reaches the same instance and therefore the
  // same slot. Nothing about the reporting verb enters the descriptor.
  const believes = await write(tx => canonicalizeClaim(tx, {
    ...shared, sourceAnchorId: secondAnchorId, statement: 'Daniel believes I owe ILS 50',
    instanceSignals: { explicitReference: 'SAME' },
  }));

  expect(says.context).toMatchObject({ contextSpaceId: baseContextSpaceId, contextKind: 'BASE' });
  expect(believes.context).toMatchObject({ contextSpaceId: baseContextSpaceId, contextKind: 'BASE' });
  expect(says.context.reason.code).toBe('DEFAULT_BASE_CONTEXT');
  expect(believes.beliefSlotId).toBe(says.beliefSlotId);
  expect(believes.propositionId).toBe(says.propositionId);
  expect(says.descriptor.contextSpaceId).toBe(baseContextSpaceId);

  // The phrasing is kept as attribution, which is what makes a quoted context
  // unnecessary (PRD §11.6 rule 3): the two claims differ here and nowhere else.
  expect(says.attribution).toMatchObject({ attributionKind: 'REPORTED_SPEECH', reportingVerb: 'says', createsQuotedContext: false, contextKind: 'BASE' });
  expect(believes.attribution).toMatchObject({ attributionKind: 'REPORTED_BELIEF', reportingVerb: 'believes', createsQuotedContext: false, contextKind: 'BASE' });
  for (const canonicalized of [says, believes]) {
    const claim = await read(tx => readClaim(tx, { ownerScopeId: owner, claimId: canonicalized.claimId }));
    expect(claim?.assertedByEntityId).toBe(daniel);
    expect((claim?.metadata as Record<string, Record<string, unknown>>)['sourceAttribution']).toMatchObject({
      attributionKind: canonicalized.attribution.attributionKind, createsQuotedContext: false,
    });
  }

  // No QUOTED context space came into existence, and none can: release 0.1.0
  // states that no rule in it creates one.
  const spaces = (await admin.query('SELECT context_kind,lifecycle FROM context_spaces WHERE owner_scope_id=$1', [owner])).rows;
  expect(spaces).toEqual([{ context_kind: 'BASE', lifecycle: 'ACTIVE' }]);

  // An extractor that selects the context kind is refused, by either spelling,
  // and nothing is written for the attempt.
  const before = (await admin.query('SELECT count(*)::int AS claims FROM claims WHERE owner_scope_id=$1', [owner])).rows[0].claims;
  await expect(write(tx => canonicalizeClaim(tx, { ...shared, sourceAnchorId: thirdAnchorId, contextKind: 'QUOTED' })))
    .rejects.toThrow('EXTRACTOR_CONTEXT_SELECTION_REFUSED');
  await expect(write(tx => canonicalizeClaim(tx, { ...shared, sourceAnchorId: thirdAnchorId, extractorContext: { contextSpaceId: baseContextSpaceId } })))
    .rejects.toThrow('EXTRACTOR_CONTEXT_SELECTION_REFUSED');
  await expect(write(tx => resolveCanonicalContext(tx, { ownerScopeId: owner, extractorContext: { contextKind: 'QUOTED' } })))
    .rejects.toThrow('EXTRACTOR_CONTEXT_SELECTION_REFUSED');
  expect((await admin.query('SELECT count(*)::int AS claims FROM claims WHERE owner_scope_id=$1', [owner])).rows[0].claims).toBe(before);

  // Even an explicit rule cannot conjure a quoted world as a side effect: it must
  // find a context space that already exists, and none does.
  await expect(write(tx => resolveCanonicalContext(tx, {
    ownerScopeId: owner, contextRule: { contextKind: 'QUOTED', ruleId: 'test.quoted_rule', source: 'REGISTRY_RULE' },
  }))).rejects.toThrow('QUOTED_CONTEXT_SPACE_UNAVAILABLE');

  // The classifier itself never answers anything but BASE.
  for (const statement of ['Daniel says I owe ILS 50', 'Daniel believes I owe ILS 50', 'Daniel told me I owe ILS 50', 'I owe Daniel ILS 50']) {
    expect(classifySourceAttribution(statement)).toMatchObject({ contextKind: 'BASE', createsQuotedContext: false });
  }
});

it('[AC44.02] CRT-MEM-11-A: "Daniel lent me another ILS 50" creates a separate candidate obligation instance', async () => {
  const daniel = await person('Daniel Lender', 'daniel.lender@example.test');
  const me = await person('Owner Borrower', 'owner.borrower@example.test');
  const roles = [{ roleId: 'creditor', entityId: daniel }, { roleId: 'debtor', entityId: me }];
  const shared = {
    ownerScopeId: owner, frameTypeId: 'shared.obligation', predicateId: 'shared.obligation.principal_amount',
    modality: 'ACTUAL' as const, normalizedValue: ILS('50.00'), roles, identityAnchorRoles: ['creditor', 'debtor'],
    claimOrigin: 'USER_STATEMENT' as const, materiality: 'MATERIAL_ACCEPTED_UPDATE' as const,
  };

  const first = await write(tx => canonicalizeClaim(tx, { ...shared, sourceAnchorId: anchorId, statement: 'I owe Daniel ILS 50' }));
  expect(first.instanceMatch.outcome).toBe('NEW_INSTANCE');
  expect(first.instanceCreated).toBe(true);

  // Same creditor, same debtor, same amount, compatible time: everything a naive
  // matcher would join. The word "another" is the signal that decides.
  const second = await write(tx => canonicalizeClaim(tx, {
    ...shared, sourceAnchorId: secondAnchorId, statement: 'Daniel lent me another ILS 50',
    instanceSignals: { explicitReference: 'ANOTHER', amountCompatibility: 'EQUAL', temporalCompatibility: 'COMPATIBLE', threadContinuity: true },
  }));
  expect(second.frameInstanceId).not.toBe(first.frameInstanceId);
  expect(second.reusedExistingInstance).toBe(false);
  expect(second.instanceMatch.outcome).toBe('CONFIRMED_DISTINCT');
  expect(second.beliefSlotId).not.toBe(first.beliefSlotId);

  // The instance it declined to join is on the record with its reason, which is
  // the Merge and split review screen's evidence.
  const recorded = await read(tx => listInstanceMatchCandidates(tx, { ownerScopeId: owner, frameInstanceId: second.frameInstanceId }));
  const distinct = recorded.filter(row => row.candidateFrameInstanceId === first.frameInstanceId);
  expect(distinct).toHaveLength(1);
  expect(distinct[0]).toMatchObject({
    matchOutcome: 'CONFIRMED_DISTINCT', reusedExistingInstance: false,
    resolvedFrameInstanceId: second.frameInstanceId, claimId: second.claimId,
  });
  expect(distinct[0]!.decisionReason['code']).toBe('EXPLICIT_DISTINCT_REFERENCE');

  // Two obligations, two amounts, each with its own claim: the second ILS 50 did
  // not overwrite or corroborate the first.
  expect(second.propositionId).not.toBe(first.propositionId);
});

it('CRT-MEM-11-C: a PROBABLE_MATCH or POSSIBLE_MATCH never reuses an existing instance for a material accepted update', async () => {
  const creditor = await person('Daniel Probable', 'daniel.probable@example.test');
  const debtor = await person('Owner Probable', 'owner.probable@example.test');
  const roles = [{ roleId: 'creditor', entityId: creditor }, { roleId: 'debtor', entityId: debtor }];
  const request = {
    ownerScopeId: owner, frameTypeId: 'shared.obligation', contextSpaceId: baseContextSpaceId,
    roles, identityAnchorRoles: ['creditor', 'debtor'],
  };
  const existing = await write(tx => resolveFrameInstance(tx, { ...request, materiality: 'MATERIAL_ACCEPTED_UPDATE' }));
  expect(existing.outcome).toBe('NEW_INSTANCE');

  // Strong circumstantial agreement: both participants, one thread, one origin
  // event, a compatible time. It is still not a confirmation.
  const probable = await write(tx => resolveFrameInstance(tx, {
    ...request, materiality: 'MATERIAL_ACCEPTED_UPDATE',
    threadContinuity: true, sharedOriginEvent: true, temporalCompatibility: 'COMPATIBLE',
  }));
  expect(probable.outcome).toBe('PROBABLE_MATCH');
  expect(probable.reusedExistingInstance).toBe(false);
  expect(probable.frameInstanceId).not.toBe(existing.frameInstanceId);

  // Both participants and nothing else.
  const possible = await write(tx => resolveFrameInstance(tx, { ...request, materiality: 'MATERIAL_ACCEPTED_UPDATE' }));
  expect(possible.outcome).toBe('POSSIBLE_MATCH');
  expect(possible.reusedExistingInstance).toBe(false);
  expect([existing.frameInstanceId, probable.frameInstanceId]).not.toContain(possible.frameInstanceId);

  // The control: a confirmation does reuse, so the test above is about the
  // outcome and not about the matcher being unable to reuse at all.
  const confirmed = await write(tx => resolveFrameInstance(tx, {
    ...request, materiality: 'MATERIAL_ACCEPTED_UPDATE', explicitReference: 'SAME',
  }));
  expect(confirmed.outcome).toBe('CONFIRMED_MATCH');
  expect(confirmed.reusedExistingInstance).toBe(true);
  expect([existing.frameInstanceId, probable.frameInstanceId, possible.frameInstanceId]).toContain(confirmed.frameInstanceId);

  // The rule is also a refusal, not only a decision the matcher happens to make:
  // recording a reuse behind a non-confirmed outcome is refused by the service
  // and, underneath it, by the schema.
  expect(mayReuseInstance('PROBABLE_MATCH', 'MATERIAL_ACCEPTED_UPDATE')).toBe(false);
  expect(mayReuseInstance('POSSIBLE_MATCH', 'MATERIAL_ACCEPTED_UPDATE')).toBe(false);
  expect(mayReuseInstance('CONFIRMED_MATCH', 'MATERIAL_ACCEPTED_UPDATE')).toBe(true);
  for (const outcome of ['PROBABLE_MATCH', 'POSSIBLE_MATCH'] as const) {
    await expect(write(tx => recordInstanceMatchCandidate(tx, {
      ownerScopeId: owner, frameTypeId: 'shared.obligation', candidateFrameInstanceId: existing.frameInstanceId,
      resolvedFrameInstanceId: existing.frameInstanceId, matchOutcome: outcome,
      materiality: 'MATERIAL_ACCEPTED_UPDATE', reusedExistingInstance: true,
    }))).rejects.toThrow('INSTANCE_MATCH_REUSE_REFUSED');
  }

  // The scorer is pure and reaches the five outcomes from signals alone.
  expect(scoreInstanceMatch({ explicitReference: 'ANOTHER', sharedResolvedEntityRoles: ['creditor', 'debtor'] }).outcome).toBe('CONFIRMED_DISTINCT');
  expect(scoreInstanceMatch({ externalIdentifierMatch: true }).outcome).toBe('CONFIRMED_MATCH');
  expect(scoreInstanceMatch({}).outcome).toBe('NEW_INSTANCE');
});

it('[AC44.03] CRT-PRJ-06-A: "Actually, it was ILS 60" leaves one slot with two propositions and the original ILS 50 claim retrievable', async () => {
  const daniel = await person('Daniel Corrected', 'daniel.corrected@example.test');
  const me = await person('Owner Corrected', 'owner.corrected@example.test');
  const first = await write(tx => canonicalizeClaim(tx, {
    ownerScopeId: owner, frameTypeId: 'shared.obligation', predicateId: 'shared.obligation.principal_amount',
    modality: 'ACTUAL', normalizedValue: ILS('50.00'),
    roles: [{ roleId: 'creditor', entityId: daniel }, { roleId: 'debtor', entityId: me }],
    identityAnchorRoles: ['creditor', 'debtor'], sourceAnchorId: anchorId,
    claimOrigin: 'USER_STATEMENT', statement: 'I owe Daniel ILS 50', materiality: 'MATERIAL_ACCEPTED_UPDATE',
  }));

  const corrected = await govern(tx => recordCorrection(tx, {
    ownerScopeId: owner, correctedClaimId: first.claimId, normalizedValue: ILS('60.00'),
    claim: { sourceAnchorId: secondAnchorId, claimOrigin: 'USER_CORRECTION' }, transactionId,
  }));
  expect(corrected.beliefSlotId).toBe(first.beliefSlotId);
  expect(corrected.propositionId).not.toBe(first.propositionId);

  // One slot, two propositions: a slot excludes the value, so ILS 60 joins ILS 50
  // instead of replacing it.
  const propositions = (await admin.query(
    'SELECT normalized_value FROM propositions WHERE owner_scope_id=$1 AND belief_slot_id=$2 ORDER BY created_at',
    [owner, first.beliefSlotId])).rows.map(row => row.normalized_value);
  expect(propositions).toEqual([ILS('50.00'), ILS('60.00')]);

  // The original claim is still there, still attached to the ILS 50 proposition,
  // still saying what it said.
  const original = await read(tx => readClaim(tx, { ownerScopeId: owner, claimId: first.claimId }));
  expect(original).toMatchObject({ claimId: first.claimId, propositionId: first.propositionId, claimOrigin: 'USER_STATEMENT' });
  expect(await read(tx => listClaimsForProposition(tx, { ownerScopeId: owner, propositionId: first.propositionId })))
    .toEqual([expect.objectContaining({ claimId: first.claimId })]);

  const relations = await read(tx => listClaimRelations(tx, { ownerScopeId: owner, claimId: first.claimId }));
  expect(relations).toEqual([expect.objectContaining({
    fromClaimId: corrected.claimId, toClaimId: first.claimId, relationKind: 'CORRECTS', temporalEffect: 'SAME_VALID_INTERVAL',
  })]);
});

it('CRT-MEM-09-A: a correction restates one valid interval while a change opens a second, non-overlapping one', async () => {
  // The salary example of PRD §57. No registry release in this repository
  // defines an employment contract, so nothing here may be *accepted* by the
  // write governor without one (CRT-MEM-01-A, another node's check); what this
  // test asserts is the bitemporal representation the two statements produce.
  const august = new Date('2025-08-01T00:00:00.000Z');
  const january = new Date('2025-01-01T00:00:00.000Z');

  async function salarySlot(): Promise<{ beliefSlotId: string; claimId: string; propositionId: string }> {
    return write(async tx => {
      const frameInstanceId = await createFrameInstance(tx, {
        ownerScopeId: owner, frameTypeId: 'work.employment', contextSpaceId: baseContextSpaceId,
      });
      const slot = await resolveBeliefSlot(tx, {
        ownerScopeId: owner, descriptor: {
          frameInstanceId, predicateId: 'work.employment.salary_amount', contextSpaceId: baseContextSpaceId,
          modality: 'ACTUAL', qualifiers: {},
        },
      });
      const proposition = await resolveProposition(tx, {
        ownerScopeId: owner, beliefSlotId: slot.beliefSlotId, normalizedValue: { amount: '50000.00', currency: 'ILS' },
      });
      const claimId = await recordClaim(tx, {
        ownerScopeId: owner, sourceAnchorId: anchorId, claimOrigin: 'USER_STATEMENT',
        propositionId: proposition.propositionId, validFrom: january, lifecycle: 'PROVISIONAL',
      });
      return { beliefSlotId: slot.beliefSlotId, claimId, propositionId: proposition.propositionId };
    });
  }

  // "My salary is 50,000." -- "Actually it was 55,000."
  const correctedCase = await salarySlot();
  const correction = await govern(tx => recordCorrection(tx, {
    ownerScopeId: owner, correctedClaimId: correctedCase.claimId, normalizedValue: { amount: '55000.00', currency: 'ILS' },
    claim: { sourceAnchorId: secondAnchorId, claimOrigin: 'USER_CORRECTION' }, transactionId,
  }));

  // "January 1: salary 50,000." -- "salary changed to 55,000 on August 1."
  const changedCase = await salarySlot();
  const change = await govern(tx => recordChange(tx, {
    ownerScopeId: owner, previousClaimId: changedCase.claimId, changedAt: august,
    normalizedValue: { amount: '55000.00', currency: 'ILS' },
    claim: { sourceAnchorId: thirdAnchorId, claimOrigin: 'USER_STATEMENT' }, transactionId,
  }));

  // The correction speaks about the interval that was already covered: one
  // interval, two propositions in it, the corrected value superseded.
  expect(correction.validPeriods).toEqual([
    { propositionId: correctedCase.propositionId, assessmentStatus: 'SUPERSEDED', validFrom: january.toISOString(), validTo: null },
    { propositionId: correction.propositionId, assessmentStatus: 'ACCEPTED', validFrom: january.toISOString(), validTo: null },
  ]);
  expect(correction.relation).toMatchObject({ relationKind: 'CORRECTS', temporalEffect: 'SAME_VALID_INTERVAL' });

  // The change ends one period and opens the next. Both stay accepted, and the
  // half-open intervals do not overlap at the change instant.
  expect(change.validPeriods).toEqual([
    { propositionId: changedCase.propositionId, assessmentStatus: 'ACCEPTED', validFrom: january.toISOString(), validTo: august.toISOString() },
    { propositionId: change.propositionId, assessmentStatus: 'ACCEPTED', validFrom: august.toISOString(), validTo: null },
  ]);
  expect(change.relation).toMatchObject({ relationKind: 'SUPERSEDES', temporalEffect: 'NEW_VALID_PERIOD' });

  // The test fails if the two produce the same representation.
  const shape = (result: typeof correction) => ({
    kind: result.kind, relationKind: result.relation.relationKind, temporalEffect: result.relation.temporalEffect,
    periods: result.validPeriods.map(period => ({ status: period.assessmentStatus, from: period.validFrom, to: period.validTo })),
  });
  expect(shape(correction)).not.toEqual(shape(change));
  expect(new Set(change.validPeriods.map(period => period.validTo)).size).toBe(2);
  expect(new Set(correction.validPeriods.map(period => period.validTo)).size).toBe(1);

  // On the same date the two answer differently: on March 1 the changed slot
  // still holds 50,000, while the corrected slot holds the corrected value.
  const march = new Date('2025-03-01T00:00:00.000Z');
  const correctedOnMarch = await read(tx => queryCorrectedHistoricalState(tx, { ownerScopeId: owner, beliefSlotId: correctedCase.beliefSlotId, worldTime: march }));
  const changedOnMarch = await read(tx => queryCorrectedHistoricalState(tx, { ownerScopeId: owner, beliefSlotId: changedCase.beliefSlotId, worldTime: march }));
  expect(correctedOnMarch.states.map(state => state.normalizedValue)).toEqual([{ amount: '55000.00', currency: 'ILS' }]);
  expect(changedOnMarch.states.map(state => state.normalizedValue)).toEqual([{ amount: '50000.00', currency: 'ILS' }]);

  // The language classifier is what tells the two apart before either is written,
  // and it refuses to guess when neither marker is present (PRD §57).
  expect(classifyTemporalUpdate('Actually, I said it wrong; it was 55,000').kind).toBe('CORRECTION');
  expect(classifyTemporalUpdate('My salary changed to 55,000 on August 1').kind).toBe('CHANGE');
  expect(classifyTemporalUpdate('55,000').kind).toBe('AMBIGUOUS');
});

it('[AC44.10] CRT-MEM-06-A and CRT-MEM-06-B: the §44.10 late-arriving correction answers three query modes differently for August 7', async () => {
  // Uai learns on August 10 that the obligation changed on August 5.
  const validFrom = new Date('2025-08-01T00:00:00.000Z');
  const changedAt = new Date('2025-08-05T00:00:00.000Z');
  const learnedFirst = new Date('2025-08-01T09:00:00.000Z');
  const learnedCorrection = new Date('2025-08-10T09:00:00.000Z');
  const august7 = new Date('2025-08-07T00:00:00.000Z');

  const daniel = await person('Daniel Timeline', 'daniel.timeline@example.test');
  const me = await person('Owner Timeline', 'owner.timeline@example.test');
  const original = await write(tx => canonicalizeClaim(tx, {
    ownerScopeId: owner, frameTypeId: 'shared.obligation', predicateId: 'shared.obligation.principal_amount',
    modality: 'ACTUAL', normalizedValue: ILS('50.00'),
    roles: [{ roleId: 'creditor', entityId: daniel }, { roleId: 'debtor', entityId: me }],
    identityAnchorRoles: ['creditor', 'debtor'], sourceAnchorId: anchorId, claimOrigin: 'USER_STATEMENT',
    statement: 'I owe Daniel ILS 50', validFrom, materiality: 'MATERIAL_ACCEPTED_UPDATE',
  }));
  // What Uai believed from August 1 on.
  await govern(tx => recordBeliefStateVersion(tx, {
    ownerScopeId: owner, propositionId: original.propositionId, assessmentStatus: 'ACCEPTED',
    transactionId, validFrom, knowledgeTime: learnedFirst,
  }));

  const late = await govern(tx => recordChange(tx, {
    ownerScopeId: owner, previousClaimId: original.claimId, changedAt, normalizedValue: ILS('30.00'),
    claim: { sourceAnchorId: secondAnchorId, claimOrigin: 'USER_STATEMENT' },
    transactionId, knowledgeTime: learnedCorrection,
  }));

  const scope = { ownerScopeId: owner, beliefSlotId: original.beliefSlotId };
  // CRT-MEM-06-A: what do we now believe was true on August 7?
  const correctedHistorical = await read(tx => queryCorrectedHistoricalState(tx, { ...scope, worldTime: august7 }));
  expect(correctedHistorical.states.map(state => state.normalizedValue)).toEqual([ILS('30.00')]);
  expect(correctedHistorical.states[0]).toMatchObject({ propositionId: late.propositionId, assessmentStatus: 'ACCEPTED' });

  // CRT-MEM-06-A: what did Uai believe on August 7, knowing only what it knew then?
  const historicalBelief = await read(tx => queryHistoricalBeliefState(tx, { ...scope, worldTime: august7 }));
  expect(historicalBelief.states.map(state => state.normalizedValue)).toEqual([ILS('50.00')]);
  expect(historicalBelief.states[0]).toMatchObject({ propositionId: original.propositionId, assessmentStatus: 'ACCEPTED' });
  expect(historicalBelief.knowledgeTime).toBe(august7.toISOString());

  // CRT-MEM-06-B: world time now, knowledge time latest.
  const current = await read(tx => queryCurrentState(tx, scope));
  expect(current.states.map(state => state.normalizedValue)).toEqual([ILS('30.00')]);
  expect(current.states[0]).toMatchObject({ supersededRecordedAt: null, validTo: null });
  expect(current.knowledgeTime).toBeNull();
  expect(new Date(current.worldTime).getTime()).toBeGreaterThan(learnedCorrection.getTime());

  // The three modes are three questions: the same instant, three answers.
  expect(correctedHistorical.states[0]!.propositionId).not.toBe(historicalBelief.states[0]!.propositionId);
  expect(await read(tx => queryBeliefState(tx, { ...scope, mode: 'CORRECTED_HISTORICAL_STATE', worldTime: august7 })))
    .toEqual(correctedHistorical);
  await expect(read(tx => queryBeliefState(tx, { ...scope, mode: 'CURRENT_STATE', worldTime: august7 })))
    .rejects.toThrow('BITEMPORAL_QUERY_ARGUMENT_REFUSED');
  await expect(read(tx => queryBeliefState(tx, { ...scope, mode: 'CORRECTED_HISTORICAL_STATE', worldTime: august7, knowledgeTime: august7 })))
    .rejects.toThrow('BITEMPORAL_QUERY_ARGUMENT_REFUSED');
  await expect(read(tx => queryBeliefState(tx, { ...scope, mode: 'HISTORICAL_BELIEF_STATE' })))
    .rejects.toThrow('BITEMPORAL_QUERY_WORLD_TIME_REQUIRED');

  // Nothing was rewritten: the August 1 version is still on the timeline, closed
  // at the instant the correction arrived, which is what makes the historical
  // belief answerable at all (the Memory inspector's historical timeline).
  const timeline = await read(tx => readBeliefTimeline(tx, scope));
  expect(timeline).toHaveLength(3);
  expect(timeline[0]).toMatchObject({
    propositionId: original.propositionId, recordedAt: learnedFirst.toISOString(),
    supersededRecordedAt: learnedCorrection.toISOString(), validFrom: validFrom.toISOString(), validTo: null,
  });
  expect(timeline.slice(1).map(version => ({ from: version.validFrom, to: version.validTo, at: version.recordedAt }))).toEqual([
    { from: validFrom.toISOString(), to: changedAt.toISOString(), at: learnedCorrection.toISOString() },
    { from: changedAt.toISOString(), to: null, at: learnedCorrection.toISOString() },
  ]);

  // Knowledge time only moves forward, and never into the future.
  await expect(govern(tx => recordBeliefStateVersion(tx, {
    ownerScopeId: owner, propositionId: late.propositionId, assessmentStatus: 'CONTESTED',
    transactionId, knowledgeTime: new Date('2025-08-02T00:00:00.000Z'),
  }))).rejects.toThrow('KNOWLEDGE_TIME_NOT_MONOTONIC');
  await expect(govern(tx => recordBeliefStateVersion(tx, {
    ownerScopeId: owner, propositionId: late.propositionId, assessmentStatus: 'CONTESTED',
    transactionId, knowledgeTime: new Date(Date.now() + 86_400_000),
  }))).rejects.toThrow('KNOWLEDGE_TIME_IN_FUTURE');
});
