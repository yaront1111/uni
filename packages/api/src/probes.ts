import { X509Certificate } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { isIPv4, isIPv6 } from 'node:net';

export type ProbeCheck = () => Promise<unknown>;
type Log = (line: string) => void;
type ClockOptions = { clock?: () => number };
type Database = { query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> };
type Results = Record<string, 'ok' | 'fail'>;
const logLine: Log = line => console.info(line);
const logStatus = (log: Log, status: 'PROBES_DISABLED' | 'TLS_CERT_EXPIRING') => log(JSON.stringify({ event: 'probes', status }));

function assertLoopback(bind: string): void {
  if (isIPv4(bind) && bind.startsWith('127.')) return;
  // URL canonicalizes expanded IPv6. Reject zones, mapped IPv4 and hostnames.
  if (isIPv6(bind) && !bind.includes('%') && new URL(`http://[${bind}]/`).hostname === '[::1]') return;
  throw new Error('PROBE_BIND_NOT_LOOPBACK');
}

export function probeConfiguration(env: NodeJS.ProcessEnv, log: Log = logLine): { bind: string; port: number } | null {
  const port = env.UNAI_PROBE_PORT;
  if (!port) { logStatus(log, 'PROBES_DISABLED'); return null; }
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('PROBE_PORT_INVALID');
  const bind = env.UNAI_PROBE_BIND || '127.0.0.1';
  assertLoopback(bind);
  return { bind, port: Number(port) };
}

export function cachedCheck<T>(check: () => Promise<T>, ttlMs: number, options?: ClockOptions & { primed?: false }): () => Promise<T>;
export function cachedCheck(check: ProbeCheck, ttlMs: number, options: ClockOptions & { primed: boolean }): ProbeCheck;
export function cachedCheck(check: ProbeCheck, ttlMs: number, { primed = false, clock = Date.now }: ClockOptions & { primed?: boolean } = {}): ProbeCheck {
  let result: Promise<unknown> | undefined = primed ? Promise.resolve() : undefined;
  let expires = clock() + ttlMs, pending = false;
  return () => {
    if (!result || (!pending && clock() >= expires)) {
      expires = clock() + ttlMs; pending = true;
      // Retain the promise even after the caller times out. No overlapping S3 re-checks.
      result = Promise.resolve().then(check).finally(() => { pending = false; });
    }
    return result;
  };
}

async function bounded(check: ProbeCheck, timeoutMs: number): Promise<'ok' | 'fail'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(check).then(() => 'ok' as const, () => 'fail' as const),
      new Promise<'fail'>(resolve => { timer = setTimeout(() => resolve('fail'), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function evaluate(checks: Record<string, ProbeCheck>, timeoutMs: number): Promise<Results> {
  return Object.fromEntries(await Promise.all(Object.entries(checks).map(async ([name, check]) => [name, await bounded(check, timeoutMs)])));
}

async function respond(req: IncomingMessage, res: ServerResponse, ready: () => Promise<Results>): Promise<void> {
  res.sendDate = false;
  if (req.method !== 'GET') { res.writeHead(405, { Allow: 'GET', 'content-length': 0 }); res.end(); return; }
  if (req.url !== '/healthz' && req.url !== '/readyz') { res.writeHead(404, { 'content-length': 0 }); res.end(); return; }
  let code = 200, body: object = { status: 'ok' };
  if (req.url === '/readyz') {
    const checks = await ready(), ok = Object.values(checks).every(value => value === 'ok');
    code = ok ? 200 : 503; body = { status: ok ? 'ready' : 'not-ready', checks };
  }
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

export async function createProbeServer({ bind, port, checks, cacheMs = 10000, timeoutMs = 2000, clock = Date.now }: {
  bind: string; port: number; checks: Record<string, ProbeCheck>; cacheMs?: number; timeoutMs?: number; clock?: () => number;
}): Promise<{ port: number; close(): Promise<void> }> {
  assertLoopback(bind);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PROBE_PORT_INVALID');
  const ready = cachedCheck(() => evaluate(checks, timeoutMs), cacheMs, { clock });
  const server = createServer({ requestTimeout: 5000, headersTimeout: 5000 }, (req, res) => { void respond(req, res, ready); });
  // Node routes CONNECT outside the request callback; never open a tunnel.
  server.on('connect', (_req, socket) => {
    socket.end('HTTP/1.1 405 Method Not Allowed\r\nAllow: GET\r\nContent-Length: 0\r\nConnection: close\r\n\r\n', () => socket.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', () => reject(new Error('PROBE_LISTEN_FAILED')));
    server.listen(port, bind, resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('PROBE_LISTEN_FAILED');
  let closing: Promise<void> | undefined;
  return { port: address.port, close: () => closing ??= new Promise<void>(resolve => {
    server.close(() => resolve()); server.closeAllConnections();
  }) };
}

export function databaseCheck(db: Database): ProbeCheck {
  return () => db.query('SELECT 1');
}

export function registryReleaseCheck(db: Database, releaseId: string): ProbeCheck {
  return async () => {
    const row = (await db.query('SELECT unai_private.registry_release_published($1) AS ok', [releaseId])).rows[0];
    if (!row || typeof row !== 'object' || !('ok' in row) || row.ok !== true) throw new Error('PROBE_RELEASE_UNAVAILABLE');
  };
}

export function certificateCheck(certificate: string | Buffer, { clock = Date.now, log = logLine }: ClockOptions & { log?: Log } = {}): ProbeCheck {
  let expires: number;
  try { expires = new X509Certificate(certificate).validToDate.getTime(); }
  catch { throw new Error('TLS_CERTIFICATE_INVALID'); }
  if (!Number.isFinite(expires)) throw new Error('TLS_CERTIFICATE_INVALID');
  let lastWarning = -Infinity;
  return async () => {
    const now = clock();
    if (now >= expires) throw new Error('TLS_CERTIFICATE_INVALID');
    if (expires - now < 7 * 86400000 && now - lastWarning >= 86400000) {
      lastWarning = now; logStatus(log, 'TLS_CERT_EXPIRING');
    }
  };
}

export function createLoopHeartbeat({ pollMs, busyLimitMs, clock = Date.now }: ClockOptions & { pollMs: number; busyLimitMs: number }): { beat(busy: boolean): void; check: ProbeCheck } {
  let lastBeat = clock(), busy = false;
  return {
    beat(value) { lastBeat = clock(); busy = value; },
    async check() {
      if (clock() - lastBeat > (busy ? busyLimitMs : 3 * pollMs)) throw new Error('PROBE_LOOP_STALLED');
    },
  };
}
