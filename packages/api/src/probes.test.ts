import { X509Certificate, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Agent, request, type IncomingHttpHeaders } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '@unai/postgres';
import { cachedCheck, certificateCheck, createLoopHeartbeat, createProbeServer,
  databaseCheck, probeConfiguration, registryReleaseCheck } from './probes.js';

const servers: Awaited<ReturnType<typeof createProbeServer>>[] = [];
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const start = async (options: Partial<Parameters<typeof createProbeServer>[0]> = {}) => {
  const server = await createProbeServer({ bind: '127.0.0.1', port: 0, checks: {}, ...options });
  servers.push(server); return server;
};
function get(port: number, path = '/readyz', method = 'GET', agent?: Agent) {
  return new Promise<{ code: number; body: string; headers: IncomingHttpHeaders }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, agent: agent ?? false }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; });
      res.on('error', reject); res.on('end', () => resolve({ code: res.statusCode!, body, headers: res.headers }));
    });
    req.on('connect', (res, socket, head) => {
      socket.destroy(); resolve({ code: res.statusCode!, body: head.toString(), headers: res.headers });
    });
    req.on('error', reject); req.end();
  });
}
afterEach(async () => { await Promise.all(servers.splice(0).map(s => s.close())); vi.restoreAllMocks(); });

it('serves exact liveness JSON without invoking readiness checks', async () => {
  const check = vi.fn(async () => undefined), server = await start({ checks: { database: check } });
  const result = await get(server.port, '/healthz');
  expect(result).toMatchObject({ code: 200, body: '{"status":"ok"}',
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  expect(result.headers.date).toBeUndefined(); expect(check).not.toHaveBeenCalled();
});
it('maps success, rejection and synchronous throw to status words without leakage', async () => {
  const logs = ['info', 'warn', 'error', 'log', 'debug'].map(method =>
    vi.spyOn(console, method as 'info').mockImplementation(() => undefined));
  const fail = () => { throw new Error('SENTINEL-probe-7f3a db password'); };
  const server = await start({ checks: { database: async () => 1, rejected: async () => fail(), thrown: fail } });
  const result = await get(server.port);
  expect(result.code).toBe(503);
  expect(result.body).toBe('{"status":"not-ready","checks":{"database":"ok","rejected":"fail","thrown":"fail"}}');
  expect(JSON.stringify([result, ...logs.map(log => log.mock.calls)])).not.toContain('SENTINEL');
  expect(logs.every(log => log.mock.calls.length === 0)).toBe(true);
});
it('times out a hung check while keeping liveness available', async () => {
  const server = await start({ timeoutMs: 50, checks: { hung: () => new Promise(() => undefined) } });
  expect(await get(server.port)).toMatchObject({ code: 503, body: '{"status":"not-ready","checks":{"hung":"fail"}}' });
  expect((await get(server.port, '/healthz')).code).toBe(200);
});
it('caches successful and failed readiness for at most the configured window', async () => {
  let now = 0, failing = false;
  const check = vi.fn(async () => { if (failing) throw new Error('ignored'); });
  const server = await start({ clock: () => now, checks: { database: check } });
  expect((await get(server.port)).body).toBe('{"status":"ready","checks":{"database":"ok"}}');
  failing = true; now = 9999; expect((await get(server.port)).code).toBe(200);
  expect(check).toHaveBeenCalledTimes(1); now = 10000;
  expect((await get(server.port)).code).toBe(503); failing = false;
  expect((await get(server.port)).code).toBe(503); expect(check).toHaveBeenCalledTimes(2);
});
it('shares concurrent evaluation and runs checks concurrently', async () => {
  const release = deferred(), entered = deferred();
  const slow = vi.fn(() => release.promise), fast = vi.fn(async () => { entered.resolve(); });
  const server = await start({ checks: { slow, fast }, cacheMs: 0 });
  const a = get(server.port), b = get(server.port); await entered.promise;
  // A liveness round trip lets both readiness requests reach the listener without a timed sleep.
  await get(server.port, '/healthz'); expect(slow).toHaveBeenCalledTimes(1);
  release.resolve(); expect((await a).code).toBe(200); expect((await b).code).toBe(200);
  expect(fast).toHaveBeenCalledTimes(1);
});
it('primes the bucket cache, holds rejection, and never duplicates an in-flight check past its TTL', async () => {
  let now = 0; const pending = deferred();
  const check = vi.fn(() => pending.promise), cached = cachedCheck(check, 300, { primed: true, clock: () => now });
  await cached(); expect(check).not.toHaveBeenCalled(); now = 300;
  const a = cached(); await Promise.resolve(); now = 601;
  const b = cached(); expect(b).toBe(a); expect(check).toHaveBeenCalledTimes(1); pending.resolve(); await Promise.all([a, b]);
  await cached(); expect(check).toHaveBeenCalledTimes(2);
  const reject = vi.fn(async () => { throw new Error('held'); });
  const failed = cachedCheck(reject, 300, { clock: () => now });
  await expect(failed()).rejects.toThrow('held'); await expect(failed()).rejects.toThrow('held');
  expect(reject).toHaveBeenCalledTimes(1); now += 300;
  await expect(failed()).rejects.toThrow('held'); expect(reject).toHaveBeenCalledTimes(2);
});
it.each(['/unknown', '/readyz/', '/readyz?x', '/healthz?x', '/'])('refuses exact-path mismatch %s', async path => {
  expect(await get((await start()).port, path)).toMatchObject({ code: 404, body: '', headers: { 'content-length': '0' } });
});
it.each(['HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH', 'TRACE', 'CONNECT'])('refuses %s before routing', async method => {
  expect(await get((await start()).port, '/unknown', method)).toMatchObject({ code: 405, body: '',
    headers: { allow: 'GET', 'content-length': '0' } });
});
it.each([undefined, ''])('logs disabled exactly once for port %s', port => {
  const log = vi.fn(), env: NodeJS.ProcessEnv = { NODE_ENV: 'test', ...(port === undefined ? {} : { UNAI_PROBE_PORT: port }) };
  expect(probeConfiguration(env, log)).toBeNull();
  expect(log.mock.calls).toEqual([['{"event":"probes","status":"PROBES_DISABLED"}']]);
});
it.each(['0', '65536', 'abc', '9101x', '-1', ' 9101', '9101 ', '1.5', '000001'])('rejects port %s', port => {
  expect(() => probeConfiguration({ NODE_ENV: 'test', UNAI_PROBE_PORT: port })).toThrow(/^PROBE_PORT_INVALID$/);
});
it.each(['1', '9101', '09101', '65535'])('accepts decimal port %s', port => {
  expect(probeConfiguration({ NODE_ENV: 'test', UNAI_PROBE_PORT: port })).toEqual({ bind: '127.0.0.1', port: Number(port) });
});
it.each(['127.0.0.2', '127.255.255.255', '::1', '0:0:0:0:0:0:0:1', '0000::0001'])('accepts loopback literal %s', bind => {
  expect(probeConfiguration({ NODE_ENV: 'test', UNAI_PROBE_PORT: '9101', UNAI_PROBE_BIND: bind })).toEqual({ bind, port: 9101 });
});
it.each(['0.0.0.0', '10.0.0.5', '::', 'localhost', '127.0.0.1.example.test', '::ffff:127.0.0.1',
  '127.000.0.1', '::1%lo', '[::1]', ' 127.0.0.1'])('refuses non-loopback or ambiguous bind %s', async bind => {
  expect(() => probeConfiguration({ NODE_ENV: 'test', UNAI_PROBE_PORT: '9101', UNAI_PROBE_BIND: bind })).toThrow(/^PROBE_BIND_NOT_LOOPBACK$/);
  await expect(start({ bind })).rejects.toThrow(/^PROBE_BIND_NOT_LOOPBACK$/);
});
it('defaults an empty bind and uses the status-only default logger', () => {
  expect(probeConfiguration({ NODE_ENV: 'test', UNAI_PROBE_PORT: '9101', UNAI_PROBE_BIND: '' })?.bind).toBe('127.0.0.1');
  const log = vi.spyOn(console, 'info').mockImplementation(() => undefined); probeConfiguration({ NODE_ENV: 'test' });
  expect(log.mock.calls).toEqual([['{"event":"probes","status":"PROBES_DISABLED"}']]);
});
it('closes idempotently, even with keep-alive, and frees the port', async () => {
  const server = await start(), agent = new Agent({ keepAlive: true });
  try {
    await get(server.port, '/healthz', 'GET', agent);
    await Promise.all([server.close(), server.close()]);
    await expect(get(server.port)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    await start({ port: server.port });
  } finally { agent.destroy(); }
});
it('sanitizes a port collision', async () => {
  await expect(start({ port: (await start()).port })).rejects.toThrow(/^PROBE_LISTEN_FAILED$/);
});
it.each([-1, 65536, 1.5, NaN])('rejects invalid programmatic port %s', async port => {
  await expect(start({ port })).rejects.toThrow(/^PROBE_PORT_INVALID$/);
});
it('checks the leaf certificate expiry and throttles warnings to once per day', async () => {
  const { createSelfSignedCertificate } = await import(pathToFileURL(resolve('scripts/tls-certificate.mjs')).href) as {
    createSelfSignedCertificate(): { certificate: string };
  };
  const cert = createSelfSignedCertificate().certificate, day = 86400000;
  const expiry = new X509Certificate(cert).validToDate.getTime(); let now = expiry - 8 * day;
  const time = vi.spyOn(Date, 'now').mockReturnValue(expiry + 8 * day);
  const laterCertificate = createSelfSignedCertificate().certificate; time.mockRestore();
  const log = vi.fn(), check = certificateCheck(cert + '\n' + laterCertificate, { clock: () => now, log });
  await check(); expect(log).not.toHaveBeenCalled();
  now = expiry - 3 * day; await check(); expect(log).toHaveBeenCalledTimes(1);
  now = expiry - 2.5 * day; await check(); expect(log).toHaveBeenCalledTimes(1);
  now = expiry - 1.9 * day; await check(); expect(log).toHaveBeenCalledTimes(2);
  expect(log.mock.calls).toEqual(Array.from({ length: 2 }, () => ['{"event":"probes","status":"TLS_CERT_EXPIRING"}']));
  now = expiry; await expect(check()).rejects.toThrow(/^TLS_CERTIFICATE_INVALID$/);
  expect(() => certificateCheck('not a cert')).toThrow(/^TLS_CERTIFICATE_INVALID$/);
});
it('uses the idle limit before the first beat and the lease sum while busy', async () => {
  let now = 0; const heartbeat = createLoopHeartbeat({ pollMs: 100, busyLimitMs: 1200000, clock: () => now });
  await heartbeat.check(); now = 300; await heartbeat.check(); now = 301;
  await expect(heartbeat.check()).rejects.toThrow(); heartbeat.beat(true);
  now += 600000; await heartbeat.check(); now += 600000; await heartbeat.check(); now++;
  await expect(heartbeat.check()).rejects.toThrow(); heartbeat.beat(false);
  now += 300; await heartbeat.check(); now++; await expect(heartbeat.check()).rejects.toThrow();
});
it.each(['server.ts', 'processing-worker.ts'])('wires %s separately and closes probes before pools', file => {
  const source = readFileSync(resolve('packages/api/src', file), 'utf8');
  expect(source).toContain("await import('./probes.js')"); expect(source).toContain('createProbeServer(');
  expect(source).toContain('probes?.close()'); expect(source.indexOf('probes?.close()')).toBeLessThan(source.indexOf('appPool.end()'));
  if (file === 'processing-worker.ts') {
    expect(source.indexOf('const PROCESSING_TURN_LIMIT_MS')).toBeLessThan(source.indexOf('await main()'));
    expect(source.indexOf("process.argv.includes('--check')")).toBeLessThan(source.indexOf('createProbeServer('));
    expect(source).toMatch(/heartbeat.beat\(true\)[\s\S]*catch[^\n]*\n\s*heartbeat.beat\(false\)/);
  }
});
it('accepts only a literal true registry result and binds the id', async () => {
  const query = vi.fn(async () => ({ rows: [{ ok: false }] })), id = randomUUID();
  await expect(registryReleaseCheck({ query }, id)()).rejects.toThrow(/^PROBE_RELEASE_UNAVAILABLE$/);
  expect(query).toHaveBeenCalledWith('SELECT unai_private.registry_release_published($1) AS ok', [id]);
  await databaseCheck({ query })(); expect(query).toHaveBeenLastCalledWith('SELECT 1');
});
describe.runIf(Boolean(process.env.UNAI_TEST_DATABASE_URL))('database probe harness', () => {
  it('reads a published release as unai_app without owner context and fails for missing or closed resources', async () => {
    const pool = new Pool({ connectionString: process.env.UNAI_TEST_DATABASE_URL });
    try {
      await runMigrations(pool, resolve('migrations')); const client = await pool.connect(), id = randomUUID();
      try {
        await client.query('BEGIN');
        await client.query(`INSERT INTO registry_releases(id,semantic_version,git_tag,git_commit,content_hash,lifecycle,released_at,manifest,correlation_id)
          VALUES($1,'9995.0.5','registry-v9995.0.5',$2,$3,'RELEASED',now(),'{}',$4)`, [id, 'a'.repeat(40), 'b'.repeat(64), randomUUID()]);
        await client.query('SET LOCAL ROLE unai_app');
        const server = await start({ cacheMs: 0, checks: { database: databaseCheck(client), registry_release: registryReleaseCheck(client, id) } });
        expect(await get(server.port)).toMatchObject({ code: 200, body: '{"status":"ready","checks":{"database":"ok","registry_release":"ok"}}' });
        const missing = await start({ checks: { registry_release: registryReleaseCheck(client, randomUUID()) } });
        expect(await get(missing.port)).toMatchObject({ code: 503, body: '{"status":"not-ready","checks":{"registry_release":"fail"}}' });
        await Promise.all([server.close(), missing.close()]);
      } finally { await client.query('ROLLBACK'); client.release(); }
      expect((await pool.query('SELECT 1 FROM registry_releases WHERE id=$1', [id])).rowCount).toBe(0);
    } finally { await pool.end(); }
    const closed = new Pool({ connectionString: process.env.UNAI_TEST_DATABASE_URL }); await closed.end();
    const server = await start({ checks: { database: databaseCheck(closed), registry_release: registryReleaseCheck(closed, randomUUID()) } });
    expect(await get(server.port)).toMatchObject({ code: 503, body: '{"status":"not-ready","checks":{"database":"fail","registry_release":"fail"}}' });
  });
});
