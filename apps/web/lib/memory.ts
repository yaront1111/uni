import {randomUUID} from 'node:crypto';
import {commitmentsProjectionViewSchema,inspectableObjectTypeSchema,memoryInspectorSchema,memoryThreadViewSchema,
  obligationsProjectionViewSchema,relatedFramesSchema,
  type CommitmentsProjectionView,type InspectableObjectType,type MemoryInspector,type MemoryThreadView,
  type ObligationsProjectionView,type RelatedFrame} from '@unai/domain';

/**
 * The reads behind the Commitments, Obligations, Memory inspector, Memory thread
 * and Correction controls screens (ADR 0027 §5), as plain functions over an API
 * call. `getServerSideProps` passes `apiRequest` from `lib/server.ts`; the
 * end-to-end tests pass the real platform API over an in-process transport.
 * Nothing here touches a database: every read is a call to `@unai/api`, and
 * every body is parsed through its `@unai/domain` schema.
 *
 * The declarations are pinned here, as the evidence reads pin theirs: the owner
 * reads their own memory for personal assistance, up to RESTRICTED.
 */
export type ApiCall=(path:string,method:'GET'|'POST',headers:Record<string,string>,body?:unknown)=>Promise<{status:number;body:unknown}>;
export interface Caller{cookie:string;ownerScopeId:string}
export const DATA_PURPOSE='PERSONAL_ASSISTANCE';
export const MAXIMUM_SENSITIVITY='RESTRICTED';
/** The related-context route answers at most this many frames per call. */
const RELATED_BATCH=100;

type Loaded<T>={kind:'expired'}|{kind:'props';props:T};

function headers(caller:Caller,purpose:string):Record<string,string>{
  return {cookie:caller.cookie,'x-owner-scope-id':caller.ownerScopeId,'x-purpose':purpose,'x-correlation-id':randomUUID(),
    'x-data-purpose':DATA_PURPOSE,'x-maximum-sensitivity':MAXIMUM_SENSITIVITY};
}
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid=(value:unknown):value is string=>typeof value==='string'&&UUID.test(value);

/** The people, sources, resolutions and threads of each row, keyed by frame
 * instance. `null` when the related read failed: the screen still shows the
 * projection and says the details could not be read. */
async function related(call:ApiCall,caller:Caller,ids:string[]):Promise<Record<string,RelatedFrame>|null|'expired'>{
  const found:Record<string,RelatedFrame>={};
  for(let start=0;start<ids.length;start+=RELATED_BATCH){
    const batch=ids.slice(start,start+RELATED_BATCH);
    const response=await call('/v1/memory/frames/related?ids='+batch.join(','),'GET',headers(caller,'memory.inspect'));
    if(response.status===401)return 'expired';
    if(response.status!==200)return null;
    for(const frame of relatedFramesSchema.parse(response.body).frames)found[frame.frameInstanceId]=frame;
  }
  return found;
}

export interface CommitmentFilters{person:string|null;thread:string|null;dueBefore:string|null;dueAfter:string|null;includeResolved:boolean}
export const NO_FILTERS:CommitmentFilters={person:null,thread:null,dueBefore:null,dueAfter:null,includeResolved:true};

/** Filters from a query string, each validated before it reaches a URL. A value
 * that does not parse is dropped rather than widened into something else. */
export function commitmentFilters(query:Record<string,string|string[]|undefined>):CommitmentFilters{
  const one=(name:string)=>{const value=query[name];return typeof value==='string'&&value!==''?value:null;};
  const date=(name:string)=>{const value=one(name);return value&&!Number.isNaN(new Date(value).getTime())?new Date(value).toISOString():null;};
  // The form sends a hidden false before the checkbox, so a checked box arrives
  // as both values and an unchecked one as false alone.
  const resolved=(value:string|string[]|undefined)=>Array.isArray(value)?value.includes('true'):value!=='false';
  const person=one('person'),thread=one('thread');
  return {person:isUuid(person)?person:null,thread:isUuid(thread)?thread:null,dueBefore:date('dueBefore'),dueAfter:date('dueAfter'),
    includeResolved:resolved(query['includeResolved'])};
}

export interface CommitmentsLoad{state:'ready'|'error';view:CommitmentsProjectionView|null;
  related:Record<string,RelatedFrame>|null;filters:CommitmentFilters;error:string|null}
const COMMITMENTS_UNAVAILABLE='Your commitments could not be read. Please reload to retry.';

/** GET /v1/projections/commitments with the person and due-window filters the
 * route offers, then the related context of every row. The thread filter is
 * applied here over the threads that read returned (ADR 0027 §5). */
export async function loadCommitments(call:ApiCall,caller:Caller,filters:CommitmentFilters):Promise<Loaded<CommitmentsLoad>>{
  const base={view:null,related:null,filters,error:null};
  const query=new URLSearchParams();
  if(filters.person)query.set('person',filters.person);
  if(filters.dueBefore)query.set('dueBefore',filters.dueBefore);
  if(filters.dueAfter)query.set('dueAfter',filters.dueAfter);
  query.set('includeResolved',String(filters.includeResolved));
  try{
    const response=await call('/v1/projections/commitments?'+query.toString(),'GET',headers(caller,'projection.read'));
    if(response.status===401)return {kind:'expired'};
    if(response.status!==200)return {kind:'props',props:{...base,state:'error',error:COMMITMENTS_UNAVAILABLE}};
    const view=commitmentsProjectionViewSchema.parse(response.body);
    const details=await related(call,caller,view.rows.map(row=>row.commitmentFrameInstanceId));
    if(details==='expired')return {kind:'expired'};
    const rows=filters.thread===null?view.rows:view.rows.filter(row=>
      details?.[row.commitmentFrameInstanceId]?.threads.some(thread=>thread.memoryThreadId===filters.thread)??false);
    return {kind:'props',props:{...base,state:'ready',view:{...view,rows},related:details}};
  }catch{return {kind:'props',props:{...base,state:'error',error:COMMITMENTS_UNAVAILABLE}};}
}

export interface ObligationsLoad{state:'ready'|'error';view:ObligationsProjectionView|null;
  related:Record<string,RelatedFrame>|null;error:string|null}
const OBLIGATIONS_UNAVAILABLE='Your obligations could not be read. Please reload to retry.';

export async function loadObligations(call:ApiCall,caller:Caller):Promise<Loaded<ObligationsLoad>>{
  const base={view:null,related:null,error:null};
  try{
    const response=await call('/v1/projections/obligations?includeResolved=true','GET',headers(caller,'projection.read'));
    if(response.status===401)return {kind:'expired'};
    if(response.status!==200)return {kind:'props',props:{...base,state:'error',error:OBLIGATIONS_UNAVAILABLE}};
    const view=obligationsProjectionViewSchema.parse(response.body);
    const details=await related(call,caller,view.rows.map(row=>row.obligationFrameInstanceId));
    if(details==='expired')return {kind:'expired'};
    return {kind:'props',props:{...base,state:'ready',view,related:details}};
  }catch{return {kind:'props',props:{...base,state:'error',error:OBLIGATIONS_UNAVAILABLE}};}
}

export interface InspectorLoad{state:'ready'|'not-found'|'error';inspector:MemoryInspector|null;error:string|null}
const INSPECTOR_UNAVAILABLE='This memory could not be read. Please reload to retry.';
const NOT_INSPECTABLE='There is no belief to inspect here. It may be a statement no belief has taken up yet.';

/** GET /v1/memory/inspector/{objectType}/{id}: the Memory inspector and the
 * Correction controls screen both read it. */
export async function loadInspector(call:ApiCall,caller:Caller,objectType:unknown,id:unknown):Promise<Loaded<InspectorLoad>>{
  const type=inspectableObjectTypeSchema.safeParse(objectType);
  if(!type.success||!isUuid(id))return {kind:'props',props:{state:'not-found',inspector:null,error:NOT_INSPECTABLE}};
  try{
    const response=await call('/v1/memory/inspector/'+type.data+'/'+id,'GET',headers(caller,'memory.inspect'));
    if(response.status===401)return {kind:'expired'};
    if(response.status===404)return {kind:'props',props:{state:'not-found',inspector:null,error:NOT_INSPECTABLE}};
    if(response.status!==200)return {kind:'props',props:{state:'error',inspector:null,error:INSPECTOR_UNAVAILABLE}};
    return {kind:'props',props:{state:'ready',inspector:memoryInspectorSchema.parse(response.body),error:null}};
  }catch{return {kind:'props',props:{state:'error',inspector:null,error:INSPECTOR_UNAVAILABLE}};}
}

export interface ThreadLoad{state:'ready'|'not-found'|'error';thread:MemoryThreadView|null;error:string|null}
const THREAD_UNAVAILABLE='This thread could not be read. Please reload to retry.';

export async function loadThread(call:ApiCall,caller:Caller,id:unknown):Promise<Loaded<ThreadLoad>>{
  if(!isUuid(id))return {kind:'props',props:{state:'not-found',thread:null,error:'That is not a thread this memory holds.'}};
  try{
    const response=await call('/v1/memory/threads/'+id,'GET',headers(caller,'memory.inspect'));
    if(response.status===401)return {kind:'expired'};
    if(response.status===404)return {kind:'props',props:{state:'not-found',thread:null,error:'That is not a thread this memory holds.'}};
    if(response.status!==200)return {kind:'props',props:{state:'error',thread:null,error:THREAD_UNAVAILABLE}};
    return {kind:'props',props:{state:'ready',thread:memoryThreadViewSchema.parse(response.body),error:null}};
  }catch{return {kind:'props',props:{state:'error',thread:null,error:THREAD_UNAVAILABLE}};}
}

export type {InspectableObjectType};
