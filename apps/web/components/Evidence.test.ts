import {expect,it} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import * as access from './Access';
import {Evidence} from './Evidence';
it('links the authenticated common navigation to the designed upload screen',()=>{
  const html=renderToStaticMarkup(createElement(access.Access,{state:'desktop',devices:[],registered:true}));
  expect(html).toContain('href="/sources"');expect(html).toContain('Documents');
});
it('renders a labeled upload form and truthful storage/processing state',()=>{
  const html=renderToStaticMarkup(createElement(Evidence,{evidence:null,connector:null,error:'Upload failed'}));
  expect(html).toContain('type="file"');expect(html).toContain('for="document"');
  expect(html).toContain('Allowed purpose: personal assistance');
  // The document index ships with the connector slice, so the copy now states
  // what is true of it: the text is searchable as soon as the document is
  // stored, and meaning extraction still waits for one of its four triggers.
  // It must keep claiming no more than that.
  expect(html).toContain('searchable as soon as it is stored');
  expect(html).toContain('Meaning is extracted later unless you ask now');
  expect(html).not.toContain('semantic memory');
  expect(html).toContain('role="alert"');expect(html).toContain('Upload failed');
});

import {publicEvidenceSchema} from '@unai/domain';
it('shows recorded processing progress and unresolved review without echoing raw worker errors',()=>{
  const id='00000000-0000-4000-8000-000000000001';
  const evidence=publicEvidenceSchema.parse({evidenceId:id,ownerScopeId:id,connectorId:null,sourceType:'DOCUMENT',externalId:'doc',parentExternalId:null,
    actorRef:{type:'USER',id},occurredAt:null,observedAt:'2026-09-19T10:00:00.000Z',rawObjectRef:id,contentHash:'a'.repeat(64),sensitivity:'PRIVATE',allowedPurposes:['PERSONAL_ASSISTANCE'],
    ingestionVersion:'evidence-json-v1',deterministicMetadata:{},ingestionStatus:'STORED',processing:{status:'NEEDS_REVIEW',unresolvedClaims:2,lastError:'PROTECTED_ERROR_MARKER',completedAt:null}});
  const html=renderToStaticMarkup(createElement(Evidence,{evidence,connector:null,error:null}));
  expect(html).toContain('Processing needs review');expect(html).toContain('2 unresolved');expect(html).toContain('href="/memory/inbox"');expect(html).not.toContain('PROTECTED_ERROR_MARKER');
  evidence.processing=null;expect(renderToStaticMarkup(createElement(Evidence,{evidence,connector:null,error:null}))).toContain('Processing status is not available');
});
