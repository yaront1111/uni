import {z} from 'zod';

export const RUNBOOK_IDS=['backup','restore','deletion','registry-migration','projection-rebuild','connector-revocation'] as const;
export const V0_CI_STAGES=['lint','unit','property','registry-lint','registry-contract','connector-integration','security','corpus','end-to-end'] as const;
const text=z.string().min(1).max(2048);
const instant=z.string().datetime();
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const commit=z.string().regex(/^[a-f0-9]{40}$/);
const result=z.enum(['PASS','FAIL','UNVERIFIED']);
const code=z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);
const count=z.number().int().min(0);
/** ADR 0044: how a recorded commit relates to the checked-out HEAD, as the gatherer found it. */
const COMMIT_RELATIONS=['HEAD','RECORDS_ONLY_ANCESTOR','OTHER_PATHS_CHANGED','NOT_ANCESTOR','UNVERIFIED'] as const;
/** The owner's `unai-live-connectors/1` record (docs/operations/real-data-gates.md, Gate 2). */
const liveConnectorRecord=z.object({format:z.literal('unai-live-connectors/1'),recordedAt:instant,recordedBy:z.literal('owner'),
  command:z.literal('pnpm test'),sourceCommit:commit,workspaceDigest:digest,completedAt:instant,exitCode:z.number().int(),
  workspaceClean:z.boolean(),revocationAllowed:z.boolean(),
  cases:z.array(z.object({criterion:text,connector:z.enum(['GMAIL','GOOGLE_CALENDAR','GITHUB','OMI']),status:z.string().min(1).max(32),testName:text}).strict()).max(50),
  totals:z.object({passed:count,failed:count,skipped:count}).strict()}).strict();
/** PRD §54 item 1: every non-opt-in case in packages/api/src/connectors.live.test.ts,
 * including Omi (ADR 0041). */
const LIVE_REQUIRED_CASES=[{criterion:'CRT-CON-02-A',connector:'GMAIL'},{criterion:'CRT-CON-03-A',connector:'GOOGLE_CALENDAR'},
  {criterion:'CRT-CON-04-A',connector:'GITHUB'},{criterion:'ADR-0041-LIVE-A',connector:'OMI'}] as const;
/** Revocation runs only when the owner allows it, so it may be skipped but never failed. */
const LIVE_OPT_IN_CASE='CRT-CON-06-A';
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
  realCorpus:z.object({result,failures:z.array(code).max(50)}).strict(),
  liveConnectors:z.object({recordRef:text.nullable(),record:liveConnectorRecord.nullable(),failure:code.nullable()}).strict(),
  registryTags:z.object({failure:code.nullable(),
    tags:z.array(z.object({version:text,tag:text,status:z.enum(['PRESENT','MISSING','MISMATCH'])}).strict()).max(100)}).strict(),
  recordedCommits:z.array(z.object({commit,relation:z.enum(COMMIT_RELATIONS)}).strict()).max(10),
}).strict();
export type OperationsReport=z.infer<typeof operationsReportSchema>;

/** Evaluates supplied evidence, not its authenticity. The release operator must
 * retain its source artifacts; only the independent verifier can attest a build. */
export function evaluateV0Release(report:OperationsReport):Array<{criterion:string;passed:boolean}>{
  const {restore,adr,defects,ci,localPolicy,realCorpus,liveConnectors,registryTags}=report;
  const adrPaths=new Set(adr.entries.map(entry=>entry.path));
  // ADR 0044: HEAD itself, or an ancestor whose only later changes are release records.
  // Every relation recorded for the commit must say so; a relation for another commit never counts.
  const accepted=(recorded:string)=>{
    const relations=report.recordedCommits.filter(entry=>entry.commit===recorded);
    return recorded===report.sourceCommit||(relations.length>0&&relations.every(entry=>entry.relation==='RECORDS_ONLY_ANCESTOR'));
  };
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
    {criterion:'CRT-QA-01-A',passed:report.workspaceClean&&ci!==null&&ci.branch===ci.defaultBranch&&accepted(ci.commit)
      &&V0_CI_STAGES.every(name=>ci.stages.filter(s=>s.name===name).length===1&&ci.stages.find(s=>s.name===name)!.result==='PASS')},
    {criterion:'CRT-WRT-03-C',passed:localPolicy.result==='PASS'&&localPolicy.dependencyAuditRef!==null&&localPolicy.e2eRef!==null},
    {criterion:'PRD-54.4-REAL-CORPUS',passed:realCorpus.result==='PASS'&&realCorpus.failures.length===0},
    {criterion:'PRD-54.1-LIVE-CONNECTORS',passed:liveConnectors.failure===null&&liveConnectors.record!==null
      &&livePassed(liveConnectors.record)&&accepted(liveConnectors.record.sourceCommit)},
    {criterion:'PRD-54.3-REGISTRY-TAGS',passed:registryTags.failure===null&&registryTags.tags.length>0
      &&registryTags.tags.every(tag=>tag.status==='PRESENT')},
  ];
}

/** A skipped, pending or absent required case is never a pass, and totals must count the cases. */
function livePassed(record:z.infer<typeof liveConnectorRecord>):boolean{
  const {cases,totals}=record;
  const passed=cases.filter(c=>c.status==='passed').length,failed=cases.filter(c=>c.status==='failed').length;
  return record.exitCode===0&&record.workspaceClean
    &&LIVE_REQUIRED_CASES.every(required=>cases.some(c=>c.criterion===required.criterion&&c.connector===required.connector))
    &&cases.every(c=>c.criterion===LIVE_OPT_IN_CASE?c.status!=='failed':c.status==='passed')
    &&totals.passed===passed&&totals.failed===failed&&totals.skipped===cases.length-passed-failed;
}
