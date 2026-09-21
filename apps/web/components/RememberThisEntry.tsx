import React,{useRef,useState} from 'react';
import type {ConversationTurn} from '@unai/domain';
export function RememberThisEntry({turn}:{turn:ConversationTurn}){
  const [state,setState]=useState<'closed'|'draft'|'proposed'|'confirmed'|'rejected'>('closed');
  const [transaction,setTransaction]=useState<string|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  const running=useRef(false),key=useRef<string|null>(null);
  if(turn.speaker!=='owner'||turn.status!=='accepted'||!turn.text)return null;
  async function action(operation:'propose'|'commit'|'reject'){
    if(running.current)return;running.current=true;setBusy(true);setError(null);
    try{
      key.current??=crypto.randomUUID().replaceAll('-','');
      const path=operation==='propose'?'propose':transaction+'/'+operation;
      const response=await fetch('/api/platform/memory/transactions/'+path,{method:'POST',headers:{'content-type':'application/json',
        'x-purpose':'memory.govern','x-correlation-id':crypto.randomUUID(),'idempotency-key':key.current},
        body:JSON.stringify(operation==='propose'?{selectedTurn:{conversationId:turn.conversationId,turnId:turn.id}}:{})});
      if(response.status===401){window.location.assign('/signin?reason=expired');return;}
      if(!response.ok)throw new Error('UNAVAILABLE');
      const result=await response.json() as {transactionId:string;status?:string;createdObjects?:unknown[]};
      if(!/^[0-9a-f-]{36}$/i.test(result.transactionId)||(transaction&&result.transactionId!==transaction))throw new Error('INVALID');
      if(operation==='propose'){
        setTransaction(result.transactionId);
        if(result.status==='COMMITTED')setState('confirmed');
        else if(result.status==='REJECTED')setState('rejected');
        else if(result.status==='PROPOSED'||result.status==='VALIDATED')setState('proposed');
        else throw new Error('INVALID');
      }else if(operation==='reject'&&result.status==='REJECTED')setState('rejected');
      else if(operation==='commit'&&Array.isArray(result.createdObjects))setState('confirmed');
      else throw new Error('INVALID');
    }catch{setError('The memory request could not be completed. Retry or check the proposal inbox.');}
    finally{running.current=false;setBusy(false);}
  }
  return <div className="remember-this">
    {state==='closed'?<button type="button" onClick={()=>{setState('draft');setError(null);}}>Remember this</button>:
      <section aria-label="Remember this statement"><blockquote>{turn.text}</blockquote>
        {state==='draft'&&<><p>Creating a proposal saves your selected words as its source. Memory changes only when you confirm.</p>
          <button type="button" disabled={busy} onClick={()=>void action('propose')}>Create proposal</button>
          <button type="button" disabled={busy} onClick={()=>{setState('closed');key.current=null;setError(null);}}>Cancel draft</button></>}
        {state==='proposed'&&<><p role="status">Awaiting confirmation. This will store an unverified statement awaiting interpretation, without treating it as a verified fact.</p>
          <button type="button" disabled={busy} onClick={()=>void action('commit')}>Confirm memory proposal</button>
          <button type="button" disabled={busy} onClick={()=>void action('reject')}>Reject memory proposal</button>
          <a href="/admin/memory#memory-proposals">Review later in proposal inbox</a></>}
        {state==='confirmed'&&<p role="status">Memory proposal confirmed. Your statement is stored as a candidate awaiting interpretation. Transaction receipt: {transaction}</p>}
        {state==='rejected'&&<p role="status">Proposal rejected. No memory was changed.</p>}
        {busy&&<p role="status">Saving your decision…</p>}
        {error&&<p role="alert">{error}</p>}
      </section>}
  </div>;
}
