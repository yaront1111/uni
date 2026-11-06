import type { MemoryTransaction } from '@unai/memory';
import { readPropositionAuthority, type PropositionAuthority } from './support-authority.js';

/** Refill the result budget after source authority, including derived values.
 * The caller bounds the metadata scan; neither hidden nor empty frames consume
 * the smaller answer budget. No value text is read during this pass. */
export async function readableFrameCandidates(tx: MemoryTransaction, input: {
  ownerScopeId: string; knowledgeTime: Date; frameIds: readonly string[]; limit: number;
  readableEvidenceIds: readonly string[]; withheldObjectIds: ReadonlySet<string>;
  withheldValueIds: ReadonlySet<string>; removedObjectIds: ReadonlySet<string>;
}) {
  const frameIds: string[] = [], withheldFrameIds: string[] = [], authority = new Map<string, PropositionAuthority>();
  let incomplete = false;
  for (let offset = 0; offset < input.frameIds.length; offset += 32) {
    const batch = input.frameIds.slice(offset, offset + 32);
    // One read per RLS table: a fresh owner estimated at one row would otherwise
    // rescan its whole slot partition for every proposition of a direct join.
    const rows = (await tx.query(`WITH candidate_slots AS MATERIALIZED (
        SELECT id,frame_instance_id FROM belief_slots
        WHERE owner_scope_id=$1 AND frame_instance_id=ANY($2::uuid[]) AND created_at<=$3
      ), candidate_propositions AS MATERIALIZED (
        SELECT id,belief_slot_id FROM propositions
        WHERE owner_scope_id=$1 AND belief_slot_id IN (SELECT id FROM candidate_slots) AND created_at<=$3
      )
      SELECT p.id,s.frame_instance_id FROM candidate_propositions p JOIN candidate_slots s ON s.id=p.belief_slot_id
      ORDER BY array_position($2::uuid[],s.frame_instance_id),p.id LIMIT 2049`,
    [input.ownerScopeId, batch, input.knowledgeTime])).rows;
    if (rows.length > 2048) incomplete = true;
    const bounded = rows.slice(0, 2048);
    for (let start = 0; start < bounded.length; start += 128) {
      const proofs = await readPropositionAuthority(tx, { ...input,
        propositionIds: bounded.slice(start, start + 128).map(row => row['id'] as string) });
      for (const [id, proof] of proofs) { authority.set(id, proof); if (proof.incomplete) incomplete = true; }
    }
    const readable = new Set(bounded.filter(row => authority.get(row['id'] as string)?.readable)
      .map(row => row['frame_instance_id'] as string));
    const nonempty = new Set(bounded.map(row => row['frame_instance_id'] as string));
    for (const id of batch) if (readable.has(id)) frameIds.push(id);
    for (const id of batch) if (nonempty.has(id) && !readable.has(id) && withheldFrameIds.length < input.limit) withheldFrameIds.push(id);
    if (frameIds.length > input.limit) { incomplete = true; break; }
  }
  // Bounded redaction placeholders are kept separately from the answer budget.
  return { frameIds: frameIds.slice(0, input.limit), withheldFrameIds, authority, incomplete };
}
