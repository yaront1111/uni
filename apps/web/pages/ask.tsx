import type {GetServerSideProps} from 'next';
import {Ask} from '../components/Ask';
import {apiRequest,identity} from '../lib/server';
import {loadAsk} from '../lib/screens';
export default Ask;

/** The Ask screen: `?q=` asks `POST /v1/ask` for the owner, then opens each
 * statement's Why? / Sources panel. Without a question it shows the examples. */
export const getServerSideProps:GetServerSideProps=async({req,res,query})=>{
  res.setHeader('Cache-Control','no-store');
  const session=await identity(req);
  if(!session)return {redirect:{destination:req.headers.cookie?'/signin?reason=expired':'/signin',permanent:false}};
  const question=typeof query.q==='string'?query.q:'';
  const loaded=await loadAsk((path,method,headers,body)=>apiRequest(path,method,headers,body),
    {cookie:req.headers.cookie??'',ownerScopeId:session.ownerScopeId},question);
  if(loaded.kind==='expired')return {redirect:{destination:'/signin?reason=expired',permanent:false}};
  return {props:loaded.props};
};
