import type {Pool} from 'pg';
import {metrics, trace} from '@opentelemetry/api';
import {withOwnerTransaction, type OwnerTransaction} from '@unai/postgres';
import {enqueueJobSchema, publicJobSchema, claimedJobSchema, queueDepthSchema, jobsViewSchema,
  workerIdSchema, jobErrorCodeSchema, jobKindSchema, type EnqueueJob, type PublicJob, type ClaimedJob,
  type JobsView, type RequestContext} from '@unai/domain';
import {uuidV7} from '../../../src/kernel/identities.js';

/** Queue purposes. A session driving the queue carries exactly one of them and
 * row-level security refuses the table under any other purpose. */
export const JOB_PURPOSES=Object.freeze({
  enqueue:'jobs.enqueue',work:'jobs.work',readJobs:'ops.jobs.read',
  readDeadLetter:'ops.dead_letter.read',retryDeadLetter:'ops.dead_letter.retry',
});

const attempts=metrics.getMeter('unai.jobs','0.1.0').createCounter('unai.jobs.attempts');
const tracer=trace.getTracer('unai.jobs','0.1.0');
const COLUMNS='id,owner_scope_id,job_kind,status,attempt_count,max_attempts,lease_owner,lease_expires_at,last_error,created_at,updated_at';

function publicJob(row:Record<string,any>):PublicJob{
  return publicJobSchema.parse({jobId:row.id,ownerScopeId:row.owner_scope_id,jobKind:row.job_kind,status:row.status,
    attemptCount:row.attempt_count,maxAttempts:row.max_attempts,leaseOwner:row.lease_owner,
    leaseExpiresAt:row.lease_expires_at?.toISOString()??null,lastError:row.last_error,
    createdAt:row.created_at.toISOString(),updatedAt:row.updated_at.toISOString()});
}
function requirePurpose(tx:OwnerTransaction,...allowed:string[]){
  if(!allowed.includes(tx.context.purpose))throw new Error('JOB_PURPOSE_REFUSED');
}

/** Idempotent per owner scope, job kind and key: a retried enqueue returns the
 * first job and creates no second row. */
export async function enqueueJob(tx:OwnerTransaction,input:EnqueueJob):Promise<PublicJob>{
  requirePurpose(tx,JOB_PURPOSES.enqueue);
  const job=enqueueJobSchema.parse(input);
  const inserted=await tx.query(`INSERT INTO jobs(id,owner_scope_id,job_kind,payload,idempotency_key,max_attempts)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING ${COLUMNS}`,
    [uuidV7(),tx.context.ownerScopeId,job.jobKind,JSON.stringify(job.payload),job.idempotencyKey,job.maxAttempts]);
  if(inserted.rowCount===1)return publicJob(inserted.rows[0]);
  const existing=(await tx.query(`SELECT ${COLUMNS},payload FROM jobs
    WHERE owner_scope_id=$1 AND job_kind=$2 AND idempotency_key=$3`,[tx.context.ownerScopeId,job.jobKind,job.idempotencyKey])).rows[0];
  if(!existing)throw new Error('JOB_ENQUEUE_REFUSED');
  if(JSON.stringify(existing.payload)!==JSON.stringify(job.payload))throw new Error('JOB_IDEMPOTENCY_CONFLICT');
  return publicJob(existing);
}

/** Claims the oldest runnable job: never claimed, failed with attempts left, or
 * held under a lease that has expired, so a stopped worker never strands work. */
export async function claimJob(tx:OwnerTransaction,options:{worker:string;leaseSeconds:number;jobKinds?:readonly string[]}):Promise<ClaimedJob|null>{
  requirePurpose(tx,JOB_PURPOSES.work);
  const worker=workerIdSchema.parse(options.worker);
  const leaseSeconds=Math.trunc(options.leaseSeconds);
  if(!(leaseSeconds>=0&&leaseSeconds<=3600))throw new Error('JOB_LEASE_INVALID');
  const kinds=options.jobKinds?.map(kind=>jobKindSchema.parse(kind))??null;
  const claimed=await tx.query(`UPDATE jobs SET status='RUNNING',lease_owner=$2,
      lease_expires_at=statement_timestamp()+make_interval(secs=>$3::double precision),attempt_count=attempt_count+1
    WHERE id=(SELECT id FROM jobs WHERE owner_scope_id=$1 AND attempt_count<max_attempts
      AND (status IN ('PENDING','FAILED') OR (status='RUNNING' AND lease_expires_at<=statement_timestamp()))
      AND ($4::text[] IS NULL OR job_kind=ANY($4))
      ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
    RETURNING ${COLUMNS},payload`,[tx.context.ownerScopeId,worker,leaseSeconds,kinds]);
  if(claimed.rowCount!==1)return null;
  const row=claimed.rows[0];
  attempts.add(1,{outcome:'CLAIMED'});
  return claimedJobSchema.parse({...publicJob(row),payload:row.payload});
}

/** Only the worker still holding a live lease may report an outcome; a worker
 * whose lease was reclaimed is refused so it cannot overwrite the new holder. */
async function reportOutcome(tx:OwnerTransaction,jobId:string,worker:string,assignments:string,values:unknown[]):Promise<PublicJob>{
  const updated=await tx.query(`UPDATE jobs SET ${assignments},lease_owner=NULL,lease_expires_at=NULL
    WHERE id=$1 AND owner_scope_id=$2 AND status='RUNNING' AND lease_owner=$3
    AND lease_expires_at>statement_timestamp() RETURNING ${COLUMNS}`,
    [publicJobSchema.shape.jobId.parse(jobId),tx.context.ownerScopeId,workerIdSchema.parse(worker),...values]);
  if(updated.rowCount!==1)throw new Error('JOB_LEASE_LOST');
  return publicJob(updated.rows[0]);
}
export async function completeJob(tx:OwnerTransaction,options:{jobId:string;worker:string}):Promise<PublicJob>{
  requirePurpose(tx,JOB_PURPOSES.work);
  const job=await reportOutcome(tx,options.jobId,options.worker,"status='SUCCEEDED'",[]);
  attempts.add(1,{outcome:job.status});
  return job;
}
/** Exhausting the attempt limit dead-letters the job instead of retrying it. */
export async function failJob(tx:OwnerTransaction,options:{jobId:string;worker:string;errorCode:string}):Promise<PublicJob>{
  requirePurpose(tx,JOB_PURPOSES.work);
  const job=await reportOutcome(tx,options.jobId,options.worker,
    "status=CASE WHEN attempt_count>=max_attempts THEN 'DEAD_LETTER' ELSE 'FAILED' END,last_error=$4",
    [jobErrorCodeSchema.parse(options.errorCode)]);
  attempts.add(1,{outcome:job.status});
  return job;
}

export async function listJobs(tx:OwnerTransaction,options:{limit:number}):Promise<JobsView>{
  requirePurpose(tx,JOB_PURPOSES.readJobs);
  const depth={PENDING:0,RUNNING:0,SUCCEEDED:0,FAILED:0,DEAD_LETTER:0,expiredLeases:0};
  const totals=(await tx.query(`SELECT status,count(*)::int AS total,
    count(*) FILTER (WHERE status='RUNNING' AND lease_expires_at<=statement_timestamp())::int AS expired
    FROM jobs WHERE owner_scope_id=$1 GROUP BY status`,[tx.context.ownerScopeId])).rows;
  for(const row of totals){
    depth[row.status as keyof typeof depth]=row.total;
    depth.expiredLeases+=row.expired;
  }
  const rows=(await tx.query(`SELECT ${COLUMNS} FROM jobs WHERE owner_scope_id=$1
    ORDER BY created_at DESC,id DESC LIMIT $2`,[tx.context.ownerScopeId,bounded(options.limit)])).rows;
  return jobsViewSchema.parse({queueDepth:queueDepthSchema.parse(depth),jobs:rows.map(publicJob)});
}

export async function listDeadLetterJobs(tx:OwnerTransaction,options:{limit:number}):Promise<PublicJob[]>{
  requirePurpose(tx,JOB_PURPOSES.readDeadLetter);
  const rows=(await tx.query(`SELECT ${COLUMNS} FROM jobs WHERE owner_scope_id=$1 AND status='DEAD_LETTER'
    ORDER BY updated_at DESC,id DESC LIMIT $2`,[tx.context.ownerScopeId,bounded(options.limit)])).rows;
  return rows.map(publicJob);
}

/** Manual retry returns a dead-lettered job to the queue with a fresh attempt
 * budget; its recorded error stays visible in the console. */
export async function retryDeadLetterJob(tx:OwnerTransaction,jobId:string):Promise<PublicJob|null>{
  requirePurpose(tx,JOB_PURPOSES.retryDeadLetter);
  const updated=await tx.query(`UPDATE jobs SET status='PENDING',attempt_count=0
    WHERE id=$1 AND owner_scope_id=$2 AND status='DEAD_LETTER' RETURNING ${COLUMNS}`,
    [publicJobSchema.shape.jobId.parse(jobId),tx.context.ownerScopeId]);
  return updated.rowCount===1?publicJob(updated.rows[0]):null;
}

function bounded(limit:number){
  const value=Math.trunc(limit);
  if(!(value>=1&&value<=200))throw new Error('JOB_LIMIT_INVALID');
  return value;
}

export interface JobAttempt {claimed:boolean;job?:PublicJob}
/** One worker turn. The claim, the handler and the outcome are separate
 * transactions: a handler that fails with a database error must not take the
 * lease bookkeeping down with it, and a worker killed between them leaves an
 * expiring lease that another worker reclaims. */
export async function runJobAttempt(pool:Pool,context:RequestContext,options:{
  worker:string;leaseSeconds:number;jobKinds?:readonly string[];
  handler(job:ClaimedJob):Promise<void>;
}):Promise<JobAttempt>{
  if(context.purpose!==JOB_PURPOSES.work)throw new Error('JOB_PURPOSE_REFUSED');
  return tracer.startActiveSpan('jobs.attempt',async span=>{
    try{
      const claimed=await withOwnerTransaction(pool,context,tx=>claimJob(tx,options));
      if(!claimed){span.setAttribute('unai.jobs.claimed',false);return {claimed:false};}
      span.setAttributes({'unai.jobs.claimed':true,'unai.jobs.kind':claimed.jobKind,'unai.jobs.attempt':claimed.attemptCount});
      let errorCode:string|null=null;
      try{await options.handler(claimed);}
      catch(error){
        // Only a stable code is recorded: handler error text may hold owner content.
        const message=error instanceof Error?error.message:'';
        errorCode=jobErrorCodeSchema.safeParse(message).success?message:'JOB_HANDLER_FAILED';
      }
      const job=await withOwnerTransaction(pool,context,tx=>errorCode===null
        ?completeJob(tx,{jobId:claimed.jobId,worker:options.worker})
        :failJob(tx,{jobId:claimed.jobId,worker:options.worker,errorCode}));
      span.setAttribute('unai.jobs.outcome',job.status);
      return {claimed:true,job};
    }finally{span.end();}
  });
}
