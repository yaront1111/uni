import { Pool } from 'pg';
import { createRequire } from 'node:module';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { assertDatabaseEncryptionAtRest, createDatabasePool, runMigrations, withOwnerTransaction } from '@unai/postgres';
import { postgresAdapter, SESSION_COOKIE } from '@unai/auth';
import { createPlatformApi, routePurpose } from './platform.js';
import { createEvidenceObjects, type EvidenceObjects } from './evidence.js';

/**
 * Transport, storage encryption and object-key exposure (PRD §30; ADR 0005,
 * ADR 0032; CRT-SEC-08-A), part of the CI security suite.
 *
 *  - API endpoints refuse a non-TLS connection: a real plaintext socket to the
 *    platform API is answered 426 before authentication, and a forwarded-protocol
 *    header does not stand in for encryption.
 *  - The database is configured with encryption at rest: the runtime refuses a
 *    database that declares none; the object store is configured with SSE-KMS:
 *    the adapter refuses a bucket whose default encryption is not the configured
 *    key, and every stored object carries that key.
 *  - Raw object keys never appear in a public API response: every GET route the
 *    API registers -- discovered from its source, so a new route is swept too --
 *    and the writes that answer with evidence are read for the stored key.
 */

if (!process.env.UNAI_TEST_DATABASE_URL) throw new Error('Run pnpm test for the required PostgreSQL harness');
const admin = new Pool({ connectionString: process.env.UNAI_TEST_DATABASE_URL });
const url = new URL(process.env.UNAI_TEST_DATABASE_URL); url.username = 'transport_test_app'; url.password = 'test-only';
const appPool = new Pool({ connectionString: url.href });

const stored = new Map<string, Uint8Array>();
const doubleObjects: EvidenceObjects = {
  encryptionKeyRef: 'kms:test-double',
  async put(_tx, id, bytes) { stored.set(id, bytes); },
  async get(_tx, id) { const bytes = stored.get(id); if (!bytes) throw new Error('OBJECT_NOT_FOUND'); return bytes; },
  async delete(_tx, id) { stored.delete(id); },
};
const RAW_KEY = /raw\/[0-9a-f]{64}/;

interface Owner { owner: string; actor: string; token: string }
async function newOwner(): Promise<Owner> {
  const adapter = postgresAdapter(admin);
  const user = await adapter.createUser!({ name: 'Transport', email: 'transport-' + randomUUID() + '@example.test', emailVerified: null });
  const token = randomBytes(32).toString('base64url');
  await adapter.createSession!({ userId: user.id, sessionToken: token, expires: new Date(Date.now() + 604800000) });
  return { owner: (user as unknown as { ownerScopeId: string }).ownerScopeId, actor: user.id, token };
}
const headers = (o: Owner, purpose: string) => ({
  cookie: SESSION_COOKIE + '=' + o.token, 'x-owner-scope-id': o.owner, 'x-purpose': purpose,
  'x-correlation-id': randomUUID(), 'idempotency-key': randomBytes(16).toString('hex'),
  'x-data-purpose': 'PERSONAL_ASSISTANCE', 'x-maximum-sensitivity': 'RESTRICTED',
});

beforeAll(async () => {
  await runMigrations(admin, resolve('migrations'));
  await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='transport_test_app') THEN CREATE ROLE transport_test_app LOGIN PASSWORD 'test-only'; END IF; END $$; GRANT unai_app TO transport_test_app");
});
afterAll(async () => { await appPool.end(); await admin.end(); });

it('CRT-SEC-08-A: API endpoints refuse a non-TLS connection before anything else runs', async () => {
  const o = await newOwner();
  // No test transport stub: the listener sees the real plaintext socket.
  const app = createPlatformApi({ authPool: admin, appPool, evidenceObjects: doubleObjects });
  try {
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    for (const [method, path, purpose] of [['GET', '/v1/devices', 'device.list'], ['POST', '/v1/evidence', 'evidence.ingest'],
      ['GET', '/v1/audit-events', 'audit.read'], ['POST', '/v1/memory/context', 'memory.read'], ['POST', '/v1/export', 'data.export']] as const) {
      const response = await fetch(address + path, { method, headers: { ...headers(o, purpose), 'x-forwarded-proto': 'https', 'content-type': 'application/json' },
        ...(method === 'POST' ? { body: '{}' } : {}) });
      expect(response.status, path).toBe(426);
      expect(await response.json(), path).toMatchObject({ code: 'TLS_REQUIRED' });
    }
    // Refused before authentication: nothing was read or written for these requests.
    expect((await admin.query('SELECT count(*)::int AS n FROM audit_events WHERE owner_scope_id=$1 AND purpose<>$2', [o.owner, 'auth.sign_in'])).rows[0].n).toBe(0);
  } finally { await app.close(); }
  // The database client is TLS-only too: a connection string may not turn it off.
  expect(() => createDatabasePool('postgresql://app@db.example.test/unai?sslmode=disable', 'ca')).toThrow('DATABASE_TLS_CONFIG_INVALID');
  expect(() => createDatabasePool('postgresql://app@db.example.test/unai', ' ')).toThrow('DATABASE_TLS_CONFIG_INVALID');
});

it('CRT-SEC-08-A: the database must declare encryption at rest before the runtime will use it', async () => {
  const name = 'unai_enc_' + randomUUID().replaceAll('-', '');
  await admin.query('CREATE DATABASE ' + name);
  const scratch = new URL(process.env.UNAI_TEST_DATABASE_URL!); scratch.pathname = '/' + name;
  try {
    const undeclared = new Pool({ connectionString: scratch.href, max: 1 });
    try { await expect(assertDatabaseEncryptionAtRest(undeclared)).rejects.toThrow('DATABASE_ENCRYPTION_AT_REST_REQUIRED'); }
    finally { await undeclared.end(); }
    await admin.query('ALTER DATABASE ' + name + " SET unai.encryption_at_rest = 'plaintext'");
    const malformed = new Pool({ connectionString: scratch.href, max: 1 });
    try { await expect(assertDatabaseEncryptionAtRest(malformed)).rejects.toThrow('DATABASE_ENCRYPTION_AT_REST_REQUIRED'); }
    finally { await malformed.end(); }
    await admin.query('ALTER DATABASE ' + name + " SET unai.encryption_at_rest = 'volume-kms:arn:aws:kms:eu-west-1:000000000000:key/unai-db'");
    const declared = new Pool({ connectionString: scratch.href, max: 1 });
    try { await expect(assertDatabaseEncryptionAtRest(declared)).resolves.toBe('volume-kms:arn:aws:kms:eu-west-1:000000000000:key/unai-db'); }
    finally { await declared.end(); }
    // An unreachable database is refused with a code and no driver text.
    const unreachable = new Pool({ connectionString: 'postgresql://nobody:nothing@127.0.0.1:1/none', max: 1, connectionTimeoutMillis: 500 });
    try { await expect(assertDatabaseEncryptionAtRest(unreachable)).rejects.toThrow(/^DATABASE_ENCRYPTION_AT_REST_UNVERIFIED$/); }
    finally { await unreachable.end(); }
  } finally { await admin.query('DROP DATABASE IF EXISTS ' + name + ' WITH (FORCE)'); }
  // The API entry point runs the check before it listens.
  const server = await readFile(resolve('packages/api/src/server.ts'), 'utf8');
  expect(server.indexOf('await assertDatabaseEncryptionAtRest(appPool)')).toBeGreaterThan(0);
  expect(server.indexOf('await assertDatabaseEncryptionAtRest(appPool)')).toBeLessThan(server.indexOf('app.listen('));
});

it('CRT-SEC-08-A: the object store is used only with its SSE-KMS default, and every stored object carries the configured key', async () => {
  expect(process.env.UNAI_TEST_S3_ENDPOINT, 'pnpm test must provide real TLS/KMS object storage').toBeTruthy();
  const configuration = { endpoint: process.env.UNAI_TEST_S3_ENDPOINT!, region: 'us-east-1', bucket: process.env.UNAI_TEST_S3_BUCKET!,
    kmsKeyId: process.env.UNAI_TEST_S3_KMS_KEY_ID! };
  // A bucket whose default encryption is not the configured key is refused at startup,
  // and so is a plaintext endpoint.
  await expect(createEvidenceObjects({ ...configuration, kmsKeyId: 'unai-some-other-key' })).rejects.toThrow('STORAGE_ENCRYPTION_REQUIRED');
  await expect(createEvidenceObjects({ ...configuration, endpoint: configuration.endpoint.replace('https:', 'http:') }))
    .rejects.toThrow('STORAGE_CONFIGURATION_INVALID');

  const objects = await createEvidenceObjects(configuration);
  const o = await newOwner();
  const app = createPlatformApi({ authPool: admin, appPool, evidenceObjects: objects, registryReleaseId: randomUUID() });
  app.addHook('onRequest', async request => { Object.defineProperty(request.raw.socket, 'encrypted', { value: true }); });
  try {
    const text = 'Encrypted at rest: the lease renewal is due on 1 October.';
    const uploaded = await app.inject({ method: 'POST', url: '/v1/documents', headers: headers(o, 'evidence.ingest'),
      payload: { documentId: 'lease', pages: [{ page: 1, text }], sensitivity: 'PRIVATE', allowedPurposes: ['PERSONAL_ASSISTANCE'],
        base64: Buffer.from(text).toString('base64') } });
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    const key = (await admin.query('SELECT k.object_store_key FROM evidence_object_keys k JOIN source_items s ON s.id=k.source_item_id WHERE s.id=$1',
      [uploaded.json().evidenceId])).rows[0].object_store_key as string;
    expect(uploaded.body).not.toContain(key);
    // Read back from the provider directly, past the adapter: the object is stored
    // under SSE-KMS with the configured key.
    const s3 = createRequire(resolve('packages/storage/package.json'))('@aws-sdk/client-s3') as {
      S3Client: new (options: Record<string, unknown>) => { send(command: unknown): Promise<Record<string, unknown>>; destroy(): void };
      HeadObjectCommand: new (input: Record<string, unknown>) => unknown;
    };
    const client = new s3.S3Client({ endpoint: configuration.endpoint, region: configuration.region, forcePathStyle: true });
    try {
      const head = await client.send(new s3.HeadObjectCommand({ Bucket: configuration.bucket, Key: key }));
      expect(head['ServerSideEncryption']).toBe('aws:kms');
      expect(String(head['SSEKMSKeyId'])).toContain(configuration.kmsKeyId);
    } finally { client.destroy(); }
  } finally { await app.close(); objects.close(); }
});

/** Every GET route the platform registers, read from the route modules. */
async function registeredGetRoutes(): Promise<string[]> {
  const routes = new Set<string>();
  for (const file of await readdir(resolve('packages/api/src'))) {
    if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
    const source = await readFile(resolve('packages/api/src', file), 'utf8');
    for (const match of source.matchAll(/app\.get(?:<[^']*)?\('(\/v1\/[^']+)'/g)) routes.add(match[1]!);
  }
  return [...routes].sort();
}

it('CRT-SEC-08-A: no public API response exposes a raw object key', async () => {
  const o = await newOwner();
  const app = createPlatformApi({ authPool: admin, appPool, evidenceObjects: doubleObjects, registryReleaseId: randomUUID() });
  app.addHook('onRequest', async request => { Object.defineProperty(request.raw.socket, 'encrypted', { value: true }); });
  const bodies: Array<{ route: string; status: number; body: string }> = [];
  const keep = <T extends { statusCode: number; body: string }>(route: string, response: T): T => { bodies.push({ route, status: response.statusCode, body: response.body }); return response; };
  try {
    // Evidence with raw bytes and a private key, reached by every kind of read.
    const text = 'Lemur-6604: the plumber quoted 900 ILS and will come by Friday.';
    const uploaded = keep('POST /v1/documents', await app.inject({ method: 'POST', url: '/v1/documents', headers: headers(o, 'evidence.ingest'),
      payload: { documentId: 'quote', pages: [{ page: 1, text }], sensitivity: 'PRIVATE', allowedPurposes: ['PERSONAL_ASSISTANCE'],
        base64: Buffer.from(text).toString('base64') } }));
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    const evidenceId = uploaded.json().evidenceId as string;
    const ingestKey = randomBytes(16).toString('hex');
    keep('POST /v1/evidence', await app.inject({ method: 'POST', url: '/v1/evidence', headers: { ...headers(o, 'evidence.ingest'), 'idempotency-key': ingestKey },
      payload: { ownerScopeId: o.owner, sourceType: 'DOCUMENT', connectorId: null, externalId: 'note:' + randomUUID(), actorRef: { type: 'USER', id: o.actor },
        occurredAt: null, content: { text: 'A second note' }, sensitivity: 'PRIVATE', allowedPurposes: ['PERSONAL_ASSISTANCE'], idempotencyKey: ingestKey } }));
    const connector = keep('POST /v1/connectors', await app.inject({ method: 'POST', url: '/v1/connectors', headers: headers(o, 'connector.manage'), payload: {
      connectorType: 'GMAIL', externalAccountRef: 'owner@example.test', secretRef: 'secret://mounted/gmail#access_token',
      requestedCapabilities: [{ capabilityId: 'gmail.read_metadata', granted: true }] } }));
    const connectorId = connector.json().connectorId as string;
    keep('POST /v1/export', await app.inject({ method: 'POST', url: '/v1/export', headers: headers(o, 'data.export'), payload: { includeRawEvidence: true } }));
    keep('POST /v1/memory/context', await app.inject({ method: 'POST', url: '/v1/memory/context', headers: headers(o, 'memory.read'), payload: {
      ownerScopeId: o.owner, requestingActorId: o.actor, purpose: 'PERSONAL_ASSISTANCE', query: 'plumber quote', worldTime: 'NOW',
      knowledgeTime: 'LATEST', maximumSensitivity: 'RESTRICTED', actionRisk: 'LOW' } }));
    keep('POST /v1/data/deletions/preview', await app.inject({ method: 'POST', url: '/v1/data/deletions/preview', headers: headers(o, 'data.delete'),
      payload: { evidenceIds: [evidenceId] } }));

    const keys = (await admin.query('SELECT object_store_key FROM evidence_object_keys WHERE owner_scope_id=$1', [o.owner])).rows
      .map(row => row.object_store_key as string);
    expect(keys.length).toBe(2);

    // Every GET route, with real identifiers where it takes one.
    const routes = await registeredGetRoutes();
    expect(routes.length).toBeGreaterThanOrEqual(38);
    const params: Record<string, string> = { ':id': evidenceId, ':objectType': 'propositions' };
    const concrete = (route: string) => route === '/v1/connectors/:id' || route === '/v1/connectors/:id/capabilities'
      ? route.replace(':id', connectorId) : route.replace(/:[a-zA-Z]+/g, name => params[name] ?? randomUUID());
    const query: Record<string, string> = { '/v1/documents/search': '?q=Lemur-6604', '/v1/weekly-review': '?weekStart=2026-09-14',
      '/v1/answers/reconsideration-candidates': '?beliefId=' + randomUUID() };
    for (const route of routes) {
      const purpose = routePurpose('GET', route);
      expect(purpose, route + ' has a purpose').not.toBeNull();
      keep('GET ' + route, await app.inject({ method: 'GET', url: concrete(route) + (query[route] ?? ''), headers: headers(o, purpose!) }));
    }
    const answered = bodies.filter(entry => entry.status === 200 || entry.status === 201);
    expect(answered.length, JSON.stringify(bodies.map(entry => [entry.route, entry.status]))).toBeGreaterThanOrEqual(30);
    // The evidence read really did return the item -- its public reference, not its key.
    const read = bodies.find(entry => entry.route === 'GET /v1/evidence/:id')!;
    expect(read.status).toBe(200);
    expect(JSON.parse(read.body).rawObjectRef).toMatch(/^[0-9a-f-]{36}$/);
    for (const entry of bodies) {
      for (const key of keys) expect(entry.body, entry.route).not.toContain(key);
      expect(entry.body, entry.route).not.toMatch(RAW_KEY);
      expect(entry.body, entry.route).not.toMatch(/object_store_key|objectStoreKey|encryption_key_ref/);
    }
  } finally { await app.close(); }
  // Nor can the application role's evidence reads reach the key table without the
  // evidence access context that authorizes the object itself.
  await withOwnerTransaction(appPool, { actorId: o.actor, ownerScopeId: o.owner, purpose: 'evidence.read', correlationId: randomUUID() }, async tx => {
    expect((await tx.query('SELECT object_store_key FROM evidence_object_keys')).rows).toEqual([]);
  });
});
