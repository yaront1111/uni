import { afterEach, beforeEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createMountedSecretsProvider, createSecretsManager } from '@unai/secrets';
import { runConnectCli, type ConnectCliIo } from './connect-google.js';

const CLIENT_HANDLE = 'secret://mounted/google-connector-client';
const POSIX = process.platform !== 'win32';
let mount = '';

beforeEach(async () => { mount = await mkdtemp(join(tmpdir(), 'unai-connect-')); });
afterEach(async () => { await rm(mount, { recursive: true, force: true }); });

interface Recorded { readonly url: string; readonly body: URLSearchParams; readonly init: RequestInit | undefined }
interface Harness {
  readonly io: ConnectCliIo; readonly out: string[]; readonly err: string[];
  readonly requests: Recorded[]; readonly opened: string[]; readonly consent: Promise<URL>;
}
interface HarnessOptions {
  readonly env?: Readonly<Record<string, string | undefined>>; readonly stdin?: string; readonly tty?: boolean;
  readonly respond?: () => Promise<Response>; readonly timeoutMs?: number;
}

function harness(options: HarnessOptions = {}): Harness {
  const out: string[] = [], err: string[] = [], requests: Recorded[] = [], opened: string[] = [];
  let seen: (url: URL) => void = () => undefined;
  const consent = new Promise<URL>(resolve => { seen = resolve; });
  const io: ConnectCliIo = {
    env: options.env ?? { UNAI_SECRETS_MOUNT: mount, UNAI_GOOGLE_CONNECTOR_CLIENT: CLIENT_HANDLE },
    stdout: line => { out.push(line); if (line.startsWith('https://accounts.google.com/')) seen(new URL(line)); },
    stderr: line => { err.push(line); },
    stdin: () => Object.assign(Readable.from(options.stdin === undefined ? [] : [Buffer.from(options.stdin)]),
      { isTTY: options.tty ?? false }),
    fetch: async (input, init) => {
      requests.push({ url: String(input), body: new URLSearchParams(String(init?.body ?? '')), init });
      if (!options.respond) throw new Error('UNEXPECTED_FETCH');
      return options.respond();
    },
    openBrowser: url => { opened.push(url); },
    ...(options.timeoutMs === undefined ? {} : { callbackTimeoutMs: options.timeoutMs }),
  };
  return { io, out, err, requests, opened, consent };
}

/** The single stderr failure line, parsed. */
function failure(run: Harness): Record<string, unknown> {
  expect(run.err).toHaveLength(1);
  return JSON.parse(run.err[0]!) as Record<string, unknown>;
}

async function mode(path: string): Promise<number> { return (await stat(path)).mode & 0o777; }

async function listing(): Promise<string[]> {
  return (await readdir(mount, { recursive: true })).map(String).sort();
}

it('--help prints the usage with the Google capability ids, reads no variable and makes no request', async () => {
  for (const command of ['google', 'secret:put']) {
    const run = harness({ env: {} });
    expect(await runConnectCli([command, '--help'], run.io)).toBe(0);
    const usage = run.out.join('\n');
    for (const text of ['pnpm connect:google', 'pnpm secret:put', 'gmail.read_metadata', 'gmail.read_content',
      'gmail.search', 'calendar.read', '--capabilities', '--secret-name', '--replace']) expect(usage).toContain(text);
    expect(run.err).toEqual([]);
    expect(run.requests).toEqual([]);
  }
});

it.each([
  [['google', '--bogus']], [['google', 'extra']], [['secret:put']], [['secret:put', 'a', 'b']],
  [['secret:put', 'a', '--port', '9000']], [['unknown']], [[]],
])('a usage error exits 2 with CONNECT_USAGE_INVALID: %j', async argv => {
  const run = harness();
  expect(await runConnectCli(argv, run.io)).toBe(2);
  expect(failure(run).code).toBe('CONNECT_USAGE_INVALID');
  expect(run.out).toEqual([]);
});

it.skipIf(!POSIX)('secret:put stores the trimmed piped value at 0600 and prints only the handle', async () => {
  const value = 'github_pat_SENTINEL_0123456789';
  const run = harness({ stdin: `  ${value}\n` });
  expect(await runConnectCli(['secret:put', 'connectors/github'], run.io)).toBe(0);
  expect(run.out).toEqual(['{"event":"secret.stored","handle":"secret://mounted/connectors/github"}']);
  expect(run.err).toEqual([]);
  const path = join(mount, 'connectors', 'github');
  expect(await readFile(path, 'utf8')).toBe(value);
  expect(await mode(path)).toBe(0o600);
  const secrets = createSecretsManager({ mounted: createMountedSecretsProvider(mount) });
  expect(await secrets.resolve('secret://mounted/connectors/github')).toBe(value);
});

it('secret:put never replaces an existing secret without --replace', async () => {
  await mkdir(join(mount, 'connectors'));
  await writeFile(join(mount, 'connectors', 'github'), 'previous');
  const run = harness({ stdin: 'next-value' });
  expect(await runConnectCli(['secret:put', 'connectors/github'], run.io)).toBe(1);
  expect(failure(run)).toEqual({ event: 'secret.failed', code: 'CONNECT_SECRET_EXISTS' });
  expect(run.out).toEqual([]);
  expect(await readFile(join(mount, 'connectors', 'github'), 'utf8')).toBe('previous');
});

it.skipIf(!POSIX)('secret:put --replace swaps the secret in at 0600 and leaves no temporary file', async () => {
  await mkdir(join(mount, 'connectors'));
  await writeFile(join(mount, 'connectors', 'github'), 'previous', { mode: 0o644 });
  const run = harness({ stdin: 'next-value\n' });
  expect(await runConnectCli(['secret:put', 'connectors/github', '--replace'], run.io)).toBe(0);
  expect(await readFile(join(mount, 'connectors', 'github'), 'utf8')).toBe('next-value');
  expect(await mode(join(mount, 'connectors', 'github'))).toBe(0o600);
  expect(await listing()).toEqual(['connectors', join('connectors', 'github')]);
});

it.each([
  { label: 'a terminal', stdin: 'typed', tty: true, code: 'CONNECT_INPUT_TERMINAL' },
  { label: 'blank input', stdin: ' \n\t', tty: false, code: 'CONNECT_INPUT_EMPTY' },
  { label: 'input over 64 KiB', stdin: 'a'.repeat(64 * 1024 + 1), tty: false, code: 'CONNECT_INPUT_TOO_LARGE' },
])('secret:put refuses $label and writes nothing', async ({ stdin, tty, code }) => {
  const run = harness({ stdin, tty });
  expect(await runConnectCli(['secret:put', 'connectors/github'], run.io)).toBe(1);
  expect(failure(run)).toEqual({ event: 'secret.failed', code });
  expect(run.out).toEqual([]);
  expect(await listing()).toEqual([]);
});

it.each(['../x', 'a//b', 'x#y', '/abs', 'a/./b', 'a\\b'])('secret:put refuses the name %j as a handle', async name => {
  const run = harness({ stdin: 'value' });
  expect(await runConnectCli(['secret:put', name], run.io)).toBe(1);
  expect(failure(run)).toEqual({ event: 'secret.failed', code: 'SECRET_HANDLE_INVALID' });
  expect(await listing()).toEqual([]);
});

it('secret:put needs an existing mount directory and never creates one', async () => {
  const missing = join(mount, 'missing');
  await writeFile(join(mount, 'file'), '');
  const cases: [Record<string, string | undefined>, string][] = [
    [{}, 'CONFIG_REQUIRED:UNAI_SECRETS_MOUNT'],
    [{ UNAI_SECRETS_MOUNT: '' }, 'CONFIG_REQUIRED:UNAI_SECRETS_MOUNT'],
    [{ UNAI_SECRETS_MOUNT: missing }, 'CONFIG_INVALID:UNAI_SECRETS_MOUNT'],
    [{ UNAI_SECRETS_MOUNT: join(mount, 'file') }, 'CONFIG_INVALID:UNAI_SECRETS_MOUNT'],
  ];
  for (const [env, code] of cases) {
    const run = harness({ env, stdin: 'value' });
    expect(await runConnectCli(['secret:put', 'connectors/github'], run.io)).toBe(1);
    expect(failure(run)).toEqual({ event: 'secret.failed', code });
  }
  expect(await listing()).toEqual(['file']);
});

const CLIENT_ID = 'client-id-0123.apps.googleusercontent.com';
const CLIENT_SECRET = 'GOCSPX-client-secret-SENTINEL';
const READ_IDS = 'gmail.read_metadata,gmail.read_content,gmail.search,calendar.read';

async function writeClient(document: unknown = { client_id: CLIENT_ID, client_secret: CLIENT_SECRET }): Promise<void> {
  await writeFile(join(mount, 'google-connector-client'), typeof document === 'string' ? document : JSON.stringify(document));
}

it.each(['gmail.send', 'calendar.create', 'gmail.create_draft'])(
  'google refuses the write capability %s by name before any listener, URL or request', async capabilityId => {
    await writeClient();
    const before = await listing();
    const run = harness({ respond: async () => new Response('{}') });
    const argv = ['google', '--capabilities', `gmail.read_metadata,${capabilityId},calendar.read`, '--open'];
    expect(await runConnectCli(argv, run.io)).toBe(1);
    expect(failure(run)).toEqual({ event: 'connect.failed', code: 'CONNECTOR_WRITE_SCOPE_REFUSED', capabilityId });
    expect(run.out).toEqual([]);
    expect(run.requests).toEqual([]);
    expect(run.opened).toEqual([]);
    expect(await listing()).toEqual(before);
  });

it.each(['github.read_issues', 'gmail.read_everything', 'omi.read_conversations'])(
  'google refuses the unknown capability %s by name', async capabilityId => {
    await writeClient();
    const run = harness();
    expect(await runConnectCli(['google', '--capabilities', `calendar.read,${capabilityId}`], run.io)).toBe(1);
    expect(failure(run)).toEqual({ event: 'connect.failed', code: 'CONNECTOR_CAPABILITY_UNKNOWN', capabilityId });
    expect(run.out).toEqual([]);
  });

it.each([
  { label: 'unset', value: undefined, code: 'CONFIG_REQUIRED:UNAI_GOOGLE_CONNECTOR_CLIENT' },
  { label: 'empty', value: '', code: 'CONFIG_REQUIRED:UNAI_GOOGLE_CONNECTOR_CLIENT' },
  { label: 'a literal', value: 'GOCSPX-literal-SENTINEL', code: 'SECRET_HANDLE_REQUIRED:UNAI_GOOGLE_CONNECTOR_CLIENT' },
  { label: 'a #field handle', value: `${CLIENT_HANDLE}#client_id`, code: 'CONFIG_INVALID:UNAI_GOOGLE_CONNECTOR_CLIENT' },
  { label: 'an absent client file', value: 'secret://mounted/absent-client', code: 'SECRET_UNAVAILABLE:mounted/absent-client' },
])('google refuses a client variable that is $label before any URL', async ({ value, code }) => {
  await writeClient();
  // The sign-in client's variables are never a fallback: a refresh token refreshes only with its minting client.
  const run = harness({ env: { UNAI_SECRETS_MOUNT: mount, UNAI_GOOGLE_CONNECTOR_CLIENT: value,
    GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: CLIENT_HANDLE } });
  expect(await runConnectCli(['google', '--capabilities', READ_IDS], run.io)).toBe(1);
  expect(failure(run)).toEqual({ event: 'connect.failed', code });
  expect(run.out).toEqual([]);
  expect(run.err.join('\n')).not.toContain('SENTINEL');
});

it.each([
  { label: 'without client_secret', document: { client_id: CLIENT_ID },
    code: 'SECRET_FIELD_MISSING:mounted/google-connector-client#client_secret' },
  { label: 'without client_id', document: { client_secret: CLIENT_SECRET },
    code: 'SECRET_FIELD_MISSING:mounted/google-connector-client#client_id' },
  { label: 'that is not JSON', document: `client_secret=${CLIENT_SECRET}`,
    code: 'SECRET_NOT_STRUCTURED:mounted/google-connector-client' },
])('google refuses a client secret $label before any URL', async ({ document, code }) => {
  await writeClient(document);
  const run = harness();
  expect(await runConnectCli(['google', '--capabilities', READ_IDS], run.io)).toBe(1);
  expect(failure(run)).toEqual({ event: 'connect.failed', code });
  expect(run.out).toEqual([]);
  expect(run.err.join('\n')).not.toContain('SENTINEL');
});

it('google never targets the client secret itself, even with --replace', async () => {
  await writeClient();
  for (const extra of [[], ['--replace']]) {
    const run = harness();
    const argv = ['google', '--capabilities', READ_IDS, '--secret-name', 'google-connector-client', ...extra];
    expect(await runConnectCli(argv, run.io)).toBe(1);
    expect(failure(run)).toEqual({ event: 'connect.failed', code: 'CONNECT_SECRET_NAME_RESERVED' });
    expect(run.out).toEqual([]);
  }
  expect(JSON.parse(await readFile(join(mount, 'google-connector-client'), 'utf8')))
    .toEqual({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET });
});

it('google refuses an existing default target without --replace before any URL', async () => {
  await writeClient();
  await mkdir(join(mount, 'connectors'));
  await writeFile(join(mount, 'connectors', 'google'), 'previous-refresh-token');
  const run = harness();
  expect(await runConnectCli(['google', '--capabilities', READ_IDS, '--open'], run.io)).toBe(1);
  expect(failure(run)).toEqual({ event: 'connect.failed', code: 'CONNECT_SECRET_EXISTS' });
  expect(run.out).toEqual([]);
  expect(run.opened).toEqual([]);
  expect(await readFile(join(mount, 'connectors', 'google'), 'utf8')).toBe('previous-refresh-token');
});

it.each([
  [['--capabilities', READ_IDS, '--port', 'abc']], [['--capabilities', READ_IDS, '--port', '80']],
  [['--capabilities', READ_IDS, '--port', '0']], [['--capabilities', READ_IDS, '--port', '65536']],
  [['--capabilities', READ_IDS, '--port', '9000.5']], [[]], [['--capabilities', ' , ']],
])('google treats %j as a usage error', async args => {
  await writeClient();
  const run = harness();
  expect(await runConnectCli(['google', ...args], run.io)).toBe(2);
  expect(failure(run)).toEqual({ event: 'connect.failed', code: 'CONNECT_USAGE_INVALID' });
  expect(run.out).toEqual([]);
});

const GMAIL_READONLY = 'https://www.googleapis.com/auth/gmail.readonly';
const GMAIL_METADATA = 'https://www.googleapis.com/auth/gmail.metadata';
const CALENDAR_READONLY = 'https://www.googleapis.com/auth/calendar.readonly';
const REFRESH = '1//refresh-token-SENTINEL-0123';
const ACCESS = 'ya29.access-token-SENTINEL-4567';
const CODE = '4/0authorization-code-SENTINEL';

function tokenResponse(fields: Record<string, unknown> = {}, status = 200): () => Promise<Response> {
  const body = { access_token: ACCESS, refresh_token: REFRESH, expires_in: 3599, token_type: 'Bearer',
    scope: `${GMAIL_READONLY} ${CALENDAR_READONLY}`, ...fields };
  return async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

interface Ceremony { readonly exit: Promise<number>; readonly url: URL; readonly redirectUri: string }

/** Starts the ceremony and waits for the consent URL, as an owner reading the terminal would. */
async function begin(run: Harness, args: readonly string[] = ['--capabilities', READ_IDS]): Promise<Ceremony> {
  const exit = runConnectCli(['google', ...args], run.io);
  const url = await Promise.race([run.consent, exit.then(code => { throw new Error(`exited ${code}: ${run.err.join(' ')}`); })]);
  return { exit, url, redirectUri: url.searchParams.get('redirect_uri') ?? '' };
}

/** Plays Google's redirect back to the loopback listener, as the browser would. */
async function redirect(ceremony: Ceremony, query: Record<string, string>): Promise<Response> {
  return fetch(`${ceremony.redirectUri}?${new URLSearchParams(query)}`);
}

function sha256(value: string): string { return createHash('sha256').update(value).digest('base64url'); }

/** Every credential the run held, none of which may reach stdout or stderr. */
function assertNoSecretPrinted(run: Harness): void {
  const printed = [...run.out, ...run.err].join('\n');
  for (const secret of ['SENTINEL', REFRESH, ACCESS, CODE, CLIENT_SECRET]) expect(printed).not.toContain(secret);
  for (const request of run.requests) expect(printed).not.toContain(request.body.get('code_verifier'));
}

async function filesUnderMount(): Promise<string[]> {
  const entries = await readdir(mount, { recursive: true, withFileTypes: true });
  return Promise.all(entries.filter(entry => entry.isFile())
    .map(entry => readFile(join(entry.parentPath, entry.name), 'utf8')));
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

it.skipIf(!POSIX)('google runs the loopback PKCE flow and stores only the refresh token at 0600', async () => {
  await writeClient();
  const run = harness({ respond: tokenResponse() });
  const ceremony = await begin(run);
  const { url } = ceremony;
  expect(`${url.origin}${url.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
  expect(url.searchParams.get('scope')).toBe(`${CALENDAR_READONLY} ${GMAIL_READONLY}`);
  for (const [key, value] of Object.entries({ access_type: 'offline', prompt: 'consent',
    include_granted_scopes: 'false', response_type: 'code', code_challenge_method: 'S256', client_id: CLIENT_ID })) {
    expect(url.searchParams.get(key)).toBe(value);
  }
  expect(ceremony.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:[0-9]+\/callback$/);
  expect(run.opened).toEqual([]);

  // Bound to 127.0.0.1 alone: the wildcard address would also answer on [::1].
  await expect(fetch(new URL('/favicon.ico', ceremony.redirectUri.replace('127.0.0.1', '[::1]')))).rejects.toThrow();
  expect((await fetch(new URL('/favicon.ico', ceremony.redirectUri))).status).toBe(404);
  const reply = await redirect(ceremony, { code: CODE, state: url.searchParams.get('state') ?? '', scope: 'x' });
  expect(reply.status).toBe(200);
  expect(reply.headers.get('cache-control')).toBe('no-store');
  expect(await reply.text()).not.toContain(CODE);
  expect(await ceremony.exit).toBe(0);

  expect(run.requests).toHaveLength(1);
  const [request] = run.requests;
  expect(request!.url).toBe('https://oauth2.googleapis.com/token');
  expect(request!.init?.method).toBe('POST');
  expect(Object.fromEntries(request!.body)).toEqual({ grant_type: 'authorization_code', code: CODE,
    redirect_uri: ceremony.redirectUri, client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
    code_verifier: request!.body.get('code_verifier') });
  expect(sha256(request!.body.get('code_verifier') ?? '')).toBe(url.searchParams.get('code_challenge'));

  const path = join(mount, 'connectors', 'google');
  expect(await readFile(path, 'utf8')).toBe(REFRESH);
  expect(await mode(path)).toBe(0o600);
  expect(JSON.parse(run.out.at(-1)!)).toEqual({ event: 'connect.stored', handle: 'secret://mounted/connectors/google',
    scopes: [CALENDAR_READONLY, GMAIL_READONLY] });
  const secrets = createSecretsManager({ mounted: createMountedSecretsProvider(mount) });
  expect(await secrets.resolve('secret://mounted/connectors/google')).toBe(REFRESH);
  expect(run.err).toEqual([]);
  assertNoSecretPrinted(run);
  for (const content of await filesUnderMount()) expect(content).not.toContain(ACCESS);
});

it('google asks for gmail.metadata alone for a metadata-only grant and stops when consent is denied', async () => {
  await writeClient();
  const run = harness();
  const ceremony = await begin(run, ['--capabilities', 'gmail.read_metadata']);
  expect(ceremony.url.searchParams.get('scope')).toBe(GMAIL_METADATA);
  const reply = await redirect(ceremony, { error: 'access_denied', state: ceremony.url.searchParams.get('state') ?? '' });
  expect(reply.status).toBe(400);
  expect(await ceremony.exit).toBe(1);
  expect(failure(run)).toEqual({ event: 'connect.failed', code: 'CONNECT_CONSENT_DENIED' });
  expect(run.requests).toEqual([]);
  expect(await listing()).toEqual(['google-connector-client']);
});

it.each([
  { label: 'a refused exchange', respond: tokenResponse({ error: 'invalid_grant',
    error_description: `${REFRESH} ${ACCESS} ${CODE} ${CLIENT_SECRET}` }, 400),
    failed: { code: 'CONNECT_TOKEN_EXCHANGE_FAILED', status: 400, error: 'invalid_grant' } },
  { label: 'an unlisted provider error', respond: tokenResponse({ error: `odd ${ACCESS}` }, 401),
    failed: { code: 'CONNECT_TOKEN_EXCHANGE_FAILED', status: 401, error: null } },
  { label: 'a server error page', respond: async () => new Response(`<html>${ACCESS}</html>`, { status: 503 }),
    failed: { code: 'CONNECT_TOKEN_EXCHANGE_FAILED', status: 503, error: null } },
  { label: 'a transport failure', respond: async () => { throw new TypeError(`fetch failed ${CLIENT_SECRET} ${CODE}`); },
    failed: { code: 'CONNECT_PROVIDER_UNAVAILABLE', status: null } },
  { label: 'no refresh token', respond: tokenResponse({ refresh_token: undefined }),
    failed: { code: 'CONNECT_REFRESH_TOKEN_MISSING' } },
  { label: 'a malformed refresh token', respond: tokenResponse({ refresh_token: `bad token\n${REFRESH}` }),
    failed: { code: 'CONNECT_PROVIDER_RESPONSE_INVALID' } },
  { label: 'no granted scope', respond: tokenResponse({ scope: undefined }),
    failed: { code: 'CONNECT_PROVIDER_RESPONSE_INVALID' } },
  { label: 'a body that is not JSON', respond: async () => new Response(`${REFRESH}`, { status: 200 }),
    failed: { code: 'CONNECT_PROVIDER_RESPONSE_INVALID' } },
  { label: 'an unticked scope', respond: tokenResponse({ scope: GMAIL_READONLY }),
    failed: { code: 'CONNECT_SCOPES_NOT_GRANTED', missing: [CALENDAR_READONLY], unexpected: [] } },
  { label: 'an extra metadata scope', respond: tokenResponse({ scope: `${GMAIL_METADATA} ${GMAIL_READONLY} ${CALENDAR_READONLY}` }),
    failed: { code: 'CONNECT_SCOPES_NOT_GRANTED', missing: [], unexpected: [GMAIL_METADATA] } },
])('google fails closed on $label, writes no token and prints no credential', async ({ respond, failed }) => {
  await writeClient();
  const run = harness({ respond });
  const ceremony = await begin(run);
  await redirect(ceremony, { code: CODE, state: ceremony.url.searchParams.get('state') ?? '' });
  expect(await ceremony.exit).toBe(1);
  expect(failure(run)).toEqual({ event: 'connect.failed', ...failed });
  expect(run.requests).toHaveLength(1);
  expect(await listing()).toEqual(['google-connector-client']);
  assertNoSecretPrinted(run);
});

it('google refuses a callback whose state differs and never exchanges its code', async () => {
  await writeClient();
  const run = harness({ respond: tokenResponse() });
  const ceremony = await begin(run);
  const reply = await redirect(ceremony, { code: CODE, state: 'forged-state' });
  expect(reply.status).toBe(400);
  expect(await reply.text()).not.toContain(CODE);
  expect(await ceremony.exit).toBe(1);
  expect(failure(run)).toEqual({ event: 'connect.failed', code: 'CONNECT_STATE_MISMATCH' });
  expect(run.requests).toEqual([]);
  expect(await listing()).toEqual(['google-connector-client']);
});

it.each([
  { label: 'no code', query: {} }, { label: 'a provider error', query: { error: 'server_error', code: CODE } },
  { label: 'an empty code', query: { code: '' } },
])('google treats a callback with $label as an authorization failure', async ({ query }) => {
  await writeClient();
  const run = harness({ respond: tokenResponse() });
  const ceremony = await begin(run);
  const reply = await redirect(ceremony, { state: ceremony.url.searchParams.get('state') ?? '', ...query });
  expect(reply.status).toBe(400);
  expect(await ceremony.exit).toBe(1);
  expect(failure(run)).toEqual({ event: 'connect.failed', code: 'CONNECT_AUTHORIZATION_FAILED' });
  expect(run.requests).toEqual([]);
});

it('google times out when no redirect arrives and closes its listener', async () => {
  await writeClient();
  const run = harness({ respond: tokenResponse(), timeoutMs: 100 });
  const ceremony = await begin(run);
  expect(await ceremony.exit).toBe(1);
  expect(failure(run)).toEqual({ event: 'connect.failed', code: 'CONNECT_TIMEOUT' });
  await expect(fetch(ceremony.redirectUri)).rejects.toThrow();
  expect(run.requests).toEqual([]);
});

it('google refuses a port already in use before printing any URL', async () => {
  await writeClient();
  const blocker = createServer();
  await new Promise<void>(resolve => blocker.listen(0, '127.0.0.1', resolve));
  try {
    const run = harness();
    const port = String((blocker.address() as AddressInfo).port);
    expect(await runConnectCli(['google', '--capabilities', READ_IDS, '--port', port, '--open'], run.io)).toBe(1);
    expect(failure(run)).toEqual({ event: 'connect.failed', code: 'CONNECT_PORT_UNAVAILABLE' });
    expect(run.out).toEqual([]);
    expect(run.opened).toEqual([]);
  } finally {
    await new Promise<void>(resolve => blocker.close(() => resolve()));
  }
});

it.skipIf(!POSIX)('google --open --replace --port opens the URL once and replaces the secret at 0600', async () => {
  await writeClient();
  await mkdir(join(mount, 'connectors'));
  await writeFile(join(mount, 'connectors', 'gmail'), 'previous-refresh-token', { mode: 0o644 });
  const port = await freePort();
  const run = harness({ respond: tokenResponse({ scope: GMAIL_READONLY }) });
  const ceremony = await begin(run, ['--capabilities', 'gmail.read_content', '--secret-name', 'connectors/gmail',
    '--port', String(port), '--open', '--replace']);
  expect(ceremony.redirectUri).toBe(`http://127.0.0.1:${port}/callback`);
  expect(run.opened).toEqual([ceremony.url.href]);
  expect(run.out).toContain(ceremony.url.href);
  await redirect(ceremony, { code: CODE, state: ceremony.url.searchParams.get('state') ?? '' });
  expect(await ceremony.exit).toBe(0);
  const path = join(mount, 'connectors', 'gmail');
  expect(await readFile(path, 'utf8')).toBe(REFRESH);
  expect(await mode(path)).toBe(0o600);
  expect(await listing()).toEqual(['connectors', join('connectors', 'gmail'), 'google-connector-client']);
  expect(run.opened).toHaveLength(1);
  assertNoSecretPrinted(run);
});

it('the root scripts run the CLI entry, which no API or worker module references', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8')) as
    { scripts: Record<string, string> };
  expect(manifest.scripts['connect:google']).toBe('tsx packages/api/src/connect-google-cli.ts google');
  expect(manifest.scripts['secret:put']).toBe('tsx packages/api/src/connect-google-cli.ts secret:put');
  const entry = await readFile(new URL('./connect-google-cli.ts', import.meta.url), 'utf8');
  expect(entry).toContain("from './connect-google.js'");
  for (const file of ['index.ts', 'server.ts', 'platform.ts', 'processing-worker.ts']) {
    expect(await readFile(new URL(`./${file}`, import.meta.url), 'utf8')).not.toContain('connect-google');
  }
});

it.skipIf(!POSIX || process.getuid?.() === 0)(
  'google refuses a target directory it cannot write before any URL, so no consent is wasted', async () => {
    await writeClient();
    await mkdir(join(mount, 'connectors'), { mode: 0o500 });
    try {
      const run = harness({ respond: tokenResponse() });
      expect(await runConnectCli(['google', '--capabilities', READ_IDS, '--open'], run.io)).toBe(1);
      expect(failure(run)).toEqual({ event: 'connect.failed', code: 'CONNECT_SECRET_WRITE_FAILED' });
      expect(run.out).toEqual([]);
      expect(run.opened).toEqual([]);
      expect(run.requests).toEqual([]);
    } finally {
      await chmod(join(mount, 'connectors'), 0o700);
    }
  });
