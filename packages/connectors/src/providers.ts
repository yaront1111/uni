import type { SecretsManager } from '@unai/secrets';
import { connectorCursorSchema, type ConnectorCursor } from '@unai/domain';
import { ConnectorError } from './manifests.js';

/**
 * The provider side of a connector: the read-only HTTPS clients, behind one port.
 *
 * `ConnectorClient` is what `runConnectorSync` consumes. The production adapters
 * below call Gmail, Google Calendar and GitHub over TLS with the OAuth token the
 * secrets manager resolves, and they call *read-only* endpoints only: there is no
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

/** Gmail, read-only. `users.threads.list` and `users.threads.get` are the only
 * two endpoints, and `format` is `metadata` unless `gmail.read_content` was
 * granted: the capability decides what is even requested from the provider. */
export function createGmailClient(secrets: SecretsManager, secretRef: string): ConnectorClient {
  return {
    async fetchPage(request) {
      const token = await secrets.resolve(secretRef);
      const account = encodeURIComponent(request.externalAccountRef);
      const page = request.cursor?.providerToken;
      const listed = record(await getJson(
        GMAIL + '/users/' + account + '/threads?maxResults=' + request.limit
        + (page ? '&pageToken=' + encodeURIComponent(page) : ''), token));
      const full = request.capabilities.includes('gmail.read_content');
      const payloads: unknown[] = [];
      for (const entry of list(listed['threads'])) {
        const id = record(entry)['id'];
        if (typeof id !== 'string') continue;
        payloads.push(await getJson(
          GMAIL + '/users/' + account + '/threads/' + encodeURIComponent(id)
          + '?format=' + (full ? 'full' : 'metadata'), token));
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
export function createGoogleCalendarClient(secrets: SecretsManager, secretRef: string): ConnectorClient {
  return {
    async fetchPage(request) {
      const token = await secrets.resolve(secretRef);
      const calendar = encodeURIComponent(request.externalAccountRef);
      const page = request.cursor?.providerToken;
      const listed = record(await getJson(
        CALENDAR + '/calendars/' + calendar + '/events?singleEvents=true&maxResults=' + request.limit
        + (page ? '&pageToken=' + encodeURIComponent(page) : ''), token));
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
  connectorType: string, secrets: SecretsManager, secretRef: string | null,
): ConnectorClient {
  if (secretRef === null) throw new ConnectorError('CONNECTOR_CREDENTIAL_MISSING', { connectorType });
  switch (connectorType) {
    case 'GMAIL': return createGmailClient(secrets, secretRef);
    case 'GOOGLE_CALENDAR': return createGoogleCalendarClient(secrets, secretRef);
    case 'GITHUB': return createGithubClient(secrets, secretRef);
    default: throw new ConnectorError('CONNECTOR_CLIENT_UNSUPPORTED', { connectorType });
  }
}

/** Revoke an OAuth token at the provider. Google exposes one revocation
 * endpoint; GitHub revokes a token through its app installation. A provider with
 * no revocation endpoint is refused rather than reported as revoked. */
export function createTokenRevoker(secrets: SecretsManager) {
  return async (input: { connectorType: string; secretRef: string }): Promise<{ revoked: boolean }> => {
    const token = await secrets.resolve(input.secretRef);
    if (input.connectorType === 'GMAIL' || input.connectorType === 'GOOGLE_CALENDAR') {
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
