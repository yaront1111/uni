import { Pool } from 'pg';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { runMigrations, withOwnerTransaction } from '@unai/postgres';
import { postgresAdapter, SESSION_COOKIE } from '@unai/auth';
import { transitionContractSetSchema, type BeliefOperation, type CommitReceipt, type ValidationReport } from '@unai/domain';
import { loadRegistryRelease, publishRegistryRelease } from '../../registry/src/index.js';
import { createPlatformApi } from './platform.js';

if (!process.env.UNAI_TEST_DATABASE_URL) throw new Error('Run pnpm test for the required PostgreSQL harness');
const admin = new Pool({ connectionString: process.env.UNAI_TEST_DATABASE_URL });
const url = new URL(process.env.UNAI_TEST_DATABASE_URL); url.username = 'memory_resolve_test_app'; url.password = 'test-only';
const appPool = new Pool({ connectionString: url.href });
let owner = '', actor = '', token = '', registryReleaseId = '', contextSpaceId = '', entityId = '';
let sourceItemId = '', anchorId = '', assistantAnchor = '', modelClaim = '', assistantClaim = '';
let app: ReturnType<typeof createPlatformApi>;
type ResolveOperation = Extract<BeliefOperation, { kind: 'RESOLVE' }>;
const rows = async (sql: string, values: unknown[] = []) => (await admin.query<Record<string, unknown>>(sql, values)).rows;

function git(repository: string, ...args: string[]) {
  const result = spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=Registry Test', '-c', 'user.email=registry@test.invalid', ...args],
    { cwd: repository, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: '2024-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2024-01-01T00:00:00Z' } });
  if (result.status !== 0) throw new Error(result.stderr);
}
async function pinnedRegistryRelease(): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const existing = (await rows("SELECT id FROM registry_releases WHERE semantic_version='0.1.0'"))[0];
    if (existing) return existing['id'] as string;
    await sleep(250);
  }
  const repository = await mkdtemp(join(tmpdir(), 'unai-resolve-release-'));
  try {
    await cp(resolve('registry'), join(repository, 'registry'), { recursive: true });
    git(repository, 'init', '--quiet'); git(repository, 'add', 'registry');
    git(repository, 'commit', '--quiet', '-m', 'release'); git(repository, 'tag', 'registry-v0.1.0');
    const release = await loadRegistryRelease({ repository, version: '0.1.0' });
    try { return (await publishRegistryRelease(admin, release, randomUUID())).releaseId; }
    catch (error) {
      const existing = (await rows("SELECT id FROM registry_releases WHERE semantic_version='0.1.0'"))[0];
      if (!existing) throw error;
      return existing['id'] as string;
    }
  } finally { await rm(repository, { recursive: true, force: true }); }
}
async function evidence(assistant: boolean, purpose = 'PERSONAL_ASSISTANCE') {
  const connector = randomUUID(), item = randomUUID(), anchor = randomUUID();
  await admin.query("INSERT INTO connectors(id,owner_scope_id,connector_type,external_account_ref,permission_manifest,status) VALUES($1,$2,'CONVERSATION',$3,'{}','ACTIVE')", [connector, owner, connector]);
  await admin.query(`INSERT INTO source_items(id,owner_scope_id,connector_id,source_type,external_id,actor_ref,submitted_by_user_id,
    raw_object_ref,content_hash,sensitivity,allowed_purposes,ingestion_version,idempotency_key)
    VALUES($1,$2,$3,$4,$9,$5,$6,$7,$8,'PRIVATE',$10,'evidence-json-v1',$9)`,
    [item, owner, connector, assistant ? 'ASSISTANT_CONVERSATION' : 'CONVERSATION', JSON.stringify({ type: assistant ? 'ASSISTANT' : 'USER', id: actor }), actor, randomUUID(), randomBytes(32).toString('hex'), item, [purpose]]);
  await admin.query(`INSERT INTO source_anchors(id,owner_scope_id,source_item_id,anchor_kind,anchor) VALUES($1,$2,$3,'MESSAGE_SPAN','{"start":0,"end":12}')`, [anchor, owner, item]);
  return { item, anchor };
}
beforeAll(async () => {
  await runMigrations(admin, resolve('migrations'));
  await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='memory_resolve_test_app') THEN CREATE ROLE memory_resolve_test_app LOGIN PASSWORD 'test-only'; END IF; END $$; GRANT unai_app TO memory_resolve_test_app");
  const adapter = postgresAdapter(admin);
  // Recovery selects its AC44 fixtures by display name; keep this owner distinct.
  const user = await adapter.createUser!({ name: 'Governed RESOLVE route owner', email: 'memory-resolve@example.test', emailVerified: null });
  actor = user.id; owner = (user as unknown as { ownerScopeId: string }).ownerScopeId;
  token = randomBytes(32).toString('base64url');
  await adapter.createSession!({ userId: actor, sessionToken: token, expires: new Date(Date.now() + 604800000) });
  contextSpaceId = (await rows("SELECT id FROM context_spaces WHERE owner_scope_id=$1 AND context_kind='BASE'", [owner]))[0]!['id'] as string;
  entityId = randomUUID();
  await admin.query("INSERT INTO entities(id,owner_scope_id,entity_kind,canonical_label) VALUES($1,$2,'PERSON','Owner')", [entityId, owner]);
  ({ item: sourceItemId, anchor: anchorId } = await evidence(false));
  assistantAnchor = (await evidence(true)).anchor; modelClaim = randomUUID(); assistantClaim = randomUUID();
  for (const [id, anchor, origin] of [[modelClaim, anchorId, 'MODEL_INFERENCE'], [assistantClaim, assistantAnchor, 'USER_STATEMENT']]) {
    await admin.query("INSERT INTO claims(id,owner_scope_id,source_anchor_id,claim_origin,lifecycle) VALUES($1,$2,$3,$4,'CANDIDATE')", [id, owner, anchor, origin]);
  }
  registryReleaseId = await pinnedRegistryRelease();
});
beforeEach(() => {
  app = createPlatformApi({ authPool: admin, appPool, registryReleaseId });
  app.addHook('onRequest', async request => { Object.defineProperty(request.raw.socket, 'encrypted', { value: true }); });
});
afterEach(async () => { await app.close(); });
afterAll(async () => { await appPool.end(); await admin.end(); });

async function frame(frameTypeId = 'shared.commitment', retired = false) {
  const id = randomUUID();
  await admin.query(`INSERT INTO frame_instances(id,owner_scope_id,frame_type_id,context_space_id,lifecycle,retired_at)
    VALUES($1,$2,$3,$4,$5,$6)`, [id, owner, frameTypeId, contextSpaceId, retired ? 'RETIRED' : 'ACTIVE', retired ? new Date() : null]);
  return id;
}
function claim(sourceAnchorId = anchorId): Extract<BeliefOperation, { kind: 'ADD_CLAIM' }> {
  return { kind: 'ADD_CLAIM', operationRef: '#outcome', sourceAnchorId, claimOrigin: 'USER_STATEMENT', lifecycle: 'CANDIDATE', assertedByEntityId: entityId };
}
function resolution(sourceFrameInstance: string, patch: Partial<ResolveOperation> = {}): ResolveOperation {
  return { kind: 'RESOLVE', sourceFrameInstance, claim: '#outcome', outcomeCode: 'FULFILLED',
    transitionContractId: 'shared.commitment.resolution', assertedByEntityId: entityId, effectiveAt: '2026-11-01T09:00:00.000Z', ...patch };
}
function headers(key: string) {
  return { cookie: SESSION_COOKIE + '=' + token, 'x-owner-scope-id': owner, 'x-purpose': 'memory.govern',
    'x-correlation-id': randomUUID(), 'idempotency-key': key, 'x-data-purpose': 'PERSONAL_ASSISTANCE', 'x-maximum-sensitivity': 'RESTRICTED' };
}
async function prepare(operations: BeliefOperation[], risk = 'LOW', sourceEvidenceIds = [sourceItemId]) {
  const key = randomUUID(), post = (path: string, payload: object = {}) => app.inject({ method: 'POST',
    url: '/v1/memory/transactions/' + path, headers: headers(key), payload });
  const proposed = await post('propose', { transactionKind: 'RESOLVE', registryReleaseId, risk, sourceEvidenceIds, operations });
  expect(proposed.statusCode, proposed.body).toBe(201);
  const { transactionId } = proposed.json<{ transactionId: string }>();
  const validated = await post(transactionId + '/validate'); expect(validated.statusCode, validated.body).toBe(200);
  return { transactionId, report: validated.json<ValidationReport>(), commit: () => post(transactionId + '/commit') };
}
async function assertion(transactionId: string) {
  const found = await rows('SELECT * FROM resolution_assertions WHERE creation_transaction_id=$1', [transactionId]);
  expect(found).toHaveLength(1); return found[0]!;
}
async function policy(receipt: CommitReceipt) {
  return (await rows('SELECT request FROM policy_decisions WHERE id=$1', [receipt.policyDecisionId]))[0]!['request'];
}

it('commits an accepted outcome atomically and serializes simultaneous retries', async () => {
  const source = await frame(), before = await rows('SELECT * FROM frame_instances WHERE id=$1', [source]);
  const run = await prepare([claim(), resolution(source)]);
  expect(run.report).toMatchObject({ decision: 'COMMITTABLE', admissionMode: 'AUTO_ACCEPT', warnings: [] });
  const [committed, again] = await Promise.all([run.commit(), run.commit()]);
  expect(committed.statusCode, committed.body).toBe(200); expect(again.statusCode).toBe(200); expect(again.body).toBe(committed.body);
  const receipt = committed.json<CommitReceipt>(), row = await assertion(run.transactionId);
  const claimId = row['claim_id'], id = row['id'], linkId = row['resolution_link_id'];
  expect(receipt.createdObjects).toEqual([{ operationOrder: 0, objectType: 'claims', objectId: claimId },
    { operationOrder: 1, objectType: 'resolution_assertions', objectId: id }, { operationOrder: 1, objectType: 'memory_links', objectId: linkId }]);
  expect(row).toMatchObject({ lifecycle: 'ACCEPTED', source_frame_instance_id: source, target_frame_instance_id: null,
    outcome_code: 'FULFILLED', transition_contract_id: 'shared.commitment.resolution', creation_transaction_id: run.transactionId });
  expect(await rows('SELECT * FROM memory_links WHERE transaction_id=$1', [run.transactionId])).toMatchObject([
    { id: linkId, lifecycle: 'ACTIVE', link_kind: 'RESOLVES', from_object_type: 'resolution_assertion', from_object_id: id, to_object_type: 'frame_instance', to_object_id: source }]);
  expect(await rows('SELECT proposition_id,lifecycle FROM claims WHERE id=$1', [claimId])).toEqual([{ proposition_id: null, lifecycle: 'CANDIDATE' }]);
  expect(await rows('SELECT result_object_refs FROM belief_transaction_operations WHERE belief_transaction_id=$1 AND operation_order=1', [run.transactionId]))
    .toEqual([{ result_object_refs: { objectType: 'resolution_assertions', objectId: id, resolutionLinkId: linkId, lifecycle: 'ACCEPTED' } }]);
  expect(await policy(receipt)).toMatchObject({ proposedChanges: { setsAcceptedAssessment: true } });
  expect(await rows('SELECT * FROM frame_instances WHERE id=$1', [source])).toEqual(before);
});

it.each(['source', 'target'] as const)('resolves an earlier CREATE_FRAME_INSTANCE %s reference', async end => {
  const source = end === 'source' ? '#new' : await frame();
  const run = await prepare([{ kind: 'CREATE_FRAME_INSTANCE', operationRef: '#new', frameTypeId: end === 'source' ? 'shared.commitment' : 'shared.event_occurrence' },
    claim(), resolution(source, end === 'target' ? { targetFrameInstance: '#new' } : {})]);
  const committed = await run.commit(); expect(committed.statusCode, committed.body).toBe(200);
  const created = committed.json<CommitReceipt>().createdObjects[0]!.objectId, row = await assertion(run.transactionId);
  expect(row).toMatchObject({ lifecycle: 'ACCEPTED', [end + '_frame_instance_id']: created });
  if (end === 'target') expect(await rows('SELECT from_object_type,from_object_id,lifecycle FROM memory_links WHERE id=$1', [row['resolution_link_id']]))
    .toEqual([{ from_object_type: 'frame_instance', from_object_id: created, lifecycle: 'ACTIVE' }]);
});

it('records a refused outcome with policy evidence and leaves no material writes', async () => {
  const source = await frame(), claimsBefore = await rows('SELECT id FROM claims WHERE owner_scope_id=$1 ORDER BY id', [owner]);
  const run = await prepare([claim(), resolution(source, { outcomeCode: 'WAIVED' })]);
  expect(run.report.decision).toBe('REJECTED'); expect(run.report.warnings).toContain('TRANSITION_OUTCOME_REFUSED');
  expect(await rows(`SELECT b.validation->'warnings' warnings,p.subject_transaction_id FROM belief_transactions b
    JOIN policy_decisions p ON p.id=b.policy_decision_id WHERE b.id=$1`, [run.transactionId]))
    .toEqual([{ warnings: ['TRANSITION_OUTCOME_REFUSED'], subject_transaction_id: run.transactionId }]);
  const committed = await run.commit(); expect(committed.statusCode).toBe(409);
  expect(committed.json()).toMatchObject({ code: 'BELIEF_TRANSACTION_REFUSED', decision: 'REJECTED' });
  expect(await rows('SELECT status FROM belief_transactions WHERE id=$1', [run.transactionId])).toEqual([{ status: 'REJECTED' }]);
  expect(await rows('SELECT id FROM resolution_assertions WHERE creation_transaction_id=$1 OR source_frame_instance_id=$2', [run.transactionId, source])).toEqual([]);
  expect(await rows('SELECT id FROM memory_links WHERE transaction_id=$1 OR to_object_id=$2', [run.transactionId, source])).toEqual([]);
  expect(await rows('SELECT result_object_refs FROM belief_transaction_operations WHERE belief_transaction_id=$1', [run.transactionId]))
    .toEqual([{ result_object_refs: null }, { result_object_refs: null }]);
  expect(await rows('SELECT id FROM claims WHERE owner_scope_id=$1 ORDER BY id', [owner])).toEqual(claimsBefore);
});

const refusals: [string, (source: string) => Partial<ResolveOperation> | Promise<Partial<ResolveOperation>>][] = [
  ['TRANSITION_CONTRACT_UNKNOWN', () => ({ transitionContractId: 'shared.decision.prediction_review' })],
  ['TRANSITION_LINK_KIND_REFUSED', () => ({ transitionContractId: 'shared.event_occurrence.realization' })],
  ['TRANSITION_SOURCE_FRAME_TYPE_REFUSED', () => ({ transitionContractId: 'shared.obligation.resolution' })],
  ['TRANSITION_TARGET_FRAME_TYPE_REFUSED', async () => ({ targetFrameInstance: await frame('shared.obligation') })],
  ['RESOLUTION_SOURCE_FRAME_NOT_FOUND', () => ({ sourceFrameInstance: randomUUID() })],
  ['RESOLUTION_SOURCE_FRAME_NOT_ACTIVE', async () => ({ sourceFrameInstance: await frame('shared.commitment', true) })],
  ['RESOLUTION_TARGET_FRAME_NOT_FOUND', () => ({ targetFrameInstance: randomUUID() })],
  ['RESOLUTION_TARGET_FRAME_NOT_ACTIVE', async () => ({ targetFrameInstance: await frame('shared.event_occurrence', true) })],
  ['RESOLUTION_TARGET_IS_SOURCE', source => ({ targetFrameInstance: source })],
  ['RESOLUTION_CLAIM_NOT_FOUND', () => ({ claim: randomUUID() })],
  ['RESOLUTION_CLAIM_NOT_FOUND', () => ({ claim: '#wrong' })],
  ['RESOLUTION_SOURCE_FRAME_NOT_FOUND', () => ({ sourceFrameInstance: '#outcome' })],
  ['RESOLUTION_ASSERTER_NOT_FOUND', () => ({ assertedByEntityId: randomUUID() })],
];
it.each(refusals)('records %s instead of attempting a partial commit', async (code, patch) => {
  const source = await frame(), changes = await patch(source), operations: BeliefOperation[] = [claim()];
  if (changes.claim === '#wrong') operations.unshift({ kind: 'CREATE_FRAME_INSTANCE', operationRef: '#wrong', frameTypeId: 'shared.event_occurrence' });
  const run = await prepare([...operations, resolution(source, changes)]);
  expect(run.report.decision).toBe('REJECTED'); expect(run.report.warnings).toContain(code);
  expect((await run.commit()).statusCode).toBe(409);
});

it('requires evidence before accepting an outcome', async () => {
  const run = await prepare([claim(), resolution(await frame())], 'LOW', []);
  expect(run.report).toMatchObject({ decision: 'REJECTED', policy: { outcome: 'DENY', reason: 'ACCEPTED_BELIEF_REQUIRES_EVIDENCE' } });
  expect((await run.commit()).statusCode).toBe(409);
});
it('commits a medium-risk outcome only as PROPOSED', async () => {
  const run = await prepare([claim(), resolution(await frame())], 'MEDIUM');
  expect(run.report).toMatchObject({ decision: 'COMMITTABLE', admissionMode: 'BATCH_REVIEW' });
  expect(run.report.withheldAutoAcceptConditions).toContain('LOW_CONSEQUENCE');
  const committed = await run.commit(); expect(committed.statusCode, committed.body).toBe(200);
  const row = await assertion(run.transactionId); expect(row['lifecycle']).toBe('PROPOSED');
  expect(await rows('SELECT lifecycle FROM memory_links WHERE id=$1', [row['resolution_link_id']])).toEqual([{ lifecycle: 'PROPOSED' }]);
  expect(await rows("SELECT result_object_refs->>'lifecycle' lifecycle FROM belief_transaction_operations WHERE belief_transaction_id=$1 AND operation_order=1", [run.transactionId])).toEqual([{ lifecycle: 'PROPOSED' }]);
  expect(await policy(committed.json<CommitReceipt>())).toMatchObject({ proposedChanges: { setsAcceptedAssessment: false } });
});
it.each(['model', 'mixed-model', 'assistant', 'mixed-assistant', 'pending-assistant', 'pending-model'] as const)('never accepts a %s outcome', async kind => {
  const pending = kind.startsWith('pending'), mixed = kind.startsWith('mixed');
  const outcomeClaim = kind.includes('assistant') ? assistantClaim : modelClaim;
  const operations: BeliefOperation[] = mixed ? [claim()] : pending ? [kind === 'pending-model'
    ? { ...claim(), claimOrigin: 'MODEL_INFERENCE' } : claim(assistantAnchor)] : [];
  const run = await prepare([...operations, resolution(await frame(), { claim: pending ? '#outcome' : outcomeClaim })]);
  expect(run.report.admissionMode).toBe('AUTO_PROVISIONAL'); expect(run.report.withheldAutoAcceptConditions).toContain('SOURCE_AUTHORITATIVE');
  const committed = await run.commit(); expect(committed.statusCode, committed.body).toBe(200);
  expect((await assertion(run.transactionId))['lifecycle']).toBe('PROPOSED');
  if (!mixed) expect(await policy(committed.json<CommitReceipt>())).toMatchObject({ proposedChanges: { modelOrConnectorAuthored: true } });
});
it('refuses forward references at propose', async () => {
  const response = await app.inject({ method: 'POST', url: '/v1/memory/transactions/propose', headers: headers(randomUUID()),
    payload: { transactionKind: 'RESOLVE', registryReleaseId, risk: 'LOW', operations: [resolution(await frame()), claim()] } });
  expect(response.statusCode).toBe(400); expect(response.json()).toMatchObject({ code: 'BELIEF_OPERATION_REF_UNRESOLVED' });
});
it.each([false, true])('fails closed on unreadable outcome evidence (pending=%s)', async pending => {
  const hidden = await evidence(true, 'PERSONAL_FINANCE'), id = randomUUID();
  if (!pending) await admin.query("INSERT INTO claims(id,owner_scope_id,source_anchor_id,claim_origin,lifecycle) VALUES($1,$2,$3,'USER_STATEMENT','CANDIDATE')", [id, owner, hidden.anchor]);
  const run = await prepare([...(pending ? [claim(hidden.anchor)] : []), resolution(await frame(), { claim: pending ? '#outcome' : id })]);
  expect(run.report.decision).toBe('REJECTED'); expect(run.report.warnings).toContain('RESOLUTION_CLAIM_EVIDENCE_UNREADABLE');
  expect((await run.commit()).statusCode).toBe(409);
  expect(await rows('SELECT id FROM resolution_assertions WHERE creation_transaction_id=$1', [run.transactionId])).toEqual([]);
});
it.each(['SOURCE', 'TARGET'] as const)('rolls back every operation if the %s retires during commit', async end => {
  const source = await frame(), target = await frame('shared.event_occurrence');
  const run = await prepare([claim(), resolution(source, { targetFrameInstance: target })]);
  const before = await rows('SELECT id FROM claims WHERE owner_scope_id=$1 ORDER BY id', [owner]);
  const holder = await admin.connect(); let pending: ReturnType<typeof run.commit> | undefined;
  try {
    await holder.query('BEGIN');
    const retiring = randomUUID();
    await holder.query(`INSERT INTO belief_transactions(id,owner_scope_id,transaction_kind,requested_by_actor_id,source_evidence_ids,registry_release_id,status,risk,idempotency_key)
      VALUES($1,$2,'MERGE',$3,'{}',$4,'COMMITTING','LOW',$5)`, [retiring, owner, actor, registryReleaseId, randomUUID()]);
    await holder.query("SELECT set_config('unai.belief_transaction_id',$1,true)", [retiring]);
    await holder.query("UPDATE frame_instances SET lifecycle='RETIRED',retired_at=now() WHERE id=$1", [end === 'SOURCE' ? source : target]);
    const pid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() pid')).rows[0]!.pid;
    let settled = false; pending = run.commit(); void pending.finally(() => { settled = true; });
    await expect.poll(async () => settled ? 'settled' : (await rows('SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))', [pid])).length ? 'blocked' : 'running').toBe('blocked');
    await holder.query('COMMIT');
    const response = await pending; expect(response.statusCode, response.body).toBe(400);
    expect(response.json()).toMatchObject({ code: `RESOLUTION_${end}_FRAME_NOT_ACTIVE` });
    expect(await rows('SELECT id FROM claims WHERE owner_scope_id=$1 ORDER BY id', [owner])).toEqual(before);
    expect(await rows('SELECT id FROM resolution_assertions WHERE creation_transaction_id=$1', [run.transactionId])).toEqual([]);
    expect(await rows('SELECT id FROM memory_links WHERE transaction_id=$1', [run.transactionId])).toEqual([]);
    expect(await rows('SELECT result_object_refs FROM belief_transaction_operations WHERE belief_transaction_id=$1', [run.transactionId]))
      .toEqual([{ result_object_refs: null }, { result_object_refs: null }]);
  } finally { await holder.query('ROLLBACK'); holder.release(); await pending; }
});
it('exposes only the requested released contracts under the governor owner context', async () => {
  const read = (purpose: string, release = registryReleaseId) => withOwnerTransaction(appPool,
    { ownerScopeId: owner, actorId: actor, purpose, correlationId: randomUUID() }, async tx =>
      (await tx.query('SELECT unai_private.registry_release_transition_contracts($1) contracts', [release])).rows[0]?.['contracts']);
  expect(transitionContractSetSchema.parse(await read('memory.govern')).map(contract => contract.id)).toEqual([
    'shared.commitment.resolution', 'shared.event_occurrence.realization', 'shared.event_occurrence.resolution', 'shared.obligation.resolution']);
  for (const purpose of ['decisions.record', 'memory.inspect', 'memory.read']) expect(await read(purpose)).toEqual([]);
  expect(await read('memory.govern', randomUUID())).toEqual([]);
  const client = await appPool.connect();
  try { expect((await client.query('SELECT unai_private.registry_release_transition_contracts($1) contracts', [registryReleaseId])).rows[0].contracts).toEqual([]); }
  finally { client.release(); }
  expect(await rows("SELECT prosecdef,provolatile,proconfig FROM pg_proc WHERE oid='unai_private.registry_release_transition_contracts(uuid)'::regprocedure"))
    .toEqual([{ prosecdef: true, provolatile: 's', proconfig: ['search_path=pg_catalog'] }]);
  expect(await rows("SELECT has_function_privilege('unai_app','unai_private.registry_release_transition_contracts(uuid)','EXECUTE') app,has_function_privilege('unai_auth','unai_private.registry_release_transition_contracts(uuid)','EXECUTE') auth"))
    .toEqual([{ app: true, auth: false }]);
});
