import {createHash} from 'node:crypto';
import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {RUNBOOK_IDS,operationsReportSchema,evaluateV0Release} from '../../packages/domain/src/index.js';
import {procedureExecution,localEndToEndPassed,recoveryEvidence,readLiveConnectorRecord,recordCommitEvidence,type TestReport} from './evidence.js';
// The test harness is plain JavaScript and shares this exact source fingerprint.
// @ts-expect-error JavaScript harness module has no declaration file.
import {workspaceEvidence} from '../../scripts/workspace-evidence.mjs';

const json=async(path:string)=>JSON.parse(await readFile(path,'utf8'));
/** A registry refusal keeps its own stable code; anything else becomes the fallback. Never error text. */
const codeOf=(error:unknown,fallback:string)=>error instanceof Error&&error.name==='RegistryError'
  &&/^[A-Z][A-Z0-9_]{0,63}$/.test(error.message)?error.message:fallback;
/** Owner-run gates (ADR 0044). The registry modules load inside try, so even a load failure is only a code. */
async function ownerGates(inputs:{liveConnectorRecords?:unknown;ci?:{commit?:unknown}|null},head:string){
  let realCorpus:{result:'PASS'|'FAIL'|'UNVERIFIED';failures:string[]};
  try{
    const {verifyRealCorpusResults}=await import('../../packages/registry/src/corpus.js');
    const verified=await verifyRealCorpusResults('.');realCorpus={result:verified.result,failures:verified.failures};
  }catch(error){realCorpus={result:'UNVERIFIED',failures:[codeOf(error,'REAL_CORPUS_UNAVAILABLE')]};}
  let registryTags:{failure:string|null;tags:Array<{version:string;tag:string;status:string}>};
  try{
    const {inspectReleaseTags}=await import('../../packages/registry/src/tags.js');
    registryTags={failure:null,tags:(await inspectReleaseTags('.')).map(({version,tag,status})=>({version,tag,status}))};
  }catch(error){registryTags={failure:codeOf(error,'REGISTRY_TAGS_UNAVAILABLE'),tags:[]};}
  const liveConnectors=await readLiveConnectorRecord('.',inputs.liveConnectorRecords);
  const recordedCommits=recordCommitEvidence('.',head,[inputs.ci?.commit,liveConnectors.record?.sourceCommit]);
  return {realCorpus,liveConnectors,registryTags,recordedCommits};
}
async function main(){
  if(process.argv.slice(2).some(arg=>arg!=='--check')||process.argv.slice(2).length>1)throw new Error('ARGUMENTS_INVALID');
  const current=await workspaceEvidence() as {sourceCommit:string;workspaceDigest:string};
  const status=spawnSync('git',['status','--porcelain'],{encoding:'utf8'});
  if(status.status!==0)throw new Error('WORKSPACE_STATUS_UNAVAILABLE');
  const inputs=await json('docs/operations/release-input.json');
  let tests:TestReport={testResults:[]},completedAt='';let suiteVerified=false;
  try{
    const provenance=await json('test-results/acceptance/vitest.json.provenance.json');
    if(provenance.sourceCommit===current.sourceCommit&&provenance.workspaceDigest===current.workspaceDigest&&provenance.exitCode===0){
      tests=await json('test-results/acceptance/vitest.json');completedAt=provenance.completedAt;suiteVerified=true;
    }
  }catch{/* Missing evidence remains unverified. */}
  let policyVerified=false;
  try{
    const audit=await json('test-results/operations/dependencies.json');
    policyVerified=audit.sourceCommit===current.sourceCommit&&audit.workspaceDigest===current.workspaceDigest&&audit.result==='PASS'
      &&suiteVerified&&localEndToEndPassed(tests);
  }catch{/* Missing evidence remains unverified. */}
  let recovery:ReturnType<typeof recoveryEvidence>=null;
  if(suiteVerified){
    try{
      const receipt=await json('test-results/operations/coordinated-roundtrip.json');
      if(receipt.sourceCommit===current.sourceCommit&&receipt.workspaceDigest===current.workspaceDigest&&receipt.archiveRef==='test-results/operations/coordinated-backup.tar.enc'
        &&createHash('sha256').update(await readFile(receipt.archiveRef)).digest('hex')===receipt.archiveDigest
        &&Date.parse(receipt.executedAt)<=Date.parse(completedAt))recovery=recoveryEvidence(receipt);
    }catch{/* Missing or corrupt archive remains unverified. */}
  }
  const entries=[];
  for(const file of (await readdir('docs/adr')).filter(f=>f.endsWith('.md')).sort()){
    const body=await readFile('docs/adr/'+file,'utf8');const date=body.match(/^Date:\s*(\d{4}-\d{2}-\d{2})/m)?.[1];
    if(date)entries.push({path:'docs/adr/'+file,title:body.split('\n')[0]!.replace(/^#\s*/,''),date});
  }
  const report=operationsReportSchema.parse({
    format:'unai-operations/1',checkedAt:new Date().toISOString(),sourceCommit:current.sourceCommit,workspaceClean:status.stdout.trim()==='',
    procedures:await Promise.all(RUNBOOK_IDS.map(async id=>({id,title:id.replaceAll('-',' '),body:await readFile('docs/operations/'+id+'.md','utf8'),
      execution:suiteVerified?((id==='backup'||id==='restore')?recovery?.execution??null:procedureExecution(id,tests,completedAt)):null}))),
    restore:recovery?.restore??inputs.restore,
    adr:{inventoryReviewedAt:inputs.adrInventoryReviewedAt,initialPaths:['docs/adr/0001-reference-stack.md','docs/adr/0002-ownership-and-audit.md',
      'docs/adr/0003-device-owner-boundary.md','docs/adr/0004-migration-ledger.md','docs/adr/0005-object-storage-encryption.md',
      'docs/adr/0006-transaction-commit-receipt.md','docs/adr/0007-storage-response-lifecycle.md','docs/adr/0008-authentication-and-responsive-web.md','docs/adr/0009-definer-role.md'],
      entries,deviations:inputs.deviations},
    defects:inputs.defects,ci:inputs.ci,
    localPolicy:{result:policyVerified?'PASS':'UNVERIFIED',dependencyAuditRef:policyVerified?'test-results/operations/dependencies.json':null,
      e2eRef:policyVerified?'test-results/acceptance/vitest.json':null},
    ...await ownerGates(inputs,current.sourceCommit),
  });
  await mkdir('test-results/operations',{recursive:true});
  await writeFile('test-results/operations/status.json',JSON.stringify(report,null,2)+'\n');
  const gates=evaluateV0Release(report);
  console.log(JSON.stringify({report:'test-results/operations/status.json',gates},null,2));
  if(process.argv.includes('--check')&&gates.some(g=>!g.passed))process.exitCode=1;
}
main().catch(()=>{console.error('OPERATIONS_REPORT_INVALID_OR_UNAVAILABLE');process.exitCode=1;});


