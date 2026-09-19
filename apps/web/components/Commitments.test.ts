import {expect,it} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {CommitmentProjectionRow,CommitmentsProjectionView,ObligationProjectionRow,ObligationsProjectionView,PendingAssertion,RelatedFrame} from '@unai/domain';
import * as commitments from './Commitments';
import * as obligations from './Obligations';

/** The Commitments and Obligations screens, one assertion group per state the
 * design draws (journey J4). Every state is reached from props alone. */

const id=(n:number)=>'0192f3a0-0000-7000-8000-'+String(n).padStart(12,'0');
const at='2026-09-18T10:00:00.000Z';
const metadata={ownerScopeId:id(1),projectionVersion:id(2),canonicalTransactionWatermark:at,ownerOverlayWatermark:4,
  reducerVersion:'projection-reducers-0.1.0',isComplete:true,sourceManifest:{},updatedAt:at};
const pending:PendingAssertion={overlayDeltaId:id(3),ownerSequence:5,deltaKind:'USER_CORRECTION',lifecycle:'USER_ASSERTED',
  rawText:'Actually it is due Monday',reason:'DELTA_VALUE_UNPARSEABLE',targetFrameInstanceId:id(10)};
function commitment(over:Partial<CommitmentProjectionRow>):CommitmentProjectionRow{
  return {...metadata,commitmentFrameInstanceId:id(10),promisorEntityId:id(20),promiseeEntityId:id(21),
    actionDescription:'send Daniel the report',dueTime:'2026-09-20T17:00:00.000Z',outcomeState:'UNRESOLVED',overdue:false,dueSoon:false,
    sourceStrength:'OWNER_STATEMENT',conflictFlag:false,overlayComplete:true,lastMaterialUpdate:at,pendingAssertions:[],...over};
}
function view(rows:CommitmentProjectionRow[],over:Partial<CommitmentsProjectionView>={}):CommitmentsProjectionView{
  return {projectionName:'open_commitments_projection',rows,isComplete:true,ownerOverlayWatermark:4,canonicalTransactionWatermark:at,
    projectionVersion:id(2),reducerVersion:'projection-reducers-0.1.0',pendingAssertions:[],highRiskActionsBlocked:false,readAt:at,...over};
}
const related=(frameInstanceId:string,over:Partial<RelatedFrame>={}):RelatedFrame=>({frameInstanceId,frameTypeId:'shared.commitment',lifecycle:'ACTIVE',
  people:[{roleId:'promisee',entityId:id(21),entityKind:'PERSON',canonicalLabel:'Daniel'},{roleId:'promisor',entityId:id(20),entityKind:'PERSON',canonicalLabel:'Me'}],
  sources:[{evidenceId:id(30),sourceType:'CONVERSATION',sensitivity:'PRIVATE',occurredAt:'2026-09-01T08:00:00.000Z',observedAt:at,
    anchors:[{sourceAnchorId:id(31),anchorKind:'MESSAGE_SPAN',text:'I will send Daniel the report'}]}],
  withheldSourceCount:0,resolutions:[],
  beliefs:[{propositionId:id(40),predicateId:'shared.commitment.action_description',modality:'COMMITTED',assessmentStatus:'ACCEPTED'}],
  threads:[{memoryThreadId:id(50),displayTitle:'Daniel report'}],...over});
const filters={person:null,thread:null,dueBefore:null,dueAfter:null,includeResolved:true};
const render=(props:Partial<commitments.CommitmentsProps>)=>renderToStaticMarkup(createElement(commitments.Commitments,
  {state:'ready',view:view([]),related:{},filters,...props}));

it('renders loading, empty and error states, with the skip link, labelled filters and navigation',()=>{
  expect(render({state:'loading',view:null})).toContain('Loading commitments…');
  const empty=render({});
  expect(empty).toContain('No commitments to show.');
  expect(empty).toContain('Skip to content');
  expect(empty).toContain('<label for="filter-person">Person</label>');
  expect(empty).toContain('<label for="filter-thread">Thread</label>');
  expect(empty).toContain('aria-current="page">Commitments</a>');
  expect(render({state:'error',view:null,error:'Your commitments could not be read. Please reload to retry.'}))
    .toContain('role="alert">Your commitments could not be read. Please reload to retry.');
});

it('renders an open commitment with its due date, people, source and inspect and correct links',()=>{
  const html=render({view:view([commitment({})]),related:{[id(10)]:related(id(10))}});
  expect(html).toContain('<h3>send Daniel the report</h3>');
  expect(html).toContain('Due 2026-09-20 17:00 UTC');
  expect(html).toContain('Open</span>');
  expect(html).toContain('Promised to: Daniel');
  expect(html).toContain('Conversation, 2026-09-01 08:00 UTC');
  expect(html).toContain('<q> I will send Daniel the report</q>');
  expect(html).toContain('href="/memory/inspector/proposition/'+id(40)+'"');
  expect(html).toContain('href="/memory/correct/proposition/'+id(40)+'"');
  expect(html).toContain('<span class="sr-only"> action description of send Daniel the report</span>');
});

it('renders the overdue flag as text, never as a failure',()=>{
  const html=render({view:view([commitment({overdue:true})]),related:{[id(10)]:related(id(10))}});
  expect(html).toContain('<span aria-hidden="true">⚠ </span>Overdue: the due time has passed; nothing has been marked failed or missed');
  expect(html).not.toMatch(/Failed|Missed<\/span>/);
});

it('renders a resolved and a partially resolved item with their resolution evidence',()=>{
  const resolved=related(id(10),{resolutions:[{resolutionAssertionId:id(60),outcomeCode:'FULFILLED',effectiveAt:'2026-09-19T09:00:00.000Z',
    lifecycle:'ACCEPTED',assertedBy:{entityId:id(20),entityKind:'PERSON',canonicalLabel:'Me'},claimId:id(61),
    evidence:[{evidenceId:id(62),sourceType:'GMAIL_THREAD',sensitivity:'PRIVATE',occurredAt:'2026-09-19T09:00:00.000Z',observedAt:at,
      anchors:[{sourceAnchorId:id(63),anchorKind:'MESSAGE_SPAN',text:'Report attached'}]}]}]});
  const html=render({view:view([commitment({outcomeState:'RESOLVED'})]),related:{[id(10)]:resolved}});
  expect(html).toContain('Resolved</span>');
  expect(html).toContain('<h4>Resolution evidence</h4>');
  expect(html).toContain('Fulfilled on 2026-09-19 09:00 UTC (accepted), stated by Me');
  expect(html).toContain('Email thread, 2026-09-19 09:00 UTC<q> Report attached</q>');
  expect(html).toContain('href="/memory/inspector/resolution_assertion/'+id(60)+'"');
  expect(render({view:view([commitment({outcomeState:'PARTIALLY_RESOLVED'})]),related:{[id(10)]:resolved}})).toContain('Partially resolved</span>');
});

it('marks a contested commitment distinctly, in words',()=>{
  const html=render({view:view([commitment({outcomeState:'CONTESTED',conflictFlag:true})]),related:{[id(10)]:related(id(10))}});
  expect(html).toContain('<li class="commitment contested">');
  expect(html).toContain('<span aria-hidden="true">⇄ </span>Contested</span>');
  expect(html).toContain('Contested: the sources disagree about this commitment, and Uai has not chosen between them.');
});

it('renders the owner\'s pending correction applied to the read',()=>{
  const html=render({view:view([commitment({sourceStrength:'PENDING_OWNER_ASSERTION'})]),related:{[id(10)]:related(id(10))}});
  expect(html).toContain('Pending your assertion: your correction is applied to this view');
});

it('renders an incomplete read with the persisted state, the pending assertion and high-risk actions blocked',()=>{
  const html=render({view:view([commitment({isComplete:false,pendingAssertions:[pending]})],
    {isComplete:false,pendingAssertions:[pending],highRiskActionsBlocked:true}),related:{[id(10)]:related(id(10))}});
  expect(html).toContain('<span aria-hidden="true">… </span>Incomplete');
  expect(html).toContain('What was last stored is shown, together with what you said that has not landed yet.');
  expect(html).toContain('High-risk actions based on this view are blocked until it is complete and uncontested.');
  expect(html).toContain('“Actually it is due Monday” — not yet reflected here (delta value unparseable)');
  expect(html).toContain('<h3>send Daniel the report</h3>');
});

it('shows the completeness flag and the owner overlay watermark',()=>{
  const html=render({view:view([commitment({})])});
  expect(html).toContain('<span aria-hidden="true">■ </span>Complete</span> · Includes your changes up to owner sequence 4.');
});

it('renders the active filters and the people and threads they choose from',()=>{
  const html=render({view:view([commitment({})]),related:{[id(10)]:related(id(10))},
    filters:{...filters,person:id(21),thread:id(50),dueAfter:'2026-09-01T00:00:00.000Z'}});
  expect(html).toContain('<option value="'+id(21)+'" selected="">Daniel</option>');
  expect(html).toContain('<option value="'+id(50)+'" selected="">Daniel report</option>');
  expect(html).toContain('Filtered by person, thread, due window.');
  expect(html).toContain('value="2026-09-01"');
});

it('says when sources are withheld or the related context could not be read',()=>{
  expect(render({view:view([commitment({})]),related:{[id(10)]:related(id(10),{withheldSourceCount:2})}}))
    .toContain('2 sources are above what this view may read and are not shown.');
  expect(render({view:view([commitment({})]),related:null}))
    .toContain('People, sources and resolution evidence could not be read. The commitments themselves are shown.');
});

// ---------------------------------------------------------------------------
// Obligations
// ---------------------------------------------------------------------------

function obligation(over:Partial<ObligationProjectionRow>):ObligationProjectionRow{
  return {...metadata,obligationFrameInstanceId:id(70),debtorEntityId:id(20),creditorEntityId:id(21),principalAmount:'500.00',currency:'ILS',
    dueTime:'2026-09-30T00:00:00.000Z',totalCanonicalAllocation:'300.00',remainingAmountCapabilityDerived:'200.00',unclassifiedRemainder:null,
    outcomeState:'PARTIALLY_RESOLVED',conflictFlag:false,overlayComplete:true,pendingAssertions:[],...over};
}
const obligationsView=(rows:ObligationProjectionRow[]):ObligationsProjectionView=>({...view([]),projectionName:'obligations_projection',rows});
const renderObligations=(props:Partial<obligations.ObligationsProps>)=>renderToStaticMarkup(createElement(obligations.Obligations,
  {state:'ready',view:obligationsView([]),related:{},...props}));
const debt=related(id(70),{frameTypeId:'shared.obligation',people:[{roleId:'creditor',entityId:id(21),entityKind:'PERSON',canonicalLabel:'Daniel'}]});

it('renders the Obligations screen with typed amounts, the allocation total and the capability-derived remainder',()=>{
  const html=renderObligations({view:obligationsView([obligation({})]),related:{[id(70)]:debt}});
  expect(html).toContain('aria-current="page">Obligations</a>');
  expect(html).toContain('<h3>Obligation of ILS 500.00</h3>');
  expect(html).toContain('<dt>Allocated so far (canonical total)</dt><dd>ILS 300.00</dd>');
  expect(html).toContain('<dt>Remaining (recomputed by the obligations capability)</dt><dd>ILS 200.00</dd>');
  expect(html).toContain('Owed to: Daniel');
  expect(renderObligations({})).toContain('No obligations recorded.');
  expect(renderObligations({state:'loading',view:null})).toContain('Loading obligations…');
});

it('labels advisory coverage as advisory and shows an unallocated remainder as unknown',()=>{
  const html=renderObligations({view:obligationsView([obligation({sourceManifest:{advisoryCoverageIgnored:[0.99]}})]),related:{[id(70)]:debt}});
  expect(html).toContain('Advisory only</span> 99% — shown as stated; never used to compute the remaining amount.');
  expect(html).toContain('Unknown</span> — no classification is invented for it');
  expect(renderObligations({view:obligationsView([obligation({unclassifiedRemainder:'10.00'})])})).toContain('<dt>Unallocated payment remainder</dt><dd>ILS 10.00</dd>');
});

it('shows two conflicting amounts side by side, keeps separate obligations separate, and words a fulfilled one',()=>{
  const conflict=obligation({conflictFlag:true,sourceManifest:{conflictingAmounts:[{propositionId:id(80),amount:'500.00',currency:'ILS'},
    {propositionId:id(81),amount:'550.00',currency:'ILS'}]}});
  const second=obligation({obligationFrameInstanceId:id(71),principalAmount:'70.00',outcomeState:'RESOLVED',remainingAmountCapabilityDerived:'0'});
  const html=renderObligations({view:obligationsView([conflict,second]),related:{[id(70)]:debt,[id(71)]:{...debt,frameInstanceId:id(71)}}});
  expect(html).toContain('Contested: two sources give different amounts');
  expect(html).toContain('ILS 500.00 <span class="belief-links">');
  expect(html).toContain('ILS 550.00 <span class="belief-links">');
  expect(html).toContain('Both amounts are kept. Uai has not chosen between them.');
  expect(html).toContain('<h3>Obligation of ILS 70.00</h3>');
  expect(html.match(/<li class="obligation/g)).toHaveLength(2);
  expect(html).toContain('Settled by an accepted resolution — no status value was recorded in its place.');
});
