import type {GetServerSideProps} from 'next';
import {MemoryInspector} from '../../../../components/MemoryInspector';
import {loadInspector} from '../../../../lib/memory';
import {apiRequest,identity} from '../../../../lib/server';
export default MemoryInspector;

/** Any object a surface showed -- a belief, a claim, a situation, a resolution
 * or the owner's own statement -- opens here (ADR 0027 §1). The loader validates
 * both path segments before they reach a URL. */
export const getServerSideProps:GetServerSideProps=async({req,res,params})=>{
  res.setHeader('Cache-Control','no-store');
  const session=await identity(req);
  if(!session)return {redirect:{destination:req.headers.cookie?'/signin?reason=expired':'/signin',permanent:false}};
  const loaded=await loadInspector(apiRequest,{cookie:req.headers.cookie??'',ownerScopeId:session.ownerScopeId},params?.['type'],params?.['id']);
  if(loaded.kind==='expired')return {redirect:{destination:'/signin?reason=expired',permanent:false}};
  return {props:loaded.props};
};
