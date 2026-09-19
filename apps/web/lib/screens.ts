import {randomBytes,randomUUID} from 'node:crypto';
import {askAnswerSchema,todayBriefingSchema,whySourcesSchema,type AskAnswer,type WhyRef,type WhySources} from '@unai/domain';

/**
 * The reads behind the Today and Ask screens, as plain functions over an API
 * call (ADR 0026). `getServerSideProps` passes `apiRequest` from `lib/server.ts`;
 * the end-to-end test passes the same API over an in-process transport. Nothing
 * here touches a database or knows the transport: every read is an HTTPS call to
 * `@unai/api`, and every body is parsed through its `@unai/domain` schema.
 *
 * The declarations are pinned here, as the evidence reads pin theirs: the owner
 * reads their own memory for personal assistance, up to RESTRICTED, and the API
 * applies both to every row it reads.
 */
export type ApiCall=(path:string,method:'GET'|'POST',headers:Record<string,string>,body?:unknown)=>Promise<{status:number;body:unknown}>;
export interface Caller{cookie:string;ownerScopeId:string}
export const DATA_PURPOSE='PERSONAL_ASSISTANCE';
export const MAXIMUM_SENSITIVITY='RESTRICTED';
/** Bounds on how many panels one screen reads, so a long answer cannot fan out. */
export const MAX_PANELS=12;

function headers(caller:Caller,purpose:string):Record<string,string>{
  return {cookie:caller.cookie,'x-owner-scope-id':caller.ownerScopeId,'x-purpose':purpose,'x-correlation-id':randomUUID(),
    'x-data-purpose':DATA_PURPOSE,'x-maximum-sensitivity':MAXIMUM_SENSITIVITY};
}

/** Open one Why? / Sources panel. Null when it cannot be read; the screen says so. */
export async function loadWhy(call:ApiCall,caller:Caller,ref:WhyRef):Promise<WhySources|null|'expired'>{
  try{
    const response=await call('/v1/memory/why/'+ref.objectType+'/'+ref.objectId,'GET',headers(caller,'memory.inspect'));
    if(response.status===401)return 'expired';
    if(response.status!==200)return null;
    const parsed=whySourcesSchema.safeParse(response.body);
    return parsed.success?parsed.data:null;
  }catch{return null;}
}

type Loaded<T>={kind:'expired'}|{kind:'props';props:T};

export interface TodayLoad{state:'loading'|'ready'|'error';briefing:ReturnType<typeof todayBriefingSchema.parse>|null;
  why:Record<string,WhySources|null>;detectTimeZone:boolean;error:string|null}

const TODAY_UNAVAILABLE='Today\'s briefing could not be loaded. Please reload to retry.';

/** GET /v1/today in the owner's timezone, then the Why? / Sources panel of every
 * item shown. With no timezone known anywhere the screen asks the browser. */
export async function loadToday(call:ApiCall,caller:Caller,timeZone:string|null):Promise<Loaded<TodayLoad>>{
  const empty={briefing:null,why:{},detectTimeZone:false,error:null};
  let response;
  try{response=await call('/v1/today'+(timeZone?'?timeZone='+encodeURIComponent(timeZone):''),'GET',headers(caller,'memory.read'));}
  catch{return {kind:'props',props:{...empty,state:'error',error:TODAY_UNAVAILABLE}};}
  if(response.status===401)return {kind:'expired'};
  const code=(response.body as {code?:unknown}|null)?.code;
  if(response.status===400&&(code==='TODAY_TIME_ZONE_REQUIRED'||code==='TODAY_TIME_ZONE_INVALID')){
    return {kind:'props',props:{...empty,state:'loading',detectTimeZone:true}};
  }
  if(response.status!==200)return {kind:'props',props:{...empty,state:'error',error:TODAY_UNAVAILABLE}};
  const briefing=todayBriefingSchema.parse(response.body);
  const why:Record<string,WhySources|null>={};
  for(const item of briefing.sections.flatMap(section=>section.items).slice(0,MAX_PANELS)){
    const ref=item.sourceRefs[0];
    if(!ref){why[item.briefingItemId]=null;continue;}
    const panel=await loadWhy(call,caller,ref);
    if(panel==='expired')return {kind:'expired'};
    why[item.briefingItemId]=panel;
  }
  return {kind:'props',props:{...empty,state:'ready',briefing,why}};
}

export interface AskLoad{state:'empty'|'answered'|'refused'|'error';question:string;answer:AskAnswer|null;
  why:Record<string,WhySources|null>;refusal:string|null;error:string|null}

const EXPLAINABLE:Record<string,WhyRef['objectType']>={propositions:'propositions',proposition:'propositions',
  owner_overlay_deltas:'owner_overlay_deltas',resolution_assertions:'resolution_assertions'};
/** The object a statement's Why? / Sources opens: a belief first, then the owner's
 * own statement, then the resolution that settled an outcome. */
export function whyRefOf(statement:AskAnswer['statements'][number]):WhyRef|null{
  for(const type of ['propositions','proposition','owner_overlay_deltas','resolution_assertions']){
    const ref=statement.objectRefs.find(entry=>entry.objectType===type);
    if(ref)return {objectType:EXPLAINABLE[type]!,objectId:ref.objectId};
  }
  return null;
}

const REFUSALS=new Set(['ASK_REQUEST_INCOMPLETE','ASK_REQUEST_INVALID','CONTEXT_READ_DENIED','CONTEXT_REQUEST_INVALID']);

/** POST /v1/ask, which reads through the Context Broker, then each statement's
 * Why? / Sources panel. */
export async function loadAsk(call:ApiCall,caller:Caller,question:string):Promise<Loaded<AskLoad>>{
  const base={question,answer:null,why:{},refusal:null,error:null};
  const asked=question.trim().slice(0,2000);
  if(asked==='')return {kind:'props',props:{...base,state:'empty'}};
  let response;
  try{
    response=await call('/v1/ask','POST',{...headers(caller,'memory.read'),'idempotency-key':randomBytes(16).toString('hex')},{
      ownerScopeId:caller.ownerScopeId,question:asked,purpose:DATA_PURPOSE,worldTime:'NOW',knowledgeTime:'LATEST',
      maximumSensitivity:MAXIMUM_SENSITIVITY});
  }catch{return {kind:'props',props:{...base,state:'error',error:'The question could not be answered. Please retry.'}};}
  if(response.status===401)return {kind:'expired'};
  const code=(response.body as {code?:unknown}|null)?.code;
  if((response.status===400||response.status===403)&&typeof code==='string'&&REFUSALS.has(code)){
    return {kind:'props',props:{...base,state:'refused',refusal:code}};
  }
  if(response.status!==200)return {kind:'props',props:{...base,state:'error',error:'The question could not be answered. Please retry.'}};
  const answer=askAnswerSchema.parse(response.body);
  const why:Record<string,WhySources|null>={};
  for(const statement of answer.statements){
    if(Object.keys(why).length>=MAX_PANELS)break;
    const ref=whyRefOf(statement);
    if(!ref)continue;
    const panel=await loadWhy(call,caller,ref);
    if(panel==='expired')return {kind:'expired'};
    why[statement.statementId]=panel;
  }
  return {kind:'props',props:{...base,state:'answered',answer,why}};
}

/** The timezone cookie the Today screen sets from the browser. */
export function cookieValue(cookie:string|undefined,name:string):string|null{
  for(const part of (cookie??'').split(';')){
    const [key,...rest]=part.trim().split('=');
    if(key===name){try{return decodeURIComponent(rest.join('='))||null;}catch{return null;}}
  }
  return null;
}
