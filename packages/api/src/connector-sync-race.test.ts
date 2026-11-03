/** Real PostgreSQL lifecycle races; ADR 0041 D8 / CRT-CON-06-A. */
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runMigrations, withOwnerTransaction } from '@unai/postgres';
import { postgresAdapter, SESSION_COOKIE } from '@unai/auth';
import { ConnectorError, markTokenRevoked, type ConnectorPage } from '@unai/connectors';
import { createPlatformApi } from './platform.js';
import type { EvidenceObjects } from './evidence.js';

if (!process.env.UNAI_TEST_DATABASE_URL) throw new Error('Run pnpm test for the required PostgreSQL harness');
const admin = new Pool({ connectionString: process.env.UNAI_TEST_DATABASE_URL });
const appUrl = new URL(process.env.UNAI_TEST_DATABASE_URL);
appUrl.username = 'connector_race_test_app'; appUrl.password = 'test-only';
const appPool = new Pool({ connectionString: appUrl.href });
const C0 = { position: 'race:c0', providerToken: null };
const C1 = { position: 'race:c1', providerToken: null };
const fixture: unknown = JSON.parse(await readFile(resolve('fixtures/sources/omi-conversation.json'), 'utf8'));
const emptyPage: ConnectorPage = { payloads: [], nextCursor: C1 };
const contentPage: ConnectorPage = { payloads: [fixture], nextCursor: C1 };

beforeAll(async () => {
  await runMigrations(admin, resolve('migrations'));
  await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='connector_race_test_app') THEN CREATE ROLE connector_race_test_app LOGIN PASSWORD 'test-only'; END IF; END $$; GRANT unai_app TO connector_race_test_app");
});
afterAll(async () => { await appPool.end(); await admin.end(); });

function pausedClient() {
  let gate: { enter: () => void; page: Promise<ConnectorPage>; release: (page: ConnectorPage) => void } | null = null;
  return {
    pause() {
      let enter!: () => void, release!: (page: ConnectorPage) => void;
      const entered = new Promise<void>(resolve => { enter = resolve; });
      const page = new Promise<ConnectorPage>(resolve => { release = resolve; });
      gate = { enter, page, release };
      return { entered, release };
    },
    async fetchPage(): Promise<ConnectorPage> {
      if (!gate) return { payloads: [], nextCursor: C0 };
      gate.enter();
      return gate.page;
    },
    release() { gate?.release(emptyPage); },
  };
}

function objectsDouble(): EvidenceObjects {
  const objects = new Map<string, Uint8Array>();
  return {
    encryptionKeyRef: 'kms:test-double',
    async put(_tx, id, bytes) { objects.set(id, bytes); },
    async get(_tx, id) {
      const bytes = objects.get(id);
      if (!bytes) throw new Error('TEST_OBJECT_MISSING');
      return bytes;
    },
  };
}

async function identity() {
  const adapter = postgresAdapter(admin);
  const user = await adapter.createUser!({ name: 'Sync race test', email: randomUUID() + '@example.test', emailVerified: null });
  const tokens = [randomBytes(32).toString('base64url'), randomBytes(32).toString('base64url')];
  for (const sessionToken of tokens) {
    await adapter.createSession!({ userId: user.id, sessionToken, expires: new Date(Date.now() + 86_400_000) });
  }
  const ownerScopeId = (user as unknown as { ownerScopeId: string }).ownerScopeId;
  return { user, ownerScopeId, headers(purpose: string, session = 0) {
    return {
      cookie: SESSION_COOKIE + '=' + tokens[session], 'x-owner-scope-id': ownerScopeId, 'x-purpose': purpose,
      'x-correlation-id': randomUUID(), 'idempotency-key': randomUUID(),
      'x-data-purpose': 'PERSONAL_ASSISTANCE', 'x-maximum-sensitivity': 'RESTRICTED',
    };
  } };
}

async function harness() {
  const who = await identity(), client = pausedClient();
  const app = createPlatformApi({ authPool: admin, appPool, evidenceObjects: objectsDouble(), connectors: {
    connectorClient: () => client, revokeTokens: async () => ({ revoked: true }),
  } });
  app.addHook('onRequest', async request => {
    Object.defineProperty(request.raw.socket, 'encrypted', { value: true, configurable: true });
  });
  try {
    const connected = await app.inject({ method: 'POST', url: '/v1/connectors', headers: who.headers('connector.manage'),
      payload: { connectorType: 'OMI', externalAccountRef: 'owner@example.test', secretRef: 'secret://test/omi-key',
        requestedCapabilities: [{ capabilityId: 'omi.read_conversations', granted: true }] } });
    expect(connected.statusCode).toBe(201);
    const connectorId = connected.json<{ connectorId: string }>().connectorId;
    const h = { ...who, app, client, connectorId,
      async close() { client.release(); await app.close(); } };
    expect((await sync(h)).response.statusCode).toBe(200);
    expect(await state(connectorId)).toMatchObject({ status: 'ACTIVE', last_cursor: C0 });
    return h;
  } catch (error) { await app.close(); throw error; }
}
type Harness = Awaited<ReturnType<typeof harness>>;

async function sync(h: Pick<Harness, 'app' | 'headers' | 'connectorId'>) {
  const headers = h.headers('connector.sync');
  const response = await h.app.inject({ method: 'POST', url: '/v1/connectors/' + h.connectorId + '/sync', headers,
    payload: { mode: 'INCREMENTAL', allowedPurposes: ['PERSONAL_ASSISTANCE'] } });
  return { response, correlationId: headers['x-correlation-id'] };
}
async function disconnect(h: Harness) {
  // A sync locks session A; lifecycle traffic MUST use session B.
  const result = await h.app.inject({ method: 'POST', url: '/v1/connectors/' + h.connectorId + '/disconnect',
    headers: h.headers('connector.manage', 1), payload: {} });
  expect(result.statusCode).toBe(200);
}
async function revoke(h: Harness) {
  return withOwnerTransaction(appPool, { ownerScopeId: h.ownerScopeId, actorId: h.user.id,
    purpose: 'connector.manage', correlationId: randomUUID() }, async tx => {
    await markTokenRevoked(tx, h.connectorId);
    await tx.audit({ policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS', objects: [] });
  });
}
async function state(connectorId: string) {
  return (await admin.query('SELECT status,secret_ref,last_cursor,last_sync_error FROM connectors WHERE id=$1',
    [connectorId])).rows[0] as unknown;
}
async function evidenceCount(h: Harness) {
  return (await admin.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM source_items WHERE owner_scope_id=$1 AND connector_id=$2',
    [h.ownerScopeId, h.connectorId])).rows[0]?.n;
}
const disconnected = { status: 'DISCONNECTED', secret_ref: null, last_cursor: null, last_sync_error: null };
function stopped(h: Harness, result: Awaited<ReturnType<typeof sync>>, status?: string) {
  expect(result.response.statusCode).toBe(409);
  expect(result.response.json()).toEqual({ code: 'CONNECTOR_INGESTION_STOPPED', correlationId: result.correlationId,
    connectorId: h.connectorId, ...(status === undefined ? {} : { status }) });
}

async function waitBlockedBy(pid: number) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))', [pid]);
    if ((result.rows[0]?.n ?? 0) > 0) return;
    await delay(20);
  }
  throw new Error('EXPECTED_CONNECTOR_LOCK_WAIT');
}
async function holdingDisconnect(h: Harness, run: (pid: number, commit: () => Promise<void>) => Promise<void>) {
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    await client.query(`UPDATE connectors SET status='DISCONNECTED',disconnected_at=now(),secret_ref=NULL,
      last_cursor=NULL,last_sync_error=NULL WHERE id=$1`, [h.connectorId]);
    await run(pid, async () => { await client.query('COMMIT'); });
  } finally { try { await client.query('ROLLBACK'); } finally { client.release(); } }
}

it('preserves a committed token revocation when an empty paused sync resumes', async () => {
  const h = await harness();
  try {
    const gate = h.client.pause(), pending = sync(h);
    await gate.entered;
    await revoke(h);
    gate.release(emptyPage);
    stopped(h, await pending, 'TOKEN_REVOKED');
    expect(await state(h.connectorId)).toEqual({ status: 'TOKEN_REVOKED', secret_ref: null,
      last_cursor: C0, last_sync_error: 'CONNECTOR_TOKEN_REVOKED' });
  } finally { await h.close(); }
}, 30_000);

it('preserves the cleared cursor after a committed disconnect', async () => {
  const h = await harness();
  try {
    const gate = h.client.pause(), pending = sync(h);
    await gate.entered;
    await disconnect(h);
    gate.release(emptyPage);
    stopped(h, await pending, 'DISCONNECTED');
    expect(await state(h.connectorId)).toEqual(disconnected);
  } finally { await h.close(); }
}, 30_000);

it('names a disconnect committed before the importer inserts', async () => {
  const h = await harness();
  try {
    const gate = h.client.pause(), pending = sync(h);
    await gate.entered;
    await disconnect(h);
    gate.release(contentPage);
    stopped(h, await pending);
    expect(await evidenceCount(h)).toBe(0);
    expect(await state(h.connectorId)).toEqual(disconnected);
  } finally { await h.close(); }
}, 30_000);

it('waits for an in-progress disconnect before deciding whether evidence may commit', async () => {
  const h = await harness();
  try {
    const gate = h.client.pause(), pending = sync(h);
    await gate.entered;
    await holdingDisconnect(h, async (pid, commit) => {
      gate.release(contentPage);
      await waitBlockedBy(pid);
      await commit();
    });
    stopped(h, await pending, 'DISCONNECTED');
    expect(await evidenceCount(h)).toBe(0);
    expect(await state(h.connectorId)).toEqual(disconnected);
  } finally { await h.close(); }
}, 30_000);

it('commits a healthy paused run without a false refusal', async () => {
  const h = await harness();
  try {
    const gate = h.client.pause(), pending = sync(h);
    await gate.entered;
    gate.release(contentPage);
    const { response } = await pending;
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ newCursor: C1, itemsIngested: 2 });
    expect(await evidenceCount(h)).toBe(2);
    expect(await state(h.connectorId)).toMatchObject({ status: 'ACTIVE', last_cursor: C1, last_sync_error: null });
  } finally { await h.close(); }
}, 30_000);

it('never revives a disconnect that commits while token revocation waits', async () => {
  const h = await harness();
  try {
    await holdingDisconnect(h, async (pid, commit) => {
      // Attach a rejection handler immediately, before releasing the blocking transaction.
      const pending = revoke(h).then(() => null, (error: unknown) => error);
      await waitBlockedBy(pid);
      await commit();
      const error = await pending;
      expect(error).toBeInstanceOf(ConnectorError);
      expect(error).toMatchObject({ message: 'CONNECTOR_DISCONNECTED', detail: { connectorId: h.connectorId } });
    });
    expect(await state(h.connectorId)).toEqual(disconnected);
  } finally { await h.close(); }
}, 30_000);
