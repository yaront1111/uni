import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { postgresAdapter } from '@unai/auth';
import { runMigrations } from '@unai/postgres';

if (!process.env.UNAI_TEST_DATABASE_URL) throw new Error('Run pnpm test for the required PostgreSQL harness');

it('upgrades already queued document extraction without manufacturing assertion time or scheduling unrequested documents', async () => {
  const server = new Pool({ connectionString: process.env.UNAI_TEST_DATABASE_URL, max: 1 });
  const database = 'unai_processing_upgrade_' + randomUUID().replaceAll('-', '');
  const directory = await mkdtemp(join(tmpdir(), 'unai-processing-upgrade-'));
  let databaseCreated = false;
  let scratch: Pool | undefined;
  const lock = await server.connect();
  try {
    // Other scratch-database suites use this same lock for cluster-global roles.
    await lock.query('SELECT pg_advisory_lock(1970170217,3)');
    await lock.query('CREATE DATABASE ' + database); databaseCreated = true;
    const url = new URL(process.env.UNAI_TEST_DATABASE_URL!); url.pathname = '/' + database;
    scratch = new Pool({ connectionString: url.href });
    for (const file of await readdir(resolve('migrations'))) {
      if (/^\d{4}_.*\.sql$/.test(file) && file.slice(0,4) <= '0030') await cp(resolve('migrations',file),join(directory,file));
    }
    await runMigrations(scratch,directory);
    const user = await postgresAdapter(scratch).createUser!({ name:'Upgrade owner',email:randomUUID()+'@example.test',emailVerified:null });
    const owner = (user as unknown as {ownerScopeId:string}).ownerScopeId;
    const releaseId = randomUUID();
    async function legacyDocument(occurredAt: string|null, queued: boolean, status='PENDING') {
      const sourceId=randomUUID(),jobId=randomUUID();
      await scratch!.query(`INSERT INTO source_items(id,owner_scope_id,source_type,external_id,actor_ref,submitted_by_user_id,
        occurred_at,raw_object_ref,content_hash,deterministic_metadata,sensitivity,allowed_purposes,ingestion_version,idempotency_key)
        VALUES($1::uuid,$2,'DOCUMENT',$1::uuid::text,$3,$4,$5,$6,$7,$8,'PRIVATE',ARRAY['PERSONAL_ASSISTANCE'],'evidence-json-v1',$9)`,
      [sourceId,owner,JSON.stringify({type:'USER',id:user.id}),user.id,occurredAt,randomUUID(),'a'.repeat(64),
        JSON.stringify(occurredAt?{timeZone:'Asia/Jerusalem'}:{}),randomUUID()]);
      await scratch!.query(`INSERT INTO triage_decisions(id,owner_scope_id,source_item_id,tier0_parsed,tier1_route,routing_reason,cost_budget_microunits)
        VALUES($1,$2,$3,'{}','DEFER_UNTIL_RELEVANT','{"code":"DOCUMENT_DEFERRED","routerVersion":"triage-test"}',0)`,[randomUUID(),owner,sourceId]);
      if(queued) await scratch!.query(`INSERT INTO jobs(id,owner_scope_id,job_kind,payload,idempotency_key,status)
        VALUES($1,$2,'evidence.extract',$3,$4,$5)`,[jobId,owner,JSON.stringify({ownerScopeId:owner,sourceItemId:sourceId,
        registryReleaseId:releaseId,correlationId:randomUUID(),runKind:'FULL',dataPurpose:'PERSONAL_ASSISTANCE',maximumSensitivity:'PRIVATE',
        // This is the old upload-time fallback. The upgrade must use source time.
        referenceInstant:'2026-09-19T12:00:00.000Z',timeZone:'UTC'}),randomUUID(),status]);
      return {sourceId,jobId};
    }
    const unknown=await legacyDocument(null,true),known=await legacyDocument('2024-01-02T08:00:00Z',true);
    const unrequested=await legacyDocument(null,false),finished=await legacyDocument(null,true,'SUCCEEDED');
    await runMigrations(scratch,resolve('migrations'));
    const rows=(await scratch.query('SELECT * FROM evidence_processing WHERE owner_scope_id=$1',[owner])).rows;
    expect(rows).toHaveLength(2);
    expect(rows.find(row=>row.source_item_id===unknown.sourceId)).toMatchObject({job_id:unknown.jobId,registry_release_id:releaseId,
      status:'PENDING',run_kind:'TARGETED',reference_instant:null,time_zone:null,source_time_precision:'UNKNOWN',
      data_purpose:'PERSONAL_ASSISTANCE',maximum_sensitivity:'PRIVATE'});
    expect(rows.find(row=>row.source_item_id===known.sourceId)).toMatchObject({job_id:known.jobId,registry_release_id:releaseId,
      reference_instant:new Date('2024-01-02T08:00:00Z'),time_zone:'Asia/Jerusalem',source_time_precision:'EXACT_INSTANT'});
    expect(rows.some(row=>[unrequested.sourceId,finished.sourceId].includes(row.source_item_id))).toBe(false);
    expect((await scratch.query('SELECT payload FROM jobs WHERE id=$1',[unknown.jobId])).rows[0].payload).toMatchObject({
      runKind:'FULL',referenceInstant:'2026-09-19T12:00:00.000Z',timeZone:'UTC'});
    expect(await runMigrations(scratch,resolve('migrations'))).toEqual([]);
    expect((await scratch.query('SELECT count(*)::int AS n FROM jobs WHERE owner_scope_id=$1',[owner])).rows[0].n).toBe(3);
  } finally {
    await scratch?.end();
    if(databaseCreated)await lock.query('DROP DATABASE '+database);
    await lock.query('SELECT pg_advisory_unlock(1970170217,3)').catch(()=>undefined);
    lock.release();await server.end();
    await rm(directory,{recursive:true,force:true});
  }
},30000);
