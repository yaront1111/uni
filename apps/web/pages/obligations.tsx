import type {GetServerSideProps} from 'next';
import {Obligations} from '../components/Obligations';
import {loadObligations} from '../lib/memory';
import {apiRequest,identity} from '../lib/server';
export default Obligations;

export const getServerSideProps:GetServerSideProps=async({req,res})=>{
  res.setHeader('Cache-Control','no-store');
  const session=await identity(req);
  if(!session)return {redirect:{destination:req.headers.cookie?'/signin?reason=expired':'/signin',permanent:false}};
  const loaded=await loadObligations(apiRequest,{cookie:req.headers.cookie??'',ownerScopeId:session.ownerScopeId});
  if(loaded.kind==='expired')return {redirect:{destination:'/signin?reason=expired',permanent:false}};
  return {props:loaded.props};
};
