import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
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
