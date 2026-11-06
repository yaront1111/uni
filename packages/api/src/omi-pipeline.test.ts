/**
 * The Omi epic's end-to-end gate (task-2d70aa23cdd54252b45303071d5b6a5e; ADR 0041
 * D2-D5, D7 and D8): the fixture conversation goes through the real OMI connector
 * sync, Tier-0/Tier-1 triage, an `evidence.extract` job with a provider double,
 * and the claim store, and is read back through GET /v1/evidence/{id}.
 *
 * Only Omi HTTP, the SecretsManager, the object store and the model provider are
 * doubled. The harness shape is copied from omi-connector.test.ts (frozen by
 * task-9fd2751b) and the extraction plumbing from extraction-pipeline.test.ts.
 *
 * Owner decision, 2026-11-06 (comment-79153fa7): the read surface that names the
 * conversation, the segment index and the speaker is GET /v1/evidence/{id}. No
 * memory read surface shows an unresolved claim's statement and label yet
 * (task-732c9d9a): the inspector's 404 is pinned below, not built. The sync does
 * record the transcript's processing intent (migration 0031's triage trigger), so
 * the read shows it PENDING; this file drives the `evidence.extract` job itself.
 */
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runMigrations, withOwnerTransaction } from '@unai/postgres';
import { postgresAdapter, SESSION_COOKIE } from '@unai/auth';
import type { RequestContext } from '@unai/domain';
import type { SecretsManager } from '@unai/secrets';
import { enqueueJob, runJobAttempt, JOB_PURPOSES } from '@unai/jobs';
import { createModelGateway, MODEL_PURPOSES, type ModelProvider, type ModelProviderRequest } from '@unai/model';
import { EXTRACTION_JOB_KIND, createExtractionJobHandler, runExtraction,
  type ExtractionTransactionRunner } from '@unai/extraction';
import { classifyCommitmentLanguage } from '@unai/capabilities';
import { createPlatformApi } from './platform.js';
import { createConnectorRuntime } from './connectors.js';
import { canonicalizeProcessingClaims } from './processing-canonicalization.js';
import type { EvidenceObjects } from './evidence.js';

let admin!: Pool;
let appPool!: Pool;
beforeAll(async () => {
  const databaseUrl = process.env.UNAI_TEST_DATABASE_URL;
  if (!databaseUrl) throw new Error('Run pnpm test for the required PostgreSQL harness');
  admin = new Pool({ connectionString: databaseUrl });
  const appUrl = new URL(databaseUrl);
  appUrl.username = 'omi_pipeline_test_app'; appUrl.password = 'test-only';
  appPool = new Pool({ connectionString: appUrl.href });
  await runMigrations(admin, resolve('migrations'));
  await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='omi_pipeline_test_app') THEN CREATE ROLE omi_pipeline_test_app LOGIN PASSWORD 'test-only'; END IF; END $$; GRANT unai_app TO omi_pipeline_test_app");
});
afterAll(async () => { await appPool?.end(); await admin?.end(); });

const OMI_LIST = 'https://api.omi.me/v1/dev/user/conversations';
const HANDLE = 'secret://test/omi-key';
const KEY = 'omi_dev_' + randomBytes(24).toString('hex');
const BODY_MARKER = 'omi-provider-body-' + randomUUID();
const DAY_MS = 86_400_000;
interface Segment { speaker_id?: number; speaker_name: string; start: number; end: number; text: string }
interface OmiFixture { id: string; started_at: string; transcript_segments: Segment[] }
const fixture = JSON.parse(await readFile(resolve('fixtures/sources/omi-conversation.json'), 'utf8')) as OmiFixture;
const segmentText = (index: number): string => fixture.transcript_segments[index]!.text;

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
  const requests: { method: string; url: URL }[] = [];
  const replies: (() => Response)[] = [];
  const fake: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    requests.push({ method: (init?.method ?? 'GET').toUpperCase(), url });
    if (url.origin + url.pathname !== OMI_LIST) return new Response('{}', { status: 404 });
    return replies.shift()?.() ?? failure(500);
  };
  return { requests, replies, install() { globalThis.fetch = fake; }, restore() { globalThis.fetch = original; } };
}

async function harness() {
  const adapter = postgresAdapter(admin);
  const user = await adapter.createUser!({ name: 'Omi pipeline', email: 'omi-pipeline-' + randomUUID() + '@example.test', emailVerified: null });
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
  const resolved: string[] = [];
  const secrets: SecretsManager = {
    async resolve(handle) {
      resolved.push(handle);
      if (handle !== HANDLE) throw new Error('SECRET_NOT_FOUND');
      return KEY;
    },
  };
  const omi = omiProvider(), correlationId = randomUUID();
  const app = createPlatformApi({ authPool: admin, appPool, evidenceObjects,
    registryReleaseId: randomUUID(), connectors: createConnectorRuntime(secrets) });
  app.addHook('onRequest', async request => {
    Object.defineProperty(request.raw.socket, 'encrypted', { value: true, configurable: true });
  });
  const context = (purpose: string): RequestContext => ({ actorId: user.id, ownerScopeId, purpose, correlationId });
  const runner: ExtractionTransactionRunner = (purpose, run) => withOwnerTransaction(appPool, context(purpose), run);
  const result = {
    app, ownerScopeId, omi, resolved, context, runner, correlationId,
    headers(purpose: string, extra: Record<string, string> = {}) {
      return {
        cookie: SESSION_COOKIE + '=' + token, 'x-owner-scope-id': ownerScopeId, 'x-purpose': purpose,
        'x-correlation-id': randomUUID(), 'idempotency-key': randomUUID(),
        'x-data-purpose': 'PERSONAL_ASSISTANCE', 'x-maximum-sensitivity': 'PRIVATE', ...extra,
      };
    },
    async close() { omi.restore(); await app.close(); },
  };
  // Nothing that can fail during setup follows installing the process-global double.
  omi.install();
  return result;
}
type Harness = Awaited<ReturnType<typeof harness>>;

async function post(h: Harness, url: string, purpose: string, payload: Record<string, unknown>) {
  return h.app.inject({ method: 'POST', url, headers: h.headers(purpose), payload });
}
async function connectOmi(h: Harness): Promise<string> {
  const response = await post(h, '/v1/connectors', 'connector.manage', { connectorType: 'OMI',
    externalAccountRef: 'owner@example.test', secretRef: HANDLE,
    requestedCapabilities: [{ capabilityId: 'omi.read_conversations', granted: true }] });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ connectorId: string }>().connectorId;
}
const sync = (h: Harness, id: string, body: Record<string, unknown> = {}) =>
  post(h, '/v1/connectors/' + id + '/sync', 'connector.sync', { allowedPurposes: ['PERSONAL_ASSISTANCE'], ...body });
const disconnect = (h: Harness, id: string) => post(h, '/v1/connectors/' + id + '/disconnect', 'connector.manage', {});

async function rows<T>(sql: string, values: unknown[]): Promise<T[]> {
  return (await admin.query(sql, values)).rows as T[];
}
async function count(sql: string, values: unknown[]): Promise<number> {
  const [row] = await rows<{ n: string }>(sql, values);
  return Number(row!.n);
}
async function itemIds(owner: string): Promise<{ transcript: string; structured: string }> {
  const items = await rows<{ id: string; external_id: string }>(
    'SELECT id,external_id FROM source_items WHERE owner_scope_id=$1 ORDER BY external_id', [owner]);
  expect(items.map(item => item.external_id)).toEqual(['omi:conversation:' + fixture.id, 'omi:conversation:' + fixture.id + ':structured']);
  return { transcript: items[0]!.id, structured: items[1]!.id };
}
interface ConnectorRow { status: string; secret_ref: string | null; last_cursor: unknown; last_sync_error: string | null; disconnected_at: Date | null }
async function connectorRow(h: Harness, id: string): Promise<ConnectorRow> {
  const [row] = await rows<ConnectorRow>('SELECT status,secret_ref,last_cursor,last_sync_error,disconnected_at FROM connectors WHERE owner_scope_id=$1 AND id=$2',
    [h.ownerScopeId, id]);
  return row!;
}
interface ClaimRow {
  id: string; claim_origin: string; lifecycle: string; proposition_id: string | null; asserted_by_entity_id: string | null;
  extraction_run_id: string; anchor_kind: string; anchor: Record<string, unknown>; normalized_text: string;
  source_item_id: string; metadata: { quote: string; statement: string };
}
const claims = (owner: string) => rows<ClaimRow>(`SELECT c.*,a.anchor_kind,a.anchor,a.normalized_text,a.source_item_id
  FROM claims c JOIN source_anchors a ON a.owner_scope_id=c.owner_scope_id AND a.id=c.source_anchor_id
  WHERE c.owner_scope_id=$1 ORDER BY c.recorded_at,c.id`, [owner]);
const runs = (owner: string) => rows<{ id: string; source_item_id: string; status: string; error_code: string | null }>(
  'SELECT id,source_item_id,status,error_code FROM extraction_runs WHERE owner_scope_id=$1 ORDER BY started_at,id', [owner]);

interface CitableAnchor { anchorKind: string; parentAnchor: Record<string, unknown>; text: string }
/** The deliberately obeying extractor: it does exactly what the system prompt
 * asks, citing one transcript segment by its own anchor and quoting the exact
 * characters at `start` (shifted by `shift` to prove a wrong offset is refused). */
function segmentCiting(segmentIndex: number, quote: string, shift = 0) {
  const requests: ModelProviderRequest[] = [];
  const provider: ModelProvider = {
    providerId: 'anthropic', defaultModelId: 'claude-omi-pipeline-test',
    async complete(request) {
      requests.push(request);
      const input = JSON.parse(request.input) as { anchors: CitableAnchor[] };
      // Narrowed claim anchors of earlier runs keep segmentIndex; the segment's own anchor starts at 0.
      const anchor = input.anchors.find(candidate => candidate.parentAnchor.segmentIndex === segmentIndex
        && candidate.parentAnchor.start === 0);
      if (!anchor) throw new Error('TEST_SEGMENT_ANCHOR_MISSING');
      const found = anchor.text.indexOf(quote);
      if (found === -1) throw new Error('TEST_FIXTURE_QUOTE_MISSING');
      const start = found + shift;
      const claim = { frameTypeId: 'shared.commitment', statement: 'Omi pipeline statement for segment ' + segmentIndex,
        span: { anchorKind: anchor.anchorKind, parentAnchor: anchor.parentAnchor, start, end: start + quote.length, quote },
        extractionConfidence: 0.7, temporalExpression: null, participants: [] };
      return { modelId: 'claude-omi-pipeline-test', outputText: JSON.stringify({ claims: [claim], unknowns: [] }), costMicrounits: 1450 };
    },
  };
  return { provider, requests };
}
function extraction(h: Harness, sourceItemId: string) {
  return { ownerScopeId: h.ownerScopeId, sourceItemId, runKind: 'FULL' as const, registryReleaseId: randomUUID(),
    correlationId: h.correlationId, referenceInstant: new Date(fixture.started_at), timeZone: 'UTC',
    dataPurpose: 'PERSONAL_ASSISTANCE', maximumSensitivity: 'PRIVATE' as const };
}
const gatewayFor = (h: Harness, provider: ModelProvider) => createModelGateway({ provider,
  recordCall: run => withOwnerTransaction(appPool, h.context(MODEL_PURPOSES.call), run) });
/** One `evidence.extract` job through the durable queue; returns the run it created. */
async function extractJob(h: Harness, sourceItemId: string, provider: ModelProvider): Promise<string> {
  const before = new Set((await runs(h.ownerScopeId)).map(run => run.id));
  const request = extraction(h, sourceItemId);
  await withOwnerTransaction(appPool, h.context(JOB_PURPOSES.enqueue), tx => enqueueJob(tx, {
    jobKind: EXTRACTION_JOB_KIND, idempotencyKey: randomUUID().replaceAll('-', ''), maxAttempts: 2,
    payload: { ...request, referenceInstant: request.referenceInstant.toISOString() },
  }));
  const handler = createExtractionJobHandler({ gateway: gatewayFor(h, provider), runnerFor: () => h.runner });
  const result = await runJobAttempt(appPool, h.context(JOB_PURPOSES.work), {
    worker: 'omi-pipeline-test-worker', leaseSeconds: 30, jobKinds: [EXTRACTION_JOB_KIND], handler });
  expect(result.job?.status).toBe('SUCCEEDED');
  const created = (await runs(h.ownerScopeId)).filter(run => !before.has(run.id));
  expect(created.map(run => [run.source_item_id, run.status])).toEqual([[sourceItemId, 'SUCCEEDED']]);
  return created[0]!.id;
}
async function syncFixture(h: Harness): Promise<{ id: string; transcript: string; structured: string }> {
  const id = await connectOmi(h);
  h.omi.replies.push(() => page([fixture]));
  const synced = await sync(h, id);
  expect(synced.statusCode, synced.body).toBe(200);
  expect(synced.json()).toMatchObject({ itemsIngested: 2, storedSensitivity: 'PRIVATE' });
  return { id, ...(await itemIds(h.ownerScopeId)) };
}

it('ADR 0041 D2-D5 end to end: an owner commitment in a synced Omi transcript becomes a candidate claim anchored to its TRANSCRIPT_SEGMENT', async () => {
  const h = await harness();
  try {
    const { transcript, structured } = await syncFixture(h);
    const triage = await rows<{ source_item_id: string; tier1_route: string; routing_reason: { code: string; positiveSignals: string[] } }>(
      'SELECT source_item_id,tier1_route,routing_reason FROM triage_decisions WHERE owner_scope_id=$1 ORDER BY source_item_id,id', [h.ownerScopeId]);
    const route = (itemId: string) => triage.filter(row => row.source_item_id === itemId);
    expect(route(transcript).map(row => [row.tier1_route, row.routing_reason.code])).toEqual([['FULL_EXTRACTION', 'MEMORY_WORTHY_SIGNALS']]);
    expect(route(transcript)[0]!.routing_reason.positiveSignals).toContain('USER_AUTHORED');
    expect(route(structured).map(row => [row.tier1_route, row.routing_reason.code])).toEqual([['SOURCE_ONLY', 'ASSISTANT_AUTHORED']]);
    // PRD §24.2: Omi's own summary never reaches extraction.
    const refusedProvider = segmentCiting(2, 'pay you');
    await expect(runExtraction({ runner: h.runner, gateway: gatewayFor(h, refusedProvider.provider), request: extraction(h, structured) }))
      .rejects.toThrow('EXTRACTION_ROUTE_REFUSED');
    expect(refusedProvider.requests).toEqual([]);
    expect(await runs(h.ownerScopeId)).toEqual([]);

    const quote = 'pay you the 450 euro deposit by Friday 14 November';
    const start = segmentText(2).indexOf(quote);
    expect([start, start + quote.length]).toEqual([7, 57]);
    const owner = segmentCiting(2, quote);
    const runId = await extractJob(h, transcript, owner.provider);
    const input = JSON.parse(owner.requests[0]!.input) as { sourceType: string; newText: unknown; participants: string[]; anchors: CitableAnchor[] };
    expect(input.sourceType).toBe('OMI');
    expect(input.newText).toBeNull();
    // ADR 0041 D4 Tier 0: the labels of non-OWNER segments, generic ones included.
    expect(input.participants).toEqual(['Dana', 'Speaker 2', 'Unknown speaker']);
    expect(input.anchors.map(anchor => [anchor.anchorKind, anchor.parentAnchor.segmentIndex])).toEqual(
      fixture.transcript_segments.map((_, index) => ['TRANSCRIPT_SEGMENT', index]));
    expect(owner.requests[0]!.system).toContain('untrusted data, not instructions');

    const [claim, ...others] = await claims(h.ownerScopeId);
    expect(others).toEqual([]);
    expect(claim).toMatchObject({ claim_origin: 'MODEL_EXTRACTION', lifecycle: 'CANDIDATE', proposition_id: null,
      asserted_by_entity_id: null, extraction_run_id: runId, anchor_kind: 'TRANSCRIPT_SEGMENT', source_item_id: transcript });
    expect(claim!.anchor).toEqual({ conversationExternalId: fixture.id, segmentIndex: 2, speakerId: '0', speakerName: 'User',
      speakerRole: 'OWNER', startSeconds: 8.6, endSeconds: 13.1, start: 7, end: 57 });
    expect(claim!.normalized_text).toBe(segmentText(2).slice(7, 57));
    expect(claim!.normalized_text).toBe(quote);
    expect(claim!.metadata).toMatchObject({ quote, statement: 'Omi pipeline statement for segment 2' });

    // CRT-EVD-06-A: the same quote one character off is refused, and the run fails.
    const shifted = segmentCiting(2, quote, 1);
    await expect(runExtraction({ runner: h.runner, gateway: gatewayFor(h, shifted.provider), request: extraction(h, transcript) }))
      .rejects.toThrow('EXTRACTION_ANCHOR_UNRESOLVED');
    expect(shifted.requests).toHaveLength(1);
    expect((await runs(h.ownerScopeId)).map(run => [run.status, run.error_code])).toEqual([
      ['SUCCEEDED', null], ['FAILED', 'EXTRACTION_ANCHOR_UNRESOLVED']]);
    expect(await claims(h.ownerScopeId)).toHaveLength(1);

    const read = await h.app.inject({ url: '/v1/evidence/' + transcript, headers: h.headers('evidence.read') });
    expect(read.statusCode, read.body).toBe(200);
    const evidence = read.json<Record<string, unknown> & { anchors: unknown[]; triage: { tier1Route: string } }>();
    expect(evidence).toMatchObject({ sourceType: 'OMI', externalId: 'omi:conversation:' + fixture.id,
      actorRef: { type: 'EXTERNAL', id: 'omi:transcript' }, sensitivity: 'PRIVATE' });
    expect(evidence.triage.tier1Route).toBe('FULL_EXTRACTION');
    // The narrowest surface naming the conversation, the segment index and the speaker.
    // The statement-with-label half has no surface yet (task-732c9d9a).
    expect(evidence.anchors).toContainEqual({ kind: 'TRANSCRIPT_SEGMENT', anchor: claim!.anchor, normalizedText: quote });
    // ADR 0038: migration 0031's triage trigger recorded the transcript's intent in
    // the sync transaction (task-b00c772f's "no intent" premise does not hold);
    // Omi's ASSISTANT summary never gets one (PRD §24.2).
    expect(evidence.processing).toEqual({ status: 'PENDING', unresolvedClaims: 0, lastError: null, completedAt: null });
    const summary = await h.app.inject({ url: '/v1/evidence/' + structured, headers: h.headers('evidence.read') });
    expect(summary.statusCode, summary.body).toBe(200);
    expect(summary.json()).toMatchObject({ actorRef: { type: 'ASSISTANT', id: 'omi:structured' }, processing: null });
    expect((await rows<{ source_item_id: string }>('SELECT source_item_id FROM evidence_processing WHERE owner_scope_id=$1',
      [h.ownerScopeId])).map(row => row.source_item_id)).toEqual([transcript]);
    // task-732c9d9a replaces this pin: an unresolved claim has no belief to inspect.
    const inspected = await h.app.inject({ url: '/v1/memory/inspector/claim/' + claim!.id, headers: h.headers('memory.inspect') });
    expect(inspected.statusCode, inspected.body).toBe(404);
    expect(inspected.json()).toMatchObject({ code: 'INSPECTOR_TARGET_NOT_FOUND' });
  } finally { await h.close(); }
}, 60_000);

it('ADR 0041 D4 attribution: a bystander claim names Dana, and canonicalization leaves every Omi claim unresolved', async () => {
  const h = await harness();
  try {
    const { transcript } = await syncFixture(h);
    const danaQuote = 'the deposit settled before the lease starts';
    expect(segmentText(1).indexOf(danaQuote)).toBe(19);
    const danaRun = await extractJob(h, transcript, segmentCiting(1, danaQuote).provider);
    const [dana] = await claims(h.ownerScopeId);
    expect(dana!.anchor).toMatchObject({ segmentIndex: 1, speakerId: '1', speakerName: 'Dana', speakerRole: 'OTHER', start: 19, end: 62 });
    expect(dana).toMatchObject({ asserted_by_entity_id: null, claim_origin: 'MODEL_EXTRACTION', normalized_text: danaQuote });

    // The owner's own first-person commitment reaches the classifier's actor check.
    const sentence = segmentText(2);
    expect(classifyCommitmentLanguage(sentence).language).toBe('COMMITMENT');
    const ownerRun = await extractJob(h, transcript, segmentCiting(2, sentence).provider);
    for (const extractionRunId of [danaRun, ownerRun]) {
      const outcome = await withOwnerTransaction(appPool, h.context('memory.canonicalize'), async tx => {
        await tx.query("SELECT set_config('unai.data_purpose','PERSONAL_ASSISTANCE',true),set_config('unai.maximum_sensitivity','PRIVATE',true)");
        return canonicalizeProcessingClaims(tx, { sourceItemId: transcript, extractionRunId, registryReleaseId: randomUUID(),
          referenceInstant: new Date(fixture.started_at), timeZone: 'UTC' });
      });
      // D4/D10(d): the EXTERNAL omi:transcript actor is nobody's identity, not even the owner's.
      expect(outcome).toEqual({ assertions: [], unresolved: 1 });
    }
    expect(await claims(h.ownerScopeId)).toHaveLength(2);
    expect(await count('SELECT count(*) AS n FROM claims WHERE owner_scope_id=$1 AND (proposition_id IS NOT NULL OR asserted_by_entity_id IS NOT NULL)',
      [h.ownerScopeId])).toBe(0);
    expect(await count('SELECT count(*) AS n FROM frame_instance_roles WHERE owner_scope_id=$1', [h.ownerScopeId])).toBe(0);
  } finally { await h.close(); }
}, 60_000);

it('ADR 0041 D7 in combination: a 429 on page 2 rolls back page 1, records SYNC_FAILED, and the next sync ingests the conversation', async () => {
  const h = await harness();
  try {
    const id = await connectOmi(h);
    h.omi.replies.push(() => page([fixture], { 'x-omi-list-truncated': 'true' }), () => failure(429, { 'retry-after': '30' }));
    const limited = await sync(h, id, { maxPages: 2 });
    expect(limited.statusCode, limited.body).toBe(429);
    expect(limited.json()).toMatchObject({ code: 'CONNECTOR_RATE_LIMITED', retryAfterSeconds: 30 });
    expect(limited.body).not.toContain(BODY_MARKER);
    expect(h.omi.requests).toHaveLength(2);
    // One sync is one transaction: the first page's items rolled back with it.
    expect(await count('SELECT count(*) AS n FROM source_items WHERE owner_scope_id=$1', [h.ownerScopeId])).toBe(0);
    expect(await connectorRow(h, id)).toMatchObject({ status: 'SYNC_FAILED', last_sync_error: 'CONNECTOR_RATE_LIMITED', last_cursor: null });
    h.omi.replies.push(() => page([fixture]));
    const resumed = await sync(h, id);
    expect(resumed.statusCode, resumed.body).toBe(200);
    expect(resumed.json()).toMatchObject({ resumedFromCursor: null, itemsIngested: 2 });
    expect(await connectorRow(h, id)).toMatchObject({ status: 'ACTIVE', last_sync_error: null });
    expect(h.omi.requests.every(request => request.method === 'GET' && request.url.origin + request.url.pathname === OMI_LIST)).toBe(true);
  } finally { await h.close(); }
}, 60_000);

it('ADR 0041 D8 in combination: disconnecting a SYNC_FAILED Omi connector returns the manual-revocation receipt without calling Omi', async () => {
  const h = await harness();
  try {
    const id = await connectOmi(h);
    h.omi.replies.push(() => failure(429, { 'retry-after': '30' }));
    expect((await sync(h, id)).statusCode).toBe(429);
    expect((await connectorRow(h, id)).status).toBe('SYNC_FAILED');
    const before = { requests: h.omi.requests.length, resolved: h.resolved.length };
    const response = await disconnect(h, id);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ connectorId: id, status: 'DISCONNECTED', tokensRevokedAtProvider: false,
      secretReferenceDestroyed: true, ingestionStopped: true, capabilitiesRevoked: ['omi.read_conversations'],
      retainedEvidence: 'RETAINED', retainedEvidenceOptions: ['KEEP_EVIDENCE', 'REQUEST_DELETION'],
      providerRevocationNotice: 'CONNECTOR_REVOCATION_MANUAL_REQUIRED' });
    expect({ requests: h.omi.requests.length, resolved: h.resolved.length }).toEqual(before);
    const row = await connectorRow(h, id);
    expect(row).toMatchObject({ status: 'DISCONNECTED', secret_ref: null, last_cursor: null });
    expect(row.disconnected_at).toBeInstanceOf(Date);
    expect(await count('SELECT count(*) AS n FROM connector_capability_grants WHERE owner_scope_id=$1 AND connector_id=$2 AND (granted OR revoked_at IS NULL)',
      [h.ownerScopeId, id])).toBe(0);
    const stopped = await sync(h, id);
    expect(stopped.statusCode).toBe(409);
    expect(stopped.json()).toMatchObject({ code: 'CONNECTOR_INGESTION_STOPPED' });
    expect(h.omi.requests).toHaveLength(before.requests);
  } finally { await h.close(); }
}, 60_000);
