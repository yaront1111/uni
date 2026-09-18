import type {GetServerSideProps} from 'next';
import {randomUUID} from 'node:crypto';
import {mergeSplitReviewSchema} from '@unai/domain';
import {MergeSplit} from '../../components/MergeSplit';
import {apiRequest,identity} from '../../lib/server';
export default MergeSplit;
const empty=()=>({frameCandidates:[],entityCandidates:[],recentLineage:[],readAt:new Date().toISOString()});
export const getServerSideProps:GetServerSideProps=async({req,res})=>{
  res.setHeader('Cache-Control','no-store');
  const session=await identity(req);
  if(!session)return {redirect:{destination:req.headers.cookie?'/signin?reason=expired':'/signin',permanent:false}};
  try{
    const review=await apiRequest('/v1/memory/merge-split/review','GET',{cookie:req.headers.cookie??'',
      'x-owner-scope-id':session.ownerScopeId,'x-purpose':'memory.inspect','x-correlation-id':randomUUID()});
    if(review.status===401)return {redirect:{destination:'/signin?reason=expired',permanent:false}};
    if(review.status!==200)return {props:{review:empty(),error:'The merge and split review could not be read. Please reload to retry.'}};
    return {props:{review:mergeSplitReviewSchema.parse(review.body)}};
  }catch{
    return {props:{review:empty(),error:'The merge and split review could not be read. Please reload to retry.'}};
  }
};
