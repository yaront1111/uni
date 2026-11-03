import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runMigrations, withOwnerTransaction, type OwnerTransaction } from '@unai/postgres';
import { postgresAdapter } from '@unai/auth';
import { connectorTypeSchema } from '@unai/domain';
import {
  createConnector, createConnectorClient, disconnectConnector, markTokenRevoked, recordSyncFailure, setCapabilityGrants,
} from '@unai/connectors';
import { connectorSyncInterval, processingConfiguration } from './processing-config.js';
import {
  MINIMUM_INTERVAL_BY_TYPE, connectorSyncSchedulerPorts, createConnectorSyncScheduler, type ScheduledConnector,
} from './connector-sync-scheduler.js';

/**
 * The connector-sync scheduler over real PostgreSQL: its interval configuration,
 * the eligibility and window rules of one tick, the per-type minimum, the one
 * owner scope per process, and the worker composition (`--once`, the loop tick).
 */

if (!process.env.UNAI_TEST_DATABASE_URL) throw new Error('Run pnpm test for the required PostgreSQL harness');
const admin = new Pool({ connectionString: process.env.UNAI_TEST_DATABASE_URL });
const appUrl = new URL(process.env.UNAI_TEST_DATABASE_URL);
appUrl.username = 'connector_sync_scheduler_test_app'; appUrl.password = 'test-only';
const appPool = new Pool({ connectionString: appUrl.href });

beforeAll(async () => {
  await runMigrations(admin, resolve('migrations'));
  await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='connector_sync_scheduler_test_app') THEN CREATE ROLE connector_sync_scheduler_test_app LOGIN PASSWORD 'test-only'; END IF; END $$; GRANT unai_app TO connector_sync_scheduler_test_app");
});
afterAll(async () => { await appPool.end(); await admin.end(); });
afterEach(() => { vi.restoreAllMocks(); });

const env = (vars: Record<string, string>): NodeJS.ProcessEnv => ({ NODE_ENV: 'test', ...vars });
const INVALID = 'CONFIG_INVALID:UNAI_CONNECTOR_SYNC_INTERVAL_MS';

it.each<[string, number, string | undefined]>([
  ['unset', 900000, undefined], ['empty', 900000, ''], ['0', 0, '0'], ['000', 0, '000'],
  ['60000', 60000, '60000'], ['86400000', 86400000, '86400000'],
])('an interval that is %s gives %i', (_name, expected, value) => {
  expect(connectorSyncInterval(env(value === undefined ? {} : { UNAI_CONNECTOR_SYNC_INTERVAL_MS: value }))).toBe(expected);
});

it.each(['1000', '59999', '86400001', '-1', 'abc', '1e5', ' 60000', '60000 ', '60000.5', '123456789', '0x1000'])(
  'the interval %j is refused with the named code', value => {
    expect(() => connectorSyncInterval(env({ UNAI_CONNECTOR_SYNC_INTERVAL_MS: value }))).toThrow(new Error(INVALID));
  });

it('the interval is validated before any other processing variable', () => {
  expect(() => processingConfiguration(env({ UNAI_CONNECTOR_SYNC_INTERVAL_MS: '1000' }))).toThrow(new Error(INVALID));
  expect(() => processingConfiguration(env({}))).toThrow(new Error('PROCESSING_CONFIGURATION_REQUIRED:UNAI_REGISTRY_RELEASE_ID'));
});

it('a complete configuration carries the interval: 900000 by default, 0 when disabled', () => {
  const scope = {
    UNAI_REGISTRY_RELEASE_ID: randomUUID(), UNAI_REGISTRY_RELEASE: '0.1.0',
    UNAI_PROCESSING_OWNER_SCOPE_ID: randomUUID(), UNAI_PROCESSING_ACTOR_ID: randomUUID(),
    UNAI_PROCESSING_DATA_PURPOSE: 'MEMORY_EXTRACTION', UNAI_PROCESSING_MAXIMUM_SENSITIVITY: 'NORMAL',
  };
  expect(processingConfiguration(env(scope)).connectorSyncIntervalMs).toBe(900000);
  expect(processingConfiguration(env({ ...scope, UNAI_CONNECTOR_SYNC_INTERVAL_MS: '0' })).connectorSyncIntervalMs).toBe(0);
});

const TIMEOUT = 60000;
const WINDOW = 900000;
// A quarter-hour boundary plus 5 s, so "60 s later" stays inside the window.
const BASE = Math.floor(Date.UTC(2026, 10, 3) / WINDOW) * WINDOW + 5000;

async function owner() {
  const user = await postgresAdapter(admin).createUser!({
    name: 'Connector sync scheduler test', email: 'sync-scheduler-' + randomUUID() + '@example.test', emailVerified: null });
  const ownerScopeId = (user as unknown as { ownerScopeId: string }).ownerScopeId;
  const as = <T,>(purpose: string, run: (tx: OwnerTransaction) => Promise<T>) =>
    withOwnerTransaction(appPool, { ownerScopeId, actorId: user.id, purpose, correlationId: randomUUID() }, run);
  const connect = async (connectorType: string, externalAccountRef: string, granted: readonly string[],
    secretRef: string | null = 'secret://mounted/' + connectorType.toLowerCase() + '#token') =>
    as('connector.manage', async tx => (await createConnector(tx, {
      connectorType: connectorType as ScheduledConnector['connectorType'], externalAccountRef, secretRef,
      requestedCapabilities: granted.map(capabilityId => ({ capabilityId, granted: true })),
    })).connectorId);
  const scheduler = (clock: () => number, intervalMs = WINDOW, minimumIntervalByType?: Readonly<Record<string, number>>) =>
    createConnectorSyncScheduler({ clock, intervalMs, ...(minimumIntervalByType ? { minimumIntervalByType } : {}),
      ...connectorSyncSchedulerPorts({ appPool, ownerScopeId, actorId: user.id }) });
  return { ownerScopeId, actorId: user.id, as, connect, scheduler };
}

type SyncRow = { connectorId: string; mode: string; maxPages: number; window: string; status: string };
async function syncRows(ownerScopeId: string): Promise<SyncRow[]> {
  return (await admin.query(`SELECT payload,status FROM jobs WHERE owner_scope_id=$1 AND job_kind='connector.sync'
    ORDER BY created_at,id`, [ownerScopeId])).rows.map(row => ({ ...row.payload, status: row.status }));
}
/** The scheduler's own log lines, as printed. */
function schedulerLines() {
  const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
  return () => info.mock.calls.map(call => String(call[0])).filter(line => {
    try { return (JSON.parse(line) as { event?: unknown }).event === 'connector.scheduler'; } catch { return false; }
  });
}
/** In-memory ports that count their calls. */
function fakePorts(connectors: readonly ScheduledConnector[] = []) {
  const calls = { list: 0, enqueue: [] as { connectorId: string; window: string }[][] };
  return {
    calls,
    listConnectors: async () => { calls.list++; return connectors; },
    enqueue: async (due: readonly { connectorId: string; window: string }[]) => { calls.enqueue.push([...due]); },
  };
}

it('enqueues one INCREMENTAL job per ACTIVE or SYNC_FAILED, granted, polled connector per window', async () => {
  const o = await owner();
  const active = await o.connect('GMAIL', 'active@example.test', ['gmail.read_metadata']);
  const failed = await o.connect('GITHUB', 'owner/failed', ['github.read_issues']);
  await o.as('connector.sync', tx => recordSyncFailure(tx, failed, 'CONNECTOR_PROVIDER_UNAVAILABLE'));
  const revoked = await o.connect('GOOGLE_CALENDAR', 'revoked@example.test', ['calendar.read']);
  await o.as('connector.manage', tx => markTokenRevoked(tx, revoked));
  const disconnected = await o.connect('GMAIL', 'disconnected@example.test', ['gmail.read_metadata']);
  await o.as('connector.manage', tx => disconnectConnector(tx, disconnected, async () => ({ revoked: true })));
  const document = await o.connect('DOCUMENT', 'uploads', ['documents.upload'], null);
  const pending = await o.connect('GITHUB', 'owner/pending', []);
  const ungranted = await o.connect('GMAIL', 'ungranted@example.test', ['gmail.read_metadata']);
  await o.as('connector.sync', tx => recordSyncFailure(tx, ungranted, 'CONNECTOR_PROVIDER_UNAVAILABLE'));
  await o.as('connector.manage', tx => setCapabilityGrants(tx, ungranted, [{ capabilityId: 'gmail.read_metadata', granted: false }]));
  const statuses = (await admin.query('SELECT id,status FROM connectors WHERE owner_scope_id=$1', [o.ownerScopeId])).rows;
  expect(Object.fromEntries(statuses.map(row => [row.id, row.status]))).toEqual({
    [active]: 'ACTIVE', [failed]: 'SYNC_FAILED', [revoked]: 'TOKEN_REVOKED', [disconnected]: 'DISCONNECTED',
    [document]: 'ACTIVE', [pending]: 'PENDING_AUTHORIZATION', [ungranted]: 'SYNC_FAILED' });
  const lines = schedulerLines();
  let now = BASE;
  const scheduler = o.scheduler(() => now);
  const window = String(Math.floor(BASE / WINDOW));
  const expected = (w: string) => [active, failed].map(connectorId =>
    ({ connectorId, mode: 'INCREMENTAL', maxPages: 1, window: w, status: 'PENDING' }));

  expect(await scheduler.tick()).toEqual({ enqueued: 2, alreadyQueued: 0, skipped: 5 });
  expect(await syncRows(o.ownerScopeId)).toEqual(expect.arrayContaining(expected(window)));
  expect(await syncRows(o.ownerScopeId)).toHaveLength(2);
  now += 60000;
  expect(await scheduler.tick()).toEqual({ enqueued: 0, alreadyQueued: 2, skipped: 5 });
  expect(await syncRows(o.ownerScopeId)).toHaveLength(2);
  // A fresh process in the same window re-submits; the idempotency key keeps one row.
  expect(await o.scheduler(() => now).tick()).toEqual({ enqueued: 2, alreadyQueued: 0, skipped: 5 });
  expect(await syncRows(o.ownerScopeId)).toHaveLength(2);
  now += WINDOW;
  expect(await scheduler.tick()).toEqual({ enqueued: 2, alreadyQueued: 0, skipped: 5 });
  const rows = await syncRows(o.ownerScopeId);
  expect(rows).toHaveLength(4);
  expect(rows).toEqual(expect.arrayContaining([...expected(window), ...expected(String(Number(window) + 1))]));

  const printed = lines();
  expect(printed).toHaveLength(4);
  for (const line of printed) expect(Object.keys(JSON.parse(line) as object)).toEqual(['event', 'enqueued', 'alreadyQueued', 'skipped']);
  const text = printed.join('\n');
  for (const secret of [active, failed, revoked, disconnected, document, pending, ungranted, o.ownerScopeId,
    'active@example.test', 'owner/failed', 'revoked@example.test', 'GMAIL', 'GITHUB']) expect(text).not.toContain(secret);
}, TIMEOUT);

it('a per-type minimum larger than the global interval stretches that connector\'s window', async () => {
  const o = await owner();
  const gmail = await o.connect('GMAIL', 'stretch@example.test', ['gmail.read_metadata']);
  const github = await o.connect('GITHUB', 'owner/stretch', ['github.read_issues']);
  const t0 = (Math.floor(BASE / 300000) + 1) * 300000;
  let now = t0;
  const scheduler = o.scheduler(() => now, 60000, { GMAIL: 300000, GITHUB: 60000 });
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  expect(await scheduler.tick()).toEqual({ enqueued: 2, alreadyQueued: 0, skipped: 0 });
  now = t0 + 60000;
  expect(await scheduler.tick()).toEqual({ enqueued: 1, alreadyQueued: 1, skipped: 0 });
  now = t0 + 300000;
  expect(await scheduler.tick()).toEqual({ enqueued: 2, alreadyQueued: 0, skipped: 0 });
  const rows = await syncRows(o.ownerScopeId);
  const windows = (id: string) => rows.filter(row => row.connectorId === id).map(row => Number(row.window));
  const k = t0 / 300000;
  expect(windows(github)).toEqual([5 * k, 5 * k + 1, 5 * k + 5]);
  expect(windows(gmail)).toEqual([k, k + 1]);
}, TIMEOUT);

it("lists only the worker's own owner scope", async () => {
  const a = await owner();
  const b = await owner();
  const mine = await a.connect('GMAIL', 'mine@example.test', ['gmail.read_metadata']);
  const theirs = await b.connect('GMAIL', 'theirs@example.test', ['gmail.read_metadata']);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  expect(await a.scheduler(() => BASE).tick()).toEqual({ enqueued: 1, alreadyQueued: 0, skipped: 0 });
  expect((await syncRows(a.ownerScopeId)).map(row => row.connectorId)).toEqual([mine]);
  expect(await syncRows(b.ownerScopeId)).toEqual([]);
  expect((await admin.query("SELECT count(*)::int AS n FROM jobs WHERE payload->>'connectorId'=$1", [theirs])).rows[0].n).toBe(0);
}, TIMEOUT);

it('an interval of 0 logs CONNECTOR_SCHEDULER_DISABLED once and never calls a port', async () => {
  const lines = schedulerLines();
  const ports = fakePorts([{ connectorId: randomUUID(), connectorType: 'GMAIL', status: 'ACTIVE', grantedCapabilities: ['gmail.read_metadata'] }]);
  const scheduler = createConnectorSyncScheduler({ clock: () => BASE, intervalMs: 0, ...ports });
  expect(await scheduler.tick()).toBeNull();
  expect(await scheduler.tickIfDue()).toBeNull();
  expect(await scheduler.tick()).toBeNull();
  expect(ports.calls).toEqual({ list: 0, enqueue: [] });
  expect(lines()).toEqual([JSON.stringify({ event: 'connector.scheduler', status: 'CONNECTOR_SCHEDULER_DISABLED' })]);
});

it('tickIfDue lists once per window boundary, and a failed pass waits for the next boundary', async () => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  let now = BASE;
  let failing = false;
  const ports = fakePorts();
  const listConnectors = async () => { if (failing) { ports.calls.list++; throw new Error('PORT_FAILED'); } return ports.listConnectors(); };
  const scheduler = createConnectorSyncScheduler({ clock: () => now, intervalMs: WINDOW, listConnectors, enqueue: ports.enqueue });
  expect(await scheduler.tickIfDue()).toEqual({ enqueued: 0, alreadyQueued: 0, skipped: 0 });
  now += 1000;
  expect(await scheduler.tickIfDue()).toBeNull();
  expect(ports.calls.list).toBe(1);
  now = (Math.floor(BASE / WINDOW) + 1) * WINDOW;
  expect(await scheduler.tickIfDue()).toEqual({ enqueued: 0, alreadyQueued: 0, skipped: 0 });
  expect(ports.calls.list).toBe(2);
  failing = true; now += WINDOW;
  await expect(scheduler.tickIfDue()).rejects.toThrow('PORT_FAILED');
  now += 1000;
  expect(await scheduler.tickIfDue()).toBeNull();
  expect(ports.calls.list).toBe(3);
  failing = false; now += WINDOW;
  expect(await scheduler.tickIfDue()).toEqual({ enqueued: 0, alreadyQueued: 0, skipped: 0 });
  expect(ports.calls.list).toBe(4);
  expect(ports.calls.enqueue).toEqual([]);
});

it('a failed enqueue leaves nothing marked queued, so the next pass re-submits', async () => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  const connectorId = randomUUID();
  const ports = fakePorts([{ connectorId, connectorType: 'GMAIL', status: 'ACTIVE', grantedCapabilities: ['gmail.read_metadata'] }]);
  let failing = true;
  const enqueue = async (due: readonly { connectorId: string; window: string }[]) => {
    await ports.enqueue(due); if (failing) throw new Error('PORT_FAILED');
  };
  const scheduler = createConnectorSyncScheduler({ clock: () => BASE, intervalMs: WINDOW, listConnectors: ports.listConnectors, enqueue });
  await expect(scheduler.tick()).rejects.toThrow('PORT_FAILED');
  failing = false;
  expect(await scheduler.tick()).toEqual({ enqueued: 1, alreadyQueued: 0, skipped: 0 });
  expect(await scheduler.tick()).toEqual({ enqueued: 0, alreadyQueued: 1, skipped: 0 });
  const due = [{ connectorId, window: String(Math.floor(BASE / WINDOW)) }];
  expect(ports.calls.enqueue).toEqual([due, due]);
});

it('the minimum-interval map names exactly the connector types that have a sync client', () => {
  const secrets = { resolve: async () => 'x' } as unknown as Parameters<typeof createConnectorClient>[1];
  const polled = connectorTypeSchema.options.filter(type => {
    try { createConnectorClient(type, secrets, 'secret://mounted/x'); return true; }
    catch (error) { if ((error as Error).message === 'CONNECTOR_CLIENT_UNSUPPORTED') return false; throw error; }
  });
  expect(Object.keys(MINIMUM_INTERVAL_BY_TYPE).sort()).toEqual([...polled].sort());
  expect(Object.values(MINIMUM_INTERVAL_BY_TYPE).every(value => Number.isInteger(value) && value >= 60000)).toBe(true);
});

// The entry has top-level await and its database pool is TLS-only, so the worker is
// not spawned past the database here. The tick tests above prove one pass; these
// source assertions prove where --once and the loop call it.
it('the worker runs one pass under --once and ticks inside the loop turn', () => {
  const source = readFileSync(resolve('packages/api/src/processing-worker.ts'), 'utf8');
  const order = ['createConnectorSyncScheduler(', "process.argv.includes('--check')", "process.argv.includes('--once')",
    'createProbeServer(', 'while ('].map(text => source.indexOf(text));
  expect(order.every(index => index >= 0)).toBe(true);
  expect(order).toEqual([...order].sort((a, b) => a - b));
  expect(source).toMatch(/--once'\)\) \{ await scheduler\.tick\(\); return; \}/);
  expect(source).toMatch(/heartbeat\.beat\(true\)[^]*scheduler\.tickIfDue\(\)[^]*heartbeat\.beat\(false\)/);
  expect(source).toMatch(/await scheduler\.tickIfDue\(\)\.catch\(\(\) => \{ process\.stderr\.write\('CONNECTOR_SCHEDULER_TICK_FAILED\\n'\); \}\);\n\s*heartbeat\.beat\(false\)/);
});
