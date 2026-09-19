import React,{useState} from 'react';
import type {CardDecisionResult,ClarificationCard,InterruptionReason,MemoryInboxView} from '@unai/domain';
import {Navigation} from './Navigation';

/** The Memory inbox screen (design journey J5, "Memory inbox"; PRD §7.7, §19.3,
 * §37.4). Every drawn state is reachable from props alone. */
export interface MemoryInboxProps {
  view:MemoryInboxView;
  /** The answer just recorded, shown with the decision that asked the question. */
  decided?:CardDecisionResult|null;
  error?:string;
}

/** Why a card is, or is not, in front of the owner -- words, never colour. */
export const reasonText:Record<InterruptionReason,string>={
  WITHIN_ATTENTION_BUDGET:'Asked within today’s attention budget.',
  REOPENED_BY_MATERIAL_NEW_EVIDENCE:'Asked again because material new evidence arrived.',
  DAILY_BUDGET_EXHAUSTED:'Deferred to batch review: today’s question budget is used up.',
  SCOPE_BUDGET_EXHAUSTED:'Deferred to batch review: today’s question for this sensitivity scope was already asked.',
  VALUE_BELOW_INTERRUPTION_COST:'Deferred to batch review: not worth interrupting you for.',
  ASKED_WITHIN_SUPPRESSION_WINDOW:'Not asked again: the same question was asked recently and no new evidence has arrived.',
  KEPT_UNCERTAIN_WITHIN_SUPPRESSION_WINDOW:'Not asked again: you chose to keep this uncertain.',
  LEARNED_RULE_APPLIED:'Answered by a learned approval rule you approved.',
};
const levelText={LOW:'low',MEDIUM:'medium',HIGH:'high'} as const;
const irreversibilityText={REVERSIBLE:'reversible',COSTLY_TO_REVERSE:'costly to reverse',IRREVERSIBLE:'irreversible'} as const;
const day=(iso:string|null)=>iso?iso.slice(0,10):'';

function scopeText(scope:string){
  const [category='',sensitivity='']=scope.split('/');
  return category.charAt(0)+category.slice(1).toLowerCase()+', '+sensitivity.toLowerCase();
}

/** The logged interruption decision: its inputs and its reason (PRD §19.4). */
function DecisionDetails({card}:{card:ClarificationCard}){
  if(!card.interruption)return null;
  const inputs=card.interruption.policyInputs;
  return <details>
    <summary>Why you are seeing this<span className="sr-only"> for {card.title}</span></summary>
    <p>{reasonText[card.interruption.reason]}</p>
    <dl>
      <dt>Chance the recorded reading is wrong</dt><dd>{Math.round(inputs.errorProbability*100)}%</dd>
      <dt>Consequence of an error</dt><dd>{levelText[inputs.consequence]}</dd>
      <dt>Reversibility</dt><dd>{irreversibilityText[inputs.irreversibility]}</dd>
      <dt>Urgency</dt><dd>{levelText[inputs.urgency]}</dd>
      <dt>Cost of interrupting you</dt><dd>{levelText[inputs.interruptionCost]}</dd>
      <dt>Budget when decided</dt><dd>{inputs.budget.askedToday} of {inputs.budget.maxCardsPerDay} questions asked that day, {inputs.budget.askedInScopeToday} of {inputs.budget.maxCardsPerSensitivityScopePerDay} in this scope</dd>
    </dl>
    <small>Decided {day(card.interruption.decidedAt)} ({inputs.timeZone}).</small>
  </details>;
}

function Card({card,busy,onChoose}:{card:ClarificationCard;busy:boolean;onChoose:(choiceId:string)=>void}){
  const id='card-'+card.clarificationCardId;
  return <section className="card" aria-labelledby={id}>
    <h2 id={id}>{card.title}</h2>
    <p className="muted">Sensitivity scope: {scopeText(card.sensitivityScope)} · {card.groupedAmbiguityIds.length} related {card.groupedAmbiguityIds.length===1?'question':'questions'} grouped into this card</p>
    {card.reopenedByEvidenceId&&<p>Asked again because material new evidence arrived.</p>}
    <ul>{card.facts.map(fact=><li key={fact}>{fact}</li>)}</ul>
    <h3>Why it matters</h3>
    <p>{card.whyItMatters}</p>
    <h3>Your choices</h3>
    <ul className="devices">{card.choices.map(choice=><li key={choice.choiceId}>
      <div><strong>{choice.label}</strong><p id={id+'-'+choice.choiceId}>What will change: {choice.whatWillChange}</p></div>
      <button disabled={busy} aria-describedby={id+'-'+choice.choiceId} onClick={()=>onChoose(choice.choiceId)}>{choice.label}<span className="sr-only"> for {card.title}</span></button>
    </li>)}</ul>
    <DecisionDetails card={card}/>
  </section>;
}

export function MemoryInbox(props:MemoryInboxProps){
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState(props.error??'');
  const [decided,setDecided]=useState<CardDecisionResult|null>(props.decided??null);
  const [answered,setAnswered]=useState<string[]>([]);
  const {view}=props;
  async function choose(card:ClarificationCard,choiceId:string){
    setBusy(true);setError('');
    try{
      const response=await fetch('/api/platform/memory/inbox/cards/'+card.clarificationCardId+'/decide',{method:'POST',
        headers:{'content-type':'application/json','x-purpose':'memory.inbox','x-correlation-id':crypto.randomUUID(),
          'idempotency-key':crypto.randomUUID().replaceAll('-','')},body:JSON.stringify({choiceId})});
      if(response.status===401){window.location.assign('/signin?reason=expired');return;}
      if(!response.ok)throw new Error('refused');
      // The answer is shown in place, with the decision that asked the question
      // and any rule it led Uai to propose; the card leaves the list.
      setDecided(await response.json() as CardDecisionResult);
      setAnswered(ids=>[...ids,card.clarificationCardId]);
    }catch{setError('Your answer could not be recorded. Nothing changed. Please retry.');}
    finally{setBusy(false);}
  }
  const nothing=view.cards.length===0&&view.deferredCount===0&&view.withheld.length===0&&view.resolvedToday.length===0;
  return <div className="shell">
    <a className="skip" href="#content">Skip to content</a>
    <header><a href="/" className="brand">Uai</a><span>Your personal memory</span></header>
    <Navigation current="memory-inbox"/>
    <main id="content" tabIndex={-1}>
      <p className="eyebrow">MEMORY</p>
      <h1>Memory inbox</h1>
      <p>Questions that are worth your answer but not urgent enough to interrupt you. Related questions about one situation come as one card.</p>
      <p role="status">Today ({view.ownerLocalDate}, {view.timeZone}): {view.remainingToday} of {view.budget.maxCardsPerDay} proactive {view.budget.maxCardsPerDay===1?'question':'questions'} left, at most {view.budget.maxCardsPerSensitivityScopePerDay} per sensitivity scope. A question you leave unanswered is not asked again for {view.budget.repeatQuestionSuppressionDays} days unless new evidence arrives.{view.budget.isDefault?' These are the default limits.':''}</p>
      {decided&&<section className="card" aria-labelledby="decided" role="status">
        <h2 id="decided">Your answer was recorded</h2>
        <p>{decided.card.title}: {decided.card.choices.find(choice=>choice.choiceId===decided!.answer.choiceId)?.label}.
          {decided.answer.proposedTransactionId?' A change to memory was proposed for review.':' Nothing in memory was changed.'}</p>
        {decided.interruptionDecision&&<p>This question was asked because: {reasonText[decided.interruptionDecision.reason]}</p>}
        {decided.proposedRule&&<p>Uai proposes a rule from your repeated answers: “{decided.proposedRule.ruleText}” It has no effect until you approve it in <a href="/memory/approval-rules">learned approval rules</a>.</p>}
      </section>}
      {nothing&&<section className="card"><p>Nothing needs your answer right now.</p></section>}
      {view.cards.filter(card=>!answered.includes(card.clarificationCardId)).map(card=><Card key={card.clarificationCardId} card={card} busy={busy} onChoose={choiceId=>void choose(card,choiceId)}/>)}
      {view.deferredCount>0&&<section className="card" aria-labelledby="deferred">
        <h2 id="deferred">Deferred to batch review</h2>
        <p>{view.remainingToday===0?'Today’s question budget is used up. ':''}{view.deferredCount} more {view.deferredCount===1?'question is':'questions are'} deferred to batch review rather than shown today.</p>
      </section>}
      {view.withheld.length>0&&<section className="card" aria-labelledby="withheld">
        <h2 id="withheld">Not asked again yet</h2>
        <ul>{view.withheld.map(card=><li key={card.clarificationCardId}>
          <strong>{card.title}</strong>: {card.interruption?reasonText[card.interruption.reason]:'Withheld.'}
          {card.suppressedUntil&&<> It can be asked again from {day(card.suppressedUntil)}, or sooner if new evidence arrives.</>}
          <DecisionDetails card={card}/>
        </li>)}</ul>
      </section>}
      {view.resolvedToday.length>0&&<section className="card" aria-labelledby="resolved">
        <h2 id="resolved">Answered today</h2>
        <ul>{view.resolvedToday.map(card=><li key={card.clarificationCardId}>
          <strong>{card.title}</strong>: {card.choices.find(choice=>choice.choiceId===card.answer?.choiceId)?.label??'answered'}
          {card.answer?.answeredBy==='LEARNED_RULE'?' — answered by a learned approval rule you approved.':' — your decision was recorded.'}
          <DecisionDetails card={card}/>
        </li>)}</ul>
      </section>}
      <p><a href="/memory/approval-rules">Learned approval rules</a></p>
      {error&&<p role="alert">{error}</p>}
    </main>
    <footer>Answering a card records your words as evidence and proposes a change; nothing already in memory is edited in place.</footer>
  </div>;
}
