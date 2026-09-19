import {contextPacketSchema,PARTIAL_OUTCOME_CODES,worldTimeSchema,initiativeSettingsSchema,initiativeWatchSchema,initiativeNoticeSchema,initiativeWatchInputSchema,
  type ContextPacket,type InitiativeSettings,type InitiativeWatch} from '@unai/domain';
import type {ApiCall,Caller} from './screens';

export interface InitiativeChoice {frameId:string;label:string;time:string|null;provisional:boolean;scheduled:boolean}
export interface InitiativeChoices {scheduled:InitiativeChoice[];prerequisites:InitiativeChoice[];incomplete:boolean}
export interface InitiativeLoad {settings:InitiativeSettings|null;watches:InitiativeWatch[];notices:ReturnType<typeof initiativeNoticeSchema.parse>[];
  choices:InitiativeChoices;error:string|null}
function field(body:unknown,key:string):unknown {return body&&typeof body==='object'?(body as Record<string,unknown>)[key]:undefined;}
const emptyChoices=():InitiativeChoices=>({scheduled:[],prerequisites:[],incomplete:true});
function textValue(value:unknown):string|null {
  if(typeof value==='string')return value.trim()||null;
  if(!value||typeof value!=='object')return null;
  const record=value as Record<string,unknown>;
  for(const key of ['text','description','value'])if(typeof record[key]==='string'&&record[key].trim())return record[key].trim();
  return null;
}
function instant(value:unknown,allowEnd:boolean):string|null {
  if(!value||typeof value!=='object')return null;
  const record=value as Record<string,unknown>;
  for(const key of allowEnd?['time','start','end']:['time','start']){
    const parsed=worldTimeSchema.safeParse(record[key]);if(parsed.success&&parsed.data!=='NOW')return parsed.data;
  }
  return null;
}
/** Choice labels come only from selected, source-backed context values. No raw
 * projection, thread title, unselected belief or identifier is a label fallback. */
export function initiativeChoices(packet:ContextPacket):InitiativeChoices {
  const admitted=new Map([...packet.currentBeliefs,...packet.futureClaims].map(value=>[value.propositionId,value]));
  const selected=packet.selections.filter(value=>{
    const belief=value.selectedPropositionId?admitted.get(value.selectedPropositionId):undefined;
    return value.outcome==='SELECTED'&&value.contextKind==='BASE'&&value.predicateRegistered&&value.certainty!==null&&
      value.selectedValue!==undefined&&belief?.normalizedValue!==undefined&&belief.frameInstanceId===value.frameInstanceId&&belief.predicateId===value.predicateId&&
      (value.evidenceIds??[]).some(id=>belief.evidenceIds?.includes(id));
  });
  const unresolved=new Set(packet.understanding?.unresolvedFrameIds??[]),choices:InitiativeChoice[]=[];
  for(const frameId of new Set(selected.map(value=>value.frameInstanceId))){
    const entries=selected.filter(value=>value.frameInstanceId===frameId);
    const descriptions=entries.filter(value=>['shared.commitment.action_description','shared.event_occurrence.description'].includes(value.predicateId));
    if(descriptions.length!==1)continue;
    const description=descriptions[0]!,label=textValue(description.selectedValue);if(!label)continue;
    const times=entries.filter(value=>['shared.commitment.due_time','shared.event_occurrence.occurrence_time'].includes(value.predicateId));
    const time=times.length===1?instant(times[0]!.selectedValue,times[0]!.predicateId.endsWith('.due_time')):null;
    choices.push({frameId,label,time,provisional:description.certainty==='PROVISIONAL'||times.some(value=>value.certainty==='PROVISIONAL'),
      scheduled:description.modality==='SCHEDULED'||times.some(value=>value.modality==='SCHEDULED')});
  }
  const resolved=new Set(packet.resolutionAssertions.filter(value=>value.lifecycle==='ACCEPTED'&&value.effectiveAt<=packet.worldTime&&!PARTIAL_OUTCOME_CODES.includes(value.outcomeCode)).map(value=>value.sourceFrameInstanceId));
  return {scheduled:choices.filter(value=>value.time!==null&&!resolved.has(value.frameId)),prerequisites:choices.filter(value=>unresolved.has(value.frameId)),
    incomplete:!packet.understanding?.complete||packet.unknowns.length>0||packet.projectionFragments.some(value=>!value.isComplete)};
}
export function watchRequest(scheduled:string,prerequisite:string,text:string,choices:InitiativeChoices) {
  if(!choices.scheduled.some(value=>value.frameId===scheduled)||!choices.prerequisites.some(value=>value.frameId===prerequisite))return null;
  const parsed=initiativeWatchInputSchema.safeParse({scheduledFrameId:scheduled,prerequisiteFrameId:prerequisite,requestText:text});
  return parsed.success?parsed.data:null;
}
/** Read each endpoint using the same source ceiling as the write proxy. Settings
 * remain available to disable checks even when a memory/source read is refused. */
export async function loadInitiative(call:ApiCall,caller:Caller&{userId:string}):Promise<{kind:'expired'}|{kind:'props';props:InitiativeLoad}> {
  const props:InitiativeLoad={settings:null,watches:[],notices:[],choices:emptyChoices(),error:null};
  const headers=(purpose:string)=>({cookie:caller.cookie,'x-owner-scope-id':caller.ownerScopeId,'x-purpose':purpose,'x-correlation-id':crypto.randomUUID(),
    'x-data-purpose':'PERSONAL_ASSISTANCE','x-maximum-sensitivity':'PRIVATE'});
  const responses=await Promise.allSettled([
    call('/v1/settings/initiative','GET',headers('settings.attention')),
    call('/v1/initiative/watches','GET',headers('memory.read')),
    call('/v1/initiative/notices','GET',headers('memory.read')),
    call('/v1/memory/context','POST',{...headers('memory.read'),'idempotency-key':crypto.randomUUID()},
      {ownerScopeId:caller.ownerScopeId,requestingActorId:caller.userId,purpose:'PERSONAL_ASSISTANCE',maximumSensitivity:'PRIVATE',
        query:'Which scheduled items and prerequisites remain unfinished?',worldTime:'NOW',knowledgeTime:'LATEST',actionRisk:'LOW',
        frameTypeHints:['shared.commitment','shared.event_occurrence'],requiredCertainty:['ACCEPTED','PROVISIONAL','CONTESTED','OWNER_OVERLAY']}),
  ]);
  if(responses.some(value=>value.status==='fulfilled'&&value.value.status===401))return {kind:'expired'};
  const body=(index:number)=>{const response=responses[index];if(response?.status!=='fulfilled'||![200,201].includes(response.value.status))throw new Error('UNAVAILABLE');return response.value.body;};
  try{props.settings=initiativeSettingsSchema.parse(field(body(0),'settings'));}catch{props.error='Daily check settings could not be loaded. Please retry.';}
  try{
    const watches=initiativeWatchSchema.array().parse(field(body(1),'watches'));
    const notices=initiativeNoticeSchema.array().parse(field(body(2),'notices'));
    const packet=contextPacketSchema.parse(body(3));
    if(packet.ownerScopeId!==caller.ownerScopeId||packet.requestingActorId!==caller.userId||packet.purpose!=='PERSONAL_ASSISTANCE')throw new Error('CONTEXT_MISMATCH');
    props.choices=initiativeChoices(packet);props.watches=watches;props.notices=notices;
  }catch{props.error='Watches and notices could not be loaded, or source access was refused. Please retry.';}
  return {kind:'props',props};
}
