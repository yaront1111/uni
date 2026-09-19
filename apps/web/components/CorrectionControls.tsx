import React,{useRef,useState} from 'react';
import type {MemoryInspector,MemoryOperationKind,PublicOverlayDelta,TargetObjectRef} from '@unai/domain';
import {inspectorHref} from './BeliefLinks';
import {personName} from './Commitments';
import {MemoryPage,Status,dateText,predicateText,valueText} from './MemoryChrome';

/**
 * The design's Correction controls screen (journey J5; PRD §20.2, §37.3).
 *
 * Ten controls, each separately labelled and separately reachable, each saying
 * what it will change before it is used, and each posting to its own endpoint so
 * it persists its own `memory_operations` kind (CRT-UX-10-A). Suppress, archive
 * and delete are three endpoints, never one with a flag. There is no "edit
 * memory" anywhere on this screen.
 */
export type ControlKey='correct'|'changed'|'confirm'|'reject'|'keep-uncertain'|'suppress'|'archive'|'delete'|'merge'|'split';
export interface Control{key:ControlKey;label:string;operationKind:MemoryOperationKind;endpoint:string;purpose:'memory.correct'|'memory.govern';
  button:string;preview:string}

/** One entry per control. The endpoint and the operation kind travel together so
 * a test can check that no two controls share either. */
export const CONTROLS:readonly Control[]=Object.freeze([
  {key:'correct',label:'Correct',operationKind:'CORRECT',endpoint:'memory/corrections',purpose:'memory.correct',button:'Record the correction',
    preview:'Says the earlier information was wrong for the same period. Your words are stored as new evidence and a correction for that same period is proposed. Nothing already stored is edited.'},
  {key:'changed',label:'Changed',operationKind:'CHANGED',endpoint:'memory/state-changes',purpose:'memory.correct',button:'Record the change',
    preview:'Says the earlier information was true and later changed. The earlier value keeps the period it covered, and a second, non-overlapping period starts on the date you give.'},
  {key:'confirm',label:'Confirm',operationKind:'CONFIRM',endpoint:'memory/confirmations',purpose:'memory.correct',button:'Confirm it',
    preview:'Adds a new confirmation of yours. The original statement, and who made it, stay exactly as they were.'},
  {key:'reject',label:'Reject',operationKind:'REJECT',endpoint:'memory/rejections',purpose:'memory.correct',button:'Reject this interpretation',
    preview:'Rejects this reading. The evidence it was read from is kept; only this interpretation of it is refused.'},
  {key:'keep-uncertain',label:'Keep uncertain',operationKind:'KEEP_UNCERTAIN',endpoint:'memory/keep-uncertain',purpose:'memory.correct',button:'Keep it uncertain',
    preview:'Keeps this exactly as it is, without deciding, and stops asking you about it for the suppression window.'},
  {key:'suppress',label:'Suppress',operationKind:'SUPPRESS',endpoint:'memory/suppressions',purpose:'memory.correct',button:'Suppress it',
    preview:'Stops Uai using this in normal answers and briefings on all your devices. Its history is kept and you can still inspect it.'},
  {key:'archive',label:'Archive',operationKind:'ARCHIVE',endpoint:'memory/archives',purpose:'memory.correct',button:'Archive it',
    preview:'Keeps this for explicit historical lookups only, with reduced prominence. Nothing is removed, and it is not hidden the way a suppression is.'},
  {key:'delete',label:'Delete',operationKind:'DELETE',endpoint:'memory/deletions',purpose:'memory.correct',button:'Delete it',
    preview:'Starts the deletion workflow: it disappears from every device\'s next read at once, and it and what was derived from it are then deleted. This cannot be undone.'},
  {key:'merge',label:'Merge',operationKind:'MERGE',endpoint:'memory/frame-instances/merge',purpose:'memory.govern',button:'Merge them',
    preview:'Says this and another situation, or two people, are one. This one survives with both histories; the other identifier keeps resolving to it and is never reused. Every projection is rebuilt.'},
  {key:'split',label:'Split',operationKind:'SPLIT',endpoint:'memory/frame-instances/{id}/split',purpose:'memory.govern',button:'Split it',
    preview:'Says this situation mixed separate ones. Statements you assign move to the new situations; any you leave stay on the original, marked contested. Every projection is rebuilt.'},
]);

export interface CorrectionReceipt{control:ControlKey;operationKind:MemoryOperationKind;memoryOperationId:string|null;
  ownerSequence:number|null;proposedTransactionId:string|null;transactionId:string|null}
export interface CorrectionControlsProps{
  state:'ready'|'not-found'|'error';
  inspector:MemoryInspector|null;
  receipt?:CorrectionReceipt|null;
  error?:string|null;
}

const LIFECYCLE:Record<string,string>={RECEIVED:'received',USER_ASSERTED:'recorded as your statement',
  AWAITING_INSTANCE_RESOLUTION:'waiting to be matched to a situation',CANONICALIZATION_PENDING:'being taken up',
  COMMITTED:'taken up into memory',CONTESTED:'contested',REJECTED_AS_INTERPRETATION:'rejected as an interpretation',
  WITHDRAWN:'withdrawn',SUPERSEDED:'superseded'};

/** A delta's contest record, in words: the failure, the conflicting evidence,
 * the projections it affects and the answers that contained it. */
function Contest({delta}:{delta:PublicOverlayDelta}){
  const reason=delta.contestedReason??{};
  const list=(key:string)=>Array.isArray(reason[key])?(reason[key] as unknown[]).length:0;
  const failure=typeof reason.failureReason==='string'?reason.failureReason:typeof reason.code==='string'?reason.code:null;
  return <div className="contest">
    <p><Status kind="contested"/> Something later disagreed with this. It is shown as contested; what you said was not reversed and is still here.</p>
    <ul>
      <li>Why: {failure?failure.toLowerCase().replaceAll('_',' '):'no reason code recorded'}</li>
      <li>Conflicting evidence: {list('conflictingEvidenceIds')}</li>
      <li>Affected projections: {Array.isArray(reason.affectedProjections)?(reason.affectedProjections as unknown[]).map(String).join(', ')||'none':'none'}</li>
      <li>Answers that contained it: {list('containingManifestIds')}</li>
    </ul>
  </div>;
}

function Earlier({deltas}:{deltas:PublicOverlayDelta[]}){
  if(deltas.length===0)return <p>You have not corrected this belief yet.</p>;
  return <ul>{deltas.map(delta=><li key={delta.overlayDeltaId}>
    “{delta.rawText}” — {delta.deltaKind.toLowerCase().replaceAll('_',' ')}, owner sequence {delta.ownerSequence}, {LIFECYCLE[delta.lifecycle]??delta.lifecycle}
    {' '}({dateText(delta.createdAt)}).
    {delta.independentVerification.verified?' Independently corroborated.':' Your statement; not independently verified.'}
    {delta.lifecycle==='CONTESTED'&&<Contest delta={delta}/>}
  </li>)}</ul>;
}

function Receipt({receipt}:{receipt:CorrectionReceipt}){
  const control=CONTROLS.find(entry=>entry.key===receipt.control)!;
  return <section className="card" aria-labelledby="receipt">
    <h2 id="receipt">{control.label}: recorded</h2>
    <p>Recorded as a {control.label} operation ({receipt.operationKind.toLowerCase().replaceAll('_',' ')}).
      {receipt.ownerSequence!==null&&<> Owner sequence {receipt.ownerSequence}.</>}</p>
    <p>No existing row was changed: your words were stored as new evidence
      {receipt.proposedTransactionId?' and a change was proposed for review':receipt.transactionId?' and the change was committed as a governed transaction':''}.</p>
    <p>Your other devices see this on their very next read.</p>
  </section>;
}

async function send(control:Control,path:string,body:unknown,key:string){
  const response=await fetch('/api/platform/'+path,{method:'POST',headers:{'content-type':'application/json','x-purpose':control.purpose,
    'x-correlation-id':crypto.randomUUID(),'idempotency-key':key},body:JSON.stringify(body)});
  if(response.status===401){window.location.assign('/signin?reason=expired');return null;}
  if(!response.ok)throw new Error('refused');
  return response.json() as Promise<Record<string,unknown>>;
}

function Fields({control,inspector}:{control:Control;inspector:MemoryInspector}){
  const id=(name:string)=>'control-'+control.key+'-'+name;
  const x=inspector.explanation;
  switch(control.key){
    case 'correct':return <>
      <label htmlFor={id('value')}>What it should have been</label><input id={id('value')} name="value" required/>
      <label htmlFor={id('text')}>In your words</label><input id={id('text')} name="rawText" required placeholder="It was always ILS 60, not ILS 50"/></>;
    case 'changed':return <>
      <label htmlFor={id('value')}>What it is now</label><input id={id('value')} name="value" required/>
      <label htmlFor={id('from')}>Changed on</label><input id={id('from')} name="from" type="date" required/>
      <label htmlFor={id('text')}>In your words</label><input id={id('text')} name="rawText" required placeholder="It went up to ILS 60 in March"/></>;
    case 'confirm':return <><label htmlFor={id('text')}>Your confirmation</label>
      <input id={id('text')} name="rawText" required defaultValue="Yes, that is right"/></>;
    case 'reject':return <><label htmlFor={id('text')}>Why this reading is wrong</label><input id={id('text')} name="rawText" required/></>;
    case 'keep-uncertain':case 'archive':return <><label htmlFor={id('text')}>Note (optional)</label><input id={id('text')} name="rawText"/></>;
    case 'suppress':case 'delete':return <>
      <label htmlFor={id('scope')}>What to include</label>
      <select id={id('scope')} name="scope" defaultValue="OBJECT"><option value="OBJECT">Only this</option>
        <option value="OBJECT_AND_DERIVATIVES">This and what was derived from it</option></select>
      {control.key==='delete'&&<><label htmlFor={id('confirm')}>Type DELETE to confirm</label>
        <input id={id('confirm')} name="confirmation" required pattern="DELETE"/></>}
      <label htmlFor={id('text')}>Note (optional)</label><input id={id('text')} name="rawText"/></>;
    case 'merge':return <>
      <label htmlFor={id('subject')}>What to merge</label>
      <select id={id('subject')} name="subject" defaultValue={'frame_instance:'+x.frameInstanceId}>
        <option value={'frame_instance:'+x.frameInstanceId}>This situation ({predicateText(x.frameTypeId)})</option>
        {inspector.assertingActors.map(actor=><option key={actor.entityId} value={'entity:'+actor.entityId}>{personName(actor)}</option>)}
      </select>
      <label htmlFor={id('other')}>Identifier of the other one (from its inspector's Advanced panel)</label>
      <input id={id('other')} name="other" required pattern="[0-9a-fA-F-]{36}"/>
      <label htmlFor={id('text')}>Why they are one</label><input id={id('text')} name="rawText"/></>;
    case 'split':return <>
      <label htmlFor={id('parts')}>New situations, separated by commas</label>
      <input id={id('parts')} name="parts" required placeholder="concert, dinner"/>
      <fieldset><legend>Which situation each statement belongs to (leave blank to keep it on this one, contested)</legend>
        {x.claims.map((claim,index)=><React.Fragment key={claim.claimId}>
          <label htmlFor={id('claim-'+index)}>Statement {index+1}, recorded {dateText(claim.recordedAt)}</label>
          <input id={id('claim-'+index)} name={'claim:'+claim.claimId}/></React.Fragment>)}
      </fieldset>
      <p className="muted">To split a person into two, use <a href="/memory/merge-split">Merge and split review</a>.</p></>;
  }
}

/** The request each control sends, built from its own form and nothing shared. */
export function requestFor(control:Control,inspector:MemoryInspector,data:Map<string,string>):{path:string;body:Record<string,unknown>}{
  const target:TargetObjectRef=inspector.subject.correctionTarget;
  const text=(data.get('rawText')??'').trim();
  const optional=text===''?{}:{rawText:text};
  switch(control.key){
    case 'correct':return {path:control.endpoint,body:{target,correctedValue:data.get('value'),rawText:text}};
    case 'changed':return {path:control.endpoint,body:{target,newValue:data.get('value'),
      changeEffectiveFrom:new Date(data.get('from')??'').toISOString(),rawText:text}};
    case 'confirm':return {path:control.endpoint,body:{target,confirmedText:text}};
    case 'reject':return {path:control.endpoint,body:{target,reason:text}};
    case 'keep-uncertain':case 'archive':return {path:control.endpoint,body:{target,...optional}};
    case 'suppress':return {path:control.endpoint,body:{target,scope:data.get('scope')??'OBJECT',...optional}};
    case 'delete':return {path:control.endpoint,body:{target,scope:data.get('scope')??'OBJECT',confirmation:data.get('confirmation'),...optional}};
    case 'merge':{
      const [kind,id]=(data.get('subject')??'').split(':');
      const other=(data.get('other')??'').trim().toLowerCase();
      const reason=text===''?{}:{reason:text};
      return kind==='entity'
        ?{path:'memory/entities/merge',body:{entityIds:[id,other],survivorHint:id,...reason}}
        :{path:control.endpoint,body:{instanceIds:[id,other],survivorHint:id,...reason}};
    }
    case 'split':{
      const parts=(data.get('parts')??'').split(',').map(part=>part.trim()).filter(Boolean);
      const claimAssignments=[...data].filter(([name,value])=>name.startsWith('claim:')&&value.trim()!=='')
        .map(([name,value])=>({claimId:name.slice('claim:'.length),partitionKey:value.trim()}));
      return {path:control.endpoint.replace('{id}',inspector.explanation.frameInstanceId),
        body:{targetPartitions:parts.map(partitionKey=>({partitionKey})),claimAssignments}};
    }
  }
}

function ControlSection({control,inspector,busy,onSubmit}:{control:Control;inspector:MemoryInspector;busy:boolean;
  onSubmit:(control:Control,data:Map<string,string>)=>void}){
  return <section className="card control" aria-labelledby={'control-'+control.key}>
    <h3 id={'control-'+control.key}>{control.label}</h3>
    <p id={'control-'+control.key+'-preview'}><strong>What this will change:</strong> {control.preview}</p>
    <form aria-describedby={'control-'+control.key+'-preview'} onSubmit={event=>{
      event.preventDefault();
      const data=new Map<string,string>();
      new FormData(event.currentTarget).forEach((value,name)=>data.set(name,String(value)));
      onSubmit(control,data);
    }}>
      <Fields control={control} inspector={inspector}/>
      <button type="submit" disabled={busy}>{control.button}</button>
    </form>
  </section>;
}

function Controls({inspector,initialReceipt,initialError}:{inspector:MemoryInspector;initialReceipt:CorrectionReceipt|null;initialError:string}){
  const [receipt,setReceipt]=useState<CorrectionReceipt|null>(initialReceipt);
  const [error,setError]=useState(initialError);
  const [busy,setBusy]=useState(false);
  // One idempotency key per control until it succeeds, so a retry after a lost
  // answer is the same write rather than a second one.
  const keys=useRef(new Map<ControlKey,string>());
  const x=inspector.explanation;
  async function submit(control:Control,data:Map<string,string>){
    setBusy(true);setError('');
    try{
      const key=keys.current.get(control.key)??crypto.randomUUID().replaceAll('-','');
      keys.current.set(control.key,key);
      const request=requestFor(control,inspector,data);
      const answer=await send(control,request.path,request.body,key);
      if(!answer)return;
      keys.current.delete(control.key);
      setReceipt({control:control.key,operationKind:control.operationKind,
        memoryOperationId:typeof answer.memoryOperationId==='string'?answer.memoryOperationId:null,
        ownerSequence:typeof answer.ownerSequence==='number'?answer.ownerSequence:null,
        proposedTransactionId:typeof answer.proposedTransactionId==='string'?answer.proposedTransactionId:null,
        transactionId:typeof answer.transactionId==='string'?answer.transactionId:null});
    }catch{setError('That could not be recorded, and nothing was changed. Please retry.');}
    finally{setBusy(false);}
  }
  return <>
    <section className="card" aria-labelledby="subject">
      <h2 id="subject">The belief</h2>
      <p><strong>{predicateText(x.predicateId)}: {valueText(x.normalizedValue)}</strong></p>
      <p><a href={inspectorHref(inspector.subject.requestedType,inspector.subject.requestedId)}>Inspect it first</a></p>
    </section>
    <div role="status" aria-live="polite">{receipt&&<Receipt receipt={receipt}/>}</div>
    {error&&<p role="alert">{error}</p>}
    <section aria-labelledby="controls">
      <h2 id="controls">Ten separate controls</h2>
      <p>Each control records a different kind of change. Pick the one that says what actually happened.</p>
      {CONTROLS.map(control=><ControlSection key={control.key} control={control} inspector={inspector} busy={busy}
        onSubmit={(chosen,data)=>void submit(chosen,data)}/>)}
    </section>
    <section className="card" aria-labelledby="earlier">
      <h2 id="earlier">What you already said about it</h2>
      <Earlier deltas={x.ownerOverlayDeltas}/>
    </section>
  </>;
}

export function CorrectionControls(props:CorrectionControlsProps){
  return <MemoryPage current={null} eyebrow="MEMORY" title="Correct this memory"
    intro={<p>Say exactly what is wrong. Every control writes forward: what Uai believed stays in its history, and your change is visible on all your devices at once.</p>}
    footer="There is no single “edit memory”. Each control is recorded as its own kind of change.">
    {props.state==='ready'&&props.inspector&&<Controls inspector={props.inspector} initialReceipt={props.receipt??null} initialError={props.error??''}/>}
    {props.state!=='ready'&&props.error&&<p role="alert">{props.error}</p>}
  </MemoryPage>;
}
