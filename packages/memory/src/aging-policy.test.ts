import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { runMigrations } from '@unai/postgres';
import { readAgingPolicy } from './aging.js';

if (!process.env.UNAI_TEST_DATABASE_URL) throw new Error('Run pnpm test for the required PostgreSQL harness');
const pool = new Pool({ connectionString: process.env.UNAI_TEST_DATABASE_URL });
beforeAll(async () => { await runMigrations(pool, resolve('migrations')); });
afterAll(async () => { await pool.end(); });
const policy = { policyId: 'aging.shared.obligation.principal_amount', policyVersion: '9998.0.1', kind: 'UNRESOLVED',
  frameTypeId: 'shared.obligation', predicateId: 'shared.obligation.principal_amount', reviewAfterDays: 30,
  verificationTrigger: 'WHEN_RELEVANT', explanation: 'Review when relevant; no completion through silence.' };

// Rollback all fixture snapshot rows: other suites deliberately assert global
// release counts. These rows exercise the deployed SQL reader, not publication.
async function fixture(run: (client: PoolClient, ids: { releaseId: string; owner: string; actor: string }) => Promise<void>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ids = { releaseId: randomUUID(), owner: randomUUID(), actor: randomUUID() };
    await client.query("INSERT INTO users(id,display_name) VALUES($1,'Aging reader')", [ids.actor]);
    await client.query("INSERT INTO owner_scopes(id,scope_kind,display_name,created_by_user_id) VALUES($1,'PERSONAL','Aging',$2)", [ids.owner, ids.actor]);
    await client.query("INSERT INTO owner_scope_members(owner_scope_id,user_id,role) VALUES($1,$2,'OWNER')", [ids.owner, ids.actor]);
    await client.query(`INSERT INTO registry_releases(id,semantic_version,git_tag,git_commit,content_hash,lifecycle,released_at,manifest,correlation_id)
      VALUES($1,'9998.0.1','registry-v9998.0.1',$2,$3,'RELEASED',now(),'{}',$4)`, [ids.releaseId, 'a'.repeat(40), 'b'.repeat(64), randomUUID()]);
    await client.query(`INSERT INTO registry_contracts(id,registry_release_id,contract_id,contract_version,contract_kind,content,content_hash)
      VALUES($1,$2,$3,'9998.0.1','PREDICATE',$4,$5)`, [randomUUID(), ids.releaseId, policy.predicateId,
      JSON.stringify({ agingPolicy: policy, secretUnrelatedField: 'never returned' }), 'c'.repeat(64)]);
    await client.query('SET LOCAL ROLE unai_app');
    await client.query(`SELECT set_config('unai.owner_scope_id',$1,true),set_config('unai.actor_id',$2,true),
      set_config('unai.purpose','memory.read',true)`, [ids.owner, ids.actor]);
    await run(client, ids);
  } finally { await client.query('ROLLBACK'); client.release(); }
}

it('reads only a precisely pinned policy and release identity; unknown pins and predicates remain unknown', async () => {
  await fixture(async (client, { releaseId }) => {
    expect(await readAgingPolicy(client, { registryReleaseId: releaseId, predicateId: policy.predicateId }))
      .toEqual({ releaseId, releaseVersion: '9998.0.1', releaseContentHash: 'b'.repeat(64), policy });
    expect(await readAgingPolicy(client, { registryReleaseId: randomUUID(), predicateId: policy.predicateId })).toBeNull();
    expect(await readAgingPolicy(client, { registryReleaseId: releaseId, predicateId: 'shared.obligation.description' })).toBeNull();
    expect(await readAgingPolicy(client, { registryReleaseId: null, predicateId: policy.predicateId })).toBeNull();
    await client.query("SELECT set_config('unai.purpose','memory.inspect',true)");
    expect(await readAgingPolicy(client, { registryReleaseId: releaseId, predicateId: policy.predicateId })).not.toBeNull();
    await client.query('SAVEPOINT direct_read');
    await expect(client.query('SELECT * FROM registry_contracts')).rejects.toMatchObject({ code: '42501' });
    await client.query('ROLLBACK TO SAVEPOINT direct_read');
  });
});

it('requires an authorized owner member and memory purpose even though policies are global metadata', async () => {
  await fixture(async (client, { releaseId, owner, actor }) => {
    const read = () => readAgingPolicy(client, { registryReleaseId: releaseId, predicateId: policy.predicateId });
    await client.query("SELECT set_config('unai.purpose','evidence.ingest',true)"); expect(await read()).toBeNull();
    await client.query("SELECT set_config('unai.purpose','memory.read',true),set_config('unai.actor_id',$1,true)", [randomUUID()]);
    expect(await read()).toBeNull();
    await client.query("SELECT set_config('unai.actor_id',$1,true),set_config('unai.owner_scope_id',$2,true)", [actor, randomUUID()]);
    expect(await read()).toBeNull();
    await client.query("SELECT set_config('unai.owner_scope_id',$1,true)", [owner]); expect(await read()).not.toBeNull();
  });
});
