import type {GetServerSideProps} from 'next';
import {randomUUID} from 'node:crypto';
import {learnedApprovalRulesViewSchema} from '@unai/domain';
import {ApprovalRules} from '../../components/ApprovalRules';
import {apiRequest,identity} from '../../lib/server';
export default ApprovalRules;
const empty=()=>({rules:[],readAt:new Date().toISOString()});
export const getServerSideProps:GetServerSideProps=async({req,res})=>{
  res.setHeader('Cache-Control','no-store');
  const session=await identity(req);
  if(!session)return {redirect:{destination:req.headers.cookie?'/signin?reason=expired':'/signin',permanent:false}};
  try{
    const rules=await apiRequest('/v1/approval-rules','GET',{cookie:req.headers.cookie??'',
      'x-owner-scope-id':session.ownerScopeId,'x-purpose':'approval.rules','x-correlation-id':randomUUID()});
    if(rules.status===401)return {redirect:{destination:'/signin?reason=expired',permanent:false}};
    if(rules.status!==200)return {props:{view:empty(),error:'The learned approval rules could not be read. Please reload to retry.'}};
    return {props:{view:learnedApprovalRulesViewSchema.parse(rules.body)}};
  }catch{
    return {props:{view:empty(),error:'The learned approval rules could not be read. Please reload to retry.'}};
  }
};
