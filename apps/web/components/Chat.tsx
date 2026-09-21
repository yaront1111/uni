import React,{useEffect,useRef,useState} from 'react';
import {askAnswerSchema,persistedConversationSchema,deletionReceiptSchema} from '@unai/domain';
import type {ChatProps} from '../lib/chat';
import {Shell} from './Shell';
import {ConversationList} from './ConversationList';
import {ConversationThread} from './ConversationThread';
import {platformWrite,RefusedWrite} from './controlWrite';
import {ANSWER_FAILURE} from './AcceptedAnswerPresenter';
const REFUSED:Record<string,string>={CONTEXT_READ_DENIED:'Permission does not allow this question to be answered.',CONTEXT_ACTION_DENIED:'Permission does not allow this question to be answered.',ASK_REQUEST_INCOMPLETE:'The request is incomplete, so this question cannot be answered.',CONTEXT_REQUEST_INCOMPLETE:'The request is incomplete, so this question cannot be answered.'};
export function Chat(props:ChatProps){
 const [data,setData]=useState(props),[busy,setBusy]=useState(false),[pending,setPending]=useState(false),[question,setQuestion]=useState(''),[error,setError]=useState(props.error),[notice,setNotice]=useState('');
 const lock=useRef(false);
 useEffect(()=>{setData(props);setError(props.error);},[props]);
 async function refresh(id?:string){
  const response=await fetch('/api/chat'+(id?'?conversation='+id:''));
  if(response.status===401){window.location.assign('/signin?reason=expired');return;}
  if(!response.ok)throw new Error('UNAVAILABLE');
  const next=await response.json() as ChatProps;if(next.error)throw new Error('UNAVAILABLE');setData(next);
  window.history.replaceState(null,'',next.conversation?'/chat?conversation='+next.conversation.id:'/chat');
 }
 async function run(action:()=>Promise<void>){if(lock.current)return;lock.current=true;setBusy(true);setError(null);setNotice('');
  try{await action();}catch(caught){setError(caught instanceof RefusedWrite?REFUSED[caught.code]??ANSWER_FAILURE:ANSWER_FAILURE);}
  finally{lock.current=false;setBusy(false);setPending(false);}}
 const send=(text:string)=>run(async()=>{setQuestion(text);setPending(true);
  const result=await platformWrite('ask','memory.read',{question:text,...(data.conversation?{conversationId:data.conversation.id}:{})});if(!result)return;
  const answer=askAnswerSchema.parse(result);if(!answer.conversationId||!answer.turnId)throw new Error('ASSOCIATION');
  await refresh(answer.conversationId);
 });
 return <Shell current={null} eyebrow="CHAT" title={data.conversation?.title??'Chat'} status={busy?'Working…':notice}>
  {error?<p role="alert">{error}</p>:null}
  <div className="chat-workspace">
   <ConversationList conversations={data.conversations} selected={data.conversation?.id??null} busy={busy}
    onCreate={()=>run(async()=>{const value=await platformWrite('conversations','conversation.write',{title:'New conversation'});if(value)await refresh(persistedConversationSchema.parse(value).id);})}
    onRename={(id,title)=>run(async()=>{const value=await platformWrite('conversations/'+id,'conversation.write',{title},'PATCH');if(value){await refresh(data.conversation?.id??id);setNotice('Conversation renamed.');}})}
    onPreview={async id=>{let receipt=null;await run(async()=>{const value=await platformWrite('data/deletions/preview','data.delete',{conversationIds:[id]});if(value)receipt=deletionReceiptSchema.parse(value);});return receipt;}}
    onDelete={id=>run(async()=>{const value=await platformWrite('data/deletions','data.delete',{conversationIds:[id],confirmation:'DELETE'});if(value){const receipt=deletionReceiptSchema.parse(value);await refresh(data.conversation?.id===id?undefined:data.conversation?.id);setNotice('Conversation deleted. '+receipt.cascade.conversationTurns+' turns removed. Deletion recorded in the audit log.');}})}/>
   <ConversationThread turns={data.turns} answers={data.answers} why={data.why} pending={pending} question={question} onSend={send}/>
  </div>
 </Shell>;
}
