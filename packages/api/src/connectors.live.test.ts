import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { runMigrations } from '@unai/postgres';
import { postgresAdapter, SESSION_COOKIE } from '@unai/auth';
import { createDefaultSecretsManager, isSecretHandle } from '@unai/secrets';
import { createPlatformApi } from './platform.js';
import { createConnectorRuntime } from './connectors.js';
import type { EvidenceObjects } from './evidence.js';

/**
 * The connector integration suite against *real* test accounts (CRT-CON-02-A,
 * CRT-CON-03-A, CRT-CON-04-A, CRT-CON-06-A and ADR-0041-LIVE-A, the Omi connector).
 *
 * Those four criteria each name a live account: "ingests a real test account's
 * threads", "a real test account's events", "a real repository's PRs and issues",
 * and a second sync that resumes for "each required connector". The recorded
 * suite beside this one (`connectors.test.ts`) proves the routes, the parsers and
 * the lifecycle over committed fixtures; this one proves the same routes against
 * the providers themselves, through `createConnectorRuntime` — the identical
 * composition `server.ts` uses, with no double anywhere in the path.
 *
 * It needs credentials the repository must never hold, so every case is skipped
 * unless an operator supplies them. Supplying them is the whole remaining work
 * for the live half of those criteria; no code change is needed:
 *
 *   UNAI_SECRETS_MOUNT              directory the secrets manager reads
 *   UNAI_LIVE_GMAIL_ACCOUNT         mailbox address, e.g. uai-test@example.com
 *   UNAI_LIVE_GMAIL_SECRET          secret://mounted/<name> for its Google REFRESH token
 *   UNAI_LIVE_CALENDAR_ACCOUNT      calendar id
 *   UNAI_LIVE_CALENDAR_SECRET       secret://mounted/<name> for its Google REFRESH token
 *   UNAI_LIVE_GITHUB_REPOSITORY     owner/name
 *   UNAI_LIVE_GITHUB_SECRET         secret://mounted/<name> for a read-only fine-grained PAT
 *   UNAI_LIVE_OMI_SECRET            secret://mounted/<name> for an Omi developer key limited to conversations:read
 *
 * Google refresh tokens are minted by the Uai connectors OAuth client.
 * UNAI_GOOGLE_CONNECTOR_CLIENT names its JSON {client_id, client_secret} secret;
 * createConnectorRuntime reads it from process.env. Without it, Google syncs
 * refuse CONNECTOR_OAUTH_CLIENT_MISSING. Revoking a Google token ends its grant.
 *
 * Omi needs no account variable: the developer key names its account. It runs
 * one INCREMENTAL sync of one page (one GET against the hourly limit, ADR 0041
 * D7); a 429 CONNECTOR_RATE_LIMITED means run again later, never a pass. The
 * account must have a completed, non-discarded conversation with transcript
 * segments and a structured summary, or the case fails as misconfigured.
 * There is no Omi disconnect half: Uai cannot revoke the key; the owner revokes
 * it in the Omi app (ADR 0041 D8).
 *
 * The token must carry only the read-only scopes the manifest lists; the suite
 * asserts that the connector requested exactly those and nothing wider, so a
 * token minted with a write scope is a finding about the operator's grant rather
 * than a passing test.
 *
 * Revocation is destructive — it consumes the operator's token — so the
 * disconnect half runs only under `UNAI_LIVE_CONNECTOR_ALLOW_REVOCATION=true`
 * and is skipped even when credentials are present. Everything else this suite
 * does at a provider is a GET, except the Google OAuth refresh-token POST.
 *
 * `pnpm test` therefore reports these as skipped, never as passed. A skipped case
 * is not evidence: while it is skipped, the live half of CRT-CON-02-A,
 * CRT-CON-03-A, CRT-CON-04-A and ADR-0041-LIVE-A stays unverified and is reported as a finding.
 */

if (!process.env.UNAI_TEST_DATABASE_URL) throw new Error('Run pnpm test for the required PostgreSQL harness');
const admin = new Pool({ connectionString: process.env.UNAI_TEST_DATABASE_URL });
const appUrl = new URL(process.env.UNAI_TEST_DATABASE_URL);
appUrl.username = 'connector_live_app'; appUrl.password = 'test-only';
const appPool = new Pool({ connectionString: appUrl.href });

/** A provider is exercised only when both its account reference and a
 * well-formed secret *handle* are configured. A literal credential in the
 * environment is refused here exactly as ADR 0013 refuses it at startup. */
function live(account: string | undefined, secretRef: string | undefined): { account: string; secretRef: string } | null {
  if (!process.env.UNAI_SECRETS_MOUNT || !account || !secretRef) return null;
  if (!isSecretHandle(secretRef)) throw new Error('SECRET_HANDLE_REQUIRED:UNAI_LIVE_*_SECRET');
  return { account, secretRef };
}
const GMAIL = live(process.env.UNAI_LIVE_GMAIL_ACCOUNT, process.env.UNAI_LIVE_GMAIL_SECRET);
const CALENDAR = live(process.env.UNAI_LIVE_CALENDAR_ACCOUNT, process.env.UNAI_LIVE_CALENDAR_SECRET);
const GITHUB = live(process.env.UNAI_LIVE_GITHUB_REPOSITORY, process.env.UNAI_LIVE_GITHUB_SECRET);
// The reserved example address only fills the required externalAccountRef.
const OMI = live('omi-live@example.test', process.env.UNAI_LIVE_OMI_SECRET);
const REVOCATION_ALLOWED = process.env.UNAI_LIVE_CONNECTOR_ALLOW_REVOCATION === 'true';

const configured = GMAIL !== null || CALENDAR !== null || GITHUB !== null || OMI !== null;

beforeAll(async () => {
  if (!configured) return;
  await runMigrations(admin, resolve('migrations'));
  await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='connector_live_app') THEN CREATE ROLE connector_live_app LOGIN PASSWORD 'test-only'; END IF; END $$; GRANT unai_app TO connector_live_app");
});
afterAll(async () => { await appPool.end(); await admin.end(); });

interface Harness {
  app: ReturnType<typeof createPlatformApi>;
  ownerScopeId: string;
  headers(purpose: string): Record<string, string>;
  close(): Promise<void>;
}

/** The production composition: the real secrets manager, the real read-only
 * clients, the real revoker. Only the object store is in-process, because an
 * encrypted bucket is the storage slice's concern and not a connector's. */
async function harness(): Promise<Harness> {
  const adapter = postgresAdapter(admin);
  const user = await adapter.createUser!({ name: 'Live connector test', email: 'live-' + randomUUID() + '@example.test', emailVerified: null });
  const token = randomBytes(32).toString('base64url');
  await adapter.createSession!({ userId: user.id, sessionToken: token, expires: new Date(Date.now() + 86400000) });
  const ownerScopeId = (user as unknown as { ownerScopeId: string }).ownerScopeId;
  const objects = new Map<string, Uint8Array>();
  const evidenceObjects: EvidenceObjects = {
    encryptionKeyRef: 'kms:live-test',
    async put(_tx, id, bytes) { objects.set(id, bytes); },
    async get(_tx, id) { return objects.get(id)!; },
  };
  const app = createPlatformApi({
    authPool: admin, appPool, evidenceObjects, registryReleaseId: randomUUID(),
    connectors: createConnectorRuntime(createDefaultSecretsManager()),
  });
  app.addHook('onRequest', async request => {
    Object.defineProperty(request.raw.socket, 'encrypted', { value: true, configurable: true });
  });
  return {
    app, ownerScopeId,
    headers(purpose) {
      return {
        cookie: SESSION_COOKIE + '=' + token, 'x-owner-scope-id': ownerScopeId, 'x-purpose': purpose,
        'x-correlation-id': randomUUID(), 'idempotency-key': randomUUID(),
        'x-data-purpose': 'PERSONAL_ASSISTANCE', 'x-maximum-sensitivity': 'RESTRICTED',
      };
    },
    async close() { await app.close(); },
  };
}

async function connect(h: Harness, body: Record<string, unknown>) {
  return h.app.inject({ method: 'POST', url: '/v1/connectors', headers: h.headers('connector.manage'), payload: body });
}
async function sync(h: Harness, connectorId: string, body: Record<string, unknown> = {}) {
  return h.app.inject({
    method: 'POST', url: '/v1/connectors/' + connectorId + '/sync', headers: h.headers('connector.sync'),
    payload: { allowedPurposes: ['PERSONAL_ASSISTANCE'], maxPages: 1, ...body },
  });
}
async function items(ownerScopeId: string, sourceType: string) {
  return (await admin.query(
    'SELECT * FROM source_items WHERE owner_scope_id=$1 AND source_type=$2 ORDER BY external_id',
    [ownerScopeId, sourceType])).rows;
}

/** Every scope the connector asked the provider for, and the assertion that runs
 * for all three: a live connector requests read-only scopes and nothing else. */
function assertReadOnlyConsent(connector: { requestedScopes: string[]; capabilities: { access: string; granted: boolean }[] }): void {
  expect(connector.requestedScopes.length).toBeGreaterThan(0);
  for (const scope of connector.requestedScopes) {
    expect(scope).not.toMatch(/(^|[.:])write([:.]|$)|^admin:|^repo$|gmail\.(send|compose|modify|insert)|\.write$/);
  }
  for (const capability of connector.capabilities) {
    if (capability.granted) expect(capability.access).toBe('READ');
  }
}

/** Observe only method and URL, never the Authorization header or body. */
function observeFetch() {
  const original = globalThis.fetch;
  const requests: { method: string; url: URL }[] = [];
  const wrapper: typeof fetch = async (input, init) => {
    requests.push({
      method: (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase(),
      url: new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url),
    });
    return original(input, init);
  };
  return { requests, install() { globalThis.fetch = wrapper; }, restore() { globalThis.fetch = original; } };
}
/** Everything written to the console or the process streams while `run` runs. */
async function capturingLogs<T>(run: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
  const originals = methods.map(method => console[method]);
  const out = process.stdout.write, err = process.stderr.write;
  methods.forEach(method => { console[method] = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); }; });
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => { lines.push(String(chunk)); return (out as (...a: unknown[]) => boolean).call(process.stdout, chunk, ...rest); }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => { lines.push(String(chunk)); return (err as (...a: unknown[]) => boolean).call(process.stderr, chunk, ...rest); }) as typeof process.stderr.write;
  try { return { value: await run(), lines }; }
  finally {
    methods.forEach((method, index) => { console[method] = originals[index]!; });
    process.stdout.write = out; process.stderr.write = err;
  }
}

it.skipIf(GMAIL === null)('CRT-CON-02-A (live): the Gmail connector ingests a real test account\'s threads read-only', async () => {
  const h = await harness();
  try {
    const created = await connect(h, {
      connectorType: 'GMAIL', externalAccountRef: GMAIL!.account, secretRef: GMAIL!.secretRef,
      requestedCapabilities: [{ capabilityId: 'gmail.read_metadata', granted: true },
        { capabilityId: 'gmail.read_content', granted: true }],
    });
    expect(created.statusCode).toBe(201);
    assertReadOnlyConsent(created.json());
    const connectorId = created.json().connectorId;

    const first = await sync(h, connectorId);
    expect(first.statusCode).toBe(200);
    // A real mailbox has to contain at least one thread for this criterion to say
    // anything; an empty test account is a misconfigured one.
    expect(first.json().itemsIngested).toBeGreaterThan(0);
    const rows = await items(h.ownerScopeId, 'GMAIL');
    for (const row of rows) {
      expect(row.external_id).toMatch(/\S/);
      expect(row.deterministic_metadata.threadExternalId).toMatch(/\S/);
    }

    // A request needing a write scope is refused, against the live connector.
    const refused = await h.app.inject({
      method: 'POST', url: '/v1/connectors/' + connectorId + '/capabilities',
      headers: h.headers('connector.manage'),
      payload: { capabilities: [{ capabilityId: 'gmail.send', granted: true }] },
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().code).toBe('CONNECTOR_WRITE_SCOPE_REFUSED');

    // CRT-CON-06-A, live: the second sync resumes and redelivery adds no row.
    const before = rows.length;
    const second = await sync(h, connectorId);
    expect(second.statusCode).toBe(200);
    expect(second.json().resumedFromCursor).toEqual(first.json().newCursor);
    expect((await items(h.ownerScopeId, 'GMAIL')).length - before)
      .toBe(second.json().itemsIngested);
  } finally { await h.close(); }
}, 120000);

it.skipIf(CALENDAR === null)('CRT-CON-03-A (live): the Calendar connector populates start, end and recurrence from structured fields', async () => {
  const h = await harness();
  try {
    const created = await connect(h, {
      connectorType: 'GOOGLE_CALENDAR', externalAccountRef: CALENDAR!.account, secretRef: CALENDAR!.secretRef,
      requestedCapabilities: [{ capabilityId: 'calendar.read', granted: true }],
    });
    expect(created.statusCode).toBe(201);
    assertReadOnlyConsent(created.json());
    expect(created.json().requestedScopes).toEqual(['https://www.googleapis.com/auth/calendar.readonly']);
    const connectorId = created.json().connectorId;

    const result = await sync(h, connectorId);
    expect(result.statusCode).toBe(200);
    expect(result.json().itemsIngested).toBeGreaterThan(0);
    const rows = await items(h.ownerScopeId, 'GOOGLE_CALENDAR');
    for (const row of rows) {
      // `occurred_at` is the occurrence's own start and the recurrence id is the
      // provider's `recurringEventId`: both come from structured fields, neither
      // is inferred from the summary text.
      expect(row.occurred_at).not.toBeNull();
      expect(row.deterministic_metadata.recurrenceId).toMatch(/\S/);
      expect(row.parent_external_id).toMatch(/\S/);
      const anchored = (await admin.query(
        `SELECT anchor->>'field' AS field,normalized_text FROM source_anchors
         WHERE owner_scope_id=$1 AND source_item_id=$2 AND anchor_kind='CALENDAR_FIELD'`,
        [h.ownerScopeId, row.id])).rows;
      const byField = new Map(anchored.map(anchor => [anchor.field, anchor.normalized_text]));
      // start, end and recurrence are all anchored; start and end carry a value
      // for every event a calendar can return.
      expect([...byField.keys()].sort()).toEqual(['end', 'recurrence', 'start']);
      expect(byField.get('start')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(byField.get('end')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      // A recurring occurrence carries the series' own RRULE; a single event has
      // no recurrence and stores none rather than an invented one.
      const recurrence = row.deterministic_metadata.recurrence as string[];
      if (recurrence.length > 0) expect(byField.get('recurrence')).toContain('RRULE:');
      else expect(byField.get('recurrence')).toBeNull();
    }
    // At least one occurrence of the test calendar must be recurring, or the
    // recurrence half of this criterion says nothing.
    expect(rows.some(row => (row.deterministic_metadata.recurrence as string[]).length > 0)).toBe(true);

    const second = await sync(h, connectorId);
    expect(second.json().resumedFromCursor).toEqual(result.json().newCursor);
  } finally { await h.close(); }
}, 120000);

it.skipIf(GITHUB === null)('CRT-CON-04-A (live): a real repository\'s PRs and issues ingest, a PR burst as one episode', async () => {
  const h = await harness();
  try {
    const created = await connect(h, {
      connectorType: 'GITHUB', externalAccountRef: GITHUB!.account, secretRef: GITHUB!.secretRef,
      requestedCapabilities: [{ capabilityId: 'github.read_pull_requests', granted: true },
        { capabilityId: 'github.read_issues', granted: true }],
    });
    expect(created.statusCode).toBe(201);
    assertReadOnlyConsent(created.json());
    const connectorId = created.json().connectorId;

    const result = await sync(h, connectorId);
    expect(result.statusCode).toBe(200);
    expect(result.json().itemsIngested).toBeGreaterThan(0);
    const rows = await items(h.ownerScopeId, 'GITHUB');
    // Each pull request that carried commits or CI runs folded them into exactly
    // one episode item, rather than one semantic extraction each.
    const episodes = rows.filter(row => row.external_id.endsWith('/episode'));
    const triaged = (await admin.query(
      'SELECT count(*)::int AS n FROM triage_decisions WHERE owner_scope_id=$1 AND source_item_id=ANY($2::uuid[])',
      [h.ownerScopeId, episodes.map(row => row.id)])).rows[0].n;
    expect(triaged).toBe(episodes.length);
    expect(result.json().episodesAggregated).toBe(episodes.length);
    for (const episode of episodes) {
      expect(episode.deterministic_metadata.episodeKind).toBe('COMMIT_AND_CI_BURST');
      const aggregated = episode.deterministic_metadata.aggregatedEventCount as number;
      expect(aggregated).toBeGreaterThan(0);
      // Every aggregated commit and CI run is still individually anchored on the
      // one episode: the burst is folded, not discarded.
      expect((await admin.query(
        'SELECT count(*)::int AS n FROM source_anchors WHERE owner_scope_id=$1 AND source_item_id=$2',
        [h.ownerScopeId, episode.id])).rows[0].n).toBe(aggregated);
    }
    // No semantic extraction ran for any of them: aggregation is an ingestion
    // decision, and a burst costs one triage decision rather than one per event.
    expect((await admin.query(
      'SELECT count(*)::int AS n FROM extraction_runs WHERE owner_scope_id=$1', [h.ownerScopeId])).rows[0].n).toBe(0);

    const second = await sync(h, connectorId);
    expect(second.json().resumedFromCursor).toEqual(result.json().newCursor);
  } finally { await h.close(); }
}, 180000);

it.skipIf(OMI === null)('ADR-0041-LIVE-A (live): the Omi connector ingests real conversations read-only, transcripts anchored by segment and the Omi summary SOURCE_ONLY', async () => {
  const h = await harness();
  const observed = observeFetch();
  try {
    const key = await createDefaultSecretsManager().resolve(OMI!.secretRef);
    observed.install();
    const bodies: string[] = [];
    const { value: result, lines } = await capturingLogs(async () => {
      console.info('omi-live-log-canary');
      const created = await connect(h, {
        connectorType: 'OMI', externalAccountRef: OMI!.account, secretRef: OMI!.secretRef,
        requestedCapabilities: [{ capabilityId: 'omi.read_conversations', granted: true }],
      });
      bodies.push(created.body);
      expect(created.statusCode).toBe(201);
      assertReadOnlyConsent(created.json());
      expect(created.json().requestedScopes).toEqual(['conversations:read']);
      const synced = await sync(h, created.json().connectorId, { mode: 'INCREMENTAL' });
      bodies.push(synced.body);
      expect(synced.statusCode).toBe(200);
      return synced.json<{ mode: string; pagesFetched: number; itemsIngested: number; storedSensitivity: string }>();
    });
    expect(result.mode).toBe('INCREMENTAL');
    expect(result.pagesFetched).toBe(1);
    expect(result.itemsIngested).toBeGreaterThan(0);
    expect(result.storedSensitivity).toBe('PRIVATE');
    expect(observed.requests.length).toBe(result.pagesFetched);
    for (const request of observed.requests) {
      expect([request.method, request.url.origin + request.url.pathname])
        .toEqual(['GET', 'https://api.omi.me/v1/dev/user/conversations']);
    }
    const rows = await items(h.ownerScopeId, 'OMI') as { id: string; external_id: string; sensitivity: string }[];
    expect(rows.length).toBeGreaterThan(0);
    expect([...new Set(rows.map(row => row.sensitivity))]).toEqual(['PRIVATE']);
    const structured = rows.filter(row => row.external_id.endsWith(':structured'));
    const transcripts = rows.filter(row => !row.external_id.endsWith(':structured'));
    // Like Calendar's recurrence guard, require a summary so SOURCE_ONLY is not vacuous.
    expect(structured.length).toBeGreaterThan(0);
    expect(transcripts.length).toBeGreaterThan(0);
    const kinds = (await admin.query<{ anchor_kind: string }>(
      'SELECT anchor_kind FROM source_anchors WHERE owner_scope_id=$1 AND source_item_id=ANY($2::uuid[])',
      [h.ownerScopeId, transcripts.map(row => row.id)])).rows.map(row => row.anchor_kind);
    expect(kinds.length).toBeGreaterThan(0);
    expect([...new Set(kinds)]).toEqual(['TRANSCRIPT_SEGMENT']);
    const routes = (await admin.query<{ tier1_route: string }>(
      'SELECT tier1_route FROM triage_decisions WHERE owner_scope_id=$1 AND source_item_id=ANY($2::uuid[])',
      [h.ownerScopeId, structured.map(row => row.id)])).rows.map(row => row.tier1_route);
    expect(routes.length).toBe(structured.length);
    expect([...new Set(routes)]).toEqual(['SOURCE_ONLY']);
    expect(key.length).toBeGreaterThanOrEqual(16);
    expect(lines.some(line => line.includes('omi-live-log-canary'))).toBe(true);
    // Only booleans enter matchers: a failure must not print private text or the key.
    for (const text of [...bodies, ...lines]) expect(text.includes(key)).toBe(false);
  } finally { observed.restore(); await h.close(); }
}, 120000);

/**
 * The destructive half of CRT-CON-06-A. It really revokes the operator's token
 * at the provider, so it is opt-in beyond the credentials themselves and the
 * operator must expect to mint a new one afterwards.
 */
it.skipIf(GMAIL === null || !REVOCATION_ALLOWED)('CRT-CON-06-A (live): disconnect revokes the token at the provider and stops ingestion', async () => {
  const h = await harness();
  try {
    const created = await connect(h, {
      connectorType: 'GMAIL', externalAccountRef: GMAIL!.account, secretRef: GMAIL!.secretRef,
      requestedCapabilities: [{ capabilityId: 'gmail.read_metadata', granted: true }],
    });
    const connectorId = created.json().connectorId;
    const disconnected = await h.app.inject({
      method: 'POST', url: '/v1/connectors/' + connectorId + '/disconnect',
      headers: h.headers('connector.manage'), payload: {},
    });
    expect(disconnected.statusCode).toBe(200);
    expect(disconnected.json()).toMatchObject({
      status: 'DISCONNECTED', tokensRevokedAtProvider: true, secretReferenceDestroyed: true, ingestionStopped: true,
    });
    const row = (await admin.query('SELECT status,secret_ref FROM connectors WHERE id=$1', [connectorId])).rows[0];
    expect(row).toMatchObject({ status: 'DISCONNECTED', secret_ref: null });
    const after = await sync(h, connectorId);
    expect(after.statusCode).toBe(409);
    expect(after.json().code).toBe('CONNECTOR_INGESTION_STOPPED');
  } finally { await h.close(); }
}, 120000);
