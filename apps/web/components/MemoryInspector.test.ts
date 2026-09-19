import {expect,it} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {MemoryInspector as Inspection,MemoryThreadView} from '@unai/domain';
import * as inspector from './MemoryInspector';
import * as thread from './MemoryThread';
import {inspection} from './testing/inspection';

/** The Memory inspector and Memory thread screens, one assertion group per state
 * the design draws (journey J5). */

const id=(n:number)=>'0192f3a0-0000-7000-8000-'+String(n).padStart(12,'0');
const at='2026-09-18T10:00:00.000Z';
const render=(value:Inspection|null,props:Partial<inspector.MemoryInspectorProps>={})=>renderToStaticMarkup(createElement(inspector.MemoryInspector,
  {state:'ready',inspector:value,...props}));

it('renders every section of the inspector with the skip link and headings',()=>{
  const html=render(inspection());
  expect(html).toContain('Skip to content');
  for(const heading of ['Current belief','Historical timeline','Original evidence','Claims and who asserted them','Inferences','Conflicts',
    'Resolution assertions','Connected memory threads','Access history','What you already did','Registry and extractor versions','Advanced']){
    expect(html,heading).toContain('>'+heading+'</h2>');
  }
});

it('renders the current belief with its assessment status and a way to correct it',()=>{
  const html=render(inspection());
  expect(html).toContain('<strong>principal amount: ILS 500.00</strong>');
  expect(html).toContain('<span aria-hidden="true">✓ </span>Confirmed</span>');
  expect(html).toContain('under policy local-policy-0.1.0');
  expect(html).toContain('<a href="/memory/correct/proposition/'+id(1)+'">Correct this belief</a>');
});

it('renders the timeline over valid and recorded time, keeping the replaced assessment as history',()=>{
  const html=render(inspection());
  expect(html).toContain('Provisional</span> recorded 2026-03-01 09:00 UTC — true from 2026-03-01 00:00 UTC to now; replaced on 2026-09-18 10:00 UTC and kept as history');
});

it('renders the original evidence with its anchors, and withheld evidence as a count',()=>{
  expect(render(inspection())).toContain('message span: <q>I borrowed ILS 500 from Daniel</q>');
  expect(render(inspection({withheldEvidenceCount:1}))).toContain('1 more item is above what this view may read.');
});

it('renders claims with asserting actors, origins and four separate confidences',()=>{
  const html=render(inspection());
  expect(html).toContain('You said it — asserted by Me (provisional)');
  expect(html).toContain('Confidence — extraction 90%, who it is about 80%, when not recorded, which situation 70%');
});

it('renders inferences, conflicts, resolutions, threads, access history, operations and versions',()=>{
  const html=render(inspection());
  expect(html).toContain('Used to derive <a href="/memory/inspector/proposition/'+id(17)+'">another belief</a> by finance.obligation_remaining');
  expect(html).toContain('Contested</span> Another value is held for the same thing — <a href="/memory/inspector/proposition/'+id(8)+'">inspect the other value</a>');
  expect(html).toContain('Partially resolved: partially fulfilled</span> effective 2026-09-18 10:00 UTC');
  expect(html).toContain('<a href="/memory/threads/'+id(18)+'">Daniel payment</a> (subject, active)');
  expect(html).toContain('Read or written for context for an answer');
  expect(html).toContain('Supplied as context to an answer — <a href="/answers/'+id(20)+'">see the answer&#x27;s record</a>');
  expect(html).toContain('confirm on 2026-09-18 10:00 UTC');
  expect(html).toContain('Registry release 0.1.0');
  expect(html).toContain('Extraction (targeted) by claude-sonnet-5, prompt extract-v3');
});

it('keeps identifiers in the advanced panel',()=>{
  const html=render(inspection());
  const [reading,advanced]=html.split('<h2 id="advanced">');
  expect(advanced).toContain('<code>'+id(3)+'</code> (shared.obligation)');
  expect(advanced).toContain('<code>'+id(1)+'</code>');
  expect(reading!.replace(/href="[^"]*"/g,'')).not.toContain(id(1));
});

it('renders a derived belief left unsupported and an assistant-only fact that is not an accepted belief',()=>{
  const unsupported=render(inspection({},{currentAssessment:{assessmentId:id(4),assessmentStatus:'UNSUPPORTED',recordedAt:at,policyVersion:'local-policy-0.1.0',decisionReason:null}}));
  expect(unsupported).toContain('Unsupported</span>');
  expect(unsupported).toContain('Unsupported: every input this belief was derived from has been invalidated, so it is no longer held.');
  const invented=render(inspection({},{currentAssessment:{assessmentId:null,assessmentStatus:null,recordedAt:null,policyVersion:null,decisionReason:null},
    claims:[{claimId:id(5),claimOrigin:'MODEL_EXTRACTION',lifecycle:'CANDIDATE',assertedByEntityId:null,extractionRunId:null,recordedAt:at,validFrom:null,validTo:null}],
    supportGraph:[]}));
  expect(invented).toContain('Only Uai has said this. It is kept as conversation evidence and is not an accepted belief.');
  expect(invented).toContain('Read from a source by Uai — no asserting person recorded');
});

it('renders a not-found and an error state',()=>{
  expect(render(null,{state:'not-found',error:'There is no belief to inspect here.'})).toContain('role="alert">There is no belief to inspect here.');
  expect(render(null,{state:'error',error:'This memory could not be read. Please reload to retry.'})).toContain('role="alert">');
});

// ---------------------------------------------------------------------------
// Memory thread
// ---------------------------------------------------------------------------

const view:MemoryThreadView={memoryThreadId:id(30),displayTitle:'Daniel payment',lifecycle:'ACTIVE',createdAt:at,
  members:[{memoryThreadId:id(30),objectType:'frame_instance',objectId:id(3),membershipKind:'SUBJECT',confidence:null,transactionId:null,createdAt:at,evidenceIds:[id(14),id(31)]}],
  currentProjection:[{projectionName:'obligations_projection',rowCount:1,frameInstanceIds:[id(3)],isComplete:false,projectionVersion:id(32),
    reducerVersion:'projection-reducers-0.1.0',ownerOverlayWatermark:6,canonicalTransactionWatermark:at,highRiskActionsBlocked:true,
    pendingAssertions:[{overlayDeltaId:id(33),ownerSequence:6,deltaKind:'USER_ASSERTION',lifecycle:'AWAITING_INSTANCE_RESOLUTION',rawText:'I paid him back',
      reason:'DELTA_NOT_ATTACHED',targetFrameInstanceId:null}]}],
  timeline:[{at:'2026-03-01T08:00:00.000Z',kind:'EVIDENCE',objectType:'source_items',objectId:id(14),detail:'CONVERSATION'},
    {at:'2026-03-10T08:00:00.000Z',kind:'RESOLUTION',objectType:'resolution_assertions',objectId:id(12),detail:'PARTIALLY_FULFILLED'}],
  plansAndExpectedOutcomes:[{propositionId:id(34),frameInstanceId:id(35),frameTypeId:'shared.commitment',predicateId:'shared.commitment.action_description',
    modality:'COMMITTED',normalizedValue:{text:'send Daniel the rest'},lifeCategories:['FINANCE']}],
  actualEvents:[{propositionId:id(1),beliefSlotId:id(2),frameInstanceId:id(3),frameTypeId:'shared.obligation',predicateId:'shared.obligation.principal_amount',
    modality:'ACTUAL',polarity:'POSITIVE',normalizedValue:{amount:'500.00',currency:'ILS'},assessmentStatus:'ACCEPTED',assessmentRecordedAt:at,
    validFrom:null,validTo:null,certainty:'ACCEPTED',lifeCategories:['FINANCE'],claimIds:[],evidenceIds:[],selectionReason:'THREAD_MEMBER_ACTUAL_STATE'}],
  resolutionLinks:[{claimId:null,evidenceIds:[],resolutionAssertionId:id(12),sourceFrameInstanceId:id(3),targetFrameInstanceId:id(36),outcomeCode:'PARTIALLY_FULFILLED',
    effectiveAt:'2026-03-10T08:00:00.000Z',lifecycle:'ACCEPTED',transitionContractId:'shared.obligation.resolution'}],
  openUncertainties:[{kind:'NO_ACCEPTED_VALUE',objectType:'propositions',objectId:id(8),detail:'CONTESTED_BELIEF'}],
  relatedPeople:[{entityId:id(37),entityKind:'PERSON',canonicalLabel:'Daniel'}],
  relatedDocuments:[{entityId:id(38),canonicalLabel:'Bank transfer receipt'}],
  relatedDecisions:[{frameInstanceId:id(39),frameTypeId:'shared.decision'}],
  evidenceIds:[id(14),id(31)],threadVersion:'memory-threads-0.1.0',readAt:at};
const renderThread=(props:Partial<thread.MemoryThreadProps>)=>renderToStaticMarkup(createElement(thread.MemoryThread,{state:'ready',thread:view,...props}));

it('renders every section of the memory thread',()=>{
  const html=renderThread({});
  expect(html).toContain('<h1>Daniel payment</h1>');
  expect(html).toContain('Obligations: 1 row —');
  expect(html).toContain('Incomplete</span> · includes your changes up to owner sequence 6');
  expect(html).toContain('Pending your assertion</span> “I paid him back”');
  expect(html).toContain('2026-03-01 08:00 UTC — Evidence arrived (conversation)');
  expect(html).toContain('Scheduled: committed</span> action description: send Daniel the rest');
  expect(html).toContain('Confirmed</span> principal amount: ILS 500.00');
  expect(html).toContain('Partially resolved: partially fulfilled</span> effective 2026-03-10 08:00 UTC — realized by another situation');
  expect(html).toContain('Contested</span> contested');
  expect(html).toContain('<li>Daniel</li>');
  expect(html).toContain('<li>Bank transfer receipt</li>');
  expect(html).toContain('decision <span class="belief-links">');
  expect(html).toContain('A situation (subject), backed by 2 sources');
});

it('renders empty sections in words and a thread that cannot be read',()=>{
  const empty={...view,currentProjection:[],timeline:[],plansAndExpectedOutcomes:[],actualEvents:[],resolutionLinks:[],openUncertainties:[],
    relatedPeople:[],relatedDocuments:[],relatedDecisions:[],members:[]};
  const html=renderThread({thread:empty});
  expect(html).toContain('No plan or expected outcome recorded.');
  expect(html).toContain('Nothing in this thread is unsettled.');
  expect(renderThread({state:'not-found',thread:null,error:'That is not a thread this memory holds.'})).toContain('role="alert">That is not a thread this memory holds.');
});
