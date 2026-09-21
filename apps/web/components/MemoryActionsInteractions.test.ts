// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {act,createElement} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {CorrectionControls} from './CorrectionControls';
import {inspection} from './testing/inspection';
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root|null=null;
afterEach(()=>{act(()=>root?.unmount());root=null;document.body.innerHTML='';vi.unstubAllGlobals();});
async function mount(){document.body.innerHTML='<div id="root"></div>';root=createRoot(document.getElementById('root')!);await act(async()=>root!.render(createElement(CorrectionControls,{state:'ready',inspector:inspection()})));}
async function submit(key:string,values:Record<string,string>={}){
  const form=document.querySelector('[aria-labelledby="control-'+key+'"] form')!;
  for(const [name,value] of Object.entries(values))(form.querySelector('[name="'+name+'"]') as HTMLInputElement).value=value;
  await act(async()=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
}
const receipt={memoryOperationId:'operation-receipt',operationKind:'DELETE',ownerSequence:42,proposedTransactionId:null,transactionId:null};
it('verify-d3-delete: previews deletion before any write, supports cancellation and displays its audited operation receipt',async()=>{
  const fetcher=vi.fn(async(..._args:unknown[])=>({ok:true,status:201,json:async()=>receipt}));vi.stubGlobal('fetch',fetcher);await mount();
  await submit('delete',{confirmation:'DELETE'});
  expect(fetcher).not.toHaveBeenCalled();expect(document.body.textContent).toContain('Review deletion');
  expect(document.body.textContent).toContain(inspection().subject.requestedId);
  const button=(text:string)=>Array.from(document.querySelectorAll('button')).find(b=>b.textContent===text)!;
  await act(async()=>button('Cancel deletion').click());expect(fetcher).not.toHaveBeenCalled();
  await submit('delete',{confirmation:'DELETE'});
  await act(async()=>button('Confirm deletion request').click());
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]?.[0]).toBe('/api/platform/memory/deletions');
  expect(document.body.textContent).toContain('operation-receipt');
  expect(document.body.textContent).toContain('Deletion workflow pending');
  expect(document.body.textContent).not.toContain('Deletion complete');
});

it('verify-d1-actions: sends confirm, correct, reject, keep uncertain, suppress and archive once each with purpose and fresh request context',async()=>{
  const fetcher=vi.fn(async(..._args:unknown[])=>({ok:true,status:201,json:async()=>receipt}));vi.stubGlobal('fetch',fetcher);await mount();
  const operations=[['confirm','confirmations'],['correct','corrections'],['reject','rejections'],['keep-uncertain','keep-uncertain'],['suppress','suppressions'],['archive','archives']];
  for(const [key] of operations)await submit(key!,{...(key==='correct'?{value:'60'}:{}),rawText:'Owner decision'});
  expect(fetcher).toHaveBeenCalledTimes(operations.length);
  const correlations=new Set(),keys=new Set();
  fetcher.mock.calls.forEach(([path,options],index)=>{
    expect(path).toBe('/api/platform/memory/'+operations[index]![1]);
    const request=options as RequestInit;const headers=request.headers as Record<string,string>;
    expect(request.method).toBe('POST');expect(headers['x-purpose']).toBe('memory.correct');
    expect(headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);expect(headers['idempotency-key']).toMatch(/^[0-9a-f]{32}$/);
    correlations.add(headers['x-correlation-id']);keys.add(headers['idempotency-key']);
  });
  expect(correlations.size).toBe(operations.length);expect(keys.size).toBe(operations.length);
});

it('deduplicates in-flight actions and retries the same payload with its original idempotency key',async()=>{
  let finish!:(value:unknown)=>void;
  const fetcher=vi.fn((..._args:unknown[])=>new Promise(resolve=>{finish=resolve;}));vi.stubGlobal('fetch',fetcher);await mount();
  // Do not await the pending request; React's event handler deliberately returns immediately.
  await submit('confirm',{rawText:'Yes'});await submit('confirm',{rawText:'Yes'});
  expect(fetcher).toHaveBeenCalledTimes(1);
  await act(async()=>finish({ok:false,status:503}));
  await submit('confirm',{rawText:'Yes'});expect(fetcher).toHaveBeenCalledTimes(2);
  const headers=(index:number)=>(fetcher.mock.calls[index]![1] as RequestInit).headers as Record<string,string>;
  expect(headers(0)['idempotency-key']).toBe(headers(1)['idempotency-key']);
  expect(headers(0)['x-correlation-id']).not.toBe(headers(1)['x-correlation-id']);
  await act(async()=>finish({ok:false,status:503}));
  await submit('confirm',{rawText:'A different confirmation'});
  expect(headers(2)['idempotency-key']).not.toBe(headers(1)['idempotency-key']);
  await act(async()=>finish({ok:true,status:201,json:async()=>receipt}));
});
