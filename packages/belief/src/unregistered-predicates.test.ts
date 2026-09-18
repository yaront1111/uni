import { Pool } from 'pg';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { runMigrations, withOwnerTransaction, type OwnerTransaction } from '@unai/postgres';
import { loadRegistryRelease, publishRegistryRelease } from '@unai/registry';
import { searchMemoryEmbeddings } from '@unai/memory';
import type { BeliefOperation, ProposeBeliefTransaction } from '@unai/domain';
import {
  commitBeliefTransaction, createLocalPolicyAdapters, proposeBeliefTransaction, readCurrentAssessment,
  validateBeliefTransaction, type BeliefTransactionRunner, type GovernorRequest,
} from './index.js';

/**
 * CRT-REG-04-A over real PostgreSQL and the real pinned registry release 0.1.0:
 * a claim under a surface predicate the release does not hold is stored and is
 * semantically searchable, and a transaction that would use it to supersede an
 * accepted belief, resolve a conflict, set a current value or authorize a
 * high-risk action is refused (PRD §17.5, ADR 0023 §4).
 *
 * Every call runs inside `withOwnerTransaction` as the low-privilege application
 * role, so migration 0018's index policy is part of what is proved.
 */

if (!process.env.UNAI_TEST_DATABASE_URL) throw new Error('Run pnpm test for the required PostgreSQL harness');
const admin = new Pool({ connectionString: process.env.UNAI_TEST_DATABASE_URL });
const appUrl = new URL(process.env.UNAI_TEST_DATABASE_URL); appUrl.username = 'unregistered_test_app'; appUrl.password = 'test-only';
const appPool = new Pool({ connectionString: appUrl.href });

const owner = randomUUID(), actor = randomUUID();
const PURPOSE = 'PERSONAL_ASSISTANCE';
/** Not in registry release 0.1.0: an owner's informal remark about the loan. */
const SURFACE_PREDICATE = 'shared.obligation.informal_note';
let registryReleaseId = '', danielEntityId = '', aliceEntityId = '', anchorId = '', sourceItemId = '';
let obligationFrame = '', unregisteredProposition = '', unregisteredClaim = '';

function git(repository: string, ...args: string[]) {
  const result = spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=Registry Test', '-c', 'user.email=registry@test.invalid', ...args],
    { cwd: repository, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: '2024-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2024-01-01T00:00:00Z' } });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

/** The immutable 0.1.0 snapshot, published by whichever suite gets there first. */
async function pinnedRegistryRelease(): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const existing = (await admin.query("SELECT id FROM registry_releases WHERE semantic_version='0.1.0'")).rows[0];
    if (existing) return existing.id as string;
    await sleep(250);
  }
  const repository = await mkdtemp(join(tmpdir(), 'unai-unregistered-registry-'));
  try {
    await cp(resolve('registry'), join(repository, 'registry'), { recursive: true });
    git(repository, 'init', '--quiet'); git(repository, 'add', 'registry');
    git(repository, 'commit', '--quiet', '-m', 'release'); git(repository, 'tag', 'registry-v0.1.0');
    const release = await loadRegistryRelease({ repository, version: '0.1.0' });
    return (await publishRegistryRelease(admin, release, randomUUID())).releaseId;
  } finally { await rm(repository, { recursive: true, force: true }); }
}

beforeAll(async () => {
  await runMigrations(admin, resolve('migrations'));
  await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='unregistered_test_app') THEN CREATE ROLE unregistered_test_app LOGIN PASSWORD 'test-only'; END IF; END $$; GRANT unai_app TO unregistered_test_app");
  await admin.query('INSERT INTO users(id,display_name) VALUES($1,$2)', [actor, 'Registry owner']);
  await admin.query("INSERT INTO owner_scopes(id,scope_kind,display_name,created_by_user_id) VALUES($1,'PERSONAL','Registry',$2)", [owner, actor]);
  await admin.query("INSERT INTO owner_scope_members(owner_scope_id,user_id,role) VALUES($1,$2,'OWNER')", [owner, actor]);
  danielEntityId = randomUUID(); aliceEntityId = randomUUID();
  await admin.query("INSERT INTO entities(id,owner_scope_id,entity_kind,canonical_label) VALUES($1,$3,'PERSON','Daniel'),($2,$3,'PERSON','Alice')",
    [danielEntityId, aliceEntityId, owner]);
  sourceItemId = randomUUID(); anchorId = randomUUID();
  const connectorId = randomUUID();
  await admin.query("INSERT INTO connectors(id,owner_scope_id,connector_type,external_account_ref,permission_manifest,status) VALUES($1,$2,'CONVERSATION','owner-chat','{}','ACTIVE')",
    [connectorId, owner]);
  await admin.query(`INSERT INTO source_items(id,owner_scope_id,connector_id,source_type,external_id,actor_ref,submitted_by_user_id,
    raw_object_ref,content_hash,sensitivity,allowed_purposes,ingestion_version,idempotency_key,occurred_at)
    VALUES($1,$2,$3,'CONVERSATION','owner-message-1',$4,$5,$6,$7,'PRIVATE',ARRAY[$8],'evidence-json-v1',$9,$10)`,
    [sourceItemId, owner, connectorId, JSON.stringify({ type: 'USER', id: actor }), actor, randomUUID(),
      randomUUID().replaceAll('-', '').padEnd(64, 'a').slice(0, 64), PURPOSE, randomUUID(), new Date('2026-02-01T08:00:00.000Z')]);
  await admin.query("INSERT INTO source_anchors(id,owner_scope_id,source_item_id,anchor_kind,anchor) VALUES($1,$2,$3,'MESSAGE_SPAN','{\"start\":0,\"end\":64}')",
    [anchorId, owner, sourceItemId]);
  registryReleaseId = await pinnedRegistryRelease();
});
afterAll(async () => { await appPool.end(); await admin.end(); });

const runner: BeliefTransactionRunner = (purpose, run) =>
  withOwnerTransaction(appPool, { actorId: actor, ownerScopeId: owner, purpose, correlationId: randomUUID() },
    tx => run(tx as OwnerTransaction));
const request = (): GovernorRequest => ({ ownerScopeId: owner, actorId: actor, correlationId: randomUUID(),
  dataPurpose: PURPOSE, maximumSensitivity: 'RESTRICTED' });
const key = (label: string) => (label + randomUUID()).replaceAll('-', '').slice(0, 64);
const proposal = (operations: BeliefOperation[], over: Partial<ProposeBeliefTransaction> = {}): ProposeBeliefTransaction => ({
  transactionKind: 'CANONICALIZE', registryReleaseId, risk: 'LOW', idempotencyKey: key('reg04'),
  sourceEvidenceIds: [sourceItemId], operations, ...over,
});
async function validate(operations: BeliefOperation[], over: Partial<ProposeBeliefTransaction> = {}) {
  const input = proposal(operations, over);
  const proposed = await proposeBeliefTransaction(runner, request(), input);
  const report = await validateBeliefTransaction(runner, request(), proposed.transactionId);
  return { input, transactionId: proposed.transactionId, report };
}
async function commit(operations: BeliefOperation[], over: Partial<ProposeBeliefTransaction> = {}) {
  const { input, transactionId, report } = await validate(operations, over);
  const receipt = await commitBeliefTransaction(runner, request(), { transactionId, idempotencyKey: input.idempotencyKey });
  return { transactionId, report, receipt };
}
const created = (receipt: { createdObjects: readonly { objectType: string; objectId: string }[] }, type: string) =>
  receipt.createdObjects.filter(object => object.objectType === type).map(object => object.objectId);
const claimOn = (proposition: string, ref = '#claim'): BeliefOperation => ({
  kind: 'ADD_CLAIM', operationRef: ref, sourceAnchorId: anchorId, proposition, assertedByEntityId: danielEntityId,
  claimOrigin: 'USER_STATEMENT', lifecycle: 'PROVISIONAL' });
const status = async (propositionId: string) =>
  (await withOwnerTransaction(appPool, { actorId: actor, ownerScopeId: owner, purpose: 'memory.inspect', correlationId: randomUUID() },
    tx => readCurrentAssessment(tx, owner, propositionId)))?.assessmentStatus;

/** A registered value in a new slot of the obligation, with the given verdict. */
async function registeredValue(amount: string, assessmentStatus: 'ACCEPTED' | 'CONTESTED', slot?: string): Promise<{ propositionId: string; slotId: string }> {
  const operations: BeliefOperation[] = [
    ...(slot ? [] : [{ kind: 'CREATE_SLOT', operationRef: '#slot', frameInstance: obligationFrame,
      predicateId: 'shared.obligation.principal_amount', modality: 'ACTUAL', qualifiers: {} } as BeliefOperation]),
    { kind: 'CREATE_PROPOSITION', operationRef: '#value', beliefSlot: slot ?? '#slot', normalizedValue: { amount, currency: 'ILS' } },
    claimOn('#value'),
    { kind: 'ADD_SUPPORT', proposition: '#value', claim: '#claim', supportKind: 'DIRECT_ASSERTION' },
    { kind: 'SET_BELIEF_ASSESSMENT', proposition: '#value', assessmentStatus },
  ];
  const { receipt } = await commit(operations);
  return { propositionId: created(receipt, 'propositions')[0]!, slotId: slot ?? created(receipt, 'belief_slots')[0]! };
}

it('CRT-REG-04-A: a claim with an unregistered predicate is stored and semantically searchable', async () => {
  const operations: BeliefOperation[] = [
    { kind: 'CREATE_FRAME_INSTANCE', operationRef: '#instance', frameTypeId: 'shared.obligation',
      roles: [{ roleId: 'creditor', entityId: danielEntityId }, { roleId: 'debtor', entityId: aliceEntityId }] },
    { kind: 'CREATE_SLOT', operationRef: '#note-slot', frameInstance: '#instance', predicateId: SURFACE_PREDICATE,
      modality: 'ACTUAL', qualifiers: {} },
    { kind: 'CREATE_PROPOSITION', operationRef: '#note', beliefSlot: '#note-slot',
      normalizedValue: { text: 'Daniel said the repayment can wait until the summer holidays' } },
    claimOn('#note'),
    { kind: 'ADD_SUPPORT', proposition: '#note', claim: '#claim', supportKind: 'DIRECT_ASSERTION' },
    { kind: 'SET_BELIEF_ASSESSMENT', proposition: '#note', assessmentStatus: 'PROVISIONAL' },
  ];
  const { report, receipt } = await commit(operations);
  // Storing it is not a use PRD §17.5 forbids: the transaction commits, and the
  // report says the predicate is unregistered without refusing anything.
  expect(report.decision).toBe('COMMITTABLE');
  expect(report.unregisteredPredicateUses).toEqual([]);
  expect(report.withheldAutoAcceptConditions).toContain('PREDICATE_REGISTERED');
  obligationFrame = created(receipt, 'frame_instances')[0]!;
  unregisteredProposition = created(receipt, 'propositions')[0]!;
  unregisteredClaim = created(receipt, 'claims')[0]!;

  // Stored: the claim, its proposition in a slot under the surface predicate.
  const stored = (await admin.query(`SELECT c.lifecycle,s.predicate_id FROM claims c JOIN propositions p ON p.id=c.proposition_id
    JOIN belief_slots s ON s.id=p.belief_slot_id WHERE c.id=$1`, [unregisteredClaim])).rows[0];
  expect(stored).toEqual({ lifecycle: 'PROVISIONAL', predicate_id: SURFACE_PREDICATE });
  // Indexed by the commit itself, in the same transaction.
  const row = (await admin.query('SELECT predicate_id,security_scope,allowed_purposes,source_item_ids FROM memory_embeddings WHERE object_id=$1',
    [unregisteredClaim])).rows[0];
  expect(row).toEqual({ predicate_id: SURFACE_PREDICATE, security_scope: 'PRIVATE', allowed_purposes: [PURPOSE],
    source_item_ids: [sourceItemId] });

  // Searchable: the model read path finds it by meaning-bearing words, and marks it
  // as a recalled source rather than an established value.
  const search = await withOwnerTransaction(appPool, { actorId: actor, ownerScopeId: owner, purpose: 'memory.read', correlationId: randomUUID() },
    async tx => {
      await tx.query("SELECT set_config('unai.data_purpose',$1,true),set_config('unai.maximum_sensitivity','PRIVATE',true)", [PURPOSE]);
      return searchMemoryEmbeddings(tx, { ownerScopeId: owner, query: 'when can the repayment wait until? summer', dataPurpose: PURPOSE,
        // A minute ahead of this process's clock, so a database clock a little
        // ahead of it cannot put the claim after the knowledge time.
        maximumSensitivity: 'PRIVATE', knowledgeTime: new Date(Date.now() + 60_000), registryReleaseId });
    });
  expect(search?.matches[0]).toMatchObject({
    objectId: unregisteredClaim, propositionId: unregisteredProposition, predicateId: SURFACE_PREDICATE,
    predicateRegistered: false, authority: 'NON_AUTHORITATIVE_UNREGISTERED_PREDICATE', evidenceIds: [sourceItemId],
  });
});

it('CRT-REG-04-A: a transaction using it to supersede an accepted belief is refused', async () => {
  const accepted = await registeredValue('50.00', 'ACCEPTED');
  expect(await status(accepted.propositionId)).toBe('ACCEPTED');
  const superseding: BeliefOperation[] = [
    claimOn(unregisteredProposition),
    { kind: 'SET_BELIEF_ASSESSMENT', proposition: accepted.propositionId, assessmentStatus: 'SUPERSEDED',
      decisionReason: { code: 'OWNER_NOTE_SAYS_OTHERWISE' } },
  ];
  const { input, transactionId, report } = await validate(superseding);
  expect(report.decision).toBe('REJECTED');
  expect(report.unregisteredPredicateUses).toContainEqual({ use: 'SUPERSEDE_ACCEPTED_BELIEF', operationOrder: 1,
    propositionRef: accepted.propositionId, contractIds: [SURFACE_PREDICATE] });
  await expect(commitBeliefTransaction(runner, request(), { transactionId, idempotencyKey: input.idempotencyKey }))
    .rejects.toThrow('BELIEF_TRANSACTION_REFUSED');
  expect(await status(accepted.propositionId)).toBe('ACCEPTED');
  expect((await admin.query('SELECT status FROM belief_transactions WHERE id=$1', [transactionId])).rows[0].status).toBe('REJECTED');

  // The same supersession resting on registered memory is not refused for this
  // reason: the refusal is the unregistered predicate's, not supersession's.
  const control = await validate([
    { kind: 'SET_BELIEF_ASSESSMENT', proposition: accepted.propositionId, assessmentStatus: 'SUPERSEDED' },
  ]);
  expect(control.report.unregisteredPredicateUses).toEqual([]);
  expect(control.report.decision).not.toBe('REJECTED');
});

it('CRT-REG-04-A: a transaction using it to resolve a conflict is refused', async () => {
  const first = await registeredValue('50.00', 'CONTESTED');
  const second = await registeredValue('60.00', 'CONTESTED', first.slotId);
  const resolving: BeliefOperation[] = [
    { kind: 'ADD_SUPPORT', proposition: first.propositionId, supportingProposition: unregisteredProposition, supportKind: 'CORROBORATION' },
    { kind: 'SET_BELIEF_ASSESSMENT', proposition: second.propositionId, assessmentStatus: 'REJECTED' },
  ];
  const { input, transactionId, report } = await validate(resolving);
  expect(report.decision).toBe('REJECTED');
  expect(report.unregisteredPredicateUses.map(use => use.use)).toEqual(['RESOLVE_CONFLICT']);
  await expect(commitBeliefTransaction(runner, request(), { transactionId, idempotencyKey: input.idempotencyKey }))
    .rejects.toThrow('BELIEF_TRANSACTION_REFUSED');
  // Both sides still stand.
  expect(await status(first.propositionId)).toBe('CONTESTED');
  expect(await status(second.propositionId)).toBe('CONTESTED');

  const control = await validate([
    { kind: 'SET_BELIEF_ASSESSMENT', proposition: second.propositionId, assessmentStatus: 'REJECTED' },
  ]);
  expect(control.report.unregisteredPredicateUses).toEqual([]);
  expect(control.report.decision).not.toBe('REJECTED');
});

it('CRT-REG-04-A: a transaction using it to set a current value is refused', async () => {
  const { input, transactionId, report } = await validate([
    claimOn(unregisteredProposition),
    { kind: 'SET_BELIEF_ASSESSMENT', proposition: unregisteredProposition, assessmentStatus: 'ACCEPTED' },
  ]);
  expect(report.decision).toBe('REJECTED');
  expect(report.unregisteredPredicateUses).toContainEqual({ use: 'SET_CURRENT_VALUE', operationOrder: 1,
    propositionRef: unregisteredProposition, contractIds: [SURFACE_PREDICATE] });
  await expect(commitBeliefTransaction(runner, request(), { transactionId, idempotencyKey: input.idempotencyKey }))
    .rejects.toThrow('BELIEF_TRANSACTION_REFUSED');
  expect(await status(unregisteredProposition)).toBe('PROVISIONAL');

  // Nor may it become current by standing as the support of a registered value
  // accepted in the same transaction.
  const slot = (await admin.query("SELECT id FROM belief_slots WHERE frame_instance_id=$1 AND predicate_id='shared.obligation.principal_amount' LIMIT 1",
    [obligationFrame])).rows[0].id as string;
  const viaSupport = await validate([
    { kind: 'CREATE_PROPOSITION', operationRef: '#value', beliefSlot: slot, normalizedValue: { amount: '70.00', currency: 'ILS' } },
    { kind: 'ADD_SUPPORT', proposition: '#value', supportingProposition: unregisteredProposition, supportKind: 'DERIVATION' },
    { kind: 'SET_BELIEF_ASSESSMENT', proposition: '#value', assessmentStatus: 'ACCEPTED' },
  ]);
  expect(viaSupport.report.decision).toBe('REJECTED');
  expect(viaSupport.report.unregisteredPredicateUses.map(use => use.use)).toContain('SET_CURRENT_VALUE');
  // No accepted assessment exists anywhere over the surface predicate.
  expect((await admin.query(`SELECT count(*)::int n FROM belief_assessments a JOIN propositions p ON p.id=a.proposition_id
    JOIN belief_slots s ON s.id=p.belief_slot_id WHERE a.owner_scope_id=$1 AND a.assessment_status='ACCEPTED'
    AND s.predicate_id=$2`, [owner, SURFACE_PREDICATE])).rows[0].n).toBe(0);
});

it('CRT-REG-04-A: a transaction or action using it to authorize a high-risk action is refused', async () => {
  const operations: BeliefOperation[] = [
    claimOn(unregisteredProposition),
    { kind: 'ADD_SUPPORT', proposition: unregisteredProposition, claim: '#claim', supportKind: 'DIRECT_ASSERTION' },
  ];
  const high = await validate(operations, { risk: 'HIGH' });
  expect(high.report.decision).toBe('REJECTED');
  expect(high.report.unregisteredPredicateUses).toEqual([{ use: 'AUTHORIZE_HIGH_RISK_ACTION', operationOrder: null,
    propositionRef: null, contractIds: [SURFACE_PREDICATE] }]);
  await expect(commitBeliefTransaction(runner, request(), { transactionId: high.transactionId, idempotencyKey: high.input.idempotencyKey }))
    .rejects.toThrow('BELIEF_TRANSACTION_REFUSED');
  // The same low-risk change only stores another claim, and commits -- and is
  // indexed like the first.
  const low = await commit(operations);
  expect(low.report.unregisteredPredicateUses).toEqual([]);
  expect((await admin.query('SELECT count(*)::int n FROM memory_embeddings WHERE object_id=$1',
    [created(low.receipt, 'claims')[0]])).rows[0].n).toBe(1);

  // The action port holds the same line for an action founded on such memory:
  // high risk is denied for that reason, whatever the action kind.
  const ports = createLocalPolicyAdapters();
  const base = { actorId: actor, ownerScopeId: owner, purpose: 'memory.act', sensitivity: 'PRIVATE' as const,
    evidenceRefs: [sourceItemId], allowedPurposes: ['memory.act'], capabilityGranted: true,
    supportingAssessment: 'ACCEPTED' as const, projectionComplete: true };
  for (const actionKind of ['DRAFT', 'EMAIL_SEND'] as const) {
    expect(await ports.evaluateMemoryAction({ ...base, actionKind, risk: 'HIGH', unregisteredPredicateSupport: true }))
      .toMatchObject({ outcome: 'DENY', reason: 'UNREGISTERED_PREDICATE_MAY_NOT_AUTHORIZE_HIGH_RISK_ACTION' });
  }
  expect(await ports.evaluateMemoryAction({ ...base, actionKind: 'DRAFT', risk: 'HIGH', unregisteredPredicateSupport: false }))
    .toMatchObject({ outcome: 'ALLOW' });
});
