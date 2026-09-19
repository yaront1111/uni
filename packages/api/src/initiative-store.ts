import { initiativeSettingsSchema, initiativeWatchSchema, initiativeNoticeSchema, type InitiativeSettings } from '@unai/domain';
import type { OwnerTransaction } from '@unai/postgres';

export const NOTICE_TEXT = 'A scheduled item is approaching or overdue, and its linked prerequisite remains unresolved.' as const;
export const GENERIC_REQUEST = 'Please share the item needed for our upcoming commitment. Thank you.';
export function settingsOf(row?: Record<string,any>): InitiativeSettings {
  return initiativeSettingsSchema.parse(row ? { enabled:row.enabled,timeZone:row.time_zone,localTime:row.local_time,
    dataPurpose:row.data_purpose,maximumSensitivity:row.maximum_sensitivity,prepareDrafts:row.prepare_drafts,
    nextDueAt:row.next_due_at?.toISOString()??null,revision:row.revision } : {
    enabled:false,timeZone:'UTC',localTime:'09:00',dataPurpose:'PERSONAL_ASSISTANCE',maximumSensitivity:'NORMAL',prepareDrafts:false,nextDueAt:null,revision:0,
  });
}
export function watchOf(row:Record<string,any>) {
  return initiativeWatchSchema.parse({watchId:row.id,sourceEvidenceId:row.source_item_id,scheduledFrameId:row.scheduled_frame_id,
    prerequisiteFrameId:row.prerequisite_frame_id,enabled:row.enabled,snoozedUntil:row.snoozed_until?.toISOString()??null,createdAt:row.created_at.toISOString()});
}
export function noticeOf(row:Record<string,any>) {
  return initiativeNoticeSchema.parse({noticeId:row.id,watchId:row.watch_id,threshold:row.threshold,message:NOTICE_TEXT,
    sourceEvidenceIds:row.source_evidence_ids,draftId:row.draft_id,preparation:row.preparation,
    ownerLocalDate:row.owner_local_date instanceof Date?row.owner_local_date.toISOString().slice(0,10):row.owner_local_date,
    createdAt:row.created_at.toISOString()});
}
export async function readInitiativeSettings(tx:OwnerTransaction) {
  return settingsOf((await tx.query('SELECT * FROM initiative_settings WHERE owner_scope_id=$1',[tx.context.ownerScopeId])).rows[0]);
}
export async function initiativeSourceGate(tx:OwnerTransaction,purpose:string,maximum:string) {
  await tx.query("SELECT set_config('unai.data_purpose',$1,true),set_config('unai.maximum_sensitivity',$2,true)",[purpose,maximum]);
}

/** Metadata-only wake signal. Source RLS is applied before counting; completing
 * processing can wake a watch without changing the original source timestamp. */
export async function inputMarker(tx:OwnerTransaction):Promise<string> {
  const row=(await tx.query(`SELECT count(*)::text AS count,max(s.observed_at)::text AS observed,max(p.completed_at)::text AS processed
    FROM source_items s LEFT JOIN evidence_processing p ON p.owner_scope_id=s.owner_scope_id AND p.source_item_id=s.id
    WHERE s.owner_scope_id=$1 AND s.actor_ref->>'type'<>'ASSISTANT'`,[tx.context.ownerScopeId])).rows[0];
  return JSON.stringify([row.count,row.observed,row.processed]);
}
