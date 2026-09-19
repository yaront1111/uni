import {expect,it} from 'vitest';
import * as domain from './index.js';

const ids=['backup','restore','deletion','registry-migration','projection-rebuild','connector-revocation'];
function ready(){return {
  format:'unai-operations/1',checkedAt:'2026-09-19T15:00:00.000Z',sourceCommit:'a'.repeat(40),workspaceClean:true,
  procedures:ids.map(id=>({id,title:id,body:'Reviewed procedure',execution:{executedAt:'2026-09-19T14:00:00.000Z',environment:'TEST',evidenceRef:'test-results/operations/execution.json',testNames:['actual rehearsal']}})),
  restore:{result:'PASS',emptyEnvironment:true,objectsRestored:true,keyRecoveryVerified:true,backupRef:'encrypted-backup-1',
    fixtures:Array.from({length:20},(_,i)=>({id:'AC44.'+String(i+1).padStart(2,'0'),sourceDigest:'b'.repeat(64),restoredDigest:'b'.repeat(64)}))},
  adr:{inventoryReviewedAt:'2026-09-19T14:00:00.000Z',initialPaths:['docs/adr/0001-reference-stack.md'],
    entries:[{path:'docs/adr/0001-reference-stack.md',title:'Reference stack',date:'2026-09-14'}],
    deviations:[{requirement:'PRD MUST example',adrPath:'docs/adr/0001-reference-stack.md',implementedAt:'2026-09-15T00:00:00.000Z'}]},
  defects:{reviewedAt:'2026-09-19T14:00:00.000Z',items:[]},
  ci:{branch:'main',defaultBranch:'main',commit:'a'.repeat(40),runRef:'https://example.invalid/actions/runs/1',
    stages:['lint','unit','property','registry-lint','registry-contract','connector-integration','security','corpus','end-to-end'].map(name=>({name,result:'PASS'}))},
  localPolicy:{result:'PASS',dependencyAuditRef:'test-results/operations/dependencies.json',e2eRef:'test-results/acceptance/vitest.json'},
};}
function evaluate(value:unknown){
  expect(domain).toHaveProperty('operationsReportSchema');
  expect(domain).toHaveProperty('evaluateV0Release');
  return domain.evaluateV0Release(domain.operationsReportSchema.parse(value));
}
it('accepts a complete attested report and lists every assigned criterion',()=>{
  expect(evaluate(ready())).toEqual([
    {criterion:'CRT-NFR-03-A',passed:true},{criterion:'CRT-OPS-01-A',passed:true},
    {criterion:'CRT-OPS-02-A',passed:true},{criterion:'CRT-OPS-03-A',passed:true},
    {criterion:'CRT-QA-01-A',passed:true},{criterion:'CRT-WRT-03-C',passed:true},
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
