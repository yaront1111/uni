import React from 'react';
import type {AskAnswer,WhySources} from '@unai/domain';
import {CertaintyBadge,displayLabelOf} from './Labels';
import {SourcesPanel} from './SourcesPanel';
export const ANSWER_FAILURE='The question could not be answered. Please retry.';
const UNAVAILABLE:Partial<Record<AskAnswer['statements'][number]['kind'],string>>={
 NOTHING_FOUND:'No grounded support is available to answer this question.',
 MEMORY_INCOMPLETE:'Memory is incomplete, so this question cannot be answered yet.',
 HISTORICAL_INSTANT_MISSING:'The requested time is missing, so this question cannot be answered yet.',
 WITHHELD:'Permission does not allow this question to be answered.',
 GROUNDING_BLOCKED:'The answer was refused by the grounding validator.',
};
/** Shared by Chat and Talk. Never use transcript text as a fallback for missing provenance. */
export function AcceptedAnswerPresenter({answer,why}:{answer:AskAnswer|null;why:Record<string,WhySources|null>}){
 if(!answer)return <p className="notice">The accepted answer is unavailable. Its certainty and sources could not be read.</p>;
 if(answer.grounding.action==='BLOCKED')return <p className="notice">The answer was refused by the grounding validator.</p>;
 const safe={...answer,statements:answer.statements.filter(s=>!UNAVAILABLE[s.kind])};
 return <div className="accepted-answer">
  {answer.declinesToAssert?<p className="notice">Memory does not hold enough to answer this with confidence.</p>:null}
  <ol className="statements">{answer.statements.map(statement=><li key={statement.statementId} data-engine-certainty={statement.label}>
   <p><CertaintyBadge label={displayLabelOf(statement)}/> {UNAVAILABLE[statement.kind]??statement.text}</p>
  </li>)}</ol>
  <SourcesPanel answer={safe} why={why}/>
 </div>;
}
