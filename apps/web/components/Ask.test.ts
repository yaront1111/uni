import {expect,it} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {askAnswerSchema,whySourcesSchema,type AskAnswer,type WhySources} from '@unai/domain';
import {Ask,EXAMPLE_QUESTIONS,type AskProps} from './Ask';

/** The Ask screen: one assertion per drawn state it serves, the labelled form,
 * the live region, and no identifier outside the advanced inspector. */

const id=(n:number)=>'0192f3a0-0000-7000-8000-'+String(n).padStart(12,'0');
const UUID=/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const readingPath=(html:string)=>html.replace(/<details class="advanced">[\s\S]*?<\/details>/g,'').replace(/<[^>]+>/g,' ');
const statement=(n:number,over:Record<string,unknown>)=>({statementId:'S'+n,kind:'SELECTED_STATE',label:'COMMITTED',
  text:'Committed, not yet fulfilled: commitment action description is send Daniel the signed lease.',
  objectRefs:[{objectType:'propositions',objectId:id(300+n)}],sourceEvidenceIds:[id(400)],
  explainPath:'/v1/memory/propositions/'+id(300+n)+'/explain',...over});
const answer:AskAnswer=askAnswerSchema.parse({
  question:'What did I promise Daniel?',answerType:'FUTURE_COMMITMENT',queryMode:'OPEN_COMMITMENTS',historicalMode:null,
  classification:{matchedRule:'FUTURE_COMMITMENT_PROMISE',classifierVersion:'question-classifier-0.1.0'},
  worldTime:'2026-09-21T20:00:00.000Z',knowledgeTime:'2026-09-21T20:00:00.000Z',
  statements:[statement(1,{}),
    statement(2,{kind:'CONFLICT',label:'CONFLICTING',text:'These disagree about principal amount: ILS 450.00 versus ILS 540.00.'}),
    statement(3,{kind:'OWNER_ASSERTION_PENDING',label:'REPORTED',text:'You said: "I paid Daniel back". This is your assertion and is not yet independently verified.',
      objectRefs:[{objectType:'owner_overlay_deltas',objectId:id(303)}],explainPath:null}),
    statement(4,{kind:'RESOLUTION',label:'CONFIRMED',text:'Outcome recorded: fulfilled, effective 2026-09-20.',
      objectRefs:[{objectType:'resolution_assertions',objectId:id(304)}],sourceEvidenceIds:[],explainPath:null}),
    statement(5,{kind:'SELECTED_STATE',label:'INFERRED',text:'Recorded: commitment action description is bring Daniel the spare keys.'})],
  sourceLinks:[{evidenceId:id(400),sourceType:'CONVERSATION',occurredAt:'2026-09-20T08:00:00.000Z',anchorIds:[id(401)],href:'/v1/evidence/'+id(400)}],
  declinesToAssert:false,packetId:id(1),packetHash:'b'.repeat(64),selectionsDigest:'c'.repeat(64),
  composer:{kind:'DETERMINISTIC_COMPOSER',version:'ask-composer-0.1.0',modelCalled:false,modelId:null,promptVersion:null},
  grounding:{validatorVersion:'grounding-validator-0.1.0',action:'PASSED',finalSource:'DETERMINISTIC_COMPOSER',
    attempts:[{attempt:1,candidateSource:'DETERMINISTIC_COMPOSER',outcome:'PASSED',violations:[]}],violations:[]},
  answerManifestId:id(2),
});
const panel:WhySources=whySourcesSchema.parse({
  subject:{objectType:'propositions',objectId:id(305)},subjectKind:'BELIEF',label:'INFERRED',
  statement:'commitment action description: bring Daniel the spare keys',modality:'COMMITTED',assessmentStatus:'ACCEPTED',
  effectiveTime:{from:'2026-09-20T08:00:00.000Z',to:null,recordedAt:'2026-09-20T09:00:00.000Z'},
  confidence:{extraction:0.7,entityResolution:null,temporalResolution:null,instanceResolution:null,assessmentStatus:'ACCEPTED'},
  claims:[],claimingActors:[{kind:'MODEL',label:'Uai (a model reading, not a person)',entityId:null}],
  sources:[{evidenceId:id(400),sourceType:'CONVERSATION',occurredAt:null,anchorKind:'MESSAGE_SPAN',excerpt:'Daniel: can you bring the spare keys?'}],
  redactions:[],conflict:{status:'NO_CONFLICT',competing:[],relations:[]},
  derivation:{isInferred:true,steps:[{evaluatorId:'extraction.commitment_inference',version:'fixture-model-1',
    inputs:[{objectType:'claims',objectId:id(9),statement:'A recorded claim (external person assertion)'}]}],modelClaims:[]},
  resolutions:[],explainPath:'/v1/memory/propositions/'+id(305)+'/explain',panelVersion:'why-sources-0.1.0',readAt:'2026-09-21T20:00:00.000Z',
});
const render=(props:Partial<AskProps>)=>renderToStaticMarkup(createElement(Ask,{state:'empty',question:'',answer:null,why:{},...props}));

it('offers a labelled question form and example questions when empty',()=>{
  const html=render({});
  expect(html).toContain('Skip to content');expect(html).toContain('role="search"');
  expect(html).toContain('<label for="question">Your question</label>');
  expect(html).toContain('action="/ask" method="get"');
  for(const question of EXAMPLE_QUESTIONS)expect(html).toContain(question.replace(/'/g,'&#x27;'));
  expect(html).toContain('href="/ask" aria-current="page">Ask</a>');
});

it('answers with per-statement labels, source links and a Why? / Sources action on each',()=>{
  const html=render({state:'answered',question:answer.question,answer,why:{S5:panel,S1:null}});
  expect(html).toMatch(/aria-live="polite" aria-atomic="true">Answer ready: 5 statements\./);
  expect(html).toContain('Answer type: <strong>What is promised or planned</strong>');
  expect(html).toContain('send Daniel the signed lease');
  expect(html).toContain('href="/sources?evidence='+id(400)+'">Source 1: conversation, 2026-09-20</a>');
  for(const label of ['COMMITTED','CONTESTED','PENDING_OWNER_ASSERTION','RESOLVED','INFERRED'])expect(html,label).toContain('data-label="'+label+'"');
  expect(html).toContain('No source is linked to this statement.');
  // Why? / Sources on the inferred statement shows its derivation path.
  expect(html).toContain('Derived by the commitment inference rule (fixture-model-1) from:');
  expect(html).toContain('Daniel: can you bring the spare keys?');
  expect(html).toContain('href="/answers/'+id(2)+'">How this answer was made (answer provenance)</a>');
});

it('keeps identifiers in the advanced inspector only',()=>{
  const html=render({state:'answered',question:answer.question,answer,why:{S5:panel}});
  expect(readingPath(html)).not.toMatch(UUID);
  expect(html).toContain('Advanced inspector: identifiers');expect(html).toContain(id(1));
});

it('says when the grounding validator changed or blocked the answer, and when it declines to assert',()=>{
  const downgraded=render({state:'answered',question:answer.question,answer:{...answer,grounding:{...answer.grounding,action:'DOWNGRADED'},declinesToAssert:true},why:{}});
  expect(downgraded).toContain('Some wording was made less certain');
  expect(downgraded).toContain('does not assert anything');
  const blocked=render({state:'answered',question:answer.question,answer:{...answer,grounding:{...answer.grounding,action:'BLOCKED'}},why:{}});
  expect(blocked).toContain('The answer was blocked');
});

it('refuses in fixed words when no purpose or an unpermitted purpose was declared',()=>{
  const denied=render({state:'refused',question:'What did I promise Daniel?',refusal:'CONTEXT_READ_DENIED'});
  expect(denied).toContain('role="alert"');expect(denied).toContain('does not allow this purpose to read it');
  expect(render({state:'refused',question:'x',refusal:'ASK_REQUEST_INCOMPLETE'})).toContain('such as its purpose');
  expect(render({state:'error',question:'x'})).toContain('could not be answered');
});

it('links every belief a statement rests on to the Memory inspector and the Correction controls (CRT-UX-10-B)',()=>{
  const html=render({state:'answered',question:answer.question,answer,why:{}});
  expect(html).toContain('<a href="/memory/inspector/proposition/'+id(301)+'">Inspect');
  expect(html).toContain('<a href="/memory/correct/owner_overlay_delta/'+id(303)+'">Correct');
  expect(html).toContain('<a href="/memory/inspector/resolution_assertion/'+id(304)+'">Inspect');
  // A statement resting on several beliefs numbers them; a belief slot is not linked.
  const several=askAnswerSchema.parse({...answer,statements:[statement(1,{kind:'CONFLICT',label:'CONFLICTING',
    objectRefs:[{objectType:'belief_slots',objectId:id(9)},{objectType:'propositions',objectId:id(310)},{objectType:'propositions',objectId:id(311)}]})]});
  const listed=render({state:'answered',question:answer.question,answer:several,why:{}});
  expect(listed).toContain('<ul class="belief-refs" aria-label="Memory behind this">');
  expect(listed).toContain('Memory 2: <span class="belief-links"><a href="/memory/inspector/proposition/'+id(311)+'">');
  expect(listed).not.toContain(id(9));
  // A statement about the absence of memory names nothing and links nothing.
  const nothing=askAnswerSchema.parse({...answer,statements:[statement(1,{kind:'NOTHING_FOUND',label:'UNKNOWN',
    text:'Nothing in the memory this request could read answers this question.',objectRefs:[],sourceEvidenceIds:[],explainPath:null})]});
  expect(render({state:'answered',question:answer.question,answer:nothing,why:{}})).not.toContain('/memory/inspector/');
  expect(readingPath(html)).not.toMatch(UUID);
});
