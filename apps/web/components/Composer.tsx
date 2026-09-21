import React,{useRef,useState} from 'react';
export function Composer({pending,onSend}:{pending:boolean;onSend:(text:string)=>Promise<void>}){
 const [text,setText]=useState('');const field=useRef<HTMLTextAreaElement>(null);const sending=useRef(false);
 async function send(){if(pending||sending.current||!text.trim())return;sending.current=true;const question=text.trim();setText('');field.current?.focus();
  try{await onSend(question);}finally{sending.current=false;field.current?.focus();}}
 return <form className="composer" onSubmit={event=>{event.preventDefault();void send();}}>
  <label htmlFor="chat-message">Your message</label>
  <textarea ref={field} id="chat-message" rows={4} maxLength={2000} value={text} onChange={e=>setText(e.target.value)} aria-describedby="composer-help"
   onKeyDown={event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.nativeEvent.isComposing){event.preventDefault();void send();}}}/>
  <p id="composer-help">Enter to send. Shift+Enter for a new line.</p>
  <button type="submit" disabled={pending||!text.trim()}>Send</button>
 </form>;
}
