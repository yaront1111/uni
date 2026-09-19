import { expect,it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { decisionDetailSchema,decisionProjectionRowSchema,decisionProjectionViewSchema,type DecisionDetail,
  type DecisionProjectionRow,type DecisionRationale } from '@unai/domain';
import * as screen from './Decisions';

/** The Decisions workspace, one assertion group per state the design draws
 * (design screen "Decisions workspace", journey J7; CRT-DEC-01-A, CRT-DEC-02-A). */

const id=(n:number)=>'0192f3a0-0000-7000-8000-'+String(n).padStart(12,'0');
const readingPath=(html:string)=>html.replace(/<details class="advanced">[\s\S]*?<\/details>/g,'').replace(/<[^>]+>/g,' ');
const UUID=/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const TODAY='2026-03-02';

const row:DecisionProjectionRow=decisionProjectionRowSchema.parse({
  ownerScopeId:id(1),projectionVersion:id(2),canonicalTransactionWatermark:'2026-03-02T08:00:00.000Z',ownerOverlayWatermark:4,
  reducerVersion:'decision-projection-0.2.0',isComplete:true,sourceManifest:{},updatedAt:'2026-03-02T08:00:00.000Z',
  decisionFrameInstanceId:id(10),question:'Should I take the Berlin job offer?',
  alternatives:[{propositionId:id(11),text:'Take the Berlin offer'},{propositionId:id(12),text:'Stay in my current role'}],
  assumptions:[{propositionId:id(13),text:'Rent in Berlin is about €1,400 a month',claimIds:[id(14)],citedEvidenceIds:[id(15)]}],
  crossDomainConsequences:[{propositionId:id(16),text:'The children change schools mid-year',domain:'FAMILY'},
    {propositionId:id(17),text:'Salary rises by 20%',domain:'FINANCE'}],
  recommendation:'Negotiate a September start',userChoice:'Take the Berlin offer',
  rationale:'The role grows my career and the rent assumption leaves savings intact',
  expectedResult:'We settle in within six months and save more each month',reviewDate:'2026-09-01T09:00:00.000Z',reviewDue:false,
  actualOutcome:null,reviewOutcomeCode:null,reviewLifecycle:null,outcomeState:'UNRESOLVED',relatedGoalId:null,
  predictedOutcomePropositionIds:[id(18)],actualResolutionIds:[],conflictFlag:false,pendingAssertions:[]});

const statedIn={evidenceId:id(20),relation:'STATED_IN' as const,sourceType:'user_statement',occurredAt:'2026-03-01T10:00:00.000Z',
  excerpt:'Rent in Berlin is about €1,400 a month'};
const cited={evidenceId:id(15),relation:'CITED' as const,sourceType:'document',occurredAt:'2026-02-20T10:00:00.000Z',
  excerpt:'Average one-bedroom rent, Prenzlauer Berg: €1,380'};
const rationale:DecisionRationale={question:'Why did I make this decision?',answerType:'DECISION_RECONSTRUCTION',queryMode:'CAUSAL_EXPLANATION',
  answer:'You chose "Take the Berlin offer" because: The role grows my career and the rent assumption leaves savings intact. You assumed: Rent in Berlin is about €1,400 a month.',
  reasonRecorded:true,items:[
    {kind:'CHOICE',propositionId:id(21),text:'Take the Berlin offer',label:'REPORTED',sources:[{...statedIn,excerpt:'Take the Berlin offer'}]},
    {kind:'RATIONALE',propositionId:id(22),text:'The role grows my career and the rent assumption leaves savings intact',label:'REPORTED',sources:[statedIn]},
    {kind:'ASSUMPTION',propositionId:id(13),text:'Rent in Berlin is about €1,400 a month',label:'REPORTED',sources:[statedIn,cited]}],
  contextPacketId:id(23),packetHash:'a'.repeat(64),composerVersion:'decision-rationale-0.1.0'};
function detail(parts:Partial<DecisionDetail>={},rowParts:Partial<DecisionProjectionRow>={}):DecisionDetail{
  return decisionDetailSchema.parse({decision:{...row,...rowParts},rationale,reviews:[],readAt:'2026-03-02T09:00:00.000Z',...parts});
}
const view=(rows:DecisionProjectionRow[])=>decisionProjectionViewSchema.parse({projectionName:'decision_projection',rows,isComplete:true,
  ownerOverlayWatermark:4,canonicalTransactionWatermark:'2026-03-02T08:00:00.000Z',projectionVersion:id(2),
  reducerVersion:'decision-projection-0.2.0',pendingAssertions:[],readAt:'2026-03-02T09:00:00.000Z'});
const render=(props:Partial<screen.DecisionsProps>)=>renderToStaticMarkup(createElement(screen.Decisions,
  {view:view([]),detail:null,goals:[],today:TODAY,...props}));

it('renders the empty list with the skip link, the navigation marked current and the labelled record form',()=>{
  const html=render({});
  expect(html).toContain('Skip to content');
  expect(html).toContain('<h1 id="page-title">Decisions</h1>');
  expect(html).toContain('href="/decisions" aria-current="page"');
  expect(html).toContain('No decisions recorded yet.');
  for(const label of ['Question','Options, one per line','Assumptions, one per line','Area of life','Consequence','Recommendation (optional)',
    'Your choice (optional)','Why you chose it (optional)','Expected result (optional)','Review date (optional)'])expect(html).toContain('>'+label+'</label>');
});

it('lists decisions from the decision projection with where each one stands',()=>{
  const reviewed={...row,decisionFrameInstanceId:id(30),question:'Which laptop?',actualOutcome:'It lasted',reviewOutcomeCode:'CONFIRMED' as const};
  const due={...row,decisionFrameInstanceId:id(31),question:'Switch gyms?',reviewDate:'2026-02-01T09:00:00.000Z',reviewDue:true};
  const html=render({view:view([row,reviewed,due])});
  const text=readingPath(html);
  expect(html).toContain('href="/decisions?id='+row.decisionFrameInstanceId+'"');
  expect(text).toContain('Awaiting its review date (2026-09-01)');
  expect(text).toContain('Reviewed: confirmed');
  expect(text).toContain('Review due since 2026-02-01; no outcome recorded yet');
  expect(text).toContain('From the decision projection');
});

it('shows every designed field of a decision, backed by its decision_projection row, awaiting its review date with no outcome yet',()=>{
  const html=render({view:null,detail:detail()});
  const text=readingPath(html);
  for(const [field,value] of [['Question','Should I take the Berlin job offer?'],['Options','Take the Berlin offer'],['Options','Stay in my current role'],
    ['Assumptions','Rent in Berlin is about €1,400 a month'],['Cross-domain consequences','The children change schools mid-year'],
    ['Recommendation','Negotiate a September start'],['Your choice','Take the Berlin offer'],
    ['Expected result','We settle in within six months and save more each month'],['Review date','2026-09-01'],
    ['Actual outcome','No recorded outcome yet.']] as const){
    expect(html,field).toContain('<dt>'+field+'</dt>');
    expect(text,field).toContain(value);
  }
  expect(text).toMatch(/Family:\s+The children change schools mid-year/);
  expect(text).toMatch(/Finance:\s+Salary rises by 20%/);
  expect(text).toContain('1 cited source');
  expect(html).toContain('Awaiting its review date (2026-09-01).');
  expect(html).toContain('Read from the decision projection. Updated 2026-03-02.');
  expect(html).toContain('data-label="RECOMMENDED"');
  expect(html).toContain('data-label="PREDICTED"');
  expect(html).toContain('No review recorded yet.');
  // The projection row itself is named in the advanced inspector.
  expect(html).toContain('<dt>Decision frame instance</dt><dd><code>'+row.decisionFrameInstanceId+'</code></dd>');
  expect(html).toContain('<code>'+row.projectionVersion+'</code> · reducer <code>decision-projection-0.2.0</code>');
});

it('answers "Why did I make this decision?" from the recorded rationale and assumptions, each with its sources',()=>{
  const html=render({view:null,detail:detail()});
  const text=readingPath(html);
  expect(html).toContain('Why did I make this decision?');
  expect(text).toContain('You chose &quot;Take the Berlin offer&quot; because: The role grows my career');
  expect(text).toMatch(/Your reason:\s+The role grows my career and the rent assumption leaves savings intact/);
  expect(text).toMatch(/An assumption:\s+Rent in Berlin is about €1,400 a month/);
  expect(text).toContain('Stated in your decision record (2026-03-01):');
  expect(text).toContain('A source you cited (2026-02-20):');
  expect(text).toContain('Average one-bedroom rent, Prenzlauer Berg: €1,380');
  const withheld=render({view:null,detail:detail({rationale:{...rationale,items:[{...rationale.items[2]!,sources:[{...cited,excerpt:null}]}]}})});
  expect(withheld).toContain('the excerpt is withheld from this view.');
  const none=render({view:null,detail:detail({rationale:{...rationale,reasonRecorded:false,items:[],answer:'No reason or assumption was recorded for this decision.'}})});
  expect(none).toContain('No reason or assumption was recorded with this decision, so none is given here.');
});

it('shows a prediction review with predicted versus actual and its resolution code, the prediction left as stated',()=>{
  const reviewed=detail({reviews:[{decisionFrameInstanceId:row.decisionFrameInstanceId,
    predicted:{propositionId:id(18),text:row.expectedResult!,modality:'PREDICTED',claimIds:[id(40)],evidenceIds:[id(20)]},
    actual:{propositionId:id(41),text:'Settled in after eight months; savings unchanged',modality:'ACTUAL',claimIds:[id(42)],evidenceIds:[id(43)],citedEvidenceIds:[]},
    resolutionAssertionId:id(44),resolutionCode:'PARTIALLY_CONFIRMED',resolutionLifecycle:'PROPOSED',
    transitionContractId:'shared.decision.prediction_review',effectiveAt:'2026-09-02T09:00:00.000Z'}]},
  {actualOutcome:'Settled in after eight months; savings unchanged',reviewOutcomeCode:'PARTIALLY_CONFIRMED',reviewLifecycle:'PROPOSED',
    actualResolutionIds:[id(44)]});
  const html=render({view:null,detail:reviewed,today:'2026-09-02'});
  const text=readingPath(html);
  expect(html).toContain('Prediction review: Partially confirmed');
  expect(html).toContain('<th scope="col">Predicted</th><th scope="col">Actual</th>');
  expect(text).toContain('We settle in within six months and save more each month');
  expect(text).toContain('Settled in after eight months; savings unchanged');
  expect(text).toContain('Resolution code:  PARTIALLY_CONFIRMED');
  expect(text).toContain('recorded as proposed; accepting it is a governed memory decision');
  expect(html).toContain('Your original prediction is kept exactly as you stated it, with its sources; the review is recorded beside it.');
  expect(html).toContain('Reviewed: partially confirmed.');
  expect(text).toMatch(/Actual outcome\s+Settled in after eight months; savings unchanged\s+\(partially confirmed\)/);
});

it('offers the review form only when there is a prediction to review',()=>{
  const html=render({view:null,detail:detail()});
  expect(html).toContain('<label for="review-actual">What actually happened</label>');
  expect(html).toContain('<legend>How did the prediction hold?</legend>');
  for(const code of ['Confirmed','Refuted','Partially confirmed'])expect(readingPath(html)).toContain(code);
  const none=render({view:null,detail:detail({},{expectedResult:null,predictedOutcomePropositionIds:[]})});
  expect(none).not.toContain('review-actual');
  expect(none).toContain('No expected result was recorded, so there is no prediction to review.');
});

it('keeps every identifier inside the advanced inspector',()=>{
  const html=render({view:view([row]),detail:detail()});
  expect(html).toContain('Advanced inspector: projection and identifiers');
  expect(readingPath(html)).not.toMatch(UUID);
});

it('shows a failure as an alert',()=>{
  expect(render({view:null,error:'Your decisions could not be read. Please reload to retry.'})).toContain('<p role="alert">');
});
