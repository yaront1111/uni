import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { postgresAdapter, SESSION_COOKIE } from '@unai/auth';
import { runMigrations } from '@unai/postgres';
import { CANONICAL_NORMALIZATION_VERSION } from '@unai/memory';
import type { ModelProvider } from '@unai/model';
import { loadRegistryRelease, publishRegistryRelease } from '../../registry/src/index.js';
import { createPlatformApi } from './platform.js';
import { createEvidenceObjects } from './evidence.js';
import { createProcessingRuntime, type ProcessingRuntimeOptions } from './processing-runtime.js';
import { processingKey } from './processing-store.js';

/**
 * ADR 0048: a change of the pinned registry release strands no extraction work.
 * A job dispatched under release A (0.1.0) is run by a worker pinned to B (0.3.0);
 * an item with stage output finishes under the release it began with.
 *
 * The file owns a database of its own: publishing a registry release is
 * permanent, and the shared suite database must hold exactly one (see
 * `packages/capabilities/src/identity-invariant.test.ts`).
 */

if (!process.env.UNAI_TEST_DATABASE_URL) throw new Error('Run pnpm test for the required PostgreSQL harness');
const serverUrl = process.env.UNAI_TEST_DATABASE_URL;
const databaseName = 'unai_processing_release_' + randomUUID().replaceAll('-', '');
interface Release { id: string; version: string }
const A: Release = { id: '', version: '0.1.0' }, B: Release = { id: '', version: '0.3.0' };
let created = false;
let admin: Pool | undefined;
let appPool: Pool | undefined;
let objects: Awaited<ReturnType<typeof createEvidenceObjects>> | undefined;

/** Roles are cluster-global and migration 0001 alters them, so every file that
 * migrates a database of its own serializes on this lock on the shared database. */
async function migrateScratch(pool: Pool): Promise<void> {
  const shared = new Pool({ connectionString: serverUrl, max: 1 });
  const client = await shared.connect();
  try {
    await client.query('SELECT pg_advisory_lock(1970170217, 3)');
    await runMigrations(pool, resolve('migrations'));
    await pool.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='processing_release_test_app') THEN CREATE ROLE processing_release_test_app LOGIN PASSWORD 'test-only'; END IF; END $$; GRANT unai_app TO processing_release_test_app");
  } finally {
    await client.query('SELECT pg_advisory_unlock(1970170217, 3)').catch(() => undefined);
    client.release();
    await shared.end().catch(() => undefined);
  }
}

/** Both releases from one commit, each loaded by its immutable Git tag. */
async function publishReleases(pool: Pool): Promise<void> {
  const repository = await mkdtemp(join(tmpdir(), 'unai-processing-release-'));
  try {
    await cp(resolve('registry'), join(repository, 'registry'), { recursive: true });
    for (const args of [['init', '--quiet'], ['add', 'registry'], ['commit', '--quiet', '-m', 'release'], ['tag', 'registry-v0.1.0'], ['tag', 'registry-v0.3.0']]) {
      const command = spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=Registry Test', '-c', 'user.email=registry@test.invalid', ...args], {
        cwd: repository, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: '2024-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2024-01-01T00:00:00Z' } });
      if (command.status !== 0) throw new Error('TEST_RELEASE_PREPARATION_FAILED');
    }
    for (const release of [A, B]) {
      const loaded = await loadRegistryRelease({ repository, version: release.version });
      release.id = (await publishRegistryRelease(pool, loaded, randomUUID())).releaseId;
    }
  } finally { await rm(repository, { recursive: true, force: true }); }
}

beforeAll(async () => {
  const server = new Pool({ connectionString: serverUrl, max: 1 });
  try { await server.query('CREATE DATABASE ' + databaseName); created = true; }
  finally { await server.end().catch(() => undefined); }
  const url = new URL(serverUrl); url.pathname = '/' + databaseName;
  admin = new Pool({ connectionString: url.href });
  await migrateScratch(admin);
  const appUrl = new URL(url.href); appUrl.username = 'processing_release_test_app'; appUrl.password = 'test-only';
  appPool = new Pool({ connectionString: appUrl.href });
  objects = await createEvidenceObjects({ endpoint: process.env.UNAI_TEST_S3_ENDPOINT!, region: 'us-east-1',
    bucket: process.env.UNAI_TEST_S3_BUCKET!, kmsKeyId: process.env.UNAI_TEST_S3_KMS_KEY_ID! });
  await publishReleases(admin);
}, 120000);
afterAll(async () => {
  objects?.close(); await appPool?.end(); await admin?.end();
  if (!created) return;
  const server = new Pool({ connectionString: serverUrl, max: 1 });
  try { await server.query('DROP DATABASE IF EXISTS ' + databaseName + ' WITH (FORCE)'); }
  finally { await server.end().catch(() => undefined); }
});

const rows = async (sql: string, params: unknown[]) => (await admin!.query(sql, params)).rows;

async function owner() {
  const adapter = postgresAdapter(admin!);
  const user = await adapter.createUser!({ name: 'Release journey', email: 'release-' + randomUUID() + '@example.test', emailVerified: null });
  const ownerScopeId = (user as unknown as { ownerScopeId: string }).ownerScopeId;
  const token = randomBytes(32).toString('base64url');
  await adapter.createSession!({ userId: user.id, sessionToken: token, expires: new Date(Date.now() + 86400000) });
  const apps: ReturnType<typeof createPlatformApi>[] = [];
  /** The API process pinned to one release, as `server.ts` composes it. */
  function api(release: Release) {
    const app = createPlatformApi({ appPool: appPool!, authPool: admin!, evidenceObjects: objects!, registryReleaseId: release.id, registryRelease: release.version });
    app.addHook('onRequest', async request => { Object.defineProperty(request.raw.socket, 'encrypted', { value: true, configurable: true }); });
    apps.push(app);
    return app;
  }
  const app = api(A);
  function headers(purpose: string) { return { cookie: SESSION_COOKIE + '=' + token,
    'x-owner-scope-id': ownerScopeId, 'x-purpose': purpose, 'x-correlation-id': randomUUID(), 'idempotency-key': randomUUID(),
    'x-data-purpose': 'PERSONAL_ASSISTANCE', 'x-maximum-sensitivity': 'PRIVATE' }; }
  async function ingest(text: string) {
    const key = randomUUID();
    const response = await app.inject({ method: 'POST', url: '/v1/evidence', headers: { ...headers('evidence.ingest'), 'idempotency-key': key }, payload: {
      ownerScopeId, sourceType: 'CONVERSATION', externalId: key, actorRef: { type: 'USER', id: user.id },
      occurredAt: '2025-01-06T09:00:00Z', content: { body: text }, deterministicMetadata: { timeZone: 'Asia/Jerusalem' },
      sensitivity: 'PRIVATE', allowedPurposes: ['PERSONAL_ASSISTANCE'], idempotencyKey: key,
    } });
    expect(response.statusCode, response.body).toBe(200);
    return response.json().evidenceId as string;
  }
  const model = { calls: 0, failing: false };
  const provider: ModelProvider = { providerId: 'recorded-test', defaultModelId: 'source-span-test', async complete(request) {
    model.calls++;
    if (model.failing) throw new Error('MODEL_PROVIDER_UNAVAILABLE');
    const input = JSON.parse(request.input) as { anchors: { anchorKind: string; parentAnchor: Record<string, unknown>; text: string }[] };
    const anchor = input.anchors[0]!;
    return { modelId: 'source-span-test', costMicrounits: 1, outputText: JSON.stringify({ claims: [{
      frameTypeId: 'shared.commitment', statement: anchor.text, span: { anchorKind: anchor.anchorKind,
        parentAnchor: anchor.parentAnchor, start: 0, end: anchor.text.length, quote: anchor.text },
      extractionConfidence: 0.95, temporalExpression: /tomorrow/.test(anchor.text) ? 'tomorrow' : null, participants: [],
    }], unknowns: [] }) };
  } };
  /** The worker process pinned to one release. */
  function runtime(release: Release, extra: Partial<ProcessingRuntimeOptions> = {}) { return createProcessingRuntime({ appPool: appPool!, ownerScopeId,
    actorId: user.id, registryReleaseId: release.id, provider, dataPurpose: 'PERSONAL_ASSISTANCE', maximumSensitivity: 'PRIVATE', workerId: 'release-test', ...extra }); }
  async function state(id: string) { return (await rows('SELECT * FROM evidence_processing WHERE source_item_id=$1', [id]))[0]; }
  const succeededRuns = (id: string) => rows("SELECT registry_release_id,processing_key FROM extraction_runs WHERE source_item_id=$1 AND status='SUCCEEDED'", [id]);
  const committed = () => rows("SELECT registry_release_id FROM belief_transactions WHERE owner_scope_id=$1 AND status='COMMITTED'", [ownerScopeId]);
  const count = async (table: string) => (await rows(`SELECT count(*)::int AS n FROM ${table} WHERE owner_scope_id=$1`, [ownerScopeId]))[0].n as number;
  const close = async () => { for (const each of apps) await each.close(); };
  return { app, api, ownerScopeId, headers, ingest, model, runtime, state, succeededRuns, committed, count, close };
}

it('runs a job queued under the previous pin under the new pin (ADR 0048 D1)', async () => {
  const o = await owner();
  try {
    const id = await o.ingest('I will send the launch report by tomorrow.');
    expect(await o.runtime(A).dispatch()).toBe(1);
    const queued = await o.state(id);
    expect(queued).toMatchObject({ status: 'PENDING', registry_release_id: A.id });
    const jobId = queued.job_id as string;
    expect(await o.runtime(B).validate()).toBe('0.3.0');
    expect((await o.runtime(B).runOnce()).job).toMatchObject({ jobId, status: 'SUCCEEDED', attemptCount: 1 });
    expect(await o.state(id)).toMatchObject({ status: 'SUCCEEDED', registry_release_id: B.id, job_id: jobId, last_error: null });
    expect(await rows('SELECT registry_release_id,processing_key,status FROM extraction_runs WHERE source_item_id=$1', [id]))
      .toEqual([{ registry_release_id: B.id, processing_key: processingKey(id, B.id), status: 'SUCCEEDED' }]);
    expect(await o.committed()).toEqual([{ registry_release_id: B.id }]);
    expect((await rows('SELECT payload FROM jobs WHERE id=$1', [jobId]))[0].payload.registryReleaseId, 'the job payload is immutable').toBe(A.id);
    expect((await o.runtime(B).runOnce()).claimed).toBe(false);
    expect(o.model.calls).toBe(1);
    expect(await rows("SELECT id FROM jobs WHERE owner_scope_id=$1 AND last_error='PROCESSING_RELEASE_MISMATCH'", [o.ownerScopeId])).toEqual([]);
  } finally { await o.close(); }
}, 30000);

it('completes a dead letter of the previous pin under the new pin after the operator retry (ADR 0048 D2)', async () => {
  const o = await owner();
  try {
    const id = await o.ingest('I will send the dead letter report by tomorrow.');
    o.model.failing = true;
    const old = o.runtime(A);
    for (const attemptCount of [1, 2, 3]) {
      expect((await old.runOnce()).job).toMatchObject({ status: attemptCount === 3 ? 'DEAD_LETTER' : 'FAILED', lastError: 'MODEL_PROVIDER_FAILED', attemptCount });
    }
    const jobId = (await o.state(id)).job_id as string;
    o.model.failing = false;
    const retried = await o.app.inject({ method: 'POST', url: '/v1/ops/dead-letter/' + jobId + '/retry', headers: o.headers('ops.dead_letter.retry'), payload: {} });
    expect(retried.statusCode, retried.body).toBe(200);
    expect(retried.json()).toMatchObject({ retried: true, job: { jobId, status: 'PENDING', attemptCount: 0 } });
    expect((await o.runtime(B).runOnce()).job).toMatchObject({ jobId, status: 'SUCCEEDED' });
    expect(await o.state(id)).toMatchObject({ status: 'SUCCEEDED', registry_release_id: B.id, last_error: null });
    expect(await o.succeededRuns(id)).toEqual([{ registry_release_id: B.id, processing_key: processingKey(id, B.id) }]);
    expect(o.model.calls).toBe(4);
  } finally { await o.close(); }
}, 30000);

it.each(['EXTRACTED', 'CANONICALIZED', 'GOVERNED', 'PROJECTED'] as const)('finishes an item interrupted after %s under the release it began with', async stage => {
  const o = await owner();
  try {
    const id = await o.ingest('I will send the checkpoint report by tomorrow.');
    let interrupted = false;
    const old = o.runtime(A, { onCheckpoint: async checkpoint => { if (!interrupted && checkpoint === stage) { interrupted = true; throw new Error('SIMULATED_WORKER_STOP'); } } });
    expect((await old.runOnce()).job?.status).toBe('FAILED');
    expect(interrupted).toBe(true);
    expect((await o.runtime(B).runOnce()).job?.status).toBe('SUCCEEDED');
    expect(await o.state(id)).toMatchObject({ status: 'SUCCEEDED', registry_release_id: A.id, last_error: null });
    expect(o.model.calls).toBe(1);
    expect(await o.count('claims')).toBe(3);
    expect(await o.committed()).toEqual([{ registry_release_id: A.id }]);
    expect(await o.succeededRuns(id)).toEqual([{ registry_release_id: A.id, processing_key: processingKey(id, A.id) }]);
    expect(await o.count('projection_rebuild_receipts')).toBe(3);
  } finally { await o.close(); }
}, 30000);

it('answers a document re-request after a re-pin with the job queued under the previous pin (ADR 0048 D2)', async () => {
  const o = await owner();
  try {
    const body = { documentId: randomUUID(), mediaType: 'text/plain', pages: [{ page: 1, text: 'I will send the launch report by tomorrow.' }],
      requestFullExtraction: true, sensitivity: 'PRIVATE', allowedPurposes: ['PERSONAL_ASSISTANCE'] };
    const first = await o.app.inject({ method: 'POST', url: '/v1/documents', headers: o.headers('evidence.ingest'), payload: body });
    expect(first.statusCode, first.body).toBe(201);
    const { evidenceId, extractionJobId: jobId } = first.json() as { evidenceId: string; extractionJobId: string };
    expect(await o.state(evidenceId)).toMatchObject({ registry_release_id: A.id, job_id: jobId });
    const again = await o.api(B).inject({ method: 'POST', url: '/v1/documents', headers: o.headers('evidence.ingest'), payload: body });
    expect(again.statusCode, again.body).toBe(201);
    expect(again.json()).toMatchObject({ evidenceId, extractionJobId: jobId });
    expect((await o.runtime(B).runOnce()).job).toMatchObject({ jobId, status: 'SUCCEEDED' });
    expect(await o.state(evidenceId)).toMatchObject({ status: 'NEEDS_REVIEW', registry_release_id: B.id });
  } finally { await o.close(); }
}, 30000);

it('pins the normalization version a re-pin never recomputes (ADR 0048 D3)', () => {
  expect(CANONICAL_NORMALIZATION_VERSION, 'ADR 0048 D3: the change that bumps CANONICAL_NORMALIZATION_VERSION must wire '
    + 'recomputeCanonicalFingerprints into production in that same change').toBe('normalization-1');
});
