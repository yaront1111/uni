import {afterAll,beforeAll,expect,it} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {runMigrations,withOwnerTransaction} from '@unai/postgres';
import {postgresAdapter,SESSION_COOKIE} from '@unai/auth';
import {inspectableObjectTypeSchema,type MemoryInspector as Inspection} from '@unai/domain';
import {beliefRefType,type BeliefRefType} from '../components/BeliefLinks';
import {Ask} from '../components/Ask';
import {Commitments} from '../components/Commitments';
import {CONTROLS,CorrectionControls,requestFor} from '../components/CorrectionControls';
import {MemoryInspector} from '../components/MemoryInspector';
import {MemoryThread} from '../components/MemoryThread';
import {Obligations} from '../components/Obligations';
import {Today} from '../components/Today';
import {WeeklyReview} from '../components/WeeklyReview';
import {commitmentFilters,loadCommitments,loadInspector,loadObligations,loadThread,NO_FILTERS,type ApiCall} from '../lib/memory';
import {loadAsk,loadToday} from '../lib/screens';
import {loadWeeklyReview} from '../lib/review';

/**
 * The Commitments, Obligations, Memory inspector, Memory thread and Correction
 * controls screens end to end (CRT-UX-04-A, CRT-UX-07-A, CRT-UX-10-A,
 * CRT-UX-10-B, CRT-UX-15-A).
 *
 * Each screen is loaded through its own loader (`lib/memory.ts`, the function its
 * page calls) from the real platform API over an in-process transport, through
 * the real owner boundary, row policies, evidence gate, projection reducer,
 * correction and lineage write paths; the screen is then rendered from what came
 * back. Only the TLS socket is not real: `inject` marks it encrypted.
 *
 * The API and the store packages are imported by path at run time so the web
 * package's type check and manifest never take them on.
 */

type Pool={query(sql:string,values?:unknown[]):Promise<{rows:Array<Record<string,any>>}>;end():Promise<void>};
type InjectApp={inject(request:{method:string;url:string;headers:Record<string,string>;payload?:unknown}):Promise<{statusCode:number;body:string}>;
  addHook(name:string,hook:(request:{raw:{socket:object}})=>Promise<void>):void;close():Promise<void>};
const API_MODULE='../../../packages/api/src/platform.ts';
const CAPABILITIES_MODULE='../../../packages/capabilities/src/index.ts';
const MEMORY_MODULE='../../../packages/memory/src/index.ts';

if(!process.env.UNAI_TEST_DATABASE_URL)throw new Error('Run pnpm test for the required PostgreSQL harness');
const {Pool:PgPool}=createRequire(new URL('../../../packages/postgres/package.json',import.meta.url))('pg') as {Pool:new(options:{connectionString:string})=>Pool};
const admin=new PgPool({connectionString:process.env.UNAI_TEST_DATABASE_URL});
const appUrl=new URL(process.env.UNAI_TEST_DATABASE_URL);appUrl.username='memory_ui_test_app';appUrl.password='test-only';
const appPool=new PgPool({connectionString:appUrl.href});

const PURPOSE='PERSONAL_ASSISTANCE';
const RECORDED=new Date('2026-03-01T08:00:00.000Z');
let owner='',actor='',token='',baseContext='',transactionId='';
const people={me:'',daniel:'',maya:'',receipt:''};
const frames={obligation:'',allocation:'',promise:'',report:'',venue:'',plumber:'',plumberAgain:''};
const beliefs={principal:'',danielAmount:'',due:'',remaining:'',promise:'',plumber:''};
const claims={loan:'',danielAmount:'',transfer:'',plumber:'',plumberAgain:''};
const resolutions={payment:'',report:''};
const threads={payment:'',trip:''};
const stored=new Map<string,Uint8Array>();
const evidenceObjects={
  encryptionKeyRef:'kms:test-double',
  async put(_tx:unknown,id:string,bytes:Uint8Array){stored.set(id,bytes);},
  async get(_tx:unknown,id:string){const bytes=stored.get(id);if(!bytes)throw new Error('OBJECT_NOT_FOUND');return bytes;},
};
const context=(purpose:string)=>({actorId:actor,ownerScopeId:owner,purpose,correlationId:randomUUID()});

async function entity(kind:string,label:string){
  const id=randomUUID();
  await admin.query('INSERT INTO entities(id,owner_scope_id,entity_kind,canonical_label) VALUES($1,$2,$3,$4)',[id,owner,kind,label]);
  return id;
}
/** One stored source item with one anchored span of text. */
async function evidence(sourceType:string,text:string,occurredAt:string){
  const evidenceId=randomUUID(),anchorId=randomUUID(),connectorId=randomUUID();
  await admin.query("INSERT INTO connectors(id,owner_scope_id,connector_type,external_account_ref,permission_manifest,status) VALUES($1,$2,'CONVERSATION',$3,'{}','ACTIVE')",
    [connectorId,owner,'memory-ui-'+evidenceId]);
  await admin.query(`INSERT INTO source_items(id,owner_scope_id,connector_id,source_type,external_id,actor_ref,submitted_by_user_id,
    raw_object_ref,content_hash,sensitivity,allowed_purposes,ingestion_version,idempotency_key,occurred_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'PRIVATE',ARRAY[$10],'evidence-json-v1',$11,$12)`,
    [evidenceId,owner,connectorId,sourceType,'memory-ui-'+evidenceId,JSON.stringify({type:'USER',id:actor}),actor,randomUUID(),
      randomBytes(32).toString('hex'),PURPOSE,randomUUID(),new Date(occurredAt)]);
  await admin.query(`INSERT INTO source_anchors(id,owner_scope_id,source_item_id,anchor_kind,anchor,normalized_text)
    VALUES($1,$2,$3,'MESSAGE_SPAN',$4,$5)`,[anchorId,owner,evidenceId,JSON.stringify({start:0,end:text.length}),text]);
  return anchorId;
}
async function frame(frameTypeId:string){
  const id=randomUUID();
  await admin.query('INSERT INTO frame_instances(id,owner_scope_id,frame_type_id,context_space_id,created_at) VALUES($1,$2,$3,$4,$5)',[id,owner,frameTypeId,baseContext,RECORDED]);
  return id;
}
/** One value in one slot, the claim that asserts it and, when given, the
 * assessment that stands over it now. */
async function belief(input:{frame:string;predicate:string;modality:string;value:unknown;anchor:string;origin:string;
  assertedBy:string;assessment?:string;slot?:string}){
  const slot=input.slot??randomUUID(),propositionId=randomUUID(),claimId=randomUUID();
  if(!input.slot)await admin.query(`INSERT INTO belief_slots(id,owner_scope_id,frame_instance_id,predicate_id,context_space_id,modality,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7)`,[slot,owner,input.frame,input.predicate,baseContext,input.modality,RECORDED]);
  await admin.query('INSERT INTO propositions(id,owner_scope_id,belief_slot_id,normalized_value,created_at) VALUES($1,$2,$3,$4,$5)',
    [propositionId,owner,slot,JSON.stringify(input.value),RECORDED]);
  await admin.query(`INSERT INTO claims(id,owner_scope_id,source_anchor_id,proposition_id,claim_origin,lifecycle,asserted_by_entity_id,
    recorded_at,extraction_confidence,entity_resolution_confidence,instance_resolution_confidence)
    VALUES($1,$2,$3,$4,$5,'PROVISIONAL',$6,$7,0.9,0.8,0.7)`,[claimId,owner,input.anchor,propositionId,input.origin,input.assertedBy,RECORDED]);
  if(input.assessment){
    await admin.query(`INSERT INTO belief_assessments(id,owner_scope_id,proposition_id,assessment_status,policy_version,transaction_id,
      decision_reason,recorded_at) VALUES($1,$2,$3,$4,'local-policy-0.1.0',$5,'{"code":"FIXTURE"}',$6)`,
      [randomUUID(),owner,propositionId,input.assessment,transactionId,RECORDED]);
  }
  return {slot,propositionId,claimId};
}
async function role(frameId:string,roleId:string,claimId:string,fill:{entityId?:string;typedValue?:unknown}){
  await admin.query(`INSERT INTO frame_instance_roles(id,owner_scope_id,frame_instance_id,role_id,entity_id,typed_value,claim_id,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[randomUUID(),owner,frameId,roleId,fill.entityId??null,
    fill.typedValue===undefined?null:JSON.stringify(fill.typedValue),claimId,RECORDED]);
}
async function resolution(input:{frame:string;outcome:string;claim:string;by:string;contract:string;at:string;coverage?:number}){
  const id=randomUUID();
  await admin.query(`INSERT INTO resolution_assertions(id,owner_scope_id,source_frame_instance_id,outcome_code,effective_at,
    asserted_by_entity_id,claim_id,transition_contract_id,lifecycle,advisory_coverage,creation_transaction_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,'ACCEPTED',$9,$10)`,[id,owner,input.frame,input.outcome,new Date(input.at),input.by,input.claim,
    input.contract,input.coverage??null,transactionId]);
  return id;
}
async function commitment(action:string,due:string,promisee:string,anchor:string){
  const id=await frame('shared.commitment');
  const stated=await belief({frame:id,predicate:'shared.commitment.action_description',modality:'COMMITTED',value:{text:action},
    anchor,origin:'USER_STATEMENT',assertedBy:people.me,assessment:'ACCEPTED'});
  await belief({frame:id,predicate:'shared.commitment.due_time',modality:'COMMITTED',value:{time:due},anchor,origin:'USER_STATEMENT',
    assertedBy:people.me,assessment:'ACCEPTED'});
  await role(id,'promisor',stated.claimId,{entityId:people.me});
  await role(id,'promisee',stated.claimId,{entityId:promisee});
  return {frame:id,...stated};
}

beforeAll(async()=>{
  await runMigrations(admin as never,resolve('migrations'));
  await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='memory_ui_test_app') THEN CREATE ROLE memory_ui_test_app LOGIN PASSWORD 'test-only'; END IF; END $$; GRANT unai_app TO memory_ui_test_app");
  const adapter=postgresAdapter(admin as never);
  const user=await adapter.createUser!({name:'Memory screens',email:'memory-ui@example.test',emailVerified:null});
  actor=user.id;owner=(user as unknown as {ownerScopeId:string}).ownerScopeId;
  token=randomBytes(32).toString('base64url');
  await adapter.createSession!({userId:user.id,sessionToken:token,expires:new Date(Date.now()+604800000)});
  baseContext=(await admin.query("SELECT id FROM context_spaces WHERE owner_scope_id=$1 AND context_kind='BASE'",[owner])).rows[0]!.id;
  transactionId=randomUUID();
  await admin.query(`INSERT INTO belief_transactions(id,owner_scope_id,transaction_kind,requested_by_actor_id,source_evidence_ids,
    registry_release_id,status,risk,idempotency_key,commit_receipt,committed_at)
    VALUES($1,$2,'CANONICALIZE',$3,'{}',$4,'COMMITTED','LOW',$5,'{}',$6)`,
    [transactionId,owner,actor,randomUUID(),randomUUID().replaceAll('-',''),RECORDED]);

  people.me=await entity('PERSON','Me');
  people.daniel=await entity('PERSON','Daniel');
  people.maya=await entity('PERSON','Maya');
  people.receipt=await entity('DOCUMENT','Bank transfer receipt');

  // The Daniel payment: a loan, Daniel's own different figure, a partial
  // repayment by bank transfer, and a promise to send the rest.
  const loan=await evidence('CONVERSATION','I borrowed ILS 500 from Daniel for the concert tickets','2026-03-01T08:00:00.000Z');
  const danielSays=await evidence('GMAIL_THREAD','Daniel: you owe me ILS 550 with the booking fee','2026-03-02T08:00:00.000Z');
  const transfer=await evidence('UPLOADED_DOCUMENT','Bank transfer to Daniel: ILS 300','2026-03-10T08:00:00.000Z');
  const promise=await evidence('CONVERSATION','I will send Daniel the remaining money by Friday','2026-03-11T08:00:00.000Z');
  for(const [entityId,label,anchor] of [[people.me,'Me',loan],[people.daniel,'Daniel',danielSays],
    [people.receipt,'Bank transfer receipt',transfer]] as const){
    await admin.query(`INSERT INTO entity_aliases(id,owner_scope_id,entity_id,alias_type,alias_value,normalized_value,source_item_id,created_at)
      SELECT $1,$2,$3,'DISPLAY_NAME',$4,$4,a.source_item_id,$6 FROM source_anchors a WHERE a.owner_scope_id=$2 AND a.id=$5`,
      [randomUUID(),owner,entityId,label,anchor,RECORDED]);
  }
  frames.obligation=await frame('shared.obligation');
  const principal=await belief({frame:frames.obligation,predicate:'shared.obligation.principal_amount',modality:'ACTUAL',
    value:{amount:'500.00',currency:'ILS'},anchor:loan,origin:'USER_STATEMENT',assertedBy:people.me,assessment:'ACCEPTED'});
  beliefs.principal=principal.propositionId;claims.loan=principal.claimId;
  const danielAmount=await belief({frame:frames.obligation,predicate:'shared.obligation.principal_amount',modality:'ACTUAL',
    value:{amount:'550.00',currency:'ILS'},anchor:danielSays,origin:'EXTERNAL_PERSON_ASSERTION',assertedBy:people.daniel,
    assessment:'PROVISIONAL',slot:principal.slot});
  beliefs.danielAmount=danielAmount.propositionId;claims.danielAmount=danielAmount.claimId;
  beliefs.due=(await belief({frame:frames.obligation,predicate:'shared.obligation.due_time',modality:'ACTUAL',
    value:{time:'2026-03-20T00:00:00.000Z'},anchor:loan,origin:'USER_STATEMENT',assertedBy:people.me,assessment:'ACCEPTED'})).propositionId;
  await role(frames.obligation,'debtor',principal.claimId,{entityId:people.me});
  await role(frames.obligation,'creditor',principal.claimId,{entityId:people.daniel});
  frames.allocation=await frame('finance.payment_allocation');
  const allocated=await belief({frame:frames.allocation,predicate:'finance.payment_allocation.allocated_amount',modality:'ACTUAL',
    value:{amount:'300.00',currency:'ILS'},anchor:transfer,origin:'DOCUMENT_ASSERTION',assertedBy:people.me,assessment:'ACCEPTED'});
  claims.transfer=allocated.claimId;
  await role(frames.allocation,'obligation',allocated.claimId,{typedValue:{frameInstanceId:frames.obligation}});
  await role(frames.allocation,'payment_transaction',allocated.claimId,{typedValue:{externalId:'bank:transfer-1',total:{amount:'300.00',currency:'ILS'}}});
  resolutions.payment=await resolution({frame:frames.obligation,outcome:'PARTIALLY_FULFILLED',claim:allocated.claimId,by:people.me,
    contract:'shared.obligation.resolution',at:'2026-03-10T08:00:00.000Z',coverage:0.6});
  // What the obligations capability derived from the loan and the transfer.
  const remaining=await belief({frame:frames.obligation,predicate:'shared.obligation.remaining_amount',modality:'ACTUAL',
    value:{amount:'200.00',currency:'ILS'},anchor:transfer,origin:'MODEL_INFERENCE',assertedBy:people.me,assessment:'ACCEPTED'});
  beliefs.remaining=remaining.propositionId;
  await admin.query(`INSERT INTO derived_proposition_dependencies(id,owner_scope_id,derived_proposition_id,input_claim_ids,
    input_proposition_ids,evaluator_id,model_or_code_version,registry_release_id,calculation_inputs,created_by_transaction_id)
    VALUES($1,$2,$3,$4,$5,'finance.obligation_remaining','obligations-capability-0.1.0',$6,'{}',$7)`,
    [randomUUID(),owner,remaining.propositionId,[claims.loan,claims.transfer],[beliefs.principal],randomUUID(),transactionId]);

  const promised=await commitment('send Daniel the remaining money','2026-03-13T17:00:00.000Z',people.daniel,promise);
  frames.promise=promised.frame;beliefs.promise=promised.propositionId;

  // A commitment kept, and one both kept and cancelled according to two sources.
  const report=await commitment('send Maya the report','2026-03-04T17:00:00.000Z',people.maya,
    await evidence('CONVERSATION','I will send Maya the report','2026-03-01T09:00:00.000Z'));
  frames.report=report.frame;
  const sent=await belief({frame:report.frame,predicate:'shared.commitment.action_description',modality:'COMMITTED',
    value:{text:'send Maya the report'},anchor:await evidence('CONVERSATION','Done, I sent Maya the report','2026-03-05T09:00:00.000Z'),
    origin:'USER_STATEMENT',assertedBy:people.me});
  resolutions.report=await resolution({frame:report.frame,outcome:'FULFILLED',claim:sent.claimId,by:people.me,
    contract:'shared.commitment.resolution',at:'2026-03-05T09:00:00.000Z'});
  const venue=await commitment('book the venue','2026-03-08T17:00:00.000Z',people.maya,
    await evidence('CONVERSATION','I will book the venue','2026-03-01T10:00:00.000Z'));
  frames.venue=venue.frame;
  await resolution({frame:venue.frame,outcome:'FULFILLED',claim:venue.claimId,by:people.me,contract:'shared.commitment.resolution',at:'2026-03-07T10:00:00.000Z'});
  await resolution({frame:venue.frame,outcome:'CANCELLED',claim:venue.claimId,by:people.maya,contract:'shared.commitment.resolution',at:'2026-03-07T11:00:00.000Z'});

  // The Daniel payment thread, and a second thread holding the same obligation.
  threads.payment=randomUUID();threads.trip=randomUUID();
  await admin.query("INSERT INTO memory_threads(id,owner_scope_id,display_title) VALUES($1,$2,'Daniel payment'),($3,$2,'Concert trip')",
    [threads.payment,owner,threads.trip]);
  for(const [thread,type,id,kind] of [[threads.payment,'frame_instance',frames.obligation,'SUBJECT'],[threads.payment,'frame_instance',frames.promise,'PLAN'],
    [threads.payment,'frame_instance',frames.allocation,'EVENT'],[threads.payment,'entity',people.daniel,'PARTICIPANT'],
    [threads.payment,'entity',people.receipt,'RELATED'],[threads.trip,'frame_instance',frames.obligation,'RELATED']] as const){
    await admin.query(`INSERT INTO memory_thread_members(owner_scope_id,memory_thread_id,object_type,object_id,membership_kind)
      VALUES($1,$2,$3,$4,$5)`,[owner,thread,type,id,kind]);
  }

  // The belief the correction controls are exercised on, and a second situation
  // to merge it with, written through the canonical stores so each carries the
  // lookup fingerprints a governed merge and split rehome.
  const memory=await import(/* @vite-ignore */ MEMORY_MODULE) as Record<string,(...args:any[])=>Promise<any>>;
  const plumberAnchor=await evidence('CONVERSATION','I will call the plumber','2026-03-12T08:00:00.000Z');
  const againAnchor=await evidence('CONVERSATION','I still need to call the plumber','2026-03-14T08:00:00.000Z');
  for(const [key,anchor,claimKey] of [['plumber',plumberAnchor,'plumber'],['plumberAgain',againAnchor,'plumberAgain']] as const){
    await withOwnerTransaction(appPool as never,context('memory.canonicalize'),async tx=>{
      const frameInstanceId=await memory.createFrameInstance!(tx,{ownerScopeId:owner,frameTypeId:'shared.commitment',contextSpaceId:baseContext});
      const slot=await memory.resolveBeliefSlot!(tx,{ownerScopeId:owner,descriptor:{frameInstanceId,predicateId:'shared.commitment.action_description',
        contextSpaceId:baseContext,modality:'COMMITTED',qualifiers:{}}});
      const proposition=await memory.resolveProposition!(tx,{ownerScopeId:owner,beliefSlotId:slot.beliefSlotId,normalizedValue:{text:'call the plumber'}});
      claims[claimKey]=await memory.recordClaim!(tx,{ownerScopeId:owner,sourceAnchorId:anchor,claimOrigin:'USER_STATEMENT',lifecycle:'PROVISIONAL',
        propositionId:proposition.propositionId,assertedByEntityId:people.me});
      frames[key]=frameInstanceId;
      if(key==='plumber')beliefs.plumber=proposition.propositionId;
    });
  }

  const capabilities=await import(/* @vite-ignore */ CAPABILITIES_MODULE) as {applyProjectionDelta:(tx:unknown,input:unknown)=>Promise<unknown>};
  await withOwnerTransaction(appPool as never,context('memory.project'),async tx=>{
    for(const projectionName of ['open_commitments_projection','obligations_projection','schedule_projection']){
      await capabilities.applyProjectionDelta(tx,{ownerScopeId:owner,projectionName,asOf:new Date()});
    }
  });
});
afterAll(async()=>{await appPool.end();await admin.end();});

/** `todayClock` pins Today's "now" to the fixture's week; nothing else reads it. */
async function api(todayClock?:()=>Date):Promise<InjectApp>{
  const {createPlatformApi}=await import(/* @vite-ignore */ API_MODULE) as {createPlatformApi:(options:unknown)=>InjectApp};
  const app=createPlatformApi({authPool:admin,appPool,evidenceObjects,registryReleaseId:randomUUID(),registryRelease:'0.1.0',
    ...(todayClock?{todayClock}:{})});
  app.addHook('onRequest',async request=>{Object.defineProperty(request.raw.socket,'encrypted',{value:true});});
  return app;
}
function transport(app:InjectApp):ApiCall{
  return async(path,method,headers,body)=>{
    const response=await app.inject({method,url:path,headers,...(body===undefined?{}:{payload:body})});
    return {status:response.statusCode,body:response.body?JSON.parse(response.body):null};
  };
}
const caller=()=>({cookie:SESSION_COOKIE+'='+token,ownerScopeId:owner});
const render=(component:unknown,props:unknown)=>renderToStaticMarkup(createElement(component as never,props as never));
async function inspect(app:InjectApp,type:string,id:string):Promise<Inspection>{
  const loaded=await loadInspector(transport(app),caller(),type,id);
  if(loaded.kind!=='props'||loaded.props.state!=='ready'||!loaded.props.inspector)throw new Error('inspector not ready for '+type+' '+id);
  return loaded.props.inspector;
}
/** A correction control's write exactly as the same-origin proxy forwards it:
 * the session's owner scope, the control's purpose and the pinned evidence
 * context (ADR 0028 §4). */
async function post(app:InjectApp,purpose:string,path:string,body:unknown){
  const response=await app.inject({method:'POST',url:'/v1/'+path,headers:{cookie:SESSION_COOKIE+'='+token,'x-owner-scope-id':owner,
    'x-purpose':purpose,'x-correlation-id':randomUUID(),'idempotency-key':randomBytes(16).toString('hex'),'x-data-purpose':PURPOSE,
    'x-maximum-sensitivity':purpose==='memory.correct'?'PRIVATE':'RESTRICTED'},payload:body});
  return {status:response.statusCode,body:JSON.parse(response.body) as Record<string,any>};
}

it('CRT-UX-04-A: the Commitments view shows open commitments with due dates, an overdue flag, people and sources, resolution evidence and a distinct contested marker',async()=>{
  const app=await api();
  try{
    const loaded=await loadCommitments(transport(app),caller(),NO_FILTERS);
    expect(loaded.kind).toBe('props');
    if(loaded.kind!=='props')return;
    expect(loaded.props.state).toBe('ready');
    const html=render(Commitments,loaded.props);
    // An open commitment with its due date, the people and the source.
    expect(html).toContain('send Daniel the remaining money');
    expect(html).toContain('Due 2026-03-13 17:00 UTC');
    expect(html).toContain('Promised to: Daniel');
    expect(html).toContain('Promised by: Me');
    expect(html).toContain('<q> I will send Daniel the remaining money by Friday</q>');
    // The overdue flag the clock set, in words, with no FAILED or MISSED created.
    const promise=loaded.props.view!.rows.find(row=>row.commitmentFrameInstanceId===frames.promise)!;
    expect(promise).toMatchObject({overdue:true,outcomeState:'UNRESOLVED'});
    expect(html).toContain('Overdue: the due time has passed; nothing has been marked failed or missed');
    expect((await admin.query("SELECT count(*)::int n FROM resolution_assertions WHERE owner_scope_id=$1 AND outcome_code IN ('FAILED','MISSED')",[owner])).rows[0]!.n).toBe(0);
    // A resolved commitment with the evidence that resolved it.
    expect(loaded.props.view!.rows.find(row=>row.commitmentFrameInstanceId===frames.report)!.outcomeState).toBe('RESOLVED');
    expect(html).toContain('Resolution evidence');
    expect(html).toContain('Fulfilled on 2026-03-05 09:00 UTC');
    expect(html).toContain('<q> Done, I sent Maya the report</q>');
    // A contested commitment, marked distinctly and in words.
    expect(loaded.props.view!.rows.find(row=>row.commitmentFrameInstanceId===frames.venue)!.outcomeState).toBe('CONTESTED');
    expect(html).toContain('Contested: the sources disagree about this commitment, and Uai has not chosen between them.');
    expect(html).toMatch(/<li class="commitment contested">/);
    // Completeness and the owner overlay watermark travel with the read.
    expect(html).toContain('How complete this view is');
    expect(html).toMatch(/Includes your changes up to owner sequence \d+/);
    // Identifiers stay out of the reading path; they appear only in link targets.
    expect(html.replace(/href="[^"]*"/g,'')).not.toContain(frames.promise);

    // Filtered by person, thread and due window.
    const byPerson=await loadCommitments(transport(app),caller(),{...NO_FILTERS,person:people.maya});
    expect(byPerson.kind==='props'&&byPerson.props.view!.rows.map(row=>row.commitmentFrameInstanceId).sort()).toEqual([frames.report,frames.venue].sort());
    const byThread=await loadCommitments(transport(app),caller(),commitmentFilters({thread:threads.payment}));
    expect(byThread.kind==='props'&&byThread.props.view!.rows.map(row=>row.commitmentFrameInstanceId)).toEqual([frames.promise]);
    const byWindow=await loadCommitments(transport(app),caller(),{...NO_FILTERS,dueAfter:'2026-03-10T00:00:00.000Z',dueBefore:'2026-03-31T00:00:00.000Z'});
    expect(byWindow.kind==='props'&&byWindow.props.view!.rows.map(row=>row.commitmentFrameInstanceId)).toEqual([frames.promise]);

    // The Obligations view: the allocation total, the remainder the capability
    // derived, and advisory coverage labelled advisory, with both amounts kept.
    const obligations=await loadObligations(transport(app),caller());
    expect(obligations.kind).toBe('props');
    if(obligations.kind!=='props')return;
    const row=obligations.props.view!.rows.find(entry=>entry.obligationFrameInstanceId===frames.obligation)!;
    expect(row).toMatchObject({outcomeState:'PARTIALLY_RESOLVED',conflictFlag:true});
    expect(Number(row.totalCanonicalAllocation)).toBe(300);
    // Two conflicting principals are both kept; the remainder is recomputed from
    // the one the capability selected, never from the advisory coverage.
    expect(Number(row.remainingAmountCapabilityDerived)).toBe(Number(row.principalAmount)-300);
    const obligationsHtml=render(Obligations,obligations.props);
    expect(obligationsHtml).toContain('<dt>Allocated so far (canonical total)</dt><dd>ILS '+row.totalCanonicalAllocation+'</dd>');
    expect(obligationsHtml).toContain('<dt>Remaining (recomputed by the obligations capability)</dt><dd>ILS '+row.remainingAmountCapabilityDerived+'</dd>');
    expect(obligationsHtml).toContain('Advisory only</span> 60% — shown as stated; never used to compute the remaining amount.');
    expect(obligationsHtml).toContain('ILS 500.00');
    expect(obligationsHtml).toContain('ILS 550.00');
    expect(obligationsHtml).toContain('Owed to: Daniel');
    expect(obligationsHtml).toContain('<q> Bank transfer to Daniel: ILS 300</q>');
  }finally{await app.close();}
});

it('CRT-UX-07-A: the Memory inspector shows current belief, timeline, original evidence, claims with asserting actors, inferences, conflicts, resolutions, threads, access history and versions',async()=>{
  const app=await api();
  try{
    // Opened once so the second opening has an access to show.
    await inspect(app,'proposition',beliefs.principal);
    const inspector=await inspect(app,'proposition',beliefs.principal);
    expect(inspector.explanation.currentAssessment.assessmentStatus).toBe('ACCEPTED');
    expect(inspector.explanation.temporalHistory.length).toBeGreaterThan(0);
    expect(inspector.originalEvidence.map(item=>item.anchors[0]?.text)).toEqual(['I borrowed ILS 500 from Daniel for the concert tickets']);
    expect(inspector.assertingActors.map(actorEntry=>actorEntry.canonicalLabel)).toEqual(['Me']);
    expect(inspector.inferences).toEqual([expect.objectContaining({role:'INPUT_TO_DERIVED',derivedPropositionId:beliefs.remaining,
      derivedAssessmentStatus:'ACCEPTED'})]);
    expect(inspector.explanation.contradictions).toContainEqual(expect.objectContaining({kind:'COMPETING_PROPOSITION',objectId:beliefs.danielAmount}));
    expect(inspector.explanation.resolutionLinks).toContainEqual(expect.objectContaining({objectType:'resolution_assertion',objectId:resolutions.payment}));
    expect(inspector.connectedThreads.map(thread=>thread.memoryThreadId).sort()).toEqual([threads.trip,threads.payment].sort());
    expect(inspector.connectedThreads.map(thread=>thread.displayTitle)).toEqual([null,null]);
    expect(inspector.accessHistory).toContainEqual(expect.objectContaining({kind:'AUDIT_EVENT',purpose:'memory.inspect',result:'SUCCESS'}));
    expect(inspector.explanation.registryVersions.registryRelease).toBe('0.1.0');

    const html=render(MemoryInspector,{state:'ready',inspector});
    for(const heading of ['Current belief','Historical timeline','Original evidence','Claims and who asserted them','Inferences',
      'Conflicts','Resolution assertions','Connected memory threads','Access history','Registry and extractor versions','Advanced']){
      expect(html,heading).toContain('>'+heading+'</h2>');
    }
    expect(html).toContain('principal amount: ILS 500.00');
    expect(html).toContain('Confirmed');
    expect(html).toContain('<q>I borrowed ILS 500 from Daniel for the concert tickets</q>');
    expect(html).toContain('You said it — asserted by Me');
    expect(html).toContain('Confidence — extraction 90%, who it is about 80%, when not recorded, which situation 70%');
    expect(html).toContain('Used to derive <a href="/memory/inspector/proposition/'+beliefs.remaining+'">another belief</a>');
    expect(html).toContain('Another value is held for the same thing');
    expect(html).toContain('partially fulfilled');
    expect(html).toContain('href="/memory/threads/'+threads.payment+'">Memory thread</a>');
    expect(html).not.toContain('>Daniel payment</a>');
    expect(html).toContain('Read or written for inspection');
    expect(html).toContain('Registry release 0.1.0');
    expect(html).toContain('<code>'+beliefs.principal+'</code>');

    // The other party's figure: reported by Daniel, provisional, asserted by him.
    const reported=render(MemoryInspector,{state:'ready',inspector:await inspect(app,'claim',claims.danielAmount)});
    expect(reported).toContain('Reported by another person — asserted by Daniel');
    expect(reported).toContain('Provisional');
    // The derived belief shows the inference it came from.
    const derived=await inspect(app,'proposition',beliefs.remaining);
    expect(derived.inferences).toEqual([expect.objectContaining({role:'DERIVED_FROM_INPUTS',inputPropositionIds:[beliefs.principal]})]);

    // Refusals: an unknown type or id is a 400, an object with no belief a 404.
    const unknownType=await app.inject({method:'GET',url:'/v1/memory/inspector/table/'+beliefs.principal,headers:{cookie:SESSION_COOKIE+'='+token,
      'x-owner-scope-id':owner,'x-purpose':'memory.inspect','x-correlation-id':randomUUID()}});
    expect(unknownType.statusCode).toBe(400);
    const missing=await loadInspector(transport(app),caller(),'proposition',randomUUID());
    expect(missing.kind==='props'&&missing.props.state).toBe('not-found');
    const wrongPurpose=await app.inject({method:'GET',url:'/v1/memory/frames/related?ids='+frames.obligation,headers:{cookie:SESSION_COOKIE+'='+token,
      'x-owner-scope-id':owner,'x-purpose':'projection.read','x-correlation-id':randomUUID()}});
    expect(wrongPurpose.statusCode).toBe(403);
  }finally{await app.close();}
});

it('CRT-UX-15-A: the memory thread view for the Daniel payment shows projection, timeline, plans, actual events, resolution links, open uncertainties, and related people and documents',async()=>{
  const app=await api();
  try{
    const loaded=await loadThread(transport(app),caller(),threads.payment);
    expect(loaded.kind).toBe('props');
    if(loaded.kind!=='props')return;
    const thread=loaded.props.thread!;
    expect(thread.currentProjection.find(fragment=>fragment.projectionName==='obligations_projection')!.frameInstanceIds).toEqual([frames.obligation]);
    expect(thread.timeline.length).toBeGreaterThan(0);
    expect(thread.plansAndExpectedOutcomes.map(plan=>plan.frameInstanceId)).toContain(frames.promise);
    expect(thread.actualEvents.map(event=>event.propositionId)).toEqual(expect.arrayContaining([beliefs.principal]));
    expect(thread.resolutionLinks.map(link=>link.resolutionAssertionId)).toEqual([resolutions.payment]);
    expect(thread.openUncertainties.map(unknown=>unknown.objectId)).toContain(beliefs.danielAmount);
    expect(thread.relatedPeople.map(person=>person.canonicalLabel).sort()).toEqual(['Daniel','Me']);
    expect(thread.relatedDocuments.map(document=>document.canonicalLabel)).toEqual(['Bank transfer receipt']);

    const html=render(MemoryThread,loaded.props);
    for(const heading of ['Current projection','Timeline','Plans and expected outcomes','Actual events','Resolution links',
      'Open uncertainties','Related people, documents and decisions']){
      expect(html,heading).toContain('>'+heading+'</h2>');
    }
    expect(thread.displayTitle).toBeNull();
    expect(html).toContain('<h1>Memory thread</h1>');
    expect(html).toContain('Obligations: 1 row');
    expect(html).toContain('Evidence arrived');
    expect(html).toContain('action description: send Daniel the remaining money');
    expect(html).toContain('principal amount: ILS 500.00');
    expect(html).toContain('Partially resolved: partially fulfilled');
    expect(html).not.toContain('No one is named in this thread.');
    expect(html).toContain('<li>Daniel</li>');
    expect(html).toContain('<li>Bank transfer receipt</li>');
    expect(html).toContain('not yet decided');

    // The obligation is in the second thread too, backed by the same evidence.
    const trip=await loadThread(transport(app),caller(),threads.trip);
    const inTrip=trip.kind==='props'?trip.props.thread!.members.find(member=>member.objectId===frames.obligation):undefined;
    const inPayment=thread.members.find(member=>member.objectId===frames.obligation);
    expect(inTrip?.evidenceIds).toEqual(inPayment?.evidenceIds);
  }finally{await app.close();}
});

it('CRT-UX-10-A: ten separately labelled controls each persist a different operation kind, with suppress, archive and delete on separate endpoints',async()=>{
  // Distinct by construction: ten labels, ten endpoints, ten operation kinds.
  expect(new Set(CONTROLS.map(control=>control.label)).size).toBe(10);
  expect(new Set(CONTROLS.map(control=>control.operationKind)).size).toBe(10);
  expect(new Set(CONTROLS.map(control=>control.endpoint)).size).toBe(10);
  const endpoint=(key:string)=>CONTROLS.find(control=>control.key===key)!.endpoint;
  expect(new Set([endpoint('suppress'),endpoint('archive'),endpoint('delete')]).size).toBe(3);

  const app=await api();
  try{
    const inspector=await inspect(app,'proposition',beliefs.plumber);
    const html=render(CorrectionControls,{state:'ready',inspector});
    for(const control of CONTROLS){
      expect(html,control.label).toContain('>'+control.label+'</h3>');
      expect(html,control.label).toContain('<strong>What this will change:</strong> '+control.preview.replaceAll('\'','&#x27;'));
      expect(html,control.label).toContain('>'+control.button+'</button>');
    }
    // No control is a generic edit.
    expect(html).not.toMatch(/>Edit( memory)?<\/(button|h3)>/i);

    const form:Record<string,Record<string,string>>={
      correct:{value:'call the electrician',rawText:'It was the electrician, not the plumber'},
      changed:{value:'call the plumber on Monday',from:'2026-03-15',rawText:'We moved it to Monday'},
      confirm:{rawText:'Yes, that is right'},
      reject:{rawText:'I never said I would call'},
      'keep-uncertain':{},
      suppress:{scope:'OBJECT'},
      archive:{rawText:'Old news'},
      delete:{scope:'OBJECT',confirmation:'DELETE'},
      merge:{subject:'frame_instance:'+frames.plumber,other:frames.plumberAgain,rawText:'The same call, said twice'},
      split:{parts:'call-first,call-again',['claim:'+claims.plumber]:'call-first'},
    };
    const recorded:Record<string,string>={};
    const paths=new Set<string>();
    for(const control of CONTROLS){
      const request=requestFor(control,inspector,new Map(Object.entries(form[control.key]!)));
      paths.add(request.path.replace(/[0-9a-f-]{36}/,'{id}'));
      const response=await post(app,control.purpose,request.path,request.body);
      expect(response.status,control.key+' '+JSON.stringify(response.body)).toBe(control.key==='merge'||control.key==='split'?200:201);
      expect(typeof response.body.memoryOperationId,control.key).toBe('string');
      if(control.purpose==='memory.correct'){
        expect(response.body.operationKind,control.key).toBe(control.operationKind);
        expect(response.body.ownerSequence,control.key).toBeGreaterThan(0);
      }
      recorded[control.key]=response.body.memoryOperationId;
    }
    expect(paths.size).toBe(10);
    const rows=(await admin.query('SELECT id,operation_kind FROM memory_operations WHERE owner_scope_id=$1 AND id=ANY($2::uuid[])',
      [owner,Object.values(recorded)])).rows;
    const kinds=Object.fromEntries(rows.map(row=>[row.id,row.operation_kind]));
    expect(Object.fromEntries(CONTROLS.map(control=>[control.key,kinds[recorded[control.key]!]])))
      .toEqual(Object.fromEntries(CONTROLS.map(control=>[control.key,control.operationKind])));
    expect(new Set(rows.map(row=>row.operation_kind)).size).toBe(10);

    // The receipt the screen shows after a write: its owner sequence, and that
    // nothing was updated in place.
    const receiptHtml=render(CorrectionControls,{state:'ready',inspector,receipt:{control:'correct',operationKind:'CORRECT',
      memoryOperationId:recorded['correct'],ownerSequence:7,proposedTransactionId:null,transactionId:null}});
    expect(receiptHtml).toContain('Correct: recorded');
    expect(receiptHtml).toContain('Owner sequence 7.');
    expect(receiptHtml).toContain('No existing row was changed');
    // The next read, from any device of this owner, shows what was written.
    const after=await inspect(app,'proposition',beliefs.plumber);
    expect(after.memoryOperations.map(operation=>operation.operationKind)).toEqual(expect.arrayContaining(
      ['CORRECT','CHANGED','CONFIRM','REJECT','KEEP_UNCERTAIN','SUPPRESS','ARCHIVE','DELETE']));
    expect(after.explanation.ownerOverlayDeltas.map(delta=>delta.deltaKind)).toEqual(expect.arrayContaining(
      ['USER_CORRECTION','USER_STATE_CHANGE','USER_CONFIRMATION','USER_REJECTION','KEEP_UNCERTAIN','SUPPRESSION','ARCHIVE','DELETION']));
  }finally{await app.close();}
});

/** Every Inspect and Correct link a rendered screen carries. */
function beliefLinksIn(html:string){
  return [...html.matchAll(/href="\/memory\/(inspector|correct)\/([a-z_]+)\/([0-9a-f-]{36})"/g)].map(match=>({screen:match[1]!,type:match[2]!,id:match[3]!}));
}
/** Follows every link a surface rendered through the loader both pages call:
 * each Inspect link opens a ready inspector, and each Correct link opens a
 * Correction controls screen whose Keep uncertain control is posted exactly as
 * the proxy forwards it and lands on the belief that screen showed. Every
 * surfaced object has both links. */
async function followEveryLink(app:InjectApp,surface:string,html:string){
  const links=beliefLinksIn(html);
  const inspectLinks=links.filter(link=>link.screen==='inspector'),correctLinks=links.filter(link=>link.screen==='correct');
  expect(inspectLinks.length,surface+' shows no inspectable belief').toBeGreaterThan(0);
  expect(correctLinks.map(link=>link.type+'/'+link.id).sort(),surface).toEqual(inspectLinks.map(link=>link.type+'/'+link.id).sort());
  const keep=CONTROLS.find(control=>control.key==='keep-uncertain')!;
  for(const link of inspectLinks){
    const opened=await loadInspector(transport(app),caller(),link.type,link.id);
    expect(opened.kind==='props'&&opened.props.state,surface+' inspect '+link.type+' '+link.id).toBe('ready');
  }
  for(const link of correctLinks){
    const opened=await loadInspector(transport(app),caller(),link.type,link.id);
    if(opened.kind!=='props'||!opened.props.inspector)throw new Error(surface+' correct '+link.type+' '+link.id+' did not open');
    expect(render(CorrectionControls,opened.props),surface).toContain('>'+keep.label+'</h3>');
    const request=requestFor(keep,opened.props.inspector,new Map());
    const kept=await post(app,keep.purpose,request.path,request.body);
    expect(kept.status,surface+' correct '+link.type+' '+JSON.stringify(kept.body)).toBe(201);
    expect((await admin.query('SELECT operation_kind FROM memory_operations WHERE id=$1',[kept.body.memoryOperationId])).rows[0])
      .toEqual({operation_kind:keep.operationKind});
  }
  return inspectLinks;
}

it('CRT-UX-10-B: every belief surfaced in Today, Ask and Commitments can be inspected and corrected',async()=>{
  // Today is read in the fixture's week, the day before the promise to Daniel is due.
  const app=await api(()=>new Date('2026-03-12T09:00:00.000Z'));
  try{
    // Commitments: every Inspect and Correct link on the screen opens.
    const loaded=await loadCommitments(transport(app),caller(),NO_FILTERS);
    if(loaded.kind!=='props')throw new Error('expired');
    expect((await followEveryLink(app,'Commitments',render(Commitments,loaded.props))).length).toBeGreaterThan(3);
    // ...and a correction posted from a row lands on the belief the row showed.
    const promise=await inspect(app,'frame_instance',frames.promise);
    const confirm=CONTROLS.find(control=>control.key==='confirm')!;
    const request=requestFor(confirm,promise,new Map([['rawText','Yes, I still owe him that']]));
    const confirmed=await post(app,confirm.purpose,request.path,request.body);
    expect(confirmed.status,JSON.stringify(confirmed.body)).toBe(201);
    expect((await admin.query('SELECT target_object_id FROM memory_operations WHERE id=$1',[confirmed.body.memoryOperationId])).rows[0])
      .toEqual({target_object_id:promise.subject.propositionId});

    // Every object type a surface can name opens in both the inspector and the
    // Correction controls, the owner's own confirmation just posted included.
    const confirmation=(await inspect(app,'frame_instance',frames.promise)).explanation.ownerOverlayDeltas
      .find(delta=>delta.deltaKind==='USER_CONFIRMATION')!;
    const byType:Record<BeliefRefType,string>={proposition:beliefs.principal,claim:claims.danielAmount,frame_instance:frames.promise,
      resolution_assertion:resolutions.payment,owner_overlay_delta:confirmation.overlayDeltaId};
    expect(Object.keys(byType).sort()).toEqual([...inspectableObjectTypeSchema.options].sort());
    for(const [type,id] of Object.entries(byType)){
      const opened=await loadInspector(transport(app),caller(),type,id);
      expect(opened.kind==='props'&&opened.props.state,type).toBe('ready');
      if(opened.kind==='props')expect(render(CorrectionControls,opened.props),type).toContain('>'+confirm.label+'</h3>');
    }

    // Today: the rendered briefing links every item it shows.
    const today=await loadToday(transport(app),caller(),'UTC');
    if(today.kind!=='props')throw new Error('expired');
    expect(today.props.state,today.props.error??'').toBe('ready');
    const items=today.props.briefing!.sections.flatMap(section=>section.items);
    expect(items.length).toBeGreaterThan(0);
    const todayHtml=render(Today,today.props);
    expect(todayHtml.match(/<li class="briefing-item">/g)?.length).toBe(items.length);
    const todayLinks=await followEveryLink(app,'Today',todayHtml);
    for(const item of items){
      const primary=item.sourceRefs[0]??{objectType:item.itemObjectType,objectId:item.itemObjectId};
      expect(todayLinks.map(link=>link.id),item.headline).toContain(primary.objectId);
    }

    // Ask: every inspectable object the rendered answer's statements name. The
    // conflict statement rests on both principal amounts, and each opens.
    const question='Does anything I recorded about the loan contradict itself?';
    const asked=await loadAsk(transport(app),caller(),question);
    if(asked.kind!=='props')throw new Error('expired');
    expect(asked.props.state).toBe('answered');
    const askHtml=render(Ask,asked.props);
    const askLinks=await followEveryLink(app,'Ask',askHtml);
    const named=asked.props.answer!.statements.flatMap(statement=>statement.objectRefs)
      .filter(ref=>beliefRefType(ref.objectType)!==null).map(ref=>beliefRefType(ref.objectType)+'/'+ref.objectId);
    expect(new Set(askLinks.map(link=>link.type+'/'+link.id))).toEqual(new Set(named));
    expect(named).toEqual(expect.arrayContaining(['proposition/'+beliefs.principal,'proposition/'+beliefs.danielAmount]));
    expect(askHtml).toContain('Memory 2: ');
  }finally{await app.close();}
},120000);

it('CRT-UX-05-A: every belief the Weekly review states rests on can be inspected and corrected',async()=>{
  const app=await api();
  try{
    // The fixture's first week: the report to Maya was due and sent, and the
    // venue was booked and cancelled according to two sources.
    const loaded=await loadWeeklyReview(transport(app),caller(),'2026-03-02');
    if(loaded.kind!=='props')throw new Error('expired');
    const review=loaded.props.review;
    if(!review)throw new Error(loaded.props.error??'no review');
    const sections=[review.priorityVersusCalendar,review.commitmentsVersusResolutions,review.decisionsVersusOutcomes,
      review.plannedVersusObservedSpending,review.materialChanges,review.repeatedPostponement];
    const grounds=[...sections.flatMap(section=>section.statements.flatMap(statement=>statement.grounds)),
      ...review.behavioralObservations.flatMap(observation=>observation.grounds)];
    const named=new Set(grounds.filter(ground=>beliefRefType(ground.objectType)!==null)
      .map(ground=>beliefRefType(ground.objectType)+'/'+ground.objectId));
    expect(named.size).toBeGreaterThan(0);
    const links=await followEveryLink(app,'Weekly review',render(WeeklyReview,loaded.props));
    expect(new Set(links.map(link=>link.type+'/'+link.id))).toEqual(named);
  }finally{await app.close();}
},120000);
