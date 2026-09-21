// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {act,createElement} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {ProposalInbox} from './ProposalInbox';
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root|null=null;
afterEach(()=>{act(()=>root?.unmount());root=null;document.body.innerHTML='';vi.unstubAllGlobals();});
const proposals=['a','b'].map(id=>({transactionId:id,transactionKind:'CANONICALIZE',status:'PROPOSED',risk:'LOW',
  idempotencyKey:'proposal-'+id,registryReleaseId:'release',proposedAt:'2026-01-01T00:00:00.000Z',operations:[],sources:[]})) as import('@unai/domain').PendingProposal[];
const button=(label:string)=>Array.from(document.querySelectorAll('button')).find(b=>b.textContent===label)!;
it.each(['confirm','reject'])('verify-d2-inbox: batch %s requires review, cancellation makes no calls, each proposal uses one governed operation',async decision=>{
  const fetcher=vi.fn(async(..._args:unknown[])=>({ok:true,status:200,json:async()=>({status:decision==='reject'?'REJECTED':'COMMITTED'})}));
  vi.stubGlobal('fetch',fetcher);document.body.innerHTML='<div id="root"></div>';root=createRoot(document.getElementById('root')!);
  await act(async()=>root!.render(createElement(ProposalInbox,{proposals})));
  expect(document.querySelectorAll('input[type=checkbox]')).toHaveLength(2);
  await act(async()=>document.querySelectorAll<HTMLInputElement>('input[type=checkbox]').forEach(input=>input.click()));
  await act(async()=>button(decision==='confirm'?'Review confirmation':'Review rejection').click());
  expect(fetcher).not.toHaveBeenCalled();
  await act(async()=>button('Cancel review').click());expect(fetcher).not.toHaveBeenCalled();
  await act(async()=>button(decision==='confirm'?'Review confirmation':'Review rejection').click());
  await act(async()=>button(decision==='confirm'?'Confirm selected proposals':'Reject selected proposals').click());
  expect(fetcher).toHaveBeenCalledTimes(2);
  const correlations=new Set();
  fetcher.mock.calls.forEach(([path,options],i)=>{
    expect(path).toBe('/api/platform/memory/transactions/'+proposals[i]!.transactionId+'/'+(decision==='confirm'?'commit':'reject'));
    const headers=(options as RequestInit).headers as Record<string,string>;
    expect(headers['x-purpose']).toBe('memory.govern');expect(headers['idempotency-key']).toBe(proposals[i]!.idempotencyKey);
    correlations.add(headers['x-correlation-id']);
  });
  expect(correlations.size).toBe(2);
  expect(document.querySelectorAll('input[type=checkbox]')).toHaveLength(0);
});
