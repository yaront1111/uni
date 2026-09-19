import {Pool} from 'pg';
import {beforeAll,afterAll,it,expect} from 'vitest';
import {randomUUID,randomBytes} from 'node:crypto';
import {resolve} from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
import {runMigrations,withOwnerTransaction} from '@unai/postgres';
import {postgresAdapter,SESSION_COOKIE} from '@unai/auth';
import {applyProjectionDelta} from '@unai/capabilities';
import {createPlatformApi} from './platform.js';
import {createEvidenceObjects,ingestOwnerStatement} from './evidence.js';

const admin=new Pool({connectionString:process.env.UNAI_TEST_DATABASE_URL});
const url=new URL(process.env.UNAI_TEST_DATABASE_URL!);url.username='performance_test_app';url.password='test-only';
const pool=new Pool({connectionString:url.href,max:8});
beforeAll(async()=>{
  await runMigrations(admin,resolve('migrations'));
  await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='performance_test_app') THEN CREATE ROLE performance_test_app LOGIN PASSWORD 'test-only'; END IF; END $$; GRANT unai_app TO performance_test_app");
});
afterAll(async()=>{await pool.end();await admin.end();});

it('CRT-NFR-01-A: records real load P95 for acknowledgement, typed read and packet assembly, excluding LLM generation',async()=>{
  expect((await admin.query("SELECT to_regclass('performance_measurements') AS name")).rows[0].name).toBe('performance_measurements');
  const {recordLoadRun}=await import('./performance.js');
  const adapter=postgresAdapter(admin);
  const user=await adapter.createUser!({name:'Load owner',email:randomUUID()+'@example.test',emailVerified:null});
  const owner=(user as unknown as {ownerScopeId:string}).ownerScopeId;
  const token=randomBytes(32).toString('base64url');
  await adapter.createSession!({userId:user.id,sessionToken:token,expires:new Date(Date.now()+86400000)});
  const objects=await createEvidenceObjects({endpoint:process.env.UNAI_TEST_S3_ENDPOINT!,region:'us-east-1',bucket:process.env.UNAI_TEST_S3_BUCKET!,kmsKeyId:process.env.UNAI_TEST_S3_KMS_KEY_ID!});
  const app=createPlatformApi({authPool:admin,appPool:pool,evidenceObjects:objects});
  app.addHook('onRequest',async request=>{Object.defineProperty(request.raw.socket,'encrypted',{value:true});});
  const correlationId=randomUUID();
  const headers=(purpose:string,key=randomUUID())=>({cookie:SESSION_COOKIE+'='+token,'x-owner-scope-id':owner,
    'x-purpose':purpose,'x-correlation-id':correlationId,'idempotency-key':key,
    'x-data-purpose':'PERSONAL_ASSISTANCE','x-maximum-sensitivity':'RESTRICTED'});
  try{
    // A populated canonical obligation makes projection and packet work nonempty.
    const space=(await admin.query("SELECT id FROM context_spaces WHERE owner_scope_id=$1 AND context_kind='BASE'",[owner])).rows[0].id;
    const frame=randomUUID(),slot=randomUUID(),proposition=randomUUID();
    await admin.query("INSERT INTO frame_instances(id,owner_scope_id,frame_type_id,context_space_id) VALUES($1,$2,'shared.obligation',$3)",[frame,owner,space]);
    await admin.query("INSERT INTO belief_slots(id,owner_scope_id,frame_instance_id,predicate_id,context_space_id,modality) VALUES($1,$2,$3,'shared.obligation.principal_amount',$4,'ACTUAL')",[slot,owner,frame,space]);
    await admin.query(`INSERT INTO propositions(id,owner_scope_id,belief_slot_id,normalized_value) VALUES($1,$2,$3,'{"amount":"50.00","currency":"ILS"}')`,[proposition,owner,slot]);
    const evidence=await withOwnerTransaction(pool,{actorId:user.id,ownerScopeId:owner,correlationId,purpose:'evidence.ingest'},async tx=>{
      await tx.query("SELECT set_config('unai.data_purpose','PERSONAL_ASSISTANCE',true),set_config('unai.maximum_sensitivity','RESTRICTED',true)");
      return ingestOwnerStatement(tx,objects,{externalId:randomUUID(),idempotencyKey:randomUUID(),text:'I owe ILS 50.',sensitivity:'PRIVATE',allowedPurposes:['PERSONAL_ASSISTANCE']});
    });
    await admin.query("INSERT INTO claims(id,owner_scope_id,source_anchor_id,proposition_id,claim_origin,lifecycle) VALUES($1,$2,$3,$4,'USER_STATEMENT','PROVISIONAL')",[randomUUID(),owner,evidence.sourceAnchorId,proposition]);
    await withOwnerTransaction(pool,{actorId:user.id,ownerScopeId:owner,correlationId,purpose:'memory.project'},
      tx=>applyProjectionDelta(tx,{ownerScopeId:owner,projectionName:'obligations_projection',asOf:new Date()}));
    const operations={
      EVIDENCE_INGESTION_ACK:async()=>{
        const key=randomUUID();
        const response=await app.inject({method:'POST',url:'/v1/evidence',headers:headers('evidence.ingest',key),payload:{
          ownerScopeId:owner,sourceType:'DOCUMENT',connectorId:null,externalId:randomUUID(),actorRef:{type:'USER',id:user.id},
          occurredAt:null,content:{text:'Load fixture evidence'},sensitivity:'PRIVATE',allowedPurposes:['PERSONAL_ASSISTANCE'],idempotencyKey:key}});
        expect(response.statusCode,response.body).toBe(200);expect(response.json().ingestionStatus).toBe('STORED');
      },
      TYPED_PROJECTION_READ:async()=>{
        const response=await app.inject({method:'GET',url:'/v1/projections/obligations',headers:headers('projection.read')});
        expect(response.statusCode,response.body).toBe(200);expect(response.json().rows).toHaveLength(1);
      },
      CONTEXT_PACKET_ASSEMBLY:async()=>{
        const response=await app.inject({method:'POST',url:'/v1/memory/context',headers:headers('memory.read'),payload:{
          ownerScopeId:owner,requestingActorId:user.id,purpose:'PERSONAL_ASSISTANCE',query:'Do I owe money?',
          worldTime:'NOW',knowledgeTime:'LATEST',maximumSensitivity:'RESTRICTED',actionRisk:'LOW'}});
        expect(response.statusCode,response.body).toBe(201);expect(response.json().packetId).toBeDefined();
      },
    };
    const context={actorId:user.id,ownerScopeId:owner,correlationId,purpose:'performance.record'};
    const results=await recordLoadRun({operations,sampleCount:100,concurrency:4,
      record:run=>withOwnerTransaction(pool,context,tx=>run(tx))});
    expect(results.map(row=>row.scenario).sort()).toEqual(Object.keys(operations).sort());
    const targets={EVIDENCE_INGESTION_ACK:1000,TYPED_PROJECTION_READ:500,CONTEXT_PACKET_ASSEMBLY:1500};
    for(const row of results){
      expect(row.sampleCount).toBe(100);expect(row.excludesLlmGeneration).toBe(true);
      expect(row.p95Ms,row.scenario).toBeLessThan(targets[row.scenario]);
    }
    expect((await admin.query('SELECT count(*)::int n FROM model_call_records WHERE owner_scope_id=$1',[owner])).rows[0].n).toBe(0);
    const response=await app.inject({method:'GET',url:'/v1/ops/metrics',headers:headers('ops.metrics.read')});
    expect(response.statusCode,response.body).toBe(200);
    expect(response.json().performance).toEqual(results);
    const stored=(await admin.query('SELECT * FROM performance_measurements WHERE owner_scope_id=$1',[owner])).rows;
    expect(stored).toHaveLength(3);
    for(const row of stored){
      expect(row.samples_ms).toHaveLength(100);
      expect(Number(row.p95_ms)).toBe([...row.samples_ms].sort((a,b)=>a-b)[94]);
    }
    console.log('LOAD_RUN',JSON.stringify(results));
    await mkdir('test-results/performance',{recursive:true});
    await writeFile('test-results/performance/load.json',JSON.stringify({format:'unai-load/1',transport:'Fastify injection; real PostgreSQL and encrypted S3',
      targets,measurements:results,samples:stored.map(row=>({scenario:row.scenario,samplesMs:row.samples_ms}))},null,2)+'\n');
  }finally{await app.close();}
},120000);
