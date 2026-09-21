import type {GetServerSideProps} from 'next';
import {AdminMemory} from '../../components/AdminMemory';
import {loadAdminMemory} from '../../lib/admin-memory';
import {identity,apiRequest} from '../../lib/server';
export default AdminMemory;
export const getServerSideProps:GetServerSideProps=async({req,res,query})=>{
  res.setHeader('Cache-Control','no-store');
  const session=await identity(req);
  if(!session)return {redirect:{destination:req.headers.cookie?'/signin?reason=expired':'/signin',permanent:false}};
  const loaded=await loadAdminMemory(apiRequest,{cookie:req.headers.cookie??'',ownerScopeId:session.ownerScopeId,actorId:session.userId},query);
  if(loaded.kind==='expired')return {redirect:{destination:'/signin?reason=expired',permanent:false}};
  return {props:loaded.props};
};
