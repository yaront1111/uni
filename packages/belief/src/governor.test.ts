import { Pool } from 'pg';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { runMigrations, withOwnerTransaction, type OwnerTransaction } from '@unai/postgres';
import { loadRegistryRelease, publishRegistryRelease } from '@unai/registry';
import { modalitySchema, type BeliefOperation, type ProposeBeliefTransaction } from '@unai/domain';
import {
  BELIEF_PURPOSES, BeliefTransactionError, POLICY_VERSION, commitBeliefTransaction, createLocalPolicyAdapters,
  proposeBeliefTransaction, readAssessmentHistory, readCurrentAssessment, readDerivedDependencies,
  readPolicyDecision, recordPolicyDecision, validateBeliefTransaction,
  type BeliefTransactionRunner, type GovernorRequest,
} from './index.js';

/** The write governor over real PostgreSQL, through the real owner boundary:
 * every call below runs inside `withOwnerTransaction` under the low-privilege
 * application role, so the policies, grants and triggers of migration 0012 are
 * part of what these tests prove. */

if (!process.env.UNAI_TEST_DATABASE_URL) throw new Error('Run pnpm test for the required PostgreSQL harness');
const admin = new Pool({ connectionString: process.env.UNAI_TEST_DATABASE_URL });
const appUrl = new URL(process.env.UNAI_TEST_DATABASE_URL); appUrl.username = 'belief_test_app'; appUrl.password = 'test-only';
const appPool = new Pool({ connectionString: appUrl.href });

const owner = randomUUID(), actor = randomUUID();
let baseContextId = '', quotedContextId = '', registryReleaseId = '';
let danielEntityId = '', aliceEntityId = '';
/** Anchors in Daniel's own messages, in Alice's message quoting Daniel, and in a
 * conversation item a model summarised. */
let danielFirst = '', danielSecond = '', aliceQuotingDaniel = '', modelSummary = '', aliceOwn = '', calendarAnchor = '';
let sourceItemIds: string[] = [];

function git(repository: string, ...args: string[]) {
  const result = spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=Registry Test', '-c', 'user.email=registry@test.invalid', ...args],
    { cwd: repository, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: '2024-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2024-01-01T00:00:00Z' } });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

/** The pinned release these transactions are governed by. The 0.1.0 snapshot is
 * immutable and unique, so this waits for the release the registry suite
 * publishes and republishes the identical tag only when running alone -- which
 * `publishRegistryRelease` answers with ALREADY_PUBLISHED either way. */
async function pinnedRegistryRelease(): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const existing = (await admin.query("SELECT id FROM registry_releases WHERE semantic_version='0.1.0'")).rows[0];
    if (existing) return existing.id as string;
    await sleep(250);
  }
  const repository = await mkdtemp(join(tmpdir(), 'unai-belief-registry-'));
  try {
    await cp(resolve('registry'), join(repository, 'registry'), { recursive: true });
    git(repository, 'init', '--quiet'); git(repository, 'add', 'registry');
    git(repository, 'commit', '--quiet', '-m', 'release'); git(repository, 'tag', 'registry-v0.1.0');
    const release = await loadRegistryRelease({ repository, version: '0.1.0' });
    return (await publishRegistryRelease(admin, release, randomUUID())).releaseId;
  } finally { await rm(repository, { recursive: true, force: true }); }
}

async function evidence(externalId: string, actorRef: unknown, sourceType = 'CONVERSATION'): Promise<{ sourceItemId: string; anchorId: string }> {
  const sourceItemId = randomUUID(), anchorId = randomUUID(), connectorId = randomUUID();
  await admin.query("INSERT INTO connectors(id,owner_scope_id,connector_type,external_account_ref,permission_manifest,status) VALUES($1,$2,$3,$4,'{}','ACTIVE')",
    [connectorId, owner, sourceType === 'CALENDAR_EVENT' ? 'GOOGLE_CALENDAR' : 'CONVERSATION', externalId]);
  await admin.query(`INSERT INTO source_items(id,owner_scope_id,connector_id,source_type,external_id,actor_ref,submitted_by_user_id,
    raw_object_ref,content_hash,sensitivity,allowed_purposes,ingestion_version,idempotency_key)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'PRIVATE',ARRAY['PERSONAL_ASSISTANCE'],'evidence-json-v1',$10)`,
    [sourceItemId, owner, connectorId, sourceType, externalId, JSON.stringify(actorRef), actor, randomUUID(),
      randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', ''), randomUUID()]);
  await admin.query("INSERT INTO source_anchors(id,owner_scope_id,source_item_id,anchor_kind,anchor) VALUES($1,$2,$3,'MESSAGE_SPAN','{\"start\":0,\"end\":32}')",
    [anchorId, owner, sourceItemId]);
  sourceItemIds.push(sourceItemId);
  return { sourceItemId, anchorId };
}

beforeAll(async () => {
  await runMigrations(admin, resolve('migrations'));
  await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='belief_test_app') THEN CREATE ROLE belief_test_app LOGIN PASSWORD 'test-only'; END IF; END $$; GRANT unai_app TO belief_test_app");
  await admin.query('INSERT INTO users(id,display_name) VALUES($1,$2)', [actor, 'Governor owner']);
  await admin.query("INSERT INTO owner_scopes(id,scope_kind,display_name,created_by_user_id) VALUES($1,'PERSONAL','Governor',$2)", [owner, actor]);
  await admin.query("INSERT INTO owner_scope_members(owner_scope_id,user_id,role) VALUES($1,$2,'OWNER')", [owner, actor]);
  baseContextId = (await admin.query("SELECT id FROM context_spaces WHERE owner_scope_id=$1 AND context_kind='BASE'", [owner])).rows[0].id;
  // No delivered application capability creates a QUOTED context (migration 0009
  // grants the application no INSERT at all), so the fixture below is written by
  // the migration principal on purpose.
  quotedContextId = randomUUID();
  await admin.query("INSERT INTO context_spaces(id,owner_scope_id,context_kind,parent_context_space_id) VALUES($1,$2,'QUOTED',$3)",
    [quotedContextId, owner, baseContextId]);

  danielEntityId = randomUUID(); aliceEntityId = randomUUID();
  await admin.query("INSERT INTO entities(id,owner_scope_id,entity_kind,canonical_label) VALUES($1,$3,'PERSON','Daniel'),($2,$3,'PERSON','Alice')",
    [danielEntityId, aliceEntityId, owner]);

  const danielRef = { type: 'EXTERNAL', id: danielEntityId };
  const aliceRef = { type: 'EXTERNAL', id: aliceEntityId };
  danielFirst = (await evidence('daniel-message-1', danielRef)).anchorId;
  danielSecond = (await evidence('daniel-message-2', danielRef)).anchorId;
  aliceQuotingDaniel = (await evidence('alice-forward-1', aliceRef)).anchorId;
  modelSummary = (await evidence('daniel-thread-summary', danielRef)).anchorId;
  aliceOwn = (await evidence('alice-message-1', aliceRef)).anchorId;
  calendarAnchor = (await evidence('calendar-event-1', { type: 'CONNECTOR', id: 'google-calendar' }, 'CALENDAR_EVENT')).anchorId;

  registryReleaseId = await pinnedRegistryRelease();
});
afterAll(async () => { await appPool.end(); await admin.end(); });

const runner: BeliefTransactionRunner = (purpose, run) =>
  withOwnerTransaction(appPool, { actorId: actor, ownerScopeId: owner, purpose, correlationId: randomUUID() },
    tx => run(tx as OwnerTransaction));
function request(): GovernorRequest {
  return { ownerScopeId: owner, actorId: actor, correlationId: randomUUID(), dataPurpose: 'PERSONAL_ASSISTANCE', maximumSensitivity: 'RESTRICTED' };
}
function key(label: string): string { return (label + '-' + randomUUID()).replaceAll('-', '').slice(0, 64); }

async function inspect<T>(run: (tx: OwnerTransaction) => Promise<T>): Promise<T> {
  return withOwnerTransaction(appPool, { actorId: actor, ownerScopeId: owner, purpose: BELIEF_PURPOSES.inspect, correlationId: randomUUID() }, run);
}

/** One obligation whose principal amount is asserted by Daniel: the smallest
 * change set that creates an instance, a slot, a proposition, a claim, a support
 * row and an accepted assessment. */
function obligationOperations(over: {
  anchorId?: string; predicateId?: string; frameTypeId?: string; amount?: string; claimOrigin?: BeliefOperation extends never ? never : string;
  assessmentStatus?: 'ACCEPTED' | 'PROVISIONAL' | 'CANDIDATE'; contextSpaceId?: string; modality?: string;
} = {}): BeliefOperation[] {
  return [
    { kind: 'CREATE_FRAME_INSTANCE', operationRef: '#instance', frameTypeId: over.frameTypeId ?? 'shared.obligation',
      contextSpaceId: over.contextSpaceId ?? baseContextId,
      roles: [{ roleId: 'creditor', entityId: danielEntityId }, { roleId: 'debtor', entityId: aliceEntityId }] },
    { kind: 'CREATE_SLOT', operationRef: '#slot', frameInstance: '#instance',
      predicateId: over.predicateId ?? 'shared.obligation.principal_amount',
      contextSpaceId: over.contextSpaceId ?? baseContextId,
      modality: (over.modality ?? 'ACTUAL') as 'ACTUAL', qualifiers: {} },
    { kind: 'CREATE_PROPOSITION', operationRef: '#proposition', beliefSlot: '#slot',
      normalizedValue: { amount: over.amount ?? '50.00', currency: 'ILS' }, polarity: 'POSITIVE' },
    { kind: 'ADD_CLAIM', operationRef: '#claim', sourceAnchorId: over.anchorId ?? danielFirst, proposition: '#proposition',
      assertedByEntityId: danielEntityId, claimOrigin: (over.claimOrigin ?? 'USER_STATEMENT') as 'USER_STATEMENT',
      lifecycle: 'PROVISIONAL', extractionConfidence: 0.95, entityResolutionConfidence: 0.9,
      temporalResolutionConfidence: 0.8, instanceResolutionConfidence: 0.85 },
    { kind: 'ADD_SUPPORT', proposition: '#proposition', claim: '#claim', supportKind: 'DIRECT_ASSERTION' },
    { kind: 'SET_BELIEF_ASSESSMENT', proposition: '#proposition', assessmentStatus: over.assessmentStatus ?? 'ACCEPTED',
      decisionReason: { code: 'OWNER_STATED' } },
  ];
}

function proposal(operations: BeliefOperation[], over: Partial<ProposeBeliefTransaction> = {}): ProposeBeliefTransaction {
  return {
    transactionKind: 'CANONICALIZE', registryReleaseId, risk: 'LOW', idempotencyKey: key('tx'),
    sourceEvidenceIds: sourceItemIds.slice(0, 1), operations, ...over,
  };
}

async function commit(operations: BeliefOperation[], over: Partial<ProposeBeliefTransaction> = {}) {
  const input = proposal(operations, over);
  const proposed = await proposeBeliefTransaction(runner, request(), input);
  const receipt = await commitBeliefTransaction(runner, request(), { transactionId: proposed.transactionId, idempotencyKey: input.idempotencyKey });
  return { transactionId: proposed.transactionId, idempotencyKey: input.idempotencyKey, receipt };
}

function objectOf(receipt: { createdObjects: readonly { objectType: string; objectId: string }[] }, objectType: string): string {
  const found = receipt.createdObjects.find(object => object.objectType === objectType);
  if (!found) throw new Error('no ' + objectType + ' in receipt');
  return found.objectId;
}

describe('belief transactions', () => {
  it('CRT-WRT-02-B: committing the same transaction twice with the same idempotency key produces one commit and identical receipts', async () => {
    const input = proposal(obligationOperations());
    const proposed = await proposeBeliefTransaction(runner, request(), input);
    const first = await commitBeliefTransaction(runner, request(), { transactionId: proposed.transactionId, idempotencyKey: input.idempotencyKey });
    const second = await commitBeliefTransaction(runner, request(), { transactionId: proposed.transactionId, idempotencyKey: input.idempotencyKey });
    expect(second).toEqual(first);
    // Identical is stronger than equal: the stored receipt is returned byte for byte.
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));

    // One commit, not two: one committed_at, one assessment, one support row, one
    // proposition -- a second commit created nothing.
    const row = (await admin.query('SELECT status,committed_at,commit_receipt FROM belief_transactions WHERE id=$1', [proposed.transactionId])).rows[0];
    expect(row.status).toBe('COMMITTED');
    expect(row.committed_at.toISOString()).toBe(first.committedAt);
    const propositionId = objectOf(first, 'propositions');
    expect((await admin.query('SELECT count(*)::int n FROM belief_assessments WHERE proposition_id=$1', [propositionId])).rows[0].n).toBe(1);
    expect((await admin.query('SELECT count(*)::int n FROM belief_support WHERE proposition_id=$1', [propositionId])).rows[0].n).toBe(1);
    expect((await admin.query('SELECT count(*)::int n FROM belief_transactions WHERE owner_scope_id=$1 AND idempotency_key=$2',
      [owner, input.idempotencyKey])).rows[0].n).toBe(1);

    // A proposal replayed under the same key finds the first transaction.
    const replayed = await proposeBeliefTransaction(runner, request(), input);
    expect(replayed).toEqual({ transactionId: proposed.transactionId, status: 'COMMITTED', alreadyProposed: true });

    expect(await inspect(tx => readCurrentAssessment(tx, owner, propositionId)))
      .toMatchObject({ assessmentStatus: 'ACCEPTED', policyVersion: POLICY_VERSION, transactionId: proposed.transactionId });
  });

  it('CRT-WRT-02-A: a transaction whose last operation fails leaves none of its earlier operations visible', async () => {
    // The last operation names a belief slot that does not exist. Everything
    // before it is a real write that really executed inside the commit.
    const missingSlot = randomUUID();
    const operations: BeliefOperation[] = [...obligationOperations(),
      { kind: 'QUALIFY', beliefSlot: missingSlot, qualifiers: { note: 'late failure' } }];
    const input = proposal(operations);
    const proposed = await proposeBeliefTransaction(runner, request(), input);
    await expect(commitBeliefTransaction(runner, request(), { transactionId: proposed.transactionId, idempotencyKey: input.idempotencyKey }))
      .rejects.toThrow('BELIEF_SLOT_NOT_FOUND');

    // Nothing the earlier operations created is visible in any table.
    for (const [table, column] of [['frame_instances', 'created_by_transaction_id'], ['belief_assessments', 'transaction_id'],
      ['belief_support', 'created_by_transaction_id']] as const) {
      expect((await admin.query(`SELECT count(*)::int n FROM ${table} WHERE ${column}=$1`, [proposed.transactionId])).rows[0].n, table).toBe(0);
    }
    // The slot, proposition and claim carry no transaction column, so they are
    // counted through the receipt-free operation rows instead: no operation of
    // this transaction recorded a result, and the transaction never committed.
    expect((await admin.query('SELECT count(*)::int n FROM belief_transaction_operations WHERE belief_transaction_id=$1 AND result_object_refs IS NOT NULL',
      [proposed.transactionId])).rows[0].n).toBe(0);
    const row = (await admin.query('SELECT status,committed_at,commit_receipt FROM belief_transactions WHERE id=$1', [proposed.transactionId])).rows[0];
    expect(row).toMatchObject({ status: 'VALIDATED', committed_at: null, commit_receipt: null });
    // And no obligation instance of this shape survived the rollback either.
    expect((await admin.query(`SELECT count(*)::int n FROM frame_instance_roles r
      JOIN frame_instances f ON f.id=r.frame_instance_id
      WHERE f.owner_scope_id=$1 AND f.created_by_transaction_id=$2`, [owner, proposed.transactionId])).rows[0].n).toBe(0);
  });

  it('CRT-MEM-01-A: an ACCEPTED assessment over a predicate or frame type absent from the pinned release is refused and leaves no accepted assessment', async () => {
    for (const absent of [{ predicateId: 'shared.obligation.imaginary_field' }, { frameTypeId: 'shared.imaginary_frame' }]) {
      const input = proposal(obligationOperations(absent));
      const proposed = await proposeBeliefTransaction(runner, request(), input);
      const report = await validateBeliefTransaction(runner, request(), proposed.transactionId);
      expect(report.decision, JSON.stringify(absent)).toBe('REJECTED');
      expect(report.unregisteredContracts.map(contract => contract.contractId))
        .toContain(absent.predicateId ?? absent.frameTypeId);
      expect(report.withheldAutoAcceptConditions).toContain('PREDICATE_REGISTERED');

      await expect(commitBeliefTransaction(runner, request(), { transactionId: proposed.transactionId, idempotencyKey: input.idempotencyKey }))
        .rejects.toThrow('BELIEF_TRANSACTION_REFUSED');
      expect((await admin.query('SELECT count(*)::int n FROM belief_assessments WHERE transaction_id=$1', [proposed.transactionId])).rows[0].n).toBe(0);
      expect((await admin.query('SELECT status FROM belief_transactions WHERE id=$1', [proposed.transactionId])).rows[0].status).toBe('REJECTED');
    }
    // No accepted assessment exists anywhere over an unregistered predicate.
    expect((await admin.query(`SELECT count(*)::int n FROM belief_assessments a
      JOIN propositions p ON p.id=a.proposition_id JOIN belief_slots s ON s.id=p.belief_slot_id
      WHERE a.owner_scope_id=$1 AND a.assessment_status='ACCEPTED' AND s.predicate_id='shared.obligation.imaginary_field'`,
      [owner])).rows[0].n).toBe(0);
    // The same change set over a registered predicate does commit, so the refusal
    // is the registry's answer and not a blanket one.
    const committed = await commit(obligationOperations());
    expect(committed.receipt.beliefAssessments[0]).toMatchObject({ assessmentStatus: 'ACCEPTED' });
  });

  it('CRT-WRT-03-A: a write EvaluateMemoryWrite denies is not committed, and the decision records outcome, reason and policy version', async () => {
    // PRD §19.1: a model may propose a semantic update and may never accept one.
    const input = proposal(obligationOperations({ claimOrigin: 'MODEL_EXTRACTION' }));
    const proposed = await proposeBeliefTransaction(runner, request(), input);
    await expect(commitBeliefTransaction(runner, request(), { transactionId: proposed.transactionId, idempotencyKey: input.idempotencyKey }))
      .rejects.toMatchObject({ name: 'BeliefTransactionError', message: 'BELIEF_TRANSACTION_REFUSED' });

    const row = (await admin.query('SELECT status,policy_decision_id,commit_receipt FROM belief_transactions WHERE id=$1', [proposed.transactionId])).rows[0];
    expect(row).toMatchObject({ status: 'REJECTED', commit_receipt: null });
    expect((await admin.query('SELECT count(*)::int n FROM belief_assessments WHERE transaction_id=$1', [proposed.transactionId])).rows[0].n).toBe(0);

    const decision = await inspect(tx => readPolicyDecision(tx, owner, row.policy_decision_id));
    expect(decision).toMatchObject({
      port: 'EvaluateMemoryWrite', outcome: 'DENY', reason: 'MODEL_PATH_MAY_NOT_ACCEPT_BELIEF',
      policyVersion: POLICY_VERSION, subjectTransactionId: proposed.transactionId, requiredConfirmation: false,
    });
  });

  it('CRT-WRT-04-A: a candidate failing an AUTO_ACCEPT condition is not auto-accepted by a real transaction either', async () => {
    const first = await commit(obligationOperations({ amount: '60.00' }));
    const slotId = objectOf(first.receipt, 'belief_slots');
    // A second, different value in the same slot is a material conflict, so the
    // governor withholds AUTO_ACCEPT and the transaction is contested rather than
    // accepted.
    const conflicting: BeliefOperation[] = [
      { kind: 'CREATE_PROPOSITION', operationRef: '#other', beliefSlot: slotId, normalizedValue: { amount: '75.00', currency: 'ILS' } },
      { kind: 'ADD_CLAIM', operationRef: '#claim', sourceAnchorId: aliceOwn, proposition: '#other', assertedByEntityId: aliceEntityId,
        claimOrigin: 'EXTERNAL_PERSON_ASSERTION', lifecycle: 'PROVISIONAL' },
      { kind: 'ADD_SUPPORT', proposition: '#other', claim: '#claim', supportKind: 'DIRECT_ASSERTION' },
      { kind: 'SET_BELIEF_ASSESSMENT', proposition: '#other', assessmentStatus: 'ACCEPTED' },
    ];
    const input = proposal(conflicting);
    const proposed = await proposeBeliefTransaction(runner, request(), input);
    const report = await validateBeliefTransaction(runner, request(), proposed.transactionId);
    expect(report.decision).toBe('CONTESTED');
    expect(report.admissionMode).not.toBe('AUTO_ACCEPT');
    expect(report.withheldAutoAcceptConditions).toContain('NO_MATERIAL_CONFLICT');
    await expect(commitBeliefTransaction(runner, request(), { transactionId: proposed.transactionId, idempotencyKey: input.idempotencyKey }))
      .rejects.toThrow('BELIEF_TRANSACTION_REFUSED');
    // The first, accepted value is untouched and no second accepted belief exists.
    expect((await admin.query(`SELECT count(*)::int n FROM belief_assessments a JOIN propositions p ON p.id=a.proposition_id
      WHERE p.belief_slot_id=$1 AND a.superseded_recorded_at IS NULL AND a.assessment_status='ACCEPTED'`, [slotId])).rows[0].n).toBe(1);

    // A HIGH-risk write is not auto-accepted either: the consequence condition
    // fails and the port asks for confirmation.
    const risky = proposal(obligationOperations(), { risk: 'HIGH' });
    const riskyProposed = await proposeBeliefTransaction(runner, request(), risky);
    const riskyReport = await validateBeliefTransaction(runner, request(), riskyProposed.transactionId);
    expect(riskyReport.admissionMode).not.toBe('AUTO_ACCEPT');
    expect(riskyReport.withheldAutoAcceptConditions).toContain('LOW_CONSEQUENCE');
    expect(riskyReport.decision).toBe('REQUIRES_CONFIRMATION');
  });
});

describe('support and independence', () => {
  it('CRT-MEM-12-A: repeated messages, quoted history and a model summary of one source count as one independence group', async () => {
    const created = await commit(obligationOperations({ amount: '120.00' }));
    const propositionId = objectOf(created.receipt, 'propositions');

    // Three more supporting claims, all carrying Daniel's single assertion: his
    // own second message, his words quoted inside Alice's forward, and a model
    // summary of the same thread.
    const more: BeliefOperation[] = [
      { kind: 'ADD_CLAIM', operationRef: '#repeat', sourceAnchorId: danielSecond, proposition: propositionId,
        assertedByEntityId: danielEntityId, claimOrigin: 'USER_STATEMENT', lifecycle: 'PROVISIONAL' },
      { kind: 'ADD_SUPPORT', proposition: propositionId, claim: '#repeat', supportKind: 'CORROBORATION' },
      { kind: 'ADD_CLAIM', operationRef: '#quoted', sourceAnchorId: aliceQuotingDaniel, proposition: propositionId,
        assertedByEntityId: danielEntityId, claimOrigin: 'EXTERNAL_PERSON_ASSERTION', lifecycle: 'PROVISIONAL' },
      { kind: 'ADD_SUPPORT', proposition: propositionId, claim: '#quoted', supportKind: 'QUOTED_RESTATEMENT' },
      { kind: 'ADD_CLAIM', operationRef: '#summary', sourceAnchorId: modelSummary, proposition: propositionId,
        assertedByEntityId: danielEntityId, claimOrigin: 'MODEL_EXTRACTION', lifecycle: 'PROVISIONAL' },
      { kind: 'ADD_SUPPORT', proposition: propositionId, claim: '#summary', supportKind: 'MODEL_SUMMARY' },
    ];
    await commit(more);

    const groups = (await admin.query('SELECT independence_group FROM belief_support WHERE proposition_id=$1', [propositionId])).rows;
    expect(groups).toHaveLength(4);
    expect(new Set(groups.map(row => row.independence_group)).size).toBe(1);

    // Alice asserting it herself is a second, genuinely independent group.
    await commit([
      { kind: 'ADD_CLAIM', operationRef: '#alice', sourceAnchorId: aliceOwn, proposition: propositionId,
        assertedByEntityId: aliceEntityId, claimOrigin: 'EXTERNAL_PERSON_ASSERTION', lifecycle: 'PROVISIONAL' },
      { kind: 'ADD_SUPPORT', proposition: propositionId, claim: '#alice', supportKind: 'CORROBORATION' },
    ]);
    const widened = (await admin.query('SELECT independence_group FROM belief_support WHERE proposition_id=$1', [propositionId])).rows;
    expect(widened).toHaveLength(5);
    expect(new Set(widened.map(row => row.independence_group)).size).toBe(2);

    // And the validation report says so in the same terms the Memory inspector reads.
    const input = proposal([
      { kind: 'ADD_CLAIM', operationRef: '#again', sourceAnchorId: danielSecond, proposition: propositionId,
        assertedByEntityId: danielEntityId, claimOrigin: 'USER_STATEMENT', lifecycle: 'PROVISIONAL' },
      { kind: 'ADD_SUPPORT', proposition: propositionId, claim: '#again', supportKind: 'CORROBORATION' }]);
    const proposed = await proposeBeliefTransaction(runner, request(), input);
    const report = await validateBeliefTransaction(runner, request(), proposed.transactionId);
    expect(report.independenceGroups).toEqual([{ propositionRef: propositionId, groups: expect.any(Array), independentSourceCount: 2 }]);
  });

  it('CRT-MEM-12-B: a transaction that would make accepted support depend circularly on itself is rejected', async () => {
    const first = await commit(obligationOperations({ amount: '210.00' }));
    const second = await commit(obligationOperations({ amount: '220.00', anchorId: danielSecond }));
    const a = objectOf(first.receipt, 'propositions'), b = objectOf(second.receipt, 'propositions');
    // a rests on b: legitimate.
    await commit([{ kind: 'ADD_SUPPORT', proposition: a, supportingProposition: b, supportKind: 'DERIVATION' }]);
    expect((await admin.query('SELECT count(*)::int n FROM belief_support WHERE proposition_id=$1 AND supporting_proposition_id=$2', [a, b])).rows[0].n).toBe(1);

    // b resting on a would close the loop.
    const input = proposal([{ kind: 'ADD_SUPPORT', proposition: b, supportingProposition: a, supportKind: 'DERIVATION' }]);
    const proposed = await proposeBeliefTransaction(runner, request(), input);
    const report = await validateBeliefTransaction(runner, request(), proposed.transactionId);
    expect(report.decision).toBe('REJECTED');
    expect(report.circularSupport).toHaveLength(1);
    expect(new Set(report.circularSupport[0]!.cycle)).toEqual(new Set([a, b]));
    await expect(commitBeliefTransaction(runner, request(), { transactionId: proposed.transactionId, idempotencyKey: input.idempotencyKey }))
      .rejects.toThrow('BELIEF_TRANSACTION_REFUSED');
    expect((await admin.query('SELECT count(*)::int n FROM belief_support WHERE proposition_id=$1 AND supporting_proposition_id=$2', [b, a])).rows[0].n).toBe(0);

    // The one-step cycle is unrepresentable even for the privileged principal.
    await expect(admin.query(`INSERT INTO belief_support(id,owner_scope_id,proposition_id,supporting_proposition_id,support_kind,created_by_transaction_id)
      VALUES($1,$2,$3,$3,'DERIVATION',$4)`, [randomUUID(), owner, a, first.transactionId])).rejects.toMatchObject({ code: '23514' });
  });
});

describe('derived beliefs', () => {
  it('CRT-AI-02-A: a derived proposition records its inputs, evaluator, versions, release and calculation inputs, and becomes UNSUPPORTED once every input is invalidated', async () => {
    const first = await commit(obligationOperations({ amount: '300.00' }));
    const second = await commit(obligationOperations({ amount: '400.00', anchorId: danielSecond }));
    const inputClaims = [objectOf(first.receipt, 'claims'), objectOf(second.receipt, 'claims')];
    const inputPropositions = [objectOf(first.receipt, 'propositions'), objectOf(second.receipt, 'propositions')];

    const derived = await commit([
      { kind: 'CREATE_FRAME_INSTANCE', operationRef: '#instance', frameTypeId: 'shared.obligation', contextSpaceId: baseContextId },
      { kind: 'CREATE_SLOT', operationRef: '#slot', frameInstance: '#instance', predicateId: 'shared.obligation.principal_amount',
        contextSpaceId: baseContextId, modality: 'ACTUAL', qualifiers: { aggregate: 'total' } },
      { kind: 'CREATE_PROPOSITION', operationRef: '#total', beliefSlot: '#slot', normalizedValue: { amount: '700.00', currency: 'ILS' } },
      { kind: 'DERIVE', derivedProposition: '#total', inputClaimIds: inputClaims, inputPropositionIds: inputPropositions,
        evaluatorId: 'finance.obligation_total', modelOrCodeVersion: 'obligation-total-0.1.0',
        calculationInputs: { operands: ['300.00', '400.00'], currency: 'ILS', operation: 'SUM' } },
      { kind: 'SET_BELIEF_ASSESSMENT', proposition: '#total', assessmentStatus: 'ACCEPTED', decisionReason: { code: 'DERIVED' } },
    ]);
    const totalId = objectOf(derived.receipt, 'propositions');

    const [dependency] = await inspect(tx => readDerivedDependencies(tx, owner, totalId));
    expect(dependency).toMatchObject({
      derivedPropositionId: totalId, evaluatorId: 'finance.obligation_total', modelOrCodeVersion: 'obligation-total-0.1.0',
      registryReleaseId, calculationInputs: { operands: ['300.00', '400.00'], currency: 'ILS', operation: 'SUM' },
      createdByTransactionId: derived.transactionId,
    });
    expect([...dependency!.inputClaimIds].sort()).toEqual([...inputClaims].sort());
    expect([...dependency!.inputPropositionIds].sort()).toEqual([...inputPropositions].sort());
    expect(Date.parse(dependency!.createdAt)).toBeGreaterThan(0);
    expect(await inspect(tx => readCurrentAssessment(tx, owner, totalId))).toMatchObject({ assessmentStatus: 'ACCEPTED' });

    // Invalidating one input is not invalidating the derivation: one live input
    // still supports it.
    await commit([
      { kind: 'SUPPRESS', target: inputClaims[0]!, targetObjectType: 'claim' },
      { kind: 'SET_BELIEF_ASSESSMENT', proposition: inputPropositions[0]!, assessmentStatus: 'REJECTED', decisionReason: { code: 'OWNER_REJECTED' } },
    ]);
    expect(await inspect(tx => readCurrentAssessment(tx, owner, totalId))).toMatchObject({ assessmentStatus: 'ACCEPTED' });

    // Invalidating the last one moves the derived belief to UNSUPPORTED.
    const final = await commit([
      { kind: 'SUPPRESS', target: inputClaims[1]!, targetObjectType: 'claim' },
      { kind: 'SET_BELIEF_ASSESSMENT', proposition: inputPropositions[1]!, assessmentStatus: 'REJECTED', decisionReason: { code: 'OWNER_REJECTED' } },
    ]);
    const now = await inspect(tx => readCurrentAssessment(tx, owner, totalId));
    expect(now).toMatchObject({ assessmentStatus: 'UNSUPPORTED', transactionId: final.transactionId });
    expect(now!.decisionReason).toEqual({ code: 'ALL_DERIVATION_INPUTS_INVALIDATED' });
    expect(final.receipt.beliefAssessments.some(entry => entry.propositionId === totalId && entry.assessmentStatus === 'UNSUPPORTED')).toBe(true);

    // The earlier verdict is retained, not rewritten: append-only recorded-time
    // versions are what the Memory inspector's history shows.
    const history = await inspect(tx => readAssessmentHistory(tx, owner, totalId));
    expect(history.map(entry => entry.assessmentStatus)).toEqual(['ACCEPTED', 'UNSUPPORTED']);
    expect(history[0]!.supersededRecordedAt).not.toBeNull();
    expect(history[1]!.supersededRecordedAt).toBeNull();
    await expect(admin.query("UPDATE belief_assessments SET assessment_status='ACCEPTED' WHERE id=$1", [history[1]!.id]))
      .rejects.toThrow('BELIEF_ASSESSMENT_APPEND_ONLY');
  });
});

describe('modality, context and the governed boundary', () => {
  it('CRT-MEM-13-A: a calendar event is stored with modality SCHEDULED independent of its assessment status and claim origin, and all eight modalities are accepted', async () => {
    const scheduled = await commit([
      { kind: 'CREATE_FRAME_INSTANCE', operationRef: '#event', frameTypeId: 'shared.event_occurrence', contextSpaceId: baseContextId },
      { kind: 'CREATE_SLOT', operationRef: '#slot', frameInstance: '#event', predicateId: 'shared.event_occurrence.occurrence_time',
        contextSpaceId: baseContextId, modality: 'SCHEDULED', qualifiers: {} },
      { kind: 'CREATE_PROPOSITION', operationRef: '#when', beliefSlot: '#slot', normalizedValue: { start: '2026-10-01T09:00:00Z', end: '2026-10-01T10:00:00Z' } },
      { kind: 'ADD_CLAIM', operationRef: '#claim', sourceAnchorId: calendarAnchor, proposition: '#when',
        claimOrigin: 'STRUCTURED_CONNECTOR_OBSERVATION', lifecycle: 'PROVISIONAL' },
      { kind: 'ADD_SUPPORT', proposition: '#when', claim: '#claim', supportKind: 'STRUCTURED_OBSERVATION' },
      { kind: 'SET_BELIEF_ASSESSMENT', proposition: '#when', assessmentStatus: 'ACCEPTED' },
    ]);
    const slotId = objectOf(scheduled.receipt, 'belief_slots'), propositionId = objectOf(scheduled.receipt, 'propositions');
    const modalityOf = async () => (await admin.query('SELECT modality FROM belief_slots WHERE id=$1', [slotId])).rows[0].modality;
    expect(await modalityOf()).toBe('SCHEDULED');

    // The assessment moves and a second claim with a different origin arrives;
    // neither is the modality, and the modality does not follow either of them.
    await commit([
      { kind: 'ADD_CLAIM', operationRef: '#user', sourceAnchorId: danielFirst, proposition: propositionId,
        assertedByEntityId: danielEntityId, claimOrigin: 'USER_STATEMENT', lifecycle: 'PROVISIONAL' },
      { kind: 'ADD_SUPPORT', proposition: propositionId, claim: '#user', supportKind: 'CORROBORATION' },
      { kind: 'SET_BELIEF_ASSESSMENT', proposition: propositionId, assessmentStatus: 'CONTESTED', decisionReason: { code: 'COMPETING_TIMES' } },
    ]);
    expect(await modalityOf()).toBe('SCHEDULED');
    expect(await inspect(tx => readCurrentAssessment(tx, owner, propositionId))).toMatchObject({ assessmentStatus: 'CONTESTED' });
    expect(new Set((await admin.query('SELECT claim_origin FROM claims WHERE proposition_id=$1', [propositionId])).rows.map(row => row.claim_origin)))
      .toEqual(new Set(['STRUCTURED_CONNECTOR_OBSERVATION', 'USER_STATEMENT']));

    // All eight modality values are accepted by the schema, through the governed path.
    const all = await commit(modalitySchema.options.flatMap((modality, index) => ([
      { kind: 'CREATE_FRAME_INSTANCE', operationRef: `#i${index}`, frameTypeId: 'shared.event_occurrence', contextSpaceId: baseContextId },
      { kind: 'CREATE_SLOT', operationRef: `#s${index}`, frameInstance: `#i${index}`, predicateId: 'shared.event_occurrence.description',
        contextSpaceId: baseContextId, modality, qualifiers: {} },
    ] as BeliefOperation[])));
    const stored = (await admin.query('SELECT modality FROM belief_slots WHERE id = ANY($1)',
      [all.receipt.createdObjects.filter(object => object.objectType === 'belief_slots').map(object => object.objectId)])).rows;
    expect(new Set(stored.map(row => row.modality))).toEqual(new Set(modalitySchema.options));
    expect(modalitySchema.options).toHaveLength(8);
  });

  it('CRT-REG-06-B: each owner scope keeps exactly one active BASE context, and a QUOTED-to-BASE move outside a governed transaction is refused', async () => {
    const bases = (await admin.query("SELECT id,lifecycle FROM context_spaces WHERE owner_scope_id=$1 AND context_kind='BASE'", [owner])).rows;
    expect(bases).toEqual([{ id: baseContextId, lifecycle: 'ACTIVE' }]);
    await expect(admin.query("INSERT INTO context_spaces(id,owner_scope_id,context_kind) VALUES($1,$2,'BASE')", [randomUUID(), owner]))
      .rejects.toMatchObject({ code: '23505' });
    await expect(admin.query("UPDATE context_spaces SET lifecycle='RETIRED',retired_at=now() WHERE id=$1", [baseContextId]))
      .rejects.toThrow('BASE_CONTEXT_SPACE_PERMANENT');

    // A proposition asserted in QUOTED context.
    const quoted = await commit(obligationOperations({ contextSpaceId: quotedContextId, amount: '15.00', assessmentStatus: 'PROVISIONAL' }));
    const slotId = objectOf(quoted.receipt, 'belief_slots');
    expect((await admin.query('SELECT context_space_id FROM belief_slots WHERE id=$1', [slotId])).rows[0].context_space_id).toBe(quotedContextId);

    // Outside a governed transaction the move is refused, for the application
    // role holding the governing purpose and for the privileged principal alike.
    await expect(runner(BELIEF_PURPOSES.govern, tx =>
      tx.query('UPDATE belief_slots SET context_space_id=$2 WHERE owner_scope_id=$3 AND id=$1', [slotId, baseContextId, owner])))
      .rejects.toThrow('CONTEXT_MOVE_REQUIRES_TRANSACTION');
    await expect(admin.query('UPDATE belief_slots SET context_space_id=$2 WHERE id=$1', [slotId, baseContextId]))
      .rejects.toThrow('CONTEXT_MOVE_REQUIRES_TRANSACTION');
    // Naming a transaction that is not committing is not a governed transaction either.
    await expect(admin.query(`SELECT set_config('unai.belief_transaction_id',$1,false)`, [quoted.transactionId])
      .then(() => admin.query('UPDATE belief_slots SET context_space_id=$2 WHERE id=$1', [slotId, baseContextId])))
      .rejects.toThrow('CONTEXT_MOVE_REQUIRES_TRANSACTION');
    await admin.query(`SELECT set_config('unai.belief_transaction_id','',false)`);
    expect((await admin.query('SELECT context_space_id FROM belief_slots WHERE id=$1', [slotId])).rows[0].context_space_id).toBe(quotedContextId);

    // Inside one, the same move is exactly what a QUALIFY operation does.
    await commit([{ kind: 'QUALIFY', beliefSlot: slotId, contextSpaceId: baseContextId }]);
    expect((await admin.query('SELECT context_space_id FROM belief_slots WHERE id=$1', [slotId])).rows[0].context_space_id).toBe(baseContextId);
    // And the owner scope still holds exactly one active BASE.
    expect((await admin.query("SELECT count(*)::int n FROM context_spaces WHERE owner_scope_id=$1 AND context_kind='BASE' AND lifecycle='ACTIVE'",
      [owner])).rows[0].n).toBe(1);
  });
});

describe('the local policy ports', () => {
  const ports = createLocalPolicyAdapters();
  const base = { actorId: actor, ownerScopeId: owner, sensitivity: 'PRIVATE' as const, evidenceRefs: ['e'], risk: 'LOW' as const };

  it('EvaluateMemoryRead redacts objects above the declared ceiling and denies an unpermitted purpose', async () => {
    const objects = [{ objectType: 'propositions', objectId: randomUUID(), sensitivity: 'NORMAL' as const },
      { objectType: 'propositions', objectId: randomUUID(), sensitivity: 'RESTRICTED' as const }];
    const redacted = await ports.evaluateMemoryRead({ ...base, purpose: 'memory.read', requestedObjects: objects,
      maximumSensitivity: 'PRIVATE', allowedPurposes: ['memory.read'] });
    expect(redacted).toMatchObject({ outcome: 'REDACT', reason: 'OBJECTS_ABOVE_MAXIMUM_SENSITIVITY' });
    expect(redacted.redactions).toHaveLength(1);
    expect(await ports.evaluateMemoryRead({ ...base, purpose: 'memory.read', requestedObjects: objects,
      maximumSensitivity: 'RESTRICTED', allowedPurposes: ['memory.read'] })).toMatchObject({ outcome: 'ALLOW' });
    expect(await ports.evaluateMemoryRead({ ...base, purpose: 'advertising', requestedObjects: [],
      maximumSensitivity: 'NORMAL', allowedPurposes: ['advertising'] })).toMatchObject({ outcome: 'DENY', reason: 'PURPOSE_NOT_PERMITTED_FOR_READ' });
  });

  it('EvaluateMemoryAction refuses every external action kind but a draft in V0', async () => {
    // The evidence behind the memory admits the action purpose throughout this
    // test, so each assertion below is about the rule it names and not about the
    // purpose gate the next test covers.
    const acting = { ...base, purpose: 'memory.act', allowedPurposes: ['memory.act'] };
    for (const actionKind of ['EMAIL_SEND', 'CALENDAR_WRITE', 'MONEY_MOVEMENT', 'TRADE'] as const) {
      expect(await ports.evaluateMemoryAction({ ...acting, actionKind, capabilityGranted: true,
        supportingAssessment: 'ACCEPTED', projectionComplete: true }), actionKind)
        .toMatchObject({ outcome: 'DENY', reason: 'EXTERNAL_ACTION_REFUSED_IN_V0' });
    }
    expect(await ports.evaluateMemoryAction({ ...acting, actionKind: 'DRAFT', capabilityGranted: false,
      supportingAssessment: 'ACCEPTED', projectionComplete: true })).toMatchObject({ outcome: 'DENY', reason: 'CAPABILITY_NOT_GRANTED' });
    expect(await ports.evaluateMemoryAction({ ...acting, actionKind: 'DRAFT', capabilityGranted: true,
      supportingAssessment: 'ACCEPTED', projectionComplete: true })).toMatchObject({ outcome: 'ALLOW' });
    // A high-risk action resting on provisional or incomplete memory is denied.
    expect(await ports.evaluateMemoryAction({ ...acting, risk: 'HIGH', actionKind: 'DRAFT',
      capabilityGranted: true, supportingAssessment: 'PROVISIONAL', projectionComplete: false }))
      .toMatchObject({ outcome: 'DENY', reason: 'HIGH_RISK_ACTION_ON_UNSETTLED_MEMORY' });
  });

  it('CRT-SEC-02-A: EvaluateMemoryAction denies an undeclared purpose and one the evidence does not admit', async () => {
    const acting = { ...base, actionKind: 'DRAFT' as const, capabilityGranted: true,
      supportingAssessment: 'ACCEPTED' as const, projectionComplete: true };
    // No declared purpose at all.
    expect(await ports.evaluateMemoryAction({ ...acting, purpose: '', allowedPurposes: ['memory.act'] }))
      .toMatchObject({ outcome: 'DENY', reason: 'PURPOSE_NOT_PERMITTED_FOR_ACTION' });
    // A purpose the evidence behind the supporting memory never admitted. The
    // action is otherwise impeccable -- a draft, with its capability, on accepted
    // memory over a complete projection -- and it is still denied.
    expect(await ports.evaluateMemoryAction({ ...acting, purpose: 'memory.act', allowedPurposes: [] }))
      .toMatchObject({ outcome: 'DENY', reason: 'PURPOSE_NOT_IN_ALLOWED_PURPOSES' });
    expect(await ports.evaluateMemoryAction({ ...acting, purpose: 'memory.act', allowedPurposes: ['memory.read'] }))
      .toMatchObject({ outcome: 'DENY', reason: 'PURPOSE_NOT_IN_ALLOWED_PURPOSES' });
    // The same action, once the evidence admits it.
    expect(await ports.evaluateMemoryAction({ ...acting, purpose: 'memory.act', allowedPurposes: ['memory.act'] }))
      .toMatchObject({ outcome: 'ALLOW' });
  });

  it('persists a decision for every port, and refuses to rewrite one', async () => {
    const verdicts = [
      { port: 'EvaluateMemoryRead' as const, verdict: await ports.evaluateMemoryRead({ ...base, purpose: 'memory.read',
        requestedObjects: [], maximumSensitivity: 'PRIVATE', allowedPurposes: ['memory.read'] }), purpose: 'memory.read' },
      { port: 'EvaluateMemoryAction' as const, verdict: await ports.evaluateMemoryAction({ ...base, purpose: 'memory.act',
        allowedPurposes: ['memory.act'], actionKind: 'EMAIL_SEND', capabilityGranted: true,
        supportingAssessment: 'ACCEPTED', projectionComplete: true }), purpose: 'memory.act' },
    ];
    for (const entry of verdicts) {
      const id = await withOwnerTransaction(appPool, { actorId: actor, ownerScopeId: owner, purpose: entry.purpose, correlationId: randomUUID() },
        tx => recordPolicyDecision(tx, { ownerScopeId: owner, correlationId: randomUUID(), port: entry.port, request: {}, verdict: entry.verdict }));
      const stored = await inspect(tx => readPolicyDecision(tx, owner, id));
      expect(stored).toMatchObject({ port: entry.port, outcome: entry.verdict.outcome, reason: entry.verdict.reason, policyVersion: POLICY_VERSION });
      await expect(admin.query("UPDATE policy_decisions SET outcome='ALLOW' WHERE id=$1", [id])).rejects.toThrow('BELIEF_RECORD_IMMUTABLE');
    }
  });

  it('refuses a proposal naming an operation kind this node does not deliver', async () => {
    await expect(proposeBeliefTransaction(runner, request(), proposal([
      { kind: 'ARCHIVE', target: randomUUID(), targetObjectType: 'proposition' }])))
      .rejects.toMatchObject({ name: 'BeliefTransactionError', message: 'BELIEF_OPERATION_NOT_DELIVERED' });
    // Merge and split are delivered by the merge-and-split node, and only inside a
    // transaction of their own kind: migration 0018 accepts lineage from nothing else.
    await expect(proposeBeliefTransaction(runner, request(), proposal([
      { kind: 'MERGE', target: randomUUID(), survivor: randomUUID() }])))
      .rejects.toMatchObject({ name: 'BeliefTransactionError', message: 'BELIEF_OPERATION_KIND_MISMATCH' });
  });

  it('refuses a commit whose idempotency key does not match the proposal', async () => {
    const input = proposal(obligationOperations({ amount: '9.00' }));
    const proposed = await proposeBeliefTransaction(runner, request(), input);
    await expect(commitBeliefTransaction(runner, request(), { transactionId: proposed.transactionId, idempotencyKey: key('other') }))
      .rejects.toThrow('BELIEF_TRANSACTION_IDEMPOTENCY_KEY_MISMATCH');
    expect(await new Promise<string>(resolve => admin.query('SELECT status FROM belief_transactions WHERE id=$1', [proposed.transactionId])
      .then(result => resolve(result.rows[0].status)))).toBe('PROPOSED');
  });
});

it('is unreachable without the governing purpose', async () => {
  await expect(withOwnerTransaction(appPool, { actorId: actor, ownerScopeId: owner, purpose: 'evidence.read', correlationId: randomUUID() },
    async tx => (await tx.query('SELECT * FROM belief_transactions')).rowCount)).resolves.toBe(0);
  for (const table of ['belief_transactions', 'belief_transaction_operations', 'belief_assessments', 'belief_support',
    'derived_proposition_dependencies', 'policy_decisions']) {
    await expect(runner(BELIEF_PURPOSES.govern, tx => tx.query('DELETE FROM ' + table)), table).rejects.toMatchObject({ code: '42501' });
  }
  expect(BeliefTransactionError).toBeTypeOf('function');
});
