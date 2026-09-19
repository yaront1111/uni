import {
  INDEPENDENT_CLAIM_ORIGINS, memoryOperationKindSchema, memoryObjectTypeSchema, ownerOverlaySchema,
  overlayDeltaKindSchema, overlayLifecycleSchema, publicOverlayDeltaSchema, targetObjectRefSchema,
  type MemoryOperationKind, type OverlayDeltaKind, type OverlayLifecycle, type OwnerOverlay,
  type PublicOverlayDelta, type TargetObjectRef,
} from '@unai/domain';
import { uuidV7 } from '../../../src/kernel/identities.js';
import { MemoryStoreError, type MemoryTransaction } from './transaction.js';

/** Owner read-your-writes: the sequence allocator, the overlay delta store and
 * the memory operation record (PRD §14, §20; design entities `owner_sequences`,
 * `owner_overlay_deltas`, `memory_operations`).
 *
 * The point of this file is that an owner's write is observable before anything
 * canonical exists. A delta is scoped to the owner, never to the device that
 * wrote it, so the phone's acknowledged write is in the desktop's next read
 * (CRT-RYW-02-A) and an acknowledged suppression or deletion is honoured by that
 * read too (CRT-RYW-02-B).
 *
 * As everywhere in this package, every function takes a `MemoryTransaction` the
 * caller already opened inside the owner boundary. Nothing here opens a
 * connection, commits, audits, or decides an accepted belief: proposing the
 * belief transaction that would is the caller's step, and it goes through
 * `@unai/belief` like every other governed write.
 */

export const OVERLAY_VERSION = 'owner-overlay-0.1.0';

const SUPPRESSING_KINDS: Readonly<Record<string, 'suppressed' | 'archived' | 'deleted'>> = Object.freeze({
  SUPPRESSION: 'suppressed', ARCHIVE: 'archived', DELETION: 'deleted',
});

export interface RecordOverlayDeltaInput {
  readonly ownerScopeId: string;
  readonly deltaKind: OverlayDeltaKind;
  readonly rawText: string;
  readonly sourceEvidenceId: string;
  readonly lifecycle?: OverlayLifecycle;
  readonly target?: TargetObjectRef | null;
  readonly sourceDeviceId?: string | null;
  readonly sourceSessionId?: string | null;
  readonly candidateEntityRefs?: readonly string[];
  readonly candidateWorldlineRefs?: readonly string[];
  readonly candidateFrameTypes?: readonly string[];
  readonly discourseAnchor?: string | null;
  readonly temporalHints?: Record<string, unknown>;
}

export interface RecordedOverlayDelta {
  readonly overlayDeltaId: string;
  readonly ownerSequence: number;
  readonly lifecycle: OverlayLifecycle;
}

/**
 * Allocate this owner's next sequence number (CRT-RYW-01-A).
 *
 * The number is handed out by the database inside the caller's transaction, so
 * two devices writing at the same time block on the same `owner_sequences` row:
 * each receives a distinct number, and the numbers increase in the order the
 * transactions commit rather than the order they started. A caller that invents
 * a number instead of calling this is refused by the unique index on
 * `(owner_scope_id, owner_sequence)`.
 */
export async function allocateOwnerSequence(tx: MemoryTransaction, ownerScopeId: string): Promise<number> {
  const row = (await tx.query('SELECT unai_private.allocate_owner_sequence($1) AS owner_sequence', [ownerScopeId])).rows[0];
  const allocated = row?.['owner_sequence'];
  // bigint arrives as a string from node-postgres; an owner sequence past
  // 2^53 is not reachable in this system, and a silent precision loss would be
  // worse than a refusal if it ever were.
  const sequence = typeof allocated === 'string' ? Number(allocated) : (allocated as number);
  if (!Number.isSafeInteger(sequence) || sequence <= 0) throw new MemoryStoreError('OWNER_SEQUENCE_UNAVAILABLE');
  return sequence;
}

/**
 * Record one overlay delta with a freshly allocated owner sequence.
 *
 * The default lifecycle is `RECEIVED`: the write is durable and owner-visible,
 * which is exactly what the acknowledgement promises, and no claim is made about
 * canonicalization that has not happened.
 */
export async function recordOverlayDelta(tx: MemoryTransaction, input: RecordOverlayDeltaInput): Promise<RecordedOverlayDelta> {
  const deltaKind = overlayDeltaKindSchema.parse(input.deltaKind);
  const lifecycle = overlayLifecycleSchema.parse(input.lifecycle ?? 'RECEIVED');
  const target = input.target ? targetObjectRefSchema.parse(input.target) : null;
  const ownerSequence = await allocateOwnerSequence(tx, input.ownerScopeId);
  const overlayDeltaId = uuidV7();
  await tx.query(
    `INSERT INTO owner_overlay_deltas(id,owner_scope_id,owner_sequence,source_session_id,source_device_id,
      source_evidence_id,raw_text,delta_kind,lifecycle,target_object_type,target_object_id,candidate_entity_refs,
      candidate_worldline_refs,candidate_frame_types,discourse_anchor,temporal_hints)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [overlayDeltaId, input.ownerScopeId, ownerSequence, input.sourceSessionId ?? null, input.sourceDeviceId ?? null,
      input.sourceEvidenceId, input.rawText, deltaKind, lifecycle, target?.objectType ?? null, target?.objectId ?? null,
      [...(input.candidateEntityRefs ?? [])], [...(input.candidateWorldlineRefs ?? [])],
      [...(input.candidateFrameTypes ?? [])], input.discourseAnchor ?? null,
      JSON.stringify(input.temporalHints ?? {})]);
  return { overlayDeltaId, ownerSequence, lifecycle };
}

/** Bind a delta to the transaction that took it up, and to the canonical objects
 * it turned out to be about. Nothing else on the row may move: the schema trigger
 * refuses a change to the kind, the text, the evidence or the target. */
export async function attachOverlayDelta(tx: MemoryTransaction, input: {
  ownerScopeId: string; overlayDeltaId: string; lifecycle?: OverlayLifecycle;
  attachedFrameInstanceId?: string | null; attachedBeliefSlotId?: string | null; resolvedByTransactionId?: string | null;
}): Promise<void> {
  const changed = await tx.query(
    `UPDATE owner_overlay_deltas SET lifecycle=coalesce($3,lifecycle),
      attached_frame_instance_id=coalesce($4,attached_frame_instance_id),
      attached_belief_slot_id=coalesce($5,attached_belief_slot_id),
      resolved_by_transaction_id=coalesce($6,resolved_by_transaction_id)
     WHERE owner_scope_id=$1 AND id=$2 RETURNING id`,
    [input.ownerScopeId, input.overlayDeltaId, input.lifecycle ? overlayLifecycleSchema.parse(input.lifecycle) : null,
      input.attachedFrameInstanceId ?? null, input.attachedBeliefSlotId ?? null, input.resolvedByTransactionId ?? null]);
  if (changed.rowCount !== 1) throw new MemoryStoreError('OVERLAY_DELTA_NOT_FOUND');
}

export interface ContestedReason {
  readonly failureReason: string;
  readonly conflictingEvidenceIds?: readonly string[];
  readonly affectedProjections?: readonly string[];
  readonly containingManifestIds?: readonly string[];
  /** PRD §21.7: whether the owner has to look at it. */
  readonly userAttentionRequired?: boolean;
}

/**
 * Mark a delta CONTESTED, and no further (CRT-MEM-15-A, CRT-RYW-05-A).
 *
 * This is the whole write path a re-extraction has over a delta the owner
 * confirmed or corrected. The row still exists afterwards and still says what the
 * owner said; what changed is that the kernel now records a conflict against it,
 * with the failure reason, the conflicting evidence, the affected projections and
 * the manifests that contained it. Moving a delta to REJECTED_AS_INTERPRETATION,
 * SUPERSEDED or WITHDRAWN is a user action, refused here and refused again by the
 * database for any principal that tries it under another purpose.
 */
export async function contestOverlayDelta(tx: MemoryTransaction, input: {
  ownerScopeId: string; overlayDeltaId: string; reason: ContestedReason;
}): Promise<{ lifecycle: OverlayLifecycle }> {
  const current = (await tx.query(
    'SELECT lifecycle FROM owner_overlay_deltas WHERE owner_scope_id=$1 AND id=$2',
    [input.ownerScopeId, input.overlayDeltaId])).rows[0];
  if (!current) throw new MemoryStoreError('OVERLAY_DELTA_NOT_FOUND');
  // A delta the owner already withdrew, or that a user action already settled, is
  // not re-opened by later evidence: contesting is only ever an escalation from a
  // live lifecycle.
  const lifecycle = current['lifecycle'] as OverlayLifecycle;
  if (lifecycle === 'REJECTED_AS_INTERPRETATION' || lifecycle === 'WITHDRAWN' || lifecycle === 'SUPERSEDED') {
    return { lifecycle };
  }
  // A policy that filters the row out answers zero rows rather than an error, so
  // the write is checked: reporting a contest that did not happen would leave the
  // conflict invisible exactly where CRT-RYW-05-A requires it recorded.
  const changed = await tx.query(
    `UPDATE owner_overlay_deltas SET lifecycle='CONTESTED',contested_reason=$3 WHERE owner_scope_id=$1 AND id=$2
     RETURNING id`,
    [input.ownerScopeId, input.overlayDeltaId, JSON.stringify({
      failureReason: input.reason.failureReason,
      conflictingEvidenceIds: [...(input.reason.conflictingEvidenceIds ?? [])],
      affectedProjections: [...(input.reason.affectedProjections ?? [])],
      containingManifestIds: [...(input.reason.containingManifestIds ?? [])],
      userAttentionRequired: input.reason.userAttentionRequired ?? true,
      overlayVersion: OVERLAY_VERSION,
    })]);
  if (changed.rowCount !== 1) throw new MemoryStoreError('OVERLAY_DELTA_NOT_CONTESTABLE');
  return { lifecycle: 'CONTESTED' };
}

/** Record which correction control the owner used, on what, and what it produced
 * (PRD §20.2). Ten distinct kinds; there is no generic edit. */
export async function recordMemoryOperation(tx: MemoryTransaction, input: {
  ownerScopeId: string; operationKind: MemoryOperationKind; target: TargetObjectRef; evidenceId: string;
  requestedByActorId: string; overlayDeltaId?: string | null; transactionId?: string | null;
  detail?: Record<string, unknown>;
}): Promise<string> {
  const target = targetObjectRefSchema.parse(input.target);
  const id = uuidV7();
  await tx.query(
    `INSERT INTO memory_operations(id,owner_scope_id,operation_kind,target_object_type,target_object_id,
      overlay_delta_id,evidence_id,transaction_id,requested_by_actor_id,detail)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id, input.ownerScopeId, memoryOperationKindSchema.parse(input.operationKind), target.objectType, target.objectId,
      input.overlayDeltaId ?? null, input.evidenceId, input.transactionId ?? null, input.requestedByActorId,
      JSON.stringify(input.detail ?? {})]);
  return id;
}

/** Every operation recorded against one object, newest last. The Correction
 * controls screen reads this to show what each control already did. */
export async function listMemoryOperations(tx: MemoryTransaction, input: {
  ownerScopeId: string; target?: TargetObjectRef;
}): Promise<Array<{ memoryOperationId: string; operationKind: MemoryOperationKind; target: TargetObjectRef;
  evidenceId: string; overlayDeltaId: string | null; transactionId: string | null; createdAt: string }>> {
  const target = input.target ? targetObjectRefSchema.parse(input.target) : null;
  const rows = (await tx.query(
    `SELECT id,operation_kind,target_object_type,target_object_id,evidence_id,overlay_delta_id,transaction_id,created_at
     FROM memory_operations WHERE owner_scope_id=$1
       AND ($2::text IS NULL OR target_object_type=$2) AND ($3::uuid IS NULL OR target_object_id=$3)
     ORDER BY created_at,id`,
    [input.ownerScopeId, target?.objectType ?? null, target?.objectId ?? null])).rows;
  return rows.map(row => ({
    memoryOperationId: row['id'] as string,
    operationKind: row['operation_kind'] as MemoryOperationKind,
    target: { objectType: memoryObjectTypeSchema.parse(row['target_object_type']), objectId: row['target_object_id'] as string },
    evidenceId: row['evidence_id'] as string,
    overlayDeltaId: (row['overlay_delta_id'] as string | null) ?? null,
    transactionId: (row['transaction_id'] as string | null) ?? null,
    createdAt: (row['created_at'] as Date).toISOString(),
  }));
}

/** The proposition a target names, so independent support can be looked for in
 * one place whether the owner pointed at a claim or at the proposition itself. */
async function propositionOfTarget(tx: MemoryTransaction, ownerScopeId: string, target: TargetObjectRef): Promise<string | null> {
  if (target.objectType === 'proposition') return target.objectId;
  if (target.objectType === 'claim') {
    const row = (await tx.query('SELECT proposition_id FROM claims WHERE owner_scope_id=$1 AND id=$2',
      [ownerScopeId, target.objectId])).rows[0];
    return (row?.['proposition_id'] as string | null) ?? null;
  }
  return null;
}

/** What supports the delta's target other than the owner's own words behind it.
 * Repetition of the owner's statement, and any model reading of it, is not
 * verification (PRD §15.4), so only the four non-owner, non-model origins count
 * and the delta's own evidence is excluded whatever origin it carries. */
async function independentVerification(
  tx: MemoryTransaction, ownerScopeId: string, sourceEvidenceId: string, target: TargetObjectRef | null,
  bounds: { knowledgeTime?: Date; readableEvidenceIds?: readonly string[] } = {},
): Promise<PublicOverlayDelta['independentVerification']> {
  const empty = { verified: false, independentEvidenceIds: [], independentClaimOrigins: [] };
  if (!target) return empty;
  const propositionId = await propositionOfTarget(tx, ownerScopeId, target);
  if (!propositionId) return empty;
  const rows = (await tx.query(
    `SELECT DISTINCT s.id AS evidence_id,c.claim_origin FROM claims c
     JOIN source_anchors a ON a.owner_scope_id=c.owner_scope_id AND a.id=c.source_anchor_id
     JOIN source_items s ON s.owner_scope_id=a.owner_scope_id AND s.id=a.source_item_id
     WHERE c.owner_scope_id=$1 AND c.proposition_id=$2 AND s.id<>$3
       AND c.claim_origin=ANY($4::text[]) AND c.lifecycle<>'REJECTED'
       AND ($5::timestamptz IS NULL OR c.recorded_at<=$5)
       AND ($6::uuid[] IS NULL OR s.id=ANY($6::uuid[]))`,
    [ownerScopeId, propositionId, sourceEvidenceId, [...INDEPENDENT_CLAIM_ORIGINS],
      bounds.knowledgeTime ?? null, bounds.readableEvidenceIds ?? null])).rows;
  return {
    verified: rows.length > 0,
    independentEvidenceIds: [...new Set(rows.map(row => row['evidence_id'] as string))],
    independentClaimOrigins: [...new Set(rows.map(row => row['claim_origin'] as typeof INDEPENDENT_CLAIM_ORIGINS[number]))].sort(),
  };
}

/**
 * Read this owner's overlay (CRT-RYW-02-A, CRT-RYW-02-B).
 *
 * The read is by owner scope alone. Whichever device asks, it sees every delta
 * any of the owner's devices wrote, in allocation order, and the watermark of the
 * last one. Suppressed, archived and deleted targets are listed separately so a
 * caller can honour them without having to re-derive the lifecycle rules: the
 * next read from another device therefore honours the phone's suppression or
 * deletion whether or not a belief transaction has committed yet.
 *
 * Every returned delta says both things CRT-RYW-02-A asks an answer to
 * distinguish: that the owner asserted it, and what -- if anything -- verifies it
 * independently of the owner.
 */
export async function readOwnerOverlay(tx: MemoryTransaction, input: {
  ownerScopeId: string; sinceSequence?: number; limit?: number;
  /** Broker reads additionally bind pending assertions and their verification
   * to the request's knowledge time and source authorization. Owner correction
   * reads omit these bounds and retain their owner-wide immediate visibility. */
  knowledgeTime?: Date; readableEvidenceIds?: readonly string[];
}): Promise<OwnerOverlay> {
  const since = input.sinceSequence ?? 0;
  const limit = Math.min(Math.max(input.limit ?? 500, 1), 1000);
  const rows = (await tx.query(
    `SELECT id,owner_sequence,delta_kind,lifecycle,raw_text,target_object_type,target_object_id,source_evidence_id,
      attached_frame_instance_id,attached_belief_slot_id,candidate_entity_refs,candidate_frame_types,discourse_anchor,
      created_at,contested_reason
     FROM owner_overlay_deltas WHERE owner_scope_id=$1 AND owner_sequence>$2
       AND ($4::timestamptz IS NULL OR created_at<=$4)
       AND ($5::uuid[] IS NULL OR source_evidence_id=ANY($5::uuid[]))
     ORDER BY owner_sequence LIMIT $3`,
    [input.ownerScopeId, since, limit, input.knowledgeTime ?? null, input.readableEvidenceIds ?? null])).rows;

  const deltas: PublicOverlayDelta[] = [];
  const removed: Record<'suppressed' | 'archived' | 'deleted', TargetObjectRef[]> = { suppressed: [], archived: [], deleted: [] };
  let watermark = since;
  for (const row of rows) {
    const sequence = Number(row['owner_sequence']);
    watermark = Math.max(watermark, sequence);
    const target: TargetObjectRef | null = row['target_object_type']
      ? { objectType: memoryObjectTypeSchema.parse(row['target_object_type']), objectId: row['target_object_id'] as string }
      : null;
    const kind = row['delta_kind'] as OverlayDeltaKind;
    const lifecycle = row['lifecycle'] as OverlayLifecycle;
    // A delta the owner withdrew, or that was rejected as an interpretation, no
    // longer removes anything from view; one that is merely CONTESTED still does,
    // because contesting is not a user action (CRT-MEM-15-A).
    const live = lifecycle !== 'WITHDRAWN' && lifecycle !== 'REJECTED_AS_INTERPRETATION';
    const bucket = SUPPRESSING_KINDS[kind];
    if (bucket && target && live) removed[bucket].push(target);
    deltas.push(publicOverlayDeltaSchema.parse({
      overlayDeltaId: row['id'], ownerSequence: sequence, deltaKind: kind, lifecycle,
      rawText: row['raw_text'], target, sourceEvidenceId: row['source_evidence_id'],
      attachedFrameInstanceId: (row['attached_frame_instance_id'] as string | null) ?? null,
      attachedBeliefSlotId: (row['attached_belief_slot_id'] as string | null) ?? null,
      candidateEntityRefs: [...(row['candidate_entity_refs'] as string[])],
      candidateFrameTypes: [...(row['candidate_frame_types'] as string[])],
      discourseAnchor: (row['discourse_anchor'] as string | null) ?? null,
      createdAt: (row['created_at'] as Date).toISOString(),
      contestedReason: (row['contested_reason'] as Record<string, unknown> | null) ?? null,
      assertionKind: 'USER_ASSERTION',
      independentVerification: await independentVerification(tx, input.ownerScopeId, row['source_evidence_id'] as string, target, input),
    }));
  }
  return ownerOverlaySchema.parse({
    ownerOverlayWatermark: watermark, deltas,
    suppressedTargets: removed.suppressed, archivedTargets: removed.archived, deletedTargets: removed.deleted,
  });
}

/** True when the owner's overlay has removed this object from normal retrieval.
 * A reader that filters with this honours an acknowledged suppression, archive or
 * deletion from any of the owner's devices (CRT-RYW-02-B). */
export function isOverlayRemoved(overlay: OwnerOverlay, target: TargetObjectRef): boolean {
  return [...overlay.suppressedTargets, ...overlay.archivedTargets, ...overlay.deletedTargets]
    .some(removed => removed.objectType === target.objectType && removed.objectId === target.objectId);
}
