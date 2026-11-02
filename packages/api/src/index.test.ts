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
