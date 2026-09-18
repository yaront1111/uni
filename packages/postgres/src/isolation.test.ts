import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { withOwnerTransaction, assertOwnershipCoverage, runMigrations, OWNER_SCOPED_TABLES } from './index.js';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';

/** Every owner-scoped table this suite queries without an application filter.
 * The final test compares it with the ownership classification, so a new owner
 * table cannot reach migration exit without its own cross-owner fixture. */
const unfiltered=new Set<string>();
function readUnfiltered(client:import('pg').PoolClient,table:string){
  unfiltered.add(table);
  return client.query('SELECT * FROM '+table);
}

if (!process.env.UNAI_TEST_DATABASE_URL) throw new Error('Run pnpm test for the required PostgreSQL harness');
describe('real PostgreSQL owner isolation', () => {
  const pool = new Pool({ connectionString: process.env.UNAI_TEST_DATABASE_URL });
  const appUrl=new URL(process.env.UNAI_TEST_DATABASE_URL!); appUrl.username='unai_test_app'; appUrl.password='unai-test-only';
  const appPool=new Pool({connectionString:appUrl.href,max:1});
  const a = randomUUID(), b = randomUUID(), alice = randomUUID(), bob = randomUUID();
  beforeAll(async () => {
    await runMigrations(pool, resolve('migrations'));
    // Roles are cluster-global, so a server a previous suite run already used still
    // carries this fixture role: create it only when it is absent.
    await pool.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='unai_test_app') THEN CREATE ROLE unai_test_app LOGIN PASSWORD 'unai-test-only'; END IF; END $$; GRANT unai_app TO unai_test_app");
    await pool.query('INSERT INTO users (id, display_name) VALUES ($1,$2),($3,$4)', [alice,'Alice',bob,'Bob']);
    await pool.query('INSERT INTO owner_scopes (id, scope_kind, display_name, created_by_user_id) VALUES ($1,$2,$3,$4),($5,$2,$6,$7)', [a,'PERSONAL','A',alice,b,'B',bob]);
    await pool.query('INSERT INTO owner_scope_members (owner_scope_id,user_id,role) VALUES ($1,$2,$3),($4,$5,$3)', [a,alice,'OWNER',b,bob]);
    await pool.query('INSERT INTO devices (id,owner_scope_id,user_id,display_name) VALUES ($1,$2,$3,$4),($5,$6,$7,$8)', [randomUUID(),a,alice,'Desktop',randomUUID(),b,bob,'Phone']);
    for (const [owner,actor] of [[a,alice],[b,bob]]) {
      const connector=randomUUID(),source=randomUUID();
      const retry=randomUUID();
      await pool.query("INSERT INTO connectors(id,owner_scope_id,connector_type,external_account_ref,permission_manifest,status) VALUES($1,$2,'DOCUMENT',$3,'{}','ACTIVE')",[connector,owner,owner]);
      await pool.query("INSERT INTO source_items(id,owner_scope_id,connector_id,source_type,external_id,actor_ref,submitted_by_user_id,raw_object_ref,content_hash,sensitivity,allowed_purposes,ingestion_version,idempotency_key) VALUES($1,$2,$3,'DOCUMENT','fixture',$4,$5,$6,$7,'PRIVATE',ARRAY['PERSONAL_ASSISTANCE'],'evidence-json-v1',$8)",[source,owner,connector,JSON.stringify({type:'USER',id:actor}),actor,randomUUID(),'a'.repeat(64),randomUUID()]);
      await pool.query("INSERT INTO evidence_object_keys(id,owner_scope_id,source_item_id,object_store_key,encryption_key_ref) VALUES($1,$2,$3,$4,'kms:test')",[randomUUID(),owner,source,'raw/'+randomUUID()]);
      await pool.query("INSERT INTO source_anchors(id,owner_scope_id,source_item_id,anchor_kind,anchor) VALUES($1,$2,$3,'CONNECTOR_JSON_PATH','{\"path\":\"$.text\"}')",[randomUUID(),owner,source]);
      await pool.query('INSERT INTO evidence_ingestion_receipts(owner_scope_id,idempotency_key,source_item_id) VALUES($1,$2,$3)',[owner,retry,source]);
      await pool.query("INSERT INTO auth_identities(owner_scope_id,user_id,issuer,subject) VALUES($1,$2,'https://accounts.google.com',$3)",[owner,actor,actor]);
      await pool.query("INSERT INTO auth_sessions(owner_scope_id,user_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 day')",[owner,actor,actor!.replaceAll('-','').repeat(2)]);
      await pool.query("INSERT INTO audit_events (owner_scope_id,actor,purpose,objects_and_fields_accessed,policy_decision,model_or_code_version,result,correlation_id) VALUES ($1,$2,'test','[]','ALLOW','test','SUCCESS',$3)",[owner,actor,randomUUID()]);
      await pool.query("INSERT INTO jobs(id,owner_scope_id,job_kind,payload,idempotency_key) VALUES($1,$2,'evidence.extract',$3,$4)",
        [randomUUID(),owner,JSON.stringify({ownerScopeId:owner}),randomUUID().replaceAll('-','')+'fixture']);
      // Canonical identity: one row per owner in every identity table, so the
      // cross-owner sweep below covers them the same way it covers evidence.
      const anchor=(await pool.query('SELECT id FROM source_anchors WHERE owner_scope_id=$1 LIMIT 1',[owner])).rows[0].id;
      const context=(await pool.query('SELECT id FROM context_spaces WHERE owner_scope_id=$1',[owner])).rows[0].id;
      const entity=randomUUID(),merged=randomUUID(),instance=randomUUID(),slot=randomUUID(),proposition=randomUUID(),claim=randomUUID();
      await pool.query("INSERT INTO entities(id,owner_scope_id,entity_kind,canonical_label) VALUES($1,$2,'PERSON','Daniel'),($3,$2,'PERSON','Daniel')",[entity,owner,merged]);
      await pool.query("UPDATE entities SET lifecycle='MERGED',retired_at=now() WHERE id=$1",[merged]);
      await pool.query("INSERT INTO entity_aliases(id,owner_scope_id,entity_id,alias_type,alias_value,normalized_value,source_item_id) VALUES($1,$2,$3,'DISPLAY_NAME','Daniel','daniel',$4)",[randomUUID(),owner,entity,source]);
      await pool.query("INSERT INTO entity_lineage(id,owner_scope_id,from_entity_id,to_entity_id,lineage_kind) VALUES($1,$2,$3,$4,'MERGED_INTO')",[randomUUID(),owner,merged,entity]);
      await pool.query("INSERT INTO frame_instances(id,owner_scope_id,frame_type_id,context_space_id) VALUES($1,$2,'shared.obligation',$3)",[instance,owner,context]);
      await pool.query("INSERT INTO belief_slots(id,owner_scope_id,frame_instance_id,predicate_id,context_space_id,modality) VALUES($1,$2,$3,'shared.obligation.principal_amount',$4,'ACTUAL')",[slot,owner,instance,context]);
      await pool.query("INSERT INTO slot_fingerprints(id,owner_scope_id,belief_slot_id,normalization_version,fingerprint,descriptor) VALUES($1,$2,$3,'normalization-1',$4,'{}')",[randomUUID(),owner,slot,'b'.repeat(64)]);
      await pool.query(`INSERT INTO propositions(id,owner_scope_id,belief_slot_id,normalized_value) VALUES($1,$2,$3,'{"amount":"50.00","currency":"ILS"}')`,[proposition,owner,slot]);
      await pool.query("INSERT INTO proposition_fingerprints(id,owner_scope_id,proposition_id,normalization_version,fingerprint,descriptor) VALUES($1,$2,$3,'normalization-1',$4,'{}')",[randomUUID(),owner,proposition,'c'.repeat(64)]);
      await pool.query("INSERT INTO claims(id,owner_scope_id,source_anchor_id,proposition_id,claim_origin,lifecycle) VALUES($1,$2,$3,$4,'USER_STATEMENT','PROVISIONAL')",[claim,owner,anchor,proposition]);
      await pool.query("INSERT INTO frame_instance_roles(id,owner_scope_id,frame_instance_id,role_id,entity_id,claim_id) VALUES($1,$2,$3,'creditor',$4,$5)",[randomUUID(),owner,instance,entity,claim]);
    }
  });
  afterAll(async()=>{await appPool.end();await pool.end();});

  async function asOwner(owner: string, actor: string, run: (client: import('pg').PoolClient)=>Promise<void>, purpose='evidence.read') {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE unai_app');
      await client.query("SELECT set_config('unai.owner_scope_id',$1,true), set_config('unai.actor_id',$2,true)",[owner,actor]);
      await client.query("SELECT set_config('unai.purpose',$1,true),set_config('unai.data_purpose','PERSONAL_ASSISTANCE',true),set_config('unai.maximum_sensitivity','RESTRICTED',true)",[purpose]);
      await run(client);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }

  it('hides B from unfiltered owner A queries on every owner table', async()=>{
    await asOwner(a,alice,async c=>{
      for (const table of ['owner_scopes','owner_scope_members','devices','audit_events','connectors','source_items','source_anchors','evidence_object_keys','evidence_ingestion_receipts','context_spaces']) {
        const key=table==='owner_scopes'?'id':'owner_scope_id';
        const rows=(await readUnfiltered(c,table)).rows;
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every(row=>row[key]===a)).toBe(true);
      }
      unfiltered.add('users');
      expect((await c.query('SELECT id FROM users')).rows).toEqual([{id:alice}]);
      for(const table of ['auth_sessions','auth_identities']){
        unfiltered.add(table);
        const rows=(await c.query('SELECT owner_scope_id,user_id FROM '+table)).rows;
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every(row=>row.owner_scope_id===a&&row.user_id===alice)).toBe(true);
      }
    });
  });
  it('CRT-SEC-01-A: hides B from unfiltered owner A queue queries and refuses queue rows under another purpose',async()=>{
    await asOwner(a,alice,async c=>{
      const rows=(await readUnfiltered(c,'jobs')).rows;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every(row=>row.owner_scope_id===a)).toBe(true);
    },'ops.jobs.read');
    await asOwner(a,alice,async c=>{
      expect((await c.query('SELECT * FROM jobs')).rows).toEqual([]);
    });
    await asOwner(b,alice,async c=>{
      expect((await c.query('SELECT * FROM jobs')).rows).toEqual([]);
    },'ops.jobs.read');
    for(const sql of ['DELETE FROM jobs','TRUNCATE jobs']){
      await expect(asOwner(a,alice,c=>c.query(sql).then(()=>{}),'ops.jobs.read')).rejects.toMatchObject({code:'42501'});
    }
  });
  it('CRT-SEC-01-A: hides B from unfiltered owner A canonical identity queries and refuses them under another purpose',async()=>{
    const memoryTables=['entities','entity_aliases','entity_lineage','frame_instances','frame_instance_roles',
      'belief_slots','slot_fingerprints','propositions','proposition_fingerprints','claims'];
    await asOwner(a,alice,async c=>{
      for(const table of memoryTables){
        const rows=(await readUnfiltered(c,table)).rows;
        expect(rows.length,table).toBeGreaterThan(0);
        expect(rows.every(row=>row.owner_scope_id===a),table).toBe(true);
      }
    },'memory.inspect');
    // Canonical identity is purpose-bound like evidence: an owner session holding
    // an unrelated product purpose sees none of it.
    await asOwner(a,alice,async c=>{
      for(const table of memoryTables) expect((await c.query('SELECT * FROM '+table)).rows,table).toEqual([]);
    });
    await asOwner(b,alice,async c=>{
      for(const table of memoryTables) expect((await c.query('SELECT * FROM '+table)).rows,table).toEqual([]);
    },'memory.inspect');
    // Reading never authorizes writing, and no identity row may be removed.
    for(const table of memoryTables){
      await expect(asOwner(a,alice,c=>c.query('DELETE FROM '+table).then(()=>{}),'memory.canonicalize'),table).rejects.toMatchObject({code:'42501'});
    }
    // A claim is one source assertion: this node grants no update on it at all.
    await expect(asOwner(a,alice,c=>c.query("UPDATE claims SET lifecycle='ACCEPTED'").then(()=>{}),'memory.canonicalize')).rejects.toMatchObject({code:'42501'});
    // A fingerprint may only be closed; its index columns are immutable even for
    // the privileged principal, so recomputation can never rewrite what an
    // earlier fingerprint said (CRT-MEM-04-A).
    await expect(asOwner(a,alice,c=>c.query("UPDATE slot_fingerprints SET fingerprint=$1",['d'.repeat(64)]).then(()=>{}),'memory.canonicalize'))
      .rejects.toMatchObject({code:'42501'});
    await expect(pool.query("UPDATE slot_fingerprints SET normalization_version='normalization-2' WHERE owner_scope_id=$1",[a]))
      .rejects.toThrow('FINGERPRINT_IMMUTABLE');
    await expect(pool.query('UPDATE entities SET id=gen_random_uuid() WHERE owner_scope_id=$1',[a]))
      .rejects.toThrow('CANONICAL_IDENTITY_IMMUTABLE');
  });
  it('holds exactly one active BASE context space per owner scope and keeps it permanent',async()=>{
    // Created with the owner scope, so no scope exists without a context to
    // assert a belief in, and the owner sees only its own.
    for(const owner of [a,b]){
      expect((await pool.query("SELECT context_kind,lifecycle,parent_context_space_id FROM context_spaces WHERE owner_scope_id=$1",[owner])).rows)
        .toEqual([{context_kind:'BASE',lifecycle:'ACTIVE',parent_context_space_id:null}]);
    }
    await asOwner(a,alice,async c=>{
      const rows=(await c.query('SELECT owner_scope_id,context_kind FROM context_spaces')).rows;
      expect(rows).toEqual([{owner_scope_id:a,context_kind:'BASE'}]);
    });
    // A second active BASE is impossible, and the existing one cannot be retired
    // or re-kinded away, so "at most one" is also "exactly one".
    await expect(pool.query("INSERT INTO context_spaces(id,owner_scope_id,context_kind) VALUES($1,$2,'BASE')",[randomUUID(),a]))
      .rejects.toMatchObject({code:'23505'});
    await expect(pool.query("UPDATE context_spaces SET lifecycle='RETIRED',retired_at=now() WHERE owner_scope_id=$1",[a]))
      .rejects.toThrow('BASE_CONTEXT_SPACE_PERMANENT');
    await expect(pool.query("UPDATE context_spaces SET context_kind='TEST' WHERE owner_scope_id=$1",[a]))
      .rejects.toThrow('CONTEXT_SPACE_IDENTITY_IMMUTABLE');
    await expect(pool.query('DELETE FROM context_spaces WHERE owner_scope_id=$1',[a]))
      .rejects.toThrow('BASE_CONTEXT_SPACE_PERMANENT');
    // A derived context is scoped to a parent in the same owner scope; the
    // application role may read contexts and write none.
    const base=(await pool.query("SELECT id FROM context_spaces WHERE owner_scope_id=$1",[a])).rows[0].id;
    await expect(pool.query("INSERT INTO context_spaces(id,owner_scope_id,context_kind,parent_context_space_id) VALUES($1,$2,'QUOTED',$3)",[randomUUID(),b,base]))
      .rejects.toMatchObject({code:'23503'});
    await expect(pool.query("INSERT INTO context_spaces(id,owner_scope_id,context_kind) VALUES($1,$2,'QUOTED')",[randomUUID(),a]))
      .rejects.toMatchObject({code:'23514'});
    for(const sql of ["INSERT INTO context_spaces(id,owner_scope_id,context_kind,parent_context_space_id) VALUES(gen_random_uuid(),'"+a+"','TEST','"+base+"')",
      'UPDATE context_spaces SET creation_transaction_id=NULL','DELETE FROM context_spaces','TRUNCATE context_spaces']){
      await expect(asOwner(a,alice,c=>c.query(sql).then(()=>{}))).rejects.toMatchObject({code:'42501'});
    }
  });
  it('does not expose session digests to the application role',async()=>{
    await expect(asOwner(a,alice,c=>c.query('SELECT token_hash FROM auth_sessions').then(()=>{}))).rejects.toMatchObject({code:'42501'});
    await expect(appPool.query('SELECT unai_private.auth_session($1)',['a'.repeat(64)])).rejects.toMatchObject({code:'42501'});
  });
  it('refuses cross-owner inserts',async()=>{
    await expect(asOwner(a,alice,c=>c.query('INSERT INTO devices (id,owner_scope_id,user_id,display_name) VALUES ($1,$2,$3,$4)',[randomUUID(),b,bob,'Forged']).then(()=>{}))).rejects.toMatchObject({code:'42501'});
  });
  it('enforces evidence purpose and sensitivity in unfiltered SQL and refuses metadata mutation',async()=>{
    await asOwner(a,alice,async c=>{
      await c.query("SELECT set_config('unai.data_purpose','ADVERTISING',true)");
      expect((await c.query('SELECT * FROM source_items')).rows).toEqual([]);
      expect((await c.query('SELECT * FROM source_anchors')).rows).toEqual([]);
      // The private object-store location follows the evidence row's own decision.
      expect((await c.query('SELECT * FROM evidence_object_keys')).rows).toEqual([]);
      await c.query("SELECT set_config('unai.data_purpose','PERSONAL_ASSISTANCE',true),set_config('unai.maximum_sensitivity','NORMAL',true)");
      expect((await c.query('SELECT * FROM source_items')).rows).toEqual([]);
    });
    for(const table of ['source_items','source_anchors','evidence_object_keys']){
      await expect(asOwner(a,alice,c=>c.query('UPDATE '+table+' SET id=id').then(()=>{}))).rejects.toMatchObject({code:'42501'});
      await expect(asOwner(a,alice,c=>c.query('DELETE FROM '+table).then(()=>{}))).rejects.toMatchObject({code:'42501'});
    }
  });
  it('refuses audit mutation and truncation',async()=>{
    for(const sql of ['UPDATE audit_events SET result=\'FAILURE\'','DELETE FROM audit_events','TRUNCATE audit_events']){
      await expect(asOwner(a,alice,c=>c.query(sql).then(()=>{}))).rejects.toMatchObject({code:'42501'});
    }
  });
  it('does not grant owner access to a non-member actor',async()=>{
    await asOwner(b,alice,async c=>{
      expect((await c.query('SELECT * FROM devices')).rows).toEqual([]);
      expect((await c.query('SELECT * FROM audit_events')).rows).toEqual([]);
    });
  });
  it('fails closed with no request context',async()=>{
    const c=await pool.connect();
    try{
      await c.query('BEGIN'); await c.query('SET LOCAL ROLE unai_app');
      expect((await c.query('SELECT * FROM devices')).rows).toEqual([]);
    } finally{await c.query('ROLLBACK');c.release();}
  });
  it('forces RLS on all application tables',async()=>{
    const rows=(await pool.query("SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON c.relnamespace=n.oid WHERE n.nspname='public' AND c.relkind='r'")).rows;
    expect(rows.length).toBe(26);
    expect(rows.every(r=>r.relrowsecurity&&r.relforcerowsecurity)).toBe(true);
    const role=(await pool.query("SELECT rolbypassrls,rolsuper FROM pg_roles WHERE rolname='unai_app'")).rows[0];
    expect(role).toEqual({rolbypassrls:false,rolsuper:false});
  });

  it('persists a scoped audit event through a real low-privilege connection',async()=>{
    const context={actorId:alice,ownerScopeId:a,purpose:'device.register',correlationId:randomUUID()};
    const id=await withOwnerTransaction(appPool,context,async tx=>{
      return tx.audit({policyDecision:'ALLOW',codeVersion:'0.1.0',result:'SUCCESS',objects:[{type:'devices',id:alice,fields:['display_name']}]});
    });
    const row=(await pool.query('SELECT owner_scope_id,actor,correlation_id FROM audit_events WHERE id=$1',[id])).rows[0];
    expect(row).toEqual({owner_scope_id:a,actor:alice,correlation_id:context.correlationId});
  });
  it('rejects invalid membership before running application work',async()=>{
    let ran=false;
    await expect(withOwnerTransaction(appPool,{actorId:alice,ownerScopeId:b,purpose:'test',correlationId:randomUUID()},async()=>{ran=true;})).rejects.toThrow('OWNER_ACCESS_DENIED');
    expect(ran).toBe(false);
  });
  it('rolls back audit and device work together on failure',async()=>{
    const correlationId=randomUUID();
    await expect(withOwnerTransaction(appPool,{actorId:alice,ownerScopeId:a,purpose:'test',correlationId},async tx=>{
      await tx.audit({policyDecision:'ALLOW',codeVersion:'0.1.0',result:'SUCCESS',objects:[]});
      throw new Error('operation failed');
    })).rejects.toThrow('operation failed');
    expect((await pool.query('SELECT * FROM audit_events WHERE correlation_id=$1',[correlationId])).rows).toEqual([]);
  });
  it('clears transaction context on a reused application connection',async()=>{
    await withOwnerTransaction(appPool,{actorId:alice,ownerScopeId:a,purpose:'test',correlationId:randomUUID()},async()=>{});
    expect((await appPool.query('SELECT * FROM devices')).rows).toEqual([]);
    await withOwnerTransaction(appPool,{actorId:bob,ownerScopeId:b,purpose:'test',correlationId:randomUUID()},async tx=>{
      expect((await tx.query('SELECT owner_scope_id FROM devices')).rows).toEqual([{owner_scope_id:b}]);
    });
  });
  it('refuses success when a caught SQL error causes COMMIT to roll back',async()=>{
    const correlationId=randomUUID();
    await expect(withOwnerTransaction(appPool,{actorId:alice,ownerScopeId:a,purpose:'test',correlationId},async tx=>{
      await tx.audit({policyDecision:'ALLOW',codeVersion:'0.1.0',result:'SUCCESS',objects:[]});
      await expect(tx.query('SELECT 1/0')).rejects.toMatchObject({code:'22012'});
      return 'material operation succeeded';
    })).rejects.toThrow('TRANSACTION_NOT_COMMITTED');
    expect((await pool.query('SELECT id FROM audit_events WHERE correlation_id=$1',[correlationId])).rows).toEqual([]);
    await withOwnerTransaction(appPool,{actorId:bob,ownerScopeId:b,purpose:'test',correlationId:randomUUID()},async tx=>{
      expect((await tx.query('SELECT owner_scope_id FROM devices')).rows).toEqual([{owner_scope_id:b}]);
    });
  });
  it('refuses an elevated application database connection',async()=>{
    await expect(withOwnerTransaction(pool,{actorId:alice,ownerScopeId:a,purpose:'test',correlationId:randomUUID()},async()=>{})).rejects.toThrow('DATABASE_ROLE_UNSAFE');
  });
  it('detects future tables without an ownership classification',async()=>{
    await assertOwnershipCoverage(pool);
    await pool.query('CREATE TABLE future_unscoped (id uuid)');
    try {await expect(assertOwnershipCoverage(pool)).rejects.toThrow('OWNERSHIP_COVERAGE_INVALID');}
    finally {await pool.query('DROP TABLE future_unscoped');}
  });

  it('keeps the global registry snapshot inaccessible to the application', async () => {
    await expect(appPool.query('SELECT * FROM registry_releases')).rejects.toMatchObject({code:'42501'});
    await expect(appPool.query('SELECT * FROM registry_contracts')).rejects.toMatchObject({code:'42501'});
    // Uncommitted on one connection, so parallel test files never observe the weakened grants.
    const client=await pool.connect();
    const coverage=()=>assertOwnershipCoverage({query:(sql:string)=>client.query(sql)} as unknown as Pool);
    try{
      for(const weaken of ['GRANT SELECT ON registry_contracts TO unai_app','ALTER TABLE registry_releases NO FORCE ROW LEVEL SECURITY',
        'CREATE POLICY registry_read ON registry_releases TO unai_app USING (true)']){
        await client.query('BEGIN');
        await client.query(weaken);
        await expect(coverage(),weaken).rejects.toThrow('OWNERSHIP_COVERAGE_INVALID');
        await client.query('ROLLBACK');
      }
    } finally {await client.query('ROLLBACK');client.release();}
  });

  it('keeps deployment ledger inaccessible to the application', async () => {
    await expect(appPool.query('SELECT * FROM unai_migrations.applied')).rejects.toMatchObject({code:'42501'});
    await pool.query('GRANT USAGE ON SCHEMA unai_migrations TO unai_app');
    try { await expect(assertOwnershipCoverage(pool)).rejects.toThrow('OWNERSHIP_COVERAGE_INVALID'); }
    finally { await pool.query('REVOKE USAGE ON SCHEMA unai_migrations FROM unai_app'); }
  });


  it('does not allow an audit capability to outlive its transaction',async()=>{
    let saved: import('./index.js').OwnerTransaction | undefined;
    await withOwnerTransaction(appPool,{actorId:alice,ownerScopeId:a,purpose:'test',correlationId:randomUUID()},async tx=>{saved=tx;});
    await expect(saved!.audit({policyDecision:'ALLOW',codeVersion:'0.1.0',result:'SUCCESS',objects:[]})).rejects.toThrow('TRANSACTION_CLOSED');
  });
  it('invalidates access when membership ends',async()=>{
    await pool.query("UPDATE owner_scope_members SET valid_to=now()+interval '1 millisecond' WHERE owner_scope_id=$1",[a]);
    await pool.query("SELECT pg_sleep(0.01)");
    try{
      await asOwner(a,alice,async c=>{expect((await c.query('SELECT * FROM devices')).rows).toEqual([]);});
    }finally{await pool.query('UPDATE owner_scope_members SET valid_to=NULL WHERE owner_scope_id=$1',[a]);}
  });


  it('refuses a retained query capability after transaction completion',async()=>{
    let saved: import('./index.js').OwnerTransaction | undefined;
    await withOwnerTransaction(appPool,{actorId:alice,ownerScopeId:a,purpose:'test',correlationId:randomUUID()},async tx=>{saved=tx;});
    await expect(saved!.query('SELECT * FROM devices')).rejects.toThrow('TRANSACTION_CLOSED');
  });


  it('CRT-SEC-01-A: covers every classified owner-scoped table with an unfiltered cross-owner query',async()=>{
    // Read the classification from the database rather than trusting the export:
    // every table an owner session can read at all, including the auth tables the
    // application may only read column by column.
    const live=(await pool.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='r' AND EXISTS(
        SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
        AND has_column_privilege('unai_app',c.oid,a.attnum,'SELECT'))`)).rows.map(row=>row.relname as string);
    expect([...live].sort()).toEqual([...OWNER_SCOPED_TABLES].sort());
    expect([...unfiltered].sort()).toEqual([...OWNER_SCOPED_TABLES].sort());
  });

  it('rejects TLS downgrade options and plaintext database transport',async()=>{
    const {createDatabasePool}=await import('./index.js');
    expect(()=>createDatabasePool(process.env.UNAI_TEST_DATABASE_URL!+'?sslmode=disable','test-ca')).toThrow('DATABASE_TLS_CONFIG_INVALID');
    expect(()=>createDatabasePool(process.env.UNAI_TEST_DATABASE_URL!,'')).toThrow('DATABASE_TLS_CONFIG_INVALID');
    // A pool built on an unpinnable CA must never reach the database, and the transport is
    // what has to refuse it. Both refusals are correct and which one arrives is a property of
    // the server, not of this code: a server without TLS answers "does not support SSL
    // connections", while one serving a certificate this CA cannot validate answers a
    // certificate error. Asserting either wording alone passes only on the server that
    // happens to be in front of it, so match the transport refusal itself and prove no row
    // was ever returned.
    const tlsPool=createDatabasePool(process.env.UNAI_TEST_DATABASE_URL!,'test-ca');
    try{await expect(tlsPool.query('SELECT 1')).rejects.toThrow(/SSL|certificate/i);}
    finally{await tlsPool.end();}
  });

});
