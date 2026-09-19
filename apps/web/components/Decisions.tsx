import React,{useState} from 'react';
import type {CertaintyLabel,DecisionDetail,DecisionProjectionRow,DecisionProjectionView,DecisionSource,MemoryLabel,
  PredictionComparison} from '@unai/domain';
import {CertaintyBadge,LabelKey,withoutIdentifiers} from './Labels';
import {Shell} from './Shell';
import {domainText} from './Goals';

/** The Decisions workspace (design journey J7, "Decisions workspace"; PRD §7.4,
 * §25.3, §52; ADR 0029 §3-§6). Every drawn state is reachable from props alone:
 * the decision list, the detail backed by a decision_projection row, awaiting
 * its review date, a prediction review with predicted versus actual and its
 * resolution code, the rationale reconstruction with its sources, and a
 * decision with no recorded outcome yet. */
export interface DecisionsProps {
  /** GET /v1/projections/decisions, or null when it could not be read. */
  view:DecisionProjectionView|null;
  /** GET /v1/decisions/{id} for the decision the owner opened. */
  detail:DecisionDetail|null;
  /** Goals a new decision may be tied to. */
  goals:{goalId:string;title:string}[];
  /** Today, owner-local, so "awaiting its review date" is decided by the server
   * render rather than by the browser's clock. */
  today:string;
  error?:string;
}

const day=(iso:string|null)=>iso?iso.slice(0,10):'';
export const resolutionText={CONFIRMED:'Confirmed',REFUTED:'Refuted',PARTIALLY_CONFIRMED:'Partially confirmed'} as const;
const lifecycleText:Record<PredictionComparison['resolutionLifecycle'],string>={
  PROPOSED:'recorded as proposed; accepting it is a governed memory decision',ACCEPTED:'accepted',CONTESTED:'contested',
  REJECTED:'rejected',SUPERSEDED:'superseded by a later review',WITHDRAWN:'withdrawn'};
const kindText={QUESTION:'The question',OPTION:'An option',ASSUMPTION:'An assumption',CONSEQUENCE:'A consequence',
  RECOMMENDATION:'The recommendation',CHOICE:'Your choice',RATIONALE:'Your reason',EXPECTED_RESULT:'The expected result'} as const;
const memoryLabel=(label:CertaintyLabel):MemoryLabel=>label==='CONFLICTING'?'CONTESTED':label;
const DOMAINS=Object.keys(domainText) as (keyof typeof domainText)[];

/** Where a decision stands, in words. The clock sets "review due"; only a
 * recorded review sets an outcome. */
export function decisionState(row:DecisionProjectionRow,today:string):string{
  if(row.reviewOutcomeCode)return 'Reviewed: '+resolutionText[row.reviewOutcomeCode].toLowerCase();
  if(row.reviewDue)return 'Review due since '+day(row.reviewDate)+'; no outcome recorded yet';
  if(row.reviewDate&&day(row.reviewDate)>=today)return 'Awaiting its review date ('+day(row.reviewDate)+')';
  return 'No recorded outcome yet';
}

async function write(path:string,body:unknown):Promise<{status:'ok'|'expired'|'refused';body:unknown}>{
  const response=await fetch('/api/platform/'+path,{method:'POST',headers:{'content-type':'application/json','x-purpose':'decisions.record',
    'x-correlation-id':crypto.randomUUID(),'idempotency-key':crypto.randomUUID().replaceAll('-','')},body:JSON.stringify(body)});
  if(response.status===401)return {status:'expired',body:null};
  return {status:response.ok?'ok':'refused',body:response.ok?await response.json():null};
}

function Sources({sources}:{sources:DecisionSource[]}){
  if(sources.length===0)return <small> · No source is recorded for this statement.</small>;
  return <ul className="sources">{sources.map(source=><li key={source.relation+source.evidenceId}>
    {source.relation==='STATED_IN'?'Stated in your decision record':'A source you cited'}
    {source.occurredAt?' ('+day(source.occurredAt)+')':''}: {source.excerpt===null?'the excerpt is withheld from this view.':<q>{withoutIdentifiers(source.excerpt)}</q>}
  </li>)}</ul>;
}

function Rationale({detail}:{detail:DecisionDetail}){
  const {rationale}=detail;
  return <section className="card" aria-labelledby="rationale">
    <h2 id="rationale">Why did I make this decision?</h2>
    <p>{withoutIdentifiers(rationale.answer)}</p>
    {rationale.reasonRecorded?null:<p>No reason or assumption was recorded with this decision, so none is given here.</p>}
    <ul>{rationale.items.map(item=><li key={item.kind+item.propositionId}>
      <CertaintyBadge label={memoryLabel(item.label)}/> <strong>{kindText[item.kind]}:</strong> {withoutIdentifiers(item.text)}
      <Sources sources={item.sources}/>
    </li>)}</ul>
    <small>Composed from your recorded decision only; nothing here is generated or taken from outside your memory.</small>
  </section>;
}

function Comparison({review}:{review:PredictionComparison}){
  return <section className="card" aria-labelledby={'review-'+review.resolutionAssertionId}>
    <h3 id={'review-'+review.resolutionAssertionId}>Prediction review: {resolutionText[review.resolutionCode]}</h3>
    <table>
      <caption>Predicted versus actual, reviewed {day(review.effectiveAt)}</caption>
      <thead><tr><th scope="col">Predicted</th><th scope="col">Actual</th></tr></thead>
      <tbody><tr>
        <td><CertaintyBadge label="PREDICTED"/> {withoutIdentifiers(review.predicted.text)}</td>
        <td>{withoutIdentifiers(review.actual.text)}{review.actual.citedEvidenceIds.length>0?<small> · {review.actual.citedEvidenceIds.length} cited {review.actual.citedEvidenceIds.length===1?'source':'sources'}</small>:null}</td>
      </tr></tbody>
    </table>
    <p>Resolution code: <strong>{review.resolutionCode}</strong> ({resolutionText[review.resolutionCode].toLowerCase()}); {lifecycleText[review.resolutionLifecycle]}.</p>
    <p>Your original prediction is kept exactly as you stated it, with its sources; the review is recorded beside it.</p>
  </section>;
}

function ReviewForm({row,busy,onSubmit}:{row:DecisionProjectionRow;busy:boolean;onSubmit:(body:Record<string,string>)=>void}){
  const [actual,setActual]=useState('');
  const [code,setCode]=useState<keyof typeof resolutionText>('CONFIRMED');
  return <form aria-labelledby="review-form" onSubmit={event=>{event.preventDefault();onSubmit({actualOutcome:actual,outcomeCode:code});}}>
    <h3 id="review-form">Review the prediction</h3>
    <p className="muted">You expected: “{withoutIdentifiers(row.expectedResult??'')}”. Recording what happened adds the actual outcome and your verdict beside the prediction; the prediction itself is not changed.</p>
    <label htmlFor="review-actual">What actually happened</label>
    <textarea id="review-actual" required maxLength={1000} value={actual} onChange={event=>setActual(event.target.value)}/>
    <fieldset><legend>How did the prediction hold?</legend>
      {(Object.keys(resolutionText) as (keyof typeof resolutionText)[]).map(value=><label key={value}>
        <input type="radio" name="review-code" value={value} checked={code===value} onChange={()=>setCode(value)}/> {resolutionText[value]}
      </label>)}
    </fieldset>
    <button type="submit" disabled={busy}>Record the review</button>
  </form>;
}

function Detail({detail,today,busy,onReview}:{detail:DecisionDetail;today:string;busy:boolean;onReview:(body:Record<string,string>)=>void}){
  const row=detail.decision;
  return <>
    <section className="card" aria-labelledby="decision-detail">
      <h2 id="decision-detail">{withoutIdentifiers(row.question??'Decision')}</h2>
      <p role="note">{decisionState(row,today)}.</p>
      <dl>
        <dt>Question</dt><dd>{withoutIdentifiers(row.question??'Not recorded')}</dd>
        <dt>Options</dt><dd>{row.alternatives.length===0?'None recorded':<ul>{row.alternatives.map(option=><li key={option.propositionId}>{withoutIdentifiers(option.text)}</li>)}</ul>}</dd>
        <dt>Assumptions</dt><dd>{row.assumptions.length===0?'None recorded':<ul>{row.assumptions.map(assumption=><li key={assumption.propositionId}>
          {withoutIdentifiers(assumption.text)}{assumption.citedEvidenceIds.length>0?<small> · {assumption.citedEvidenceIds.length} cited {assumption.citedEvidenceIds.length===1?'source':'sources'}</small>:null}</li>)}</ul>}</dd>
        <dt>Cross-domain consequences</dt><dd>{row.crossDomainConsequences.length===0?'None recorded':<ul>{row.crossDomainConsequences.map(consequence=><li key={consequence.propositionId}>
          <strong>{domainText[consequence.domain]}:</strong> {withoutIdentifiers(consequence.text)}</li>)}</ul>}</dd>
        <dt>Recommendation</dt><dd>{row.recommendation?<><CertaintyBadge label="RECOMMENDED"/> {withoutIdentifiers(row.recommendation)}</>:'None recorded'}</dd>
        <dt>Your choice</dt><dd>{row.userChoice?withoutIdentifiers(row.userChoice):'Not chosen yet'}</dd>
        <dt>Expected result</dt><dd>{row.expectedResult?<><CertaintyBadge label="PREDICTED"/> {withoutIdentifiers(row.expectedResult)}</>:'None recorded'}</dd>
        <dt>Review date</dt><dd>{row.reviewDate?day(row.reviewDate):'None set'}</dd>
        <dt>Actual outcome</dt><dd>{row.actualOutcome?<>{withoutIdentifiers(row.actualOutcome)}{row.reviewOutcomeCode?<> ({resolutionText[row.reviewOutcomeCode].toLowerCase()})</>:null}</>:'No recorded outcome yet.'}</dd>
      </dl>
      <p className="muted">Read from the decision projection{row.isComplete?'':'; it is incomplete, so some of your recent statements may not be reflected yet'}. Updated {day(row.updatedAt)}.</p>
      {row.conflictFlag?<p className="notice">Your memory holds conflicting values for part of this decision.</p>:null}
    </section>
    <Rationale detail={detail}/>
    <section className="card" aria-labelledby="reviews">
      <h2 id="reviews">Predicted versus actual</h2>
      {detail.reviews.length===0?<p>{row.expectedResult?'No review recorded yet.':'No expected result was recorded, so there is no prediction to review.'}</p>:null}
      {detail.reviews.map(review=><Comparison key={review.resolutionAssertionId} review={review}/>)}
      {row.expectedResult?<ReviewForm row={row} busy={busy} onSubmit={onReview}/>:null}
    </section>
  </>;
}

const lines=(text:string)=>text.split('\n').map(line=>line.trim()).filter(line=>line!=='');

function RecordForm({goals,busy,onSubmit}:{goals:DecisionsProps['goals'];busy:boolean;onSubmit:(body:Record<string,unknown>)=>void}){
  const [fields,setFields]=useState({question:'',options:'',assumptions:'',recommendation:'',userChoice:'',rationale:'',expectedResult:'',reviewDate:'',goalId:''});
  const [consequences,setConsequences]=useState<{domain:keyof typeof domainText;text:string}[]>([]);
  const [domain,setDomain]=useState<keyof typeof domainText>('FINANCE');
  const [consequence,setConsequence]=useState('');
  const set=(key:keyof typeof fields)=>(event:{target:{value:string}})=>setFields(current=>({...current,[key]:event.target.value}));
  const optional=(key:keyof typeof fields)=>fields[key].trim()?{[key]:fields[key].trim()}:{};
  return <form className="card" aria-labelledby="record-decision" onSubmit={event=>{event.preventDefault();onSubmit({
    question:fields.question.trim(),options:lines(fields.options),assumptions:lines(fields.assumptions).map(text=>({text})),consequences,
    ...optional('recommendation'),...optional('userChoice'),...optional('rationale'),...optional('expectedResult'),...optional('goalId'),
    ...(fields.reviewDate?{reviewDate:fields.reviewDate+'T09:00:00.000Z'}:{})});}}>
    <h2 id="record-decision">Record a decision</h2>
    <p className="muted">Your words are kept as evidence and every field points back to them. Nothing is accepted into memory without review.</p>
    <label htmlFor="decision-question">Question</label>
    <input id="decision-question" required maxLength={1000} value={fields.question} onChange={set('question')}/>
    <label htmlFor="decision-options">Options, one per line</label>
    <textarea id="decision-options" required value={fields.options} onChange={set('options')}/>
    <label htmlFor="decision-assumptions">Assumptions, one per line</label>
    <textarea id="decision-assumptions" value={fields.assumptions} onChange={set('assumptions')}/>
    <fieldset><legend>Cross-domain consequences</legend>
      {consequences.length>0?<ul>{consequences.map((entry,index)=><li key={index}>{domainText[entry.domain]}: {entry.text}</li>)}</ul>:null}
      <label htmlFor="consequence-domain">Area of life</label>
      <select id="consequence-domain" value={domain} onChange={event=>setDomain(event.target.value as keyof typeof domainText)}>
        {DOMAINS.map(value=><option key={value} value={value}>{domainText[value]}</option>)}
      </select>
      <label htmlFor="consequence-text">Consequence</label>
      <input id="consequence-text" maxLength={1000} value={consequence} onChange={event=>setConsequence(event.target.value)}/>
      <button type="button" onClick={()=>{if(consequence.trim()){setConsequences(list=>[...list,{domain,text:consequence.trim()}]);setConsequence('');}}}>Add the consequence</button>
    </fieldset>
    <label htmlFor="decision-recommendation">Recommendation (optional)</label>
    <input id="decision-recommendation" maxLength={1000} value={fields.recommendation} onChange={set('recommendation')}/>
    <label htmlFor="decision-choice">Your choice (optional)</label>
    <input id="decision-choice" maxLength={1000} value={fields.userChoice} onChange={set('userChoice')}/>
    <label htmlFor="decision-rationale">Why you chose it (optional)</label>
    <textarea id="decision-rationale" maxLength={2000} value={fields.rationale} onChange={set('rationale')}/>
    <label htmlFor="decision-expected">Expected result (optional)</label>
    <input id="decision-expected" maxLength={1000} value={fields.expectedResult} onChange={set('expectedResult')}/>
    <label htmlFor="decision-review-date">Review date (optional)</label>
    <input id="decision-review-date" type="date" value={fields.reviewDate} onChange={set('reviewDate')}/>
    {goals.length>0?<><label htmlFor="decision-goal">Related goal (optional)</label>
      <select id="decision-goal" value={fields.goalId} onChange={set('goalId')}>
        <option value="">None</option>{goals.map(goal=><option key={goal.goalId} value={goal.goalId}>{goal.title}</option>)}
      </select></>:null}
    <button type="submit" disabled={busy}>Record the decision</button>
  </form>;
}

export function Decisions(props:DecisionsProps){
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState(props.error??'');
  const [status,setStatus]=useState('');
  const {view,detail,today}=props;
  async function submit(path:string,body:unknown,failure:string,open:(result:unknown)=>string){
    setBusy(true);setError('');setStatus('Saving…');
    try{
      const result=await write(path,body);
      if(result.status==='expired'){window.location.assign('/signin?reason=expired');return;}
      if(result.status!=='ok')throw new Error('refused');
      window.location.assign(open(result.body));
    }catch{setStatus('');setError(failure);}
    finally{setBusy(false);}
  }
  const opened=(result:unknown)=>{
    const id=(result as {decision?:{decisionFrameInstanceId?:unknown}}|null)?.decision?.decisionFrameInstanceId;
    return typeof id==='string'?'/decisions?id='+encodeURIComponent(id):'/decisions';
  };
  const rows=view?.rows??[];
  return <Shell current="decisions" eyebrow="DECISIONS" title={detail?'Decision':'Decisions'} status={status}
    footer="A decision and its review are recorded from your own words. The original prediction is never rewritten by a review.">
    <LabelKey labels={['RECOMMENDED','PREDICTED','CONFIRMED','REPORTED','INFERRED','CONTESTED']}/>
    {detail?<>
      <p><a href="/decisions">All decisions</a></p>
      <Detail detail={detail} today={today} busy={busy}
        onReview={body=>void submit('decisions/'+detail.decision.decisionFrameInstanceId+'/review',body,
          'The review could not be recorded. Nothing changed. Please retry.',()=>'/decisions?id='+encodeURIComponent(detail.decision.decisionFrameInstanceId))}/>
    </>:<>
      {view?<section className="card" aria-labelledby="decision-list">
        <h2 id="decision-list">Your decisions</h2>
        {rows.length===0?<p>No decisions recorded yet.</p>:<ul>{rows.map(row=><li key={row.decisionFrameInstanceId}>
          <a href={'/decisions?id='+encodeURIComponent(row.decisionFrameInstanceId)}>{withoutIdentifiers(row.question??'Decision')}</a>
          {row.userChoice?<> — chose “{withoutIdentifiers(row.userChoice)}”</>:null}. {decisionState(row,today)}.
        </li>)}</ul>}
        <small>From the decision projection{view.isComplete?'':'; it is incomplete, so some recent statements may be missing'}.</small>
      </section>:null}
      <RecordForm goals={props.goals} busy={busy} onSubmit={body=>void submit('decisions',body,'The decision could not be recorded. Nothing changed. Please retry.',opened)}/>
    </>}
    {view||detail?<details className="advanced">
      <summary>Advanced inspector: projection and identifiers</summary>
      <dl>
        {view?<><dt>Projection</dt><dd><code>{view.projectionName}</code> · reducer <code>{view.reducerVersion}</code> · owner overlay watermark {view.ownerOverlayWatermark} · canonical watermark <code>{view.canonicalTransactionWatermark}</code> · {view.isComplete?'complete':'incomplete'}</dd></>:null}
        {detail?<>
          <dt>Decision frame instance</dt><dd><code>{detail.decision.decisionFrameInstanceId}</code></dd>
          <dt>Projection version</dt><dd><code>{detail.decision.projectionVersion}</code> · reducer <code>{detail.decision.reducerVersion}</code></dd>
          <dt>Predicted outcome propositions</dt><dd>{detail.decision.predictedOutcomePropositionIds.map(id=><code key={id}>{id} </code>)}</dd>
          <dt>Actual resolutions</dt><dd>{detail.decision.actualResolutionIds.map(id=><code key={id}>{id} </code>)}</dd>
          <dt>Rationale context packet</dt><dd><code>{detail.rationale.contextPacketId}</code> · hash <code>{detail.rationale.packetHash}</code> · {detail.rationale.composerVersion}</dd>
          {detail.reviews.map(review=><React.Fragment key={review.resolutionAssertionId}>
            <dt>Review {review.resolutionCode}</dt><dd>resolution <code>{review.resolutionAssertionId}</code> · contract <code>{review.transitionContractId}</code> · predicted <code>{review.predicted.propositionId}</code> · actual <code>{review.actual.propositionId}</code></dd>
          </React.Fragment>)}
        </>:null}
      </dl>
    </details>:null}
    {error?<p role="alert">{error}</p>:null}
  </Shell>;
}
