import React,{useState} from 'react';
import type {PublicJob,QueueDepth} from '@unai/domain';
import {Navigation} from './Navigation';

export interface JobsProps {
  queueDepth:QueueDepth;
  jobs:PublicJob[];
  deadLetter:PublicJob[];
  retriedJobId?:string|null;
  error?:string;
}
/** Status wording is text, never colour alone (design accessibility rule). */
const statusLabels:Record<PublicJob['status'],string>={
  PENDING:'Waiting',RUNNING:'Running',SUCCEEDED:'Succeeded',FAILED:'Retrying',DEAD_LETTER:'Dead letter',
};
function leaseState(job:PublicJob,now:number){
  if(job.status!=='RUNNING'||!job.leaseExpiresAt)return 'No lease held';
  if(new Date(job.leaseExpiresAt).getTime()>now)return 'Leased by '+job.leaseOwner+' until '+timestamp(job.leaseExpiresAt);
  return job.attemptCount>=job.maxAttempts
    ?'Lease expired — no attempts left, moves to dead letter on the next worker turn'
    :'Lease expired — another worker can pick this job up';
}
function timestamp(value:string){return new Date(value).toISOString().slice(0,19).replace('T',' ')+' UTC';}

export function Jobs(props:JobsProps){
  const [busy,setBusy]=useState('');
  const [error,setError]=useState(props.error??'');
  const now=Date.now();
  const reclaimable=props.jobs.filter(job=>job.status==='RUNNING'&&job.leaseExpiresAt&&new Date(job.leaseExpiresAt).getTime()<=now);
  async function retry(jobId:string){
    setBusy(jobId);setError('');
    try{
      const response=await fetch('/api/platform/ops/dead-letter/'+jobId+'/retry',{method:'POST',
        headers:{'content-type':'application/json','x-purpose':'ops.dead_letter.retry',
          'x-correlation-id':crypto.randomUUID(),'idempotency-key':crypto.randomUUID()},body:'{}'});
      if(response.status===401){window.location.assign('/signin?reason=expired');return;}
      if(!response.ok)throw new Error('refused');
      window.location.assign('/ops/jobs?retried='+jobId);
    }catch{setError('The job could not be queued again. Please retry.');}finally{setBusy('');}
  }
  return <div className="shell">
    <a className="skip" href="#content">Skip to content</a>
    <header><a href="/" className="brand">Uai</a><span>Your personal memory</span></header>
    <Navigation current="jobs"/>
    <main id="content" tabIndex={-1}>
      <p className="eyebrow">OPERATIONS</p>
      <h1>Jobs and dead letter</h1>
      <div role="status" aria-live="polite">
        {props.retriedJobId&&<p>Job {props.retriedJobId} was queued again and is waiting for a worker.</p>}
      </div>
      <section className="card" aria-labelledby="queue-depth">
        <h2 id="queue-depth">Queue depth and lease state</h2>
        <ul className="depth">
          <li>Waiting: {props.queueDepth.PENDING}</li>
          <li>Running: {props.queueDepth.RUNNING}</li>
          <li>Retrying: {props.queueDepth.FAILED}</li>
          <li>Succeeded: {props.queueDepth.SUCCEEDED}</li>
          <li>Dead letter: {props.queueDepth.DEAD_LETTER}</li>
          <li>Expired leases: {props.queueDepth.expiredLeases}</li>
        </ul>
        {reclaimable.length>0&&<p>
          {reclaimable.length===1?'One job':reclaimable.length+' jobs'} held a lease that expired after a worker stopped.
          Another worker picks the work up on its next turn, or moves it to the dead letter when it has no attempts left.
          Stored evidence is unchanged: raw evidence and its content hash are immutable, so the retry starts from the same bytes.
        </p>}
      </section>
      <section className="card" aria-labelledby="queue-jobs">
        <h2 id="queue-jobs">Jobs</h2>
        {props.jobs.length===0?<p>No jobs have been queued for this owner scope.</p>:
        <table><caption className="sr-only">Queued jobs with attempts and lease state</caption>
          <thead><tr><th scope="col">Job</th><th scope="col">State</th><th scope="col">Attempts</th><th scope="col">Lease</th><th scope="col">Last error</th></tr></thead>
          <tbody>{props.jobs.map(job=><tr key={job.jobId}>
            <th scope="row"><span>{job.jobKind}</span><small>{job.jobId}</small></th>
            <td>{statusLabels[job.status]}{job.status==='FAILED'?' — attempt '+job.attemptCount+' of '+job.maxAttempts+' within its attempt limit':''}</td>
            <td>{job.attemptCount} of {job.maxAttempts}</td>
            <td>{leaseState(job,now)}</td>
            <td>{job.lastError??'None recorded'}</td>
          </tr>)}</tbody>
        </table>}
      </section>
      <section className="card" aria-labelledby="dead-letter">
        <h2 id="dead-letter">Dead letter</h2>
        {props.deadLetter.length===0?<p>No job has reached its attempt limit.</p>:
        <ul className="devices">{props.deadLetter.map(job=><li key={job.jobId}>
          <div>
            <strong>{job.jobKind}</strong>
            <p>Stopped at its attempt limit after {job.attemptCount} of {job.maxAttempts} attempts. Error: {job.lastError??'None recorded'}</p>
            <small>{job.jobId} · last change {timestamp(job.updatedAt)}</small>
          </div>
          <button disabled={busy===job.jobId} onClick={()=>void retry(job.jobId)}>
            {busy===job.jobId?'Queueing…':'Retry'}<span className="sr-only"> {job.jobKind} job {job.jobId}</span>
          </button>
        </li>)}</ul>}
      </section>
      {error&&<p role="alert">{error}</p>}
    </main>
    <footer>Jobs are retried up to their attempt limit, then kept here for inspection. Retrying gives a job a fresh attempt budget.</footer>
  </div>;
}
