import {auditLogSchema,type AuditLog,type PublicAuditEvent} from '@unai/domain';

/** Audit log screen data for the component and accessibility tests: one event of
 * each kind, a refused change attempt and a deletion. Test data only; no page
 * imports it. */
const id=(n:number)=>'0192f3a0-0000-7000-8000-'+String(n).padStart(12,'0');
export const AUDIT_ACTOR=id(1);
export const AUDIT_OWNER=id(2);
const at=(minute:number)=>'2026-09-19T10:'+String(minute).padStart(2,'0')+':00.000Z';
function event(n:number,over:Partial<PublicAuditEvent>):PublicAuditEvent{
  return {auditEventId:id(100+n),ownerScopeId:AUDIT_OWNER,actorId:AUDIT_ACTOR,purpose:'evidence.read',eventKind:'READ',
    objects:[{type:'source_items',id:id(500),fields:['content_hash','sensitivity']}],policyDecision:'ALLOW',policyDecisionId:null,
    codeVersion:'0.1.0',result:'SUCCESS',correlationId:id(900+n),createdAt:at(59-n),...over};
}
export const AUDIT_EVENTS:PublicAuditEvent[]=[
  event(1,{purpose:'audit.modify',eventKind:'DELETION',policyDecision:'DENY',result:'REFUSED',codeVersion:'audit-log-0.1.0',
    objects:[{type:'audit_events',id:id(104),fields:['id']}]}),
  event(2,{purpose:'memory.project',eventKind:'PROJECTION_REBUILD',codeVersion:'projection-reducers-0.1.0',
    objects:[{type:'projection_rebuild_receipts',id:id(600),fields:['projection_name','rows_rebuilt']}]}),
  event(3,{purpose:'data.delete',eventKind:'DELETION',objects:[{type:'source_items',id:id(500),fields:['deleted_at']}]}),
  event(4,{purpose:'data.export',eventKind:'EXPORT',objects:[{type:'retention_and_deletion_requests',id:id(700),fields:['request_kind']}]}),
  event(5,{purpose:'action.execute',eventKind:'EXTERNAL_ACTION',policyDecision:'DENY',result:'REFUSED',policyDecisionId:id(800),objects:[]}),
  event(6,{}),
  event(7,{purpose:'evidence.ingest',eventKind:'WRITE',actorId:id(3)}),
];
export function auditLog(over:Partial<AuditLog>={}):AuditLog{
  return auditLogSchema.parse({events:AUDIT_EVENTS,
    filters:{objectType:null,objectId:null,actorId:null,purpose:null,eventKind:null,from:null,to:null},
    nextCursor:'2026-09-19T10:52:00.000000Z|'+id(107),appendOnly:true,retainsPayload:false,...over});
}
export const AUDIT_OBJECT={type:'source_items',id:id(500)};
