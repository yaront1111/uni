import type {GetServerSideProps} from 'next';
import {randomUUID} from 'node:crypto';
import {decisionDetailSchema,decisionProjectionRowSchema,decisionProjectionViewSchema,goalsViewSchema} from '@unai/domain';
import {Decisions} from '../components/Decisions';
import {apiRequest,identity} from '../lib/server';
export default Decisions;
const UNAVAILABLE='Your decisions could not be read. Please reload to retry.';
export const getServerSideProps:GetServerSideProps=async({req,res,query})=>{
  res.setHeader('Cache-Control','no-store');
  const session=await identity(req);
  if(!session)return {redirect:{destination:req.headers.cookie?'/signin?reason=expired':'/signin',permanent:false}};
  const expired={redirect:{destination:'/signin?reason=expired',permanent:false}};
  const today=new Date().toISOString().slice(0,10);
  const base=(purpose:string)=>({cookie:req.headers.cookie??'','x-owner-scope-id':session.ownerScopeId,'x-purpose':purpose,
    'x-correlation-id':randomUUID()});
  const requested=decisionProjectionRowSchema.shape.decisionFrameInstanceId.safeParse(query.id);
  try{
    if(requested.success){
      // The rationale is read through the Context Broker and its sources are
      // inspected, both under the pinned evidence context of this app.
      const detail=await apiRequest('/v1/decisions/'+requested.data,'GET',{...base('decisions.read'),
        'x-data-purpose':'PERSONAL_ASSISTANCE','x-maximum-sensitivity':'RESTRICTED'});
      if(detail.status===401)return expired;
      if(detail.status===404)return {props:{view:null,detail:null,goals:[],today,error:'That decision was not found.'}};
      if(detail.status!==200)return {props:{view:null,detail:null,goals:[],today,error:UNAVAILABLE}};
      return {props:{view:null,detail:decisionDetailSchema.parse(detail.body),goals:[],today}};
    }
    const [view,goals]=await Promise.all([apiRequest('/v1/projections/decisions','GET',base('projection.read')),
      apiRequest('/v1/goals','GET',base('goals.read'))]);
    if(view.status===401||goals.status===401)return expired;
    if(view.status!==200)return {props:{view:null,detail:null,goals:[],today,error:UNAVAILABLE}};
    const goalList=goals.status===200?goalsViewSchema.parse(goals.body).goals.filter(goal=>goal.retiredAt===null)
      .map(goal=>({goalId:goal.goalId,title:goal.title})):[];
    return {props:{view:decisionProjectionViewSchema.parse(view.body),detail:null,goals:goalList,today}};
  }catch{
    return {props:{view:null,detail:null,goals:[],today,error:UNAVAILABLE}};
  }
};
