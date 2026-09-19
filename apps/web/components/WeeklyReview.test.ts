import { expect,it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { weeklyReviewSchema,type WeeklyReview } from '@unai/domain';
import * as screen from './WeeklyReview';

/** The Weekly review screen, one assertion group per state the design draws
 * (design screen "Weekly review", journey J6). */

const id=(n:number)=>'0192f3a0-0000-7000-8000-'+String(n).padStart(12,'0');
const ground=(n:number)=>({objectType:'proposition' as const,objectId:id(n)});
const section=(prefix:string,texts:Array<[string,string]>)=>({availability:'AVAILABLE' as const,note:null,
  statements:texts.map(([text,label],index)=>({statementId:prefix+'-'+(index+1),text,label,lifeCategory:null,grounds:[ground(index+1),ground(index+2)]}))});
const base={weeklyReviewId:id(90),weekStart:'2026-03-02',weekEnd:'2026-03-08',timeZone:'UTC',
  priorityVersusCalendar:{...section('priority',[['Family: you stated 1 high-priority commitment ("Prepare the school forms"), and 1 hour of the 11 hours scheduled this week (9%) went to family.','INFERRED']]),
    allocation:[{lifeCategory:'FAMILY',scheduledMinutes:60,eventCount:1,highPriorityCommitments:1,statedPriorityCommitments:1}]},
  commitmentsVersusResolutions:{...section('commitments',[['Completed: "Call the bank" (fulfilled on 2026-03-04).','CONFIRMED'],
    ['Slipping: "Ship the quarterly report" was due 2026-03-04 and has no recorded outcome.','COMMITTED']]),openCount:2,slippingCount:1,completedCount:1},
  decisionsVersusOutcomes:{availability:'NOT_AVAILABLE_IN_THIS_RELEASE',note:'Decision records arrive with the Decisions workspace; no decision is compared here yet.',statements:[]},
  plannedVersusObservedSpending:section('spending',[['Planned: ₪60 due 2026-03-05.','CONFIRMED'],['Observed: ₪60 allocated to an obligation on 2026-03-06.','CONFIRMED']]),
  materialChanges:section('changes',[['Changed (Finance): the obligation principal amount was ₪50 until 2026-03-04 and is now ₪60.','CONFIRMED']]),
  repeatedPostponement:{...section('postponement',[['Postponed: "Ship the quarterly report" moved from 2026-03-03 to 2026-03-04 (restated 2026-03-02).','COMMITTED']]),episodeCount:1},
  behavioralObservations:[],contextPacketId:id(91),packetHash:'a'.repeat(64),
  manifest:{packetId:id(91),packetHash:'a'.repeat(64),beliefIds:[],claimIds:[],evidenceIds:[],overlayDeltaIds:[],frameInstanceIds:[],resolutionAssertionIds:[]},
  statementCount:7,reviewVersion:'weekly-review-0.1.0',createdAt:'2026-03-09T08:00:00.000Z'};
const episode=(n:number)=>({episodeId:id(n),frameInstanceId:id(n+1),previousPropositionId:id(n+2),previousDueAt:'2026-03-03T17:00:00.000Z',
  newDueAt:'2026-03-04T17:00:00.000Z',restatedAt:'2026-03-02T09:00:00.000Z'});
const observed={...base,repeatedPostponement:{...base.repeatedPostponement,episodeCount:2},behavioralObservations:[{behavioralObservationId:id(92),
  patternKind:'REPEATED_POSTPONEMENT',statement:'Between 2026-02-09 and 2026-03-08, due dates were moved later 2 times across 2 commitments; 1 commitment due in the same period kept its original date.',
  supportingEpisodeIds:[id(20),id(30)],supportingEpisodes:[episode(20),episode(30)],
  counterexampleSearch:{searched:'Commitments with a due time inside the observation window whose due time was never restated later.',counterexamplesFound:1,counterexampleIds:[id(40)]},
  observationWindow:{from:'2026-02-09T00:00:00.000Z',to:'2026-03-09T00:00:00.000Z'},confidence:0.67,reviewOrExpiryDate:'2026-04-05',
  grounds:[ground(20),ground(30)]}]};
function render(props:Partial<screen.WeeklyReviewProps>){
  return renderToStaticMarkup(createElement(screen.WeeklyReview,{weekStart:'2026-03-02',review:null,...props}));
}
const review=(value:unknown):WeeklyReview=>weeklyReviewSchema.parse(value);

it('renders the loading state with the skip link and a labelled week picker',()=>{
  const html=render({loading:true});
  expect(html).toContain('Skip to content');
  expect(html).toContain('Preparing the review for the week starting 2026-03-02');
  expect(html).toContain('<label for="week-start">Week starting</label>');
});

it('compares stated priorities with calendar allocation and open commitments with completed outcomes',()=>{
  const html=render({review:review(base)});
  expect(html).toContain('Stated priorities and where the time went');
  expect(html).toContain('[Inferred]</span> Family: you stated 1 high-priority commitment');
  expect(html).toContain('Open commitments and completed outcomes');
  expect(html).toContain('[Confirmed]</span> Completed: &quot;Call the bank&quot;');
  expect(html).toContain('[Committed]</span> Slipping:');
});

it('says when decisions cannot be compared yet, and compares planned with observed spending',()=>{
  const html=render({review:review(base)});
  expect(html).toContain('Not available yet. Decision records arrive with the Decisions workspace');
  expect(html).toContain('Planned: ₪60 due 2026-03-05.');
  expect(html).toContain('Observed: ₪60 allocated to an obligation on 2026-03-06.');
});

it('reports material changes by domain and grounds every statement in the persisted packet',()=>{
  const html=render({review:review(base)});
  expect(html).toContain('Changed (Finance): the obligation principal amount was ₪50 until 2026-03-04 and is now ₪60.');
  expect(html).toContain('7 statements, each grounded in the context packet recorded for this review.');
  expect(html).toContain('Sources: 2 items from this review’s context packet');
  expect(html).toContain('Recorded from context packet '+id(91));
});

it('emits no behavioral observation from a single episode',()=>{
  const html=render({review:review(base)});
  expect(html).toContain('Postponed: &quot;Ship the quarterly report&quot; moved from 2026-03-03 to 2026-03-04');
  expect(html).toContain('No behavioral observation: a single episode is not enough to support one.');
  expect(html).not.toContain('<h3');
});

it('records an observation with its episodes, counterexample search, window, confidence and review date, in a direct tone',()=>{
  const html=render({review:review(observed)});
  expect(html).toContain('Behavioral observation');
  expect(html).toContain('Supporting episodes</dt><dd>2: ');
  expect(html).toContain('Counterexample search</dt><dd>Commitments with a due time inside the observation window whose due time was never restated later. Found: 1.');
  expect(html).toContain('Observation window</dt><dd>2026-02-09 to 2026-03-09');
  expect(html).toContain('Confidence</dt><dd>67%');
  expect(html).toContain('Review or expiry date</dt><dd>2026-04-05');
  expect(html).not.toMatch(/great job|well done|you should feel|lazy|you always/i);
});

it('shows a failure as an alert',()=>{
  expect(render({error:'The weekly review could not be prepared. Please reload to retry.'})).toContain('role="alert"');
});
