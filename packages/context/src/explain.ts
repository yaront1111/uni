import {
  beliefExplanationSchema, explainClaimSchema, explainContradictionSchema, explainEvidenceAnchorSchema,
  explainProjectionConsumerSchema, explainResolutionLinkSchema, explainSupportSchema, explainTemporalEntrySchema,
  type BeliefExplanation,
} from '@unai/domain';
import { CANONICALIZATION_VERSION, readOwnerOverlay, type MemoryTransaction } from '@unai/memory';
import { ContextBrokerError } from './broker.js';

/**
 * The belief explanation behind the Memory inspector (PRD §35.8, §37.1;
 * GET /v1/memory/propositions/{id}/explain; CRT-RD-09-A).
 *
 * Nine sections, each read from the rows that already exist: the assessment that
 * stands now, the claims that assert the value, the evidence anchors those claims
 * are grounded in, the support graph with its independence groups, the
 * contradictions, the history over valid *and* recorded time, the resolution
 * links, the registry and extractor versions every step was pinned to, and the
 * projections that consume the value.
 *
 * Nothing here computes a new assessment or re-derives anything. An explanation
 * that recomputed its subject would be answering about a belief the system does
 * not hold.
 */

export const EXPLANATION_VERSION = 'belief-explanation-0.1.0';

/** Which projection column consumes which predicate. It is read from the registry
 * contract the release pinned, so the consumer list is the registry's statement
 * and not an inference from a column name. */
async function projectionContracts(tx: MemoryTransaction, predicateId: string, releaseId: string | null): Promise<string[]> {
  if (!releaseId) return [];
  const rows = (await tx.query(
    'SELECT unai_private.registry_contract_present($1,$2,$3) AS present', [releaseId, predicateId, 'PREDICATE'])).rows;
  // The application role may not read the registry snapshot; it may only ask
  // whether a contract is in the pinned release (ADR 0011). A predicate the
  // release does not carry names no projection contract.
  return rows[0]?.['present'] === true ? [predicateId] : [];
}

export async function explainProposition(tx: MemoryTransaction, input: {
  ownerScopeId: string; propositionId: string; readAt: Date; registryRelease?: string | null;
}): Promise<BeliefExplanation> {
  const subject = (await tx.query(
    `SELECT p.id,p.belief_slot_id,p.normalized_value,p.polarity,s.frame_instance_id,s.predicate_id,s.modality,
       f.frame_type_id
     FROM propositions p
     JOIN belief_slots s ON s.owner_scope_id=p.owner_scope_id AND s.id=p.belief_slot_id
     JOIN frame_instances f ON f.owner_scope_id=s.owner_scope_id AND f.id=s.frame_instance_id
     WHERE p.owner_scope_id=$1 AND p.id=$2`, [input.ownerScopeId, input.propositionId])).rows[0];
  if (!subject) throw new ContextBrokerError('PROPOSITION_NOT_FOUND');
  const slotId = subject['belief_slot_id'] as string;
  const frameInstanceId = subject['frame_instance_id'] as string;

  // Temporal history over both axes: every assessment version ever recorded, in
  // recorded-time order, with the valid period each one spoke about.
  const assessmentRows = (await tx.query(
    `SELECT id,assessment_status,valid_from,valid_to,recorded_at,superseded_recorded_at,transaction_id,policy_version,
       decision_reason
     FROM belief_assessments WHERE owner_scope_id=$1 AND proposition_id=$2 ORDER BY recorded_at,id`,
    [input.ownerScopeId, input.propositionId])).rows;
  const live = assessmentRows.filter(row => row['superseded_recorded_at'] === null).at(-1) ?? null;

  const claimRows = (await tx.query(
    `SELECT id,claim_origin,lifecycle,asserted_by_entity_id,extraction_run_id,recorded_at,valid_from,valid_to,
       source_anchor_id
     FROM claims WHERE owner_scope_id=$1 AND proposition_id=$2 ORDER BY recorded_at,id`,
    [input.ownerScopeId, input.propositionId])).rows;

  const anchorRows = claimRows.length === 0 ? [] : (await tx.query(
    `SELECT a.id,a.anchor_kind,a.source_item_id,s.source_type,s.sensitivity,s.occurred_at,
       coalesce(array_agg(c.id ORDER BY c.id),'{}') AS claim_ids
     FROM source_anchors a
     JOIN source_items s ON s.owner_scope_id=a.owner_scope_id AND s.id=a.source_item_id
     JOIN claims c ON c.owner_scope_id=a.owner_scope_id AND c.source_anchor_id=a.id
     WHERE a.owner_scope_id=$1 AND c.proposition_id=$2
     GROUP BY a.id,a.anchor_kind,a.source_item_id,s.source_type,s.sensitivity,s.occurred_at
     ORDER BY a.id`, [input.ownerScopeId, input.propositionId])).rows;

  const supportRows = (await tx.query(
    `SELECT id,support_kind,claim_id,supporting_proposition_id,independence_group
     FROM belief_support WHERE owner_scope_id=$1 AND proposition_id=$2 ORDER BY id`,
    [input.ownerScopeId, input.propositionId])).rows;
  const groups = new Map<string, number>();
  for (const row of supportRows) {
    const group = (row['independence_group'] as string | null) ?? null;
    if (group) groups.set(group, (groups.get(group) ?? 0) + 1);
  }

  // Contradictions, from all four places one can be recorded: a competing live
  // proposition in the same slot, a CORRECTS/SUPERSEDES/CONTRADICTS claim
  // relation, a CONTRADICTS memory link, and a contested owner assertion.
  const contradictions = [];
  const competing = (await tx.query(
    `SELECT p.id,coalesce((SELECT b.assessment_status FROM belief_assessments b
       WHERE b.owner_scope_id=p.owner_scope_id AND b.proposition_id=p.id AND b.superseded_recorded_at IS NULL
       ORDER BY b.recorded_at DESC,b.id DESC LIMIT 1),'CANDIDATE') AS assessment_status
     FROM propositions p WHERE p.owner_scope_id=$1 AND p.belief_slot_id=$2 AND p.id<>$3 AND p.lifecycle<>'RETIRED'
     ORDER BY p.id`, [input.ownerScopeId, slotId, input.propositionId])).rows;
  for (const row of competing) {
    if (row['assessment_status'] === 'REJECTED' || row['assessment_status'] === 'SUPERSEDED') continue;
    contradictions.push(explainContradictionSchema.parse({
      kind: 'COMPETING_PROPOSITION', objectType: 'propositions', objectId: row['id'],
      relation: 'SAME_SLOT_DIFFERENT_VALUE', detail: 'COMPETING_LIVE_PROPOSITIONS_IN_ONE_SLOT',
    }));
  }
  const claimIds = claimRows.map(row => row['id'] as string);
  if (claimIds.length > 0) {
    const relationRows = (await tx.query(
      `SELECT id,from_claim_id,to_claim_id,relation_kind FROM claim_relations
       WHERE owner_scope_id=$1 AND (from_claim_id=ANY($2::uuid[]) OR to_claim_id=ANY($2::uuid[]))
         AND relation_kind IN ('CORRECTS','SUPERSEDES','CONTRADICTS') ORDER BY id`,
      [input.ownerScopeId, claimIds])).rows;
    for (const row of relationRows) {
      contradictions.push(explainContradictionSchema.parse({
        kind: 'CLAIM_RELATION', objectType: 'claim_relations', objectId: row['id'],
        relation: row['relation_kind'] as string, detail: 'CLAIM_RELATION_RECORDED',
      }));
    }
  }
  const linkRows = (await tx.query(
    `SELECT id,link_kind,from_object_id,to_object_id FROM memory_links
     WHERE owner_scope_id=$1 AND link_kind='CONTRADICTS'
       AND ((from_object_type='proposition' AND from_object_id=$2) OR (to_object_type='proposition' AND to_object_id=$2))
     ORDER BY id`, [input.ownerScopeId, input.propositionId])).rows;
  for (const row of linkRows) {
    contradictions.push(explainContradictionSchema.parse({
      kind: 'MEMORY_LINK', objectType: 'memory_links', objectId: row['id'],
      relation: row['link_kind'] as string, detail: 'CONTRADICTS_LINK_RECORDED',
    }));
  }

  const overlay = await readOwnerOverlay(tx, { ownerScopeId: input.ownerScopeId });
  const ownerOverlayDeltas = overlay.deltas.filter(delta =>
    (delta.target !== null && delta.target.objectType === 'proposition' && delta.target.objectId === input.propositionId)
    || (delta.target !== null && delta.target.objectType === 'claim' && claimIds.includes(delta.target.objectId))
    || delta.attachedFrameInstanceId === frameInstanceId);
  for (const delta of ownerOverlayDeltas) {
    if (delta.lifecycle !== 'CONTESTED') continue;
    contradictions.push(explainContradictionSchema.parse({
      kind: 'CONTESTED_OVERLAY_DELTA', objectType: 'owner_overlay_deltas', objectId: delta.overlayDeltaId,
      relation: delta.deltaKind, detail: 'OWNER_ASSERTION_CONTESTED',
    }));
  }

  // Resolution links: the assertions that settle the frame this value belongs to,
  // and the protocol links that carry them.
  const resolutionRows = (await tx.query(
    `SELECT id,outcome_code,effective_at,lifecycle FROM resolution_assertions
     WHERE owner_scope_id=$1 AND (source_frame_instance_id=$2 OR target_frame_instance_id=$2
       OR source_proposition_id=$3 OR target_proposition_id=$3) ORDER BY effective_at,id`,
    [input.ownerScopeId, frameInstanceId, input.propositionId])).rows;
  const resolutionLinkRows = (await tx.query(
    `SELECT id,link_kind,lifecycle FROM memory_links
     WHERE owner_scope_id=$1 AND link_kind IN ('RESOLVES','REALIZES','SUPERSEDES','DERIVED_FROM')
       AND ((from_object_type='proposition' AND from_object_id=$2) OR (to_object_type='proposition' AND to_object_id=$2)
         OR (from_object_type='frame_instance' AND from_object_id=$3) OR (to_object_type='frame_instance' AND to_object_id=$3))
     ORDER BY id`, [input.ownerScopeId, input.propositionId, frameInstanceId])).rows;

  // The extractor versions every claim was produced under, and the release each
  // run was pinned to.
  const runIds = [...new Set(claimRows.map(row => row['extraction_run_id'] as string | null).filter((id): id is string => id !== null))];
  const runRows = runIds.length === 0 ? [] : (await tx.query(
    `SELECT id,run_kind,model_id,prompt_version,normalization_version,entity_resolver_version,temporal_resolver_version,
       registry_release_id FROM extraction_runs WHERE owner_scope_id=$1 AND id=ANY($2::uuid[]) ORDER BY id`,
    [input.ownerScopeId, runIds])).rows;

  const fingerprint = (await tx.query(
    `SELECT registry_release_id,normalization_version FROM proposition_fingerprints
     WHERE owner_scope_id=$1 AND proposition_id=$2 AND valid_to_recorded_at IS NULL
     ORDER BY valid_from_recorded_at DESC LIMIT 1`, [input.ownerScopeId, input.propositionId])).rows[0] ?? null;
  const releaseId = (fingerprint?.['registry_release_id'] as string | null)
    ?? (runRows[0]?.['registry_release_id'] as string | null) ?? null;

  // Projection consumers: the typed rows that actually carry this frame today.
  const consumers = [];
  const contracts = await projectionContracts(tx, subject['predicate_id'] as string, releaseId);
  for (const [projectionName, column] of [
    ['open_commitments_projection', 'commitment_frame_instance_id'],
    ['obligations_projection', 'obligation_frame_instance_id'],
    ['schedule_projection', 'scheduled_frame_instance_id'],
  ] as const) {
    const row = (await tx.query(
      `SELECT projection_version,reducer_version,is_complete FROM ${projectionName}
       WHERE owner_scope_id=$1 AND ${column}=$2`, [input.ownerScopeId, frameInstanceId])).rows[0];
    if (!row) continue;
    consumers.push(explainProjectionConsumerSchema.parse({
      projectionName, frameInstanceId, projectionVersion: (row['projection_version'] as string | null) ?? null,
      reducerVersion: row['reducer_version'], isComplete: row['is_complete'], projectionContracts: contracts,
    }));
  }

  return beliefExplanationSchema.parse({
    propositionId: subject['id'], beliefSlotId: slotId, frameInstanceId,
    frameTypeId: subject['frame_type_id'], predicateId: subject['predicate_id'],
    modality: subject['modality'], polarity: subject['polarity'], normalizedValue: subject['normalized_value'],
    currentAssessment: {
      assessmentId: (live?.['id'] as string | null) ?? null,
      assessmentStatus: (live?.['assessment_status'] as string | null) ?? null,
      recordedAt: live?.['recorded_at'] ? (live['recorded_at'] as Date).toISOString() : null,
      policyVersion: (live?.['policy_version'] as string | null) ?? null,
      decisionReason: (live?.['decision_reason'] as Record<string, unknown> | null) ?? null,
    },
    claims: claimRows.map(row => explainClaimSchema.parse({
      claimId: row['id'], claimOrigin: row['claim_origin'], lifecycle: row['lifecycle'],
      assertedByEntityId: (row['asserted_by_entity_id'] as string | null) ?? null,
      extractionRunId: (row['extraction_run_id'] as string | null) ?? null,
      recordedAt: (row['recorded_at'] as Date).toISOString(),
      validFrom: row['valid_from'] ? (row['valid_from'] as Date).toISOString() : null,
      validTo: row['valid_to'] ? (row['valid_to'] as Date).toISOString() : null,
    })),
    evidenceAnchors: anchorRows.map(row => explainEvidenceAnchorSchema.parse({
      sourceAnchorId: row['id'], evidenceId: row['source_item_id'], anchorKind: row['anchor_kind'],
      sourceType: row['source_type'], sensitivity: row['sensitivity'],
      claimIds: (row['claim_ids'] as string[] | null) ?? [],
      occurredAt: row['occurred_at'] ? (row['occurred_at'] as Date).toISOString() : null,
    })),
    supportGraph: supportRows.map(row => explainSupportSchema.parse({
      supportId: row['id'], supportKind: row['support_kind'],
      claimId: (row['claim_id'] as string | null) ?? null,
      supportingPropositionId: (row['supporting_proposition_id'] as string | null) ?? null,
      independenceGroup: (row['independence_group'] as string | null) ?? null,
    })),
    independenceGroups: [...groups].map(([independenceGroup, supportCount]) => ({ independenceGroup, supportCount })),
    contradictions,
    temporalHistory: assessmentRows.map(row => explainTemporalEntrySchema.parse({
      assessmentId: row['id'], assessmentStatus: row['assessment_status'],
      validFrom: row['valid_from'] ? (row['valid_from'] as Date).toISOString() : null,
      validTo: row['valid_to'] ? (row['valid_to'] as Date).toISOString() : null,
      recordedAt: (row['recorded_at'] as Date).toISOString(),
      supersededRecordedAt: row['superseded_recorded_at'] ? (row['superseded_recorded_at'] as Date).toISOString() : null,
      transactionId: (row['transaction_id'] as string | null) ?? null,
    })),
    resolutionLinks: [
      ...resolutionRows.map(row => explainResolutionLinkSchema.parse({
        objectType: 'resolution_assertion', objectId: row['id'], linkKind: null,
        outcomeCode: row['outcome_code'], effectiveAt: (row['effective_at'] as Date).toISOString(),
        lifecycle: row['lifecycle'],
      })),
      ...resolutionLinkRows.map(row => explainResolutionLinkSchema.parse({
        objectType: 'memory_link', objectId: row['id'], linkKind: row['link_kind'],
        outcomeCode: null, effectiveAt: null, lifecycle: row['lifecycle'],
      })),
    ],
    registryVersions: {
      registryReleaseId: releaseId,
      registryRelease: input.registryRelease ?? null,
      normalizationVersion: (fingerprint?.['normalization_version'] as string | null) ?? null,
      canonicalizationVersion: CANONICALIZATION_VERSION,
    },
    extractorVersions: runRows.map(row => ({
      extractionRunId: row['id'], runKind: row['run_kind'],
      modelId: (row['model_id'] as string | null) ?? null,
      promptVersion: (row['prompt_version'] as string | null) ?? null,
      normalizationVersion: row['normalization_version'],
      entityResolverVersion: row['entity_resolver_version'],
      temporalResolverVersion: row['temporal_resolver_version'],
      registryReleaseId: (row['registry_release_id'] as string | null) ?? null,
    })),
    projectionConsumers: consumers,
    ownerOverlayDeltas,
    explanationVersion: EXPLANATION_VERSION,
    readAt: input.readAt.toISOString(),
  });
}
