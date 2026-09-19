import type {GetServerSideProps} from 'next';
import {MemoryThread} from '../../../components/MemoryThread';
import {loadThread} from '../../../lib/memory';
import {apiRequest,identity} from '../../../lib/server';
export default MemoryThread;

export const getServerSideProps:GetServerSideProps=async({req,res,params})=>{
  res.setHeader('Cache-Control','no-store');
  const session=await identity(req);
  if(!session)return {redirect:{destination:req.headers.cookie?'/signin?reason=expired':'/signin',permanent:false}};
  const loaded=await loadThread(apiRequest,{cookie:req.headers.cookie??'',ownerScopeId:session.ownerScopeId},params?.['id']);
  if(loaded.kind==='expired')return {redirect:{destination:'/signin?reason=expired',permanent:false}};
  return {props:loaded.props};
};
