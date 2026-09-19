import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runMigrations, withOwnerTransaction, type OwnerTransaction } from '@unai/postgres';
import { postgresAdapter, SESSION_COOKIE } from '@unai/auth';
import { createPlatformApi } from './platform.js';
import type { EvidenceObjects } from './evidence.js';
import type { ConnectorClient, ConnectorFetch } from '@unai/connectors';
import { requireCapability, listGrants } from '@unai/connectors';
import { createConnectorRuntime } from './connectors.js';

/**
 * The required V0 connectors, their capability grants and their lifecycle, over
 * real PostgreSQL through the real owner boundary.
 *
 * Covers CRT-CON-01-A, CRT-CON-02-A, CRT-CON-03-A, CRT-CON-04-A, CRT-CON-05-A,
 * CRT-CON-06-A and CRT-CON-07-A. The provider side is a recorded double: it
 * answers the committed raw fixtures and remembers the cursor it was asked with,
 * so "the second sync resumed from the stored cursor" is observable. The live
 * Gmail, Calendar and GitHub accounts the criteria also name need operator
 * credentials this suite does not hold; that gap is reported as a finding.
 */

if (!process.env.UNAI_TEST_DATABASE_URL) throw new Error('Run pnpm test for the required PostgreSQL harness');
const admin = new Pool({ connectionString: process.env.UNAI_TEST_DATABASE_URL });
const appUrl = new URL(process.env.UNAI_TEST_DATABASE_URL); appUrl.username = 'connector_test_app'; appUrl.password = 'test-only';
const appPool = new Pool({ connectionString: appUrl.href });

beforeAll(async () => {
  await runMigrations(admin, resolve('migrations'));
  await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='connector_test_app') THEN CREATE ROLE connector_test_app LOGIN PASSWORD 'test-only'; END IF; END $$; GRANT unai_app TO connector_test_app");
});
afterAll(async () => { await appPool.end(); await admin.end(); });

async function fixture(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(resolve('fixtures/sources/' + name + '.json'), 'utf8')) as Record<string, unknown>;
}

/** A provider double that serves prepared pages and records every fetch. One
 * page per call, with the cursor the connector asked with. */
function recordedClient(pages: readonly (readonly unknown[])[]) {
  const fetches: ConnectorFetch[] = [];
  let index = 0;
  const client: ConnectorClient = {
    async fetchPage(request) {
      fetches.push(request);
      const payloads = pages[Math.min(index, pages.length - 1)] ?? [];
      index += 1;
      return { payloads: [...payloads], nextCursor: { position: 'page:' + index, providerToken: String(index) } };
    },
  };
  return { client, fetches, reset() { index = 0; } };
}

interface Harness {
  app: ReturnType<typeof createPlatformApi>;
  ownerScopeId: string;
  userId: string;
  headers(purpose: string, extra?: Record<string, string>): Record<string, string>;
  pages: { value: readonly (readonly unknown[])[] };
  fetches: ConnectorFetch[];
  revocations: { connectorType: string; secretRef: string }[];
  revokeAnswer: { revoked: boolean };
  objects: Map<string, Uint8Array>;
  close(): Promise<void>;
}

async function harness(): Promise<Harness> {
  const adapter = postgresAdapter(admin);
  const user = await adapter.createUser!({ name: 'Connector test', email: 'connector-' + randomUUID() + '@example.test', emailVerified: null });
  const token = randomBytes(32).toString('base64url');
  await adapter.createSession!({ userId: user.id, sessionToken: token, expires: new Date(Date.now() + 86400000) });
  const ownerScopeId = (user as unknown as { ownerScopeId: string }).ownerScopeId;
  const objects = new Map<string, Uint8Array>();
  const evidenceObjects: EvidenceObjects = {
    encryptionKeyRef: 'kms:test-double',
    async put(_tx, id, bytes) { objects.set(id, bytes); },
    async get(_tx, id) { return objects.get(id)!; },
  };
  const pages: { value: readonly (readonly unknown[])[] } = { value: [[]] };
  const fetches: ConnectorFetch[] = [];
  const revocations: { connectorType: string; secretRef: string }[] = [];
  const revokeAnswer = { revoked: true };
  const app = createPlatformApi({
    authPool: admin, appPool, evidenceObjects, registryReleaseId: randomUUID(),
    connectors: {
      connectorClient: () => ({
        async fetchPage(request) {
          fetches.push(request);
          const page = pages.value[Math.min(fetches.length - 1, pages.value.length - 1)] ?? [];
          return { payloads: [...page], nextCursor: { position: 'page:' + fetches.length, providerToken: String(fetches.length) } };
        },
      }),
      revokeTokens: async input => { revocations.push(input); return revokeAnswer; },
    },
  });
  app.addHook('onRequest', async request => {
    Object.defineProperty(request.raw.socket, 'encrypted', { value: true, configurable: true });
  });
  return {
    app, ownerScopeId, userId: user.id, pages, fetches, revocations, revokeAnswer, objects,
    headers(purpose, extra = {}) {
      return {
        cookie: SESSION_COOKIE + '=' + token, 'x-owner-scope-id': ownerScopeId, 'x-purpose': purpose,
        'x-correlation-id': randomUUID(), 'idempotency-key': randomUUID(),
        'x-data-purpose': 'PERSONAL_ASSISTANCE', 'x-maximum-sensitivity': 'RESTRICTED', ...extra,
      };
    },
    async close() { await app.close(); },
  };
}

async function connect(h: Harness, body: Record<string, unknown>) {
  const response = await h.app.inject({
    method: 'POST', url: '/v1/connectors', headers: h.headers('connector.manage'), payload: body,
  });
  return response;
}
async function sync(h: Harness, connectorId: string, body: Record<string, unknown> = {}) {
  return h.app.inject({
    method: 'POST', url: '/v1/connectors/' + connectorId + '/sync', headers: h.headers('connector.sync'),
    payload: { allowedPurposes: ['PERSONAL_ASSISTANCE'], ...body },
  });
}
async function items(ownerScopeId: string, sourceType?: string) {
  const rows = await admin.query(
    'SELECT * FROM source_items WHERE owner_scope_id=$1' + (sourceType ? ' AND source_type=$2' : '')
    + ' ORDER BY external_id', sourceType ? [ownerScopeId, sourceType] : [ownerScopeId]);
  return rows.rows;
}

it('CRT-CON-07-A/02-A: capabilities are granted one row at a time and a write scope is refused', async () => {
  const h = await harness();
  try {
    const created = await connect(h, {
      connectorType: 'GMAIL', externalAccountRef: 'owner@example.test', secretRef: 'secret://mounted/gmail#refresh',
      requestedCapabilities: [{ capabilityId: 'gmail.read_metadata', granted: true },
        { capabilityId: 'gmail.read_content', granted: false }],
    });
    expect(created.statusCode).toBe(201);
    const connector = created.json();
    // Two discrete rows for two discrete capabilities, and only the granted one
    // contributes a provider scope to the consent handoff.
    const rows = (await admin.query(
      'SELECT capability_id,granted,granted_at,revoked_at,risk_class,access_kind FROM connector_capability_grants WHERE connector_id=$1 ORDER BY capability_id',
      [connector.connectorId])).rows;
    expect(rows.map(row => [row.capability_id, row.granted])).toEqual([
      ['gmail.read_content', false], ['gmail.read_metadata', true], ['gmail.search', false]]);
    expect(connector.grantedCapabilities).toEqual(['gmail.read_metadata']);
    expect(connector.requestedScopes).toEqual(['https://www.googleapis.com/auth/gmail.metadata']);
    // Every requested scope is read-only, which is what CRT-CON-02-A asks of the
    // consent handoff itself.
    expect(connector.requestedScopes.every((scope: string) => scope.includes('readonly') || scope.includes('metadata'))).toBe(true);
    expect(JSON.stringify(connector)).not.toContain('secret://');

    // An operation needing the ungranted sibling capability is refused by name.
    await expect(withOwnerTransaction(appPool,
      { actorId: h.userId, ownerScopeId: h.ownerScopeId, purpose: 'connector.read', correlationId: randomUUID() },
      tx => requireCapability(tx, connector.connectorId, 'gmail.read_content')))
      .rejects.toThrow('CONNECTOR_CAPABILITY_NOT_GRANTED');
    await expect(withOwnerTransaction(appPool,
      { actorId: h.userId, ownerScopeId: h.ownerScopeId, purpose: 'connector.read', correlationId: randomUUID() },
      tx => requireCapability(tx, connector.connectorId, 'gmail.read_metadata'))).resolves.toMatchObject({ capabilityId: 'gmail.read_metadata' });

    // A request needing a write scope is refused with the reason and changes nothing.
    const refused = await h.app.inject({
      method: 'POST', url: '/v1/connectors/' + connector.connectorId + '/capabilities',
      headers: h.headers('connector.manage'), payload: { capabilities: [{ capabilityId: 'gmail.send', granted: true }] },
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ code: 'CONNECTOR_WRITE_SCOPE_REFUSED', reason: 'V0_IS_READ_ONLY' });
    expect((await admin.query('SELECT count(*)::int AS n FROM connector_capability_grants WHERE connector_id=$1', [connector.connectorId])).rows[0].n).toBe(3);

    // Granting the sibling capability afterwards moves exactly that one row.
    const granted = await h.app.inject({
      method: 'POST', url: '/v1/connectors/' + connector.connectorId + '/capabilities',
      headers: h.headers('connector.manage'),
      payload: { capabilities: [{ capabilityId: 'gmail.read_content', granted: true }] },
    });
    expect(granted.statusCode).toBe(200);
    expect(granted.json().grantedCapabilities).toEqual(['gmail.read_content', 'gmail.read_metadata']);
    const revoked = await h.app.inject({
      method: 'POST', url: '/v1/connectors/' + connector.connectorId + '/capabilities',
      headers: h.headers('connector.manage'),
      payload: { capabilities: [{ capabilityId: 'gmail.read_content', granted: false }] },
    });
    expect(revoked.json().capabilities.find((entry: { capabilityId: string }) => entry.capabilityId === 'gmail.read_content'))
      .toMatchObject({ granted: false, revokedAt: expect.any(String), grantedAt: expect.any(String) });
  } finally { await h.close(); }
});

it('CRT-CON-02-A: the Gmail connector ingests threads and a partial grant stores no message body', async () => {
  const h = await harness();
  try {
    const thread = await fixture('gmail-thread');
    const created = await connect(h, {
      connectorType: 'GMAIL', externalAccountRef: 'owner@example.test', secretRef: 'secret://mounted/gmail#refresh',
      requestedCapabilities: [{ capabilityId: 'gmail.read_metadata', granted: true }],
    });
    const connectorId = created.json().connectorId;
    h.pages.value = [[thread]];
    const first = await sync(h, connectorId);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ itemsIngested: 3, duplicatesSuppressed: 0, threadUpdatesApplied: 3 });
    const rows = await items(h.ownerScopeId, 'GMAIL');
    expect(rows.map(row => row.external_id)).toEqual(['msg-9a1c04', 'msg-9a1c05', 'msg-9a1c06']);
    // The body was never granted, so no body text is stored anywhere.
    const body = (thread.messages as { payload: { body: { text: string } } }[])[0]!.payload.body.text;
    expect(rows.every(row => JSON.stringify(row.deterministic_metadata).includes('threadExternalId'))).toBe(true);
    for (const stored of h.objects.values()) expect(Buffer.from(stored).toString('utf8')).not.toContain(body);
    // The subject still arrived: metadata is what the granted capability reads.
    expect([...h.objects.values()].some(stored => Buffer.from(stored).toString('utf8').includes('Subject'))).toBe(false);
    expect([...h.objects.values()].some(stored => Buffer.from(stored).toString('utf8').includes('subject'))).toBe(true);
    // The provider was asked with the granted capability list and nothing wider.
    expect(h.fetches[0]!.capabilities).toEqual(['gmail.read_metadata']);
  } finally { await h.close(); }
});

it('CRT-CON-03-A: the Calendar connector stores start, end and recurrence from the structured fields', async () => {
  const h = await harness();
  try {
    const event = await fixture('google-calendar-recurring-event');
    const created = await connect(h, {
      connectorType: 'GOOGLE_CALENDAR', externalAccountRef: 'owner@example.test',
      secretRef: 'secret://mounted/calendar#refresh',
      requestedCapabilities: [{ capabilityId: 'calendar.read', granted: true }],
    });
    const connectorId = created.json().connectorId;
    h.pages.value = [[event]];
    const result = await sync(h, connectorId);
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ itemsIngested: 3, recurrenceUpdatesApplied: 3 });
    const rows = await items(h.ownerScopeId, 'GOOGLE_CALENDAR');
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      const stored = JSON.parse(Buffer.from(h.objects.get(row.raw_object_ref)!).toString('utf8'));
      // Populated from the payload's own structured fields, never inferred.
      expect(stored.start).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(stored.end).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(stored.recurrenceId).toBe('evt-weekly-review-7b3');
      expect(row.deterministic_metadata.recurrence).toEqual(['RRULE:FREQ=WEEKLY;BYDAY=FR;COUNT=3']);
      expect(row.parent_external_id).toBe('evt-weekly-review-7b3');
    }
    const anchors = (await admin.query(
      `SELECT anchor->>'field' AS field FROM source_anchors WHERE owner_scope_id=$1 AND anchor_kind='CALENDAR_FIELD' ORDER BY field`,
      [h.ownerScopeId])).rows.map(row => row.field);
    expect(new Set(anchors)).toEqual(new Set(['start', 'end', 'recurrence']));
  } finally { await h.close(); }
});

it('CRT-CON-04-A: a burst of commits and CI webhooks on one pull request is one aggregated episode', async () => {
  const h = await harness();
  try {
    const burst = await fixture('github-pull-request-burst');
    const created = await connect(h, {
      connectorType: 'GITHUB', externalAccountRef: 'example-org/uai-reference',
      secretRef: 'secret://mounted/github#token',
      requestedCapabilities: [{ capabilityId: 'github.read_pull_requests', granted: true },
        { capabilityId: 'github.read_issues', granted: true }],
    });
    const connectorId = created.json().connectorId;
    h.pages.value = [[burst]];
    const result = await sync(h, connectorId);
    expect(result.statusCode).toBe(200);
    // Twelve provider events -- seven commits and five CI runs -- become one
    // episode item, beside the pull request and its comment.
    expect(result.json()).toMatchObject({ episodesAggregated: 1, aggregatedEvents: 12, itemsIngested: 3 });
    const rows = await items(h.ownerScopeId, 'GITHUB');
    expect(rows.map(row => row.external_id)).toEqual([
      'example-org/uai-reference#517',
      'example-org/uai-reference#517/comments/9114001',
      'example-org/uai-reference#517/episode',
    ]);
    const episode = rows.find(row => row.external_id.endsWith('/episode'))!;
    expect(episode.deterministic_metadata).toMatchObject({
      episodeKind: 'COMMIT_AND_CI_BURST', aggregatedCommitCount: 7, aggregatedCheckRunCount: 5,
    });
    // One triage decision for the burst, not one per event: the extraction unit
    // is the episode (PRD §20.5).
    const triage = (await admin.query(
      'SELECT tier1_route FROM triage_decisions WHERE owner_scope_id=$1 AND source_item_id=$2', [h.ownerScopeId, episode.id])).rows;
    expect(triage).toHaveLength(1);
    expect((await admin.query('SELECT count(*)::int AS n FROM triage_decisions WHERE owner_scope_id=$1', [h.ownerScopeId])).rows[0].n).toBe(3);
    // Every commit and CI run is still individually anchored.
    expect((await admin.query(
      'SELECT count(*)::int AS n FROM source_anchors WHERE owner_scope_id=$1 AND source_item_id=$2', [h.ownerScopeId, episode.id])).rows[0].n).toBe(12);
    // Nothing semantic ran: the aggregation is an ingestion decision, not an
    // extraction result.
    expect((await admin.query('SELECT count(*)::int AS n FROM extraction_runs WHERE owner_scope_id=$1', [h.ownerScopeId])).rows[0].n).toBe(0);
  } finally { await h.close(); }
});

it('CRT-CON-01-A: each user and assistant message becomes one CONVERSATION row with its message id', async () => {
  const h = await harness();
  try {
    const conversation = await fixture('conversation-thread');
    const created = await connect(h, {
      connectorType: 'CONVERSATION', externalAccountRef: 'first-party',
      requestedCapabilities: [{ capabilityId: 'conversation.read_user_messages', granted: true },
        { capabilityId: 'conversation.read_assistant_messages', granted: true }],
    });
    const connectorId = created.json().connectorId;
    h.pages.value = [[conversation]];
    const result = await sync(h, connectorId);
    expect(result.statusCode).toBe(200);
    expect(result.json().itemsIngested).toBe(4);
    const rows = await items(h.ownerScopeId, 'CONVERSATION');
    expect(rows.map(row => row.external_id))
      .toEqual(['msg-conv-0001', 'msg-conv-0002', 'msg-conv-0003', 'msg-conv-0004']);
    expect(rows.map(row => row.deterministic_metadata.role)).toEqual(['USER', 'ASSISTANT', 'USER', 'ASSISTANT']);
    // The assistant's own words are stored as evidence with an ASSISTANT actor,
    // never as the owner's statement and never as an accepted belief.
    expect(rows.map(row => row.actor_ref.type)).toEqual(['USER', 'ASSISTANT', 'USER', 'ASSISTANT']);
    expect(rows[1]!.actor_ref.id).toBe('uai-assistant-0.1.0');
    expect(rows[0]!.actor_ref.id).toBe(h.userId);
    expect((await admin.query('SELECT count(*)::int AS n FROM propositions WHERE owner_scope_id=$1', [h.ownerScopeId])).rows[0].n).toBe(0);
  } finally { await h.close(); }
});

it('CRT-CON-06-A: a second sync resumes from the stored cursor, redelivery adds nothing, disconnect stops ingestion', async () => {
  const h = await harness();
  try {
    const thread = await fixture('gmail-thread');
    const created = await connect(h, {
      connectorType: 'GMAIL', externalAccountRef: 'owner@example.test', secretRef: 'secret://mounted/gmail#refresh',
      requestedCapabilities: [{ capabilityId: 'gmail.read_metadata', granted: true },
        { capabilityId: 'gmail.read_content', granted: true }],
    });
    const connectorId = created.json().connectorId;
    h.pages.value = [[thread]];
    const first = await sync(h, connectorId);
    expect(first.json()).toMatchObject({ resumedFromCursor: null, itemsIngested: 3, duplicatesSuppressed: 0 });
    const storedCursor = first.json().newCursor;
    expect(storedCursor).toMatchObject({ position: 'page:1' });
    expect((await admin.query('SELECT last_cursor,cursor_updated_at FROM connectors WHERE id=$1', [connectorId])).rows[0])
      .toMatchObject({ last_cursor: storedCursor, cursor_updated_at: expect.anything() });

    // The provider redelivers the identical page: the second run resumes from the
    // stored cursor and creates no duplicate row.
    const second = await sync(h, connectorId);
    expect(second.json()).toMatchObject({ resumedFromCursor: storedCursor, itemsIngested: 0, duplicatesSuppressed: 3 });
    expect(h.fetches[1]!.cursor).toEqual(storedCursor);
    expect(await items(h.ownerScopeId, 'GMAIL')).toHaveLength(3);
    expect((await admin.query('SELECT count(*)::int AS n FROM evidence_object_keys WHERE owner_scope_id=$1', [h.ownerScopeId])).rows[0].n).toBe(3);

    // Disconnect: the provider tokens are revoked, the credential handle is
    // destroyed, every capability is revoked and ingestion stops.
    const disconnected = await h.app.inject({
      method: 'POST', url: '/v1/connectors/' + connectorId + '/disconnect', headers: h.headers('connector.manage'), payload: {},
    });
    expect(disconnected.statusCode).toBe(200);
    expect(disconnected.json()).toMatchObject({
      status: 'DISCONNECTED', tokensRevokedAtProvider: true, secretReferenceDestroyed: true,
      ingestionStopped: true, retainedEvidence: 'RETAINED',
      retainedEvidenceOptions: ['KEEP_EVIDENCE', 'REQUEST_DELETION'],
    });
    expect(h.revocations).toEqual([{ connectorType: 'GMAIL', secretRef: 'secret://mounted/gmail#refresh' }]);
    const row = (await admin.query('SELECT status,secret_ref,disconnected_at,last_cursor FROM connectors WHERE id=$1', [connectorId])).rows[0];
    expect(row).toMatchObject({ status: 'DISCONNECTED', secret_ref: null, last_cursor: null });
    expect(row.disconnected_at).not.toBeNull();
    expect((await admin.query('SELECT count(*)::int AS n FROM connector_capability_grants WHERE connector_id=$1 AND granted', [connectorId])).rows[0].n).toBe(0);

    const afterDisconnect = await sync(h, connectorId);
    expect(afterDisconnect.statusCode).toBe(409);
    expect(afterDisconnect.json().code).toBe('CONNECTOR_INGESTION_STOPPED');
    expect(await items(h.ownerScopeId, 'GMAIL')).toHaveLength(3);
    // The retained evidence is still readable: disconnect stops ingestion and
    // deletes nothing (PRD §30.7).
    const read = await h.app.inject({
      url: '/v1/evidence/' + (await items(h.ownerScopeId, 'GMAIL'))[0]!.id, headers: h.headers('evidence.read'),
    });
    expect(read.statusCode).toBe(200);
  } finally { await h.close(); }
});

it('CRT-CON-06-A: a backfill re-reads from the beginning and still creates no duplicate', async () => {
  const h = await harness();
  try {
    const conversation = await fixture('conversation-thread');
    const created = await connect(h, {
      connectorType: 'CONVERSATION', externalAccountRef: 'first-party',
      requestedCapabilities: [{ capabilityId: 'conversation.read_user_messages', granted: true },
        { capabilityId: 'conversation.read_assistant_messages', granted: true }],
    });
    const connectorId = created.json().connectorId;
    h.pages.value = [[conversation]];
    await sync(h, connectorId);
    const backfill = await sync(h, connectorId, { mode: 'BACKFILL' });
    expect(backfill.json()).toMatchObject({ mode: 'BACKFILL', resumedFromCursor: null, duplicatesSuppressed: 4, itemsIngested: 0 });
    expect(h.fetches[1]!.cursor).toBeNull();
    expect(await items(h.ownerScopeId, 'CONVERSATION')).toHaveLength(4);
  } finally { await h.close(); }
});

it('a sync with no granted capability is refused and the failure is recorded on the connector', async () => {
  const h = await harness();
  try {
    const created = await connect(h, {
      connectorType: 'GITHUB', externalAccountRef: 'example-org/uai-reference',
      secretRef: 'secret://mounted/github#token', requestedCapabilities: [],
    });
    const connectorId = created.json().connectorId;
    expect(created.json().status).toBe('PENDING_AUTHORIZATION');
    const refused = await sync(h, connectorId);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe('CONNECTOR_INGESTION_STOPPED');
    expect(await items(h.ownerScopeId)).toHaveLength(0);
  } finally { await h.close(); }
});

it('CRT-CON-05-A: an uploaded document is stored, indexed and searchable with extraction deferred', async () => {
  const h = await harness();
  try {
    const document = await fixture('uploaded-document');
    const upload = await h.app.inject({
      method: 'POST', url: '/v1/documents', headers: h.headers('evidence.ingest'),
      payload: {
        documentId: 'doc-notes-' + randomUUID(), title: 'Team notes', mediaType: 'text/plain',
        pages: [{ page: 1, text: 'Notes from the retrospective about the pgvector index rollout.' }],
        sensitivity: 'PRIVATE', allowedPurposes: ['PERSONAL_ASSISTANCE'],
      },
    });
    expect(upload.statusCode).toBe(201);
    expect(upload.json()).toMatchObject({
      ingestionStatus: 'STORED', indexed: true, searchable: true, indexedAnchors: 1,
      extractionPlan: 'DEFERRED', extractionPlanReason: 'NO_FULL_EXTRACTION_TRIGGER', extractionJobId: null,
    });
    // Nothing was queued, so no extraction can have run.
    expect((await admin.query('SELECT count(*)::int AS n FROM jobs WHERE owner_scope_id=$1', [h.ownerScopeId])).rows[0].n).toBe(0);
    expect((await admin.query('SELECT count(*)::int AS n FROM extraction_runs WHERE owner_scope_id=$1', [h.ownerScopeId])).rows[0].n).toBe(0);

    // ...and it is searchable immediately, by its own text.
    const found = await h.app.inject({
      url: '/v1/documents/search?q=' + encodeURIComponent('pgvector index'), headers: h.headers('evidence.read'),
    });
    expect(found.statusCode).toBe(200);
    expect(found.json().hits).toHaveLength(1);
    expect(found.json().hits[0]).toMatchObject({ evidenceId: upload.json().evidenceId, page: 1, extractionPlan: 'DEFERRED' });
    expect(found.json().hits[0].excerpt).toContain('pgvector');
    const missing = await h.app.inject({
      url: '/v1/documents/search?q=' + encodeURIComponent('a phrase this owner never stored'), headers: h.headers('evidence.read'),
    });
    expect(missing.json().hits).toEqual([]);

    // A user-requested extraction queues the run; a deadline-bearing document
    // queues one without being asked.
    const requested = await h.app.inject({
      method: 'POST', url: '/v1/documents', headers: h.headers('evidence.ingest'),
      payload: {
        documentId: 'doc-requested-' + randomUUID(), title: 'Handbook', mediaType: 'text/plain',
        pages: [{ page: 1, text: 'General onboarding notes with nothing urgent in them.' }],
        sensitivity: 'PRIVATE', allowedPurposes: ['PERSONAL_ASSISTANCE'], requestFullExtraction: true,
      },
    });
    expect(requested.json()).toMatchObject({ extractionPlan: 'FULL', extractionPlanReason: 'USER_REQUESTED' });
    expect(requested.json().extractionJobId).toMatch(/^[0-9a-f-]{36}$/);
    const queued = (await admin.query('SELECT job_kind,status FROM jobs WHERE owner_scope_id=$1', [h.ownerScopeId])).rows;
    expect(queued).toEqual([{ job_kind: 'evidence.extract', status: 'PENDING' }]);

    const deadline = await h.app.inject({
      method: 'POST', url: '/v1/documents', headers: h.headers('evidence.ingest'),
      payload: {
        documentId: 'doc-deadline-' + randomUUID(), title: 'Renewal', mediaType: 'text/plain',
        pages: [{ page: 1, text: 'The signed renewal is due before 2026-10-01 or the lease lapses.' }],
        sensitivity: 'PRIVATE', allowedPurposes: ['PERSONAL_ASSISTANCE'],
      },
    });
    expect(deadline.json()).toMatchObject({ extractionPlan: 'FULL', extractionPlanReason: 'DEADLINE_BEARING' });

    const highValue = await h.app.inject({
      method: 'POST', url: '/v1/documents', headers: h.headers('evidence.ingest'),
      payload: {
        documentId: 'doc-value-' + randomUUID(), title: 'Lease', mediaType: 'application/pdf',
        pages: (document.pages as { page: number; text: string }[]).map(page => ({ page: page.page, text: 'Ordinary text on page ' + page.page })),
        sensitivity: 'PRIVATE', allowedPurposes: ['PERSONAL_ASSISTANCE'], valueClassification: 'HIGH_VALUE',
      },
    });
    expect(highValue.json()).toMatchObject({ extractionPlan: 'FULL', extractionPlanReason: 'HIGH_VALUE', indexedAnchors: 2 });

    // A format whose text could not be read is stored as source-only evidence and
    // stays retrievable rather than being refused.
    const unsupported = await h.app.inject({
      method: 'POST', url: '/v1/documents', headers: h.headers('evidence.ingest'),
      payload: {
        documentId: 'doc-binary-' + randomUUID(), title: 'Scan', mediaType: 'image/tiff', pages: [],
        base64: Buffer.from('not extractable bytes').toString('base64'),
        sensitivity: 'PRIVATE', allowedPurposes: ['PERSONAL_ASSISTANCE'], requestFullExtraction: true,
      },
    });
    expect(unsupported.json()).toMatchObject({
      extractionPlan: 'DEFERRED', extractionPlanReason: 'UNSUPPORTED_FORMAT_STORED_AS_SOURCE_ONLY',
      indexedAnchors: 0, extractionJobId: null,
    });
    const storedBinary = await h.app.inject({
      url: '/v1/evidence/' + unsupported.json().evidenceId, headers: h.headers('evidence.read'),
    });
    expect(storedBinary.statusCode).toBe(200);
    // Two FULL plans, two queued jobs: the deferred ones queued nothing.
    expect((await admin.query('SELECT count(*)::int AS n FROM jobs WHERE owner_scope_id=$1', [h.ownerScopeId])).rows[0].n).toBe(3);
  } finally { await h.close(); }
});

it('lists connected sources with their status, granted capabilities and stored cursor', async () => {
  const h = await harness();
  try {
    const created = await connect(h, {
      connectorType: 'GMAIL', externalAccountRef: 'owner@example.test', secretRef: 'secret://mounted/gmail#refresh',
      requestedCapabilities: [{ capabilityId: 'gmail.read_metadata', granted: true }],
    });
    const connectorId = created.json().connectorId;
    h.pages.value = [[await fixture('gmail-thread')]];
    await sync(h, connectorId);
    const listed = await h.app.inject({ url: '/v1/connectors', headers: h.headers('connector.read') });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().connectors).toHaveLength(1);
    expect(listed.json().connectors[0]).toMatchObject({
      connectorId, connectorType: 'GMAIL', status: 'ACTIVE', manifestId: 'connector.gmail',
      credentialHeld: true, grantedCapabilities: ['gmail.read_metadata'],
      cursor: { position: 'page:1' },
    });
    // The credential handle is never in a response.
    expect(listed.body).not.toContain('secret://');
    const capabilities = await h.app.inject({
      url: '/v1/connectors/' + connectorId + '/capabilities', headers: h.headers('connector.read'),
    });
    expect(capabilities.json().capabilities.map((entry: { capabilityId: string; riskClass: string }) => [entry.capabilityId, entry.riskClass]))
      .toEqual([['gmail.read_content', 'MEDIUM'], ['gmail.read_metadata', 'LOW'], ['gmail.search', 'LOW']]);
    // A second connection of the same account is refused rather than duplicated.
    const again = await connect(h, {
      connectorType: 'GMAIL', externalAccountRef: 'owner@example.test', secretRef: 'secret://mounted/gmail#refresh',
      requestedCapabilities: [],
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('CONNECTOR_ALREADY_CONNECTED');
    // The grant list is readable in-process under the read purpose, and the
    // rows are per capability there too.
    const grants = await withOwnerTransaction(appPool,
      { actorId: h.userId, ownerScopeId: h.ownerScopeId, purpose: 'connector.read', correlationId: randomUUID() },
      tx => listGrants(tx, connectorId));
    expect(grants.filter(grant => grant.granted).map(grant => grant.capabilityId)).toEqual(['gmail.read_metadata']);
  } finally { await h.close(); }
});

/**
 * The manifest's declared sensitivity default is a floor, and a failed sync is
 * retryable.
 *
 * The first is the enforcement half of the settled default: every V0 source type
 * defaults to PRIVATE, and a caller may not store evidence below that by asking.
 * The second is what keeps CRT-CON-06-A's "a second sync resumes from the stored
 * cursor" true after a first run that failed: consent and the cursor both
 * survive a refusal, so the retry resumes rather than finding a wedged connector.
 */
it('CRT-CON-02-A/06-A: the manifest default floors stored sensitivity, and a failed sync retries from the cursor', async () => {
  const h = await harness();
  try {
    const created = await connect(h, {
      connectorType: 'GMAIL', externalAccountRef: 'floor@example.test', secretRef: 'secret://mounted/gmail#refresh',
      requestedCapabilities: [{ capabilityId: 'gmail.read_metadata', granted: true },
        { capabilityId: 'gmail.read_content', granted: true }],
    });
    const connectorId = created.json().connectorId;
    h.pages.value = [[await fixture('gmail-thread')]];

    // Asking for NORMAL does not store Gmail content at NORMAL: the manifest's
    // PRIVATE default is the floor, and the receipt reports both levels.
    const first = await sync(h, connectorId, { sensitivity: 'NORMAL' });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ requestedSensitivity: 'NORMAL', storedSensitivity: 'PRIVATE' });
    expect(first.json().itemsIngested).toBeGreaterThan(0);
    const stored = await items(h.ownerScopeId, 'GMAIL');
    expect(stored.map(row => row.sensitivity)).toEqual(stored.map(() => 'PRIVATE'));
    // A request may still raise above the floor.
    expect((await sync(h, connectorId, { sensitivity: 'RESTRICTED' })).json())
      .toMatchObject({ requestedSensitivity: 'RESTRICTED', storedSensitivity: 'RESTRICTED' });

    // A declared ceiling below the floor is refused by name rather than met by
    // lowering the floor, and the refusal is recorded on the connector.
    const refused = await h.app.inject({
      method: 'POST', url: '/v1/connectors/' + connectorId + '/sync',
      headers: h.headers('connector.sync', { 'x-maximum-sensitivity': 'NORMAL' }),
      payload: { allowedPurposes: ['PERSONAL_ASSISTANCE'], sensitivity: 'NORMAL' },
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().code).toBe('CONNECTOR_SENSITIVITY_CEILING_TOO_LOW');
    const failed = (await admin.query('SELECT status,last_sync_error,last_cursor FROM connectors WHERE id=$1', [connectorId])).rows[0];
    expect(failed.status).toBe('SYNC_FAILED');
    expect(failed.last_sync_error).toBe('CONNECTOR_SENSITIVITY_CEILING_TOO_LOW');

    // The retry is not blocked by the recorded failure: it resumes from the
    // cursor the successful runs stored, and clears the failure.
    const retried = await sync(h, connectorId);
    expect(retried.statusCode).toBe(200);
    expect(retried.json().resumedFromCursor).toMatchObject({ position: failed.last_cursor.position });
    expect(retried.json().duplicatesSuppressed).toBeGreaterThan(0);
    const recovered = (await admin.query('SELECT status,last_sync_error FROM connectors WHERE id=$1', [connectorId])).rows[0];
    expect(recovered).toMatchObject({ status: 'ACTIVE', last_sync_error: null });

    // A disconnected connector stays stopped: only a *failed* sync is retryable.
    await h.app.inject({
      method: 'POST', url: '/v1/connectors/' + connectorId + '/disconnect', headers: h.headers('connector.manage'),
    });
    const afterDisconnect = await sync(h, connectorId);
    expect(afterDisconnect.statusCode).toBe(409);
    expect(afterDisconnect.json().code).toBe('CONNECTOR_INGESTION_STOPPED');
  } finally { await h.close(); }
});

it('CRT-CON-05-A: an upload is stored at the documents manifest floor, not below it', async () => {
  const h = await harness();
  try {
    const upload = await h.app.inject({
      method: 'POST', url: '/v1/documents', headers: h.headers('evidence.ingest'),
      payload: {
        documentId: 'doc-floor-' + randomUUID(), title: 'Notes', mediaType: 'text/plain',
        pages: [{ page: 1, text: 'An ordinary page of notes.' }],
        sensitivity: 'NORMAL', allowedPurposes: ['PERSONAL_ASSISTANCE'],
      },
    });
    expect(upload.statusCode).toBe(201);
    expect(upload.json().storedSensitivity).toBe('PRIVATE');
    const row = (await admin.query('SELECT sensitivity FROM source_items WHERE id=$1', [upload.json().evidenceId])).rows[0];
    expect(row.sensitivity).toBe('PRIVATE');
    // A ceiling below the floor is refused rather than silently lowering it.
    const refused = await h.app.inject({
      method: 'POST', url: '/v1/documents', headers: h.headers('evidence.ingest', { 'x-maximum-sensitivity': 'NORMAL' }),
      payload: {
        documentId: 'doc-ceiling-' + randomUUID(), mediaType: 'text/plain',
        pages: [{ page: 1, text: 'Another page.' }],
        sensitivity: 'NORMAL', allowedPurposes: ['PERSONAL_ASSISTANCE'],
      },
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().code).toBe('CONNECTOR_SENSITIVITY_CEILING_TOO_LOW');
  } finally { await h.close(); }
});

/**
 * The production wiring, tested without a listener and without a network call.
 *
 * `server.ts` composes `createConnectorRuntime(secrets)` into the platform API.
 * Without it the read-only clients of `@unai/connectors` and the real revocation
 * call are present in the package but unreachable from a deployment: every sync
 * would answer CONNECTOR_CLIENT_UNSUPPORTED and every disconnect of a
 * credentialed connector CONNECTOR_REVOCATION_UNAVAILABLE. Constructing a client
 * resolves no secret and sends no request, so this asserts the composition
 * rather than the provider.
 */
it('CRT-CON-06-A: the production runtime builds a read-only client per provider and a revoker', () => {
  const resolved: string[] = [];
  const runtime = createConnectorRuntime({ async resolve(handle) { resolved.push(handle); return 'token'; } });
  for (const connectorType of ['GMAIL', 'GOOGLE_CALENDAR', 'GITHUB']) {
    const client = runtime.connectorClient({ connectorType, secretRef: 'secret://mounted/' + connectorType + '#token' });
    expect(typeof client.fetchPage).toBe('function');
  }
  // Building a client must not touch the secrets manager: the handle is resolved
  // per fetch, inside the package that holds the bearer token.
  expect(resolved).toEqual([]);
  expect(typeof runtime.revokeTokens).toBe('function');
  // A connector with no stored credential cannot be synced, and a first-party
  // type has no provider to poll at all.
  expect(() => runtime.connectorClient({ connectorType: 'GMAIL', secretRef: null }))
    .toThrow('CONNECTOR_CREDENTIAL_MISSING');
  for (const connectorType of ['CONVERSATION', 'DOCUMENT']) {
    expect(() => runtime.connectorClient({ connectorType, secretRef: 'secret://mounted/x#t' }))
      .toThrow('CONNECTOR_CLIENT_UNSUPPORTED');
  }
});
