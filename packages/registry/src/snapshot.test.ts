import { afterAll, beforeAll, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { runMigrations } from '@unai/postgres';
import * as registry from './index.js';

if (!process.env.UNAI_TEST_DATABASE_URL) throw new Error('Run pnpm test for the required PostgreSQL harness');
const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
let pool: Pool, repository: string;
let release: registry.LoadedRegistryRelease;

// Fixed identity and timestamps, so the fixture tag resolves to the same commit on
// every run: the published 0.1.0 snapshot is immutable and its version is unique, so
// a rerun against a server a previous run used must republish the same release rather
// than a new commit the snapshot would refuse as a conflict.
const committed = '2024-01-01T00:00:00Z';
function git(...args: string[]) {
  const result = spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=Registry Test', '-c', 'user.email=registry@test.invalid', ...args],
    { cwd: repository, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: committed, GIT_COMMITTER_DATE: committed } });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

beforeAll(async () => {
  // Roles are cluster-global, so use the shared suite database; migrations are serialized and idempotent.
  pool = new Pool({ connectionString: process.env.UNAI_TEST_DATABASE_URL });
  await runMigrations(pool, resolve('migrations'));
  repository = await mkdtemp(join(tmpdir(), 'unai-registry-publish-'));
  await cp(resolve('registry'), join(repository, 'registry'), { recursive: true });
  git('init', '--quiet'); git('add', 'registry'); git('commit', '--quiet', '-m', 'release'); git('tag', 'registry-v0.1.0');
  release = await registry.loadRegistryRelease({ repository, version: '0.1.0' });
});
afterAll(async () => {
  await pool?.end();
  if (repository) await rm(repository, { recursive: true, force: true });
});

it('materializes the tag-loaded release immutably with public UUIDv7 identifiers and publication audit fields', async () => {
  const correlationId = randomUUID();
  // On a freshly provisioned database this publishes; against a server a previous run
  // already used, the immutable snapshot must answer ALREADY_PUBLISHED and still carry
  // the correlation id of the publication that created the row.
  const prior = (await pool.query('SELECT correlation_id FROM registry_releases')).rows[0]?.correlation_id as string | undefined;
  const outcome = await registry.publishRegistryRelease(pool, release, correlationId);
  expect(outcome.outcome).toBe(prior ? 'ALREADY_PUBLISHED' : 'PUBLISHED');
  expect(outcome.releaseId).toMatch(uuidV7);
  const row = (await pool.query('SELECT *, current_user AS principal FROM registry_releases')).rows[0];
  expect(row).toMatchObject({ id: outcome.releaseId, semantic_version: '0.1.0', git_tag: 'registry-v0.1.0', git_commit: release.gitCommit,
    content_hash: release.contentHash, lifecycle: 'RELEASED', correlation_id: prior ?? correlationId });
  expect(row.published_by).toBe(row.principal);
  expect(row.released_at).toBeInstanceOf(Date);
  expect(row.id).not.toContain(release.contentHash.slice(0, 8));
  const contracts = (await pool.query('SELECT * FROM registry_contracts WHERE registry_release_id=$1', [outcome.releaseId])).rows;
  const predicates = release.frames.flatMap(frame => frame.predicates);
  expect(contracts).toHaveLength(release.frames.length + predicates.length + release.transitions.length);
  expect(contracts.filter(c => c.contract_kind === 'FRAME').map(c => c.contract_id).sort())
    .toEqual(['finance.payment_allocation', 'shared.commitment', 'shared.event_occurrence', 'shared.obligation']);
  expect(contracts.filter(c => c.contract_kind === 'PREDICATE').map(c => c.contract_id).sort()).toEqual(predicates.map(p => p.id).sort());
  for (const contract of contracts) {
    expect(contract.id).toMatch(uuidV7);
    expect(contract.contract_version).toBe('0.1.0');
    expect(contract.content_hash).toBe(createHash('sha256').update(registry.canonicalJson(contract.content)).digest('hex'));
  }
});

it('is idempotent for the same tag and refuses a different hash or commit for a published version', async () => {
  const first = await registry.publishRegistryRelease(pool, release, randomUUID());
  const again = await registry.publishRegistryRelease(pool, release, randomUUID());
  expect(again).toEqual({ releaseId: first.releaseId, outcome: 'ALREADY_PUBLISHED' });
  expect((await pool.query('SELECT count(*)::int AS n FROM registry_releases')).rows[0].n).toBe(1);
  await expect(registry.publishRegistryRelease(pool, { ...release, contentHash: 'b'.repeat(64) }, randomUUID()))
    .rejects.toThrow('REGISTRY_RELEASE_CONFLICT');
  await expect(registry.publishRegistryRelease(pool, { ...release, gitCommit: 'c'.repeat(40) }, randomUUID()))
    .rejects.toThrow('REGISTRY_RELEASE_CONFLICT');
});

it('publishes only releases loaded from an immutable Git tag', async () => {
  const checkout = await registry.lintRegistryCheckout({ repository, version: '0.1.0' });
  await expect(registry.publishRegistryRelease(pool, checkout, randomUUID())).rejects.toThrow('REGISTRY_TAG_SOURCE_REQUIRED');
  await expect(registry.publishRegistryRelease(pool, release, 'not-a-uuid')).rejects.toThrow('REGISTRY_CORRELATION_ID_INVALID');
});

it('refuses update, delete and truncate of the snapshot, even for the privileged principal', async () => {
  await registry.publishRegistryRelease(pool, release, randomUUID());
  await expect(pool.query("UPDATE registry_releases SET lifecycle='RELEASED'")).rejects.toThrow('REGISTRY_SNAPSHOT_IMMUTABLE');
  await expect(pool.query('DELETE FROM registry_contracts')).rejects.toThrow('REGISTRY_SNAPSHOT_IMMUTABLE');
  await expect(pool.query("UPDATE registry_contracts SET content='{}'")).rejects.toThrow('REGISTRY_SNAPSHOT_IMMUTABLE');
  await expect(pool.query('TRUNCATE registry_contracts, registry_releases')).rejects.toThrow('REGISTRY_SNAPSHOT_IMMUTABLE');
});

it('grants the application role no registry snapshot read or write access', async () => {
  const client = await pool.connect();
  try {
    for (const statement of ['SELECT * FROM registry_releases', 'SELECT * FROM registry_contracts',
      "INSERT INTO registry_releases(id,semantic_version,git_tag,git_commit,content_hash,lifecycle,manifest,correlation_id) VALUES (gen_random_uuid(),'9.9.9','registry-v9.9.9','" + 'a'.repeat(40) + "','" + 'a'.repeat(64) + "','RELEASED','{}',gen_random_uuid())"]) {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE unai_app');
      await expect(client.query(statement)).rejects.toMatchObject({ code: '42501' });
      await client.query('ROLLBACK');
    }
  } finally { client.release(); }
});
