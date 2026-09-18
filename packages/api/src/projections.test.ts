import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { runMigrations, withOwnerTransaction } from '@unai/postgres';
import { postgresAdapter, SESSION_COOKIE } from '@unai/auth';
import { applyProjectionDelta } from '@unai/capabilities';
import { createPlatformApi } from './platform.js';

/**
 * The typed projection reads over the real boundary (CRT-PRJ-04-A).
 *
 * TLS, session, owner scope, purpose and correlation id all apply, and the
 * response has to carry its completeness flag and its owner overlay watermark:
 * a caller must be able to tell from the answer alone whether it read the whole
 * story (PRD §35.9, FR-082).
 */

if (!process.env.UNAI_TEST_DATABASE_URL) throw new Error('Run pnpm test for the required PostgreSQL harness');
const admin = new Pool({ connectionString: process.env.UNAI_TEST_DATABASE_URL });
const url = new URL(process.env.UNAI_TEST_DATABASE_URL); url.username = 'projection_api_test_app'; url.password = 'test-only';
const appPool = new Pool({ connectionString: url.href });

let owner = '', token = '', userId = '', obligationId = '', commitmentId = '', danielId = '';

beforeAll(async () => {
  await runMigrations(admin, resolve('migrations'));
  await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='projection_api_test_app') THEN CREATE ROLE projection_api_test_app LOGIN PASSWORD 'test-only'; END IF; END $$; GRANT unai_app TO projection_api_test_app");
  const adapter = postgresAdapter(admin);
  const user = await adapter.createUser!({ name: 'Projections', email: 'projections@example.test', emailVerified: null });
  userId = user.id;
  owner = (user as unknown as { ownerScopeId: string }).ownerScopeId;
  token = randomBytes(32).toString('base64url');
  await adapter.createSession!({ userId: user.id, sessionToken: token, expires: new Date(Date.now() + 604800000) });

  const contextSpaceId = (await admin.query("SELECT id FROM context_spaces WHERE owner_scope_id=$1 AND context_kind='BASE'", [owner])).rows[0].id;
  const connectorId = randomUUID(), sourceItemId = randomUUID(), anchorId = randomUUID();
  await admin.query("INSERT INTO connectors(id,owner_scope_id,connector_type,external_account_ref,permission_manifest,status) VALUES($1,$2,'CONVERSATION',$3,'{}','ACTIVE')", [connectorId, owner, owner]);
  await admin.query(`INSERT INTO source_items(id,owner_scope_id,connector_id,source_type,external_id,actor_ref,submitted_by_user_id,
    raw_object_ref,content_hash,sensitivity,allowed_purposes,ingestion_version,idempotency_key)
    VALUES($1,$2,$3,'CONVERSATION','projection-api-1',$4,$5,$6,$7,'PRIVATE',ARRAY['PERSONAL_ASSISTANCE'],'evidence-json-v1',$8)`,
    [sourceItemId, owner, connectorId, JSON.stringify({ type: 'USER', id: user.id }), user.id, randomUUID(), 'd'.repeat(64), randomUUID()]);
  await admin.query("INSERT INTO source_anchors(id,owner_scope_id,source_item_id,anchor_kind,anchor) VALUES($1,$2,$3,'MESSAGE_SPAN','{\"start\":0,\"end\":10}')", [anchorId, owner, sourceItemId]);

  danielId = randomUUID();
  await admin.query("INSERT INTO entities(id,owner_scope_id,entity_kind,canonical_label) VALUES($1,$2,'PERSON','Daniel')", [danielId, owner]);

  // One obligation and one commitment, written with the privileged fixture role:
  // what is under test here is the read, not the write path.
  obligationId = randomUUID(); commitmentId = randomUUID();
  const obligationSlot = randomUUID(), obligationProposition = randomUUID(), obligationClaim = randomUUID();
  await admin.query("INSERT INTO frame_instances(id,owner_scope_id,frame_type_id,context_space_id) VALUES($1,$2,'shared.obligation',$3),($4,$2,'shared.commitment',$3)",
    [obligationId, owner, contextSpaceId, commitmentId]);
  await admin.query("INSERT INTO belief_slots(id,owner_scope_id,frame_instance_id,predicate_id,context_space_id,modality) VALUES($1,$2,$3,'shared.obligation.principal_amount',$4,'ACTUAL')",
    [obligationSlot, owner, obligationId, contextSpaceId]);
  await admin.query(`INSERT INTO propositions(id,owner_scope_id,belief_slot_id,normalized_value)
    VALUES($1,$2,$3,'{"amount":"50.00","currency":"ILS"}')`, [obligationProposition, owner, obligationSlot]);
  await admin.query("INSERT INTO claims(id,owner_scope_id,source_anchor_id,proposition_id,claim_origin,lifecycle) VALUES($1,$2,$3,$4,'USER_STATEMENT','PROVISIONAL')",
    [obligationClaim, owner, anchorId, obligationProposition]);
  await admin.query("INSERT INTO frame_instance_roles(id,owner_scope_id,frame_instance_id,role_id,entity_id,claim_id) VALUES($1,$2,$3,'creditor',$4,$5)",
    [randomUUID(), owner, obligationId, danielId, obligationClaim]);

  const commitmentSlot = randomUUID(), commitmentProposition = randomUUID(), commitmentClaim = randomUUID();
  await admin.query("INSERT INTO belief_slots(id,owner_scope_id,frame_instance_id,predicate_id,context_space_id,modality) VALUES($1,$2,$3,'shared.commitment.action_description',$4,'COMMITTED')",
    [commitmentSlot, owner, commitmentId, contextSpaceId]);
  await admin.query(`INSERT INTO propositions(id,owner_scope_id,belief_slot_id,normalized_value)
    VALUES($1,$2,$3,'{"text":"send Daniel the report"}')`, [commitmentProposition, owner, commitmentSlot]);
  await admin.query("INSERT INTO claims(id,owner_scope_id,source_anchor_id,proposition_id,claim_origin,lifecycle) VALUES($1,$2,$3,$4,'USER_STATEMENT','PROVISIONAL')",
    [commitmentClaim, owner, anchorId, commitmentProposition]);
  await admin.query("INSERT INTO frame_instance_roles(id,owner_scope_id,frame_instance_id,role_id,entity_id,claim_id) VALUES($1,$2,$3,'promisee',$4,$5)",
    [randomUUID(), owner, commitmentId, danielId, commitmentClaim]);

  // The reducer runs under its own purpose, exactly as the background capability
  // does; the HTTP read below holds `projection.read` and writes nothing.
  await withOwnerTransaction(appPool, { actorId: userId, ownerScopeId: owner, purpose: 'memory.project', correlationId: randomUUID() },
    async tx => {
      for (const projectionName of ['open_commitments_projection', 'obligations_projection', 'schedule_projection'] as const) {
        await applyProjectionDelta(tx, { ownerScopeId: owner, projectionName, asOf: new Date() });
      }
    });
});
afterAll(async () => { await appPool.end(); await admin.end(); });

function api() {
  const app = createPlatformApi({ authPool: admin, appPool });
  app.addHook('onRequest', async request => { Object.defineProperty(request.raw.socket, 'encrypted', { value: true }); });
  return app;
}
const headers = (purpose = 'projection.read') => ({
  cookie: SESSION_COOKIE + '=' + token, 'x-owner-scope-id': owner, 'x-purpose': purpose,
  'x-correlation-id': randomUUID(),
});

it('CRT-PRJ-04-A: commitments and obligations reads include a completeness flag and an owner overlay watermark', async () => {
  const app = api();
  try {
    for (const path of ['/v1/projections/commitments', '/v1/projections/obligations']) {
      const response = await app.inject({ method: 'GET', url: path, headers: headers() });
      expect(response.statusCode, path + ' ' + response.body).toBe(200);
      const view = response.json();
      // The two fields the criterion names, present and typed.
      expect(typeof view.isComplete, path).toBe('boolean');
      expect(Number.isInteger(view.ownerOverlayWatermark), path).toBe(true);
      expect(view.ownerOverlayWatermark, path).toBeGreaterThanOrEqual(0);
      // ...and the rest of what a caller needs to decide whether to act on it.
      expect(typeof view.canonicalTransactionWatermark, path).toBe('string');
      expect(view.reducerVersion, path).toMatch(/^projection-reducers-/);
      expect(Array.isArray(view.pendingAssertions), path).toBe(true);
      expect(typeof view.highRiskActionsBlocked, path).toBe('boolean');
      expect(view.rows.length, path).toBeGreaterThan(0);
      for (const row of view.rows) {
        expect(row.projectionVersion, path).toMatch(/^[0-9a-f-]{36}$/);
        expect(typeof row.isComplete, path).toBe('boolean');
        expect(typeof row.sourceManifest, path).toBe('object');
        expect(typeof row.updatedAt, path).toBe('string');
      }
    }

    const obligations = (await app.inject({ method: 'GET', url: '/v1/projections/obligations', headers: headers() })).json();
    // Typed money crosses the boundary as exact digits, never as a float.
    expect(obligations.rows[0]).toMatchObject({ principalAmount: '50.00', currency: 'ILS', outcomeState: 'UNRESOLVED' });
    expect(obligations.rows[0].creditorEntityId).toBe(danielId);

    const commitments = (await app.inject({ method: 'GET', url: '/v1/projections/commitments', headers: headers() })).json();
    expect(commitments.rows[0]).toMatchObject({ commitmentFrameInstanceId: commitmentId,
      actionDescription: 'send Daniel the report', outcomeState: 'UNRESOLVED', overdue: false });

    // The schedule read answers the same envelope.
    const schedule = await app.inject({ method: 'GET', url: '/v1/projections/schedule', headers: headers() });
    expect(schedule.statusCode).toBe(200);
    expect(typeof schedule.json().isComplete).toBe('boolean');
  } finally { await app.close(); }
});

it('filters by person and due window, and refuses a malformed filter', async () => {
  const app = api();
  try {
    const mine = (await app.inject({ method: 'GET', url: '/v1/projections/commitments?person=' + danielId, headers: headers() })).json();
    expect(mine.rows).toHaveLength(1);
    const other = (await app.inject({ method: 'GET', url: '/v1/projections/commitments?person=' + randomUUID(), headers: headers() })).json();
    expect(other.rows).toHaveLength(0);
    // A commitment with no due time is outside every due window rather than
    // silently inside it.
    const windowed = (await app.inject({ method: 'GET', url: '/v1/projections/commitments?dueBefore=2026-01-01T00:00:00.000Z', headers: headers() })).json();
    expect(windowed.rows).toHaveLength(0);

    const bad = await app.inject({ method: 'GET', url: '/v1/projections/obligations?person=not-a-uuid', headers: headers() });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe('PROJECTION_FILTER_INVALID');
    const badTime = await app.inject({ method: 'GET', url: '/v1/projections/obligations?dueBefore=whenever', headers: headers() });
    expect(badTime.statusCode).toBe(400);
  } finally { await app.close(); }
});

it('refuses a projection read under another purpose and answers the Projection health screen under its own', async () => {
  const app = api();
  try {
    const wrongPurpose = await app.inject({ method: 'GET', url: '/v1/projections/obligations', headers: headers('memory.inspect') });
    expect(wrongPurpose.statusCode).toBe(403);
    const noPurposeForHealth = await app.inject({ method: 'GET', url: '/v1/ops/projections', headers: headers('projection.read') });
    expect(noPurposeForHealth.statusCode).toBe(403);

    const health = await app.inject({ method: 'GET', url: '/v1/ops/projections', headers: headers('ops.projections.read') });
    expect(health.statusCode, health.body).toBe(200);
    const view = health.json();
    expect(view.projections.map((projection: { projectionName: string }) => projection.projectionName).sort())
      .toEqual(['obligations_projection', 'open_commitments_projection', 'schedule_projection']);
    expect(view.projections.every((projection: { reducerVersion: string }) => projection.reducerVersion.startsWith('projection-reducers-'))).toBe(true);
    expect(Array.isArray(view.receipts)).toBe(true);
  } finally { await app.close(); }
});
