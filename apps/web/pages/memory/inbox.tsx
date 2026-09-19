import type {GetServerSideProps} from 'next';
import {randomUUID} from 'node:crypto';
import {DEFAULT_ATTENTION_BUDGET,memoryInboxViewSchema,type MemoryInboxView} from '@unai/domain';
import {MemoryInbox} from '../../components/MemoryInbox';
import {apiRequest,identity} from '../../lib/server';
export default MemoryInbox;
const empty=():MemoryInboxView=>({ownerLocalDate:new Date().toISOString().slice(0,10),timeZone:'UTC',
  budget:{...DEFAULT_ATTENTION_BUDGET,isDefault:true,updatedAt:null},remainingToday:0,remainingByScope:[],cards:[],deferredCount:0,
  withheld:[],resolvedToday:[],contextPacketId:null,readAt:new Date().toISOString()});
export const getServerSideProps:GetServerSideProps=async({req,res})=>{
  res.setHeader('Cache-Control','no-store');
  const session=await identity(req);
  if(!session)return {redirect:{destination:req.headers.cookie?'/signin?reason=expired':'/signin',permanent:false}};
  try{
    // The inbox reads memory through the Context Broker, so it declares the same
    // pinned evidence context every other memory read from this app declares.
    const inbox=await apiRequest('/v1/memory/inbox?timeZone=UTC','GET',{cookie:req.headers.cookie??'',
      'x-owner-scope-id':session.ownerScopeId,'x-purpose':'memory.inbox','x-correlation-id':randomUUID(),
      'x-data-purpose':'PERSONAL_ASSISTANCE','x-maximum-sensitivity':'RESTRICTED'});
    if(inbox.status===401)return {redirect:{destination:'/signin?reason=expired',permanent:false}};
    if(inbox.status!==200)return {props:{view:empty(),error:'The memory inbox could not be read. Please reload to retry.'}};
    return {props:{view:memoryInboxViewSchema.parse(inbox.body)}};
  }catch{
    return {props:{view:empty(),error:'The memory inbox could not be read. Please reload to retry.'}};
  }
};
