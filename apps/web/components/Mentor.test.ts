import { expect,it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mentorViewSchema,type MentorCard,type MentorView } from '@unai/domain';
import * as screen from './Mentor';

/** The Mentor contradiction card screen, one assertion group per state the design
 * draws (design screen "Mentor contradiction card", journey J7; CRT-DEC-03-A). */

const id=(n:number)=>'0192f3a0-0000-7000-8000-'+String(n).padStart(12,'0');
const readingPath=(html:string)=>html.replace(/<details class="advanced">[\s\S]*?<\/details>/g,'').replace(/<[^>]+>/g,' ');
const UUID=/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const inputs={errorProbability:0.6,consequence:'HIGH',irreversibility:'COSTLY_TO_REVERSE',urgency:'MEDIUM',interruptionCost:'LOW',
  expectedValue:0.3,interruptionCostValue:0.05,sensitivityScope:'HEALTH/PRIVATE',ownerLocalDate:'2026-03-02',timeZone:'UTC',
  budget:{maxCardsPerDay:3,maxCardsPerSensitivityScopePerDay:1,repeatQuestionSuppressionDays:7,askedToday:0,askedInScopeToday:0},
  lastAskedAt:null,suppressedUntil:null,materialNewEvidenceIds:[],learnedApprovalRuleId:null} as const;
const card:MentorCard={mentorCardId:id(1),cardKind:'GOAL_CALENDAR_CONTRADICTION',goalId:id(2),goalTitle:'Train for the half marathon',
  goalDomain:'HEALTH',goalPriorityHistoryId:id(3),
  evidence:[
    {label:'EVIDENCE',kind:'STATED_GOAL',text:'You set "Train for the half marathon" (health) to high priority on 2026-02-01: "The race is in April".',
      grounds:[{objectType:'goal',objectId:id(2)},{objectType:'goal_priority_history',objectId:id(3)}]},
    {label:'EVIDENCE',kind:'CALENDAR_ALLOCATION',text:'Between 2026-02-02 and 2026-03-01, 6 calendar events took 9 h: work 8 h across 5 events; health 1 h across 1 event. Health: 1 h across 1 event.',
      grounds:[{objectType:'proposition',objectId:id(4)},{objectType:'proposition',objectId:id(5)}]}],
  inference:{label:'INFERENCE',text:'Health received 11% of your scheduled time while "Train for the half marathon" is stated as high priority. This is a reading of your calendar, not of your intentions: time spent outside calendar events is not visible here.',
    confidence:0.8,goalMinutes:60,totalMinutes:540,sharePercent:11,eventCount:6,
    counterexampleSearch:{searched:'Scheduled or attended calendar events in health between 2026-02-02 and 2026-03-01.',counterexamplesFound:1,counterexampleIds:[id(5)]}},
  recommendation:{label:'RECOMMENDATION',text:'If "Train for the half marathon" is still a high priority, put time for it on your calendar this week. If it is not, lower its stated priority, so reviews measure you against what matters now.'},
  observationWindow:{from:'2026-02-02T09:00:00.000Z',to:'2026-03-02T09:00:00.000Z'},confidence:0.8,sensitivityScope:'HEALTH/PRIVATE',
  decision:'ASK',reason:'WITHIN_ATTENTION_BUDGET',policyInputs:{...inputs,budget:{...inputs.budget},materialNewEvidenceIds:[]},
  ownerLocalDate:'2026-03-02',decidedAt:'2026-03-02T09:00:00.000Z',contextPacketId:id(6)};
const budget={maxCardsPerDay:3,maxCardsPerSensitivityScopePerDay:1,repeatQuestionSuppressionDays:7,isDefault:true,updatedAt:null};
function view(parts:Partial<MentorView>={}):MentorView{
  return mentorViewSchema.parse({ownerLocalDate:'2026-03-02',timeZone:'UTC',budget,proactiveItemsToday:0,remainingToday:3,cards:[],withheld:[],
    respectedOverrides:[],contextPacketId:id(6),composerVersion:'mentor-contradictions-0.1.0',readAt:'2026-03-02T09:00:00.000Z',...parts});
}
const render=(props:Partial<screen.MentorProps>)=>renderToStaticMarkup(createElement(screen.Mentor,{view:view(),...props}));

it('renders the empty state with the skip link, the navigation marked current and the shared budget in words',()=>{
  const html=render({});
  expect(html).toContain('Skip to content');
  expect(html).toContain('<h1 id="page-title">Mentor</h1>');
  expect(html).toContain('href="/mentor" aria-current="page"');
  expect(html).toContain('No contradiction between your goals and your calendar right now.');
  expect(readingPath(html)).toContain('0 of 3 proactive items shown, 3 left, at most 1 per sensitivity scope. Mentor cards and Memory inbox questions share this one budget.');
});

it('shows a contradiction between a stated goal and observed calendar behaviour',()=>{
  const html=render({view:view({cards:[card],proactiveItemsToday:1,remainingToday:2})});
  const text=readingPath(html);
  expect(html).toContain('“Train for the half marathon” and your calendar');
  expect(text).toContain('to high priority on 2026-02-01');
  expect(text).toContain('6 calendar events took 9 h');
  expect(text).toContain('Health received 11% of your scheduled time');
});

it('labels the evidence, the inference and the recommendation distinctly, each in its own section and words',()=>{
  const html=render({view:view({cards:[card],proactiveItemsToday:1,remainingToday:2})});
  const evidence=html.indexOf('Evidence: what your records show');
  const inference=html.indexOf('Inference: what Uai concludes from it');
  const recommendation=html.indexOf('Recommendation: a suggestion, not a decision');
  expect(evidence).toBeGreaterThan(-1);
  expect(inference).toBeGreaterThan(evidence);
  expect(recommendation).toBeGreaterThan(inference);
  // Each statement sits under its own heading and carries its own label.
  const evidenceSection=html.slice(evidence,inference),inferenceSection=html.slice(inference,recommendation),recommendationSection=html.slice(recommendation);
  expect(evidenceSection.match(/data-label="EVIDENCE"/g)).toHaveLength(2);
  expect(evidenceSection).toContain('You set &quot;Train for the half marathon&quot;');
  expect(evidenceSection).not.toContain('data-label="INFERRED"');
  expect(inferenceSection).toContain('data-label="INFERRED"');
  expect(inferenceSection).toContain('Health received 11% of your scheduled time');
  expect(inferenceSection).toContain('<dt>Confidence</dt><dd>80%</dd>');
  expect(readingPath(inferenceSection)).toContain('Found: 1');
  expect(inferenceSection).not.toContain('put time for it on your calendar');
  expect(recommendationSection).toContain('data-label="RECOMMENDED"');
  expect(recommendationSection).toContain('put time for it on your calendar this week');
});

it('shows a card emitted within the attention budget',()=>{
  const html=render({view:view({cards:[card],proactiveItemsToday:1,remainingToday:2})});
  expect(html).toContain('Shown within today’s attention budget.');
  expect(readingPath(html)).toContain('1 of 3 proactive items shown, 2 left');
});

it('withholds a card when the attention budget is exhausted, naming it without showing its content',()=>{
  const withheld={...card,mentorCardId:id(7),goalId:id(8),goalTitle:'Call my parents weekly',goalDomain:'FAMILY' as const,
    decision:'BATCH' as const,reason:'DAILY_BUDGET_EXHAUSTED' as const,sensitivityScope:'FAMILY/PRIVATE'};
  const html=render({view:view({cards:[card],withheld:[withheld],proactiveItemsToday:3,remainingToday:0})});
  expect(html).toContain('Withheld today');
  expect(html).toContain('Today’s attention budget is used up, so these were not shown.');
  expect(readingPath(html)).toContain('Call my parents weekly : Withheld: today’s attention budget is used up.');
  expect(html).not.toContain('“Call my parents weekly” and your calendar');
  // Only the emitted card's sections are drawn.
  expect(html.match(/Evidence: what your records show/g)).toHaveLength(1);
});

it('respects an explicit temporary override by not raising the goal',()=>{
  const html=render({view:view({respectedOverrides:[{goalId:id(9),goalTitle:'Train for the half marathon',priority:'LOW',until:'2026-03-15T23:59:59.000Z'}]})});
  expect(readingPath(html)).toContain('you set it to low priority until 2026-03-15, so your calendar is not measured against its stated priority.');
});

it('keeps every identifier inside the advanced inspector',()=>{
  const html=render({view:view({cards:[card],proactiveItemsToday:1,remainingToday:2})});
  expect(html).toContain('Advanced inspector: how these cards were decided');
  expect(html).toContain(card.mentorCardId);
  expect(readingPath(html)).not.toMatch(UUID);
});

it('shows a failure as an alert',()=>{
  expect(render({view:null,error:'The mentor could not be read. Please reload to retry.'})).toContain('<p role="alert">');
});
