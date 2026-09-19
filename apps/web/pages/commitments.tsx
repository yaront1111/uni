import type {GetServerSideProps} from 'next';
import {Commitments} from '../components/Commitments';
import {commitmentFilters,loadCommitments} from '../lib/memory';
import {apiRequest,identity} from '../lib/server';
export default Commitments;

/** The Commitments screen: the typed projection under `projection.read`, then
 * each row's people, sources and resolution evidence under `memory.inspect`
 * (ADR 0027 §1). */
export const getServerSideProps:GetServerSideProps=async({req,res,query})=>{
  res.setHeader('Cache-Control','no-store');
  const session=await identity(req);
  if(!session)return {redirect:{destination:req.headers.cookie?'/signin?reason=expired':'/signin',permanent:false}};
  const loaded=await loadCommitments(apiRequest,{cookie:req.headers.cookie??'',ownerScopeId:session.ownerScopeId},commitmentFilters(query));
  if(loaded.kind==='expired')return {redirect:{destination:'/signin?reason=expired',permanent:false}};
  return {props:loaded.props};
};
