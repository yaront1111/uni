import { Pool } from 'pg';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { randomUUID, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { runMigrations, withOwnerTransaction } from '@unai/postgres';
import { postgresAdapter, SESSION_COOKIE } from '@unai/auth';
import { JOB_PURPOSES, enqueueJob, runJobAttempt } from '@unai/jobs';
import type { RequestContext } from '@unai/domain';
import { createPlatformApi } from './platform.js';

const admin=new Pool({connectionString:process.env.UNAI_TEST_DATABASE_URL});
const url=new URL(process.env.UNAI_TEST_DATABASE_URL!);url.username='ops_test_app';url.password='test-only';
const appPool=new Pool({connectionString:url.href});
beforeAll(async()=>{
  await runMigrations(admin,resolve('migrations'));
  await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='ops_test_app') THEN CREATE ROLE ops_test_app LOGIN PASSWORD 'test-only'; END IF; END $$; GRANT unai_app TO ops_test_app");
});
afterAll(async()=>{await appPool.end();await admin.end();});

async function fixture(email:string){
  const adapter=postgresAdapter(admin);
  const user=await adapter.createUser!({name:'Operator',email,emailVerified:null});
  const token=randomBytes(32).toString('base64url');
  await adapter.createSession!({userId:user.id,sessionToken:token,expires:new Date(Date.now()+86400000)});
  const owner=(user as unknown as {ownerScopeId:string}).ownerScopeId;
  const app=createPlatformApi({authPool:admin,appPool});
  app.addHook('onRequest',async request=>{Object.defineProperty(request.raw.socket,'encrypted',{value:true});});
  const headers={cookie:SESSION_COOKIE+'='+token,'x-owner-scope-id':owner,'x-purpose':'ops.jobs.read',
    'x-correlation-id':randomUUID(),'idempotency-key':randomUUID()};
  const context=(purpose:string):RequestContext=>({actorId:user.id,ownerScopeId:owner,purpose,correlationId:randomUUID()});
  return {app,headers,owner,user,context};
}

it('CRT-NFR-02-A: the jobs route reports queue depth, lease state and attempts without the job payload',async()=>{
  const f=await fixture('ops-jobs@example.test');try{
    const job=await withOwnerTransaction(appPool,f.context(JOB_PURPOSES.enqueue),tx=>enqueueJob(tx,
      {jobKind:'evidence.extract',payload:{secretNote:'owner content'},idempotencyKey:randomUUID().replaceAll('-',''),maxAttempts:2}));
    const pending=await f.app.inject({url:'/v1/ops/jobs',headers:f.headers});
    expect(pending.statusCode).toBe(200);
    expect(pending.json().queueDepth).toMatchObject({PENDING:1,RUNNING:0,DEAD_LETTER:0,expiredLeases:0});
    expect(pending.json().jobs[0]).toMatchObject({jobId:job.jobId,jobKind:'evidence.extract',status:'PENDING',attemptCount:0,maxAttempts:2,leaseOwner:null});
    expect(pending.body).not.toContain('owner content');
    expect(pending.body).not.toContain('payload');
    // A worker killed mid-job leaves an expired lease visible to the console.
    await withOwnerTransaction(appPool,f.context(JOB_PURPOSES.work),async tx=>{
      const {claimJob}=await import('@unai/jobs');
      return claimJob(tx,{worker:'worker-killed',leaseSeconds:0});
    });
    const running=await f.app.inject({url:'/v1/ops/jobs',headers:f.headers});
    expect(running.json().queueDepth).toMatchObject({RUNNING:1,expiredLeases:1});
    expect(running.json().jobs[0]).toMatchObject({status:'RUNNING',leaseOwner:'worker-killed',attemptCount:1});
    expect((await admin.query('SELECT purpose FROM audit_events WHERE correlation_id=$1',[f.headers['x-correlation-id']])).rows
      .map((row:{purpose:string})=>row.purpose)).toContain('ops.jobs.read');
  }finally{await f.app.close();}
});

it('CRT-NFR-02-A: an exhausted job is listed in the dead-letter route with its error and retried manually',async()=>{
  const f=await fixture('ops-dead-letter@example.test');try{
    const job=await withOwnerTransaction(appPool,f.context(JOB_PURPOSES.enqueue),tx=>enqueueJob(tx,
      {jobKind:'evidence.extract',idempotencyKey:randomUUID().replaceAll('-',''),maxAttempts:1}));
    const attempt=await runJobAttempt(appPool,f.context(JOB_PURPOSES.work),{worker:'worker-a',leaseSeconds:60,
      handler:async()=>{throw new Error('EXTRACTION_UNAVAILABLE');}});
    expect(attempt.job).toMatchObject({status:'DEAD_LETTER'});
    const listed=await f.app.inject({url:'/v1/ops/dead-letter',headers:{...f.headers,'x-purpose':'ops.dead_letter.read'}});
    expect(listed.statusCode).toBe(200);
    expect(listed.json().jobs).toEqual([expect.objectContaining({jobId:job.jobId,status:'DEAD_LETTER',attemptCount:1,lastError:'EXTRACTION_UNAVAILABLE'})]);
    const retryHeaders={...f.headers,'x-purpose':'ops.dead_letter.retry','x-correlation-id':randomUUID(),'idempotency-key':randomUUID()};
    const retried=await f.app.inject({method:'POST',url:'/v1/ops/dead-letter/'+job.jobId+'/retry',headers:retryHeaders,payload:{}});
    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toMatchObject({retried:true,job:{jobId:job.jobId,status:'PENDING',attemptCount:0,lastError:'EXTRACTION_UNAVAILABLE'}});
    expect((await f.app.inject({url:'/v1/ops/dead-letter',headers:{...f.headers,'x-purpose':'ops.dead_letter.read'}})).json().jobs).toEqual([]);
    expect((await admin.query('SELECT purpose FROM audit_events WHERE correlation_id=$1',[retryHeaders['x-correlation-id']])).rows
      .map((row:{purpose:string})=>row.purpose)).toEqual(['ops.dead_letter.retry']);
    const missing=await f.app.inject({method:'POST',url:'/v1/ops/dead-letter/'+randomUUID()+'/retry',
      headers:{...retryHeaders,'x-correlation-id':randomUUID(),'idempotency-key':randomUUID()},payload:{}});
    expect(missing.statusCode).toBe(404);
    const invalid=await f.app.inject({method:'POST',url:'/v1/ops/dead-letter/not-a-job/retry',
      headers:{...retryHeaders,'x-correlation-id':randomUUID(),'idempotency-key':randomUUID()},payload:{}});
    expect(invalid.statusCode).toBe(400);
  }finally{await f.app.close();}
});

it('refuses queue routes without the matching purpose, owner scope, correlation id or idempotency key',async()=>{
  const f=await fixture('ops-refusals@example.test');try{
    expect((await f.app.inject({url:'/v1/ops/jobs',headers:{...f.headers,'x-purpose':'device.list'}})).statusCode).toBe(403);
    expect((await f.app.inject({url:'/v1/ops/dead-letter',headers:f.headers})).statusCode).toBe(403);
    expect((await f.app.inject({url:'/v1/ops/jobs',headers:{...f.headers,'x-owner-scope-id':randomUUID()}})).statusCode).toBe(403);
    const {['x-correlation-id']:_omitted,...withoutCorrelation}=f.headers;
    expect((await f.app.inject({url:'/v1/ops/jobs',headers:withoutCorrelation})).statusCode).toBe(400);
    const {['idempotency-key']:_key,...withoutKey}=f.headers;
    expect((await f.app.inject({method:'POST',url:'/v1/ops/dead-letter/'+randomUUID()+'/retry',
      headers:{...withoutKey,'x-purpose':'ops.dead_letter.retry'},payload:{}})).statusCode).toBe(400);
    expect((await f.app.inject({url:'/v1/ops/jobs',headers:{...f.headers,cookie:SESSION_COOKIE+'=missing'}})).statusCode).toBe(401);
  }finally{await f.app.close();}
});

it('CRT-SEC-01-A: the queue routes never answer with another owner scope job',async()=>{
  const a=await fixture('ops-owner-a@example.test'),b=await fixture('ops-owner-b@example.test');try{
    const job=await withOwnerTransaction(appPool,b.context(JOB_PURPOSES.enqueue),tx=>enqueueJob(tx,
      {jobKind:'evidence.extract',idempotencyKey:randomUUID().replaceAll('-',''),maxAttempts:1}));
    await runJobAttempt(appPool,b.context(JOB_PURPOSES.work),{worker:'worker-b',leaseSeconds:60,handler:async()=>{throw new Error('EXTRACTION_UNAVAILABLE');}});
    const jobs=await a.app.inject({url:'/v1/ops/jobs',headers:a.headers});
    expect(jobs.json().jobs).toEqual([]);
    expect(jobs.json().queueDepth).toMatchObject({PENDING:0,RUNNING:0,DEAD_LETTER:0});
    expect((await a.app.inject({url:'/v1/ops/dead-letter',headers:{...a.headers,'x-purpose':'ops.dead_letter.read'}})).json().jobs).toEqual([]);
    const stolen=await a.app.inject({method:'POST',url:'/v1/ops/dead-letter/'+job.jobId+'/retry',
      headers:{...a.headers,'x-purpose':'ops.dead_letter.retry','x-correlation-id':randomUUID(),'idempotency-key':randomUUID()},payload:{}});
    expect(stolen.statusCode).toBe(404);
    expect((await admin.query('SELECT status FROM jobs WHERE id=$1',[job.jobId])).rows[0].status).toBe('DEAD_LETTER');
  }finally{await a.app.close();await b.app.close();}
});
