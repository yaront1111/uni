import { createHash,randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { type ClaimedJob,type InitiativeSettings,type RequestContext } from '@unai/domain';
import { withOwnerTransaction,type OwnerTransaction } from '@unai/postgres';
import { enqueueJob,runJobAttempt } from '@unai/jobs';
import { readContextPacket } from '@unai/context';
import { canonicalJson } from '@unai/memory';
import { decideInterruption,ownerLocalDate,readAttentionBudget,readProactiveAttentionCounts } from '@unai/review';
import { evaluateActionBasis,insertDraft,pluginCapabilityGranted } from '@unai/control';
import { GENERIC_REQUEST,inputMarker,initiativeSourceGate,settingsOf } from './initiative-store.js';
import { nextInitiativeRun } from './initiative-time.js';
import { initiativeSituation } from './initiative-situation.js';
import { uuidV7 } from '../../../src/kernel/identities.js';

interface Options {appPool:Pool;ownerScopeId:string;actorId:string;registryReleaseId:string;registryRelease:string;workerId:string;clock?:()=>Date;
  dataPurpose?:string;maximumSensitivity?:'NORMAL'|'PRIVATE'|'RESTRICTED'}
const rank={NORMAL:0,PRIVATE:1,RESTRICTED:2};
const digest=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');

/** Durable queue turns; no external provider action exists in this runtime. */
export function createInitiativeRuntime(options:Options) {
  const now=()=>options.clock?.()??new Date();
  const context=(purpose:string):RequestContext=>({ownerScopeId:options.ownerScopeId,actorId:options.actorId,purpose,correlationId:randomUUID()});
  const run=<T,>(purpose:string,work:(tx:OwnerTransaction)=>Promise<T>)=>withOwnerTransaction(options.appPool,context(purpose),work);
  function effective(settings:InitiativeSettings):InitiativeSettings|null {
    if(!settings.enabled||(options.dataPurpose&&settings.dataPurpose!==options.dataPurpose))return null;
    return {...settings,maximumSensitivity:options.maximumSensitivity&&rank[options.maximumSensitivity]<rank[settings.maximumSensitivity]?options.maximumSensitivity:settings.maximumSensitivity};
  }
  const readSettings=()=>run('jobs.enqueue',async tx=>settingsOf((await tx.query('SELECT * FROM initiative_settings WHERE owner_scope_id=$1',[options.ownerScopeId])).rows[0]));
  const gated=<T,>(purpose:string,settings:InitiativeSettings,work:(tx:OwnerTransaction)=>Promise<T>)=>run(purpose,async tx=>{await initiativeSourceGate(tx,settings.dataPurpose,settings.maximumSensitivity);return work(tx);});
  const packetFor=(settings:InitiativeSettings)=>readContextPacket(work=>gated('memory.read',settings,work),{
    ownerScopeId:options.ownerScopeId,requestingActorId:options.actorId,purpose:settings.dataPurpose,
    query:'Which scheduled items and their prerequisites remain unfinished?',frameTypeHints:['shared.commitment','shared.event_occurrence'],
    worldTime:'NOW',knowledgeTime:'LATEST',maximumSensitivity:settings.maximumSensitivity,requiredCertainty:['ACCEPTED','PROVISIONAL','CONTESTED','OWNER_OVERLAY'],actionRisk:'LOW',
  },{correlationId:randomUUID(),registryReleaseId:options.registryReleaseId,registryRelease:options.registryRelease,now:now()});
  async function dispatch():Promise<number> {
    const settings=effective(await readSettings());if(!settings)return 0;
    const marker=await gated('memory.read',settings,inputMarker),at=now();
    return run('jobs.enqueue',async tx=>{
      const row=(await tx.query('SELECT * FROM initiative_settings WHERE owner_scope_id=$1 FOR UPDATE',[options.ownerScopeId])).rows[0];
      if(!row?.enabled||row.revision!==settings.revision)return 0;
      const due=row.next_due_at instanceof Date&&row.next_due_at<=at;
      if(!due&&row.last_input_marker===marker)return 0;
      const key=digest({revision:row.revision,due:due?row.next_due_at.toISOString():null,marker});
      await enqueueJob(tx,{jobKind:'initiative.evaluate',idempotencyKey:key,maxAttempts:3,payload:{ownerScopeId:options.ownerScopeId,revision:row.revision}});
      await tx.query('UPDATE initiative_settings SET next_due_at=$2,last_input_marker=$3 WHERE owner_scope_id=$1',
        [options.ownerScopeId,nextInitiativeRun(at,settings.timeZone,settings.localTime),marker]);
      await tx.audit({policyDecision:'ALLOW',codeVersion:'initiative-0.1.0',result:'SUCCESS',objects:[{type:'initiative_settings',id:options.ownerScopeId,fields:['next_due_at']}]});return 1;
    });
  }
  async function handle(job:ClaimedJob) {
    if(job.ownerScopeId!==options.ownerScopeId||job.payload['ownerScopeId']!==options.ownerScopeId)throw new Error('INITIATIVE_OWNER_MISMATCH');
    const lock=await options.appPool.connect(),key='initiative:'+options.ownerScopeId;
    try {
      await lock.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[key]);
      const settings=effective(await readSettings());if(!settings||job.payload['revision']!==settings.revision)return;
      const packet=await packetFor(settings),at=now();
      const watches=await gated('memory.read',settings,async tx=>(await tx.query(`SELECT * FROM initiative_watches WHERE owner_scope_id=$1 AND enabled
        AND (snoozed_until IS NULL OR snoozed_until<=$2) ORDER BY created_at,id LIMIT 200`,[options.ownerScopeId,at])).rows);
      let nextThreshold:Date|null=null;
      for(const watch of watches) {
        const candidate=initiativeSituation(packet,watch,at);if(!candidate)continue;
        if(candidate.nextThreshold&&(!nextThreshold||candidate.nextThreshold<nextThreshold))nextThreshold=candidate.nextThreshold;
        const day=ownerLocalDate(at,settings.timeZone);
        const existing=await run('memory.inbox',async tx=>(await tx.query(`SELECT 1 FROM initiative_receipts
          WHERE owner_scope_id=$1 AND watch_id=$2 AND state_digest=$3 AND threshold=$4
          AND (attention_decision='ASK' OR owner_local_date=$5::date)`,
          [options.ownerScopeId,watch.id,candidate.stateDigest,candidate.threshold,day])).rowCount);
        if(existing)continue;
        // Re-check source visibility immediately before preparation; the owner
        // can reduce permissions between enqueue and execution.
        const visible=await gated('memory.read',settings,async tx=>(await tx.query('SELECT id FROM source_items WHERE owner_scope_id=$1 AND id=ANY($2::uuid[])',[options.ownerScopeId,candidate.sourceIds])).rowCount);
        if(visible!==candidate.sourceIds.length)continue;
        const attention=await run('memory.inbox',async tx=>{
          const budget=await readAttentionBudget(tx,{ownerScopeId:options.ownerScopeId});
          const counts=await readProactiveAttentionCounts(tx,{ownerScopeId:options.ownerScopeId,ownerLocalDate:day});
          const used=[...counts.values()].reduce((sum,count)=>sum+count,0);
          return decideInterruption({risk:{errorProbability:0.8,consequence:'MEDIUM',irreversibility:'COSTLY_TO_REVERSE',urgency:candidate.threshold==='UPCOMING'?'MEDIUM':'HIGH',interruptionCost:'LOW'},
            sensitivityScope:'PERSONAL/'+settings.maximumSensitivity,budget,ownerLocalDate:day,timeZone:settings.timeZone,now:at,askedToday:used,
            askedInScopeToday:counts.get('PERSONAL/'+settings.maximumSensitivity)??0,
            lastAskedAt:null,suppressedUntil:watch.snoozed_until,materialNewEvidenceIds:candidate.sourceIds,learnedApprovalRuleId:null});
        });
        let preparation='NOT_REQUESTED',verdict:Awaited<ReturnType<typeof evaluateActionBasis>>|null=null;
        if(settings.prepareDrafts&&attention.decision==='ASK') {
          const granted=await run('action.draft',tx=>pluginCapabilityGranted(tx,'gmail.create_draft'));
          if(!granted)preparation='CAPABILITY_NOT_GRANTED';
          else {
            verdict=await evaluateActionBasis(work=>gated('memory.read',settings,work),{ownerScopeId:options.ownerScopeId,actorId:options.actorId,purpose:settings.dataPurpose,
              basis:{query:'Prepare a request for an unresolved prerequisite before a scheduled item.',entityHints:[],frameTypeHints:['shared.commitment','shared.event_occurrence']},
              maximumSensitivity:settings.maximumSensitivity,actionRisk:'LOW',capabilityGranted:granted},
            {correlationId:randomUUID(),registryReleaseId:options.registryReleaseId,registryRelease:options.registryRelease});
            preparation=verdict.outcome==='DENY'?'POLICY_DENIED':verdict.outcome!=='ALLOW'||!candidate.settled?'CONFIRMATION_REQUIRED':'DRAFTED';
          }
        }
        await run('action.draft',async tx=>{
          // Locking reads require the table's UPDATE policy; drafting cannot
          // acquire the owner's settings/edit authority merely to recheck it.
          const live=(await tx.query('SELECT enabled,revision,prepare_drafts FROM initiative_settings WHERE owner_scope_id=$1',[options.ownerScopeId])).rows[0];
          const current=(await tx.query('SELECT enabled,snoozed_until FROM initiative_watches WHERE owner_scope_id=$1 AND id=$2',[options.ownerScopeId,watch.id])).rows[0];
          if(!live?.enabled||live.revision!==settings.revision||!current?.enabled||(current.snoozed_until&&current.snoozed_until>at))return;
          let draftId:string|null=null;
          if(preparation==='DRAFTED'&&verdict?.packetId&&verdict.policyDecisionId) {
            if(!live.prepare_drafts)preparation='NOT_REQUESTED';
            else if(!await pluginCapabilityGranted(tx,'gmail.create_draft'))preparation='CAPABILITY_NOT_GRANTED';
            else draftId=(await insertDraft(tx,{draftKind:'EMAIL',capabilityId:'gmail.create_draft',content:{subject:null,body:GENERIC_REQUEST,recipients:[],startsAt:null,endsAt:null},recommendationId:null,
              supportingPacketId:verdict.packetId,policyDecisionId:verdict.policyDecisionId})).draft.draftId;
          }
          const id=uuidV7();
          await tx.query(`INSERT INTO initiative_receipts(id,owner_scope_id,watch_id,state_digest,threshold,owner_local_date,source_evidence_ids,packet_id,
            attention_decision,attention_reason,attention_inputs,preparation,draft_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [id,options.ownerScopeId,watch.id,candidate.stateDigest,candidate.threshold,day,candidate.sourceIds,packet.packetId,attention.decision,attention.reason,JSON.stringify(attention.policyInputs),preparation,draftId]);
          await tx.audit({policyDecision:'ALLOW',codeVersion:'initiative-0.1.0',result:'SUCCESS',objects:[{type:'initiative_receipts',id,fields:['attention_decision','preparation','draft_id']}]});
        });
      }
      if(nextThreshold)await run('jobs.enqueue',tx=>tx.query('UPDATE initiative_settings SET next_due_at=least(next_due_at,$2) WHERE owner_scope_id=$1 AND enabled AND revision=$3',
        [options.ownerScopeId,nextThreshold,settings.revision]));
    } finally {await lock.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]).finally(()=>lock.release());}
  }
  return {dispatch,async runOnce(){await dispatch();return runJobAttempt(options.appPool,context('jobs.work'),{worker:options.workerId,leaseSeconds:300,jobKinds:['initiative.evaluate'],handler:handle});}};
}
