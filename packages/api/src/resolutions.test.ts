import { Pool } from 'pg';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { runMigrations, withOwnerTransaction, type OwnerTransaction } from '@unai/postgres';
import { postgresAdapter, SESSION_COOKIE } from '@unai/auth';
import { applyProjectionDelta, canonicalizeCommitmentStatement, resolveOwnerEntity } from '@unai/capabilities';
import { loadRegistryRelease, publishRegistryRelease } from '../../registry/src/index.js';
import type { EvidenceObjects } from './evidence.js';
import { createPlatformApi, PLATFORM_PURPOSES, routePurpose } from './platform.js';
import { RESOLUTION_WRITE_PURPOSE } from './resolutions.js';

/** POST /v1/memory/resolutions over the real boundary (PRD §16, §35.6, §44): the
 * owner's outcome becomes a committed resolution assertion, or an unattached owner
 * delta, and the commitment's projection reads the change on the next GET. Every
 * test gets a fresh owner, because an unattached delta makes its owner's views
 * incomplete. */

if (!process.env.UNAI_TEST_DATABASE_URL) throw new Error('Run pnpm test for the required PostgreSQL harness');
const admin = new Pool({ connectionString: process.env.UNAI_TEST_DATABASE_URL });
const url = new URL(process.env.UNAI_TEST_DATABASE_URL); url.username = 'resolutions_route_test_app'; url.password = 'test-only';
const appPool = new Pool({ connectionString: url.href });
const stored = new Map<string, Uint8Array>();
const evidenceObjects: EvidenceObjects = {
  encryptionKeyRef: 'kms:test-double',
  async put(_tx, id, bytes) { stored.set(id, bytes); },
  async get(_tx, id) { const bytes = stored.get(id); if (!bytes) throw new Error('OBJECT_NOT_FOUND'); return bytes; },
};
let registryReleaseId = '';
const rows = async (sql: string, values: unknown[] = []) => (await admin.query<Record<string, unknown>>(sql, values)).rows;
const count = async (table: string, owner: string, where = 'true') =>
  Number((await rows(`SELECT count(*)::int AS n FROM ${table} WHERE owner_scope_id=$1 AND ${where}`, [owner]))[0]!['n']);

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
  const repository = await mkdtemp(join(tmpdir(), 'unai-resolutions-release-'));
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
beforeAll(async () => {
  await runMigrations(admin, resolve('migrations'));
  await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='resolutions_route_test_app') THEN CREATE ROLE resolutions_route_test_app LOGIN PASSWORD 'test-only'; END IF; END $$; GRANT unai_app TO resolutions_route_test_app");
  registryReleaseId = await pinnedRegistryRelease();
});
afterAll(async () => { await appPool.end(); await admin.end(); });

interface Owner { owner: string; actor: string; token: string; contextSpaceId: string; commitment: string }
/** A fresh owner with one overdue commitment, written through the capability
 * stores under the application role and projected by the reducer. */
async function freshOwner(): Promise<Owner> {
  const adapter = postgresAdapter(admin);
  // Recovery selects its AC44 fixtures by display name; keep this owner distinct.
  const user = await adapter.createUser!({ name: 'Owner outcome route owner', email: randomUUID() + '@resolutions.example.test', emailVerified: null });
  const actor = user.id, owner = (user as unknown as { ownerScopeId: string }).ownerScopeId, token = randomBytes(32).toString('base64url');
  await adapter.createSession!({ userId: actor, sessionToken: token, expires: new Date(Date.now() + 604800000) });
  const contextSpaceId = (await rows("SELECT id FROM context_spaces WHERE owner_scope_id=$1 AND context_kind='BASE'", [owner]))[0]!['id'] as string;
  const connector = randomUUID(), item = randomUUID(), anchor = randomUUID(), daniel = randomUUID();
  await admin.query("INSERT INTO connectors(id,owner_scope_id,connector_type,external_account_ref,permission_manifest,status) VALUES($1,$2,'CONVERSATION',$3,'{}','ACTIVE')", [connector, owner, connector]);
  await admin.query(`INSERT INTO source_items(id,owner_scope_id,connector_id,source_type,external_id,actor_ref,submitted_by_user_id,
    raw_object_ref,content_hash,sensitivity,allowed_purposes,ingestion_version,idempotency_key)
    VALUES($1,$2,$3,'CONVERSATION',$8,$4,$5,$6,$7,'PRIVATE',ARRAY['PERSONAL_ASSISTANCE'],'evidence-json-v1',$8)`,
    [item, owner, connector, JSON.stringify({ type: 'USER', id: actor }), actor, randomUUID(), randomBytes(32).toString('hex'), 'commitment-' + item]);
  await admin.query(`INSERT INTO source_anchors(id,owner_scope_id,source_item_id,anchor_kind,anchor,normalized_text)
    VALUES($1,$2,$3,'MESSAGE_SPAN','{"start":0,"end":39}','I will send Daniel the report by Friday')`, [anchor, owner, item]);
  await admin.query("INSERT INTO entities(id,owner_scope_id,entity_kind,canonical_label) VALUES($1,$2,'PERSON','Daniel')", [daniel, owner]);
  const as = <T,>(purpose: string, run: (tx: OwnerTransaction) => Promise<T>) =>
    withOwnerTransaction(appPool, { actorId: actor, ownerScopeId: owner, purpose, correlationId: randomUUID() }, run);
  const commitment = await as('memory.canonicalize', async tx => {
    const self = await resolveOwnerEntity(tx, { ownerScopeId: owner, actorId: actor });
    return (await canonicalizeCommitmentStatement(tx, { ownerScopeId: owner, contextSpaceId, statement: 'I will send Daniel the report by Friday',
      sourceAnchorId: anchor, claimOrigin: 'USER_STATEMENT', assertedByEntityId: self, promisorEntityId: self, promiseeEntityId: daniel,
      dueTime: new Date('2026-01-09T17:00:00.000Z'), statedAt: new Date('2026-01-05T08:00:00.000Z') })).commitmentFrameInstanceId!;
  });
  await as('memory.project', tx => applyProjectionDelta(tx, { ownerScopeId: owner, projectionName: 'open_commitments_projection', asOf: new Date() }));
  return { owner, actor, token, contextSpaceId, commitment };
}
async function occurrence(o: Owner) {
  const id = randomUUID();
  await admin.query("INSERT INTO frame_instances(id,owner_scope_id,frame_type_id,context_space_id) VALUES($1,$2,'shared.event_occurrence',$3)",
    [id, o.owner, o.contextSpaceId]);
  return id;
}
function api() {
  const app = createPlatformApi({ authPool: admin, appPool, registryReleaseId, evidenceObjects });
  app.addHook('onRequest', async request => { Object.defineProperty(request.raw.socket, 'encrypted', { value: true }); });
  return app;
}
function headers(o: Owner, purpose = 'memory.govern', extra: Record<string, string> = {}): Record<string, string> {
  return { cookie: SESSION_COOKIE + '=' + o.token, 'x-owner-scope-id': o.owner, 'x-purpose': purpose, 'x-correlation-id': randomUUID(),
    'x-data-purpose': 'PERSONAL_ASSISTANCE', 'x-maximum-sensitivity': 'RESTRICTED', ...extra };
}
type App = ReturnType<typeof api>;
const record = (app: App, o: Owner, payload: object, key = randomUUID(), extra: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: '/v1/memory/resolutions', headers: headers(o, 'memory.govern', { 'idempotency-key': key, ...extra }), payload });
const commitments = async (app: App, o: Owner, query = '') => {
  const response = await app.inject({ method: 'GET', url: '/v1/projections/commitments' + query, headers: headers(o, 'projection.read') });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ rows: CommitmentRow[]; pendingAssertions: Array<Record<string, unknown>>; isComplete: boolean }>();
};
interface CommitmentRow {
  commitmentFrameInstanceId: string; outcomeState: string; overdue: boolean; sourceStrength: string;
  sourceManifest: { acceptedResolutionIds: string[] };
}

it('DoD 1: a target-linked outcome commits an accepted resolution assertion with its evidence and transaction', async () => {
  const o = await freshOwner(), target = await occurrence(o), app = api();
  try {
    const response = await record(app, o, { sourceFrameInstanceId: o.commitment, targetFrameInstanceId: target, statement: 'I delivered it at the meeting' });
    expect(response.statusCode, response.body).toBe(201);
    const receipt = response.json();
    expect(receipt).toMatchObject({ status: 'COMMITTED', sourceFrameInstanceId: o.commitment, targetFrameInstanceId: target, outcomeCode: 'FULFILLED',
      transitionContractId: 'shared.commitment.resolution', lifecycle: 'ACCEPTED', outcomeState: 'RESOLVED' });
    expect(await rows('SELECT target_frame_instance_id,outcome_code,lifecycle,creation_transaction_id,claim_id FROM resolution_assertions WHERE owner_scope_id=$1', [o.owner]))
      .toEqual([{ target_frame_instance_id: target, outcome_code: 'FULFILLED', lifecycle: 'ACCEPTED', creation_transaction_id: receipt.transactionId, claim_id: receipt.claimId }]);
    expect(await rows('SELECT id,status,transaction_kind,source_evidence_ids FROM belief_transactions WHERE owner_scope_id=$1', [o.owner]))
      .toEqual([{ id: receipt.transactionId, status: 'COMMITTED', transaction_kind: 'RESOLVE', source_evidence_ids: [receipt.evidenceId] }]);
    expect(await rows(`SELECT a.source_item_id,a.normalized_text,c.claim_origin FROM claims c JOIN source_anchors a ON a.owner_scope_id=c.owner_scope_id
      AND a.id=c.source_anchor_id WHERE c.owner_scope_id=$1 AND c.id=$2`, [o.owner, receipt.claimId]))
      .toEqual([{ source_item_id: receipt.evidenceId, normalized_text: 'I delivered it at the meeting', claim_origin: 'USER_STATEMENT' }]);
    expect(await rows('SELECT link_kind,lifecycle,from_object_type,from_object_id,to_object_id FROM memory_links WHERE owner_scope_id=$1 AND transaction_id=$2',
      [o.owner, receipt.transactionId])).toEqual([{ link_kind: 'RESOLVES', lifecycle: 'ACTIVE', from_object_type: 'frame_instance', from_object_id: target, to_object_id: o.commitment }]);
  } finally { await app.close(); }
});

it('DoD 2: a target-less outcome links from the assertion and the related-frames read lists it', async () => {
  const o = await freshOwner(), app = api();
  try {
    const response = await record(app, o, { sourceFrameInstanceId: o.commitment, statement: 'Done, I sent it', effectiveAt: '2026-01-10T11:00:00+02:00' });
    expect(response.statusCode, response.body).toBe(201);
    const { resolutionAssertionId, transactionId } = response.json();
    expect(await rows('SELECT target_frame_instance_id FROM resolution_assertions WHERE owner_scope_id=$1', [o.owner])).toEqual([{ target_frame_instance_id: null }]);
    expect(await rows('SELECT from_object_type,from_object_id,to_object_id FROM memory_links WHERE owner_scope_id=$1 AND transaction_id=$2', [o.owner, transactionId]))
      .toEqual([{ from_object_type: 'resolution_assertion', from_object_id: resolutionAssertionId, to_object_id: o.commitment }]);
    const related = await app.inject({ method: 'GET', url: '/v1/memory/frames/related?ids=' + o.commitment, headers: headers(o, 'memory.inspect') });
    expect(related.statusCode, related.body).toBe(200);
    const [resolution] = related.json().frames[0].resolutions;
    expect(resolution).toMatchObject({ resolutionAssertionId, outcomeCode: 'FULFILLED', lifecycle: 'ACCEPTED', effectiveAt: '2026-01-10T09:00:00.000Z' });
    expect(resolution.evidence[0].anchors[0].text).toBe('Done, I sent it');
  } finally { await app.close(); }
});

it('DoD 2: an outcome naming no item is kept as an unattached owner delta, listed and never dropped', async () => {
  const o = await freshOwner(), app = api(), key = randomUUID();
  try {
    const body = { statement: 'I paid him back', candidateFrameTypes: ['shared.obligation'] };
    const first = await record(app, o, body, key);
    expect(first.statusCode, first.body).toBe(201);
    const receipt = first.json();
    expect(receipt).toMatchObject({ status: 'AWAITING_SOURCE', outcomeCode: 'FULFILLED', lifecycle: 'AWAITING_INSTANCE_RESOLUTION' });
    const view = await commitments(app, o);
    expect(view.isComplete).toBe(false);
    expect(view.pendingAssertions).toContainEqual(expect.objectContaining({ overlayDeltaId: receipt.overlayDeltaId, reason: 'DELTA_NOT_ATTACHED', rawText: 'I paid him back' }));
    const overlay = await app.inject({ method: 'GET', url: '/v1/memory/overlay-deltas', headers: headers(o, 'memory.correct', { 'x-maximum-sensitivity': 'PRIVATE' }) });
    expect(overlay.statusCode, overlay.body).toBe(200);
    expect(overlay.json().deltas).toEqual([expect.objectContaining({ overlayDeltaId: receipt.overlayDeltaId, lifecycle: 'AWAITING_INSTANCE_RESOLUTION' })]);
    expect(await count('resolution_assertions', o.owner)).toBe(0);
    const retry = await record(app, o, body, key);
    expect(retry.statusCode, retry.body).toBe(200);
    expect(retry.json()).toEqual(receipt);
    expect(await count('owner_overlay_deltas', o.owner)).toBe(1);
    // The same key cannot later be spent on a governed outcome, with other words
    // (the evidence refuses them) or with the same words now naming an item.
    for (const [statement, code] of [['Done, I sent it', 'IDEMPOTENCY_CONFLICT'], ['I paid him back', 'IDEMPOTENCY_KEY_REUSED']]) {
      const reused = await record(app, o, { sourceFrameInstanceId: o.commitment, statement }, key);
      expect(reused.statusCode, reused.body).toBe(409);
      expect(reused.json().code).toBe(code);
    }
    expect(await count('resolution_assertions', o.owner) + await count('belief_transactions', o.owner)).toBe(0);
  } finally { await app.close(); }
});

it('DoD 3: recording done on a commitment makes the next projection read report it resolved, from canonical state', async () => {
  const o = await freshOwner(), app = api();
  try {
    const before = await commitments(app, o);
    expect(before.rows).toEqual([expect.objectContaining({ commitmentFrameInstanceId: o.commitment, outcomeState: 'UNRESOLVED', overdue: true })]);
    const response = await record(app, o, { sourceFrameInstanceId: o.commitment, statement: 'Done, I sent it' });
    expect(response.statusCode, response.body).toBe(201);
    const receipt = response.json();
    expect((await commitments(app, o)).rows.map(row => row.commitmentFrameInstanceId)).not.toContain(o.commitment);
    const [row] = (await commitments(app, o, '?includeResolved=true')).rows.filter(candidate => candidate.commitmentFrameInstanceId === o.commitment);
    expect(row).toMatchObject({ outcomeState: 'RESOLVED', overdue: false });
    expect(row!.sourceManifest.acceptedResolutionIds).toContain(receipt.resolutionAssertionId);
    expect(row!.sourceStrength).not.toBe('PENDING_OWNER_ASSERTION');
    expect(await count('owner_overlay_deltas', o.owner)).toBe(0);
  } finally { await app.close(); }
});

it('answers a retry and a simultaneous duplicate from the one committed transaction', async () => {
  const o = await freshOwner(), app = api(), key = randomUUID(), body = { sourceFrameInstanceId: o.commitment, statement: 'Done, I sent it' };
  try {
    const first = await record(app, o, body, key), again = await record(app, o, body, key);
    expect([first.statusCode, again.statusCode], again.body).toEqual([201, 200]);
    expect(again.json()).toEqual(first.json());
    // The committed key cannot be spent again on the same words naming no item.
    const unattached = await record(app, o, { statement: 'Done, I sent it' }, key);
    expect(unattached.statusCode, unattached.body).toBe(409);
    expect(unattached.json().code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await count('owner_overlay_deltas', o.owner)).toBe(0);
    const raced = await freshOwner(), racedKey = randomUUID(), racedBody = { sourceFrameInstanceId: raced.commitment, statement: 'Done, I sent it' };
    const pair = await Promise.all([record(app, raced, racedBody, racedKey), record(app, raced, racedBody, racedKey)]);
    expect(pair.map(response => response.statusCode).sort(), pair.map(response => response.body).join('\n')).toEqual([200, 201]);
    expect(pair[0]!.json().resolutionAssertionId).toBe(pair[1]!.json().resolutionAssertionId);
    for (const owner of [o.owner, raced.owner]) {
      expect(await count('resolution_assertions', owner)).toBe(1);
      expect(await count('belief_transactions', owner)).toBe(1);
      expect(await count('source_items', owner, "deterministic_metadata->>'record'='RESOLUTION'")).toBe(1);
    }
  } finally { await app.close(); }
});

it('refuses before writing anything, and audits each refusal the route makes', async () => {
  const o = await freshOwner(), other = await freshOwner(), app = api(), retired = randomUUID();
  await admin.query(`INSERT INTO frame_instances(id,owner_scope_id,frame_type_id,context_space_id,lifecycle,retired_at)
    VALUES($1,$2,'shared.commitment',$3,'RETIRED',now())`, [retired, o.owner, o.contextSpaceId]);
  const tables = ['resolution_assertions', 'belief_transactions', 'source_items', 'owner_overlay_deltas'];
  const snapshot = async () => Promise.all(tables.map(table => count(table, o.owner)));
  const before = await snapshot();
  try {
    const audited: Array<[object, Record<string, string>, number, string]> = [
      [{ sourceFrameInstanceId: o.commitment, statement: 'I waived it' }, {}, 422, 'TRANSITION_OUTCOME_REFUSED'],
      [{ sourceFrameInstanceId: randomUUID(), statement: 'Done, I sent it' }, {}, 404, 'RESOLUTION_SOURCE_NOT_FOUND'],
      [{ sourceFrameInstanceId: retired, statement: 'Done, I sent it' }, {}, 409, 'RESOLUTION_SOURCE_NOT_ACTIVE'],
      [{ statement: 'Done '.repeat(1700) }, {}, 400, 'RESOLUTION_INPUT_INVALID'],
      [{ statement: 'Done, I sent it', ownerScopeId: other.owner }, {}, 400, 'RESOLUTION_INPUT_INVALID'],
      [{ statement: 'Done, I sent it', candidateFrameTypes: [] }, {}, 400, 'RESOLUTION_INPUT_INVALID'],
      [{ sourceFrameInstanceId: o.commitment, targetFrameInstanceId: o.commitment, statement: 'Done, I sent it' }, {}, 400, 'RESOLUTION_INPUT_INVALID'],
      [{ targetFrameInstanceId: o.commitment, statement: 'Done, I sent it' }, {}, 400, 'RESOLUTION_INPUT_INVALID'],
      [{ sourceFrameInstanceId: o.commitment, statement: 'Thanks for the update' }, {}, 422, 'RESOLUTION_STATEMENT_UNRECOGNIZED'],
      [{ sourceFrameInstanceId: o.commitment, statement: 'Done', outcomeCode: 'CANCELLED' }, {}, 422, 'RESOLUTION_OUTCOME_DISAGREES_WITH_STATEMENT'],
      [{ sourceFrameInstanceId: o.commitment, statement: 'Done, I sent it', effectiveAt: '2999-01-01T00:00:00Z' }, {}, 400, 'RESOLUTION_INPUT_INVALID'],
      [{ sourceFrameInstanceId: o.commitment, statement: 'Done, I sent it' }, { 'x-data-purpose': 'not a purpose' }, 400, 'MEMORY_CONTEXT_REQUIRED'],
    ];
    for (const [payload, extra, status, code] of audited) {
      const correlationId = randomUUID(), response = await record(app, o, payload, randomUUID(), { ...extra, 'x-correlation-id': correlationId });
      expect(response.statusCode, code + ' ' + response.body).toBe(status);
      expect(response.json()).toEqual({ code, correlationId });
      expect(await rows('SELECT policy_decision,result FROM audit_events WHERE correlation_id=$1', [correlationId]), code)
        .toEqual([{ policy_decision: 'DENY', result: 'REFUSED' }]);
    }
    const wrongPurpose = await app.inject({ method: 'POST', url: '/v1/memory/resolutions', payload: { sourceFrameInstanceId: o.commitment, statement: 'Done, I sent it' },
      headers: headers(o, 'memory.correct', { 'idempotency-key': randomUUID() }) });
    expect(wrongPurpose.statusCode).toBe(403);
    expect(wrongPurpose.json().code).toBe('PURPOSE_REFUSED');
    const foreign = await record(app, o, { sourceFrameInstanceId: other.commitment, statement: 'Done, I sent it' }, randomUUID(), { 'x-owner-scope-id': other.owner });
    expect(foreign.statusCode, foreign.body).toBe(403);
    expect(await snapshot()).toEqual(before);
    expect(await count('resolution_assertions', other.owner)).toBe(0);
  } finally { await app.close(); }
});

it('maps the route to memory.govern in the platform purpose chain', () => {
  expect(RESOLUTION_WRITE_PURPOSE).toBe('memory.govern');
  expect(routePurpose('POST', '/v1/memory/resolutions')).toBe(RESOLUTION_WRITE_PURPOSE);
  expect(PLATFORM_PURPOSES.has(RESOLUTION_WRITE_PURPOSE)).toBe(true);
});
