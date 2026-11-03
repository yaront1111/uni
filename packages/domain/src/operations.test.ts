import {expect,it} from 'vitest';
import * as domain from './index.js';

const ids=['backup','restore','deletion','registry-migration','projection-rebuild','connector-revocation'];
const HEAD='a'.repeat(40),C='c'.repeat(40),D='d'.repeat(40);
/** The example record of docs/operations/real-data-gates.md, Gate 2. */
function liveRecord(){return {
  format:'unai-live-connectors/1',recordedAt:'2026-11-02T12:00:00.000Z',recordedBy:'owner',command:'pnpm test',
  sourceCommit:HEAD,workspaceDigest:'e'.repeat(64),completedAt:'2026-11-02T11:59:00.000Z',exitCode:0,workspaceClean:true,revocationAllowed:false,
  cases:[
    {criterion:'CRT-CON-02-A',connector:'GMAIL',status:'passed',testName:'CRT-CON-02-A gmail live'},
    {criterion:'CRT-CON-03-A',connector:'GOOGLE_CALENDAR',status:'passed',testName:'CRT-CON-03-A calendar live'},
    {criterion:'CRT-CON-04-A',connector:'GITHUB',status:'passed',testName:'CRT-CON-04-A github live'},
    {criterion:'CRT-CON-06-A',connector:'GMAIL',status:'skipped',testName:'CRT-CON-06-A revocation live'},
    {criterion:'ADR-0041-LIVE-A',connector:'OMI',status:'passed',testName:'ADR-0041-LIVE-A omi live'},
  ],
  totals:{passed:4,failed:0,skipped:1},
};}
type LiveRecord=ReturnType<typeof liveRecord>;
function ready(){return {
  format:'unai-operations/1',checkedAt:'2026-09-19T15:00:00.000Z',sourceCommit:HEAD,workspaceClean:true,
  procedures:ids.map(id=>({id,title:id,body:'Reviewed procedure',execution:{executedAt:'2026-09-19T14:00:00.000Z',environment:'TEST',evidenceRef:'test-results/operations/execution.json',testNames:['actual rehearsal']}})),
  restore:{result:'PASS',emptyEnvironment:true,objectsRestored:true,keyRecoveryVerified:true,backupRef:'encrypted-backup-1',
    fixtures:Array.from({length:20},(_,i)=>({id:'AC44.'+String(i+1).padStart(2,'0'),sourceDigest:'b'.repeat(64),restoredDigest:'b'.repeat(64)}))},
  adr:{inventoryReviewedAt:'2026-09-19T14:00:00.000Z',initialPaths:['docs/adr/0001-reference-stack.md'],
    entries:[{path:'docs/adr/0001-reference-stack.md',title:'Reference stack',date:'2026-09-14'}],
    deviations:[{requirement:'PRD MUST example',adrPath:'docs/adr/0001-reference-stack.md',implementedAt:'2026-09-15T00:00:00.000Z'}]},
  defects:{reviewedAt:'2026-09-19T14:00:00.000Z',items:[]},
  ci:{branch:'main',defaultBranch:'main',commit:HEAD,runRef:'https://example.invalid/actions/runs/1',
    stages:['lint','unit','property','registry-lint','registry-contract','connector-integration','security','corpus','end-to-end'].map(name=>({name,result:'PASS'}))},
  localPolicy:{result:'PASS',dependencyAuditRef:'test-results/operations/dependencies.json',e2eRef:'test-results/acceptance/vitest.json'},
  realCorpus:{result:'PASS',failures:[] as string[]},
  liveConnectors:{recordRef:'docs/operations/live-connectors-2026-11-02.json' as string|null,record:liveRecord() as LiveRecord|null,failure:null as string|null},
  registryTags:{failure:null as string|null,tags:['0.1.0','0.2.0','0.3.0'].map(version=>({version,tag:'registry-v'+version,status:'PRESENT'}))},
  recordedCommits:[] as Array<{commit:string;relation:string}>,
};}
function evaluate(value:unknown){
  expect(domain).toHaveProperty('operationsReportSchema');
  expect(domain).toHaveProperty('evaluateV0Release');
  return domain.evaluateV0Release(domain.operationsReportSchema.parse(value));
}
function gate(value:unknown,criterion:string){
  const found=evaluate(value).find(entry=>entry.criterion===criterion);
  expect(found).toBeDefined();
  return found!.passed;
}
it('accepts a complete attested report and lists every assigned criterion',()=>{
  expect(evaluate(ready())).toEqual([
    {criterion:'CRT-NFR-03-A',passed:true},{criterion:'CRT-OPS-01-A',passed:true},
    {criterion:'CRT-OPS-02-A',passed:true},{criterion:'CRT-OPS-03-A',passed:true},
    {criterion:'CRT-QA-01-A',passed:true},{criterion:'CRT-WRT-03-C',passed:true},
    {criterion:'PRD-54.4-REAL-CORPUS',passed:true},{criterion:'PRD-54.1-LIVE-CONNECTORS',passed:true},
    {criterion:'PRD-54.3-REGISTRY-TAGS',passed:true},
  ]);
});
it('fails absent rehearsals and unreviewed inventories even with empty defect and deviation lists',()=>{
  const r=ready();Object.assign(r.procedures[0]!,{execution:null});
  Object.assign(r.adr,{inventoryReviewedAt:null,deviations:[]});Object.assign(r.defects,{reviewedAt:null});
  expect(evaluate(r).filter(x=>!x.passed).map(x=>x.criterion)).toEqual(['CRT-OPS-01-A','CRT-OPS-02-A','CRT-OPS-03-A']);
});
it('rejects missing, duplicate, mismatched and nonempty-target restore fixture evidence',()=>{
  for(const mutate of [
    (r:ReturnType<typeof ready>)=>r.restore.fixtures.pop(),
    (r:ReturnType<typeof ready>)=>{r.restore.fixtures[1]=r.restore.fixtures[0]!;},
    (r:ReturnType<typeof ready>)=>{r.restore.fixtures[0]!.restoredDigest='c'.repeat(64);},
    (r:ReturnType<typeof ready>)=>{r.restore.emptyEnvironment=false;},
    (r:ReturnType<typeof ready>)=>{r.restore.objectsRestored=false;},
    (r:ReturnType<typeof ready>)=>{r.restore.keyRecoveryVerified=false;},
  ]){const r=ready();mutate(r);expect(evaluate(r)[0]!.passed).toBe(false);}
});
it('blocks late or missing ADRs and open P0/P1 correctness or security defects',()=>{
  const r=ready();r.adr.deviations[0]!.implementedAt='2026-09-14T00:00:00.000Z';
  Object.assign(r.defects,{items:[{id:'D1',priority:'P1',category:'SECURITY',status:'OPEN',detail:'Known defect'}]});
  expect(evaluate(r).filter(x=>!x.passed).map(x=>x.criterion)).toEqual(['CRT-OPS-02-A','CRT-OPS-03-A']);
  r.adr.deviations[0]!.adrPath='docs/adr/missing.md';expect(evaluate(r)[2]!.passed).toBe(false);
});
it('blocks stale/non-default/missing stages and unverified local policy runs',()=>{
  const r=ready();r.ci.commit='c'.repeat(40);expect(evaluate(r)[4]!.passed).toBe(false);
  r.ci.commit=r.sourceCommit;r.ci.branch='topic';expect(evaluate(r)[4]!.passed).toBe(false);
  r.ci.branch='main';r.ci.stages.pop();expect(evaluate(r)[4]!.passed).toBe(false);
  Object.assign(r.localPolicy,{result:'UNVERIFIED'});expect(evaluate(r)[5]!.passed).toBe(false);
  const dirty=ready();dirty.workspaceClean=false;expect(evaluate(dirty)[4]!.passed).toBe(false);
});

// ADR 0044: a recorded commit other than HEAD counts only through a
// RECORDS_ONLY_ANCESTOR relation the gatherer recorded for that exact commit.
it('CRT-QA-01-A accepts a records-only ancestor of HEAD and nothing else',()=>{
  const at=(relations:Array<{commit:string;relation:string}>)=>{const r=ready();r.ci.commit=C;r.recordedCommits=relations;return gate(r,'CRT-QA-01-A');};
  expect(at([{commit:C,relation:'RECORDS_ONLY_ANCESTOR'}])).toBe(true);
  expect(at([])).toBe(false);
  for(const relation of ['OTHER_PATHS_CHANGED','NOT_ANCESTOR','UNVERIFIED','HEAD'])expect(at([{commit:C,relation}])).toBe(false);
  expect(at([{commit:D,relation:'RECORDS_ONLY_ANCESTOR'}])).toBe(false);
  expect(at([{commit:C,relation:'RECORDS_ONLY_ANCESTOR'},{commit:C,relation:'OTHER_PATHS_CHANGED'}])).toBe(false);
  const dirty=ready();dirty.ci.commit=C;dirty.recordedCommits=[{commit:C,relation:'RECORDS_ONLY_ANCESTOR'}];dirty.workspaceClean=false;
  expect(gate(dirty,'CRT-QA-01-A')).toBe(false);
});

const CORPUS='PRD-54.4-REAL-CORPUS';
it('PRD-54.4-REAL-CORPUS passes only a verified PASS that carries no failure code',()=>{
  expect(gate(ready(),CORPUS)).toBe(true);
  for(const realCorpus of [
    {result:'FAIL',failures:['REAL_RESULTS_MISSING']},{result:'FAIL',failures:['REAL_RESULTS_FAILED']},
    {result:'FAIL',failures:['REAL_RESULTS_THRESHOLDS_STALE']},{result:'UNVERIFIED',failures:['REAL_CORPUS_UNAVAILABLE']},
    {result:'PASS',failures:['REAL_RESULTS_INVALID']},{result:'FAIL',failures:[]},{result:'UNVERIFIED',failures:[]},
  ])expect(gate({...ready(),realCorpus},CORPUS)).toBe(false);
  expect(()=>evaluate({...ready(),realCorpus:{result:'FAIL',failures:['ENOENT: no such file']}})).toThrow();
  const {realCorpus:_,...missing}=ready();expect(()=>evaluate(missing)).toThrow();
});

const LIVE='PRD-54.1-LIVE-CONNECTORS';
function retotal(record:LiveRecord){
  const passed=record.cases.filter(c=>c.status==='passed').length,failed=record.cases.filter(c=>c.status==='failed').length;
  record.totals={passed,failed,skipped:record.cases.length-passed-failed};
}
/** Mutates the record, then recomputes totals so only the mutation decides. */
function live(mutate:(record:LiveRecord)=>void){const r=ready();mutate(r.liveConnectors.record!);retotal(r.liveConnectors.record!);return r;}
it('PRD-54.1-LIVE-CONNECTORS passes a complete owner record whose opt-in revocation case is skipped, passed or absent',()=>{
  expect(gate(ready(),LIVE)).toBe(true);
  expect(gate(live(record=>{record.cases[3]!.status='passed';}),LIVE)).toBe(true);
  expect(gate(live(record=>{record.cases=record.cases.filter(c=>c.criterion!=='CRT-CON-06-A');}),LIVE)).toBe(true);
  expect(gate(live(record=>{record.cases.push({criterion:'CRT-CON-07-A',connector:'OMI',status:'passed',testName:'omi live'});}),LIVE)).toBe(true);
});
it('PRD-54.1-LIVE-CONNECTORS requires the Omi case ADR-0041-LIVE-A, passed, under connector OMI',()=>{
  expect(gate(ready(),LIVE)).toBe(true);
  expect.soft(gate(live(record=>{record.cases=record.cases.filter(c=>c.connector!=='OMI');}),LIVE)).toBe(false);
  expect.soft(gate(live(record=>{record.cases[4]!.criterion='CRT-CON-07-A';}),LIVE)).toBe(false);
  expect.soft(gate(live(record=>{record.cases[4]!.connector='GMAIL';}),LIVE)).toBe(false);
  expect.soft(gate(live(record=>{record.cases[4]!.status='skipped';}),LIVE)).toBe(false);
});
it('fails a missing or invalid listing, and a failure code beside a record',()=>{
  for(const failure of ['LIVE_RECORD_MISSING','LIVE_RECORD_INVALID'])
    expect(gate({...ready(),liveConnectors:{recordRef:null,record:null,failure}},LIVE)).toBe(false);
  const coded=ready();coded.liveConnectors.failure='LIVE_RECORD_INVALID';expect(gate(coded,LIVE)).toBe(false);
  const empty=ready();empty.liveConnectors.record=null;expect(gate(empty,LIVE)).toBe(false);
});
it('fails a required case that is skipped, pending, failed or absent, a failed opt-in case and any other unpassed case',()=>{
  for(const index of [0,1,2,4])for(const status of ['skipped','pending','failed','todo'])
    expect(gate(live(record=>{record.cases[index]!.status=status;}),LIVE)).toBe(false);
  expect(gate(live(record=>{record.cases=record.cases.filter(c=>c.connector!=='GITHUB');}),LIVE)).toBe(false);
  expect(gate(live(record=>{record.cases[2]!.criterion='CRT-CON-05-A';}),LIVE)).toBe(false);
  expect(gate(live(record=>{record.cases[0]!.connector='GOOGLE_CALENDAR';}),LIVE)).toBe(false);
  expect(gate(live(record=>{record.cases[3]!.status='failed';}),LIVE)).toBe(false);
  expect(gate(live(record=>{record.cases.push({criterion:'CRT-CON-07-A',connector:'OMI',status:'skipped',testName:'omi live'});}),LIVE)).toBe(false);
  expect(gate(live(record=>{record.cases=[];}),LIVE)).toBe(false);
});
it('fails a nonzero exit, a dirty workspace and totals that do not match the cases',()=>{
  expect(gate(live(record=>{record.exitCode=1;}),LIVE)).toBe(false);
  expect(gate(live(record=>{record.workspaceClean=false;}),LIVE)).toBe(false);
  for(const totals of [{passed:5,failed:0,skipped:1},{passed:4,failed:1,skipped:1},{passed:4,failed:0,skipped:0},{passed:5,failed:0,skipped:0}]){
    const r=ready();r.liveConnectors.record!.totals=totals;expect(gate(r,LIVE)).toBe(false);
  }
});
it('fails a record whose source commit is neither HEAD nor a records-only ancestor recorded for it',()=>{
  const at=(relations:Array<{commit:string;relation:string}>)=>{const r=live(record=>{record.sourceCommit=C;});r.recordedCommits=relations;return gate(r,LIVE);};
  expect(at([{commit:C,relation:'RECORDS_ONLY_ANCESTOR'}])).toBe(true);
  expect(at([])).toBe(false);
  for(const relation of ['OTHER_PATHS_CHANGED','NOT_ANCESTOR','UNVERIFIED','HEAD'])expect(at([{commit:C,relation}])).toBe(false);
  expect(at([{commit:D,relation:'RECORDS_ONLY_ANCESTOR'}])).toBe(false);
});
it('refuses a live record with an unknown key, another format, a non-owner recorder, another command or an unknown connector',()=>{
  for(const change of [{extra:true},{format:'unai-live-connectors/2'},{recordedBy:'agent'},{command:'pnpm test --run'},
    {recordedAt:'2026-11-02T14:00:00+02:00'},{sourceCommit:'HEAD'},{exitCode:0.5}]){
    const r=ready();r.liveConnectors.record={...r.liveConnectors.record!,...change} as LiveRecord;
    expect(()=>evaluate(r)).toThrow();
  }
  const unknown=live(record=>{record.cases[0]!.connector='SLACK';});expect(()=>evaluate(unknown)).toThrow();
  const extraCase=ready();Object.assign(extraCase.liveConnectors.record!.cases[0]!,{account:'owner@example.invalid'});expect(()=>evaluate(extraCase)).toThrow();
  expect(()=>evaluate({...ready(),liveConnectors:{...ready().liveConnectors,extra:1}})).toThrow();
});

const TAGS='PRD-54.3-REGISTRY-TAGS';
it('PRD-54.3-REGISTRY-TAGS passes only when every recorded version is PRESENT',()=>{
  expect(gate(ready(),TAGS)).toBe(true);
  for(const status of ['MISSING','MISMATCH']){const r=ready();r.registryTags.tags[1]!.status=status;expect(gate(r,TAGS)).toBe(false);}
  const empty=ready();empty.registryTags.tags=[];expect(gate(empty,TAGS)).toBe(false);
  const shallow=ready();shallow.registryTags={failure:'REGISTRY_HISTORY_SHALLOW',tags:[]};expect(gate(shallow,TAGS)).toBe(false);
  const coded=ready();coded.registryTags.failure='REGISTRY_TAGS_UNAVAILABLE';expect(gate(coded,TAGS)).toBe(false);
  const unknown=ready();unknown.registryTags.tags[0]!.status='UNKNOWN';expect(()=>evaluate(unknown)).toThrow();
});
