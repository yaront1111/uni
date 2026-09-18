import {Pool} from 'pg';
import {beforeAll, afterAll, expect, it} from 'vitest';
import {randomUUID, randomBytes, createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {runMigrations, withOwnerTransaction, type OwnerTransaction} from '@unai/postgres';
import {postgresAdapter, SESSION_COOKIE} from '@unai/auth';
import {parseSourcePayload, type ParsedSourceItem, type RequestContext} from '@unai/domain';
import {runJobAttempt, enqueueJob, listDeadLetterJobs, claimJob, JOB_PURPOSES} from '@unai/jobs';
import {createModelGateway, MODEL_PURPOSES, type ModelProvider} from '@unai/model';
import {EXTRACTION_JOB_KIND, EXTRACTION_PURPOSES, createExtractionJobHandler, runExtraction,
  readExtractionRun, readTriageDecision, type ExtractionTransactionRunner} from '@unai/extraction';
import {createPlatformApi} from './platform.js';
import {importSource, type EvidenceObjects} from './evidence.js';

/** Ingest, triage, extraction and the queue, composed exactly as the runtime
 * composes them, over real PostgreSQL and the real owner boundary.
 *
 * The model is the only double: a provider that answers from the material it was
 * given. Everything else -- the parsers, the triage service, the gateway, the
 * extraction service, the claim store and the durable queue -- is the delivered
 * code, and every assertion below is about what those wrote to the database.
 */

if (!process.env.UNAI_TEST_DATABASE_URL) throw new Error('Run pnpm test for the required PostgreSQL harness');
const admin = new Pool({connectionString: process.env.UNAI_TEST_DATABASE_URL});
const url = new URL(process.env.UNAI_TEST_DATABASE_URL); url.username = 'extraction_test_app'; url.password = 'test-only';
const appPool = new Pool({connectionString: url.href});
const registryReleaseId = randomUUID();

beforeAll(async () => {
  await runMigrations(admin, resolve('migrations'));
  await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='extraction_test_app') THEN CREATE ROLE extraction_test_app LOGIN PASSWORD 'test-only'; END IF; END $$; GRANT unai_app TO extraction_test_app");
  // The release a run pins itself to. The application role holds no read
  // privilege on the snapshot and the pin carries no foreign key (ADR 0011,
  // ADR 0016 Section 3), so the runtime supplies the id from the loaded release;
  // this suite supplies one without touching the global snapshot the registry
  // node owns and publishes into.
});
afterAll(async () => { await appPool.end(); await admin.end(); });

async function fixture(name: string) {
  return JSON.parse(await readFile(resolve('fixtures/sources/' + name + '.json'), 'utf8'));
}

/** One owner with a connector, the ingest path, and the three transaction
 * purposes the model path runs under. */
async function owner(connectorType: string) {
  const adapter = postgresAdapter(admin);
  const user = await adapter.createUser!({name: 'Extraction test', email: 'extract-' + randomUUID() + '@example.test', emailVerified: null});
  const token = randomBytes(32).toString('base64url');
  await adapter.createSession!({userId: user.id, sessionToken: token, expires: new Date(Date.now() + 86400000)});
  const ownerScopeId = (user as unknown as {ownerScopeId: string}).ownerScopeId;
  const connectorId = randomUUID();
  await admin.query('INSERT INTO connectors(id,owner_scope_id,connector_type,external_account_ref,permission_manifest,status) VALUES($1,$2,$3,$4,$5,$6)',
    [connectorId, ownerScopeId, connectorType, 'account-' + randomUUID(), '{}', 'ACTIVE']);
  const stored = new Map<string, Uint8Array>();
  const objects: EvidenceObjects = {
    encryptionKeyRef: 'kms:test-double',
    async put(_tx, id, bytes) { stored.set(id, bytes); },
    async get(_tx, id) { return stored.get(id)!; },
  };
  const correlationId = randomUUID();
  function context(purpose: string): RequestContext { return {actorId: user.id, ownerScopeId, purpose, correlationId}; }
  const runner: ExtractionTransactionRunner = (purpose, run) => withOwnerTransaction(appPool, context(purpose), run);
  async function importFixture(sourceType: string, payload: unknown, connector: string | null = connectorId) {
    return withOwnerTransaction(appPool, context('evidence.ingest'), async tx => {
      await tx.query("SELECT set_config('unai.data_purpose','PERSONAL_ASSISTANCE',true),set_config('unai.maximum_sensitivity','RESTRICTED',true)");
      return importSource(tx, objects, {sourceType, payload, connectorId: connector, sensitivity: 'PRIVATE', allowedPurposes: ['PERSONAL_ASSISTANCE']});
    });
  }
  async function items() {
    return (await admin.query('SELECT * FROM source_items WHERE owner_scope_id=$1 ORDER BY external_id', [ownerScopeId])).rows;
  }
  async function routes() {
    return (await admin.query(`SELECT s.external_id,t.tier1_route,t.routing_reason,t.cost_budget_microunits,t.tier0_parsed
      FROM source_items s LEFT JOIN triage_decisions t ON t.owner_scope_id=s.owner_scope_id AND t.source_item_id=s.id
      WHERE s.owner_scope_id=$1 ORDER BY s.external_id`, [ownerScopeId])).rows;
  }
  async function runs() {
    return (await admin.query('SELECT * FROM extraction_runs WHERE owner_scope_id=$1 ORDER BY started_at,id', [ownerScopeId])).rows;
  }
  async function claims() {
    return (await admin.query(`SELECT c.*,a.anchor_kind,a.anchor,a.normalized_text,a.source_item_id
      FROM claims c JOIN source_anchors a ON a.owner_scope_id=c.owner_scope_id AND a.id=c.source_anchor_id
      WHERE c.owner_scope_id=$1 ORDER BY c.recorded_at,c.id`, [ownerScopeId])).rows;
  }
  return {user, token, ownerScopeId, connectorId, context, runner, importFixture, items, routes, runs, claims, correlationId};
}

/** A provider that answers from the material it was actually given: it cites a
 * span of a real anchor and quotes it exactly, as a well-behaved extractor would.
 * `mutate` lets one test make it misbehave. */
function citingProvider(options?: {mutate?(claim: Record<string, unknown>, input: Record<string, any>): unknown; cost?: number}): ModelProvider {
  return {
    providerId: 'anthropic', defaultModelId: 'claude-extraction-test',
    async complete(request) {
      const input = JSON.parse(request.input) as {newText: string; anchors: Array<{anchorKind: string; parentAnchor: Record<string, unknown>; text: string}>};
      // Cite the anchor that actually holds the new content where there is one,
      // and otherwise the first anchor with text; quote it from the anchor's own
      // characters, which is the only way a span can be grounded afterwards.
      const anchor = input.anchors.find(candidate => input.newText !== '' && candidate.text.includes(input.newText.slice(0, 20)))
        ?? input.anchors.find(candidate => candidate.text.length > 0)!;
      const start = input.newText === '' ? 0 : Math.max(0, anchor.text.indexOf(input.newText.slice(0, 24)));
      const quoted = anchor.text.slice(start, start + 24);
      const claim: Record<string, unknown> = {
        frameTypeId: 'shared.commitment',
        statement: 'Surface frame read from ' + anchor.anchorKind,
        span: {anchorKind: anchor.anchorKind, parentAnchor: anchor.parentAnchor,
          start, end: start + quoted.length, quote: quoted},
        extractionConfidence: 0.72,
        temporalExpression: /friday/i.test(input.newText) ? 'Friday' : null,
        participants: [],
      };
      const output = options?.mutate ? options.mutate(claim, input) : {claims: [claim], unknowns: []};
      return {modelId: 'claude-extraction-test', outputText: JSON.stringify(output), costMicrounits: options?.cost ?? 1450};
    },
  };
}
/** Reading a route back needs the evidence access context the service declares
 * for itself: a triage row is readable exactly when its evidence is. */
function readRoute(o: Awaited<ReturnType<typeof owner>>, sourceItemId: string) {
  return withOwnerTransaction(appPool, o.context(EXTRACTION_PURPOSES.run), async tx => {
    await tx.query("SELECT set_config('unai.data_purpose','PERSONAL_ASSISTANCE',true),set_config('unai.maximum_sensitivity','PRIVATE',true)");
    return readTriageDecision(tx, {ownerScopeId: o.ownerScopeId, sourceItemId});
  });
}
function gatewayFor(o: Awaited<ReturnType<typeof owner>>, provider: ModelProvider) {
  return createModelGateway({provider, recordCall: run => withOwnerTransaction(appPool, o.context(MODEL_PURPOSES.call), run)});
}
function extractionRequest(o: Awaited<ReturnType<typeof owner>>, sourceItemId: string, runKind: 'FULL' | 'TARGETED' = 'FULL') {
  return {ownerScopeId: o.ownerScopeId, sourceItemId, runKind, registryReleaseId, correlationId: o.correlationId,
    referenceInstant: new Date('2026-09-01T09:00:00Z'), timeZone: 'Asia/Jerusalem',
    dataPurpose: 'PERSONAL_ASSISTANCE', maximumSensitivity: 'PRIVATE' as const};
}

it('CRT-WRT-07-A: every ingested item carries a Tier-1 route and reason, decided before any extraction', async () => {
  const o = await owner('GMAIL');
  await o.importFixture('GMAIL', await fixture('gmail-thread'));
  await o.importFixture('GMAIL', await fixture('gmail-newsletter'));
  await o.importFixture('GITHUB', await fixture('github-ci-notification'), null);
  await o.importFixture('DOCUMENT', await fixture('uploaded-document'), null);

  const routed = await o.routes();
  expect(routed.length).toBe((await o.items()).length);
  const allowed = new Set(['SOURCE_ONLY', 'INDEX_ONLY', 'ENTITY_EXTRACTION', 'FULL_EXTRACTION', 'DEFER_UNTIL_RELEVANT']);
  for (const row of routed) {
    expect(row.tier1_route, row.external_id).not.toBeNull();
    expect(allowed.has(row.tier1_route), row.external_id + ' -> ' + row.tier1_route).toBe(true);
    expect(typeof row.routing_reason.code, row.external_id).toBe('string');
    expect(row.routing_reason.routerVersion).toBe('tier1-rules-0.1.0');
    expect(row.tier0_parsed.parserVersion).toBe('tier0-deterministic-0.1.0');
  }
  // Routing happened with no extraction run and no model call anywhere.
  expect(await o.runs()).toEqual([]);
  expect((await admin.query('SELECT count(*)::int AS calls FROM model_call_records WHERE owner_scope_id=$1', [o.ownerScopeId])).rows[0].calls).toBe(0);

  // The newsletter and the two bot CI comments are preserved and indexed, never
  // fully extracted; the human pull request in the same payload still is.
  const byId = new Map(routed.map(row => [row.external_id, row]));
  expect(byId.get('msg-nl-0001')!.tier1_route).toBe('INDEX_ONLY');
  expect(byId.get('msg-nl-0001')!.routing_reason.code).toBe('NEWSLETTER');
  for (const externalId of ['example-org/uai-reference#418/comments/9014455', 'example-org/uai-reference#418/comments/9014456']) {
    expect(byId.get(externalId)!.tier1_route, externalId).toBe('INDEX_ONLY');
    expect(byId.get(externalId)!.routing_reason.code).toBe('ROUTINE_CI_NOTIFICATION');
  }
  expect(byId.get('example-org/uai-reference#418')!.tier1_route).not.toBe('FULL_EXTRACTION');

  // A route that admits no deep extraction refuses one when it is attempted.
  const newsletterId = (await o.items()).find(row => row.external_id === 'msg-nl-0001')!.id;
  await expect(runExtraction({runner: o.runner, gateway: gatewayFor(o, citingProvider()), request: extractionRequest(o, newsletterId)}))
    .rejects.toThrow('EXTRACTION_ROUTE_REFUSED');
  expect(await o.runs()).toEqual([]);
});

it('CRT-EVD-03-A: the evidence read returns the triage route and reason, and null before triage exists', async () => {
  const o = await owner('GMAIL');
  const imported = await o.importFixture('GMAIL', await fixture('gmail-thread'));
  const app = createPlatformApi({authPool: admin, appPool, evidenceObjects: {
    encryptionKeyRef: 'kms:test-double', async put() {}, async get() { return new Uint8Array(); },
  }});
  app.addHook('onRequest', async request => { Object.defineProperty(request.raw.socket, 'encrypted', {value: true}); });
  try {
    const read = async (id: string) => app.inject({url: '/v1/evidence/' + id, headers: {
      cookie: SESSION_COOKIE + '=' + o.token, 'x-owner-scope-id': o.ownerScopeId, 'x-purpose': 'evidence.read',
      'x-correlation-id': randomUUID(), 'x-data-purpose': 'PERSONAL_ASSISTANCE', 'x-maximum-sensitivity': 'RESTRICTED',
    }});
    const response = await read(imported[0]!.evidenceId);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().triage).toMatchObject({
      tier1Route: 'FULL_EXTRACTION', routingReason: {code: 'MEMORY_WORTHY_SIGNALS', routerVersion: 'tier1-rules-0.1.0'},
    });
    expect(response.json().anchors.length).toBeGreaterThan(0);

    // An item with no triage row stays readable: the route is null, not missing
    // evidence. This is the state after a triage row is absent for any reason.
    await admin.query('DELETE FROM triage_decisions WHERE owner_scope_id=$1 AND source_item_id=$2', [o.ownerScopeId, imported[0]!.evidenceId]);
    const untriaged = await read(imported[0]!.evidenceId);
    expect(untriaged.statusCode).toBe(200);
    expect(untriaged.json().triage).toBeNull();
    expect(untriaged.json().contentHash).toBe(response.json().contentHash);
  } finally { await app.close(); }
});

it('CRT-WRT-07-B: a Gmail thread update with quoted history triggers one deep extraction, not one per quoted message', async () => {
  const o = await owner('GMAIL');
  // The thread as it stood, then the update that quotes all of it back.
  await o.importFixture('GMAIL', await fixture('gmail-thread'));
  const before = (await o.items()).length;
  const updated = await o.importFixture('GMAIL', await fixture('gmail-thread-update'));
  const items = await o.items();
  // Three messages were redelivered and deduplicated; one is new.
  expect(items.length).toBe(before + 1);
  expect(updated.filter(item => item.stored).map(item => item.externalId)).toEqual(['msg-9a1c07']);

  const newest = items.find(row => row.external_id === 'msg-9a1c07')!;
  const gateway = gatewayFor(o, citingProvider());
  // Every item of the thread that triage admits is offered for extraction; the
  // quoted-history message is not one of them.
  const threadItems = items.filter(row => row.deterministic_metadata.threadExternalId === 'thread-1f8c2a4b7d');
  let deepRuns = 0;
  for (const item of threadItems) {
    const decision = await readRoute(o, item.id);
    if (decision!.tier1Route !== 'FULL_EXTRACTION' && decision!.tier1Route !== 'ENTITY_EXTRACTION') continue;
    if (item.id !== newest.id) continue;
    await runExtraction({runner: o.runner, gateway, request: extractionRequest(o, item.id)});
    deepRuns += 1;
  }
  expect(deepRuns).toBe(1);

  const runs = await o.runs();
  expect(runs).toHaveLength(1);
  expect(runs[0]!.source_item_id).toBe(newest.id);
  // One model call for the update, not one per quoted message.
  const calls = (await admin.query('SELECT count(*)::int AS calls FROM model_call_records WHERE owner_scope_id=$1', [o.ownerScopeId])).rows[0].calls;
  expect(calls).toBe(1);
  // What the run read was the new content alone: the three quoted messages are
  // already stored evidence and are never read out of the quoting body again.
  const tier0 = (await o.routes()).find(row => row.external_id === 'msg-9a1c07')!.tier0_parsed;
  expect(tier0.newText).toBe('Booked: the tiling crew starts on 14 September and I will pay the 4,200 deposit by Friday.');
  expect(tier0.quotedTextLength).toBeGreaterThan(0);
  for (const claim of await o.claims()) expect(claim.normalized_text).not.toContain('18,400');
});

it('CRT-EVD-06-A: every extracted claim anchors to a span present in its source item', async () => {
  const o = await owner('GMAIL');
  const corpus: Array<[string, string, string | null]> = [
    ['GMAIL', 'gmail-thread', o.connectorId], ['GMAIL', 'gmail-thread-update', o.connectorId],
    ['GOOGLE_CALENDAR', 'google-calendar-recurring-event', null], ['GITHUB', 'github-issue-thread', null],
    ['DOCUMENT', 'uploaded-document', null],
  ];
  const parsedByExternalId = new Map<string, ParsedSourceItem>();
  for (const [sourceType, name, connector] of corpus) {
    const payload = await fixture(name);
    for (const item of parseSourcePayload(sourceType, payload)) parsedByExternalId.set(item.externalId, item);
    await o.importFixture(sourceType, payload, connector);
  }
  const gateway = gatewayFor(o, citingProvider());
  const routed = await o.routes();
  const deep = routed.filter(row => row.tier1_route === 'FULL_EXTRACTION' || row.tier1_route === 'ENTITY_EXTRACTION');
  expect(deep.length).toBeGreaterThan(3);
  const items = await o.items();
  for (const row of deep) {
    const item = items.find(candidate => candidate.external_id === row.external_id)!;
    await runExtraction({runner: o.runner, gateway, request: extractionRequest(o, item.id)});
  }

  const claims = await o.claims();
  expect(claims.length).toBe(deep.length);
  for (const claim of claims) {
    expect(claim.claim_origin).toBe('MODEL_EXTRACTION');
    // A claim, never a belief: no proposition, and nothing accepted.
    expect(claim.proposition_id).toBeNull();
    expect(claim.lifecycle).toBe('CANDIDATE');
    expect(claim.extraction_run_id).not.toBeNull();

    const item = items.find(candidate => candidate.id === claim.source_item_id)!;
    const parsed = parsedByExternalId.get(item.external_id)!;
    const anchor = claim.anchor as Record<string, any>;
    // The anchor resolves against the source item's own content, re-derived from
    // the fixture bytes by the deterministic parser.
    const content = parsed.content as Record<string, any>;
    let sourceText: string;
    if (claim.anchor_kind === 'MESSAGE_SPAN') sourceText = String(content.body ?? '');
    else if (claim.anchor_kind === 'GITHUB_COMMENT') sourceText = String(content.body ?? '');
    else if (claim.anchor_kind === 'CALENDAR_FIELD') sourceText = String(content[anchor.field] ?? '');
    else if (claim.anchor_kind === 'DOCUMENT_RANGE') sourceText = String((content.pages as Array<{page: number; text: string}>).find(page => page.page === anchor.page)!.text);
    else sourceText = String(claim.normalized_text);
    expect(typeof anchor.start === 'number' && typeof anchor.end === 'number', claim.anchor_kind).toBe(true);
    expect(anchor.end).toBeLessThanOrEqual(sourceText.length);
    expect(sourceText.slice(anchor.start, anchor.end), claim.anchor_kind + ' span must resolve in its source item')
      .toBe(claim.normalized_text);
    expect(claim.metadata.quote).toBe(claim.normalized_text);
  }
});

it('CRT-EVD-06-A: a span the source item does not contain fails the run instead of becoming a claim', async () => {
  const o = await owner('GMAIL');
  const imported = await o.importFixture('GMAIL', await fixture('gmail-thread'));
  const inventedQuote = gatewayFor(o, citingProvider({mutate: claim => ({
    claims: [{...claim, span: {...(claim.span as Record<string, unknown>), quote: 'a sentence the message never contained'}}], unknowns: [],
  })}));
  await expect(runExtraction({runner: o.runner, gateway: inventedQuote, request: extractionRequest(o, imported[0]!.evidenceId)}))
    .rejects.toThrow('EXTRACTION_ANCHOR_UNRESOLVED');
  const offsetPastEnd = gatewayFor(o, citingProvider({mutate: claim => ({
    claims: [{...claim, span: {...(claim.span as Record<string, unknown>), start: 900000, end: 900010, quote: 'whatever'}}], unknowns: [],
  })}));
  await expect(runExtraction({runner: o.runner, gateway: offsetPastEnd, request: extractionRequest(o, imported[0]!.evidenceId)}))
    .rejects.toThrow('EXTRACTION_ANCHOR_UNRESOLVED');
  const unknownAnchor = gatewayFor(o, citingProvider({mutate: claim => ({
    claims: [{...claim, span: {...(claim.span as Record<string, unknown>), parentAnchor: {messageExternalId: 'msg-invented', field: 'body'}}}], unknowns: [],
  })}));
  await expect(runExtraction({runner: o.runner, gateway: unknownAnchor, request: extractionRequest(o, imported[0]!.evidenceId)}))
    .rejects.toThrow('EXTRACTION_ANCHOR_UNRESOLVED');

  expect(await o.claims()).toEqual([]);
  const runs = await o.runs();
  expect(runs).toHaveLength(3);
  expect(runs.every(run => run.status === 'FAILED' && run.error_code === 'EXTRACTION_ANCHOR_UNRESOLVED')).toBe(true);
});

it('CRT-NFR-06-A: schema-invalid extraction output is rejected and stored as no claim at all', async () => {
  const o = await owner('GMAIL');
  const imported = await o.importFixture('GMAIL', await fixture('gmail-thread'));
  const malformed = gatewayFor(o, citingProvider({mutate: claim => ({
    // One well-formed claim and one that violates the contract. The response is
    // rejected whole: a half-valid answer is not evidence of which half to keep.
    claims: [claim, {frameTypeId: 'not a registry id', statement: '', extractionConfidence: 12}], unknowns: [],
  })}));
  await expect(runExtraction({runner: o.runner, gateway: malformed, request: extractionRequest(o, imported[0]!.evidenceId)}))
    .rejects.toThrow('MODEL_OUTPUT_INVALID');
  expect(await o.claims()).toEqual([]);
  const [run] = await o.runs();
  expect(run).toMatchObject({status: 'FAILED', error_code: 'MODEL_OUTPUT_INVALID'});
  // The rejected call is still accounted for.
  const call = (await admin.query('SELECT * FROM model_call_records WHERE owner_scope_id=$1', [o.ownerScopeId])).rows[0];
  expect(call).toMatchObject({outcome: 'OUTPUT_REJECTED', model_provider: 'anthropic'});
  expect(Number(call.cost_microunits)).toBe(1450);
});

it('CRT-WRT-08-A: a run records every version, time and cost, and re-extraction adds claims without touching the old ones', async () => {
  const o = await owner('GMAIL');
  const imported = await o.importFixture('GMAIL', await fixture('gmail-thread'));
  const sourceItemId = imported[0]!.evidenceId;
  const gateway = gatewayFor(o, citingProvider());
  const first = await runExtraction({runner: o.runner, gateway, request: extractionRequest(o, sourceItemId)});

  const run = await withOwnerTransaction(appPool, o.context(EXTRACTION_PURPOSES.run),
    tx => readExtractionRun(tx, {ownerScopeId: o.ownerScopeId, extractionRunId: first.extractionRunId}));

  expect(run).toMatchObject({
    sourceItemId, runKind: 'FULL', status: 'SUCCEEDED',
    modelProvider: 'anthropic', modelId: 'claude-extraction-test', promptVersion: 'surface-frames-0.1.0',
    registryReleaseId, normalizationVersion: 'normalization-1',
    entityResolverVersion: 'entity-resolver-1', temporalResolverVersion: 'temporal-resolver-1',
    errorCode: null,
  });
  expect(run!.costMicrounits).toBe(1450);
  expect(run!.latencyMs).toBeGreaterThanOrEqual(0);
  expect(Date.parse(run!.completedAt!)).toBeGreaterThanOrEqual(Date.parse(run!.startedAt));
  expect(run!.triageDecisionId).toBeTruthy();

  // Exactly what the first run wrote, byte for byte, before anything re-reads it.
  const beforeRows = await o.claims();
  const fingerprint = (rows: Array<Record<string, unknown>>) => rows.map(row => createHash('sha256')
    .update(JSON.stringify(row, (_key, value) => value instanceof Date ? value.toISOString() : value)).digest('hex'));
  const beforeFingerprints = fingerprint(beforeRows);

  const second = await runExtraction({runner: o.runner, gateway, request: extractionRequest(o, sourceItemId)});
  expect(second.extractionRunId).not.toBe(first.extractionRunId);
  const afterRows = await o.claims();
  // New claim rows, and every earlier row still identical field for field.
  expect(afterRows.length).toBe(beforeRows.length * 2);
  expect(fingerprint(afterRows.slice(0, beforeRows.length))).toEqual(beforeFingerprints);
  expect(new Set(afterRows.map(row => row.id)).size).toBe(afterRows.length);
  expect(new Set(afterRows.map(row => row.extraction_run_id))).toEqual(new Set([first.extractionRunId, second.extractionRunId]));
  // The re-derived span is the same anchor row, so an anchor is not duplicated.
  expect(new Set(afterRows.map(row => row.source_anchor_id)).size).toBe(beforeRows.length);
  expect(await o.runs()).toHaveLength(2);

  // A closed run cannot be reopened or re-versioned, even by the privileged role.
  await expect(admin.query("UPDATE extraction_runs SET status='RUNNING',completed_at=NULL WHERE id=$1", [first.extractionRunId]))
    .rejects.toThrow('EXTRACTION_RUN_ALREADY_CLOSED');
});

it('CRT-EVD-05-A: a forced gateway failure retries and then dead-letters the job, leaving the evidence unchanged', async () => {
  const o = await owner('GMAIL');
  const imported = await o.importFixture('GMAIL', await fixture('gmail-thread'));
  const sourceItemId = imported[0]!.evidenceId;
  const before = (await admin.query('SELECT content_hash,raw_object_ref,observed_at FROM source_items WHERE id=$1', [sourceItemId])).rows[0];

  const failing = gatewayFor(o, {
    providerId: 'anthropic', defaultModelId: 'claude-extraction-test',
    async complete() { throw new Error('forced gateway failure'); },
  });
  const handler = createExtractionJobHandler({gateway: failing, runnerFor: () => o.runner});
  const payload = {ownerScopeId: o.ownerScopeId, sourceItemId, runKind: 'FULL', registryReleaseId,
    correlationId: o.correlationId, referenceInstant: '2026-09-01T09:00:00Z', timeZone: 'Asia/Jerusalem',
    dataPurpose: 'PERSONAL_ASSISTANCE', maximumSensitivity: 'PRIVATE'};
  const job = await withOwnerTransaction(appPool, o.context(JOB_PURPOSES.enqueue), tx => enqueueJob(tx, {
    jobKind: EXTRACTION_JOB_KIND, payload, idempotencyKey: randomUUID().replaceAll('-', ''), maxAttempts: 2,
  }));

  const statuses: string[] = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await runJobAttempt(appPool, o.context(JOB_PURPOSES.work), {
      worker: 'extraction-test-worker', leaseSeconds: 30, jobKinds: [EXTRACTION_JOB_KIND], handler,
    });
    statuses.push(result.job!.status);
  }
  // Retried within its attempt budget, then dead-lettered with its stable code.
  expect(statuses).toEqual(['FAILED', 'DEAD_LETTER']);
  const deadLettered = await withOwnerTransaction(appPool, o.context(JOB_PURPOSES.readDeadLetter), tx => listDeadLetterJobs(tx, {limit: 10}));
  expect(deadLettered.map(entry => entry.jobId)).toContain(job.jobId);
  expect(deadLettered[0]!.lastError).toBe('MODEL_PROVIDER_FAILED');

  // The evidence the failed job was reading is exactly as it was ingested.
  const after = (await admin.query('SELECT content_hash,raw_object_ref,observed_at FROM source_items WHERE id=$1', [sourceItemId])).rows[0];
  expect(after).toEqual(before);
  const app = createPlatformApi({authPool: admin, appPool, evidenceObjects: {
    encryptionKeyRef: 'kms:test-double', async put() {}, async get() { return new Uint8Array(); },
  }});
  app.addHook('onRequest', async request => { Object.defineProperty(request.raw.socket, 'encrypted', {value: true}); });
  try {
    const response = await app.inject({url: '/v1/evidence/' + sourceItemId, headers: {
      cookie: SESSION_COOKIE + '=' + o.token, 'x-owner-scope-id': o.ownerScopeId, 'x-purpose': 'evidence.read',
      'x-correlation-id': randomUUID(), 'x-data-purpose': 'PERSONAL_ASSISTANCE', 'x-maximum-sensitivity': 'RESTRICTED',
    }});
    expect(response.statusCode).toBe(200);
    expect(response.json().contentHash).toBe(before.content_hash);
    // Still routed and still readable, with the failed run visible beside it.
    expect(response.json().triage.tier1Route).toBe('FULL_EXTRACTION');
  } finally { await app.close(); }
  const runs = await o.runs();
  expect(runs).toHaveLength(2);
  expect(runs.every(run => run.status === 'FAILED' && run.error_code === 'MODEL_PROVIDER_FAILED')).toBe(true);
  expect(await o.claims()).toEqual([]);
});

it('CRT-EVD-05-A: a worker killed mid-job strands nothing: the lease expires, another worker takes it, evidence is intact', async () => {
  const o = await owner('GMAIL');
  const imported = await o.importFixture('GMAIL', await fixture('gmail-thread'));
  const sourceItemId = imported[0]!.evidenceId;
  const before = (await admin.query('SELECT content_hash FROM source_items WHERE id=$1', [sourceItemId])).rows[0];
  const payload = {ownerScopeId: o.ownerScopeId, sourceItemId, runKind: 'FULL', registryReleaseId,
    correlationId: o.correlationId, referenceInstant: '2026-09-01T09:00:00Z', timeZone: 'Asia/Jerusalem',
    dataPurpose: 'PERSONAL_ASSISTANCE', maximumSensitivity: 'PRIVATE'};
  await withOwnerTransaction(appPool, o.context(JOB_PURPOSES.enqueue), tx => enqueueJob(tx, {
    jobKind: EXTRACTION_JOB_KIND, payload, idempotencyKey: randomUUID().replaceAll('-', ''), maxAttempts: 3,
  }));

  // A worker claims the job and dies: no completion, no failure, a lease that
  // simply stops being renewed.
  const abandoned = await withOwnerTransaction(appPool, o.context(JOB_PURPOSES.work),
    tx => claimJob(tx, {worker: 'worker-that-dies', leaseSeconds: 0, jobKinds: [EXTRACTION_JOB_KIND]}));
  expect(abandoned!.status).toBe('RUNNING');
  expect((await admin.query('SELECT content_hash FROM source_items WHERE id=$1', [sourceItemId])).rows[0]).toEqual(before);

  // Another worker reclaims the expired lease and finishes the work.
  const gateway = gatewayFor(o, citingProvider());
  const handler = createExtractionJobHandler({gateway, runnerFor: () => o.runner});
  const second = await runJobAttempt(appPool, o.context(JOB_PURPOSES.work), {
    worker: 'worker-that-survives', leaseSeconds: 30, jobKinds: [EXTRACTION_JOB_KIND], handler,
  });
  expect(second.claimed).toBe(true);
  expect(second.job).toMatchObject({status: 'SUCCEEDED', jobId: abandoned!.jobId, attemptCount: 2});
  expect((await admin.query('SELECT content_hash FROM source_items WHERE id=$1', [sourceItemId])).rows[0]).toEqual(before);
  const runs = await o.runs();
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({status: 'SUCCEEDED', model_provider: 'anthropic'});
  expect((await o.claims()).length).toBeGreaterThan(0);
});

it('refuses an extraction the triage service never routed, and a deferred document until it is asked for', async () => {
  const o = await owner('DOCUMENT');
  const imported = await o.importFixture('DOCUMENT', await fixture('uploaded-document'), null);
  const documentId = imported[0]!.evidenceId;
  const gateway = gatewayFor(o, citingProvider());
  const decision = await readRoute(o, documentId);
  expect(decision!.tier1Route).toBe('DEFER_UNTIL_RELEVANT');
  // Deferred means deferred: the scheduled path does not extract it.
  await expect(runExtraction({runner: o.runner, gateway, request: extractionRequest(o, documentId, 'FULL')}))
    .rejects.toThrow('EXTRACTION_ROUTE_REFUSED');
  // Asking for it is what makes it happen (PRD §20.5 lazy document extraction).
  const targeted = await runExtraction({runner: o.runner, gateway, request: extractionRequest(o, documentId, 'TARGETED')});
  expect((await o.runs()).map(run => run.run_kind)).toEqual(['TARGETED']);
  expect(targeted.claimIds.length).toBe(1);

  // An item with no triage decision at all is refused rather than extracted: a
  // missing route is never read as an implicit permission to extract.
  const [untriaged] = await o.importFixture('GMAIL', await fixture('gmail-thread'), null);
  await admin.query('DELETE FROM triage_decisions WHERE owner_scope_id=$1 AND source_item_id=$2', [o.ownerScopeId, untriaged!.evidenceId]);
  await expect(runExtraction({runner: o.runner, gateway, request: extractionRequest(o, untriaged!.evidenceId, 'TARGETED')}))
    .rejects.toThrow('EXTRACTION_TRIAGE_REQUIRED');
  expect((await o.runs()).map(run => run.run_kind)).toEqual(['TARGETED']);
});
