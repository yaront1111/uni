import React from 'react';
import type {ChatProps} from '../lib/chat';
import {EXAMPLE_QUESTIONS} from './Ask';
import {AcceptedAnswerPresenter,ANSWER_FAILURE} from './AcceptedAnswerPresenter';
import {Composer} from './Composer';
export function ConversationThread({turns,answers,why,pending,question,onSend}:{turns:ChatProps['turns'];answers:ChatProps['answers'];why:ChatProps['why'];pending:boolean;question:string;onSend:(text:string)=>Promise<void>}){
 return <section className="conversation-thread" aria-label="Conversation thread">
  {turns.length===0&&!pending?<section aria-labelledby="chat-examples"><h2 id="chat-examples">Example questions</h2><ul>{EXAMPLE_QUESTIONS.map(example=><li key={example}><button type="button" onClick={()=>void onSend(example)}>{example}</button></li>)}</ul></section>:null}
  <ol className="conversation-turns">{[...turns].sort((a,b)=>a.storedOrder-b.storedOrder).map(turn=><li key={turn.id} data-turn-id={turn.id}>
   <h3>{turn.speaker==='owner'?'You':'Assistant'}</h3>
   {turn.speaker==='owner'?<p className="turn-text">{turn.text}</p>:turn.status==='accepted'?<AcceptedAnswerPresenter answer={answers[turn.id]??null} why={why[turn.id]??{}}/>
    :<p className="notice">{turn.status==='pending'?'Answer pending…':turn.status==='failed'?ANSWER_FAILURE:turn.status==='refused'?'The answer was refused.':'No grounded support is available to answer this question.'}</p>}
  </li>)}</ol>
  {pending?<div role="status"><p className="turn-text">You: {question}</p><p>Answer pending…</p></div>:null}
  <Composer pending={pending} onSend={onSend}/>
 </section>;
}
