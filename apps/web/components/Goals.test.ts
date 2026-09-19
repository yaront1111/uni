import { expect,it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { goalsViewSchema,type Goal } from '@unai/domain';
import * as screen from './Goals';

/** The Goals screen, one assertion group per state the design draws (design
 * screen "Goals", journey J7; CRT-DEC-01-A's "goal priority changes are retained
 * as history"). */

const id=(n:number)=>'0192f3a0-0000-7000-8000-'+String(n).padStart(12,'0');
const readingPath=(html:string)=>html.replace(/<details class="advanced">[\s\S]*?<\/details>/g,'').replace(/<[^>]+>/g,' ');
const UUID=/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const fitness:Goal={goalId:id(1),title:'Train for the half marathon',domain:'HEALTH',currentPriority:'HIGH',effectivePriority:'HIGH',
  temporaryOverride:null,overrideActive:false,createdAt:'2026-01-05T08:00:00.000Z',retiredAt:null,contradiction:null,
  priorityHistory:[
    {goalPriorityHistoryId:id(2),changeKind:'INITIAL',priority:'MEDIUM',validFrom:'2026-01-05T08:00:00.000Z',validTo:null,
      recordedAt:'2026-01-05T08:00:00.000Z',reason:'Stated when the goal was created.'},
    {goalPriorityHistoryId:id(3),changeKind:'CHANGE',priority:'HIGH',validFrom:'2026-02-01T08:00:00.000Z',validTo:null,
      recordedAt:'2026-02-01T08:00:00.000Z',reason:'The race is in April'}]};
const view=(goals:Goal[])=>goalsViewSchema.parse({goals,readAt:'2026-03-02T09:00:00.000Z'});
const render=(props:Partial<screen.GoalsProps>)=>renderToStaticMarkup(createElement(screen.Goals,{view:view([]),...props}));

it('renders the empty list with the skip link, the navigation marked current and the add-a-goal form',()=>{
  const html=render({});
  expect(html).toContain('Skip to content');
  expect(html).toContain('<h1 id="page-title">Goals</h1>');
  expect(html).toContain('No goals recorded yet.');
  expect(html).toContain('href="/goals" aria-current="page"');
  for(const label of ['<label for="new-goal-title">Goal</label>','<label for="new-goal-domain">Area of life</label>',
    '<label for="new-goal-priority">Priority</label>'])expect(html).toContain(label);
});

it('lists each goal with its current priority',()=>{
  const html=render({view:view([fitness])});
  expect(html).toContain('Train for the half marathon');
  expect(html).toContain('<dt>Area of life</dt><dd>Health</dd>');
  expect(html).toContain('<dt>Stated priority</dt><dd>High</dd>');
  expect(html).toContain('<dt>Priority that applies now</dt><dd>High');
});

it('keeps a priority change as history: the earlier priority stays listed beside the change',()=>{
  const html=render({view:view([fitness])});
  expect(html).toContain('Priority history, oldest first (2 entries; entries are kept, never overwritten)');
  const text=readingPath(html);
  expect(text).toMatch(/Set when the goal was created\s+Medium/);
  expect(text).toMatch(/Priority changed\s+High/);
  expect(text).toContain('The race is in April');
  expect(html).toContain('A change is added to the history below; the earlier priority is kept, never overwritten.');
  expect(html).toContain('Record the change<span class="sr-only"> for Train for the half marathon</span>');
});

it('records and respects an explicit temporary override without changing the stated priority',()=>{
  const override={historyId:id(4),priority:'LOW' as const,validFrom:'2026-03-01T00:00:00.000Z',validTo:'2026-03-15T23:59:59.000Z',reason:'Injured this fortnight'};
  const html=render({view:view([{...fitness,effectivePriority:'LOW',overrideActive:true,temporaryOverride:override,
    priorityHistory:[...fitness.priorityHistory,{goalPriorityHistoryId:id(4),changeKind:'TEMPORARY_OVERRIDE',priority:'LOW',
      validFrom:override.validFrom,validTo:override.validTo,recordedAt:override.validFrom,reason:override.reason}]}])});
  expect(html).toContain('<dt>Stated priority</dt><dd>High</dd>');
  expect(html).toContain('<dt>Priority that applies now</dt><dd>Low (temporary override until 2026-03-15: “Injured this fortnight”)</dd>');
  expect(html).toContain('Your temporary override is respected: until 2026-03-15 this goal is treated as low priority');
  expect(readingPath(html)).toMatch(/Temporary override\s+Low\s+2026-03-01\s+2026-03-15/);
  expect(html).toContain('<label for="change-'+fitness.goalId+'-until">Temporary until (optional)</label>');
});

it('flags a goal whose stated priority contradicts observed behaviour, pointing to the mentor card',()=>{
  const flagged={...fitness,contradiction:{mentorCardId:id(5),decision:'ASK' as const,reason:'WITHIN_ATTENTION_BUDGET' as const,
    ownerLocalDate:'2026-03-02',decidedAt:'2026-03-02T09:00:00.000Z'}};
  const html=render({view:view([flagged])});
  expect(html).toContain('<strong>Flagged:</strong> your calendar on 2026-03-02 did not match this goal’s stated priority.');
  expect(html).toContain('The <a href="/mentor">mentor card</a> shows the evidence, the inference and a recommendation.');
  const withheld=render({view:view([{...flagged,contradiction:{...flagged.contradiction,decision:'BATCH',reason:'DAILY_BUDGET_EXHAUSTED'}}])});
  expect(withheld).toContain('The mentor card was withheld to keep within today’s attention budget');
});

it('keeps every identifier inside the advanced inspector',()=>{
  const html=render({view:view([fitness])});
  expect(html).toContain('Advanced inspector: goal and history identifiers');
  expect(html).toContain(fitness.goalId);
  expect(readingPath(html)).not.toMatch(UUID);
});

it('shows a failure as an alert',()=>{
  expect(render({error:'Your goals could not be read. Please reload to retry.'})).toContain('<p role="alert">Your goals could not be read.');
});
