import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { runMigrations } from '@unai/postgres';
import { postgresAdapter, SESSION_COOKIE } from '@unai/auth';
import { createPlatformApi } from './platform.js';
import type { EvidenceObjects } from './evidence.js';

/** The correction controls over the real boundary: TLS, session, owner scope,
 * purpose, correlation id, idempotency key, evidence gate, then the write.
 *
 * "Two devices" here means two sessions of the same owner. The overlay is scoped
 * to the owner and never to the device that wrote it, which is the whole point of
 * CRT-RYW-02-A and CRT-RYW-02-B.
 */

if (!process.env.UNAI_TEST_DATABASE_URL) throw new Error('Run pnpm test for the required PostgreSQL harness');
const admin = new Pool({ connectionString: process.env.UNAI_TEST_DATABASE_URL });
const url = new URL(process.env.UNAI_TEST_DATABASE_URL); url.username = 'corrections_test_app'; url.password = 'test-only';
const appPool = new Pool({ connectionString: url.href });

const registryReleaseId = randomUUID();
let owner = '', phoneToken = '', desktopToken = '', userId = '';
let propositionId = '', assistantClaimId = '', frameInstanceId = '';
const stored = new Map<string, Uint8Array>();
const evidenceObjects: EvidenceObjects = {
  encryptionKeyRef: 'kms:test-double',
  async put(_tx, id, bytes) { stored.set(id, bytes); },
  async get(_tx, id) { return stored.get(id)!; },
};

beforeAll(async () => {
  await runMigrations(admin, resolve('migrations'));
  await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='corrections_test_app') THEN CREATE ROLE corrections_test_app LOGIN PASSWORD 'test-only'; END IF; END $$; GRANT unai_app TO corrections_test_app");
  const adapter = postgresAdapter(admin);
  const user = await adapter.createUser!({ name: 'Corrections', email: 'corrections@example.test', emailVerified: null });
  userId = user.id;
  owner = (user as unknown as { ownerScopeId: string }).ownerScopeId;
  // One owner, two signed-in devices.
  for (const target of ['phone', 'desktop'] as const) {
    const token = randomBytes(32).toString('base64url');
    await adapter.createSession!({ userId: user.id, sessionToken: token, expires: new Date(Date.now() + 604800000) });
    if (target === 'phone') phoneToken = token; else desktopToken = token;
  }

  const contextSpaceId = (await admin.query("SELECT id FROM context_spaces WHERE owner_scope_id=$1 AND context_kind='BASE'", [owner])).rows[0].id;
  const connectorId = randomUUID(), sourceItemId = randomUUID(), anchorId = randomUUID();
  const slotId = randomUUID(); frameInstanceId = randomUUID(); propositionId = randomUUID(); assistantClaimId = randomUUID();
  await admin.query("INSERT INTO connectors(id,owner_scope_id,connector_type,external_account_ref,permission_manifest,status) VALUES($1,$2,'CONVERSATION',$3,'{}','ACTIVE')", [connectorId, owner, owner]);
  await admin.query(`INSERT INTO source_items(id,owner_scope_id,connector_id,source_type,external_id,actor_ref,submitted_by_user_id,
    raw_object_ref,content_hash,sensitivity,allowed_purposes,ingestion_version,idempotency_key)
    VALUES($1,$2,$3,'CONVERSATION','assistant-message-1',$4,$5,$6,$7,'PRIVATE',ARRAY['PERSONAL_ASSISTANCE'],'evidence-json-v1',$8)`,
    [sourceItemId, owner, connectorId, JSON.stringify({ type: 'ASSISTANT', id: 'uai' }), user.id, randomUUID(), 'a'.repeat(64), randomUUID()]);
  await admin.query(`INSERT INTO source_anchors(id,owner_scope_id,source_item_id,anchor_kind,anchor)
    VALUES($1,$2,$3,'MESSAGE_SPAN','{"start":0,"end":24}')`, [anchorId, owner, sourceItemId]);
  await admin.query("INSERT INTO frame_instances(id,owner_scope_id,frame_type_id,context_space_id) VALUES($1,$2,'shared.obligation',$3)",
    [frameInstanceId, owner, contextSpaceId]);
  await admin.query(`INSERT INTO belief_slots(id,owner_scope_id,frame_instance_id,predicate_id,context_space_id,modality)
    VALUES($1,$2,$3,'shared.obligation.principal_amount',$4,'ACTUAL')`, [slotId, owner, frameInstanceId, contextSpaceId]);
  await admin.query(`INSERT INTO propositions(id,owner_scope_id,belief_slot_id,normalized_value)
    VALUES($1,$2,$3,'{"amount":"50.00","currency":"ILS"}')`, [propositionId, owner, slotId]);
  // The assistant's own statement. Its origin is what must survive a confirmation.
  await admin.query(`INSERT INTO claims(id,owner_scope_id,source_anchor_id,proposition_id,claim_origin,lifecycle)
    VALUES($1,$2,$3,$4,'MODEL_EXTRACTION','PROVISIONAL')`, [assistantClaimId, owner, anchorId, propositionId]);
  const transactionId = randomUUID();
  await admin.query(`INSERT INTO belief_transactions(id,owner_scope_id,transaction_kind,requested_by_actor_id,
    registry_release_id,status,risk,idempotency_key) VALUES($1,$2,'CANONICALIZE',$3,$4,'PROPOSED','LOW',$5)`,
    [transactionId, owner, user.id, registryReleaseId, randomUUID().replaceAll('-', '')]);
  await admin.query(`INSERT INTO belief_assessments(id,owner_scope_id,proposition_id,assessment_status,policy_version,transaction_id)
    VALUES($1,$2,$3,'PROVISIONAL','local-policy-0.1.0',$4)`, [randomUUID(), owner, propositionId, transactionId]);
});
afterAll(async () => { await appPool.end(); await admin.end(); });

function api() {
  const app = createPlatformApi({ authPool: admin, appPool, evidenceObjects, registryReleaseId });
  app.addHook('onRequest', async request => { Object.defineProperty(request.raw.socket, 'encrypted', { value: true }); });
  return app;
}
function headers(token: string, extra: Record<string, string> = {}) {
  return {
    cookie: SESSION_COOKIE + '=' + token, 'x-owner-scope-id': owner, 'x-purpose': 'memory.correct',
    'x-correlation-id': randomUUID(), 'idempotency-key': randomUUID().replaceAll('-', ''),
    'x-data-purpose': 'PERSONAL_ASSISTANCE', 'x-maximum-sensitivity': 'PRIVATE', ...extra,
  };
}
/** Every row version of the tables a correction must not touch. `xmin` changes
 * on any in-place update, so comparing the whole set before and after is a
 * stronger check than counting rows. */
async function rowVersions() {
  const versions: Record<string, Record<string, string>> = {};
  for (const table of ['claims', 'propositions', 'belief_assessments', 'belief_slots', 'frame_instances']) {
    const rows = (await admin.query('SELECT id,xmin::text AS version FROM ' + table + ' WHERE owner_scope_id=$1 ORDER BY id', [owner])).rows;
    versions[table] = Object.fromEntries(rows.map((row: { id: string; version: string }) => [row.id, row.version]));
  }
  return versions;
}

it('CRT-RYW-06-A: a correction creates evidence, an overlay delta and a proposed transaction, and updates no row in place', async () => {
  const app = api();
  try {
    const before = await rowVersions();
    const evidenceBefore = (await admin.query('SELECT count(*)::int n FROM source_items WHERE owner_scope_id=$1', [owner])).rows[0].n;

    const response = await app.inject({
      method: 'POST', url: '/v1/memory/corrections', headers: headers(phoneToken),
      payload: { target: { objectType: 'proposition', objectId: propositionId },
        correctedValue: { amount: '60.00', currency: 'ILS' }, rawText: 'Actually it was ILS 60' },
    });
    expect(response.statusCode, response.body).toBe(201);
    const receipt = response.json();
    expect(receipt).toMatchObject({ operationKind: 'CORRECT', visibilityStatus: 'OWNER_VISIBLE', lifecycle: 'USER_ASSERTED' });
    expect(receipt.ownerSequence).toBeGreaterThan(0);

    // A new evidence row, holding the owner's own words.
    const evidence = (await admin.query('SELECT source_type,external_id,deleted_at FROM source_items WHERE id=$1', [receipt.evidenceId])).rows[0];
    expect(evidence).toMatchObject({ source_type: 'CONVERSATION', deleted_at: null });
    expect((await admin.query('SELECT count(*)::int n FROM source_items WHERE owner_scope_id=$1', [owner])).rows[0].n).toBe(evidenceBefore + 1);

    // An overlay delta carrying that sequence, and a memory operation naming the control.
    const delta = (await admin.query('SELECT owner_sequence,delta_kind,target_object_id,source_evidence_id FROM owner_overlay_deltas WHERE id=$1',
      [receipt.overlayDeltaId])).rows[0];
    expect(delta).toMatchObject({ delta_kind: 'USER_CORRECTION', target_object_id: propositionId, source_evidence_id: receipt.evidenceId });
    expect(Number(delta.owner_sequence)).toBe(receipt.ownerSequence);
    expect((await admin.query('SELECT operation_kind,transaction_id FROM memory_operations WHERE id=$1', [receipt.memoryOperationId])).rows[0])
      .toMatchObject({ operation_kind: 'CORRECT', transaction_id: receipt.proposedTransactionId });

    // A proposed transaction, and nothing committed: a correction asks, it does not decide.
    expect(receipt.proposedTransactionId).toEqual(expect.any(String));
    expect((await admin.query('SELECT status,transaction_kind FROM belief_transactions WHERE id=$1', [receipt.proposedTransactionId])).rows[0])
      .toEqual({ status: 'PROPOSED', transaction_kind: 'CORRECT' });

    // Nothing that existed before was rewritten.
    expect(await rowVersions()).toEqual(before);
  } finally { await app.close(); }
});

it('CRT-AI-03-A: a confirmation creates a USER_CONFIRMATION claim and leaves the confirmed claim\'s origin unchanged', async () => {
  const app = api();
  try {
    const originBefore = (await admin.query('SELECT claim_origin,xmin::text AS version FROM claims WHERE id=$1', [assistantClaimId])).rows[0];
    const response = await app.inject({
      method: 'POST', url: '/v1/memory/confirmations', headers: headers(phoneToken),
      payload: { target: { objectType: 'claim', objectId: assistantClaimId }, confirmedText: 'yes, that is correct' },
    });
    expect(response.statusCode, response.body).toBe(201);
    const receipt = response.json();
    expect(receipt.operationKind).toBe('CONFIRM');
    expect(receipt.createdClaimId).toEqual(expect.any(String));
    expect(receipt.createdClaimId).not.toBe(assistantClaimId);

    const created = (await admin.query('SELECT claim_origin,proposition_id FROM claims WHERE id=$1', [receipt.createdClaimId])).rows[0];
    expect(created).toEqual({ claim_origin: 'USER_CONFIRMATION', proposition_id: propositionId });

    // The assistant's claim is untouched, origin and row version alike.
    expect((await admin.query('SELECT claim_origin,xmin::text AS version FROM claims WHERE id=$1', [assistantClaimId])).rows[0])
      .toEqual(originBefore);
    expect(originBefore.claim_origin).toBe('MODEL_EXTRACTION');
  } finally { await app.close(); }
});

it('[AC44.05] CRT-RYW-02-A: the desktop\'s next read includes the phone\'s acknowledged write and distinguishes assertion from verification', async () => {
  const app = api();
  try {
    const written = await app.inject({
      method: 'POST', url: '/v1/memory/overlay-deltas', headers: headers(phoneToken),
      payload: { deltaKind: 'USER_ASSERTION', rawText: 'I paid him back',
        target: { objectType: 'proposition', objectId: propositionId } },
    });
    expect(written.statusCode, written.body).toBe(201);
    const acknowledged = written.json();
    expect(acknowledged).toMatchObject({ visibilityStatus: 'OWNER_VISIBLE', lifecycle: 'AWAITING_INSTANCE_RESOLUTION' });

    // The very next read, from the other device's session.
    const read = await app.inject({ method: 'GET', url: '/v1/memory/overlay-deltas', headers: headers(desktopToken) });
    expect(read.statusCode, read.body).toBe(200);
    const overlay = read.json();
    const delta = overlay.deltas.find((candidate: { overlayDeltaId: string }) => candidate.overlayDeltaId === acknowledged.overlayDeltaId);
    expect(delta, 'the phone write is in the desktop read').toBeDefined();
    expect(delta.rawText).toBe('I paid him back');
    expect(delta.assertionKind).toBe('USER_ASSERTION');
    // The owner said it; the model's reading of the assistant message is not
    // verification of it, so nothing independent is claimed.
    expect(delta.independentVerification.verified).toBe(false);
    expect(overlay.ownerOverlayWatermark).toBeGreaterThanOrEqual(acknowledged.ownerSequence);
  } finally { await app.close(); }
});

it('CRT-RYW-02-B: a suppression and a deletion acknowledged on one device are honoured by the other device\'s next read', async () => {
  const app = api();
  try {
    const suppression = await app.inject({
      method: 'POST', url: '/v1/memory/suppressions', headers: headers(phoneToken),
      payload: { target: { objectType: 'proposition', objectId: propositionId }, scope: 'OBJECT' },
    });
    expect(suppression.statusCode, suppression.body).toBe(201);
    const deletion = await app.inject({
      method: 'POST', url: '/v1/memory/deletions', headers: headers(phoneToken),
      payload: { target: { objectType: 'frame_instance', objectId: frameInstanceId }, confirmation: 'DELETE' },
    });
    expect(deletion.statusCode, deletion.body).toBe(201);

    const read = await app.inject({ method: 'GET', url: '/v1/memory/overlay-deltas', headers: headers(desktopToken) });
    const overlay = read.json();
    expect(overlay.suppressedTargets).toContainEqual({ objectType: 'proposition', objectId: propositionId });
    expect(overlay.deletedTargets).toContainEqual({ objectType: 'frame_instance', objectId: frameInstanceId });
    // Suppress, archive and delete stay three different promises.
    expect(deletion.json().operationKind).toBe('DELETE');
    expect(suppression.json().operationKind).toBe('SUPPRESS');
  } finally { await app.close(); }
});

it('records a distinct operation kind for each correction control and never a generic edit', async () => {
  const app = api();
  try {
    const calls: Array<[string, Record<string, unknown>, string]> = [
      ['/v1/memory/state-changes', { target: { objectType: 'proposition', objectId: propositionId }, newValue: { amount: '70.00', currency: 'ILS' },
        changeEffectiveFrom: '2026-08-01T00:00:00Z', rawText: 'It changed to ILS 70 on August 1' }, 'CHANGED'],
      ['/v1/memory/rejections', { target: { objectType: 'proposition', objectId: propositionId }, reason: 'That is not what I meant' }, 'REJECT'],
      ['/v1/memory/keep-uncertain', { target: { objectType: 'proposition', objectId: propositionId } }, 'KEEP_UNCERTAIN'],
      ['/v1/memory/archives', { target: { objectType: 'proposition', objectId: propositionId } }, 'ARCHIVE'],
    ];
    for (const [route, payload, operationKind] of calls) {
      const response = await app.inject({ method: 'POST', url: route, headers: headers(phoneToken), payload });
      expect(response.statusCode, route + ' ' + response.body).toBe(201);
      expect(response.json().operationKind, route).toBe(operationKind);
      expect(response.json().ownerSequence, route).toBeGreaterThan(0);
    }
    // Keeping something uncertain decides nothing, so it proposes nothing.
    const kinds = (await admin.query('SELECT DISTINCT operation_kind FROM memory_operations WHERE owner_scope_id=$1', [owner]))
      .rows.map((row: { operation_kind: string }) => row.operation_kind).sort();
    expect(kinds).toEqual(['ARCHIVE', 'CHANGED', 'CONFIRM', 'CORRECT', 'DELETE', 'KEEP_UNCERTAIN', 'REJECT', 'SUPPRESS']);
    expect((await admin.query("SELECT transaction_id FROM memory_operations WHERE owner_scope_id=$1 AND operation_kind='KEEP_UNCERTAIN'",
      [owner])).rows.every((row: { transaction_id: string | null }) => row.transaction_id === null)).toBe(true);
  } finally { await app.close(); }
});

it('refuses a correction under another purpose, without the evidence context, or against an object that does not exist', async () => {
  const app = api();
  try {
    const wrongPurpose = await app.inject({ method: 'POST', url: '/v1/memory/corrections',
      headers: headers(phoneToken, { 'x-purpose': 'memory.govern' }),
      payload: { target: { objectType: 'proposition', objectId: propositionId }, correctedValue: 1, rawText: 'x' } });
    expect(wrongPurpose.statusCode).toBe(403);

    const noEvidenceContext = { ...headers(phoneToken) } as Record<string, string>;
    delete noEvidenceContext['x-data-purpose'];
    const refused = await app.inject({ method: 'POST', url: '/v1/memory/corrections', headers: noEvidenceContext,
      payload: { target: { objectType: 'proposition', objectId: propositionId }, correctedValue: 1, rawText: 'x' } });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ code: 'MEMORY_CONTEXT_REQUIRED' });

    const missing = await app.inject({ method: 'POST', url: '/v1/memory/corrections', headers: headers(phoneToken),
      payload: { target: { objectType: 'proposition', objectId: randomUUID() }, correctedValue: 1, rawText: 'x' } });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: 'MEMORY_TARGET_NOT_FOUND' });

    const invalid = await app.inject({ method: 'POST', url: '/v1/memory/deletions', headers: headers(phoneToken),
      payload: { target: { objectType: 'proposition', objectId: propositionId } } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: 'MEMORY_CORRECTION_INPUT_INVALID' });

    // No response carries a session token, a digest or a private object key.
    for (const response of [wrongPurpose, refused, missing, invalid]) expect(response.body).not.toMatch(/token_hash|object_store_key/i);
  } finally { await app.close(); }
});
