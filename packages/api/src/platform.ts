import type { Pool } from 'pg';
import { createApiBoundary, type ApiBoundaryOptions } from './index.js';
import { resolveSession, sessionToken, revokeSessions } from '@unai/auth';
import { withOwnerTransaction } from '@unai/postgres';
import { registerDeviceSchema,publicDeviceSchema } from '@unai/domain';
import { randomUUID } from 'node:crypto';
import {registerEvidenceRoutes,type EvidenceObjects} from './evidence.js';
import {registerMemoryGovernorRoutes} from './memory.js';
import {registerCorrectionRoutes,CORRECTION_PURPOSE} from './corrections.js';
import {registerOpsRoutes} from './ops.js';
import {registerProjectionRoutes,PROJECTION_READ_PURPOSE,PROJECTION_HEALTH_PURPOSE} from './projections.js';
import {registerContextRoutes,CONTEXT_READ_PURPOSE,MEMORY_INSPECT_PURPOSE,MEMORY_THREAD_PURPOSE} from './context.js';
import {registerAskRoutes,ASK_PURPOSE} from './ask.js';
import {registerAnswerRoutes,ANSWER_READ_PURPOSE} from './answers.js';
import type {PolicyPorts} from '@unai/belief';
import type {AnswerPhraser} from '@unai/context';

/** The owner's correction controls and their overlay read. One purpose covers
 * both directions of the same surface: the write records the delta and the read
 * answers it back for whichever of the owner's devices asks (PRD §14, §20). */
const CORRECTION_URLS=new Set(['/v1/memory/overlay-deltas','/v1/memory/corrections','/v1/memory/state-changes',
  '/v1/memory/confirmations','/v1/memory/rejections','/v1/memory/keep-uncertain','/v1/memory/suppressions',
  '/v1/memory/archives','/v1/memory/deletions']);

export function createPlatformApi(options:{authPool:Pool;appPool:Pool;tls?:ApiBoundaryOptions['tls'];
  evidenceObjects?:EvidenceObjects;registryReleaseId?:string;registryRelease?:string;
  /** The policy ports the Context Broker evaluates reads through. The local
   * adapters are the default; a deployment that installs Cordum supplies them
   * here and no route changes (PRD §29.4). */
  policyPorts?:PolicyPorts;
  /** The model that phrases Ask answers (`createGatewayAnswerPhraser`). Without
   * one the deterministic composer answers; either way the grounding validator
   * decides what is presented and a manifest is recorded (ADR 0024). */
  answerPhraser?:AnswerPhraser}){
  const purposes=new Set(['device.list','device.register','device.remove','auth.sign_out_all','evidence.ingest','evidence.read','connector.read',
    'memory.govern',CORRECTION_PURPOSE,PROJECTION_READ_PURPOSE,PROJECTION_HEALTH_PURPOSE,
    CONTEXT_READ_PURPOSE,MEMORY_INSPECT_PURPOSE,MEMORY_THREAD_PURPOSE,
    'ops.jobs.read','ops.dead_letter.read','ops.dead_letter.retry','ops.registry.read']);
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
    const expected=request.method==='GET'&&request.routeOptions.url==='/v1/devices'?'device.list':
      request.routeOptions.url==='/v1/devices'?'device.register':
      request.routeOptions.url==='/v1/devices/:id/revoke'?'device.remove':
      request.routeOptions.url==='/v1/sessions/revoke-all'?'auth.sign_out_all':
      request.routeOptions.url==='/v1/evidence'?'evidence.ingest':
      request.routeOptions.url==='/v1/evidence/:id'?'evidence.read':
      request.routeOptions.url==='/v1/connectors/:id'?'connector.read':
      request.routeOptions.url?.startsWith('/v1/memory/transactions')?'memory.govern':
      request.routeOptions.url==='/v1/memory/context'?CONTEXT_READ_PURPOSE:
      request.routeOptions.url==='/v1/ask'?ASK_PURPOSE:
      request.routeOptions.url==='/v1/memory/propositions/:id/explain'?MEMORY_INSPECT_PURPOSE:
      request.routeOptions.url==='/v1/memory/threads/:id'?MEMORY_INSPECT_PURPOSE:
      request.routeOptions.url==='/v1/memory/threads/:id/members'?MEMORY_THREAD_PURPOSE:
      request.routeOptions.url==='/v1/answers/:id/manifest'?ANSWER_READ_PURPOSE:
      request.routeOptions.url==='/v1/answers/reconsideration-candidates'?ANSWER_READ_PURPOSE:
      request.routeOptions.url&&CORRECTION_URLS.has(request.routeOptions.url)?CORRECTION_PURPOSE:
      request.routeOptions.url?.startsWith('/v1/projections/')?PROJECTION_READ_PURPOSE:
      request.routeOptions.url==='/v1/ops/projections'?PROJECTION_HEALTH_PURPOSE:
      request.routeOptions.url==='/v1/ops/jobs'?'ops.jobs.read':
      request.routeOptions.url==='/v1/ops/dead-letter'?'ops.dead_letter.read':
      request.routeOptions.url==='/v1/ops/dead-letter/:id/retry'?'ops.dead_letter.retry':
      request.routeOptions.url==='/v1/ops/registry-snapshot'?'ops.registry.read':null;
    if(!expected||request.ownerContext?.purpose!==expected)return reply.code(403).send({code:'PURPOSE_REFUSED'});
  });
  async function deviceWork(request:import('fastify').FastifyRequest,run:(tx:import('@unai/postgres').OwnerTransaction,sessionId:string)=>Promise<unknown>,
    /** A fixed purpose other than the route's, for the one transaction a route
     * runs on its own behalf -- recording an Ask answer under `answer.record`.
     * The session, owner scope and actor stay the request's. */
    purpose?:string){
    const token=sessionToken(request.headers.cookie);
    const session=token?await resolveSession(options.authPool,token):null;
    if(!session||session.ownerScopeId!==request.ownerContext!.ownerScopeId)throw new Error('SESSION_EXPIRED');
    return withOwnerTransaction(options.appPool,purpose?{...request.ownerContext!,purpose}:request.ownerContext!,async tx=>{
      const live=await tx.query('SELECT id FROM auth_sessions WHERE id=$1 AND revoked_at IS NULL AND expires_at>statement_timestamp() FOR UPDATE',[session.id]);
      if(live.rowCount!==1)throw new Error('SESSION_EXPIRED');
      return run(tx,session.id);
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
  registerMemoryGovernorRoutes(app,deviceWork);
  registerCorrectionRoutes(app,deviceWork,{evidenceObjects:options.evidenceObjects,registryReleaseId:options.registryReleaseId});
  registerOpsRoutes(app,deviceWork);
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
  return app;
}
