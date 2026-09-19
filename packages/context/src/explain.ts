import {
  beliefExplanationSchema, explainClaimSchema, explainContradictionSchema, explainEvidenceAnchorSchema,
  explainProjectionConsumerSchema, explainResolutionLinkSchema, explainSupportSchema, explainTemporalEntrySchema,
  type BeliefExplanation,
} from '@unai/domain';
import { CANONICALIZATION_VERSION, readOwnerOverlay, type MemoryTransaction } from '@unai/memory';
import { ContextBrokerError } from './broker.js';
import { readPropositionAuthority } from './support-authority.js';

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

export const EXPLANATION_VERSION = 'belief-explanation-0.3.0';

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

/** A link is readable only when both objects it describes have readable support. */
async function readableLinks(tx: MemoryTransaction, ownerScopeId: string, rows: Record<string, unknown>[], readAt: Date) {
  if (rows.length === 0) return [];
  const refs = rows.flatMap(row => [
    { type: row['from_object_type'] as string, id: row['from_object_id'] as string },
    { type: row['to_object_type'] as string, id: row['to_object_id'] as string },
  ]);
  const ids = [...new Set(refs.map(ref => ref.id))];
  const readable = new Set<string>();
  const sources = (await tx.query(`SELECT 'source_item' AS kind,id FROM source_items WHERE owner_scope_id=$1 AND id=ANY($2::uuid[])
    UNION ALL SELECT 'claim',c.id FROM claims c JOIN source_anchors a ON a.owner_scope_id=c.owner_scope_id AND a.id=c.source_anchor_id
      WHERE c.owner_scope_id=$1 AND c.id=ANY($2::uuid[]) AND c.recorded_at<=$3
    UNION ALL SELECT 'resolution_assertion',r.id FROM resolution_assertions r
      JOIN claims c ON c.owner_scope_id=r.owner_scope_id AND c.id=r.claim_id
      JOIN source_anchors a ON a.owner_scope_id=c.owner_scope_id AND a.id=c.source_anchor_id
      WHERE r.owner_scope_id=$1 AND r.id=ANY($2::uuid[]) AND r.recorded_at<=$3 AND c.recorded_at<=$3
    UNION ALL SELECT 'entity',a.entity_id FROM entity_aliases a
      JOIN source_items s ON s.owner_scope_id=a.owner_scope_id AND s.id=a.source_item_id
      WHERE a.owner_scope_id=$1 AND a.entity_id=ANY($2::uuid[]) AND a.created_at<=$3`, [ownerScopeId, ids, readAt])).rows;
  for (const row of sources) readable.add(row['kind'] + ':' + row['id']);
  const propositions = (await tx.query(`SELECT p.id,s.frame_instance_id FROM propositions p
    JOIN belief_slots s ON s.owner_scope_id=p.owner_scope_id AND s.id=p.belief_slot_id
    WHERE p.owner_scope_id=$1 AND (p.id=ANY($2::uuid[]) OR s.frame_instance_id=ANY($2::uuid[]))`, [ownerScopeId, ids])).rows;
  const authority = await readPropositionAuthority(tx, { ownerScopeId, knowledgeTime: readAt,
    propositionIds: propositions.map(row => row['id'] as string) });
  for (const row of propositions) if (authority.get(row['id'] as string)?.readable) {
    readable.add('proposition:' + row['id']); readable.add('frame_instance:' + row['frame_instance_id']);
  }
  return rows.filter(row => readable.has(row['from_object_type'] + ':' + row['from_object_id'])
    && readable.has(row['to_object_type'] + ':' + row['to_object_id']));
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
  const authority = (await readPropositionAuthority(tx, { ownerScopeId: input.ownerScopeId,
    propositionIds: [input.propositionId], knowledgeTime: input.readAt })).get(input.propositionId);
  if (!authority?.readable) {
    const history = (await tx.query(`SELECT
      unai_private.object_state_at($1,'propositions',$2,$5) IS NOT NULL AS proposition_known,
      unai_private.object_state_at($1,'belief_slots',$3,$5) IS NOT NULL AS slot_known,
      unai_private.object_state_at($1,'frame_instances',$4,$5) IS NOT NULL AS frame_known`,
    [input.ownerScopeId, input.propositionId, subject['belief_slot_id'], subject['frame_instance_id'], input.readAt])).rows[0];
    if (!history?.['proposition_known'] || !history['slot_known'] || !history['frame_known']) {
      throw new ContextBrokerError('PROPOSITION_HISTORY_UNAVAILABLE');
    }
    throw new ContextBrokerError('PROPOSITION_SOURCE_WITHHELD');
  }
  const slotId = subject['belief_slot_id'] as string;
  const frameInstanceId = subject['frame_instance_id'] as string;

  // Temporal history over both axes: every assessment version ever recorded, in
  // recorded-time order, with the valid period each one spoke about.
  const assessmentRows = (await tx.query(
    `SELECT id,assessment_status,valid_from,valid_to,recorded_at,
       CASE WHEN superseded_recorded_at<=$3 THEN superseded_recorded_at ELSE NULL END AS superseded_recorded_at,transaction_id,policy_version
     FROM belief_assessments WHERE owner_scope_id=$1 AND proposition_id=$2 AND recorded_at<=$3 ORDER BY recorded_at,id`,
    [input.ownerScopeId, input.propositionId, input.readAt])).rows;
  const live = assessmentRows.filter(row => row['superseded_recorded_at'] === null).at(-1) ?? null;

  const claimRows = (await tx.query(
    `SELECT c.id,c.claim_origin,unai_private.object_state_at(c.owner_scope_id,'claims',c.id,$3)->>'lifecycle' AS lifecycle,c.asserted_by_entity_id,c.extraction_run_id,c.recorded_at,c.valid_from,c.valid_to,
       c.source_anchor_id
     FROM claims c JOIN source_anchors a ON a.owner_scope_id=c.owner_scope_id AND a.id=c.source_anchor_id
     WHERE c.owner_scope_id=$1 AND c.proposition_id=$2 AND (unai_private.object_state_at(c.owner_scope_id,'claims',c.id,$3)->>'proposition_id')::uuid=$2
       AND c.recorded_at<=$3 ORDER BY c.recorded_at,c.id`,
    [input.ownerScopeId, input.propositionId, input.readAt])).rows;
  // Direct assertions remain separate from transitive leaf citations: a
  // computation must not invent a person who directly asserted its result.
  const claimIds = claimRows.map(row => row['id'] as string);

  const anchorRows = (await tx.query(
    `SELECT a.id,a.anchor_kind,a.source_item_id,s.source_type,s.sensitivity,s.occurred_at,
       coalesce(array_agg(c.id ORDER BY c.id),'{}') AS claim_ids
     FROM source_anchors a
     JOIN source_items s ON s.owner_scope_id=a.owner_scope_id AND s.id=a.source_item_id
     JOIN claims c ON c.owner_scope_id=a.owner_scope_id AND c.source_anchor_id=a.id
     WHERE a.owner_scope_id=$1 AND c.id=ANY($2::uuid[])
     GROUP BY a.id,a.anchor_kind,a.source_item_id,s.source_type,s.sensitivity,s.occurred_at
     ORDER BY a.id`, [input.ownerScopeId, authority.claimIds])).rows;

  const supportCandidates = (await tx.query(
    `SELECT b.id,b.support_kind,b.claim_id,b.supporting_proposition_id,b.independence_group
     FROM belief_support b WHERE b.owner_scope_id=$1 AND b.proposition_id=$2 AND b.created_at<=$3
       AND (b.claim_id IS NULL OR EXISTS(SELECT 1 FROM claims c
         JOIN source_anchors a ON a.owner_scope_id=c.owner_scope_id AND a.id=c.source_anchor_id
         WHERE c.owner_scope_id=b.owner_scope_id AND c.id=b.claim_id AND c.recorded_at<=$3))
       AND (b.claim_id IS NOT NULL OR b.supporting_proposition_id IS NOT NULL)
     ORDER BY b.id`,
    [input.ownerScopeId, input.propositionId, input.readAt])).rows;
  const supportAuthority = await readPropositionAuthority(tx, { ownerScopeId: input.ownerScopeId, knowledgeTime: input.readAt,
    propositionIds: supportCandidates.map(row => row['supporting_proposition_id'] as string | null).filter((id): id is string => id !== null) });
  const supportRows = supportCandidates.filter(row => row['supporting_proposition_id'] === null
    || supportAuthority.get(row['supporting_proposition_id'] as string)?.readable);
  const groups = new Map<string, number>();
  for (const row of supportRows) {
    const group = (row['independence_group'] as string | null) ?? null;
    if (group) groups.set(group, (groups.get(group) ?? 0) + 1);
  }

  // Contradictions, from all four places one can be recorded: a competing live
  // proposition in the same slot, a CORRECTS/SUPERSEDES/CONTRADICTS claim
  // relation, a CONTRADICTS memory link, and a contested owner assertion.
  const contradictions = [];
  const competingCandidates = (await tx.query(
    `SELECT p.id,coalesce((SELECT b.assessment_status FROM belief_assessments b
       WHERE b.owner_scope_id=p.owner_scope_id AND b.proposition_id=p.id AND b.recorded_at<=$4
       AND (b.superseded_recorded_at IS NULL OR b.superseded_recorded_at>$4)
       ORDER BY b.recorded_at DESC,b.id DESC LIMIT 1),'CANDIDATE') AS assessment_status
     FROM propositions p WHERE p.owner_scope_id=$1 AND p.belief_slot_id=$2 AND p.id<>$3
       AND unai_private.object_state_at(p.owner_scope_id,'propositions',p.id,$4)->>'lifecycle'<>'RETIRED'
     ORDER BY p.id`, [input.ownerScopeId, slotId, input.propositionId, input.readAt])).rows;
  const competingAuthority = await readPropositionAuthority(tx, { ownerScopeId: input.ownerScopeId, knowledgeTime: input.readAt,
    propositionIds: competingCandidates.map(row => row['id'] as string) });
  const competing = competingCandidates.filter(row => competingAuthority.get(row['id'] as string)?.readable);
  for (const row of competing) {
    if (row['assessment_status'] === 'REJECTED' || row['assessment_status'] === 'SUPERSEDED') continue;
    contradictions.push(explainContradictionSchema.parse({
      kind: 'COMPETING_PROPOSITION', objectType: 'propositions', objectId: row['id'],
      relation: 'SAME_SLOT_DIFFERENT_VALUE', detail: 'COMPETING_LIVE_PROPOSITIONS_IN_ONE_SLOT',
    }));
  }
  if (claimIds.length > 0) {
    const relationRows = (await tx.query(
      `SELECT r.id,r.from_claim_id,r.to_claim_id,r.relation_kind FROM claim_relations r
       JOIN claims f ON f.owner_scope_id=r.owner_scope_id AND f.id=r.from_claim_id
       JOIN source_anchors fa ON fa.owner_scope_id=f.owner_scope_id AND fa.id=f.source_anchor_id
       JOIN claims t ON t.owner_scope_id=r.owner_scope_id AND t.id=r.to_claim_id
       JOIN source_anchors ta ON ta.owner_scope_id=t.owner_scope_id AND ta.id=t.source_anchor_id
       WHERE r.owner_scope_id=$1 AND (r.from_claim_id=ANY($2::uuid[]) OR r.to_claim_id=ANY($2::uuid[]))
         AND f.recorded_at<=$3 AND t.recorded_at<=$3 AND r.created_at<=$3
         AND r.relation_kind IN ('CORRECTS','SUPERSEDES','CONTRADICTS') ORDER BY r.id`,
      [input.ownerScopeId, claimIds, input.readAt])).rows;
    for (const row of relationRows) {
      contradictions.push(explainContradictionSchema.parse({
        kind: 'CLAIM_RELATION', objectType: 'claim_relations', objectId: row['id'],
        relation: row['relation_kind'] as string, detail: 'CLAIM_RELATION_RECORDED',
      }));
    }
  }
  const linkRows = (await tx.query(
    `SELECT id,link_kind,from_object_type,from_object_id,to_object_type,to_object_id FROM memory_links
     WHERE owner_scope_id=$1 AND link_kind='CONTRADICTS' AND created_at<=$3
       AND ((from_object_type='proposition' AND from_object_id=$2) OR (to_object_type='proposition' AND to_object_id=$2))
     ORDER BY id`, [input.ownerScopeId, input.propositionId, input.readAt])).rows;
  for (const row of await readableLinks(tx, input.ownerScopeId, linkRows, input.readAt)) {
    contradictions.push(explainContradictionSchema.parse({
      kind: 'MEMORY_LINK', objectType: 'memory_links', objectId: row['id'],
      relation: row['link_kind'] as string, detail: 'CONTRADICTS_LINK_RECORDED',
    }));
  }

  const readableEvidenceIds = (await tx.query('SELECT id FROM source_items WHERE owner_scope_id=$1',
    [input.ownerScopeId])).rows.map(row => row['id'] as string);
  const overlay = await readOwnerOverlay(tx, { ownerScopeId: input.ownerScopeId,
    knowledgeTime: input.readAt, readableEvidenceIds });
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
    `SELECT r.id,r.outcome_code,r.effective_at,
       unai_private.object_state_at(r.owner_scope_id,'resolution_assertions',r.id,$4)->>'lifecycle' AS lifecycle FROM resolution_assertions r
     JOIN claims c ON c.owner_scope_id=r.owner_scope_id AND c.id=r.claim_id
     JOIN source_anchors a ON a.owner_scope_id=c.owner_scope_id AND a.id=c.source_anchor_id
     WHERE r.owner_scope_id=$1 AND (r.source_frame_instance_id=$2 OR r.target_frame_instance_id=$2
       OR r.source_proposition_id=$3 OR r.target_proposition_id=$3)
       AND r.recorded_at<=$4 AND c.recorded_at<=$4
       AND unai_private.object_state_at(r.owner_scope_id,'resolution_assertions',r.id,$4) IS NOT NULL ORDER BY r.effective_at,r.id`,
    [input.ownerScopeId, frameInstanceId, input.propositionId, input.readAt])).rows;
  const resolutionLinkCandidates = (await tx.query(
    `SELECT id,link_kind,unai_private.object_state_at(owner_scope_id,'memory_links',id,$5)->>'lifecycle' AS lifecycle,
       from_object_type,from_object_id,to_object_type,to_object_id FROM memory_links
     WHERE owner_scope_id=$1 AND link_kind IN ('RESOLVES','REALIZES','SUPERSEDES','DERIVED_FROM')
       AND created_at<=$5 AND unai_private.object_state_at(owner_scope_id,'memory_links',id,$5) IS NOT NULL
       AND ((from_object_type='proposition' AND from_object_id=$2) OR (to_object_type='proposition' AND to_object_id=$2)
         OR (from_object_type='frame_instance' AND from_object_id=$3) OR (to_object_type='frame_instance' AND to_object_id=$3))
       AND (from_object_type<>'resolution_assertion' OR from_object_id=ANY($4::uuid[]))
       AND (to_object_type<>'resolution_assertion' OR to_object_id=ANY($4::uuid[]))
     ORDER BY id`, [input.ownerScopeId, input.propositionId, frameInstanceId, resolutionRows.map(row => row['id'] as string), input.readAt])).rows;
  const resolutionLinkRows = await readableLinks(tx, input.ownerScopeId, resolutionLinkCandidates, input.readAt);

  // The extractor versions every claim was produced under, and the release each
  // run was pinned to.
  const runIds = [...new Set(claimRows.map(row => row['extraction_run_id'] as string | null).filter((id): id is string => id !== null))];
  const runRows = runIds.length === 0 ? [] : (await tx.query(
    `SELECT id,run_kind,model_id,prompt_version,normalization_version,entity_resolver_version,temporal_resolver_version,
       registry_release_id FROM extraction_runs WHERE owner_scope_id=$1 AND id=ANY($2::uuid[]) ORDER BY id`,
    [input.ownerScopeId, runIds])).rows;

  const fingerprint = (await tx.query(
    `SELECT registry_release_id,normalization_version FROM proposition_fingerprints
     WHERE owner_scope_id=$1 AND proposition_id=$2 AND valid_from_recorded_at<=$3
       AND (valid_to_recorded_at IS NULL OR valid_to_recorded_at>$3)
     ORDER BY valid_from_recorded_at DESC LIMIT 1`, [input.ownerScopeId, input.propositionId, input.readAt])).rows[0] ?? null;
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
      // Opaque rationale JSON has no per-field source provenance. Do not let it
      // reintroduce a protected input beside an otherwise readable value.
      decisionReason: null,
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
