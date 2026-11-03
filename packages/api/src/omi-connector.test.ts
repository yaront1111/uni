/**
 * Held-out OMI connector API acceptance tests: ADR 0041 D2, D3, D6, D7 and D8
 * (task-9fd2751b432d479b9ad9dc0fd9afff2a). They drive the real createPlatformApi
 * and createConnectorRuntime; Omi HTTP and SecretsManager are doubled, alongside
 * the existing in-memory EvidenceObjects harness (no connector/runtime double).
 * Written before sync (task-8e528f0c), disconnect (task-359a705a) and triage
 * (task-d3956af0): every case is skipped and red by design.
 *
 * Only task-8e528f0cad59476695b2b1a1dfb945b6 may change this file, and only by deleting the `.skip` of each `it.skip(` line. Any other edit is a QA rejection. A case that looks wrong is raised with the architect (task comment or moe.report_blocked), never edited.
 *
 * Owner decisions, 2026-11-03 (comment-0a4728e4762844d48265b911b7cd71e6): case 6
 * follows connector-sync-job.ts on a 401; case 5 permits <10 s and exactly one
 * provider request. The key is invented at run time, never written here
 * (ADR 0041 D6, FR-104). These skipped tests do not claim live-account coverage.
 */
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runMigrations } from '@unai/postgres';
import { postgresAdapter, SESSION_COOKIE } from '@unai/auth';
import type { SecretsManager } from '@unai/secrets';
import { createPlatformApi } from './platform.js';
import { createConnectorRuntime } from './connectors.js';
import type { EvidenceObjects } from './evidence.js';

// All-skipped suites run neither hook: collection needs no database.
let admin!: Pool;
let appPool!: Pool;
beforeAll(async () => {
  const databaseUrl = process.env.UNAI_TEST_DATABASE_URL;
  if (!databaseUrl) throw new Error('Run pnpm test for the required PostgreSQL harness');
  admin = new Pool({ connectionString: databaseUrl });
  const appUrl = new URL(databaseUrl);
  appUrl.username = 'omi_connector_test_app'; appUrl.password = 'test-only';
  appPool = new Pool({ connectionString: appUrl.href });
  await runMigrations(admin, resolve('migrations'));
  await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='omi_connector_test_app') THEN CREATE ROLE omi_connector_test_app LOGIN PASSWORD 'test-only'; END IF; END $$; GRANT unai_app TO omi_connector_test_app");
});
afterAll(async () => { await appPool?.end(); await admin?.end(); });

const OMI_LIST = 'https://api.omi.me/v1/dev/user/conversations';
const HANDLE = 'secret://test/omi-key';
const KEY = 'omi_dev_' + randomBytes(24).toString('hex');
const BODY_MARKER = 'omi-provider-body-' + randomUUID();
const DAY_MS = 86_400_000;
const ALLOWED_QUERY = ['end_date', 'include_transcript', 'limit', 'offset', 'start_date'];
interface OmiFixture {
  id: string;
  created_at: string;
  transcript_segments: unknown[];
  structured: { action_items: unknown[] };
}
async function omiFixture(): Promise<OmiFixture> {
  return JSON.parse(await readFile(resolve('fixtures/sources/omi-conversation.json'), 'utf8')) as OmiFixture;
}
function fixtureRefs(fixture: OmiFixture) {
  const transcriptId = 'omi:conversation:' + fixture.id;
  return {
    transcriptId, structuredId: transcriptId + ':structured',
    closedPosition: 'omi:hwm=' + fixture.created_at + '/' + fixture.id + ';before=none;offset=0',
    openPosition: 'omi:hwm=none/none;before=' + fixture.created_at + ';offset=0',
    lookbackStart: new Date(Date.parse(fixture.created_at) - DAY_MS).toISOString(),
  };
}
interface ProviderRequest {
  method: string; url: URL; headers: Record<string, string>; redirect: RequestRedirect | null;
}
function failure(status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ detail: BODY_MARKER }), {
    status, headers: { 'content-type': 'application/json', ...headers },
  });
}
function page(items: unknown[], headers: Record<string, string> = { 'x-omi-has-more': 'false' }): Response {
  return Response.json(items, { headers });
}
function omiProvider() {
  const original = globalThis.fetch;
  const requests: ProviderRequest[] = [];
  const replies: (() => Response)[] = [];
  const fake: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    requests.push({ method: (init?.method ?? 'GET').toUpperCase(), url,
      headers: Object.fromEntries(new Headers(init?.headers)), redirect: init?.redirect ?? null });
    if (url.origin + url.pathname !== OMI_LIST) return new Response('{}', { status: 404 });
    return replies.shift()?.() ?? failure(500);
  };
  return { requests, replies, install() { globalThis.fetch = fake; }, restore() { globalThis.fetch = original; } };
}
function secretsDouble() {
  const resolved: string[] = [];
  const manager: SecretsManager = {
    async resolve(handle) {
      resolved.push(handle);
      if (handle !== HANDLE) throw new Error('SECRET_NOT_FOUND');
      return KEY;
    },
  };
  return { manager, resolved };
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
async function harness() {
  const adapter = postgresAdapter(admin);
  const user = await adapter.createUser!({ name: 'Omi test', email: 'omi-' + randomUUID() + '@example.test', emailVerified: null });
  const token = randomBytes(32).toString('base64url');
  await adapter.createSession!({ userId: user.id, sessionToken: token, expires: new Date(Date.now() + DAY_MS) });
  const ownerScopeId = (user as unknown as { ownerScopeId: string }).ownerScopeId;
  const objects = new Map<string, Uint8Array>();
  const evidenceObjects: EvidenceObjects = {
    encryptionKeyRef: 'kms:test-double',
    async put(_tx, id, bytes) { objects.set(id, bytes); },
    async get(_tx, id) {
      const bytes = objects.get(id);
      if (!bytes) throw new Error('TEST_OBJECT_MISSING');
      return bytes;
    },
  };
  const omi = omiProvider(), secrets = secretsDouble();
  const app = createPlatformApi({ authPool: admin, appPool, evidenceObjects,
    registryReleaseId: randomUUID(), connectors: createConnectorRuntime(secrets.manager) });
  app.addHook('onRequest', async request => {
    Object.defineProperty(request.raw.socket, 'encrypted', { value: true, configurable: true });
  });
  const result = {
    app, ownerScopeId, omi, secrets, objects, bodies: [] as string[],
    headers(purpose: string, extra: Record<string, string> = {}) {
      return {
        cookie: SESSION_COOKIE + '=' + token, 'x-owner-scope-id': ownerScopeId, 'x-purpose': purpose,
        'x-correlation-id': randomUUID(), 'idempotency-key': randomUUID(),
        'x-data-purpose': 'PERSONAL_ASSISTANCE', 'x-maximum-sensitivity': 'RESTRICTED', ...extra,
      };
    },
    async close() { omi.restore(); await app.close(); },
  };
  // Nothing that can fail during setup follows installing the process-global double.
  omi.install();
  return result;
}
type Harness = Awaited<ReturnType<typeof harness>>;
interface Cursor { position: string; providerToken: string }
interface SyncBody { newCursor: Cursor; evidenceIds: string[] }
interface ConnectorBody {
  connectorId: string;
  capabilities: { capabilityId: string; access: string; riskClass: string; scopes: string[]; granted: boolean }[];
}
async function connectOmi(h: Harness, overrides: Record<string, unknown> = {}) {
  const response = await h.app.inject({ method: 'POST', url: '/v1/connectors', headers: h.headers('connector.manage'),
    payload: { connectorType: 'OMI', externalAccountRef: 'owner@example.test', secretRef: HANDLE,
      requestedCapabilities: [{ capabilityId: 'omi.read_conversations', granted: true }], ...overrides } });
  h.bodies.push(response.body);
  return response;
}
async function grant(h: Harness, id: string, capabilities: { capabilityId: string; granted: boolean }[]) {
  const response = await h.app.inject({ method: 'POST', url: '/v1/connectors/' + id + '/capabilities',
    headers: h.headers('connector.manage'), payload: { capabilities } });
  h.bodies.push(response.body);
  return response;
}
async function sync(h: Harness, id: string, body: Record<string, unknown> = {}, extra: Record<string, string> = {}) {
  const response = await h.app.inject({ method: 'POST', url: '/v1/connectors/' + id + '/sync',
    headers: h.headers('connector.sync', extra), payload: { allowedPurposes: ['PERSONAL_ASSISTANCE'], ...body } });
  h.bodies.push(response.body);
  return response;
}
async function disconnect(h: Harness, id: string) {
  const response = await h.app.inject({ method: 'POST', url: '/v1/connectors/' + id + '/disconnect',
    headers: h.headers('connector.manage'), payload: {} });
  h.bodies.push(response.body);
  return response;
}
interface ConnectorRow {
  status: string; secret_ref: string | null; last_cursor: Cursor | null; last_sync_error: string | null;
  cursor_updated_at: Date | null; disconnected_at: Date | null;
}
async function connectorRow(id: string): Promise<ConnectorRow> {
  const { rows } = await admin.query<ConnectorRow>(
    'SELECT status,secret_ref,last_cursor,last_sync_error,cursor_updated_at,disconnected_at FROM connectors WHERE id=$1 ORDER BY id', [id]);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}
interface ItemRow {
  id: string; external_id: string; source_type: string; actor_ref: { type: string; id: string };
  parent_external_id: string | null; sensitivity: string;
}
async function itemRows(owner: string): Promise<ItemRow[]> {
  return (await admin.query<ItemRow>(
    'SELECT id,external_id,source_type,actor_ref,parent_external_id,sensitivity FROM source_items WHERE owner_scope_id=$1 ORDER BY external_id', [owner])).rows;
}
async function count(sql: string, values: string[]): Promise<number> {
  const { rows } = await admin.query<{ n: string }>(sql, values);
  expect(rows).toHaveLength(1);
  return Number(rows[0]!.n);
}

it.skip('(1) ADR 0041 D6: an OMI connector gets one HIGH read grant and Omi write capabilities are refused by name', async () => {
  const h = await harness();
  try {
    const connected = await connectOmi(h);
    expect(connected.statusCode).toBe(201);
    const body = connected.json<ConnectorBody>(), id = body.connectorId;
    expect(body).toMatchObject({ connectorType: 'OMI', manifestId: 'connector.omi', displayName: 'Omi wearable (read-only)',
      status: 'ACTIVE', promptInjectionRisk: 'HIGH', grantedCapabilities: ['omi.read_conversations'],
      requestedScopes: ['conversations:read'], credentialHeld: true, cursor: null });
    expect(body.capabilities.map(c => [c.capabilityId, c.access, c.riskClass, c.scopes, c.granted]))
      .toEqual([['omi.read_conversations', 'READ', 'HIGH', ['conversations:read'], true]]);
    expect(connected.body).not.toContain('secret://');
    const grants = await admin.query(
      'SELECT capability_id,granted,risk_class,access_kind FROM connector_capability_grants WHERE connector_id=$1 ORDER BY capability_id', [id]);
    expect(grants.rows).toEqual([{ capability_id: 'omi.read_conversations', granted: true, risk_class: 'HIGH', access_kind: 'READ' }]);
    expect((await connectorRow(id)).secret_ref).toBe(HANDLE);
    const refused = await connectOmi(h, { externalAccountRef: 'second@example.test',
      requestedCapabilities: [{ capabilityId: 'omi.write_conversations', granted: true }] });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ code: 'CONNECTOR_WRITE_SCOPE_REFUSED',
      capabilityId: 'omi.write_conversations', reason: 'V0_IS_READ_ONLY' });
    expect(await count('SELECT count(*) AS n FROM connectors WHERE owner_scope_id=$1 AND external_account_ref=$2',
      [h.ownerScopeId, 'second@example.test'])).toBe(0);
    const refusedGrant = await grant(h, id, [{ capabilityId: 'omi.write_memories', granted: true }]);
    expect(refusedGrant.statusCode).toBe(403);
    expect(refusedGrant.json()).toMatchObject({ code: 'CONNECTOR_WRITE_SCOPE_REFUSED',
      capabilityId: 'omi.write_memories', reason: 'V0_IS_READ_ONLY' });
    expect(await count('SELECT count(*) AS n FROM connector_capability_grants WHERE connector_id=$1', [id])).toBe(1);
    expect(h.omi.requests).toHaveLength(0);
    expect(h.secrets.resolved).toEqual([]);
  } finally { await h.close(); }
}, 60_000);

async function assertStoredItems(owner: string, fixture: OmiFixture): Promise<ItemRow[]> {
  const refs = fixtureRefs(fixture), items = await itemRows(owner);
  expect(items.map(item => item.external_id)).toEqual([refs.transcriptId, refs.structuredId]);
  expect(items.map(item => item.source_type)).toEqual(['OMI', 'OMI']);
  expect(items.map(item => item.actor_ref)).toEqual([
    { type: 'EXTERNAL', id: 'omi:transcript' }, { type: 'ASSISTANT', id: 'omi:structured' },
  ]);
  expect(items.map(item => item.parent_external_id)).toEqual([null, refs.transcriptId]);
  const anchors = await admin.query<{ anchor_kind: string; i: number }>(
    "SELECT anchor_kind,(anchor->>'segmentIndex')::int AS i FROM source_anchors WHERE owner_scope_id=$1 AND source_item_id=$2 ORDER BY i,id",
    [owner, items[0]!.id]);
  expect(anchors.rows.map(row => row.anchor_kind)).toEqual(fixture.transcript_segments.map(() => 'TRANSCRIPT_SEGMENT'));
  expect(anchors.rows.map(row => row.i)).toEqual(fixture.transcript_segments.map((_, i) => i));
  const structuredAnchors = await admin.query<{ anchor_kind: string; path: string }>(
    "SELECT anchor_kind,anchor->>'path' AS path FROM source_anchors WHERE owner_scope_id=$1 AND source_item_id=$2 ORDER BY path,id",
    [owner, items[1]!.id]);
  expect(structuredAnchors.rows.map(row => [row.anchor_kind, row.path])).toEqual([
    ['CONNECTOR_JSON_PATH', '$.structured.action_items[0].description'],
    ['CONNECTOR_JSON_PATH', '$.structured.overview'], ['CONNECTOR_JSON_PATH', '$.structured.title'],
  ]);
  return items;
}
interface TriageRow { source_item_id: string; tier1_route: string; routing_reason: { code: string; positiveSignals: string[] } }
it.skip('(2) ADR 0041 D2/D3/D7: the first sync stores two items, TRANSCRIPT_SEGMENT anchors, triage routes and the cursor', async () => {
  const h = await harness();
  try {
    const fixture = await omiFixture(), refs = fixtureRefs(fixture);
    const connected = await connectOmi(h);
    expect(connected.statusCode).toBe(201);
    const id = connected.json<ConnectorBody>().connectorId;
    h.omi.replies.push(() => page([fixture]));
    const response = await sync(h, id);
    expect(response.statusCode).toBe(200);
    const body = response.json<SyncBody>();
    expect(body).toMatchObject({ resumedFromCursor: null, pagesFetched: 1, itemsIngested: 2,
      duplicatesSuppressed: 0, refusals: [], storedSensitivity: 'PRIVATE' });
    expect(body.evidenceIds).toHaveLength(2);
    expect(body.newCursor.position).toBe(refs.closedPosition);
    expect(JSON.parse(body.newCursor.providerToken)).toEqual({ v: 1, hwm: fixture.created_at, hwmId: fixture.id,
      top: null, topId: null, before: null, offset: 0 });
    expect(h.omi.requests).toHaveLength(1);
    const request = h.omi.requests[0]!;
    expect(request.method).toBe('GET');
    expect(request.url.origin + request.url.pathname).toBe(OMI_LIST);
    expect(request.url.searchParams.get('include_transcript')).toBe('true');
    expect(request.url.searchParams.get('limit')).toBe('50');
    expect(request.url.searchParams.get('offset')).toBe('0');
    expect(request.url.searchParams.has('start_date')).toBe(false);
    expect(request.url.searchParams.has('end_date')).toBe(false);
    const row = await connectorRow(id);
    expect(row.last_cursor).toEqual(body.newCursor);
    expect(row.cursor_updated_at).toBeInstanceOf(Date);
    expect(row.last_sync_error).toBe(null);
    const items = await assertStoredItems(h.ownerScopeId, fixture);
    const triage = (await admin.query<TriageRow>(
      'SELECT source_item_id,tier1_route,routing_reason FROM triage_decisions WHERE owner_scope_id=$1 ORDER BY source_item_id,id', [h.ownerScopeId])).rows;
    expect(triage).toHaveLength(2);
    expect(triage.filter(r => r.source_item_id === items[1]!.id).map(r => [r.tier1_route, r.routing_reason.code]))
      .toEqual([['SOURCE_ONLY', 'ASSISTANT_AUTHORED']]);
    // LAST: task-d3956af0 supplies ownerSegmentCount -> USER_AUTHORED (not the EXTERNAL actor).
    const transcript = triage.filter(r => r.source_item_id === items[0]!.id);
    expect(transcript.map(r => [r.tier1_route, r.routing_reason.code])).toEqual([['FULL_EXTRACTION', 'MEMORY_WORTHY_SIGNALS']]);
    expect(transcript[0]!.routing_reason.positiveSignals).toContain('USER_AUTHORED');
  } finally { await h.close(); }
}, 60_000);

it.skip('(3) ADR 0041 D2/D7: a second sync resumes with the 24 h lookback and suppresses the redelivered conversation', async () => {
  const h = await harness();
  try {
    const fixture = await omiFixture(), refs = fixtureRefs(fixture);
    const connected = await connectOmi(h);
    expect(connected.statusCode).toBe(201);
    const id = connected.json<ConnectorBody>().connectorId;
    h.omi.replies.push(() => page([fixture]), () => page([fixture]));
    const first = await sync(h, id);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ itemsIngested: 2, duplicatesSuppressed: 0 });
    const cursor = first.json<SyncBody>().newCursor;
    expect((await connectorRow(id)).last_cursor).toEqual(cursor);
    const second = await sync(h, id);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ resumedFromCursor: cursor, newCursor: cursor,
      pagesFetched: 1, itemsIngested: 0, duplicatesSuppressed: 2 });
    expect(await count('SELECT count(*) AS n FROM source_items WHERE owner_scope_id=$1', [h.ownerScopeId])).toBe(2);
    expect(await count('SELECT count(*) AS n FROM source_anchors WHERE owner_scope_id=$1', [h.ownerScopeId]))
      .toBe(fixture.transcript_segments.length + 3);
    expect(await count('SELECT count(*) AS n FROM triage_decisions WHERE owner_scope_id=$1', [h.ownerScopeId])).toBe(2);
    expect(h.omi.requests).toHaveLength(2);
    expect(h.omi.requests[1]!.url.search).not.toBe(h.omi.requests[0]!.url.search);
    const query = h.omi.requests[1]!.url.searchParams;
    expect(query.get('start_date')).toBe(refs.lookbackStart);
    expect(query.has('end_date')).toBe(false);
    expect(query.get('offset')).toBe('0');
    expect((await connectorRow(id)).last_cursor).toEqual(cursor);
  } finally { await h.close(); }
}, 60_000);

it.skip('(4) ADR 0041 D7: truncated pages keep the window open, including empty pages; a closing page ends the run', async () => {
  const h = await harness();
  try {
    const fixture = await omiFixture(), refs = fixtureRefs(fixture);
    const connected = await connectOmi(h);
    expect(connected.statusCode).toBe(201);
    const id = connected.json<ConnectorBody>().connectorId;
    h.omi.replies.push(() => page([fixture], { 'x-omi-list-truncated': 'true' }),
      () => page([], { 'x-omi-list-truncated': 'true' }));
    const first = await sync(h, id, { maxPages: 3 });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ pagesFetched: 2, itemsIngested: 2 });
    const openCursor = first.json<SyncBody>().newCursor;
    expect(openCursor.position).toBe(refs.openPosition);
    expect(h.omi.requests).toHaveLength(2);
    const secondQuery = h.omi.requests[1]!.url.searchParams;
    expect(secondQuery.has('start_date')).toBe(false);
    expect(secondQuery.get('end_date')).toBe(fixture.created_at);
    expect(secondQuery.get('offset')).toBe('0');
    h.omi.replies.push(() => page([fixture])); // end_date is inclusive: the boundary returns.
    const second = await sync(h, id, { maxPages: 2 });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ resumedFromCursor: openCursor, pagesFetched: 1, itemsIngested: 0, duplicatesSuppressed: 2 });
    expect(second.json<SyncBody>().newCursor.position).toBe(refs.closedPosition);
    expect(h.omi.requests).toHaveLength(3); // exhausted must stop the otherwise permitted fourth request.
    expect(h.omi.requests[2]!.url.searchParams.get('end_date')).toBe(fixture.created_at);
    expect(h.omi.requests[2]!.url.searchParams.has('start_date')).toBe(false);
    expect((await connectorRow(id)).last_cursor?.position).toBe(refs.closedPosition);
  } finally { await h.close(); }
}, 60_000);

it.skip('(5) ADR 0041 D7: a 429 fails at once with CONNECTOR_RATE_LIMITED and the next sync resumes from the stored cursor', async () => {
  const h = await harness();
  try {
    const fixture = await omiFixture(), connected = await connectOmi(h);
    expect(connected.statusCode).toBe(201);
    const id = connected.json<ConnectorBody>().connectorId;
    h.omi.replies.push(() => page([fixture]));
    const first = await sync(h, id);
    expect(first.statusCode).toBe(200);
    const cursor = first.json<SyncBody>().newCursor;
    h.omi.replies.push(() => failure(429, { 'retry-after': '30' }));
    const started = performance.now();
    const limited = await sync(h, id);
    const elapsed = performance.now() - started;
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ code: 'CONNECTOR_RATE_LIMITED', retryAfterSeconds: 30 });
    expect(limited.body).not.toContain(BODY_MARKER);
    // Owner, 2026-11-03, comment-0a4728e4762844d48265b911b7cd71e6:
    // <10 s (one third of Retry-After) plus one request, with host-load headroom.
    expect(elapsed).toBeLessThan(10_000);
    expect(h.omi.requests).toHaveLength(2);
    expect(await connectorRow(id)).toMatchObject({ status: 'SYNC_FAILED', last_sync_error: 'CONNECTOR_RATE_LIMITED',
      last_cursor: cursor, secret_ref: HANDLE });
    expect(await count('SELECT count(*) AS n FROM source_items WHERE owner_scope_id=$1', [h.ownerScopeId])).toBe(2);
    h.omi.replies.push(() => page([fixture]));
    const resumed = await sync(h, id);
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json()).toMatchObject({ resumedFromCursor: cursor, itemsIngested: 0, duplicatesSuppressed: 2 });
    expect(h.omi.requests).toHaveLength(3);
    expect(h.omi.requests[2]!.url.search).toBe(h.omi.requests[1]!.url.search);
    expect(await connectorRow(id)).toMatchObject({ status: 'ACTIVE', last_sync_error: null });
  } finally { await h.close(); }
}, 60_000);

it.skip('(6) ADR 0041 D7 with the connector.sync job rule: a 401 marks TOKEN_REVOKED and the next sync is stopped without calling Omi', async () => {
  const h = await harness();
  try {
    const connected = await connectOmi(h);
    expect(connected.statusCode).toBe(201);
    const id = connected.json<ConnectorBody>().connectorId;
    h.omi.replies.push(() => failure(401));
    const revoked = await sync(h, id);
    expect(revoked.statusCode).toBe(409);
    expect(revoked.json<{ code: string }>().code).toBe('CONNECTOR_TOKEN_REVOKED');
    expect(revoked.body).not.toContain(BODY_MARKER);
    // Owner, 2026-11-03, comment-0a4728e4762844d48265b911b7cd71e6:
    // match connector-sync-job.ts on 401, never 403; refuse a stopped connector
    // before building its client. task-8e528f0c supplies both route changes.
    // Before that change this row is SYNC_FAILED, and a cleared handle answers
    // CONNECTOR_CREDENTIAL_MISSING before runConnectorSync can check status.
    expect(await connectorRow(id)).toMatchObject({ status: 'TOKEN_REVOKED', secret_ref: null,
      last_sync_error: 'CONNECTOR_TOKEN_REVOKED', last_cursor: null });
    const stopped = await sync(h, id);
    expect(stopped.statusCode).toBe(409);
    expect(stopped.json<{ code: string }>().code).toBe('CONNECTOR_INGESTION_STOPPED');
    expect(h.omi.requests).toHaveLength(1);
    expect(h.secrets.resolved).toHaveLength(1);
    expect(await count('SELECT count(*) AS n FROM source_items WHERE owner_scope_id=$1', [h.ownerScopeId])).toBe(0);
  } finally { await h.close(); }
}, 60_000);

it.skip('(7) ADR 0041 D8: disconnect revokes grants, forgets the handle and reports manual revocation without calling Omi or resolving the key', async () => {
  const h = await harness();
  try {
    const fixture = await omiFixture(), connected = await connectOmi(h);
    expect(connected.statusCode).toBe(201);
    const id = connected.json<ConnectorBody>().connectorId;
    h.omi.replies.push(() => page([fixture]));
    const synced = await sync(h, id);
    expect(synced.statusCode).toBe(200);
    expect(synced.json()).toMatchObject({ itemsIngested: 2 });
    expect(synced.json<SyncBody>().newCursor.position).toBe(fixtureRefs(fixture).closedPosition);
    const before = { requests: h.omi.requests.length, resolved: h.secrets.resolved.length };
    const response = await disconnect(h, id);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ connectorId: id, status: 'DISCONNECTED', tokensRevokedAtProvider: false,
      secretReferenceDestroyed: true, ingestionStopped: true, capabilitiesRevoked: ['omi.read_conversations'],
      retainedEvidence: 'RETAINED', retainedEvidenceOptions: ['KEEP_EVIDENCE', 'REQUEST_DELETION'],
      providerRevocationNotice: 'CONNECTOR_REVOCATION_MANUAL_REQUIRED' });
    // D8 rule 1: the OMI branch must precede secrets.resolve, not just fetch.
    expect(h.omi.requests).toHaveLength(before.requests);
    expect(h.secrets.resolved).toHaveLength(before.resolved);
    const row = await connectorRow(id);
    expect(row).toMatchObject({ status: 'DISCONNECTED', secret_ref: null, last_cursor: null });
    expect(row.disconnected_at).toBeInstanceOf(Date);
    expect(await count('SELECT count(*) AS n FROM connector_capability_grants WHERE connector_id=$1', [id])).toBe(1);
    expect(await count('SELECT count(*) AS n FROM connector_capability_grants WHERE connector_id=$1 AND (granted OR revoked_at IS NULL)', [id])).toBe(0);
    expect(await count('SELECT count(*) AS n FROM source_items WHERE owner_scope_id=$1', [h.ownerScopeId])).toBe(2);
    // LAST: the owner's 2026-11-03 stopped-before-client decision (task-8e528f0c).
    const stopped = await sync(h, id);
    expect(stopped.statusCode).toBe(409);
    expect(stopped.json<{ code: string }>().code).toBe('CONNECTOR_INGESTION_STOPPED');
    expect(h.omi.requests).toHaveLength(before.requests);
    expect(h.secrets.resolved).toHaveLength(before.resolved);
  } finally { await h.close(); }
}, 60_000);

it.skip('(8) ADR 0041 D6: a ceiling below PRIVATE is refused and a request asking for NORMAL still stores PRIVATE', async () => {
  const h = await harness();
  try {
    const fixture = await omiFixture(), connected = await connectOmi(h);
    expect(connected.statusCode).toBe(201);
    const id = connected.json<ConnectorBody>().connectorId;
    const refused = await sync(h, id, { sensitivity: 'NORMAL' }, { 'x-maximum-sensitivity': 'NORMAL' });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ code: 'CONNECTOR_SENSITIVITY_CEILING_TOO_LOW', connectorType: 'OMI',
      maximumSensitivity: 'NORMAL', storedSensitivity: 'PRIVATE' });
    expect(h.omi.requests).toHaveLength(0);
    expect(await count('SELECT count(*) AS n FROM source_items WHERE owner_scope_id=$1', [h.ownerScopeId])).toBe(0);
    h.omi.replies.push(() => page([fixture]));
    const stored = await sync(h, id, { sensitivity: 'NORMAL' }, { 'x-maximum-sensitivity': 'PRIVATE' });
    expect(stored.statusCode).toBe(200);
    expect(stored.json()).toMatchObject({ requestedSensitivity: 'NORMAL', storedSensitivity: 'PRIVATE', itemsIngested: 2 });
    expect((await itemRows(h.ownerScopeId)).map(item => item.sensitivity)).toEqual(['PRIVATE', 'PRIVATE']);
  } finally { await h.close(); }
}, 60_000);

async function storedCorpus(owner: string): Promise<string[]> {
  const corpus: string[] = [];
  // Identifiers are a fixed local allowlist, never caller/provider input.
  for (const table of ['audit_events', 'connectors', 'connector_capability_grants', 'source_items', 'source_anchors', 'triage_decisions']) {
    const { rows } = await admin.query(`SELECT * FROM ${table} WHERE owner_scope_id=$1 ORDER BY id`, [owner]);
    corpus.push(JSON.stringify(rows));
  }
  return corpus;
}
it.skip('(9) ADR 0041 D2/D6 and FR-104: no key or provider error body reaches responses, stored rows, objects or logs; provider calls are GET-only', async () => {
  const h = await harness();
  try {
    const fixture = await omiFixture();
    const { value: id, lines } = await capturingLogs(async () => {
      console.info('omi-acceptance-log-canary');
      const connected = await connectOmi(h);
      expect(connected.statusCode).toBe(201);
      const connectorId = connected.json<ConnectorBody>().connectorId;
      h.omi.replies.push(() => page([fixture]), () => failure(429, { 'retry-after': '30' }), () => failure(401));
      expect((await sync(h, connectorId)).statusCode).toBe(200);
      expect((await sync(h, connectorId)).statusCode).toBe(429);
      const revoked = await sync(h, connectorId);
      expect(revoked.statusCode).toBe(409);
      expect(revoked.json<{ code: string }>().code).toBe('CONNECTOR_TOKEN_REVOKED');
      expect((await disconnect(h, connectorId)).statusCode).toBe(200);
      return connectorId;
    });
    expect(lines.join('\n')).toContain('omi-acceptance-log-canary');
    expect(h.bodies).toHaveLength(5);
    expect(h.omi.requests).toHaveLength(3);
    expect([...new Set(h.secrets.resolved)]).toEqual([HANDLE]);
    expect(h.objects.size).toBe(2);
    for (const request of h.omi.requests) {
      expect(request.method).toBe('GET');
      expect(request.url.origin + request.url.pathname).toBe(OMI_LIST);
      expect(request.redirect).toBe('error');
      expect(request.headers['authorization']).toBe('Bearer ' + KEY);
      expect([...request.url.searchParams.keys()].filter(key => !ALLOWED_QUERY.includes(key))).toEqual([]);
      expect(request.url.href).not.toContain(KEY);
      expect(JSON.stringify(Object.entries(request.headers).filter(([name]) => name !== 'authorization'))).not.toContain(KEY);
    }
    const rows = await storedCorpus(h.ownerScopeId);
    expect(rows[0]).toContain(id); // Audit query actually searched this connector's records.
    const corpus = [...h.bodies, ...rows, ...[...h.objects.values()].map(bytes => Buffer.from(bytes).toString('utf8')), ...lines];
    for (const entry of corpus) {
      expect(entry).not.toContain(KEY);
      expect(entry).not.toContain(BODY_MARKER);
    }
  } finally { await h.close(); }
}, 60_000);
