import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { runMigrations } from '@unai/postgres';
import { postgresAdapter, SESSION_COOKIE } from '@unai/auth';
import { createPlatformApi } from './platform.js';

/**
 * The Context Broker and the inspection reads over the real boundary
 * (POST /v1/memory/context, GET /v1/memory/propositions/{id}/explain,
 * GET /v1/memory/threads/{id}, POST /v1/memory/threads/{id}/members).
 *
 * `packages/context/src/context.test.ts` covers the assembly itself. What is
 * under test here is the HTTP path: that a request missing a declaration is
 * refused before any retrieval, that a purpose the evidence does not admit is
 * denied and the denial is kept, that a PRIVATE request lists rather than
 * receives a RESTRICTED object, that the explanation answers its nine sections,
 * and that one object joins two threads without a second evidence row.
 *
 * Covers CRT-RD-02-A, CRT-RD-05-A, CRT-RD-09-A, CRT-RD-10-A, CRT-SEC-02-A and
 * CRT-SEC-09-A at the route.
 */

if (!process.env.UNAI_TEST_DATABASE_URL) throw new Error('Run pnpm test for the required PostgreSQL harness');
const admin = new Pool({ connectionString: process.env.UNAI_TEST_DATABASE_URL });
const url = new URL(process.env.UNAI_TEST_DATABASE_URL); url.username = 'context_api_test_app'; url.password = 'test-only';
const appPool = new Pool({ connectionString: url.href });

const FINANCE = 'PERSONAL_FINANCE', FAMILY = 'FAMILY_COORDINATION';
/** Before the fixture's claims and assessments, so the knowledge time a request
 * leaves at LATEST admits them whatever day the suite runs. */
const RECORDED_AT = new Date('2026-02-01T09:00:00.000Z');

let owner = '', token = '', actor = '', registryReleaseId = '';
let obligationFrame = '', principalSlot = '', acceptedProposition = '', competingProposition = '';
let sharedEvidence = '', restrictedEvidence = '', restrictedProposition = '';
let financeThread = '', familyThread = '', danielId = '';

async function evidence(input: { sensitivity: string; purposes: string[]; externalId: string }): Promise<{ evidenceId: string; anchorId: string }> {
  const evidenceId = randomUUID(), anchorId = randomUUID(), connectorId = randomUUID();
  await admin.query("INSERT INTO connectors(id,owner_scope_id,connector_type,external_account_ref,permission_manifest,status) VALUES($1,$2,'CONVERSATION',$3,'{}','ACTIVE')",
    [connectorId, owner, input.externalId]);
  await admin.query(`INSERT INTO source_items(id,owner_scope_id,connector_id,source_type,external_id,actor_ref,submitted_by_user_id,
    raw_object_ref,content_hash,sensitivity,allowed_purposes,ingestion_version,idempotency_key,occurred_at)
    VALUES($1,$2,$3,'CONVERSATION',$4,$5,$6,$7,$8,$9,$10,'evidence-json-v1',$11,$12)`,
    [evidenceId, owner, connectorId, input.externalId, JSON.stringify({ type: 'USER', id: actor }), actor, randomUUID(),
      randomUUID().replaceAll('-', '').padEnd(64, 'a').slice(0, 64), input.sensitivity, input.purposes, randomUUID(),
      new Date('2026-02-01T08:00:00.000Z')]);
  await admin.query(`INSERT INTO source_anchors(id,owner_scope_id,source_item_id,anchor_kind,anchor,normalized_text)
    VALUES($1,$2,$3,'MESSAGE_SPAN','{"start":0,"end":20}',$4)`, [anchorId, owner, evidenceId, input.externalId]);
  return { evidenceId, anchorId };
}

async function proposition(input: {
  beliefSlotId: string; value: unknown; anchorId: string; assessment?: string | null; transactionId: string;
}): Promise<string> {
  const propositionId = randomUUID(), claimId = randomUUID();
  await admin.query('INSERT INTO propositions(id,owner_scope_id,belief_slot_id,normalized_value) VALUES($1,$2,$3,$4)',
    [propositionId, owner, input.beliefSlotId, JSON.stringify(input.value)]);
  await admin.query(`INSERT INTO proposition_fingerprints(id,owner_scope_id,proposition_id,registry_release_id,
    normalization_version,fingerprint,descriptor) VALUES($1,$2,$3,$4,'normalization-1',$5,'{}')`,
    [randomUUID(), owner, propositionId, registryReleaseId, randomUUID().replaceAll('-', '').padEnd(64, 'b').slice(0, 64)]);
  await admin.query(`INSERT INTO claims(id,owner_scope_id,source_anchor_id,proposition_id,claim_origin,lifecycle,valid_from,recorded_at)
    VALUES($1,$2,$3,$4,'USER_STATEMENT','PROVISIONAL',$5,$6)`,
    [claimId, owner, input.anchorId, propositionId, new Date('2026-02-01T08:00:00.000Z'), RECORDED_AT]);
  if (input.assessment) {
    await admin.query(`INSERT INTO belief_assessments(id,owner_scope_id,proposition_id,assessment_status,policy_version,
      transaction_id,decision_reason,recorded_at) VALUES($1,$2,$3,$4,'local-policy-0.1.0',$5,'{"code":"FIXTURE"}',$6)`,
      [randomUUID(), owner, propositionId, input.assessment, input.transactionId, RECORDED_AT]);
    await admin.query(`INSERT INTO belief_support(id,owner_scope_id,proposition_id,claim_id,support_kind,
      independence_group,created_by_transaction_id) VALUES($1,$2,$3,$4,'DIRECT_ASSERTION',$5,$6)`,
      [randomUUID(), owner, propositionId, claimId, 'source:' + input.anchorId.slice(0, 8), input.transactionId]);
  }
  return propositionId;
}

beforeAll(async () => {
  await runMigrations(admin, resolve('migrations'));
  await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='context_api_test_app') THEN CREATE ROLE context_api_test_app LOGIN PASSWORD 'test-only'; END IF; END $$; GRANT unai_app TO context_api_test_app");
  const adapter = postgresAdapter(admin);
  const user = await adapter.createUser!({ name: 'Context', email: 'context-api@example.test', emailVerified: null });
  actor = user.id;
  owner = (user as unknown as { ownerScopeId: string }).ownerScopeId;
  token = randomBytes(32).toString('base64url');
  await adapter.createSession!({ userId: user.id, sessionToken: token, expires: new Date(Date.now() + 604800000) });

  const contextSpaceId = (await admin.query("SELECT id FROM context_spaces WHERE owner_scope_id=$1 AND context_kind='BASE'", [owner])).rows[0].id;
  registryReleaseId = randomUUID();
  const transactionId = randomUUID();
  await admin.query(`INSERT INTO belief_transactions(id,owner_scope_id,transaction_kind,requested_by_actor_id,
    source_evidence_ids,registry_release_id,status,risk,idempotency_key,commit_receipt,committed_at)
    VALUES($1,$2,'CANONICALIZE',$3,'{}',$4,'COMMITTED','LOW',$5,'{}',$6)`,
    [transactionId, owner, actor, registryReleaseId, randomUUID().replaceAll('-', ''), RECORDED_AT]);

  // One evidence row that admits finance *and* family, and one RESTRICTED item.
  const shared = await evidence({ sensitivity: 'PRIVATE', purposes: [FINANCE, FAMILY], externalId: 'api-shared' });
  sharedEvidence = shared.evidenceId;
  const second = await evidence({ sensitivity: 'PRIVATE', purposes: [FINANCE], externalId: 'api-second' });
  const restricted = await evidence({ sensitivity: 'RESTRICTED', purposes: [FINANCE], externalId: 'api-restricted' });
  restrictedEvidence = restricted.evidenceId;

  danielId = randomUUID();
  await admin.query("INSERT INTO entities(id,owner_scope_id,entity_kind,canonical_label) VALUES($1,$2,'PERSON','Daniel')", [danielId, owner]);
  await admin.query(`INSERT INTO entity_aliases(id,owner_scope_id,entity_id,alias_type,alias_value,normalized_value,source_item_id,created_at)
    VALUES($1,$2,$3,'DISPLAY_NAME','Daniel','daniel',$4,$5)`, [randomUUID(), owner, danielId, sharedEvidence, RECORDED_AT]);

  obligationFrame = randomUUID();
  const commitmentFrame = randomUUID();
  await admin.query("INSERT INTO frame_instances(id,owner_scope_id,frame_type_id,context_space_id) VALUES($1,$2,'shared.obligation',$3),($4,$2,'shared.commitment',$3)",
    [obligationFrame, owner, contextSpaceId, commitmentFrame]);

  principalSlot = randomUUID();
  const restrictedSlot = randomUUID();
  await admin.query(`INSERT INTO belief_slots(id,owner_scope_id,frame_instance_id,predicate_id,context_space_id,modality)
    VALUES($1,$2,$3,'shared.obligation.principal_amount',$4,'ACTUAL'),($5,$2,$6,'shared.commitment.due_time',$4,'ACTUAL')`,
    [principalSlot, owner, obligationFrame, contextSpaceId, restrictedSlot, commitmentFrame]);

  // Two live values in one slot: the conflict the packet reports.
  acceptedProposition = await proposition({ beliefSlotId: principalSlot, value: { amount: '50.00', currency: 'ILS' },
    anchorId: shared.anchorId, assessment: 'ACCEPTED', transactionId });
  await admin.query(`INSERT INTO frame_instance_roles(id,owner_scope_id,frame_instance_id,role_id,entity_id,claim_id,created_at)
    SELECT $1,$2,$3,'creditor',$4,c.id,$6 FROM claims c
    WHERE c.owner_scope_id=$2 AND c.proposition_id=$5 ORDER BY c.id LIMIT 1`,
    [randomUUID(), owner, obligationFrame, danielId, acceptedProposition, RECORDED_AT]);
  competingProposition = await proposition({ beliefSlotId: principalSlot, value: { amount: '60.00', currency: 'ILS' },
    anchorId: second.anchorId, assessment: 'PROVISIONAL', transactionId });
  // A value whose only support is RESTRICTED.
  restrictedProposition = await proposition({ beliefSlotId: restrictedSlot, value: { time: '2026-04-01T00:00:00.000Z' },
    anchorId: restricted.anchorId, assessment: 'ACCEPTED', transactionId });

  // A pending owner assertion and an incomplete projection, so the packet has
  // something to be incomplete about (CRT-RD-05-A).
  await admin.query(`INSERT INTO owner_overlay_deltas(id,owner_scope_id,owner_sequence,source_evidence_id,raw_text,
    delta_kind,lifecycle,candidate_entity_refs,candidate_frame_types)
    VALUES($1,$2,1,$3,'I paid him back','USER_ASSERTION','AWAITING_INSTANCE_RESOLUTION',ARRAY[$4::uuid],ARRAY['shared.obligation'])`,
    [randomUUID(), owner, sharedEvidence, danielId]);
  await admin.query(`INSERT INTO obligations_projection(owner_scope_id,obligation_frame_instance_id,debtor_entity_id,
    creditor_entity_id,principal_amount,currency,total_canonical_allocation,remaining_amount_capability_derived,
    outcome_state,conflict_flag,overlay_complete,projection_version,canonical_transaction_watermark,
    owner_overlay_watermark,reducer_version,is_complete,source_manifest,updated_at)
    VALUES($1,$2,$3,$3,50.00,'ILS',0,50.00,'UNRESOLVED',true,true,$4,$5,0,'projection-reducers-0.1.0',true,'{}',$5)`,
    [owner, obligationFrame, danielId, randomUUID(), RECORDED_AT]);

  financeThread = randomUUID(); familyThread = randomUUID();
  await admin.query("INSERT INTO memory_threads(id,owner_scope_id,display_title) VALUES($1,$2,'Daniel loan'),($3,$2,'Family money')",
    [financeThread, owner, familyThread]);
});
afterAll(async () => { await appPool.end(); await admin.end(); });

function api() {
  const app = createPlatformApi({ authPool: admin, appPool, registryReleaseId, registryRelease: '0.1.0' });
  app.addHook('onRequest', async request => { Object.defineProperty(request.raw.socket, 'encrypted', { value: true }); });
  return app;
}
const headers = (purpose: string, extra: Record<string, string> = {}) => ({
  cookie: SESSION_COOKIE + '=' + token, 'x-owner-scope-id': owner, 'x-purpose': purpose,
  'x-correlation-id': randomUUID(), 'idempotency-key': randomBytes(16).toString('hex'), ...extra,
});
const inspectHeaders = (purpose = 'memory.inspect') =>
  headers(purpose, { 'x-data-purpose': FINANCE, 'x-maximum-sensitivity': 'RESTRICTED' });
const body = (overrides: Record<string, unknown> = {}) => ({
  ownerScopeId: owner, requestingActorId: actor, purpose: FINANCE, query: 'Do I still owe Daniel?',
  worldTime: 'NOW', knowledgeTime: 'LATEST', maximumSensitivity: 'RESTRICTED', actionRisk: 'MEDIUM', ...overrides,
});

it('CRT-RD-02-A: POST /v1/memory/context refuses a request missing any declaration before retrieval', async () => {
  const app = api();
  try {
    for (const field of ['purpose', 'requestingActorId', 'ownerScopeId', 'worldTime', 'knowledgeTime',
      'maximumSensitivity', 'actionRisk']) {
      const before = (await admin.query('SELECT count(*)::int AS n FROM context_packets WHERE owner_scope_id=$1', [owner])).rows[0].n;
      const payload = body(); delete (payload as Record<string, unknown>)[field];
      const response = await app.inject({ method: 'POST', url: '/v1/memory/context', headers: headers('memory.read'), payload });
      expect(response.statusCode, field + ' ' + response.body).toBe(400);
      expect(response.json(), field).toMatchObject({ code: 'CONTEXT_REQUEST_INCOMPLETE', missing: [field] });
      // Nothing was retrieved and nothing was recorded: the refusal happens before
      // the broker's first transaction opens.
      expect((await admin.query('SELECT count(*)::int AS n FROM context_packets WHERE owner_scope_id=$1', [owner])).rows[0].n, field).toBe(before);
    }
    // A body naming another owner scope or another actor is refused, not obeyed:
    // the authority is the session's.
    for (const forged of [{ ownerScopeId: randomUUID() }, { requestingActorId: randomUUID() }]) {
      const response = await app.inject({ method: 'POST', url: '/v1/memory/context', headers: headers('memory.read'), payload: body(forged) });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('CONTEXT_REQUEST_INVALID');
    }
    // And the route holds its own purpose.
    const wrongPurpose = await app.inject({ method: 'POST', url: '/v1/memory/context', headers: headers('memory.inspect'), payload: body() });
    expect(wrongPurpose.statusCode).toBe(403);
  } finally { await app.close(); }
});

it('CRT-SEC-02-A: POST /v1/memory/context denies a purpose absent from the evidence allowed purposes', async () => {
  const app = api();
  try {
    const response = await app.inject({ method: 'POST', url: '/v1/memory/context', headers: headers('memory.read'),
      payload: body({ purpose: 'ADVERTISING' }) });
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json()).toMatchObject({ code: 'CONTEXT_READ_DENIED', reason: 'PURPOSE_NOT_IN_ALLOWED_PURPOSES' });
    // The denial is kept: the verdict commits in its own transaction before the
    // refusal is raised, so the Audit log can show a read that was turned down.
    const decision = (await admin.query(
      `SELECT outcome,reason FROM policy_decisions WHERE owner_scope_id=$1 AND port='EvaluateMemoryRead'
         AND reason='PURPOSE_NOT_IN_ALLOWED_PURPOSES' ORDER BY created_at DESC LIMIT 1`, [owner])).rows[0];
    expect(decision).toMatchObject({ outcome: 'DENY', reason: 'PURPOSE_NOT_IN_ALLOWED_PURPOSES' });
    expect((await admin.query("SELECT count(*)::int AS n FROM context_packets WHERE owner_scope_id=$1 AND purpose='ADVERTISING'", [owner])).rows[0].n).toBe(0);

    // The action half, on the same route. The broker is the only memory read path
    // a model or a plugin has, so an action founded on memory is declared here and
    // gated here: this packet rests on evidence that does not all admit
    // FAMILY_COORDINATION, so the draft declaring it is refused and no packet is
    // issued for it.
    const before = (await admin.query('SELECT count(*)::int AS n FROM context_packets WHERE owner_scope_id=$1', [owner])).rows[0].n;
    const denied = await app.inject({ method: 'POST', url: '/v1/memory/context', headers: headers('memory.read'),
      payload: body({ intendedAction: { actionKind: 'DRAFT', actionPurpose: FAMILY, capabilityGranted: true } }) });
    expect(denied.statusCode, denied.body).toBe(403);
    expect(denied.json()).toMatchObject({ code: 'CONTEXT_ACTION_DENIED', reason: 'PURPOSE_NOT_IN_ALLOWED_PURPOSES' });
    expect((await admin.query('SELECT count(*)::int AS n FROM context_packets WHERE owner_scope_id=$1', [owner])).rows[0].n).toBe(before);
    expect((await admin.query(
      `SELECT outcome,reason FROM policy_decisions WHERE owner_scope_id=$1 AND port='EvaluateMemoryAction'
         ORDER BY created_at DESC,id DESC LIMIT 1`, [owner])).rows[0])
      .toMatchObject({ outcome: 'DENY', reason: 'PURPOSE_NOT_IN_ALLOWED_PURPOSES' });

    // A purpose every one of those items admits is decided on the action's merits.
    const permitted = await app.inject({ method: 'POST', url: '/v1/memory/context', headers: headers('memory.read'),
      payload: body({ intendedAction: { actionKind: 'DRAFT', actionPurpose: FINANCE, capabilityGranted: true } }) });
    expect(permitted.statusCode, permitted.body).toBe(201);
    expect(permitted.json().actionDecision).toMatchObject({ actionKind: 'DRAFT', actionPurpose: FINANCE });
  } finally { await app.close(); }
});

it('CRT-RD-05-A: POST /v1/memory/context answers a packet with conflicts, unknowns, overlay deltas, completeness and watermarks', async () => {
  const app = api();
  try {
    const response = await app.inject({ method: 'POST', url: '/v1/memory/context', headers: headers('memory.read'),
      payload: body({ entityHints: [danielId], frameTypeHints: ['shared.obligation'] }) });
    expect(response.statusCode, response.body).toBe(201);
    const packet = response.json();
    expect(packet.conflicts.length).toBeGreaterThan(0);
    expect(packet.conflicts[0].positions.map((position: { propositionId: string }) => position.propositionId).sort())
      .toEqual([acceptedProposition, competingProposition].sort());
    expect(packet.unknowns.some((unknown: { kind: string }) => unknown.kind === 'UNATTACHED_OWNER_ASSERTION')).toBe(true);
    expect(packet.ownerOverlayDeltas.length).toBeGreaterThan(0);
    expect(packet.projectionFragments.map((fragment: { projectionName: string }) => fragment.projectionName).sort())
      .toEqual(['obligations_projection', 'open_commitments_projection', 'schedule_projection']);
    expect(packet.projectionFragments.every((fragment: { isComplete: boolean }) => typeof fragment.isComplete === 'boolean')).toBe(true);
    expect(Number.isInteger(packet.watermarks.ownerOverlayWatermark)).toBe(true);
    expect(packet.watermarks.registryRelease).toBe('0.1.0');
    expect(packet.selectionReason.selectorVersion).toMatch(/^deterministic-selector/);
    expect(packet.packetHash).toMatch(/^[a-f0-9]{64}$/);
    // The packet is recorded under the request that produced it.
    const stored = (await admin.query('SELECT packet_hash,purpose,registry_release_id FROM context_packets WHERE id=$1', [packet.packetId])).rows[0];
    expect(stored).toMatchObject({ packet_hash: packet.packetHash, purpose: FINANCE, registry_release_id: registryReleaseId });
  } finally { await app.close(); }
});

it('CRT-SEC-09-A: a PRIVATE context request receives no RESTRICTED object and lists it only as a redaction', async () => {
  const app = api();
  try {
    const response = await app.inject({ method: 'POST', url: '/v1/memory/context', headers: headers('memory.read'),
      payload: body({ maximumSensitivity: 'PRIVATE', includeEvidence: 'ALWAYS' }) });
    expect(response.statusCode, response.body).toBe(201);
    const packet = response.json();
    const supplied = [...packet.currentBeliefs, ...packet.historicalBeliefs]
      .map((belief: { propositionId: string }) => belief.propositionId);
    expect(supplied).not.toContain(restrictedProposition);
    expect(packet.evidenceRefs.every((reference: { sensitivity: string }) => reference.sensitivity !== 'RESTRICTED')).toBe(true);
    expect(packet.redactions).toContainEqual({ objectType: 'source_items', objectId: restrictedEvidence,
      fields: [], reason: 'ABOVE_MAXIMUM_SENSITIVITY' });
    expect(packet.redactions).toContainEqual({ objectType: 'propositions', objectId: restrictedProposition,
      fields: [], reason: 'SUPPORTING_EVIDENCE_WITHHELD' });
    expect(JSON.stringify(packet)).not.toContain('2026-04-01T00:00:00.000Z');
  } finally { await app.close(); }
});

it('CRT-RD-09-A: GET /v1/memory/propositions/{id}/explain answers the assessment, claims, anchors, support, contradictions, history and versions', async () => {
  const app = api();
  try {
    const response = await app.inject({ method: 'GET', url: '/v1/memory/propositions/' + acceptedProposition + '/explain',
      headers: inspectHeaders() });
    expect(response.statusCode, response.body).toBe(200);
    const explanation = response.json();
    expect(explanation.currentAssessment.assessmentStatus).toBe('ACCEPTED');
    expect(explanation.claims.length).toBeGreaterThan(0);
    expect(explanation.evidenceAnchors.map((anchor: { evidenceId: string }) => anchor.evidenceId)).toContain(sharedEvidence);
    expect(explanation.supportGraph.length).toBeGreaterThan(0);
    expect(explanation.independenceGroups.length).toBeGreaterThan(0);
    expect(explanation.contradictions.some((entry: { kind: string; objectId: string }) =>
      entry.kind === 'COMPETING_PROPOSITION' && entry.objectId === competingProposition)).toBe(true);
    expect(explanation.temporalHistory.length).toBeGreaterThan(0);
    expect(explanation.registryVersions).toMatchObject({ registryReleaseId, registryRelease: '0.1.0' });
    expect(explanation.projectionConsumers.map((consumer: { projectionName: string }) => consumer.projectionName))
      .toContain('obligations_projection');
    expect(explanation.explanationVersion).toMatch(/^belief-explanation/);

    const missing = await app.inject({ method: 'GET', url: '/v1/memory/propositions/' + randomUUID() + '/explain', headers: inspectHeaders() });
    expect(missing.statusCode).toBe(404);
    const malformed = await app.inject({ method: 'GET', url: '/v1/memory/propositions/not-a-uuid/explain', headers: inspectHeaders() });
    expect(malformed.statusCode).toBe(400);
    const wrongPurpose = await app.inject({ method: 'GET', url: '/v1/memory/propositions/' + acceptedProposition + '/explain',
      headers: inspectHeaders('memory.read') });
    expect(wrongPurpose.statusCode).toBe(403);
  } finally { await app.close(); }
});

it('CRT-RD-10-A: POST /v1/memory/threads/{id}/members puts one object in two threads without a second evidence row', async () => {
  const app = api();
  try {
    const before = (await admin.query('SELECT count(*)::int AS n FROM source_items WHERE owner_scope_id=$1', [owner])).rows[0].n;
    const beforeClaims = (await admin.query('SELECT count(*)::int AS n FROM claims WHERE owner_scope_id=$1', [owner])).rows[0].n;

    const attach = (threadId: string, membershipKind: string) => app.inject({
      method: 'POST', url: '/v1/memory/threads/' + threadId + '/members', headers: headers('memory.thread'),
      payload: { objectType: 'frame_instance', objectId: obligationFrame, membershipKind },
    });
    expect((await attach(financeThread, 'SUBJECT')).statusCode).toBe(201);
    expect((await attach(familyThread, 'RELATED')).statusCode).toBe(201);
    // Repeating the attach is the same single row, answered 200 rather than 201.
    expect((await attach(familyThread, 'RELATED')).statusCode).toBe(200);

    const financeView = (await app.inject({ method: 'GET', url: '/v1/memory/threads/' + financeThread, headers: inspectHeaders() })).json();
    const familyView = (await app.inject({ method: 'GET', url: '/v1/memory/threads/' + familyThread, headers: inspectHeaders() })).json();
    for (const view of [financeView, familyView]) {
      expect(view.members.map((member: { objectId: string }) => member.objectId)).toContain(obligationFrame);
      expect(view.evidenceIds).toContain(sharedEvidence);
    }
    // The same evidence, read from the object's own claims, in both threads.
    expect([...financeView.evidenceIds].sort()).toEqual([...familyView.evidenceIds].sort());
    expect(financeView.currentProjection.map((fragment: { projectionName: string }) => fragment.projectionName))
      .toContain('obligations_projection');
    expect(financeView.relatedPeople.map((person: { entityId: string }) => person.entityId)).toContain(danielId);

    // And nothing was created by joining a second thread.
    expect((await admin.query('SELECT count(*)::int AS n FROM source_items WHERE owner_scope_id=$1', [owner])).rows[0].n).toBe(before);
    expect((await admin.query('SELECT count(*)::int AS n FROM claims WHERE owner_scope_id=$1', [owner])).rows[0].n).toBe(beforeClaims);
    expect((await admin.query('SELECT count(*)::int AS n FROM memory_thread_members WHERE owner_scope_id=$1 AND object_id=$2',
      [owner, obligationFrame])).rows[0].n).toBe(2);

    const unknownThread = await app.inject({ method: 'POST', url: '/v1/memory/threads/' + randomUUID() + '/members',
      headers: headers('memory.thread'), payload: { objectType: 'frame_instance', objectId: obligationFrame, membershipKind: 'SUBJECT' } });
    expect(unknownThread.statusCode).toBe(404);
    const unknownObject = await app.inject({ method: 'POST', url: '/v1/memory/threads/' + financeThread + '/members',
      headers: headers('memory.thread'), payload: { objectType: 'proposition', objectId: randomUUID(), membershipKind: 'RELATED' } });
    expect(unknownObject.statusCode).toBe(404);
    const malformed = await app.inject({ method: 'POST', url: '/v1/memory/threads/' + financeThread + '/members',
      headers: headers('memory.thread'), payload: { objectType: 'moon', objectId: obligationFrame, membershipKind: 'SUBJECT' } });
    expect(malformed.statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/v1/memory/threads/' + randomUUID(), headers: inspectHeaders() })).statusCode).toBe(404);
  } finally { await app.close(); }
});

it('CRT-MEM-02-A: one stored evidence row is served in the finance view and in the family view', async () => {
  const app = api();
  try {
    const rows = (await admin.query('SELECT count(*)::int AS n FROM source_items WHERE owner_scope_id=$1 AND external_id=$2',
      [owner, 'api-shared'])).rows[0].n;
    expect(rows).toBe(1);
    const finance = (await app.inject({ method: 'POST', url: '/v1/memory/context', headers: headers('memory.read'),
      payload: body({ purpose: FINANCE, lifeCategory: 'FINANCE' }) })).json();
    const family = (await app.inject({ method: 'POST', url: '/v1/memory/context', headers: headers('memory.read'),
      payload: body({ purpose: FAMILY, lifeCategory: 'FAMILY' }) })).json();
    const financed = finance.currentBeliefs.find((belief: { propositionId: string }) => belief.propositionId === acceptedProposition);
    const familied = family.currentBeliefs.find((belief: { propositionId: string }) => belief.propositionId === acceptedProposition);
    expect(financed, 'finance view').toBeDefined();
    expect(familied, 'family view').toBeDefined();
    expect(financed.evidenceIds).toEqual([sharedEvidence]);
    expect(familied.evidenceIds).toEqual([sharedEvidence]);
    // Two views, one row: nothing was copied to be shown twice.
    expect((await admin.query('SELECT count(*)::int AS n FROM source_items WHERE owner_scope_id=$1 AND external_id=$2',
      [owner, 'api-shared'])).rows[0].n).toBe(1);
  } finally { await app.close(); }
});
