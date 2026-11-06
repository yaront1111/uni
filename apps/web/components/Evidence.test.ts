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

import {candidateBystanderPanel,candidateOwnerPanel,sourcesProps} from './testing/screens';
const statementsOf=(over:Record<string,unknown>)=>renderToStaticMarkup(createElement(Evidence,{...sourcesProps,...over}));
it('lists the statements read from a source with their labels and one Why? / Sources disclosure each (ADR 0047)',()=>{
  const html=statementsOf({});
  expect(html).toContain('<h2 id="statements-heading">Statements read from this source</h2>');
  expect(html).toContain('aria-labelledby="statements-heading"');
  expect(html).toContain('These statements were read from this source. They are not yet in memory: nothing has accepted them.');
  expect(html).toContain('What the labels mean');expect(html).toContain('data-label="REPORTED"');
  expect(html).toContain('</span> '+candidateOwnerPanel.statement+'</p>');
  expect(html).toContain('</span> '+candidateBystanderPanel.statement+'</p>');
  expect(html.match(/<summary>Why\? \/ Sources/g)).toHaveLength(2);
  expect(html).not.toContain('Only the first');
  expect(html.indexOf('Source detail')).toBeLessThan(html.indexOf('Statements read from this source'));
  const readingPath=html.replace(/<details class="advanced">[\s\S]*?<\/details>/g,'').replace(/<[^>]+>/g,' ');
  expect(readingPath).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  expect(readingPath).not.toContain('omi-conv-2026-10-28-7f3a');
});
it('says when the list is cut short',()=>{
  expect(statementsOf({statements:{...sourcesProps.statements!,truncated:true}})).toContain('<p>Only the first 2 statements are shown.</p>');
});
it('shows a failed statements read as a fixed alert and keeps the source detail',()=>{
  const html=statementsOf({statements:null,statementsError:'The statements read from this source could not be loaded. Please reload to retry.'});
  expect(html).toContain('<p role="alert">The statements read from this source could not be loaded. Please reload to retry.</p>');
  expect(html).toContain('Source detail');expect(html).toContain('Statements read from this source');
  expect(html).not.toContain(candidateOwnerPanel.statement);expect(html).not.toContain(candidateBystanderPanel.statement);
  expect(html).not.toContain('What the labels mean');
});
it('draws no statements section for a source with none, or before anything was read',()=>{
  expect(statementsOf({statements:{...sourcesProps.statements!,statements:[]}})).not.toContain('Statements read from this source');
  expect(statementsOf({statements:null})).not.toContain('Statements read from this source');
  const {statements:_s,statementsError:_e,...earlier}=sourcesProps;
  expect(renderToStaticMarkup(createElement(Evidence,earlier))).not.toContain('Statements read from this source');
  expect(statementsOf({evidence:null})).not.toContain('Statements read from this source');
});

// The Source page's loader (pages/sources.tsx): the statements read happens on
// the server with server-chosen declarations, after the evidence read succeeds.
import {vi} from 'vitest';
import type {GetServerSidePropsContext} from 'next';
const server=vi.hoisted(()=>({identity:vi.fn(),apiRequest:vi.fn()}));vi.mock('../lib/server',()=>server);
import {getServerSideProps as sourcesRoute} from '../pages/sources';
const evidenceId=sourcesProps.evidence!.evidenceId,ownerScopeId=sourcesProps.evidence!.ownerScopeId;
const CLAIMS='/v1/memory/evidence/'+evidenceId+'/claims';
const UNAVAILABLE='The statements read from this source could not be loaded. Please reload to retry.';
const load=async(statements:()=>Promise<{status:number;body:unknown}>,query:Record<string,string>={evidence:evidenceId})=>{
  server.identity.mockResolvedValue({ownerScopeId,userId:ownerScopeId,deviceId:ownerScopeId});
  server.apiRequest.mockReset();
  server.apiRequest.mockImplementation(async(path:string)=>path===CLAIMS?statements()
    :path.startsWith('/v1/connectors/')?{status:200,body:{connectorType:'OMI',status:'ACTIVE',evidence:[]}}
      :{status:200,body:sourcesProps.evidence});
  return sourcesRoute({req:{headers:{cookie:'session'}},res:{setHeader:vi.fn()},query} as unknown as GetServerSidePropsContext);
};
it('reads a source\'s statements under memory.inspect with the pinned declarations, after the evidence read',async()=>{
  const loaded=await load(async()=>({status:200,body:JSON.parse(JSON.stringify(sourcesProps.statements))}));
  expect(loaded).toHaveProperty('props.statements',sourcesProps.statements);
  expect(loaded).toHaveProperty('props.statementsError',null);
  expect(loaded).toHaveProperty('props.error',null);
  expect(server.apiRequest.mock.calls.map(call=>call[0])).toEqual(['/v1/evidence/'+evidenceId,CLAIMS]);
  const headers=server.apiRequest.mock.calls[1]![2] as Record<string,string>;
  expect(server.apiRequest.mock.calls[1]![1]).toBe('GET');
  expect(headers).toMatchObject({cookie:'session','x-owner-scope-id':ownerScopeId,'x-purpose':'memory.inspect',
    'x-data-purpose':'PERSONAL_ASSISTANCE','x-maximum-sensitivity':'RESTRICTED'});
  expect(headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
});
it('redirects an expired session met by the statements read',async()=>{
  expect(await load(async()=>({status:401,body:{}}))).toEqual({redirect:{destination:'/signin?reason=expired',permanent:false}});
});
it('turns any other statements failure into one fixed sentence and keeps the source detail',async()=>{
  for(const statements of [async()=>({status:404,body:{code:'WHY_OBJECT_NOT_FOUND'}}),async()=>({status:200,body:{statements:'PRIVATE_BODY_MARKER'}}),
    async()=>{throw new Error('API_UNAVAILABLE PRIVATE_BODY_MARKER');}]){
    const loaded=await load(statements);
    expect(loaded).toHaveProperty('props.statementsError',UNAVAILABLE);
    expect(loaded).toHaveProperty('props.statements',null);
    expect(loaded).toHaveProperty('props.error',null);
    expect(loaded).toHaveProperty('props.evidence',sourcesProps.evidence);
    expect(JSON.stringify(loaded)).not.toContain('PRIVATE_BODY_MARKER');expect(JSON.stringify(loaded)).not.toContain('WHY_OBJECT_NOT_FOUND');
  }
});
it('reads no statements for a connector, a refused source or an invalid link',async()=>{
  const statements=vi.fn(async()=>({status:200,body:sourcesProps.statements}));
  expect(await load(statements,{connector:evidenceId})).toHaveProperty('props.statements',null);
  server.apiRequest.mockReset();server.apiRequest.mockResolvedValue({status:403,body:{}});
  const refused=await sourcesRoute({req:{headers:{cookie:'session'}},res:{setHeader:vi.fn()},query:{evidence:evidenceId}} as unknown as GetServerSidePropsContext);
  expect(refused).toHaveProperty('props.statementsError',null);expect(server.apiRequest).toHaveBeenCalledTimes(1);
  expect(await load(statements,{evidence:'not-a-uuid'})).toHaveProperty('props.statements',null);
  expect(statements).not.toHaveBeenCalled();
});
