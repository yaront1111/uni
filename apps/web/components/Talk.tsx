import React,{useEffect,useRef,useState} from 'react';
import type {ChatProps} from '../lib/chat';
import {askAnswerSchema,type VoiceSettings} from '@unai/domain';
import {LocalSpeechEngine,type SpeechEnginePort} from '../lib/speech';
import {TalkController,type TalkSnapshot} from '../lib/TalkController';
import {Shell} from './Shell';
import {AcceptedAnswerPresenter} from './AcceptedAnswerPresenter';
import {RecognitionReview} from './RecognitionReview';
import {platformWrite} from './controlWrite';
export interface TalkProps extends ChatProps {voice:VoiceSettings|null;engine?:SpeechEnginePort}
const STATES={idle:'Ready — hold to talk',listening:'Listening — release to finish',thinking:'Thinking — preparing your answer',speaking:'Speaking — Stop or Escape to interrupt',unavailable:'Unavailable — local speech could not be verified'};
export function Talk(props:TalkProps){
 const controller=useRef<TalkController|null>(null);
 const [view,setView]=useState<TalkSnapshot>({state:'unavailable',draft:null,transcript:'',dialogue:false,data:props,error:null});
 useEffect(()=>{
  let conversationId=props.conversation?.id;
  const current=new TalkController(props.engine??new LocalSpeechEngine(window),props.voice,props,async text=>{
   const value=await platformWrite('ask','memory.read',{question:text,...(conversationId?{conversationId}:{})});if(!value){current.stop();throw new Error('EXPIRED');}
   const answer=askAnswerSchema.parse(value);if(!answer.conversationId||!answer.turnId)throw new Error('ASSOCIATION');
   const response=await fetch('/api/chat?conversation='+encodeURIComponent(answer.conversationId));
   if(response.status===401){current.stop();window.location.assign('/signin?reason=expired');throw new Error('EXPIRED');}
   if(!response.ok)throw new Error('UNAVAILABLE');const data=await response.json() as ChatProps;
   if(data.error||data.conversation?.id!==answer.conversationId||!data.turns.some(t=>t.id===answer.turnId&&t.conversationId===answer.conversationId))throw new Error('ASSOCIATION');
   conversationId=answer.conversationId;return {...data,answerTurnId:answer.turnId};
  },()=>setView(current.snapshot));
  controller.current=current;void current.initialise();
  const stop=()=>current.stop();const key=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();stop();}};
  const hidden=()=>{if(document.hidden)stop();};const navigation=(event:MouseEvent)=>{if((event.target as Element).closest?.('a[href]'))stop();};
  window.addEventListener('keydown',key);window.addEventListener('pagehide',stop);window.addEventListener('popstate',stop);window.addEventListener('blur',stop);document.addEventListener('visibilitychange',hidden);document.addEventListener('click',navigation,true);
  return ()=>{current.dispose();controller.current=null;window.removeEventListener('keydown',key);window.removeEventListener('pagehide',stop);window.removeEventListener('popstate',stop);window.removeEventListener('blur',stop);document.removeEventListener('visibilitychange',hidden);document.removeEventListener('click',navigation,true);};
 },[props]);
 const unavailable=view.state==='unavailable';
 return <Shell current={null} eyebrow="TALK" title={view.data.conversation?.title??'Talk'}>
  <section aria-label="Talk controls" className="card">
   <p role="status" aria-live="polite" data-talk-state={view.state}>{STATES[view.state]}</p>
   <p>{unavailable?'Speech unavailable':'Active provider: on-device speech'}. <a href="/chat">Continue in Chat</a> · <a href="/admin/configuration">Voice settings</a></p>
   {view.error||props.error?<p role="alert">{view.error??props.error}</p>:null}
   <button type="button" disabled={unavailable||view.dialogue||!!view.draft||view.state==='speaking'||view.state==='thinking'} aria-describedby="ptt-help"
    onPointerDown={event=>{if(event.button!==0)return;event.preventDefault();event.currentTarget.setPointerCapture?.(event.pointerId);controller.current?.press();}}
    onPointerUp={()=>controller.current?.release()} onPointerCancel={()=>controller.current?.stop()} onLostPointerCapture={()=>controller.current?.release()}
    onKeyDown={event=>{if(event.key===' '||event.key==='Enter'){event.preventDefault();if(!event.repeat)controller.current?.press();}}}
    onKeyUp={event=>{if(event.key===' '||event.key==='Enter'){event.preventDefault();controller.current?.release();}}}
    onBlur={()=>{if(view.state==='listening'&&!view.dialogue)controller.current?.stop();}}>Hold to talk</button>
   <p id="ptt-help">Hold with a pointer, Space or Enter. Release to finish. Uncertain recognition is reviewed before sending.</p>
   <button type="button" onClick={()=>controller.current?.stop()}>Stop</button>
   <p>Hands-free: {view.dialogue?'active':'off'}. Stops after 30 seconds of inactivity or five minutes, and when you leave Talk.</p>
   {props.voice?.handsFreeEnabled?<button type="button" disabled={unavailable||view.dialogue||view.state!=='idle'||!!view.draft} onClick={()=>controller.current?.startDialogue()}>Start hands-free</button>:null}
  </section>
  {view.draft?<RecognitionReview draft={view.draft} onConfirm={text=>controller.current?.confirm(text)} onCancel={()=>controller.current?.stop()}/>:null}
  <section aria-label="Talk transcript"><h2>Transcript</h2>
   <ol className="conversation-turns">{view.data.turns.map(turn=><li key={turn.id} data-turn-id={turn.id}><h3>{turn.speaker==='owner'?'You':'Assistant'}</h3>
    {turn.speaker==='owner'?<p>{turn.text}</p>:<AcceptedAnswerPresenter answer={turn.status==='accepted'?view.data.answers[turn.id]??null:null} why={view.data.why[turn.id]??{}}/>}</li>)}</ol>
   {view.transcript?<p aria-live="polite">You: {view.transcript}</p>:null}
  </section>
 </Shell>;
}
