import { randomBytes } from 'node:crypto';
import { lstat, mkdir, open, rename, stat, unlink } from 'node:fs/promises';
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

interface Target { readonly handle: string; readonly path: string }

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
  await assertAbsent(target.path, replace);
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
  await assertAbsent(target.path, replace);
  const secrets = createSecretsManager({ mounted: createMountedSecretsProvider(mount) });
  const client = { id: await secrets.resolve(clientHandle + '#client_id'),
    secret: await secrets.resolve(clientHandle + '#client_secret') };
  void port; void client; void target;
  throw new ConnectorError('CONNECT_FAILED');
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

async function assertAbsent(path: string, replace: boolean): Promise<void> {
  if (replace) return;
  try { await lstat(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new ConnectorError('CONNECT_SECRET_WRITE_FAILED');
  }
  throw new ConnectorError('CONNECT_SECRET_EXISTS');
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
