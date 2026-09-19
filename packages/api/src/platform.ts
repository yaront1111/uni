import type { Pool } from 'pg';
import { createApiBoundary, type ApiBoundaryOptions } from './index.js';
import { resolveSession, sessionToken, revokeSessions } from '@unai/auth';
import { withOwnerTransaction, type OwnerTransaction } from '@unai/postgres';
import { registerDeviceSchema,publicDeviceSchema,auditEventKindFor,type AuditEvent } from '@unai/domain';
import {registerAuditRoutes,AUDIT_READ_PURPOSE,AUDIT_MODIFY_PURPOSE,auditPurposeFor} from './audit.js';
import { randomUUID } from 'node:crypto';
import {registerEvidenceRoutes,type EvidenceObjects} from './evidence.js';
import {registerMemoryGovernorRoutes} from './memory.js';
import {registerCorrectionRoutes,CORRECTION_PURPOSE} from './corrections.js';
import {registerOpsRoutes} from './ops.js';
import {registerMetricsRoutes,METRICS_READ_PURPOSE,SHADOW_READ_PURPOSE} from './metrics.js';
import {registerProjectionRoutes,PROJECTION_READ_PURPOSE,PROJECTION_HEALTH_PURPOSE} from './projections.js';
import {registerContextRoutes,CONTEXT_READ_PURPOSE,MEMORY_INSPECT_PURPOSE,MEMORY_THREAD_PURPOSE} from './context.js';
import {registerLineageRoutes,LINEAGE_WRITE_PURPOSE,MERGE_SPLIT_REVIEW_PURPOSE} from './lineage.js';
import {registerAskRoutes,ASK_PURPOSE} from './ask.js';
import {registerInspectionRoutes,INSPECTION_PURPOSE,INSPECTION_URLS} from './inspection.js';
import {registerAnswerRoutes,ANSWER_READ_PURPOSE} from './answers.js';
import {registerControlRoutes,controlPurposeFor,CONTROL_PURPOSES} from './control.js';
import {registerReviewRoutes,INBOX_PURPOSE,APPROVAL_RULES_PURPOSE,ATTENTION_SETTINGS_PURPOSE,WEEKLY_REVIEW_PURPOSE} from './review.js';
import {registerTodayRoutes,TODAY_PURPOSE,WHY_PURPOSE,type TodayRouteOptions} from './today.js';
import {registerDecisionRoutes,DECISIONS_READ_PURPOSE,DECISIONS_RECORD_PURPOSE,GOALS_READ_PURPOSE,GOALS_MANAGE_PURPOSE,
  MENTOR_PURPOSE} from './decisions.js';
import type {TransitionContract} from '@unai/domain';
import {registerConnectorRoutes,CONNECTOR_MANAGE_PURPOSE,CONNECTOR_SYNC_PURPOSE,
  type ConnectorRouteOptions} from './connectors.js';
import {ConnectorError} from '@unai/connectors';
import {enqueueEvidenceProcessing} from './processing-store.js';
import {registerInitiativeRoutes} from './initiative-routes.js';
import type {PolicyPorts} from '@unai/belief';
import type {AnswerPhraser} from '@unai/context';

/** The owner's correction controls and their overlay read. One purpose covers
 * both directions of the same surface: the write records the delta and the read
 * answers it back for whichever of the owner's devices asks (PRD §14, §20). */
const CORRECTION_URLS=new Set(['/v1/memory/overlay-deltas','/v1/memory/corrections','/v1/memory/state-changes',
  '/v1/memory/confirmations','/v1/memory/rejections','/v1/memory/keep-uncertain','/v1/memory/suppressions',
  '/v1/memory/archives','/v1/memory/deletions']);
/** Governed merge and split (PRD §35.11). Each is a belief transaction, so each
 * runs under the governing purpose like every other governed write. */
const LINEAGE_URLS=new Set(['/v1/memory/frame-instances/merge','/v1/memory/frame-instances/:id/split',
  '/v1/memory/entities/merge','/v1/memory/entities/:id/split']);

/** Every audit event a route appends names its kind (CRT-SEC-07-A). A route that
 * knows better names it itself; otherwise the transaction's purpose decides the
 * four kinds only one purpose can produce, and the request's HTTP method tells a
 * read from a write. The owner, actor and correlation id stay the transaction's. */
function withRequestEventKind(tx:OwnerTransaction,method:string):OwnerTransaction{
  return Object.freeze({
    context:tx.context,
    query:(sql:string,values?:unknown[])=>tx.query(sql,values),
    audit:(event:AuditEvent)=>tx.audit({...event,eventKind:event.eventKind??auditEventKindFor(tx.context.purpose,method)}),
  });
}

/** Every purpose a request may declare. A purpose missing here is refused at the
 * boundary (`ACCESS_DENIED`) before any route runs. */
export const PLATFORM_PURPOSES:ReadonlySet<string>=new Set(['device.list','device.register','device.remove','auth.sign_out_all','evidence.ingest','evidence.read','connector.read',
  CONNECTOR_MANAGE_PURPOSE,CONNECTOR_SYNC_PURPOSE,
  'memory.govern',CORRECTION_PURPOSE,PROJECTION_READ_PURPOSE,PROJECTION_HEALTH_PURPOSE,
  CONTEXT_READ_PURPOSE,ASK_PURPOSE,TODAY_PURPOSE,WHY_PURPOSE,MEMORY_INSPECT_PURPOSE,MEMORY_THREAD_PURPOSE,
  INBOX_PURPOSE,APPROVAL_RULES_PURPOSE,ATTENTION_SETTINGS_PURPOSE,WEEKLY_REVIEW_PURPOSE,
  GOALS_READ_PURPOSE,GOALS_MANAGE_PURPOSE,DECISIONS_READ_PURPOSE,DECISIONS_RECORD_PURPOSE,MENTOR_PURPOSE,
  'ops.jobs.read','ops.dead_letter.read','ops.dead_letter.retry','ops.registry.read',METRICS_READ_PURPOSE,SHADOW_READ_PURPOSE,
  // Governed action and the data-control surface (ADR 0030).
  ...CONTROL_PURPOSES,
  // The Audit log (ADR 0032). `audit.modify` is admitted only so an attempt to
  // change an event reaches its route, which refuses it and records the refusal.
  AUDIT_READ_PURPOSE,AUDIT_MODIFY_PURPOSE]);

/** The single purpose each route admits, by route pattern (not the raw URL) and
 * method, or null for none. The platform's preHandler refuses any other declared
 * purpose with `PURPOSE_REFUSED`. */
export function routePurpose(method:string,url:string|undefined):string|null{
  return method==='GET'&&url==='/v1/devices'?'device.list':
    url==='/v1/devices'?'device.register':
    url==='/v1/devices/:id/revoke'?'device.remove':
    url==='/v1/sessions/revoke-all'?'auth.sign_out_all':
    url==='/v1/evidence'?'evidence.ingest':
    url==='/v1/evidence/:id'?'evidence.read':
    url==='/v1/documents'?'evidence.ingest':
    url==='/v1/documents/search'?'evidence.read':
    url==='/v1/connectors/:id/sync'?CONNECTOR_SYNC_PURPOSE:
    url==='/v1/connectors/:id/capabilities'&&method==='POST'?CONNECTOR_MANAGE_PURPOSE:
    url==='/v1/connectors/:id/disconnect'?CONNECTOR_MANAGE_PURPOSE:
    url==='/v1/connectors'&&method==='POST'?CONNECTOR_MANAGE_PURPOSE:
    url==='/v1/connectors'?'connector.read':
    url==='/v1/connectors/:id/capabilities'?'connector.read':
    url==='/v1/connectors/:id'?'connector.read':
    url?.startsWith('/v1/memory/transactions')?'memory.govern':
    url==='/v1/memory/context'?CONTEXT_READ_PURPOSE:
    url==='/v1/ask'?ASK_PURPOSE:
    url==='/v1/today'?TODAY_PURPOSE:
    url==='/v1/memory/why/:objectType/:id'?WHY_PURPOSE:
    url==='/v1/memory/propositions/:id/explain'?MEMORY_INSPECT_PURPOSE:
    url==='/v1/memory/threads/:id'?MEMORY_INSPECT_PURPOSE:
    url==='/v1/memory/threads/:id/members'?MEMORY_THREAD_PURPOSE:
    url&&INSPECTION_URLS.includes(url)?INSPECTION_PURPOSE:
    url==='/v1/answers/:id/manifest'?ANSWER_READ_PURPOSE:
    url==='/v1/answers/reconsideration-candidates'?ANSWER_READ_PURPOSE:
    url==='/v1/memory/inbox'?INBOX_PURPOSE:
    url==='/v1/memory/inbox/cards/:id/decide'?INBOX_PURPOSE:
    url==='/v1/settings/attention-budgets'?ATTENTION_SETTINGS_PURPOSE:
    url==='/v1/settings/initiative'?ATTENTION_SETTINGS_PURPOSE:
    url==='/v1/initiative/watches'&&method==='POST'?CORRECTION_PURPOSE:
    url==='/v1/initiative/watches/:id'?CORRECTION_PURPOSE:
    url==='/v1/initiative/watches'||url==='/v1/initiative/notices'?CONTEXT_READ_PURPOSE:
    url==='/v1/approval-rules'?APPROVAL_RULES_PURPOSE:
    url==='/v1/approval-rules/:id/approve'?APPROVAL_RULES_PURPOSE:
    url==='/v1/approval-rules/:id/revoke'?APPROVAL_RULES_PURPOSE:
    url==='/v1/weekly-review'?WEEKLY_REVIEW_PURPOSE:
    url==='/v1/goals'&&method==='GET'?GOALS_READ_PURPOSE:
    url==='/v1/goals'?GOALS_MANAGE_PURPOSE:
    url==='/v1/goals/:id/priority'?GOALS_MANAGE_PURPOSE:
    url==='/v1/decisions'?DECISIONS_RECORD_PURPOSE:
    url==='/v1/decisions/:id/review'?DECISIONS_RECORD_PURPOSE:
    url==='/v1/decisions/:id'?DECISIONS_READ_PURPOSE:
    url==='/v1/mentor/contradictions'?MENTOR_PURPOSE:
    url&&LINEAGE_URLS.has(url)?LINEAGE_WRITE_PURPOSE:
    url==='/v1/memory/merge-split/review'?MERGE_SPLIT_REVIEW_PURPOSE:
    url&&CORRECTION_URLS.has(url)?CORRECTION_PURPOSE:
    url?.startsWith('/v1/projections/')?PROJECTION_READ_PURPOSE:
    url==='/v1/ops/projections'?PROJECTION_HEALTH_PURPOSE:
    url==='/v1/ops/jobs'?'ops.jobs.read':
    url==='/v1/ops/dead-letter'?'ops.dead_letter.read':
    url==='/v1/ops/dead-letter/:id/retry'?'ops.dead_letter.retry':
    url==='/v1/ops/registry-snapshot'?'ops.registry.read':
    url==='/v1/ops/metrics'?METRICS_READ_PURPOSE:
    url==='/v1/ops/shadow-evaluations'?SHADOW_READ_PURPOSE:
    auditPurposeFor(method,url)??
    controlPurposeFor(method,url);
}

export function createPlatformApi(options:{authPool:Pool;appPool:Pool;tls?:ApiBoundaryOptions['tls'];
  evidenceObjects?:EvidenceObjects;registryReleaseId?:string;registryRelease?:string;
  /** The policy ports the Context Broker evaluates reads through. The local
   * adapters are the default; a deployment that installs Cordum supplies them
   * here and no route changes (PRD §29.4). */
  policyPorts?:PolicyPorts;
  /** The model that phrases Ask answers (`createGatewayAnswerPhraser`). Without
   * one the deterministic composer answers; either way the grounding validator
   * decides what is presented and a manifest is recorded (ADR 0026). */
  answerPhraser?:AnswerPhraser;
  /** The connector runtime's ports: the read-only provider clients, the token
   * revoker a disconnect calls, and the extraction enqueue a FULL document plan
   * uses. A deployment without them still serves the inspection routes and
   * refuses a sync rather than pretending to run one. */
  connectors?:ConnectorRouteOptions;
  /** The instant a Today briefing is built for; only tests pin it. */
  todayClock?:TodayRouteOptions['clock'];
  /** The instant the inbox and the weekly review treat as now. Only tests set it,
   * to move the inbox across owner-local days; sessions still expire on the
   * database's own clock. */
  clock?:()=>Date;
  /** The pinned registry release's transition contracts, for the decision review.
   * Without them the review reads the newest published release's from the
   * database snapshot (ADR 0029 §6). */
  transitionContracts?:readonly TransitionContract[]}){
  const purposes=PLATFORM_PURPOSES;
  const app=createApiBoundary({
    ...(options.tls?{tls:options.tls}:{}),
    async authenticate(headers){
      const token=sessionToken(headers.cookie);
      const session=token?await resolveSession(options.authPool,token):null;
      return session?{actorId:session.userId}:null;
    },
    async authorize(context){
      if(!purposes.has(context.purpose))return false;
      try{return await withOwnerTransaction(options.appPool,context,async()=>true);}catch{return false;}
    },
    log:event=>console.info(JSON.stringify(event)),
  });
  app.addHook('preHandler',async(request,reply)=>{
    const expected=routePurpose(request.method,request.routeOptions.url);
    if(!expected||request.ownerContext?.purpose!==expected)return reply.code(403).send({code:'PURPOSE_REFUSED'});
  });
  /** `purpose` lets a route open one transaction under a purpose its server code
   * names -- the projection rebuild after a merge runs under `memory.project`
   * (ADR 0025 §4), and an Ask answer is recorded under `answer.record` (ADR 0026).
   * It is never read from a header, and the session, owner scope and actor stay
   * the request's: the session is re-verified exactly as for every other transaction. */
  async function deviceWork(request:import('fastify').FastifyRequest,run:(tx:import('@unai/postgres').OwnerTransaction,sessionId:string)=>Promise<unknown>,purpose?:string){
    const token=sessionToken(request.headers.cookie);
    const session=token?await resolveSession(options.authPool,token):null;
    if(!session||session.ownerScopeId!==request.ownerContext!.ownerScopeId)throw new Error('SESSION_EXPIRED');
    const context=purpose===undefined?request.ownerContext!:{...request.ownerContext!,purpose};
    return withOwnerTransaction(options.appPool,context,async tx=>{
      const live=await tx.query('SELECT id FROM auth_sessions WHERE id=$1 AND revoked_at IS NULL AND expires_at>statement_timestamp() FOR UPDATE',[session.id]);
      if(live.rowCount!==1)throw new Error('SESSION_EXPIRED');
      return run(withRequestEventKind(tx,request.method),session.id);
    });
  }
  app.get('/v1/devices',async request=>deviceWork(request,async(tx)=>{
    const rows=(await tx.query('SELECT id,display_name,device_kind,last_seen_at FROM devices WHERE owner_scope_id=$1 AND user_id=$2 AND removed_at IS NULL ORDER BY last_seen_at DESC',[tx.context.ownerScopeId,tx.context.actorId])).rows;
    const devices=rows.map(row=>publicDeviceSchema.parse({id:row.id,displayName:row.display_name,kind:row.device_kind,lastSeenAt:row.last_seen_at.toISOString()}));
    await tx.audit({policyDecision:'ALLOW',codeVersion:'0.1.0',result:'SUCCESS',objects:devices.slice(0,100).map(d=>({type:'devices',id:d.id,fields:['display_name','last_seen_at','device_kind']}))});
    return {devices};
  }));
  app.post('/v1/devices',async(request,reply)=>{
    const parsed=registerDeviceSchema.safeParse(request.body);
    if(!parsed.success)return reply.code(400).send({code:'DEVICE_INPUT_INVALID'});
    return deviceWork(request,async(tx,sessionId)=>{
      const row=(await tx.query('SELECT device_id FROM auth_sessions WHERE id=$1',[sessionId])).rows[0];
      let device;
      if(row.device_id){
        device=(await tx.query('SELECT id,display_name,device_kind,last_seen_at FROM devices WHERE id=$1 AND removed_at IS NULL',[row.device_id])).rows[0];
        if(!device||device.display_name!==parsed.data.displayName||device.device_kind!==parsed.data.kind) return reply.code(409).send({code:'DEVICE_ALREADY_REGISTERED'});
      }else{
        const id=randomUUID();
        device=(await tx.query('INSERT INTO devices(id,owner_scope_id,user_id,display_name,device_kind) VALUES($1,$2,$3,$4,$5) RETURNING id,display_name,device_kind,last_seen_at',
          [id,tx.context.ownerScopeId,tx.context.actorId,parsed.data.displayName,parsed.data.kind])).rows[0];
        await tx.query('UPDATE auth_sessions SET device_id=$1 WHERE id=$2',[id,sessionId]);
      }
      await tx.audit({policyDecision:'ALLOW',codeVersion:'0.1.0',result:'SUCCESS',objects:[{type:'devices',id:device.id,fields:['display_name','device_kind']}]});
      return publicDeviceSchema.parse({id:device.id,displayName:device.display_name,kind:device.device_kind,lastSeenAt:device.last_seen_at.toISOString()});
    });
  });
  app.post<{Params:{id:string}}>('/v1/devices/:id/revoke',async(request,reply)=>{
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(request.params.id))return reply.code(400).send({code:'DEVICE_INPUT_INVALID'});
    return deviceWork(request,async tx=>{
      const changed=await tx.query('UPDATE devices SET removed_at=coalesce(removed_at,now()) WHERE id=$1 AND owner_scope_id=$2 AND user_id=$3 RETURNING id',[request.params.id,tx.context.ownerScopeId,tx.context.actorId]);
      if(changed.rowCount!==1)return reply.code(404).send({code:'DEVICE_NOT_FOUND'});
      await tx.audit({policyDecision:'ALLOW',codeVersion:'0.1.0',result:'SUCCESS',objects:[{type:'devices',id:request.params.id,fields:['removed_at']}]});
      return {removed:true};
    });
  });
  app.post('/v1/sessions/revoke-all',async request=>{
    await revokeSessions(options.authPool,sessionToken(request.headers.cookie)!,request.ownerContext!.correlationId,true);
    return {revoked:true};
  });
  registerEvidenceRoutes(app,deviceWork,options.evidenceObjects);
  registerInitiativeRoutes(app,deviceWork,{...(options.evidenceObjects?{evidenceObjects:options.evidenceObjects}:{}),
    ...(options.clock?{clock:options.clock}:{}),...(options.registryReleaseId?{registryReleaseId:options.registryReleaseId}:{}),
    ...(options.registryRelease?{registryRelease:options.registryRelease}:{})});
  registerConnectorRoutes(app,deviceWork,{
    ...(options.evidenceObjects?{evidenceObjects:options.evidenceObjects}:{}),
    ...(options.connectors ?? {}),
    // The queue is the API's own, so the enqueue port is composed here rather
    // than handed in: a document whose plan is FULL is queued in its own owner
    // transaction under `jobs.enqueue`, after the evidence has committed.
    enqueueExtraction:options.connectors?.enqueueExtraction ?? (async input=>{
      // The extraction worker pins its run to a registry release; a deployment
      // that has loaded none cannot queue a run it could not reproduce, and says
      // so rather than queueing a payload that would dead-letter.
      if(!options.registryReleaseId)throw new ConnectorError('DOCUMENT_EXTRACTION_UNAVAILABLE');
      return enqueueEvidenceProcessing({appPool:options.appPool,context:input.context,
        evidenceId:input.evidenceId,registryReleaseId:options.registryReleaseId});
    }),
  });
  registerMemoryGovernorRoutes(app,deviceWork);
  registerCorrectionRoutes(app,deviceWork,{evidenceObjects:options.evidenceObjects,registryReleaseId:options.registryReleaseId});
  registerLineageRoutes(app,deviceWork,{registryReleaseId:options.registryReleaseId,evidenceObjects:options.evidenceObjects});
  registerOpsRoutes(app,deviceWork);
  registerMetricsRoutes(app,deviceWork);
  registerProjectionRoutes(app,deviceWork);
  registerContextRoutes(app,deviceWork,{
    ...(options.policyPorts?{policyPorts:options.policyPorts}:{}),
    registryReleaseId:options.registryReleaseId??null,registryRelease:options.registryRelease??null});
  registerAskRoutes(app,deviceWork,{
    ...(options.policyPorts?{policyPorts:options.policyPorts}:{}),
    registryReleaseId:options.registryReleaseId??null,registryRelease:options.registryRelease??null,
    evidenceObjects:options.evidenceObjects,phraser:options.answerPhraser,
    purposeWork:(request,purpose,run)=>deviceWork(request,tx=>run(tx),purpose)});
  registerAnswerRoutes(app,deviceWork);
  registerInspectionRoutes(app,deviceWork,{registryRelease:options.registryRelease??null});
  registerTodayRoutes(app,deviceWork,{
    ...(options.policyPorts?{policyPorts:options.policyPorts}:{}),
    ...(options.todayClock?{clock:options.todayClock}:{}),
    registryReleaseId:options.registryReleaseId??null,registryRelease:options.registryRelease??null});
  // The Memory inbox, learned approval rules, attention budgets and the weekly
  // review (ADR 0029). Their broker reads and their answer writes run under
  // `memory.read` and `memory.correct`, named here by server code.
  registerReviewRoutes(app,deviceWork,{
    purposeWork:<T,>(request:import('fastify').FastifyRequest,purpose:string,run:(tx:import('@unai/postgres').OwnerTransaction)=>Promise<T>)=>
      deviceWork(request,tx=>run(tx),purpose) as Promise<T>,
    evidenceObjects:options.evidenceObjects,registryReleaseId:options.registryReleaseId,
    registryRelease:options.registryRelease??null,...(options.policyPorts?{policyPorts:options.policyPorts}:{}),
    ...(options.clock?{now:options.clock}:{})});
  // Goals, decisions, the prediction review and the mentor (ADR 0029). Their
  // evidence, canonicalization, projection, broker and inspection steps run under
  // `memory.correct`, `memory.canonicalize`, `memory.project`, `projection.read`,
  // `memory.read` and `memory.inspect`, named here by server code.
  registerDecisionRoutes(app,deviceWork,{
    purposeWork:<T,>(request:import('fastify').FastifyRequest,purpose:string,run:(tx:import('@unai/postgres').OwnerTransaction)=>Promise<T>)=>
      deviceWork(request,tx=>run(tx),purpose) as Promise<T>,
    evidenceObjects:options.evidenceObjects,registryReleaseId:options.registryReleaseId,
    registryRelease:options.registryRelease??null,...(options.policyPorts?{policyPorts:options.policyPorts}:{}),
    ...(options.transitionContracts?{transitionContracts:options.transitionContracts}:{}),
    ...(options.clock?{now:options.clock}:{})});
  registerControlRoutes(app,deviceWork,{
    ...(options.policyPorts?{policyPorts:options.policyPorts}:{}),
    registryReleaseId:options.registryReleaseId??null,registryRelease:options.registryRelease??null,
    evidenceObjects:options.evidenceObjects});
  registerAuditRoutes(app,deviceWork);
  return app;
}
