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
  if(row['format']!=='unai-coordinated-roundtrip/1'||row['result']!=='PASS'||row['emptyTarget']!==true
    ||row['keyRecoveryVerified']!==true||row['acceptanceAnswersRegenerated']!==true
    ||typeof row['objectsRestored']!=='number'||row['objectsRestored']<1
    ||typeof row['executedAt']!=='string'||!Number.isFinite(Date.parse(row['executedAt'])))return null;
  const parsed=operationsReportSchema.shape.restore.safeParse({result:'PASS',emptyEnvironment:true,objectsRestored:true,keyRecoveryVerified:true,
    backupRef:row['archiveRef'],fixtures:Array.isArray(row['fixtures'])?row['fixtures'].map((fixture:Record<string,unknown>)=>({id:fixture['id'],sourceDigest:fixture['sourceDigest'],restoredDigest:fixture['restoredDigest']})):null});
  if(!parsed.success||parsed.data.fixtures.length!==20||new Set(parsed.data.fixtures.map(f=>f.id)).size!==20
    ||parsed.data.fixtures.some(f=>f.sourceDigest!==f.restoredDigest))return null;
  return {restore:parsed.data,execution:{executedAt:row['executedAt'],environment:'TEST',
    evidenceRef:'test-results/operations/coordinated-roundtrip.json',testNames:['Coordinated encrypted backup, empty database and object store restore, 20 regenerated acceptance fixture read pairs']}};
}


