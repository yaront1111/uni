import type {GetServerSideProps} from 'next';
import {randomUUID} from 'node:crypto';
import {metricsViewSchema} from '@unai/domain';
import {Metrics} from '../../components/Metrics';
import {apiRequest,identity} from '../../lib/server';
export default Metrics;

/** Reads the metrics the API computes and records; the web process computes
 * nothing and reads no memory itself. */
export const getServerSideProps:GetServerSideProps=async({req,res})=>{
  res.setHeader('Cache-Control','no-store');
  const session=await identity(req);
  if(!session)return {redirect:{destination:req.headers.cookie?'/signin?reason=expired':'/signin',permanent:false}};
  const error='The metrics could not be read. Please reload to retry.';
  try{
    const response=await apiRequest('/v1/ops/metrics','GET',{cookie:req.headers.cookie??'',
      'x-owner-scope-id':session.ownerScopeId,'x-purpose':'ops.metrics.read','x-correlation-id':randomUUID()});
    if(response.status===401)return {redirect:{destination:'/signin?reason=expired',permanent:false}};
    if(response.status!==200)return {props:{view:null,error}};
    return {props:{view:metricsViewSchema.parse(response.body)}};
  }catch{
    return {props:{view:null,error}};
  }
};
