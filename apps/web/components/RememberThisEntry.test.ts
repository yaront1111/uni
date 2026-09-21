// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {act,createElement} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import type {ConversationTurn} from '@unai/domain';
import {RememberThisEntry} from './RememberThisEntry';
import {ConversationThread} from './ConversationThread';
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root|null=null;
afterEach(()=>{act(()=>root?.unmount());root=null;document.body.innerHTML='';vi.unstubAllGlobals();});
const turn:ConversationTurn={id:'10000000-0000-4000-8000-000000000001',conversationId:'10000000-0000-4000-8000-000000000002',
  ownerScopeId:'10000000-0000-4000-8000-000000000003',speaker:'owner',status:'accepted',text:'I prefer tea.',storedOrder:0,createdAt:'2026-01-01T00:00:00.000Z'};
const transactionId='10000000-0000-4000-8000-000000000004';
const button=(text:string)=>Array.from(document.querySelectorAll('button')).find(b=>b.textContent===text)!;
async function mount(shared=false){document.body.innerHTML='<div id="root"></div>';root=createRoot(document.getElementById('root')!);
  await act(async()=>root!.render(shared?createElement(ConversationThread,{turns:[turn],answers:{},why:{},pending:false,question:'',onSend:async()=>{}}):createElement(RememberThisEntry,{turn})));}
it.each(['confirm','reject'])('verify-a7-remember verify-r04-proposal: shared selected-turn draft cancels without writes; proposal precedes explicit %s',async decision=>{
 const fetcher=vi.fn(async(path:unknown,_options:unknown)=>({ok:true,status:200,json:async()=>String(path).endsWith('/propose')?{transactionId,status:'PROPOSED'}:
   {transactionId,status:decision==='reject'?'REJECTED':'COMMITTED',createdObjects:[]}}));vi.stubGlobal('fetch',fetcher);
 await mount(true);expect(button('Remember this')).toBeDefined();expect(fetcher).not.toHaveBeenCalled();
 await act(async()=>button('Remember this').click());expect(document.body.textContent).toContain(turn.text);
 await act(async()=>button('Cancel draft').click());expect(fetcher).not.toHaveBeenCalled();
 await act(async()=>button('Remember this').click());await act(async()=>button('Create proposal').click());
 expect(fetcher).toHaveBeenCalledTimes(1);expect(fetcher.mock.calls[0]![0]).toBe('/api/platform/memory/transactions/propose');
 expect(JSON.parse((fetcher.mock.calls[0]![1] as RequestInit).body as string)).toEqual({selectedTurn:{conversationId:turn.conversationId,turnId:turn.id}});
 expect(document.body.textContent).toContain('Awaiting confirmation');
 await act(async()=>button(decision==='confirm'?'Confirm memory proposal':'Reject memory proposal').click());
 expect(fetcher).toHaveBeenCalledTimes(2);expect(fetcher.mock.calls[1]![0]).toBe('/api/platform/memory/transactions/'+transactionId+'/'+(decision==='confirm'?'commit':'reject'));
 const headers=(i:number)=>(fetcher.mock.calls[i]![1] as RequestInit).headers as Record<string,string>;
 expect(headers(0)['x-purpose']).toBe('memory.govern');expect(headers(1)['idempotency-key']).toBe(headers(0)['idempotency-key']);
 expect(headers(1)['x-correlation-id']).not.toBe(headers(0)['x-correlation-id']);
});
it('verify-r04-proposal: assistant turns cannot be relabelled as owner sources',async()=>{
 document.body.innerHTML='<div id="root"></div>';root=createRoot(document.getElementById('root')!);
 await act(async()=>root!.render(createElement(RememberThisEntry,{turn:{...turn,speaker:'assistant'}})));
 expect(document.querySelector('button')).toBeNull();
});
