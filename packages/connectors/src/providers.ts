import { z } from 'zod';
import type { SecretsManager } from '@unai/secrets';
import { connectorCursorSchema, type ConnectorCursor } from '@unai/domain';
import { ConnectorError } from './manifests.js';

/**
 * The provider side of a connector: the read-only HTTPS clients, behind one port.
 *
 * `ConnectorClient` is what `runConnectorSync` consumes. The production adapters
 * below exchange Google refresh tokens for access tokens and send GitHub tokens
 * resolved by the secrets manager over TLS. Resource endpoints are read-only:
 * there is no
 * request builder here that can send, create or modify anything at the provider,
 * and the bearer token never leaves this file's request headers.
 *
 * A real test account is configuration, not code: the adapters are constructed
 * with the account reference the owner connected and the secret handle stored on
 * the connector row, so the same code path that runs against a fixture page runs
 * against a live account when a deployment supplies credentials.
 */

export interface ConnectorPage {
  /** Raw provider payloads, each in the shape the deterministic parser expects. */
  readonly payloads: readonly unknown[];
  readonly nextCursor: ConnectorCursor | null;
  /**
   * Set only by a client, on the page that completes its provider-side window
   * (ADR 0041 D7 rule 5): `runConnectorSync` then stops paging and still persists
   * `nextCursor`, so one run never reopens a window it just closed. The other
   * clients never set it.
   */
  readonly exhausted?: boolean;
}
export interface ConnectorFetch {
  readonly cursor: ConnectorCursor | null;
  readonly capabilities: readonly string[];
  readonly externalAccountRef: string;
  readonly limit: number;
}
export interface ConnectorClient {
  fetchPage(request: ConnectorFetch): Promise<ConnectorPage>;
}

const GMAIL = 'https://gmail.googleapis.com/gmail/v1';
const CALENDAR = 'https://www.googleapis.com/calendar/v3';
const GITHUB = 'https://api.github.com';

async function getJson(url: string, token: string, headers: Record<string, string> = {}): Promise<unknown> {
  const response = await fetch(url, {
    method: 'GET',
    headers: { authorization: 'Bearer ' + token, accept: 'application/json', ...headers },
    redirect: 'error',
  });
  if (response.status === 401 || response.status === 403) {
    throw new ConnectorError('CONNECTOR_TOKEN_REVOKED', { status: response.status });
  }
  if (!response.ok) throw new ConnectorError('CONNECTOR_PROVIDER_UNAVAILABLE', { status: response.status });
  // Provider error text can carry the owner's own content, so only the status is
  // ever kept; the body is parsed or the call fails under its own code.
  try { return await response.json(); } catch { throw new ConnectorError('CONNECTOR_PROVIDER_RESPONSE_INVALID'); }
}

function cursor(position: string, providerToken: string | null): ConnectorCursor {
  return connectorCursorSchema.parse({ position, providerToken });
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}
function list(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }

/** The separate "Uai connectors" OAuth client (ADR 0043 D6), never an env read here. */
export interface GoogleOAuthClientConfig {
  resolve(): Promise<{ readonly clientId: string; readonly clientSecret: string }>;
}
export interface GoogleAccessTokens {
  accessToken(secretRef: string, refresh: boolean): Promise<string>;
}
const googleTokenSchema = z.object({ access_token: z.string().min(1), expires_in: z.number().int().positive() });

async function exchangeGoogleToken(refreshToken: string, client: GoogleOAuthClientConfig) {
  const { clientId, clientSecret } = await client.resolve();
  let response: Response;
  try {
    response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken,
        client_id: clientId, client_secret: clientSecret }).toString(),
    });
  } catch {
    throw new ConnectorError('CONNECTOR_PROVIDER_UNAVAILABLE', { status: null });
  }
  // Consume once, discard provider text, and never retain the body or a cause.
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = response.status === 400 && record(body)['error'] === 'invalid_grant'
      ? 'CONNECTOR_TOKEN_REVOKED' : 'CONNECTOR_PROVIDER_UNAVAILABLE';
    throw new ConnectorError(code, { status: response.status });
  }
  const parsed = googleTokenSchema.safeParse(body);
  if (!parsed.success) throw new ConnectorError('CONNECTOR_PROVIDER_RESPONSE_INVALID');
  return parsed.data;
}

/** Cache belongs to this runtime, never the module: two mounts can use the same handle. */
export function createGoogleAccessTokens(secrets: SecretsManager, client: GoogleOAuthClientConfig | null): GoogleAccessTokens {
  const cache = new Map<string, { token: string; expiresAt: number }>();
  return {
    async accessToken(secretRef, refresh) {
      if (client === null) throw new ConnectorError('CONNECTOR_OAUTH_CLIENT_MISSING');
      if (refresh) cache.delete(secretRef);
      const cached = cache.get(secretRef);
      if (cached && Date.now() < cached.expiresAt) return cached.token;
      cache.delete(secretRef);
      const result = await exchangeGoogleToken(await secrets.resolve(secretRef), client);
      if (result.expires_in > 60) cache.set(secretRef, {
        token: result.access_token, expiresAt: Date.now() + (result.expires_in - 60) * 1000,
      });
      return result.access_token;
    },
  };
}

/** 403 is never revocation: Google and GitHub also use it for rate limits and missing scope. */
export function credentialRevoked(error: unknown): boolean {
  return error instanceof ConnectorError && error.message === 'CONNECTOR_TOKEN_REVOKED'
    && (error.detail['status'] === 401 || error.detail['status'] === 400);
}

/** Native fetch/header errors can quote the bearer. Keep Google's new access-token
 * path status-only on both the first attempt and the retry. */
async function googleJson(url: string, token: string): Promise<unknown> {
  try { return await getJson(url, token); } catch (error) {
    if (error instanceof ConnectorError) throw error;
    throw new ConnectorError('CONNECTOR_PROVIDER_UNAVAILABLE', { status: null });
  }
}

/** One refresh budget for the entire page, including Gmail thread-detail requests. */
async function googlePageRequest(tokens: GoogleAccessTokens, secretRef: string) {
  let token = await tokens.accessToken(secretRef, false);
  let refreshed = false;
  return async (url: string): Promise<unknown> => {
    try { return await googleJson(url, token); } catch (error) {
      if (!(error instanceof ConnectorError) || error.message !== 'CONNECTOR_TOKEN_REVOKED'
        || error.detail['status'] !== 401 || refreshed) throw error;
      refreshed = true;
      token = await tokens.accessToken(secretRef, true);
      return googleJson(url, token);
    }
  };
}

/** Gmail, read-only. `users.threads.list` and `users.threads.get` are the only
 * two endpoints, and `format` is `metadata` unless `gmail.read_content` was
 * granted: the capability decides what is even requested from the provider. */
export function createGmailClient(tokens: GoogleAccessTokens, secretRef: string): ConnectorClient {
  return {
    async fetchPage(request) {
      const get = await googlePageRequest(tokens, secretRef);
      const account = encodeURIComponent(request.externalAccountRef);
      const page = request.cursor?.providerToken;
      const listed = record(await get(
        GMAIL + '/users/' + account + '/threads?maxResults=' + request.limit
        + (page ? '&pageToken=' + encodeURIComponent(page) : '')));
      const full = request.capabilities.includes('gmail.read_content');
      const payloads: unknown[] = [];
      for (const entry of list(listed['threads'])) {
        const id = record(entry)['id'];
        if (typeof id !== 'string') continue;
        payloads.push(await get(
          GMAIL + '/users/' + account + '/threads/' + encodeURIComponent(id)
          + '?format=' + (full ? 'full' : 'metadata')));
      }
      const next = listed['nextPageToken'];
      return {
        payloads,
        nextCursor: typeof next === 'string' && next !== ''
          ? cursor('gmail:' + next, next)
          : payloads.length > 0 ? cursor('gmail:end', null) : request.cursor,
      };
    },
  };
}

/** Google Calendar, read-only. `singleEvents=true` expands the series, and the
 * occurrence's own `recurringEventId` and `recurrence` come back as structured
 * fields, which is what the parser stores (CRT-CON-03-A). */
export function createGoogleCalendarClient(tokens: GoogleAccessTokens, secretRef: string): ConnectorClient {
  return {
    async fetchPage(request) {
      const get = await googlePageRequest(tokens, secretRef);
      const calendar = encodeURIComponent(request.externalAccountRef);
      const page = request.cursor?.providerToken;
      const listed = record(await get(
        CALENDAR + '/calendars/' + calendar + '/events?singleEvents=true&maxResults=' + request.limit
        + (page ? '&pageToken=' + encodeURIComponent(page) : '')));
      // One payload per series: the parser takes an event with its expanded
      // instances, so occurrences are grouped by the event they belong to.
      const bySeries = new Map<string, Record<string, unknown>[]>();
      for (const entry of list(listed['items'])) {
        const occurrence = record(entry);
        const id = occurrence['recurringEventId'] ?? occurrence['id'];
        if (typeof id !== 'string') continue;
        bySeries.set(id, [...(bySeries.get(id) ?? []), occurrence]);
      }
      const payloads = [...bySeries].map(([id, instances]) => ({
        id, summary: record(instances[0])['summary'],
        recurrence: list(record(instances[0])['recurrence']),
        timeZone: listed['timeZone'], instances,
      }));
      const next = listed['nextPageToken'];
      return {
        payloads,
        nextCursor: typeof next === 'string' && next !== ''
          ? cursor('calendar:' + next, next)
          : payloads.length > 0 ? cursor('calendar:end', null) : request.cursor,
      };
    },
  };
}

/** GitHub, read-only. Issues and pull requests with their comments, and for a
 * pull request its commits and check runs, which the parser aggregates into one
 * episode (CRT-CON-04-A). */
export function createGithubClient(secrets: SecretsManager, secretRef: string): ConnectorClient {
  return {
    async fetchPage(request) {
      const token = await secrets.resolve(secretRef);
      const repository = request.externalAccountRef;
      const page = Number(request.cursor?.providerToken ?? '1');
      const headers = { 'x-github-api-version': '2022-11-28', 'user-agent': 'uai-connector' };
      const issues = list(await getJson(
        GITHUB + '/repos/' + repository + '/issues?state=all&per_page=' + request.limit + '&page=' + page,
        token, headers));
      const payloads: unknown[] = [];
      for (const entry of issues) {
        const issue = record(entry);
        const number = issue['number'];
        if (typeof number !== 'number') continue;
        const isPullRequest = issue['pull_request'] !== undefined;
        if (isPullRequest && !request.capabilities.includes('github.read_pull_requests')) continue;
        if (!isPullRequest && !request.capabilities.includes('github.read_issues')) continue;
        const comments = list(await getJson(
          GITHUB + '/repos/' + repository + '/issues/' + number + '/comments?per_page=100', token, headers));
        const commits = isPullRequest ? list(await getJson(
          GITHUB + '/repos/' + repository + '/pulls/' + number + '/commits?per_page=100', token, headers)) : [];
        const head = record(record(issue['pull_request'])['head'])['sha'];
        const checkRuns = isPullRequest && typeof head === 'string' ? list(record(await getJson(
          GITHUB + '/repos/' + repository + '/commits/' + head + '/check-runs?per_page=100',
          token, headers))['check_runs']) : [];
        payloads.push({
          repository: { full_name: repository }, issue, comments,
          commits: commits.map(commit => ({
            sha: record(commit)['sha'], message: record(record(commit)['commit'])['message'],
            author: record(commit)['author'],
            committed_at: record(record(record(commit)['commit'])['committer'])['date'],
          })),
          check_runs: checkRuns,
        });
      }
      return {
        payloads,
        nextCursor: issues.length > 0 ? cursor('github:page:' + (page + 1), String(page + 1)) : request.cursor,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Omi (ADR 0041 D2, D7). One GET, ever: the developer API's conversation list,
// transcripts included. Nothing here writes to Omi, reads another Omi endpoint
// or keeps a provider response body (FR-104).
// ---------------------------------------------------------------------------

const OMI = 'https://api.omi.me/v1/dev/user/conversations';
const DAY_MS = 86_400_000;
// Printable ASCII only, so JSON-escaping can never push the cursor past
// `connectorCursorSchema`'s 2048 characters.
// A position must also be a date whose 24 h lookback is a date: a stored `hwm`
// that is not would make every later sync fail with CONNECTOR_CURSOR_INVALID, and
// `toISOString()` throws a non-connector error on an out-of-range value.
const omiStamp = z.string().min(1).max(64).regex(/^[\x20-\x7e]+$/)
  .refine(stamp => !Number.isNaN(new Date(Date.parse(stamp) - DAY_MS).getTime()));
const omiId = z.string().min(1).max(128).regex(/^[\x20-\x7e]+$/);
const omiItemKey = z.object({ id: omiId, created_at: omiStamp });

/** `hwm`/`hwmId`: newest conversation of the last closed window. `top`/`topId`:
 * the same for the window in progress. `before`: the next page's `end_date`.
 * `offset`: the tie skip. */
const omiStateSchema = z.strictObject({
  v: z.literal(1),
  hwm: omiStamp.nullable(), hwmId: omiId.nullable(),
  top: omiStamp.nullable(), topId: omiId.nullable(),
  before: omiStamp.nullable(),
  offset: z.number().int().min(0).max(1_000_000),
}).refine(state =>
  (state.hwm === null) === (state.hwmId === null)
  && (state.top === null) === (state.topId === null)
  && (state.top === null || state.before !== null));
type OmiState = z.infer<typeof omiStateSchema>;
const OMI_EMPTY: OmiState = { v: 1, hwm: null, hwmId: null, top: null, topId: null, before: null, offset: 0 };

function omiStateOf(from: ConnectorCursor | null): OmiState {
  if (from === null) return OMI_EMPTY;
  try {
    return omiStateSchema.parse(JSON.parse(from.providerToken ?? ''));
  } catch {
    // Never echo the token: it is the cursor's own text, not the owner's, but a
    // corrupt or foreign one is refused by name before any request is made.
    throw new ConnectorError('CONNECTOR_CURSOR_INVALID');
  }
}

function omiQuery(state: OmiState, limit: number): URLSearchParams {
  const query = new URLSearchParams({
    include_transcript: 'true', limit: String(limit), offset: String(state.offset),
  });
  // The 24 h lookback re-reads a conversation that was still processing when the
  // last window closed: its created_at is older than ones already read.
  if (state.hwm !== null) query.set('start_date', new Date(Date.parse(state.hwm) - DAY_MS).toISOString());
  if (state.top !== null && state.before !== null) query.set('end_date', state.before);
  return query;
}

interface OmiList {
  readonly items: readonly unknown[];
  readonly hasMore: string | null;
  readonly truncated: string | null;
}

/** The single request. Only the status and `Retry-After` of a failed response are
 * ever kept, and its body is cancelled unread: Omi error text can carry the
 * owner's own words. Never sleeps and never retries. */
async function omiGet(key: string, query: URLSearchParams): Promise<OmiList> {
  let response: Response;
  try {
    response = await fetch(OMI + '?' + query.toString(), {
      method: 'GET', headers: { authorization: 'Bearer ' + key, accept: 'application/json' }, redirect: 'error',
    });
  } catch {
    throw new ConnectorError('CONNECTOR_PROVIDER_UNAVAILABLE', { status: null });
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    const status = response.status;
    if (status === 401 || status === 403) throw new ConnectorError('CONNECTOR_TOKEN_REVOKED', { status });
    if (status === 429) {
      const wait = response.headers.get('retry-after')?.trim() ?? '';
      throw new ConnectorError('CONNECTOR_RATE_LIMITED', {
        status, retryAfterSeconds: /^\d+$/.test(wait) ? Number(wait) : null,
      });
    }
    throw new ConnectorError('CONNECTOR_PROVIDER_UNAVAILABLE', { status });
  }
  let items: unknown;
  try { items = await response.json(); } catch { throw new ConnectorError('CONNECTOR_PROVIDER_RESPONSE_INVALID'); }
  if (!Array.isArray(items)) throw new ConnectorError('CONNECTOR_PROVIDER_RESPONSE_INVALID');
  const header = (name: string) => response.headers.get(name)?.trim().toLowerCase() ?? null;
  return { items, hasMore: header('x-omi-has-more'), truncated: header('x-omi-list-truncated') };
}

/** D7 rule 3: more pages when either header says so; only when neither header is
 * present does a full page mean more. */
function omiHasMore(list: OmiList, limit: number): boolean {
  if (list.hasMore === 'true' || list.truncated === 'true') return true;
  return list.hasMore === null && list.truncated === null && list.items.length === limit;
}

/** The pure state step of D7 (rules 1-4). `usable` are the page's items that carry
 * a plain id and created_at, newest first. */
function omiAdvance(
  state: OmiState, usable: readonly { id: string; created_at: string }[], count: number, more: boolean,
): OmiState {
  const first = usable[0], last = usable.at(-1);
  if (!more) {
    // Close the window: the newest conversation of the window becomes the new
    // high-water mark. An empty page leaves it where it was.
    const head = state.top !== null
      ? { at: state.top, id: state.topId }
      : first ? { at: first.created_at, id: first.id } : { at: state.hwm, id: state.hwmId };
    return { ...state, hwm: head.at, hwmId: head.id, top: null, topId: null, before: null, offset: 0 };
  }
  // An empty truncated page is never the end: keep the state and let the run stop.
  if (count === 0) return state;
  const opened = state.top === null && first
    ? { ...state, top: first.created_at, topId: first.id } : state;
  // A page whose oldest created_at did not move (a tie, or nothing usable) must
  // grow the offset, or the next request would be the same one.
  if (!last || last.created_at === state.before) return { ...opened, offset: state.offset + count };
  return { ...opened, before: last.created_at, offset: 0 };
}

function omiCursor(state: OmiState): ConnectorCursor {
  const at = (value: string | null) => value ?? 'none';
  return connectorCursorSchema.parse({
    position: `omi:hwm=${at(state.hwm)}/${at(state.hwmId)};before=${at(state.before)};offset=${state.offset}`,
    providerToken: JSON.stringify(state),
  });
}

/** Omi, read-only (ADR 0041 D2, D7): the owner's completed conversations, newest
 * first, paged by keyset on `created_at` with a 24 h lookback. The provider's
 * objects are returned untouched, because the parser hashes their content. */
export function createOmiClient(secrets: SecretsManager, secretRef: string): ConnectorClient {
  return {
    async fetchPage(request) {
      const state = omiStateOf(request.cursor);
      const key = await secrets.resolve(secretRef);
      const list = await omiGet(key, omiQuery(state, request.limit));
      const more = omiHasMore(list, request.limit);
      const usable = list.items.flatMap(item => {
        const found = omiItemKey.safeParse(item);
        return found.success ? [found.data] : [];
      });
      const next = omiAdvance(state, usable, list.items.length, more);
      return {
        payloads: list.items,
        // Nothing read: hand back the input cursor (null on a first, empty sync).
        nextCursor: JSON.stringify(next) === JSON.stringify(state) ? request.cursor : omiCursor(next),
        ...(more ? {} : { exhausted: true }),
      };
    },
  };
}

export function createConnectorClient(
  connectorType: string, secrets: SecretsManager, secretRef: string | null, google?: GoogleAccessTokens,
): ConnectorClient {
  if (secretRef === null) throw new ConnectorError('CONNECTOR_CREDENTIAL_MISSING', { connectorType });
  switch (connectorType) {
    case 'GMAIL': return createGmailClient(google ?? createGoogleAccessTokens(secrets, null), secretRef);
    case 'GOOGLE_CALENDAR': return createGoogleCalendarClient(google ?? createGoogleAccessTokens(secrets, null), secretRef);
    case 'GITHUB': return createGithubClient(secrets, secretRef);
    case 'OMI': return createOmiClient(secrets, secretRef);
    default: throw new ConnectorError('CONNECTOR_CLIENT_UNSUPPORTED', { connectorType });
  }
}

/** Revoke an OAuth token at the provider. Google exposes one revocation
 * endpoint; GitHub revokes a token through its app installation. A provider with
 * no revocation endpoint is refused unless it explicitly requires manual revocation. */
export function createTokenRevoker(secrets: SecretsManager) {
  return async (input: { connectorType: string; secretRef: string }): Promise<{ revoked: boolean; manualRevocationRequired?: boolean }> => {
    // Omi keys cannot revoke themselves: DELETE /v1/dev/keys needs a Firebase ID token (OMI-2).
    // This branch makes no request and resolves no secret (ADR 0041 D8).
    if (input.connectorType === 'OMI') return { revoked: false, manualRevocationRequired: true };
    const token = await secrets.resolve(input.secretRef);
    if (input.connectorType === 'GMAIL' || input.connectorType === 'GOOGLE_CALENDAR') {
      // The stored handle is the REFRESH token: revoking it ends the grant,
      // including its access tokens (RFC 7009 section 2.1); the next exchange fails invalid_grant.
      // https://developers.google.com/identity/protocols/oauth2/web-server#tokenrevoke
      // https://www.rfc-editor.org/rfc/rfc7009#section-2.1
      const response = await fetch('https://oauth2.googleapis.com/revoke', {
        method: 'POST', redirect: 'error',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }).toString(),
      });
      // Google answers 200 for a revoked token and 400 for one already invalid;
      // both mean the credential no longer grants anything.
      return { revoked: response.ok || response.status === 400 };
    }
    if (input.connectorType === 'GITHUB') {
      const response = await fetch(GITHUB + '/installation/token', {
        method: 'DELETE', redirect: 'error',
        headers: { authorization: 'Bearer ' + token, accept: 'application/vnd.github+json', 'user-agent': 'uai-connector' },
      });
      return { revoked: response.status === 204 || response.status === 401 };
    }
    throw new ConnectorError('CONNECTOR_REVOCATION_UNAVAILABLE', { connectorType: input.connectorType });
  };
}
