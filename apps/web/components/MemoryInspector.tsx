import React from 'react';
import type {MemoryInspector as Inspection} from '@unai/domain';
import {correctionHref,inspectorHref} from './BeliefLinks';
import {personName} from './Commitments';
import {MemoryPage,Status,assessmentStatus,dateText,outcomeStatus,predicateText,sourceText,valueText} from './MemoryChrome';

/** The design's Memory inspector screen (journey J5; PRD §7.6): current belief,
 * historical timeline, original evidence, claims with asserting actors,
 * inferences, conflicts, resolution assertions, connected threads, access
 * history, registry and extractor versions, and the advanced identifier panel. */
export interface MemoryInspectorProps{
  state:'ready'|'not-found'|'error';
  inspector:Inspection|null;
  error?:string|null;
}

export const ORIGINS:Record<string,string>={USER_STATEMENT:'You said it',USER_CONFIRMATION:'You confirmed it',
  USER_CORRECTION:'You corrected it',EXTERNAL_PERSON_ASSERTION:'Reported by another person',
  STRUCTURED_CONNECTOR_OBSERVATION:'Observed by a connected source',DOCUMENT_ASSERTION:'Stated in a document',
  MODEL_EXTRACTION:'Read from a source by Uai',MODEL_INFERENCE:'Inferred by Uai',MODEL_RECOMMENDATION:'Recommended by Uai',
  MODEL_PREDICTION:'Predicted by Uai',TOOL_EXECUTION_RECEIPT:'Receipt from a tool'};
const CONTRADICTIONS:Record<string,string>={COMPETING_PROPOSITION:'Another value is held for the same thing',
  CLAIM_RELATION:'A later statement relates to this one',MEMORY_LINK:'Recorded as contradicting another belief',
  CONTESTED_OVERLAY_DELTA:'Your own statement about it is contested'};
const ACCESS:Record<string,string>={AUDIT_EVENT:'Read or written',ANSWER_MANIFEST:'Supplied as context to an answer'};
const PURPOSES:Record<string,string>={'memory.inspect':'inspection','memory.read':'context for an answer',
  'memory.correct':'a correction','memory.govern':'a governed change','projection.read':'a projection read',
  'memory.canonicalize':'canonicalization','memory.project':'a projection rebuild','memory.thread':'a thread change'};
const confidence=(value:number|null)=>value===null?'not recorded':Math.round(value*100)+'%';

function Section({id,title,children}:{id:string;title:string;children:React.ReactNode}){
  return <section className="card" aria-labelledby={id}><h2 id={id}>{title}</h2>{children}</section>;
}

function Inspector({inspector}:{inspector:Inspection}){
  const x=inspector.explanation;
  const actors=new Map(inspector.assertingActors.map(actor=>[actor.entityId,actor]));
  const confidences=new Map(inspector.claimConfidences.map(entry=>[entry.claimId,entry]));
  const status=x.currentAssessment.assessmentStatus;
  const onlyAssistant=x.claims.length>0&&x.claims.every(claim=>claim.claimOrigin.startsWith('MODEL_'))&&status!=='ACCEPTED';
  return <>
    <Section id="current-belief" title="Current belief">
      <p className="belief-value"><strong>{predicateText(x.predicateId)}: {valueText(x.normalizedValue)}</strong></p>
      <p><Status kind={assessmentStatus(status)}/>{x.polarity==='NEGATIVE'?' — held as not true':''}
        {x.currentAssessment.recordedAt&&<> · decided {dateText(x.currentAssessment.recordedAt)}</>}
        {x.currentAssessment.policyVersion&&<> under policy {x.currentAssessment.policyVersion}</>}</p>
      {status===null&&<p>No decision has been recorded about this belief yet.</p>}
      {status==='UNSUPPORTED'&&<p>Unsupported: every input this belief was derived from has been invalidated, so it is no longer held.</p>}
      {onlyAssistant&&<p>Only Uai has said this. It is kept as conversation evidence and is not an accepted belief.</p>}
      <p className="actions"><a href={correctionHref(inspector.subject.requestedType,inspector.subject.requestedId)}>Correct this belief</a></p>
    </Section>
    <Section id="timeline" title="Historical timeline">
      {x.temporalHistory.length===0?<p>No assessment has been recorded yet.</p>:<ol>{x.temporalHistory.map(entry=><li key={entry.assessmentId??entry.recordedAt}>
        <Status kind={assessmentStatus(entry.assessmentStatus)}/> recorded {dateText(entry.recordedAt)}
        {' '}— true from {entry.validFrom?dateText(entry.validFrom):'an unrecorded time'} to {entry.validTo?dateText(entry.validTo):'now'}
        {entry.supersededRecordedAt&&<>; replaced on {dateText(entry.supersededRecordedAt)} and kept as history</>}
      </li>)}</ol>}
    </Section>
    <Section id="evidence" title="Original evidence">
      {inspector.originalEvidence.length===0?<p>No readable evidence.</p>:<ul>{inspector.originalEvidence.map(item=><li key={item.evidenceId}>
        {sourceText(item.sourceType)}, {dateText(item.occurredAt??item.observedAt)} ({item.sensitivity.toLowerCase()})
        <ul>{item.anchors.map(anchor=><li key={anchor.sourceAnchorId}>{anchor.anchorKind.toLowerCase().replaceAll('_',' ')}
          {anchor.text?<>: <q>{anchor.text}</q></>:' (no excerpt stored)'}</li>)}</ul>
      </li>)}</ul>}
      {inspector.withheldEvidenceCount>0&&<p><Status kind="withheld"/> {inspector.withheldEvidenceCount} more {inspector.withheldEvidenceCount===1?'item is':'items are'} above what this view may read.</p>}
    </Section>
    <Section id="claims" title="Claims and who asserted them">
      {x.claims.length===0?<p>No claim asserts this value.</p>:<ul>{x.claims.map(claim=>{
        const actor=claim.assertedByEntityId?actors.get(claim.assertedByEntityId):undefined;
        const scores=confidences.get(claim.claimId);
        return <li key={claim.claimId}>
          {ORIGINS[claim.claimOrigin]??claim.claimOrigin}{actor?<> — asserted by {personName(actor)}</>:<> — no asserting person recorded</>}
          {' '}({claim.lifecycle.toLowerCase()}), recorded {dateText(claim.recordedAt)}
          {scores&&<p className="muted">Confidence — extraction {confidence(scores.extraction)}, who it is about {confidence(scores.entityResolution)},
            {' '}when {confidence(scores.temporalResolution)}, which situation {confidence(scores.instanceResolution)}</p>}
        </li>;})}</ul>}
    </Section>
    <Section id="inferences" title="Inferences">
      {inspector.inferences.length===0?<p>Nothing was inferred from or into this belief.</p>:<ul>{inspector.inferences.map(inference=><li key={inference.dependencyId}>
        {inference.role==='DERIVED_FROM_INPUTS'
          ?<>Derived from {inference.inputClaimIds.length} {inference.inputClaimIds.length===1?'claim':'claims'} and {inference.inputPropositionIds.length} other {inference.inputPropositionIds.length===1?'belief':'beliefs'}</>
          :<>Used to derive <a href={inspectorHref('proposition',inference.derivedPropositionId)}>another belief</a></>}
        {' '}by {inference.evaluatorId} ({inference.modelOrCodeVersion})
        {inference.derivedAssessmentStatus&&<> — derived belief <Status kind={assessmentStatus(inference.derivedAssessmentStatus)}/></>}
      </li>)}</ul>}
    </Section>
    <Section id="conflicts" title="Conflicts">
      {x.contradictions.length===0?<p>No conflict recorded.</p>:<ul>{x.contradictions.map(conflict=><li key={conflict.objectId}>
        <Status kind="contested"/> {CONTRADICTIONS[conflict.kind]??conflict.kind}
        {conflict.kind==='COMPETING_PROPOSITION'&&<> — <a href={inspectorHref('proposition',conflict.objectId)}>inspect the other value</a></>}
      </li>)}</ul>}
    </Section>
    <Section id="resolutions" title="Resolution assertions">
      {x.resolutionLinks.length===0?<p>Nothing has resolved this yet.</p>:<ul>{x.resolutionLinks.map(link=><li key={link.objectId}>
        {link.objectType==='resolution_assertion'
          ?<>{link.lifecycle==='ACCEPTED'?<Status kind={outcomeStatus(link.outcomeCode)} detail={(link.outcomeCode??'').toLowerCase().replaceAll('_',' ')}/>
            :<>{(link.outcomeCode??'').toLowerCase().replaceAll('_',' ')} (not accepted)</>} effective {dateText(link.effectiveAt)} ({link.lifecycle.toLowerCase()})
            {' '}<a href={inspectorHref('resolution_assertion',link.objectId)}>Inspect the resolution</a></>
          :<>{(link.linkKind??'').toLowerCase().replaceAll('_',' ')} link ({link.lifecycle.toLowerCase()})</>}
      </li>)}</ul>}
    </Section>
    <Section id="threads" title="Connected memory threads">
      {inspector.connectedThreads.length===0?<p>Not part of any thread.</p>:<ul>{inspector.connectedThreads.map(thread=><li key={thread.memoryThreadId}>
        <a href={'/memory/threads/'+thread.memoryThreadId}>{thread.displayTitle??'Memory thread'}</a> ({thread.membershipKind.toLowerCase()}, {thread.lifecycle.toLowerCase()})
      </li>)}</ul>}
    </Section>
    <Section id="access" title="Access history">
      {inspector.accessHistory.length===0?<p>No access recorded yet.</p>:<ul>{inspector.accessHistory.map(access=><li key={access.kind+access.id}>
        {dateText(access.at)} — {ACCESS[access.kind]}{access.purpose?<> for {PURPOSES[access.purpose]??access.purpose}</>:null}
        {access.result&&access.result!=='SUCCESS'?<> ({access.result.toLowerCase()})</>:null}
        {access.kind==='ANSWER_MANIFEST'&&<> — <a href={'/answers/'+access.id}>see the answer's record</a></>}
      </li>)}</ul>}
    </Section>
    <Section id="operations" title="What you already did">
      {inspector.memoryOperations.length===0?<p>No correction has been recorded for this belief.</p>:<ul>{inspector.memoryOperations.map(operation=><li key={operation.memoryOperationId}>
        {operation.operationKind.toLowerCase().replaceAll('_',' ')} on {dateText(operation.createdAt)}</li>)}</ul>}
    </Section>
    <Section id="versions" title="Registry and extractor versions">
      <ul>
        <li>Registry release {x.registryVersions.registryRelease??'not recorded'}</li>
        <li>Normalization {x.registryVersions.normalizationVersion??'not recorded'} · canonicalization {x.registryVersions.canonicalizationVersion}</li>
        {x.extractorVersions.length===0?<li>No extraction run produced these claims.</li>:x.extractorVersions.map(run=><li key={run.extractionRunId}>
          Extraction ({run.runKind.toLowerCase()}){run.modelId?<> by {run.modelId}</>:null}{run.promptVersion?<>, prompt {run.promptVersion}</>:null},
          {' '}entity resolver {run.entityResolverVersion}, temporal resolver {run.temporalResolverVersion}</li>)}
      </ul>
    </Section>
    <section className="card" aria-labelledby="advanced">
      <h2 id="advanced">Advanced</h2>
      <details><summary>Identifiers</summary>
        <dl className="identifiers">
          <dt>Situation (frame instance)</dt><dd><code>{x.frameInstanceId}</code> ({x.frameTypeId})</dd>
          <dt>Slot</dt><dd><code>{x.beliefSlotId}</code> ({x.predicateId}, {x.modality.toLowerCase()})</dd>
          <dt>Proposition</dt><dd><code>{x.propositionId}</code></dd>
          <dt>Claims</dt><dd>{x.claims.map(claim=><code key={claim.claimId}>{claim.claimId} </code>)}</dd>
          <dt>Registry release id</dt><dd><code>{x.registryVersions.registryReleaseId??'none'}</code></dd>
        </dl>
      </details>
    </section>
  </>;
}

export function MemoryInspector(props:MemoryInspectorProps){
  return <MemoryPage current={null} eyebrow="MEMORY" title="Memory inspector"
    intro={<p>Everything Uai holds about one belief: what it believes now, why, from where, and what has happened to it.</p>}
    footer="The inspector reads memory and changes nothing. Opening it is recorded in the access history.">
    {props.state==='ready'&&props.inspector&&<Inspector inspector={props.inspector}/>}
    {props.error&&<p role="alert">{props.error}</p>}
  </MemoryPage>;
}
