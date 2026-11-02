import {spawnSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {operationsReportSchema,type OperationsReport} from '../../packages/domain/src/index.js';
export interface TestReport {testResults:Array<{name:string;assertionResults:Array<{fullName:string;status:string}>}>}
const procedures:Record<string,{file:string;marker:string}>={
  deletion:{file:'packages/api/src/control.test.ts',marker:'[AC44.18]'},
  'registry-migration':{file:'packages/registry/src/evaluation-db.test.ts',marker:'CRT-REG-05-A: publishing a migrating release'},
  'projection-rebuild':{file:'packages/capabilities/src/projection-replay.test.ts',marker:'CRT-PRJ-02-B: dropping the projection tables'},
  'connector-revocation':{file:'packages/api/src/connectors.test.ts',marker:'CRT-CON-06-A: a second sync resumes'},
};
export function procedureExecution(id:string,report:TestReport,completedAt:string):OperationsReport['procedures'][number]['execution']{
  const procedure=procedures[id];if(!procedure)return null;
  const cases=report.testResults.filter(f=>f.name.replaceAll('\\','/').endsWith(procedure.file))
    .flatMap(f=>f.assertionResults).filter(t=>t.fullName.startsWith(procedure.marker));
  if(!cases.length||cases.some(t=>t.status!=='passed'))return null;
  return {executedAt:completedAt,environment:'TEST',evidenceRef:'test-results/acceptance/vitest.json',testNames:cases.map(t=>t.fullName)};
}
export function localEndToEndPassed(report:TestReport):boolean{
  return ['apps/web/e2e/ask.test.ts','apps/web/e2e/memory.test.ts','packages/api/src/answers.test.ts','packages/api/src/today.test.ts'].every(path=>{
    const cases=report.testResults.filter(f=>f.name.replaceAll('\\','/').endsWith(path)).flatMap(f=>f.assertionResults);
    return cases.length>0&&cases.every(t=>t.status==='passed');
  });
}

export function recoveryEvidence(input:unknown):{restore:OperationsReport['restore'];execution:NonNullable<OperationsReport['procedures'][number]['execution']>}|null{
  if(!input||typeof input!=='object')return null;
  const row=input as Record<string,unknown>;
  if(row['format']!=='unai-coordinated-roundtrip/2'||row['archiveFormat']!=='uai-backup/1'||row['result']!=='PASS'||row['emptyTarget']!==true
    ||row['keyRecoveryVerified']!==true||row['wrongKeyRefused']!==true||row['tamperRefused']!==true||row['acceptanceAnswersRegenerated']!==true
    ||typeof row['objectsRestored']!=='number'||row['objectsRestored']<1
    ||typeof row['executedAt']!=='string'||!Number.isFinite(Date.parse(row['executedAt'])))return null;
  const parsed=operationsReportSchema.shape.restore.safeParse({result:'PASS',emptyEnvironment:true,objectsRestored:true,keyRecoveryVerified:true,
    backupRef:row['archiveRef'],fixtures:Array.isArray(row['fixtures'])?row['fixtures'].map((fixture:Record<string,unknown>)=>({id:fixture['id'],sourceDigest:fixture['sourceDigest'],restoredDigest:fixture['restoredDigest']})):null});
  if(!parsed.success||parsed.data.fixtures.length!==20||new Set(parsed.data.fixtures.map(f=>f.id)).size!==20
    ||parsed.data.fixtures.some(f=>f.sourceDigest!==f.restoredDigest))return null;
  return {restore:parsed.data,execution:{executedAt:row['executedAt'],environment:'TEST',
    evidenceRef:'test-results/operations/coordinated-roundtrip.json',testNames:['Coordinated encrypted backup, empty database and object store restore, 20 regenerated acceptance fixture read pairs']}};
}

// ADR 0044: the release records that may be committed after the run they certify.
export const RELEASE_RECORD_PATHS=['docs/operations/release-input.json','docs/operations/real-data-gates.md','corpus/expected/real-corpus-results.json'] as const;
/** The length bound keeps a listed path within the report's text limit. */
export const LIVE_RECORD_PATH=/^docs\/operations\/live-connectors-[A-Za-z0-9._-]{1,100}\.json$/;
const COMMIT=/^[a-f0-9]{40}$/;
type CommitRelation=OperationsReport['recordedCommits'][number]['relation'];

export function isReleaseRecordPath(path:string):boolean{
  return (RELEASE_RECORD_PATHS as readonly string[]).includes(path)||LIVE_RECORD_PATH.test(path);
}

/** Exit status and stdout only; stderr is discarded. Unlike the registry's git(),
 * this keeps exit status 1 apart from an error. Same hardening otherwise. */
function git(repository:string,args:string[]):{status:number|null;stdout:string}{
  const result=spawnSync('git',args,{cwd:repository,shell:false,encoding:'utf8',timeout:30000,maxBuffer:16*1024*1024,
    stdio:['ignore','pipe','ignore'],env:{...process.env,GIT_NO_REPLACE_OBJECTS:'1',GIT_TERMINAL_PROMPT:'0'}});
  return result.error?{status:null,stdout:''}:{status:result.status,stdout:result.stdout};
}

/** How a recorded commit relates to the explicit HEAD sha (never the symbolic HEAD,
 * which another session may move). Only validated 40-hex values reach Git. */
export function commitRelation(repository:string,commit:string,head:string):CommitRelation{
  if(!COMMIT.test(commit)||!COMMIT.test(head))return 'UNVERIFIED';
  if(commit===head)return 'HEAD';
  const ancestor=git(repository,['merge-base','--is-ancestor',commit,head]).status;
  if(ancestor===1)return 'NOT_ANCESTOR';
  if(ancestor!==0)return 'UNVERIFIED';
  // Without rename detection a file moved into a record path still lists its old path.
  const diff=git(repository,['diff','--name-only','--no-renames','-z',commit,head]);
  if(diff.status!==0)return 'UNVERIFIED';
  return diff.stdout.split('\0').filter(path=>path!=='').every(isReleaseRecordPath)?'RECORDS_ONLY_ANCESTOR':'OTHER_PATHS_CHANGED';
}

/** One relation per distinct 40-hex value; anything else is left out and so never accepted. */
export function recordCommitEvidence(repository:string,head:string,commits:readonly unknown[]):OperationsReport['recordedCommits']{
  const unique=[...new Set(commits.filter((value):value is string=>typeof value==='string'&&COMMIT.test(value)))];
  return unique.map(commit=>({commit,relation:commitRelation(repository,commit,head)}));
}

/** The newest (last) record listed under release-input.json `liveConnectorRecords`.
 * Answers only codes: never file content or error text. */
export async function readLiveConnectorRecord(repository:string,listed:unknown):Promise<OperationsReport['liveConnectors']>{
  const refused=(recordRef:string|null,failure:'LIVE_RECORD_MISSING'|'LIVE_RECORD_INVALID')=>({recordRef,record:null,failure});
  if(listed===undefined||listed===null||(Array.isArray(listed)&&listed.length===0))return refused(null,'LIVE_RECORD_MISSING');
  if(!Array.isArray(listed)||listed.some(entry=>typeof entry!=='string'))return refused(null,'LIVE_RECORD_INVALID');
  const recordRef:unknown=listed[listed.length-1];
  if(typeof recordRef!=='string'||!LIVE_RECORD_PATH.test(recordRef))return refused(null,'LIVE_RECORD_INVALID');
  let raw:string;
  try{raw=await readFile(resolve(repository,recordRef),'utf8');}
  catch(error){return refused(recordRef,(error as {code?:unknown}).code==='ENOENT'?'LIVE_RECORD_MISSING':'LIVE_RECORD_INVALID');}
  let value:unknown;
  try{value=JSON.parse(raw);}catch{return refused(recordRef,'LIVE_RECORD_INVALID');}
  const parsed=operationsReportSchema.shape.liveConnectors.shape.record.unwrap().safeParse(value);
  return parsed.success?{recordRef,record:parsed.data,failure:null}:refused(recordRef,'LIVE_RECORD_INVALID');
}
