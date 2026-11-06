import { afterEach, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type { RequestContext } from '@unai/domain';
import * as api from './index.js';
import { createRateLimiter, DEFAULT_RATE_LIMITS, parseRateLimit, RATE_LIMIT_MAX_KEYS } from './rate-limit.js';
import { request as httpsRequest } from 'node:https';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const actorId = randomUUID(), ownerScopeId = randomUUID(), correlationId = randomUUID();
const headers = { 'x-owner-scope-id': ownerScopeId, 'x-purpose': 'device.list', 'x-correlation-id': correlationId };
const servers: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())); });

function setup(options: { authenticated?: boolean; authorized?: boolean; encrypted?: boolean } = {}) {
  const create = (api as Record<string, unknown>).createApiBoundary;
  expect(create, 'Fastify security boundary must exist').toBeTypeOf('function');
  const seen: RequestContext[] = [];
  const app = (create as (options: unknown) => FastifyInstance)({
    authenticate: async () => options.authenticated === false ? null : { actorId },
    authorize: async (context: RequestContext) => { seen.push(context); return options.authorized !== false; },
  });
  // Test-only transport stub: production uses the real socket, never forwarded headers.
  if (options.encrypted !== false) app.addHook('onRequest', async request => {
    Object.defineProperty(request.raw.socket, 'encrypted', { value: true });
  });
  app.get('/probe', async request => ({ context: (request as unknown as { ownerContext: RequestContext }).ownerContext }));
  app.get('/failure', async () => { throw new Error('secret-storage-key-do-not-log'); });
  servers.push(app);
  return { app, seen };
}

it('refuses plaintext even when forwarded headers claim HTTPS', async () => {
  const { app, seen } = setup({ encrypted: false });
  const result = await app.inject({ url: '/probe', headers: { ...headers, 'x-forwarded-proto': 'https' } });
  expect(result.statusCode).toBe(426);
  expect(result.json().code).toBe('TLS_REQUIRED');
  expect(seen).toEqual([]);
});

it('refuses unauthenticated actors', async () => {
  const { app, seen } = setup({ authenticated: false });
  const result = await app.inject({ url: '/probe', headers });
  expect(result.statusCode).toBe(401);
  expect(seen).toEqual([]);
});

it.each(['x-owner-scope-id', 'x-purpose', 'x-correlation-id'])('requires %s', async name => {
  const { app, seen } = setup();
  const incomplete: Record<string, string> = { ...headers };
  delete incomplete[name];
  const result = await app.inject({ url: '/probe', headers: incomplete });
  expect(result.statusCode).toBe(400);
  expect(seen).toEqual([]);
});

it('refuses invalid purpose or owner authorization', async () => {
  const { app } = setup({ authorized: false });
  expect((await app.inject({ url: '/probe', headers })).statusCode).toBe(403);
  expect((await app.inject({ url: '/probe', headers: { ...headers, 'x-purpose': 'private\tdata' } })).statusCode).toBe(400);
});

it('uses verified actor identity and returns the validated correlation ID', async () => {
  const { app, seen } = setup();
  const result = await app.inject({ url: '/probe', headers: { ...headers, 'x-actor-id': randomUUID() } });
  expect(result.statusCode).toBe(200);
  expect(result.headers['x-correlation-id']).toBe(correlationId);
  expect(seen).toEqual([{ actorId, ownerScopeId, purpose: 'device.list', correlationId }]);
  expect(result.json().context).toEqual(seen[0]);
});

it('redacts unexpected errors and prevents caching of private responses', async () => {
  const { app } = setup();
  const result = await app.inject({ url: '/failure', headers });
  expect(result.statusCode).toBe(500);
  expect(result.json()).toEqual({ code: 'INTERNAL_ERROR', correlationId });
  expect(result.body).not.toContain('secret-storage-key');
  expect(result.headers['cache-control']).toBe('no-store');
});

it('requires idempotency keys on writes', async () => {
  const { app } = setup();
  app.post('/write', async () => ({ ok: true }));
  expect((await app.inject({ method: 'POST', url: '/write', headers })).statusCode).toBe(400);
  expect((await app.inject({ method: 'POST', url: '/write', headers: { ...headers, 'idempotency-key': randomUUID() } })).statusCode).toBe(200);
});

it('serves an authenticated request over certificate-verified TLS with safe structured logs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'unai-tls-'));
  try {
    const keyPath = join(directory, 'key.pem'), certPath = join(directory, 'cert.pem');
    const openssl = process.platform === 'win32' ? 'C:/Program Files/Git/usr/bin/openssl.exe' : 'openssl';
    const generated = spawnSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', keyPath, '-out', certPath], { encoding: 'utf8' });
    expect(generated.status, generated.stderr).toBe(0);
    const cert = await readFile(certPath), key = await readFile(keyPath);
    const events: unknown[] = [];
    const app = api.createApiBoundary({ tls: { cert, key }, authenticate: async () => ({ actorId }),
      authorize: async () => true, log: event => events.push(event) });
    servers.push(app);
    app.get('/secure', async () => ({ ok: true }));
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const result = await new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
      const request = httpsRequest(origin + '/secure', { ca: cert, headers: { ...headers, authorization: 'test-secret-never-log' } }, response => {
        let body = '';
        response.on('data', chunk => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, body }));
      });
      request.on('error', reject); request.end();
    });
    expect(result).toEqual({ status: 200, body: '{"ok":true}' });
    expect(events).toEqual([{ event: 'api.response', correlationId, statusCode: 200, durationMs: expect.any(Number) }]);
    expect(JSON.stringify(events)).not.toContain('test-secret');
  } finally {
    await rm(directory, { recursive: true });
  }
});

function limited(perSessionPerMinute = 3, authFailuresPerAddressPerMinute = 2) {
  const valid = new Set(['A', 'B', 'unai-sentinel-session-0001']), events: unknown[] = [];
  let now = 121_000, calls = 0;
  const credential = (headers: Readonly<IncomingHttpHeaders>) => /(?:^|;\s*)t=([^;]+)/.exec(headers.cookie ?? '')?.[1] ?? null;
  const app = api.createApiBoundary({
    credential, rateLimit: { perSessionPerMinute, authFailuresPerAddressPerMinute }, clock: () => now,
    authenticate: async headers => { calls++; return valid.has(credential(headers) ?? '') ? { actorId } : null; },
    authorize: async () => true, log: event => events.push(event),
  });
  app.addHook('onRequest', async request => { Object.defineProperty(request.raw.socket, 'encrypted', { value: true }); });
  app.get('/probe', async () => ({ ok: true }));
  servers.push(app);
  const send = (token: string | null = 'A', remoteAddress = '10.0.0.7', extra: Record<string, string> = {}) =>
    app.inject({ url: '/probe', remoteAddress, headers: { ...headers, ...(token ? { cookie: 't=' + token } : {}), ...extra } });
  return { send, valid, events, calls: () => calls, advance: (time: number) => { now = time; } };
}

it('limits session request N+1 before authentication until the next minute', async () => {
  const limit = limited();
  for (let i = 0; i < 3; i++) expect((await limit.send()).statusCode).toBe(200);
  const refused = await limit.send();
  expect(refused.statusCode).toBe(429);
  expect(refused.json()).toEqual({ code: 'RATE_LIMITED', correlationId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
  expect(refused.headers['retry-after']).toBe('59');
  expect(refused.headers['x-rate-limit-bucket']).toBe('session');
  expect(limit.calls()).toBe(3);
  limit.advance(180_000);
  expect((await limit.send()).statusCode).toBe(200);
});

it('counts sessions independently, not the complete cookie header or other apps', async () => {
  const limit = limited(1);
  expect((await limit.send('A')).statusCode).toBe(200);
  expect((await limit.send('A', undefined, { cookie: 'noise=1; t=A; other=2' })).statusCode).toBe(429);
  expect((await limit.send('B')).statusCode).toBe(200);
  expect((await limit.send('B')).statusCode).toBe(429);
  expect((await limited(1).send('A')).statusCode).toBe(200);
});

it('blocks unknown credentials at a limited socket address without blocking known sessions', async () => {
  const limit = limited();
  expect((await limit.send()).statusCode).toBe(200);
  for (const token of ['bad1', 'bad2']) expect((await limit.send(token)).statusCode).toBe(401);
  const refused = await limit.send('bad3');
  expect(refused.statusCode).toBe(429);
  expect(refused.headers['retry-after']).toBe('59');
  expect(refused.headers['x-rate-limit-bucket']).toBe('authentication');
  expect((await limit.send(null)).statusCode).toBe(429);
  expect(limit.calls()).toBe(3);
  expect((await limit.send()).statusCode).toBe(200);
  expect((await limit.send('bad', '10.0.0.8')).statusCode).toBe(401);
  limit.advance(180_000);
  expect((await limit.send('bad')).statusCode).toBe(401);
});

it('ignores forwarded addresses and protocols when counting authentication failures', async () => {
  const limit = limited();
  for (let i = 0; i < 3; i++) {
    const result = await limit.send('bad' + i, '10.0.0.7', {
      'x-forwarded-for': '10.1.0.' + i, 'x-forwarded-proto': i % 2 ? 'https' : 'http',
    });
    expect(result.statusCode).toBe(i < 2 ? 401 : 429);
  }
  expect(limit.calls()).toBe(2);
});

it('forgets a credential after its first authentication failure', async () => {
  const limit = limited(3, 1);
  expect((await limit.send()).statusCode).toBe(200);
  limit.valid.delete('A');
  expect((await limit.send()).statusCode).toBe(401);
  expect((await limit.send()).statusCode).toBe(429);
  expect(limit.calls()).toBe(2);
  expect(limit.events).toContainEqual(expect.objectContaining({ event: 'api.rate_limited', bucket: 'authentication' }));
});

it('logs one allowlisted refusal without the credential or its digest', async () => {
  const token = 'unai-sentinel-session-0001', hash = createHash('sha256').update(token).digest('hex');
  const limit = limited(1), allowed = await limit.send(token), refused = await limit.send(token);
  expect(allowed.statusCode).toBe(200);
  expect(refused.statusCode).toBe(429);
  expect(limit.events.filter(event => (event as { event: string }).event === 'api.rate_limited')).toEqual([
    { event: 'api.rate_limited', correlationId: refused.json().correlationId, statusCode: 429, bucket: 'session' },
  ]);
  for (const value of [JSON.stringify(limit.events), allowed.body, refused.body, JSON.stringify(allowed.headers), JSON.stringify(refused.headers)]) {
    expect(value).not.toContain(token);
    expect(value).not.toContain(hash);
  }
});

it('limits the 31st authentication failure by default', async () => {
  const { app } = setup({ authenticated: false });
  for (let i = 0; i < 30; i++) expect((await app.inject({ url: '/probe', headers })).statusCode).toBe(401);
  expect((await app.inject({ url: '/probe', headers })).statusCode).toBe(429);
});

it('uses secure default budgets and strictly parses configured limits', () => {
  expect(DEFAULT_RATE_LIMITS).toEqual({ perSessionPerMinute: 600, authFailuresPerAddressPerMinute: 30 });
  expect(Object.isFrozen(DEFAULT_RATE_LIMITS)).toBe(true);
  expect(parseRateLimit(undefined, 'UNAI_TEST_LIMIT', 30)).toBe(30);
  expect(parseRateLimit('', 'UNAI_TEST_LIMIT', 30)).toBe(30);
  expect(parseRateLimit('600', 'UNAI_TEST_LIMIT', 30)).toBe(600);
  expect(parseRateLimit('999999', 'UNAI_TEST_LIMIT', 30)).toBe(999999);
  for (const value of ['0', '-5', '1.5', 'abc', '1e3', '1000000', ' 60', '60\n', '60\r']) {
    expect(() => parseRateLimit(value, 'UNAI_TEST_LIMIT', 30)).toThrow('CONFIG_INVALID:UNAI_TEST_LIMIT');
  }
});

it('fails closed at the address capacity and clears it at the next window', () => {
  let now = 179_999;
  const limiter = createRateLimiter(DEFAULT_RATE_LIMITS, () => now);
  for (let i = 0; i < RATE_LIMIT_MAX_KEYS; i++) limiter.failed(null, String(i));
  expect(limiter.admit(null, 'new')).toEqual({ kind: 'refused', bucket: 'authentication', retryAfterSeconds: 1 });
  limiter.failed(null, 'pending'); // An auth call admitted before the map filled.
  expect(limiter.admit(null, 'pending').kind).toBe('refused');
  expect(limiter.admit(null, '0')).toEqual({ kind: 'unknown' });
  now = 180_000;
  expect(limiter.admit(null, 'new')).toEqual({ kind: 'unknown' });
  limiter.authenticated(null);
  expect(limiter.admit(null, 'new')).toEqual({ kind: 'unknown' });
});

it('retains known sessions across windows but bounds their cache', () => {
  let now = 121_000;
  const limiter = createRateLimiter({ perSessionPerMinute: 1, authFailuresPerAddressPerMinute: 1 }, () => now);
  limiter.authenticated('first');
  now = 180_000;
  limiter.failed(null, 'blocked');
  expect(limiter.admit('first', 'blocked')).toEqual({ kind: 'counted' });
  expect(limiter.admit('first', 'blocked')).toEqual({ kind: 'refused', bucket: 'session', retryAfterSeconds: 60 });
  for (let i = 1; i <= RATE_LIMIT_MAX_KEYS; i++) limiter.authenticated(String(i));
  expect(limiter.admit('first', 'blocked')).toEqual({ kind: 'refused', bucket: 'authentication', retryAfterSeconds: 60 });
});

it("keeps this window's session refusals across a capacity turnover and evicts every other session", () => {
  let now = 15_000;
  const limiter = createRateLimiter({ perSessionPerMinute: 2, authFailuresPerAddressPerMinute: 1 }, () => now);
  limiter.authenticated('held');
  expect(limiter.admit('held', 'a')).toEqual({ kind: 'counted' });
  const refusal = { kind: 'refused', bucket: 'session', retryAfterSeconds: 45 };
  expect(limiter.admit('held', 'a')).toEqual(refusal);
  limiter.authenticated('busy'); // Known but under budget.
  limiter.authenticated('revoked');
  expect(limiter.admit('revoked', 'a')).toEqual({ kind: 'counted' }); // Now at budget.
  limiter.failed('revoked', 'r'); // Forgotten, as after a revoked session's 401; its count stays.
  for (let i = 0; i < RATE_LIMIT_MAX_KEYS; i++) limiter.authenticated('other' + i); // Turnover, on sessions.size.
  expect(limiter.admit('held', 'b')).toEqual(refusal);
  expect(limiter.admit('busy', 'c')).toEqual({ kind: 'unknown' });
  limiter.release('c');
  expect(limiter.admit('revoked', 'd')).toEqual({ kind: 'unknown' }); // A forgotten hash is never resurrected.
  limiter.release('d');
  expect(limiter.admit('other0', 'e')).toEqual({ kind: 'unknown' });
  now = 60_000;
  expect(limiter.admit('held', 'b')).toEqual({ kind: 'counted' }); // The kept refusal ends with its window.
});

it("keeps nothing at a turnover under an infinite session budget, the web gate's configuration", () => {
  const limiter = createRateLimiter({ perSessionPerMinute: Number.POSITIVE_INFINITY, authFailuresPerAddressPerMinute: 1 }, () => 15_000);
  limiter.authenticated('first');
  for (let i = 0; i < 1000; i++) expect(limiter.admit('first', 'a')).toEqual({ kind: 'counted' });
  for (let i = 0; i < RATE_LIMIT_MAX_KEYS; i++) limiter.authenticated('other' + i);
  expect(limiter.admit('first', 'b')).toEqual({ kind: 'unknown' });
});

it("fails open when this window's refusals would fill more than half the capacity", () => {
  function turnover(refused: number) {
    const limiter = createRateLimiter({ perSessionPerMinute: 2, authFailuresPerAddressPerMinute: 1 }, () => 15_000);
    for (let i = 0; i < refused; i++) { limiter.authenticated('r' + i); limiter.admit('r' + i, 'a'); } // Count 2 = budget.
    for (let i = refused; i < RATE_LIMIT_MAX_KEYS; i++) limiter.authenticated('u' + i); // Count 1.
    limiter.authenticated('new'); // The 10 001st key turns the cache over.
    return limiter;
  }
  expect(turnover(RATE_LIMIT_MAX_KEYS / 2).admit('r0', 'b')).toEqual({ kind: 'refused', bucket: 'session', retryAfterSeconds: 45 });
  expect(turnover(RATE_LIMIT_MAX_KEYS / 2 + 1).admit('r0', 'b')).toEqual({ kind: 'unknown' });
});

it('reserves an address slot for each unknown admission until release', () => {
  let now = 121_000;
  const limiter = createRateLimiter({ perSessionPerMinute: 5, authFailuresPerAddressPerMinute: 2 }, () => now);
  limiter.release('z');
  limiter.release('z'); // Nothing in flight: a no-op, never a negative count.
  expect(limiter.admit(null, 'a')).toEqual({ kind: 'unknown' });
  expect(limiter.admit('h', 'a')).toEqual({ kind: 'unknown' });
  expect(limiter.admit(null, 'a')).toEqual({ kind: 'refused', bucket: 'authentication', retryAfterSeconds: 59 });
  expect(limiter.admit(null, 'b')).toEqual({ kind: 'unknown' });
  limiter.authenticated('k');
  expect(limiter.admit('k', 'a')).toEqual({ kind: 'counted' }); // A known hash neither reserves nor sees the bucket.
  limiter.release('a');
  expect(limiter.admit(null, 'a')).toEqual({ kind: 'unknown' });
  limiter.release('a');
  limiter.failed(null, 'a');
  expect(limiter.admit(null, 'a').kind).toBe('refused'); // One failure plus one slot in flight fill the budget.
  now = 180_000;
  expect(limiter.admit(null, 'a')).toEqual({ kind: 'unknown' }); // Failures reset with the window; in-flight slots survive.
  expect(limiter.admit(null, 'a').kind).toBe('refused');
  expect(limiter.admit(null, 'z')).toEqual({ kind: 'unknown' });
  expect(limiter.admit(null, 'z')).toEqual({ kind: 'unknown' });
  expect(limiter.admit(null, 'z').kind).toBe('refused'); // The earlier releases of 'z' did not go negative.
});

/** Authentication that stays pending until `open()`, counting each unknown entry and each 429 as one decision. */
function held(authFailuresPerAddressPerMinute: number) {
  const unknownAuths: string[] = [], events: Array<{ event: string; bucket?: string }> = [];
  const waiting: Array<{ count: number; resolve: () => void }> = [];
  let now = 121_000, decisions = 0, open!: () => void;
  const gate = new Promise<void>(resolve => { open = resolve; });
  const decide = () => { decisions++; for (const waiter of waiting) if (decisions >= waiter.count) waiter.resolve(); };
  const decided = (count: number) => new Promise<void>(resolve => {
    if (decisions >= count) resolve(); else waiting.push({ count, resolve });
  });
  const credential = (headers: Readonly<IncomingHttpHeaders>) => /(?:^|;\s*)t=([^;]+)/.exec(headers.cookie ?? '')?.[1] ?? null;
  const app = api.createApiBoundary({
    credential, rateLimit: { perSessionPerMinute: 100, authFailuresPerAddressPerMinute }, clock: () => now,
    authenticate: async headers => {
      const token = credential(headers);
      if (token === 'A') return { actorId };
      if (token === 'boom') throw new Error('auth-pool-down-do-not-log');
      unknownAuths.push(token ?? '(none)'); decide();
      await gate;
      return null;
    },
    authorize: async () => true,
    log: event => { events.push(event); if (event.event === 'api.rate_limited') decide(); },
  });
  app.addHook('onRequest', async request => {
    if (request.headers['x-test-plaintext'] === undefined) Object.defineProperty(request.raw.socket, 'encrypted', { value: true });
  });
  app.get('/probe', async () => ({ ok: true }));
  servers.push(app);
  const send = (token: string | null = 'A', remoteAddress = '10.0.0.7', extra: Record<string, string> = {}) =>
    app.inject({ url: '/probe', remoteAddress, headers: { ...headers, ...(token ? { cookie: 't=' + token } : {}), ...extra } });
  const refusals = () => events.filter(event => event.event === 'api.rate_limited');
  return { send, open, decided, unknownAuths, refusals, advance: (time: number) => { now = time; } };
}

it('caps concurrent unknown authentications at the address budget while authentication is held', async () => {
  const hold = held(2);
  expect((await hold.send('A')).statusCode).toBe(200);
  const settled: Array<{ statusCode: number; headers: Record<string, unknown>; json(): unknown }> = [];
  let sixRefused!: () => void;
  const refusedSix = new Promise<void>(resolve => { sixRefused = resolve; });
  const burst = Array.from({ length: 8 }, (_, i) => hold.send(i % 2 ? 'bad' + i : null).then(response => {
    settled.push(response);
    if (settled.length === 6) sixRefused();
    return response;
  }));
  await hold.decided(8);
  expect(hold.unknownAuths).toHaveLength(2);
  expect(hold.refusals()).toHaveLength(6);
  for (const event of hold.refusals()) expect(event.bucket).toBe('authentication');
  await refusedSix;
  for (const response of settled) {
    expect(response.statusCode).toBe(429);
    expect(response.json()).toEqual({ code: 'RATE_LIMITED', correlationId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(response.headers['retry-after']).toBe('59');
  }
  expect((await hold.send('A')).statusCode).toBe(200); // A known session keeps its exemption from the address bucket.
  expect((await hold.send('bad12')).statusCode).toBe(429); // ...and neither reserved nor freed an unknown slot.
  expect((await hold.send('bad9', '10.0.0.7', { 'x-test-plaintext': '1' })).statusCode).toBe(426);
  expect(hold.unknownAuths).toHaveLength(2); // TLS is checked before admission.
  const other = hold.send('bad8', '10.0.0.8');
  await hold.decided(10); // 2 held + 7 refused + this one.
  expect(hold.unknownAuths).toHaveLength(3); // Another address has its own bucket.
  hold.open();
  const statuses = (await Promise.all(burst)).map(response => response.statusCode).sort((a, b) => a - b);
  expect(statuses).toEqual([401, 401, 429, 429, 429, 429, 429, 429]);
  expect((await other).statusCode).toBe(401);
  expect((await hold.send('bad10')).statusCode).toBe(429); // The two failures now fill the budget.
  expect(hold.unknownAuths).toHaveLength(3);
  expect((await hold.send('A')).statusCode).toBe(200);
  hold.advance(180_000);
  expect((await hold.send('bad11')).statusCode).toBe(401);
});

it('frees the slot when authentication succeeds or throws and does not count a throw', async () => {
  const hold = held(1);
  hold.open();
  expect((await hold.send('A')).statusCode).toBe(200);
  const thrown = await hold.send('boom');
  expect(thrown.statusCode).toBe(500);
  expect(thrown.body).not.toContain('auth-pool-down');
  expect((await hold.send('bad')).statusCode).toBe(401);
  expect((await hold.send('bad2')).statusCode).toBe(429);
});
