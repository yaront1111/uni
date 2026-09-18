import { Pool } from 'pg';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { runMigrations, withOwnerTransaction, type OwnerTransaction } from '@unai/postgres';
import type { RequestContext } from '@unai/domain';
import { JOB_PURPOSES, enqueueJob, claimJob, completeJob, failJob, listJobs, listDeadLetterJobs,
  retryDeadLetterJob, runJobAttempt } from './index.js';

if(!process.env.UNAI_TEST_DATABASE_URL)throw new Error('Run pnpm test for the required PostgreSQL harness');
const admin=new Pool({connectionString:process.env.UNAI_TEST_DATABASE_URL});
const url=new URL(process.env.UNAI_TEST_DATABASE_URL!);url.username='jobs_test_app';url.password='test-only';
const appPool=new Pool({connectionString:url.href});
const owner=randomUUID(),actor=randomUUID();
beforeAll(async()=>{
  await runMigrations(admin,resolve('migrations'));
  await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='jobs_test_app') THEN CREATE ROLE jobs_test_app LOGIN PASSWORD 'test-only'; END IF; END $$; GRANT unai_app TO jobs_test_app");
  await admin.query('INSERT INTO users(id,display_name) VALUES($1,$2)',[actor,'Queue operator']);
  await admin.query("INSERT INTO owner_scopes(id,scope_kind,display_name,created_by_user_id) VALUES($1,'PERSONAL','Queue owner',$2)",[owner,actor]);
  await admin.query("INSERT INTO owner_scope_members(owner_scope_id,user_id,role) VALUES($1,$2,'OWNER')",[owner,actor]);
});
afterAll(async()=>{await appPool.end();await admin.end();});

function context(purpose:string):RequestContext{return {actorId:actor,ownerScopeId:owner,purpose,correlationId:randomUUID()};}
function as<T>(purpose:string,run:(tx:OwnerTransaction)=>Promise<T>){return withOwnerTransaction(appPool,context(purpose),run);}
const key=()=>randomUUID().replaceAll('-','');

it('CRT-NFR-02-A: a handler that always fails is retried to its attempt limit and then inspectable in the dead-letter list',async()=>{
  const enqueued=await as(JOB_PURPOSES.enqueue,tx=>enqueueJob(tx,{jobKind:'evidence.extract',payload:{note:'always fails'},idempotencyKey:key(),maxAttempts:3}));
  expect(enqueued).toMatchObject({status:'PENDING',attemptCount:0,maxAttempts:3,leaseOwner:null,lastError:null});
  const handled:number[]=[];
  const attempt=()=>runJobAttempt(appPool,context(JOB_PURPOSES.work),{worker:'worker-a',leaseSeconds:60,jobKinds:['evidence.extract'],
    handler:async job=>{handled.push(job.attemptCount);throw new Error('EXTRACTION_UNAVAILABLE');}});
  expect(await attempt()).toMatchObject({claimed:true,job:{status:'FAILED',attemptCount:1,lastError:'EXTRACTION_UNAVAILABLE',leaseOwner:null}});
  expect(await attempt()).toMatchObject({claimed:true,job:{status:'FAILED',attemptCount:2}});
  expect(await attempt()).toMatchObject({claimed:true,job:{status:'DEAD_LETTER',attemptCount:3,lastError:'EXTRACTION_UNAVAILABLE'}});
  // The attempt limit holds: a fourth turn finds nothing runnable.
  expect(await attempt()).toEqual({claimed:false});
  expect(handled).toEqual([1,2,3]);
  const dead=await as(JOB_PURPOSES.readDeadLetter,tx=>listDeadLetterJobs(tx,{limit:50}));
  expect(dead.map(job=>job.jobId)).toContain(enqueued.jobId);
  expect(dead.find(job=>job.jobId===enqueued.jobId)).toMatchObject({status:'DEAD_LETTER',attemptCount:3,maxAttempts:3,lastError:'EXTRACTION_UNAVAILABLE'});
  expect(JSON.stringify(dead)).not.toContain('always fails');
  const view=await as(JOB_PURPOSES.readJobs,tx=>listJobs(tx,{limit:50}));
  expect(view.queueDepth.DEAD_LETTER).toBeGreaterThanOrEqual(1);
});

it('CRT-NFR-02-A: a job whose worker lease expires is picked up by another worker',async()=>{
  const enqueued=await as(JOB_PURPOSES.enqueue,tx=>enqueueJob(tx,{jobKind:'evidence.reindex',idempotencyKey:key(),maxAttempts:5}));
  // A worker killed mid-job leaves a lease it never reports against.
  const first=await as(JOB_PURPOSES.work,tx=>claimJob(tx,{worker:'worker-killed',leaseSeconds:0,jobKinds:['evidence.reindex']}));
  expect(first).toMatchObject({jobId:enqueued.jobId,status:'RUNNING',leaseOwner:'worker-killed',attemptCount:1});
  const expired=await as(JOB_PURPOSES.readJobs,tx=>listJobs(tx,{limit:50}));
  expect(expired.queueDepth.expiredLeases).toBeGreaterThanOrEqual(1);
  const second=await as(JOB_PURPOSES.work,tx=>claimJob(tx,{worker:'worker-b',leaseSeconds:60,jobKinds:['evidence.reindex']}));
  expect(second).toMatchObject({jobId:enqueued.jobId,status:'RUNNING',leaseOwner:'worker-b',attemptCount:2});
  // The reclaimed worker can no longer report an outcome for the job it lost.
  await expect(as(JOB_PURPOSES.work,tx=>completeJob(tx,{jobId:enqueued.jobId,worker:'worker-killed'}))).rejects.toThrow('JOB_LEASE_LOST');
  await expect(as(JOB_PURPOSES.work,tx=>failJob(tx,{jobId:enqueued.jobId,worker:'worker-killed',errorCode:'STOLEN'}))).rejects.toThrow('JOB_LEASE_LOST');
  expect(await as(JOB_PURPOSES.work,tx=>completeJob(tx,{jobId:enqueued.jobId,worker:'worker-b'}))).toMatchObject({status:'SUCCEEDED',leaseOwner:null,leaseExpiresAt:null});
});

it('CRT-NFR-02-A: a dead-lettered job is retried manually and then runs to success',async()=>{
  const idempotencyKey=key();
  const enqueued=await as(JOB_PURPOSES.enqueue,tx=>enqueueJob(tx,{jobKind:'projection.rebuild',idempotencyKey,maxAttempts:1}));
  expect(await runJobAttempt(appPool,context(JOB_PURPOSES.work),{worker:'worker-a',leaseSeconds:60,jobKinds:['projection.rebuild'],
    handler:async()=>{throw new Error('REDUCER_FAILED');}})).toMatchObject({job:{status:'DEAD_LETTER',attemptCount:1}});
  const retried=await as(JOB_PURPOSES.retryDeadLetter,tx=>retryDeadLetterJob(tx,enqueued.jobId));
  expect(retried).toMatchObject({jobId:enqueued.jobId,status:'PENDING',attemptCount:0,leaseOwner:null,lastError:'REDUCER_FAILED'});
  let ran=0;
  expect(await runJobAttempt(appPool,context(JOB_PURPOSES.work),{worker:'worker-c',leaseSeconds:60,jobKinds:['projection.rebuild'],
    handler:async()=>{ran+=1;}})).toMatchObject({claimed:true,job:{jobId:enqueued.jobId,status:'SUCCEEDED',attemptCount:1}});
  expect(ran).toBe(1);
  expect(await as(JOB_PURPOSES.retryDeadLetter,tx=>retryDeadLetterJob(tx,enqueued.jobId))).toBeNull();
  expect(await as(JOB_PURPOSES.retryDeadLetter,tx=>retryDeadLetterJob(tx,randomUUID()))).toBeNull();
});

it('enqueues idempotently and refuses a conflicting payload for the same key',async()=>{
  const idempotencyKey=key();
  const first=await as(JOB_PURPOSES.enqueue,tx=>enqueueJob(tx,{jobKind:'connector.sync',payload:{a:1},idempotencyKey}));
  const repeated=await as(JOB_PURPOSES.enqueue,tx=>enqueueJob(tx,{jobKind:'connector.sync',payload:{a:1},idempotencyKey}));
  expect(repeated.jobId).toBe(first.jobId);
  expect((await admin.query('SELECT id FROM jobs WHERE owner_scope_id=$1 AND idempotency_key=$2',[owner,idempotencyKey])).rowCount).toBe(1);
  await expect(as(JOB_PURPOSES.enqueue,tx=>enqueueJob(tx,{jobKind:'connector.sync',payload:{a:2},idempotencyKey}))).rejects.toThrow('JOB_IDEMPOTENCY_CONFLICT');
});

it('refuses queue operations under a purpose the queue does not grant',async()=>{
  await expect(as('device.list',tx=>enqueueJob(tx,{jobKind:'evidence.extract',idempotencyKey:key()}))).rejects.toThrow('JOB_PURPOSE_REFUSED');
  await expect(as('device.list',tx=>claimJob(tx,{worker:'worker-a',leaseSeconds:60}))).rejects.toThrow('JOB_PURPOSE_REFUSED');
  await expect(as('ops.jobs.read',tx=>retryDeadLetterJob(tx,randomUUID()))).rejects.toThrow('JOB_PURPOSE_REFUSED');
  await expect(runJobAttempt(appPool,context('ops.jobs.read'),{worker:'worker-a',leaseSeconds:60,handler:async()=>{}})).rejects.toThrow('JOB_PURPOSE_REFUSED');
  // Row-level security refuses the insert even when the library check is bypassed.
  await expect(as('device.list',tx=>tx.query("INSERT INTO jobs(id,owner_scope_id,job_kind,idempotency_key) VALUES($1,$2,'evidence.extract',$3)",
    [randomUUID(),owner,key()]))).rejects.toMatchObject({code:'42501'});
});

it('records only stable error codes and keeps job identity immutable',async()=>{
  const enqueued=await as(JOB_PURPOSES.enqueue,tx=>enqueueJob(tx,{jobKind:'evidence.redact',idempotencyKey:key(),maxAttempts:1}));
  const result=await runJobAttempt(appPool,context(JOB_PURPOSES.work),{worker:'worker-a',leaseSeconds:60,jobKinds:['evidence.redact'],
    handler:async()=>{throw new Error('connection to 10.0.0.4 failed for user alice@example.test');}});
  expect(result.job).toMatchObject({jobId:enqueued.jobId,status:'DEAD_LETTER',lastError:'JOB_HANDLER_FAILED'});
  await expect(admin.query('UPDATE jobs SET owner_scope_id=$1 WHERE id=$2',[randomUUID(),enqueued.jobId])).rejects.toMatchObject({code:'55000'});
  await expect(admin.query("UPDATE jobs SET payload='{\"x\":1}' WHERE id=$1",[enqueued.jobId])).rejects.toMatchObject({code:'55000'});
});

it('CRT-NFR-02-A: a worker killed mid-job leaves its evidence and content hash unchanged for the next worker',async()=>{
  const evidence=randomUUID(),hash='b'.repeat(64);
  await admin.query(`INSERT INTO source_items(id,owner_scope_id,connector_id,source_type,external_id,actor_ref,submitted_by_user_id,
    raw_object_ref,content_hash,sensitivity,allowed_purposes,ingestion_version,idempotency_key)
    VALUES($1,$2,NULL,'DOCUMENT',$3,$4,$5,$6,$7,'PRIVATE',ARRAY['PERSONAL_ASSISTANCE'],'evidence-json-v1',$8)`,
    [evidence,owner,'document:'+evidence,JSON.stringify({type:'USER',id:actor}),actor,randomUUID(),hash,key()]);
  const enqueued=await as(JOB_PURPOSES.enqueue,tx=>enqueueJob(tx,{jobKind:'evidence.summarize',payload:{evidenceId:evidence},idempotencyKey:key(),maxAttempts:3}));
  const killed=await as(JOB_PURPOSES.work,tx=>claimJob(tx,{worker:'worker-killed',leaseSeconds:0,jobKinds:['evidence.summarize']}));
  expect(killed).toMatchObject({jobId:enqueued.jobId,payload:{evidenceId:evidence}});
  // The stored evidence is immutable, so the reclaimed attempt restarts from the same bytes.
  await expect(admin.query('UPDATE source_items SET content_hash=$1 WHERE id=$2',['c'.repeat(64),evidence])).rejects.toMatchObject({code:'55000'});
  const reclaimed=await as(JOB_PURPOSES.work,tx=>claimJob(tx,{worker:'worker-d',leaseSeconds:60,jobKinds:['evidence.summarize']}));
  expect(reclaimed).toMatchObject({jobId:enqueued.jobId,leaseOwner:'worker-d',attemptCount:2,payload:{evidenceId:evidence}});
  expect((await admin.query('SELECT content_hash FROM source_items WHERE id=$1',[evidence])).rows[0].content_hash).toBe(hash);
  expect(await as(JOB_PURPOSES.work,tx=>completeJob(tx,{jobId:enqueued.jobId,worker:'worker-d'}))).toMatchObject({status:'SUCCEEDED'});
});

it('refuses an out-of-range lease or list limit',async()=>{
  await expect(as(JOB_PURPOSES.work,tx=>claimJob(tx,{worker:'worker-a',leaseSeconds:-1}))).rejects.toThrow('JOB_LEASE_INVALID');
  await expect(as(JOB_PURPOSES.work,tx=>claimJob(tx,{worker:'bad worker id',leaseSeconds:60}))).rejects.toThrow();
  await expect(as(JOB_PURPOSES.readJobs,tx=>listJobs(tx,{limit:0}))).rejects.toThrow('JOB_LIMIT_INVALID');
  await expect(as(JOB_PURPOSES.readDeadLetter,tx=>listDeadLetterJobs(tx,{limit:500}))).rejects.toThrow('JOB_LIMIT_INVALID');
});
