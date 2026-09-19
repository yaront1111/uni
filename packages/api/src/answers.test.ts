import { Pool } from 'pg';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { runMigrations, withOwnerTransaction } from '@unai/postgres';
import { postgresAdapter, SESSION_COOKIE } from '@unai/auth';
// The registry library stays out of the API's manifest (registry-boundary.test.ts);
// only this test publishes the pinned release, through the package's own source.
import { loadRegistryRelease, publishRegistryRelease } from '../../registry/src/index.js';
import { createModelGateway, MODEL_PURPOSES, type ModelProvider } from '@unai/model';
import { SUPPLIED_CONTEXT_STATEMENT, type AnswerCandidate, type AnswerCandidateStatement } from '@unai/domain';
import type { AnswerPhraser } from '@unai/context';
import { uuidV7 } from '../../../src/kernel/identities.js';
import { createPlatformApi } from './platform.js';
import { createGatewayAnswerPhraser } from './answers.js';
import type { EvidenceObjects } from './evidence.js';

/**
 * Answer provenance and grounding end to end, over the real boundary, the real
 * owner transaction, the real pinned registry release 0.1.0 and the real governor
 * (ADR 0025).
 *
 *  - CRT-RD-06-A: every answer this suite generates has a manifest whose belief,
 *    claim, evidence and overlay delta ids equal what its persisted packet holds,
 *    with the packet hash, projection versions, watermarks, release, model and
 *    prompt version.
 *  - CRT-RD-07-A: nothing in the manifest API names which item the model used.
 *  - CRT-RD-08-A: the grounding validator blocks, downgrades or regenerates each of
 *    the five failures.
 *  - CRT-AI-01-A: a fact the model invents is stored only as assistant
 *    conversation evidence, becomes no belief, and is never cited later.
 *  - CRT-RD-11-A: after a belief changes materially, the reconsideration query
 *    returns exactly the answers whose manifests contained it.
 *  - CRT-RYW-05-A: evidence that contradicts a pending delta leaves it CONTESTED,
 *    present, and carrying its full record.
 *
 * The phrasing "model" is a scripted test double supplied through the same
 * `AnswerPhraser` port a gateway-backed phraser fills; one test runs the real
 * gateway over a fake provider to show the call is recorded.
 */

if (!process.env.UNAI_TEST_DATABASE_URL) throw new Error('Run pnpm test for the required PostgreSQL harness');
const admin = new Pool({ connectionString: process.env.UNAI_TEST_DATABASE_URL });
const url = new URL(process.env.UNAI_TEST_DATABASE_URL); url.username = 'answers_api_test_app'; url.password = 'test-only';
const appPool = new Pool({ connectionString: url.href });

const FINANCE = 'PERSONAL_FINANCE', SCHEDULING = 'SCHEDULING';
const T = (day: string) => new Date(day + 'T09:00:00.000Z');
let owner = '', actor = '', token = '', registryReleaseId = '', transactionId = '', baseContext = '', daniel = '';
const evidence: Record<'document' | 'calendar' | 'chat' | 'medical', { evidenceId: string; anchorId: string }> = {
  document: { evidenceId: '', anchorId: '' }, calendar: { evidenceId: '', anchorId: '' },
  chat: { evidenceId: '', anchorId: '' }, medical: { evidenceId: '', anchorId: '' },
};
/** The fixture's propositions by role. */
const p = { principal: '', car: '', rent: '', due: '', meeting: '', restricted: '' };
let overlayDelta = '';
/** Every answer a request in this file got back, for the suite-wide manifest check. */
const answered: Array<{ answerManifestId: string; packetId: string; modelId: string; promptVersion: string }> = [];
const stored = new Map<string, Uint8Array>();
const evidenceObjects: EvidenceObjects = {
  encryptionKeyRef: 'kms:test-double',
  async put(_tx, id, bytes) { stored.set(id, bytes); },
  async get(_tx, id) { const bytes = stored.get(id); if (!bytes) throw new Error('OBJECT_NOT_FOUND'); return bytes; },
};

function git(repository: string, ...args: string[]) {
  const result = spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=Registry Test', '-c', 'user.email=registry@test.invalid', ...args],
    { cwd: repository, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: '2024-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2024-01-01T00:00:00Z' } });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
/** The immutable 0.1.0 snapshot, published by whichever suite gets there first. */
async function pinnedRegistryRelease(): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const existing = (await admin.query("SELECT id FROM registry_releases WHERE semantic_version='0.1.0'")).rows[0];
    if (existing) return existing.id as string;
    await sleep(250);
  }
  const repository = await mkdtemp(join(tmpdir(), 'unai-answers-registry-'));
  try {
    await cp(resolve('registry'), join(repository, 'registry'), { recursive: true });
    git(repository, 'init', '--quiet'); git(repository, 'add', 'registry');
    git(repository, 'commit', '--quiet', '-m', 'release'); git(repository, 'tag', 'registry-v0.1.0');
    const release = await loadRegistryRelease({ repository, version: '0.1.0' });
    try { return (await publishRegistryRelease(admin, release, randomUUID())).releaseId; }
    catch { return (await admin.query("SELECT id FROM registry_releases WHERE semantic_version='0.1.0'")).rows[0].id as string; }
  } finally { await rm(repository, { recursive: true, force: true }); }
}

async function item(externalId: string, sourceType: string, sensitivity: string, purposes: string[]) {
  const evidenceId = uuidV7(), anchorId = uuidV7(), connectorId = randomUUID();
  await admin.query("INSERT INTO connectors(id,owner_scope_id,connector_type,external_account_ref,permission_manifest,status) VALUES($1,$2,'CONVERSATION',$3,'{}','ACTIVE')",
    [connectorId, owner, externalId]);
  await admin.query(`INSERT INTO source_items(id,owner_scope_id,connector_id,source_type,external_id,actor_ref,submitted_by_user_id,
    raw_object_ref,content_hash,sensitivity,allowed_purposes,ingestion_version,idempotency_key,occurred_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'evidence-json-v1',$12,$13)`,
    [evidenceId, owner, connectorId, sourceType, externalId, JSON.stringify({ type: 'USER', id: actor }), actor, randomUUID(),
      randomBytes(32).toString('hex'), sensitivity, purposes, randomUUID(), T('2026-01-20')]);
  await admin.query(`INSERT INTO source_anchors(id,owner_scope_id,source_item_id,anchor_kind,anchor)
    VALUES($1,$2,$3,'MESSAGE_SPAN','{"start":0,"end":40}')`, [anchorId, owner, evidenceId]);
  return { evidenceId, anchorId };
}
async function frame(frameTypeId: string) {
  const id = uuidV7();
  await admin.query('INSERT INTO frame_instances(id,owner_scope_id,frame_type_id,context_space_id) VALUES($1,$2,$3,$4)',
    [id, owner, frameTypeId, baseContext]);
  await admin.query("INSERT INTO frame_instance_roles(id,owner_scope_id,frame_instance_id,role_id,entity_id) VALUES($1,$2,$3,'creditor',$4)",
    [randomUUID(), owner, id, daniel]);
  return id;
}
async function slot(frameInstanceId: string, predicateId: string, modality = 'ACTUAL') {
  const id = uuidV7();
  await admin.query(`INSERT INTO belief_slots(id,owner_scope_id,frame_instance_id,predicate_id,context_space_id,modality)
    VALUES($1,$2,$3,$4,$5,$6)`, [id, owner, frameInstanceId, predicateId, baseContext, modality]);
  return id;
}
async function value(slotId: string, normalized: unknown, source: keyof typeof evidence, status: string, origin = 'USER_STATEMENT') {
  const propositionId = uuidV7(), claimId = uuidV7();
  await admin.query('INSERT INTO propositions(id,owner_scope_id,belief_slot_id,normalized_value) VALUES($1,$2,$3,$4)',
    [propositionId, owner, slotId, JSON.stringify(normalized)]);
  await admin.query(`INSERT INTO claims(id,owner_scope_id,source_anchor_id,proposition_id,claim_origin,lifecycle,valid_from,recorded_at)
    VALUES($1,$2,$3,$4,$5,'PROVISIONAL',$6,$7)`, [claimId, owner, evidence[source].anchorId, propositionId, origin, T('2026-01-01'), T('2026-02-01')]);
  await admin.query(`INSERT INTO belief_assessments(id,owner_scope_id,proposition_id,assessment_status,valid_from,recorded_at,
    policy_version,decision_reason,transaction_id) VALUES($1,$2,$3,$4,$5,$6,'local-policy-0.1.0','{"code":"FIXTURE"}',$7)`,
    [uuidV7(), owner, propositionId, status, T('2026-01-01'), T('2026-02-01'), transactionId]);
  return propositionId;
}

beforeAll(async () => {
  await runMigrations(admin, resolve('migrations'));
  await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='answers_api_test_app') THEN CREATE ROLE answers_api_test_app LOGIN PASSWORD 'test-only'; END IF; END $$; GRANT unai_app TO answers_api_test_app");
  const adapter = postgresAdapter(admin);
  const user = await adapter.createUser!({ name: 'Provenance', email: 'answers-api@example.test', emailVerified: null });
  actor = user.id;
  owner = (user as unknown as { ownerScopeId: string }).ownerScopeId;
  token = randomBytes(32).toString('base64url');
  await adapter.createSession!({ userId: user.id, sessionToken: token, expires: new Date(Date.now() + 604800000) });
  baseContext = (await admin.query("SELECT id FROM context_spaces WHERE owner_scope_id=$1 AND context_kind='BASE'", [owner])).rows[0].id;
  registryReleaseId = await pinnedRegistryRelease();
  transactionId = randomUUID();
  await admin.query(`INSERT INTO belief_transactions(id,owner_scope_id,transaction_kind,requested_by_actor_id,
    source_evidence_ids,registry_release_id,status,risk,idempotency_key,commit_receipt,committed_at)
    VALUES($1,$2,'CANONICALIZE',$3,'{}',$4,'COMMITTED','LOW',$5,'{}',$6)`,
    [transactionId, owner, actor, registryReleaseId, randomUUID().replaceAll('-', ''), T('2026-02-01')]);
  daniel = uuidV7();
  await admin.query("INSERT INTO entities(id,owner_scope_id,entity_kind,canonical_label) VALUES($1,$2,'PERSON','Daniel')", [daniel, owner]);

  evidence.document = await item('loan-agreement.pdf', 'DOCUMENT', 'PRIVATE', [FINANCE]);
  evidence.calendar = await item('calendar-handover', 'CALENDAR_EVENT', 'PRIVATE', [FINANCE, SCHEDULING]);
  evidence.chat = await item('owner-chat', 'CONVERSATION', 'PRIVATE', [FINANCE]);
  evidence.medical = await item('clinic-invoice.pdf', 'DOCUMENT', 'RESTRICTED', [FINANCE]);

  const obligation = await frame('shared.obligation');
  p.principal = await value(await slot(obligation, 'shared.obligation.principal_amount'), { amount: '60.00', currency: 'ILS' }, 'document', 'ACCEPTED');
  const description = await slot(obligation, 'shared.obligation.description');
  p.car = await value(description, { text: 'loan to repair the car' }, 'chat', 'CONTESTED');
  p.rent = await value(description, { text: 'loan to cover the rent' }, 'document', 'CONTESTED', 'DOCUMENT_ASSERTION');
  // Accepted on a model's reading alone: a legacy row no current governed write
  // could produce, so the read side has to label it on its own.
  p.due = await value(await slot(obligation, 'shared.obligation.due_time'), { time: '2026-04-01T00:00:00.000Z' }, 'chat', 'ACCEPTED', 'MODEL_INFERENCE');
  p.meeting = await value(await slot(await frame('shared.event_occurrence'), 'shared.event_occurrence.occurrence_time', 'SCHEDULED'),
    { time: '2026-03-10T09:00:00.000Z' }, 'calendar', 'ACCEPTED');
  p.restricted = await value(await slot(await frame('shared.obligation'), 'shared.obligation.principal_amount'),
    { amount: '999.00', currency: 'ILS' }, 'medical', 'ACCEPTED');

  // The owner's pending "actually it was 65" on the principal.
  overlayDelta = uuidV7();
  await admin.query(`INSERT INTO owner_overlay_deltas(id,owner_scope_id,owner_sequence,source_evidence_id,raw_text,delta_kind,
    lifecycle,target_object_type,target_object_id,created_at)
    VALUES($1,$2,1,$3,'Actually it was 65','USER_CORRECTION','USER_ASSERTED','proposition',$4,$5)`,
    [overlayDelta, owner, evidence.chat.evidenceId, p.principal, T('2026-02-20')]);
});
afterAll(async () => { await appPool.end(); await admin.end(); });

function api(phraser?: AnswerPhraser, objects: EvidenceObjects | null = evidenceObjects) {
  const app = createPlatformApi({ authPool: admin, appPool, registryReleaseId, registryRelease: '0.1.0',
    ...(objects ? { evidenceObjects: objects } : {}), ...(phraser ? { answerPhraser: phraser } : {}) });
  app.addHook('onRequest', async request => { Object.defineProperty(request.raw.socket, 'encrypted', { value: true }); });
  return app;
}
const headers = (purpose: string, extra: Record<string, string> = {}) => ({
  cookie: SESSION_COOKIE + '=' + token, 'x-owner-scope-id': owner, 'x-purpose': purpose,
  'x-correlation-id': randomUUID(), 'idempotency-key': randomBytes(16).toString('hex'), ...extra,
});

/** A phrasing model that says exactly what the test scripts, one candidate per call. */
function scripted(...candidates: AnswerCandidateStatement[][]): AnswerPhraser & { calls: number } {
  const phraser = {
    modelProvider: 'fixture-model', modelId: 'fixture-model-1', promptVersion: 'answer-phrasing-0.1.0', calls: 0,
    async phrase(): Promise<AnswerCandidate> {
      const statements = candidates[Math.min(phraser.calls, candidates.length - 1)]!;
      phraser.calls++;
      return { statements };
    },
  };
  return phraser;
}
const ref = (objectId: string, objectType = 'propositions') => ({ objectType, objectId });
const statement = (text: string, label: AnswerCandidateStatement['label'], objectRefs: Array<{ objectType: string; objectId: string }>,
  extra: Partial<AnswerCandidateStatement> = {}): AnswerCandidateStatement =>
  ({ text, label, objectRefs, sourceEvidenceIds: [], sensitivityScope: null, ...extra });

async function ask(app: ReturnType<typeof api>, question: string, over: Record<string, unknown> = {}) {
  const response = await app.inject({ method: 'POST', url: '/v1/ask', headers: headers('memory.read'), payload: {
    ownerScopeId: owner, question, purpose: FINANCE, worldTime: 'NOW', knowledgeTime: 'LATEST', maximumSensitivity: 'PRIVATE', ...over } });
  expect(response.statusCode, response.body).toBe(200);
  const answer = response.json();
  answered.push({ answerManifestId: answer.answerManifestId, packetId: answer.packetId,
    modelId: answer.composer.modelId ?? 'ask-composer-0.1.0', promptVersion: answer.composer.promptVersion ?? 'composer-templates-0.1.0' });
  return answer;
}
/** What the answer says, without its ids: an invented digit must not match a UUID. */
const said = (answer: { statements: Array<{ text: string }> }) => answer.statements.map(entry => entry.text).join('\n');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Every UUID the stored packet names, except in the lists of what it withheld:
 * its redactions and unknowns, and what the selector's read-policy step excluded
 * (named there without a value). */
function uuidsIn(value: unknown, found = new Set<string>()): Set<string> {
  if (typeof value === 'string' && UUID.test(value)) found.add(value);
  else if (Array.isArray(value)) for (const entry of value) uuidsIn(entry, found);
  else if (value && typeof value === 'object') {
    const readPolicy = (value as Record<string, unknown>)['rule'] === 'APPLY_READ_POLICY';
    for (const [key, entry] of Object.entries(value)) {
      if (key !== 'redactions' && key !== 'unknowns' && !(readPolicy && key === 'excluded')) uuidsIn(entry, found);
    }
  }
  return found;
}
/** The oracle: which of those ids the database knows as each kind of object. It
 * shares no code with the manifest derivation it checks. */
async function packetSets(packet: unknown) {
  const ids = [...uuidsIn(packet)];
  const of = async (table: string) => (await admin.query(`SELECT id::text FROM ${table} WHERE owner_scope_id=$1 AND id=ANY($2::uuid[]) ORDER BY id`,
    [owner, ids])).rows.map(row => row.id as string).sort();
  return { beliefIds: await of('propositions'), claimIds: await of('claims'), evidenceIds: await of('source_items'),
    overlayDeltaIds: await of('owner_overlay_deltas') };
}
async function manifestRow(id: string) {
  return (await admin.query('SELECT * FROM answer_manifests WHERE owner_scope_id=$1 AND id=$2', [owner, id])).rows[0];
}
const assistantItems = async () => (await admin.query(
  `SELECT id::text,external_id,actor_ref,source_type,raw_object_ref FROM source_items WHERE owner_scope_id=$1 AND source_type='ASSISTANT_CONVERSATION'`,
  [owner])).rows;

it('CRT-RD-06-A, CRT-RD-07-A: an answer has a manifest equal to its persisted packet, described as context supplied', async () => {
  const app = api();
  try {
    const answer = await ask(app, 'Do I still owe Daniel?');
    expect(answer.answerManifestId).toMatch(UUID);
    expect(answer.grounding).toMatchObject({ action: 'PASSED', finalSource: 'DETERMINISTIC_COMPOSER' });
    expect(answer.composer).toMatchObject({ kind: 'DETERMINISTIC_COMPOSER', modelCalled: false });

    const row = await manifestRow(answer.answerManifestId);
    const packet = (await admin.query('SELECT packet,packet_hash,registry_release_id FROM context_packets WHERE id=$1', [answer.packetId])).rows[0];
    const expected = await packetSets(packet.packet);
    expect([...row.belief_ids].sort()).toEqual(expected.beliefIds);
    expect([...row.claim_ids].sort()).toEqual(expected.claimIds);
    expect([...row.evidence_ids].sort()).toEqual(expected.evidenceIds);
    expect([...row.overlay_delta_ids].sort()).toEqual(expected.overlayDeltaIds);
    // The fixture's own objects are among them, and the withheld one's evidence is not.
    expect(row.belief_ids).toEqual(expect.arrayContaining([p.principal, p.car, p.rent, p.due]));
    expect(row.overlay_delta_ids).toEqual([overlayDelta]);
    expect(row.evidence_ids).not.toContain(evidence.medical.evidenceId);
    expect(row).toMatchObject({ context_packet_id: answer.packetId, packet_hash: packet.packet_hash, registry_release: '0.1.0',
      registry_release_id: registryReleaseId, model_provider: 'unai-deterministic', model_id: 'ask-composer-0.1.0',
      prompt_version: 'composer-templates-0.1.0' });
    expect(row.projection_versions).toEqual(packet.packet.watermarks.projectionVersions);
    expect(row.watermarks).toEqual(packet.packet.watermarks);

    // The manifest API: every field describes context supplied, none says used.
    const read = await app.inject({ method: 'GET', url: '/v1/answers/' + answer.answerManifestId + '/manifest', headers: headers('memory.inspect') });
    expect(read.statusCode, read.body).toBe(200);
    const manifest = read.json();
    expect(manifest).toMatchObject({ answerManifestId: answer.answerManifestId, recordKind: 'CONTEXT_SUPPLIED_TO_MODEL',
      recordStatement: SUPPLIED_CONTEXT_STATEMENT, question: 'Do I still owe Daniel?',
      contextSupplied: { packetId: answer.packetId, packetHash: packet.packet_hash, registryRelease: '0.1.0', registryReleaseId },
      suppliedTo: { modelId: 'ask-composer-0.1.0', promptVersion: 'composer-templates-0.1.0' },
      reconsideration: { isCandidate: false, changes: [] } });
    expect([...manifest.contextSupplied.beliefIds].sort()).toEqual(expected.beliefIds);
    const keys: string[] = [];
    const walk = (value: unknown) => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') for (const [key, entry] of Object.entries(value)) { keys.push(key); walk(entry); }
    };
    walk(manifest);
    for (const key of keys) expect(key).not.toMatch(/used|uses|relied|reliance|attribut|contribut|influenc|cited|relevan|weight|score|rank|selected/i);
    expect(JSON.stringify(manifest).replace(SUPPLIED_CONTEXT_STATEMENT, '')).not.toMatch(/\bused\b|relied|based on/i);
    // The route belongs to the inspector's purpose, and to this owner.
    expect((await app.inject({ method: 'GET', url: '/v1/answers/' + answer.answerManifestId + '/manifest', headers: headers('memory.read') })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/v1/answers/' + randomUUID() + '/manifest', headers: headers('memory.inspect') })).statusCode).toBe(404);

    // The presented answer is assistant conversation evidence, routed SOURCE_ONLY.
    const message = (await admin.query('SELECT s.actor_ref,s.source_type,t.tier1_route,t.routing_reason FROM source_items s JOIN triage_decisions t ON t.owner_scope_id=s.owner_scope_id AND t.source_item_id=s.id WHERE s.id=$1',
      [row.conversation_message_id])).rows[0];
    expect(message).toMatchObject({ source_type: 'ASSISTANT_CONVERSATION', actor_ref: { type: 'ASSISTANT' }, tier1_route: 'SOURCE_ONLY',
      routing_reason: { code: 'ASSISTANT_AUTHORED' } });
  } finally { await app.close(); }
});

it('CRT-RD-08-A: an ungrounded personal fact is regenerated, and the composer answers when the model cannot ground it', async () => {
  const grounded = statement('Recorded: obligation principal amount is ILS 60.00.', 'CONFIRMED', [ref(p.principal)]);
  const invented = statement('You owe Daniel ILS 500.', 'CONFIRMED', [ref(p.principal)]);
  let app = api(scripted([invented], [grounded]));
  try {
    const answer = await ask(app, 'Do I still owe Daniel?');
    expect(answer.grounding).toMatchObject({ action: 'REGENERATED', finalSource: 'MODEL' });
    expect(answer.grounding.attempts.map((attempt: { outcome: string }) => attempt.outcome)).toEqual(['REGENERATED', 'PASSED']);
    expect(answer.grounding.violations[0]).toMatchObject({ rule: 'UNGROUNDED_PERSONAL_FACT', action: 'REGENERATE',
      detail: 'STATES_VALUE_NOT_IN_NAMED_OBJECTS' });
    expect(answer.composer).toMatchObject({ kind: 'MODEL_PHRASED', modelCalled: true, modelId: 'fixture-model-1' });
    expect(answer.statements.map((entry: { text: string }) => entry.text)).toEqual([grounded.text]);
    expect((await manifestRow(answer.answerManifestId)).grounding_validator_result).toMatchObject({ action: 'REGENERATED' });
  } finally { await app.close(); }
  // Naming nothing in the packet is ungrounded too; twice, and the composer answers.
  app = api(scripted([statement('Your sister lent you ILS 200.', 'REPORTED', [])]));
  try {
    const answer = await ask(app, 'Do I still owe Daniel?');
    expect(answer.grounding).toMatchObject({ action: 'REGENERATED', finalSource: 'DETERMINISTIC_COMPOSER' });
    expect(answer.grounding.attempts.map((attempt: { candidateSource: string }) => attempt.candidateSource))
      .toEqual(['MODEL', 'MODEL', 'DETERMINISTIC_COMPOSER']);
    expect(answer.grounding.violations[0]).toMatchObject({ rule: 'UNGROUNDED_PERSONAL_FACT', detail: 'NAMES_NO_PACKET_OBJECT' });
    expect(answer.composer.kind).toBe('DETERMINISTIC_COMPOSER');
    expect(said(answer)).not.toMatch(/sister|200/);
  } finally { await app.close(); }
});

it('CRT-RD-08-A: a SCHEDULED event worded as occurred and a CONTESTED belief worded as certain are downgraded', async () => {
  let app = api(scripted([statement('The handover meeting on 2026-03-10 happened.', 'CONFIRMED', [ref(p.meeting)])]));
  try {
    const answer = await ask(app, 'What is on my calendar?');
    expect(answer.grounding.action).toBe('DOWNGRADED');
    expect(answer.grounding.violations).toEqual([expect.objectContaining({ rule: 'SCHEDULED_WORDED_AS_OCCURRED',
      action: 'DOWNGRADE', objectIds: [p.meeting] })]);
    expect(answer.statements[0]).toMatchObject({ kind: 'MODEL_PHRASED', label: 'SCHEDULED' });
    expect(answer.statements[0].text).toMatch(/^Scheduled, not yet happened/);
  } finally { await app.close(); }
  // Worded as happened under a future label is still worded as happened.
  app = api(scripted([statement('The handover took place as planned.', 'SCHEDULED', [ref(p.meeting)])]));
  try {
    const answer = await ask(app, 'What is on my calendar?');
    expect(answer.grounding.violations).toEqual([expect.objectContaining({ rule: 'SCHEDULED_WORDED_AS_OCCURRED', detail: 'OCCURRENCE_WORDING' })]);
    expect(answer.statements[0].text).not.toContain('took place');
  } finally { await app.close(); }
  app = api(scripted([statement('The loan was definitely to repair the car.', 'CONFIRMED', [ref(p.car)])]));
  try {
    const answer = await ask(app, 'Do I still owe Daniel?');
    expect(answer.grounding.action).toBe('DOWNGRADED');
    expect(answer.grounding.violations).toEqual([expect.objectContaining({ rule: 'CONTESTED_WORDED_AS_CERTAIN', action: 'DOWNGRADE' })]);
    expect(answer.statements[0]).toMatchObject({ label: 'CONFLICTING' });
    expect(answer.statements[0].text).toContain('neither is settled');
    expect(answer.statements[0].text).not.toContain('definitely');
  } finally { await app.close(); }
});

it('CRT-RD-08-A: a model inference presented as source evidence is downgraded to an inference', async () => {
  const app = api(scripted([statement('According to your records the loan is due on 2026-04-01.', 'CONFIRMED', [ref(p.due)],
    { sourceEvidenceIds: [] })]));
  try {
    const answer = await ask(app, 'Do I still owe Daniel?');
    expect(answer.grounding.action).toBe('DOWNGRADED');
    expect(answer.grounding.violations).toEqual([expect.objectContaining({ rule: 'INFERENCE_PRESENTED_AS_EVIDENCE',
      action: 'DOWNGRADE', detail: 'MODEL_READING_LABELLED_AS_SOURCE', objectIds: [p.due] })]);
    expect(answer.statements[0]).toMatchObject({ label: 'INFERRED' });
    expect(answer.statements[0].text).toMatch(/^Inferred, not stated in a source: /);
  } finally { await app.close(); }
});

it('CRT-RD-08-A: content from a sensitivity scope absent from the packet is blocked', async () => {
  for (const candidate of [
    // Names the RESTRICTED obligation the PRIVATE request withheld.
    statement('You also owe the clinic ILS 999.00.', 'CONFIRMED', [ref(p.restricted)]),
    // Declares a scope the packet holds none of.
    statement('Recorded: obligation principal amount is ILS 60.00.', 'CONFIRMED', [ref(p.principal)], { sensitivityScope: 'RESTRICTED' }),
    // Cites evidence the request may not read.
    statement('Recorded: obligation principal amount is ILS 60.00.', 'CONFIRMED', [ref(p.principal)],
      { sourceEvidenceIds: [evidence.medical.evidenceId] }),
  ]) {
    const app = api(scripted([candidate]));
    try {
      const answer = await ask(app, 'Do I still owe Daniel?');
      expect(answer.grounding).toMatchObject({ action: 'BLOCKED' });
      expect(answer.grounding.violations[0]).toMatchObject({ rule: 'SENSITIVITY_SCOPE_LEAK', action: 'BLOCK' });
      expect(answer.statements).toHaveLength(1);
      expect(answer.statements[0]).toMatchObject({ kind: 'GROUNDING_BLOCKED', label: 'UNKNOWN', objectRefs: [], sourceEvidenceIds: [] });
      expect(answer.sourceLinks).toEqual([]);
      expect(answer.declinesToAssert).toBe(true);
      expect(said(answer)).not.toMatch(/999|clinic/);
      expect((await manifestRow(answer.answerManifestId)).grounding_validator_result).toMatchObject({ action: 'BLOCKED' });
    } finally { await app.close(); }
  }
});

it('CRT-AI-01-A: an invented personal fact is stored only as assistant conversation evidence, never believed, never cited', async () => {
  const invented = statement('You also owe Dana ILS 450 for the concert tickets.', 'CONFIRMED', []);
  let app = api(scripted([invented]));
  let packetId = '';
  try {
    const answer = await ask(app, 'Do I still owe Daniel?');
    packetId = answer.packetId;
    expect(said(answer)).not.toMatch(/Dana|450/);
  } finally { await app.close(); }

  // What the model said is kept, as what it is: an assistant message.
  const items = await assistantItems();
  const candidates = items.filter(row => row.external_id.startsWith('answer:' + packetId + ':candidate:'));
  expect(candidates).toHaveLength(2);
  for (const row of candidates) {
    expect(row).toMatchObject({ source_type: 'ASSISTANT_CONVERSATION', actor_ref: { type: 'ASSISTANT', id: 'fixture-model:fixture-model-1' } });
    expect(Buffer.from(stored.get(row.raw_object_ref)!).toString('utf8')).toContain('Dana ILS 450');
  }
  const ids = items.map(row => row.id);
  // Routed SOURCE_ONLY: no extraction is ever scheduled over it.
  expect((await admin.query('SELECT DISTINCT tier1_route FROM triage_decisions WHERE owner_scope_id=$1 AND source_item_id=ANY($2::uuid[])',
    [owner, ids])).rows).toEqual([{ tier1_route: 'SOURCE_ONLY' }]);
  // No claim rests on it, so no belief and no support row can.
  expect((await admin.query(`SELECT count(*)::int AS n FROM claims c JOIN source_anchors a ON a.owner_scope_id=c.owner_scope_id AND a.id=c.source_anchor_id
    WHERE c.owner_scope_id=$1 AND a.source_item_id=ANY($2::uuid[])`, [owner, ids])).rows[0].n).toBe(0);

  // Nor can a governed write make one out of it: a claim anchored in the
  // assistant's message is never support, whatever origin it declares.
  const anchor = (await admin.query(`SELECT id FROM source_anchors WHERE owner_scope_id=$1 AND source_item_id=$2`,
    [owner, candidates[0]!.id])).rows[0].id as string;
  const governed = (key: string) => headers('memory.govern', { 'idempotency-key': key, 'x-data-purpose': FINANCE, 'x-maximum-sensitivity': 'PRIVATE' });
  app = api();
  try {
    const key = randomUUID().replaceAll('-', '');
    const proposed = await app.inject({ method: 'POST', url: '/v1/memory/transactions/propose', headers: governed(key), payload: {
      transactionKind: 'CANONICALIZE', registryReleaseId, risk: 'LOW', sourceEvidenceIds: [candidates[0]!.id], operations: [
        { kind: 'CREATE_FRAME_INSTANCE', operationRef: '#instance', frameTypeId: 'shared.obligation', contextSpaceId: baseContext },
        { kind: 'CREATE_SLOT', operationRef: '#slot', frameInstance: '#instance', predicateId: 'shared.obligation.principal_amount',
          contextSpaceId: baseContext, modality: 'ACTUAL', qualifiers: {} },
        { kind: 'CREATE_PROPOSITION', operationRef: '#proposition', beliefSlot: '#slot', normalizedValue: { amount: '450.00', currency: 'ILS' } },
        { kind: 'ADD_CLAIM', operationRef: '#claim', sourceAnchorId: anchor, proposition: '#proposition', claimOrigin: 'USER_STATEMENT', lifecycle: 'PROVISIONAL' },
        { kind: 'ADD_SUPPORT', proposition: '#proposition', claim: '#claim', supportKind: 'DIRECT_ASSERTION' },
        { kind: 'SET_BELIEF_ASSESSMENT', proposition: '#proposition', assessmentStatus: 'ACCEPTED' },
      ] } });
    expect(proposed.statusCode, proposed.body).toBe(201);
    const transaction = proposed.json().transactionId as string;
    const validated = await app.inject({ method: 'POST', url: '/v1/memory/transactions/' + transaction + '/validate', headers: governed(key), payload: {} });
    expect(validated.statusCode, validated.body).toBe(200);
    expect(validated.json()).toMatchObject({ decision: 'REJECTED', policy: { outcome: 'DENY', reason: 'MODEL_PATH_MAY_NOT_ACCEPT_BELIEF' } });
    expect(validated.json().warnings).toContain('ASSISTANT_EVIDENCE_IS_NOT_SUPPORT');
    const committed = await app.inject({ method: 'POST', url: '/v1/memory/transactions/' + transaction + '/commit', headers: governed(key), payload: {} });
    expect(committed.statusCode).not.toBe(200);
    expect((await admin.query(`SELECT count(*)::int AS n FROM belief_assessments a JOIN propositions p ON p.owner_scope_id=a.owner_scope_id
      AND p.id=a.proposition_id WHERE a.owner_scope_id=$1 AND p.normalized_value->>'amount'='450.00'`, [owner])).rows[0].n).toBe(0);
  } finally { await app.close(); }

  // A later question about that fact finds nothing to cite: no source link, no
  // manifest entry and no statement comes from any assistant message.
  app = api();
  try {
    const later = await ask(app, 'Do I owe Dana for the concert tickets?');
    const every = (await assistantItems()).map(row => row.id);
    for (const link of later.sourceLinks) expect(every).not.toContain(link.evidenceId);
    for (const entry of later.statements) for (const cited of entry.sourceEvidenceIds) expect(every).not.toContain(cited);
    expect(said(later)).not.toMatch(/450|concert/);
    const row = await manifestRow(later.answerManifestId);
    for (const id of row.evidence_ids) expect(every).not.toContain(id);
  } finally { await app.close(); }
});

it('CRT-RD-11-A, CRT-RYW-05-A: a material change marks exactly the answers that contained it; a contradicted delta is contested and kept', async () => {
  const app = api();
  try {
    const containing = await ask(app, 'Do I still owe Daniel?');
    // Asked for another purpose, this packet never held the principal.
    const unrelated = await ask(app, 'What is on my calendar?', { purpose: SCHEDULING });
    expect((await manifestRow(unrelated.answerManifestId)).belief_ids).not.toContain(p.principal);
    expect((await manifestRow(containing.answerManifestId)).belief_ids).toContain(p.principal);
    const candidates = (query: string) => app.inject({ method: 'GET', url: '/v1/answers/reconsideration-candidates?' + query, headers: headers('memory.inspect') });
    // Nothing has changed yet.
    expect((await candidates('beliefId=' + p.principal)).json()).toMatchObject({ candidates: [], previousAnswersPreserved: true });
    const before = await manifestRow(containing.answerManifestId);

    // Later evidence re-asserts the value the owner's pending delta corrected,
    // and the governor records the principal as contested: one governed commit.
    const statement = await item('bank-statement.pdf', 'DOCUMENT', 'PRIVATE', [FINANCE]);
    const key = randomUUID().replaceAll('-', '');
    const governed = headers('memory.govern', { 'idempotency-key': key, 'x-data-purpose': FINANCE, 'x-maximum-sensitivity': 'PRIVATE' });
    const proposed = await app.inject({ method: 'POST', url: '/v1/memory/transactions/propose', headers: governed, payload: {
      transactionKind: 'CANONICALIZE', registryReleaseId, risk: 'LOW', sourceEvidenceIds: [statement.evidenceId], operations: [
        { kind: 'ADD_CLAIM', operationRef: '#claim', sourceAnchorId: statement.anchorId, proposition: p.principal,
          claimOrigin: 'DOCUMENT_ASSERTION', lifecycle: 'PROVISIONAL' },
        { kind: 'ADD_SUPPORT', proposition: p.principal, claim: '#claim', supportKind: 'CORROBORATION' },
        { kind: 'SET_BELIEF_ASSESSMENT', proposition: p.principal, assessmentStatus: 'CONTESTED' },
      ] } });
    expect(proposed.statusCode, proposed.body).toBe(201);
    const transaction = proposed.json().transactionId as string;
    const validated = await app.inject({ method: 'POST', url: '/v1/memory/transactions/' + transaction + '/validate', headers: { ...governed, 'x-correlation-id': randomUUID() }, payload: {} });
    expect(validated.json(), validated.body).toMatchObject({ decision: 'COMMITTABLE' });
    const committed = await app.inject({ method: 'POST', url: '/v1/memory/transactions/' + transaction + '/commit', headers: { ...governed, 'x-correlation-id': randomUUID() }, payload: {} });
    expect(committed.statusCode, committed.body).toBe(200);

    // CRT-RD-11-A: exactly the earlier answers whose manifests held the belief.
    const expected = (await admin.query(`SELECT id::text FROM answer_manifests WHERE owner_scope_id=$1 AND $2=ANY(belief_ids)
      AND id<>$3 ORDER BY created_at,id`, [owner, p.principal, unrelated.answerManifestId])).rows.map(row => row.id as string);
    const after = await ask(app, 'Do I still owe Daniel?');
    const listed = (await candidates('beliefId=' + p.principal)).json();
    expect(listed.candidates.map((entry: { answerManifestId: string }) => entry.answerManifestId).sort()).toEqual([...expected].sort());
    expect(expected).toContain(containing.answerManifestId);
    expect(listed.candidates.map((entry: { answerManifestId: string }) => entry.answerManifestId)).not.toContain(unrelated.answerManifestId);
    // An answer given after the change already saw it.
    expect(listed.candidates.map((entry: { answerManifestId: string }) => entry.answerManifestId)).not.toContain(after.answerManifestId);
    expect(listed.candidates.find((entry: { answerManifestId: string }) => entry.answerManifestId === containing.answerManifestId).changes)
      .toEqual(expect.arrayContaining([expect.objectContaining({ changedObjectType: 'belief', changedObjectId: p.principal,
        changeKind: 'BELIEF_ASSESSMENT_CHANGED' })]));
    // A belief that never changed has no candidates.
    expect((await candidates('beliefId=' + p.meeting)).json().candidates).toEqual([]);
    // The old answer is marked, not rewritten.
    expect(await manifestRow(containing.answerManifestId)).toEqual(before);
    const marked = (await app.inject({ method: 'GET', url: '/v1/answers/' + containing.answerManifestId + '/manifest', headers: headers('memory.inspect') })).json();
    expect(marked.reconsideration.isCandidate).toBe(true);
    // The other purpose's answer was never supplied the principal, so no change to
    // it is listed there. Its packet did name the owner's pending delta on that
    // slot (the selector lists it beside a partly withheld slot), so the delta's
    // move is listed, and nothing else.
    const unmarked = (await app.inject({ method: 'GET', url: '/v1/answers/' + unrelated.answerManifestId + '/manifest', headers: headers('memory.inspect') })).json();
    expect(unmarked.contextSupplied.beliefIds).not.toContain(p.principal);
    expect(unmarked.reconsideration.changes.filter((change: { changedObjectType: string }) => change.changedObjectType === 'belief')).toEqual([]);
    for (const change of unmarked.reconsideration.changes) {
      expect(change).toMatchObject({ changedObjectType: 'owner_overlay_delta', changedObjectId: overlayDelta });
      expect(unmarked.contextSupplied.overlayDeltaIds).toContain(overlayDelta);
    }
    // One object per query, and a well-formed one.
    for (const query of ['', 'beliefId=' + p.principal + '&overlayDeltaId=' + overlayDelta, 'beliefId=not-a-uuid']) {
      expect((await candidates(query)).statusCode, query).toBe(400);
    }

    // CRT-RYW-05-A: the pending delta is CONTESTED, still there, with its record.
    const delta = (await admin.query('SELECT * FROM owner_overlay_deltas WHERE id=$1', [overlayDelta])).rows[0];
    expect(delta).toMatchObject({ lifecycle: 'CONTESTED', raw_text: 'Actually it was 65', delta_kind: 'USER_CORRECTION',
      target_object_id: p.principal, source_evidence_id: evidence.chat.evidenceId });
    const containingDelta = (await admin.query(`SELECT id::text FROM answer_manifests WHERE owner_scope_id=$1 AND $2=ANY(overlay_delta_ids)
      AND created_at<=$3 ORDER BY created_at,id`, [owner, overlayDelta, (await manifestRow(after.answerManifestId)).created_at])).rows
      .map(row => row.id as string).filter(id => id !== after.answerManifestId);
    expect(containingDelta).toContain(containing.answerManifestId);
    expect(delta.contested_reason).toMatchObject({
      failureReason: 'LATER_EVIDENCE_REASSERTS_CORRECTED_VALUE',
      conflictingEvidenceIds: [statement.evidenceId],
      affectedProjections: expect.arrayContaining(['obligations_projection']),
      userAttentionRequired: true,
    });
    expect([...delta.contested_reason.containingManifestIds].sort()).toEqual([...containingDelta].sort());
    // The delta's move is itself a change the answers that held it are marked for.
    const byDelta = (await candidates('overlayDeltaId=' + overlayDelta)).json();
    expect(byDelta.candidates.map((entry: { answerManifestId: string }) => entry.answerManifestId).sort()).toEqual([...containingDelta].sort());
  } finally { await app.close(); }
});

it('CRT-RD-06-A: a gateway-phrased answer records the model and prompt it was supplied to, and the call itself', async () => {
  const provider: ModelProvider = {
    providerId: 'fixture-provider', defaultModelId: 'fixture-large-1',
    async complete() {
      return { modelId: 'fixture-large-1', costMicrounits: 12, outputText: JSON.stringify({ statements: [
        { text: 'Recorded: obligation principal amount is ILS 60.00.', label: 'REPORTED',
          objectRefs: [{ objectType: 'propositions', objectId: p.principal }], sourceEvidenceIds: [], sensitivityScope: null }] }) };
    },
  };
  const gateway = createModelGateway({ provider, recordCall: run => withOwnerTransaction(appPool,
    { actorId: actor, ownerScopeId: owner, purpose: MODEL_PURPOSES.call, correlationId: randomUUID() }, run) });
  const app = api(createGatewayAnswerPhraser(gateway));
  try {
    const answer = await ask(app, 'Do I still owe Daniel?');
    expect(answer.composer).toMatchObject({ kind: 'MODEL_PHRASED', modelCalled: true, modelId: 'fixture-large-1', promptVersion: 'answer-phrasing-0.1.0' });
    expect(await manifestRow(answer.answerManifestId)).toMatchObject({ model_provider: 'fixture-provider', model_id: 'fixture-large-1',
      prompt_version: 'answer-phrasing-0.1.0' });
    expect((await admin.query(`SELECT purpose,model_id,prompt_version,outcome FROM model_call_records WHERE owner_scope_id=$1
      AND purpose='answer.phrase'`, [owner])).rows).toEqual([{ purpose: 'answer.phrase', model_id: 'fixture-large-1',
      prompt_version: 'answer-phrasing-0.1.0', outcome: 'SUCCEEDED' }]);
  } finally { await app.close(); }
});

it('refuses to answer where no answer could be recorded', async () => {
  const app = api(undefined, null);
  try {
    const before = (await admin.query('SELECT count(*)::int AS n FROM context_packets WHERE owner_scope_id=$1', [owner])).rows[0].n;
    const response = await app.inject({ method: 'POST', url: '/v1/ask', headers: headers('memory.read'), payload: {
      ownerScopeId: owner, question: 'Do I still owe Daniel?', purpose: FINANCE, worldTime: 'NOW', knowledgeTime: 'LATEST', maximumSensitivity: 'PRIVATE' } });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'ANSWER_RECORDING_UNAVAILABLE' });
    expect((await admin.query('SELECT count(*)::int AS n FROM context_packets WHERE owner_scope_id=$1', [owner])).rows[0].n).toBe(before);
  } finally { await app.close(); }
});

it('CRT-RD-06-A: every answer generated in this suite has a manifest equal to its persisted packet', async () => {
  expect(answered.length).toBeGreaterThanOrEqual(12);
  for (const entry of answered) {
    const row = await manifestRow(entry.answerManifestId);
    expect(row, entry.answerManifestId).toBeDefined();
    const packet = (await admin.query('SELECT packet,packet_hash FROM context_packets WHERE id=$1', [entry.packetId])).rows[0];
    const expected = await packetSets(packet.packet);
    expect({ beliefIds: [...row.belief_ids].sort(), claimIds: [...row.claim_ids].sort(), evidenceIds: [...row.evidence_ids].sort(),
      overlayDeltaIds: [...row.overlay_delta_ids].sort() }, entry.answerManifestId).toEqual(expected);
    expect(row).toMatchObject({ context_packet_id: entry.packetId, packet_hash: packet.packet_hash, model_id: entry.modelId,
      prompt_version: entry.promptVersion, registry_release: '0.1.0', registry_release_id: registryReleaseId });
    expect(row.projection_versions).toEqual(packet.packet.watermarks.projectionVersions);
    expect(row.watermarks).toEqual(packet.packet.watermarks);
  }
  // And no packet the Ask route assembled is left without one.
  expect((await admin.query(`SELECT count(*)::int AS n FROM context_packets p WHERE p.owner_scope_id=$1
    AND NOT EXISTS(SELECT 1 FROM answer_manifests m WHERE m.owner_scope_id=p.owner_scope_id AND m.context_packet_id=p.id)`,
    [owner])).rows[0].n).toBe(0);
});
