import React from 'react';
import type {AskAnswer,WhySources as Explanation} from '@unai/domain';
import {WhySources} from './WhySources';
/** The caller's map belongs to one answer, never a global statement-id cache. */
export function SourcesPanel({answer,why}:{answer:AskAnswer;why:Record<string,Explanation|null>}){
 return <div className="turn-sources">{answer.statements.map(statement=><WhySources key={statement.statementId} about={statement.text} panel={why[statement.statementId]??null}/>)}
  {answer.answerManifestId?<p><a href={'/answers/'+answer.answerManifestId}>How this answer was made (answer provenance)</a></p>:null}</div>;
}
