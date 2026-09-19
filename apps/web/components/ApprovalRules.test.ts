import { expect,it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { learnedApprovalRulesViewSchema,type LearnedApprovalRule } from '@unai/domain';
import * as screen from './ApprovalRules';

/** The Learned approval rules screen, one assertion group per state the design
 * draws (design screen "Learned approval rules", journey J5). */

const id=(n:number)=>'0192f3a0-0000-7000-8000-'+String(n).padStart(12,'0');
const proposed:LearnedApprovalRule={learnedApprovalRuleId:id(1),
  ruleText:'Always link transfers with the exact memo "Daniel dinner" to the matching open obligation.',
  scope:{situationKind:'REPAYMENT',matchText:'Daniel dinner',choiceId:'confirm_repayment',effect:'CONFIRM',sensitivityScope:'FINANCE/PRIVATE'},
  status:'PROPOSED',inEffect:false,proposedFromCardIds:[id(2),id(3)],proposedAt:'2026-03-03T09:00:00.000Z',approvedByUserId:null,
  approvedAt:null,revokedAt:null,history:[{event:'PROPOSED',at:'2026-03-03T09:00:00.000Z',clarificationCardId:null}]};
const approved:LearnedApprovalRule={...proposed,status:'APPROVED',inEffect:true,approvedByUserId:id(4),approvedAt:'2026-03-04T09:00:00.000Z',
  history:[...proposed.history,{event:'APPROVED',at:'2026-03-04T09:00:00.000Z',clarificationCardId:null},
    {event:'APPLIED',at:'2026-03-04T10:00:00.000Z',clarificationCardId:id(5)}]};
const revoked:LearnedApprovalRule={...approved,status:'REVOKED',inEffect:false,revokedAt:'2026-03-05T09:00:00.000Z',
  history:[...approved.history,{event:'REVOKED',at:'2026-03-05T09:00:00.000Z',clarificationCardId:null}]};
function render(rules:LearnedApprovalRule[],error?:string){
  const view=learnedApprovalRulesViewSchema.parse({rules,readAt:'2026-03-05T10:00:00.000Z'});
  return renderToStaticMarkup(createElement(screen.ApprovalRules,{view,...(error?{error}:{})}));
}

it('renders a proposed rule that has no effect until it is approved, with the skip link and labelled controls',()=>{
  const html=render([proposed]);
  expect(html).toContain('Skip to content');
  expect(html).toContain('Learned approval rules');
  expect(html).toContain('Proposed — has no effect until you approve it');
  expect(html).toContain('Approve rule<span class="sr-only">: Always link transfers');
  expect(html).toContain('Decline rule');
  expect(html).toContain('Proposed after you gave the same answer to 2 matching questions.');
});

it('shows the rule scope',()=>{
  const html=render([proposed]);
  expect(html).toContain('Possible repayments whose memo is exactly “Daniel dinner”');
  expect(html).toContain('confirm repayment');
  expect(html).toContain('FINANCE/PRIVATE');
});

it('shows an approved rule as active with a revoke control, and its decision history',()=>{
  const html=render([approved]);
  expect(html).toContain('Approved — in effect');
  expect(html).toContain('Revoke rule');
  expect(html).not.toContain('Approve rule');
  expect(html).toContain('Decision history');
  expect(html).toContain('Proposed on 2026-03-03');
  expect(html).toContain('Approved on 2026-03-04');
  expect(html).toContain('Applied to a question on 2026-03-04');
});

it('shows a revoked rule as no longer applied, with no control that could revive it',()=>{
  const html=render([revoked]);
  expect(html).toContain('Revoked — no longer applied');
  expect(html).toContain('Revoked on 2026-03-05');
  expect(html).not.toContain('Approve rule');
  expect(html).not.toContain('Revoke rule');
});

it('renders the empty list and a failure',()=>{
  expect(render([])).toContain('No rule has been proposed yet.');
  expect(render([],'The learned approval rules could not be read. Please reload to retry.')).toContain('role="alert"');
});
