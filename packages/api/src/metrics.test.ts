import {Pool} from 'pg';
import {beforeAll, afterAll, expect, it} from 'vitest';
import {randomUUID, randomBytes} from 'node:crypto';
import {readFile, readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {runMigrations, withOwnerTransaction} from '@unai/postgres';
import {postgresAdapter, SESSION_COOKIE} from '@unai/auth';
import {metricsViewSchema, shadowRunsViewSchema, type RequestContext} from '@unai/domain';
import {createModelGateway, MODEL_PURPOSES, type ModelProvider} from '@unai/model';
import {runExtraction} from '@unai/extraction';
import {createPlatformApi} from './platform.js';
import {importSource, type EvidenceObjects} from './evidence.js';
import {computeMetrics, exactRatio} from './metrics.js';
import {uuidV7} from '../../../src/kernel/identities.js';

/** CRT-WRT-10-A: after processing a corpus, the metrics backend reports the
 * economic and quality metrics (PRD §20.6, §45; design `GET /v1/ops/metrics`).
 *
 * The committed synthetic Gmail corpus is processed the way the runtime
 * processes mail: every thread is imported through the evidence path (Tier-0
 * parse and Tier-1 routing at ingest), and every item routed to deep extraction
 * is extracted through the real gateway, which records each call's cost. The
 * model is the only double. What follows extraction in production -- governed
 * acceptance, a retrieval, the owner's confirmations and corrections, a merge
 * later split -- is recorded here as those services record it, and every metric
 * is then checked against a count taken independently from the same rows.
 */

if (!process.env.UNAI_TEST_DATABASE_URL) throw new Error('Run pnpm test for the required PostgreSQL harness');
const admin=new Pool({connectionString:process.env.UNAI_TEST_DATABASE_URL});
const url=new URL(process.env.UNAI_TEST_DATABASE_URL);url.username='metrics_test_app';url.password='test-only';
const appPool=new Pool({connectionString:url.href});
const COST=1500;

beforeAll(async()=>{
  await runMigrations(admin,resolve('migrations'));
  await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='metrics_test_app') THEN CREATE ROLE metrics_test_app LOGIN PASSWORD 'test-only'; END IF; END $$; GRANT unai_app TO metrics_test_app");
});
afterAll(async()=>{await appPool.end();await admin.end();});

/** Cites a span of the first anchor with text, quoting it exactly. */
const citing:ModelProvider={providerId:'anthropic',defaultModelId:'claude-metrics-test',
  async complete(request){
    const input=JSON.parse(request.input) as {anchors:Array<{anchorKind:string;parentAnchor:Record<string,unknown>;text:string}>};
    const anchor=input.anchors.find(candidate=>candidate.text.length>0)!;
    const quote=anchor.text.slice(0,20);
    return {modelId:'claude-metrics-test',costMicrounits:COST,outputText:JSON.stringify({claims:[{frameTypeId:'shared.commitment',
      statement:'Surface frame',span:{anchorKind:anchor.anchorKind,parentAnchor:anchor.parentAnchor,start:0,end:quote.length,quote},
      extractionConfidence:0.7,temporalExpression:null,participants:[]}],unknowns:[]})};
  }};

it('CRT-WRT-10-A: after processing a corpus the metrics backend reports cost, usage, routing, owner review and merge quality',async()=>{
  const adapter=postgresAdapter(admin);
  const user=await adapter.createUser!({name:'Metrics owner',email:'metrics-'+randomUUID()+'@example.test',emailVerified:null});
  const token=randomBytes(32).toString('base64url');
  await adapter.createSession!({userId:user.id,sessionToken:token,expires:new Date(Date.now()+86400000)});
  const owner=(user as unknown as {ownerScopeId:string}).ownerScopeId;
  const correlationId=randomUUID();
  const context=(purpose:string):RequestContext=>({actorId:user.id,ownerScopeId:owner,purpose,correlationId});
  const connectorId=randomUUID();
  await admin.query('INSERT INTO connectors(id,owner_scope_id,connector_type,external_account_ref,permission_manifest,status) VALUES($1,$2,$3,$4,$5,$6)',
    [connectorId,owner,'GMAIL','metrics-'+randomUUID(),'{}','ACTIVE']);
  const stored=new Map<string,Uint8Array>();
  const objects:EvidenceObjects={encryptionKeyRef:'kms:test-double',
    async put(_tx,id,bytes){stored.set(id,bytes);},async get(_tx,id){return stored.get(id)!;}};
  const windowStart=new Date(Date.now()-60000);

  // 1. Ingest the corpus: every thread through the evidence path, which parses
  // and routes each message at ingest.
  const threadsDirectory=resolve('corpus/synthetic/threads');
  for(const name of (await readdir(threadsDirectory)).sort()){
    const payload=JSON.parse(await readFile(resolve(threadsDirectory,name),'utf8'));
    await withOwnerTransaction(appPool,context('evidence.ingest'),async tx=>{
      await tx.query("SELECT set_config('unai.data_purpose','PERSONAL_ASSISTANCE',true),set_config('unai.maximum_sensitivity','RESTRICTED',true)");
      return importSource(tx,objects,{sourceType:'GMAIL',payload,connectorId,sensitivity:'PRIVATE',allowedPurposes:['PERSONAL_ASSISTANCE']});
    });
  }
  // 2. Extract what triage routed to deep extraction, through the real gateway.
  const gateway=createModelGateway({provider:citing,recordCall:run=>withOwnerTransaction(appPool,context(MODEL_PURPOSES.call),run)});
  const deep=(await admin.query(`SELECT s.id FROM source_items s JOIN triage_decisions t ON t.owner_scope_id=s.owner_scope_id AND t.source_item_id=s.id
    WHERE s.owner_scope_id=$1 AND t.tier1_route IN ('FULL_EXTRACTION','ENTITY_EXTRACTION') ORDER BY s.external_id`,[owner])).rows;
  expect(deep.length).toBeGreaterThan(2);
  const extracted:string[]=[];
  for(const row of deep){
    const result=await runExtraction({runner:(purpose,run)=>withOwnerTransaction(appPool,context(purpose),run),gateway,request:{
      ownerScopeId:owner,sourceItemId:row.id,runKind:'FULL',registryReleaseId:randomUUID(),correlationId,
      referenceInstant:new Date('2026-09-01T09:00:00Z'),timeZone:'UTC',dataPurpose:'PERSONAL_ASSISTANCE',maximumSensitivity:'PRIVATE'}});
    extracted.push(...result.claimIds);
  }

  // 3. What governance, reading and the owner then record: three accepted beliefs
  // under one governed transaction, one packet that retrieved two of them and one
  // extracted claim, a confirmation, a correction and a rejection, and two frame
  // merges of which one was later split again.
  const contextSpace=(await admin.query('SELECT id FROM context_spaces WHERE owner_scope_id=$1',[owner])).rows[0].id;
  const anchor=(await admin.query('SELECT id,source_item_id FROM source_anchors WHERE owner_scope_id=$1 ORDER BY id LIMIT 1',[owner])).rows[0];
  const transaction=randomUUID();
  await admin.query(`INSERT INTO belief_transactions(id,owner_scope_id,transaction_kind,requested_by_actor_id,source_evidence_ids,
    registry_release_id,status,risk,idempotency_key,commit_receipt,committed_at) VALUES($1,$2,'CANONICALIZE',$3,'{}',$4,'COMMITTED','LOW',$5,'{}',now())`,
    [transaction,owner,user.id,randomUUID(),randomUUID().replaceAll('-','')]);
  const frame=uuidV7();
  await admin.query("INSERT INTO frame_instances(id,owner_scope_id,frame_type_id,context_space_id) VALUES($1,$2,'shared.commitment',$3)",[frame,owner,contextSpace]);
  const beliefs:string[]=[];
  for(const [index,predicate] of ['shared.commitment.action_description','shared.commitment.due_time','shared.commitment.priority'].entries()){
    const slot=uuidV7(),proposition=uuidV7();
    await admin.query("INSERT INTO belief_slots(id,owner_scope_id,frame_instance_id,predicate_id,context_space_id,modality) VALUES($1,$2,$3,$4,$5,'COMMITTED')",
      [slot,owner,frame,predicate,contextSpace]);
    await admin.query('INSERT INTO propositions(id,owner_scope_id,belief_slot_id,normalized_value) VALUES($1,$2,$3,$4)',[proposition,owner,slot,JSON.stringify('value-'+index)]);
    await admin.query("INSERT INTO claims(id,owner_scope_id,source_anchor_id,proposition_id,claim_origin,lifecycle) VALUES($1,$2,$3,$4,'USER_STATEMENT','ACCEPTED')",
      [uuidV7(),owner,anchor.id,proposition]);
    await admin.query(`INSERT INTO belief_assessments(id,owner_scope_id,proposition_id,assessment_status,policy_version,transaction_id)
      VALUES($1,$2,$3,'ACCEPTED','local-policy-0.1.0',$4)`,[randomUUID(),owner,proposition,transaction]);
    beliefs.push(proposition);
  }
  await admin.query(`INSERT INTO context_packets(id,owner_scope_id,purpose,requesting_actor_id,answer_type_classification,request,packet,packet_hash,selection_reason)
    VALUES($1,$2,'PERSONAL_ASSISTANCE',$3,'CURRENT_VALUE','{}',$4,$5,'{}')`,[randomUUID(),owner,user.id,
    JSON.stringify({currentBeliefs:[{propositionId:beliefs[0],claimIds:[extracted[0]]},{propositionId:beliefs[1],claimIds:[]}],historicalBeliefs:[]}),'d'.repeat(64)]);
  for(const kind of ['CONFIRM','CORRECT','REJECT','CHANGED']){
    await admin.query(`INSERT INTO memory_operations(id,owner_scope_id,operation_kind,target_object_type,target_object_id,evidence_id,requested_by_actor_id)
      VALUES($1,$2,$3,'proposition',$4,$5,$6)`,[randomUUID(),owner,kind,beliefs[0],anchor.source_item_id,user.id]);
  }
  const lineage=async(kind:'MERGE'|'SPLIT',from:string,to:string)=>{
    const client=await admin.connect();
    try{
      await client.query('BEGIN');
      const id=randomUUID();
      await client.query(`INSERT INTO belief_transactions(id,owner_scope_id,transaction_kind,requested_by_actor_id,registry_release_id,status,risk,idempotency_key)
        VALUES($1,$2,$3,$4,$5,'COMMITTING','MEDIUM',$6)`,[id,owner,kind,user.id,randomUUID(),randomUUID().replaceAll('-','')]);
      await client.query("SELECT set_config('unai.belief_transaction_id',$1,true)",[id]);
      await client.query(`INSERT INTO frame_instance_lineage(id,owner_scope_id,from_frame_instance_id,to_frame_instance_id,lineage_kind,transaction_id)
        VALUES($1,$2,$3,$4,$5,$6)`,[randomUUID(),owner,from,to,kind==='MERGE'?'MERGED_INTO':'SPLIT_INTO',id]);
      await client.query("UPDATE belief_transactions SET status='COMMITTED',committed_at=now(),commit_receipt='{}' WHERE id=$1",[id]);
      await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  };
  const instances:string[]=[];
  for(let index=0;index<5;index++){
    const id=uuidV7();
    await admin.query("INSERT INTO frame_instances(id,owner_scope_id,frame_type_id,context_space_id) VALUES($1,$2,'shared.obligation',$3)",[id,owner,contextSpace]);
    instances.push(id);
  }
  await lineage('MERGE',instances[1]!,instances[0]!);
  await lineage('MERGE',instances[3]!,instances[2]!);
  await lineage('SPLIT',instances[0]!,instances[4]!);

  // 4. The metrics, over the window the corpus was processed in.
  const app=createPlatformApi({authPool:admin,appPool});
  app.addHook('onRequest',async request=>{Object.defineProperty(request.raw.socket,'encrypted',{value:true});});
  const headers={cookie:SESSION_COOKIE+'='+token,'x-owner-scope-id':owner,'x-purpose':'ops.metrics.read','x-correlation-id':randomUUID()};
  try{
    const windowEnd=new Date(Date.now()+60000);
    const response=await app.inject({url:'/v1/ops/metrics?windowStart='+windowStart.toISOString()+'&windowEnd='+windowEnd.toISOString(),headers});
    expect(response.statusCode,response.body).toBe(200);
    const view=metricsViewSchema.parse(response.json());
    const metric=(key:string)=>view.metrics.find(entry=>entry.metricKey===key)!;

    // Independent counts from the rows the pipeline wrote.
    const items=Number((await admin.query('SELECT count(*) FROM source_items WHERE owner_scope_id=$1',[owner])).rows[0].count);
    const cost=Number((await admin.query('SELECT sum(cost_microunits) FROM model_call_records WHERE owner_scope_id=$1',[owner])).rows[0].sum);
    const routes=Object.fromEntries((await admin.query('SELECT tier1_route,count(*)::int AS n FROM triage_decisions WHERE owner_scope_id=$1 GROUP BY 1',[owner]))
      .rows.map(row=>[row.tier1_route,row.n]));
    expect(items).toBe(24);
    expect(cost).toBe(deep.length*COST);
    expect(metric('cost_per_source_item')).toMatchObject({value:exactRatio(BigInt(cost),24n),numerator:cost,denominator:24,unit:'MICROUNITS_PER_ITEM'});
    expect(metric('cost_per_canonical_claim')).toMatchObject({value:exactRatio(BigInt(cost),3n),denominator:3});
    expect(metric('cost_per_accepted_belief')).toMatchObject({value:exactRatio(BigInt(cost),3n),denominator:3});
    expect(metric('cost_per_belief_later_retrieved')).toMatchObject({value:exactRatio(BigInt(cost),2n),denominator:2});
    expect(metric('extracted_claims_never_used')).toMatchObject({numerator:extracted.length-1,denominator:extracted.length,
      value:exactRatio(BigInt(extracted.length-1),BigInt(extracted.length))});
    expect(metric('tier_routing_distribution')).toMatchObject({distribution:routes,value:String(24)});
    expect(metric('user_confirmation_rate')).toMatchObject({numerator:1,denominator:3,value:'0.333333'});
    // A correction and a rejected interpretation are errors; a change of state is not.
    expect(metric('user_correction_rate')).toMatchObject({numerator:2,denominator:3,value:'0.666666'});
    expect(metric('false_instance_merge_rate')).toMatchObject({numerator:1,denominator:2,value:'0.500000'});
    expect(view.notMeasured.map(entry=>entry.metricKey)).toContain('clarification_prompts_per_active_day');
    // Counts and codes only: nothing from the mail reaches the report.
    expect(response.body).not.toMatch(/example\.test|Daniel|taxi|ILS/);
    // Each measured value is recorded as an append-only row of its own.
    const recorded=(await admin.query('SELECT metric_key,value::text,numerator,denominator FROM economic_and_quality_metrics WHERE owner_scope_id=$1 AND correlation_id=$2',
      [owner,headers['x-correlation-id']])).rows;
    expect(recorded.map(row=>row.metric_key).sort()).toEqual(view.metrics.map(entry=>entry.metricKey).sort());
    expect(recorded.find(row=>row.metric_key==='user_correction_rate')).toMatchObject({value:'0.666666',numerator:'2',denominator:'3'});
    expect((await admin.query('SELECT purpose FROM audit_events WHERE correlation_id=$1',[headers['x-correlation-id']])).rows)
      .toEqual([{purpose:'ops.metrics.read'}]);

    // The purpose is the route's own, and a malformed window is refused.
    expect((await app.inject({url:'/v1/ops/metrics',headers:{...headers,'x-purpose':'ops.jobs.read'}})).statusCode).toBe(403);
    expect((await app.inject({url:'/v1/ops/metrics?windowStart=yesterday',headers:{...headers,'x-correlation-id':randomUUID()}})).statusCode).toBe(400);
    const empty=await app.inject({url:'/v1/ops/shadow-evaluations',headers:{...headers,'x-purpose':'ops.shadow.read','x-correlation-id':randomUUID()}});
    expect(empty.statusCode).toBe(200);
    expect(shadowRunsViewSchema.parse(empty.json())).toEqual({runs:[]});
  }finally{await app.close();}
},180000);

it('computes undefined rates as null, never as zero, with integer arithmetic only',()=>{
  const none=computeMetrics({sourceItems:0,modelCalls:0,modelCostMicrounits:0,canonicalClaims:0,acceptedBeliefs:0,acceptedBeliefsRetrieved:0,
    extractedClaims:0,extractedClaimsNeverUsed:0,tierRoutes:{},operations:{},frameMerges:0,frameMergesSplitLater:0,entitiesCreated:0,
    entityMerges:0,entityMergesSplitLater:0,rebuildsCompared:0,rebuildsEqual:0});
  expect(none.filter(metric=>metric.metricKey!=='tier_routing_distribution').every(metric=>metric.value===null)).toBe(true);
  expect(exactRatio(10n,3n)).toBe('3.333333');
  expect(exactRatio(1450n,1n)).toBe('1450.000000');
});
