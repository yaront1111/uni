import type {NextApiRequest,NextApiResponse} from 'next';
import {apiRequest,identity} from '../../lib/server';
import {loadChat} from '../../lib/chat';
/** Read projection, authenticated on the server just like /chat SSR. */
export default async function handler(req:NextApiRequest,res:NextApiResponse){
 res.setHeader('Cache-Control','no-store');
 if(req.method!=='GET')return res.status(405).json({code:'METHOD_REFUSED'});
 try{const session=await identity(req);if(!session)return res.status(401).json({code:'SESSION_EXPIRED'});
  const loaded=await loadChat(apiRequest,{cookie:req.headers.cookie??'',ownerScopeId:session.ownerScopeId},typeof req.query.conversation==='string'?req.query.conversation:undefined);
  if(loaded.kind==='expired')return res.status(401).json({code:'SESSION_EXPIRED'});
  return res.status(loaded.props.error?503:200).json(loaded.props);
 }catch{return res.status(503).json({code:'SERVICE_UNAVAILABLE'});}
}
