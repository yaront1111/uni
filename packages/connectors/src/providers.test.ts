import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SecretsManager } from '@unai/secrets';
import { ConnectorError, manifestFor } from './manifests.js';
import { connectorCredentialHandle } from './credentials.js';
import { credentialHandleVectors } from './testing/credential-handles.js';
import * as googleProviders from './providers.js';
import {
  createConnectorClient, createConnectorSecrets, createOmiClient, createTokenRevoker, type ConnectorFetch,
  type GoogleOAuthClientConfig,
} from './providers.js';

/**
 * The read-only Omi client (ADR 0041 D2 and D7). No network: `fetch` is stubbed,
 * and the key is an invented literal that cannot be mistaken for a real one.
 */

const KEY = 'omi_dev_TESTKEY_never_real';
const SENTINEL = 'SENTINEL_BODY_the_owner_said_this_privately';
const ORIGIN = 'https://api.omi.me';
const PATH = '/v1/dev/user/conversations';
const URL_BASE = ORIGIN + PATH;
const secrets = { resolve: async () => KEY } as unknown as SecretsManager;

interface Recorded { readonly url: string; readonly init: RequestInit }
interface Scripted { readonly status?: number; readonly headers?: Record<string, string>; readonly body?: unknown }

function stubFetch(...script: Scripted[]): Recorded[] {
  const recorded: Recorded[] = [];
  const queue = [...script];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    recorded.push({ url: String(url), init });
    const next = queue.shift();
    if (!next) throw new Error('unscripted request');
    const body = typeof next.body === 'string' ? next.body : JSON.stringify(next.body ?? []);
    return new Response(next.status === 204 ? null : body, { status: next.status ?? 200, headers: next.headers ?? {} });
  });
  return recorded;
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const T1 = '2026-11-02T10:00:00.123456+00:00';
const T2 = '2026-11-02T09:30:00.500000+00:00';
const T3 = '2026-11-02T09:00:00.000001+00:00';
const T4 = '2026-11-02T08:00:00.000000+00:00';
const conversation = (id: string, created_at: string) => ({ id, created_at, transcript_segments: [{ text: 'hello' }] });

function ask(cursor: ConnectorFetch['cursor'], limit = 2) {
  return { cursor, capabilities: ['omi.read_conversations'], externalAccountRef: 'owner@example.test', limit };
}
function tokenOf(cursor: { providerToken: string | null } | null): Record<string, unknown> {
  expect(cursor).not.toBeNull();
  return JSON.parse(cursor?.providerToken ?? 'null') as Record<string, unknown>;
}
async function failure(run: Promise<unknown>): Promise<ConnectorError> {
  try { await run; } catch (error) {
    expect(error).toBeInstanceOf(ConnectorError);
    return error as ConnectorError;
  }
  throw new Error('expected the call to fail');
}
function expectClean(error: ConnectorError): void {
  const everything = [error.message, JSON.stringify(error.detail), error.stack ?? ''].join('\n');
  expect(everything).not.toContain(KEY);
  expect(everything).not.toContain(SENTINEL);
  expect(everything).not.toContain('api.omi.me');
}

describe('requests (ADR 0041 D2, D7)', () => {
  it('first page of a first sync, then the continuing page, then the next sync after a closed window', async () => {
    const one = [conversation('c1', T1), conversation('c2', T2)];
    const recorded = stubFetch(
      { body: one, headers: { 'x-omi-has-more': 'true' } },
      { body: [conversation('c3', T3)], headers: { 'x-omi-has-more': 'false' } },
      { body: [] },
    );
    const client = createOmiClient(secrets, 'secret://omi/key');

    const first = await client.fetchPage(ask(null));
    expect(recorded[0]?.url).toBe(URL_BASE + '?include_transcript=true&limit=2&offset=0');
    expect(first.exhausted).toBeUndefined();
    expect(first.nextCursor).not.toBeNull();

    const second = await client.fetchPage(ask(first.nextCursor));
    const secondUrl = new URL(recorded[1]?.url ?? '');
    expect(secondUrl.searchParams.get('end_date')).toBe(T2);
    expect(recorded[1]?.url).toContain('end_date=2026-11-02T09%3A30%3A00.500000%2B00%3A00');
    expect(secondUrl.searchParams.get('start_date')).toBeNull();
    expect(secondUrl.searchParams.get('offset')).toBe('0');
    expect(second.exhausted).toBe(true);

    // The window closed on c1 (the newest of the window), so the next sync looks back 24 h from it.
    await client.fetchPage(ask(second.nextCursor));
    const third = new URL(recorded[2]?.url ?? '');
    expect(third.searchParams.get('start_date')).toBe('2026-11-01T10:00:00.123Z');
    expect(third.searchParams.get('end_date')).toBeNull();

    for (const request of recorded) {
      expect((request.init.headers as Record<string, string>)['authorization']).toBe('Bearer ' + KEY);
      expect((request.init.headers as Record<string, string>)['accept']).toBe('application/json');
      expect(request.init.redirect).toBe('error');
      expect(request.init.method).toBe('GET');
    }
  });

  it('every request is a GET to the one conversations URL on api.omi.me', async () => {
    const recorded = stubFetch(
      { body: [conversation('c1', T1), conversation('c2', T2)], headers: { 'x-omi-list-truncated': 'true' } },
      { body: [] },
    );
    const client = createOmiClient(secrets, 'secret://omi/key');
    const first = await client.fetchPage(ask(null));
    await client.fetchPage(ask(first.nextCursor));
    expect(recorded).toHaveLength(2);
    for (const request of recorded) {
      const url = new URL(request.url);
      expect(url.origin).toBe(ORIGIN);
      expect(url.pathname).toBe(PATH);
      expect(request.init.method).toBe('GET');
      expect(request.init.body).toBeUndefined();
    }
  });
});

describe('truncation, window close and the position cursor', () => {
  it('a truncated short page continues the window and is not the end', async () => {
    stubFetch({ body: [conversation('c1', T1)], headers: { 'x-omi-list-truncated': 'true' } });
    const page = await createOmiClient(secrets, 'secret://omi/key').fetchPage(ask(null));
    expect(page.exhausted).toBeUndefined();
    expect(page.nextCursor).not.toBeNull();
    const state = tokenOf(page.nextCursor);
    expect(state).toMatchObject({ v: 1, hwm: null, top: T1, topId: 'c1', before: T1, offset: 0 });
    expect(page.nextCursor?.position).toBe('omi:hwm=none/none;before=' + T1 + ';offset=0');
  });

  it('an EMPTY truncated page returns the input cursor unchanged: never the end', async () => {
    const recorded = stubFetch(
      { body: [conversation('c1', T1), conversation('c2', T2)], headers: { 'x-omi-has-more': 'true' } },
      { body: [], headers: { 'x-omi-list-truncated': 'true' } },
    );
    const client = createOmiClient(secrets, 'secret://omi/key');
    const first = await client.fetchPage(ask(null));
    const stalled = await client.fetchPage(ask(first.nextCursor));
    expect(recorded).toHaveLength(2);
    expect(stalled.nextCursor).toBe(first.nextCursor);
    expect(stalled.exhausted).toBeUndefined();
    expect(stalled.payloads).toEqual([]);
  });

  it('a short non-empty untruncated page closes the window with hwm = its first item', async () => {
    stubFetch({ body: [conversation('c1', T1)] });
    const page = await createOmiClient(secrets, 'secret://omi/key').fetchPage(ask(null));
    expect(page.exhausted).toBe(true);
    expect(tokenOf(page.nextCursor)).toEqual({
      v: 1, hwm: T1, hwmId: 'c1', top: null, topId: null, before: null, offset: 0,
    });
    expect(page.nextCursor?.position).toBe('omi:hwm=' + T1 + '/c1;before=none;offset=0');
  });

  it('an empty untruncated first page reads nothing: null cursor, window closed', async () => {
    stubFetch({ body: [] });
    const page = await createOmiClient(secrets, 'secret://omi/key').fetchPage(ask(null));
    expect(page.nextCursor).toBeNull();
    expect(page.exhausted).toBe(true);
  });

  it('an empty untruncated page after a closed window returns the input cursor', async () => {
    const recorded = stubFetch({ body: [conversation('c1', T1)] }, { body: [] });
    const client = createOmiClient(secrets, 'secret://omi/key');
    const closed = await client.fetchPage(ask(null));
    const again = await client.fetchPage(ask(closed.nextCursor));
    expect(recorded).toHaveLength(2);
    expect(again.nextCursor).toBe(closed.nextCursor);
    expect(again.exhausted).toBe(true);
  });

  it('X-Omi-Has-More false on a full page also closes the window', async () => {
    stubFetch({ body: [conversation('c1', T1), conversation('c2', T2)], headers: { 'x-omi-has-more': 'false' } });
    const page = await createOmiClient(secrets, 'secret://omi/key').fetchPage(ask(null));
    expect(page.exhausted).toBe(true);
    expect(tokenOf(page.nextCursor)).toMatchObject({ hwm: T1, hwmId: 'c1', top: null, before: null });
  });

  it('with neither header, a full page means more and a short page means done', async () => {
    stubFetch(
      { body: [conversation('c1', T1), conversation('c2', T2)] },
      { body: [conversation('c3', T3)] },
    );
    const client = createOmiClient(secrets, 'secret://omi/key');
    const full = await client.fetchPage(ask(null));
    expect(full.exhausted).toBeUndefined();
    const short = await client.fetchPage(ask(full.nextCursor));
    expect(short.exhausted).toBe(true);
    // The window's newest item (c1, from page 1) is the new high-water mark.
    expect(tokenOf(short.nextCursor)).toMatchObject({ hwm: T1, hwmId: 'c1' });
  });

  it('ties: an unmoved oldest created_at keeps `before` and grows the offset, which the next request carries', async () => {
    const recorded = stubFetch(
      { body: [conversation('a', T1), conversation('b', T2)], headers: { 'x-omi-has-more': 'true' } },
      { body: [conversation('b', T2), conversation('b2', T2)], headers: { 'x-omi-has-more': 'true' } },
      { body: [] },
    );
    const client = createOmiClient(secrets, 'secret://omi/key');
    const first = await client.fetchPage(ask(null));
    const tied = await client.fetchPage(ask(first.nextCursor));
    expect(tokenOf(tied.nextCursor)).toMatchObject({ top: T1, before: T2, offset: 2 });
    expect(tied.nextCursor?.position).toContain('offset=2');
    await client.fetchPage(ask(tied.nextCursor));
    const third = new URL(recorded[2]?.url ?? '');
    expect(third.searchParams.get('offset')).toBe('2');
    expect(third.searchParams.get('end_date')).toBe(T2);
  });

  it('items without a string id or created_at are passed through but ignored for positions', async () => {
    // After the one good item: a missing id, a missing created_at, non-objects, a
    // created_at that is not a date and one whose 24 h lookback is out of range.
    // None may become `before`, or the stored cursor would poison later syncs.
    const odd = [
      conversation('c1', T1), { created_at: T3 }, { id: 'x' }, 'text', null,
      { id: 'bad', created_at: 'not-a-date' }, { id: 'far', created_at: '-271821-04-20T00:00:00Z' },
    ];
    stubFetch({ body: odd, headers: { 'x-omi-has-more': 'true' } });
    const page = await createOmiClient(secrets, 'secret://omi/key').fetchPage(ask(null, 7));
    expect(page.payloads).toHaveLength(7);
    expect(tokenOf(page.nextCursor)).toMatchObject({ top: T1, topId: 'c1', before: T1 });
  });

  it('a page with no usable item grows the offset instead of looping', async () => {
    stubFetch({ body: [{ nothing: true }, { nothing: true }], headers: { 'x-omi-has-more': 'true' } });
    const page = await createOmiClient(secrets, 'secret://omi/key').fetchPage(ask(null));
    expect(tokenOf(page.nextCursor)).toMatchObject({ top: null, before: null, offset: 2 });
  });

  it('passes each conversation through unchanged (same object the provider returned)', async () => {
    // A Response-shaped double whose json() hands back objects the test holds, so
    // `toBe` proves the client neither copied nor reshaped them (the parser hashes
    // content; reshaping here would change identity).
    const provided = [conversation('c1', T1), { id: 'c2', created_at: T2, structured: { title: 'x' }, extra: [1, 2] }];
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => provided }));
    const page = await createOmiClient(secrets, 'secret://omi/key').fetchPage(ask(null));
    expect(page.payloads).toHaveLength(2);
    expect(page.payloads[0]).toBe(provided[0]);
    expect(page.payloads[1]).toBe(provided[1]);
  });
});

describe('failures keep the status and nothing else (FR-104)', () => {
  it('429 with Retry-After: CONNECTOR_RATE_LIMITED, retryAfterSeconds 30, no wait', async () => {
    const recorded = stubFetch({ status: 429, headers: { 'retry-after': '30' }, body: SENTINEL });
    const started = Date.now();
    const error = await failure(createOmiClient(secrets, 'secret://omi/key').fetchPage(ask(null)));
    expect(Date.now() - started).toBeLessThan(500);
    expect(error.message).toBe('CONNECTOR_RATE_LIMITED');
    expect(error.detail).toEqual({ status: 429, retryAfterSeconds: 30 });
    expect(recorded).toHaveLength(1);
    expectClean(error);
  });

  it('a Retry-After that is an HTTP date or absent gives retryAfterSeconds null', async () => {
    stubFetch(
      { status: 429, headers: { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' } },
      { status: 429 },
    );
    const client = createOmiClient(secrets, 'secret://omi/key');
    expect((await failure(client.fetchPage(ask(null)))).detail).toEqual({ status: 429, retryAfterSeconds: null });
    expect((await failure(client.fetchPage(ask(null)))).detail).toEqual({ status: 429, retryAfterSeconds: null });
  });

  it.each([401, 403])('%i: CONNECTOR_TOKEN_REVOKED with the status', async status => {
    stubFetch({ status, body: SENTINEL });
    const error = await failure(createOmiClient(secrets, 'secret://omi/key').fetchPage(ask(null)));
    expect(error.message).toBe('CONNECTOR_TOKEN_REVOKED');
    expect(error.detail).toEqual({ status });
    expectClean(error);
  });

  it('a 500 whose body holds a sentinel: CONNECTOR_PROVIDER_UNAVAILABLE, no body text anywhere', async () => {
    stubFetch({ status: 500, body: JSON.stringify({ detail: SENTINEL }) });
    const error = await failure(createOmiClient(secrets, 'secret://omi/key').fetchPage(ask(null)));
    expect(error.message).toBe('CONNECTOR_PROVIDER_UNAVAILABLE');
    expect(error.detail).toEqual({ status: 500 });
    expectClean(error);
  });

  it('a fetch that rejects (network, TLS, redirect) is CONNECTOR_PROVIDER_UNAVAILABLE with a null status', async () => {
    vi.stubGlobal('fetch', async () => { throw new TypeError('fetch failed for ' + URL_BASE + ' with ' + KEY); });
    const error = await failure(createOmiClient(secrets, 'secret://omi/key').fetchPage(ask(null)));
    expect(error.message).toBe('CONNECTOR_PROVIDER_UNAVAILABLE');
    expect(error.detail).toEqual({ status: null });
    expect(error.cause).toBeUndefined();
    expectClean(error);
  });

  it('non-JSON and non-array 200 bodies are CONNECTOR_PROVIDER_RESPONSE_INVALID', async () => {
    stubFetch({ body: 'not json ' + SENTINEL }, { body: { conversations: [] } }, { body: 'null' });
    const client = createOmiClient(secrets, 'secret://omi/key');
    for (let attempt = 0; attempt < 3; attempt++) {
      const error = await failure(client.fetchPage(ask(null)));
      expect(error.message).toBe('CONNECTOR_PROVIDER_RESPONSE_INVALID');
      expectClean(error);
    }
  });

  it('the key never appears in any thrown error', async () => {
    const cases: Scripted[] = [{ status: 429 }, { status: 401 }, { status: 502 }, { body: 'nope' }];
    stubFetch(...cases);
    const client = createOmiClient(secrets, 'secret://omi/key');
    for (let index = 0; index < cases.length; index++) expectClean(await failure(client.fetchPage(ask(null))));
  });
});

describe('cursor validation (before any fetch)', () => {
  const bad = (providerToken: string | null) => ({ position: 'omi:bad', providerToken });
  const valid = {
    v: 1, hwm: T1, hwmId: 'c1', top: null, topId: null, before: null, offset: 0,
  };

  it.each([
    ['null providerToken', null],
    ['not JSON', 'not json'],
    ['a JSON array', '[]'],
    ['a foreign version', JSON.stringify({ ...valid, v: 2 })],
    ['an extra key', JSON.stringify({ ...valid, extra: 1 })],
    ['an unreadable hwm', JSON.stringify({ ...valid, hwm: 'yesterday-ish' })],
    ['an hwm whose 24 h lookback is out of range', JSON.stringify({ ...valid, hwm: '-271821-04-20T00:00:00Z' })],
    ['an hwm without its id', JSON.stringify({ ...valid, hwmId: null })],
    ['a window top without a before', JSON.stringify({ ...valid, top: T1, topId: 'c1', before: null })],
    ['a negative offset', JSON.stringify({ ...valid, offset: -1 })],
    ['a non-printable id', JSON.stringify({ ...valid, hwmId: 'c\u0001' })],
  ])('%s: CONNECTOR_CURSOR_INVALID and no request', async (_name, token) => {
    const recorded = stubFetch();
    const error = await failure(createOmiClient(secrets, 'secret://omi/key').fetchPage(ask(bad(token))));
    expect(error.message).toBe('CONNECTOR_CURSOR_INVALID');
    expect(recorded).toHaveLength(0);
  });
});

describe('createConnectorClient', () => {
  it("'OMI' builds the Omi client, and a missing secret still fails by name", async () => {
    const recorded = stubFetch({ body: [] });
    const client = createConnectorClient('OMI', secrets, 'secret://x');
    await client.fetchPage(ask(null));
    expect(new URL(recorded[0]?.url ?? '').pathname).toBe(PATH);
    expect(() => createConnectorClient('OMI', secrets, null)).toThrowError('CONNECTOR_CREDENTIAL_MISSING');
  });
});

describe('createTokenRevoker (ADR 0023, ADR 0041 D8)', () => {
  it('OMI reports manual revocation without resolving a secret or making a request', async () => {
    const recorded = stubFetch();
    const resolved: string[] = [];
    const recordingSecrets: SecretsManager = {
      async resolve(handle) { resolved.push(handle); return KEY; },
    };
    await expect(createTokenRevoker(recordingSecrets)({
      connectorType: 'OMI', secretRef: 'secret://mounted/omi#key',
    })).resolves.toEqual({ revoked: false, manualRevocationRequired: true });
    expect(recorded).toEqual([]);
    expect(resolved).toEqual([]);
  });

  it.each([
    ['GMAIL', 200, true],
    ['GOOGLE_CALENDAR', 400, true],
    ['GOOGLE_CALENDAR', 500, false],
  ] as const)('%s with status %i preserves its Google revocation result', async (connectorType, status, revoked) => {
    const recorded = stubFetch({ status });
    await expect(createTokenRevoker(secrets)({ connectorType, secretRef: 'secret://mounted/google#token' }))
      .resolves.toEqual({ revoked });
    expect(recorded).toEqual([{
      url: 'https://oauth2.googleapis.com/revoke',
      init: {
        method: 'POST', redirect: 'error',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: KEY }).toString(),
      },
    }]);
  });

  it('GITHUB preserves its installation-token DELETE and successful result', async () => {
    const recorded = stubFetch({ status: 204 });
    await expect(createTokenRevoker(secrets)({ connectorType: 'GITHUB', secretRef: 'secret://mounted/github#token' }))
      .resolves.toEqual({ revoked: true });
    expect(recorded).toEqual([{
      url: 'https://api.github.com/installation/token',
      init: {
        method: 'DELETE', redirect: 'error',
        headers: { authorization: 'Bearer ' + KEY, accept: 'application/vnd.github+json', 'user-agent': 'uai-connector' },
      },
    }]);
  });

  it('DOCUMENT is still refused without a provider request', async () => {
    const recorded = stubFetch();
    await expect(createTokenRevoker(secrets)({ connectorType: 'DOCUMENT', secretRef: 'secret://mounted/document#token' }))
      .rejects.toThrow('CONNECTOR_REVOCATION_UNAVAILABLE');
    expect(recorded).toEqual([]);
  });
});

// The connector-credential namespace (ADR 0013, amendment 2026-11-07). Owner ids
// are invented, in the lowercase canonical form PostgreSQL prints.
const OWNER = '018f5a2e-7c41-7b3a-9d2e-4f6a8b0c1d2e';
const OTHER_OWNER = '018f5a2e-7c41-7b3a-9d2e-4f6a8b0c1d2f';
const RUNTIME_HANDLE = 'secret://mounted/api-database-url';

function recordingManager(value = KEY) {
  const resolved: string[] = [];
  const manager: SecretsManager = { async resolve(handle) { resolved.push(handle); return value; } };
  return { manager, resolved };
}

describe('createConnectorSecrets: the connector-only resolver (ADR 0013, layer 3)', () => {
  it.each([
    ['a runtime credential handle', RUNTIME_HANDLE],
    ["another owner's handle", `secret://mounted/connectors/${OTHER_OWNER}/gmail#refresh`],
    ["the owner's own handle with an uppercase owner segment", `secret://mounted/connectors/${OWNER.toUpperCase()}/gmail#refresh`],
  ])('refuses %s with the bare code before reading anything', async (_title, handle) => {
    const { manager, resolved } = recordingManager();
    const error = await failure(createConnectorSecrets(manager, OWNER).resolve(handle));
    expect(error.message).toBe('CONNECTOR_SECRET_REF_OUT_OF_SCOPE');
    expect(error.detail).toEqual({});
    expect(resolved).toEqual([]);
    const everything = [error.message, JSON.stringify(error.detail), error.stack ?? ''].join('\n');
    for (const leak of [handle, OWNER, OTHER_OWNER, OWNER.toUpperCase(), KEY]) expect(everything).not.toContain(leak);
  });

  it.each([undefined, 'refresh'])("resolves the owner's own handle once, unchanged (field %s)", async field => {
    const handle = connectorCredentialHandle(OWNER, 'gmail', { field });
    const { manager, resolved } = recordingManager();
    await expect(createConnectorSecrets(manager, OWNER).resolve(handle)).resolves.toBe(KEY);
    expect(resolved).toEqual([handle]);
  });

  it('resolves exactly the shared vectors isConnectorCredentialHandle accepts, and reads nothing for the rest', async () => {
    const vectors = credentialHandleVectors(OWNER, OTHER_OWNER);
    const verdicts: { title: string; verdict: string; reads: string[] }[] = [];
    for (const vector of vectors) {
      const { manager, resolved } = recordingManager();
      const verdict = await createConnectorSecrets(manager, OWNER).resolve(vector.handle)
        .then(() => 'RESOLVED', (error: unknown) => error instanceof ConnectorError ? error.message : 'NOT_A_CONNECTOR_ERROR');
      verdicts.push({ title: vector.title, verdict, reads: resolved });
    }
    // One table, so a disagreement names its vector (vitest drops titles inside loops).
    expect(verdicts).toEqual(vectors.map(vector => ({
      title: vector.title,
      verdict: vector.accepted ? 'RESOLVED' : 'CONNECTOR_SECRET_REF_OUT_OF_SCOPE',
      reads: vector.accepted ? [vector.handle] : [],
    })));
  });
});

// Google credentials are invented sentinels, never live credentials.
const REF = connectorCredentialHandle(OWNER, 'gmail', { field: 'refresh_token' });
const OTHER_REF = connectorCredentialHandle(OTHER_OWNER, 'gmail', { field: 'refresh_token' });
const REFRESH = '1//REFRESH_TEST_ONLY';
const OTHER_REFRESH = '1//OTHER_OWNER_REFRESH_TEST_ONLY';
const ACCESS = 'ya29.ACCESS_TEST_ONLY';
const ACCESS2 = 'ya29.SECOND_TEST_ONLY';
const ACCESS3 = 'ya29.THIRD_TEST_ONLY';
const CLIENT_ID = 'connector-client.apps.example.test';
const CLIENT_SECRET = 'GOCSPX-CLIENT_TEST_ONLY';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const googleRequest: ConnectorFetch = {
  cursor: null, capabilities: ['gmail.read_content'], externalAccountRef: 'me', limit: 2,
};
const issued = (access_token = ACCESS, expires_in = 3599) => ({ body: { access_token, expires_in } });
const oauthClient: GoogleOAuthClientConfig = {
  resolve: async () => ({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }),
};

function googleSource() {
  const resolved: string[] = [];
  const manager: SecretsManager = { resolve: async ref => { resolved.push(ref); return REFRESH; } };
  // This assertion makes the pre-implementation RED a missing-behavior failure.
  expect(googleProviders.createGoogleAccessTokenCache).toBeTypeOf('function');
  const tokens = googleProviders.createGoogleAccessTokenCache(oauthClient).forOwner(OWNER, manager);
  return { tokens, resolved, manager };
}
function googleCalls(calls: Recorded[]) { return calls.filter(call => call.url !== TOKEN_URL); }
function tokenCalls(calls: Recorded[]) { return calls.filter(call => call.url === TOKEN_URL); }
async function googleFailure(run: Promise<unknown>, code: string, detail: Record<string, unknown> = {}) {
  const error = await failure(run);
  expect(error.message).toBe(code);
  expect(error.detail).toEqual(detail);
  expect(error.cause).toBeUndefined();
  const everything = [error.message, JSON.stringify(error.detail), error.stack].join('\n');
  for (const secret of [REFRESH, OTHER_REFRESH, ACCESS, ACCESS2, ACCESS3, CLIENT_SECRET, SENTINEL]) {
    expect(everything).not.toContain(secret);
  }
  return error;
}

describe('Google refresh exchange (ADR 0043 D6)', () => {
  beforeEach(() => {
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, method);
  });
  afterEach(() => {
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) expect(console[method]).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('T1: exchanges once for two Gmail pages and sends only the access token to Gmail', async () => {
    const calls = stubFetch(issued(), { body: { threads: [{ id: 't1' }], nextPageToken: 'page2' } },
      { body: { id: 't1' } }, { body: { threads: [{ id: 't2' }] } }, { body: { id: 't2' } });
    const { tokens, resolved } = googleSource();
    const client = googleProviders.createGmailClient(tokens, REF);
    const first = await client.fetchPage(googleRequest);
    const second = await client.fetchPage({ ...googleRequest, cursor: first.nextCursor });
    expect(first.payloads).toEqual([{ id: 't1' }]);
    expect(second.payloads).toEqual([{ id: 't2' }]);
    expect(tokenCalls(calls)).toHaveLength(1);
    expect(resolved).toEqual([REF]);
    expect(calls[0]).toEqual({ url: TOKEN_URL, init: {
      method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: REFRESH,
        client_id: CLIENT_ID, client_secret: CLIENT_SECRET }).toString(),
    } });
    expect(Object.fromEntries(new URLSearchParams(String(calls[0]?.init.body)))).toEqual({
      grant_type: 'refresh_token', refresh_token: REFRESH, client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
    });
    expect(googleCalls(calls).map(c => c.url)).toEqual([
      'https://gmail.googleapis.com/gmail/v1/users/me/threads?maxResults=2',
      'https://gmail.googleapis.com/gmail/v1/users/me/threads/t1?format=full',
      'https://gmail.googleapis.com/gmail/v1/users/me/threads?maxResults=2&pageToken=page2',
      'https://gmail.googleapis.com/gmail/v1/users/me/threads/t2?format=full',
    ]);
    for (const call of googleCalls(calls)) {
      expect(call.init.headers).toEqual({ authorization: 'Bearer ' + ACCESS, accept: 'application/json' });
      for (const secret of [REFRESH, CLIENT_SECRET]) expect(JSON.stringify(call)).not.toContain(secret);
    }
  });

  it.each(['GMAIL', 'GOOGLE_CALENDAR'])('T2: %s refreshes and retries once on a 401', async type => {
    const calls = stubFetch(issued(), { status: 401 }, issued(ACCESS2), { body: {} });
    const { tokens, manager } = googleSource();
    await googleProviders.createConnectorClient(type, manager, REF, tokens).fetchPage(googleRequest);
    expect(tokenCalls(calls)).toHaveLength(2);
    expect(googleCalls(calls)).toHaveLength(2);
    expect(googleCalls(calls)[1]?.url).toBe(googleCalls(calls)[0]?.url);
    expect(new Headers(googleCalls(calls)[1]?.init.headers).get('authorization')).toBe('Bearer ' + ACCESS2);
  });

  it('T3: a second 401 on one page is final, even on a later thread', async () => {
    const calls = stubFetch(issued(), { status: 401 }, issued(ACCESS2),
      { body: { threads: [{ id: 't1' }] } }, { status: 401 });
    const { tokens } = googleSource();
    await googleFailure(googleProviders.createGmailClient(tokens, REF).fetchPage(googleRequest),
      'CONNECTOR_TOKEN_REVOKED', { status: 401 });
    expect(tokenCalls(calls)).toHaveLength(2);
    expect(googleCalls(calls)).toHaveLength(3);
  });

  it('T3: an immediate second 401 is not retried', async () => {
    const calls = stubFetch(issued(), { status: 401 }, issued(ACCESS2), { status: 401 });
    const { tokens } = googleSource();
    await googleFailure(googleProviders.createGmailClient(tokens, REF).fetchPage(googleRequest),
      'CONNECTOR_TOKEN_REVOKED', { status: 401 });
    expect(tokenCalls(calls)).toHaveLength(2);
    expect(googleCalls(calls)).toHaveLength(2);
  });

  it('T4: a 403 never refreshes', async () => {
    const calls = stubFetch(issued(), { status: 403 });
    const { tokens } = googleSource();
    await googleFailure(googleProviders.createGmailClient(tokens, REF).fetchPage(googleRequest),
      'CONNECTOR_TOKEN_REVOKED', { status: 403 });
    expect(tokenCalls(calls)).toHaveLength(1);
  });

  it('T5: invalid_grant alone revokes the refresh credential', async () => {
    const calls = stubFetch({ status: 400, body: { error: 'invalid_grant', error_description: SENTINEL } });
    const { tokens } = googleSource();
    const error = await googleFailure(tokens.accessToken(REF, false), 'CONNECTOR_TOKEN_REVOKED', { status: 400 });
    expect(googleProviders.credentialRevoked(error)).toBe(true);
    expect(googleCalls(calls)).toEqual([]);
  });

  it.each([[400, 'invalid_request'], [400, 'unauthorized_client'], [401, 'invalid_client'],
    [429, 'rate_limit'], [500, 'invalid_grant'], [503, null]] as const)(
    'T6: token HTTP %s %s is a deployment/provider failure, not revocation', async (status, error) => {
      stubFetch({ status, body: error === null ? SENTINEL : { error, error_description: SENTINEL } });
      const { tokens } = googleSource();
      const caught = await googleFailure(tokens.accessToken(REF, false), 'CONNECTOR_PROVIDER_UNAVAILABLE', { status });
      expect(googleProviders.credentialRevoked(caught)).toBe(false);
    });

  it('T6: a rejected exchange discards even a secret-bearing error and cause', async () => {
    vi.stubGlobal('fetch', async () => { throw new Error([REFRESH, ACCESS, CLIENT_SECRET, SENTINEL].join(' ')); });
    const { tokens } = googleSource();
    await googleFailure(tokens.accessToken(REF, false), 'CONNECTOR_PROVIDER_UNAVAILABLE', { status: null });
  });

  it.each([{ expires_in: 3599 }, { access_token: ACCESS, expires_in: '3599' },
    { access_token: ACCESS, expires_in: 0 }, SENTINEL])('T6: malformed successful token response %#', async body => {
    stubFetch({ body });
    const { tokens } = googleSource();
    await googleFailure(tokens.accessToken(REF, false), 'CONNECTOR_PROVIDER_RESPONSE_INVALID');
  });

  it('T7: expiry uses a 60 second safety margin', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const calls = stubFetch(issued(), { body: {} }, { body: {} }, issued(ACCESS2), { body: {} });
    const { tokens } = googleSource();
    const client = googleProviders.createGmailClient(tokens, REF);
    await client.fetchPage(googleRequest);
    vi.setSystemTime(3538999); await client.fetchPage(googleRequest);
    expect(tokenCalls(calls)).toHaveLength(1);
    vi.setSystemTime(3539000); await client.fetchPage(googleRequest);
    expect(tokenCalls(calls)).toHaveLength(2);
  });

  it('T7: tokens with less than a minute remaining are never cached', async () => {
    const calls = stubFetch(issued(ACCESS, 30), { body: {} }, issued(ACCESS2, 30), { body: {} });
    const { tokens } = googleSource();
    const client = googleProviders.createGmailClient(tokens, REF);
    await client.fetchPage(googleRequest); await client.fetchPage(googleRequest);
    expect(tokenCalls(calls)).toHaveLength(2);
  });

  it('T8: a failed forced refresh evicts the rejected token', async () => {
    const calls = stubFetch(issued(), { status: 401 }, { status: 500 }, issued(ACCESS2), { body: {} });
    const { tokens } = googleSource();
    const client = googleProviders.createGmailClient(tokens, REF);
    await googleFailure(client.fetchPage(googleRequest), 'CONNECTOR_PROVIDER_UNAVAILABLE', { status: 500 });
    await client.fetchPage(googleRequest);
    expect(tokenCalls(calls)).toHaveLength(3);
    expect(new Headers(googleCalls(calls)[1]?.init.headers).get('authorization')).toBe('Bearer ' + ACCESS2);
  });

  it.each([false, true])('T11: a rejected data request stays secret-free (after refresh: %s)', async retry => {
    let exchanges = 0, dataRequests = 0;
    vi.stubGlobal('fetch', async (url: string) => {
      if (url === TOKEN_URL) { exchanges++; return Response.json(issued().body); }
      dataRequests++;
      if (retry && dataRequests === 1) return new Response(null, { status: 401 });
      throw new TypeError([REFRESH, ACCESS, ACCESS2, CLIENT_SECRET, SENTINEL].join(' '));
    });
    const { tokens } = googleSource();
    await googleFailure(googleProviders.createGmailClient(tokens, REF).fetchPage(googleRequest),
      'CONNECTOR_PROVIDER_UNAVAILABLE', { status: null });
    expect(exchanges).toBe(retry ? 2 : 1);
    expect(dataRequests).toBe(retry ? 2 : 1);
  });

  it('T9: absent OAuth config constructs but refuses before secret resolution or fetch', async () => {
    const calls = stubFetch();
    const resolve = vi.fn(async () => REFRESH);
    const client = googleProviders.createConnectorClient('GMAIL', { resolve }, REF);
    await googleFailure(client.fetchPage(googleRequest), 'CONNECTOR_OAUTH_CLIENT_MISSING');
    expect(calls).toEqual([]); expect(resolve).not.toHaveBeenCalled();
  });

  it('isolates caches by runtime and by handle', async () => {
    const calls = stubFetch(issued(), issued(ACCESS2), issued(ACCESS2));
    const one = googleSource().tokens, two = googleSource().tokens;
    expect(await one.accessToken(REF, false)).toBe(ACCESS);
    expect(await two.accessToken(REF, false)).toBe(ACCESS2);
    expect(await one.accessToken(connectorCredentialHandle(OWNER, 'calendar'), false)).toBe(ACCESS2);
    expect(tokenCalls(calls)).toHaveLength(3);
  });

  it('keys one runtime map by owner scope plus handle, and never hands one owner another owner\'s token', async () => {
    const calls = stubFetch(issued(ACCESS), issued(ACCESS2), issued(ACCESS3));
    const cache = new Map<string, { token: string; expiresAt: number }>();
    const runtime = googleProviders.createGoogleAccessTokenCache(oauthClient, cache);
    const a = recordingManager(REFRESH), b = recordingManager(OTHER_REFRESH);
    const ownerA = runtime.forOwner(OWNER, a.manager), ownerB = runtime.forOwner(OTHER_OWNER, b.manager);
    expect(await ownerA.accessToken(REF, false)).toBe(ACCESS);
    expect(await ownerA.accessToken(REF, false)).toBe(ACCESS);
    expect(tokenCalls(calls)).toHaveLength(1);
    // Owner B naming A's handle, cached or forced, is refused before the cache is read or evicted.
    for (const refresh of [false, true]) {
      const error = await googleFailure(ownerB.accessToken(REF, refresh), 'CONNECTOR_SECRET_REF_OUT_OF_SCOPE');
      for (const leak of [REF, OWNER, OTHER_OWNER]) expect(error.stack ?? '').not.toContain(leak);
    }
    expect(b.resolved).toEqual([]);
    expect(await ownerB.accessToken(OTHER_REF, false)).toBe(ACCESS2);
    expect(tokenCalls(calls)).toHaveLength(2);
    expect(new URLSearchParams(String(tokenCalls(calls)[1]?.init.body)).get('refresh_token')).toBe(OTHER_REFRESH);
    expect([...cache.keys()]).toEqual([OWNER + '\u0000' + REF, OTHER_OWNER + '\u0000' + OTHER_REF]);
    // A forced refresh evicts only the caller's key: B's next call is still a cache hit.
    expect(await ownerA.accessToken(REF, true)).toBe(ACCESS3);
    expect(await ownerB.accessToken(OTHER_REF, false)).toBe(ACCESS2);
    expect(tokenCalls(calls)).toHaveLength(3);
    expect(a.resolved).toEqual([REF, REF]);
    expect(b.resolved).toEqual([OTHER_REF]);
    expect([...cache.keys()]).toEqual([OTHER_OWNER + '\u0000' + OTHER_REF, OWNER + '\u0000' + REF]);
  });

  it.each([
    ['a runtime credential handle', RUNTIME_HANDLE],
    ["another owner's handle", OTHER_REF],
    ["the owner's own handle with an uppercase owner segment", REF.replace(OWNER, OWNER.toUpperCase())],
  ])('refuses %s before any secret read, exchange or cache entry', async (_title, handle) => {
    const calls = stubFetch();
    const cache = new Map<string, { token: string; expiresAt: number }>();
    const { manager, resolved } = recordingManager(REFRESH);
    await googleFailure(googleProviders.createGoogleAccessTokenCache(oauthClient, cache)
      .forOwner(OWNER, manager).accessToken(handle, false), 'CONNECTOR_SECRET_REF_OUT_OF_SCOPE');
    expect(resolved).toEqual([]); expect(calls).toEqual([]); expect(cache.size).toBe(0);
  });

  it('a missing OAuth client is still answered first, even for a foreign handle', async () => {
    const calls = stubFetch();
    const { manager, resolved } = recordingManager(REFRESH);
    await googleFailure(googleProviders.createGoogleAccessTokenCache(null).forOwner(OWNER, manager)
      .accessToken(RUNTIME_HANDLE, false), 'CONNECTOR_OAUTH_CLIENT_MISSING');
    expect(resolved).toEqual([]); expect(calls).toEqual([]);
  });

  it('no export still offers a cache keyed by handle alone', () => {
    expect(Object.keys(googleProviders)).not.toContain('createGoogleAccessTokens');
  });

  it.each([
    [new ConnectorError('CONNECTOR_TOKEN_REVOKED', { status: 401 }), true],
    [new ConnectorError('CONNECTOR_TOKEN_REVOKED', { status: 400 }), true],
    [new ConnectorError('CONNECTOR_TOKEN_REVOKED', { status: 403 }), false],
    [new ConnectorError('CONNECTOR_PROVIDER_UNAVAILABLE', { status: 401 }), false],
    [new Error('CONNECTOR_TOKEN_REVOKED'), false], [undefined, false],
  ])('T10: revocation predicate %#', (error, expected) => {
    expect(googleProviders.credentialRevoked).toBeTypeOf('function');
    expect(googleProviders.credentialRevoked(error)).toBe(expected);
  });
});


it('manifests distinguish Google refresh handles from GitHub bearer handles', () => {
  expect(manifestFor('GMAIL').requiredSecrets).toEqual(['oauth_refresh_token']);
  expect(manifestFor('GOOGLE_CALENDAR').requiredSecrets).toEqual(['oauth_refresh_token']);
  expect(manifestFor('GITHUB').requiredSecrets).toEqual(['access_token']);
});
