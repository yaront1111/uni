import type { SecretsManager } from '@unai/secrets';
import { connectorCursorSchema, type ConnectorCursor } from '@unai/domain';
import { ConnectorError } from './manifests.js';
import { isConnectorCredentialHandle } from './credentials.js';
import { discardBody, getJson, providerFetch, record } from './http.js';
import type { GoogleAccessTokens } from './google-tokens.js';
import { createOmiClient } from './omi.js';

export { createGoogleAccessTokenCache, type GoogleAccessTokenCache, type GoogleAccessTokens,
  type GoogleOAuthClientConfig } from './google-tokens.js';
export { createOmiClient };

/**
 * The provider side of a connector: the read-only HTTPS clients, behind one port.
 *
 * `ConnectorClient` is what `runConnectorSync` consumes. The production adapters
 * below send Google access tokens (exchanged from refresh tokens in
 * google-tokens.ts) and GitHub tokens resolved by the secrets manager over TLS;
 * the Omi client is omi.ts. Resource endpoints are read-only:
 * there is no
 * request builder here that can send, create or modify anything at the provider,
 * and the bearer token never leaves the request headers built in providers.ts,
 * http.ts and omi.ts.
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

/**
 * The connector-only resolver (ADR 0013, amendment 2026-11-07, layer 3): the
 * deployment's manager narrowed to one owner's `connectors/<ownerScopeId>/`
 * namespace. A runtime credential, another owner's handle or a non-canonical
 * owner segment is refused with the bare code before the manager is asked, so
 * nothing is read and the error carries no handle, owner scope or value.
 */
export function createConnectorSecrets(secrets: SecretsManager, ownerScopeId: string): SecretsManager {
  return {
    async resolve(handle) {
      if (!isConnectorCredentialHandle(handle, ownerScopeId)) throw new ConnectorError('CONNECTOR_SECRET_REF_OUT_OF_SCOPE');
      return secrets.resolve(handle);
    },
  };
}

function cursor(position: string, providerToken: string | null): ConnectorCursor {
  return connectorCursorSchema.parse({ position, providerToken });
}
function list(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }

/** A Google client built without the runtime's cache behaves as one with no OAuth
 * client configured: its first request fails before any secret is resolved. */
const NO_OAUTH_CLIENT: GoogleAccessTokens = {
  async accessToken() { throw new ConnectorError('CONNECTOR_OAUTH_CLIENT_MISSING'); },
};

/** 403 is never revocation: Google and GitHub also use it for rate limits and missing scope. */
export function credentialRevoked(error: unknown): boolean {
  return error instanceof ConnectorError && error.message === 'CONNECTOR_TOKEN_REVOKED'
    && (error.detail['status'] === 401 || error.detail['status'] === 400);
}

/** One refresh budget for the entire page, including Gmail thread-detail requests. */
async function googlePageRequest(tokens: GoogleAccessTokens, secretRef: string) {
  let token = await tokens.accessToken(secretRef, false);
  let refreshed = false;
  return async (url: string): Promise<unknown> => {
    try { return await getJson(url, token); } catch (error) {
      if (!(error instanceof ConnectorError) || error.message !== 'CONNECTOR_TOKEN_REVOKED'
        || error.detail['status'] !== 401 || refreshed) throw error;
      refreshed = true;
      token = await tokens.accessToken(secretRef, true);
      return getJson(url, token);
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

export function createConnectorClient(
  connectorType: string, secrets: SecretsManager, secretRef: string | null, google?: GoogleAccessTokens,
): ConnectorClient {
  if (secretRef === null) throw new ConnectorError('CONNECTOR_CREDENTIAL_MISSING', { connectorType });
  switch (connectorType) {
    case 'GMAIL': return createGmailClient(google ?? NO_OAUTH_CLIENT, secretRef);
    case 'GOOGLE_CALENDAR': return createGoogleCalendarClient(google ?? NO_OAUTH_CLIENT, secretRef);
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
      const response = await providerFetch('https://oauth2.googleapis.com/revoke', {
        method: 'POST', redirect: 'error',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }).toString(),
      });
      // Google answers 200 for a revoked token and 400 for one already invalid;
      // both mean the credential no longer grants anything.
      discardBody(response);
      return { revoked: response.ok || response.status === 400 };
    }
    if (input.connectorType === 'GITHUB') {
      const response = await providerFetch(GITHUB + '/installation/token', {
        method: 'DELETE', redirect: 'error',
        headers: { authorization: 'Bearer ' + token, accept: 'application/vnd.github+json', 'user-agent': 'uai-connector' },
      });
      discardBody(response);
      return { revoked: response.status === 204 || response.status === 401 };
    }
    throw new ConnectorError('CONNECTOR_REVOCATION_UNAVAILABLE', { connectorType: input.connectorType });
  };
}
