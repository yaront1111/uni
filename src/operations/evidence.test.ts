import {recoveryEvidence} from './evidence.js';
import {afterEach,it,expect} from 'vitest';
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {evaluateV0Release,operationsReportSchema,type OperationsReport} from '../../packages/domain/src/index.js';
import * as evidence from './evidence.js';
it('refuses a skipped, absent or failed procedure case and records a passed case by exact file',()=>{
  expect(evidence).toHaveProperty('procedureExecution');
  const file='packages/api/src/control.test.ts',name='[AC44.18] deletion';
  const report=(status:string)=>({testResults:[{name:file,assertionResults:[{fullName:name,status}]}]});
  for(const status of ['skipped','pending','failed','todo'])expect(evidence.procedureExecution('deletion',report(status),'2026-09-19T15:00:00.000Z')).toBeNull();
  expect(evidence.procedureExecution('deletion',{testResults:[]},'2026-09-19T15:00:00.000Z')).toBeNull();
  expect(evidence.procedureExecution('deletion',report('passed'),'2026-09-19T15:00:00.000Z')?.testNames).toEqual([name]);
});
it('requires every local end-to-end file to have only passed cases',()=>{
  const files=['apps/web/e2e/ask.test.ts','apps/web/e2e/memory.test.ts','packages/api/src/answers.test.ts','packages/api/src/today.test.ts'];
  const report={testResults:files.map(name=>({name,assertionResults:[{fullName:'behavior',status:'passed'}]}))};
  expect(evidence.localEndToEndPassed(report)).toBe(true);
  report.testResults[0]!.assertionResults[0]!.status='skipped';expect(evidence.localEndToEndPassed(report)).toBe(false);
  report.testResults.shift();expect(evidence.localEndToEndPassed(report)).toBe(false);
});

it('accepts only a complete coordinated recovery receipt and rejects database-only evidence',()=>{
  const valid={format:'unai-coordinated-roundtrip/2',archiveFormat:'uai-backup/1',result:'PASS',executedAt:'2026-09-19T12:00:00.000Z',emptyTarget:true,
    archiveRef:'test-results/operations/coordinated-backup.tar.enc',archiveDigest:'a'.repeat(64),objectsRestored:1,
    keyRecoveryVerified:true,wrongKeyRefused:true,tamperRefused:true,acceptanceAnswersRegenerated:true,
    fixtures:Array.from({length:20},(_,i)=>({id:'AC44.'+String(i+1).padStart(2,'0'),sourceDigest:'b'.repeat(64),restoredDigest:'b'.repeat(64)}))};
  expect(recoveryEvidence(valid)?.restore.result).toBe('PASS');
  for(const change of [{objectsRestored:0},{emptyTarget:false},{keyRecoveryVerified:false},{acceptanceAnswersRegenerated:false},
    {format:'unai-coordinated-roundtrip/1'},{archiveFormat:'uai-backup/2'},{wrongKeyRefused:false},{tamperRefused:false},
    {fixtures:valid.fixtures.slice(1)},{fixtures:[...valid.fixtures.slice(1),valid.fixtures[1]]},
    {fixtures:valid.fixtures.map((f,i)=>i?f:{...f,restoredDigest:'c'.repeat(64)})}])
    expect(recoveryEvidence({...valid,...change})).toBeNull();
  for(const field of ['archiveFormat','wrongKeyRefused','tamperRefused'] as const){
    const {[field]:_,...missing}=valid;expect(recoveryEvidence(missing)).toBeNull();
  }
  expect(recoveryEvidence({format:'unai-database-roundtrip/1',result:'PASS'})).toBeNull();
});


// ADR 0044 commit rule and the live-connector reader, over throwaway Git
// repositories only: nothing here reads or writes the checkout's history.
const directories:string[]=[];
afterEach(async()=>{await Promise.all(directories.splice(0).map(path=>rm(path,{recursive:true,force:true})));});
const LIVE_PATH='docs/operations/live-connectors-2026-11-02.json';
const STAGES=['lint','unit','property','registry-lint','registry-contract','connector-integration','security','corpus','end-to-end'];
/** Without GIT_* variables, a GIT_DIR inherited from a hook can never point the fixture at the checkout. */
function isolated(){const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('GIT_'))delete env[key];return env;}
function git(repository:string,...args:string[]){
  const result=spawnSync('git',['-c','core.autocrlf=false','-c','commit.gpgsign=false','-c','init.defaultBranch=main',
    '-c','user.name=Operations Test','-c','user.email=operations@test.invalid',...args],{cwd:repository,encoding:'utf8',env:isolated()});
  if(result.status!==0)throw new Error('fixture git '+args[0]+' failed: '+result.stderr);
  return result.stdout.trim();
}
const commitAll=(repository:string,message:string)=>{git(repository,'add','-A');git(repository,'commit','--quiet','--no-verify','-m',message);return git(repository,'rev-parse','HEAD');};
async function put(repository:string,path:string,text:string){await mkdir(dirname(join(repository,path)),{recursive:true});await writeFile(join(repository,path),text);}
function liveRecord(sourceCommit:string){return {
  format:'unai-live-connectors/1',recordedAt:'2026-11-02T12:00:00.000Z',recordedBy:'owner',command:'pnpm test',sourceCommit,
  workspaceDigest:'e'.repeat(64),completedAt:'2026-11-02T11:59:00.000Z',exitCode:0,workspaceClean:true,revocationAllowed:false,
  cases:[{criterion:'CRT-CON-02-A',connector:'GMAIL',status:'passed',testName:'gmail live'},
    {criterion:'CRT-CON-03-A',connector:'GOOGLE_CALENDAR',status:'passed',testName:'calendar live'},
    {criterion:'CRT-CON-04-A',connector:'GITHUB',status:'passed',testName:'github live'},
    {criterion:'CRT-CON-06-A',connector:'GMAIL',status:'skipped',testName:'revocation live'},
    {criterion:'ADR-0041-LIVE-A',connector:'OMI',status:'passed',testName:'omi live'}],
  totals:{passed:4,failed:0,skipped:1}};}
/** C1 holds code and the release input; C2 changes and adds only release records. */
async function fixture(){
  const repository=await mkdtemp(join(tmpdir(),'unai-operations-evidence-'));directories.push(repository);
  git(repository,'init','--quiet');
  await put(repository,'src/app.ts','export const app=1;\n');
  await put(repository,'docs/operations/release-input.json','{}\n');
  const C1=commitAll(repository,'C1: code');
  await put(repository,'docs/operations/release-input.json',JSON.stringify({liveConnectorRecords:[LIVE_PATH]})+'\n');
  await put(repository,'docs/operations/real-data-gates.md','# Real-data gates\n');
  await put(repository,LIVE_PATH,JSON.stringify(liveRecord(C1))+'\n');
  await put(repository,'corpus/expected/real-corpus-results.json','{}\n');
  const C2=commitAll(repository,'C2: release records');
  return {repository,C1,C2};
}
function report(head:string,ciCommit:string,recordedCommits:unknown,options:{liveConnectors?:unknown;stages?:unknown}={}){
  return operationsReportSchema.parse({format:'unai-operations/1',checkedAt:'2026-11-02T12:00:00.000Z',sourceCommit:head,workspaceClean:true,
    procedures:[],restore:{result:'UNVERIFIED',emptyEnvironment:false,objectsRestored:false,keyRecoveryVerified:false,backupRef:null,fixtures:[]},
    adr:{inventoryReviewedAt:null,initialPaths:['docs/adr/0001-reference-stack.md'],entries:[],deviations:[]},defects:{reviewedAt:null,items:[]},
    ci:{branch:'main',defaultBranch:'main',commit:ciCommit,runRef:'https://example.invalid/actions/runs/1',
      stages:options.stages??STAGES.map(name=>({name,result:'PASS'}))},
    localPolicy:{result:'UNVERIFIED',dependencyAuditRef:null,e2eRef:null},realCorpus:{result:'FAIL',failures:['REAL_RESULTS_MISSING']},
    liveConnectors:options.liveConnectors??{recordRef:null,record:null,failure:'LIVE_RECORD_MISSING'},registryTags:{failure:null,tags:[]},recordedCommits});
}
const gate=(value:OperationsReport,criterion:string)=>evaluateV0Release(value).find(entry=>entry.criterion===criterion)!.passed;
/** What report.ts does for ci.commit at a given HEAD. */
const qa=(repository:string,head:string,ciCommit:string,options:{stages?:unknown}={})=>
  gate(report(head,ciCommit,evidence.recordCommitEvidence(repository,head,[ciCommit]),options),'CRT-QA-01-A');

it('classifies exactly the four ADR 0044 release-record paths',()=>{
  for(const path of ['docs/operations/release-input.json','docs/operations/real-data-gates.md','corpus/expected/real-corpus-results.json',
    LIVE_PATH,'docs/operations/live-connectors-a.b_c-1.json'])expect(evidence.isReleaseRecordPath(path)).toBe(true);
  for(const path of ['src/app.ts','docs/operations/README.md','docs/operations/live-connectors-.json','docs/operations/live-connectors-a/b.json',
    'docs/operations/live-connectors-'+'x'.repeat(101)+'.json','./docs/operations/release-input.json','docs/operations/release-input.json.bak',
    'corpus/expected/identity-thresholds.json','docs/operations/live-connectors-1.json/x'])expect(evidence.isReleaseRecordPath(path)).toBe(false);
});
it('CRT-QA-01-A passes at HEAD and at a records-only ancestor of HEAD',async()=>{
  const {repository,C1,C2}=await fixture();
  expect(evidence.commitRelation(repository,C2,C2)).toBe('HEAD');
  expect(qa(repository,C2,C2)).toBe(true);
  expect(evidence.commitRelation(repository,C1,C2)).toBe('RECORDS_ONLY_ANCESTOR');
  expect(qa(repository,C2,C1)).toBe(true);
});
it('CRT-QA-01-A fails once a code path changes, for a non-ancestor and for a code file renamed or re-moded',async()=>{
  const {repository,C1,C2}=await fixture();
  const side=git(repository,'commit-tree',C1+'^{tree}','-p',C1,'-m','side');
  expect(evidence.commitRelation(repository,side,C2)).toBe('NOT_ANCESTOR');
  expect(qa(repository,C2,side)).toBe(false);
  await put(repository,'src/app.ts','export const app=2;\n');
  const C3=commitAll(repository,'C3: code edit');
  expect(evidence.commitRelation(repository,C1,C3)).toBe('OTHER_PATHS_CHANGED');
  expect(qa(repository,C3,C1)).toBe(false);
  git(repository,'reset','--quiet','--hard',C2);
  git(repository,'mv','src/app.ts','docs/operations/live-connectors-moved.json');
  const C4=commitAll(repository,'C4: code moved into a record path');
  expect(evidence.commitRelation(repository,C2,C4)).toBe('OTHER_PATHS_CHANGED');
  git(repository,'reset','--quiet','--hard',C2);
  git(repository,'update-index','--chmod=+x','src/app.ts');
  git(repository,'commit','--quiet','--no-verify','-m','C5: mode only');
  const C5=git(repository,'rev-parse','HEAD');
  expect(evidence.commitRelation(repository,C2,C5)).toBe('OTHER_PATHS_CHANGED');
  expect(qa(repository,C5,C2)).toBe(false);
});
it('records an absent, non-hex or option-like commit as unverified and never hands it to Git',async()=>{
  const {repository,C1,C2}=await fixture();
  const absent='f'.repeat(40);
  expect(evidence.commitRelation(repository,absent,C2)).toBe('UNVERIFIED');
  expect(qa(repository,C2,absent)).toBe(false);
  for(const value of ['--output=x','HEAD',C1.toUpperCase(),C1.slice(0,39),C1+'\n'])expect(evidence.commitRelation(repository,value,C2)).toBe('UNVERIFIED');
  expect(evidence.commitRelation(repository,C1,'HEAD')).toBe('UNVERIFIED');
  expect(existsSync(join(repository,'x'))).toBe(false);
  expect(evidence.recordCommitEvidence(repository,C2,['--output=x',undefined,null,7,C1,C1])).toEqual([{commit:C1,relation:'RECORDS_ONLY_ANCESTOR'}]);
  expect(evidence.commitRelation(join(repository,'missing'),C1,C2)).toBe('UNVERIFIED');
});
it('CRT-QA-01-A at an accepted ancestor still fails a missing or failed stage',async()=>{
  const {repository,C1,C2}=await fixture();
  expect(qa(repository,C2,C1,{stages:STAGES.slice(1).map(name=>({name,result:'PASS'}))})).toBe(false);
  expect(qa(repository,C2,C1,{stages:STAGES.map(name=>({name,result:name==='security'?'FAIL':'PASS'}))})).toBe(false);
});
it('PRD-54.1-LIVE-CONNECTORS passes a records-only ancestor record and fails once a code commit follows',async()=>{
  const {repository,C1,C2}=await fixture();
  const liveConnectors=await evidence.readLiveConnectorRecord(repository,[LIVE_PATH]);
  expect(liveConnectors).toMatchObject({recordRef:LIVE_PATH,failure:null,record:{sourceCommit:C1}});
  const at=(head:string)=>gate(report(head,head,evidence.recordCommitEvidence(repository,head,[head,liveConnectors.record?.sourceCommit]),{liveConnectors}),
    'PRD-54.1-LIVE-CONNECTORS');
  expect(at(C2)).toBe(true);
  await put(repository,'src/app.ts','export const app=3;\n');
  expect(at(commitAll(repository,'C3: code after the live run'))).toBe(false);
});
it('answers LIVE_RECORD_MISSING or LIVE_RECORD_INVALID for every missing or malformed listing, path, file and record',async()=>{
  const {repository,C1}=await fixture();
  const read=(listed:unknown)=>evidence.readLiveConnectorRecord(repository,listed);
  const refused=(recordRef:string|null,failure:string)=>({recordRef,record:null,failure});
  for(const listed of [undefined,null,[]])expect(await read(listed)).toEqual(refused(null,'LIVE_RECORD_MISSING'));
  for(const listed of ['x',[1],[LIVE_PATH,2],{0:LIVE_PATH},LIVE_PATH])expect(await read(listed)).toEqual(refused(null,'LIVE_RECORD_INVALID'));
  for(const path of ['../release-input.json','docs/operations/other.json','/etc/passwd','docs/operations/live-connectors-x.json/'])
    expect(await read([path])).toEqual(refused(null,'LIVE_RECORD_INVALID'));
  const absent='docs/operations/live-connectors-absent.json';
  expect(await read([absent])).toEqual(refused(absent,'LIVE_RECORD_MISSING'));
  const bad='docs/operations/live-connectors-bad.json',extra='docs/operations/live-connectors-extra.json',folder='docs/operations/live-connectors-folder.json';
  await put(repository,bad,'{"format": "unai-live-connectors/1", "token": "secret-value"');
  await put(repository,extra,JSON.stringify({...liveRecord(C1),account:'secret-value'}));
  await mkdir(join(repository,folder));
  for(const path of [bad,extra,folder]){
    const result=await read([path]);
    expect(result).toEqual(refused(path,'LIVE_RECORD_INVALID'));
    expect(JSON.stringify(result)).not.toContain('secret-value');
  }
  expect((await read([bad,LIVE_PATH])).record?.sourceCommit).toBe(C1);
  expect(await read([LIVE_PATH,absent])).toEqual(refused(absent,'LIVE_RECORD_MISSING'));
});
