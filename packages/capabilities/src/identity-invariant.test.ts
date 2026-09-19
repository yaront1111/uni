import { Pool } from 'pg';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { runMigrations, withOwnerTransaction, type OwnerTransaction } from '@unai/postgres';
import { lintRegistryCheckout, loadRegistryRelease, publishRegistryRelease } from '@unai/registry';
import { commitBeliefTransaction, proposeBeliefTransaction, type BeliefTransactionRunner } from '@unai/belief';
import {
  createBeliefSlot, createFrameInstance, createProposition, recordClaim, recordOverlayDelta, recordResolutionAssertion,
  resolveEntity,
} from '@unai/memory';
import { applyProjectionDelta, replayProjection } from './index.js';
import { uuidV7 } from '../../../src/kernel/identities.js';

/**
 * CRT-MEM-03-A: the surrogate-identity invariant across every durable object
 * kind the criterion names (PRD §13.1, §42 invariant 27; ADR 0025 §5).
 *
 * Frame instances, belief slots, propositions, claims, resolution assertions,
 * registry releases, belief transactions, overlay deltas and projection versions
 * are each created here through the production code path that creates them in
 * the running system -- the memory stores, the write governor, the registry
 * publisher, the overlay allocator and the projection reducer -- and every
 * identifier is then checked three ways:
 *
 *  1. it is a valid UUIDv7 whose timestamp is the moment it was minted;
 *  2. two objects created from identical content receive different ids, so the
 *     id cannot be a function of the content;
 *  3. no id equals, or appears inside, any content hash, fingerprint or packet
 *     hash stored anywhere in the database, and none equals the hash of its own
 *     row's content.
 *
 * The file owns a database of its own: publishing a registry release is
 * permanent, and the shared suite database must hold exactly one (see
 * `packages/registry/src/snapshot.test.ts`).
 */

if (!process.env.UNAI_TEST_DATABASE_URL) throw new Error('Run pnpm test for the required PostgreSQL harness');
const serverUrl = process.env.UNAI_TEST_DATABASE_URL;
const databaseName = 'unai_identity_' + randomUUID().replaceAll('-', '');
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let admin: Pool | undefined;
let appPool: Pool | undefined;
let unavailable: string | null = null;
let repository = '';
const owner = randomUUID(), actor = randomUUID();
let contextSpaceId = '', sourceItemId = '', anchorId = '';

/** Migrate a database of this file's own. Roles are cluster-global and migration
 * 0001 alters them, while `runMigrations` serializes only within one database, so
 * two files migrating fresh databases at once would race on the same role rows.
 * Both such files take this advisory lock on the shared suite database first. */
async function migrateScratch(pool: Pool): Promise<void> {
  const shared = new Pool({ connectionString: serverUrl, max: 1 });
  const client = await shared.connect();
  try {
    await client.query('SELECT pg_advisory_lock(1970170217, 3)');
    await runMigrations(pool, resolve('migrations'));
  } finally {
    await client.query('SELECT pg_advisory_unlock(1970170217, 3)').catch(() => undefined);
    client.release();
    await shared.end().catch(() => undefined);
  }
}

beforeAll(async () => {
  const server = new Pool({ connectionString: serverUrl, max: 1 });
  try { await server.query('CREATE DATABASE ' + databaseName); }
  catch (error) { unavailable = error instanceof Error ? error.message : String(error); return; }
  finally { await server.end().catch(() => {}); }
  const url = new URL(serverUrl); url.pathname = '/' + databaseName;
  admin = new Pool({ connectionString: url.href });
  await migrateScratch(admin);
  await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='identity_test_app') THEN CREATE ROLE identity_test_app LOGIN PASSWORD 'test-only'; END IF; END $$; GRANT unai_app TO identity_test_app");
  const appUrl = new URL(url.href); appUrl.username = 'identity_test_app'; appUrl.password = 'test-only';
  appPool = new Pool({ connectionString: appUrl.href });

  await admin.query('INSERT INTO users(id,display_name) VALUES($1,$2)', [actor, 'Identity owner']);
  await admin.query("INSERT INTO owner_scopes(id,scope_kind,display_name,created_by_user_id) VALUES($1,'PERSONAL','Identity',$2)", [owner, actor]);
  await admin.query("INSERT INTO owner_scope_members(owner_scope_id,user_id,role) VALUES($1,$2,'OWNER')", [owner, actor]);
  contextSpaceId = (await admin.query('SELECT id FROM context_spaces WHERE owner_scope_id=$1', [owner])).rows[0].id;
  const connectorId = randomUUID(); sourceItemId = randomUUID(); anchorId = randomUUID();
  await admin.query("INSERT INTO connectors(id,owner_scope_id,connector_type,external_account_ref,permission_manifest,status) VALUES($1,$2,'CONVERSATION',$3,'{}','ACTIVE')", [connectorId, owner, owner]);
  await admin.query(`INSERT INTO source_items(id,owner_scope_id,connector_id,source_type,external_id,actor_ref,submitted_by_user_id,
    raw_object_ref,content_hash,sensitivity,allowed_purposes,ingestion_version,idempotency_key)
    VALUES($1,$2,$3,'CONVERSATION','identity-message-1',$4,$5,$6,$7,'PRIVATE',ARRAY['PERSONAL_ASSISTANCE'],'evidence-json-v1',$8)`,
    [sourceItemId, owner, connectorId, JSON.stringify({ type: 'USER', id: actor }), actor, randomUUID(),
      createHash('sha256').update('I owe Daniel ILS 50').digest('hex'), randomUUID()]);
  await admin.query(`INSERT INTO source_anchors(id,owner_scope_id,source_item_id,anchor_kind,anchor) VALUES($1,$2,$3,'MESSAGE_SPAN','{"start":0,"end":19}')`,
    [anchorId, owner, sourceItemId]);

  // A real release, loaded by its immutable Git tag, exactly as the snapshot
  // publisher receives it in a deployment.
  repository = await mkdtemp(join(tmpdir(), 'unai-identity-registry-'));
  await cp(resolve('registry'), join(repository, 'registry'), { recursive: true });
  const git = (...args: string[]) => {
    const result = spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=Identity Test', '-c', 'user.email=identity@test.invalid', ...args],
      { cwd: repository, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
  };
  git('init', '--quiet'); git('add', 'registry'); git('commit', '--quiet', '-m', 'release'); git('tag', 'registry-v0.1.0');
});
afterAll(async () => {
  await appPool?.end(); await admin?.end();
  if (repository) await rm(repository, { recursive: true, force: true });
  if (!unavailable) {
    const server = new Pool({ connectionString: serverUrl, max: 1 });
    try { await server.query('DROP DATABASE IF EXISTS ' + databaseName + ' WITH (FORCE)'); }
    finally { await server.end().catch(() => {}); }
  }
});

const as = <T,>(purpose: string, run: (tx: OwnerTransaction) => Promise<T>) =>
  withOwnerTransaction(appPool!, { actorId: actor, ownerScopeId: owner, purpose, correlationId: randomUUID() }, run);

/** The millisecond timestamp a UUIDv7 carries in its first 48 bits. */
const mintedAt = (id: string) => parseInt(id.replaceAll('-', '').slice(0, 12), 16);

it('CRT-MEM-03-A: every durable object kind receives a valid UUIDv7 that is neither a content hash nor derived from one', async () => {
  expect(unavailable, 'the harness server refused a disposable database for this file').toBeNull();
  const started = Date.now();
  const minted: Record<string, string[]> = {};
  const keep = (kind: string, ...ids: string[]) => { (minted[kind] ??= []).push(...ids); };

  // Registry release: published from the Git tag by the deployment publisher.
  const release = await loadRegistryRelease({ repository, version: '0.1.0' });
  const published = await publishRegistryRelease(admin!, release, randomUUID());
  keep('registry_releases', published.releaseId);
  const transitions = [...(await lintRegistryCheckout({ repository: resolve('.'), version: '0.1.0' })).transitions];

  // Frame instances, belief slots, propositions and claims: two of each from
  // identical content, through the canonical identity stores.
  const daniel = (await as('memory.canonicalize', tx => resolveEntity(tx, { ownerScopeId: owner, entityKind: 'PERSON',
    canonicalLabel: 'Daniel', aliases: [{ aliasType: 'EMAIL', aliasValue: 'daniel.identity@example.test' }] }))).entityId;
  for (let copy = 0; copy < 2; copy += 1) {
    await as('memory.canonicalize', async tx => {
      const frameInstanceId = await createFrameInstance(tx, { ownerScopeId: owner, frameTypeId: 'shared.obligation', contextSpaceId });
      keep('frame_instances', frameInstanceId);
      // The same descriptor twice on one frame is legal (no fingerprint is a key)
      // and must still yield two identities.
      const descriptor = { frameInstanceId, predicateId: 'shared.obligation.principal_amount', contextSpaceId,
        modality: 'ACTUAL' as const, qualifiers: {} };
      const slots = [await createBeliefSlot(tx, { ownerScopeId: owner, descriptor, registryReleaseId: published.releaseId }),
        await createBeliefSlot(tx, { ownerScopeId: owner, descriptor, registryReleaseId: published.releaseId })];
      keep('belief_slots', ...slots);
      const value = { amount: '50.00', currency: 'ILS' };
      const propositions = [await createProposition(tx, { ownerScopeId: owner, beliefSlotId: slots[0]!, normalizedValue: value }),
        await createProposition(tx, { ownerScopeId: owner, beliefSlotId: slots[0]!, normalizedValue: value })];
      keep('propositions', ...propositions);
      for (let claim = 0; claim < 2; claim += 1) {
        keep('claims', await recordClaim(tx, { ownerScopeId: owner, sourceAnchorId: anchorId, propositionId: propositions[0]!,
          claimOrigin: 'USER_STATEMENT', lifecycle: 'PROVISIONAL', assertedByEntityId: daniel }));
      }
      // Resolution assertions: the same settlement asserted twice.
      for (let assertion = 0; assertion < 2; assertion += 1) {
        keep('resolution_assertions', (await recordResolutionAssertion(tx, {
          ownerScopeId: owner, sourceFrameInstanceId: frameInstanceId, sourceFrameTypeId: 'shared.obligation',
          outcomeCode: 'FULFILLED', effectiveAt: new Date('2026-09-01T00:00:00.000Z'), assertedByEntityId: daniel,
          claimId: minted['claims']!.at(-1)!, transitionContractId: 'shared.obligation.resolution', transitionContracts: transitions,
        })).resolutionAssertionId);
      }
    });
  }

  // Belief transactions, through the write governor, pinned to the real release.
  const runner: BeliefTransactionRunner = (purpose, run) => as(purpose, async tx => {
    await tx.query("SELECT set_config('unai.data_purpose','PERSONAL_ASSISTANCE',true),set_config('unai.maximum_sensitivity','RESTRICTED',true)");
    return run(tx);
  });
  const governed = { ownerScopeId: owner, actorId: actor, correlationId: randomUUID(),
    dataPurpose: 'PERSONAL_ASSISTANCE', maximumSensitivity: 'RESTRICTED' as const };
  for (let copy = 0; copy < 2; copy += 1) {
    const idempotencyKey = randomUUID().replaceAll('-', '');
    const proposed = await proposeBeliefTransaction(runner, governed, { transactionKind: 'CANONICALIZE',
      registryReleaseId: published.releaseId, risk: 'LOW', idempotencyKey, sourceEvidenceIds: [sourceItemId],
      operations: [{ kind: 'CREATE_FRAME_INSTANCE', operationRef: '#obligation', frameTypeId: 'shared.obligation' }] });
    keep('belief_transactions', proposed.transactionId);
    const receipt = await commitBeliefTransaction(runner, governed, { transactionId: proposed.transactionId, idempotencyKey });
    keep('frame_instances', ...receipt.createdObjects.map(object => object.objectId));
  }

  // Overlay deltas: the same owner sentence twice, through the allocator.
  for (let copy = 0; copy < 2; copy += 1) {
    keep('owner_overlay_deltas', (await as('memory.correct', tx => recordOverlayDelta(tx, {
      ownerScopeId: owner, deltaKind: 'USER_ASSERTION', rawText: 'I paid him back', sourceEvidenceId: sourceItemId,
    }))).overlayDeltaId);
  }

  // Projection versions: two runs of the reducer over identical canonical input.
  for (let copy = 0; copy < 2; copy += 1) {
    const applied = await as('memory.project', tx => applyProjectionDelta(tx, { ownerScopeId: owner,
      projectionName: 'obligations_projection', asOf: new Date('2026-09-02T00:00:00.000Z') }));
    keep('projection_versions', applied.projectionVersion);
  }
  const receipt = await as('memory.project', tx => replayProjection(tx, { ownerScopeId: owner,
    projectionName: 'obligations_projection', asOf: new Date('2026-09-02T00:00:00.000Z') }));
  keep('projection_versions', receipt.projectionVersion);
  const finished = Date.now();

  // Every kind the criterion names is represented, from the rows actually stored.
  expect(Object.keys(minted).sort()).toEqual(['belief_slots', 'belief_transactions', 'claims', 'frame_instances',
    'owner_overlay_deltas', 'projection_versions', 'propositions', 'registry_releases', 'resolution_assertions']);
  for (const [table, column] of [['frame_instances', 'id'], ['belief_slots', 'id'], ['propositions', 'id'], ['claims', 'id'],
    ['resolution_assertions', 'id'], ['registry_releases', 'id'], ['belief_transactions', 'id'], ['owner_overlay_deltas', 'id']] as const) {
    const stored = (await admin!.query(`SELECT ${column} AS id FROM ${table} WHERE ${column}=ANY($1::uuid[])`, [minted[table]])).rows
      .map((row: { id: string }) => row.id).sort();
    expect(stored, table).toEqual([...new Set(minted[table])].sort());
  }
  const projectionVersions = (await admin!.query('SELECT DISTINCT projection_version FROM obligations_projection WHERE owner_scope_id=$1', [owner])).rows
    .map((row: { projection_version: string }) => row.projection_version);
  expect(projectionVersions.every((version: string) => minted['projection_versions']!.includes(version))).toBe(true);

  // 1. Valid UUIDv7, minted at the moment of creation.
  for (const [kind, ids] of Object.entries(minted)) {
    for (const id of ids) {
      expect(id, kind).toMatch(UUID_V7);
      expect(mintedAt(id), kind).toBeGreaterThanOrEqual(started - 1000);
      expect(mintedAt(id), kind).toBeLessThanOrEqual(finished + 1000);
    }
    // 2. Identical content never yields the same id.
    expect(new Set(ids).size, kind).toBe(ids.length);
  }

  // 3. No id is, or is contained in, any hash or fingerprint anywhere.
  const hashes = (await admin!.query(`
    SELECT content_hash AS value FROM source_items UNION ALL SELECT fingerprint FROM slot_fingerprints
    UNION ALL SELECT fingerprint FROM proposition_fingerprints UNION ALL SELECT content_hash FROM registry_releases
    UNION ALL SELECT content_hash FROM registry_contracts UNION ALL SELECT packet_hash FROM context_packets`)).rows
    .map((row: { value: string }) => row.value.toLowerCase());
  expect(hashes.length).toBeGreaterThan(0);
  const everyId = Object.values(minted).flat();
  for (const id of everyId) {
    const hex = id.replaceAll('-', '');
    for (const hash of hashes) {
      expect(hash === id || hash === hex || hash.includes(hex) || hash.includes(hex.slice(12))).toBe(false);
    }
  }
  // ...and none is the digest of the row it names, under the canonical forms the
  // system hashes (the fingerprint descriptors and the release content).
  const descriptors = (await admin!.query(`SELECT belief_slot_id AS id,descriptor::text AS body FROM slot_fingerprints
    UNION ALL SELECT proposition_id,descriptor::text FROM proposition_fingerprints`)).rows;
  for (const row of descriptors as Array<{ id: string; body: string }>) {
    const digest = createHash('sha256').update(row.body).digest('hex');
    expect(digest.startsWith(row.id.replaceAll('-', '').slice(0, 8))).toBe(false);
  }
  expect(release.contentHash).not.toContain(published.releaseId.replaceAll('-', '').slice(0, 12));
});

it('CRT-MEM-03-A: every production writer of the nine kinds mints ids with the zero-argument uuidV7 and never with randomUUID or a hash', async () => {
  // The one generator takes no input at all, so it cannot be fed content.
  expect(uuidV7.length).toBe(0);
  const tables = ['frame_instances', 'belief_slots', 'propositions', 'claims', 'resolution_assertions', 'registry_releases',
    'belief_transactions', 'owner_overlay_deltas'];
  const writers: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') await walk(path); continue; }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
      const text = await readFile(path, 'utf8');
      if (!tables.some(table => new RegExp('INSERT INTO ' + table + '\\s*\\(\\s*id\\b').test(text))) continue;
      writers.push(path.replaceAll('\\', '/').replace(/^.*\/packages\//, 'packages/'));
      expect(text, path).toMatch(/uuidV7\(\)/);
      expect(text, path).toMatch(/from '\.\.\/\.\.\/\.\.\/src\/kernel\/identities\.js'/);
      expect(text, path).not.toMatch(/randomUUID/);
    }
  };
  await walk(resolve('packages'));
  // The writers this invariant covers, found rather than listed by hand.
  expect(writers.sort()).toEqual(expect.arrayContaining(['packages/belief/src/transactions.ts', 'packages/memory/src/claims.ts',
    'packages/memory/src/overlay.ts', 'packages/memory/src/resolutions.ts', 'packages/memory/src/slots.ts',
    'packages/registry/src/snapshot.ts']));
  // A projection version is the reducer run's own mint.
  const reducer = await readFile(resolve('packages/capabilities/src/projections.ts'), 'utf8');
  expect(reducer).toMatch(/projectionVersion: uuidV7\(\)/);
});
