import React from 'react';
import type {BehavioralObservation,CertaintyLabel,ReviewSection,ReviewStatement,WeeklyReview as Review} from '@unai/domain';
import {Navigation} from './Navigation';

/** The Weekly review screen (design journey J6; PRD §7.5, §39). */
export interface WeeklyReviewProps {
  weekStart:string;
  review:Review|null;
  /** Shown while a review is being prepared. */
  loading?:boolean;
  error?:string;
}

/** Each label is text, distinguishable without colour (PRD §37.2). */
export const labelText:Record<CertaintyLabel,string>={
  CONFIRMED:'Confirmed',REPORTED:'Reported',INFERRED:'Inferred',CONFLICTING:'Contested',UNKNOWN:'Unknown',
  SCHEDULED:'Scheduled',INTENDED:'Intended',COMMITTED:'Committed',PREDICTED:'Predicted',RECOMMENDED:'Recommended',
};

function Statement({statement}:{statement:ReviewStatement}){
  return <li><span className="label">[{labelText[statement.label]}]</span> {statement.text}
    <small> · Sources: {statement.grounds.length} {statement.grounds.length===1?'item':'items'} from this review’s context packet</small></li>;
}

function Section({id,title,section,children}:{id:string;title:string;section:ReviewSection;children?:React.ReactNode}){
  return <section className="card" aria-labelledby={id}>
    <h2 id={id}>{title}</h2>
    {section.availability==='AVAILABLE'
      ?<ul>{section.statements.map(statement=><Statement key={statement.statementId} statement={statement}/>)}</ul>
      :<p>{section.availability==='NOT_AVAILABLE_IN_THIS_RELEASE'?'Not available yet. ':''}{section.note}</p>}
    {children}
  </section>;
}

function Observation({observation}:{observation:BehavioralObservation}){
  return <section className="card" aria-labelledby={'observation-'+observation.behavioralObservationId}>
    <h3 id={'observation-'+observation.behavioralObservationId}>Behavioral observation</h3>
    <p><span className="label">[Inferred]</span> {observation.statement}</p>
    <dl>
      <dt>Supporting episodes</dt><dd>{observation.supportingEpisodes.length}: {observation.supportingEpisodes.map(episode=>
        'moved from '+episode.previousDueAt.slice(0,10)+' to '+episode.newDueAt.slice(0,10)).join('; ')}</dd>
      <dt>Counterexample search</dt><dd>{observation.counterexampleSearch.searched} Found: {observation.counterexampleSearch.counterexamplesFound}.</dd>
      <dt>Observation window</dt><dd>{observation.observationWindow.from.slice(0,10)} to {observation.observationWindow.to.slice(0,10)}</dd>
      <dt>Confidence</dt><dd>{Math.round(observation.confidence*100)}%</dd>
      <dt>Review or expiry date</dt><dd>{observation.reviewOrExpiryDate}</dd>
    </dl>
  </section>;
}

export function WeeklyReview(props:WeeklyReviewProps){
  const review=props.review;
  return <div className="shell">
    <a className="skip" href="#content">Skip to content</a>
    <header><a href="/" className="brand">Uai</a><span>Your personal memory</span></header>
    <Navigation current="weekly-review"/>
    <main id="content" tabIndex={-1}>
      <p className="eyebrow">WEEKLY REVIEW</p>
      <h1>Weekly review</h1>
      <form method="get" action="/weekly-review" className="card">
        <label htmlFor="week-start">Week starting</label>
        <input id="week-start" name="weekStart" type="date" defaultValue={props.weekStart} required/>
        <button type="submit">Show review</button>
      </form>
      <div role="status" aria-live="polite">{props.loading&&<p>Preparing the review for the week starting {props.weekStart}…</p>}</div>
      {review&&<>
        <p>Week of {review.weekStart} to {review.weekEnd} ({review.timeZone}). {review.statementCount} {review.statementCount===1?'statement':'statements'}, each grounded in the context packet recorded for this review.</p>
        <Section id="priorities" title="Stated priorities and where the time went" section={review.priorityVersusCalendar}/>
        <Section id="commitments" title="Open commitments and completed outcomes" section={review.commitmentsVersusResolutions}/>
        <Section id="decisions" title="Decisions and their outcomes" section={review.decisionsVersusOutcomes}/>
        <Section id="spending" title="Planned and observed spending" section={review.plannedVersusObservedSpending}/>
        <Section id="changes" title="What changed" section={review.materialChanges}/>
        <Section id="postponement" title="Repeated postponement" section={review.repeatedPostponement}>
          {review.behavioralObservations.map(observation=><Observation key={observation.behavioralObservationId} observation={observation}/>)}
          {review.behavioralObservations.length===0&&<p className="muted">No behavioral observation: {review.repeatedPostponement.episodeCount===1
            ?'a single episode is not enough to support one.':'no pattern is supported by more than one episode.'}</p>}
        </Section>
        <p className="muted">Recorded from context packet {review.contextPacketId}. Every statement above names the objects of that packet it rests on.</p>
      </>}
      {props.error&&<p role="alert">{props.error}</p>}
    </main>
    <footer>The review states what the record shows. It does not judge.</footer>
  </div>;
}
