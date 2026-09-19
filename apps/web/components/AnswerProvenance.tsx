import React from 'react';
import {SUPPLIED_CONTEXT_STATEMENT,type PublicAnswerManifest} from '@unai/domain';
import {Navigation} from './Navigation';

/**
 * The Answer provenance screen (design journey J3; PRD §23.6, §23.7; CRT-RD-06-A,
 * CRT-RD-07-A, CRT-RD-11-A).
 *
 * Three drawn states: the listing of the context supplied to the model, the
 * statement that this is not a record of which item the model used, and the
 * reconsideration badge after a belief in the packet changed materially.
 *
 * Every heading and label here speaks of what was supplied. None of them ranks,
 * weights, credits or attributes an item: the manifest cannot know which item
 * the model used, so the screen never suggests it does.
 */
export interface AnswerProvenanceProps {
  manifest:PublicAnswerManifest|null;
  error?:string;
}

const groundingLabels:Record<PublicAnswerManifest['groundingValidator']['action'],string>={
  PASSED:'Passed: every statement was checked against this context and presented as phrased.',
  DOWNGRADED:'Downgraded: some wording was made less certain before the answer was presented.',
  REGENERATED:'Regenerated: a candidate stated something this context does not hold, so the answer was phrased again.',
  BLOCKED:'Blocked: a candidate would have stated memory this request may not read, so no answer was presented.',
};
const changeLabels:Record<string,string>={
  BELIEF_ASSESSMENT_CHANGED:'Its assessment changed',
  CLAIM_CORRECTED:'A claim behind it was corrected',
  CLAIM_SUPERSEDED:'A claim behind it was superseded',
  CLAIM_RETRACTED:'A claim behind it was retracted',
  CLAIM_CONTRADICTED:'A claim behind it was contradicted',
  OVERLAY_DELTA_LIFECYCLE_CHANGED:'Your pending statement moved to another state',
};
function timestamp(value:string){return new Date(value).toISOString().slice(0,19).replace('T',' ')+' UTC';}

function IdList({id,title,ids}:{id:string;title:string;ids:string[]}){
  return <section aria-labelledby={id}>
    <h3 id={id}>{title} ({ids.length})</h3>
    {ids.length===0?<p>None were supplied.</p>:<ul>{ids.map(value=><li key={value}><code>{value}</code></li>)}</ul>}
  </section>;
}

export function AnswerProvenance(props:AnswerProvenanceProps){
  const manifest=props.manifest;
  return <div className="shell">
    <a className="skip" href="#content">Skip to content</a>
    <header><a href="/" className="brand">Uai</a><span>Your personal memory</span></header>
    <Navigation current={null}/>
    <main id="content" tabIndex={-1}>
      <p className="eyebrow">ASK</p>
      <h1>Answer provenance</h1>
      {props.error?<p role="alert">{props.error}</p>:!manifest?<p role="alert">This answer's record could not be read.</p>:<>
        <section className="card" aria-labelledby="record-kind">
          <h2 id="record-kind">Context supplied to the model</h2>
          <p><strong>{SUPPLIED_CONTEXT_STATEMENT}</strong></p>
          {manifest.question?<p>Question: {manifest.question}</p>:null}
          <p>Answered {timestamp(manifest.createdAt)}.</p>
          {manifest.reconsideration.isCandidate?<div role="status" className="badge" aria-labelledby="reconsider">
            <h3 id="reconsider">Reconsider: context in this answer has changed</h3>
            <p>Since this answer was given, something supplied in its context changed materially. The answer itself is kept
              as it was; ask again to get an answer from the current memory.</p>
            <ul>{manifest.reconsideration.changes.map((change,index)=><li key={change.changedObjectId+index}>
              {changeLabels[change.changeKind]??'It changed'} ({change.changedObjectType==='belief'?'belief':'pending statement'}{' '}
              <code>{change.changedObjectId}</code>, detected {timestamp(change.detectedAt)})</li>)}</ul>
          </div>:<p>No belief supplied in this context has changed materially since the answer was given.</p>}
        </section>
        <section className="card" aria-labelledby="packet">
          <h2 id="packet">Context packet</h2>
          <dl>
            <dt>Packet ID</dt><dd><code>{manifest.contextSupplied.packetId}</code></dd>
            <dt>Packet hash</dt><dd><code>{manifest.contextSupplied.packetHash}</code></dd>
            <dt>Registry release</dt><dd>{manifest.contextSupplied.registryRelease??'None pinned'}</dd>
            <dt>Model</dt><dd>{manifest.suppliedTo.modelProvider} {manifest.suppliedTo.modelId}</dd>
            <dt>Prompt version</dt><dd>{manifest.suppliedTo.promptVersion}</dd>
            <dt>Grounding check</dt><dd>{groundingLabels[manifest.groundingValidator.action]}</dd>
          </dl>
        </section>
        <section className="card" aria-labelledby="supplied">
          <h2 id="supplied">Items supplied</h2>
          <IdList id="beliefs" title="Beliefs supplied" ids={manifest.contextSupplied.beliefIds}/>
          <IdList id="claims" title="Claims supplied" ids={manifest.contextSupplied.claimIds}/>
          <IdList id="evidence" title="Evidence supplied" ids={manifest.contextSupplied.evidenceIds}/>
          <IdList id="deltas" title="Your pending statements supplied" ids={manifest.contextSupplied.overlayDeltaIds}/>
        </section>
        <section className="card" aria-labelledby="versions">
          <h2 id="versions">Projection versions and watermarks</h2>
          {Object.keys(manifest.contextSupplied.projectionVersions).length===0?<p>No projection was supplied.</p>:
            <dl>{Object.entries(manifest.contextSupplied.projectionVersions).map(([name,version])=><React.Fragment key={name}>
              <dt>{name}</dt><dd><code>{version??'not built'}</code></dd></React.Fragment>)}</dl>}
          <dl>{Object.entries(manifest.contextSupplied.watermarks).filter(([name])=>name!=='projectionVersions')
            .map(([name,value])=><React.Fragment key={name}><dt>{name}</dt><dd><code>{value===null?'none':String(value)}</code></dd></React.Fragment>)}</dl>
        </section>
      </>}
    </main>
  </div>;
}
