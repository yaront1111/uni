// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {act,createElement} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import axe from 'axe-core';
import {cascadeCountsSchema} from '@unai/domain';
import {Chat} from './Chat';
import {Composer} from './Composer';
import {chatFixture} from './testing/chat';
import {KeyboardUser,accessibleName} from './testing/keyboard';
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root|null=null;
afterEach(()=>{act(()=>root?.unmount());root=null;document.body.innerHTML='';vi.unstubAllGlobals();vi.restoreAllMocks();});
async function mount(element:React.ReactElement){document.documentElement.lang='en';document.title='Chat';document.body.innerHTML='<div id="root"></div>';root=createRoot(document.getElementById('root')!);await act(async()=>root!.render(element));}
async function press(user:KeyboardUser,name:RegExp){expect(user.tabTo(e=>name.test(accessibleName(e)))).not.toBeNull();await act(async()=>user.press('Enter'));}
it('verify-b1-keys: Keyboard tests verify Enter submits, Shift+Enter adds a newline without submission, and focus is in the composer after send.',async()=>{
 const send=vi.fn(async()=>{});await mount(createElement(Composer,{pending:false,onSend:send}));const user=new KeyboardUser(document);
 expect(user.tabTo(e=>e.tagName==='TEXTAREA')).not.toBeNull();await act(async()=>user.type('First line'));
 const field=document.querySelector('textarea')!;
 const newline=new KeyboardEvent('keydown',{key:'Enter',shiftKey:true,bubbles:true,cancelable:true});
 await act(async()=>{field.dispatchEvent(newline);if(!newline.defaultPrevented)user.type(field.value+'\n');});
 expect(field.value).toBe('First line\n');expect(send).not.toHaveBeenCalled();
 await act(async()=>user.type(field.value+'Second line'));await act(async()=>user.press('Enter'));
 expect(send).toHaveBeenCalledExactlyOnceWith('First line\nSecond line');expect(document.activeElement).toBe(field);expect(field.value).toBe('');
});
it('verify-b2-pending: With an unresolved answer request the thread visibly indicates that the turn is pending.',async()=>{
 let resolve!:(value:unknown)=>void;const fetcher=vi.fn(()=>new Promise(r=>{resolve=r;}));vi.stubGlobal('fetch',fetcher);
 await mount(createElement(Chat,chatFixture()));const user=new KeyboardUser(document);user.tabTo(e=>e.tagName==='TEXTAREA');await act(async()=>user.type('Follow up'));await act(async()=>user.press('Enter'));
 expect(document.body.textContent).toContain('Answer pending');expect(document.activeElement?.tagName).toBe('TEXTAREA');
 await act(async()=>user.press('Enter'));expect(fetcher).toHaveBeenCalledTimes(1);
 await act(async()=>resolve({ok:false,status:503,json:async()=>({code:'SECRET ERROR'})}));
 expect(document.body.textContent).not.toContain('Answer pending');expect(document.body.textContent).toContain('The question could not be answered. Please retry.');expect(document.body.textContent).not.toContain('SECRET ERROR');
});
it('verify-b2-failure: A failed request renders the fixed failure message rather than raw exception content.',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>{throw new Error('private token and traceback');}));await mount(createElement(Chat,chatFixture()));const user=new KeyboardUser(document);
 user.tabTo(e=>e.tagName==='TEXTAREA');await act(async()=>user.type('Question'));await act(async()=>user.press('Enter'));
 expect(document.querySelector('[role=alert]')?.textContent).toBe('The question could not be answered. Please retry.');expect(document.body.textContent).not.toContain('private token');
});
it('opens each turn’s own explanation even when both answers use statement S1',async()=>{
 const props=chatFixture(),first=props.turns[1]!,second={...first,id:'00000000-0000-4000-8000-000000000007',storedOrder:3};props.turns.push(second);
 props.answers[second.id]={...props.answers[first.id]!,turnId:second.id};props.why[second.id]={S1:{...props.why[first.id]!.S1!,statement:'Explanation unique to the second turn'}};
 await mount(createElement(Chat,props));
 for(const [id,text] of [[first.id,'commitment action description: send Daniel'],[second.id,'Explanation unique to the second turn']]){
  const user=new KeyboardUser(document);expect(user.tabTo(e=>e.tagName==='SUMMARY'&&e.closest('[data-turn-id]')?.getAttribute('data-turn-id')===id)).not.toBeNull();await act(async()=>user.press('Enter'));
  const panel=document.querySelector('[data-turn-id="'+id+'"] details.why')!;expect(panel.hasAttribute('open')).toBe(true);expect(panel.textContent).toContain(text);
 }
});
it.each([320,640])('sources and composer stay keyboard operable at %i CSS px (640px models doubled zoom on 1280px)',async width=>{
 const fixture=chatFixture();const fetcher=vi.fn(async(path:string)=>({ok:true,status:200,json:async()=>path==='/api/platform/ask'?fixture.answers[fixture.turns[1]!.id]:fixture}));vi.stubGlobal('fetch',fetcher);
 Object.defineProperty(window,'innerWidth',{configurable:true,value:width});await mount(createElement(Chat,chatFixture()));const user=new KeyboardUser(document);
 await press(user,/Why\? \/ Sources/);expect(document.querySelector('details.why')?.hasAttribute('open')).toBe(true);
 expect(user.tabTo(e=>e.tagName==='TEXTAREA')).not.toBeNull();await act(async()=>user.type('Readable question'));expect(document.querySelector('textarea')?.value).toBe('Readable question');
 await press(user,/^Send$/);expect(fetcher).toHaveBeenCalledWith('/api/platform/ask',expect.objectContaining({body:JSON.stringify({question:'Readable question',conversationId:fixture.conversation!.id})}));
 expect(document.activeElement?.tagName).toBe('TEXTAREA');
 const result=await axe.run(document,{rules:{'color-contrast':{enabled:false}}});expect(result.violations.map(v=>v.id)).toEqual([]);
});
it('operates create, first send, rename and confirmed deletion through all real Chat controls',async()=>{
 let data=chatFixture();const newId='00000000-0000-4000-8000-000000000008';
 const fetcher=vi.fn(async(path:string,options?:RequestInit)=>{
  const body=options?.body?JSON.parse(String(options.body)):{};let result:unknown={};
  if(path==='/api/platform/conversations'){
   const conversation={...data.conversation!,id:newId,title:body.title};data={...data,conversation,conversations:[conversation,...data.conversations],turns:[],answers:{},why:{}};result=conversation;
  }else if(path.startsWith('/api/platform/conversations/')){data.conversation!.title=body.title;result=data.conversation;
  }else if(path==='/api/platform/ask'){
   expect(body).toEqual({question:'First turn',conversationId:newId});const fixture=chatFixture();const answer={...fixture.answers[fixture.turns[1]!.id]!,conversationId:newId};
   data={...data,turns:fixture.turns.map(t=>({...t,conversationId:newId})),answers:{[answer.turnId!]:answer},why:fixture.why};result=answer;
  }else if(path.startsWith('/api/platform/data/deletions')){
   const cascade=cascadeCountsSchema.parse(Object.fromEntries(Object.keys(cascadeCountsSchema.shape).map(key=>[key,key==='conversations'?1:key==='conversationTurns'?2:0])));
   result={requestId:null,status:'PREVIEW',trigger:'OWNER_REQUEST',evidenceIds:[],conversationIds:[newId],cascade,projectionsRebuilt:[],auditRetainsPayload:false};
   if(!path.endsWith('preview')){expect(body).toEqual({conversationIds:[newId],confirmation:'DELETE'});result={...result as object,status:'COMPLETED',requestId:newId};data={...data,conversations:[],conversation:null,turns:[],answers:{},why:{}};}
  }else if(path.startsWith('/api/chat'))result=data;else throw new Error('Unexpected route '+path);
  return {ok:true,status:200,json:async()=>structuredClone(result)};
 });vi.stubGlobal('fetch',fetcher);await mount(createElement(Chat,data));
 await press(new KeyboardUser(document),/^New conversation$/);expect(document.body.textContent).toContain('Example questions');
 let user=new KeyboardUser(document);user.tabTo(e=>e.tagName==='TEXTAREA');await act(async()=>user.type('First turn'));await act(async()=>user.press('Enter'));expect(document.activeElement?.tagName).toBe('TEXTAREA');
 await press(new KeyboardUser(document),/^Rename New conversation$/);user=new KeyboardUser(document);user.tabTo(e=>e.tagName==='INPUT'&&e.id.startsWith('title-'));await act(async()=>user.type('Changed title'));
 await press(new KeyboardUser(document),/^Save title$/);expect(document.querySelector('h1')?.textContent).toBe('Changed title');
 await press(new KeyboardUser(document),/^Delete Changed title$/);expect(document.body.textContent).toContain('2 turns');
 expect(fetcher.mock.calls.filter(c=>c[0]==='/api/platform/data/deletions')).toHaveLength(0);
 user=new KeyboardUser(document);user.tabTo(e=>e.id==='chat-delete-confirmation');await act(async()=>user.type('DELETE'));await press(new KeyboardUser(document),/^Confirm deletion$/);
 expect(document.body.textContent).toContain('Conversation deleted. 2 turns removed.');expect(document.querySelector('.conversation-list')?.textContent).not.toContain('Changed title');
 const writes=fetcher.mock.calls.filter(c=>c[1]);const correlations=writes.map(c=>(c[1]!.headers as Record<string,string>)['x-correlation-id']);expect(new Set(correlations).size).toBe(writes.length);
});
