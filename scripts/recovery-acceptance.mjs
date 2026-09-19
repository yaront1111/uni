import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {deepStrictEqual} from 'node:assert';
import {comparableRecoveryOutput} from './recovery-output.mjs';
const {Pool}=createRequire(new URL('../packages/postgres/package.json',import.meta.url))('pg');
// The named owners are created by the existing §44 acceptance fixtures. These
// probes read their terminal persisted state; original scenario assertions run
// first and must pass. No fixture facts are reseeded into the restored database.
const fixtures=[
 ['Provenance','PERSONAL_FINANCE','Do I still owe Daniel?'],
 ['Canonicalization owner','PERSONAL_ASSISTANCE','Do I still owe Daniel?'],
 ['Canonicalization owner','PERSONAL_ASSISTANCE','What changed about the loan?'],
 ['Resolution owner','PERSONAL_ASSISTANCE','Do I still owe Daniel?'],
 ['Corrections','PERSONAL_ASSISTANCE','What did I promise Daniel?'],
 ['Provenance','PERSONAL_FINANCE','Does anything about the loan contradict itself?'],
 ['Resolution owner','PERSONAL_ASSISTANCE','What is on my calendar?'],
 ['Projection owner','PERSONAL_ASSISTANCE','What did I promise?'],
 ['Resolution owner','PERSONAL_ASSISTANCE','Did my prediction come true?'],
 ['Canonicalization owner','PERSONAL_ASSISTANCE','What did I believe at the time?'],
 ['Projection owner','PERSONAL_ASSISTANCE','Does anything about the loan contradict itself?'],
 ['Memory owner','PERSONAL_ASSISTANCE','What do I know about Daniel?'],
 ['Lineage','PERSONAL_ASSISTANCE','Do I still owe Daniel?'],
 ['Lineage','PERSONAL_ASSISTANCE','Does anything about the loan contradict itself?'],
 ['Provenance','PERSONAL_FINANCE','Do I owe Dana for the concert tickets?'],
 ['Canonicalization owner','PERSONAL_ASSISTANCE','What does Daniel say?'],
 ['Projection owner','PERSONAL_ASSISTANCE','Do I still owe Daniel?'],
 ['data','PERSONAL_FINANCE','Do I owe Dana?'],
 ['email-injection','PERSONAL_FINANCE','Do I still owe Daniel?'],
 ['Provenance','PERSONAL_FINANCE','Do I still owe Daniel?'],
];
export async function compareAcceptanceReads(sourceUrl,restoredUrl){
  const unregister=(await import('tsx/esm/api')).register();
  const {withOwnerTransaction}=await import('../packages/postgres/src/index.ts');
  const {readOwnerOverlay}=await import('../packages/memory/src/index.ts');
  const {answerQuestion,buildTodayBriefing,readWhySources,readPersistedPacket,suppliedContextOf}=await import('../packages/context/src/index.ts');
  const now=new Date(); // Frozen once, after all fixture writes have completed.
  const source=new Pool({connectionString:sourceUrl,max:1});
  const restored=new Pool({connectionString:restoredUrl,max:1});
  const appUrl=url=>{const parsed=new URL(url);parsed.username='recovery_test_app';parsed.password='test-only';return parsed.href;};
  await source.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='recovery_test_app') THEN CREATE ROLE recovery_test_app LOGIN PASSWORD 'test-only'; END IF; END $$; GRANT unai_app TO recovery_test_app");
  const sourceApp=new Pool({connectionString:appUrl(sourceUrl),max:1}),restoredApp=new Pool({connectionString:appUrl(restoredUrl),max:1});
  const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
  async function read(pool,admin,owner,actor,purpose,question,worldTime=now.toISOString()){
    const context={ownerScopeId:owner,actorId:actor,purpose:'memory.read',correlationId:randomUUID()};
    // Every transaction declares the same source boundary as the public read,
    // including saved packets; a broker's earlier transaction grants no access.
    const runner=run=>withOwnerTransaction(pool,context,async tx=>{
      await tx.query("SELECT set_config('unai.data_purpose',$1,true),set_config('unai.maximum_sensitivity','RESTRICTED',true)",[purpose]);
      return run(tx);
    });
    const release=(await admin.query("SELECT id FROM registry_releases WHERE semantic_version='0.1.0'")).rows[0]?.id??null;
    const options={now,correlationId:context.correlationId,requestingActorId:actor,registryReleaseId:release,registryRelease:'0.1.0'};
    const ask=await answerQuestion(runner,{ownerScopeId:owner,question,purpose,worldTime,knowledgeTime:'LATEST',maximumSensitivity:'RESTRICTED'},options);
    const today=await buildTodayBriefing(runner,{ownerScopeId:owner,timeZone:'UTC',date:null,dataPurpose:purpose,maximumSensitivity:'RESTRICTED'},options);
    const packet=await runner(tx=>readPersistedPacket(tx,{ownerScopeId:owner,packetId:ask.packetId}));
    const supplied=suppliedContextOf(packet.packet,{registryReleaseId:release});
    const why=[];
    for(const statement of [...ask.statements,...today.sections.flatMap(section=>section.items).map(item=>({objectRefs:item.sourceRefs}))]){
      for(const ref of statement.objectRefs??[]){
        if(!['propositions','owner_overlay_deltas','resolution_assertions'].includes(ref.objectType))continue;
        why.push(await withOwnerTransaction(pool,{...context,purpose:'memory.inspect'},async tx=>{
          await tx.query("SELECT set_config('unai.data_purpose',$1,true),set_config('unai.maximum_sensitivity','RESTRICTED',true)",[purpose]);
          return readWhySources(tx,{ownerScopeId:owner,ref,readAt:now});
        }));
      }
    }
    const comparablePacket={...packet.packet,policy:{...packet.packet.policy,policyDecisionId:'GENERATED_READ_RECEIPT'}};
    return comparableRecoveryOutput({ask,today,supplied,packet:comparablePacket,why});
  }
  try{
    const receipts=[];
    for(const [index,[label,purpose,question]] of fixtures.entries()){
      const id='AC44.'+String(index+1).padStart(2,'0');
      const owners=(await source.query(`SELECT m.owner_scope_id,m.user_id FROM owner_scope_members m JOIN users u ON u.id=m.user_id
        JOIN owner_scopes o ON o.id=m.owner_scope_id WHERE u.display_name=$1 AND u.disabled_at IS NULL AND o.deleted_at IS NULL ORDER BY m.owner_scope_id`,[label])).rows;
      if(owners.length!==1)throw new Error('RESTORE_FIXTURE_OWNER_MISSING_OR_AMBIGUOUS: '+id+' '+label+' '+owners.length);
      const owner=owners[0];
      console.log('Recovery fixture '+id+' ('+label+')');
      const before=await read(sourceApp,source,owner.owner_scope_id,owner.user_id,purpose,question);
      const after=await read(restoredApp,restored,owner.owner_scope_id,owner.user_id,purpose,question);
      if(id==='AC44.05'){
        const context={ownerScopeId:owner.owner_scope_id,actorId:owner.user_id,purpose:'memory.correct',correlationId:randomUUID()};
        const overlay=pool=>withOwnerTransaction(pool,context,async tx=>{
          await tx.query("SELECT set_config('unai.data_purpose',$1,true),set_config('unai.maximum_sensitivity','RESTRICTED',true)",[purpose]);
          return readOwnerOverlay(tx,{ownerScopeId:owner.owner_scope_id});
        });
        before.ownerOverlay=await overlay(sourceApp);after.ownerOverlay=await overlay(restoredApp);
        const assertion=before.ownerOverlay.deltas.find(delta=>delta.rawText==='I paid him back');
        if(!assertion||assertion.assertionKind!=='USER_ASSERTION'||assertion.independentVerification.verified!==false)
          throw new Error('RECOVERY_PHONE_ASSERTION_FIXTURE_MISSING');
      }
      deepStrictEqual(after,before,'RESTORED_ACCEPTANCE_ANSWER_MISMATCH '+id);
      const historical=[];
      if(id==='AC44.10'){
        for(const historicalQuestion of ['What was true about Daniel on August 7?','What did Uai believe on August 7?']){
          const left=await read(sourceApp,source,owner.owner_scope_id,owner.user_id,purpose,historicalQuestion,'2025-08-07T00:00:00.000Z');
          const right=await read(restoredApp,restored,owner.owner_scope_id,owner.user_id,purpose,historicalQuestion,'2025-08-07T00:00:00.000Z');
          deepStrictEqual(right,left,'RESTORED_HISTORICAL_ANSWER_MISMATCH '+id);
          historical.push({source:left,restored:right});
        }
      }
      receipts.push({id,sourceDigest:hash([before,...historical.map(pair=>pair.source)]),restoredDigest:hash([after,...historical.map(pair=>pair.restored)]),
        frozenAt:now.toISOString(),question,purpose,statements:before.ask.statements.length,beliefs:before.supplied.beliefIds.length,
        explanations:before.why.length,todayItems:before.today.sections.reduce((n,section)=>n+section.items.length,0),historicalModes:historical.length,ownerOverlayDeltas:before.ownerOverlay?.deltas.length??0});
    }
    return receipts;
  }finally{await Promise.all([sourceApp.end(),restoredApp.end(),source.end(),restored.end()]);await unregister();}
}



