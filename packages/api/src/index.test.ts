import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { RequestContext } from '@unai/domain';
import * as api from './index.js';
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
