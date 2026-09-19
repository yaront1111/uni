import {expect,it} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {whySourcesSchema,type WhySources as Panel} from '@unai/domain';
import {WhySources} from './WhySources';

/** The Why? / Sources panel: one assertion per drawn state (CRT-UX-11-A), and
 * identifiers only inside the advanced inspector. */

const id=(n:number)=>'0192f3a0-0000-7000-8000-'+String(n).padStart(12,'0');
const UUID=/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** The text a reader meets without opening the advanced inspector. */
const readingPath=(html:string)=>html.replace(/<details class="advanced">[\s\S]*?<\/details>/g,'').replace(/<[^>]+>/g,' ');

const confirmedPanel:Panel=whySourcesSchema.parse({
  subject:{objectType:'propositions',objectId:id(1)},subjectKind:'BELIEF',label:'CONFIRMED',
  statement:'commitment action description: send Daniel the signed lease',modality:'COMMITTED',assessmentStatus:'ACCEPTED',
  effectiveTime:{from:'2026-09-20T08:00:00.000Z',to:null,recordedAt:'2026-09-20T09:00:00.000Z'},
  confidence:{extraction:0.93,entityResolution:null,temporalResolution:0.88,instanceResolution:null,assessmentStatus:'ACCEPTED'},
  claims:[{claimId:id(2),claimOrigin:'USER_STATEMENT',claimingActor:{kind:'PERSON',label:'Maya',entityId:id(3)},
    recordedAt:'2026-09-20T09:00:00.000Z',validFrom:'2026-09-20T08:00:00.000Z',validTo:null,
    confidence:{extraction:0.93,entityResolution:null,temporalResolution:0.88,instanceResolution:null},
    source:{evidenceId:id(4),sourceType:'CONVERSATION',occurredAt:'2026-09-20T08:00:00.000Z',anchorKind:'MESSAGE_SPAN',
      excerpt:'I will send Daniel the signed lease by this afternoon.'}}],
  claimingActors:[{kind:'PERSON',label:'Maya',entityId:id(3)}],
  sources:[{evidenceId:id(4),sourceType:'CONVERSATION',occurredAt:'2026-09-20T08:00:00.000Z',anchorKind:'MESSAGE_SPAN',
    excerpt:'I will send Daniel the signed lease by this afternoon.'}],
  redactions:[],conflict:{status:'NO_CONFLICT',competing:[],relations:[]},
  derivation:{isInferred:false,steps:[],modelClaims:[]},resolutions:[],
  explainPath:'/v1/memory/propositions/'+id(1)+'/explain',panelVersion:'why-sources-0.1.0',readAt:'2026-09-21T09:00:00.000Z',
});
const render=(panel:Panel|null,timeZone?:string)=>renderToStaticMarkup(createElement(WhySources,{about:'Commitment to Daniel',panel,...(timeZone?{timeZone}:{})}));

it('is closed until the reader activates Why? / Sources',()=>{
  const html=render(confirmedPanel);
  expect(html).toMatch(/^<details class="why"><summary>Why\? \/ Sources/);
  expect(html).not.toMatch(/<details class="why" open/);
  expect(html).toContain('for: Commitment to Daniel');
});

it('opens a confirmed belief with its claiming actor, source excerpt, effective time and confidence',()=>{
  const html=render(confirmedPanel,'Asia/Tokyo');
  expect(html).toContain('data-label="CONFIRMED"');
  expect(html).toContain('A belief, accepted.');
  expect(html).toContain('Who claimed it');expect(html).toContain('Maya: you said it');
  expect(html).toContain('What the source says');expect(html).toContain('I will send Daniel the signed lease by this afternoon.');
  expect(html).toContain('When it holds');expect(html).toContain('(Asia/Tokyo)');
  expect(html).toContain('How confident');expect(html).toContain('Reading from the source 93%');expect(html).toContain('when 88%');
  expect(html).toContain('Nothing recorded disputes this.');
  expect(html).toContain('Not inferred: it rests on what its sources state.');
  expect(readingPath(html)).not.toMatch(UUID);
  expect(html).toContain('Advanced inspector: identifiers');expect(html).toContain(id(1));
});

it('opens a reported assertion by another person',()=>{
  const html=render({...confirmedPanel,label:'REPORTED',claimingActors:[{kind:'PERSON',label:'Dana',entityId:id(9)}],
    claims:[{...confirmedPanel.claims[0]!,claimOrigin:'EXTERNAL_PERSON_ASSERTION',claimingActor:{kind:'PERSON',label:'Dana',entityId:id(9)}}]});
  expect(html).toContain('data-label="REPORTED"');expect(html).toContain('Dana: another person said it');
});

it('opens an inferred statement with its derivation path',()=>{
  const html=render({...confirmedPanel,label:'INFERRED',derivation:{isInferred:true,
    steps:[{evaluatorId:'extraction.commitment_inference',version:'fixture-model-1',
      inputs:[{objectType:'claims',objectId:id(5),statement:'A recorded claim (external person assertion)'}]}],
    modelClaims:[{claimId:id(2),claimOrigin:'MODEL_INFERENCE',modelId:'fixture-model-1',promptVersion:'extract-0.1.0'}]}});
  expect(html).toContain('data-label="INFERRED"');
  expect(html).toContain('Inferred, not stated by anyone.');
  expect(html).toContain('Derived by the commitment inference rule (fixture-model-1) from:');
  expect(html).toContain('A recorded claim (external person assertion)');
  expect(html).toContain('a model inferred it (fixture-model-1, extract-0.1.0)');
});

it('opens a contested statement with both competing values and the conflict status',()=>{
  const html=render({...confirmedPanel,label:'CONTESTED',assessmentStatus:'CONTESTED',conflict:{status:'CONTESTED',
    competing:[{propositionId:id(6),statement:'obligation principal amount: ILS 540.00',assessmentStatus:'CONTESTED'}],
    relations:[{kind:'COMPETING_PROPOSITION',relation:'SAME_SLOT_DIFFERENT_VALUE'}]},
    statement:'obligation principal amount: ILS 450.00'});
  expect(html).toContain('data-label="CONTESTED"');
  expect(html).toContain('Contested: sources disagree and neither value is settled.');
  expect(html).toContain('ILS 450.00');expect(html).toContain('Competing value: obligation principal amount: ILS 540.00 (contested)');
});

it('opens a pending owner assertion that is not yet canonicalized',()=>{
  const html=render({...confirmedPanel,subject:{objectType:'owner_overlay_deltas',objectId:id(7)},subjectKind:'OWNER_ASSERTION',
    label:'PENDING_OWNER_ASSERTION',statement:'You said: “The dentist moved it to 16:00.” This is your assertion and is not yet independently verified.',
    claims:[],claimingActors:[{kind:'OWNER',label:'You',entityId:null}],assessmentStatus:null,
    confidence:{extraction:null,entityResolution:null,temporalResolution:null,instanceResolution:null,assessmentStatus:null}});
  expect(html).toContain('data-label="PENDING_OWNER_ASSERTION"');
  expect(html).toContain('Your own statement, recorded as you said it.');
  expect(html).toContain('not yet independently verified');
  expect(html).toContain('No assessment yet.');
});

it('opens a scheduled item and a resolved one linked to its resolution assertion',()=>{
  expect(render({...confirmedPanel,label:'SCHEDULED',modality:'SCHEDULED'})).toContain('data-label="SCHEDULED"');
  const html=render({...confirmedPanel,subject:{objectType:'resolution_assertions',objectId:id(8)},subjectKind:'RESOLUTION',label:'RESOLVED',
    statement:'Outcome recorded: fulfilled, effective 2026-09-21.',
    resolutions:[{resolutionAssertionId:id(8),outcomeCode:'FULFILLED',effectiveAt:'2026-09-21T09:00:00.000Z',lifecycle:'ACCEPTED'}]});
  expect(html).toContain('data-label="RESOLVED"');
  expect(html).toContain('A resolution assertion recording an outcome.');
  expect(html).toContain('Outcome');expect(html).toContain('fulfilled, effective 2026-09-21 09:00 UTC');
});

it('lists a withheld source excerpt as a redaction and never quotes it',()=>{
  const html=render({...confirmedPanel,sources:[],claims:[{...confirmedPanel.claims[0]!,source:null}],
    redactions:[{claimId:id(2),reason:'SOURCE_NOT_READABLE_FOR_THIS_REQUEST'}]});
  expect(html).toContain('1 source is withheld: this view may not read it under its purpose or sensitivity limit.');
  expect(html).not.toContain('signed lease by this afternoon');
});

it('says so when the panel could not be read',()=>{
  const html=render(null);
  expect(html).toContain('role="alert"');expect(html).toContain('could not be read');
});
