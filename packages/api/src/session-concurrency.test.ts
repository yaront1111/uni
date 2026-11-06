/** Session liveness under concurrency (ADR 0045). An admin transaction holds a row
 * lock, and every ordering is read from pg_blocking_pids of that holder's own
 * backend (or of a request it parked), never from a sleep or a wall clock. */
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runMigrations } from '@unai/postgres';
import { postgresAdapter, resolveSession, revokeSessions, SESSION_COOKIE } from '@unai/auth';
import { createPlatformApi } from './platform.js';

if (!process.env.UNAI_TEST_DATABASE_URL) throw new Error('Run pnpm test for the required PostgreSQL harness');
const admin = new Pool({ connectionString: process.env.UNAI_TEST_DATABASE_URL });
const appUrl = new URL(process.env.UNAI_TEST_DATABASE_URL);
appUrl.username = 'session_concurrency_test_app'; appUrl.password = 'test-only';
const appPool = new Pool({ connectionString: appUrl.href });

beforeAll(async () => {
  await runMigrations(admin, resolve('migrations'));
  await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='session_concurrency_test_app') THEN CREATE ROLE session_concurrency_test_app LOGIN PASSWORD 'test-only'; END IF; END $$; GRANT unai_app TO session_concurrency_test_app");
});
afterAll(async () => { await appPool.end(); await admin.end(); });

async function owner() {
  const adapter = postgresAdapter(admin);
  const user = await adapter.createUser!({ name: 'Session concurrency', email: randomUUID() + '@example.test', emailVerified: null });
  const scope = (user as unknown as { ownerScopeId: string }).ownerScopeId;
  async function session() {
    const token = randomBytes(32).toString('base64url');
    await adapter.createSession!({ userId: user.id, sessionToken: token, expires: new Date(Date.now() + 600_000) });
    return token;
  }
  return { scope, userId: user.id, token: await session(), session };
}
type Owner = Awaited<ReturnType<typeof owner>>;

function headers(o: { scope: string; token: string }, purpose: string) {
  return { cookie: SESSION_COOKIE + '=' + o.token, 'x-owner-scope-id': o.scope, 'x-purpose': purpose,
    'x-correlation-id': randomUUID(), 'idempotency-key': randomUUID() };
}
const registration = (o: Owner) => ({ method: 'POST' as const, url: '/v1/devices',
  headers: headers(o, 'device.register'), payload: { displayName: 'Laptop', kind: 'DESKTOP' } });
const sameSessionReads = (o: Owner) => [
  { url: '/v1/devices', headers: headers(o, 'device.list') }, { url: '/v1/devices', headers: headers(o, 'device.list') },
  { url: '/v1/settings/voice', headers: headers(o, 'settings.voice') },
  { url: '/v1/settings/voice', headers: headers(o, 'settings.voice') }];

function api() {
  const app = createPlatformApi({ authPool: admin, appPool });
  app.addHook('onRequest', async request => {
    Object.defineProperty(request.raw.socket, 'encrypted', { value: true, configurable: true });
  });
  return app;
}

interface Held { readonly pid: number; end(commit?: boolean): Promise<void> }
/** An admin transaction that keeps the row locks `sql` takes until `end`. */
async function hold(sql: string, params: unknown[]): Promise<Held> {
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    await client.query(sql, params);
    let ended = false;
    return { pid, async end(commit = false) {
      if (ended) return;
      ended = true;
      try { await client.query(commit ? 'COMMIT' : 'ROLLBACK'); } finally { client.release(); }
    } };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
    throw error;
  }
}
/** Backends waiting on THIS pid only: files run in parallel on one database. */
async function waiters(pid: number): Promise<number[]> {
  return (await admin.query<{ pid: number }>(
    'SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) ORDER BY pid', [pid])).rows.map(row => row.pid);
}

interface Tracked<T> { readonly promise: Promise<T>; readonly settled: boolean }
function tracked<T>(source: Promise<T>): Tracked<T> {
  let settled = false;
  const promise = source.finally(() => { settled = true; });
  promise.catch(() => undefined); // Awaited later; never an unhandled rejection meanwhile.
  return { promise, get settled() { return settled; } };
}
interface Holder { readonly label: string; readonly pid: number; readonly count?: number }
/** Whichever comes first: `settled()` turns true, or `count` backends wait on a
 * holder's pid. Each case races two branches that both resolve, so a wrong
 * ordering fails fast instead of hanging. */
async function firstWaitOn(settled: () => boolean, ...holders: Holder[]): Promise<string> {
  for (;;) {
    if (settled()) return 'settled';
    for (const holder of holders) {
      if ((await waiters(holder.pid)).length >= (holder.count ?? 1)) return holder.label;
    }
    await delay(10);
  }
}

interface Case {
  readonly app: ReturnType<typeof api>;
  track<T>(promise: Promise<T>): Tracked<T>;
  hold(sql: string, params: unknown[]): Promise<Held>;
}
/** One case on a fresh app (the address limiter is per instance). However the
 * case ends, the holder ends first, then every request it started settles. */
async function scenario(run: (c: Case) => Promise<void>) {
  const app = api(), started: Promise<unknown>[] = [];
  const holders: Held[] = [];
  try {
    await run({
      app,
      track(promise) { const t = tracked(promise); started.push(t.promise); return t; },
      async hold(sql, params) { const holder = await hold(sql, params); holders.push(holder); return holder; },
    });
  } finally {
    await Promise.all(holders.map(holder => holder.end()));
    await Promise.allSettled(started);
    await app.close();
  }
}

/** Parks a PATCH /v1/settings/voice inside its owner transaction: the holder keeps
 * the owner's voice row, and updateVoiceSettings waits at its FOR UPDATE (its
 * INSERT ... ON CONFLICT DO NOTHING never waits on a lock-only row). */
async function heldPatch(c: Case, o: Owner) {
  await admin.query('INSERT INTO voice_settings(owner_scope_id) VALUES($1)', [o.scope]);
  const holder = await c.hold('SELECT 1 FROM voice_settings WHERE owner_scope_id=$1 FOR UPDATE', [o.scope]);
  const patchHeaders = headers(o, 'settings.voice');
  const first = c.track(c.app.inject({ method: 'PATCH', url: '/v1/settings/voice', headers: patchHeaders,
    payload: { language: 'he-IL' } }));
  expect(await firstWaitOn(() => first.settled, { label: 'holder', pid: holder.pid })).toBe('holder');
  const parked = await waiters(holder.pid);
  expect(parked).toHaveLength(1);
  return { holder, first, correlationId: patchHeaders['x-correlation-id'], r1: parked[0]! };
}
async function register(c: Case, o: Owner): Promise<string> {
  const registered = await c.app.inject(registration(o));
  expect(registered.statusCode).toBe(200);
  return registered.json<{ id: string }>().id;
}
async function language(o: Owner) {
  return (await admin.query<{ language: string }>('SELECT language FROM voice_settings WHERE owner_scope_id=$1',
    [o.scope])).rows[0]?.language;
}
/** Answered 401 SESSION_EXPIRED, and the rolled-back transaction left no audit row. */
async function expectExpired(response: Promise<{ statusCode: number; json(): unknown }>, correlationId: string) {
  const answered = await response;
  expect(answered.statusCode).toBe(401);
  expect(answered.json()).toEqual({ code: 'SESSION_EXPIRED', correlationId });
  expect((await admin.query<{ n: number }>('SELECT count(*)::int AS n FROM audit_events WHERE correlation_id=$1',
    [correlationId])).rows[0]?.n).toBe(0);
}
const outcome = (error: unknown) => String((error as { code?: unknown } | null)?.code ?? 'ERROR');
/** @unai/auth's private token digest (sha256 hex), for calling its SQL functions directly. */
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
/** The SQLSTATE or code of every error a route threw. Fastify runs onError hooks
 * with the original error before setErrorHandler answers 500, so a route-side 40P01
 * stays visible. Call it first: Fastify refuses addHook once the app has served. */
function routeErrors(app: Case['app']): string[] {
  const codes: string[] = [];
  app.addHook('onError', async (_request, _reply, error) => { codes.push(outcome(error)); });
  return codes;
}
/** A device route racing a same-user sign-out, with an admin holder on the users row.
 * The sign-out MUST start first. Under 0002's FOR UPDATE the waiting revoker holds
 * the users tuple's heavyweight lock in AccessExclusiveLock mode, so the route's
 * foreign-key KEY SHARE (AccessShareLock) queues behind the revoker ('revoker').
 * When the holder ends, the revoker takes FOR UPDATE and waits for the route's
 * session row while the route waits for the revoker: 40P01. Under migration 0043's
 * FOR NO KEY UPDATE the revoker's tuple lock is ExclusiveLock, which AccessShareLock
 * does not conflict with, so the route waits on the holder beside it ('user row').
 * The reverse start order never deadlocks: the first waiter keeps its queue place. */
async function raceSignOut<T>(c: Case, o: Owner, signOut: () => Promise<void>, route: () => Promise<T>) {
  const holder = await c.hold('SELECT 1 FROM users WHERE id=$1 FOR UPDATE', [o.userId]);
  const out = c.track(signOut().then(() => 'REVOKED', outcome));
  expect(await firstWaitOn(() => out.settled, { label: 'user row', pid: holder.pid })).toBe('user row');
  const revokers = await waiters(holder.pid);
  expect(revokers).toHaveLength(1);
  const request = c.track(route());
  const parkedOn = await firstWaitOn(() => request.settled, { label: 'revoker', pid: revokers[0]! },
    { label: 'user row', pid: holder.pid, count: 2 });
  await holder.end();
  return { response: await request.promise, signOut: await out.promise, parkedOn };
}
async function auditPurposes(...ids: string[]) {
  return (await admin.query<{ purpose: string }>(
    'SELECT purpose FROM audit_events WHERE correlation_id=ANY($1::uuid[]) ORDER BY purpose', [ids])).rows.map(row => row.purpose);
}
async function liveSessions(userId: string) {
  return (await admin.query<{ n: number }>('SELECT count(*)::int AS n FROM auth_sessions WHERE user_id=$1 AND revoked_at IS NULL',
    [userId])).rows[0]?.n;
}

it('a request held inside its transaction does not stall a second request on the same session', () => scenario(async c => {
  const o = await owner();
  const { holder, first, r1 } = await heldPatch(c, o);
  const second = c.track(c.app.inject({ url: '/v1/devices', headers: headers(o, 'device.list') }));
  expect(await firstWaitOn(() => second.settled, { label: 'held request', pid: r1 })).toBe('settled');
  expect((await second.promise).statusCode).toBe(200);
  expect(first.settled).toBe(false);
  await holder.end();
  expect((await first.promise).statusCode).toBe(200);
  expect(await language(o)).toBe('he-IL');
}));

it('a sign-out commits while a same-session request is in flight, and that request then rolls back with SESSION_EXPIRED', () => scenario(async c => {
  const o = await owner();
  const { holder, first, correlationId, r1 } = await heldPatch(c, o);
  // The real auth_revoke_session, called the way Auth.js sign-out calls it.
  const signOut = c.track(revokeSessions(admin, o.token, randomUUID(), false).then(() => 'REVOKED', outcome));
  expect(await firstWaitOn(() => signOut.settled, { label: 'in-flight request', pid: r1 })).toBe('settled');
  expect(await signOut.promise).toBe('REVOKED');
  expect(first.settled).toBe(false);
  await holder.end();
  await expectExpired(first.promise, correlationId);
  expect(await language(o)).toBe('device');
  expect((await c.app.inject({ url: '/v1/devices', headers: headers(o, 'device.list') })).statusCode).toBe(401);
}));

it("removing the session's device from another session commits while a request is in flight, and that request then rolls back", () => scenario(async c => {
  const o = await owner();
  const device = await register(c, o);
  const other = { ...o, token: await o.session() };
  const { holder, first, correlationId, r1 } = await heldPatch(c, o);
  const removal = c.track(c.app.inject({ method: 'POST', url: '/v1/devices/' + device + '/revoke',
    headers: headers(other, 'device.remove'), payload: {} }));
  expect(await firstWaitOn(() => removal.settled, { label: 'in-flight request', pid: r1 })).toBe('settled');
  const removed = await removal.promise;
  expect(removed.statusCode).toBe(200);
  expect(removed.json()).toEqual({ removed: true });
  expect(first.settled).toBe(false);
  await holder.end();
  await expectExpired(first.promise, correlationId);
  expect(await language(o)).toBe('device');
}));

it('a request that reaches its commit point during an uncommitted revocation waits for it and rolls back', () => scenario(async c => {
  const o = await owner();
  const device = await register(c, o);
  // Fires the real revoke_removed_device_sessions trigger and stays uncommitted.
  const holder = await c.hold('UPDATE devices SET removed_at=now() WHERE id=$1', [device]);
  const readHeaders = headers(o, 'device.list');
  const read = c.track(c.app.inject({ url: '/v1/devices', headers: readHeaders }));
  expect(await firstWaitOn(() => read.settled, { label: 'revocation', pid: holder.pid })).toBe('revocation');
  await holder.end(true);
  await expectExpired(read.promise, readHeaders['x-correlation-id']);
}));

it('device registration and its concurrent retry serialize on the session row against same-session reads: one device, no deadlock, no 500', () => scenario(async c => {
  const o = await owner();
  // auth_create_session's per-user FOR UPDATE. It stops a registration at its devices
  // INSERT, through the devices.user_id foreign key; auth_revoke_session's FOR NO KEY
  // UPDATE (migration 0043) would not.
  const holder = await c.hold('SELECT 1 FROM users WHERE id=$1 FOR UPDATE', [o.userId]);
  const first = c.track(c.app.inject(registration(o)));
  expect(await firstWaitOn(() => first.settled, { label: 'user row', pid: holder.pid })).toBe('user row');
  const parked = await waiters(holder.pid);
  expect(parked).toHaveLength(1);
  const retry = c.track(c.app.inject(registration(o)));
  expect(await firstWaitOn(() => retry.settled, { label: 'registration', pid: parked[0]! },
    { label: 'user row', pid: holder.pid, count: 2 })).toBe('registration');
  const reads = sameSessionReads(o).map(request => c.track(c.app.inject(request)).promise);
  await holder.end();
  const answered = await Promise.all([first.promise, retry.promise, ...reads]);
  expect(answered.map(response => response.statusCode)).toEqual([200, 200, 200, 200, 200, 200]);
  const id = answered[0]!.json<{ id: string }>().id;
  expect(answered[1]!.json<{ id: string }>().id).toBe(id);
  expect((await admin.query('SELECT id FROM devices WHERE owner_scope_id=$1 AND user_id=$2', [o.scope, o.userId])).rows)
    .toEqual([{ id }]);
  expect((await admin.query('SELECT device_id FROM auth_sessions WHERE user_id=$1', [o.userId])).rows)
    .toEqual([{ device_id: id }]);
  // The same mix with no holder at all.
  const p = await owner();
  const burst = await Promise.all([registration(p), registration(p), ...sameSessionReads(p)]
    .map(request => c.track(c.app.inject(request)).promise));
  expect(burst.map(response => response.statusCode)).toEqual([200, 200, 200, 200, 200, 200]);
  const burstId = burst[0]!.json<{ id: string }>().id;
  expect(burst[1]!.json<{ id: string }>().id).toBe(burstId);
  expect((await admin.query('SELECT id FROM devices WHERE owner_scope_id=$1 AND user_id=$2', [p.scope, p.userId])).rows)
    .toEqual([{ id: burstId }]);
}));

it('registration racing a sign-out of its own session: both commit, no 40P01', () => scenario(async c => {
  const errors = routeErrors(c.app);
  const o = await owner();
  const request = registration(o), signOutId = randomUUID();
  const { response, signOut, parkedOn } = await raceSignOut(c, o,
    () => revokeSessions(admin, o.token, signOutId, false), () => c.app.inject(request));
  expect({ route: response.statusCode, routeErrors: errors, signOut }).toEqual({ route: 200, routeErrors: [], signOut: 'REVOKED' });
  expect(parkedOn).toBe('user row');
  const id = response.json<{ id: string }>().id;
  expect((await admin.query('SELECT id, removed_at FROM devices WHERE owner_scope_id=$1 AND user_id=$2', [o.scope, o.userId])).rows)
    .toEqual([{ id, removed_at: null }]);
  // The revoker waited for the route's row lock, then re-checked the committed version.
  expect((await admin.query('SELECT device_id, revoked_at IS NOT NULL AS revoked FROM auth_sessions WHERE user_id=$1', [o.userId])).rows)
    .toEqual([{ device_id: id, revoked: true }]);
  expect(await auditPurposes(request.headers['x-correlation-id'], signOutId)).toEqual(['auth.sign_out', 'device.register']);
}));

it('own-device removal racing a sign-out-all from another session: both commit, no 40P01', () => scenario(async c => {
  const errors = routeErrors(c.app);
  const o = await owner();
  const device = await register(c, o);
  const other = await o.session();
  const removal = { method: 'POST' as const, url: '/v1/devices/' + device + '/revoke', headers: headers(o, 'device.remove'), payload: {} };
  const signOutId = randomUUID();
  const { response, signOut, parkedOn } = await raceSignOut(c, o,
    () => revokeSessions(admin, other, signOutId, true), () => c.app.inject(removal));
  expect({ route: response.statusCode, routeErrors: errors, signOut }).toEqual({ route: 200, routeErrors: [], signOut: 'REVOKED' });
  expect(response.json()).toEqual({ removed: true });
  expect(parkedOn).toBe('user row');
  expect((await admin.query('SELECT id, removed_at IS NOT NULL AS removed FROM devices WHERE owner_scope_id=$1 AND user_id=$2',
    [o.scope, o.userId])).rows).toEqual([{ id: device, removed: true }]);
  // The device trigger revoked o.token's session; the sign-out-all revoked `other`
  // and skipped the row the route had already revoked.
  expect((await admin.query('SELECT count(*)::int AS n, (count(*) FILTER (WHERE revoked_at IS NULL))::int AS live FROM auth_sessions WHERE user_id=$1',
    [o.userId])).rows).toEqual([{ n: 2, live: 0 }]);
  expect(await auditPurposes(removal.headers['x-correlation-id'], signOutId)).toEqual(['auth.sign_out_all', 'device.remove']);
}));

it("the revoker's users lock still serializes it against an uncommitted sign-in and against another revoker", async () => {
  await scenario(async c => {
    const o = await owner();
    const issued = randomBytes(32).toString('base64url');
    // An uncommitted sign-in: auth_create_session holds users FOR UPDATE.
    const holder = await c.hold('SELECT unai_private.auth_create_session($1,$2,$3,$4)',
      [digest(issued), o.userId, new Date(Date.now() + 600_000), randomUUID()]);
    const all = c.track(revokeSessions(admin, o.token, randomUUID(), true).then(() => 'REVOKED', outcome));
    expect(await firstWaitOn(() => all.settled, { label: 'sign-in', pid: holder.pid })).toBe('sign-in');
    await holder.end(true);
    expect(await all.promise).toBe('REVOKED');
    expect((await admin.query('SELECT revoked_at IS NOT NULL AS revoked FROM auth_sessions WHERE token_hash=$1', [digest(issued)])).rows)
      .toEqual([{ revoked: true }]);
    expect(await liveSessions(o.userId)).toBe(0);
    expect(await resolveSession(admin, issued)).toBeNull();
  });
  await scenario(async c => {
    const o = await owner();
    const second = await o.session(), firstId = randomUUID(), secondId = randomUUID();
    const holder = await c.hold('SELECT unai_private.auth_revoke_session($1,$2,$3)', [digest(o.token), firstId, false]);
    // A different session row: only the users lock can make it wait.
    const next = c.track(revokeSessions(admin, second, secondId, false).then(() => 'REVOKED', outcome));
    expect(await firstWaitOn(() => next.settled, { label: 'first revoker', pid: holder.pid })).toBe('first revoker');
    await holder.end(true);
    expect(await next.promise).toBe('REVOKED');
    expect(await liveSessions(o.userId)).toBe(0);
    expect(await auditPurposes(firstId, secondId)).toEqual(['auth.sign_out', 'auth.sign_out']);
  });
});

/** Each probe releases its lock even on refusal; only 55P03 means not lockable. */
async function lockable(sessionId: string): Promise<boolean> {
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT 1 FROM auth_sessions WHERE id=$1 FOR NO KEY UPDATE NOWAIT', [sessionId]);
    return true;
  } catch (error) {
    if (outcome(error) === '55P03') return false;
    throw error;
  } finally {
    try { await client.query('ROLLBACK'); } finally { client.release(); }
  }
}
async function sessionId(token: string): Promise<string> {
  return (await admin.query<{ id: string }>('SELECT id FROM auth_sessions WHERE token_hash=$1', [digest(token)])).rows[0]!.id;
}
const removal = (o: Owner, device: string) => ({ method: 'POST' as const, url: '/v1/devices/' + device + '/revoke',
  headers: headers(o, 'device.remove'), payload: {} });

it('mutual device removal commits once and expires the second session without 40P01', () => scenario(async c => {
  const errors = routeErrors(c.app), y = await owner(), dy = await register(c, y);
  const x = { ...y, token: await y.session() }, dx = await register(c, x);
  const h1 = await c.hold('SELECT 1 FROM devices WHERE id=$1 FOR UPDATE', [dy]);
  const h2 = await c.hold('SELECT 1 FROM devices WHERE id=$1 FOR UPDATE', [dx]);
  const rx = c.track(c.app.inject(removal(x, dy)));
  expect(await firstWaitOn(() => rx.settled, { label: 'DY', pid: h1.pid })).toBe('DY');
  const parked = await waiters(h1.pid);
  expect(parked).toHaveLength(1);
  const requestY = removal(y, dx), ry = c.track(c.app.inject(requestY));
  expect(await firstWaitOn(() => ry.settled, { label: 'DX', pid: h2.pid }, { label: 'X', pid: parked[0]! }))
    .toMatch(/^(DX|X)$/);
  await h1.end();
  await h2.end();
  const [first, second] = await Promise.all([rx.promise, ry.promise]);
  expect({ codes: [first.statusCode, second.statusCode], deadlocks: errors.filter(code => code === '40P01') })
    .toEqual({ codes: [200, 401], deadlocks: [] });
  expect(first.json()).toEqual({ removed: true });
  await expectExpired(ry.promise, requestY.headers['x-correlation-id']);
  expect((await admin.query('SELECT id, removed_at IS NOT NULL AS removed FROM devices WHERE id=ANY($1::uuid[]) ORDER BY id',
    [[dx, dy]])).rows).toEqual([{ id: dx, removed: false }, { id: dy, removed: true }].sort((a, b) => a.id.localeCompare(b.id)));
  expect((await admin.query('SELECT id, revoked_at IS NOT NULL AS revoked FROM auth_sessions WHERE user_id=$1 ORDER BY id',
    [y.userId])).rows).toEqual([{ id: await sessionId(x.token), revoked: false }, { id: await sessionId(y.token), revoked: true }]
    .sort((a, b) => a.id.localeCompare(b.id)));
}));

it("removing another session's device racing its sign-out-all: both commit, no 40P01", () => scenario(async c => {
  const errors = routeErrors(c.app), y = await owner(), device = await register(c, y);
  const x = { ...y, token: await y.session() }, request = removal(x, device), signOutId = randomUUID();
  const holder = await c.hold('SELECT 1 FROM devices WHERE id=$1 FOR UPDATE', [device]);
  const route = c.track(c.app.inject(request));
  expect(await firstWaitOn(() => route.settled, { label: 'device', pid: holder.pid })).toBe('device');
  const parked = await waiters(holder.pid);
  expect(parked).toHaveLength(1);
  const signOut = c.track(revokeSessions(admin, y.token, signOutId, true).then(() => 'REVOKED', outcome));
  expect(await firstWaitOn(() => signOut.settled, { label: 'route', pid: parked[0]! })).toBe('route');
  await holder.end();
  const response = await route.promise;
  expect({ route: response.statusCode, routeErrors: errors, signOut: await signOut.promise })
    .toEqual({ route: 200, routeErrors: [], signOut: 'REVOKED' });
  expect(response.json()).toEqual({ removed: true });
  expect((await admin.query('SELECT removed_at IS NOT NULL AS removed FROM devices WHERE id=$1', [device])).rows)
    .toEqual([{ removed: true }]);
  expect(await liveSessions(y.userId)).toBe(0);
  expect(await auditPurposes(request.headers['x-correlation-id'], signOutId)).toEqual(['auth.sign_out_all', 'device.remove']);
}));

/** Find an inversion in creation order without choosing ids: auth creates random
 * UUIDs. Revoke other fixture sessions before racing, leaving exactly two rows. */
async function invertedPair(c: Case) {
  const o = await owner();
  let higherToken = o.token, higher = await sessionId(higherToken);
  for (let attempts = 0; attempts < 128; attempts++) {
    const lowerToken = await o.session(), lower = await sessionId(lowerToken);
    if (lower < higher) {
      const device = await register(c, { ...o, token: lowerToken });
      await admin.query('UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1 AND id<>ALL($2::uuid[])',
        [o.userId, [lower, higher]]);
      return { o: { ...o, token: higherToken }, lower, higher, device };
    }
    higherToken = lowerToken; higher = lower;
  }
  throw new Error('SESSION_ID_INVERSION_NOT_FOUND');
}
it.each(['removal', 'sign-out-all', 'disable'] as const)('%s locks multiple sessions in ascending id order', async writer => {
  for (const held of ['lower', 'higher'] as const) await scenario(async c => {
    const errors = routeErrors(c.app), pair = await invertedPair(c);
    const holder = await c.hold('SELECT 1 FROM auth_sessions WHERE id=$1 FOR NO KEY UPDATE', [pair[held]]);
    const work = c.track(writer === 'removal'
      ? c.app.inject(removal(pair.o, pair.device)).then(response => String(response.statusCode))
      : writer === 'sign-out-all'
        ? revokeSessions(admin, pair.o.token, randomUUID(), true).then(() => 'REVOKED', outcome)
        : admin.query('UPDATE users SET disabled_at=now() WHERE id=$1', [pair.o.userId]).then(() => 'DISABLED', outcome));
    expect(await firstWaitOn(() => work.settled, { label: held, pid: holder.pid })).toBe(held);
    expect(await lockable(pair[held === 'lower' ? 'higher' : 'lower']), `${writer}: holder on ${held}`).toBe(held === 'lower');
    await holder.end();
    expect(await work.promise).toBe(writer === 'removal' ? '200' : writer === 'sign-out-all' ? 'REVOKED' : 'DISABLED');
    expect(errors).toEqual([]);
  });
});

it('removal pre-lock set equals the device trigger write set, excluding the caller', () => scenario(async c => {
  const o = await owner(), device = await register(c, o);
  const second = await o.session(), expired = await o.session(), revoked = await o.session();
  const otherDeviceSession = { ...o, token: await o.session() }, otherDevice = await register(c, otherDeviceSession);
  const caller = { ...o, token: await o.session() }, foreign = await owner();
  const ids = await Promise.all([o.token, second, expired, revoked, otherDeviceSession.token, caller.token, foreign.token].map(sessionId));
  const [firstId, secondId, expiredId, revokedId, otherId, callerId, foreignId] = ids as [string, string, string, string, string, string, string];
  await admin.query('UPDATE auth_sessions SET device_id=$1 WHERE id=ANY($2::uuid[])', [device, [secondId, expiredId, revokedId]]);
  await admin.query("UPDATE auth_sessions SET expires_at=now()-interval '1 minute' WHERE id=$1", [expiredId]);
  await admin.query("UPDATE auth_sessions SET revoked_at=now()-interval '1 day' WHERE id=$1", [revokedId]);
  const before = (await admin.query<{ id: string; revoked: string | null }>(
    'SELECT id, revoked_at::text AS revoked FROM auth_sessions WHERE id=ANY($1::uuid[])', [ids])).rows;
  const holder = await c.hold('SELECT 1 FROM devices WHERE id=$1 FOR UPDATE', [device]);
  const route = c.track(c.app.inject(removal(caller, device)));
  expect(await firstWaitOn(() => route.settled, { label: 'device', pid: holder.pid })).toBe('device');
  const locked: string[] = [];
  for (const id of ids) if (!await lockable(id)) locked.push(id);
  expect(locked.sort()).toEqual([firstId, secondId, expiredId, callerId].sort());
  await holder.end();
  expect((await route.promise).statusCode).toBe(200);
  const after = (await admin.query<{ id: string; revoked: string | null }>(
    'SELECT id, revoked_at::text AS revoked FROM auth_sessions WHERE id=ANY($1::uuid[])', [ids])).rows;
  const changed = after.filter(row => row.revoked !== before.find(old => old.id === row.id)!.revoked).map(row => row.id);
  expect(locked.filter(id => id !== callerId).sort()).toEqual(changed.sort());
  expect(changed.sort()).toEqual([firstId, secondId, expiredId].sort());
  expect(locked).not.toEqual(expect.arrayContaining([revokedId, otherId, foreignId]));
  expect((await admin.query('SELECT removed_at FROM devices WHERE id=$1', [otherDevice])).rows).toEqual([{ removed_at: null }]);
}));

it.each(['expires_at', 'revoked_at'] as const)('own-device removal refuses a concurrent %s change after its first statement waits',
  field => scenario(async c => {
    const o = await owner(), device = await register(c, o), id = await sessionId(o.token);
    // Resolution sees the old live version; the locking statement must recheck
    // the version committed by this holder, even if the device predicate matches.
    const holder = await c.hold(`UPDATE auth_sessions SET ${field}=now()-interval '1 minute' WHERE id=$1`, [id]);
    const request = removal(o, device), route = c.track(c.app.inject(request));
    expect(await firstWaitOn(() => route.settled, { label: 'session', pid: holder.pid })).toBe('session');
    await holder.end(true);
    await expectExpired(route.promise, request.headers['x-correlation-id']);
    expect((await admin.query('SELECT removed_at FROM devices WHERE id=$1', [device])).rows).toEqual([{ removed_at: null }]);
  }));

it('foreign-device removal answers 404 without locking its sessions', () => scenario(async c => {
  const caller = await owner(), foreign = await owner(), device = await register(c, foreign);
  const holder = await c.hold('SELECT 1 FROM auth_sessions WHERE id=$1 FOR NO KEY UPDATE', [await sessionId(foreign.token)]);
  const route = c.track(c.app.inject(removal(caller, device)));
  expect(await firstWaitOn(() => route.settled, { label: 'foreign session', pid: holder.pid })).toBe('settled');
  const response = await route.promise;
  expect(response.statusCode).toBe(404);
  expect(response.json()).toEqual({ code: 'DEVICE_NOT_FOUND' });
  expect((await admin.query('SELECT removed_at FROM devices WHERE id=$1', [device])).rows).toEqual([{ removed_at: null }]);
  expect(await liveSessions(foreign.userId)).toBe(1);
}));
