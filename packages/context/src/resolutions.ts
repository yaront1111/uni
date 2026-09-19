import { contextResolutionSchema, PARTIAL_OUTCOME_CODES } from '@unai/domain';
import type { MemoryTransaction } from '@unai/memory';

/** Final authority is source-bound before it can close or rank an open concern. */
export async function readableResolutions(tx: MemoryTransaction, input: {
  ownerScopeId: string; frameIds: readonly string[]; knowledgeTime: Date; worldTime: Date;
  readableEvidenceIds: readonly string[]; withheldObjectIds: ReadonlySet<string>; removedObjectIds: ReadonlySet<string>;
}) {
  if (input.frameIds.length === 0) return [];
  const rows = (await tx.query(`SELECT r.id,r.claim_id,a.source_item_id,r.source_frame_instance_id,
      r.target_frame_instance_id,r.outcome_code,r.effective_at,r.transition_contract_id,
      unai_private.object_state_at(r.owner_scope_id,'resolution_assertions',r.id,$3)->>'lifecycle' AS lifecycle
    FROM resolution_assertions r JOIN claims c ON c.owner_scope_id=r.owner_scope_id AND c.id=r.claim_id
    JOIN source_anchors a ON a.owner_scope_id=c.owner_scope_id AND a.id=c.source_anchor_id
    WHERE r.owner_scope_id=$1
      AND (r.source_frame_instance_id=ANY($2::uuid[]) OR r.target_frame_instance_id=ANY($2::uuid[]))
      AND r.recorded_at<=$3 AND c.recorded_at<=$3 AND r.effective_at<=$4
      AND unai_private.object_state_at(r.owner_scope_id,'resolution_assertions',r.id,$3) IS NOT NULL
      AND unai_private.object_state_at(c.owner_scope_id,'claims',c.id,$3) IS NOT NULL
      AND a.source_item_id=ANY($5::uuid[])
    ORDER BY r.effective_at,r.id`, [input.ownerScopeId, [...input.frameIds], input.knowledgeTime,
    input.worldTime, [...input.readableEvidenceIds]])).rows;
  return rows.filter(row => [row['id'], row['claim_id'], row['source_frame_instance_id'], row['target_frame_instance_id']]
    .every(id => id == null || (!input.withheldObjectIds.has(id as string) && !input.removedObjectIds.has(id as string))))
    .map(row => contextResolutionSchema.parse({
      resolutionAssertionId: row['id'], sourceFrameInstanceId: row['source_frame_instance_id'],
      targetFrameInstanceId: row['target_frame_instance_id'] ?? null, outcomeCode: row['outcome_code'],
      effectiveAt: (row['effective_at'] as Date).toISOString(), lifecycle: row['lifecycle'],
      transitionContractId: row['transition_contract_id'], claimId: row['claim_id'], evidenceIds: [row['source_item_id']],
    }));
}

export function closedFrameIds(resolutions: readonly {
  sourceFrameInstanceId: string; lifecycle: string; outcomeCode: string;
}[]): Set<string> {
  const outcomes = new Map<string, Set<string>>();
  for (const value of resolutions) {
    if (value.lifecycle !== 'ACCEPTED' || PARTIAL_OUTCOME_CODES.some(code => code === value.outcomeCode)) continue;
    const codes = outcomes.get(value.sourceFrameInstanceId) ?? new Set<string>();
    codes.add(value.outcomeCode); outcomes.set(value.sourceFrameInstanceId, codes);
  }
  // Partial progress and conflicting final outcomes never silently finish work.
  return new Set([...outcomes].filter(([, codes]) => codes.size === 1).map(([id]) => id));
}
