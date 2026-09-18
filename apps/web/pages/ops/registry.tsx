import type {GetServerSideProps} from 'next';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {registrySnapshotViewSchema,registryLintReportSchema} from '@unai/domain';
import {Registry} from '../../components/Registry';
import {apiRequest,identity} from '../../lib/server';
export default Registry;

/** Reads two things and computes neither: the materialized snapshot over the
 * read-only ops route, and the lint report the registry CLI wrote for CI. The
 * web process runs no registry code and reads no release file (ADR 0014). */
async function lintReport(){
  const path=process.env.UNAI_REGISTRY_LINT_REPORT_FILE;
  if(!path)return null;
  try{
    const parsed=registryLintReportSchema.safeParse(JSON.parse(await readFile(path,'utf8')));
    return parsed.success?parsed.data:null;
  }catch{return null;}
}

export const getServerSideProps:GetServerSideProps=async({req,res})=>{
  res.setHeader('Cache-Control','no-store');
  const session=await identity(req);
  if(!session)return {redirect:{destination:req.headers.cookie?'/signin?reason=expired':'/signin',permanent:false}};
  const lint=await lintReport();
  try{
    const response=await apiRequest('/v1/ops/registry-snapshot','GET',{cookie:req.headers.cookie??'',
      'x-owner-scope-id':session.ownerScopeId,'x-purpose':'ops.registry.read','x-correlation-id':randomUUID()});
    if(response.status===401)return {redirect:{destination:'/signin?reason=expired',permanent:false}};
    if(response.status!==200)return {props:{release:null,contracts:[],lint,error:'The loaded release could not be read. Please reload to retry.'}};
    const view=registrySnapshotViewSchema.parse(response.body);
    return {props:{...view,lint}};
  }catch{
    return {props:{release:null,contracts:[],lint,error:'The loaded release could not be read. Please reload to retry.'}};
  }
};
