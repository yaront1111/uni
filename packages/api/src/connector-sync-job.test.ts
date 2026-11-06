import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runMigrations, withOwnerTransaction, type OwnerTransaction } from '@unai/postgres';
import { postgresAdapter } from '@unai/auth';
import { listDeadLetterJobs } from '@unai/jobs';
import {
  ConnectorError, createConnector, disconnectConnector, setCapabilityGrants, type ConnectorClient, type ConnectorFetch,
} from '@unai/connectors';
import type { EvidenceObjects } from './evidence.js';
import {
  CONNECTOR_SYNC_JOB_KIND, TERMINAL_CONNECTOR_SYNC_ERROR_CODES, createConnectorSyncRuntime, enqueueConnectorSync,
} from './connector-sync-job.js';
import { createConnectorRuntime } from './connectors.js';

/**
 * Durable `connector.sync` jobs over real PostgreSQL: the worker-side handler, its
 * outcome mapping (done, retried, dead-lettered) and the enqueue de-duplication.
 * The provider is a recorded double serving the committed Gmail fixture, or
 * throwing the ConnectorError a real adapter throws for a given HTTP status.
 */

if (!process.env.UNAI_TEST_DATABASE_URL) throw new Error('Run pnpm test for the required PostgreSQL harness');
const admin = new Pool({ connectionString: process.env.UNAI_TEST_DATABASE_URL });
const appUrl = new URL(process.env.UNAI_TEST_DATABASE_URL);
appUrl.username = 'connector_sync_job_test_app'; appUrl.password = 'test-only';
const appPool = new Pool({ connectionString: appUrl.href });
const TIMEOUT = 60000;

beforeAll(async () => {
  await runMigrations(admin, resolve('migrations'));
  await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='connector_sync_job_test_app') THEN CREATE ROLE connector_sync_job_test_app LOGIN PASSWORD 'test-only'; END IF; END $$; GRANT unai_app TO connector_sync_job_test_app");
});
afterAll(async () => { await appPool.end(); await admin.end(); });
afterEach(() => { vi.restoreAllMocks(); });

const CURSOR = { position: 'page:1', providerToken: '1' };

/** A provider double: serves the fixture page, or throws the given error, and
 * records every fetch so "the provider was never called" is observable. */
function provider(failure?: Error) {
  const fetches: ConnectorFetch[] = [];
  const client: ConnectorClient = {
    async fetchPage(request) {
      fetches.push(request);
      if (failure) throw failure;
      const thread = JSON.parse(await readFile(resolve('fixtures/sources/gmail-thread.json'), 'utf8')) as unknown;
      return { payloads: [thread], nextCursor: CURSOR };
    },
  };
  return { client, fetches };
}

async function owner() {
  const user = await postgresAdapter(admin).createUser!({
    name: 'Connector sync job test', email: 'sync-job-' + randomUUID() + '@example.test', emailVerified: null });
  const ownerScopeId = (user as unknown as { ownerScopeId: string }).ownerScopeId;
  const as = <T,>(purpose: string, run: (tx: OwnerTransaction) => Promise<T>) =>
    withOwnerTransaction(appPool, { ownerScopeId, actorId: user.id, purpose, correlationId: randomUUID() }, run);
  const connectorId = await as('connector.manage', async tx => (await createConnector(tx, {
    connectorType: 'GMAIL', externalAccountRef: 'owner@example.test', secretRef: 'secret://mounted/gmail#token',
    requestedCapabilities: [{ capabilityId: 'gmail.read_metadata', granted: true }, { capabilityId: 'gmail.read_content', granted: true }],
  })).connectorId);
  return { ownerScopeId, actorId: user.id, connectorId, as };
}
type Owner = Awaited<ReturnType<typeof owner>>;

function runtime(o: Owner, client: ConnectorClient) {
  const objects = new Map<string, Uint8Array>();
  const evidenceObjects: EvidenceObjects = {
    encryptionKeyRef: 'kms:test-double',
    async put(_tx, id, bytes) { objects.set(id, bytes); },
    async get(_tx, id) { return objects.get(id)!; },
  };
  return createConnectorSyncRuntime({
    appPool, ownerScopeId: o.ownerScopeId, actorId: o.actorId, dataPurpose: 'PERSONAL_ASSISTANCE',
    maximumSensitivity: 'RESTRICTED', workerId: 'connector-sync-test-' + randomUUID(), evidenceObjects,
    connectorClient: () => client,
  });
}

function enqueue(o: Owner, input: { connectorId?: string; window?: string; maxAttempts?: number } = {}) {
  return o.as('jobs.enqueue', tx => enqueueConnectorSync(tx, {
    connectorId: input.connectorId ?? o.connectorId, mode: 'INCREMENTAL', window: input.window ?? '2026-11-02T10',
    ...(input.maxAttempts ? { maxAttempts: input.maxAttempts } : {}),
  }));
}
async function connectorRow(connectorId: string) {
  return (await admin.query('SELECT * FROM connectors WHERE id=$1', [connectorId])).rows[0];
}
async function sourceItemCount(ownerScopeId: string) {
  return (await admin.query('SELECT count(*)::int AS n FROM source_items WHERE owner_scope_id=$1', [ownerScopeId])).rows[0].n as number;
}
/** Captures what this process writes to its log streams during one test. */
function captureLogs() {
  const info = vi.spyOn(console, 'info');
  const stderr = vi.spyOn(process.stderr, 'write');
  return () => JSON.stringify([info.mock.calls, stderr.mock.calls.map(call => String(call[0]))]);
}

it('a connector.sync job ingests the fixture page, stores the cursor and audits one SUCCESS row', async () => {
  const o = await owner();
  const job = await enqueue(o);
  const { client, fetches } = provider();
  const attempt = await runtime(o, client).runOnce();
  expect(attempt).toMatchObject({ claimed: true, job: { jobId: job.jobId, status: 'SUCCEEDED', attemptCount: 1 } });
  expect(fetches).toHaveLength(1);
  expect(fetches[0]!.capabilities).toEqual(['gmail.read_content', 'gmail.read_metadata']);
  const items = (await admin.query("SELECT external_id FROM source_items WHERE owner_scope_id=$1 AND source_type='GMAIL' ORDER BY external_id",
    [o.ownerScopeId])).rows.map(row => row.external_id);
  expect(items).toEqual(['msg-9a1c04', 'msg-9a1c05', 'msg-9a1c06']);
  const connector = await connectorRow(o.connectorId);
  expect(connector.last_cursor).toEqual(CURSOR);
  expect(connector.status).toBe('ACTIVE');
  const audits = (await admin.query(`SELECT purpose,result,policy_decision,objects_and_fields_accessed AS objects
    FROM audit_events WHERE owner_scope_id=$1 AND correlation_id=$2`, [o.ownerScopeId, job.jobId])).rows;
  expect(audits.every(row => row.purpose === 'connector.sync' && row.result === 'SUCCESS' && row.policy_decision === 'ALLOW')).toBe(true);
  // One run-level row names the connector's cursor; the shared ingest path (the
  // same one the manual sync route uses) adds one row per stored item.
  const run = audits.filter(row => row.objects[0].type === 'connectors');
  expect(run).toHaveLength(1);
  expect(run[0].objects[0]).toEqual({ type: 'connectors', id: o.connectorId, fields: ['last_cursor', 'cursor_updated_at'] });
  expect(run[0].objects.slice(1).map((entry: { type: string }) => entry.type)).toEqual(['source_items', 'source_items', 'source_items']);
  expect(audits.filter(row => row.objects[0].type === 'source_items')).toHaveLength(3);
  expect(audits).toHaveLength(4);
}, TIMEOUT);

it.each([401, 400] as const)('a %s marks the connector TOKEN_REVOKED and completes the job without a retry', async status => {
  const o = await owner();
  const job = await enqueue(o);
  const sync = runtime(o, provider(new ConnectorError('CONNECTOR_TOKEN_REVOKED', { status })).client);
  expect(await sync.runOnce()).toMatchObject({ claimed: true, job: { jobId: job.jobId, status: 'SUCCEEDED', attemptCount: 1 } });
  const connector = await connectorRow(o.connectorId);
  expect(connector).toMatchObject({ status: 'TOKEN_REVOKED', secret_ref: null, last_sync_error: 'CONNECTOR_TOKEN_REVOKED' });
  expect(await sync.runOnce()).toEqual({ claimed: false });
  expect(await sourceItemCount(o.ownerScopeId)).toBe(0);
  const audits = (await admin.query('SELECT purpose,result FROM audit_events WHERE owner_scope_id=$1 AND correlation_id=$2',
    [o.ownerScopeId, job.jobId])).rows;
  expect(audits).toEqual([{ purpose: 'connector.manage', result: 'SUCCESS' }]);
}, TIMEOUT);

it('a 403 is a retryable sync failure and keeps the credential handle', async () => {
  const o = await owner();
  const job = await enqueue(o);
  const sync = runtime(o, provider(new ConnectorError('CONNECTOR_TOKEN_REVOKED', { status: 403 })).client);
  expect(await sync.runOnce()).toMatchObject({ claimed: true,
    job: { jobId: job.jobId, status: 'FAILED', attemptCount: 1, lastError: 'CONNECTOR_TOKEN_REVOKED' } });
  expect(await connectorRow(o.connectorId)).toMatchObject({
    status: 'SYNC_FAILED', secret_ref: 'secret://mounted/gmail#token', last_sync_error: 'CONNECTOR_TOKEN_REVOKED' });
}, TIMEOUT);

it('a 503 fails the attempt, is retried, and dead-letters with its code and no provider text', async () => {
  const o = await owner();
  const SENTINEL = 'sentinel-' + randomUUID();
  const logs = captureLogs();
  const job = await enqueue(o, { maxAttempts: 2 });
  const sync = runtime(o, provider(new ConnectorError('CONNECTOR_PROVIDER_UNAVAILABLE', { status: 503, providerText: SENTINEL })).client);
  expect(await sync.runOnce()).toMatchObject({ claimed: true,
    job: { jobId: job.jobId, status: 'FAILED', attemptCount: 1, lastError: 'CONNECTOR_PROVIDER_UNAVAILABLE' } });
  expect(await connectorRow(o.connectorId)).toMatchObject({ status: 'SYNC_FAILED', last_sync_error: 'CONNECTOR_PROVIDER_UNAVAILABLE' });
  expect(await sync.runOnce()).toMatchObject({ claimed: true,
    job: { jobId: job.jobId, status: 'DEAD_LETTER', attemptCount: 2, lastError: 'CONNECTOR_PROVIDER_UNAVAILABLE' } });
  const deadLetter = await o.as('ops.dead_letter.read', tx => listDeadLetterJobs(tx, { limit: 10 }));
  expect(deadLetter.map(entry => [entry.jobId, entry.jobKind, entry.lastError]))
    .toEqual([[job.jobId, 'connector.sync', 'CONNECTOR_PROVIDER_UNAVAILABLE']]);
  const audits = (await admin.query('SELECT * FROM audit_events WHERE owner_scope_id=$1', [o.ownerScopeId])).rows;
  expect(audits.filter(row => row.correlation_id === job.jobId).map(row => [row.purpose, row.result]))
    .toEqual([['connector.sync', 'FAILURE'], ['connector.sync', 'FAILURE']]);
  const stored = JSON.stringify([
    (await admin.query('SELECT * FROM jobs WHERE owner_scope_id=$1', [o.ownerScopeId])).rows,
    await connectorRow(o.connectorId), audits]);
  expect(stored).toContain('CONNECTOR_PROVIDER_UNAVAILABLE');
  expect(stored).not.toContain(SENTINEL);
  const logged = logs();
  expect(logged).toContain('CONNECTOR_PROVIDER_UNAVAILABLE');
  expect(logged).not.toContain(SENTINEL);
}, TIMEOUT);

it('ADR 0041 D7: an Omi 429 with Retry-After dead-letters the connector.sync job on that attempt; runOnce inside the wait makes no further Omi request, and the next window resumes from the stored cursor', async () => {
  const o = await owner();
  // The real Omi client through the production factory, over a fetch double: the
  // client's 429 mapping and the job's terminal list are proven together. The key
  // is invented at run time and only ever sits behind the handle (FR-104, D6).
  const handle = 'secret://test/omi-key';
  const key = 'omi_dev_' + randomBytes(24).toString('hex');
  const omiId = await o.as('connector.manage', async tx => (await createConnector(tx, {
    connectorType: 'OMI', externalAccountRef: 'owner@example.test', secretRef: handle,
    requestedCapabilities: [{ capabilityId: 'omi.read_conversations', granted: true }],
  })).connectorId);
  const requests: { method: string; url: URL }[] = [];
  const replies: (() => Response)[] = [() => new Response(null, { status: 429, headers: { 'retry-after': '1800' } })];
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ method: (init?.method ?? 'GET').toUpperCase(),
      url: new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url) });
    // An empty queue answers 500, so an unexpected extra request shows up.
    return replies.shift()?.() ?? new Response(null, { status: 500 });
  });
  try {
    const client = createConnectorRuntime({
      async resolve(ref) { if (ref !== handle) throw new Error('SECRET_NOT_FOUND'); return key; },
    }, {}).connectorClient({ connectorType: 'OMI', secretRef: handle });
    const sync = runtime(o, client);
    const logs = captureLogs();
    const limited = await enqueue(o, { connectorId: omiId, window: '2026-11-06T10' });
    expect(await sync.runOnce()).toMatchObject({ claimed: true, job: {
      jobId: limited.jobId, status: 'DEAD_LETTER', attemptCount: 1, maxAttempts: 1, lastError: 'CONNECTOR_RATE_LIMITED' } });
    // Inside the wait: the worker's next polls claim nothing and call nobody.
    expect(await sync.runOnce()).toEqual({ claimed: false });
    expect(await sync.runOnce()).toEqual({ claimed: false });
    expect(requests).toHaveLength(1);
    expect(requests.every(r => r.method === 'GET' && r.url.origin + r.url.pathname === 'https://api.omi.me/v1/dev/user/conversations'))
      .toBe(true);
    expect(await connectorRow(omiId)).toMatchObject({
      status: 'SYNC_FAILED', last_sync_error: 'CONNECTOR_RATE_LIMITED', last_cursor: null, secret_ref: handle });
    const audits = (await admin.query('SELECT purpose,result FROM audit_events WHERE owner_scope_id=$1 AND correlation_id=$2',
      [o.ownerScopeId, limited.jobId])).rows;
    expect(audits).toEqual([{ purpose: 'connector.sync', result: 'FAILURE' }]);
    const logged = logs();
    expect(logged).toContain('CONNECTOR_RATE_LIMITED');
    expect(logged).not.toContain(key);

    // The next window: what the scheduler's port enqueues (enqueueConnectorSync,
    // mode INCREMENTAL, a new window and so a new job).
    const fixture = JSON.parse(await readFile(resolve('fixtures/sources/omi-conversation.json'), 'utf8')) as unknown;
    replies.push(() => Response.json([fixture], { headers: { 'x-omi-has-more': 'false' } }));
    const next = await enqueue(o, { connectorId: omiId, window: '2026-11-06T11' });
    expect(await sync.runOnce()).toMatchObject({ claimed: true, job: { jobId: next.jobId, status: 'SUCCEEDED', attemptCount: 1 } });
    expect(requests).toHaveLength(2);
    // Resumed from the cursor the failed run left unchanged (D7).
    expect(requests[1]!.url.search).toBe(requests[0]!.url.search);
    expect(await connectorRow(omiId)).toMatchObject({ status: 'ACTIVE', last_sync_error: null });
  } finally {
    vi.unstubAllGlobals();
  }
}, TIMEOUT);

it('connector.sync lists only CONNECTOR_RATE_LIMITED as terminal', () => {
  expect([...TERMINAL_CONNECTOR_SYNC_ERROR_CODES]).toEqual(['CONNECTOR_RATE_LIMITED']);
  expect(Object.isFrozen(TERMINAL_CONNECTOR_SYNC_ERROR_CODES)).toBe(true);
});

it('enqueueConnectorSync de-duplicates per connector, mode and window', async () => {
  const o = await owner();
  const first = await enqueue(o, { window: '2026-11-02T10' });
  const again = await enqueue(o, { window: '2026-11-02T10' });
  expect(again.jobId).toBe(first.jobId);
  const count = async () => (await admin.query('SELECT count(*)::int AS n FROM jobs WHERE owner_scope_id=$1 AND job_kind=$2',
    [o.ownerScopeId, CONNECTOR_SYNC_JOB_KIND])).rows[0].n as number;
  expect(await count()).toBe(1);
  const next = await enqueue(o, { window: '2026-11-02T11' });
  expect(next.jobId).not.toBe(first.jobId);
  expect(await count()).toBe(2);
  // The longest window still yields a key the jobs table accepts.
  await expect(enqueue(o, { window: 'W'.repeat(40) })).resolves.toMatchObject({ status: 'PENDING' });
  await expect(enqueue(o, { window: '2026-11-02T10:00' })).rejects.toThrow('CONNECTOR_SYNC_JOB_INVALID');
}, TIMEOUT);

it("a job naming another owner's connector dead-letters as CONNECTOR_NOT_FOUND and touches nothing", async () => {
  const a = await owner();
  const b = await owner();
  const job = await enqueue(a, { connectorId: b.connectorId, maxAttempts: 1 });
  const { client, fetches } = provider();
  expect(await runtime(a, client).runOnce()).toMatchObject({ claimed: true,
    job: { jobId: job.jobId, status: 'DEAD_LETTER', lastError: 'CONNECTOR_NOT_FOUND' } });
  expect(fetches).toHaveLength(0);
  expect(await connectorRow(b.connectorId)).toMatchObject({ status: 'ACTIVE', last_cursor: null, last_sync_error: null });
  expect(await sourceItemCount(a.ownerScopeId)).toBe(0);
  expect(await sourceItemCount(b.ownerScopeId)).toBe(0);
  expect((await admin.query('SELECT count(*)::int AS n FROM audit_events WHERE correlation_id=$1', [job.jobId])).rows[0].n).toBe(0);
}, TIMEOUT);

it('a disconnected connector completes the job with nothing to do', async () => {
  const o = await owner();
  await o.as('connector.manage', tx => disconnectConnector(tx, o.connectorId, async () => ({ revoked: true })));
  const logs = captureLogs();
  const job = await enqueue(o);
  const { client, fetches } = provider();
  expect(await runtime(o, client).runOnce()).toMatchObject({ claimed: true, job: { jobId: job.jobId, status: 'SUCCEEDED' } });
  expect(fetches).toHaveLength(0);
  expect(await sourceItemCount(o.ownerScopeId)).toBe(0);
  expect(logs()).toContain('CONNECTOR_INGESTION_STOPPED');
  const audits = (await admin.query('SELECT purpose,result,policy_decision FROM audit_events WHERE owner_scope_id=$1 AND correlation_id=$2',
    [o.ownerScopeId, job.jobId])).rows;
  expect(audits).toEqual([{ purpose: 'connector.sync', result: 'REFUSED', policy_decision: 'DENY' }]);
}, TIMEOUT);

// A change committed in the middle of a run refuses the run by name (the commit
// point's grant check, or migration 0018's trigger at ingest). Another transaction
// decided the outcome and recordSyncFailure writes nothing for it, so the job is
// done with one REFUSED row that names the connector and no field: not a FAILURE
// row naming fields nobody wrote, and not a retry of a deterministic refusal.
const MID_RUN_CHANGES: [string, (o: Owner) => Promise<unknown>][] = [
  ['CONNECTOR_CAPABILITY_NOT_GRANTED', o => o.as('connector.manage', tx =>
    setCapabilityGrants(tx, o.connectorId, [{ capabilityId: 'gmail.read_content', granted: false }]))],
  ['CONNECTOR_INGESTION_STOPPED', o => o.as('connector.manage', tx =>
    disconnectConnector(tx, o.connectorId, async () => ({ revoked: true })))],
];
it.each(MID_RUN_CHANGES)('a %s refusal in the middle of a run completes the job without a retry and audits one REFUSED row',
  async (code, change) => {
    const o = await owner();
    const logs = captureLogs();
    const job = await enqueue(o);
    const page = provider();
    // The change commits inside the first fetch, before the page is returned: a
    // fresh ACTIVE run holds no lock on the connector row yet, and every lifecycle
    // writer takes it FOR NO KEY UPDATE, so the writer neither waits nor deadlocks.
    let afterChange: unknown;
    const client: ConnectorClient = {
      async fetchPage(request) {
        await change(o);
        afterChange = await connectorRow(o.connectorId);
        return page.client.fetchPage(request);
      },
    };
    const sync = runtime(o, client);
    expect(await sync.runOnce()).toMatchObject({ claimed: true, job: { jobId: job.jobId, status: 'SUCCEEDED', attemptCount: 1 } });
    expect(await sync.runOnce()).toEqual({ claimed: false });
    expect(page.fetches).toHaveLength(1);
    expect(await sourceItemCount(o.ownerScopeId)).toBe(0);
    // The job wrote nothing to the connector: no SYNC_FAILED, no last_sync_error, same updated_at.
    expect(await connectorRow(o.connectorId)).toEqual(afterChange);
    const audits = (await admin.query(`SELECT purpose,result,policy_decision,objects_and_fields_accessed AS objects
      FROM audit_events WHERE owner_scope_id=$1 AND correlation_id=$2`, [o.ownerScopeId, job.jobId])).rows;
    expect(audits).toEqual([{
      purpose: 'connector.sync', result: 'REFUSED', policy_decision: 'DENY',
      objects: [{ type: 'connectors', id: o.connectorId, fields: [] }],
    }]);
    expect(logs()).toContain(code);
  }, TIMEOUT);

// A first-party type has no provider to poll. The attempt is done on its first try
// and records nothing on the connector: a recorded SYNC_FAILED would make migration
// 0018's connector_ingestion_active trigger refuse every later upload naming it.
for (const [connectorType, capabilityId] of [['DOCUMENT', 'documents.upload'], ['CONVERSATION', 'conversation.read_user_messages']] as const) {
  it('a ' + connectorType + ' connector.sync job completes on its first attempt and records nothing on the connector', async () => {
    const o = await owner();
    const connectorId = await o.as('connector.manage', async tx => (await createConnector(tx, {
      connectorType, externalAccountRef: 'first-party', secretRef: null,
      requestedCapabilities: [{ capabilityId, granted: true }],
    })).connectorId);
    const logs = captureLogs();
    const job = await enqueue(o, { connectorId });
    // The production factory, with a NORMAL ceiling: that is below the PRIVATE floor,
    // so a type check placed after the ceiling check would fail the run.
    const production = createConnectorRuntime({ async resolve() { throw new Error('UNEXPECTED_SECRET_RESOLVE'); } });
    const built: string[] = [];
    const sync = createConnectorSyncRuntime({
      appPool, ownerScopeId: o.ownerScopeId, actorId: o.actorId, dataPurpose: 'PERSONAL_ASSISTANCE',
      maximumSensitivity: 'NORMAL', workerId: 'connector-sync-test-' + randomUUID(),
      evidenceObjects: {
        encryptionKeyRef: 'kms:test-double',
        async put() { throw new Error('UNEXPECTED_PUT'); },
        async get() { throw new Error('UNEXPECTED_GET'); },
      },
      connectorClient: input => { built.push(input.connectorType); return production.connectorClient(input); },
    });
    expect(await sync.runOnce()).toMatchObject({ claimed: true, job: { jobId: job.jobId, status: 'SUCCEEDED', attemptCount: 1 } });
    expect(await sync.runOnce()).toEqual({ claimed: false });
    expect(built).toEqual([]);
    expect(await connectorRow(connectorId)).toMatchObject({ status: 'ACTIVE', last_sync_error: null });
    const audits = (await admin.query(`SELECT purpose,result,policy_decision,objects_and_fields_accessed AS objects
      FROM audit_events WHERE owner_scope_id=$1 AND correlation_id=$2`, [o.ownerScopeId, job.jobId])).rows;
    expect(audits).toEqual([{
      purpose: 'connector.sync', result: 'REFUSED', policy_decision: 'DENY',
      objects: [{ type: 'connectors', id: connectorId, fields: ['connector_type'] }],
    }]);
    expect(logs()).toContain('CONNECTOR_CLIENT_UNSUPPORTED');
  }, TIMEOUT);
}

it('the worker composes connector.sync beside the two existing runtimes', async () => {
  const source = await readFile(resolve('packages/api/src/processing-worker.ts'), 'utf8');
  for (const call of ['createConnectorSyncRuntime(', 'connectorSync.runOnce()', 'runtime.runOnce()', 'initiative.runOnce()']) {
    expect(source).toContain(call);
  }
  expect(CONNECTOR_SYNC_JOB_KIND).toBe('connector.sync');
});
