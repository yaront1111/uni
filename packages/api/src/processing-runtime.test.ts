import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { postgresAdapter, SESSION_COOKIE } from '@unai/auth';
import { runMigrations, withOwnerTransaction } from '@unai/postgres';
import { claimJob, retryDeadLetterJob } from '@unai/jobs';
import { replayProjection, resolveOwnerEntity } from '@unai/capabilities';
import { recordClaim, recordResolutionAssertion, setResolutionLifecycle } from '@unai/memory';
import type { ModelProvider } from '@unai/model';
import { lintRegistryCheckout, loadRegistryRelease, publishRegistryRelease } from '../../registry/src/index.js';
import { createPlatformApi } from './platform.js';
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

async function owner(clock?: () => Date) {
  const adapter = postgresAdapter(admin);
  const user = await adapter.createUser!({ name: 'Processing journey', email: 'processing-' + randomUUID() + '@example.test', emailVerified: null });
  const ownerScopeId = (user as unknown as { ownerScopeId: string }).ownerScopeId;
  const token = randomBytes(32).toString('base64url');
  await adapter.createSession!({ userId: user.id, sessionToken: token, expires: new Date(Date.now() + 86400000) });
  const app = createPlatformApi({ appPool, authPool: admin, evidenceObjects: objects, registryReleaseId, registryRelease: '0.1.0', ...(clock ? { clock } : {}) });
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
  const model = { calls: 0, failing: false, frameType: 'shared.commitment' };
  const provider: ModelProvider = { providerId: 'recorded-test', defaultModelId: 'source-span-test', async complete(request) {
    model.calls++;
    if (model.failing) throw new Error('MODEL_PROVIDER_UNAVAILABLE');
    const input = JSON.parse(request.input) as { anchors: { anchorKind: string; parentAnchor: Record<string, unknown>; text: string }[] };
    const anchor = input.anchors[0]!;
    return { modelId: 'source-span-test', costMicrounits: 1, outputText: JSON.stringify({ claims: [{
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
