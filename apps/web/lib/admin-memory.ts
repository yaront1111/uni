import {randomUUID} from 'node:crypto';
import {commitmentsProjectionViewSchema,obligationsProjectionViewSchema,scheduleProjectionViewSchema,relatedFramesSchema,mergeSplitReviewSchema,contextRequestSchema,contextPacketSchema} from '@unai/domain';
import {loadInspector,type ApiCall,type Caller} from './memory';
import type {AdminMemoryProps} from '../components/AdminMemory';
import {pendingProposalsSchema} from './memory-proposals';

export async function loadAdminMemory(call:ApiCall,caller:Caller&{actorId?:string},query:Record<string,string|string[]|undefined>):Promise<{kind:'expired'}|{kind:'props';props:AdminMemoryProps}>{
  const props:AdminMemoryProps={frames:[],errors:[],inspector:null,review:null};
  const headers=(purpose:string)=>({cookie:caller.cookie,'x-owner-scope-id':caller.ownerScopeId,'x-purpose':purpose,
    'x-correlation-id':randomUUID(),'x-data-purpose':'PERSONAL_ASSISTANCE','x-maximum-sensitivity':'RESTRICTED'});
  const ids=new Set<string>();
  if(caller.actorId){
    try{
      const one=(name:string)=>typeof query[name]==='string'?query[name] as string:'';
      const filters={q:one('q'),person:one('person'),topic:one('topic'),kind:one('kind'),from:one('from'),to:one('to')};
      props.filters=filters;
      const request=contextRequestSchema.parse({ownerScopeId:caller.ownerScopeId,requestingActorId:caller.actorId,
        purpose:'PERSONAL_ASSISTANCE',maximumSensitivity:'RESTRICTED',actionRisk:'LOW',worldTime:'NOW',knowledgeTime:'LATEST',
        query:filters.q||'memory',entityHints:filters.person?[filters.person]:[],worldlineHints:filters.topic?[filters.topic]:[],
        frameTypeHints:filters.kind?[filters.kind]:[],requiredCertainty:['ACCEPTED','PROVISIONAL','CONTESTED','OWNER_OVERLAY'],
        timeWindow:filters.from||filters.to?{from:filters.from?new Date(filters.from+'T00:00:00.000Z').toISOString():null,
          to:filters.to?new Date(filters.to+'T23:59:59.999Z').toISOString():null}:null});
      const response=await call('/v1/memory/context','POST',{...headers('memory.read'),'idempotency-key':randomUUID().replaceAll('-','')},request);
      if(response.status===401)return {kind:'expired'};
      if(response.status!==201&&response.status!==200)throw new Error('unavailable');
      const packet=contextPacketSchema.parse(response.body);
      for(const belief of [...packet.currentBeliefs,...packet.historicalBeliefs,...packet.futureClaims])ids.add(belief.frameInstanceId);
      if(packet.unknowns.some(unknown=>unknown.kind==='PROJECTION_INCOMPLETE'))props.errors.push('Some results may be outside the current retrieval limit. Narrow your search.');
    }catch{props.errors.push('Memory search could not be read. Check the filters and reload to retry.');}
  }
  for(const kind of ['commitments','obligations','schedule'] as const){
    try{
      const response=await call('/v1/projections/'+kind+'?includeResolved=true','GET',headers('projection.read'));
      if(response.status===401)return {kind:'expired'};
      if(response.status!==200)throw new Error('unavailable');
      const view=kind==='commitments'?commitmentsProjectionViewSchema.parse(response.body):kind==='obligations'?obligationsProjectionViewSchema.parse(response.body):scheduleProjectionViewSchema.parse(response.body);
      for(const row of view.rows)ids.add('commitmentFrameInstanceId' in row?row.commitmentFrameInstanceId:'obligationFrameInstanceId' in row?row.obligationFrameInstanceId:row.scheduledFrameInstanceId);
      if(!view.isComplete||view.rows.length===500)props.errors.push('The '+kind+' projection is incomplete or at its result limit. Some items may be missing.');
    }catch{props.errors.push('The '+kind+' projection could not be loaded. Please reload to retry.');}
  }
  const frameIds=[...ids];
  for(let start=0;start<frameIds.length;start+=100){
    try{
      const response=await call('/v1/memory/frames/related?ids='+frameIds.slice(start,start+100).join(','),'GET',headers('memory.inspect'));
      if(response.status===401)return {kind:'expired'};
      if(response.status!==200)throw new Error('unavailable');
      props.frames.push(...relatedFramesSchema.parse(response.body).frames);
    }catch{props.errors.push('Some memory details could not be read. Please reload to retry.');break;}
  }
  if(query.id){
    const inspected=await loadInspector(call,caller,query.type??'proposition',query.id);
    if(inspected.kind==='expired')return inspected;
    props.inspector=inspected.props.inspector;
    if(inspected.props.error)props.errors.push(inspected.props.error);
  }
  if(query.review==='merge-split'){
    try{
      const response=await call('/v1/memory/merge-split/review','GET',headers('memory.inspect'));
      if(response.status===401)return {kind:'expired'};
      if(response.status!==200)throw new Error('unavailable');
      props.review=mergeSplitReviewSchema.parse(response.body);
    }catch{props.errors.push('Merge and split review could not be loaded. Please reload to retry.');}
  }
  try{
    const response=await call('/v1/memory/transactions','GET',headers('memory.govern'));
    if(response.status===401)return {kind:'expired'};
    if(response.status!==200)throw new Error('unavailable');
    const pending=pendingProposalsSchema.parse(response.body);
    props.proposals=pending.proposals;props.proposalsAtLimit=pending.atLimit;
  }catch{props.errors.push('Pending proposals could not be read. Please reload to retry.');}
  return {kind:'props',props};
}
