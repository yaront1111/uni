import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { runMigrations } from '@unai/postgres';
import { postgresAdapter, SESSION_COOKIE } from '@unai/auth';
import { createPlatformApi } from './platform.js';

/**
 * POST /v1/ask over the real boundary (design API surface; CRT-RD-12-A at the
 * route). `packages/context/src/answering.test.ts` covers the eight answer types
 * end to end; what is under test here is the HTTP path: the route's purpose, the
 * refusal of an incomplete or forged request before any retrieval, the refusal of
 * a purpose the evidence does not admit, and an answer carrying its classified
 * type, labelled statements and source links.
 */

if (!process.env.UNAI_TEST_DATABASE_URL) throw new Error('Run pnpm test for the required PostgreSQL harness');
const admin = new Pool({ connectionString: process.env.UNAI_TEST_DATABASE_URL });
const url = new URL(process.env.UNAI_TEST_DATABASE_URL); url.username = 'ask_api_test_app'; url.password = 'test-only';
const appPool = new Pool({ connectionString: url.href });

const FINANCE = 'PERSONAL_FINANCE';
const RECORDED_AT = new Date('2026-02-01T09:00:00.000Z');
let owner = '', token = '', actor = '';
const evidenceIds: string[] = [];

beforeAll(async () => {
  await runMigrations(admin, resolve('migrations'));
  await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='ask_api_test_app') THEN CREATE ROLE ask_api_test_app LOGIN PASSWORD 'test-only'; END IF; END $$; GRANT unai_app TO ask_api_test_app");
  const adapter = postgresAdapter(admin);
  const user = await adapter.createUser!({ name: 'Ask', email: 'ask-api@example.test', emailVerified: null });
  actor = user.id;
  owner = (user as unknown as { ownerScopeId: string }).ownerScopeId;
  token = randomBytes(32).toString('base64url');
  await adapter.createSession!({ userId: user.id, sessionToken: token, expires: new Date(Date.now() + 604800000) });

  const context = (await admin.query("SELECT id FROM context_spaces WHERE owner_scope_id=$1 AND context_kind='BASE'", [owner])).rows[0].id;
  const transactionId = randomUUID();
  await admin.query(`INSERT INTO belief_transactions(id,owner_scope_id,transaction_kind,requested_by_actor_id,
    source_evidence_ids,registry_release_id,status,risk,idempotency_key,commit_receipt,committed_at)
    VALUES($1,$2,'CANONICALIZE',$3,'{}',$4,'COMMITTED','LOW',$5,'{}',$6)`,
    [transactionId, owner, actor, randomUUID(), randomUUID().replaceAll('-', ''), RECORDED_AT]);
  const frame = randomUUID(), slot = randomUUID();
  await admin.query("INSERT INTO frame_instances(id,owner_scope_id,frame_type_id,context_space_id) VALUES($1,$2,'shared.obligation',$3)",
    [frame, owner, context]);
  await admin.query(`INSERT INTO belief_slots(id,owner_scope_id,frame_instance_id,predicate_id,context_space_id,modality)
    VALUES($1,$2,$3,'shared.obligation.description',$4,'ACTUAL')`, [slot, owner, frame, context]);
  // Two sources that disagree about what the loan was for.
  for (const [externalId, text] of [['api-ask-chat', 'loan to repair the car'], ['api-ask-document', 'loan to cover the rent']]) {
    const evidenceId = randomUUID(), anchorId = randomUUID(), connectorId = randomUUID(), propositionId = randomUUID();
    await admin.query("INSERT INTO connectors(id,owner_scope_id,connector_type,external_account_ref,permission_manifest,status) VALUES($1,$2,'CONVERSATION',$3,'{}','ACTIVE')",
      [connectorId, owner, externalId]);
    await admin.query(`INSERT INTO source_items(id,owner_scope_id,connector_id,source_type,external_id,actor_ref,submitted_by_user_id,
      raw_object_ref,content_hash,sensitivity,allowed_purposes,ingestion_version,idempotency_key,occurred_at)
      VALUES($1,$2,$3,'CONVERSATION',$4,$5,$6,$7,$8,'PRIVATE',ARRAY[$9],'evidence-json-v1',$10,$11)`,
      [evidenceId, owner, connectorId, externalId, JSON.stringify({ type: 'USER', id: actor }), actor, randomUUID(),
        randomUUID().replaceAll('-', '').padEnd(64, 'a').slice(0, 64), FINANCE, randomUUID(), RECORDED_AT]);
    await admin.query(`INSERT INTO source_anchors(id,owner_scope_id,source_item_id,anchor_kind,anchor)
      VALUES($1,$2,$3,'MESSAGE_SPAN','{"start":0,"end":20}')`, [anchorId, owner, evidenceId]);
    await admin.query('INSERT INTO propositions(id,owner_scope_id,belief_slot_id,normalized_value) VALUES($1,$2,$3,$4)',
      [propositionId, owner, slot, JSON.stringify({ text })]);
    await admin.query(`INSERT INTO claims(id,owner_scope_id,source_anchor_id,proposition_id,claim_origin,lifecycle,recorded_at)
      VALUES($1,$2,$3,$4,'USER_STATEMENT','PROVISIONAL',$5)`, [randomUUID(), owner, anchorId, propositionId, RECORDED_AT]);
    await admin.query(`INSERT INTO belief_assessments(id,owner_scope_id,proposition_id,assessment_status,policy_version,
      transaction_id,decision_reason,recorded_at) VALUES($1,$2,$3,'CONTESTED','local-policy-0.1.0',$4,'{"code":"FIXTURE"}',$5)`,
      [randomUUID(), owner, propositionId, transactionId, RECORDED_AT]);
    evidenceIds.push(evidenceId);
  }
});
afterAll(async () => { await appPool.end(); await admin.end(); });

function api() {
  const app = createPlatformApi({ authPool: admin, appPool, registryReleaseId: randomUUID(), registryRelease: '0.1.0' });
  app.addHook('onRequest', async request => { Object.defineProperty(request.raw.socket, 'encrypted', { value: true }); });
  return app;
}
const headers = (purpose = 'memory.read') => ({
  cookie: SESSION_COOKIE + '=' + token, 'x-owner-scope-id': owner, 'x-purpose': purpose,
  'x-correlation-id': randomUUID(), 'idempotency-key': randomBytes(16).toString('hex'),
});
const body = (over: Record<string, unknown> = {}) => ({
  ownerScopeId: owner, question: 'Does anything I recorded about the loan contradict itself?', purpose: FINANCE,
  worldTime: 'NOW', knowledgeTime: 'LATEST', maximumSensitivity: 'PRIVATE', ...over,
});
const packets = async () => (await admin.query('SELECT count(*)::int AS n FROM context_packets WHERE owner_scope_id=$1', [owner])).rows[0].n;

it('CRT-RD-12-A: POST /v1/ask answers with the classified type, labelled statements and source links', async () => {
  const app = api();
  try {
    const response = await app.inject({ method: 'POST', url: '/v1/ask', headers: headers(), payload: body() });
    expect(response.statusCode, response.body).toBe(200);
    const answer = response.json();
    expect(answer).toMatchObject({ answerType: 'CONTRADICTION_CHECK', queryMode: 'CONTRADICTION_DETECTION',
      composer: { kind: 'DETERMINISTIC_COMPOSER', modelCalled: false } });
    const conflict = answer.statements.find((statement: { kind: string }) => statement.kind === 'CONFLICT');
    expect(conflict).toMatchObject({ label: 'CONFLICTING', sourceEvidenceIds: [...evidenceIds].sort() });
    expect(answer.sourceLinks.map((link: { evidenceId: string }) => link.evidenceId).sort()).toEqual([...evidenceIds].sort());
    expect(answer.sourceLinks[0].href).toMatch(/^\/v1\/evidence\/[0-9a-f-]{36}$/);
    // The packet the answer rests on is the broker's own record.
    expect((await admin.query('SELECT answer_type_classification FROM context_packets WHERE id=$1', [answer.packetId])).rows[0])
      .toEqual({ answer_type_classification: 'CONTRADICTION_DETECTION' });
    // No private storage key or session material leaves the route.
    expect(JSON.stringify(answer)).not.toMatch(/raw_object_ref|object_store_key|token/i);
    // With no release this deployment knows, nothing is selected as current: the
    // current-state answer says it does not know rather than naming a value.
    const current = (await app.inject({ method: 'POST', url: '/v1/ask', headers: headers(),
      payload: body({ question: 'Do I still owe Daniel?' }) })).json();
    expect(current.answerType).toBe('CURRENT_STATE');
    expect(current.declinesToAssert).toBe(true);
  } finally { await app.close(); }
});

it('CRT-RD-12-A: POST /v1/ask refuses an incomplete, forged or unpermitted request before retrieval', async () => {
  const app = api();
  try {
    for (const field of ['ownerScopeId', 'question', 'purpose', 'worldTime', 'knowledgeTime', 'maximumSensitivity']) {
      const before = await packets();
      const payload: Record<string, unknown> = body(); delete payload[field];
      const response = await app.inject({ method: 'POST', url: '/v1/ask', headers: headers(), payload });
      expect(response.statusCode, field).toBe(400);
      expect(response.json(), field).toMatchObject({ code: 'ASK_REQUEST_INCOMPLETE', missing: [field] });
      expect(await packets(), field).toBe(before);
    }
    // The owner scope and the actor are the session's.
    for (const forged of [{ ownerScopeId: randomUUID() }, { requestingActorId: randomUUID() }]) {
      const response = await app.inject({ method: 'POST', url: '/v1/ask', headers: headers(), payload: body(forged) });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('ASK_REQUEST_INVALID');
    }
    // The route holds its own purpose.
    expect((await app.inject({ method: 'POST', url: '/v1/ask', headers: headers('memory.inspect'), payload: body() })).statusCode).toBe(403);
    // A purpose the evidence does not admit is refused, and the refusal is recorded.
    const denied = await app.inject({ method: 'POST', url: '/v1/ask', headers: headers(), payload: body({ purpose: 'ADVERTISING' }) });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: 'CONTEXT_READ_DENIED', reason: 'PURPOSE_NOT_IN_ALLOWED_PURPOSES' });
    expect((await admin.query(`SELECT outcome FROM policy_decisions WHERE owner_scope_id=$1 AND port='EvaluateMemoryRead'
      AND reason='PURPOSE_NOT_IN_ALLOWED_PURPOSES'`, [owner])).rows.length).toBeGreaterThan(0);
  } finally { await app.close(); }
});
