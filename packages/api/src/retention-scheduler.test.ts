import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runMigrations, withOwnerTransaction, type OwnerTransaction } from '@unai/postgres';
import { postgresAdapter } from '@unai/auth';
import { PROJECTION_NAMES } from '@unai/domain';
import { updateRetention } from '@unai/control';
import { ingestOwnerStatement, type EvidenceObjects } from './evidence.js';
import { processingConfiguration, retentionCleanupInterval } from './processing-config.js';
import { createRetentionScheduler, retentionSchedulerPorts, type RetentionTick } from './retention-scheduler.js';

/**
 * The scheduled retention cleanup over real PostgreSQL: its interval configuration,
 * the window rules of one tick, the drain in batches of 50, the one owner scope per
 * process, and the worker composition. The cleanup is the route's own
 * `runRetentionCleanup`, so the cascade here is the one control.test.ts proves.
 */

if (!process.env.UNAI_TEST_DATABASE_URL) throw new Error('Run pnpm test for the required PostgreSQL harness');
const admin = new Pool({ connectionString: process.env.UNAI_TEST_DATABASE_URL });
const appUrl = new URL(process.env.UNAI_TEST_DATABASE_URL);
appUrl.username = 'retention_scheduler_test_app'; appUrl.password = 'test-only';
const appPool = new Pool({ connectionString: appUrl.href });

beforeAll(async () => {
  await runMigrations(admin, resolve('migrations'));
  await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='retention_scheduler_test_app') THEN CREATE ROLE retention_scheduler_test_app LOGIN PASSWORD 'test-only'; END IF; END $$; GRANT unai_app TO retention_scheduler_test_app");
});
afterAll(async () => { await appPool.end(); await admin.end(); });
afterEach(() => { vi.restoreAllMocks(); });

const env = (vars: Record<string, string>): NodeJS.ProcessEnv => ({ NODE_ENV: 'test', ...vars });
const INVALID = 'CONFIG_INVALID:UNAI_RETENTION_CLEANUP_INTERVAL_MS';

it.each<[string, number, string | undefined]>([
  ['unset', 86400000, undefined], ['empty', 86400000, ''], ['0', 0, '0'], ['000', 0, '000'],
  ['3600000', 3600000, '3600000'], ['86400000', 86400000, '86400000'],
])('a retention interval that is %s gives %i', (_name, expected, value) => {
  expect(retentionCleanupInterval(env(value === undefined ? {} : { UNAI_RETENTION_CLEANUP_INTERVAL_MS: value }))).toBe(expected);
});

it.each(['1000', '3599999', '86400001', '-1', 'abc', '1e6', ' 3600000', '3600000 ', '3600000.5', '0x1000', '123456789'])(
  'the retention interval %j is refused with the named code', value => {
    expect(() => retentionCleanupInterval(env({ UNAI_RETENTION_CLEANUP_INTERVAL_MS: value }))).toThrow(new Error(INVALID));
  });

it('the retention interval is validated before the registry release', () => {
  expect(() => processingConfiguration(env({ UNAI_RETENTION_CLEANUP_INTERVAL_MS: '1000' }))).toThrow(new Error(INVALID));
  expect(() => processingConfiguration(env({}))).toThrow(new Error('PROCESSING_CONFIGURATION_REQUIRED:UNAI_REGISTRY_RELEASE_ID'));
});

it('a complete configuration carries the retention interval: 86400000 by default, 0 when disabled', () => {
  const scope = {
    UNAI_REGISTRY_RELEASE_ID: randomUUID(), UNAI_REGISTRY_RELEASE: '0.1.0',
    UNAI_PROCESSING_OWNER_SCOPE_ID: randomUUID(), UNAI_PROCESSING_ACTOR_ID: randomUUID(),
    UNAI_PROCESSING_DATA_PURPOSE: 'MEMORY_EXTRACTION', UNAI_PROCESSING_MAXIMUM_SENSITIVITY: 'NORMAL',
  };
  expect(processingConfiguration(env(scope)).retentionCleanupIntervalMs).toBe(86400000);
  expect(processingConfiguration(env({ ...scope, UNAI_RETENTION_CLEANUP_INTERVAL_MS: '0' })).retentionCleanupIntervalMs).toBe(0);
});

const TIMEOUT = 60000;
const DAY = 86_400_000;
const ZERO: RetentionTick = { passes: 0, evidenceErased: 0, conversationsDeleted: 0, derivedEvidenceItems: 0,
  derivedEmbeddings: 0, derivedSummaries: 0, projectionsRebuilt: 0 };
// A day boundary plus 5 s, so "60 s later" stays inside the window.
const BASE = Math.floor(Date.UTC(2026, 10, 3) / DAY) * DAY + 5000;
// At least two days after anything this file ingests: past a one-day raw retention.
const LATER = (Math.floor(Date.now() / DAY) + 3) * DAY + 5000;

/** The in-memory store control.test.ts runs the cascade with, keyed by raw object ref. */
const stored = new Map<string, Uint8Array>();
const evidenceObjects: EvidenceObjects = {
  encryptionKeyRef: 'kms:test-double',
  async put(_tx, id, bytes) { stored.set(id, bytes); },
  async get(_tx, id) { const bytes = stored.get(id); if (!bytes) throw new Error('OBJECT_NOT_FOUND'); return bytes; },
  async delete(_tx, id) { stored.delete(id); },
};

async function owner() {
  const user = await postgresAdapter(admin).createUser!({
    name: 'Retention scheduler test', email: 'retention-scheduler-' + randomUUID() + '@example.test', emailVerified: null });
  const ownerScopeId = (user as unknown as { ownerScopeId: string }).ownerScopeId;
  const as = <T,>(purpose: string, run: (tx: OwnerTransaction) => Promise<T>) =>
    withOwnerTransaction(appPool, { ownerScopeId, actorId: user.id, purpose, correlationId: randomUUID() }, run);
  /** Owner statements: CONVERSATION evidence, observed now, through the product ingest. */
  const say = async (count: number) => {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      ids.push((await as('evidence.ingest', async tx => {
        await tx.query("SELECT set_config('unai.data_purpose','PERSONAL_ASSISTANCE',true),set_config('unai.maximum_sensitivity','PRIVATE',true)");
        return ingestOwnerStatement(tx, evidenceObjects, { externalId: randomUUID(), idempotencyKey: randomUUID(),
          text: 'Retention fixture statement ' + i, sensitivity: 'PRIVATE', allowedPurposes: ['PERSONAL_ASSISTANCE'] });
      })).evidenceId);
    }
    return ids;
  };
  /** The route test's rule, saved through the settings function: one day of raw retention. */
  const retain = () => as('permissions.manage', tx => updateRetention(tx, {
    rules: [{ sourceType: 'CONVERSATION', rawRetentionDays: 1, derivedRetentionDays: null }] }));
  const scheduler = (clock: () => number, maxPasses?: number) => createRetentionScheduler({ clock, intervalMs: DAY,
    ...retentionSchedulerPorts({ appPool, ownerScopeId, actorId: user.id, evidenceObjects, ...(maxPasses ? { maxPasses } : {}) }) });
  return { ownerScopeId, actorId: user.id, say, retain, scheduler };
}

async function counts(ownerScopeId: string) {
  const count = async (sql: string) => (await admin.query(sql, [ownerScopeId])).rows[0].n as number;
  return {
    live: await count('SELECT count(*)::int AS n FROM source_items WHERE owner_scope_id=$1 AND deleted_at IS NULL'),
    requests: await count('SELECT count(*)::int AS n FROM retention_and_deletion_requests WHERE owner_scope_id=$1'),
    audits: await count('SELECT count(*)::int AS n FROM audit_events WHERE owner_scope_id=$1'),
  };
}
async function rawRefs(ids: readonly string[]): Promise<string[]> {
  return (await admin.query('SELECT raw_object_ref FROM source_items WHERE id=ANY($1::uuid[])', [ids])).rows.map(row => row.raw_object_ref);
}
/** The scheduler's own log lines, as printed. */
function schedulerLines() {
  const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
  return () => info.mock.calls.map(call => String(call[0])).filter(line => {
    try { return (JSON.parse(line) as { event?: unknown }).event === 'retention.scheduler'; } catch { return false; }
  });
}
/** A cleanup port that records the instant of every call. */
function fakeCleanup(result: RetentionTick = { ...ZERO, passes: 1 }) {
  const calls: number[] = [];
  let failing = false;
  return {
    calls, fail(value: boolean) { failing = value; },
    cleanup: async (asOf: Date) => { calls.push(asOf.getTime()); if (failing) throw new Error('PORT_FAILED'); return result; },
  };
}

it('an interval of 0 logs RETENTION_SCHEDULER_DISABLED once and never calls the cleanup', async () => {
  const lines = schedulerLines();
  const port = fakeCleanup();
  const scheduler = createRetentionScheduler({ clock: () => BASE, intervalMs: 0, cleanup: port.cleanup });
  expect(await scheduler.tick()).toBeNull();
  expect(await scheduler.tickIfDue()).toBeNull();
  expect(await scheduler.tick()).toBeNull();
  expect(port.calls).toEqual([]);
  expect(lines()).toEqual([JSON.stringify({ event: 'retention.scheduler', status: 'RETENTION_SCHEDULER_DISABLED' })]);
});

it('tickIfDue cleans once per window, and a failed pass waits for the next boundary', async () => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  const day = Math.floor(BASE / DAY);
  let now = BASE;
  const port = fakeCleanup();
  const scheduler = createRetentionScheduler({ clock: () => now, intervalMs: DAY, cleanup: port.cleanup });
  expect(await scheduler.tickIfDue()).toEqual({ ...ZERO, passes: 1 });
  now += 60_000;
  expect(await scheduler.tickIfDue()).toBeNull();
  now = (day + 1) * DAY;
  expect(await scheduler.tickIfDue()).toEqual({ ...ZERO, passes: 1 });
  port.fail(true); now += DAY;
  await expect(scheduler.tickIfDue()).rejects.toThrow('PORT_FAILED');
  now += 60_000;
  expect(await scheduler.tickIfDue()).toBeNull();
  port.fail(false); now += DAY;
  expect(await scheduler.tickIfDue()).toEqual({ ...ZERO, passes: 1 });
  expect(port.calls).toEqual([BASE, (day + 1) * DAY, (day + 2) * DAY, (day + 3) * DAY + 60_000]);
});

it('tick cleans every time it is called: the --once path', async () => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  const port = fakeCleanup();
  const scheduler = createRetentionScheduler({ clock: () => BASE, intervalMs: DAY, cleanup: port.cleanup });
  await scheduler.tick(); await scheduler.tick();
  expect(port.calls).toEqual([BASE, BASE]);
});

it('a pass logs one line of integer counts and nothing else the port returns', async () => {
  const lines = schedulerLines();
  const tick = { passes: 2, evidenceErased: 51, conversationsDeleted: 3, derivedEvidenceItems: 4, derivedEmbeddings: 5,
    derivedSummaries: 6, projectionsRebuilt: 6 };
  const leaky = { ...tick, evidenceIds: [randomUUID()], text: 'Retention fixture statement' } as RetentionTick;
  const scheduler = createRetentionScheduler({ clock: () => BASE, intervalMs: DAY, cleanup: async () => leaky });
  expect(await scheduler.tick()).toEqual(tick);
  expect(lines()).toEqual([JSON.stringify({ event: 'retention.scheduler', ...tick })]);
});

it('one tick erases expired items through the route cleanup, audited as DELETION and PROJECTION_REBUILD', async () => {
  const a = await owner();
  const ids = await a.say(2);
  await a.retain();
  const refs = await rawRefs(ids);
  expect(refs.filter(ref => stored.has(ref))).toHaveLength(2);
  const lines = schedulerLines();
  expect(await a.scheduler(() => LATER).tickIfDue()).toEqual({ ...ZERO, passes: 1, evidenceErased: 2,
    projectionsRebuilt: PROJECTION_NAMES.length + 1 }); // The three typed projections and decision_projection.
  expect((await admin.query('SELECT count(*)::int AS n FROM source_items WHERE id=ANY($1::uuid[]) AND deleted_at IS NOT NULL',
    [ids])).rows[0].n).toBe(2);
  expect(refs.filter(ref => stored.has(ref))).toEqual([]);
  expect((await admin.query('SELECT request_kind,trigger,requested_by_user_id FROM retention_and_deletion_requests WHERE owner_scope_id=$1',
    [a.ownerScopeId])).rows).toEqual([{ request_kind: 'DELETE', trigger: 'RETENTION_POLICY', requested_by_user_id: a.actorId }]);
  const audits = (await admin.query(`SELECT purpose,event_kind,actor,result,correlation_id FROM audit_events
    WHERE owner_scope_id=$1 AND purpose IN ('data.delete','memory.project')`, [a.ownerScopeId])).rows;
  // The erasure, the projection rebuild and the derived expiry: one pass, one correlation id.
  expect(audits.map(row => row.purpose + ':' + row.event_kind).sort())
    .toEqual(['data.delete:DELETION', 'data.delete:DELETION', 'memory.project:PROJECTION_REBUILD']);
  expect(audits.every(row => row.actor === a.actorId && row.result === 'SUCCESS')).toBe(true);
  expect(new Set(audits.map(row => row.correlation_id)).size).toBe(1);
  const printed = lines();
  expect(printed).toHaveLength(1);
  for (const value of [...ids, ...refs, a.ownerScopeId, a.actorId, 'Retention fixture']) expect(printed[0]).not.toContain(value);
}, TIMEOUT);

it('a second tick in the same window changes nothing', async () => {
  const a = await owner();
  await a.say(1);
  await a.retain();
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  let now = LATER;
  const scheduler = a.scheduler(() => now);
  expect(await scheduler.tickIfDue()).toMatchObject({ passes: 1, evidenceErased: 1 });
  const before = await counts(a.ownerScopeId);
  expect(before).toMatchObject({ live: 0, requests: 1 });
  now += 60_000;
  expect(await scheduler.tickIfDue()).toBeNull();
  expect(await counts(a.ownerScopeId)).toEqual(before);
  // A worker restarted inside the window repeats an idempotent cleanup: nothing is
  // erased or requested again, and only the derived-expiry audit row is added.
  expect(await a.scheduler(() => now).tickIfDue()).toEqual({ ...ZERO, passes: 1 });
  expect(await counts(a.ownerScopeId)).toEqual({ ...before, audits: before.audits + 1 });
}, TIMEOUT);

it('one tick drains full batches of 50 and stops after the first short pass', async () => {
  const b = await owner();
  await b.say(51);
  await b.retain();
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  expect(await b.scheduler(() => LATER).tickIfDue()).toEqual({ ...ZERO, passes: 2, evidenceErased: 51,
    projectionsRebuilt: 2 * (PROJECTION_NAMES.length + 1) });
  expect(await counts(b.ownerScopeId)).toMatchObject({ live: 0, requests: 2 });
}, TIMEOUT);

it('maxPasses bounds the drain, and the next window erases the rest', async () => {
  const c = await owner();
  await c.say(51);
  await c.retain();
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  let now = LATER;
  const scheduler = c.scheduler(() => now, 1);
  expect(await scheduler.tickIfDue()).toEqual({ ...ZERO, passes: 1, evidenceErased: 50, projectionsRebuilt: PROJECTION_NAMES.length + 1 });
  expect(await counts(c.ownerScopeId)).toMatchObject({ live: 1, requests: 1 });
  now += DAY;
  expect(await scheduler.tickIfDue()).toEqual({ ...ZERO, passes: 1, evidenceErased: 1, projectionsRebuilt: PROJECTION_NAMES.length + 1 });
  expect(await counts(c.ownerScopeId)).toMatchObject({ live: 0, requests: 2 });
}, TIMEOUT);

it("cleans only the worker's own owner scope", async () => {
  const a = await owner();
  const other = await owner();
  const mine = await a.say(1);
  const theirs = await other.say(1);
  await a.retain();
  await other.retain();
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  expect(await a.scheduler(() => LATER).tick()).toMatchObject({ passes: 1, evidenceErased: 1 });
  expect(await counts(a.ownerScopeId)).toMatchObject({ live: 0, requests: 1 });
  expect(await counts(other.ownerScopeId)).toMatchObject({ live: 1, requests: 0 });
  expect((await rawRefs(theirs)).filter(ref => stored.has(ref))).toHaveLength(1);
  expect((await rawRefs(mine)).filter(ref => stored.has(ref))).toEqual([]);
}, TIMEOUT);

// The entry has top-level await and a TLS-only pool, so the worker is not spawned
// past the database here: the tick tests above prove a pass, and these source
// assertions prove there is one cascade and where --once and the loop run it. Under
// --once, as in the loop, a failed retention pass never stops the connector pass;
// it is printed and the exit code is 1.
it('the route and the worker share one cleanup, run under --once and before the connector tick', () => {
  const dir = resolve('packages/api/src');
  const sources = readdirSync(dir, { encoding: 'utf8', recursive: true })
    .filter(name => name.endsWith('.ts') && !name.includes('.test.'))
    .map(name => [name, readFileSync(resolve(dir, name), 'utf8')] as const);
  for (const call of ['listExpiredEvidence(', 'expireDerivedData(', '.applyRetention(']) {
    expect(sources.flatMap(([name, text]) => text.split(call).slice(1).map(() => name)), call).toEqual(['control.ts']);
  }
  expect(readFileSync(resolve(dir, 'retention-scheduler.ts'), 'utf8')).toContain('runRetentionCleanup(');
  const worker = readFileSync(resolve(dir, 'processing-worker.ts'), 'utf8');
  const order = ['createRetentionScheduler(', "process.argv.includes('--check')",
    "if (process.argv.includes('--once')) await retention.tick().catch(() => { process.stderr.write('RETENTION_SCHEDULER_TICK_FAILED\\n'); process.exitCode = 1; });",
    "--once')) { await scheduler.tick(); return; }",
    'heartbeat.beat(true)', "await retention.tickIfDue().catch(() => { process.stderr.write('RETENTION_SCHEDULER_TICK_FAILED\\n'); });",
    "process.stderr.write('CONNECTOR_SCHEDULER_TICK_FAILED\\n')", 'heartbeat.beat(false)'].map(text => worker.indexOf(text));
  expect(order.every(index => index >= 0)).toBe(true);
  expect(order).toEqual([...order].sort((x, y) => x - y));
});
