import { Pool, type PoolClient, type QueryResult } from 'pg';
import { trace, metrics, SpanStatusCode } from '@opentelemetry/api';
import { requestContextSchema, auditEventSchema, auditEventKindFor, type RequestContext, type AuditEvent } from '@unai/domain';

const tracer=trace.getTracer('unai.postgres','0.1.0');
const duration=metrics.getMeter('unai.postgres','0.1.0').createHistogram('unai.database.transaction.duration',{unit:'ms'});

export function createDatabasePool(connectionString:string,ca:string):Pool {
  const url=new URL(connectionString);
  if(!['postgres:','postgresql:'].includes(url.protocol) || url.search || !ca.trim()) {
    throw new Error('DATABASE_TLS_CONFIG_INVALID');
  }
  return new Pool({connectionString,ssl:{ca,rejectUnauthorized:true},max:10,connectionTimeoutMillis:5000,idleTimeoutMillis:30000});
}

export interface OwnerTransaction {
  query(sql:string,values?:unknown[]):Promise<QueryResult>;
  readonly context:RequestContext;
  audit(event:AuditEvent):Promise<string>;
}

/** actorId must originate from the authenticated session, never a request body.
 * The caller's successful material work and its audit receipt commit atomically.
 * Refused/failed operations require a separate audit transaction after rollback.
 */
export async function withOwnerTransaction<T>(pool:Pool, input:RequestContext, run:(tx:OwnerTransaction)=>Promise<T>):Promise<T> {
  const context=Object.freeze(requestContextSchema.parse(input));
  return tracer.startActiveSpan('owner.transaction',async span=>{
    const started=performance.now();
    let client:PoolClient|undefined;
    let inTransaction=false;
    let discard=false;
    let result='FAILURE';
    span.setAttributes({'unai.owner_scope_id':context.ownerScopeId,'unai.correlation_id':context.correlationId,'unai.purpose':context.purpose,'unai.code_version':'0.1.0'});
    try{
      client=await pool.connect();
      const unsafe=(await client.query(`SELECT EXISTS (
        SELECT 1 FROM pg_roles WHERE rolname IN (current_user,session_user) AND (rolsuper OR rolbypassrls)
        UNION ALL
        SELECT 1 FROM pg_class WHERE relkind IN ('r','p') AND relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)
      ) AS unsafe`)).rows[0]?.unsafe;
      if(unsafe!==false) throw new Error('DATABASE_ROLE_UNSAFE');
      await client.query('BEGIN');
      inTransaction=true;
      await client.query(`SELECT set_config('unai.owner_scope_id',$1,true),
        set_config('unai.actor_id',$2,true),set_config('unai.purpose',$3,true),
        set_config('unai.correlation_id',$4,true)`,[context.ownerScopeId,context.actorId,context.purpose,context.correlationId]);
      const membership=await client.query(`SELECT 1 FROM owner_scope_members m
        JOIN users u ON u.id=m.user_id JOIN owner_scopes o ON o.id=m.owner_scope_id
        WHERE m.owner_scope_id=$1 AND m.user_id=$2 AND m.valid_from<=statement_timestamp()
        AND (m.valid_to IS NULL OR m.valid_to>statement_timestamp()) AND u.disabled_at IS NULL AND o.deleted_at IS NULL`,
        [context.ownerScopeId,context.actorId]);
      if(membership.rowCount!==1) throw new Error('OWNER_ACCESS_DENIED');
      const activeClient=client;
      let active=true;
      const tx:OwnerTransaction=Object.freeze({
        context,
        async query(sql:string,values?:unknown[]){
          if(!active)throw new Error('TRANSACTION_CLOSED');
          return activeClient.query(sql,values);
        },
        async audit(inputEvent:AuditEvent):Promise<string>{
          if(!active)throw new Error('TRANSACTION_CLOSED');
          const event=auditEventSchema.parse(inputEvent);
          const receipt=await activeClient.query(`INSERT INTO audit_events
            (owner_scope_id,actor,purpose,event_kind,objects_and_fields_accessed,policy_decision,policy_decision_id,
             model_or_code_version,result,correlation_id)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
            [context.ownerScopeId,context.actorId,context.purpose,event.eventKind??auditEventKindFor(context.purpose),
              JSON.stringify(event.objects),event.policyDecision,event.policyDecisionId??null,event.codeVersion,event.result,context.correlationId]);
          return receipt.rows[0].id as string;
        },
      });
      let value:T;
      try{value=await run(tx);}finally{active=false;}
      const committed=await client.query('COMMIT');
      inTransaction=false;
      // PostgreSQL answers COMMIT with ROLLBACK after a caught statement error.
      // Callback completion is not a durable work/audit receipt.
      if(committed.command!=='COMMIT')throw new Error('TRANSACTION_NOT_COMMITTED');
      result='SUCCESS';
      span.setStatus({code:SpanStatusCode.OK});
      return value;
    }catch(error){
      if(client&&inTransaction){
        try{await client.query('ROLLBACK');}catch{discard=true;}
      }
      // Do not record exceptions: database error text can contain private values.
      span.setStatus({code:SpanStatusCode.ERROR,message:'DATABASE_OPERATION_FAILED'});
      throw error;
    }finally{
      client?.release(discard);
      span.setAttribute('unai.result',result);
      duration.record(performance.now()-started,{result});
      span.end();
    }
  });
}

export { assertOwnershipCoverage, OWNER_SCOPED_TABLES } from './ownership.js';
export { assertDatabaseEncryptionAtRest, ENCRYPTION_AT_REST_SETTING } from './encryption.js';
export { runMigrations } from './migrations.js';


