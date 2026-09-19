import type {GetServerSideProps} from 'next';
import {Initiative} from '../components/Initiative';
import {loadInitiative} from '../lib/initiative';
import {apiRequest,identity} from '../lib/server';
export default Initiative;
export const getServerSideProps:GetServerSideProps=async({req,res,query})=>{
  res.setHeader('Cache-Control','no-store');
  const session=await identity(req);
  if(!session)return {redirect:{destination:req.headers.cookie?'/signin?reason=expired':'/signin',permanent:false}};
  const loaded=await loadInitiative(apiRequest,{cookie:req.headers.cookie??'',ownerScopeId:session.ownerScopeId,userId:session.userId});
  if(loaded.kind==='expired')return {redirect:{destination:'/signin?reason=expired',permanent:false}};
  return {props:{...loaded.props,saved:query.saved==='1'}};
};
