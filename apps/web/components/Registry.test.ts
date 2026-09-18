import { expect,it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { LoadedRegistryRelease,PublicRegistryContract,RegistryLintReport } from '@unai/domain';
import * as screen from './Registry';

const release:LoadedRegistryRelease={id:'0192f3a0-0000-7000-8000-00000000c001',semanticVersion:'0.1.0',
  gitTag:'registry-v0.1.0',gitCommit:'a'.repeat(40),contentHash:'6fec376b01ada0e5384374de58661b62ddf8816f797566dcd2b0be5e7218f6d5',
  lifecycle:'RELEASED',releasedAt:'2026-09-16T10:00:00.000Z'};
const contracts:PublicRegistryContract[]=['shared.obligation','shared.commitment','shared.event_occurrence','finance.payment_allocation']
  .map(contractId=>({contractId,contractKind:'FRAME' as const,contractVersion:'0.1.0',contentHash:'b'.repeat(64)}));
const failure=(issues:RegistryLintReport['issues']):RegistryLintReport=>
  ({result:'FAIL',checkedAt:'2026-09-18T09:00:00.000Z',code:'REGISTRY_LINT_FAILED',releases:[],issues});
function render(props:Partial<screen.RegistryProps>){
  return renderToStaticMarkup(createElement(screen.Registry,{release:null,contracts:[],...props}));
}

it('renders the loaded release read-only with its Git tag and content hash',()=>{
  const html=render({release,contracts});
  expect(html).toContain('Registry release and migration');
  expect(html).toContain('registry-v0.1.0');
  expect(html).toContain(release.contentHash);
  expect(html).toContain('Read-only');
  expect(html).toContain('no registry service endpoint anywhere in it');
  for(const contract of contracts)expect(html).toContain(contract.contractId);
  expect(html).toContain('Skip to content');
  // A read-only view offers no control that would load, lint or publish a release.
  expect(html).not.toMatch(/<button|<form|<input/);
});

it('renders the deployment with no release materialized',()=>{
  const html=render({});
  expect(html).toContain('No registry release is loaded in this deployment');
  expect(html).toContain('uai registry publish');
});

it('renders a lint failure on a contract missing a required frame or predicate field',()=>{
  const html=render({release,contracts,lint:failure([
    {code:'REGISTRY_FIELD_REQUIRED',contract:'shared.commitment.yaml',path:'mergePolicy'},
    {code:'REGISTRY_FIELD_REQUIRED',contract:'shared.obligation.yaml',path:'predicates.0.conflictBehavior'}])});
  expect(html).toContain('Lint failed');
  expect(html).toContain('Required contract field missing');
  expect(html).toContain('shared.commitment.yaml');
  expect(html).toContain('predicates.0.conflictBehavior');
  expect(html).toContain('the loaded release above is unchanged');
});

it('renders a lint failure on an outcome status predicate and on a rejected cardinality',()=>{
  const html=render({lint:failure([
    {code:'OUTCOME_STATUS_PREDICATE_FORBIDDEN',contract:'shared.commitment.yaml',path:'predicates.3.id'},
    {code:'REGISTRY_CARDINALITY_INVALID',contract:'shared.obligation.yaml',path:'predicates.1.cardinality'}])});
  expect(html).toContain('Outcome status predicate: outcome state belongs to resolution assertions');
  expect(html).toContain('Cardinality outside FUNCTIONAL, SET and EVENT');
  expect(html).toContain('OUTCOME_STATUS_PREDICATE_FORBIDDEN');
});

it('renders a load refused because the content hash differs from the recorded hash',()=>{
  const html=render({lint:{result:'FAIL',checkedAt:'2026-09-18T09:00:00.000Z',
    code:'REGISTRY_CONTENT_HASH_MISMATCH',releases:[],issues:[]}});
  expect(html).toContain('content hash differs from the hash recorded for that version');
});

it('states that lint runs in the CLI when no report is available, and reports a read failure',()=>{
  expect(render({release,contracts})).toContain('No lint report is available to this deployment');
  expect(render({lint:{result:'PASS',checkedAt:'2026-09-18T09:00:00.000Z',code:null,
    releases:[{version:'0.1.0',tag:'registry-v0.1.0',contentHash:'c'.repeat(64),contracts:8}],issues:[]}}))
    .toContain('Lint passed for 0.1.0');
  expect(render({error:'The loaded release could not be read. Please reload to retry.'}))
    .toContain('The loaded release could not be read');
});
