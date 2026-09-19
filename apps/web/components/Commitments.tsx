import React from 'react';
import type {CommitmentProjectionRow,CommitmentsProjectionView,PendingAssertion,RelatedFrame} from '@unai/domain';
import {BeliefLinks} from './BeliefLinks';
import {MemoryPage,Status,dateText,predicateText,sourceText,type StatusKind} from './MemoryChrome';

/** The design's Commitments screen (journey J4): open commitments with due dates,
 * people and sources, the overdue flag the clock sets, resolution evidence, a
 * distinct contested marker, the owner's pending correction, and the
 * completeness flag and overlay watermark every projection read carries. */
export interface CommitmentFiltersProps{person:string|null;thread:string|null;dueBefore:string|null;dueAfter:string|null;includeResolved:boolean}
export interface CommitmentsProps{
  state:'loading'|'ready'|'error';
  view:CommitmentsProjectionView|null;
  /** Keyed by commitment frame instance; null when the details could not be read. */
  related:Record<string,RelatedFrame>|null;
  filters:CommitmentFiltersProps;
  error?:string|null;
}

export const OUTCOME:Record<CommitmentProjectionRow['outcomeState'],StatusKind>={
  UNRESOLVED:'open',PARTIALLY_RESOLVED:'partially-resolved',RESOLVED:'resolved',CONTESTED:'contested',
};
const ROLE:Record<string,string>={promisor:'Promised by',promisee:'Promised to',debtor:'Owed by',creditor:'Owed to'};
const OUTCOME_CODE:Record<string,string>={FULFILLED:'Fulfilled',PARTIALLY_FULFILLED:'Partly fulfilled',WAIVED:'Waived',
  CANCELLED:'Cancelled',WITHDRAWN:'Withdrawn',FAILED:'Failed',MISSED:'Missed',OCCURRED:'Occurred',
  OCCURRED_MODIFIED:'Occurred with changes',CONFIRMED:'Confirmed',REFUTED:'Refuted',PARTIALLY_CONFIRMED:'Partly confirmed'};
const RESOLUTION_LIFECYCLE:Record<string,string>={PROPOSED:'proposed, not yet accepted',ACCEPTED:'accepted',
  CONTESTED:'contested',REJECTED:'rejected',SUPERSEDED:'superseded',WITHDRAWN:'withdrawn'};

export function personName(entry:{canonicalLabel:string|null;entityKind:string}){return entry.canonicalLabel??'An unnamed '+entry.entityKind.toLowerCase();}

export function People({frame}:{frame:RelatedFrame|undefined}){
  if(!frame||frame.people.length===0)return <p>No related people recorded.</p>;
  return <ul className="people">{frame.people.map(person=><li key={person.roleId+person.entityId}>
    {ROLE[person.roleId]??predicateText(person.roleId)}: {personName(person)}</li>)}</ul>;
}

export function Sources({frame}:{frame:RelatedFrame|undefined}){
  if(!frame)return <p>Sources could not be read.</p>;
  return <>
    {frame.sources.length===0?<p>No readable source.</p>:<ul className="sources">{frame.sources.map(source=><li key={source.evidenceId}>
      {sourceText(source.sourceType)}, {dateText(source.occurredAt??source.observedAt)}
      {source.anchors.filter(anchor=>anchor.text).slice(0,2).map(anchor=><q key={anchor.sourceAnchorId}> {anchor.text}</q>)}
    </li>)}</ul>}
    {frame.withheldSourceCount>0&&<p><Status kind="withheld"/> {frame.withheldSourceCount} {frame.withheldSourceCount===1?'source is':'sources are'} above what this view may read and {frame.withheldSourceCount===1?'is':'are'} not shown.</p>}
  </>;
}

export function ResolutionEvidence({frame}:{frame:RelatedFrame|undefined}){
  if(!frame||frame.resolutions.length===0)return null;
  return <div className="resolution-evidence"><h4>Resolution evidence</h4><ul>{frame.resolutions.map(resolution=><li key={resolution.resolutionAssertionId}>
    {OUTCOME_CODE[resolution.outcomeCode]??resolution.outcomeCode} on {dateText(resolution.effectiveAt)}
    {' '}({RESOLUTION_LIFECYCLE[resolution.lifecycle]??resolution.lifecycle.toLowerCase()})
    {resolution.assertedBy&&<>, stated by {personName(resolution.assertedBy)}</>}
    {resolution.evidence.length===0?<> — its source is not readable here</>:resolution.evidence.map(item=><span key={item.evidenceId}>
      {' '}— {sourceText(item.sourceType)}, {dateText(item.occurredAt??item.observedAt)}
      {item.anchors.filter(anchor=>anchor.text).slice(0,1).map(anchor=><q key={anchor.sourceAnchorId}> {anchor.text}</q>)}
    </span>)}
    {' '}<BeliefLinks objectType="resolution_assertion" objectId={resolution.resolutionAssertionId} about={'this resolution'}/>
  </li>)}</ul></div>;
}

export function Pending({assertions}:{assertions:PendingAssertion[]}){
  if(assertions.length===0)return null;
  return <ul className="pending">{assertions.map(assertion=><li key={assertion.overlayDeltaId}>
    <Status kind="pending-owner"/> “{assertion.rawText}” — not yet reflected here ({assertion.reason.toLowerCase().replaceAll('_',' ')})
    {' '}<BeliefLinks objectType="owner_overlay_delta" objectId={assertion.overlayDeltaId} about={'your statement “'+assertion.rawText+'”'}/>
  </li>)}</ul>;
}

export function Beliefs({frame,about}:{frame:RelatedFrame|undefined;about:string}){
  if(!frame||frame.beliefs.length===0)return null;
  return <ul className="beliefs">{frame.beliefs.map(belief=><li key={belief.propositionId}>
    {predicateText(belief.predicateId)}: <BeliefLinks objectType="proposition" objectId={belief.propositionId} about={predicateText(belief.predicateId)+' of '+about}/>
  </li>)}</ul>;
}

export function Completeness({view}:{view:{isComplete:boolean;ownerOverlayWatermark:number;highRiskActionsBlocked:boolean;pendingAssertions:PendingAssertion[]}}){
  return <section className="card" aria-labelledby="completeness">
    <h2 id="completeness">How complete this view is</h2>
    <p>{view.isComplete?<Status kind="complete"/>:<Status kind="incomplete"/>} · Includes your changes up to owner sequence {view.ownerOverlayWatermark}.</p>
    {!view.isComplete&&<p>What was last stored is shown, together with what you said that has not landed yet.</p>}
    {view.highRiskActionsBlocked&&<p>High-risk actions based on this view are blocked until it is complete and uncontested.</p>}
    <Pending assertions={view.pendingAssertions}/>
  </section>;
}

function Row({row,frame}:{row:CommitmentProjectionRow;frame:RelatedFrame|undefined}){
  const title=row.actionDescription??'A commitment with no recorded action';
  const contested=row.outcomeState==='CONTESTED'||row.conflictFlag;
  return <li className={'commitment'+(contested?' contested':'')}>
    <h3>{title}</h3>
    <p className="statuses">
      <Status kind={OUTCOME[row.outcomeState]}/>
      {row.overdue&&<> <Status kind="overdue" detail="the due time has passed; nothing has been marked failed or missed"/></>}
      {row.dueSoon&&<> <Status kind="due-soon"/></>}
      {contested&&row.outcomeState!=='CONTESTED'&&<> <Status kind="contested" detail="sources disagree"/></>}
      {row.sourceStrength==='PENDING_OWNER_ASSERTION'&&<> <Status kind="pending-owner" detail="your correction is applied to this view"/></>}
      {!row.isComplete&&<> <Status kind="incomplete"/></>}
    </p>
    {contested&&<p className="contested-note">Contested: the sources disagree about this commitment, and Uai has not chosen between them.</p>}
    <p>Due {row.dueTime?dateText(row.dueTime):'— no due date recorded'}</p>
    <People frame={frame}/>
    <Sources frame={frame}/>
    {(row.outcomeState==='RESOLVED'||row.outcomeState==='PARTIALLY_RESOLVED'||row.outcomeState==='CONTESTED')&&<ResolutionEvidence frame={frame}/>}
    <Pending assertions={row.pendingAssertions}/>
    <Beliefs frame={frame} about={title}/>
  </li>;
}

function Filters({filters,related}:{filters:CommitmentFiltersProps;related:Record<string,RelatedFrame>|null}){
  const frames=Object.values(related??{});
  const people=new Map<string,string>();
  for(const frame of frames)for(const person of frame.people)people.set(person.entityId,personName(person));
  const threads=new Map<string,string>();
  for(const frame of frames)for(const thread of frame.threads)threads.set(thread.memoryThreadId,thread.displayTitle??'Untitled thread');
  const active=[filters.person&&'person',filters.thread&&'thread',(filters.dueBefore||filters.dueAfter)&&'due window'].filter(Boolean);
  return <section className="card" aria-labelledby="filters">
    <h2 id="filters">Filter</h2>
    <form method="get" action="/commitments">
      <label htmlFor="filter-person">Person</label>
      <select id="filter-person" name="person" defaultValue={filters.person??''}>
        <option value="">Anyone</option>
        {[...people].map(([id,name])=><option key={id} value={id}>{name}</option>)}
      </select>
      <label htmlFor="filter-thread">Thread</label>
      <select id="filter-thread" name="thread" defaultValue={filters.thread??''}>
        <option value="">Any thread</option>
        {[...threads].map(([id,title])=><option key={id} value={id}>{title}</option>)}
      </select>
      <label htmlFor="filter-due-after">Due after</label>
      <input id="filter-due-after" name="dueAfter" type="date" defaultValue={filters.dueAfter?.slice(0,10)??''}/>
      <label htmlFor="filter-due-before">Due before</label>
      <input id="filter-due-before" name="dueBefore" type="date" defaultValue={filters.dueBefore?.slice(0,10)??''}/>
      <input type="hidden" name="includeResolved" value="false"/>
      <label htmlFor="filter-resolved"><input id="filter-resolved" name="includeResolved" type="checkbox" value="true"
        defaultChecked={filters.includeResolved}/> Include resolved commitments</label>
      <button type="submit">Apply filters</button>
    </form>
    {active.length>0&&<p>Filtered by {active.join(', ')}. <a href="/commitments">Clear filters</a></p>}
  </section>;
}

export function Commitments(props:CommitmentsProps){
  const rows=props.view?.rows??[];
  return <MemoryPage current="commitments" eyebrow="MEMORY" title="Commitments"
    intro={<p>What you promised and what was promised to you, with who is involved and where it came from. A due time passing marks a commitment overdue; it never records it as failed.</p>}
    footer="Read from the open commitments projection. Every item can be inspected and corrected.">
    {props.state==='loading'&&<p role="status" aria-live="polite" aria-busy="true">Loading commitments…</p>}
    {props.state==='ready'&&props.view&&<>
      <Filters filters={props.filters} related={props.related}/>
      <Completeness view={props.view}/>
      <section className="card" aria-labelledby="commitment-list">
        <h2 id="commitment-list">Commitments</h2>
        {props.related===null&&<p role="alert">People, sources and resolution evidence could not be read. The commitments themselves are shown.</p>}
        {rows.length===0?<p>No commitments to show{props.filters.person||props.filters.thread||props.filters.dueBefore||props.filters.dueAfter?' for these filters':''}.</p>
          :<ul className="devices">{rows.map(row=><Row key={row.commitmentFrameInstanceId} row={row}
            frame={props.related?.[row.commitmentFrameInstanceId]}/>)}</ul>}
      </section>
    </>}
    {props.error&&<p role="alert">{props.error}</p>}
  </MemoryPage>;
}
