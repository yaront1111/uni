import {Pool} from 'pg';
import {beforeAll, afterAll, expect, it} from 'vitest';
import {randomUUID, randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {runMigrations, withOwnerTransaction, type OwnerTransaction} from '@unai/postgres';
import {postgresAdapter, SESSION_COOKIE} from '@unai/auth';
import {createPlatformApi} from './platform.js';
import {importSource, type EvidenceObjects, type SourceImportRequest} from './evidence.js';

const admin = new Pool({connectionString: process.env.UNAI_TEST_DATABASE_URL});
const url = new URL(process.env.UNAI_TEST_DATABASE_URL!); url.username = 'import_test_app'; url.password = 'test-only';
const appPool = new Pool({connectionString: url.href});
beforeAll(async () => {
  await runMigrations(admin, resolve('migrations'));
  await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='import_test_app') THEN CREATE ROLE import_test_app LOGIN PASSWORD 'test-only'; END IF; END $$; GRANT unai_app TO import_test_app");
});
afterAll(async () => { await appPool.end(); await admin.end(); });

async function fixture(name: string) {
  return JSON.parse(await readFile(resolve('fixtures/sources/' + name + '.json'), 'utf8'));
}

/** One owner, one connector and a storage double: this suite proves the durable
 * parse-and-persist path, with no extraction worker and no model anywhere in it. */
async function owner(connectorType: string) {
  const adapter = postgresAdapter(admin);
  const user = await adapter.createUser!({name: 'Import test', email: 'import-' + randomUUID() + '@example.test', emailVerified: null});
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
  async function ingest<T>(run: (tx: OwnerTransaction) => Promise<T>) {
    return withOwnerTransaction(appPool, {actorId: user.id, ownerScopeId, purpose: 'evidence.ingest', correlationId: randomUUID()}, async tx => {
      await tx.query("SELECT set_config('unai.data_purpose','PERSONAL_ASSISTANCE',true),set_config('unai.maximum_sensitivity','RESTRICTED',true)");
      return run(tx);
    });
  }
  type FixtureImport = Omit<SourceImportRequest, 'connectorId' | 'sensitivity' | 'allowedPurposes'> & {connectorId?: string | null};
  async function importFixture(request: FixtureImport) {
    return ingest(tx => importSource(tx, objects, {
      sourceType: request.sourceType, payload: request.payload,
      connectorId: request.connectorId === undefined ? connectorId : request.connectorId,
      sensitivity: 'PRIVATE', allowedPurposes: ['PERSONAL_ASSISTANCE'],
    }));
  }
  async function count() {
    return (await admin.query('SELECT count(*)::int AS items FROM source_items WHERE owner_scope_id=$1', [ownerScopeId])).rows[0].items as number;
  }
  async function rows() {
    return (await admin.query('SELECT * FROM source_items WHERE owner_scope_id=$1 ORDER BY external_id', [ownerScopeId])).rows;
  }
  return {user, token, ownerScopeId, connectorId, objects: stored, ingest, importFixture, count, rows};
}

it('CRT-EVD-02-C: re-importing the same raw Gmail fixture leaves the evidence row count unchanged', async () => {
  const o = await owner('GMAIL');
  const payload = await fixture('gmail-thread');
  const first = await o.importFixture({sourceType: 'GMAIL', payload});
  expect(first).toHaveLength(3);
  expect(first.every(item => item.stored)).toBe(true);
  const after = await o.count();
  expect(after).toBe(3);

  const second = await o.importFixture({sourceType: 'GMAIL', payload});
  expect(await o.count()).toBe(after);
  // The same fixture resolves to the same evidence, and nothing was written twice.
  expect(second.map(item => item.evidenceId)).toEqual(first.map(item => item.evidenceId));
  expect(second.every(item => item.stored)).toBe(false);
  expect(o.objects.size).toBe(3);
  expect((await admin.query('SELECT count(*)::int AS keys FROM evidence_object_keys WHERE owner_scope_id=$1', [o.ownerScopeId])).rows[0].keys).toBe(3);
  // Anchors are re-derived on the second pass and must not duplicate either.
  const anchors = (await admin.query('SELECT count(*)::int AS anchors FROM source_anchors WHERE owner_scope_id=$1', [o.ownerScopeId])).rows[0].anchors;
  expect(anchors).toBe(6);
});

it('CRT-EVD-04-A: a multi-message Gmail thread stores each external id with a parent linking it to the thread', async () => {
  const o = await owner('GMAIL');
  const payload = await fixture('gmail-thread');
  await o.importFixture({sourceType: 'GMAIL', payload});
  const rows = await o.rows();
  expect(rows.map(row => row.external_id)).toEqual(['msg-9a1c04', 'msg-9a1c05', 'msg-9a1c06']);
  const externalIds = new Set(rows.map(row => row.external_id));
  for (const row of rows) {
    expect(row.source_type).toBe('GMAIL');
    expect(row.parent_external_id).not.toBeNull();
    // Either the thread itself or another message of the same thread.
    expect(row.parent_external_id === payload.id || externalIds.has(row.parent_external_id)).toBe(true);
    expect(row.deterministic_metadata.threadExternalId).toBe(payload.id);
  }
  expect(rows.map(row => row.parent_external_id)).toEqual([payload.id, 'msg-9a1c04', 'msg-9a1c05']);
  const spans = (await admin.query("SELECT anchor,normalized_text FROM source_anchors WHERE owner_scope_id=$1 AND anchor_kind='MESSAGE_SPAN' ORDER BY normalized_text", [o.ownerScopeId])).rows;
  expect(spans).toHaveLength(3);
  for (const span of spans) {
    const message = payload.messages.find((m: {payload: {body: {text: string}}}) => m.payload.body.text === span.normalized_text);
    expect(message, 'every message span must resolve to text present in its source item').toBeDefined();
    expect(span.anchor.end).toBe(message.payload.body.text.length);
  }
});

it('CRT-EVD-04-B: a recurring Google Calendar fixture stores occurrences carrying the payload recurrence id', async () => {
  const o = await owner('GOOGLE_CALENDAR');
  const payload = await fixture('google-calendar-recurring-event');
  await o.importFixture({sourceType: 'GOOGLE_CALENDAR', payload});
  const rows = await o.rows();
  expect(rows).toHaveLength(payload.instances.length);
  for (const [index, row] of rows.entries()) {
    const occurrence = payload.instances[index];
    expect(row.external_id).toBe(occurrence.id);
    expect(row.deterministic_metadata.recurrenceId).toBe(occurrence.recurringEventId);
    expect(row.parent_external_id).toBe(occurrence.recurringEventId);
    expect(row.deterministic_metadata.recurrence).toEqual(payload.recurrence);
  }
  expect(rows[0]!.occurred_at.toISOString()).toBe('2026-09-04T13:00:00.000Z');
  const fields = (await admin.query("SELECT anchor FROM source_anchors WHERE owner_scope_id=$1 AND anchor_kind='CALENDAR_FIELD'", [o.ownerScopeId])).rows;
  expect(fields).toHaveLength(9);
  expect(fields.filter(row => row.anchor.field === 'recurrence').every(row => row.anchor.recurrenceId === payload.id)).toBe(true);
  // Re-importing a recurring series is idempotent for the same reason a thread is.
  await o.importFixture({sourceType: 'GOOGLE_CALENDAR', payload});
  expect(await o.count()).toBe(payload.instances.length);
});

it('stores every anchor kind the design names across the deterministic parsers', async () => {
  const o = await owner('GITHUB');
  await o.importFixture({sourceType: 'GITHUB', payload: await fixture('github-issue-thread')});
  // An uploaded document belongs to no connector.
  await o.importFixture({sourceType: 'DOCUMENT', payload: await fixture('uploaded-document'), connectorId: null});
  const kinds = (await admin.query('SELECT DISTINCT anchor_kind FROM source_anchors WHERE owner_scope_id=$1 ORDER BY anchor_kind', [o.ownerScopeId]))
    .rows.map(row => row.anchor_kind);
  expect(kinds).toEqual(['CONNECTOR_JSON_PATH', 'DOCUMENT_RANGE', 'GITHUB_COMMENT', 'MESSAGE_SPAN']);
  const comment = (await admin.query("SELECT anchor,normalized_text FROM source_anchors WHERE owner_scope_id=$1 AND anchor_kind='GITHUB_COMMENT' ORDER BY (anchor->>'commentId')", [o.ownerScopeId])).rows;
  expect(comment.map(row => row.anchor.commentId)).toEqual([9013371, 9013372]);
  // The document item is attributed to the submitting owner, not to a connector actor.
  const document = (await admin.query("SELECT actor_ref FROM source_items WHERE owner_scope_id=$1 AND source_type='DOCUMENT'", [o.ownerScopeId])).rows[0];
  expect(document.actor_ref).toEqual({type: 'USER', id: o.user.id});
  await expect(o.importFixture({sourceType: 'GITHUB', payload: {repository: {full_name: 'x/y'}}})).rejects.toThrow('SOURCE_PAYLOAD_INVALID');
});

it('CRT-EVD-03-A: an imported item reads back every retained field and its anchors', async () => {
  const o = await owner('GMAIL');
  const payload = await fixture('gmail-thread');
  const imported = await o.importFixture({sourceType: 'GMAIL', payload});
  const app = createPlatformApi({authPool: admin, appPool, evidenceObjects: {
    encryptionKeyRef: 'kms:test-double', async put() {}, async get() { return new Uint8Array(); },
  }});
  app.addHook('onRequest', async request => { Object.defineProperty(request.raw.socket, 'encrypted', {value: true}); });
  try {
    const result = await app.inject({url: '/v1/evidence/' + imported[0]!.evidenceId, headers: {
      cookie: SESSION_COOKIE + '=' + o.token, 'x-owner-scope-id': o.ownerScopeId, 'x-purpose': 'evidence.read',
      'x-correlation-id': randomUUID(), 'x-data-purpose': 'PERSONAL_ASSISTANCE', 'x-maximum-sensitivity': 'RESTRICTED',
    }});
    expect(result.statusCode, result.body).toBe(200);
    const row = (await admin.query('SELECT * FROM source_items WHERE id=$1', [imported[0]!.evidenceId])).rows[0];
    expect(result.json()).toMatchObject({
      evidenceId: row.id, ownerScopeId: o.ownerScopeId, sourceType: 'GMAIL', connectorId: o.connectorId,
      externalId: 'msg-9a1c04', parentExternalId: payload.id, actorRef: {type: 'EXTERNAL', id: 'dana@example.test'},
      occurredAt: '2026-08-31T09:00:00.000Z', observedAt: row.observed_at.toISOString(), rawObjectRef: row.raw_object_ref,
      contentHash: row.content_hash, sensitivity: 'PRIVATE', allowedPurposes: ['PERSONAL_ASSISTANCE'],
      ingestionVersion: 'evidence-json-v1',
    });
    expect(result.json().anchors.map((anchor: {kind: string}) => anchor.kind).sort()).toEqual(['CONNECTOR_JSON_PATH', 'MESSAGE_SPAN']);
    const key = (await admin.query('SELECT object_store_key FROM evidence_object_keys WHERE source_item_id=$1', [row.id])).rows[0];
    expect(result.body).not.toContain(key.object_store_key);
  } finally { await app.close(); }
});

it('refuses an import under a purpose other than evidence ingestion', async () => {
  const o = await owner('GMAIL');
  const payload = await fixture('gmail-thread');
  await expect(withOwnerTransaction(appPool, {actorId: o.user.id, ownerScopeId: o.ownerScopeId, purpose: 'evidence.read', correlationId: randomUUID()},
    async tx => importSource(tx, {encryptionKeyRef: 'kms:test-double', async put() {}, async get() { return new Uint8Array(); }}, {
      sourceType: 'GMAIL', payload, connectorId: o.connectorId, sensitivity: 'PRIVATE', allowedPurposes: ['PERSONAL_ASSISTANCE'],
    }))).rejects.toThrow('EVIDENCE_POLICY_REFUSED');
  expect(await o.count()).toBe(0);
});
