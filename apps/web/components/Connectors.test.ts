import {expect,it} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {Connectors,type ConnectorsProps} from './Connectors';
import {Evidence} from './Evidence';

/** One assertion per state the design draws for "Connected sources", "Grant
 * connector capabilities" and "Upload a document". The component renders
 * statically, so every state is reachable from props alone. */
function connector(overrides:Record<string,unknown>={}){
  return {
    connectorId:'11111111-1111-4111-8111-111111111111',connectorType:'GMAIL',manifestId:'connector.gmail',
    manifestVersion:'0.1.0',displayName:'Gmail (read-only)',externalAccountRef:'owner@example.test',
    status:'ACTIVE',promptInjectionRisk:'HIGH',
    capabilities:[
      {capabilityId:'gmail.read_metadata',description:'Read message headers.',access:'READ',riskClass:'LOW',
        scopes:['https://www.googleapis.com/auth/gmail.metadata'],granted:true,grantedAt:'2026-09-01T10:00:00.000Z',revokedAt:null},
      {capabilityId:'gmail.read_content',description:'Read the body text of your messages.',access:'READ',riskClass:'MEDIUM',
        scopes:['https://www.googleapis.com/auth/gmail.readonly'],granted:false,grantedAt:null,revokedAt:null},
    ],
    grantedCapabilities:['gmail.read_metadata'],
    requestedScopes:['https://www.googleapis.com/auth/gmail.metadata'],
    cursor:{position:'gmail:page-2',providerToken:'2'},cursorUpdatedAt:'2026-09-14T08:00:00.000Z',
    lastSyncError:null,credentialHeld:true,createdAt:'2026-09-01T10:00:00.000Z',disconnectedAt:null,
    ...overrides,
  };
}
function render(props:Partial<ConnectorsProps>){
  return renderToStaticMarkup(createElement(Connectors,{
    connectors:[],selected:null,lastSync:null,state:'IDLE',refusal:null,error:null,...props,
  } as ConnectorsProps));
}

it('draws the empty state when no source is connected',()=>{
  const html=render({});
  expect(html).toContain('No sources connected');
  expect(html).toContain('Nothing is being read');
  expect(html).toContain('href="/connectors"');
});

it('lists a connected source with its status, granted capabilities and stored cursor',()=>{
  const html=render({connectors:[connector() as never]});
  expect(html).toContain('Gmail (read-only)');
  expect(html).toContain('Connected.');
  expect(html).toContain('gmail.read_metadata');
  expect(html).toContain('gmail:page-2');
  expect(html).toContain('Held by the secrets manager');
  // The credential itself is never rendered.
  expect(html).not.toContain('secret://');
});

it('draws the running sync, the resumed sync and the discarded redeliveries',()=>{
  const running=render({connectors:[connector() as never],state:'SYNCING'});
  expect(running).toContain('Initial sync running');
  const resumed=render({connectors:[connector() as never],lastSync:{
    syncRunId:'22222222-2222-4222-8222-222222222222',connectorId:'11111111-1111-4111-8111-111111111111',
    mode:'INCREMENTAL',resumedFromCursor:{position:'gmail:page-1',providerToken:'1'},
    newCursor:{position:'gmail:page-2',providerToken:'2'},pagesFetched:1,itemsIngested:0,duplicatesSuppressed:3,
    episodesAggregated:0,aggregatedEvents:0,threadUpdatesApplied:0,recurrenceUpdatesApplied:0,
    evidenceIds:[],refusals:[],
  } as never});
  expect(resumed).toContain('Resumed from the stored cursor gmail:page-1');
  expect(resumed).toContain('Redelivered items discarded as duplicates');
});

it('names a failed sync, a revoked token and a disconnected source in text',()=>{
  expect(render({connectors:[connector({status:'SYNC_FAILED',lastSyncError:'CONNECTOR_PROVIDER_UNAVAILABLE'}) as never]}))
    .toContain('Reason: CONNECTOR_PROVIDER_UNAVAILABLE');
  expect(render({connectors:[connector({status:'TOKEN_REVOKED',credentialHeld:false}) as never]}))
    .toContain('Reauthorization required');
  const disconnected=render({connectors:[connector({status:'DISCONNECTED',cursor:null,credentialHeld:false,
    disconnectedAt:'2026-09-15T09:00:00.000Z',grantedCapabilities:[]}) as never]});
  expect(disconnected).toContain('tokens revoked and ingestion stopped');
  // A disconnected source offers no sync button.
  expect(disconnected).not.toContain('Sync now');
});

it('draws one independent control per capability with its risk classification',()=>{
  const selected=connector();
  const html=render({connectors:[selected as never],selected:selected as never});
  expect(html).toContain('Grant connector capabilities');
  expect(html).toContain('Risk classification: LOW');
  expect(html).toContain('Risk classification: MEDIUM');
  // A partial grant: one capability granted, its sibling not, with its own control.
  expect(html).toContain('Revoke gmail.read_metadata');
  expect(html).toContain('Grant gmail.read_content');
  expect(html).toContain('Not granted');
  // The consent handoff requests read-only scopes only.
  expect(html).toContain('Consent requests read-only access');
  expect(html).toContain('gmail.metadata');
  expect(html).toContain('read-only');
});

it('shows a write capability as refused with the reason, and never as a toggle',()=>{
  const selected=connector({capabilities:[
    {capabilityId:'gmail.read_metadata',description:'Read message headers.',access:'READ',riskClass:'LOW',
      scopes:['https://www.googleapis.com/auth/gmail.metadata'],granted:true,grantedAt:'2026-09-01T10:00:00.000Z',revokedAt:null},
    {capabilityId:'gmail.create_draft',description:'Create a draft reply.',access:'WRITE',riskClass:'HIGH',
      scopes:['https://www.googleapis.com/auth/gmail.compose'],granted:false,grantedAt:null,revokedAt:null},
  ]});
  const html=render({connectors:[selected as never],selected:selected as never,
    refusal:{code:'CONNECTOR_WRITE_SCOPE_REFUSED',capabilityId:'gmail.send'}});
  expect(html).toContain('Uai V0 is read-only and refused it');
  expect(html).toContain('Capability: gmail.send.');
  expect(html).not.toContain('Grant gmail.create_draft');
  expect(html).toContain('Draft creation is governed separately');
});

it('draws the upload states: deferred, user-requested, triggered, failed and source-only',()=>{
  const base={evidence:null,connector:null,error:null,search:null};
  const receipt=(overrides:Record<string,unknown>)=>({
    evidenceId:'33333333-3333-4333-8333-333333333333',ingestionStatus:'STORED',indexed:true,indexedAnchors:2,
    searchable:true,extractionPlan:'DEFERRED',extractionPlanReason:'NO_FULL_EXTRACTION_TRIGGER',
    triageRoute:'DEFER_UNTIL_RELEVANT',extractionJobId:null,...overrides,
  });
  const empty=renderToStaticMarkup(createElement(Evidence,{...base,receipt:null} as never));
  expect(empty).toContain('type="file"');
  expect(empty).toContain('searchable as soon as it is stored');

  const deferred=renderToStaticMarkup(createElement(Evidence,{...base,receipt:receipt({})} as never));
  expect(deferred).toContain('2 page(s) indexed and searchable immediately');
  expect(deferred).toContain('Full extraction is deferred');
  expect(deferred).toContain('None queued');

  const requested=renderToStaticMarkup(createElement(Evidence,{...base,receipt:receipt({
    extractionPlan:'FULL',extractionPlanReason:'USER_REQUESTED',triageRoute:'FULL_EXTRACTION',
    extractionJobId:'44444444-4444-4444-8444-444444444444'})} as never));
  expect(requested).toContain('running because you asked for it');

  for(const [reason,text] of [['DEADLINE_BEARING','carries a deadline'],['HIGH_VALUE','high value'],
    ['ACTIVE_WORKFLOW_RELATED','open memory thread']] as const){
    expect(renderToStaticMarkup(createElement(Evidence,{...base,receipt:receipt({
      extractionPlan:'FULL',extractionPlanReason:reason})} as never))).toContain(text);
  }

  const failed=renderToStaticMarkup(createElement(Evidence,{...base,receipt:receipt({
    extractionPlan:'FULL',extractionPlanReason:'USER_REQUESTED'}),extractionFailed:true} as never));
  expect(failed).toContain('Extraction failed');
  expect(failed).toContain('stays retrievable and searchable');

  const unsupported=renderToStaticMarkup(createElement(Evidence,{...base,receipt:receipt({
    indexedAnchors:0,extractionPlanReason:'UNSUPPORTED_FORMAT_STORED_AS_SOURCE_ONLY',triageRoute:'SOURCE_ONLY'})} as never));
  expect(unsupported).toContain('stored as source-only evidence');
});

it('shows stored documents found by text before any extraction has run',()=>{
  const html=renderToStaticMarkup(createElement(Evidence,{evidence:null,connector:null,error:null,receipt:null,
    search:{query:'pgvector',hits:[{evidenceId:'33333333-3333-4333-8333-333333333333',documentId:'doc-1',
      title:null,page:1,excerpt:'Notes about the pgvector rollout',occurredAt:null,
      observedAt:'2026-09-14T08:00:00.000Z',extractionPlan:'DEFERRED'}]}} as never));
  expect(html).toContain('Search stored documents');
  expect(html).toContain('Notes about the pgvector rollout');
  expect(html).toContain('Meaning extraction: deferred');
  const none=renderToStaticMarkup(createElement(Evidence,{evidence:null,connector:null,error:null,receipt:null,
    search:{query:'nothing here',hits:[]}} as never));
  expect(none).toContain('No stored document matches that text');
});
