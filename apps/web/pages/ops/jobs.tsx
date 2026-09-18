import type {GetServerSideProps} from 'next';
import {randomUUID} from 'node:crypto';
import {jobsViewSchema,publicJobSchema,deadLetterViewSchema} from '@unai/domain';
import {Jobs} from '../../components/Jobs';
import {apiRequest,identity} from '../../lib/server';
export default Jobs;
const empty={PENDING:0,RUNNING:0,SUCCEEDED:0,FAILED:0,DEAD_LETTER:0,expiredLeases:0};
export const getServerSideProps:GetServerSideProps=async({req,res,query})=>{
  res.setHeader('Cache-Control','no-store');
  const session=await identity(req);
  if(!session)return {redirect:{destination:req.headers.cookie?'/signin?reason=expired':'/signin',permanent:false}};
  const read=(path:string,purpose:string)=>apiRequest(path,'GET',{cookie:req.headers.cookie??'',
    'x-owner-scope-id':session.ownerScopeId,'x-purpose':purpose,'x-correlation-id':randomUUID()});
  try{
    const [jobs,deadLetter]=await Promise.all([read('/v1/ops/jobs','ops.jobs.read'),read('/v1/ops/dead-letter','ops.dead_letter.read')]);
    if(jobs.status===401||deadLetter.status===401)return {redirect:{destination:'/signin?reason=expired',permanent:false}};
    if(jobs.status!==200||deadLetter.status!==200){
      return {props:{queueDepth:empty,jobs:[],deadLetter:[],error:'The job queue could not be read. Please reload to retry.'}};
    }
    const view=jobsViewSchema.parse(jobs.body);
    const retried=typeof query.retried==='string'&&publicJobSchema.shape.jobId.safeParse(query.retried).success?query.retried:null;
    return {props:{...view,deadLetter:deadLetterViewSchema.parse(deadLetter.body).jobs,retriedJobId:retried}};
  }catch{
    return {props:{queueDepth:empty,jobs:[],deadLetter:[],error:'The job queue could not be read. Please reload to retry.'}};
  }
};
