import { createHash } from 'node:crypto';
import {
  contextSelectionSchema,
  type AnswerType, type ContextSelection, type PublicOverlayDelta, type SelectionStep,
} from '@unai/domain';
import { canonicalJson, type MemoryTransaction } from '@unai/memory';

/**
 * Deterministic current-state selection (PRD §23.4, FR-062; CRT-RD-03-A,
 * CRT-REG-04-A). ADR 0024 §1.
 *
 * `selectSlotState` is a pure function over the rows of one belief slot. It reads
 * no clock, no random source, no model and no network; every instant it compares
 * is the request's world or knowledge time, and every list it returns is sorted.
 * The same memory and the same request therefore produce the same selection, and
 * the same reason for it, however many times it runs.
 *
 * The rules run in the order PRD §23.4 states them, after the read policy and
 * with the registry rule of PRD §17.5 beside context and modality. Each rule
 * records which propositions it kept and which it excluded, with a reason code, so
 * the selection is its own explanation.
 */

export const SELECTION_VERSION = 'deterministic-selector-0.4.0';

const FUTURE_MODALITIES = ['SCHEDULED', 'INTENDED', 'COMMITTED', 'EXPECTED', 'PREDICTED', 'RECOMMENDED', 'CONDITIONAL'] as const;

/** Which modalities an answer type is asking about (PRD §23.4 step 3). A state
 * question is about what is ACTUAL; a commitment or plan question about the
 * future modalities; a prediction review about the prediction and what happened. */
export function modalitiesForAnswerType(answerType: AnswerType): readonly string[] {
  switch (answerType) {
    case 'OPEN_COMMITMENTS': return ['ACTUAL', 'COMMITTED', 'INTENDED', 'SCHEDULED'];
    case 'FUTURE_PLANS': return [...FUTURE_MODALITIES];
    case 'PREDICTION_VERSUS_OUTCOME': return ['ACTUAL', 'EXPECTED', 'PREDICTED'];
    default: return ['ACTUAL'];
  }
}

export interface SelectorSlot {
  readonly beliefSlotId: string;
  readonly frameInstanceId: string;
  readonly frameTypeId: string;
  readonly predicateId: string;
  readonly modality: ContextSelection['modality'];
  readonly contextKind: ContextSelection['contextKind'];
  /** Both the predicate and the frame type are in the pinned release. */
  readonly predicateRegistered: boolean;
}

export interface SelectorProposition {
  readonly propositionId: string;
  readonly lifecycle: string;
  readonly normalizedValue: unknown;
  /** Withheld by the read policy: above the ceiling, or redacted as an object. */
  readonly withheld: boolean;
  /** Outside the requested life-category view. */
  readonly outOfView: boolean;
}

export interface SelectorAssessment {
  readonly assessmentId: string;
  readonly propositionId: string;
  readonly status: string;
  readonly validFrom: string | null;
  readonly validTo: string | null;
  readonly recordedAt: string;
  readonly supersededRecordedAt: string | null;
}

export interface SelectorClaim {
  readonly claimId: string;
  readonly propositionId: string;
  readonly claimOrigin: string;
  readonly recordedAt: string;
  /** The evidence item behind the claim, or null when this request may not read it. */
  readonly evidenceId: string | null;
}

export interface SelectorRelation {
  readonly fromClaimId: string;
  readonly toClaimId: string;
  readonly relationKind: string;
  readonly validFrom: string | null;
  readonly createdAt: string;
}

export interface SelectorOverlayDelta {
  readonly overlayDeltaId: string;
  readonly lifecycle: string;
  readonly targetPropositionId: string | null;
  readonly attachedBeliefSlotId: string | null;
  readonly createdAt: string;
}

export interface SlotSelectionInput {
  readonly slot: SelectorSlot;
  readonly propositions: readonly SelectorProposition[];
  readonly assessments: readonly SelectorAssessment[];
  readonly claims: readonly SelectorClaim[];
  readonly relations: readonly SelectorRelation[];
  readonly overlayDeltas: readonly SelectorOverlayDelta[];
}

export interface SelectionParameters {
  /** ISO instants: the request's, never the wall clock's. */
  readonly worldTime: string;
  readonly knowledgeTime: string;
  readonly modalities: readonly string[];
  /** PROVISIONAL values are candidates only when the request asked for them. */
  readonly admitProvisional: boolean;
}

/** Overlay lifecycles that are still the owner's pending word rather than a
 * settled canonical fact (PRD §21.5). */
const PENDING_OVERLAY = new Set(['RECEIVED', 'USER_ASSERTED', 'AWAITING_INSTANCE_RESOLUTION', 'CANONICALIZATION_PENDING', 'CONTESTED']);
const LIFECYCLE_EXCLUDED = new Set(['REJECTED', 'SUPERSEDED', 'UNSUPPORTED', 'SUPPRESSED', 'CANDIDATE']);

const at = (iso: string): number => Date.parse(iso);
const byId = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

function step(rule: SelectionStep['rule'], kept: Iterable<string>, excluded: Map<string, string>): SelectionStep {
  return {
    rule,
    kept: [...kept].sort(byId),
    excluded: [...excluded.entries()].sort(([left], [right]) => byId(left, right))
      .map(([objectId, reason]) => ({ objectId, reason })),
  };
}

/** Half-open `[validFrom, validTo)` over world time. */
function coversWorldTime(version: SelectorAssessment, world: number): boolean {
  return (version.validFrom === null || at(version.validFrom) <= world) && (version.validTo === null || at(version.validTo) > world);
}

/** Half-open `[recordedAt, supersededRecordedAt)` over knowledge time. */
function liveAtKnowledgeTime(version: SelectorAssessment, knowledge: number): boolean {
  return at(version.recordedAt) <= knowledge && (version.supersededRecordedAt === null || at(version.supersededRecordedAt) > knowledge);
}

/**
 * Select the state of one belief slot.
 *
 * The outcome is `SELECTED` only when exactly one ACCEPTED value survives every
 * rule and nothing contested stands beside it; two standing values are
 * `CONTESTED` and neither is chosen. A slot with a withheld proposition is
 * `WITHHELD`: choosing among the visible values as if the withheld one did not
 * exist would present part of a slot as the whole of it.
 */
export function selectSlotState(input: SlotSelectionInput, parameters: SelectionParameters): ContextSelection {
  const { slot } = input;
  const world = at(parameters.worldTime);
  const knowledge = at(parameters.knowledgeTime);
  const propositions = [...input.propositions].sort((left, right) => byId(left.propositionId, right.propositionId));
  const steps: SelectionStep[] = [];
  const excludedEver = new Map<string, string>();
  let survivors = propositions.map(proposition => proposition.propositionId);
  const apply = (rule: SelectionStep['rule'], decide: (propositionId: string) => string | null) => {
    const excluded = new Map<string, string>();
    for (const propositionId of survivors) {
      const reason = decide(propositionId);
      if (reason !== null) { excluded.set(propositionId, reason); excludedEver.set(propositionId, reason); }
    }
    survivors = survivors.filter(propositionId => !excluded.has(propositionId));
    steps.push(step(rule, survivors, excluded));
  };
  const propositionById = new Map(propositions.map(proposition => [proposition.propositionId, proposition]));

  // 0. The read policy. What the request may not see is never a candidate.
  apply('APPLY_READ_POLICY', id => propositionById.get(id)!.withheld ? 'WITHHELD_BY_READ_POLICY'
    : propositionById.get(id)!.outOfView ? 'OUTSIDE_LIFE_CATEGORY_VIEW' : null);
  const withheld = propositions.some(proposition => proposition.withheld);

  // 1. Valid time, judged on the verdict as it stood at the knowledge time: a
  //    change closes the earlier value's period in a later version, and that is
  //    the version whose interval must hold at the world time. A proposition with
  //    no version live then is left for the knowledge-time rule to name.
  const versions = new Map<string, SelectorAssessment[]>();
  for (const version of input.assessments) versions.set(version.propositionId, [...(versions.get(version.propositionId) ?? []), version]);
  apply('FILTER_VALID_TIME', id => {
    const own = versions.get(id) ?? [];
    if (own.length === 0) return 'NO_ASSESSMENT_RECORDED';
    const live = own.filter(version => liveAtKnowledgeTime(version, knowledge));
    if (live.length === 0) return null;
    return live.some(version => coversWorldTime(version, world)) ? null : 'VALID_TIME_EXCLUDES_WORLD_TIME';
  });

  // 2. Knowledge time: some version live at the knowledge time must hold.
  const chosen = new Map<string, SelectorAssessment>();
  apply('FILTER_KNOWLEDGE_TIME', id => {
    const live = (versions.get(id) ?? [])
      .filter(version => coversWorldTime(version, world) && liveAtKnowledgeTime(version, knowledge))
      .sort((left, right) => at(right.recordedAt) - at(left.recordedAt) || byId(left.assessmentId, right.assessmentId));
    if (live.length === 0) return 'NOT_KNOWN_AT_KNOWLEDGE_TIME';
    chosen.set(id, live[0]!);
    return null;
  });

  // 3. Context and modality are properties of the slot: every value in it shares
  //    them, so the rule keeps all or none.
  const slotExclusion = slot.contextKind !== 'BASE' ? 'CONTEXT_NOT_BASE'
    : !parameters.modalities.includes(slot.modality) ? 'MODALITY_NOT_REQUESTED' : null;
  apply('APPLY_CONTEXT_AND_MODALITY', () => slotExclusion);

  // 4. PRD §17.5: a value under a contract the pinned release does not hold may
  //    be recalled, never selected as the authoritative current value.
  apply('REQUIRE_REGISTERED_CONTRACT', () => slot.predicateRegistered ? null : 'UNREGISTERED_PREDICATE_NOT_AUTHORITATIVE');

  // 5. Lifecycle: the verdict live at the knowledge time, and the proposition's own.
  apply('APPLY_BELIEF_LIFECYCLE', id => {
    if (propositionById.get(id)!.lifecycle === 'RETIRED') return 'PROPOSITION_RETIRED';
    const status = chosen.get(id)!.status;
    if (LIFECYCLE_EXCLUDED.has(status)) return 'ASSESSMENT_' + status;
    if (status === 'PROVISIONAL' && !parameters.admitProvisional) return 'PROVISIONAL_NOT_REQUESTED';
    return null;
  });

  // 6. Explicit correction and supersession, as recorded by claim relations known
  //    at the knowledge time. A proposition goes only when *every* one of its
  //    claims is corrected, superseded or retracted: one claim nobody took back
  //    keeps it standing.
  const claims = input.claims.filter(claim => at(claim.recordedAt) <= knowledge);
  const claimOwner = new Map(claims.map(claim => [claim.claimId, claim.propositionId]));
  const relations = input.relations.filter(relation => at(relation.createdAt) <= knowledge)
    .filter(relation => claimOwner.has(relation.toClaimId));
  const standing = new Set(survivors);
  const appliedRelations: ContextSelection['appliedRelations'] = [];
  const takenBack = (claimId: string, propositionId: string): string | null => {
    let reason: string | null = null;
    for (const relation of relations.filter(entry => entry.toClaimId === claimId)) {
      const from = claimOwner.get(relation.fromClaimId) ?? null;
      if (from === propositionId) continue;
      if (relation.relationKind === 'RETRACTS') return 'RETRACTED_BY_SOURCE';
      if (relation.relationKind === 'CORRECTS' && from !== null && standing.has(from)) reason = 'CORRECTED_BY_CLAIM';
      if (relation.relationKind === 'SUPERSEDES' && from !== null && standing.has(from) && reason === null
        && (relation.validFrom === null || at(relation.validFrom) <= world)) reason = 'SUPERSEDED_BY_LATER_PERIOD';
    }
    return reason;
  };
  apply('APPLY_CORRECTION_AND_SUPERSESSION', id => {
    const own = claims.filter(claim => claim.propositionId === id);
    if (own.length === 0) return null;
    const reasons = own.map(claim => takenBack(claim.claimId, id));
    if (reasons.some(reason => reason === null)) return null;
    return reasons.includes('RETRACTED_BY_SOURCE') ? 'RETRACTED_BY_SOURCE'
      : reasons.includes('CORRECTED_BY_CLAIM') ? 'CORRECTED_BY_CLAIM' : 'SUPERSEDED_BY_LATER_PERIOD';
  });
  // Every correction or supersession that touched this slot, whatever rule
  // excluded its target -- the explanation of a selection names them all.
  for (const relation of relations) {
    if (!['CORRECTS', 'SUPERSEDES', 'RETRACTS'].includes(relation.relationKind)) continue;
    const to = claimOwner.get(relation.toClaimId)!;
    const from = claimOwner.get(relation.fromClaimId) ?? null;
    if (from === to) continue;
    const entry = { relationKind: relation.relationKind as 'CORRECTS' | 'SUPERSEDES' | 'RETRACTS', fromPropositionId: from, toPropositionId: to };
    if (!appliedRelations.some(existing => canonicalJson(existing) === canonicalJson(entry))) appliedRelations.push(entry);
  }
  appliedRelations.sort((left, right) => byId(left.toPropositionId, right.toPropositionId)
    || byId(left.fromPropositionId ?? '', right.fromPropositionId ?? '') || byId(left.relationKind, right.relationKind));

  // 7. Unresolved conflicts are reported, never resolved.
  const accepted = survivors.filter(id => chosen.get(id)!.status === 'ACCEPTED');
  const contested = survivors.filter(id => chosen.get(id)!.status === 'CONTESTED');
  const provisional = survivors.filter(id => chosen.get(id)!.status === 'PROVISIONAL');
  let selected: string | null = null;
  let outcome: ContextSelection['outcome'];
  if (withheld) outcome = 'WITHHELD';
  else if (slotExclusion !== null || !slot.predicateRegistered) outcome = 'EXCLUDED';
  else if (survivors.length === 0) outcome = 'NO_CURRENT_VALUE';
  else if (contested.length > 0 || accepted.length > 1 || (accepted.length === 0 && provisional.length > 1)) outcome = 'CONTESTED';
  else { outcome = 'SELECTED'; selected = accepted[0] ?? provisional[0]!; }
  steps.push(step('INCLUDE_UNRESOLVED_CONFLICTS', survivors, new Map()));

  // 8. The owner's pending word on this slot, shown beside the canonical value.
  const slotPropositions = new Set(propositions.map(proposition => proposition.propositionId));
  const overlay = input.overlayDeltas
    .filter(delta => at(delta.createdAt) <= knowledge && PENDING_OVERLAY.has(delta.lifecycle))
    .filter(delta => delta.attachedBeliefSlotId === slot.beliefSlotId
      || (delta.targetPropositionId !== null && slotPropositions.has(delta.targetPropositionId)))
    .map(delta => delta.overlayDeltaId).sort(byId);
  steps.push(step('INCLUDE_APPLICABLE_OVERLAY_DELTAS', overlay, new Map()));

  const correctedTargets = new Set(appliedRelations.filter(entry => entry.fromPropositionId === selected)
    .map(entry => entry.relationKind + ':' + entry.toPropositionId));
  const reason = outcome === 'WITHHELD' ? 'SLOT_PARTLY_WITHHELD_BY_READ_POLICY'
    : outcome === 'EXCLUDED' ? (slotExclusion ?? 'UNREGISTERED_PREDICATE_NOT_AUTHORITATIVE')
      : outcome === 'NO_CURRENT_VALUE' ? 'NO_VALUE_SURVIVED_SELECTION'
        : outcome === 'CONTESTED' ? 'UNRESOLVED_CONFLICT'
          : [...correctedTargets].some(key => key.startsWith('CORRECTS:')) ? 'SELECTED_AFTER_CORRECTION'
            : [...correctedTargets].some(key => key.startsWith('SUPERSEDES:'))
              || [...excludedEver.values()].includes('ASSESSMENT_SUPERSEDED') ? 'SELECTED_AFTER_SUPERSESSION'
              : survivors.length > 1 ? 'ACCEPTED_OVER_UNACCEPTED_COMPETITORS'
                : chosen.get(selected!)!.status === 'PROVISIONAL' ? 'ONLY_PROVISIONAL_VALUE' : 'ONLY_ACCEPTED_VALUE';

  const version = selected ? chosen.get(selected)! : null;
  const selectedClaims = selected ? claims.filter(claim => claim.propositionId === selected) : [];
  return contextSelectionSchema.parse({
    beliefSlotId: slot.beliefSlotId, frameInstanceId: slot.frameInstanceId, frameTypeId: slot.frameTypeId,
    predicateId: slot.predicateId, modality: slot.modality, contextKind: slot.contextKind,
    predicateRegistered: slot.predicateRegistered, outcome, reason,
    selectedPropositionId: selected,
    ...(selected ? { selectedValue: propositionById.get(selected)!.normalizedValue } : {}),
    certainty: version ? (version.status === 'ACCEPTED' ? 'ACCEPTED' : 'PROVISIONAL') : null,
    assessmentId: version?.assessmentId ?? null,
    assessmentStatus: (version?.status ?? null) as ContextSelection['assessmentStatus'],
    validFrom: version?.validFrom ?? null, validTo: version?.validTo ?? null,
    competingPropositionIds: outcome === 'SELECTED' || outcome === 'CONTESTED'
      ? survivors.filter(id => id !== selected).sort(byId) : [],
    claimOrigins: [...new Set(selectedClaims.map(claim => claim.claimOrigin))].sort(byId),
    evidenceIds: [...new Set(selectedClaims.map(claim => claim.evidenceId).filter((id): id is string => id !== null))].sort(byId),
    appliedRelations, overlayDeltaIds: overlay, ownerAssertionPending: overlay.length > 0, steps,
  });
}

/** SHA-256 over the canonical JSON of a list of selections: the value two runs are
 * compared by (CRT-RD-03-A). */
export function selectionsDigest(selections: readonly ContextSelection[]): string {
  return createHash('sha256').update(canonicalJson(selections)).digest('hex');
}

/**
 * Load every slot of the given frames and select each one.
 *
 * The rows come from the canonical tables through the caller's owner transaction,
 * so the row policies apply; a claim whose evidence this request may not read
 * contributes its existence and no evidence id. Registration is judged against
 * the pinned release through the one-boolean reader, once per contract; with no
 * release pinned nothing is registered and nothing is selected (fail closed).
 */
export async function selectCurrentStates(tx: MemoryTransaction, input: {
  ownerScopeId: string; frameInstanceIds: readonly string[]; registryReleaseId: string | null;
  parameters: SelectionParameters; withheldPropositionIds: ReadonlySet<string>;
  outOfViewPropositionIds: ReadonlySet<string>; overlayDeltas: readonly PublicOverlayDelta[];
  /** Broker-authorized provenance; omission retains the standalone reader's
   * existing contract, while an explicit empty set admits no claim metadata. */
  allowedClaimIds?: ReadonlySet<string>;
}): Promise<ContextSelection[]> {
  if (input.frameInstanceIds.length === 0) return [];
  const slots = (await tx.query(
    `SELECT s.id,s.frame_instance_id,s.predicate_id,s.modality,c.context_kind,f.frame_type_id
     FROM belief_slots s
     JOIN frame_instances f ON f.owner_scope_id=s.owner_scope_id AND f.id=s.frame_instance_id
     JOIN context_spaces c ON c.owner_scope_id=s.owner_scope_id AND c.id=s.context_space_id
     WHERE s.owner_scope_id=$1 AND s.frame_instance_id=ANY($2::uuid[]) ORDER BY s.id`,
    [input.ownerScopeId, [...input.frameInstanceIds]])).rows;
  if (slots.length === 0) return [];
  const slotIds = slots.map(row => row['id'] as string);
  const propositions = (await tx.query(
    `SELECT id,belief_slot_id,normalized_value,lifecycle FROM propositions
     WHERE owner_scope_id=$1 AND belief_slot_id=ANY($2::uuid[]) ORDER BY id`, [input.ownerScopeId, slotIds])).rows;
  const propositionIds = propositions.map(row => row['id'] as string);
  const assessments = propositionIds.length === 0 ? [] : (await tx.query(
    `SELECT b.id,b.proposition_id,b.assessment_status,
       coalesce(b.valid_from,(SELECT min(c.valid_from) FROM claims c
         WHERE c.owner_scope_id=b.owner_scope_id AND c.proposition_id=b.proposition_id AND c.recorded_at<=$3
           AND ($4::uuid[] IS NULL OR c.id=ANY($4::uuid[])))) AS valid_from,
       coalesce(b.valid_to,(SELECT max(c.valid_to) FROM claims c
         WHERE c.owner_scope_id=b.owner_scope_id AND c.proposition_id=b.proposition_id AND c.recorded_at<=$3
           AND ($4::uuid[] IS NULL OR c.id=ANY($4::uuid[])))) AS valid_to,
       b.recorded_at,b.superseded_recorded_at
     FROM belief_assessments b WHERE b.owner_scope_id=$1 AND b.proposition_id=ANY($2::uuid[]) ORDER BY b.recorded_at,b.id`,
    [input.ownerScopeId, propositionIds, input.parameters.knowledgeTime,
      input.allowedClaimIds === undefined ? null : [...input.allowedClaimIds]])).rows;
  const claims = propositionIds.length === 0 ? [] : (await tx.query(
    `SELECT c.id,c.proposition_id,c.claim_origin,c.recorded_at,a.source_item_id
     FROM claims c LEFT JOIN source_anchors a ON a.owner_scope_id=c.owner_scope_id AND a.id=c.source_anchor_id
     WHERE c.owner_scope_id=$1 AND c.proposition_id=ANY($2::uuid[])
       AND ($3::uuid[] IS NULL OR c.id=ANY($3::uuid[])) ORDER BY c.id`,
    [input.ownerScopeId, propositionIds, input.allowedClaimIds === undefined ? null : [...input.allowedClaimIds]])).rows;
  const claimIds = claims.map(row => row['id'] as string);
  const relations = claimIds.length === 0 ? [] : (await tx.query(
    `SELECT from_claim_id,to_claim_id,relation_kind,valid_from,created_at FROM claim_relations
     WHERE owner_scope_id=$1 AND to_claim_id=ANY($2::uuid[])
       AND ($3::uuid[] IS NULL OR from_claim_id=ANY($3::uuid[])) ORDER BY id`,
    [input.ownerScopeId, claimIds, input.allowedClaimIds === undefined ? null : [...input.allowedClaimIds]])).rows;

  const presence = new Map<string, boolean>();
  const present = async (contract: string, kind: 'FRAME' | 'PREDICATE'): Promise<boolean> => {
    if (!input.registryReleaseId) return false;
    const key = kind + ':' + contract;
    if (!presence.has(key)) {
      presence.set(key, (await tx.query('SELECT unai_private.registry_contract_present($1,$2,$3) AS present',
        [input.registryReleaseId, contract, kind])).rows[0]?.['present'] === true);
    }
    return presence.get(key)!;
  };
  const iso = (value: unknown): string | null => value ? (value as Date).toISOString() : null;
  const overlay: SelectorOverlayDelta[] = input.overlayDeltas.map(delta => ({
    overlayDeltaId: delta.overlayDeltaId, lifecycle: delta.lifecycle,
    targetPropositionId: delta.target?.objectType === 'proposition' ? delta.target.objectId : null,
    attachedBeliefSlotId: delta.attachedBeliefSlotId, createdAt: delta.createdAt,
  }));

  const selections: ContextSelection[] = [];
  for (const slot of slots) {
    const slotId = slot['id'] as string;
    const own = propositions.filter(row => row['belief_slot_id'] === slotId);
    if (own.length === 0) continue;
    const ownIds = new Set(own.map(row => row['id'] as string));
    const ownClaims = claims.filter(row => ownIds.has(row['proposition_id'] as string));
    const ownClaimIds = new Set(ownClaims.map(row => row['id'] as string));
    const predicateId = slot['predicate_id'] as string;
    const frameTypeId = slot['frame_type_id'] as string;
    selections.push(selectSlotState({
      slot: {
        beliefSlotId: slotId, frameInstanceId: slot['frame_instance_id'] as string, frameTypeId, predicateId,
        modality: slot['modality'] as SelectorSlot['modality'], contextKind: slot['context_kind'] as SelectorSlot['contextKind'],
        predicateRegistered: await present(predicateId, 'PREDICATE') && await present(frameTypeId, 'FRAME'),
      },
      propositions: own.map(row => ({
        propositionId: row['id'] as string, lifecycle: row['lifecycle'] as string, normalizedValue: row['normalized_value'],
        withheld: input.withheldPropositionIds.has(row['id'] as string),
        outOfView: input.outOfViewPropositionIds.has(row['id'] as string),
      })),
      assessments: assessments.filter(row => ownIds.has(row['proposition_id'] as string)).map(row => ({
        assessmentId: row['id'] as string, propositionId: row['proposition_id'] as string,
        status: row['assessment_status'] as string, validFrom: iso(row['valid_from']), validTo: iso(row['valid_to']),
        recordedAt: iso(row['recorded_at'])!, supersededRecordedAt: iso(row['superseded_recorded_at']),
      })),
      claims: ownClaims.map(row => ({
        claimId: row['id'] as string, propositionId: row['proposition_id'] as string,
        claimOrigin: row['claim_origin'] as string, recordedAt: iso(row['recorded_at'])!,
        evidenceId: (row['source_item_id'] as string | null) ?? null,
      })),
      relations: relations.filter(row => ownClaimIds.has(row['to_claim_id'] as string)).map(row => ({
        fromClaimId: row['from_claim_id'] as string, toClaimId: row['to_claim_id'] as string,
        relationKind: row['relation_kind'] as string, validFrom: iso(row['valid_from']), createdAt: iso(row['created_at'])!,
      })),
      overlayDeltas: overlay,
    }, input.parameters));
  }
  return selections;
}
