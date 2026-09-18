import { Pool } from 'pg';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { runMigrations } from '@unai/postgres';
import { postgresAdapter, SESSION_COOKIE } from '@unai/auth';
import { createPlatformApi } from './platform.js';
import {createEvidenceObjects,type EvidenceObjects} from './evidence.js';
import {withOwnerTransaction} from '@unai/postgres';

const admin=new Pool({connectionString:process.env.UNAI_TEST_DATABASE_URL});
const url=new URL(process.env.UNAI_TEST_DATABASE_URL!);url.username='evidence_test_app';url.password='test-only';
const appPool=new Pool({connectionString:url.href});
beforeAll(async()=>{
  await runMigrations(admin,resolve('migrations'));
  await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='evidence_test_app') THEN CREATE ROLE evidence_test_app LOGIN PASSWORD 'test-only'; END IF; END $$; GRANT unai_app TO evidence_test_app");
});
afterAll(async()=>{await appPool.end();await admin.end();});

async function fixture(realObjects?:EvidenceObjects){
  const adapter=postgresAdapter(admin);
  const user=await adapter.createUser!({name:'Evidence test',email:'evidence@example.test',emailVerified:null});
  const token=randomBytes(32).toString('base64url');
  await adapter.createSession!({userId:user.id,sessionToken:token,expires:new Date(Date.now()+86400000)});
  const owner=(user as unknown as {ownerScopeId:string}).ownerScopeId;
  // Test-only storage double: no worker or model exists in this fixture.
  const objects=new Map<string,Uint8Array>();let fail=false;
  const evidenceObjects={
    async put(_tx:unknown,id:string,bytes:Uint8Array){if(fail)throw new Error('provider private key');objects.set(id,bytes);},
    async get(_tx:unknown,id:string){return objects.get(id)!;},
  };
  const app=createPlatformApi({authPool:admin,appPool,evidenceObjects:realObjects??evidenceObjects});
  app.addHook('onRequest',async request=>{Object.defineProperty(request.raw.socket,'encrypted',{value:true});});
  const headers={cookie:SESSION_COOKIE+'='+token,'x-owner-scope-id':owner,'x-purpose':'evidence.ingest',
    'x-correlation-id':randomUUID(),'idempotency-key':randomUUID(),'x-data-purpose':'PERSONAL_ASSISTANCE','x-maximum-sensitivity':'RESTRICTED'};
  const payload={ownerScopeId:owner,sourceType:'DOCUMENT',connectorId:null,externalId:'document:'+randomUUID(),
    actorRef:{type:'USER',id:user.id},occurredAt:'2026-08-31T09:00:00Z',content:{text:'Original evidence'},
    sensitivity:'PRIVATE',allowedPurposes:['PERSONAL_ASSISTANCE'],idempotencyKey:headers['idempotency-key']};
  return {app,headers,payload,objects,owner,user,fail:()=>{fail=true;}};
}

it('CRT-EVD-01-A: persists row and raw bytes synchronously without extraction workers',async()=>{
  const f=await fixture();try{
    const result=await f.app.inject({method:'POST',url:'/v1/evidence',headers:f.headers,payload:f.payload});
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({evidenceId:expect.any(String),ingestionStatus:'STORED'});
    const row=(await admin.query('SELECT * FROM source_items WHERE id=$1',[result.json().evidenceId])).rows[0];
    expect(row).toBeDefined();expect(f.objects.get(row.raw_object_id)).toEqual(Buffer.from(JSON.stringify(f.payload.content)));
    expect(row.content_hash).toBe(createHash('sha256').update(f.objects.get(row.raw_object_id)!).digest('hex'));
    expect((await admin.query('SELECT id FROM audit_events WHERE correlation_id=$1',[f.headers['x-correlation-id']])).rowCount).toBe(1);
  }finally{await f.app.close();}
});

it.each([null,'connector'])('CRT-EVD-02-A/B: concurrent %s duplicates retain one ID and SQL rejects duplicates',async kind=>{
  const f=await fixture();try{
    const connector=kind?randomUUID():null;
    if(connector)await admin.query("INSERT INTO connectors(id,owner_scope_id,connector_type,external_account_ref,permission_manifest,status) VALUES($1,$2,'DOCUMENT','test','{}','ACTIVE')",[connector,f.owner]);
    if(connector)expect((await appPool.query("SELECT has_table_privilege(current_user,'connectors','UPDATE') AS allowed")).rows[0].allowed).toBe(false);
    const payload={...f.payload,connectorId:connector};
    const results=await Promise.all(Array.from({length:4},()=>f.app.inject({method:'POST',url:'/v1/evidence',headers:f.headers,payload})));
    expect(results.map(r=>r.statusCode)).toEqual([200,200,200,200]);
    expect(new Set(results.map(r=>r.json().evidenceId)).size).toBe(1);
    const rows=(await admin.query('SELECT * FROM source_items WHERE owner_scope_id=$1',[f.owner])).rows;
    expect(rows).toHaveLength(1);expect(f.objects.size).toBe(1);
    await expect(admin.query(`INSERT INTO source_items SELECT (jsonb_populate_record(NULL::source_items,to_jsonb(s)||jsonb_build_object('id',$2::text,'raw_object_id',$3::text,'raw_object_ref',$4::text,'idempotency_key',$5::text))).* FROM source_items s WHERE id=$1`,
      [rows[0].id,randomUUID(),randomUUID(),'private/'+randomUUID(),randomUUID()])).rejects.toMatchObject({code:'23505',constraint:'source_items_identity'});
  }finally{await f.app.close();}
});

it('CRT-EVD-03-A: reads every retained field with public object reference and immutable originals',async()=>{
  const f=await fixture();try{
    const posted=await f.app.inject({method:'POST',url:'/v1/evidence',headers:f.headers,payload:f.payload});
    expect(posted.statusCode).toBe(200);const id=posted.json().evidenceId;
    const result=await f.app.inject({url:'/v1/evidence/'+id,headers:{...f.headers,'x-purpose':'evidence.read'}});
    expect(result.statusCode).toBe(200);
    const row=(await admin.query('SELECT * FROM source_items WHERE id=$1',[id])).rows[0];
    expect(result.json()).toMatchObject({evidenceId:id,ownerScopeId:f.owner,sourceType:'DOCUMENT',connectorId:null,
      externalId:f.payload.externalId,actorRef:f.payload.actorRef,occurredAt:'2026-08-31T09:00:00.000Z',
      observedAt:row.observed_at.toISOString(),rawObjectRef:row.raw_object_id,contentHash:row.content_hash,
      sensitivity:'PRIVATE',allowedPurposes:['PERSONAL_ASSISTANCE'],ingestionVersion:'evidence-json-v1'});
    expect(JSON.stringify(result.json())).not.toContain(row.raw_object_ref);
    await expect(admin.query("UPDATE source_items SET sensitivity='NORMAL' WHERE id=$1",[id])).rejects.toMatchObject({code:'55000'});
    const duplicate=await f.app.inject({method:'POST',url:'/v1/evidence',headers:f.headers,payload:{...f.payload,occurredAt:null}});
    expect(duplicate.json().evidenceId).toBe(id);
  }finally{await f.app.close();}
});

it('refuses wrong owner, actor, purpose and sensitivity before exposing evidence',async()=>{
  const f=await fixture();try{
    const posted=await f.app.inject({method:'POST',url:'/v1/evidence',headers:f.headers,payload:f.payload});
    expect(posted.statusCode).toBe(200);const id=posted.json().evidenceId;
    for(const headers of [
      {...f.headers,'x-purpose':'evidence.read','x-owner-scope-id':randomUUID()},
      {...f.headers,'x-purpose':'evidence.read','x-data-purpose':'ADVERTISING'},
      {...f.headers,'x-purpose':'evidence.read','x-maximum-sensitivity':'NORMAL'},
    ]){const r=await f.app.inject({url:'/v1/evidence/'+id,headers});expect([403,404]).toContain(r.statusCode);expect(r.body).not.toContain(f.payload.externalId);}
    const forged=await f.app.inject({method:'POST',url:'/v1/evidence',headers:f.headers,payload:{...f.payload,actorRef:{type:'USER',id:randomUUID()}}});
    expect(forged.statusCode).toBe(403);
  }finally{await f.app.close();}
});

it('failed object persistence returns no success or row and leaks no private provider error',async()=>{
  const f=await fixture();f.fail();try{
    const r=await f.app.inject({method:'POST',url:'/v1/evidence',headers:f.headers,payload:f.payload});
    expect(r.statusCode).toBe(503);expect(r.body).not.toContain('private key');
    expect((await admin.query('SELECT id FROM source_items WHERE owner_scope_id=$1',[f.owner])).rowCount).toBe(0);
  }finally{await f.app.close();}
});

it('CRT-EVD-01-A/02-A/03-A: real TLS/KMS object persistence and authorized read survive without workers',async()=>{
  expect(process.env.UNAI_TEST_S3_ENDPOINT,'pnpm test must provide real storage').toBeTruthy();
  const objects=await createEvidenceObjects({endpoint:process.env.UNAI_TEST_S3_ENDPOINT!,region:'us-east-1',bucket:process.env.UNAI_TEST_S3_BUCKET!,kmsKeyId:process.env.UNAI_TEST_S3_KMS_KEY_ID!});
  const f=await fixture(objects);
  try{
    const result=await f.app.inject({method:'POST',url:'/v1/evidence',headers:f.headers,payload:f.payload});
    expect(result.statusCode,result.body).toBe(200);
    const row=(await admin.query('SELECT * FROM source_items WHERE id=$1',[result.json().evidenceId])).rows[0];
    expect(row).toBeDefined();
    const context={actorId:f.user.id,ownerScopeId:f.owner,purpose:'evidence.read',correlationId:randomUUID()};
    const raw=await withOwnerTransaction(appPool,context,async tx=>{
      await tx.query("SELECT set_config('unai.data_purpose','PERSONAL_ASSISTANCE',true),set_config('unai.maximum_sensitivity','PRIVATE',true)");
      return objects.get(tx,row.raw_object_id);
    });
    expect(Buffer.from(raw).toString()).toBe(JSON.stringify(f.payload.content));
    expect(createHash('sha256').update(raw).digest('hex')).toBe(row.content_hash);
    const duplicate=await f.app.inject({method:'POST',url:'/v1/evidence',headers:f.headers,payload:f.payload});
    expect(duplicate.json()).toEqual(result.json());
    await expect(withOwnerTransaction(appPool,{...context,correlationId:randomUUID()},tx=>objects.get(tx,row.raw_object_id))).rejects.toThrow('STORAGE_ACCESS_DENIED');
  }finally{await f.app.close();objects.close();}
});

it('binds a new retry key even when that request deduplicates an existing item',async()=>{
  const f=await fixture();try{
    const first=await f.app.inject({method:'POST',url:'/v1/evidence',headers:f.headers,payload:f.payload});
    expect(first.statusCode).toBe(200);
    const key=randomUUID(),headers={...f.headers,'idempotency-key':key},payload={...f.payload,idempotencyKey:key};
    const duplicate=await f.app.inject({method:'POST',url:'/v1/evidence',headers,payload});
    expect(duplicate.json()).toEqual(first.json());
    const changed=await f.app.inject({method:'POST',url:'/v1/evidence',headers,payload:{...payload,content:{text:'Changed'}}});
    expect(changed.statusCode).toBe(409);
  }finally{await f.app.close();}
});

it('audits missing evidence policy context for an authenticated owner',async()=>{
  const f=await fixture();try{
    const {['x-data-purpose']:ignored,...headers}=f.headers;
    const result=await f.app.inject({method:'POST',url:'/v1/evidence',headers,payload:f.payload});
    expect(result.statusCode).toBe(400);
    expect((await admin.query('SELECT policy_decision,result FROM audit_events WHERE correlation_id=$1',[f.headers['x-correlation-id']])).rows).toEqual([{policy_decision:'DENY',result:'REFUSED'}]);
  }finally{await f.app.close();}
});
