import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { postgresAdapter, SESSION_COOKIE } from '@unai/auth';
import { runMigrations, withOwnerTransaction } from '@unai/postgres';
import { claimJob, retryDeadLetterJob } from '@unai/jobs';
import { connectorCredentialHandle } from '@unai/connectors';
import { TERMINAL_EXTRACTION_ERROR_CODES } from '@unai/extraction';
import { replayProjection, resolveOwnerEntity } from '@unai/capabilities';
import { recordClaim, recordResolutionAssertion, setResolutionLifecycle } from '@unai/memory';
import { createMountedSecretsProvider, createSecretsManager } from '@unai/secrets';
import type { ModelProvider } from '@unai/model';
import { lintRegistryCheckout, loadRegistryRelease, publishRegistryRelease } from '../../registry/src/index.js';
import { createPlatformApi } from './platform.js';
import { createConnectorRuntime } from './connectors.js';
import { createEvidenceObjects } from './evidence.js';
import { createProcessingRuntime, type ProcessingRuntimeOptions } from './processing-runtime.js';

if (!process.env.UNAI_TEST_DATABASE_URL) throw new Error('Run pnpm test for the required PostgreSQL harness');
const admin = new Pool({ connectionString: process.env.UNAI_TEST_DATABASE_URL });
const url = new URL(process.env.UNAI_TEST_DATABASE_URL);
url.username = 'processing_test_app'; url.password = 'test-only';
const appPool = new Pool({ connectionString: url.href });
let objects: Awaited<ReturnType<typeof createEvidenceObjects>>;
let registryReleaseId: string;
async function release() {
  for (let attempt = 0; attempt < 8; attempt++) {
    const existing = (await admin.query("SELECT id FROM registry_releases WHERE semantic_version='0.1.0'")).rows[0];
    if (existing) return existing.id as string;
    await sleep(250);
  }
  const repository = await mkdtemp(join(tmpdir(), 'unai-processing-registry-'));
  try {
    await cp(resolve('registry'), join(repository, 'registry'), { recursive: true });
    for (const args of [['init','--quiet'],['add','registry'],['commit','--quiet','-m','release'],['tag','registry-v0.1.0']]) {
      const command = spawnSync('git', ['-c','core.autocrlf=false','-c','user.name=Registry Test','-c','user.email=registry@test.invalid',...args], {
        cwd: repository, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: '2024-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2024-01-01T00:00:00Z' } });
      if (command.status !== 0) throw new Error('TEST_RELEASE_PREPARATION_FAILED');
    }
    const loaded = await loadRegistryRelease({ repository, version: '0.1.0' });
    try { return (await publishRegistryRelease(admin, loaded, randomUUID())).releaseId; }
    catch { return (await admin.query("SELECT id FROM registry_releases WHERE semantic_version='0.1.0'")).rows[0].id as string; }
  } finally { await rm(repository, { recursive: true, force: true }); }
}
beforeAll(async () => {
  await runMigrations(admin, resolve('migrations'));
  await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='processing_test_app') THEN CREATE ROLE processing_test_app LOGIN PASSWORD 'test-only'; END IF; END $$; GRANT unai_app TO processing_test_app");
  objects = await createEvidenceObjects({ endpoint: process.env.UNAI_TEST_S3_ENDPOINT!, region: 'us-east-1',
    bucket: process.env.UNAI_TEST_S3_BUCKET!, kmsKeyId: process.env.UNAI_TEST_S3_KMS_KEY_ID! });
  registryReleaseId = await release();
});
afterAll(async () => { objects?.close(); await appPool.end(); await admin.end(); });

async function owner(clock?: () => Date, connectors?: ReturnType<typeof createConnectorRuntime>) {
  const adapter = postgresAdapter(admin);
  const user = await adapter.createUser!({ name: 'Processing journey', email: 'processing-' + randomUUID() + '@example.test', emailVerified: null });
  const ownerScopeId = (user as unknown as { ownerScopeId: string }).ownerScopeId;
  const token = randomBytes(32).toString('base64url');
  await adapter.createSession!({ userId: user.id, sessionToken: token, expires: new Date(Date.now() + 86400000) });
  const app = createPlatformApi({ appPool, authPool: admin, evidenceObjects: objects, registryReleaseId, registryRelease: '0.1.0', ...(clock ? { clock } : {}), ...(connectors ? { connectors } : {}) });
  app.addHook('onRequest', async request => { Object.defineProperty(request.raw.socket, 'encrypted', { value: true, configurable: true }); });
  function headers(purpose: string, key = randomUUID()) { return { cookie: SESSION_COOKIE + '=' + token,
    'x-owner-scope-id': ownerScopeId, 'x-purpose': purpose, 'x-correlation-id': randomUUID(), 'idempotency-key': key,
    'x-data-purpose': 'PERSONAL_ASSISTANCE', 'x-maximum-sensitivity': 'PRIVATE' }; }
  async function ingest(text: string, occurredAt: string | null = '2025-01-06T09:00:00Z', sourceType = 'CONVERSATION', timeZone = 'Asia/Jerusalem') {
    const key = randomUUID();
    const response = await app.inject({ method: 'POST', url: '/v1/evidence', headers: headers('evidence.ingest', key), payload: {
      ownerScopeId, sourceType, externalId: key, actorRef: { type: 'USER', id: user.id },
      occurredAt, content: { body: text }, deterministicMetadata: { timeZone },
      sensitivity: 'PRIVATE', allowedPurposes: ['PERSONAL_ASSISTANCE'], idempotencyKey: key,
    } });
    expect(response.statusCode, response.body).toBe(200);
    return response.json().evidenceId as string;
  }
  const model = { calls: 0, failing: false, frameType: 'shared.commitment', cost: 1, output: null as string | null };
  const provider: ModelProvider = { providerId: 'recorded-test', defaultModelId: 'source-span-test', async complete(request) {
    model.calls++;
    if (model.failing) throw new Error('MODEL_PROVIDER_UNAVAILABLE');
    if (model.output !== null) return { modelId: 'source-span-test', costMicrounits: model.cost, outputText: model.output };
    const input = JSON.parse(request.input) as { anchors: { anchorKind: string; parentAnchor: Record<string, unknown>; text: string }[] };
    const anchor = input.anchors[0]!;
    return { modelId: 'source-span-test', costMicrounits: model.cost, outputText: JSON.stringify({ claims: [{
      frameTypeId: model.frameType, statement: anchor.text, span: { anchorKind: anchor.anchorKind,
        parentAnchor: anchor.parentAnchor, start: 0, end: anchor.text.length, quote: anchor.text },
      extractionConfidence: 0.95, temporalExpression: /tomorrow/.test(anchor.text) ? 'tomorrow' : null, participants: [],
    }], unknowns: [] }) };
  } };
  function runtime(extra: Partial<ProcessingRuntimeOptions> = {}) { return createProcessingRuntime({ appPool, ownerScopeId,
    actorId: user.id, registryReleaseId, provider, dataPurpose: 'PERSONAL_ASSISTANCE', maximumSensitivity: 'PRIVATE', workerId: 'processing-test', ...extra }); }
  async function state(id: string) { return (await admin.query('SELECT * FROM evidence_processing WHERE source_item_id=$1', [id])).rows[0]; }
  function context(purpose: string) { return { ownerScopeId, actorId: user.id, correlationId: randomUUID(), purpose }; }
  async function ask() { const response = await app.inject({ method: 'POST', url: '/v1/ask', headers: headers('memory.read'), payload: {
    ownerScopeId, question: 'What did I promise to send?', purpose: 'PERSONAL_ASSISTANCE', worldTime: 'NOW', knowledgeTime: 'LATEST',
    maximumSensitivity: 'PRIVATE', frameTypeHints: ['shared.commitment'],
  } }); expect(response.statusCode, response.body).toBe(200); return response.json(); }
  return { app, ownerScopeId, user, headers, ingest, model, runtime, state, context, ask };
}

it('persists owner-local initiative settings and resumes one durable evaluation after restart', async () => {
  let now = new Date('2026-09-19T05:59:00Z');
  const o = await owner(() => now);
  try {
    const response = await o.app.inject({ method: 'PATCH', url: '/v1/settings/initiative', headers: o.headers('settings.attention'), payload: {
      enabled: true, timeZone: 'Asia/Jerusalem', localTime: '09:00', dataPurpose: 'PERSONAL_ASSISTANCE', maximumSensitivity: 'PRIVATE', prepareDrafts: false,
    } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().settings.nextDueAt).toBe('2026-09-19T06:00:00.000Z');
    const path = './initiative-runtime.js';
    const { createInitiativeRuntime } = await import(path);
    const runtime = () => createInitiativeRuntime({ appPool, ownerScopeId: o.ownerScopeId, actorId: o.user.id,
      registryReleaseId, registryRelease: '0.1.0', workerId: 'initiative-test', clock: () => now });
    expect((await runtime().runOnce()).claimed).toBe(false);
    now = new Date('2026-09-19T06:00:00Z');
    expect(await runtime().dispatch()).toBe(1);
    expect((await runtime().runOnce()).job.status).toBe('SUCCEEDED');
    expect((await runtime().runOnce()).claimed).toBe(false);
    const jobs = (await admin.query("SELECT job_kind,status FROM jobs WHERE owner_scope_id=$1 AND job_kind='initiative.evaluate'", [o.ownerScopeId])).rows;
    expect(jobs).toEqual([{ job_kind: 'initiative.evaluate', status: 'SUCCEEDED' }]);
    const settings = await o.app.inject({ method: 'GET', url: '/v1/settings/initiative', headers: o.headers('settings.attention') });
    expect(settings.json().settings.nextDueAt).toBe('2026-09-20T06:00:00.000Z');
  } finally { await o.app.close(); }
});

it('refuses malformed initiative zones and external execution permissions', async () => {
  const o = await owner();
  try {
    const invalid = await o.app.inject({ method: 'PATCH', url: '/v1/settings/initiative', headers: o.headers('settings.attention'), payload: {
      enabled: true, timeZone: 'not/a-zone', localTime: '09:00', dataPurpose: 'PERSONAL_ASSISTANCE', maximumSensitivity: 'PRIVATE', prepareDrafts: false,
    } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().code).toBe('INITIATIVE_REQUEST_INVALID');
    const execution = await o.app.inject({ method: 'PATCH', url: '/v1/settings/initiative', headers: o.headers('settings.attention'), payload: {
      enabled: true, timeZone: 'UTC', localTime: '09:00', dataPurpose: 'PERSONAL_ASSISTANCE', maximumSensitivity: 'PRIVATE', prepareDrafts: true, sendAutomatically: true,
    } });
    expect(execution.statusCode).toBe(400);
  } finally { await o.app.close(); }
});

it('surfaces an explicit unfinished prerequisite once and withholds its private watch from a lower ceiling', async () => {
  let now = new Date(Date.now()+60000);
  const o = await owner(() => now);
  try {
    await o.ingest('I will attend the launch meeting by tomorrow.', '2026-09-19T05:00:00Z');
    await o.runtime().runOnce();
    await o.ingest('I will obtain the launch document.', '2026-09-19T05:00:00Z');
    await o.runtime().runOnce();
    const frames = (await admin.query(`SELECT b.frame_instance_id,p.normalized_value FROM belief_slots b JOIN propositions p
      ON p.belief_slot_id=b.id WHERE b.owner_scope_id=$1 AND b.predicate_id='shared.commitment.action_description'`, [o.ownerScopeId])).rows;
    const scheduledFrameId = frames.find(row => JSON.stringify(row.normalized_value).includes('attend'))!.frame_instance_id;
    const prerequisiteFrameId = frames.find(row => JSON.stringify(row.normalized_value).includes('obtain'))!.frame_instance_id;
    const watch = await o.app.inject({ method: 'POST', url: '/v1/initiative/watches', headers: o.headers('memory.correct'), payload: {
      scheduledFrameId, prerequisiteFrameId, requestText: 'Please share the launch document before the meeting.',
    } });
    expect(watch.statusCode,watch.body).toBe(201);
    expect(watch.json().watch).toMatchObject({ scheduledFrameId, prerequisiteFrameId, enabled: true });
    const lower = await o.app.inject({ method: 'GET', url: '/v1/initiative/watches', headers: { ...o.headers('memory.read'), 'x-maximum-sensitivity': 'NORMAL' } });
    expect(lower.statusCode).toBe(200); expect(lower.json().watches).toEqual([]);
    const settings = await o.app.inject({ method: 'PATCH', url: '/v1/settings/initiative', headers: o.headers('settings.attention'), payload: {
      enabled: true, timeZone: 'Asia/Jerusalem', localTime: '09:00', dataPurpose: 'PERSONAL_ASSISTANCE', maximumSensitivity: 'PRIVATE', prepareDrafts: true,
    } });
    expect(settings.statusCode,settings.body).toBe(200);
    const path = './initiative-runtime.js';
    const { createInitiativeRuntime } = await import(path);
    const runtime = () => createInitiativeRuntime({ appPool, ownerScopeId: o.ownerScopeId, actorId: o.user.id,
      registryReleaseId, registryRelease: '0.1.0', workerId: 'watch-test', clock: () => now });
    now = new Date(settings.json().settings.nextDueAt);
    expect((await runtime().runOnce()).job.status).toBe('SUCCEEDED');
    const notices = await o.app.inject({ method: 'GET', url: '/v1/initiative/notices', headers: o.headers('memory.read') });
    expect(notices.statusCode,notices.body).toBe(200);
    expect(notices.json().notices).toHaveLength(1);
    expect(notices.json().notices[0].noticeId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(notices.json().notices[0]).toMatchObject({ watchId: watch.json().watch.watchId, draftId: null, preparation: 'CAPABILITY_NOT_GRANTED' });
    expect((await runtime().runOnce()).claimed).toBe(false);
    expect((await admin.query('SELECT count(*)::int AS n FROM drafts WHERE owner_scope_id=$1', [o.ownerScopeId])).rows[0].n).toBe(0);
    const hidden = await o.app.inject({ method: 'GET', url: '/v1/initiative/notices', headers: { ...o.headers('memory.read'), 'x-maximum-sensitivity': 'NORMAL' } });
    expect(hidden.statusCode,hidden.body).toBe(403);
    expect(hidden.json().code).toBe('CONTEXT_READ_DENIED');
    expect(hidden.body).not.toContain(watch.json().watch.watchId);
  } finally { await o.app.close(); }
},15000);

it('persists a recoverable processing intent with acknowledged evidence before a worker exists', async () => {
  const o = await owner();
  try {
    const id = await o.ingest('I will send the launch report by tomorrow.');
    expect((await admin.query('SELECT ingestion_version FROM source_items WHERE id=$1', [id])).rows[0].ingestion_version).toBe('evidence-json-v1');
    expect((await admin.query('SELECT tier1_route FROM triage_decisions WHERE source_item_id=$1', [id])).rows[0].tier1_route).toBe('FULL_EXTRACTION');
    const exists = (await admin.query("SELECT to_regclass('public.evidence_processing') AS relation")).rows[0].relation;
    expect(exists, 'Acknowledged eligible evidence needs an atomic durable processing intent').toBe('evidence_processing');
    const row = (await admin.query('SELECT status,source_item_id,reference_instant,time_zone FROM evidence_processing WHERE source_item_id=$1', [id])).rows[0];
    expect(row).toMatchObject({ status: 'PENDING', source_item_id: id, time_zone: 'Asia/Jerusalem' });
    expect(row.reference_instant.toISOString()).toBe('2025-01-06T09:00:00.000Z');
    const read = await o.app.inject({ method: 'GET', url: '/v1/evidence/' + id, headers: o.headers('evidence.read') });
    expect(read.statusCode).toBe(200);
    expect(read.json().processing).toMatchObject({ status: 'PENDING', unresolvedClaims: 0, lastError: null });
  } finally { await o.app.close(); }
});

it('processes imported email through the real queue, governor and projection into source-linked Ask', async () => {
  const o = await owner();
  try {
    const id = await o.ingest('I will send the launch report by tomorrow.', '2025-01-06T09:00:00Z', 'GMAIL');
    const before = await o.ask();
    expect(JSON.stringify(before.statements)).not.toContain('send the launch report');
    const attempted = await o.runtime().runOnce();
    expect(attempted.job?.status).toBe('SUCCEEDED');
    expect((await o.state(id)).status).toBe('SUCCEEDED');
    const facts = (await admin.query(`SELECT p.id,p.normalized_value,b.predicate_id,c.valid_from,c.claim_origin,a.assessment_status
      FROM propositions p JOIN belief_slots b ON b.id=p.belief_slot_id
      JOIN claims c ON c.proposition_id=p.id JOIN belief_assessments a ON a.proposition_id=p.id WHERE p.owner_scope_id=$1`, [o.ownerScopeId])).rows;
    expect(facts).toHaveLength(2);
    expect(facts.every(row => row.assessment_status === 'PROVISIONAL' && row.claim_origin === 'MODEL_EXTRACTION')).toBe(true);
    expect(facts.every(row => row.valid_from.toISOString() === '2025-01-06T09:00:00.000Z')).toBe(true);
    const due = facts.find(row => row.predicate_id.endsWith('due_time'))!;
    expect(due.normalized_value).toMatchObject({ precision: 'DAY', timeZone: 'Asia/Jerusalem',
      start: '2025-01-06T22:00:00.000Z', end: '2025-01-07T22:00:00.000Z' });
    const projected=(await admin.query('SELECT due_time FROM open_commitments_projection WHERE owner_scope_id=$1', [o.ownerScopeId])).rows;
    expect(projected).toHaveLength(1);
    expect(projected[0].due_time.toISOString()).toBe('2025-01-06T22:00:00.000Z');
    const answer = await o.ask();
    expect(JSON.stringify(answer.statements)).toContain('send the launch report');
    expect(JSON.stringify(answer)).toContain(id);
    const description = facts.find(row => row.predicate_id.endsWith('action_description'))!;
    const corrected = await o.app.inject({ method: 'POST', url: '/v1/memory/corrections', headers: o.headers('memory.correct'), payload: {
      target: { objectType: 'proposition', objectId: description.id }, correctedValue: { text: 'send the launch checklist' },
      rawText: 'I meant the launch checklist.',
    } });
    expect(corrected.statusCode, corrected.body).toBe(201);
    expect(JSON.stringify((await o.ask()).statements)).toContain('launch checklist');
  } finally { await o.app.close(); }
});

it.each(['EXTRACTED','CANONICALIZED','GOVERNED','PROJECTED'] as const)('resumes a lost %s checkpoint without duplicate claims or model calls', async stage => {
  const o = await owner();
  try {
    const id = await o.ingest('I will send the checkpoint report by tomorrow.');
    let interrupted = false;
    const runtime = o.runtime({ onCheckpoint: async checkpoint => { if (!interrupted && checkpoint === stage) { interrupted = true; throw new Error('SIMULATED_WORKER_STOP'); } } });
    expect((await runtime.runOnce()).job?.status).toBe('FAILED');
    expect(interrupted).toBe(true);
    expect((await o.runtime().runOnce()).job?.status).toBe('SUCCEEDED');
    expect(await o.state(id)).toMatchObject({status:'SUCCEEDED',last_error:null});
    expect(o.model.calls).toBe(1);
    expect((await admin.query('SELECT count(*)::int AS n FROM claims WHERE owner_scope_id=$1', [o.ownerScopeId])).rows[0].n).toBe(3);
    expect((await admin.query("SELECT count(*)::int AS n FROM belief_transactions WHERE owner_scope_id=$1 AND status='COMMITTED'", [o.ownerScopeId])).rows[0].n).toBe(1);
    expect((await admin.query('SELECT count(*)::int AS n FROM projection_rebuild_receipts WHERE owner_scope_id=$1', [o.ownerScopeId])).rows[0].n).toBe(3);
  } finally { await o.app.close(); }
});

it('keeps unsupported semantics and undated relative deadlines explicitly incomplete', async () => {
  const o = await owner();
  try {
    const id = await o.ingest('I will send the undated report by tomorrow.', null);
    expect((await o.runtime().runOnce()).job?.status).toBe('SUCCEEDED');
    expect(await o.state(id)).toMatchObject({ status: 'NEEDS_REVIEW', unresolved_claims: 1, reference_instant: null });
    expect((await admin.query("SELECT count(*)::int AS n FROM belief_slots WHERE owner_scope_id=$1 AND predicate_id='shared.commitment.due_time'", [o.ownerScopeId])).rows[0].n).toBe(0);
    o.model.frameType = 'shared.obligation';
    const unsupported = await o.ingest('I will pay USD 200.');
    await o.runtime().runOnce();
    expect(await o.state(unsupported)).toMatchObject({ status: 'NEEDS_REVIEW', unresolved_claims: 1 });
  } finally { await o.app.close(); }
});

it.each(['Invalid/Timezone','x'.repeat(65)])('keeps evidence durable and its relative deadline unknown for invalid source timezone %s',async zone=>{
  const o=await owner();
  try {
    const id=await o.ingest('I will send the timezone report by tomorrow.','2025-01-06T09:00:00Z','CONVERSATION',zone);
    expect((await o.runtime().runOnce()).job?.status).toBe('SUCCEEDED');
    expect(await o.state(id)).toMatchObject({status:'NEEDS_REVIEW',unresolved_claims:1});
    expect((await admin.query("SELECT count(*)::int AS n FROM belief_slots WHERE owner_scope_id=$1 AND predicate_id='shared.commitment.due_time'",[o.ownerScopeId])).rows[0].n).toBe(0);
    const source=await o.app.inject({method:'GET',url:'/v1/evidence/'+id,headers:o.headers('evidence.read')});
    expect(source.statusCode).toBe(200);expect(source.json().deterministicMetadata.timeZone).toBe(zone);
  }finally{await o.app.close();}
});

it('leaves source-only and index-only evidence readable without calling the model',async()=>{
  const o=await owner();
  try {
    for(const [body,route] of [['','SOURCE_ONLY'],['Thanks for the note.','INDEX_ONLY']] as const) {
      const id=await o.ingest(body);
      const response=await o.app.inject({method:'GET',url:'/v1/evidence/'+id,headers:o.headers('evidence.read')});
      expect(response.statusCode).toBe(200);expect(response.json().triage.tier1Route).toBe(route);expect(response.json().processing).toBeNull();
    }
    expect((await o.runtime().runOnce()).claimed).toBe(false);expect(o.model.calls).toBe(0);
  }finally{await o.app.close();}
});

it.each([
  { code: 'EXTRACTION_INPUT_TOO_LARGE', body: 'I will send the oversized report. ' + 'x'.repeat(40000), cost: 1, calls: 0 },
  { code: 'MODEL_COST_BUDGET_EXCEEDED', body: 'I will send the costly report.', cost: 1_000_000, calls: 1 },
])('dead-letters deterministic extraction refusal $code on its first attempt', async ({ code, body, cost, calls }) => {
  const o = await owner();
  try {
    const id = await o.ingest(body);
    o.model.cost = cost;
    const runtime = o.runtime();
    expect((await runtime.runOnce()).job).toMatchObject({ status: 'DEAD_LETTER', lastError: code, attemptCount: 1, maxAttempts: 1 });
    expect((await runtime.runOnce()).claimed).toBe(false);
    expect(o.model.calls).toBe(calls);
    expect((await admin.query('SELECT count(*)::int AS n FROM model_call_records WHERE owner_scope_id=$1', [o.ownerScopeId])).rows[0].n).toBe(calls);
    expect(await o.state(id)).toMatchObject({ status: 'PENDING', last_error: code });
  } finally { await o.app.close(); }
});

it.each(['MODEL_OUTPUT_INVALID', 'MODEL_PROVIDER_FAILED'])('keeps %s retryable through the configured attempt budget', async code => {
  const o = await owner();
  try {
    await o.ingest('I will send the retryable report.');
    if (code === 'MODEL_OUTPUT_INVALID') o.model.output = 'not json';
    else o.model.failing = true;
    const runtime = o.runtime();
    for (const attemptCount of [1, 2, 3]) {
      expect((await runtime.runOnce()).job).toMatchObject({ status: attemptCount === 3 ? 'DEAD_LETTER' : 'FAILED',
        lastError: code, attemptCount, maxAttempts: 3 });
    }
    expect(o.model.calls).toBe(3);
  } finally { await o.app.close(); }
});

it('pins the immutable deterministic extraction refusal allowlist', () => {
  expect([...TERMINAL_EXTRACTION_ERROR_CODES].sort()).toEqual([
    'EXTRACTION_INPUT_TOO_LARGE', 'EXTRACTION_ROUTE_REFUSED', 'MODEL_COST_BUDGET_EXCEEDED',
  ]);
  expect(Object.isFrozen(TERMINAL_EXTRACTION_ERROR_CODES)).toBe(true);
  for (const code of ['MODEL_OUTPUT_INVALID', 'MODEL_PROVIDER_FAILED', 'EXTRACTION_TRIAGE_REQUIRED']) {
    expect(TERMINAL_EXTRACTION_ERROR_CODES).not.toContain(code);
  }
});

it('retains raw evidence across model dead letters and supports explicit manual retry', async () => {
  const o = await owner();
  try {
    const id = await o.ingest('I will send the retry report.');
    o.model.failing = true;
    const runtime = o.runtime();
    expect((await runtime.runOnce()).job?.status).toBe('FAILED');
    expect((await runtime.runOnce()).job?.status).toBe('FAILED');
    const failed = (await runtime.runOnce()).job!;
    expect(failed.status).toBe('DEAD_LETTER');
    const evidence = await o.app.inject({ method: 'GET', url: '/v1/evidence/' + id, headers: o.headers('evidence.read') });
    expect(evidence.statusCode).toBe(200);
    expect(evidence.json().anchors[0].normalizedText).toBe('I will send the retry report.');
    o.model.failing = false;
    await withOwnerTransaction(appPool, o.context('ops.dead_letter.retry'), tx => retryDeadLetterJob(tx, failed.jobId));
    expect((await runtime.runOnce()).job?.status).toBe('SUCCEEDED');
    expect((await o.state(id)).status).toBe('SUCCEEDED');
  } finally { await o.app.close(); }
});

it('reclaims an expired lease and rechecks a narrower source ceiling before calling the model', async () => {
  const o = await owner();
  try {
    const id = await o.ingest('I will send the private report.');
    await o.runtime().dispatch();
    await withOwnerTransaction(appPool, o.context('jobs.work'), tx => claimJob(tx, { worker: 'stopped-worker', leaseSeconds: 0, jobKinds: ['evidence.extract'] }));
    const refused = await o.runtime({ maximumSensitivity: 'NORMAL' }).runOnce();
    expect(refused.job).toMatchObject({ status: 'FAILED', lastError: 'PROCESSING_SOURCE_UNAVAILABLE', attemptCount: 2 });
    expect(o.model.calls).toBe(0);
    expect((await o.runtime().runOnce()).job?.status).toBe('SUCCEEDED');
    expect((await o.state(id)).status).toBe('SUCCEEDED');
  } finally { await o.app.close(); }
});

it('keeps unknown document assertion time unknown when queueing extraction', async () => {
  const o = await owner();
  try {
    const response = await o.app.inject({ method: 'POST', url: '/v1/documents', headers: o.headers('evidence.ingest'), payload: {
      documentId: randomUUID(), mediaType: 'text/plain', pages: [{ page: 1, text: 'I will send the launch report by tomorrow.' }],
      requestFullExtraction: true, sensitivity: 'PRIVATE', allowedPurposes: ['PERSONAL_ASSISTANCE'],
    } });
    expect(response.statusCode, response.body).toBe(201);
    const job = (await admin.query('SELECT payload FROM jobs WHERE id=$1', [response.json().extractionJobId])).rows[0];
    expect(job.payload.referenceInstant, 'Upload time does not confirm when the document was written').toBeNull();
    expect(job.payload.timeZone, 'UTC is not evidence of the author timezone').toBeNull();
    expect((await o.runtime().runOnce()).job?.status).toBe('SUCCEEDED');
    expect(await o.state(response.json().evidenceId)).toMatchObject({status:'NEEDS_REVIEW',unresolved_claims:1,reference_instant:null,time_zone:null});
    expect((await admin.query('SELECT count(*)::int AS n FROM propositions WHERE owner_scope_id=$1',[o.ownerScopeId])).rows[0].n).toBe(0);
  } finally { await o.app.close(); }
});

async function watchedOwner(accepted=false) {
  let now=new Date(Date.now()+60000);
  const o=await owner(()=>now);
  await o.ingest('I will attend the overdue planning meeting by tomorrow.');await o.runtime().runOnce();
  await o.ingest('I will obtain the overdue prerequisite document.');await o.runtime().runOnce();
  const facts=(await admin.query(`SELECT p.id,p.normalized_value,b.frame_instance_id,c.source_anchor_id,a.source_item_id FROM propositions p
    JOIN belief_slots b ON b.id=p.belief_slot_id JOIN claims c ON c.proposition_id=p.id JOIN source_anchors a ON a.id=c.source_anchor_id
    WHERE p.owner_scope_id=$1 AND c.claim_origin='MODEL_EXTRACTION'`,[o.ownerScopeId])).rows;
  if(accepted) {
    for(const fact of facts) {
      const key=randomUUID();
      const proposed=await o.app.inject({method:'POST',url:'/v1/memory/transactions/propose',headers:o.headers('memory.govern',key),payload:{
        transactionKind:'CONFIRM',registryReleaseId,risk:'LOW',sourceEvidenceIds:[fact.source_item_id],operations:[
          // The owner explicitly confirms the exact already-ingested source via
          // the governor API; the original model claim and source time remain.
          {kind:'ADD_CLAIM',operationRef:'#owner-confirmation',sourceAnchorId:fact.source_anchor_id,proposition:fact.id,
            claimOrigin:'USER_CONFIRMATION',lifecycle:'PROVISIONAL',validFrom:'2025-01-06T09:00:00.000Z'},
          {kind:'ADD_SUPPORT',proposition:fact.id,claim:'#owner-confirmation',supportKind:'DIRECT_ASSERTION'},
          {kind:'SET_BELIEF_ASSESSMENT',proposition:fact.id,assessmentStatus:'ACCEPTED',validFrom:'2025-01-06T09:00:00.000Z'},
        ],
      }});expect(proposed.statusCode,proposed.body).toBe(201);
      const committed=await o.app.inject({method:'POST',url:'/v1/memory/transactions/'+proposed.json().transactionId+'/commit',headers:o.headers('memory.govern',key),payload:{}});
      expect(committed.statusCode,committed.body).toBe(200);
    }
    await withOwnerTransaction(appPool,o.context('memory.project'),tx=>replayProjection(tx,{ownerScopeId:o.ownerScopeId,projectionName:'open_commitments_projection',asOf:now}));
  }
  const scheduledFrameId=facts.find(row=>JSON.stringify(row.normalized_value).includes('attend'))!.frame_instance_id;
  const prerequisiteFrameId=facts.find(row=>JSON.stringify(row.normalized_value).includes('obtain'))!.frame_instance_id;
  const watch=await o.app.inject({method:'POST',url:'/v1/initiative/watches',headers:o.headers('memory.correct'),payload:{
    scheduledFrameId,prerequisiteFrameId,requestText:'Secret owner wording must remain only in its source, marker WATCH_PRIVATE_42.',
  }});expect(watch.statusCode,watch.body).toBe(201);
  const configured=await o.app.inject({method:'PATCH',url:'/v1/settings/initiative',headers:o.headers('settings.attention'),payload:{
    enabled:true,timeZone:'UTC',localTime:'00:00',dataPurpose:'PERSONAL_ASSISTANCE',maximumSensitivity:'PRIVATE',prepareDrafts:true,
  }});expect(configured.statusCode,configured.body).toBe(200);
  now=new Date(configured.json().settings.nextDueAt);
  const path='./initiative-runtime.js';const {createInitiativeRuntime}=await import(path);
  const runtime=()=>createInitiativeRuntime({appPool,ownerScopeId:o.ownerScopeId,actorId:o.user.id,registryReleaseId,registryRelease:'0.1.0',workerId:'initiative-lifecycle',clock:()=>now});
  const notices=async()=>{const result=await o.app.inject({method:'GET',url:'/v1/initiative/notices',headers:o.headers('memory.read')});expect(result.statusCode,result.body).toBe(200);return result.json().notices;};
  const grant=async(granted:boolean)=>{const result=await o.app.inject({method:'POST',url:'/v1/plugin-capabilities',headers:o.headers('permissions.manage'),payload:{capabilities:[{capabilityId:'gmail.create_draft',granted}]}});expect(result.statusCode,result.body).toBe(200);};
  return {...o,runtime,watch:watch.json().watch,notices,grant,facts,clock:()=>now,advanceDay(){now=new Date(now.getTime()+86400000);}};
}

it('reconsiders a budget-withheld prerequisite on a later day without repeating a shown notice',async()=>{
  const o=await watchedOwner();
  try {
    const budget=await o.app.inject({method:'PATCH',url:'/v1/settings/attention-budgets',headers:o.headers('settings.attention'),payload:{maxCardsPerDay:0}});
    expect(budget.statusCode,budget.body).toBe(200);
    expect((await o.runtime().runOnce()).job.status).toBe('SUCCEEDED');expect(await o.notices()).toEqual([]);
    expect((await admin.query('SELECT attention_reason FROM initiative_receipts WHERE owner_scope_id=$1',[o.ownerScopeId])).rows[0].attention_reason).toBe('DAILY_BUDGET_EXHAUSTED');
    await o.app.inject({method:'PATCH',url:'/v1/settings/attention-budgets',headers:o.headers('settings.attention'),payload:{maxCardsPerDay:5}});
    o.advanceDay();expect((await o.runtime().runOnce()).job.status).toBe('SUCCEEDED');expect(await o.notices()).toHaveLength(1);
    o.advanceDay();await o.runtime().runOnce();expect(await o.notices()).toHaveLength(1);
  }finally{await o.app.close();}
});

it('prepares one generic draft only after explicit owner confirmation and governed acceptance',async()=>{
  const o=await watchedOwner(true);
  try {
    await o.grant(true);
    expect((await o.runtime().runOnce()).job.status).toBe('SUCCEEDED');
    const notices=await o.notices();expect(notices).toHaveLength(1);expect(notices[0].preparation).toBe('DRAFTED');expect(notices[0].draftId).toBeTruthy();
    const drafts=await o.app.inject({method:'GET',url:'/v1/drafts',headers:o.headers('action.read')});
    expect(drafts.statusCode,drafts.body).toBe(200);expect(drafts.body).toContain('Please share the item needed for our upcoming commitment.');
    expect(drafts.body).not.toContain('WATCH_PRIVATE_42');
    o.advanceDay();await o.runtime().runOnce();
    expect((await admin.query('SELECT count(*)::int AS n FROM drafts WHERE owner_scope_id=$1',[o.ownerScopeId])).rows[0].n).toBe(1);
    expect((await admin.query("SELECT count(*)::int AS n FROM action_history WHERE owner_scope_id=$1 AND stage='EXECUTED'",[o.ownerScopeId])).rows[0].n).toBe(0);
  }finally{await o.app.close();}
});

it.each(['REVOKE_GRANT','DISABLE_WATCH','DELETE_SOURCE'] as const)('rechecks %s after an initiative job was queued',async(change)=>{
  const o=await watchedOwner(true);
  try {
    await o.grant(true);expect(await o.runtime().dispatch()).toBe(1);
    if(change==='REVOKE_GRANT')await o.grant(false);
    else if(change==='DISABLE_WATCH') {
      const result=await o.app.inject({method:'PATCH',url:'/v1/initiative/watches/'+o.watch.watchId,headers:o.headers('memory.correct'),payload:{enabled:false}});
      expect(result.statusCode,result.body).toBe(200);
    }else{
      const result=await o.app.inject({method:'POST',url:'/v1/data/deletions',headers:o.headers('data.delete'),payload:{evidenceIds:[o.watch.sourceEvidenceId],confirmation:'DELETE'}});
      expect(result.statusCode,result.body).toBe(200);
    }
    expect((await o.runtime().runOnce()).job.status).toBe('SUCCEEDED');
    expect((await admin.query('SELECT count(*)::int AS n FROM drafts WHERE owner_scope_id=$1',[o.ownerScopeId])).rows[0].n).toBe(0);
    if(change==='REVOKE_GRANT')expect((await o.notices())[0].preparation).toBe('CAPABILITY_NOT_GRANTED');else expect(await o.notices()).toEqual([]);
  }finally{await o.app.close();}
});

it('requires confirmation when a draft grant exists but the watched memories remain provisional',async()=>{
  const o=await watchedOwner();
  try {
    await o.grant(true);expect((await o.runtime().runOnce()).job.status).toBe('SUCCEEDED');
    const notices=await o.notices();expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({preparation:'CONFIRMATION_REQUIRED',draftId:null});
    expect((await admin.query('SELECT count(*)::int AS n FROM drafts WHERE owner_scope_id=$1',[o.ownerScopeId])).rows[0].n).toBe(0);
  }finally{await o.app.close();}
},15000);

it.each(['SNOOZE','DISABLE'] as const)('honors %s when reading an already displayed initiative notice',async(change)=>{
  const o=await watchedOwner();
  try {
    expect((await o.runtime().runOnce()).job.status).toBe('SUCCEEDED');expect(await o.notices()).toHaveLength(1);
    const updated=await o.app.inject({method:'PATCH',url:'/v1/initiative/watches/'+o.watch.watchId,headers:o.headers('memory.correct'),payload:
      change==='DISABLE'?{enabled:false}:{snoozedUntil:new Date(Date.now()+30*86400000).toISOString()}});
    expect(updated.statusCode,updated.body).toBe(200);expect(await o.notices()).toEqual([]);
  }finally{await o.app.close();}
},15000);

it('removes an unresolved notice when its prerequisite gains an accepted final outcome',async()=>{
  const o=await watchedOwner(true);
  try {
    expect((await o.runtime().runOnce()).job.status).toBe('SUCCEEDED');expect(await o.notices()).toHaveLength(1);
    const sourceId=await o.ingest('The prerequisite document is now fulfilled.',o.clock().toISOString());
    const anchor=(await admin.query('SELECT id FROM source_anchors WHERE source_item_id=$1',[sourceId])).rows[0].id;
    const txId=(await admin.query("SELECT id FROM belief_transactions WHERE owner_scope_id=$1 AND transaction_kind='CONFIRM' AND status='COMMITTED' LIMIT 1",[o.ownerScopeId])).rows[0].id;
    const transitions=(await lintRegistryCheckout({repository:resolve('.'),version:'0.1.0'})).transitions;
    const resolution=await withOwnerTransaction(appPool,o.context('memory.canonicalize'),async tx=>{
      const entity=await resolveOwnerEntity(tx,{ownerScopeId:o.ownerScopeId,actorId:o.user.id});
      const claim=await recordClaim(tx,{ownerScopeId:o.ownerScopeId,sourceAnchorId:anchor,claimOrigin:'USER_STATEMENT',lifecycle:'CANDIDATE',
        assertedByEntityId:entity,validFrom:o.clock()});
      return recordResolutionAssertion(tx,{ownerScopeId:o.ownerScopeId,sourceFrameInstanceId:o.watch.prerequisiteFrameId,
        sourceFrameTypeId:'shared.commitment',outcomeCode:'FULFILLED',effectiveAt:o.clock(),assertedByEntityId:entity,
        claimId:claim,transitionContractId:'shared.commitment.resolution',transitionContracts:transitions});
    });
    await withOwnerTransaction(appPool,o.context('memory.govern'),tx=>setResolutionLifecycle(tx,{ownerScopeId:o.ownerScopeId,
      resolutionAssertionId:resolution.resolutionAssertionId,lifecycle:'ACCEPTED',transactionId:txId}));
    expect(await o.notices()).toEqual([]);
  }finally{await o.app.close();}
},15000);

it('withholds an old overdue notice after an owner changes its scheduled deadline',async()=>{
  const o=await watchedOwner();
  try {
    expect((await o.runtime().runOnce()).job.status).toBe('SUCCEEDED');expect(await o.notices()).toHaveLength(1);
    const due=o.facts.find(row=>'start' in row.normalized_value)!;
    const corrected=await o.app.inject({method:'POST',url:'/v1/memory/corrections',headers:o.headers('memory.correct'),payload:{
      target:{objectType:'proposition',objectId:due.id},correctedValue:{time:new Date(o.clock().getTime()+14*86400000).toISOString(),precision:'EXACT_INSTANT',timeZone:'UTC'},
      rawText:'The scheduled item is now due two weeks from today.',
    }});expect(corrected.statusCode,corrected.body).toBe(201);
    expect(await o.notices()).toEqual([]);
  }finally{await o.app.close();}
},15000);

// ADR 0038 for connector syncs (task-b00c772f): the owner decided on 2026-11-06 to keep the ADR as
// written, so a synced item routed FULL or ENTITY gets its intent in the sync transaction (migration
// 0031's triage_processing_intent trigger) and the worker extracts it. The two cases below drive the
// web's exact Sync now request through the real connector runtime; only the provider endpoints
// (global fetch) and the model are doubles.
const GMAIL_SENTENCE = 'I will send the signed lease.';
const OMI_QUOTE = 'pay you the 450 euro deposit by Friday 14 November';
const OMI_LIST = 'https://api.omi.me/v1/dev/user/conversations';
const omiFixture = JSON.parse(await readFile(resolve('fixtures/sources/omi-conversation.json'), 'utf8')) as { id: string };
const EXTERNAL = { full: 'thread-full-m1', entity: 'thread-entity-m1', index: 'thread-index-m1', source: 'thread-source-m1',
  transcript: 'omi:conversation:' + omiFixture.id, summary: 'omi:conversation:' + omiFixture.id + ':structured' } as const;

function gmailThread(id: string, from: string, subject: string, body: string, labelIds = ['INBOX']) {
  return { id, historyId: '1', messages: [{ id: id + '-m1', threadId: id, internalDate: '1788166800000', labelIds,
    payload: { mimeType: 'text/plain', headers: [
      { name: 'Message-Id', value: '<' + id + '@example.test>' }, { name: 'From', value: from },
      { name: 'To', value: 'owner@example.test' }, { name: 'Subject', value: subject },
      { name: 'Date', value: 'Mon, 31 Aug 2026 09:00:00 +0000' }],
      body: { text: body } } }] };
}
const GMAIL_THREADS = [
  gmailThread('thread-full', 'Dana <dana@example.test>', 'The lease', GMAIL_SENTENCE),
  gmailThread('thread-entity', 'Lee <lee@example.test>', 'Hello', 'Thanks for the note.'),
  gmailThread('thread-index', 'newsletter@shop.example', 'Weekly digest', 'Fresh arrivals this week. Unsubscribe here.', ['INBOX', 'CATEGORY_PROMOTIONS']),
  gmailThread('thread-source', 'Lee <lee@example.test>', 'Re: The lease',
    'On Mon, 31 Aug 2026 at 09:00, Dana <dana@example.test> wrote:\n> ' + GMAIL_SENTENCE),
];

/** The three provider endpoints a Gmail and an Omi sync touch, and nothing else. Every token is
 * generated per run, and each endpoint refuses a request that does not carry the right one. */
function providerFetch(google: { accessToken: string; refreshToken: string; clientId: string; clientSecret: string }, omiKey: string): typeof fetch {
  return async (input, init) => {
    const target = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const bearer = new Headers(init?.headers).get('authorization');
    if (target.href === 'https://oauth2.googleapis.com/token') {
      const form = new URLSearchParams(String(init?.body));
      const expected = { grant_type: 'refresh_token', refresh_token: google.refreshToken,
        client_id: google.clientId, client_secret: google.clientSecret };
      const valid = init?.method === 'POST' && [...form].length === 4 && Object.entries(expected).every(([key, value]) => form.get(key) === value);
      return valid ? Response.json({ access_token: google.accessToken, expires_in: 3599, token_type: 'Bearer' })
        : Response.json({ error: 'invalid_request' }, { status: 400 });
    }
    if (target.origin === 'https://gmail.googleapis.com') {
      if (bearer !== 'Bearer ' + google.accessToken) return new Response('{}', { status: 401 });
      if (/^\/gmail\/v1\/users\/[^/]+\/threads$/.test(target.pathname)) return Response.json({ threads: GMAIL_THREADS.map(thread => ({ id: thread.id })) });
      const one = /^\/gmail\/v1\/users\/[^/]+\/threads\/([^/]+)$/.exec(target.pathname);
      const thread = one ? GMAIL_THREADS.find(candidate => candidate.id === decodeURIComponent(one[1]!)) : undefined;
      return thread ? Response.json(thread) : new Response('{}', { status: 404 });
    }
    if (target.origin + target.pathname === OMI_LIST) {
      if (bearer !== 'Bearer ' + omiKey) return new Response('{}', { status: 401 });
      return Response.json([omiFixture], { headers: { 'x-omi-has-more': 'false' } });
    }
    return new Response('{}', { status: 404 });
  };
}
/** A mounted secrets directory behind the real connector runtime. The runtime credential
 * google-connector-client sits at the mount root; `provision` writes an owner's Gmail and Omi
 * credentials to connectors/<ownerScopeId>/{gmail,omi}, the connector namespace (ADR 0013). */
async function syncedSources() {
  const dir = await mkdtemp(join(tmpdir(), 'unai-processing-sync-'));
  const google = { accessToken: 'ya29.' + randomBytes(24).toString('base64url'), refreshToken: '1//' + randomBytes(24).toString('base64url'),
    clientId: 'connector-client.apps.example.test', clientSecret: 'GOCSPX-' + randomBytes(18).toString('base64url') };
  const omiKey = 'omi_dev_' + randomBytes(24).toString('hex');
  try {
    await writeFile(join(dir, 'google-connector-client'), JSON.stringify({ client_id: google.clientId, client_secret: google.clientSecret }));
    const provision = async (ownerScopeId: string) => {
      await mkdir(join(dir, 'connectors', ownerScopeId), { recursive: true });
      await writeFile(join(dir, 'connectors', ownerScopeId, 'gmail'), JSON.stringify({ refresh_token: google.refreshToken }));
      await writeFile(join(dir, 'connectors', ownerScopeId, 'omi'), omiKey);
    };
    return { fetch: providerFetch(google, omiKey), close: () => rm(dir, { recursive: true, force: true }), provision,
      connectors: createConnectorRuntime(createSecretsManager({ mounted: createMountedSecretsProvider(dir) }),
        { UNAI_GOOGLE_CONNECTOR_CLIENT: 'secret://mounted/google-connector-client' }) };
  } catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
}

type SyncedOwner = Awaited<ReturnType<typeof owner>>;
/** Connect a source and press Sync now exactly as the web does: the proxy pins the PERSONAL_ASSISTANCE
 * data purpose and the RESTRICTED ceiling (apps/web/pages/api/platform/[...path].ts), the component
 * sends {mode, allowedPurposes} (apps/web/components/Connectors.tsx). The fetch double is installed
 * only around the sync request. */
async function syncNow(o: SyncedOwner, provider: typeof fetch, connectorType: 'GMAIL' | 'OMI', itemsIngested: number) {
  const gmail = connectorType === 'GMAIL';
  const created = await o.app.inject({ method: 'POST', url: '/v1/connectors', headers: o.headers('connector.manage'), payload: {
    connectorType, externalAccountRef: 'owner@example.test', secretRef: connectorCredentialHandle(o.ownerScopeId, gmail ? 'gmail' : 'omi', gmail ? { field: 'refresh_token' } : {}),
    requestedCapabilities: (gmail ? ['gmail.read_metadata', 'gmail.read_content'] : ['omi.read_conversations']).map(capabilityId => ({ capabilityId, granted: true })) } });
  expect(created.statusCode, created.body).toBe(201);
  const original = globalThis.fetch;
  globalThis.fetch = provider;
  try {
    const synced = await o.app.inject({ method: 'POST', url: '/v1/connectors/' + created.json().connectorId + '/sync',
      headers: { ...o.headers('connector.sync'), 'x-maximum-sensitivity': 'RESTRICTED' },
      payload: { mode: 'INCREMENTAL', allowedPurposes: ['PERSONAL_ASSISTANCE'] } });
    expect(synced.statusCode, synced.body).toBe(200);
    expect(synced.json()).toMatchObject({ itemsIngested, storedSensitivity: 'PRIVATE' });
  } finally { globalThis.fetch = original; }
}
/** A fresh owner who has synced the four Gmail threads and the one Omi conversation. */
async function withSyncedOwner<T>(run: (o: SyncedOwner) => Promise<T>): Promise<T> {
  const sources = await syncedSources();
  try {
    const o = await owner(undefined, sources.connectors);
    try {
      await sources.provision(o.ownerScopeId);
      await syncNow(o, sources.fetch, 'GMAIL', GMAIL_THREADS.length);
      await syncNow(o, sources.fetch, 'OMI', 2);
      return await run(o);
    } finally { await o.app.close(); }
  } finally { await sources.close(); }
}
async function items(ownerScopeId: string) {
  const rows = (await admin.query(`SELECT s.id,s.external_id,t.tier1_route AS route,t.routing_reason->>'code' AS code
    FROM source_items s JOIN triage_decisions t ON t.owner_scope_id=s.owner_scope_id AND t.source_item_id=s.id
    WHERE s.owner_scope_id=$1`, [ownerScopeId])).rows as { id: string; external_id: string; route: string; code: string }[];
  return { rows, of: (name: keyof typeof EXTERNAL) => rows.find(row => row.external_id === EXTERNAL[name])! };
}
const intents = async (ownerScopeId: string) =>
  (await admin.query('SELECT * FROM evidence_processing WHERE owner_scope_id=$1 ORDER BY source_item_id', [ownerScopeId])).rows;

/** A model double that quotes one fixed sentence from whichever anchor holds it, and answers no claim
 * for any other item. The default double cites anchors[0], and anchors come back in random id order. */
function citing() {
  const requests: { sourceType: string; input: string }[] = [];
  const provider: ModelProvider = { providerId: 'recorded-test', defaultModelId: 'source-span-test', async complete(request) {
    const input = JSON.parse(request.input) as { sourceType: string; anchors: { anchorKind: string; parentAnchor: Record<string, unknown>; text: string }[] };
    requests.push({ sourceType: input.sourceType, input: request.input });
    for (const sentence of [GMAIL_SENTENCE, OMI_QUOTE]) {
      const anchor = input.anchors.find(candidate => candidate.text.includes(sentence));
      if (!anchor) continue;
      const start = anchor.text.indexOf(sentence);
      return { modelId: 'source-span-test', costMicrounits: 1, outputText: JSON.stringify({ claims: [{
        frameTypeId: 'shared.commitment', statement: sentence, span: { anchorKind: anchor.anchorKind,
          parentAnchor: anchor.parentAnchor, start, end: start + sentence.length, quote: sentence },
        extractionConfidence: 0.95, temporalExpression: null, participants: [] }], unknowns: [] }) };
    }
    return { modelId: 'source-span-test', costMicrounits: 1, outputText: JSON.stringify({ claims: [], unknowns: [] }) };
  } };
  return { provider, requests };
}

it('ADR 0038 for connector syncs: Sync now records a PENDING intent in the sync transaction for every FULL or ENTITY item and none for SOURCE_ONLY or INDEX_ONLY items', () => withSyncedOwner(async o => {
  const synced = await items(o.ownerScopeId);
  // The fixtures route as intended, so a drifting router fails here and not as a vacuous pass below.
  expect(Object.fromEntries(synced.rows.map(row => [row.external_id, row.route]))).toEqual({
    [EXTERNAL.full]: 'FULL_EXTRACTION', [EXTERNAL.entity]: 'ENTITY_EXTRACTION', [EXTERNAL.index]: 'INDEX_ONLY',
    [EXTERNAL.source]: 'SOURCE_ONLY', [EXTERNAL.transcript]: 'FULL_EXTRACTION', [EXTERNAL.summary]: 'SOURCE_ONLY',
  });
  expect(synced.of('summary').code).toBe('ASSISTANT_AUTHORED');
  const deep = [synced.of('full').id, synced.of('entity').id, synced.of('transcript').id].sort();

  const recorded = await intents(o.ownerScopeId);
  expect(recorded.map(row => row.source_item_id as string).sort()).toEqual(deep);
  for (const row of recorded) {
    expect(row).toMatchObject({ status: 'PENDING', job_id: null, extraction_run_id: null, run_kind: 'FULL',
      data_purpose: 'PERSONAL_ASSISTANCE', maximum_sensitivity: 'RESTRICTED', actor_id: o.user.id });
  }
  // Same transaction: nothing updates either row before dispatch, so an equal xmin means one inserting
  // transaction, the sync's. An intent written by a later transaction would carry another xmin.
  const together = (await admin.query(`SELECT p.source_item_id FROM evidence_processing p JOIN triage_decisions t
    ON t.owner_scope_id=p.owner_scope_id AND t.source_item_id=p.source_item_id
    WHERE p.owner_scope_id=$1 AND p.xmin=t.xmin`, [o.ownerScopeId])).rows;
  expect(together.map(row => row.source_item_id as string).sort()).toEqual(deep);

  for (const name of ['full', 'entity', 'transcript'] as const) {
    const read = await o.app.inject({ method: 'GET', url: '/v1/evidence/' + synced.of(name).id, headers: o.headers('evidence.read') });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json().processing, name).toEqual({ status: 'PENDING', unresolvedClaims: 0, lastError: null, completedAt: null });
  }
  for (const name of ['index', 'source', 'summary'] as const) {
    const read = await o.app.inject({ method: 'GET', url: '/v1/evidence/' + synced.of(name).id, headers: o.headers('evidence.read') });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json().processing, name).toBeNull();
  }
}), 30000);

it('ADR 0038 for connector syncs: the worker extracts synced Gmail and Omi items only under the data purpose the sync recorded', () => withSyncedOwner(async o => {
  const synced = await items(o.ownerScopeId);
  const [full, entity, transcript] = [synced.of('full').id, synced.of('entity').id, synced.of('transcript').id] as const;
  const c = citing();

  // The web pins PERSONAL_ASSISTANCE for Sync now, and dispatch filters on that purpose
  // (processing-runtime.ts dispatch), so a worker for another purpose claims nothing.
  expect((await o.runtime({ provider: c.provider, dataPurpose: 'WORK_ASSISTANCE' }).runOnce()).claimed).toBe(false);
  expect(c.requests).toEqual([]);
  const waiting = await intents(o.ownerScopeId);
  expect(waiting.map(row => row.source_item_id as string).sort()).toEqual([full, entity, transcript].sort());
  for (const row of waiting) expect(row).toMatchObject({ status: 'PENDING', job_id: null });

  // The matching worker dispatches all three on its first turn and runs one job per turn.
  const worker = o.runtime({ provider: c.provider });
  for (let turn = 1; turn <= 3; turn++) expect((await worker.runOnce()).job?.status, 'turn ' + turn).toBe('SUCCEEDED');
  expect((await worker.runOnce()).claimed).toBe(false);
  // The INDEX_ONLY newsletter and the SOURCE_ONLY quoted reply never reach the model.
  expect(c.requests.map(request => request.sourceType).sort()).toEqual(['GMAIL', 'GMAIL', 'OMI']);
  for (const request of c.requests) expect(request.input).not.toMatch(/Unsubscribe|wrote:/);

  const runs = (await admin.query('SELECT id,source_item_id,status,error_code FROM extraction_runs WHERE owner_scope_id=$1', [o.ownerScopeId])).rows;
  expect(runs.map(run => [run.source_item_id, run.status, run.error_code]).sort())
    .toEqual([[full, 'SUCCEEDED', null], [entity, 'SUCCEEDED', null], [transcript, 'SUCCEEDED', null]].sort());
  const ledger = new Map((await intents(o.ownerScopeId)).map(row => [row.source_item_id as string, row]));
  const runOf = (id: string) => runs.find(run => run.source_item_id === id)!.id as string;
  expect(ledger.get(full)).toMatchObject({ status: 'SUCCEEDED', unresolved_claims: 0, last_error: null, extraction_run_id: runOf(full) });
  expect(ledger.get(entity)).toMatchObject({ status: 'SUCCEEDED', unresolved_claims: 0, last_error: null, extraction_run_id: runOf(entity) });
  // By design (ADR 0041 D4): the quote is not first-person and the EXTERNAL omi:transcript actor gets no
  // entity (processing-canonicalization.ts), so the claim stays unresolved and the item needs review.
  expect(ledger.get(transcript)).toMatchObject({ status: 'NEEDS_REVIEW', unresolved_claims: 1, last_error: null, extraction_run_id: runOf(transcript) });
  for (const id of [full, entity, transcript]) expect(ledger.get(id)!.completed_at, id).toBeInstanceOf(Date);

  const claims = (await admin.query(`SELECT c.claim_origin,c.lifecycle,c.proposition_id,c.extraction_run_id,a.source_item_id,a.anchor_kind,a.anchor
    FROM claims c JOIN source_anchors a ON a.owner_scope_id=c.owner_scope_id AND a.id=c.source_anchor_id
    WHERE c.owner_scope_id=$1`, [o.ownerScopeId])).rows;
  expect(claims.filter(claim => claim.source_item_id === entity)).toEqual([]);
  for (const name of ['index', 'source', 'summary'] as const) {
    expect(claims.filter(claim => claim.source_item_id === synced.of(name).id), name).toEqual([]);
  }
  const spoken = claims.filter(claim => claim.source_item_id === transcript);
  expect(spoken).toHaveLength(1);
  expect(spoken[0]).toMatchObject({ claim_origin: 'MODEL_EXTRACTION', lifecycle: 'CANDIDATE', proposition_id: null,
    anchor_kind: 'TRANSCRIPT_SEGMENT', anchor: expect.objectContaining({ segmentIndex: 2 }) });
  const sent = claims.filter(claim => claim.source_item_id === full && claim.proposition_id !== null);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ claim_origin: 'MODEL_EXTRACTION' });
  const assessment = (await admin.query('SELECT assessment_status FROM belief_assessments WHERE owner_scope_id=$1 AND proposition_id=$2',
    [o.ownerScopeId, sent[0]!.proposition_id])).rows;
  expect(assessment).toEqual([{ assessment_status: 'PROVISIONAL' }]);

  const read = await o.app.inject({ method: 'GET', url: '/v1/evidence/' + transcript, headers: o.headers('evidence.read') });
  expect(read.statusCode, read.body).toBe(200);
  expect(read.json().processing).toMatchObject({ status: 'NEEDS_REVIEW', unresolvedClaims: 1, lastError: null });
  expect(typeof read.json().processing.completedAt).toBe('string');
}), 60000);
