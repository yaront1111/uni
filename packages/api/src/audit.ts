import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {OwnerTransaction} from '@unai/postgres';
import {auditLogQuerySchema,auditLogSchema,publicAuditEventSchema,type AuditLog,type PublicAuditEvent} from '@unai/domain';

type Work=(request:FastifyRequest,run:(tx:OwnerTransaction,sessionId:string)=>Promise<unknown>)=>Promise<unknown>;

/**
 * The Audit log (design route `GET /v1/audit-events`, screen "Audit log"; PRD
 * §30.6; CRT-SEC-07-A; ADR 0032).
 *
 * The log is read under `audit.read`, filtered by object, actor, purpose, kind
 * and time, newest first. The application offers no way to change it: the only
 * other routes on the collection answer an update or a delete with 405
 * `AUDIT_EVENT_IMMUTABLE`, and that refusal is itself appended, so an attempt is
 * visible in the log it tried to change. Underneath, `unai_app` holds no UPDATE,
 * DELETE or TRUNCATE on the table and migration 0027's trigger refuses all three
 * for every role.
 */
export const AUDIT_READ_PURPOSE='audit.read';
export const AUDIT_MODIFY_PURPOSE='audit.modify';
export const AUDIT_LOG_VERSION='audit-log-0.1.0';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_LIMIT=50;
/** The fields an Audit log read discloses about each event it lists. */
const LISTED_FIELDS=['actor','purpose','event_kind','objects_and_fields_accessed','policy_decision','policy_decision_id',
  'model_or_code_version','result','correlation_id','created_at'];

/** The purpose each audit route runs under; null for any other route. */
export function auditPurposeFor(method:string,url:string|undefined):string|null{
  if(url==='/v1/audit-events')return method==='GET'?AUDIT_READ_PURPOSE:AUDIT_MODIFY_PURPOSE;
  if(url==='/v1/audit-events/:id')return AUDIT_MODIFY_PURPOSE;
  return null;
}

function publicEvent(row:Record<string,unknown>):PublicAuditEvent{
  return publicAuditEventSchema.parse({
    auditEventId:row['id'],ownerScopeId:row['owner_scope_id'],actorId:row['actor'],purpose:row['purpose'],
    eventKind:row['event_kind'],objects:row['objects_and_fields_accessed'],policyDecision:row['policy_decision'],
    policyDecisionId:row['policy_decision_id']??null,codeVersion:row['model_or_code_version'],result:row['result'],
    correlationId:row['correlation_id'],createdAt:(row['created_at'] as Date).toISOString(),
  });
}

export function registerAuditRoutes(app:FastifyInstance,work:Work):void{
  app.get('/v1/audit-events',async(request,reply)=>{
    const parsed=auditLogQuerySchema.safeParse(request.query??{});
    if(!parsed.success){
      await work(request,tx=>tx.audit({policyDecision:'DENY',codeVersion:AUDIT_LOG_VERSION,result:'REFUSED',objects:[]}));
      return reply.code(400).send({code:'AUDIT_QUERY_INVALID',correlationId:request.ownerContext!.correlationId});
    }
    const query=parsed.data;
    const limit=query.limit??DEFAULT_LIMIT;
    return work(request,async tx=>{
      // Row-level security already confines the read to this owner; the owner
      // filter here is the application's own statement of the same rule.
      const where=['owner_scope_id=$1'];
      const values:unknown[]=[tx.context.ownerScopeId];
      const add=(clause:(n:number)=>string,value:unknown)=>{values.push(value);where.push(clause(values.length));};
      if(query.objectType!==undefined&&query.objectId!==undefined){
        add(n=>'objects_and_fields_accessed @> $'+n+'::jsonb',JSON.stringify([{type:query.objectType,id:query.objectId}]));
      }
      if(query.actorId!==undefined)add(n=>'actor=$'+n,query.actorId);
      if(query.purpose!==undefined)add(n=>'purpose=$'+n,query.purpose);
      if(query.eventKind!==undefined)add(n=>'event_kind=$'+n,query.eventKind);
      if(query.from!==undefined)add(n=>'created_at>=$'+n,query.from);
      if(query.to!==undefined)add(n=>'created_at<$'+n,query.to);
      if(query.before!==undefined){
        const [at,id]=query.before.split('|');
        values.push(at,id);
        where.push('(created_at,id)<($'+(values.length-1)+'::timestamptz,$'+values.length+'::uuid)');
      }
      values.push(limit+1);
      const rows=(await tx.query(`SELECT id,owner_scope_id,actor,purpose,event_kind,objects_and_fields_accessed,policy_decision,
          policy_decision_id,model_or_code_version,result,correlation_id,created_at,
          to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
        FROM audit_events WHERE ${where.join(' AND ')} ORDER BY created_at DESC,id DESC LIMIT $${values.length}`,values)).rows;
      const page=rows.slice(0,limit);
      const last=page[page.length-1];
      const log:AuditLog=auditLogSchema.parse({
        events:page.map(publicEvent),
        filters:{objectType:query.objectType??null,objectId:query.objectId??null,actorId:query.actorId??null,
          purpose:query.purpose??null,eventKind:query.eventKind??null,from:query.from??null,to:query.to??null},
        nextCursor:rows.length>limit&&last?String(last['cursor_at'])+'|'+String(last['id']):null,
        appendOnly:true,retainsPayload:false,
      });
      // Reading the log is itself a read of these events, and is recorded as one.
      await tx.audit({policyDecision:'ALLOW',codeVersion:AUDIT_LOG_VERSION,result:'SUCCESS',
        objects:log.events.slice(0,100).map(event=>({type:'audit_events',id:event.auditEventId,fields:LISTED_FIELDS}))});
      return log;
    });
  });

  /** No update and no delete, through any method, for any event: refused, and the
   * attempt appended. The event is named only when this owner can see it. */
  async function refuseChange(request:FastifyRequest<{Params:{id?:string}}>,reply:import('fastify').FastifyReply){
    const target=request.params.id;
    await work(request,async tx=>{
      const visible=target!==undefined&&UUID.test(target)
        &&(await tx.query('SELECT 1 FROM audit_events WHERE owner_scope_id=$1 AND id=$2',[tx.context.ownerScopeId,target])).rowCount===1;
      await tx.audit({eventKind:request.method==='DELETE'?'DELETION':'WRITE',policyDecision:'DENY',codeVersion:AUDIT_LOG_VERSION,
        result:'REFUSED',objects:visible?[{type:'audit_events',id:target!,fields:request.method==='DELETE'?['id']:LISTED_FIELDS}]:[]});
    });
    return reply.code(405).header('allow','GET').send({code:'AUDIT_EVENT_IMMUTABLE',correlationId:request.ownerContext!.correlationId});
  }
  for(const method of ['PUT','PATCH','DELETE'] as const){
    app.route<{Params:{id?:string}}>({method,url:'/v1/audit-events/:id',handler:refuseChange});
  }
  for(const method of ['POST','PUT','PATCH','DELETE'] as const){
    app.route<{Params:{id?:string}}>({method,url:'/v1/audit-events',handler:refuseChange});
  }
}
