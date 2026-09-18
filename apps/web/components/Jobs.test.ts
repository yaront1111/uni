import { expect,it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PublicJob } from '@unai/domain';
import * as jobs from './Jobs';

const base:PublicJob={jobId:'6e6f8a40-6f0d-7b9a-8f6a-2c1a6e2f0001',ownerScopeId:'6e6f8a40-6f0d-7b9a-8f6a-2c1a6e2f0000',
  jobKind:'evidence.extract',status:'PENDING',attemptCount:0,maxAttempts:3,leaseOwner:null,leaseExpiresAt:null,
  lastError:null,createdAt:'2026-09-17T08:00:00.000Z',updatedAt:'2026-09-17T08:00:00.000Z'};
const depth={PENDING:1,RUNNING:1,SUCCEEDED:2,FAILED:1,DEAD_LETTER:1,expiredLeases:1};
const retrying:PublicJob={...base,jobId:'6e6f8a40-6f0d-7b9a-8f6a-2c1a6e2f0002',status:'FAILED',attemptCount:2,lastError:'EXTRACTION_UNAVAILABLE'};
const dead:PublicJob={...base,jobId:'6e6f8a40-6f0d-7b9a-8f6a-2c1a6e2f0003',status:'DEAD_LETTER',attemptCount:3,lastError:'EXTRACTION_UNAVAILABLE'};
const expired:PublicJob={...base,jobId:'6e6f8a40-6f0d-7b9a-8f6a-2c1a6e2f0004',status:'RUNNING',attemptCount:1,
  leaseOwner:'worker-killed',leaseExpiresAt:'2026-09-17T08:05:00.000Z'};
const held:PublicJob={...base,jobId:'6e6f8a40-6f0d-7b9a-8f6a-2c1a6e2f0005',status:'RUNNING',attemptCount:1,
  leaseOwner:'worker-b',leaseExpiresAt:'2099-01-01T00:00:00.000Z'};
const exhausted:PublicJob={...expired,jobId:'6e6f8a40-6f0d-7b9a-8f6a-2c1a6e2f0006',attemptCount:3};
function render(props:Partial<jobs.JobsProps>){
  return renderToStaticMarkup(createElement(jobs.Jobs,{queueDepth:depth,jobs:[],deadLetter:[],...props}));
}

it('renders the designed queue depth and lease state',()=>{
  expect(jobs).toHaveProperty('Jobs');
  const html=render({jobs:[held]});
  expect(html).toContain('Queue depth and lease state');
  expect(html).toContain('Expired leases: 1');
  expect(html).toContain('Leased by worker-b until');
  expect(html).toContain('Skip to content');
});

it('renders a job retrying within its attempt limit',()=>{
  const html=render({jobs:[retrying]});
  expect(html).toContain('Retrying — attempt 2 of 3 within its attempt limit');
  expect(html).toContain('EXTRACTION_UNAVAILABLE');
});

it('renders a job at its attempt limit in the dead-letter list with its error and a retry control',()=>{
  const html=render({jobs:[dead],deadLetter:[dead]});
  expect(html).toContain('Dead letter');
  expect(html).toContain('Stopped at its attempt limit after 3 of 3 attempts. Error: EXTRACTION_UNAVAILABLE');
  expect(html).toContain('Retry');
  expect(html).toContain(dead.jobId);
});

it('renders the result of a manual retry',()=>{
  const html=render({retriedJobId:dead.jobId});
  expect(html).toContain('was queued again and is waiting for a worker');
  expect(html).toContain('No job has reached its attempt limit');
});

it('renders an expired lease as reclaimable with the evidence left intact',()=>{
  const html=render({jobs:[expired]});
  expect(html).toContain('Lease expired — another worker can pick this job up');
  expect(html).toContain('One job held a lease that expired after a worker stopped');
  expect(html).toContain('content');
  expect(html).toContain('hash are immutable');
  // An expired lease with no attempt left is not picked up again: the next worker turn dead-letters it.
  const stuck=render({jobs:[exhausted]});
  expect(stuck).toContain('Lease expired — no attempts left, moves to dead letter on the next worker turn');
  expect(stuck).not.toContain('another worker can pick this job up');
});

it('renders an empty queue and a read failure without leaking a payload',()=>{
  expect(render({queueDepth:{PENDING:0,RUNNING:0,SUCCEEDED:0,FAILED:0,DEAD_LETTER:0,expiredLeases:0}}))
    .toContain('No jobs have been queued for this owner scope.');
  expect(render({error:'The job queue could not be read. Please reload to retry.'}))
    .toContain('The job queue could not be read.');
  expect(render({jobs:[retrying,dead,expired],deadLetter:[dead]})).not.toContain('payload');
});
