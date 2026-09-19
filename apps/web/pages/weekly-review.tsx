import type {GetServerSideProps} from 'next';
import {randomUUID} from 'node:crypto';
import {weeklyReviewRequestSchema,weeklyReviewSchema} from '@unai/domain';
import {WeeklyReview} from '../components/WeeklyReview';
import {apiRequest,identity} from '../lib/server';
export default WeeklyReview;
/** The Monday of the week before the current one: the last complete week. */
function lastWeek(){
  const now=new Date();
  const monday=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()-((now.getUTCDay()+6)%7)-7));
  return monday.toISOString().slice(0,10);
}
export const getServerSideProps:GetServerSideProps=async({req,res,query})=>{
  res.setHeader('Cache-Control','no-store');
  const session=await identity(req);
  if(!session)return {redirect:{destination:req.headers.cookie?'/signin?reason=expired':'/signin',permanent:false}};
  const requested=weeklyReviewRequestSchema.shape.weekStart.safeParse(query.weekStart);
  const weekStart=requested.success?requested.data:lastWeek();
  try{
    // The review reads memory through the Context Broker, with the pinned evidence
    // context every memory read from this app declares.
    const review=await apiRequest('/v1/weekly-review?weekStart='+weekStart+'&timeZone=UTC','GET',{cookie:req.headers.cookie??'',
      'x-owner-scope-id':session.ownerScopeId,'x-purpose':'review.weekly','x-correlation-id':randomUUID(),
      'x-data-purpose':'PERSONAL_ASSISTANCE','x-maximum-sensitivity':'RESTRICTED'});
    if(review.status===401)return {redirect:{destination:'/signin?reason=expired',permanent:false}};
    if(review.status!==200)return {props:{weekStart,review:null,error:'The weekly review could not be prepared. Please reload to retry.'}};
    return {props:{weekStart,review:weeklyReviewSchema.parse(review.body)}};
  }catch{
    return {props:{weekStart,review:null,error:'The weekly review could not be prepared. Please reload to retry.'}};
  }
};
