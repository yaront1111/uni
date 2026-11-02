import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SecretsManager } from '@unai/secrets';
import { ConnectorError } from './manifests.js';
import { createConnectorClient, createOmiClient, type ConnectorFetch } from './providers.js';

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
    return new Response(body, { status: next.status ?? 200, headers: next.headers ?? {} });
  });
  return recorded;
}
afterEach(() => { vi.unstubAllGlobals(); });

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
