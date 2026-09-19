import type {GetServerSideProps} from 'next';
import {randomUUID} from 'node:crypto';
import {publicAnswerManifestSchema} from '@unai/domain';
import {AnswerProvenance} from '../../components/AnswerProvenance';
import {apiRequest,identity} from '../../lib/server';
export default AnswerProvenance;

const UNREADABLE='This answer\'s record could not be read. Please reload to retry.';

/** One answer's manifest, read under `memory.inspect`. The page computes nothing:
 * the sets, versions and reconsideration changes are the API's (ADR 0024). */
export const getServerSideProps:GetServerSideProps=async({req,res,params})=>{
  res.setHeader('Cache-Control','no-store');
  const session=await identity(req);
  if(!session)return {redirect:{destination:req.headers.cookie?'/signin?reason=expired':'/signin',permanent:false}};
  const id=publicAnswerManifestSchema.shape.answerManifestId.safeParse(params?.['id']);
  if(!id.success)return {props:{manifest:null,error:'That is not an answer this memory recorded.'}};
  try{
    const response=await apiRequest('/v1/answers/'+id.data+'/manifest','GET',{cookie:req.headers.cookie??'',
      'x-owner-scope-id':session.ownerScopeId,'x-purpose':'memory.inspect','x-correlation-id':randomUUID()});
    if(response.status===401)return {redirect:{destination:'/signin?reason=expired',permanent:false}};
    if(response.status===404)return {props:{manifest:null,error:'That is not an answer this memory recorded.'}};
    if(response.status!==200)return {props:{manifest:null,error:UNREADABLE}};
    return {props:{manifest:publicAnswerManifestSchema.parse(response.body)}};
  }catch{
    return {props:{manifest:null,error:UNREADABLE}};
  }
};
