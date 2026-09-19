import {expect,it} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import type {PublicOverlayDelta} from '@unai/domain';
import * as screen from './CorrectionControls';
import {BeliefLinks,beliefRefType,correctionHref,inspectorHref} from './BeliefLinks';
import {inspection} from './testing/inspection';

/** The Correction controls screen (journey J5; CRT-UX-10-A): ten separately
 * labelled controls, each stating what it will change and each sending its own
 * request to its own endpoint. */

const id=(n:number)=>'0192f3a0-0000-7000-8000-'+String(n).padStart(12,'0');
const at='2026-09-18T10:00:00.000Z';
const render=(props:Partial<screen.CorrectionControlsProps>)=>renderToStaticMarkup(createElement(screen.CorrectionControls,
  {state:'ready',inspector:inspection(),...props}));
const escape=(text:string)=>text.replaceAll('\'','&#x27;');

it('offers ten distinct, separately labelled controls, each with its own endpoint and operation kind',()=>{
  expect(screen.CONTROLS.map(control=>control.label)).toEqual(['Correct','Changed','Confirm','Reject','Keep uncertain','Suppress','Archive',
    'Delete','Merge','Split']);
  expect(new Set(screen.CONTROLS.map(control=>control.operationKind)).size).toBe(10);
  expect(new Set(screen.CONTROLS.map(control=>control.endpoint)).size).toBe(10);
  expect(new Set(screen.CONTROLS.map(control=>control.button)).size).toBe(10);
  const html=render({});
  expect(html).toContain('Skip to content');
  for(const control of screen.CONTROLS){
    expect(html,control.label).toContain('<h3 id="control-'+control.key+'">'+control.label+'</h3>');
    expect(html,control.label).toContain('<strong>What this will change:</strong> '+escape(control.preview));
    expect(html,control.label).toContain('aria-describedby="control-'+control.key+'-preview"');
  }
  expect(html).not.toMatch(/>Edit( memory)?<\/(button|h3)>/i);
});

it('sends suppress, archive and delete to three separate endpoints, and delete only with an explicit confirmation',()=>{
  const inspector=inspection();
  const body=(key:string,data:Record<string,string>)=>screen.requestFor(screen.CONTROLS.find(control=>control.key===key)!,inspector,new Map(Object.entries(data)));
  const target={objectType:'proposition',objectId:id(1)};
  expect(body('suppress',{scope:'OBJECT'})).toEqual({path:'memory/suppressions',body:{target,scope:'OBJECT'}});
  expect(body('archive',{})).toEqual({path:'memory/archives',body:{target}});
  expect(body('delete',{scope:'OBJECT',confirmation:'DELETE'})).toEqual({path:'memory/deletions',body:{target,scope:'OBJECT',confirmation:'DELETE'}});
  expect(render({})).toContain('<label for="control-delete-confirm">Type DELETE to confirm</label>');
  // Correct and Changed are different writes: the same period, or a new one.
  expect(body('correct',{value:'60',rawText:'It was 60'})).toEqual({path:'memory/corrections',body:{target,correctedValue:'60',rawText:'It was 60'}});
  expect(body('changed',{value:'60',from:'2026-04-01',rawText:'Now 60'})).toEqual({path:'memory/state-changes',
    body:{target,newValue:'60',changeEffectiveFrom:'2026-04-01T00:00:00.000Z',rawText:'Now 60'}});
  expect(body('merge',{subject:'frame_instance:'+id(3),other:id(40)})).toEqual({path:'memory/frame-instances/merge',
    body:{instanceIds:[id(3),id(40)],survivorHint:id(3)}});
  expect(body('merge',{subject:'entity:'+id(6),other:id(41),rawText:'Same Daniel'})).toEqual({path:'memory/entities/merge',
    body:{entityIds:[id(6),id(41)],survivorHint:id(6),reason:'Same Daniel'}});
  expect(body('split',{parts:'concert, dinner',['claim:'+id(5)]:'concert'})).toEqual({path:'memory/frame-instances/'+id(3)+'/split',
    body:{targetPartitions:[{partitionKey:'concert'},{partitionKey:'dinner'}],claimAssignments:[{claimId:id(5),partitionKey:'concert'}]}});
});

it('maps every correction endpoint to its own purpose in the same-origin proxy',()=>{
  const proxy=readFileSync(resolve('apps/web/pages/api/platform/[...path].ts'),'utf8');
  for(const control of screen.CONTROLS.filter(entry=>entry.purpose==='memory.correct')){
    expect(proxy,control.endpoint).toContain(control.endpoint.replace('memory/',''));
  }
  expect(proxy).toContain("?'memory.correct':null");
});

it('acknowledges a write with its owner sequence, no in-place update, and visibility on the other devices',()=>{
  const html=render({receipt:{control:'suppress',operationKind:'SUPPRESS',memoryOperationId:id(50),ownerSequence:12,proposedTransactionId:id(51),transactionId:null}});
  expect(html).toContain('Suppress: recorded');
  expect(html).toContain('Recorded as a Suppress operation (suppress). Owner sequence 12.');
  expect(html).toContain('No existing row was changed: your words were stored as new evidence and a change was proposed for review.');
  expect(html).toContain('Your other devices see this on their very next read.');
});

it('shows an earlier statement later contested, with its reason, and never as reversed',()=>{
  const delta:PublicOverlayDelta={overlayDeltaId:id(60),ownerSequence:3,deltaKind:'USER_CONFIRMATION',lifecycle:'CONTESTED',rawText:'Yes, ILS 500',
    target:{objectType:'proposition',objectId:id(1)},sourceEvidenceId:id(61),attachedFrameInstanceId:id(3),attachedBeliefSlotId:null,
    candidateEntityRefs:[],candidateFrameTypes:[],discourseAnchor:null,createdAt:at,
    contestedReason:{failureReason:'REEXTRACTION_CONTRADICTS_OWNER',conflictingEvidenceIds:[id(62)],affectedProjections:['obligations_projection'],
      containingManifestIds:[id(63),id(64)]},assertionKind:'USER_ASSERTION',
    independentVerification:{verified:false,independentEvidenceIds:[],independentClaimOrigins:[]}};
  const html=render({inspector:inspection({},{ownerOverlayDeltas:[delta]})});
  expect(html).toContain('“Yes, ILS 500” — user confirmation, owner sequence 3, contested');
  expect(html).toContain('Your statement; not independently verified.');
  expect(html).toContain('It is shown as contested; what you said was not reversed and is still here.');
  expect(html).toContain('<li>Why: reextraction contradicts owner</li>');
  expect(html).toContain('<li>Conflicting evidence: 1</li>');
  expect(html).toContain('<li>Affected projections: obligations_projection</li>');
  expect(html).toContain('<li>Answers that contained it: 2</li>');
  expect(render({})).toContain('You have not corrected this belief yet.');
});

it('renders a target that cannot be corrected',()=>{
  expect(render({state:'not-found',inspector:null,error:'There is no belief to inspect here.'})).toContain('role="alert">There is no belief to inspect here.');
});

it('builds the inspect and correct links any surface uses, for every object type a surface names',()=>{
  for(const type of ['proposition','propositions','claim','frame_instance','resolution_assertions','owner_overlay_deltas']){
    expect(beliefRefType(type),type).not.toBeNull();
  }
  expect(beliefRefType('source_items')).toBeNull();
  expect(inspectorHref('proposition',id(1))).toBe('/memory/inspector/proposition/'+id(1));
  expect(correctionHref('owner_overlay_delta',id(2))).toBe('/memory/correct/owner_overlay_delta/'+id(2));
  const html=renderToStaticMarkup(createElement(BeliefLinks,{objectType:'propositions',objectId:id(1),about:'what you owe Daniel'}));
  expect(html).toBe('<span class="belief-links"><a href="/memory/inspector/proposition/'+id(1)+'">Inspect<span class="sr-only"> what you owe Daniel</span></a> · '
    +'<a href="/memory/correct/proposition/'+id(1)+'">Correct<span class="sr-only"> what you owe Daniel</span></a></span>');
  expect(renderToStaticMarkup(createElement(BeliefLinks,{objectType:'source_items',objectId:id(1),about:'x'}))).toBe('');
});
