import { expect,it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { cardDecisionResultSchema,memoryInboxViewSchema,type ClarificationCard,type MemoryInboxView } from '@unai/domain';
import * as screen from './MemoryInbox';

/** The Memory inbox screen, one assertion group per state the design draws
 * (design screen "Memory inbox", journey J5). */

const id=(n:number)=>'0192f3a0-0000-7000-8000-'+String(n).padStart(12,'0');
const inputs={errorProbability:0.4,consequence:'HIGH',irreversibility:'COSTLY_TO_REVERSE',urgency:'LOW',interruptionCost:'LOW',
  expectedValue:0.15,interruptionCostValue:0.05,sensitivityScope:'FINANCE/PRIVATE',ownerLocalDate:'2026-03-02',timeZone:'UTC',
  budget:{maxCardsPerDay:3,maxCardsPerSensitivityScopePerDay:1,repeatQuestionSuppressionDays:7,askedToday:0,askedInScopeToday:0},
  lastAskedAt:null,suppressedUntil:null,materialNewEvidenceIds:[],learnedApprovalRuleId:null} as const;
const daniel:ClarificationCard={
  clarificationCardId:id(1),situationKey:'thread:'+id(2),situationKind:'REPAYMENT',title:'Possible Daniel repayment',
  facts:['An obligation of ₪50 is on record.','A ₪60 transfer with the memo "Daniel dinner" was recorded.',
    'The counterparty is not confirmed as the same person.','The purpose is not confirmed.'],
  whyItMatters:'Whether this transfer repaid the ₪50 obligation decides whether you still owe it.',
  choices:[
    {choiceId:'confirm_repayment',label:'Confirm repayment',effect:'CONFIRM',whatWillChange:'Records that the ₪60 transfer repaid this obligation.',targets:[{objectType:'proposition',objectId:id(3)}]},
    {choiceId:'different_person',label:'Different person',effect:'REJECT',whatWillChange:'Records that the transfer went to someone else.',targets:[{objectType:'proposition',objectId:id(3)}]},
    {choiceId:'different_purpose',label:'Different purpose',effect:'REJECT',whatWillChange:'Records that the transfer was for something else.',targets:[{objectType:'proposition',objectId:id(3)}]},
    {choiceId:'keep_uncertain',label:'Keep uncertain',effect:'KEEP_UNCERTAIN',whatWillChange:'Nothing is decided.',targets:[{objectType:'proposition',objectId:id(3)}]}],
  groupedAmbiguityIds:[id(3),id(4)],
  ambiguities:[{ambiguityId:id(3),kind:'UNCONFIRMED_INTERPRETATION',frameInstanceId:id(5),frameTypeId:'finance.payment_allocation',
    predicateId:'finance.payment_allocation.allocated_amount',propositionIds:[id(3)],evidenceIds:[],detail:'The allocated amount "₪60" is not confirmed.'},
  {ambiguityId:id(4),kind:'UNCONFIRMED_INTERPRETATION',frameInstanceId:id(6),frameTypeId:'shared.event_occurrence',
    predicateId:'shared.event_occurrence.participants',propositionIds:[id(4)],evidenceIds:[],detail:'The participants are not confirmed.'}],
  sensitivityScope:'FINANCE/PRIVATE',status:'ASKED',askedAt:'2026-03-02T09:00:00.000Z',answeredAt:null,suppressedUntil:null,
  reopenedByEvidenceId:null,appliedRuleId:null,answer:null,
  interruption:{decision:'ASK',reason:'WITHIN_ATTENTION_BUDGET',policyInputs:{...inputs,budget:{...inputs.budget},materialNewEvidenceIds:[]},decidedAt:'2026-03-02T09:00:00.000Z'},
};
const budget={maxCardsPerDay:3,maxCardsPerSensitivityScopePerDay:1,repeatQuestionSuppressionDays:7,isDefault:true,updatedAt:null};
function view(parts:Partial<MemoryInboxView>={}):MemoryInboxView{
  return memoryInboxViewSchema.parse({ownerLocalDate:'2026-03-02',timeZone:'UTC',budget,remainingToday:3,remainingByScope:[],cards:[],
    deferredCount:0,withheld:[],resolvedToday:[],contextPacketId:null,readAt:'2026-03-02T09:00:00.000Z',...parts});
}
function render(props:Partial<screen.MemoryInboxProps>){
  return renderToStaticMarkup(createElement(screen.MemoryInbox,{view:view(),...props}));
}

it('renders the empty inbox with the skip link and the budget in words',()=>{
  const html=render({});
  expect(html).toContain('Skip to content');
  expect(html).toContain('Memory inbox');
  expect(html).toContain('Nothing needs your answer right now.');
  expect(html).toContain('3 of 3 proactive questions left, at most 1 per sensitivity scope');
  expect(html).toContain('not asked again for 7 days unless new evidence arrives');
  expect(html).toContain('aria-current="page"');
});

it('renders one grouped card per situation with why it matters and what each choice will change',()=>{
  const html=render({view:view({cards:[daniel],remainingToday:2})});
  expect(html).toContain('Possible Daniel repayment');
  expect(html).toContain('2 related questions grouped into this card');
  expect(html).toContain('A ₪60 transfer with the memo &quot;Daniel dinner&quot; was recorded.');
  expect(html).toContain('<h3>Why it matters</h3>');
  expect(html).toContain('decides whether you still owe it');
  for(const label of ['Confirm repayment','Different person','Different purpose','Keep uncertain'])expect(html).toContain('>'+label+'<span class="sr-only"> for Possible Daniel repayment</span>');
  expect(html).toContain('What will change: Records that the ₪60 transfer repaid this obligation.');
  expect(html).toContain('aria-describedby="card-'+daniel.clarificationCardId+'-confirm_repayment"');
  expect(html).toContain('Sensitivity scope: Finance, private');
});

it('shows the budget reached, one card per scope, and the remaining questions deferred to batch review',()=>{
  const html=render({view:view({cards:[daniel],remainingToday:0,deferredCount:7,
    remainingByScope:[{sensitivityScope:'FINANCE/PRIVATE',remaining:0}]})});
  expect(html).toContain('0 of 3 proactive questions left, at most 1 per sensitivity scope');
  expect(html).toContain('Today’s question budget is used up. 7 more questions are deferred to batch review rather than shown today.');
});

it('shows a question withheld because it was asked within seven days, and one re-asked because new evidence arrived',()=>{
  const withheld={...daniel,clarificationCardId:id(7),status:'SUPPRESSED' as const,suppressedUntil:'2026-03-09T09:00:00.000Z',
    interruption:{...daniel.interruption!,decision:'SUPPRESS' as const,reason:'ASKED_WITHIN_SUPPRESSION_WINDOW' as const}};
  const reopened={...daniel,clarificationCardId:id(8),reopenedByEvidenceId:id(9),
    interruption:{...daniel.interruption!,reason:'REOPENED_BY_MATERIAL_NEW_EVIDENCE' as const}};
  const html=render({view:view({cards:[reopened],withheld:[withheld]})});
  expect(html).toContain('Not asked again yet');
  expect(html).toContain('Not asked again: the same question was asked recently and no new evidence has arrived.');
  expect(html).toContain('It can be asked again from 2026-03-09, or sooner if new evidence arrives.');
  expect(html).toContain('Asked again because material new evidence arrived.');
});

it('shows a resolved card with its recorded decision, and the answer just given with any proposed rule',()=>{
  const resolved={...daniel,status:'RESOLVED' as const,answeredAt:'2026-03-02T09:05:00.000Z',answer:{choiceId:'confirm_repayment',
    effect:'CONFIRM' as const,answeredBy:'LEARNED_RULE' as const,learnedApprovalRuleId:id(10),evidenceId:id(11),overlayDeltaIds:[id(12)],
    memoryOperationIds:[id(13)],proposedTransactionId:id(14)},appliedRuleId:id(10)};
  const decided=cardDecisionResultSchema.parse({card:{...resolved,answer:{...resolved.answer,answeredBy:'OWNER',learnedApprovalRuleId:null},appliedRuleId:null},
    answer:{...resolved.answer,answeredBy:'OWNER',learnedApprovalRuleId:null},
    interruptionDecision:{interruptionDecisionId:id(15),clarificationCardId:daniel.clarificationCardId,candidateAmbiguityId:id(3),
      ambiguityKind:'UNCONFIRMED_INTERPRETATION',decision:'ASK',reason:'WITHIN_ATTENTION_BUDGET',policyInputs:daniel.interruption!.policyInputs,
      ownerLocalDate:'2026-03-02',policyVersion:'interruption-policy-0.1.0',decidedAt:'2026-03-02T09:00:00.000Z'},
    proposedRule:{learnedApprovalRuleId:id(10),ruleText:'Always link transfers with the exact memo "Daniel dinner" to the matching open obligation.',
      scope:{situationKind:'REPAYMENT',matchText:'Daniel dinner',choiceId:'confirm_repayment',effect:'CONFIRM',sensitivityScope:'FINANCE/PRIVATE'},
      status:'PROPOSED',inEffect:false,proposedFromCardIds:[id(1),id(16)],proposedAt:'2026-03-02T09:05:00.000Z',approvedByUserId:null,
      approvedAt:null,revokedAt:null,history:[{event:'PROPOSED',at:'2026-03-02T09:05:00.000Z',clarificationCardId:null}]}});
  const html=render({view:view({resolvedToday:[resolved]}),decided});
  expect(html).toContain('Answered today');
  expect(html).toContain('Confirm repayment — answered by a learned approval rule you approved.');
  expect(html).toContain('Your answer was recorded');
  expect(html).toContain('A change to memory was proposed for review.');
  expect(html).toContain('It has no effect until you approve it');
});

it('shows each interruption decision with its logged policy inputs and reason',()=>{
  const html=render({view:view({cards:[daniel]})});
  expect(html).toContain('Why you are seeing this');
  expect(html).toContain('Asked within today’s attention budget.');
  for(const text of ['Chance the recorded reading is wrong</dt><dd>40%','Consequence of an error</dt><dd>high',
    'Reversibility</dt><dd>costly to reverse','Urgency</dt><dd>low','Cost of interrupting you</dt><dd>low',
    '0 of 3 questions asked that day, 0 of 1 in this scope'])expect(html).toContain(text);
});

it('shows a failure as an alert',()=>{
  expect(render({error:'The memory inbox could not be read. Please reload to retry.'})).toContain('role="alert"');
});
