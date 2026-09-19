import { expect,it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CorpusResults,CorpusStatus } from '@unai/domain';
import * as screen from './Corpus';

const rule=(ruleId:CorpusResults['rules'][number]['ruleId'],ruleVersion:string,falseSplitRate:number)=>({ruleId,ruleVersion,observations:25,
  pairsCompared:300,predictedSamePairs:20,goldSamePairs:26,falseMergePairs:0,falseSplitPairs:6,falseMergeRate:0,falseSplitRate,
  meetsThresholds:true,failures:[]});
const results=(corpusKind:'REAL'|'SYNTHETIC',threadCount:number):CorpusResults=>({format:'unai-corpus-results/1',corpusKind,threadCount,
  annotationDigest:'a'.repeat(64),thresholdsVersion:'identity-thresholds-1',registryRelease:'0.1.0',scoredAt:'2026-09-19T08:00:00.000Z',
  rules:[rule('entity.strong_alias_exact','entity-resolver-1',0.239),rule('frame_instance.confirmed_match','instance-matcher-0.1.0',0.142),
    rule('belief_slot.descriptor_identity','normalization-1',0),rule('proposition.normalized_value_identity','normalization-1',0)],
  coverage:{sourceSpans:60,entities:12,frameInstances:11,slots:21,propositions:22,commitments:5,resolutions:5,nonMemoryItems:11},
  pipelineChecks:{spanIntegrity:{checked:100,failed:0},tier0Import:{checked:12,failed:0},commitmentLanguage:{checked:5,failed:0},
    resolutionTransitions:{checked:5,failed:0},nonMemoryItems:{checked:11,failed:0}},result:'PASS',failures:[]});
const threshold={maxFalseMergeRate:0,maxFalseSplitRate:0.5,minObservations:20};
const base:CorpusStatus={format:'unai-corpus-status/1',checkedAt:'2026-09-19T08:00:00.000Z',
  privatePath:{location:'REPOSITORY_LOCAL',gitignored:true,precommitBlockInstalled:true,trackedFiles:0},
  realThreads:{imported:0,annotated:0},syntheticThreads:{annotated:12},
  labelCoverage:{
    real:{threads:0,items:{sourceSpans:0,entities:0,frameInstances:0,slots:0,propositions:0,commitments:0,resolutions:0,nonMemoryItems:0},
      threadsMissing:{sourceSpans:0,entities:0,frameInstances:0,slots:0,propositions:0,commitments:0,resolutions:0,nonMemoryItems:0}},
    synthetic:{threads:12,items:{sourceSpans:60,entities:12,frameInstances:11,slots:21,propositions:22,commitments:5,resolutions:5,nonMemoryItems:11},
      threadsMissing:{sourceSpans:0,entities:0,frameInstances:1,slots:3,propositions:3,commitments:7,resolutions:7,nonMemoryItems:4}}},
  thresholds:{format:'unai-identity-thresholds/1',version:'identity-thresholds-1',minimumRealThreads:10,
    rules:{'entity.strong_alias_exact':threshold,'frame_instance.confirmed_match':threshold,
      'belief_slot.descriptor_identity':threshold,'proposition.normalized_value_identity':threshold}},
  synthetic:results('SYNTHETIC',12),real:null,verification:{result:'FAIL',failures:['REAL_RESULTS_MISSING']}};
const render=(props:Partial<screen.CorpusProps>)=>renderToStaticMarkup(createElement(screen.Corpus,{status:null,...props}));

it('renders the private corpus path as local, gitignored and protected by the commit block',()=>{
  const html=render({status:base});
  expect(html).toContain('Corpus and evaluation');
  expect(html).toContain('Local to the repository, never committed');
  expect(html).toContain('Gitignored</dt><dd>Yes');
  expect(html).toContain('a commit adding a file under the private corpus path is refused');
  expect(html).toContain('Skip to content');
});

it('renders the annotation categories, the committed synthetic equivalents and the thresholds recorded in CI',()=>{
  const html=render({status:base});
  for(const label of ['Source spans','Entities','Frame instances','Slots','Propositions','Commitments','Resolutions',
    'Unknowns and non-memory items'])expect(html).toContain(label);
  expect(html).toContain('uai corpus annotate');
  expect(html).toContain('12 labelled threads, committed');
  expect(html).toContain('Recorded in CI as identity-thresholds-1');
  expect(html).toContain('Synthetic results alone never approve a keying rule');
});

it('says annotation is done locally through the CLI, shows the commands and per-category coverage from the report',()=>{
  const html=render({status:{...base,realThreads:{imported:3,annotated:1},labelCoverage:{...base.labelCoverage,
    real:{threads:3,items:{...base.labelCoverage.synthetic.items,commitments:0},
      threadsMissing:{sourceSpans:0,entities:2,frameInstances:2,slots:2,propositions:2,commitments:3,resolutions:2,nonMemoryItems:2}}}}});
  expect(html).toContain('Annotation is done locally, on the machine that holds the private corpus, through the command line.');
  expect(html).toContain('This screen does not edit labels');
  expect(html).toContain('pnpm uai corpus import --source &lt;export.json&gt;');
  expect(html).toContain('pnpm uai corpus annotate --thread &lt;ref&gt;');
  expect(html).toContain('pnpm uai corpus status --report');
  expect(html).toMatch(/<th scope="row">Commitments<\/th><td>0<\/td><td>3 of 3<\/td><td>5<\/td><td>7 of 12<\/td>/);
  expect(html).not.toMatch(/<textarea|<input|contenteditable/);
});

it('renders a missing real corpus as incomplete evaluation, never as approval',()=>{
  const html=render({status:base});
  expect(html).toContain('0 imported, 0 labelled');
  expect(html).toContain('Real-corpus evaluation is incomplete');
  expect(html).toContain('No real-corpus results are recorded.');
});

it('renders ten or more labelled real threads and per-keying-rule real-corpus results',()=>{
  const html=render({status:{...base,realThreads:{imported:11,annotated:11},real:results('REAL',11),
    verification:{result:'PASS',failures:[]}}});
  expect(html).toContain('11 imported, 11 labelled');
  expect(html).toContain('Every production keying rule is evaluated on 11 real threads, not only on synthetic tests.');
  for(const label of ['Entity: exact strong-alias match only','Frame instance: confirmed match only','Belief slot: descriptor identity',
    'Proposition: normalized value identity'])expect(html).toContain(label);
  expect(html).toContain('23.9 %');
});

it('renders a missing commit block and the no-report and error states',()=>{
  expect(render({status:{...base,privatePath:{...base.privatePath,precommitBlockInstalled:false}}})).toContain('run pnpm hooks:install');
  expect(render({})).toContain('No corpus status is available to this deployment');
  expect(render({error:'The corpus status report could not be read.'})).toContain('role="alert"');
});
