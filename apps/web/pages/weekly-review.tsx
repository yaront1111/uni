import type {GetServerSideProps} from 'next';
import {WeeklyReview} from '../components/WeeklyReview';
import {apiRequest,identity} from '../lib/server';
import {loadWeeklyReview,weekStartFrom} from '../lib/review';
export default WeeklyReview;
export const getServerSideProps:GetServerSideProps=async({req,res,query})=>{
  res.setHeader('Cache-Control','no-store');
  const session=await identity(req);
  if(!session)return {redirect:{destination:req.headers.cookie?'/signin?reason=expired':'/signin',permanent:false}};
  const loaded=await loadWeeklyReview((path,method,headers,body)=>apiRequest(path,method,headers,body),
    {cookie:req.headers.cookie??'',ownerScopeId:session.ownerScopeId},weekStartFrom(query.weekStart));
  if(loaded.kind==='expired')return {redirect:{destination:'/signin?reason=expired',permanent:false}};
  return {props:loaded.props};
};
