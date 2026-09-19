import { Pool } from 'pg';
import Fastify from 'fastify';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { runMigrations, withOwnerTransaction } from '@unai/postgres';
import { registerControlRoutes } from './control.js';
import { postgresAdapter, SESSION_COOKIE } from '@unai/auth';
import { auditEventKindFor, auditLogSchema, type AuditLog } from '@unai/domain';
import { createPlatformApi, PLATFORM_PURPOSES } from './platform.js';
import type { EvidenceObjects } from './evidence.js';

/**
 * The audit trail behind the Audit log (design entity `audit_events`, route
 * `GET /v1/audit-events`, screen "Audit log"; PRD §30.6; ADR 0032), over the real
 * boundary and the real owner transaction.
 *
 *  - CRT-SEC-07-A: a read, a write, a projection rebuild, an export and a deletion
 *    each append an audit event carrying actor, owner scope, purpose, objects and
 *    fields, policy decision, model or code version, result and correlation id;
 *    and no route, no application SQL and not even the migration principal can
 *    update or delete one.
 */

if (!process.env.UNAI_TEST_DATABASE_URL) throw new Error('Run pnpm test for the required PostgreSQL harness');
const admin = new Pool({ connectionString: process.env.UNAI_TEST_DATABASE_URL });
const url = new URL(process.env.UNAI_TEST_DATABASE_URL); url.username = 'audit_api_test_app'; url.password = 'test-only';
const appPool = new Pool({ connectionString: url.href });

const FINANCE = 'PERSONAL_FINANCE';
const MARKER = 'Quokka-8812';
const stored = new Map<string, Uint8Array>();
const evidenceObjects: EvidenceObjects = {
  encryptionKeyRef: 'kms:test-double',
  async put(_tx, id, bytes) { stored.set(id, bytes); },
  async get(_tx, id) { const bytes = stored.get(id); if (!bytes) throw new Error('OBJECT_NOT_FOUND'); return bytes; },
  async delete(_tx, id) { stored.delete(id); },
};

interface Owner { owner: string; actor: string; token: string }
async function newOwner(label: string): Promise<Owner> {
  const adapter = postgresAdapter(admin);
  const user = await adapter.createUser!({ name: label, email: 'audit-' + label + '-' + randomUUID() + '@example.test', emailVerified: null });
  const token = randomBytes(32).toString('base64url');
  await adapter.createSession!({ userId: user.id, sessionToken: token, expires: new Date(Date.now() + 604800000) });
  return { owner: (user as unknown as { ownerScopeId: string }).ownerScopeId, actor: user.id, token };
}
function api() {
  const app = createPlatformApi({ authPool: admin, appPool, evidenceObjects, registryReleaseId: randomUUID(), registryRelease: '0.1.0' });
  app.addHook('onRequest', async request => { Object.defineProperty(request.raw.socket, 'encrypted', { value: true }); });
  return app;
}
const headers = (o: Owner, purpose: string, extra: Record<string, string> = {}) => ({
  cookie: SESSION_COOKIE + '=' + o.token, 'x-owner-scope-id': o.owner, 'x-purpose': purpose,
  'x-correlation-id': randomUUID(), 'idempotency-key': randomBytes(16).toString('hex'), ...extra,
});
const evidenceHeaders = (o: Owner, purpose: string) =>
  headers(o, purpose, { 'x-data-purpose': FINANCE, 'x-maximum-sensitivity': 'RESTRICTED' });

interface Row {
  id: string; owner_scope_id: string; actor: string; purpose: string; event_kind: string;
  objects_and_fields_accessed: Array<{ type: string; id: string; fields: string[] }>;
  policy_decision: string; policy_decision_id: string | null; model_or_code_version: string; result: string; correlation_id: string;
}
const eventsFor = async (correlationId: string): Promise<Row[]> =>
  (await admin.query('SELECT * FROM audit_events WHERE correlation_id=$1 ORDER BY created_at,id', [correlationId])).rows as Row[];

/** Every field the criterion names, present and meaningful on one event. */
function expectComplete(event: Row, o: Owner, correlationId: string) {
  expect(event.actor).toBe(o.actor);
  expect(event.owner_scope_id).toBe(o.owner);
  expect(event.purpose).toMatch(/^[a-z][a-z0-9_.:-]+$/);
  expect(event.objects_and_fields_accessed.length).toBeGreaterThan(0);
  for (const object of event.objects_and_fields_accessed) {
    expect(object.type).toMatch(/^[a-z][a-z0-9_]+$/);
    expect(object.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(object.fields.length).toBeGreaterThan(0);
  }
  expect(['ALLOW', 'DENY']).toContain(event.policy_decision);
  expect(event.model_or_code_version.length).toBeGreaterThan(0);
  expect(['SUCCESS', 'FAILURE', 'REFUSED']).toContain(event.result);
  expect(event.correlation_id).toBe(correlationId);
}

let owner: Owner, other: Owner;
beforeAll(async () => {
  await runMigrations(admin, resolve('migrations'));
  await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='audit_api_test_app') THEN CREATE ROLE audit_api_test_app LOGIN PASSWORD 'test-only'; END IF; END $$; GRANT unai_app TO audit_api_test_app");
  owner = await newOwner('owner');
  other = await newOwner('other');
});
afterAll(async () => { await appPool.end(); await admin.end(); });

for (const failCommit of [false, true]) {
  it(`export waits for its audit transaction before responding (rollback=${failCommit})`, async () => {
    const context = { actorId: owner.actor, ownerScopeId: owner.owner, purpose: 'data.export', correlationId: randomUUID() };
    const app = Fastify();
    app.decorateRequest('ownerContext', null);
    app.addHook('preHandler', async request => { request.ownerContext = context; });
    registerControlRoutes(app, (_request, run) => withOwnerTransaction(appPool, context, async tx => {
      const result = await run(tx, 'unused-test-session');
      // Keep the transaction open after the route callback: a response must
      // neither outrun the durable audit event nor report a rolled-back export.
      await sleep(100);
      if (failCommit) throw new Error('SIMULATED_COMMIT_FAILURE');
      return result;
    }));
    try {
      const response = await app.inject({ method: 'POST', url: '/v1/export',
        headers: { 'x-maximum-sensitivity': 'RESTRICTED' }, payload: { includeRawEvidence: false } });
      expect(response.statusCode).toBe(failCommit ? 500 : 201);
      expect((await eventsFor(context.correlationId)).map(event => event.event_kind)).toEqual(failCommit ? [] : ['EXPORT']);
      if (failCommit) expect(response.body).not.toContain('COMPLETED');
    } finally { await app.close(); }
  });
}

it('CRT-SEC-07-A: a read, a write, a projection rebuild, an export and a deletion each append a complete audit event', async () => {
  const app = api();
  try {
    // --- Write: a document stored through the real upload path.
    const write = evidenceHeaders(owner, 'evidence.ingest');
    const text = MARKER + ': the landlord asked for the signed lease by Friday.';
    const uploaded = await app.inject({ method: 'POST', url: '/v1/documents', headers: write,
      payload: { documentId: 'lease-note', title: 'Lease note', pages: [{ page: 1, text }], sensitivity: 'PRIVATE',
        allowedPurposes: [FINANCE], base64: Buffer.from(text).toString('base64') } });
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    const evidenceId = uploaded.json().evidenceId as string;
    const writeEvents = await eventsFor(write['x-correlation-id']);
    const written = writeEvents.find(event => event.event_kind === 'WRITE')!;
    expect(written, JSON.stringify(writeEvents)).toBeDefined();
    expectComplete(written, owner, write['x-correlation-id']);
    expect(written).toMatchObject({ purpose: 'evidence.ingest', policy_decision: 'ALLOW', result: 'SUCCESS' });
    expect(written.objects_and_fields_accessed.map(object => object.id)).toContain(evidenceId);

    // --- Read: the same item read back.
    const read = evidenceHeaders(owner, 'evidence.read');
    expect((await app.inject({ method: 'GET', url: '/v1/evidence/' + evidenceId, headers: read })).statusCode).toBe(200);
    const [readEvent] = await eventsFor(read['x-correlation-id']);
    expectComplete(readEvent!, owner, read['x-correlation-id']);
    expect(readEvent).toMatchObject({ event_kind: 'READ', purpose: 'evidence.read', policy_decision: 'ALLOW', result: 'SUCCESS' });
    expect(readEvent!.objects_and_fields_accessed[0]).toMatchObject({ type: 'source_items', id: evidenceId });

    // --- Export: the owner's bundle.
    const exporting = headers(owner, 'data.export', { 'x-maximum-sensitivity': 'RESTRICTED' });
    const exported = await app.inject({ method: 'POST', url: '/v1/export', headers: exporting, payload: { includeRawEvidence: true } });
    expect(exported.statusCode, exported.body).toBe(201);
    const exportEvents = await eventsFor(exporting['x-correlation-id']);
    expect(exportEvents.map(event => event.event_kind)).toEqual(['EXPORT']);
    expectComplete(exportEvents[0]!, owner, exporting['x-correlation-id']);
    expect(exportEvents[0]).toMatchObject({ purpose: 'data.export', result: 'SUCCESS' });

    // --- Deletion, and the projection rebuild the cascade runs after it.
    const deleting = headers(owner, 'data.delete');
    const deleted = await app.inject({ method: 'POST', url: '/v1/data/deletions', headers: deleting,
      payload: { evidenceIds: [evidenceId], confirmation: 'DELETE' } });
    expect(deleted.statusCode, deleted.body).toBe(200);
    const deletionEvents = await eventsFor(deleting['x-correlation-id']);
    const deletion = deletionEvents.find(event => event.event_kind === 'DELETION')!;
    const rebuild = deletionEvents.find(event => event.event_kind === 'PROJECTION_REBUILD')!;
    expectComplete(deletion, owner, deleting['x-correlation-id']);
    expect(deletion).toMatchObject({ purpose: 'data.delete', result: 'SUCCESS' });
    expect(deletion.objects_and_fields_accessed).toEqual(expect.arrayContaining([{ type: 'source_items', id: evidenceId, fields: ['deleted_at'] }]));
    expectComplete(rebuild, owner, deleting['x-correlation-id']);
    expect(rebuild).toMatchObject({ purpose: 'memory.project', result: 'SUCCESS', model_or_code_version: 'projection-reducers-0.1.0' });
    const receipts = rebuild.objects_and_fields_accessed.filter(object => object.type === 'projection_rebuild_receipts');
    expect(receipts).toHaveLength(3);
    const recorded = await admin.query('SELECT count(*)::int AS n FROM projection_rebuild_receipts WHERE owner_scope_id=$1 AND id=ANY($2::uuid[])',
      [owner.owner, receipts.map(receipt => receipt.id)]);
    expect(recorded.rows[0].n).toBe(3);

    // --- An external action: refused in V0, and the event names the recorded decision.
    const acting = headers(owner, 'action.execute');
    const action = await app.inject({ method: 'POST', url: '/v1/actions/execute', headers: acting,
      payload: { actionKind: 'EMAIL_SEND', purpose: FINANCE, actionRisk: 'LOW' } });
    expect(action.statusCode, action.body).toBe(403);
    const [actionEvent] = await eventsFor(acting['x-correlation-id']);
    expect(actionEvent).toMatchObject({ event_kind: 'EXTERNAL_ACTION', policy_decision: 'DENY', result: 'REFUSED',
      policy_decision_id: action.json().policyDecisionId });

    // --- The Audit log reads them back, filtered to the deleted item, with no payload.
    const logHeaders = headers(owner, 'audit.read');
    const logged = await app.inject({ method: 'GET', url: '/v1/audit-events?objectType=source_items&objectId=' + evidenceId, headers: logHeaders });
    expect(logged.statusCode, logged.body).toBe(200);
    const log: AuditLog = auditLogSchema.parse(logged.json());
    expect(log).toMatchObject({ appendOnly: true, retainsPayload: false, filters: { objectType: 'source_items', objectId: evidenceId } });
    // The export named the item it carried, so it is in the object's history too.
    expect(new Set(log.events.map(event => event.eventKind))).toEqual(new Set(['WRITE', 'READ', 'EXPORT', 'DELETION']));
    for (const event of log.events) {
      expect(event.objects.some(object => object.type === 'source_items' && object.id === evidenceId)).toBe(true);
      expect(event).toMatchObject({ ownerScopeId: owner.owner, actorId: owner.actor });
    }
    // Redacted metadata only: identifiers and field names survive the deletion, the words never did.
    expect(logged.body).not.toContain(MARKER);
    expect(JSON.stringify((await admin.query('SELECT * FROM audit_events WHERE owner_scope_id=$1', [owner.owner])).rows)).not.toContain(MARKER);
    // Filtering by kind, and reading the log is itself recorded as a read of it.
    const rebuilds = auditLogSchema.parse((await app.inject({ method: 'GET', url: '/v1/audit-events?eventKind=PROJECTION_REBUILD',
      headers: headers(owner, 'audit.read') })).json());
    expect(rebuilds.events.map(event => event.auditEventId)).toContain(rebuild.id);
    const [logRead] = await eventsFor(logHeaders['x-correlation-id']);
    expect(logRead).toMatchObject({ event_kind: 'READ', purpose: 'audit.read', result: 'SUCCESS' });
    expect(logRead!.objects_and_fields_accessed.every(object => object.type === 'audit_events')).toBe(true);

    // --- Paging walks the whole log without repeating an event.
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = auditLogSchema.parse((await app.inject({ method: 'GET',
        url: '/v1/audit-events?limit=2' + (cursor ? '&before=' + encodeURIComponent(cursor) : ''), headers: headers(owner, 'audit.read') })).json());
      seen.push(...page.events.map(event => event.auditEventId));
      cursor = page.nextCursor;
    } while (cursor !== null && seen.length < 200);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(expect.arrayContaining([written.id, readEvent!.id, deletion.id, rebuild.id]));

    // --- Another owner sees none of it.
    const foreign = auditLogSchema.parse((await app.inject({ method: 'GET', url: '/v1/audit-events?objectType=source_items&objectId=' + evidenceId,
      headers: headers(other, 'audit.read') })).json());
    expect(foreign.events).toEqual([]);
    const foreignAll = auditLogSchema.parse((await app.inject({ method: 'GET', url: '/v1/audit-events', headers: headers(other, 'audit.read') })).json());
    expect(foreignAll.events.every(event => event.ownerScopeId === other.owner)).toBe(true);
    // The log holds its own purpose.
    expect((await app.inject({ method: 'GET', url: '/v1/audit-events', headers: headers(owner, 'evidence.read') })).json().code).toBe('PURPOSE_REFUSED');
    expect((await app.inject({ method: 'GET', url: '/v1/audit-events?objectType=source_items', headers: headers(owner, 'audit.read') })).statusCode).toBe(400);
  } finally { await app.close(); }
});

it('CRT-SEC-07-A: audit events cannot be updated or deleted through the application, and every attempt is itself recorded', async () => {
  const app = api();
  try {
    const listed = await app.inject({ method: 'GET', url: '/v1/devices', headers: headers(owner, 'device.list') });
    expect(listed.statusCode).toBe(200);
    const target = (await admin.query("SELECT * FROM audit_events WHERE owner_scope_id=$1 ORDER BY created_at LIMIT 1", [owner.owner])).rows[0] as Row;
    const before = JSON.stringify(target);

    for (const [method, path] of [['PATCH', '/v1/audit-events/' + target.id], ['PUT', '/v1/audit-events/' + target.id],
      ['DELETE', '/v1/audit-events/' + target.id], ['DELETE', '/v1/audit-events'], ['POST', '/v1/audit-events']] as const) {
      const attempt = headers(owner, 'audit.modify');
      const response = await app.inject({ method, url: path, headers: attempt,
        ...(method === 'DELETE' ? {} : { payload: { result: 'FAILURE', purpose: 'rewritten' } }) });
      expect(response.statusCode, method + ' ' + path).toBe(405);
      expect(response.json()).toMatchObject({ code: 'AUDIT_EVENT_IMMUTABLE' });
      expect(response.headers['allow']).toBe('GET');
      const [refusal] = await eventsFor(attempt['x-correlation-id']);
      expect(refusal, method + ' ' + path).toMatchObject({ purpose: 'audit.modify', policy_decision: 'DENY', result: 'REFUSED',
        event_kind: method === 'DELETE' ? 'DELETION' : 'WRITE' });
      if (path.endsWith(target.id)) expect(refusal!.objects_and_fields_accessed[0]).toMatchObject({ type: 'audit_events', id: target.id });
    }
    // The event is exactly as it was, and still there.
    const after = (await admin.query('SELECT * FROM audit_events WHERE id=$1', [target.id])).rows[0];
    expect(JSON.stringify(after)).toBe(before);
    // Another owner's attempt is refused the same way and names nothing it cannot see.
    const foreign = headers(other, 'audit.modify');
    expect((await app.inject({ method: 'DELETE', url: '/v1/audit-events/' + target.id, headers: foreign })).statusCode).toBe(405);
    expect((await eventsFor(foreign['x-correlation-id']))[0]!.objects_and_fields_accessed).toEqual([]);
    // The refused attempts are in the log, where the Audit log screen shows them.
    const refused = auditLogSchema.parse((await app.inject({ method: 'GET', url: '/v1/audit-events?purpose=audit.modify',
      headers: headers(owner, 'audit.read') })).json());
    expect(refused.events.length).toBeGreaterThanOrEqual(5);
    expect(refused.events.every(event => event.result === 'REFUSED' && event.policyDecision === 'DENY')).toBe(true);

    // Under the routes: the application role holds no UPDATE, DELETE or TRUNCATE ...
    const client = await appPool.connect();
    try {
      for (const sql of ["UPDATE audit_events SET result='FAILURE'", 'DELETE FROM audit_events', 'TRUNCATE audit_events']) {
        await client.query('BEGIN');
        await client.query("SELECT set_config('unai.owner_scope_id',$1,true),set_config('unai.actor_id',$2,true)", [owner.owner, owner.actor]);
        await expect(client.query(sql), sql).rejects.toMatchObject({ code: '42501' });
        await client.query('ROLLBACK');
      }
    } finally { client.release(); }
    // ... and the table refuses all three for every role, the migration principal included.
    for (const sql of ["UPDATE audit_events SET result='FAILURE' WHERE id=$1", 'DELETE FROM audit_events WHERE id=$1']) {
      await expect(admin.query(sql, [target.id]), sql).rejects.toMatchObject({ code: '55000', message: 'AUDIT_EVENT_IMMUTABLE' });
    }
    const truncating = await admin.connect();
    try {
      await truncating.query('BEGIN');
      await expect(truncating.query('TRUNCATE audit_events')).rejects.toMatchObject({ code: '55000', message: 'AUDIT_EVENT_IMMUTABLE' });
    } finally { await truncating.query('ROLLBACK'); truncating.release(); }
    expect(JSON.stringify((await admin.query('SELECT * FROM audit_events WHERE id=$1', [target.id])).rows[0])).toBe(before);
  } finally { await app.close(); }
});

it('records a kind on events appended outside the API, and the SQL and TypeScript kind rules agree on every purpose', async () => {
  // A sign-in is appended by the definer function `auth_create_session`, which
  // names no kind: the table's trigger derives it.
  const signIn = (await admin.query("SELECT event_kind FROM audit_events WHERE owner_scope_id=$1 AND purpose='auth.sign_in'", [owner.owner])).rows;
  expect(signIn).toEqual([{ event_kind: 'WRITE' }]);
  const purposes = [...PLATFORM_PURPOSES, 'auth.sign_in', 'auth.sign_out', 'memory.project', 'memory.act', 'memory.canonicalize',
    'answer.record', 'answer.phrase', 'model.call', 'evaluation.shadow', 'jobs.enqueue', 'memory.extract'];
  for (const purpose of purposes) {
    const kind = (await admin.query('SELECT unai_private.audit_event_kind($1) AS kind', [purpose])).rows[0].kind;
    expect(kind, purpose).toBe(auditEventKindFor(purpose));
  }
  // A GET is a read whatever its purpose; the four fixed kinds hold for any method.
  expect(auditEventKindFor('memory.correct', 'GET')).toBe('READ');
  expect(auditEventKindFor('memory.correct', 'POST')).toBe('WRITE');
  expect(auditEventKindFor('memory.read', 'POST')).toBe('READ');
  expect(auditEventKindFor('data.delete', 'POST')).toBe('DELETION');
  expect(auditEventKindFor('memory.project', 'GET')).toBe('PROJECTION_REBUILD');
});
