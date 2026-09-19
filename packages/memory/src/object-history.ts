import type { MemoryTransaction } from './transaction.js';

export type TemporalObjectType = 'entities' | 'frame_instances' | 'belief_slots' | 'propositions' | 'claims'
  | 'owner_overlay_deltas' | 'resolution_assertions' | 'memory_links' | 'memory_threads' | 'context_spaces';
export type TemporalObjectState = Readonly<Record<string, string | null>>;

/** A missing checkpoint is unknown history, never permission to use today's
 * lifecycle. The journal stores structural metadata only; source authorization
 * and present suppression/deletion must still be checked by the public reader. */
export async function readTemporalObjectStates(tx: MemoryTransaction, input: {
  ownerScopeId: string; objectType: TemporalObjectType; objectIds: readonly string[]; knowledgeTime: Date;
}): Promise<Map<string, TemporalObjectState | null>> {
  const ids = [...new Set(input.objectIds)];
  if (ids.length === 0) return new Map();
  const rows = (await tx.query(`SELECT id,unai_private.object_state_at($1,$2,id,$4) AS state
    FROM unnest($3::uuid[]) AS id`, [input.ownerScopeId, input.objectType, ids, input.knowledgeTime])).rows;
  return new Map(rows.map(row => [row['id'] as string, row['state'] as TemporalObjectState | null]));
}
