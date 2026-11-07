import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { runMigrations } from '@unai/postgres';
import { postgresAdapter, SESSION_COOKIE } from '@unai/auth';
import { ConnectorError, connectorCredentialHandle } from '@unai/connectors';
import { createPlatformApi } from './platform.js';

if (!process.env.UNAI_TEST_DATABASE_URL) throw new Error('Run pnpm test for the required PostgreSQL harness');
const admin = new Pool({ connectionString: process.env.UNAI_TEST_DATABASE_URL });
const appUrl = new URL(process.env.UNAI_TEST_DATABASE_URL);
appUrl.username = 'connector_route_test_app'; appUrl.password = 'test-only';
const appPool = new Pool({ connectionString: appUrl.href });

beforeAll(async () => {
  await runMigrations(admin, resolve('migrations'));
  await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='connector_route_test_app') THEN CREATE ROLE connector_route_test_app LOGIN PASSWORD 'test-only'; END IF; END $$; GRANT unai_app TO connector_route_test_app");
});
afterAll(async () => { await appPool.end(); await admin.end(); });

async function harness() {
  const adapter = postgresAdapter(admin);
  const user = await adapter.createUser!({ name: 'Sync route test', email: randomUUID() + '@example.test', emailVerified: null });
  const token = randomBytes(32).toString('base64url');
  await adapter.createSession!({ userId: user.id, sessionToken: token, expires: new Date(Date.now() + 86_400_000) });
  const ownerScopeId = (user as unknown as { ownerScopeId: string }).ownerScopeId;
  const handle = connectorCredentialHandle(ownerScopeId, 'gmail', { field: 'refresh' });
  const built: string[] = [];
  const failure: { value: ConnectorError | null } = { value: null };
  const app = createPlatformApi({ authPool: admin, appPool, connectors: {
    connectorClient: input => {
      built.push(input.connectorType);
      return { async fetchPage() {
        if (failure.value) throw failure.value;
        return { payloads: [], nextCursor: null };
      } };
    },
  } });
  app.addHook('onRequest', async request => {
    Object.defineProperty(request.raw.socket, 'encrypted', { value: true, configurable: true });
  });
  function headers(purpose: string) {
    return {
      cookie: SESSION_COOKIE + '=' + token, 'x-owner-scope-id': ownerScopeId, 'x-purpose': purpose,
      'x-correlation-id': randomUUID(), 'idempotency-key': randomUUID(),
      'x-data-purpose': 'PERSONAL_ASSISTANCE', 'x-maximum-sensitivity': 'RESTRICTED',
    };
  }
  const connected = await app.inject({ method: 'POST', url: '/v1/connectors', headers: headers('connector.manage'),
    payload: { connectorType: 'GMAIL', externalAccountRef: 'owner@example.test', secretRef: handle,
      requestedCapabilities: [{ capabilityId: 'gmail.read_metadata', granted: true }] } });
  expect(connected.statusCode).toBe(201);
  const connectorId = connected.json<{ connectorId: string }>().connectorId;
  return { app, connectorId, built, failure, headers, handle };
}
type Harness = Awaited<ReturnType<typeof harness>>;

async function sync(h: Harness, mode: 'INCREMENTAL' | 'BACKFILL' = 'INCREMENTAL') {
  const headers = h.headers('connector.sync');
  const response = await h.app.inject({ method: 'POST', url: '/v1/connectors/' + h.connectorId + '/sync', headers,
    payload: { mode, allowedPurposes: ['PERSONAL_ASSISTANCE'] } });
  return { response, correlationId: headers['x-correlation-id'] };
}
async function state(connectorId: string) {
  const result = await admin.query<{ status: string; secret_ref: string | null; last_sync_error: string | null }>(
    'SELECT status,secret_ref,last_sync_error FROM connectors WHERE id=$1', [connectorId]);
  return result.rows[0];
}
async function audits(correlationId: string) {
  return (await admin.query<{ purpose: string; policy_decision: string; result: string }>(
    'SELECT purpose,policy_decision,result FROM audit_events WHERE correlation_id=$1 ORDER BY purpose',
    [correlationId])).rows;
}
const refused = { purpose: 'connector.sync', policy_decision: 'DENY', result: 'REFUSED' };

it('revokes a provider 401 under connector.manage and stops the next sync before building a client', async () => {
  const h = await harness();
  try {
    h.failure.value = new ConnectorError('CONNECTOR_TOKEN_REVOKED', { status: 401 });
    const first = await sync(h);
    expect(first.response.statusCode).toBe(409);
    expect(first.response.json()).toEqual({ code: 'CONNECTOR_TOKEN_REVOKED', correlationId: first.correlationId, status: 401 });
    expect(await state(h.connectorId)).toEqual({ status: 'TOKEN_REVOKED', secret_ref: null,
      last_sync_error: 'CONNECTOR_TOKEN_REVOKED' });
    expect(await audits(first.correlationId)).toEqual([
      { purpose: 'connector.manage', policy_decision: 'ALLOW', result: 'SUCCESS' }, refused,
    ]);
    expect(h.built).toEqual(['GMAIL']);
    h.failure.value = null;
    const stopped = await sync(h);
    expect(stopped.response.statusCode).toBe(409);
    expect(stopped.response.json()).toEqual({ code: 'CONNECTOR_INGESTION_STOPPED', correlationId: stopped.correlationId,
      connectorId: h.connectorId, status: 'TOKEN_REVOKED' });
    expect(h.built).toEqual(['GMAIL']);
  } finally { await h.app.close(); }
});

it('keeps a provider 403 retryable without changing the credential handle', async () => {
  const h = await harness();
  try {
    h.failure.value = new ConnectorError('CONNECTOR_TOKEN_REVOKED', { status: 403 });
    const first = await sync(h);
    expect(first.response.statusCode).toBe(409);
    expect(first.response.json()).toEqual({ code: 'CONNECTOR_TOKEN_REVOKED', correlationId: first.correlationId, status: 403 });
    expect(await state(h.connectorId)).toEqual({ status: 'SYNC_FAILED', secret_ref: h.handle,
      last_sync_error: 'CONNECTOR_TOKEN_REVOKED' });
    expect(await audits(first.correlationId)).toEqual([refused]);
    h.failure.value = null;
    expect((await sync(h)).response.statusCode).toBe(200);
    expect(await state(h.connectorId)).toEqual({ status: 'ACTIVE', secret_ref: h.handle, last_sync_error: null });
    expect(h.built).toEqual(['GMAIL', 'GMAIL']);
  } finally { await h.app.close(); }
});

it('records an invalid stored cursor as a conflict and admits BACKFILL recovery', async () => {
  const h = await harness();
  try {
    h.failure.value = new ConnectorError('CONNECTOR_CURSOR_INVALID');
    const first = await sync(h);
    expect(first.response.statusCode).toBe(409);
    expect(first.response.json()).toEqual({ code: 'CONNECTOR_CURSOR_INVALID', correlationId: first.correlationId });
    expect(await state(h.connectorId)).toEqual({ status: 'SYNC_FAILED', secret_ref: h.handle,
      last_sync_error: 'CONNECTOR_CURSOR_INVALID' });
    expect(await audits(first.correlationId)).toEqual([refused]);
    h.failure.value = null;
    const recovered = await sync(h, 'BACKFILL');
    expect(recovered.response.statusCode).toBe(200);
    expect(recovered.response.json<{ resumedFromCursor: unknown }>().resumedFromCursor).toBe(null);
    expect(await state(h.connectorId)).toEqual({ status: 'ACTIVE', secret_ref: h.handle, last_sync_error: null });
  } finally { await h.app.close(); }
});

it.each(['PENDING_AUTHORIZATION', 'TOKEN_REVOKED', 'DISCONNECTED'])(
  'does not build a client for a %s connector', async status => {
    const h = await harness();
    try {
      await admin.query(`UPDATE connectors SET status=$2,secret_ref=NULL,
        disconnected_at=CASE WHEN $2='DISCONNECTED' THEN now() ELSE NULL END WHERE id=$1`, [h.connectorId, status]);
      const stopped = await sync(h);
      expect(stopped.response.statusCode).toBe(409);
      expect(stopped.response.json()).toEqual({ code: 'CONNECTOR_INGESTION_STOPPED', correlationId: stopped.correlationId,
        connectorId: h.connectorId, status });
      expect(h.built).toEqual([]);
      expect(await state(h.connectorId)).toEqual({ status, secret_ref: null, last_sync_error: null });
    } finally { await h.app.close(); }
  },
);
