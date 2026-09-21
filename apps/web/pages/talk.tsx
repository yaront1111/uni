import type {GetServerSideProps} from 'next';
import {randomUUID} from 'node:crypto';
import {voiceSettingsSchema} from '@unai/domain';
import {Talk} from '../components/Talk';
import {apiRequest,identity} from '../lib/server';
import {loadChat} from '../lib/chat';
export default Talk;
export const getServerSideProps:GetServerSideProps=async({req,res,query})=>{
 res.setHeader('Cache-Control','no-store');const session=await identity(req);
 if(!session)return {redirect:{destination:req.headers.cookie?'/signin?reason=expired':'/signin',permanent:false}};
 const caller={cookie:req.headers.cookie??'',ownerScopeId:session.ownerScopeId};
 const loaded=await loadChat(apiRequest,caller,typeof query.conversation==='string'?query.conversation:undefined);
 if(loaded.kind==='expired')return {redirect:{destination:'/signin?reason=expired',permanent:false}};
 let voice=null;
 try{const response=await apiRequest('/v1/settings/voice','GET',{cookie:caller.cookie,'x-owner-scope-id':caller.ownerScopeId,'x-purpose':'settings.voice','x-correlation-id':randomUUID()});
  if(response.status===401)return {redirect:{destination:'/signin?reason=expired',permanent:false}};
  if(response.status===200)voice=voiceSettingsSchema.parse(response.body);
 }catch{}
 return {props:{...loaded.props,voice}};
};
