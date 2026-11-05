import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { access, constants, lstat, mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { ConnectorError, capabilityOf, isWriteScope, manifestFor, requestedScopes } from '@unai/connectors';
import { createMountedSecretsProvider, createSecretsManager, isSecretHandle, parseSecretHandle }
  from '@unai/secrets';

/**
 * `pnpm connect:google` and `pnpm secret:put`: the operator commands that place a
 * connector credential in the secrets mount as a file the `mounted` provider reads
 * (ADR 0043 D6). `connect:google` runs Google's installed-app loopback flow with
 * PKCE and stores only the refresh token; `secret:put` stores a value piped on
 * stdin (a GitHub fine-grained PAT, an Omi key). Both print the handle and never a
 * credential. This module has no side effects: `connect-google-cli.ts` is the
 * process entry, and nothing on the API or worker path imports either file.
 */

export interface ConnectCliIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  stdout(line: string): void;
  stderr(line: string): void;
  /** Called only by `secret:put`, so the Google flow never touches stdin. */
  stdin(): AsyncIterable<string | Uint8Array> & { readonly isTTY?: boolean };
  readonly fetch: typeof fetch;
  openBrowser(url: string): void;
  readonly callbackTimeoutMs?: number;
}

const USAGE_INVALID = 'CONNECT_USAGE_INVALID';
const INPUT_LIMIT = 64 * 1024;
/** A stable code, optionally suffixed with a variable name or handle parts. */
const CODE = /^[A-Z][A-Z0-9_]*(?::[A-Za-z0-9_./#-]+)?$/;
const DETAIL_KEYS = ['capabilityId', 'status', 'error', 'missing', 'unexpected'] as const;
const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CALLBACK_TIMEOUT_MS = 5 * 60_000;
/** RFC 6749 section 5.2 codes; any other provider text is reported as null. */
const OAUTH_ERRORS = new Set(['invalid_request', 'invalid_client', 'invalid_grant', 'unauthorized_client',
  'unsupported_grant_type', 'invalid_scope']);

interface Target { readonly handle: string; readonly path: string }
interface Client { readonly id: string; readonly secret: string }
interface Authorization { readonly code: string; readonly redirectUri: string; readonly verifier: string }
interface Settle { resolve(code: string): void; reject(error: Error): void }

export async function runConnectCli(argv: readonly string[], io: ConnectCliIo): Promise<number> {
  const [command, ...args] = argv;
  try {
    if (command === 'google') return await connectGoogle(args, io);
    if (command === 'secret:put') return await secretPut(args, io);
    throw new ConnectorError(USAGE_INVALID);
  } catch (error) {
    io.stderr(failureLine(command === 'secret:put' ? 'secret.failed' : 'connect.failed', error));
    return error instanceof Error && error.message === USAGE_INVALID ? 2 : 1;
  }
}

/** `--open`: the platform's URL handler, spawned without a shell so the URL stays one
 * argument. Without a handler the run continues: the URL is already printed. */
export function openBrowser(url: string): void {
  const [command, args]: [string, string[]] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : ['xdg-open', [url]];
  const child = spawn(command, args, { stdio: 'ignore', detached: true });
  child.on('error', () => { process.stdout.write('Could not start a browser: open the URL above in a browser.\n'); });
  child.unref();
}

/** The one failure line: a stable code and allowlisted detail, never a foreign
 * error's text, cause or stack. */
function failureLine(event: string, error: unknown): string {
  const code = error instanceof Error && CODE.test(error.message) ? error.message : 'CONNECT_FAILED';
  const detail: Record<string, unknown> = {};
  if (error instanceof ConnectorError) {
    for (const key of DETAIL_KEYS) if (Object.hasOwn(error.detail, key)) detail[key] = error.detail[key];
  }
  return JSON.stringify({ event, code, ...detail });
}

function help(io: ConnectCliIo): number {
  const ids = ['GMAIL', 'GOOGLE_CALENDAR']
    .flatMap(type => manifestFor(type).capabilities.map(entry => entry.capabilityId));
  for (const line of [
    'Usage:',
    '  pnpm connect:google --capabilities <ids> [--secret-name <name>] [--port <1024-65535>] [--open] [--replace]',
    '  pnpm secret:put <name> [--replace]        (reads the value from stdin; pipe it, never type it)',
    '',
    `Read-only capabilities for --capabilities (comma-separated): ${ids.join(', ')}`,
    '--secret-name defaults to connectors/google. Both commands read UNAI_SECRETS_MOUNT; connect:google also',
    'reads UNAI_GOOGLE_CONNECTOR_CLIENT (the Uai connectors Desktop app OAuth client, ADR 0043 D6).',
    'Each writes one file, <UNAI_SECRETS_MOUNT>/<name> at mode 0600 (never replaced without --replace),',
    'and prints its handle secret://mounted/<name>. No token is ever printed.',
  ]) io.stdout(line);
  return 0;
}

/** Turns any parseArgs refusal into the usage code without its message. */
function parsed<T>(read: () => T): T {
  try { return read(); } catch { throw new ConnectorError(USAGE_INVALID); }
}

async function secretPut(args: readonly string[], io: ConnectCliIo): Promise<number> {
  const { values, positionals } = parsed(() => parseArgs({ args: [...args], strict: true, allowPositionals: true,
    options: { replace: { type: 'boolean' }, help: { type: 'boolean' } } }));
  if (values.help) return help(io);
  const [name] = positionals;
  if (positionals.length !== 1 || name === undefined) throw new ConnectorError(USAGE_INVALID);
  const replace = values.replace === true;
  const target = targetOf(await mountOf(io.env), name);
  await assertWritable(target.path, replace);
  await writeSecret(target.path, await readPiped(io.stdin()), replace);
  io.stdout(JSON.stringify({ event: 'secret.stored', handle: target.handle }));
  return 0;
}

async function connectGoogle(args: readonly string[], io: ConnectCliIo): Promise<number> {
  const { values } = parsed(() => parseArgs({ args: [...args], strict: true, allowPositionals: false,
    options: { capabilities: { type: 'string' }, 'secret-name': { type: 'string' }, port: { type: 'string' },
      open: { type: 'boolean' }, replace: { type: 'boolean' }, help: { type: 'boolean' } } }));
  if (values.help) return help(io);
  const ids = capabilityIds(values.capabilities);
  const port = portOf(values.port);
  const scopes = scopesFor(ids);
  const mount = await mountOf(io.env);
  const clientHandle = clientHandleOf(io.env);
  const target = targetOf(mount, values['secret-name'] ?? 'connectors/google');
  if (target.handle === clientHandle) throw new ConnectorError('CONNECT_SECRET_NAME_RESERVED');
  const replace = values.replace === true;
  await assertWritable(target.path, replace);
  const secrets = createSecretsManager({ mounted: createMountedSecretsProvider(mount) });
  const client: Client = { id: await secrets.resolve(clientHandle + '#client_id'),
    secret: await secrets.resolve(clientHandle + '#client_secret') };
  const authorization = await authorize(io, port, client.id, scopes, values.open === true);
  const refreshToken = await exchange(io, client, authorization, scopes);
  await writeSecret(target.path, refreshToken, replace);
  io.stdout(JSON.stringify({ event: 'connect.stored', handle: target.handle, scopes }));
  return 0;
}

/** Google's installed-app flow: PKCE S256 and `state`, one listener on 127.0.0.1
 * only, closed with its timer on every exit path so the command never hangs. */
async function authorize(io: ConnectCliIo, port: number, clientId: string, scopes: readonly string[],
  open: boolean): Promise<Authorization> {
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(16).toString('base64url');
  let settle: Settle = { resolve: () => undefined, reject: () => undefined };
  const code = new Promise<string>((resolve, reject) => { settle = { resolve, reject }; });
  const server = createServer((request, response) => { answerCallback(request, response, state, settle); });
  let timer: NodeJS.Timeout | undefined;
  try {
    const redirectUri = `http://127.0.0.1:${await listen(server, port)}/callback`;
    const url = `${AUTHORIZE_URL}?${new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri,
      response_type: 'code', scope: scopes.join(' '), state, access_type: 'offline', prompt: 'consent',
      include_granted_scopes: 'false', code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url') })}`;
    const timeoutMs = io.callbackTimeoutMs ?? CALLBACK_TIMEOUT_MS;
    io.stdout('Open this URL in a browser signed in to the Google account to connect:');
    io.stdout(url);
    io.stdout(`Waiting ${Math.ceil(timeoutMs / 1000)} s for Google to redirect to ${redirectUri}`);
    if (open) io.openBrowser(url);
    timer = setTimeout(() => { settle.reject(new ConnectorError('CONNECT_TIMEOUT')); }, timeoutMs);
    return { code: await code, redirectUri, verifier };
  } finally {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections();
  }
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.on('error', () => { reject(new ConnectorError('CONNECT_PORT_UNAVAILABLE')); });
    server.listen(port, '127.0.0.1', () => { resolve((server.address() as AddressInfo).port); });
  });
}

/** Fixed text that never echoes a query value. Any other path (a favicon request)
 * is a 404 and the listener keeps waiting; the run settles once the reply is sent. */
function answerCallback(request: IncomingMessage, response: ServerResponse, state: string, settle: Settle): void {
  const url = URL.parse(request.url ?? '/', 'http://127.0.0.1');
  const outcome = url?.pathname === '/callback' ? callbackOutcome(url.searchParams, state) : null;
  const status = outcome === null ? 404 : typeof outcome === 'string' ? 200 : 400;
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store',
    connection: 'close' });
  response.end(status === 404 ? 'Not found.' : status === 200
    ? 'Uai received the authorization. Return to the terminal.'
    : 'Uai could not complete the connection. Return to the terminal.', () => {
    if (typeof outcome === 'string') settle.resolve(outcome); else if (outcome !== null) settle.reject(outcome);
  });
}

function callbackOutcome(query: URLSearchParams, state: string): string | ConnectorError {
  if (query.get('state') !== state) return new ConnectorError('CONNECT_STATE_MISMATCH');
  if (query.get('error') === 'access_denied') return new ConnectorError('CONNECT_CONSENT_DENIED');
  const code = query.get('code');
  return query.has('error') || !code ? new ConnectorError('CONNECT_AUTHORIZATION_FAILED') : code;
}

/** Returns only a refresh token whose granted scope set equals the requested one
 * (an owner may untick a scope); the access token is never read. */
async function exchange(io: ConnectCliIo, client: Client, authorization: Authorization,
  scopes: readonly string[]): Promise<string> {
  const body = await tokenResponse(io, new URLSearchParams({ grant_type: 'authorization_code',
    code: authorization.code, redirect_uri: authorization.redirectUri, client_id: client.id,
    client_secret: client.secret, code_verifier: authorization.verifier }));
  const { refresh_token: refreshToken, scope } = body;
  if (refreshToken === undefined) throw new ConnectorError('CONNECT_REFRESH_TOKEN_MISSING');
  if (typeof refreshToken !== 'string' || !/^[\x21-\x7e]+$/.test(refreshToken)
    || typeof scope !== 'string' || scope.trim() === '') {
    throw new ConnectorError('CONNECT_PROVIDER_RESPONSE_INVALID');
  }
  const granted = new Set(scope.trim().split(/\s+/));
  const missing = scopes.filter(entry => !granted.has(entry));
  const unexpected = [...granted].filter(entry => !scopes.includes(entry)).sort();
  if (missing.length + unexpected.length > 0) {
    throw new ConnectorError('CONNECT_SCOPES_NOT_GRANTED', { missing, unexpected });
  }
  return refreshToken;
}

/** The token endpoint's JSON object. A transport failure binds nothing and passes no
 * cause: its text can quote the request, which carries the code and client secret. */
async function tokenResponse(io: ConnectCliIo, body: URLSearchParams): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await io.fetch(TOKEN_URL, { method: 'POST', redirect: 'error', body,
      signal: AbortSignal.timeout(30_000),
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' } });
  } catch {
    throw new ConnectorError('CONNECT_PROVIDER_UNAVAILABLE', { status: null });
  }
  const json: unknown = await response.json().catch(() => null);
  const fields = typeof json === 'object' && json !== null && !Array.isArray(json)
    ? json as Record<string, unknown> : null;
  if (!response.ok) {
    const error = typeof fields?.error === 'string' && OAUTH_ERRORS.has(fields.error) ? fields.error : null;
    throw new ConnectorError('CONNECT_TOKEN_EXCHANGE_FAILED', { status: response.status, error });
  }
  if (fields === null) throw new ConnectorError('CONNECT_PROVIDER_RESPONSE_INVALID');
  return fields;
}

function capabilityIds(value: string | undefined): string[] {
  const ids = [...new Set((value ?? '').split(',').map(id => id.trim()).filter(id => id !== ''))];
  if (ids.length === 0) throw new ConnectorError(USAGE_INVALID);
  return ids;
}

/** 0 asks the OS for a free port; an explicit one is for `ssh -L` forwarding. */
function portOf(value: string | undefined): number {
  if (value === undefined) return 0;
  const port = /^[0-9]{4,5}$/.test(value) ? Number(value) : 0;
  if (port < 1024 || port > 65535) throw new ConnectorError(USAGE_INVALID);
  return port;
}

/** Refuses an unknown or write capability by name, then asks for exactly the
 * read-only scopes the named Gmail and Calendar capabilities need. */
function scopesFor(ids: readonly string[]): string[] {
  const grants = new Map<string, string[]>();
  for (const id of ids) {
    const type = id.startsWith('gmail.') ? 'GMAIL' : id.startsWith('calendar.') ? 'GOOGLE_CALENDAR' : null;
    if (type === null) throw new ConnectorError('CONNECTOR_CAPABILITY_UNKNOWN', { capabilityId: id });
    capabilityOf(manifestFor(type), id);
    grants.set(type, [...(grants.get(type) ?? []), id]);
  }
  const scopes = [...grants].flatMap(([type, granted]) => requestedScopes(manifestFor(type), granted)).sort();
  if (scopes.some(isWriteScope)) throw new ConnectorError('CONNECTOR_WRITE_SCOPE_REFUSED');
  return scopes;
}

/** The Uai connectors client (ADR 0043 D6), required here: the refresh token it
 * mints refreshes only with that same client, so the sign-in client never stands in. */
function clientHandleOf(env: ConnectCliIo['env']): string {
  const handle = env.UNAI_GOOGLE_CONNECTOR_CLIENT;
  if (!handle) throw new ConnectorError('CONFIG_REQUIRED:UNAI_GOOGLE_CONNECTOR_CLIENT');
  if (!isSecretHandle(handle)) throw new ConnectorError('SECRET_HANDLE_REQUIRED:UNAI_GOOGLE_CONNECTOR_CLIENT');
  if (parseSecretHandle(handle).field !== null) throw new ConnectorError('CONFIG_INVALID:UNAI_GOOGLE_CONNECTOR_CLIENT');
  return handle;
}

/** The mount must already exist as a directory, so a typo never creates a tree. */
async function mountOf(env: ConnectCliIo['env']): Promise<string> {
  const mount = env.UNAI_SECRETS_MOUNT;
  if (!mount) throw new ConnectorError('CONFIG_REQUIRED:UNAI_SECRETS_MOUNT');
  const found = await stat(mount).catch(() => null);
  if (!found?.isDirectory()) throw new ConnectorError('CONFIG_INVALID:UNAI_SECRETS_MOUNT');
  return resolve(mount);
}

/** The handle grammar refuses '..', '.', empty segments, a leading '/' and any
 * separator but '/'; the path check repeats it as the mounted provider does. */
function targetOf(mount: string, name: string): Target {
  const handle = 'secret://mounted/' + name;
  const handleParts = parseSecretHandle(handle);
  const path = resolve(mount, ...name.split('/'));
  if (handleParts.field !== null || handleParts.name !== name || !path.startsWith(mount + sep)) {
    throw new ConnectorError('SECRET_HANDLE_INVALID');
  }
  return { handle, path };
}

/** Refuses up front what the writer would refuse after consent: an existing target
 * without --replace, or a nearest existing directory this user cannot write. */
async function assertWritable(path: string, replace: boolean): Promise<void> {
  if (!replace) {
    const absent = await lstat(path).then(() => false, (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return true;
      throw new ConnectorError('CONNECT_SECRET_WRITE_FAILED');
    });
    if (!absent) throw new ConnectorError('CONNECT_SECRET_EXISTS');
  }
  let directory = dirname(path);
  while (!(await stat(directory).catch(() => null))?.isDirectory()) directory = dirname(directory);
  await access(directory, constants.W_OK).catch(() => { throw new ConnectorError('CONNECT_SECRET_WRITE_FAILED'); });
}

/** Creates the file exclusively at 0600 (or a temporary file renamed over the
 * target with --replace), so a concurrent run gets CONNECT_SECRET_EXISTS and a
 * failure leaves neither a partial secret nor a temporary file behind. */
async function writeSecret(path: string, value: string, replace: boolean): Promise<void> {
  const file = replace ? `${path}.${randomBytes(6).toString('hex')}.tmp` : path;
  let created = false;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const handle = await open(file, 'wx', 0o600);
    created = true;
    try { await handle.writeFile(value); await handle.sync(); } finally { await handle.close(); }
    if (replace) await rename(file, path);
  } catch (error) {
    if (created) await unlink(file).catch(() => undefined);
    const exists = !created && (error as NodeJS.ErrnoException).code === 'EEXIST';
    throw new ConnectorError(exists ? 'CONNECT_SECRET_EXISTS' : 'CONNECT_SECRET_WRITE_FAILED');
  }
}

async function readPiped(stdin: ReturnType<ConnectCliIo['stdin']>): Promise<string> {
  if (stdin.isTTY) throw new ConnectorError('CONNECT_INPUT_TERMINAL');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stdin) {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
    size += bytes.length;
    if (size > INPUT_LIMIT) throw new ConnectorError('CONNECT_INPUT_TOO_LARGE');
    chunks.push(bytes);
  }
  const value = Buffer.concat(chunks).toString('utf8').trim();
  if (value === '') throw new ConnectorError('CONNECT_INPUT_EMPTY');
  return value;
}
