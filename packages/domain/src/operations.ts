import {z} from 'zod';

export const RUNBOOK_IDS=['backup','restore','deletion','registry-migration','projection-rebuild','connector-revocation'] as const;
export const V0_CI_STAGES=['lint','unit','property','registry-lint','registry-contract','connector-integration','security','corpus','end-to-end'] as const;
const text=z.string().min(1).max(2048);
const instant=z.string().datetime();
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const commit=z.string().regex(/^[a-f0-9]{40}$/);
const result=z.enum(['PASS','FAIL','UNVERIFIED']);
const execution=z.object({executedAt:instant,environment:z.literal('TEST'),evidenceRef:text,testNames:z.array(text).min(1).max(200)}).strict();
export const operationsReportSchema=z.object({
  format:z.literal('unai-operations/1'),checkedAt:instant,sourceCommit:commit,workspaceClean:z.boolean(),
  procedures:z.array(z.object({id:z.enum(RUNBOOK_IDS),title:text,body:z.string().min(1).max(30000),execution:execution.nullable()}).strict()).max(6),
  restore:z.object({result,emptyEnvironment:z.boolean(),objectsRestored:z.boolean(),keyRecoveryVerified:z.boolean(),backupRef:text.nullable(),
    fixtures:z.array(z.object({id:z.string().regex(/^AC44\.(0[1-9]|1[0-9]|20)$/),sourceDigest:digest,restoredDigest:digest}).strict()).max(20)}).strict(),
  adr:z.object({inventoryReviewedAt:instant.nullable(),initialPaths:z.array(text).min(1).max(100),
    entries:z.array(z.object({path:z.string().regex(/^docs\/adr\/[a-zA-Z0-9_-]+\.md$/),title:text,date:z.string().date()}).strict()).max(1000),
    deviations:z.array(z.object({requirement:text,adrPath:text,implementedAt:instant}).strict()).max(1000)}).strict(),
  defects:z.object({reviewedAt:instant.nullable(),items:z.array(z.object({id:text,priority:z.enum(['P0','P1','P2','P3']),
    category:z.enum(['CORRECTNESS','SECURITY','OTHER']),status:z.enum(['OPEN','CLOSED']),detail:text}).strict()).max(1000)}).strict(),
  ci:z.object({branch:text,defaultBranch:text,commit,runRef:z.string().url(),
    stages:z.array(z.object({name:z.enum(V0_CI_STAGES),result}).strict()).max(9)}).strict().nullable(),
  localPolicy:z.object({result,dependencyAuditRef:text.nullable(),e2eRef:text.nullable()}).strict(),
}).strict();
export type OperationsReport=z.infer<typeof operationsReportSchema>;

/** Evaluates supplied evidence, not its authenticity. The release operator must
 * retain its source artifacts; only the independent verifier can attest a build. */
export function evaluateV0Release(report:OperationsReport):Array<{criterion:string;passed:boolean}>{
  const {restore,adr,defects,ci,localPolicy}=report;
  const adrPaths=new Set(adr.entries.map(entry=>entry.path));
  return [
    {criterion:'CRT-NFR-03-A',passed:restore.result==='PASS'&&restore.emptyEnvironment&&restore.objectsRestored&&restore.keyRecoveryVerified
      &&restore.backupRef!==null&&restore.fixtures.length===20&&new Set(restore.fixtures.map(f=>f.id)).size===20
      &&restore.fixtures.every(f=>f.sourceDigest===f.restoredDigest)},
    {criterion:'CRT-OPS-01-A',passed:RUNBOOK_IDS.every(id=>report.procedures.filter(p=>p.id===id).length===1
      &&report.procedures.find(p=>p.id===id)!.execution!==null)},
    // A date without time cannot establish precedence over a same-day change.
    {criterion:'CRT-OPS-02-A',passed:adr.inventoryReviewedAt!==null&&adrPaths.size===adr.entries.length
      &&adr.initialPaths.every(path=>adrPaths.has(path))&&adr.deviations.every(d=>{
        const entry=adr.entries.find(a=>a.path===d.adrPath);return entry!==undefined&&entry.date<d.implementedAt.slice(0,10);
      })},
    {criterion:'CRT-OPS-03-A',passed:defects.reviewedAt!==null&&!defects.items.some(d=>d.status==='OPEN'
      &&(d.priority==='P0'||d.priority==='P1')&&(d.category==='CORRECTNESS'||d.category==='SECURITY'))},
    {criterion:'CRT-QA-01-A',passed:report.workspaceClean&&ci!==null&&ci.branch===ci.defaultBranch&&ci.commit===report.sourceCommit
      &&V0_CI_STAGES.every(name=>ci.stages.filter(s=>s.name===name).length===1&&ci.stages.find(s=>s.name===name)!.result==='PASS')},
    {criterion:'CRT-WRT-03-C',passed:localPolicy.result==='PASS'&&localPolicy.dependencyAuditRef!==null&&localPolicy.e2eRef!==null},
  ];
}
