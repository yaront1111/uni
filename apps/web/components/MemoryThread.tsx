import React from 'react';
import type {MemoryThreadView} from '@unai/domain';
import {BeliefLinks} from './BeliefLinks';
import {MemoryPage,Status,assessmentStatus,dateText,outcomeStatus,predicateText,valueText} from './MemoryChrome';

/** The design's Memory thread screen (journey J5; PRD §37.5): current projection,
 * timeline, plans and expected outcomes, actual events, resolution links, open
 * uncertainties, related people, documents and decisions, and the members, each
 * backed by the evidence it already had. */
export interface MemoryThreadProps{
  state:'ready'|'not-found'|'error';
  thread:MemoryThreadView|null;
  error?:string|null;
}

const PROJECTIONS:Record<string,string>={open_commitments_projection:'Commitments',obligations_projection:'Obligations',
  schedule_projection:'Schedule'};
const TIMELINE:Record<string,string>={EVIDENCE:'Evidence arrived',CLAIM:'Something was stated',PLAN:'A plan was made',
  EVENT:'Something happened',RESOLUTION:'Resolved',OWNER_ASSERTION:'You said'};
const UNKNOWNS:Record<string,string>={NO_ACCEPTED_ASSESSMENT:'not yet decided',CONTESTED_BELIEF:'contested'};
const MEMBER_TYPES:Record<string,string>={frame_instance:'situation',proposition:'belief',claim:'statement',entity:'person or thing',
  resolution_assertion:'resolution'};
const text=(value:string)=>value.toLowerCase().replaceAll('_',' ');

function Section({id,title,children}:{id:string;title:string;children:React.ReactNode}){
  return <section className="card" aria-labelledby={id}><h2 id={id}>{title}</h2>{children}</section>;
}

function Thread({thread}:{thread:MemoryThreadView}){
  const title=thread.displayTitle??'Untitled thread';
  return <>
    <p>{title} · {text(thread.lifecycle)} · started {dateText(thread.createdAt)}</p>
    <Section id="projection" title="Current projection">
      {thread.currentProjection.length===0?<p>No typed projection covers this thread.</p>:<ul>{thread.currentProjection.map(fragment=><li key={fragment.projectionName}>
        {PROJECTIONS[fragment.projectionName]??fragment.projectionName}: {fragment.rowCount} {fragment.rowCount===1?'row':'rows'} —{' '}
        {fragment.isComplete?<Status kind="complete"/>:<Status kind="incomplete"/>} · includes your changes up to owner sequence {fragment.ownerOverlayWatermark}
        {fragment.pendingAssertions.map(pending=><p key={pending.overlayDeltaId}><Status kind="pending-owner"/> “{pending.rawText}”</p>)}
      </li>)}</ul>}
    </Section>
    <Section id="timeline" title="Timeline">
      {thread.timeline.length===0?<p>Nothing has happened in this thread yet.</p>:<ol>{thread.timeline.map(entry=><li key={entry.kind+entry.objectId}>
        {dateText(entry.at)} — {TIMELINE[entry.kind]??entry.kind}{entry.detail?<> ({text(entry.detail)})</>:null}
        {entry.kind==='RESOLUTION'&&<> <BeliefLinks objectType="resolution_assertion" objectId={entry.objectId} about="this resolution"/></>}
        {entry.kind==='OWNER_ASSERTION'&&<> <BeliefLinks objectType="owner_overlay_delta" objectId={entry.objectId} about="what you said"/></>}
      </li>)}</ol>}
    </Section>
    <Section id="plans" title="Plans and expected outcomes">
      {thread.plansAndExpectedOutcomes.length===0?<p>No plan or expected outcome recorded.</p>:<ul>{thread.plansAndExpectedOutcomes.map(plan=><li key={plan.propositionId}>
        <Status kind="scheduled" detail={text(plan.modality)}/> {predicateText(plan.predicateId)}: {valueText(plan.normalizedValue)}
        {' '}<BeliefLinks objectType="proposition" objectId={plan.propositionId} about={predicateText(plan.predicateId)}/>
      </li>)}</ul>}
    </Section>
    <Section id="events" title="Actual events">
      {thread.actualEvents.length===0?<p>No actual event recorded.</p>:<ul>{thread.actualEvents.map(event=><li key={event.propositionId}>
        <Status kind={assessmentStatus(event.assessmentStatus)}/> {predicateText(event.predicateId)}: {valueText(event.normalizedValue)}
        {' '}<BeliefLinks objectType="proposition" objectId={event.propositionId} about={predicateText(event.predicateId)}/>
      </li>)}</ul>}
    </Section>
    <Section id="resolution-links" title="Resolution links">
      {thread.resolutionLinks.length===0?<p>Nothing in this thread has been resolved.</p>:<ul>{thread.resolutionLinks.map(link=><li key={link.resolutionAssertionId}>
        {link.lifecycle==='ACCEPTED'?<Status kind={outcomeStatus(link.outcomeCode)} detail={text(link.outcomeCode)}/>:<>{text(link.outcomeCode)} ({text(link.lifecycle)})</>}
        {' '}effective {dateText(link.effectiveAt)}{link.targetFrameInstanceId?' — realized by another situation':''}
        {' '}<BeliefLinks objectType="resolution_assertion" objectId={link.resolutionAssertionId} about="this resolution"/>
      </li>)}</ul>}
    </Section>
    <Section id="uncertainties" title="Open uncertainties">
      {thread.openUncertainties.length===0?<p>Nothing in this thread is unsettled.</p>:<ul>{thread.openUncertainties.map(unknown=><li key={unknown.kind+(unknown.objectId??'')}>
        <Status kind={unknown.detail==='CONTESTED_BELIEF'?'contested':'provisional'}/> {UNKNOWNS[unknown.detail]??text(unknown.detail)}
        {unknown.objectId&&unknown.objectType==='propositions'&&<> <BeliefLinks objectType="proposition" objectId={unknown.objectId} about="this open question"/></>}
      </li>)}</ul>}
    </Section>
    <Section id="related" title="Related people, documents and decisions">
      <h3>People</h3>
      {thread.relatedPeople.length===0?<p>No one is named in this thread.</p>:<ul>{thread.relatedPeople.map(person=><li key={person.entityId}>
        {person.canonicalLabel??'An unnamed '+person.entityKind.toLowerCase()}</li>)}</ul>}
      <h3>Documents</h3>
      {thread.relatedDocuments.length===0?<p>No document is part of this thread.</p>:<ul>{thread.relatedDocuments.map(document=><li key={document.entityId}>
        {document.canonicalLabel??'An untitled document'}</li>)}</ul>}
      <h3>Decisions</h3>
      {thread.relatedDecisions.length===0?<p>No decision is part of this thread.</p>:<ul>{thread.relatedDecisions.map(decision=><li key={decision.frameInstanceId}>
        {predicateText(decision.frameTypeId)} <BeliefLinks objectType="frame_instance" objectId={decision.frameInstanceId} about="this decision"/></li>)}</ul>}
    </Section>
    <Section id="members" title="What this thread groups">
      <p>A thread groups what memory already holds. Adding something to it copies no evidence: an item in two threads is backed by the same sources in both.</p>
      <ul>{thread.members.map(member=><li key={member.objectType+member.objectId}>
        A {MEMBER_TYPES[member.objectType]??member.objectType} ({text(member.membershipKind)}), backed by {member.evidenceIds.length} {member.evidenceIds.length===1?'source':'sources'}
      </li>)}</ul>
    </Section>
  </>;
}

export function MemoryThread(props:MemoryThreadProps){
  return <MemoryPage current={null} eyebrow="MEMORY THREAD" title={props.thread?.displayTitle??'Memory thread'}
    intro={<p>One situation followed through time: what was planned, what actually happened, and what is still open.</p>}
    footer="A thread is computed from memory each time it is read. It stores no belief of its own.">
    {props.state==='ready'&&props.thread&&<Thread thread={props.thread}/>}
    {props.error&&<p role="alert">{props.error}</p>}
  </MemoryPage>;
}
