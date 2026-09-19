import type {GetServerSideProps} from 'next';
import {randomUUID} from 'node:crypto';
import {goalsViewSchema} from '@unai/domain';
import {Goals} from '../components/Goals';
import {apiRequest,identity} from '../lib/server';
export default Goals;
const empty=()=>({goals:[],readAt:new Date().toISOString()});
export const getServerSideProps:GetServerSideProps=async({req,res})=>{
  res.setHeader('Cache-Control','no-store');
  const session=await identity(req);
  if(!session)return {redirect:{destination:req.headers.cookie?'/signin?reason=expired':'/signin',permanent:false}};
  try{
    const goals=await apiRequest('/v1/goals','GET',{cookie:req.headers.cookie??'','x-owner-scope-id':session.ownerScopeId,
      'x-purpose':'goals.read','x-correlation-id':randomUUID()});
    if(goals.status===401)return {redirect:{destination:'/signin?reason=expired',permanent:false}};
    if(goals.status!==200)return {props:{view:empty(),error:'Your goals could not be read. Please reload to retry.'}};
    return {props:{view:goalsViewSchema.parse(goals.body)}};
  }catch{
    return {props:{view:empty(),error:'Your goals could not be read. Please reload to retry.'}};
  }
};
