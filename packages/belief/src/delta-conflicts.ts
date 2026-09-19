import { deltaContestRecordSchema, type DeltaContestRecord } from '@unai/domain';
import { contestOverlayDelta, type MemoryTransaction } from '@unai/memory';

/**
 * Later evidence against a pending owner delta (PRD §21.7; CRT-RYW-05-A; ADR 0024 §6).
 *
 * A delta the owner wrote is visible at once and canonicalized later. When
 * evidence that arrives afterwards contradicts it, the delta becomes CONTESTED --
 * it does not vanish, and it is not rejected on the owner's behalf -- and the row
 * records why: the failure reason, the conflicting evidence, the projections that
 * were reading the delta, the answer manifests whose packets contained it, and
 * whether the owner's attention is required.
 *
 * `contestOverlayDelta` (ADR 0019) is the only write, so the database trigger that
 * refuses any verdict needing the owner still applies.
 */

export const PENDING_DELTA_LIFECYCLES: readonly string[] = Object.freeze([
  'RECEIVED', 'USER_ASSERTED', 'AWAITING_INSTANCE_RESOLUTION', 'CANONICALIZATION_PENDING',
]);

/** Which typed projection a frame's contract feeds (registry release 0.1.0). */
const PROJECTION_OF_FRAME_TYPE: Readonly<Record<string, string>> = Object.freeze({
  'shared.obligation': 'obligations_projection',
  'finance.payment_allocation': 'obligations_projection',
  'shared.commitment': 'open_commitments_projection',
  'shared.event_occurrence': 'schedule_projection',
});
const PROJECTION_FRAME_COLUMN: ReadonlyArray<readonly [string, string]> = Object.freeze([
  ['open_commitments_projection', 'commitment_frame_instance_id'],
  ['obligations_projection', 'obligation_frame_instance_id'],
  ['schedule_projection', 'scheduled_frame_instance_id'],
] as const);

interface DeltaRow {
  readonly id: string;
  readonly deltaKind: string;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly attachedFrameInstanceId: string | null;
  readonly attachedBeliefSlotId: string | null;
  readonly sourceEvidenceId: string;
  readonly createdAt: Date;
}

/** The proposition, slot and frame a delta is about, as far as its target and its
 * attachment say. Any of them may be unknown for an unattached delta. */
async function placeOfDelta(tx: MemoryTransaction, ownerScopeId: string, delta: DeltaRow): Promise<{
  propositionId: string | null; beliefSlotId: string | null; frameInstanceId: string | null;
}> {
  let propositionId: string | null = null;
  let beliefSlotId: string | null = delta.attachedBeliefSlotId;
  let frameInstanceId: string | null = delta.attachedFrameInstanceId;
  if (delta.targetType === 'proposition') propositionId = delta.targetId;
  if (delta.targetType === 'claim' && delta.targetId) {
    propositionId = ((await tx.query('SELECT proposition_id FROM claims WHERE owner_scope_id=$1 AND id=$2',
      [ownerScopeId, delta.targetId])).rows[0]?.['proposition_id'] as string | null | undefined) ?? null;
  }
  if (delta.targetType === 'belief_slot') beliefSlotId ??= delta.targetId;
  if (delta.targetType === 'frame_instance') frameInstanceId ??= delta.targetId;
  if (propositionId) {
    const row = (await tx.query(
      `SELECT p.belief_slot_id,s.frame_instance_id FROM propositions p
       JOIN belief_slots s ON s.owner_scope_id=p.owner_scope_id AND s.id=p.belief_slot_id
       WHERE p.owner_scope_id=$1 AND p.id=$2`, [ownerScopeId, propositionId])).rows[0];
    beliefSlotId ??= (row?.['belief_slot_id'] as string | undefined) ?? null;
    frameInstanceId ??= (row?.['frame_instance_id'] as string | undefined) ?? null;
  }
  if (beliefSlotId && !frameInstanceId) {
    frameInstanceId = ((await tx.query('SELECT frame_instance_id FROM belief_slots WHERE owner_scope_id=$1 AND id=$2',
      [ownerScopeId, beliefSlotId])).rows[0]?.['frame_instance_id'] as string | undefined) ?? null;
  }
  return { propositionId, beliefSlotId, frameInstanceId };
}

/** Every typed projection reading the delta's frame: the ones holding a row for it,
 * and the one its contract feeds even before a row exists. */
async function affectedProjections(tx: MemoryTransaction, ownerScopeId: string, frameInstanceId: string | null): Promise<string[]> {
  if (!frameInstanceId) return [];
  const names = new Set<string>();
  const frameType = (await tx.query('SELECT frame_type_id FROM frame_instances WHERE owner_scope_id=$1 AND id=$2',
    [ownerScopeId, frameInstanceId])).rows[0]?.['frame_type_id'] as string | undefined;
  const mapped = frameType ? PROJECTION_OF_FRAME_TYPE[frameType] : undefined;
  if (mapped) names.add(mapped);
  for (const [table, column] of PROJECTION_FRAME_COLUMN) {
    // A purpose the projection's read policy does not admit sees no row, which
    // narrows this list to the contract's projection and never widens it.
    const held = (await tx.query(`SELECT 1 FROM ${table} WHERE owner_scope_id=$1 AND ${column}=$2 LIMIT 1`,
      [ownerScopeId, frameInstanceId])).rowCount;
    if ((held ?? 0) > 0) names.add(table);
  }
  return [...names].sort();
}

/** The answer manifests whose packets supplied this delta to a model. */
export async function manifestsContainingDelta(tx: MemoryTransaction, ownerScopeId: string, overlayDeltaId: string): Promise<string[]> {
  return (await tx.query(
    `SELECT id FROM answer_manifests WHERE owner_scope_id=$1 AND overlay_delta_ids @> ARRAY[$2::uuid]
     ORDER BY created_at,id`, [ownerScopeId, overlayDeltaId])).rows.map(row => row['id'] as string);
}

async function readDelta(tx: MemoryTransaction, ownerScopeId: string, overlayDeltaId: string): Promise<DeltaRow & { lifecycle: string } | null> {
  const row = (await tx.query(
    `SELECT id,delta_kind,lifecycle,target_object_type,target_object_id,attached_frame_instance_id,
       attached_belief_slot_id,source_evidence_id,created_at
     FROM owner_overlay_deltas WHERE owner_scope_id=$1 AND id=$2`, [ownerScopeId, overlayDeltaId])).rows[0];
  return row ? { ...deltaRow(row), lifecycle: row['lifecycle'] as string } : null;
}

function deltaRow(row: Record<string, unknown>): DeltaRow {
  return {
    id: row['id'] as string, deltaKind: row['delta_kind'] as string,
    targetType: (row['target_object_type'] as string | null) ?? null, targetId: (row['target_object_id'] as string | null) ?? null,
    attachedFrameInstanceId: (row['attached_frame_instance_id'] as string | null) ?? null,
    attachedBeliefSlotId: (row['attached_belief_slot_id'] as string | null) ?? null,
    sourceEvidenceId: row['source_evidence_id'] as string, createdAt: row['created_at'] as Date,
  };
}

/**
 * Contest one delta with its full record (PRD §21.7).
 *
 * The record is assembled here, from the database, rather than trusted from the
 * caller: which projections read the delta and which manifests contained it are
 * facts this transaction can see, so a caller can neither omit nor invent them.
 */
export async function recordDeltaContest(tx: MemoryTransaction, input: {
  ownerScopeId: string; overlayDeltaId: string; failureReason: string; conflictingEvidenceIds: readonly string[];
}): Promise<{ lifecycle: string; record: DeltaContestRecord }> {
  const delta = await readDelta(tx, input.ownerScopeId, input.overlayDeltaId);
  if (!delta) throw new Error('OVERLAY_DELTA_NOT_FOUND');
  const place = await placeOfDelta(tx, input.ownerScopeId, delta);
  const record = deltaContestRecordSchema.parse({
    failureReason: input.failureReason,
    conflictingEvidenceIds: [...new Set(input.conflictingEvidenceIds)].sort(),
    affectedProjections: await affectedProjections(tx, input.ownerScopeId, place.frameInstanceId),
    containingManifestIds: await manifestsContainingDelta(tx, input.ownerScopeId, input.overlayDeltaId),
    // The owner's own word is now contradicted by a source: that is exactly what
    // the owner has to see, and nothing but the owner may settle it (CRT-MEM-15-A).
    userAttentionRequired: true,
  });
  const contested = await contestOverlayDelta(tx, {
    ownerScopeId: input.ownerScopeId, overlayDeltaId: input.overlayDeltaId, reason: record,
  });
  return { lifecycle: contested.lifecycle, record };
}

/**
 * Find the pending deltas that claims just written contradict, and contest each.
 *
 * A claim conflicts with a pending delta when it rests on evidence other than the
 * delta's own, was recorded after the delta, and either
 *
 *  - re-asserts the proposition the owner corrected or rejected
 *    (`LATER_EVIDENCE_REASSERTS_CORRECTED_VALUE`), or
 *  - asserts a different value in the slot of the proposition the owner asserted
 *    or confirmed (`LATER_EVIDENCE_ASSERTS_COMPETING_VALUE`).
 *
 * Runs inside the governor's commit, so the contest commits or rolls back with
 * the claims that caused it.
 */
export async function contestDeltasConflictingWithClaims(tx: MemoryTransaction, input: {
  ownerScopeId: string; claimIds: readonly string[];
}): Promise<Array<{ overlayDeltaId: string; failureReason: string; record: DeltaContestRecord }>> {
  if (input.claimIds.length === 0) return [];
  const claims = (await tx.query(
    `SELECT c.id,c.proposition_id,c.recorded_at,p.belief_slot_id,a.source_item_id
     FROM claims c
     JOIN propositions p ON p.owner_scope_id=c.owner_scope_id AND p.id=c.proposition_id
     JOIN source_anchors a ON a.owner_scope_id=c.owner_scope_id AND a.id=c.source_anchor_id
     WHERE c.owner_scope_id=$1 AND c.id=ANY($2::uuid[]) AND c.lifecycle NOT IN ('REJECTED','SUPPRESSED')
     ORDER BY c.id`, [input.ownerScopeId, [...input.claimIds]])).rows.map(row => ({
    propositionId: row['proposition_id'] as string, beliefSlotId: row['belief_slot_id'] as string,
    recordedAt: row['recorded_at'] as Date, evidenceId: row['source_item_id'] as string,
  }));
  if (claims.length === 0) return [];
  const pending = (await tx.query(
    `SELECT id,delta_kind,target_object_type,target_object_id,attached_frame_instance_id,attached_belief_slot_id,
       source_evidence_id,created_at
     FROM owner_overlay_deltas WHERE owner_scope_id=$1 AND lifecycle=ANY($2::text[]) ORDER BY owner_sequence`,
    [input.ownerScopeId, [...PENDING_DELTA_LIFECYCLES]])).rows.map(deltaRow);

  const contested: Array<{ overlayDeltaId: string; failureReason: string; record: DeltaContestRecord }> = [];
  for (const delta of pending) {
    const place = await placeOfDelta(tx, input.ownerScopeId, delta);
    if (!place.propositionId) continue;
    const later = claims.filter(claim => claim.evidenceId !== delta.sourceEvidenceId
      && claim.recordedAt.getTime() >= delta.createdAt.getTime());
    const corrective = delta.deltaKind === 'USER_CORRECTION' || delta.deltaKind === 'USER_REJECTION';
    const affirmative = delta.deltaKind === 'USER_ASSERTION' || delta.deltaKind === 'USER_CONFIRMATION';
    const reasserting = corrective ? later.filter(claim => claim.propositionId === place.propositionId) : [];
    const competing = affirmative
      ? later.filter(claim => claim.beliefSlotId === place.beliefSlotId && claim.propositionId !== place.propositionId) : [];
    const conflicting = reasserting.length > 0 ? reasserting : competing;
    if (conflicting.length === 0) continue;
    const failureReason = reasserting.length > 0 ? 'LATER_EVIDENCE_REASSERTS_CORRECTED_VALUE' : 'LATER_EVIDENCE_ASSERTS_COMPETING_VALUE';
    const { record } = await recordDeltaContest(tx, {
      ownerScopeId: input.ownerScopeId, overlayDeltaId: delta.id, failureReason,
      conflictingEvidenceIds: conflicting.map(claim => claim.evidenceId),
    });
    contested.push({ overlayDeltaId: delta.id, failureReason, record });
  }
  return contested;
}
