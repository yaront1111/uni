import { inspect } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SecretsManager } from '@unai/secrets';
import { ConnectorError } from './manifests.js';
import { providerFailure } from './http.js';
import * as googleTokens from './google-tokens.js';
import * as omi from './omi.js';
import * as providers from './providers.js';
import {
  createGithubClient, createGmailClient, createGoogleCalendarClient, createOmiClient, createTokenRevoker,
  type ConnectorClient, type ConnectorFetch, type GoogleAccessTokens,
} from './providers.js';

/**
 * The failure mapping of every provider client's resource requests (ADR 0041 D7,
 * 2026-11-07 addition). A failed response keeps only its status and a whole-second
 * `Retry-After`; its body is cancelled unread, because provider error text can
 * carry the owner's own words (FR-104).
 *
 * No test reaches the network: fetch is always a double, and every credential is
 * an invented literal.
 */

const SENTINEL = 'SENTINEL_BODY_the_owner_said_this_privately';
const TOKEN = 'TOKEN_TEST_ONLY_never_real';
const KEY = 'KEY_TEST_ONLY_never_real';
const ACCESS = 'ACCESS_TEST_ONLY';
const HANDLE = 'secret://mounted/provider#token';
const REF = 'secret://mounted/google#refresh';
const secretsOf = (value: string) => ({ resolve: async () => value }) as unknown as SecretsManager;
const request: ConnectorFetch = { cursor: null, capabilities: [], externalAccountRef: 'owner/repo', limit: 2 };
const macrotask = () => new Promise(resolve => setTimeout(resolve, 0));

afterEach(() => { vi.unstubAllGlobals(); });

interface Tracked { readonly response: Response; cancelled(): boolean }

/** A response whose body holds the sentinel and records a cancel. The stream is
 * never closed: cancel() on a closed stream never reaches the source. */
function tracked(status: number, headers: Record<string, string> = {}): Tracked {
  let flag = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(SENTINEL)); },
    cancel() { flag = true; },
  });
  return { response: new Response(body, { status, headers }), cancelled: () => flag };
}

/** Serves the answers in order and records each requested URL. */
function stubFetch(answers: readonly Tracked[]): string[] {
  const calls: string[] = [];
  const queue = [...answers];
  vi.stubGlobal('fetch', async (url: string) => {
    calls.push(String(url));
    const next = queue.shift();
    if (!next) throw new Error('unscripted request');
    return next.response;
  });
  return calls;
}

type ClientName = 'GMAIL' | 'GOOGLE_CALENDAR' | 'GITHUB' | 'OMI';
const CLIENTS: readonly ClientName[] = ['GMAIL', 'GOOGLE_CALENDAR', 'GITHUB', 'OMI'];
const isGoogle = (name: ClientName) => name === 'GMAIL' || name === 'GOOGLE_CALENDAR';

function build(name: ClientName): { client: ConnectorClient; refreshes: boolean[] } {
  const refreshes: boolean[] = [];
  const tokens: GoogleAccessTokens = {
    accessToken: async (_ref, refresh) => { refreshes.push(refresh); return ACCESS; },
  };
  const client = name === 'GMAIL' ? createGmailClient(tokens, REF)
    : name === 'GOOGLE_CALENDAR' ? createGoogleCalendarClient(tokens, REF)
      : name === 'GITHUB' ? createGithubClient(secretsOf(TOKEN), HANDLE)
        : createOmiClient(secretsOf(KEY), HANDLE);
  return { client, refreshes };
}

/** Runs one page that must fail, and checks what every failure must hold. */
async function failure(name: ClientName, answers: readonly Tracked[]) {
  const calls = stubFetch(answers);
  const { client, refreshes } = build(name);
  const caught: unknown = await client.fetchPage(request).then(() => null, (error: unknown) => error);
  expect(caught).toBeInstanceOf(ConnectorError);
  const error = caught as ConnectorError;
  expect(error.cause).toBeUndefined();
  expect(inspect(error, { depth: 5 })).not.toContain(SENTINEL);
  expect(JSON.stringify(error.detail)).not.toContain(SENTINEL);
  await macrotask();
  expect(answers.map(answer => answer.cancelled())).toEqual(answers.map(() => true));
  return { error, calls, refreshes };
}

describe.each(CLIENTS)('%s resource request failure', name => {
  const once = isGoogle(name) ? [false] : [];

  it('maps a 403 to CONNECTOR_TOKEN_REVOKED {status: 403} and never refreshes', async () => {
    const { error, calls, refreshes } = await failure(name, [tracked(403)]);
    expect(error.message).toBe('CONNECTOR_TOKEN_REVOKED');
    expect(error.detail).toEqual({ status: 403 });
    expect(calls).toHaveLength(1);
    expect(refreshes).toEqual(once);
  });

  it('maps a 429 to CONNECTOR_RATE_LIMITED with the whole-second Retry-After', async () => {
    const { error, calls, refreshes } = await failure(name, [tracked(429, { 'retry-after': '30' })]);
    expect(error.message).toBe('CONNECTOR_RATE_LIMITED');
    expect(error.detail).toEqual({ status: 429, retryAfterSeconds: 30 });
    expect(calls).toHaveLength(1);
    expect(refreshes).toEqual(once);
  });

  it.each([
    ['an HTTP-date Retry-After', { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' }],
    ['no Retry-After', {}],
  ])('maps a 429 with %s to retryAfterSeconds null', async (_label, headers) => {
    const { error, calls } = await failure(name, [tracked(429, headers)]);
    expect(error.message).toBe('CONNECTOR_RATE_LIMITED');
    expect(error.detail).toEqual({ status: 429, retryAfterSeconds: null });
    expect(calls).toHaveLength(1);
  });

  it('maps a 500 to CONNECTOR_PROVIDER_UNAVAILABLE {status: 500}', async () => {
    const { error, calls, refreshes } = await failure(name, [tracked(500)]);
    expect(error.message).toBe('CONNECTOR_PROVIDER_UNAVAILABLE');
    expect(error.detail).toEqual({ status: 500 });
    expect(calls).toHaveLength(1);
    expect(refreshes).toEqual(once);
  });

  it('maps a 401 to CONNECTOR_TOKEN_REVOKED {status: 401}, after one refresh for Google', async () => {
    const answers = isGoogle(name) ? [tracked(401), tracked(401)] : [tracked(401)];
    const { error, calls, refreshes } = await failure(name, answers);
    expect(error.message).toBe('CONNECTOR_TOKEN_REVOKED');
    expect(error.detail).toEqual({ status: 401 });
    expect(calls).toHaveLength(answers.length);
    expect(refreshes).toEqual(isGoogle(name) ? [false, true] : []);
  });
});

describe('module split', () => {
  it('providers.ts re-exports the moved Omi client and Google token cache, not copies', () => {
    expect(providers.createOmiClient).toBe(omi.createOmiClient);
    expect(providers.createGoogleAccessTokenCache).toBe(googleTokens.createGoogleAccessTokenCache);
  });
});

describe('providerFailure', () => {
  it.each([
    [401, {}, 'CONNECTOR_TOKEN_REVOKED', { status: 401 }],
    [403, {}, 'CONNECTOR_TOKEN_REVOKED', { status: 403 }],
    [418, {}, 'CONNECTOR_PROVIDER_UNAVAILABLE', { status: 418 }],
    [429, { 'retry-after': ' 120 ' }, 'CONNECTOR_RATE_LIMITED', { status: 429, retryAfterSeconds: 120 }],
    [429, { 'retry-after': '1.5' }, 'CONNECTOR_RATE_LIMITED', { status: 429, retryAfterSeconds: null }],
    [429, { 'retry-after': '-1' }, 'CONNECTOR_RATE_LIMITED', { status: 429, retryAfterSeconds: null }],
    [429, { 'retry-after': '' }, 'CONNECTOR_RATE_LIMITED', { status: 429, retryAfterSeconds: null }],
    [429, { 'retry-after': 'soon' }, 'CONNECTOR_RATE_LIMITED', { status: 429, retryAfterSeconds: null }],
  ] as const)('%i %j → %s %j, the body cancelled unread', async (status, headers, code, detail) => {
    const answer = tracked(status, headers);
    const error = providerFailure(answer.response);
    expect(error).toBeInstanceOf(ConnectorError);
    expect(error.message).toBe(code);
    expect(error.detail).toEqual(detail);
    expect(inspect(error, { depth: 5 })).not.toContain(SENTINEL);
    await macrotask();
    expect(answer.cancelled()).toBe(true);
  });
});

describe('createTokenRevoker', () => {
  it.each([
    ['GMAIL', 200, true], ['GMAIL', 400, true], ['GMAIL', 503, false],
    ['GITHUB', 401, true], ['GITHUB', 500, false],
  ] as const)('%s answered %i: revoked %s, the body cancelled unread', async (connectorType, status, revoked) => {
    const answer = tracked(status);
    const calls = stubFetch([answer]);
    const result = await createTokenRevoker(secretsOf(TOKEN))({ connectorType, secretRef: HANDLE });
    expect(result).toEqual({ revoked });
    expect(calls).toHaveLength(1);
    await macrotask();
    expect(answer.cancelled()).toBe(true);
  });

  it('GITHUB answered 204 with no body: revoked', async () => {
    const calls = stubFetch([{ response: new Response(null, { status: 204 }), cancelled: () => true }]);
    const result = await createTokenRevoker(secretsOf(TOKEN))({ connectorType: 'GITHUB', secretRef: HANDLE });
    expect(result).toEqual({ revoked: true });
    expect(calls).toHaveLength(1);
  });
});
