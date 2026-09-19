import React,{useState} from 'react';
import type {EntityMergeResult,EntitySplitResult,FrameInstanceMergeResult,FrameInstanceSplitResult,
  LineageRecord,MergeSplitReview,ProjectionRebuildReceipt,ResolvedIdentity} from '@unai/domain';
import {Navigation} from './Navigation';

/** What a merge or split will do, before it does it. */
export type MergeSplitPreview=
  |{kind:'merge';objectType:'frame_instance'|'entity';survivorId:string;mergedIds:string[]}
  |{kind:'split';objectType:'frame_instance'|'entity';targetId:string;partitions:string[];
    assignments:{objectId:string;partitionKey:string}[]};
export type MergeSplitResult=
  |{kind:'frame-merge';result:FrameInstanceMergeResult}
  |{kind:'frame-split';result:FrameInstanceSplitResult}
  |{kind:'entity-merge';result:EntityMergeResult}
  |{kind:'entity-split';result:EntitySplitResult};

export interface MergeSplitProps {
  review:MergeSplitReview;
  preview?:MergeSplitPreview|null;
  result?:MergeSplitResult|null;
  error?:string;
}

/** Outcome wording is text, never colour alone (design accessibility rule). */
const outcomeLabels:Record<MergeSplitReview['frameCandidates'][number]['matchOutcome'],string>={
  CONFIRMED_MATCH:'Confirmed match',PROBABLE_MATCH:'Probable match',POSSIBLE_MATCH:'Possible match',
  CONFIRMED_DISTINCT:'Confirmed distinct',NEW_INSTANCE:'New situation',
};
const lineageLabels:Record<LineageRecord['lineageKind'],string>={
  MERGED_INTO:'merged into',SPLIT_INTO:'split into',ALIAS_OF:'alias of',RETIRED_PARENT:'retired parent of',
  EQUIVALENT_TO:'equivalent to',CANONICAL_ALIAS_OF:'canonical alias of',
};
const objectLabels={frame_instance:'Situation',entity:'Entity',proposition:'Value'} as const;

function scoreText(components:Record<string,unknown>){
  const entries=Object.entries(components);
  return entries.length===0?'No score components recorded':entries.map(([name,value])=>name+': '+String(value)).join(', ');
}

function LineageList({records,label}:{records:LineageRecord[];label:string}){
  if(records.length===0)return null;
  return <><h3>{label}</h3><ul>{records.map(record=><li key={record.lineageId}>
    {objectLabels[record.objectType]} <code>{record.fromId}</code> {lineageLabels[record.lineageKind]} <code>{record.toId}</code>
    <small> · lineage {record.lineageId}</small>
  </li>)}</ul></>;
}

function Receipts({receipts}:{receipts:ProjectionRebuildReceipt[]}){
  return <><h3>Projection rebuild receipts</h3><ul>{receipts.map(receipt=><li key={receipt.projectionRebuildReceiptId}>
    {receipt.projectionName}: rebuilt {receipt.rowsRebuilt} {receipt.rowsRebuilt===1?'row':'rows'} after the {receipt.trigger.toLowerCase()} —{' '}
    {receipt.equalsIncremental===null?'not compared':receipt.equalsIncremental?'replay equals the maintained state':'replay differs from the maintained state'}
    <small> · version {receipt.projectionVersion}</small>
  </li>)}</ul></>;
}

function Resolution({entries}:{entries:ResolvedIdentity[]}){
  return <><h3>What each identifier resolves to now</h3><ul>{entries.map(entry=><li key={entry.objectType+entry.id}>
    <code>{entry.id}</code> ({objectLabels[entry.objectType]}, {entry.lifecycle==='ACTIVE'?'active':entry.lifecycle.toLowerCase()})
    {' '}resolves to {entry.resolvesTo.map(id=><code key={id}>{id}</code>)}
    {entry.lifecycle!=='ACTIVE'&&<span> — kept as history, never reused for anything else</span>}
  </li>)}</ul></>;
}

function ResultCard({result}:{result:MergeSplitResult}){
  const body=result.result;
  return <section className="card" aria-labelledby="merge-split-result">
    <h2 id="merge-split-result">{result.kind.endsWith('merge')?'Merge receipt':'Split receipt'}</h2>
    <p>Recorded as belief transaction <code>{body.transactionId}</code> at {body.committedAt}.</p>
    {result.kind==='frame-merge'&&<p>Survivor <code>{result.result.survivorFrameInstanceId}</code>
      {result.result.survivorCreated?' (a new situation)':''}; {result.result.merges.reduce((count,merge)=>count+merge.conflicts.length,0)===0
        ?'no competing values.':'competing values are kept side by side and marked contested.'}</p>}
    {result.kind==='entity-merge'&&<p>Survivor <code>{result.result.survivorEntityId}</code>; its aliases now include every alias of the merged entities.</p>}
    {result.kind==='frame-split'&&<>
      <p>{result.result.split.reassignedClaims.length} safely assigned {result.result.split.reassignedClaims.length===1?'claim was':'claims were'} reassigned to the new situations.</p>
      <h3>Claims that cannot be safely assigned</h3>
      {result.result.split.contestedClaims.length+result.result.split.retainedOnParentClaims.length===0
        ?<p>Every claim was assigned.</p>
        :<ul>
          {result.result.split.contestedClaims.map(claim=><li key={claim.claimId}>Claim <code>{claim.claimId}</code>: contested, still attached to the retired parent</li>)}
          {result.result.split.retainedOnParentClaims.map(claim=><li key={claim.claimId}>Claim <code>{claim.claimId}</code>: attached to the retired parent ({claim.lifecycle.toLowerCase()})</li>)}
        </ul>}
      {result.result.split.newSlots.some(slot=>slot.mixedSituations)&&<p>One earlier slot mixed separate situations; each new situation received a slot of its own.</p>}
    </>}
    {result.kind==='entity-split'&&<>
      <h3>Aliases no new entity could claim</h3>
      {result.result.split.ambiguousAliases.length===0?<p>Every alias was assigned.</p>:<ul>
        {result.result.split.ambiguousAliases.map(alias=><li key={alias.aliasId}>{alias.aliasValue}: kept on the retired entity</li>)}
      </ul>}
    </>}
    <LineageList records={body.lineage} label="Lineage records"/>
    {'propositionLineage' in body&&<LineageList records={body.propositionLineage} label="Value lineage"/>}
    <Receipts receipts={body.projectionRebuildReceipts}/>
    <Resolution entries={body.resolution}/>
  </section>;
}

function PreviewCard({preview,busy,onConfirm}:{preview:MergeSplitPreview;busy:boolean;onConfirm:()=>void}){
  const noun=preview.objectType==='entity'?'entity':'situation';
  return <section className="card" aria-labelledby="merge-split-preview">
    <h2 id="merge-split-preview">{preview.kind==='merge'?'Merge preview':'Split preview'}</h2>
    {preview.kind==='merge'?<>
      <p>The {noun} <code>{preview.survivorId}</code> survives. This lineage will be written:</p>
      <ul>{preview.mergedIds.map(id=><li key={id}><code>{id}</code> merged into <code>{preview.survivorId}</code></li>)}</ul>
      <p>The merged {noun} keeps its identifier, which resolves to the survivor from then on and is never reused. Every typed projection is rebuilt.</p>
    </>:<>
      <p>The {noun} <code>{preview.targetId}</code> is split into {preview.partitions.length} new {noun === 'entity' ? 'entities' : 'situations'}: {preview.partitions.join(', ')}.</p>
      {preview.assignments.length>0&&<ul>{preview.assignments.map(assignment=><li key={assignment.objectId}>
        <code>{assignment.objectId}</code> goes to {assignment.partitionKey}</li>)}</ul>}
      <p>{preview.objectType==='entity'
        ?'Aliases you do not assign stay on the retired entity.'
        :'Claims you do not assign cannot be safely assigned: they are left contested and attached to the retired parent.'}
        {' '}The old identifier is kept as lineage history. Every typed projection is rebuilt.</p>
    </>}
    <button disabled={busy} onClick={onConfirm}>{busy?'Recording…':preview.kind==='merge'?'Confirm merge':'Confirm split'}</button>
  </section>;
}

async function post(path:string,body:unknown){
  const response=await fetch('/api/platform/memory/'+path,{method:'POST',headers:{'content-type':'application/json',
    'x-purpose':'memory.govern','x-correlation-id':crypto.randomUUID(),'idempotency-key':crypto.randomUUID().replaceAll('-','')},
    body:JSON.stringify(body)});
  if(response.status===401){window.location.assign('/signin?reason=expired');return null;}
  if(!response.ok)throw new Error('refused');
  return response.json();
}

export function MergeSplit(props:MergeSplitProps){
  const [preview,setPreview]=useState<MergeSplitPreview|null>(props.preview??null);
  const [result,setResult]=useState<MergeSplitResult|null>(props.result??null);
  const [error,setError]=useState(props.error??'');
  const [busy,setBusy]=useState(false);
  async function confirm(){
    if(!preview)return;
    setBusy(true);setError('');
    try{
      if(preview.kind==='merge'){
        const ids=[preview.survivorId,...preview.mergedIds];
        const body=preview.objectType==='entity'?await post('entities/merge',{entityIds:ids,survivorHint:preview.survivorId})
          :await post('frame-instances/merge',{instanceIds:ids,survivorHint:preview.survivorId});
        if(body)setResult(preview.objectType==='entity'?{kind:'entity-merge',result:body}:{kind:'frame-merge',result:body});
      }else{
        const body=preview.objectType==='entity'
          ?await post('entities/'+preview.targetId+'/split',{partitions:preview.partitions.map(partitionKey=>({partitionKey})),
            aliasAssignments:preview.assignments.map(assignment=>({aliasId:assignment.objectId,partitionKey:assignment.partitionKey}))})
          :await post('frame-instances/'+preview.targetId+'/split',{targetPartitions:preview.partitions.map(partitionKey=>({partitionKey})),
            claimAssignments:preview.assignments.map(assignment=>({claimId:assignment.objectId,partitionKey:assignment.partitionKey}))});
        if(body)setResult(preview.objectType==='entity'?{kind:'entity-split',result:body}:{kind:'frame-split',result:body});
      }
      setPreview(null);
    }catch{setError('The change could not be recorded. Nothing was merged or split. Please retry.');}
    finally{setBusy(false);}
  }
  return <div className="shell">
    <a className="skip" href="#content">Skip to content</a>
    <header><a href="/" className="brand">Uai</a><span>Your personal memory</span></header>
    <Navigation current="merge-split"/>
    <main id="content" tabIndex={-1}>
      <p className="eyebrow">MEMORY</p>
      <h1>Merge and split review</h1>
      <p>Uai keeps two situations or two people apart until the evidence, or you, say they are one. Nothing here changes until you confirm a preview.</p>
      <section className="card" aria-labelledby="frame-candidates">
        <h2 id="frame-candidates">Situations the matcher compared</h2>
        {props.review.frameCandidates.length===0?<p>No candidate pairs have been recorded.</p>:
        <table><caption className="sr-only">Candidate pairs with match outcome and score components</caption>
          <thead><tr><th scope="col">Pair</th><th scope="col">Match outcome</th><th scope="col">Score components</th><th scope="col">Decision</th><th scope="col"><span className="sr-only">Review</span></th></tr></thead>
          <tbody>{props.review.frameCandidates.map(candidate=><tr key={candidate.candidateId}>
            <th scope="row"><span>{candidate.frameTypeId}</span><small>{candidate.candidateFrameInstanceId} and {candidate.resolvedFrameInstanceId}</small></th>
            <td>{outcomeLabels[candidate.matchOutcome]}{candidate.score===null?'':' (score '+candidate.score+')'}</td>
            <td>{scoreText(candidate.scoreComponents)}</td>
            <td>{candidate.keptSeparate
              ?(candidate.matchOutcome==='PROBABLE_MATCH'||candidate.matchOutcome==='POSSIBLE_MATCH'
                ?'Kept separate — a '+outcomeLabels[candidate.matchOutcome].toLowerCase()+' never reuses a situation for a material accepted update'
                :'Kept separate')
              :'Reused the existing situation (confirmed match)'}</td>
            <td>{candidate.keptSeparate&&candidate.candidateFrameInstanceId&&candidate.resolvedFrameInstanceId&&
              candidate.candidateFrameInstanceId!==candidate.resolvedFrameInstanceId&&
              <button onClick={()=>setPreview({kind:'merge',objectType:'frame_instance',survivorId:candidate.candidateFrameInstanceId!,
                mergedIds:[candidate.resolvedFrameInstanceId!]})}>Preview merge<span className="sr-only"> of {candidate.frameTypeId} pair</span></button>}</td>
          </tr>)}</tbody>
        </table>}
      </section>
      <section className="card" aria-labelledby="entity-candidates">
        <h2 id="entity-candidates">People and things that share a name</h2>
        {props.review.entityCandidates.length===0?<p>No two entities share a name.</p>:
        <ul className="devices">{props.review.entityCandidates.map(group=><li key={group.entityKind+group.sharedAlias}>
          <div>
            <strong>{group.sharedAlias}</strong>
            <p>{group.entityIds.length} separate {group.entityKind.toLowerCase()} entities kept apart: a shared name is not sufficient evidence that they are one.</p>
            <small>{group.entityIds.join(', ')}</small>
          </div>
          <button onClick={()=>setPreview({kind:'merge',objectType:'entity',survivorId:group.entityIds[0]!,mergedIds:group.entityIds.slice(1)})}>
            Preview merge<span className="sr-only"> of the entities named {group.sharedAlias}</span></button>
        </li>)}</ul>}
      </section>
      <section className="card" aria-labelledby="split-form">
        <h2 id="split-form">Split something that was combined</h2>
        <form onSubmit={event=>{
          event.preventDefault();
          const data=new FormData(event.currentTarget);
          const partitions=String(data.get('partitions')??'').split(',').map(value=>value.trim()).filter(Boolean);
          const assignments=String(data.get('assignments')??'').split('\n').map(line=>line.trim()).filter(Boolean).map(line=>{
            const [objectId='',partitionKey='']=line.split('=').map(part=>part.trim());
            return {objectId,partitionKey};
          });
          setPreview({kind:'split',objectType:data.get('objectType')==='entity'?'entity':'frame_instance',
            targetId:String(data.get('targetId')??'').trim(),partitions,assignments});
        }}>
          <label htmlFor="split-object-type">What to split</label>
          <select id="split-object-type" name="objectType" defaultValue="frame_instance">
            <option value="frame_instance">A situation, such as an obligation</option>
            <option value="entity">A person or other entity</option>
          </select>
          <label htmlFor="split-target">Identifier to split</label>
          <input id="split-target" name="targetId" required/>
          <label htmlFor="split-partitions">New parts, separated by commas</label>
          <input id="split-partitions" name="partitions" required placeholder="concert, dinner"/>
          <label htmlFor="split-assignments">Assignments, one per line as identifier=part (claims for a situation, aliases for an entity)</label>
          <textarea id="split-assignments" name="assignments" rows={4}/>
          <button type="submit">Preview split</button>
        </form>
      </section>
      {preview&&<PreviewCard preview={preview} busy={busy} onConfirm={()=>void confirm()}/>}
      <div role="status" aria-live="polite">{result&&<ResultCard result={result}/>}</div>
      <section className="card" aria-labelledby="recent-lineage">
        <h2 id="recent-lineage">Recent lineage</h2>
        {props.review.recentLineage.length===0?<p>Nothing has been merged or split yet.</p>:
          <LineageList records={props.review.recentLineage} label="Old identifiers and where they went"/>}
      </section>
      {error&&<p role="alert">{error}</p>}
    </main>
    <footer>Merge and split are recorded as governed changes. Old identifiers stay resolvable and are never reused.</footer>
  </div>;
}
