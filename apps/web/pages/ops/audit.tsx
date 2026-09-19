import type {GetServerSideProps} from 'next';
import {randomUUID} from 'node:crypto';
import {auditLogQuerySchema,auditLogSchema} from '@unai/domain';
import {AuditLog} from '../../components/AuditLog';
import {apiRequest,identity} from '../../lib/server';
export default AuditLog;

/** The Audit log reads `GET /v1/audit-events` under `audit.read`. Only the
 * filters the API defines are forwarded, each validated here first; the page
 * never offers, and the proxy never forwards, a change to an event. */
export const getServerSideProps:GetServerSideProps=async({req,res,query})=>{
  res.setHeader('Cache-Control','no-store');
  const session=await identity(req);
  if(!session)return {redirect:{destination:req.headers.cookie?'/signin?reason=expired':'/signin',permanent:false}};
  const error='The audit log could not be read. Please reload to retry.';
  const requested:Record<string,string>={};
  for(const name of ['objectType','objectId','actorId','purpose','eventKind','from','to','before']){
    const value=query[name];
    if(typeof value==='string'&&value!=='')requested[name]=value;
  }
  const parsed=auditLogQuerySchema.safeParse(requested);
  if(!parsed.success)return {props:{log:null,actorId:session.userId,error:'Those filters could not be read. An object filter needs both its type and its identifier.'}};
  const search=new URLSearchParams(Object.entries(parsed.data).map(([name,value])=>[name,String(value)])).toString();
  try{
    const response=await apiRequest('/v1/audit-events'+(search?'?'+search:''),'GET',{cookie:req.headers.cookie??'',
      'x-owner-scope-id':session.ownerScopeId,'x-purpose':'audit.read','x-correlation-id':randomUUID()});
    if(response.status===401)return {redirect:{destination:'/signin?reason=expired',permanent:false}};
    if(response.status!==200)return {props:{log:null,actorId:session.userId,error}};
    return {props:{log:auditLogSchema.parse(response.body),actorId:session.userId}};
  }catch{
    return {props:{log:null,actorId:session.userId,error}};
  }
};
