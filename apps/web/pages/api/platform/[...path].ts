import type {NextApiRequest,NextApiResponse} from 'next';
import {apiRequest,identity,required} from '../../../lib/server';
/** The export bundle carries raw evidence, so its answer may exceed the default
 * response size; the limit is `EXPORT_RESPONSE_BYTES` below, set in one place. */
export const config={api:{responseLimit:false}};
const EXPORT_RESPONSE_BYTES=64*1024*1024;
export default async function handler(req:NextApiRequest,res:NextApiResponse){
  res.setHeader('Cache-Control','no-store');
  try{
    const session=await identity(req);
    if(!session)return res.status(401).json({code:'SESSION_EXPIRED'});
    const path=Array.isArray(req.query.path)?req.query.path.join('/'):'';
    // The owner's settings are the only PATCH routes (design PATCH /v1/settings/*);
    // every other write is a POST.
    const settings=/^settings\/(attention-budgets|retention|domain-sensitivity)$/.test(path);
    if(req.method!==(settings?'PATCH':'POST'))return res.status(405).json({code:'METHOD_REFUSED'});
    if(req.headers.origin!==new URL(required('NEXTAUTH_URL')).origin)return res.status(403).json({code:'ORIGIN_REFUSED'});
    const purpose=path==='devices'?'device.register':/^devices\/[0-9a-f-]{36}\/revoke$/i.test(path)?'device.remove':path==='sessions/revoke-all'?'auth.sign_out_all':path==='evidence'?'evidence.ingest':
      path==='documents'?'evidence.ingest':
      path==='connectors'?'connector.manage':
      /^connectors\/[0-9a-f-]{36}\/(capabilities|disconnect)$/i.test(path)?'connector.manage':
      /^connectors\/[0-9a-f-]{36}\/sync$/i.test(path)?'connector.sync':
      /^ops\/dead-letter\/[0-9a-f-]{36}\/retry$/i.test(path)?'ops.dead_letter.retry':
      /^memory\/(frame-instances|entities)\/(merge|[0-9a-f-]{36}\/split)$/i.test(path)?'memory.govern':
      /^memory\/inbox\/cards\/[0-9a-f-]{36}\/decide$/i.test(path)?'memory.inbox':
      /^approval-rules\/[0-9a-f-]{36}\/(approve|revoke)$/i.test(path)?'approval.rules':
      // Governed action and the data-control surface (ADR 0030).
      // The attention budget is the memory inbox's setting (ADR 0029), changed here too.
      path==='settings/attention-budgets'?'settings.attention':
      settings||path==='plugin-capabilities'?'permissions.manage':
      path==='drafts'||/^drafts\/[0-9a-f-]{36}\/decision$/i.test(path)?'action.draft':
      path==='actions/execute'?'action.execute':
      path==='recommendations'||/^recommendations\/[0-9a-f-]{36}\/respond$/i.test(path)?'action.recommend':
      path==='export'?'data.export':
      path==='data/deletions'||path==='data/deletions/preview'||path==='data/retention/cleanup'?'data.delete':
      path==='memory/embeddings/regenerate'?'memory.reindex':
      /^memory\/(corrections|state-changes|confirmations|rejections|keep-uncertain|suppressions|archives|deletions)$/.test(path)?'memory.correct':null;
    if(!purpose||req.headers['x-purpose']!==purpose)return res.status(403).json({code:'PURPOSE_REFUSED'});
    const correlation=req.headers['x-correlation-id'],key=req.headers['idempotency-key'];
    if(typeof correlation!=='string'||typeof key!=='string')return res.status(400).json({code:'REQUEST_CONTEXT_REQUIRED'});
    const body=path==='evidence'?{...req.body,ownerScopeId:session.ownerScopeId,actorRef:{type:'USER',id:session.userId},idempotencyKey:key}:req.body;
    // The evidence context is pinned by the proxy, never taken from the browser:
    // a document upload and a connector sync both store evidence, so both carry
    // the same declared data purpose and sensitivity ceiling the evidence route
    // carries.
    const evidencePath=path==='evidence'||path==='documents'||/^connectors\/[0-9a-f-]{36}\/sync$/i.test(path);
    const response=await apiRequest('/v1/'+path,settings?'PATCH':'POST',{cookie:req.headers.cookie??'','x-owner-scope-id':session.ownerScopeId,'x-purpose':purpose,'x-correlation-id':correlation,'idempotency-key':key,
      // A merge or split (whose governed commit reads the evidence behind the
      // claims it reassigns) passes the evidence gate with the same pinned context,
      // and so does an answer to an inbox card, which is stored as evidence.
      ...(evidencePath||purpose==='memory.govern'||purpose==='memory.inbox'?{'x-data-purpose':'PERSONAL_ASSISTANCE','x-maximum-sensitivity':'RESTRICTED'}:{}),
      // A correction control stores the owner's own words as evidence; they are
      // kept PRIVATE, and the browser can raise neither value (ADR 0028 §4).
      ...(purpose==='memory.correct'?{'x-data-purpose':'PERSONAL_ASSISTANCE','x-maximum-sensitivity':'PRIVATE'}:{}),
      // An export is the owner's own, bounded by the owner's widest ceiling.
      ...(purpose==='data.export'?{'x-maximum-sensitivity':'RESTRICTED'}:{})},body,
      purpose==='data.export'?EXPORT_RESPONSE_BYTES:undefined);
    return res.status(response.status).json(response.body);
  }catch{return res.status(503).json({code:'SERVICE_UNAVAILABLE'});}
}
