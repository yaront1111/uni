import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {OwnerTransaction} from '@unai/postgres';
import {listJobs,listDeadLetterJobs,retryDeadLetterJob} from '@unai/jobs';
import {publicJobSchema,deadLetterViewSchema,retryResultSchema,registrySnapshotViewSchema} from '@unai/domain';

type Work=(request:FastifyRequest,run:(tx:OwnerTransaction,sessionId:string)=>Promise<unknown>)=>Promise<unknown>;
const jobFields=['job_kind','status','attempt_count','max_attempts','lease_owner','lease_expires_at','last_error'];

/** Operations console surface for the durable queue (design screen
 * "Jobs and dead letter"). Read routes never expose a job payload. */
export function registerOpsRoutes(app:FastifyInstance,work:Work){
  app.get('/v1/ops/jobs',async request=>work(request,async tx=>{
    const view=await listJobs(tx,{limit:50});
    await tx.audit({policyDecision:'ALLOW',codeVersion:'0.1.0',result:'SUCCESS',
      objects:view.jobs.slice(0,100).map(job=>({type:'jobs',id:job.jobId,fields:jobFields}))});
    return view;
  }));
  app.get('/v1/ops/dead-letter',async request=>work(request,async tx=>{
    const jobs=await listDeadLetterJobs(tx,{limit:50});
    await tx.audit({policyDecision:'ALLOW',codeVersion:'0.1.0',result:'SUCCESS',
      objects:jobs.slice(0,100).map(job=>({type:'jobs',id:job.jobId,fields:jobFields}))});
    return deadLetterViewSchema.parse({jobs});
  }));
  /** Read-only view of the snapshot the registry CLI already materialized
   * (design screen "Registry release and migration", loaded-release state).
   * It runs no registry logic and accepts no mutation: the deployment holds no
   * registry service, and loading, hashing, linting and publishing a release
   * stay in the CLI (CRT-REG-01-B, ADR 0014). */
  app.get('/v1/ops/registry-snapshot',async request=>work(request,async tx=>{
    // Forced-RLS reference tables with no application grant; the reviewed
    // definer function is the only path and gates on this purpose itself.
    const snapshot=(await tx.query('SELECT unai_private.registry_snapshot() AS snapshot')).rows[0]?.snapshot;
    const view=registrySnapshotViewSchema.parse(snapshot??{release:null,contracts:[]});
    await tx.audit({policyDecision:'ALLOW',codeVersion:'0.1.0',result:'SUCCESS',
      objects:view.release?[{type:'registry_releases',id:view.release.id,
        fields:['semantic_version','git_tag','git_commit','content_hash','lifecycle','released_at']}]:[]});
    return view;
  }));
  app.post<{Params:{id:string}}>('/v1/ops/dead-letter/:id/retry',async(request,reply)=>{
    if(!publicJobSchema.shape.jobId.safeParse(request.params.id).success)return reply.code(400).send({code:'JOB_ID_INVALID'});
    return work(request,async tx=>{
      const job=await retryDeadLetterJob(tx,request.params.id);
      if(!job)return reply.code(404).send({code:'DEAD_LETTER_JOB_NOT_FOUND'});
      await tx.audit({policyDecision:'ALLOW',codeVersion:'0.1.0',result:'SUCCESS',
        objects:[{type:'jobs',id:job.jobId,fields:['status','attempt_count','lease_owner']}]});
      return retryResultSchema.parse({retried:true,job});
    });
  });
}
