import { createHash } from 'node:crypto';
import type { FastifyInstance,FastifyRequest,FastifyReply } from 'fastify';
import type { OwnerTransaction } from '@unai/postgres';
import { dataPurposeSchema,sensitivitySchema,initiativeSettingsInputSchema,initiativeWatchInputSchema,initiativeWatchPatchSchema } from '@unai/domain';
import { assertTimeZone } from '@unai/review';
import { ContextBrokerError,readContextPacket } from '@unai/context';
import { ingestOwnerStatement,type EvidenceObjects } from './evidence.js';
import { nextInitiativeRun } from './initiative-time.js';
import { initiativeSituation } from './initiative-situation.js';
import { inputMarker,initiativeSourceGate,noticeOf,readInitiativeSettings,settingsOf,watchOf } from './initiative-store.js';

type Work=(request:FastifyRequest,run:(tx:OwnerTransaction,sessionId:string)=>Promise<unknown>,purpose?:string)=>Promise<unknown>;
export function registerInitiativeRoutes(app:FastifyInstance,work:Work,options:{evidenceObjects?:EvidenceObjects;clock?:()=>Date;registryReleaseId?:string;registryRelease?:string}) {
  const now=()=>options.clock?.()??new Date();
  const as=<T,>(request:FastifyRequest,purpose:string,run:(tx:OwnerTransaction)=>Promise<T>)=>work(request,run,purpose) as Promise<T>;
  async function refuse(request:FastifyRequest,reply:FastifyReply,code:string,status=400) {
    await work(request,tx=>tx.audit({policyDecision:'DENY',codeVersion:'initiative-0.1.0',result:'REFUSED',objects:[]}));
    return reply.code(status).send({code,correlationId:request.ownerContext!.correlationId});
  }
  function gate(request:FastifyRequest) {
    const purpose=dataPurposeSchema.safeParse(request.headers['x-data-purpose']),maximum=sensitivitySchema.safeParse(request.headers['x-maximum-sensitivity']);
    return purpose.success&&maximum.success?{purpose:purpose.data,maximum:maximum.data}:null;
  }
  async function packet(request:FastifyRequest,reply:FastifyReply,purpose:string,maximum:'NORMAL'|'PRIVATE'|'RESTRICTED') {
    try { return await readContextPacket(run=>as(request,'memory.read',run),{ownerScopeId:request.ownerContext!.ownerScopeId,requestingActorId:request.ownerContext!.actorId,
      purpose,query:'Which scheduled items and prerequisites remain unfinished?',worldTime:'NOW',knowledgeTime:'LATEST',maximumSensitivity:maximum,
      frameTypeHints:['shared.commitment','shared.event_occurrence'],requiredCertainty:['ACCEPTED','PROVISIONAL','CONTESTED','OWNER_OVERLAY'],actionRisk:'LOW'},
    {correlationId:request.ownerContext!.correlationId,registryReleaseId:options.registryReleaseId??null,registryRelease:options.registryRelease??null,now:now()});
    }catch(error){
      if(!(error instanceof ContextBrokerError))throw error;
      await refuse(request,reply,error.message,error.message==='CONTEXT_READ_DENIED'||error.message==='CONTEXT_ACTION_DENIED'?403:400);
      return null;
    }
  }
  app.get('/v1/settings/initiative',async request=>work(request,async tx=>{
    const settings=await readInitiativeSettings(tx);await tx.audit({policyDecision:'ALLOW',codeVersion:'initiative-0.1.0',result:'SUCCESS',objects:[{type:'initiative_settings',id:tx.context.ownerScopeId,fields:['enabled','next_due_at']}]});return {settings};
  }));
  app.patch('/v1/settings/initiative',async(request,reply)=>{
    const parsed=initiativeSettingsInputSchema.safeParse(request.body);
    if(!parsed.success)return refuse(request,reply,'INITIATIVE_REQUEST_INVALID');
    try{assertTimeZone(parsed.data.timeZone);}catch{return refuse(request,reply,'INITIATIVE_REQUEST_INVALID');}
    const input=parsed.data,at=now();
    const marker=await as(request,'memory.read',async tx=>{await initiativeSourceGate(tx,input.dataPurpose,input.maximumSensitivity);return inputMarker(tx);});
    return work(request,async tx=>{
      const row=(await tx.query(`INSERT INTO initiative_settings(owner_scope_id,actor_id,enabled,time_zone,local_time,data_purpose,maximum_sensitivity,prepare_drafts,next_due_at,last_input_marker)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(owner_scope_id) DO UPDATE SET actor_id=excluded.actor_id,enabled=excluded.enabled,
        time_zone=excluded.time_zone,local_time=excluded.local_time,data_purpose=excluded.data_purpose,maximum_sensitivity=excluded.maximum_sensitivity,
        prepare_drafts=excluded.prepare_drafts,next_due_at=excluded.next_due_at,last_input_marker=excluded.last_input_marker,revision=initiative_settings.revision+1,updated_at=now() RETURNING *`,
      [tx.context.ownerScopeId,tx.context.actorId,input.enabled,input.timeZone,input.localTime,input.dataPurpose,input.maximumSensitivity,input.prepareDrafts,
        input.enabled?nextInitiativeRun(at,input.timeZone,input.localTime):null,marker])).rows[0];
      await tx.audit({policyDecision:'ALLOW',codeVersion:'initiative-0.1.0',result:'SUCCESS',objects:[{type:'initiative_settings',id:tx.context.ownerScopeId,fields:['enabled','next_due_at','prepare_drafts']}]});
      return {settings:settingsOf(row)};
    });
  });
  app.post('/v1/initiative/watches',async(request,reply)=>{
    const parsed=initiativeWatchInputSchema.safeParse(request.body),access=gate(request);
    if(!parsed.success||!access)return refuse(request,reply,'INITIATIVE_REQUEST_INVALID');
    if(!options.evidenceObjects)return refuse(request,reply,'INITIATIVE_STORAGE_UNAVAILABLE',503);
    const input=parsed.data,context=await packet(request,reply,access.purpose,access.maximum);if(!context)return;
    const frames=new Set([...context.currentBeliefs,...context.futureClaims].map(belief=>belief.frameInstanceId));
    if(!frames.has(input.scheduledFrameId)||!frames.has(input.prerequisiteFrameId))return refuse(request,reply,'INITIATIVE_FRAME_UNAVAILABLE',404);
    const watch=await work(request,async tx=>{
      await initiativeSourceGate(tx,access.purpose,access.maximum);
      const key=createHash('sha256').update('initiative:'+String(request.headers['idempotency-key'])).digest('hex');
      const source=await ingestOwnerStatement(tx,options.evidenceObjects!,{text:JSON.stringify(input),externalId:'initiative:'+key,idempotencyKey:key,
        sensitivity:access.maximum,allowedPurposes:[access.purpose],deterministicMetadata:{initiativeWatch:true}});
      const row=(await tx.query(`INSERT INTO initiative_watches(id,owner_scope_id,source_item_id,source_anchor_id,scheduled_frame_id,prerequisite_frame_id)
        VALUES($1,$2,$1,$3,$4,$5) ON CONFLICT(owner_scope_id,source_item_id) DO UPDATE SET enabled=initiative_watches.enabled RETURNING *`,
      [source.evidenceId,tx.context.ownerScopeId,source.sourceAnchorId,input.scheduledFrameId,input.prerequisiteFrameId])).rows[0];
      await tx.audit({policyDecision:'ALLOW',codeVersion:'initiative-0.1.0',result:'SUCCESS',objects:[{type:'initiative_watches',id:row.id,fields:['source_item_id','scheduled_frame_id','prerequisite_frame_id']}]});return watchOf(row);
    });
    return reply.code(201).send({watch});
  });
  app.patch<{Params:{id:string}}>('/v1/initiative/watches/:id',async(request,reply)=>{
    const parsed=initiativeWatchPatchSchema.safeParse(request.body),access=gate(request);
    if(!parsed.success||!access||!/^[a-f0-9-]{36}$/i.test(request.params.id))return refuse(request,reply,'INITIATIVE_REQUEST_INVALID');
    return work(request,async tx=>{
      await initiativeSourceGate(tx,access.purpose,access.maximum);
      const row=(await tx.query(`UPDATE initiative_watches SET enabled=coalesce($3,enabled),snoozed_until=CASE WHEN $4 THEN $5 ELSE snoozed_until END
        WHERE owner_scope_id=$1 AND id=$2 RETURNING *`,[tx.context.ownerScopeId,request.params.id,parsed.data.enabled??null,'snoozedUntil' in parsed.data,parsed.data.snoozedUntil??null])).rows[0];
      if(!row)return reply.code(404).send({code:'INITIATIVE_WATCH_UNAVAILABLE'});
      await tx.audit({policyDecision:'ALLOW',codeVersion:'initiative-0.1.0',result:'SUCCESS',objects:[{type:'initiative_watches',id:row.id,fields:['enabled','snoozed_until']}]});return {watch:watchOf(row)};
    });
  });
  app.get('/v1/initiative/watches',async(request,reply)=>{
    const access=gate(request);if(!access)return refuse(request,reply,'INITIATIVE_CONTEXT_REQUIRED');
    return work(request,async tx=>{await initiativeSourceGate(tx,access.purpose,access.maximum);
      const rows=(await tx.query('SELECT * FROM initiative_watches WHERE owner_scope_id=$1 ORDER BY created_at,id LIMIT 200',[tx.context.ownerScopeId])).rows;
      await tx.audit({policyDecision:'ALLOW',codeVersion:'initiative-0.1.0',result:'SUCCESS',objects:rows.slice(0,100).map(row=>({type:'initiative_watches',id:row.id,fields:['enabled']}))});return {watches:rows.map(watchOf)};});
  });
  app.get('/v1/initiative/notices',async(request,reply)=>{
    const access=gate(request);if(!access)return refuse(request,reply,'INITIATIVE_CONTEXT_REQUIRED');
    const current=await packet(request,reply,access.purpose,access.maximum);if(!current)return;
    return work(request,async tx=>{await initiativeSourceGate(tx,access.purpose,access.maximum);
      const rows=(await tx.query(`SELECT r.*,r.owner_local_date::text AS owner_local_date,w.source_item_id,w.scheduled_frame_id,w.prerequisite_frame_id FROM initiative_receipts r JOIN initiative_watches w ON w.owner_scope_id=r.owner_scope_id AND w.id=r.watch_id
        WHERE r.owner_scope_id=$1 AND r.attention_decision='ASK' AND w.enabled
          AND (w.snoozed_until IS NULL OR w.snoozed_until<=$2)
        ORDER BY r.created_at DESC,r.id LIMIT 100`,[tx.context.ownerScopeId,now()])).rows
        .filter(row=>{const candidate=initiativeSituation(current,row,now());return candidate!==null&&candidate.stateDigest===row.state_digest&&candidate.threshold===row.threshold;});
      await tx.audit({policyDecision:'ALLOW',codeVersion:'initiative-0.1.0',result:'SUCCESS',objects:rows.map(row=>({type:'initiative_receipts',id:row.id,fields:['preparation']}))});return {notices:rows.map(noticeOf)};});
  });
}
