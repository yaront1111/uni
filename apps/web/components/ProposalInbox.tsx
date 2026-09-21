import React,{useRef,useState} from 'react';
import type {PendingProposal} from '../lib/memory-proposals';
export function ProposalInbox({proposals,atLimit=false}:{proposals:PendingProposal[];atLimit?:boolean}) {
  const [selected,setSelected]=useState<string[]>([]),[review,setReview]=useState<'commit'|'reject'|null>(null);
  const [outcomes,setOutcomes]=useState<Record<string,string>>({}),[busy,setBusy]=useState(false);
  const running=useRef(false);
  const pending=proposals.filter(p=>!['Confirmed','Rejected'].includes(outcomes[p.transactionId]??''));
  async function decide(){
    if(running.current||!review)return;running.current=true;setBusy(true);
    const action=review;
    try{
      for(const proposal of pending.filter(p=>selected.includes(p.transactionId))){
        try{
          const response=await fetch('/api/platform/memory/transactions/'+proposal.transactionId+'/'+action,{method:'POST',
            headers:{'content-type':'application/json','x-purpose':'memory.govern','x-correlation-id':crypto.randomUUID(),
              // The governor deliberately requires the proposal's key at settlement.
              'idempotency-key':proposal.idempotencyKey},body:'{}'});
          if(response.status===401){window.location.assign('/signin?reason=expired');return;}
          if(!response.ok)throw new Error('UNAVAILABLE');
          setOutcomes(previous=>({...previous,[proposal.transactionId]:action==='commit'?'Confirmed':'Rejected'}));
        }catch{setOutcomes(previous=>({...previous,[proposal.transactionId]:'Decision failed. Reload to check its state before retrying.'}));}
      }
      setReview(null);setSelected([]);
    }finally{running.current=false;setBusy(false);}
  }
  return <section id="memory-proposals" aria-labelledby="memory-proposals-heading"><h2 id="memory-proposals-heading">Proposal inbox</h2>
    {atLimit&&<p>Showing the first 100 pending proposals. Reload after reviewing these to see more.</p>}
    {!pending.length&&<p>No pending proposals in this view.</p>}
    <ul>{pending.map(proposal=><li key={proposal.transactionId}>
      <label><input type="checkbox" checked={selected.includes(proposal.transactionId)} disabled={busy||review!==null}
        onChange={event=>setSelected(previous=>event.target.checked?[...previous,proposal.transactionId]:previous.filter(id=>id!==proposal.transactionId))}/>
        {proposal.transactionKind} — {proposal.transactionId}</label>
      <p>{proposal.status}; risk: {proposal.risk}; proposed {proposal.proposedAt}</p>
      {proposal.sources.map(source=><p key={source.sourceAnchorId}><q>{source.text??'Source text unavailable'}</q>{' '}<a href={'/evidence/'+source.evidenceId}>Open supporting source</a></p>)}
      <details><summary>Review proposed changes</summary><pre>{JSON.stringify(proposal.operations,null,2)}</pre></details>
    </li>)}</ul>
    {Object.entries(outcomes).map(([id,outcome])=><p key={id} role="status">{id}: {outcome}</p>)}
    {review?<div role="group" aria-label="Batch review"><p>{review==='commit'?'Confirm':'Reject'} {selected.length} selected proposals?</p>
      <p>Confirmation runs existing belief validation. Rejection settles proposals without changing committed memories.</p>
      <button type="button" disabled={busy} onClick={()=>void decide()}>{review==='commit'?'Confirm selected proposals':'Reject selected proposals'}</button>
      <button type="button" disabled={busy} onClick={()=>setReview(null)}>Cancel review</button>
    </div>:<><button type="button" disabled={!selected.length||busy} onClick={()=>setReview('commit')}>Review confirmation</button>
      <button type="button" disabled={!selected.length||busy} onClick={()=>setReview('reject')}>Review rejection</button></>}
    {busy&&<p role="status">Applying proposal decisions…</p>}
  </section>;
}
