import { createHash } from 'node:crypto';
import {
  SUPPLIED_CONTEXT_STATEMENT, contextPacketSchema, groundingResultSchema, publicAnswerManifestSchema,
  reconsiderationCandidatesViewSchema, suppliedContextSchema,
  type ContextPacket, type GroundingResult, type PublicAnswerManifest, type ReconsiderationCandidatesView,
  type ReconsiderationChange, type SuppliedContext,
} from '@unai/domain';
import { canonicalJson, type MemoryTransaction } from '@unai/memory';
import { uuidV7 } from '../../../src/kernel/identities.js';
import { ContextBrokerError } from './broker.js';

/**
 * The answer manifest store (PRD §23.6, §23.7; design entities `answer_manifests`
 * and `reconsideration_candidates`; CRT-RD-06-A, CRT-RD-07-A, CRT-RD-11-A;
 * ADR 0025 §1, §2, §5).
 *
 * A manifest is a record of the context *supplied* to a model for one answer. It
 * is derived from the packet as persisted -- read back from `context_packets` and
 * checked against its stored hash -- so it can only ever list what that packet
 * held, and no field of it says which item the model used.
 */

export const MANIFEST_VERSION = 'answer-manifest-0.1.0';
/** The purpose an answer is recorded under. It is never a request purpose. */
export const ANSWER_RECORD_PURPOSE = 'answer.record';

const sorted = (ids: Iterable<string | null | undefined>): string[] =>
  [...new Set([...ids].filter((id): id is string => typeof id === 'string'))].sort();

/** A target reference's object type, as the overlay records it, to the set it
 * belongs in. Anything else (an entity, a frame instance) is none of the four. */
const TARGET_SET: Readonly<Record<string, 'belief' | 'claim' | 'evidence' | 'overlay'>> = Object.freeze({
  proposition: 'belief', claim: 'claim', source_item: 'evidence', owner_overlay_delta: 'overlay',
});

/**
 * The sets one packet supplied (ADR 0025 §1). Pure: the same packet gives the same
 * sets, each sorted and holding every id once.
 *
 * "Supplied" means named anywhere in the packet body a model reads -- a stated
 * value, a conflict position, a selection's kept, excluded or competing
 * proposition, an applied correction, a semantic match, an overlay delta's
 * target, a projection's pending assertion. PRD §23.6 allows the manifest to
 * over-approximate; it never under-approximates. Left out is only what the packet
 * names as *not* supplied: its redactions and unknowns, an object it withheld
 * whole, and what the selector's read-policy step excluded.
 */
export function suppliedContextOf(packet: ContextPacket, options: { registryReleaseId: string | null }): SuppliedContext {
  const beliefs: Array<string | null> = [], claims: string[] = [], evidence: string[] = [], overlay: string[] = [];
  const target = (ref: { objectType: string; objectId: string } | null) => {
    const set = ref ? TARGET_SET[ref.objectType] : undefined;
    if (!ref || !set) return;
    ({ belief: beliefs, claim: claims, evidence, overlay } as const)[set].push(ref.objectId);
  };
  for (const belief of [...packet.currentBeliefs, ...packet.historicalBeliefs]) {
    beliefs.push(belief.propositionId);
    claims.push(...belief.claimIds ?? []);
    evidence.push(...belief.evidenceIds ?? []);
  }
  for (const claim of packet.futureClaims) { beliefs.push(claim.propositionId); evidence.push(...claim.evidenceIds ?? []); }
  for (const conflict of packet.conflicts) {
    for (const position of conflict.positions) { beliefs.push(position.propositionId); evidence.push(...position.evidenceIds ?? []); }
  }
  for (const selection of packet.selections) {
    beliefs.push(selection.selectedPropositionId, ...selection.competingPropositionIds);
    for (const relation of selection.appliedRelations) beliefs.push(relation.fromPropositionId, relation.toPropositionId);
    evidence.push(...selection.evidenceIds ?? []);
    overlay.push(...selection.overlayDeltaIds);
    for (const step of selection.steps) {
      // Every step lists propositions except the one that lists the owner's
      // pending deltas on the slot. What the read policy excluded -- withheld, or
      // outside the requested view -- is named there without a value, so it was
      // never supplied.
      const excluded = step.rule === 'APPLY_READ_POLICY' ? [] : step.excluded.map(entry => entry.objectId);
      const ids = [...step.kept, ...excluded];
      (step.rule === 'INCLUDE_APPLICABLE_OVERLAY_DELTAS' ? overlay : beliefs).push(...ids);
    }
  }
  for (const match of packet.semanticSearch?.matches ?? []) {
    claims.push(match.objectId); beliefs.push(match.propositionId); evidence.push(...match.evidenceIds);
  }
  evidence.push(...packet.semanticSearch?.filters.sourceItemIds ?? []);
  evidence.push(...packet.evidenceRefs.map(reference => reference.evidenceId));
  for (const delta of packet.ownerOverlayDeltas) {
    overlay.push(delta.overlayDeltaId);
    evidence.push(delta.sourceEvidenceId);
    target(delta.target);
    const conflicting = delta.contestedReason?.['conflictingEvidenceIds'];
    if (Array.isArray(conflicting)) evidence.push(...conflicting.filter((id): id is string => typeof id === 'string'));
  }
  overlay.push(...packet.selectionReason.overlayDeltasApplied);
  for (const fragment of packet.projectionFragments) overlay.push(...fragment.pendingAssertions.map(entry => entry.overlayDeltaId));
  // An object the packet withheld whole (a redaction naming no fields) is listed
  // so the answer knows it exists, and is not supplied (`assemble` in broker.ts).
  const withheld = new Set(packet.redactions.filter(redaction => redaction.fields.length === 0).map(redaction => redaction.objectId));
  const supplied = (ids: Array<string | null>) => sorted(ids).filter(id => !withheld.has(id));
  return suppliedContextSchema.parse({
    packetId: packet.packetId,
    packetHash: packet.packetHash,
    beliefIds: supplied(beliefs), claimIds: supplied(claims), evidenceIds: supplied(evidence), overlayDeltaIds: supplied(overlay),
    projectionVersions: packet.watermarks.projectionVersions,
    watermarks: packet.watermarks,
    registryRelease: packet.registryRelease,
    registryReleaseId: options.registryReleaseId,
  });
}

/**
 * Read a packet back as it was persisted, and prove it is the one its hash names.
 *
 * The hash covers the packet body without its own id, hash and creation time
 * (`assemble` in `broker.ts`); a stored packet that no longer reproduces it is
 * refused rather than recorded against.
 */
export async function readPersistedPacket(tx: MemoryTransaction, input: { ownerScopeId: string; packetId: string }): Promise<{
  packet: ContextPacket; registryReleaseId: string | null; question: string | null;
}> {
  const row = (await tx.query(
    'SELECT packet,packet_hash,registry_release_id,request FROM context_packets WHERE owner_scope_id=$1 AND id=$2',
    [input.ownerScopeId, input.packetId])).rows[0];
  if (!row) throw new ContextBrokerError('CONTEXT_PACKET_NOT_FOUND');
  // The hash is recomputed over the stored JSON itself, not over a parsed copy:
  // the stored bytes are what the manifest claims to describe.
  const { packetId: _id, packetHash: _hash, createdAt: _created, ...body } = row['packet'] as Record<string, unknown>;
  const recomputed = createHash('sha256').update(canonicalJson(body)).digest('hex');
  const packet = contextPacketSchema.parse(row['packet']);
  if (packet.packetHash !== row['packet_hash'] || recomputed !== row['packet_hash']) {
    throw new ContextBrokerError('CONTEXT_PACKET_HASH_MISMATCH');
  }
  const request = row['request'] as Record<string, unknown> | null;
  return {
    packet, registryReleaseId: (row['registry_release_id'] as string | null) ?? null,
    question: typeof request?.['query'] === 'string' ? request['query'] : null,
  };
}

export interface RecordAnswerManifestInput {
  readonly ownerScopeId: string;
  readonly requestingActorId: string;
  readonly packetId: string;
  /** The assistant conversation evidence the presented answer was stored as. */
  readonly conversationMessageId: string;
  readonly suppliedTo: { modelProvider: string; modelId: string; promptVersion: string; composerVersion: string };
  readonly grounding: GroundingResult;
}

/**
 * Record the manifest of one answer, inside a transaction opened under
 * `answer.record`. The sets are the persisted packet's; the caller supplies only
 * what the packet cannot know -- the conversation message, the model it was
 * supplied to and the validator's verdict.
 */
export async function recordAnswerManifest(tx: MemoryTransaction, input: RecordAnswerManifestInput): Promise<{
  answerManifestId: string; contextSupplied: SuppliedContext;
}> {
  const persisted = await readPersistedPacket(tx, { ownerScopeId: input.ownerScopeId, packetId: input.packetId });
  const supplied = suppliedContextOf(persisted.packet, { registryReleaseId: persisted.registryReleaseId });
  const grounding = groundingResultSchema.parse(input.grounding);
  const answerManifestId = uuidV7();
  await tx.query(
    `INSERT INTO answer_manifests(id,owner_scope_id,context_packet_id,packet_hash,conversation_message_id,requesting_actor_id,
       model_provider,model_id,prompt_version,composer_version,belief_ids,claim_ids,evidence_ids,overlay_delta_ids,
       projection_versions,watermarks,registry_release,registry_release_id,grounding_validator_result,manifest_version)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
    [answerManifestId, input.ownerScopeId, supplied.packetId, supplied.packetHash, input.conversationMessageId,
      input.requestingActorId, input.suppliedTo.modelProvider, input.suppliedTo.modelId, input.suppliedTo.promptVersion,
      input.suppliedTo.composerVersion, supplied.beliefIds, supplied.claimIds, supplied.evidenceIds, supplied.overlayDeltaIds,
      JSON.stringify(supplied.projectionVersions), JSON.stringify(supplied.watermarks), supplied.registryRelease,
      supplied.registryReleaseId, JSON.stringify(grounding), MANIFEST_VERSION]);
  return { answerManifestId, contextSupplied: supplied };
}

const PUBLIC_OBJECT_TYPE: Readonly<Record<string, ReconsiderationChange['changedObjectType']>> = Object.freeze({
  proposition: 'belief', owner_overlay_delta: 'owner_overlay_delta',
});

function changeOf(row: Record<string, unknown>): ReconsiderationChange {
  return {
    changedObjectType: PUBLIC_OBJECT_TYPE[row['changed_object_type'] as string]!,
    changedObjectId: row['changed_object_id'] as string,
    changeKind: row['change_kind'] as ReconsiderationChange['changeKind'],
    detectedAt: (row['detected_at'] as Date).toISOString(),
  };
}

/** GET /v1/answers/{id}/manifest: the manifest, the packet's question, and any
 * change detected since to an object it contained. */
export async function readAnswerManifest(tx: MemoryTransaction, input: {
  ownerScopeId: string; answerManifestId: string;
}): Promise<PublicAnswerManifest | null> {
  const row = (await tx.query(
    `SELECT m.*,p.request FROM answer_manifests m
     LEFT JOIN context_packets p ON p.owner_scope_id=m.owner_scope_id AND p.id=m.context_packet_id
     WHERE m.owner_scope_id=$1 AND m.id=$2`, [input.ownerScopeId, input.answerManifestId])).rows[0];
  if (!row) return null;
  const changes = (await tx.query(
    `SELECT changed_object_type,changed_object_id,change_kind,detected_at FROM reconsideration_candidates
     WHERE owner_scope_id=$1 AND answer_manifest_id=$2 ORDER BY detected_at,id`,
    [input.ownerScopeId, input.answerManifestId])).rows.map(changeOf);
  const request = row['request'] as Record<string, unknown> | null;
  return publicAnswerManifestSchema.parse({
    answerManifestId: row['id'],
    recordKind: 'CONTEXT_SUPPLIED_TO_MODEL',
    recordStatement: SUPPLIED_CONTEXT_STATEMENT,
    question: typeof request?.['query'] === 'string' ? request['query'] : null,
    contextSupplied: {
      packetId: row['context_packet_id'], packetHash: row['packet_hash'],
      beliefIds: row['belief_ids'], claimIds: row['claim_ids'], evidenceIds: row['evidence_ids'],
      overlayDeltaIds: row['overlay_delta_ids'], projectionVersions: row['projection_versions'],
      watermarks: row['watermarks'], registryRelease: row['registry_release'] ?? null,
      registryReleaseId: row['registry_release_id'] ?? null,
    },
    suppliedTo: {
      modelProvider: row['model_provider'], modelId: row['model_id'], promptVersion: row['prompt_version'],
      composerVersion: row['composer_version'],
    },
    conversationMessageId: row['conversation_message_id'],
    groundingValidator: row['grounding_validator_result'],
    reconsideration: { isCandidate: changes.length > 0, changes },
    manifestVersion: row['manifest_version'],
    createdAt: (row['created_at'] as Date).toISOString(),
  });
}

/**
 * GET /v1/answers/reconsideration-candidates (PRD §23.7; CRT-RD-11-A).
 *
 * Exactly the answers whose manifests contained the object and that were given
 * before it changed materially: the candidate rows the database derived when the
 * change arrived. An answer given after the change already saw the new state and
 * is not listed; an object that never changed lists nothing. No answer is
 * rewritten.
 */
export async function listReconsiderationCandidates(tx: MemoryTransaction, input: {
  ownerScopeId: string; objectType: 'belief' | 'owner_overlay_delta'; objectId: string; now?: Date;
}): Promise<ReconsiderationCandidatesView> {
  const storedType = input.objectType === 'belief' ? 'proposition' : 'owner_overlay_delta';
  const rows = (await tx.query(
    `SELECT r.changed_object_type,r.changed_object_id,r.change_kind,r.detected_at,
       m.id AS answer_manifest_id,m.context_packet_id,m.conversation_message_id,m.created_at AS answered_at
     FROM reconsideration_candidates r
     JOIN answer_manifests m ON m.owner_scope_id=r.owner_scope_id AND m.id=r.answer_manifest_id
     WHERE r.owner_scope_id=$1 AND r.changed_object_type=$2 AND r.changed_object_id=$3
     ORDER BY m.created_at,m.id,r.detected_at,r.id`,
    [input.ownerScopeId, storedType, input.objectId])).rows;
  const byManifest = new Map<string, ReconsiderationCandidatesView['candidates'][number]>();
  for (const row of rows) {
    const manifestId = row['answer_manifest_id'] as string;
    const entry = byManifest.get(manifestId) ?? {
      answerManifestId: manifestId, contextPacketId: row['context_packet_id'] as string,
      conversationMessageId: row['conversation_message_id'] as string,
      answeredAt: (row['answered_at'] as Date).toISOString(), changes: [],
    };
    entry.changes.push(changeOf(row));
    byManifest.set(manifestId, entry);
  }
  return reconsiderationCandidatesViewSchema.parse({
    changedObject: { objectType: input.objectType, objectId: input.objectId },
    candidates: [...byManifest.values()],
    previousAnswersPreserved: true,
    readAt: (input.now ?? new Date()).toISOString(),
  });
}
