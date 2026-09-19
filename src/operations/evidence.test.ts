import {recoveryEvidence} from './evidence.js';
import {it,expect} from 'vitest';
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
  const valid={format:'unai-coordinated-roundtrip/1',result:'PASS',executedAt:'2026-09-19T12:00:00.000Z',emptyTarget:true,
    archiveRef:'test-results/operations/coordinated-backup.aesgcm',archiveDigest:'a'.repeat(64),objectsRestored:1,
    keyRecoveryVerified:true,acceptanceAnswersRegenerated:true,
    fixtures:Array.from({length:20},(_,i)=>({id:'AC44.'+String(i+1).padStart(2,'0'),sourceDigest:'b'.repeat(64),restoredDigest:'b'.repeat(64)}))};
  expect(recoveryEvidence(valid)?.restore.result).toBe('PASS');
  for(const change of [{objectsRestored:0},{emptyTarget:false},{keyRecoveryVerified:false},{acceptanceAnswersRegenerated:false},
    {fixtures:valid.fixtures.slice(1)},{fixtures:[...valid.fixtures.slice(1),valid.fixtures[1]]},
    {fixtures:valid.fixtures.map((f,i)=>i?f:{...f,restoredDigest:'c'.repeat(64)})}])
    expect(recoveryEvidence({...valid,...change})).toBeNull();
  expect(recoveryEvidence({format:'unai-database-roundtrip/1',result:'PASS'})).toBeNull();
});

