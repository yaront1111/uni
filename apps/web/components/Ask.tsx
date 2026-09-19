import React,{useState} from 'react';
import type {AskAnswer,AskStatement,MemoryLabel,WhySources as WhySourcesPanel} from '@unai/domain';
import {BeliefRefLinks} from './BeliefLinks';
import {CertaintyBadge,LabelKey,displayLabelOf,withoutIdentifiers} from './Labels';
import {Shell} from './Shell';
import {WhySources} from './WhySources';

/**
 * The Ask screen (design journey J3, screen "Ask"; CRT-UX-03-A, CRT-UX-11-A,
 * CRT-UX-12-A).
 *
 * The question is a plain GET form, so it works from the keyboard and without
 * script; the server asks `POST /v1/ask`, which reads the owner's context through
 * the Context Broker, and renders the answer. With script, submitting announces
 * "classifying the requested answer type" in the live region while the answer is
 * prepared, and the answer itself arrives in that region's section.
 *
 * Each statement carries its certainty label, links to the sources it rests on
 * and a Why? / Sources action. Refusals and grounding-validator actions are said
 * in fixed sentences; API error text is never shown.
 */
export interface AskProps{
  state:'empty'|'answered'|'refused'|'error';
  question:string;
  answer:AskAnswer|null;
  /** The Why? / Sources panel of each statement, by statement id. */
  why:Record<string,WhySourcesPanel|null>;
  refusal?:string|null;
  error?:string|null;
}

export const EXAMPLE_QUESTIONS=Object.freeze(['What am I forgetting?','What changed in my life this month?',
  'Given my situation, what should I focus on?','Why did I decide against this before?',
  'What can you handle for me today?','What did I promise Daniel?','Do I still owe Daniel?']);

const ANSWER_TYPE:Record<AskAnswer['answerType'],string>={
  CURRENT_STATE:'What is true now',HISTORICAL_STATE:'What was true then',EPISODE_RECALL:'Remembering an episode',
  CAUSAL_EXPLANATION:'Why something happened',FUTURE_COMMITMENT:'What is promised or planned',
  PREDICTION_REVIEW:'A prediction and its outcome',AGGREGATION:'A count over memory',CONTRADICTION_CHECK:'Whether memory contradicts itself',
};
const REFUSAL:Record<string,string>={
  ASK_REQUEST_INCOMPLETE:'The question was refused because it did not declare everything an answer needs, such as its purpose.',
  ASK_REQUEST_INVALID:'The question was refused because it could not be read as asked.',
  CONTEXT_READ_DENIED:'The question was refused because your memory does not allow this purpose to read it.',
  CONTEXT_REQUEST_INVALID:'The question was refused because it could not be read as asked.',
};
const GROUNDING:Record<AskAnswer['grounding']['action'],string|null>={
  PASSED:null,
  DOWNGRADED:'Some wording was made less certain before this answer was shown, because its memory does not support more.',
  REGENERATED:'A first draft stated something memory does not hold, so the answer was composed again from memory.',
  BLOCKED:'The answer was blocked because it would have stated memory this question may not read.',
};

function sourceName(link:AskAnswer['sourceLinks'][number],index:number){
  return 'Source '+(index+1)+': '+link.sourceType.toLowerCase().replaceAll('_',' ')+(link.occurredAt?', '+link.occurredAt.slice(0,10):'');
}

function Statement({statement,answer,panel}:{statement:AskStatement;answer:AskAnswer;panel:WhySourcesPanel|null|undefined}){
  const links=answer.sourceLinks.filter(link=>statement.sourceEvidenceIds.includes(link.evidenceId));
  return <li className="statement">
    <p><CertaintyBadge label={displayLabelOf(statement)}/> {withoutIdentifiers(statement.text)}</p>
    {links.length>0?<ul className="source-links" aria-label="Sources">{links.map(link=><li key={link.evidenceId}>
      <a href={'/sources?evidence='+link.evidenceId}>{sourceName(link,answer.sourceLinks.indexOf(link))}</a></li>)}</ul>
      :<p className="muted">No source is linked to this statement.</p>}
    {panel!==undefined?<WhySources about={statement.text} panel={panel}/>:null}
    <BeliefRefLinks refs={statement.objectRefs} about={withoutIdentifiers(statement.text)}/>
  </li>;
}

export function Ask(props:AskProps){
  const [status,setStatus]=useState('');
  const answer=props.answer;
  const labels=answer?[...new Set<MemoryLabel>(answer.statements.map(displayLabelOf))]:[];
  const announced=status||(answer?'Answer ready: '+answer.statements.length+' statement'+(answer.statements.length===1?'':'s')+'.'
    :props.state==='refused'?'The question was refused.':'');
  return <Shell current="ask" eyebrow="ASK" title="Ask about your own context" status={announced}>
    <form className="card" method="get" action="/ask" role="search" aria-label="Ask a question"
      onSubmit={()=>setStatus('Classifying the requested answer type…')}>
      <label htmlFor="question">Your question</label>
      <input id="question" name="q" type="search" required maxLength={2000} defaultValue={props.question} autoComplete="off"
        placeholder="For example: What did I promise Daniel?"/>
      <button type="submit">Ask</button>
      <p className="muted">Answers come only from your own memory, read for personal assistance, and say how sure they are.</p>
    </form>
    {props.state==='error'?<p role="alert">{props.error??'The question could not be answered. Please retry.'}</p>:null}
    {props.state==='refused'?<p role="alert">{REFUSAL[props.refusal??'']??'The question was refused.'}</p>:null}
    {props.state==='empty'?<section className="card" aria-labelledby="examples">
      <h2 id="examples">Example questions</h2>
      <ul>{EXAMPLE_QUESTIONS.map(question=><li key={question}><a href={'/ask?q='+encodeURIComponent(question)}>{question}</a></li>)}</ul>
    </section>:null}
    {answer?<section className="card answer" aria-labelledby="answer-title">
      <h2 id="answer-title">Answer</h2>
      <p>Question: {answer.question}</p>
      <p>Answer type: <strong>{ANSWER_TYPE[answer.answerType]}</strong>{answer.historicalMode==='HISTORICAL_BELIEF_STATE'?' (what Uai believed then, from what it knew then)'
        :answer.historicalMode==='CORRECTED_HISTORICAL_STATE'?' (what is now believed to have been true then)':''}.</p>
      {GROUNDING[answer.grounding.action]?<p className="notice">{GROUNDING[answer.grounding.action]}</p>:null}
      {answer.declinesToAssert?<p className="notice">Memory does not hold enough to answer this with confidence, so this answer does not assert anything.</p>:null}
      <LabelKey labels={labels}/>
      <ol className="statements">{answer.statements.map(statement=><Statement key={statement.statementId} statement={statement} answer={answer}
        panel={statement.statementId in props.why?props.why[statement.statementId]:undefined}/>)}</ol>
      {answer.answerManifestId?<p><a href={'/answers/'+answer.answerManifestId}>How this answer was made (answer provenance)</a></p>:null}
      <details className="advanced">
        <summary>Advanced inspector: identifiers</summary>
        <dl>
          <dt>Context packet</dt><dd><code>{answer.packetId}</code></dd>
          <dt>Packet hash</dt><dd><code>{answer.packetHash}</code></dd>
          {answer.answerManifestId?<><dt>Answer manifest</dt><dd><code>{answer.answerManifestId}</code></dd></>:null}
          <dt>Classifier rule</dt><dd><code>{answer.classification.matchedRule}</code></dd>
        </dl>
      </details>
    </section>:null}
  </Shell>;
}
