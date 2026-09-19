import React from 'react';
import type {WhySources as WhySourcesPanel} from '@unai/domain';
import {CertaintyBadge,withoutIdentifiers} from './Labels';

/**
 * The Why? / Sources panel (design screen "Why? / Sources panel"; CRT-UX-11-A).
 *
 * A native disclosure: closed until the reader activates "Why? / Sources", open
 * from the keyboard with Enter or Space, and readable without script. Opened, it
 * answers in words what the statement rests on: the belief or your own statement,
 * who claimed it, the source's own words, when it holds, how confident the
 * recorded claims are, whether anything disputes it, and -- for an inferred
 * statement -- how it was derived. A source this view may not read is listed as
 * withheld, never quoted.
 *
 * Identifiers appear only inside the nested advanced inspector.
 */
export interface WhySourcesProps{
  /** The statement the panel explains, for the disclosure's accessible name. */
  about:string;
  panel:WhySourcesPanel|null;
  /** The owner's timezone when the screen knows it; UTC otherwise. */
  timeZone?:string;
}

const STATUS:Record<string,string>={
  CANDIDATE:'a candidate, not yet assessed',PROVISIONAL:'provisional',ACCEPTED:'accepted',CONTESTED:'contested',
  REJECTED:'rejected',SUPERSEDED:'superseded',UNSUPPORTED:'no longer supported',SUPPRESSED:'suppressed',
};
const CONFLICT:Record<WhySourcesPanel['conflict']['status'],string>={
  NO_CONFLICT:'Nothing recorded disputes this.',
  CONTESTED:'Contested: sources disagree and neither value is settled.',
  CORRECTED_OR_SUPERSEDED:'A later statement corrected or superseded part of this; the history is kept.',
};
const ORIGIN:Record<string,string>={
  USER_STATEMENT:'you said it',USER_CONFIRMATION:'you confirmed it',USER_CORRECTION:'you corrected it',
  EXTERNAL_PERSON_ASSERTION:'another person said it',STRUCTURED_CONNECTOR_OBSERVATION:'a connected source recorded it',
  DOCUMENT_ASSERTION:'a document states it',MODEL_EXTRACTION:'a model read it from a source',MODEL_INFERENCE:'a model inferred it',
  MODEL_RECOMMENDATION:'a model recommended it',MODEL_PREDICTION:'a model predicted it',TOOL_EXECUTION_RECEIPT:'a tool receipt records it',
};

export function when(value:string|null,timeZone?:string):string{
  if(!value)return 'not stated';
  const date=new Date(value);
  if(!timeZone)return date.toISOString().slice(0,16).replace('T',' ')+' UTC';
  return new Intl.DateTimeFormat('en-GB',{timeZone,dateStyle:'medium',timeStyle:'short'}).format(date)+' ('+timeZone+')';
}
/** "extraction.commitment_inference" reads "commitment inference": the rule's
 * own identifier belongs in the advanced inspector. */
function ruleName(evaluatorId:string){return (evaluatorId.split('.').at(-1)??evaluatorId).replaceAll('_',' ');}
function percent(value:number|null){return value===null?'not recorded':Math.round(value*100)+'%';}

export function WhySources({about,panel,timeZone}:WhySourcesProps){
  return <details className="why">
    <summary>Why? / Sources<span className="sr-only"> for: {withoutIdentifiers(about)}</span></summary>
    {!panel?<p role="alert">The sources for this statement could not be read. Reload the page to try again.</p>:<div className="why-panel">
      <p><CertaintyBadge label={panel.label}/> {withoutIdentifiers(panel.statement)}</p>
      <dl>
        <dt>What it is</dt>
        <dd>{panel.subjectKind==='BELIEF'?'A belief'+(panel.assessmentStatus?', '+STATUS[panel.assessmentStatus]:'')+'.'
          :panel.subjectKind==='OWNER_ASSERTION'?'Your own statement, recorded as you said it.':'A resolution assertion recording an outcome.'}</dd>
        <dt>Who claimed it</dt>
        <dd>{panel.claimingActors.length===0?'No claim is recorded.':panel.claimingActors.map(actor=>actor.label).join('; ')}
          {panel.claims.length>0?<ul>{panel.claims.slice(0,10).map(claim=><li key={claim.claimId}>{claim.claimingActor.label}: {ORIGIN[claim.claimOrigin]??'recorded'}, {when(claim.recordedAt,timeZone)}</li>)}</ul>:null}</dd>
        <dt>What the source says</dt>
        <dd>{panel.sources.length===0?<p>No source excerpt can be shown here.</p>:panel.sources.slice(0,5).map((source,index)=><figure key={index}>
          <blockquote>{source.excerpt===null?'This source records a position but no text.':withoutIdentifiers(source.excerpt)}</blockquote>
          <figcaption>{source.sourceType.toLowerCase().replaceAll('_',' ')}{source.occurredAt?', '+when(source.occurredAt,timeZone):''}</figcaption>
        </figure>)}
          {panel.redactions.length>0?<p>{panel.redactions.length} source{panel.redactions.length===1?' is':'s are'} withheld: this view may not read {panel.redactions.length===1?'it':'them'} under its purpose or sensitivity limit.</p>:null}</dd>
        <dt>When it holds</dt>
        <dd>{panel.effectiveTime.from||panel.effectiveTime.to?'From '+when(panel.effectiveTime.from,timeZone)+(panel.effectiveTime.to?' to '+when(panel.effectiveTime.to,timeZone):''):'No time is stated.'}
          {panel.effectiveTime.recordedAt?' Recorded '+when(panel.effectiveTime.recordedAt,timeZone)+'.':''}</dd>
        <dt>How confident</dt>
        <dd>{panel.confidence.assessmentStatus?'Assessment: '+STATUS[panel.confidence.assessmentStatus]+'. ':'No assessment yet. '}
          Reading from the source {percent(panel.confidence.extraction)}; who it is about {percent(panel.confidence.entityResolution)};
          when {percent(panel.confidence.temporalResolution)}; which situation {percent(panel.confidence.instanceResolution)}.</dd>
        <dt>Conflict</dt>
        <dd>{CONFLICT[panel.conflict.status]}
          {panel.conflict.competing.length>0?<ul>{panel.conflict.competing.map(entry=><li key={entry.propositionId}>Competing value: {withoutIdentifiers(entry.statement)}{entry.assessmentStatus?' ('+STATUS[entry.assessmentStatus]+')':''}</li>)}</ul>:null}</dd>
        <dt>How it was derived</dt>
        <dd>{!panel.derivation.isInferred?'Not inferred: it rests on what its sources state.':<>
          Inferred, not stated by anyone.
          <ol>{panel.derivation.steps.map((step,index)=><li key={index}>Derived by the {ruleName(step.evaluatorId)} rule ({step.version}) from:
            <ul>{step.inputs.map(input=><li key={input.objectId}>{withoutIdentifiers(input.statement)}</li>)}</ul></li>)}
            {panel.derivation.modelClaims.map(claim=><li key={claim.claimId}>{ORIGIN[claim.claimOrigin]??'A model produced it'}{claim.modelId?' ('+claim.modelId+(claim.promptVersion?', '+claim.promptVersion:'')+')':''}</li>)}</ol>
        </>}</dd>
        {panel.resolutions.length>0?<><dt>Outcome</dt><dd><ul>{panel.resolutions.map(resolution=><li key={resolution.resolutionAssertionId}>
          {resolution.outcomeCode.toLowerCase().replaceAll('_',' ')}, effective {when(resolution.effectiveAt,timeZone)}{resolution.lifecycle==='ACCEPTED'?'':' (not yet accepted)'}</li>)}</ul></dd></>:null}
      </dl>
      <details className="advanced">
        <summary>Advanced inspector: identifiers</summary>
        <dl>
          <dt>Object</dt><dd><code>{panel.subject.objectType} {panel.subject.objectId}</code></dd>
          {panel.claims.length>0?<><dt>Claims</dt><dd>{panel.claims.map(claim=><code key={claim.claimId}>{claim.claimId} </code>)}</dd></>:null}
          {panel.sources.length>0?<><dt>Evidence</dt><dd>{panel.sources.map((source,index)=><code key={index}>{source.evidenceId} </code>)}</dd></>:null}
          {panel.derivation.steps.length>0?<><dt>Derivation rules</dt><dd>{panel.derivation.steps.map((step,index)=><code key={index}>{step.evaluatorId} </code>)}</dd></>:null}
          {panel.explainPath?<><dt>Memory inspector read</dt><dd><code>{panel.explainPath}</code></dd></>:null}
          <dt>Panel version</dt><dd><code>{panel.panelVersion}</code></dd>
        </dl>
      </details>
    </div>}
  </details>;
}
