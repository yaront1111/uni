import type {NextApiRequest,NextApiResponse} from 'next';
import {apiRequest,identity,required} from '../../../lib/server';
export default async function handler(req:NextApiRequest,res:NextApiResponse){
  res.setHeader('Cache-Control','no-store');
  try{
    const session=await identity(req);
    if(!session)return res.status(401).json({code:'SESSION_EXPIRED'});
    if(req.method!=='POST')return res.status(405).json({code:'METHOD_REFUSED'});
    if(req.headers.origin!==new URL(required('NEXTAUTH_URL')).origin)return res.status(403).json({code:'ORIGIN_REFUSED'});
    const path=Array.isArray(req.query.path)?req.query.path.join('/'):'';
    const purpose=path==='devices'?'device.register':/^devices\/[0-9a-f-]{36}\/revoke$/i.test(path)?'device.remove':path==='sessions/revoke-all'?'auth.sign_out_all':path==='evidence'?'evidence.ingest':null;
    if(!purpose||req.headers['x-purpose']!==purpose)return res.status(403).json({code:'PURPOSE_REFUSED'});
    const correlation=req.headers['x-correlation-id'],key=req.headers['idempotency-key'];
    if(typeof correlation!=='string'||typeof key!=='string')return res.status(400).json({code:'REQUEST_CONTEXT_REQUIRED'});
    const body=path==='evidence'?{...req.body,ownerScopeId:session.ownerScopeId,actorRef:{type:'USER',id:session.userId},idempotencyKey:key}:req.body;
    const response=await apiRequest('/v1/'+path,'POST',{cookie:req.headers.cookie??'','x-owner-scope-id':session.ownerScopeId,'x-purpose':purpose,'x-correlation-id':correlation,'idempotency-key':key,
      ...(path==='evidence'?{'x-data-purpose':'PERSONAL_ASSISTANCE','x-maximum-sensitivity':'RESTRICTED'}:{})},body);
    return res.status(response.status).json(response.body);
  }catch{return res.status(503).json({code:'SERVICE_UNAVAILABLE'});}
}
