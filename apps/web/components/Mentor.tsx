import React from 'react';
import type {InterruptionReason,MentorCard,MentorView} from '@unai/domain';
import {CertaintyBadge,withoutIdentifiers} from './Labels';
import {Shell} from './Shell';
import {domainText,priorityText} from './Goals';

/** The Mentor contradiction card screen (design journey J7, "Mentor
 * contradiction card"; PRD §4.9, §36.13, §37.7; ADR 0029 §7). Every drawn state
 * is reachable from props alone: a contradiction between a stated goal and the
 * calendar, its evidence, inference and recommendation labelled distinctly, a
 * card emitted within the attention budget, and one withheld because the budget
 * is exhausted. */
export interface MentorProps {
  view:MentorView|null;
  error?:string;
}

/** Why a card is, or is not, in front of the owner -- words, never colour. */
export const mentorReasonText:Record<InterruptionReason,string>={
  WITHIN_ATTENTION_BUDGET:'Shown within today’s attention budget.',
  REOPENED_BY_MATERIAL_NEW_EVIDENCE:'Shown again because new calendar evidence arrived.',
  DAILY_BUDGET_EXHAUSTED:'Withheld: today’s attention budget is used up.',
  SCOPE_BUDGET_EXHAUSTED:'Withheld: today’s item for this sensitivity scope was already shown.',
  VALUE_BELOW_INTERRUPTION_COST:'Withheld: not worth interrupting you for today.',
  ASKED_WITHIN_SUPPRESSION_WINDOW:'Withheld: shown recently, and no new evidence has arrived.',
  KEPT_UNCERTAIN_WITHIN_SUPPRESSION_WINDOW:'Withheld: you chose to leave this for now.',
  LEARNED_RULE_APPLIED:'Handled by a learned approval rule you approved.',
};
const day=(iso:string)=>iso.slice(0,10);
const hours=(minutes:number)=>(Math.round(minutes/6)/10)+' h';

function Card({card}:{card:MentorCard}){
  const id='mentor-'+card.mentorCardId;
  const {inference}=card;
  return <section className="card" aria-labelledby={id}>
    <h2 id={id}>“{card.goalTitle}” and your calendar</h2>
    <p className="muted">{domainText[card.goalDomain]} · observed {day(card.observationWindow.from)} to {day(card.observationWindow.to)} · {mentorReasonText[card.reason]}</p>
    <section aria-labelledby={id+'-evidence'}>
      <h3 id={id+'-evidence'}>Evidence: what your records show</h3>
      <ul>{card.evidence.map(item=><li key={item.kind}>
        <span className="label label-solid" data-label="EVIDENCE"><span className="glyph" aria-hidden="true">▤</span> Evidence</span>{' '}
        {withoutIdentifiers(item.text)}<small> · {item.grounds.length} {item.grounds.length===1?'record':'records'}</small>
      </li>)}</ul>
    </section>
    <section aria-labelledby={id+'-inference'}>
      <h3 id={id+'-inference'}>Inference: what Uai concludes from it</h3>
      <p><CertaintyBadge label="INFERRED"/> {withoutIdentifiers(inference.text)}</p>
      <dl>
        <dt>Confidence</dt><dd>{Math.round(inference.confidence*100)}%</dd>
        <dt>Time on this goal’s area</dt><dd>{hours(inference.goalMinutes)} of {hours(inference.totalMinutes)} scheduled ({inference.sharePercent}%) across {inference.eventCount} calendar events</dd>
        <dt>Counterexample search</dt><dd>{withoutIdentifiers(inference.counterexampleSearch.searched)} Found: {inference.counterexampleSearch.counterexamplesFound}.</dd>
      </dl>
    </section>
    <section aria-labelledby={id+'-recommendation'}>
      <h3 id={id+'-recommendation'}>Recommendation: a suggestion, not a decision</h3>
      <p><CertaintyBadge label="RECOMMENDED"/> {withoutIdentifiers(card.recommendation.text)}</p>
      <p><a href="/goals">Change the goal’s priority</a> if it no longer holds.</p>
    </section>
  </section>;
}

export function Mentor(props:MentorProps){
  const {view}=props;
  return <Shell current="mentor" eyebrow="MENTOR" title="Mentor"
    footer="The mentor reads your stated goals and your calendar. It suggests; it never acts, and nothing it says is stored as your intention.">
    <p>Where your calendar and a goal you stated disagree. Each card keeps what the record shows, what Uai concludes and what it suggests apart.</p>
    {view?<>
      <p>Today ({view.ownerLocalDate}, {view.timeZone}): {view.proactiveItemsToday} of {view.budget.maxCardsPerDay} proactive {view.budget.maxCardsPerDay===1?'item':'items'} shown, {view.remainingToday} left, at most {view.budget.maxCardsPerSensitivityScopePerDay} per sensitivity scope. Mentor cards and Memory inbox questions share this one budget.</p>
      {view.cards.length===0&&view.withheld.length===0?<section className="card"><p>No contradiction between your goals and your calendar right now.</p></section>:null}
      {view.cards.map(card=><Card key={card.mentorCardId} card={card}/>)}
      {view.withheld.length>0?<section className="card" aria-labelledby="withheld">
        <h2 id="withheld">Withheld today</h2>
        <p>{view.remainingToday===0?'Today’s attention budget is used up, so these were not shown. ':''}They are recorded and can be shown on a later day.</p>
        <ul>{view.withheld.map(card=><li key={card.mentorCardId}><strong>{card.goalTitle}</strong>: {mentorReasonText[card.reason]}</li>)}</ul>
      </section>:null}
      {view.respectedOverrides.length>0?<section className="card" aria-labelledby="overrides">
        <h2 id="overrides">Not raised: your temporary overrides</h2>
        <ul>{view.respectedOverrides.map(entry=><li key={entry.goalId}><strong>{entry.goalTitle}</strong>: you set it to {priorityText[entry.priority].toLowerCase()} priority until {day(entry.until)}, so your calendar is not measured against its stated priority.</li>)}</ul>
      </section>:null}
      <details className="advanced">
        <summary>Advanced inspector: how these cards were decided</summary>
        <dl>
          <dt>Context packet</dt><dd><code>{view.contextPacketId??'none'}</code> · {view.composerVersion}</dd>
          {[...view.cards,...view.withheld].map(card=><React.Fragment key={card.mentorCardId}>
            <dt>{card.goalTitle}: {card.decision} ({card.reason})</dt>
            <dd>card <code>{card.mentorCardId}</code> · goal <code>{card.goalId}</code> · priority entry <code>{card.goalPriorityHistoryId}</code> · scope {card.sensitivityScope} · budget when decided {card.policyInputs.budget.askedToday} of {card.policyInputs.budget.maxCardsPerDay}</dd>
          </React.Fragment>)}
        </dl>
      </details>
    </>:null}
    {props.error?<p role="alert">{props.error}</p>:null}
  </Shell>;
}
