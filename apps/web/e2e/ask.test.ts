import {afterAll,beforeAll,expect,it} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {cp,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {runMigrations} from '@unai/postgres';
import {postgresAdapter,SESSION_COOKIE} from '@unai/auth';
import {Ask} from '../components/Ask';
import {loadAsk,type ApiCall} from '../lib/screens';
import {loadChat} from '../lib/chat';
import {Chat} from '../components/Chat';

/**
 * CRT-UX-03-A and the Ask half of CRT-UX-11-A, end to end.
 *
 * The question "What did I promise Daniel?" goes through the Ask screen's own
 * loader (`lib/screens.ts`, the function `pages/ask.tsx` calls) into the real
 * platform API over an in-process transport, through the real owner boundary,
 * the real Context Broker, the real grounding validator and answer recorder and
 * the real pinned registry release 0.1.0; the screen is then rendered from what
 * came back. Only the TLS socket is not real: `inject` marks it encrypted.
 *
 * The API and the registry library are imported by path at run time so the web
 * package's type check and manifest never take them on (registry-boundary.test.ts).
 */

type Pool={query(sql:string,values?:unknown[]):Promise<{rows:Array<Record<string,any>>}>;end():Promise<void>};
type InjectApp={inject(request:{method:string;url:string;headers:Record<string,string>;payload?:unknown}):Promise<{statusCode:number;body:string}>;
  addHook(name:string,hook:(request:{raw:{socket:object}})=>Promise<void>):void;close():Promise<void>};
const API_MODULE='../../../packages/api/src/platform.ts';
const REGISTRY_MODULE='../../../packages/registry/src/index.ts';

if(!process.env.UNAI_TEST_DATABASE_URL)throw new Error('Run pnpm test for the required PostgreSQL harness');
const {Pool:PgPool}=createRequire(new URL('../../../packages/postgres/package.json',import.meta.url))('pg') as {Pool:new(options:{connectionString:string})=>Pool};
const admin=new PgPool({connectionString:process.env.UNAI_TEST_DATABASE_URL});
const appUrl=new URL(process.env.UNAI_TEST_DATABASE_URL);appUrl.username='ask_ui_test_app';appUrl.password='test-only';
const appPool=new PgPool({connectionString:appUrl.href});

const PURPOSE='PERSONAL_ASSISTANCE';
const RECORDED=new Date(Date.now()-3*3600_000);
let owner='',actor='',token='',registryReleaseId='',transactionId='',baseContext='',maya='',daniel='';
const lease={evidenceId:'',anchorId:'',propositionId:''};
const keys={evidenceId:'',anchorId:'',propositionId:'',claimId:''};
const stored=new Map<string,Uint8Array>();
const evidenceObjects={
  encryptionKeyRef:'kms:test-double',
  async put(_tx:unknown,id:string,bytes:Uint8Array){stored.set(id,bytes);},
  async get(_tx:unknown,id:string){const bytes=stored.get(id);if(!bytes)throw new Error('OBJECT_NOT_FOUND');return bytes;},
};

function git(repository:string,...args:string[]){
  const result=spawnSync('git',['-c','core.autocrlf=false','-c','user.name=Registry Test','-c','user.email=registry@test.invalid',...args],
    {cwd:repository,encoding:'utf8',env:{...process.env,GIT_AUTHOR_DATE:'2024-01-01T00:00:00Z',GIT_COMMITTER_DATE:'2024-01-01T00:00:00Z'}});
  if(result.status!==0)throw new Error(result.stderr);
  return result.stdout.trim();
}
/** The immutable 0.1.0 snapshot, published by whichever suite gets there first. */
async function pinnedRegistryRelease():Promise<string>{
  for(let attempt=0;attempt<8;attempt++){
    const existing=(await admin.query("SELECT id FROM registry_releases WHERE semantic_version='0.1.0'")).rows[0];
    if(existing)return existing.id as string;
    await sleep(250);
  }
  const registry=await import(/* @vite-ignore */ REGISTRY_MODULE) as {
    loadRegistryRelease(input:{repository:string;version:string}):Promise<unknown>;
    publishRegistryRelease(pool:Pool,release:unknown,correlationId:string):Promise<{releaseId:string}>;
  };
  const repository=await mkdtemp(join(tmpdir(),'unai-ask-ui-registry-'));
  try{
    await cp(resolve('registry'),join(repository,'registry'),{recursive:true});
    git(repository,'init','--quiet');git(repository,'add','registry');
    git(repository,'commit','--quiet','-m','release');git(repository,'tag','registry-v0.1.0');
    const release=await registry.loadRegistryRelease({repository,version:'0.1.0'});
    try{return (await registry.publishRegistryRelease(admin,release,randomUUID())).releaseId;}
    catch{return (await admin.query("SELECT id FROM registry_releases WHERE semantic_version='0.1.0'")).rows[0]!.id as string;}
  }finally{await rm(repository,{recursive:true,force:true});}
}

async function source(externalId:string,words:string){
  const evidenceId=randomUUID(),anchorId=randomUUID(),connectorId=randomUUID();
  await admin.query("INSERT INTO connectors(id,owner_scope_id,connector_type,external_account_ref,permission_manifest,status) VALUES($1,$2,'CONVERSATION',$3,'{}','ACTIVE')",
    [connectorId,owner,externalId]);
  await admin.query(`INSERT INTO source_items(id,owner_scope_id,connector_id,source_type,external_id,actor_ref,submitted_by_user_id,
    raw_object_ref,content_hash,sensitivity,allowed_purposes,ingestion_version,idempotency_key,occurred_at)
    VALUES($1,$2,$3,'CONVERSATION',$4,$5,$6,$7,$8,'PRIVATE',ARRAY[$9],'evidence-json-v1',$10,$11)`,
    [evidenceId,owner,connectorId,externalId,JSON.stringify({type:'USER',id:actor}),actor,randomUUID(),randomBytes(32).toString('hex'),
      PURPOSE,randomUUID(),RECORDED]);
  await admin.query(`INSERT INTO source_anchors(id,owner_scope_id,source_item_id,anchor_kind,anchor,normalized_text)
    VALUES($1,$2,$3,'MESSAGE_SPAN',$4,$5)`,[anchorId,owner,evidenceId,JSON.stringify({start:0,end:words.length}),words]);
  return {evidenceId,anchorId};
}
/** A commitment to Daniel whose action is stated by `origin` and accepted. */
async function promise(action:string,anchorId:string,origin:string){
  const frame=randomUUID(),slot=randomUUID(),propositionId=randomUUID(),claimId=randomUUID();
  await admin.query("INSERT INTO frame_instances(id,owner_scope_id,frame_type_id,context_space_id) VALUES($1,$2,'shared.commitment',$3)",[frame,owner,baseContext]);
  for(const [role,entity] of [['promisor',maya],['promisee',daniel]] as const){
    await admin.query('INSERT INTO frame_instance_roles(id,owner_scope_id,frame_instance_id,role_id,entity_id) VALUES($1,$2,$3,$4,$5)',[randomUUID(),owner,frame,role,entity]);
  }
  await admin.query(`INSERT INTO belief_slots(id,owner_scope_id,frame_instance_id,predicate_id,context_space_id,modality)
    VALUES($1,$2,$3,'shared.commitment.action_description',$4,'COMMITTED')`,[slot,owner,frame,baseContext]);
  await admin.query('INSERT INTO propositions(id,owner_scope_id,belief_slot_id,normalized_value) VALUES($1,$2,$3,$4)',
    [propositionId,owner,slot,JSON.stringify({text:action})]);
  await admin.query(`INSERT INTO claims(id,owner_scope_id,source_anchor_id,proposition_id,claim_origin,lifecycle,valid_from,recorded_at,
    asserted_by_entity_id,extraction_confidence) VALUES($1,$2,$3,$4,$5,'PROVISIONAL',$6,$6,$7,0.91)`,
    [claimId,owner,anchorId,propositionId,origin,RECORDED,maya]);
  await admin.query(`INSERT INTO belief_assessments(id,owner_scope_id,proposition_id,assessment_status,valid_from,recorded_at,
    policy_version,decision_reason,transaction_id) VALUES($1,$2,$3,'ACCEPTED',$4,$4,'local-policy-0.1.0','{"code":"FIXTURE"}',$5)`,
    [randomUUID(),owner,propositionId,RECORDED,transactionId]);
  return {propositionId,claimId};
}

beforeAll(async()=>{
  await runMigrations(admin as never,resolve('migrations'));
  await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='ask_ui_test_app') THEN CREATE ROLE ask_ui_test_app LOGIN PASSWORD 'test-only'; END IF; END $$; GRANT unai_app TO ask_ui_test_app");
  const adapter=postgresAdapter(admin as never);
  const user=await adapter.createUser!({name:'Maya',email:'ask-ui@example.test',emailVerified:null});
  actor=user.id;owner=(user as unknown as {ownerScopeId:string}).ownerScopeId;
  token=randomBytes(32).toString('base64url');
  await adapter.createSession!({userId:user.id,sessionToken:token,expires:new Date(Date.now()+604800000)});
  baseContext=(await admin.query("SELECT id FROM context_spaces WHERE owner_scope_id=$1 AND context_kind='BASE'",[owner])).rows[0]!.id;
  registryReleaseId=await pinnedRegistryRelease();
  transactionId=randomUUID();
  await admin.query(`INSERT INTO belief_transactions(id,owner_scope_id,transaction_kind,requested_by_actor_id,source_evidence_ids,
    registry_release_id,status,risk,idempotency_key,commit_receipt,committed_at) VALUES($1,$2,'CANONICALIZE',$3,'{}',$4,'COMMITTED','LOW',$5,'{}',$6)`,
    [transactionId,owner,actor,registryReleaseId,randomUUID().replaceAll('-',''),RECORDED]);
  maya=randomUUID();daniel=randomUUID();
  await admin.query("INSERT INTO entities(id,owner_scope_id,entity_kind,canonical_label) VALUES($1,$2,'PERSON','Maya'),($3,$2,'PERSON','Daniel')",[maya,owner,daniel]);
  const identitySource=await source('maya-name','My name is Maya.');
  await admin.query(`INSERT INTO entity_aliases(id,owner_scope_id,entity_id,alias_type,alias_value,normalized_value,source_item_id,created_at)
    VALUES($1,$2,$3,'DISPLAY_NAME','Maya','maya',$4,$5)`,[randomUUID(),owner,maya,identitySource.evidenceId,RECORDED]);

  // What Maya told Daniel, in her own words, and what a model inferred she
  // agreed to from Daniel's message.
  Object.assign(lease,await source('chat-lease','I promised Daniel I would send him the signed lease by Friday.'));
  lease.propositionId=(await promise('send Daniel the signed lease',lease.anchorId,'USER_STATEMENT')).propositionId;
  Object.assign(keys,await source('chat-keys','Daniel: can you also bring the spare keys when you come?'));
  const inferred=await promise('bring Daniel the spare keys',keys.anchorId,'MODEL_INFERENCE');
  keys.propositionId=inferred.propositionId;
  keys.claimId=randomUUID();
  await admin.query(`INSERT INTO claims(id,owner_scope_id,source_anchor_id,claim_origin,lifecycle,recorded_at,asserted_by_entity_id)
    VALUES($1,$2,$3,'EXTERNAL_PERSON_ASSERTION','CANDIDATE',$4,$5)`,[keys.claimId,owner,keys.anchorId,RECORDED,daniel]);
  await admin.query(`INSERT INTO derived_proposition_dependencies(id,owner_scope_id,derived_proposition_id,input_claim_ids,evaluator_id,
    model_or_code_version,registry_release_id,calculation_inputs,created_by_transaction_id)
    VALUES($1,$2,$3,ARRAY[$4::uuid],'extraction.commitment_inference','fixture-model-1',$5,'{"rule":"request_accepted"}',$6)`,
    [randomUUID(),owner,keys.propositionId,keys.claimId,registryReleaseId,transactionId]);
});
afterAll(async()=>{await appPool.end();await admin.end();});

it('CRT-UX-03-A: asks "What did I promise Daniel?" in the Ask UI and answers with source links, its context read through the Context Broker',async()=>{
  const {createPlatformApi}=await import(/* @vite-ignore */ API_MODULE) as {createPlatformApi(options:Record<string,unknown>):InjectApp};
  const app=createPlatformApi({authPool:admin,appPool,evidenceObjects,registryReleaseId,registryRelease:'0.1.0'});
  app.addHook('onRequest',async request=>{Object.defineProperty(request.raw.socket,'encrypted',{value:true});});
  const calls:string[]=[];
  // The same signature as `apiRequest` in lib/server.ts, over the in-process transport.
  const call:ApiCall=async(path,method,headers,body)=>{
    calls.push(method+' '+path.replace(/[0-9a-f-]{36}/g,':id'));
    const response=await app.inject({method,url:path,headers,...(body===undefined?{}:{payload:body})});
    return {status:response.statusCode,body:JSON.parse(response.body)};
  };
  try{
    const loaded=await loadAsk(call,{cookie:SESSION_COOKIE+'='+token,ownerScopeId:owner},'What did I promise Daniel?');
    expect(loaded.kind).toBe('props');
    if(loaded.kind!=='props')return;
    const props=loaded.props;
    expect(props.state).toBe('answered');
    const answer=props.answer!;
    expect(answer.answerType).toBe('FUTURE_COMMITMENT');

    // The answer names what Maya promised Daniel, and links its sources.
    const promised=answer.statements.find(statement=>statement.text.includes('send Daniel the signed lease'))!;
    expect(promised).toBeTruthy();
    expect(promised.sourceEvidenceIds).toContain(lease.evidenceId);
    expect(answer.sourceLinks.map(link=>link.evidenceId)).toEqual(expect.arrayContaining([lease.evidenceId,keys.evidenceId]));

    // Its context was retrieved through the Context Broker: the packet the answer
    // names is the broker's own persisted record, read for this purpose by this
    // session's actor, and the answer's manifest was recorded over it.
    const packet=(await admin.query('SELECT purpose,requesting_actor_id,answer_type_classification,packet_hash FROM context_packets WHERE id=$1',
      [answer.packetId])).rows[0];
    expect(packet).toEqual({purpose:PURPOSE,requesting_actor_id:actor,answer_type_classification:'OPEN_COMMITMENTS',packet_hash:answer.packetHash});
    const manifest=(await admin.query('SELECT context_packet_id,belief_ids FROM answer_manifests WHERE id=$1',[answer.answerManifestId])).rows[0];
    expect(manifest!.context_packet_id).toBe(answer.packetId);
    expect(manifest!.belief_ids).toContain(lease.propositionId);
    expect(calls[0]).toBe('POST /v1/ask');

    // The screen, rendered from what came back.
    const html=renderToStaticMarkup(createElement(Ask,props));
    expect(html).toContain('What did I promise Daniel?');
    expect(html).toContain('send Daniel the signed lease');
    expect(html).toContain('href="/sources?evidence='+lease.evidenceId+'"');
    expect(html).toContain('data-label="COMMITTED"');
    expect(html).toMatch(/aria-live="polite" aria-atomic="true">Answer ready: \d+ statements?\./);
    expect(html).toContain('href="/answers/'+answer.answerManifestId+'"');

    // CRT-UX-11-A, Ask half: Why? / Sources on the statement opens the belief,
    // its claiming actor, the source excerpt, the effective time, the confidence
    // and the conflict status...
    expect(calls).toContain('GET /v1/memory/why/propositions/:id');
    const why=props.why[promised.statementId]!;
    expect(why).toMatchObject({subjectKind:'BELIEF',subject:{objectType:'propositions',objectId:lease.propositionId},label:'CONFIRMED',
      assessmentStatus:'ACCEPTED',conflict:{status:'NO_CONFLICT'}});
    expect(why.claimingActors).toContainEqual({kind:'PERSON',label:'Maya',entityId:maya});
    expect(why.sources[0]!.excerpt).toBe('I promised Daniel I would send him the signed lease by Friday.');
    expect(why.effectiveTime.from).not.toBeNull();
    expect(why.confidence).toMatchObject({assessmentStatus:'ACCEPTED',extraction:0.91});
    expect(html).toContain('I promised Daniel I would send him the signed lease by Friday.');
    expect(html).toContain('Nothing recorded disputes this.');
    // ...and, on the inferred statement, its derivation path.
    const inferredStatement=answer.statements.find(statement=>statement.text.includes('bring Daniel the spare keys'))!;
    const inferred=props.why[inferredStatement.statementId]!;
    expect(inferred).toMatchObject({label:'INFERRED',derivation:{isInferred:true}});
    expect(inferred.derivation.steps[0]!.inputs[0]).toMatchObject({objectType:'claims',objectId:keys.claimId});
    expect(html).toContain('Derived by the commitment inference rule (fixture-model-1) from:');
    expect(html).toContain('Daniel: can you also bring the spare keys when you come?');
    // Legacy Ask already created this thread; loading Chat must never re-answer.
    const chat=await loadChat(call,{cookie:SESSION_COOKIE+'='+token,ownerScopeId:owner},answer.conversationId);
    expect(chat.kind).toBe('props');if(chat.kind!=='props')throw new Error('CHAT_NOT_LOADED');
    expect(chat.props.answers[answer.turnId!]).toEqual(answer);
    for(const [statementId,panel] of Object.entries(props.why)){
      const reopened=chat.props.why[answer.turnId!]![statementId];
      if(!panel){expect(reopened).toBeNull();continue;}
      const {readAt,...explanation}=panel;
      expect(reopened).toMatchObject(explanation);
      expect(Date.parse(reopened!.readAt)).toBeGreaterThanOrEqual(Date.parse(readAt));
    }
    const chatHtml=renderToStaticMarkup(createElement(Chat,chat.props));expect(chatHtml).toContain('I promised Daniel I would send him the signed lease by Friday.');
    expect(calls.filter(c=>c==='POST /v1/ask')).toHaveLength(1);
  }finally{await app.close();}
});

it('CRT-UX-03-A: the Ask UI refuses a purpose the owner\'s memory does not admit, in fixed words',async()=>{
  const {createPlatformApi}=await import(/* @vite-ignore */ API_MODULE) as {createPlatformApi(options:Record<string,unknown>):InjectApp};
  const app=createPlatformApi({authPool:admin,appPool,evidenceObjects,registryReleaseId,registryRelease:'0.1.0'});
  app.addHook('onRequest',async request=>{Object.defineProperty(request.raw.socket,'encrypted',{value:true});});
  try{
    // The same question under a data purpose the evidence never admitted.
    const call:ApiCall=async(path,method,headers,body)=>{
      const payload=body&&typeof body==='object'?{...body as Record<string,unknown>,purpose:'ADVERTISING'}:body;
      const response=await app.inject({method,url:path,headers,...(payload===undefined?{}:{payload})});
      return {status:response.statusCode,body:JSON.parse(response.body)};
    };
    const loaded=await loadAsk(call,{cookie:SESSION_COOKIE+'='+token,ownerScopeId:owner},'What did I promise Daniel?');
    expect(loaded).toMatchObject({kind:'props',props:{state:'refused',refusal:'CONTEXT_READ_DENIED'}});
    if(loaded.kind!=='props')return;
    const html=renderToStaticMarkup(createElement(Ask,loaded.props));
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('signed lease');
  }finally{await app.close();}
});
