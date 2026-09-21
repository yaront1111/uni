import React,{useState} from 'react';
import type {LearnedApprovalRule,LearnedApprovalRulesView} from '@unai/domain';
import {Navigation} from './Navigation';

/** The Learned approval rules screen (design journey J5; PRD §19.5): a rule is
 * proposed with no effect, becomes active only on explicit approval, and stops
 * applying once revoked. */
export interface ApprovalRulesProps {
  embedded?:boolean;
  view:LearnedApprovalRulesView;
  error?:string;
}

const statusText:Record<LearnedApprovalRule['status'],string>={
  PROPOSED:'Proposed — has no effect until you approve it',
  APPROVED:'Approved — in effect',
  REVOKED:'Revoked — no longer applied',
};
const eventText={PROPOSED:'Proposed',APPROVED:'Approved',APPLIED:'Applied to a question',REVOKED:'Revoked'} as const;

function Rule({rule,busy,onDecide}:{rule:LearnedApprovalRule;busy:boolean;onDecide:(action:'approve'|'revoke')=>void}){
  const id='rule-'+rule.learnedApprovalRuleId;
  return <section className="card" aria-labelledby={id}>
    <h2 id={id}>{rule.ruleText}</h2>
    <p><strong>Status:</strong> {statusText[rule.status]}</p>
    <h3>Scope</h3>
    <dl>
      <dt>Applies to</dt><dd>{rule.scope.situationKind==='REPAYMENT'?'Possible repayments':'Questions'} whose memo is exactly “{rule.scope.matchText}”</dd>
      <dt>Answer it gives</dt><dd>{rule.scope.choiceId.replaceAll('_',' ')}</dd>
      <dt>Sensitivity scope</dt><dd>{rule.scope.sensitivityScope}</dd>
    </dl>
    <p className="muted">Proposed after you gave the same answer to {rule.proposedFromCardIds.length} matching questions.</p>
    <h3>Decision history</h3>
    <ol>{rule.history.map((entry,index)=><li key={entry.event+index}>{eventText[entry.event]} on {entry.at.slice(0,10)}{entry.clarificationCardId?' (question '+entry.clarificationCardId.slice(0,8)+')':''}</li>)}</ol>
    <div className="actions">
      {rule.status==='PROPOSED'&&<button disabled={busy} onClick={()=>onDecide('approve')}>Approve rule<span className="sr-only">: {rule.ruleText}</span></button>}
      {rule.status!=='REVOKED'&&<button disabled={busy} onClick={()=>onDecide('revoke')}>{rule.status==='PROPOSED'?'Decline':'Revoke'} rule<span className="sr-only">: {rule.ruleText}</span></button>}
    </div>
  </section>;
}

export function ApprovalRules(props:ApprovalRulesProps){
  const Frame=props.embedded?'section':'main';
  const Heading=props.embedded?'h2':'h1';
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState(props.error??'');
  async function decide(rule:LearnedApprovalRule,action:'approve'|'revoke'){
    setBusy(true);setError('');
    try{
      const response=await fetch('/api/platform/approval-rules/'+rule.learnedApprovalRuleId+'/'+action,{method:'POST',
        headers:{'content-type':'application/json','x-purpose':'approval.rules','x-correlation-id':crypto.randomUUID(),
          'idempotency-key':crypto.randomUUID().replaceAll('-','')},body:'{}'});
      if(response.status===401){window.location.assign('/signin?reason=expired');return;}
      if(!response.ok)throw new Error('refused');
      window.location.reload();
    }catch{setError('The rule could not be changed. Nothing changed. Please retry.');}
    finally{setBusy(false);}
  }
  return <div className={props.embedded?undefined:'shell'}>{!props.embedded&&<>
    <a className="skip" href="#content">Skip to content</a>
    <header><a href="/" className="brand">Uai</a><span>Your personal memory</span></header>
    <Navigation current="approval-rules"/></>}
    <Frame id={props.embedded?'configuration-approval-rules':'content'} tabIndex={-1}>
      <p className="eyebrow">MEMORY</p>
      <Heading>Learned approval rules</Heading>
      <p>When you give the same answer to the same kind of question more than once, Uai may propose a rule. A rule does nothing until you approve it, and you can revoke it at any time.</p>
      {props.view.rules.length===0&&<section className="card"><p>No rule has been proposed yet.</p></section>}
      {props.view.rules.map(rule=><Rule key={rule.learnedApprovalRuleId} rule={rule} busy={busy} onDecide={action=>void decide(rule,action)}/>)}
      {error&&<p role="alert">{error}</p>}
    </Frame>
    {!props.embedded&&<footer>An approved rule answers matching questions for you through the same recorded path as your own answers.</footer>}
  </div>;
}
