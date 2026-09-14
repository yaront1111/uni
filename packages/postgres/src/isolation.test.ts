import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { withOwnerTransaction, assertOwnershipCoverage, runMigrations } from './index.js';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';

if (!process.env.UNAI_TEST_DATABASE_URL) throw new Error('Run pnpm test for the required PostgreSQL harness');
describe('real PostgreSQL owner isolation', () => {
  const pool = new Pool({ connectionString: process.env.UNAI_TEST_DATABASE_URL });
  const appUrl=new URL(process.env.UNAI_TEST_DATABASE_URL!); appUrl.username='unai_test_app'; appUrl.password='unai-test-only';
  const appPool=new Pool({connectionString:appUrl.href,max:1});
  const a = randomUUID(), b = randomUUID(), alice = randomUUID(), bob = randomUUID();
  beforeAll(async () => {
    await runMigrations(pool, resolve('migrations'));
    await pool.query("CREATE ROLE unai_test_app LOGIN PASSWORD 'unai-test-only'; GRANT unai_app TO unai_test_app");
    await pool.query('INSERT INTO users (id, display_name) VALUES ($1,$2),($3,$4)', [alice,'Alice',bob,'Bob']);
    await pool.query('INSERT INTO owner_scopes (id, scope_kind, display_name, created_by_user_id) VALUES ($1,$2,$3,$4),($5,$2,$6,$7)', [a,'PERSONAL','A',alice,b,'B',bob]);
    await pool.query('INSERT INTO owner_scope_members (owner_scope_id,user_id,role) VALUES ($1,$2,$3),($4,$5,$3)', [a,alice,'OWNER',b,bob]);
    await pool.query('INSERT INTO devices (id,owner_scope_id,user_id,display_name) VALUES ($1,$2,$3,$4),($5,$6,$7,$8)', [randomUUID(),a,alice,'Desktop',randomUUID(),b,bob,'Phone']);
    for (const [owner,actor] of [[a,alice],[b,bob]]) {
      await pool.query("INSERT INTO audit_events (owner_scope_id,actor,purpose,objects_and_fields_accessed,policy_decision,model_or_code_version,result,correlation_id) VALUES ($1,$2,'test','[]','ALLOW','test','SUCCESS',$3)",[owner,actor,randomUUID()]);
    }
  });
  afterAll(async()=>{await appPool.end();await pool.end();});

  async function asOwner(owner: string, actor: string, run: (client: import('pg').PoolClient)=>Promise<void>) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE unai_app');
      await client.query("SELECT set_config('unai.owner_scope_id',$1,true), set_config('unai.actor_id',$2,true)",[owner,actor]);
      await run(client);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }

  it('hides B from unfiltered owner A queries on every owner table', async()=>{
    await asOwner(a,alice,async c=>{
      for (const table of ['owner_scopes','owner_scope_members','devices','audit_events']) {
        const key=table==='owner_scopes'?'id':'owner_scope_id';
        const rows=(await c.query('SELECT * FROM '+table)).rows;
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every(row=>row[key]===a)).toBe(true);
      }
      expect((await c.query('SELECT id FROM users')).rows).toEqual([{id:alice}]);
    });
  });
  it('refuses cross-owner inserts',async()=>{
    await expect(asOwner(a,alice,c=>c.query('INSERT INTO devices (id,owner_scope_id,user_id,display_name) VALUES ($1,$2,$3,$4)',[randomUUID(),b,bob,'Forged']).then(()=>{}))).rejects.toMatchObject({code:'42501'});
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
    expect(rows.length).toBe(7);
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


  it('rejects TLS downgrade options and plaintext database transport',async()=>{
    const {createDatabasePool}=await import('./index.js');
    expect(()=>createDatabasePool(process.env.UNAI_TEST_DATABASE_URL!+'?sslmode=disable','test-ca')).toThrow('DATABASE_TLS_CONFIG_INVALID');
    expect(()=>createDatabasePool(process.env.UNAI_TEST_DATABASE_URL!,'')).toThrow('DATABASE_TLS_CONFIG_INVALID');
    const tlsPool=createDatabasePool(process.env.UNAI_TEST_DATABASE_URL!,'test-ca');
    try{await expect(tlsPool.query('SELECT 1')).rejects.toThrow(/SSL/);}
    finally{await tlsPool.end();}
  });

});
