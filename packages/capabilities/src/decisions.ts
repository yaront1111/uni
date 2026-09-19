import {
  DECISION_FRAME_TYPE, DECISION_REVIEW_CONTRACT, decisionProjectionRowSchema, decisionProjectionViewSchema,
  projectionRebuildReceiptSchema, rebuildTriggerSchema, recordDecisionSchema,
  type DecisionProjectionRow, type DecisionProjectionView, type LifeCategory, type OutcomeCode, type PendingAssertion,
  type PredictionComparison, type ProjectionRebuildReceipt, type RebuildTrigger, type RecordDecision, type TransitionContract,
} from '@unai/domain';
import {
  canonicalJson, createFrameInstance, frameOutcomeProjection, recordClaim, recordFrameInstanceRole, recordMemoryLink,
  recordResolutionAssertion, resolveBeliefSlot, resolveEntity, resolveProposition, type MemoryTransaction,
} from '@unai/memory';
import { uuidV7 } from '../../../src/kernel/identities.js';
import {
  isSettledDelta, latestTime, listFrameInstances, pendingAssertion, readOwnerDeltas, readResolutions, readRoles,
  readSlotValues, readWatermarks, roleEntity, roleValue, selectSlotValue,
  type CanonicalWatermarks, type OwnerDelta, type SlotValue,
} from './canonical.js';
import { PROJECTION_PURPOSE } from './projections.js';

/**
 * The decisions capability and `decision_projection` (PRD §7.4, §25.3, §44.9,
 * §52; registry release 0.2.0 `shared.decision`; ADR 0029 §3, §4, §6;
 * CRT-DEC-01-A, CRT-DEC-02-A).
 *
 * Three rules this file exists to hold:
 *
 *  1. **A decision is the owner's statement, canonicalized, not accepted.** Every
 *     field becomes a proposition in its registry slot with a `USER_STATEMENT`
 *     claim anchored on the owner's own words. Acceptance stays a governed
 *     belief transaction, as for a commitment.
 *  2. **A prediction is never edited by its outcome.** The review records what
 *     happened in the `observed_result` ACTUAL slot and a resolution assertion
 *     whose source proposition is the PREDICTED `expected_result`. Nothing here
 *     writes to an existing slot, proposition or claim; every write is an insert.
 *  3. **One reducer.** `applyDecisionProjection` and `replayDecisionProjection`
 *     differ only in which frames they hand to `buildDecisionRows`, as in
 *     `projections.ts` (ADR 0021): no clock, inputs recorded in the manifest,
 *     the owner overlay folded in memory on read.
 */

export const DECISION_CAPABILITY_VERSION = 'capability-decisions-0.1.0';
export const DECISION_REDUCER_VERSION = 'decision-reducer-0.1.0';
export const DECISION_PROJECTION = 'decision_projection';
export { DECISION_FRAME_TYPE, DECISION_REVIEW_CONTRACT };

export class DecisionError extends Error {
  constructor(code: string) { super(code); this.name = 'DecisionError'; }
}

const predicate = (name: string) => DECISION_FRAME_TYPE + '.' + name;
export const DECISION_PREDICATES = Object.freeze({
  question: { id: predicate('question'), modality: 'ACTUAL' },
  option: { id: predicate('option'), modality: 'ACTUAL' },
  assumption: { id: predicate('assumption'), modality: 'EXPECTED' },
  consequence: { id: predicate('consequence'), modality: 'EXPECTED' },
  recommendation: { id: predicate('recommendation'), modality: 'RECOMMENDED' },
  choice: { id: predicate('choice'), modality: 'ACTUAL' },
  rationale: { id: predicate('rationale'), modality: 'ACTUAL' },
  expectedResult: { id: predicate('expected_result'), modality: 'PREDICTED' },
  reviewDate: { id: predicate('review_date'), modality: 'INTENDED' },
  observedResult: { id: predicate('observed_result'), modality: 'ACTUAL' },
} as const);
type DecisionPredicate = keyof typeof DECISION_PREDICATES;

// ---------------------------------------------------------------------------
// The owner's statement: one text, one span per stated value
// ---------------------------------------------------------------------------

const DOMAIN_WORDS: Readonly<Record<LifeCategory, string>> = Object.freeze({
  FINANCE: 'Finance', FAMILY: 'Family', WORK: 'Work', HEALTH: 'Health', ADMIN: 'Administration', PERSONAL: 'Personal',
});

export interface StatementSpan { readonly key: string; readonly start: number; readonly end: number }
export interface RenderedStatement { readonly text: string; readonly spans: readonly StatementSpan[] }

/** Render a decision as the owner's statement, with the character span of each
 * stated value. The evidence stores this text; each claim anchors on its span,
 * so "where did this come from" answers with the owner's exact words. */
export function renderDecisionStatement(raw: RecordDecision): RenderedStatement {
  const decision = recordDecisionSchema.parse(raw);
  let text = '';
  const spans: StatementSpan[] = [];
  const line = (label: string, key: string, value: string) => {
    text += label + ': ';
    spans.push({ key, start: text.length, end: text.length + value.length });
    text += value + '\n';
  };
  line('Decision', 'question', decision.question);
  decision.options.forEach((option, index) => line('Option ' + (index + 1), 'option:' + index, option));
  decision.assumptions.forEach((assumption, index) => line('Assumption ' + (index + 1), 'assumption:' + index, assumption.text));
  decision.consequences.forEach((consequence, index) =>
    line('Consequence (' + DOMAIN_WORDS[consequence.domain] + ')', 'consequence:' + index, consequence.text));
  if (decision.recommendation) line('Recommendation received', 'recommendation', decision.recommendation);
  if (decision.userChoice) line('My choice', 'choice', decision.userChoice);
  if (decision.rationale) line('Why', 'rationale', decision.rationale);
  if (decision.expectedResult) line('Expected result', 'expected_result', decision.expectedResult);
  if (decision.reviewDate) line('Review on', 'review_date', new Date(decision.reviewDate).toISOString());
  return Object.freeze({ text: text.trimEnd(), spans: Object.freeze(spans) });
}

/** The owner as a person entity, found by the one strong alias every owner
 * statement shares: the account's own user id. Under-merge holds (ADR 0015 §3):
 * only that exact alias reuses the entity. */
export async function resolveOwnerEntity(tx: MemoryTransaction, input: { ownerScopeId: string; actorId: string }): Promise<string> {
  return (await resolveEntity(tx, {
    ownerScopeId: input.ownerScopeId, entityKind: 'PERSON',
    aliases: [{ aliasType: 'EXTERNAL_ID', aliasValue: 'unai-user:' + input.actorId }],
  })).entityId;
}

/** Evidence the owner cites must exist for this owner and be readable under the
 * request's own evidence context; a source the caller cannot read cannot be
 * cited on their behalf. */
async function assertCitable(tx: MemoryTransaction, ownerScopeId: string, evidenceIds: readonly string[]): Promise<void> {
  const unique = [...new Set(evidenceIds)];
  if (unique.length === 0) return;
  const found = (await tx.query('SELECT id FROM source_items WHERE owner_scope_id=$1 AND id=ANY($2::uuid[]) AND deleted_at IS NULL',
    [ownerScopeId, unique])).rows.length;
  if (found !== unique.length) throw new DecisionError('DECISION_SOURCE_UNKNOWN');
}

export interface DecisionStatementRequest {
  readonly ownerScopeId: string;
  readonly contextSpaceId: string;
  readonly decision: RecordDecision;
  readonly deciderEntityId: string;
  /** The anchor of each stated value, by the span key `renderDecisionStatement` gave it. */
  readonly anchorFor: (key: string) => string;
  readonly statedAt: Date;
  readonly registryReleaseId?: string | null;
}

export interface CanonicalizedDecision {
  readonly decisionFrameInstanceId: string;
  readonly propositionIds: Readonly<Record<string, string>>;
  readonly claimIds: readonly string[];
  readonly citationLinkIds: readonly string[];
  readonly capabilityVersion: string;
}

/**
 * Canonicalize one recorded decision (ADR 0029 §3).
 *
 * Runs under `memory.canonicalize`. Writes one `shared.decision` frame, its
 * roles, a slot per predicate at the modality release 0.2.0 allows it, a
 * proposition per stated value and a `USER_STATEMENT` claim per proposition,
 * lifecycle `CANDIDATE`. Nothing is accepted here.
 */
export async function canonicalizeDecision(tx: MemoryTransaction, request: DecisionStatementRequest): Promise<CanonicalizedDecision> {
  const decision = recordDecisionSchema.parse(request.decision);
  const release = request.registryReleaseId ?? null;
  await assertCitable(tx, request.ownerScopeId, decision.assumptions.flatMap(assumption => assumption.sourceEvidenceIds));
  // The goal reference is a product record the caller checked under its own
  // purpose; the frame names it as a typed role value and the projection's foreign
  // key holds it to a goal that exists.
  const decisionFrameInstanceId = await createFrameInstance(tx, {
    ownerScopeId: request.ownerScopeId, frameTypeId: DECISION_FRAME_TYPE, contextSpaceId: request.contextSpaceId,
  });
  const propositionIds: Record<string, string> = {};
  const claimIds: string[] = [];
  // A listed value (an option, an assumption, a consequence) sits in its own slot,
  // qualified by its position in the owner's list (release 0.2.0): two options
  // are two members of the set, never two competing values in one slot.
  const state = async (field: DecisionPredicate, key: string, normalizedValue: unknown): Promise<string> => {
    const contract = DECISION_PREDICATES[field];
    const position = key.includes(':') ? Number(key.split(':')[1]) : null;
    const beliefSlotId = (await resolveBeliefSlot(tx, {
      ownerScopeId: request.ownerScopeId, registryReleaseId: release,
      descriptor: { frameInstanceId: decisionFrameInstanceId, predicateId: contract.id, contextSpaceId: request.contextSpaceId,
        modality: contract.modality, qualifiers: position === null ? {} : { position } },
    })).beliefSlotId;
    const proposition = await resolveProposition(tx, {
      ownerScopeId: request.ownerScopeId, beliefSlotId, normalizedValue, registryReleaseId: release,
    });
    claimIds.push(await recordClaim(tx, {
      ownerScopeId: request.ownerScopeId, sourceAnchorId: request.anchorFor(key), claimOrigin: 'USER_STATEMENT',
      lifecycle: 'CANDIDATE', propositionId: proposition.propositionId, candidateFrameTypeId: DECISION_FRAME_TYPE,
      assertedByEntityId: request.deciderEntityId, validFrom: request.statedAt,
      metadata: { decisionField: key, capabilityVersion: DECISION_CAPABILITY_VERSION },
    }));
    propositionIds[key] = proposition.propositionId;
    return proposition.propositionId;
  };

  await state('question', 'question', { text: decision.question });
  for (const [index, option] of decision.options.entries()) await state('option', 'option:' + index, { text: option });
  const citationLinkIds: string[] = [];
  for (const [index, assumption] of decision.assumptions.entries()) {
    const assumptionId = await state('assumption', 'assumption:' + index, { text: assumption.text });
    for (const evidenceId of [...new Set(assumption.sourceEvidenceIds)]) {
      citationLinkIds.push(await recordMemoryLink(tx, {
        ownerScopeId: request.ownerScopeId, linkKind: 'REFERENCES', lifecycle: 'ACTIVE',
        from: { objectType: 'proposition', objectId: assumptionId }, to: { objectType: 'source_item', objectId: evidenceId },
        metadata: { citedFor: 'shared.decision.assumption', capabilityVersion: DECISION_CAPABILITY_VERSION },
      }));
    }
  }
  for (const [index, consequence] of decision.consequences.entries()) {
    await state('consequence', 'consequence:' + index, { text: consequence.text, domain: consequence.domain });
  }
  if (decision.recommendation) await state('recommendation', 'recommendation', { text: decision.recommendation });
  if (decision.userChoice) await state('choice', 'choice', { text: decision.userChoice });
  if (decision.rationale) await state('rationale', 'rationale', { text: decision.rationale });
  if (decision.expectedResult) await state('expectedResult', 'expected_result', { text: decision.expectedResult });
  if (decision.reviewDate) await state('reviewDate', 'review_date', { time: new Date(decision.reviewDate).toISOString() });

  const questionClaim = claimIds[0]!;
  await recordFrameInstanceRole(tx, { ownerScopeId: request.ownerScopeId, frameInstanceId: decisionFrameInstanceId,
    roleId: 'decider', entityId: request.deciderEntityId, claimId: questionClaim });
  if (decision.goalId) {
    await recordFrameInstanceRole(tx, { ownerScopeId: request.ownerScopeId, frameInstanceId: decisionFrameInstanceId,
      roleId: 'related_goal', typedValue: { goalId: decision.goalId }, claimId: questionClaim });
  }
  return Object.freeze({ decisionFrameInstanceId, propositionIds: Object.freeze(propositionIds),
    claimIds: Object.freeze(claimIds), citationLinkIds: Object.freeze(citationLinkIds), capabilityVersion: DECISION_CAPABILITY_VERSION });
}

/** The decision a retried request already canonicalized from the same evidence
 * row, so a retry answers the first decision instead of creating a second. */
export async function findDecisionForEvidence(tx: MemoryTransaction, input: { ownerScopeId: string; evidenceId: string }): Promise<string | null> {
  const row = (await tx.query(
    `SELECT s.frame_instance_id FROM claims c
     JOIN source_anchors a ON a.owner_scope_id=c.owner_scope_id AND a.id=c.source_anchor_id
     JOIN propositions p ON p.owner_scope_id=c.owner_scope_id AND p.id=c.proposition_id
     JOIN belief_slots s ON s.owner_scope_id=p.owner_scope_id AND s.id=p.belief_slot_id
     WHERE c.owner_scope_id=$1 AND a.source_item_id=$2 AND s.predicate_id=$3
     ORDER BY c.recorded_at,c.id LIMIT 1`,
    [input.ownerScopeId, input.evidenceId, DECISION_PREDICATES.question.id])).rows[0];
  return (row?.['frame_instance_id'] as string | undefined) ?? null;
}

// ---------------------------------------------------------------------------
// The prediction review (ADR 0029 §6)
// ---------------------------------------------------------------------------

export interface DecisionReviewRequest {
  readonly ownerScopeId: string;
  readonly contextSpaceId: string;
  readonly decisionFrameInstanceId: string;
  readonly reviewerEntityId: string;
  /** What happened, in the owner's words. Null when only evidence is cited. */
  readonly actualOutcome: string | null;
  readonly actualOutcomeEvidenceId: string | null;
  readonly outcomeCode: OutcomeCode;
  readonly transitionContractId: string;
  readonly transitionContracts: readonly TransitionContract[];
  readonly effectiveAt: Date;
  /** The anchor of the observed result and of the reviewer's verdict in the
   * review statement's evidence. */
  readonly observedAnchorId: string;
  readonly verdictAnchorId: string;
  readonly registryReleaseId?: string | null;
}

/** Text of an evidence item cited as the actual outcome: its first anchored
 * words, read under the request's own evidence context. */
async function citedOutcomeText(tx: MemoryTransaction, ownerScopeId: string, evidenceId: string): Promise<string> {
  await assertCitable(tx, ownerScopeId, [evidenceId]);
  const anchor = (await tx.query(
    `SELECT normalized_text FROM source_anchors WHERE owner_scope_id=$1 AND source_item_id=$2 AND normalized_text IS NOT NULL
     ORDER BY id LIMIT 1`, [ownerScopeId, evidenceId])).rows[0];
  const words = (anchor?.['normalized_text'] as string | undefined)?.trim();
  return words ? words.slice(0, 1000) : 'Recorded in the cited source.';
}

async function claimEvidence(tx: MemoryTransaction, ownerScopeId: string, claimIds: readonly string[]): Promise<string[]> {
  if (claimIds.length === 0) return [];
  return (await tx.query(
    `SELECT DISTINCT a.source_item_id FROM claims c JOIN source_anchors a ON a.owner_scope_id=c.owner_scope_id AND a.id=c.source_anchor_id
     WHERE c.owner_scope_id=$1 AND c.id=ANY($2::uuid[]) ORDER BY a.source_item_id`, [ownerScopeId, [...claimIds]])).rows
    .map(row => row['source_item_id'] as string);
}

/**
 * Record one prediction review: the observed result in its own ACTUAL slot and a
 * proposed resolution assertion over the PREDICTED expected result, validated
 * against the pinned transition contract. The prediction's slot, proposition and
 * claims are only read.
 */
export async function recordDecisionReview(tx: MemoryTransaction, request: DecisionReviewRequest): Promise<PredictionComparison> {
  const frames = await listFrameInstances(tx, { ownerScopeId: request.ownerScopeId, frameTypeId: DECISION_FRAME_TYPE,
    frameInstanceIds: [request.decisionFrameInstanceId] });
  if (frames.length === 0) throw new DecisionError('DECISION_NOT_FOUND');
  const predictions = await readSlotValues(tx, { ownerScopeId: request.ownerScopeId, frameInstanceIds: [request.decisionFrameInstanceId],
    predicateId: DECISION_PREDICATES.expectedResult.id, modality: 'PREDICTED' });
  const predicted = selectSlotValue(predictions);
  if (!predicted) throw new DecisionError('DECISION_PREDICTION_MISSING');
  const release = request.registryReleaseId ?? null;

  const actualText = request.actualOutcome
    ?? await citedOutcomeText(tx, request.ownerScopeId, request.actualOutcomeEvidenceId!);
  if (request.actualOutcomeEvidenceId) await assertCitable(tx, request.ownerScopeId, [request.actualOutcomeEvidenceId]);
  const slot = await resolveBeliefSlot(tx, {
    ownerScopeId: request.ownerScopeId, registryReleaseId: release,
    descriptor: { frameInstanceId: request.decisionFrameInstanceId, predicateId: DECISION_PREDICATES.observedResult.id,
      contextSpaceId: request.contextSpaceId, modality: 'ACTUAL', qualifiers: {} },
  });
  const actual = await resolveProposition(tx, {
    ownerScopeId: request.ownerScopeId, beliefSlotId: slot.beliefSlotId, normalizedValue: { text: actualText },
    registryReleaseId: release,
  });
  const actualClaimId = await recordClaim(tx, {
    ownerScopeId: request.ownerScopeId, sourceAnchorId: request.observedAnchorId, claimOrigin: 'USER_STATEMENT',
    lifecycle: 'CANDIDATE', propositionId: actual.propositionId, candidateFrameTypeId: DECISION_FRAME_TYPE,
    assertedByEntityId: request.reviewerEntityId, validFrom: request.effectiveAt,
    metadata: { decisionField: 'observed_result', capabilityVersion: DECISION_CAPABILITY_VERSION },
  });
  const citedEvidenceIds: string[] = [];
  if (request.actualOutcomeEvidenceId) {
    await recordMemoryLink(tx, {
      ownerScopeId: request.ownerScopeId, linkKind: 'REFERENCES', lifecycle: 'ACTIVE',
      from: { objectType: 'proposition', objectId: actual.propositionId },
      to: { objectType: 'source_item', objectId: request.actualOutcomeEvidenceId },
      metadata: { citedFor: DECISION_PREDICATES.observedResult.id, capabilityVersion: DECISION_CAPABILITY_VERSION },
    });
    citedEvidenceIds.push(request.actualOutcomeEvidenceId);
  }
  // The verdict is its own claim: the reviewer asserted how the prediction held,
  // which is a statement about the pair, not a value in either slot.
  const verdictClaimId = await recordClaim(tx, {
    ownerScopeId: request.ownerScopeId, sourceAnchorId: request.verdictAnchorId, claimOrigin: 'USER_STATEMENT',
    lifecycle: 'CANDIDATE', propositionId: null, candidateFrameTypeId: DECISION_FRAME_TYPE,
    assertedByEntityId: request.reviewerEntityId, validFrom: request.effectiveAt,
    metadata: { reviewOf: predicted.propositionId, observedResult: actual.propositionId, outcomeCode: request.outcomeCode },
  });
  const recorded = await recordResolutionAssertion(tx, {
    ownerScopeId: request.ownerScopeId, sourceFrameInstanceId: request.decisionFrameInstanceId,
    sourceFrameTypeId: DECISION_FRAME_TYPE, sourcePropositionId: predicted.propositionId,
    outcomeCode: request.outcomeCode, effectiveAt: request.effectiveAt, assertedByEntityId: request.reviewerEntityId,
    claimId: verdictClaimId, transitionContractId: request.transitionContractId,
    transitionContracts: request.transitionContracts, lifecycle: 'PROPOSED',
    metadata: { observedResultPropositionId: actual.propositionId, capabilityVersion: DECISION_CAPABILITY_VERSION },
  });
  const code = recorded.outcomeCode;
  if (code !== 'CONFIRMED' && code !== 'REFUTED' && code !== 'PARTIALLY_CONFIRMED') throw new DecisionError('DECISION_REVIEW_CODE_REFUSED');
  return {
    decisionFrameInstanceId: request.decisionFrameInstanceId,
    predicted: { propositionId: predicted.propositionId, text: textOf(predicted.normalizedValue) ?? '', modality: 'PREDICTED',
      claimIds: [...predicted.claimIds], evidenceIds: await claimEvidence(tx, request.ownerScopeId, predicted.claimIds) },
    actual: { propositionId: actual.propositionId, text: actualText, modality: 'ACTUAL', claimIds: [actualClaimId],
      evidenceIds: await claimEvidence(tx, request.ownerScopeId, [actualClaimId]), citedEvidenceIds },
    resolutionAssertionId: recorded.resolutionAssertionId, resolutionCode: code, resolutionLifecycle: 'PROPOSED',
    transitionContractId: request.transitionContractId, effectiveAt: request.effectiveAt.toISOString(),
  };
}

/** Every recorded review of one decision, oldest first, as predicted-versus-actual
 * pairs. Read under a purpose that sees claims, resolutions and anchors. */
export async function listDecisionReviews(tx: MemoryTransaction, input: {
  ownerScopeId: string; decisionFrameInstanceId: string;
}): Promise<PredictionComparison[]> {
  const rows = (await tx.query(
    `SELECT r.id,r.outcome_code,r.lifecycle,r.transition_contract_id,r.effective_at,r.source_proposition_id,r.metadata
     FROM resolution_assertions r WHERE r.owner_scope_id=$1 AND r.source_frame_instance_id=$2
       AND r.outcome_code IN ('CONFIRMED','REFUTED','PARTIALLY_CONFIRMED') AND r.source_proposition_id IS NOT NULL
     ORDER BY r.effective_at,r.recorded_at,r.id`, [input.ownerScopeId, input.decisionFrameInstanceId])).rows;
  const comparisons: PredictionComparison[] = [];
  for (const row of rows) {
    const actualId = (row['metadata'] as Record<string, unknown> | null)?.['observedResultPropositionId'];
    if (typeof actualId !== 'string') continue;
    const read = async (propositionId: string) => {
      const proposition = (await tx.query('SELECT normalized_value FROM propositions WHERE owner_scope_id=$1 AND id=$2',
        [input.ownerScopeId, propositionId])).rows[0];
      const claims = (await tx.query('SELECT id FROM claims WHERE owner_scope_id=$1 AND proposition_id=$2 ORDER BY recorded_at,id',
        [input.ownerScopeId, propositionId])).rows.map(claim => claim['id'] as string);
      return { text: textOf(proposition?.['normalized_value']) ?? '', claimIds: claims,
        evidenceIds: await claimEvidence(tx, input.ownerScopeId, claims) };
    };
    const predicted = await read(row['source_proposition_id'] as string);
    const actual = await read(actualId);
    const cited = (await tx.query(
      `SELECT to_object_id FROM memory_links WHERE owner_scope_id=$1 AND link_kind='REFERENCES' AND from_object_type='proposition'
         AND from_object_id=$2 AND to_object_type='source_item' AND lifecycle<>'RETRACTED' ORDER BY created_at,id`,
      [input.ownerScopeId, actualId])).rows.map(link => link['to_object_id'] as string);
    comparisons.push({
      decisionFrameInstanceId: input.decisionFrameInstanceId,
      predicted: { propositionId: row['source_proposition_id'] as string, modality: 'PREDICTED', ...predicted },
      actual: { propositionId: actualId, modality: 'ACTUAL', ...actual, citedEvidenceIds: cited },
      resolutionAssertionId: row['id'] as string,
      resolutionCode: row['outcome_code'] as 'CONFIRMED' | 'REFUTED' | 'PARTIALLY_CONFIRMED',
      resolutionLifecycle: row['lifecycle'] as PredictionComparison['resolutionLifecycle'],
      transitionContractId: row['transition_contract_id'] as string,
      effectiveAt: (row['effective_at'] as Date).toISOString(),
    });
  }
  return comparisons;
}

// ---------------------------------------------------------------------------
// The reducer
// ---------------------------------------------------------------------------

function textOf(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'object' && value !== null) {
    const candidate = (value as Record<string, unknown>)['text'];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return null;
}
function timeOf(value: unknown): Date | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = (value as Record<string, unknown>)['time'];
  if (typeof raw !== 'string') return null;
  const time = new Date(raw);
  return Number.isNaN(time.getTime()) ? null : time;
}
const LIFE_DOMAINS: readonly string[] = ['FINANCE', 'FAMILY', 'WORK', 'HEALTH', 'ADMIN', 'PERSONAL'];
function domainOf(value: unknown): LifeCategory {
  const raw = typeof value === 'object' && value !== null ? (value as Record<string, unknown>)['domain'] : null;
  return (typeof raw === 'string' && LIFE_DOMAINS.includes(raw) ? raw : 'PERSONAL') as LifeCategory;
}
/** A set, in the order it was stated. */
const inOrder = (values: readonly SlotValue[]) => [...values].sort((left, right) =>
  left.createdAt.getTime() - right.createdAt.getTime() || left.propositionId.localeCompare(right.propositionId));
const conflicting = (values: readonly SlotValue[]) => new Set(values.map(value => canonicalJson(value.normalizedValue ?? null))).size > 1;

const HIDING_KINDS = new Set(['SUPPRESSION', 'ARCHIVE', 'DELETION']);
const NEUTRAL_KINDS = new Set(['USER_CONFIRMATION', 'USER_REJECTION', 'KEEP_UNCERTAIN']);
const GOVERNED_KINDS = new Set(['MERGE', 'SPLIT']);

interface DecisionFold { readonly applied: string[]; readonly pending: PendingAssertion[]; readonly suppressed: boolean; readonly latestAt: Date | null }

/** The owner's writes about one decision. A decision's fields are the owner's own
 * words and no sentence restates one safely, so a value-stating delta is shown as
 * pending rather than guessed into a column. */
function foldDecisionDeltas(deltas: readonly OwnerDelta[]): DecisionFold {
  const applied: string[] = [];
  const pending: PendingAssertion[] = [];
  let suppressed = false;
  let latestAt: Date | null = null;
  for (const delta of deltas) {
    if (isSettledDelta(delta)) continue;
    latestAt = latestTime([latestAt, delta.createdAt], delta.createdAt);
    if (delta.lifecycle === 'CONTESTED') { pending.push(pendingAssertion(delta, 'DELTA_CONTESTED')); continue; }
    if (GOVERNED_KINDS.has(delta.deltaKind)) { pending.push(pendingAssertion(delta, 'DELTA_KIND_NOT_REDUCIBLE')); continue; }
    if (HIDING_KINDS.has(delta.deltaKind)) { suppressed = true; applied.push(delta.overlayDeltaId); continue; }
    if (NEUTRAL_KINDS.has(delta.deltaKind)) { applied.push(delta.overlayDeltaId); continue; }
    pending.push(pendingAssertion(delta, 'DELTA_VALUE_UNPARSEABLE'));
  }
  return { applied, pending, suppressed, latestAt };
}

async function deltasByFrame(tx: MemoryTransaction, ownerScopeId: string): Promise<{ byFrame: Map<string, OwnerDelta[]>; watermark: number }> {
  const byFrame = new Map<string, OwnerDelta[]>();
  let watermark = 0;
  for (const delta of await readOwnerDeltas(tx, ownerScopeId)) {
    watermark = Math.max(watermark, delta.ownerSequence);
    if (delta.frameInstanceId === null) continue;
    byFrame.set(delta.frameInstanceId, [...(byFrame.get(delta.frameInstanceId) ?? []), delta]);
  }
  return { byFrame, watermark };
}

const REVIEW_CODES = new Set(['CONFIRMED', 'REFUTED', 'PARTIALLY_CONFIRMED']);
const STANDING = new Set(['PROPOSED', 'ACCEPTED', 'CONTESTED']);

async function buildDecisionRows(tx: MemoryTransaction, input: {
  ownerScopeId: string; asOf: Date; projectionVersion: string; watermarks: CanonicalWatermarks;
  frameInstanceIds?: readonly string[] | undefined;
}): Promise<DecisionProjectionRow[]> {
  const frames = await listFrameInstances(tx, { ownerScopeId: input.ownerScopeId, frameTypeId: DECISION_FRAME_TYPE,
    frameInstanceIds: input.frameInstanceIds });
  if (frames.length === 0) return [];
  const ids = frames.map(frame => frame.frameInstanceId);
  const read = (field: DecisionPredicate) => readSlotValues(tx, { ownerScopeId: input.ownerScopeId, frameInstanceIds: ids,
    predicateId: DECISION_PREDICATES[field].id, modality: DECISION_PREDICATES[field].modality });
  const values = Object.fromEntries(await Promise.all((Object.keys(DECISION_PREDICATES) as DecisionPredicate[])
    .map(async field => [field, await read(field)] as const))) as Record<DecisionPredicate, SlotValue[]>;
  const roles = await readRoles(tx, { ownerScopeId: input.ownerScopeId, frameInstanceIds: ids });
  const resolutions = await readResolutions(tx, { ownerScopeId: input.ownerScopeId, frameInstanceIds: ids });
  const assumptionIds = values.assumption.map(value => value.propositionId);
  const citations = assumptionIds.length === 0 ? [] : (await tx.query(
    `SELECT from_object_id,to_object_id,created_at FROM memory_links WHERE owner_scope_id=$1 AND link_kind='REFERENCES'
       AND from_object_type='proposition' AND from_object_id=ANY($2::uuid[]) AND to_object_type='source_item'
       AND lifecycle<>'RETRACTED' ORDER BY from_object_id,created_at,id`, [input.ownerScopeId, assumptionIds])).rows;
  const overlay = await deltasByFrame(tx, input.ownerScopeId);

  const rows: DecisionProjectionRow[] = [];
  for (const frame of frames) {
    const of = (field: DecisionPredicate) => values[field].filter(value => value.frameInstanceId === frame.frameInstanceId);
    const selected = (field: DecisionPredicate) => selectSlotValue(of(field));
    const fold = foldDecisionDeltas(overlay.byFrame.get(frame.frameInstanceId) ?? []);
    const frameResolutions = resolutions.filter(resolution => resolution.sourceFrameInstanceId === frame.frameInstanceId);
    const reviews = frameResolutions.filter(resolution => REVIEW_CODES.has(resolution.outcomeCode) && STANDING.has(resolution.lifecycle));
    const latestReview = reviews.at(-1) ?? null;
    const outcome = await frameOutcomeProjection(tx, { ownerScopeId: input.ownerScopeId, frameInstanceId: frame.frameInstanceId, asOf: input.asOf });
    const reviewDate = timeOf(selected('reviewDate')?.normalizedValue);
    const goal = roleValue(roles, frame.frameInstanceId, 'related_goal') as Record<string, unknown> | null;
    const allValues = (Object.keys(DECISION_PREDICATES) as DecisionPredicate[]).flatMap(of);
    const functional: DecisionPredicate[] = ['question', 'recommendation', 'choice', 'rationale', 'expectedResult', 'reviewDate', 'observedResult'];
    const updatedAt = latestTime([
      ...allValues.map(value => value.latestClaimAt), ...frameResolutions.map(resolution => resolution.recordedAt),
      ...citations.filter(link => allValues.some(value => value.propositionId === link['from_object_id']))
        .map(link => link['created_at'] as Date),
      fold.latestAt,
    ], frame.createdAt);

    rows.push(decisionProjectionRowSchema.parse({
      ownerScopeId: input.ownerScopeId,
      projectionVersion: input.projectionVersion,
      canonicalTransactionWatermark: input.watermarks.canonicalTransactionWatermark.toISOString(),
      ownerOverlayWatermark: input.watermarks.ownerOverlayWatermark,
      reducerVersion: DECISION_REDUCER_VERSION,
      isComplete: fold.pending.length === 0,
      sourceManifest: {
        frameInstanceId: frame.frameInstanceId, frameTypeId: frame.frameTypeId,
        beliefSlotIds: [...new Set(allValues.map(value => value.beliefSlotId))].sort(),
        propositionIds: allValues.map(value => value.propositionId).sort(),
        claimIds: [...new Set(allValues.flatMap(value => [...value.claimIds]))].sort(),
        resolutionAssertionIds: frameResolutions.map(resolution => resolution.resolutionAssertionId),
        acceptedResolutionIds: [...outcome.acceptedResolutionIds],
        deciderEntityId: roleEntity(roles, frame.frameInstanceId, 'decider'),
        rationalePropositionId: selected('rationale')?.propositionId ?? null,
        choicePropositionId: selected('choice')?.propositionId ?? null,
        observedResultPropositionId: selected('observedResult')?.propositionId ?? null,
        appliedOverlayDeltaIds: [...fold.applied],
        ownerSuppressed: fold.suppressed,
        pendingAssertions: [...fold.pending],
        reducerVersion: DECISION_REDUCER_VERSION,
      },
      updatedAt: updatedAt.toISOString(),
      decisionFrameInstanceId: frame.frameInstanceId,
      question: textOf(selected('question')?.normalizedValue),
      alternatives: inOrder(of('option')).map(value => ({ propositionId: value.propositionId, text: textOf(value.normalizedValue) ?? '' }))
        .filter(value => value.text !== ''),
      assumptions: inOrder(of('assumption')).map(value => ({
        propositionId: value.propositionId, text: textOf(value.normalizedValue) ?? '', claimIds: [...value.claimIds],
        citedEvidenceIds: citations.filter(link => link['from_object_id'] === value.propositionId).map(link => link['to_object_id'] as string),
      })).filter(value => value.text !== ''),
      crossDomainConsequences: inOrder(of('consequence')).map(value => ({ propositionId: value.propositionId,
        text: textOf(value.normalizedValue) ?? '', domain: domainOf(value.normalizedValue) })).filter(value => value.text !== ''),
      recommendation: textOf(selected('recommendation')?.normalizedValue),
      userChoice: textOf(selected('choice')?.normalizedValue),
      rationale: textOf(selected('rationale')?.normalizedValue),
      expectedResult: textOf(selected('expectedResult')?.normalizedValue),
      reviewDate: reviewDate?.toISOString() ?? null,
      // The clock moves this flag and nothing else: a passed review date creates
      // no review and no resolution assertion.
      reviewDue: reviewDate !== null && reviewDate.getTime() <= input.asOf.getTime() && latestReview === null,
      actualOutcome: textOf(selected('observedResult')?.normalizedValue),
      reviewOutcomeCode: latestReview?.outcomeCode ?? null,
      reviewLifecycle: latestReview?.lifecycle ?? null,
      outcomeState: outcome.state,
      relatedGoalId: typeof goal?.['goalId'] === 'string' ? goal['goalId'] : null,
      predictedOutcomePropositionIds: of('expectedResult').map(value => value.propositionId).sort(),
      actualResolutionIds: reviews.map(resolution => resolution.resolutionAssertionId),
      conflictFlag: outcome.state === 'CONTESTED' || functional.some(field => conflicting(of(field))),
      pendingAssertions: [...fold.pending],
    }));
  }
  return rows;
}

async function writeDecisionRow(tx: MemoryTransaction, row: DecisionProjectionRow): Promise<void> {
  await tx.query(
    `INSERT INTO decision_projection(owner_scope_id,decision_frame_instance_id,question,alternatives,assumptions,
      cross_domain_consequences,recommendation,user_choice,rationale,expected_result,review_date,review_due,actual_outcome,
      review_outcome_code,review_lifecycle,outcome_state,related_goal_id,predicted_outcome_proposition_ids,actual_resolution_ids,
      conflict_flag,projection_version,canonical_transaction_watermark,owner_overlay_watermark,reducer_version,is_complete,
      source_manifest,updated_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::uuid[],$19::uuid[],$20,$21,$22,$23,$24,$25,$26,$27)
     ON CONFLICT(owner_scope_id,decision_frame_instance_id) DO UPDATE SET
      question=EXCLUDED.question, alternatives=EXCLUDED.alternatives, assumptions=EXCLUDED.assumptions,
      cross_domain_consequences=EXCLUDED.cross_domain_consequences, recommendation=EXCLUDED.recommendation,
      user_choice=EXCLUDED.user_choice, rationale=EXCLUDED.rationale, expected_result=EXCLUDED.expected_result,
      review_date=EXCLUDED.review_date, review_due=EXCLUDED.review_due, actual_outcome=EXCLUDED.actual_outcome,
      review_outcome_code=EXCLUDED.review_outcome_code, review_lifecycle=EXCLUDED.review_lifecycle,
      outcome_state=EXCLUDED.outcome_state, related_goal_id=EXCLUDED.related_goal_id,
      predicted_outcome_proposition_ids=EXCLUDED.predicted_outcome_proposition_ids,
      actual_resolution_ids=EXCLUDED.actual_resolution_ids, conflict_flag=EXCLUDED.conflict_flag,
      projection_version=EXCLUDED.projection_version, canonical_transaction_watermark=EXCLUDED.canonical_transaction_watermark,
      owner_overlay_watermark=EXCLUDED.owner_overlay_watermark, reducer_version=EXCLUDED.reducer_version,
      is_complete=EXCLUDED.is_complete, source_manifest=EXCLUDED.source_manifest, updated_at=EXCLUDED.updated_at`,
    [row.ownerScopeId, row.decisionFrameInstanceId, row.question, JSON.stringify(row.alternatives), JSON.stringify(row.assumptions),
      JSON.stringify(row.crossDomainConsequences), row.recommendation, row.userChoice, row.rationale, row.expectedResult,
      row.reviewDate, row.reviewDue, row.actualOutcome, row.reviewOutcomeCode, row.reviewLifecycle, row.outcomeState,
      row.relatedGoalId, [...row.predictedOutcomePropositionIds], [...row.actualResolutionIds], row.conflictFlag,
      row.projectionVersion, row.canonicalTransactionWatermark, row.ownerOverlayWatermark, row.reducerVersion, row.isComplete,
      JSON.stringify(row.sourceManifest), row.updatedAt]);
}

const iso = (value: unknown) => value === null || value === undefined ? null : (value as Date).toISOString();

function toDecisionRow(row: Record<string, unknown>): DecisionProjectionRow {
  const manifest = (row['source_manifest'] ?? {}) as Record<string, unknown>;
  return decisionProjectionRowSchema.parse({
    ownerScopeId: row['owner_scope_id'], projectionVersion: row['projection_version'],
    canonicalTransactionWatermark: iso(row['canonical_transaction_watermark']),
    ownerOverlayWatermark: Number(row['owner_overlay_watermark']), reducerVersion: row['reducer_version'],
    isComplete: row['is_complete'], sourceManifest: manifest, updatedAt: iso(row['updated_at']),
    decisionFrameInstanceId: row['decision_frame_instance_id'], question: row['question'] ?? null,
    alternatives: row['alternatives'], assumptions: row['assumptions'], crossDomainConsequences: row['cross_domain_consequences'],
    recommendation: row['recommendation'] ?? null, userChoice: row['user_choice'] ?? null, rationale: row['rationale'] ?? null,
    expectedResult: row['expected_result'] ?? null, reviewDate: iso(row['review_date']), reviewDue: row['review_due'],
    actualOutcome: row['actual_outcome'] ?? null, reviewOutcomeCode: row['review_outcome_code'] ?? null,
    reviewLifecycle: row['review_lifecycle'] ?? null, outcomeState: row['outcome_state'],
    relatedGoalId: row['related_goal_id'] ?? null,
    predictedOutcomePropositionIds: [...(row['predicted_outcome_proposition_ids'] as string[])],
    actualResolutionIds: [...(row['actual_resolution_ids'] as string[])], conflictFlag: row['conflict_flag'],
    pendingAssertions: Array.isArray(manifest['pendingAssertions']) ? manifest['pendingAssertions'] : [],
  });
}

/** Every stored decision row of one owner, in source-frame order. */
export async function readDecisionRows(tx: MemoryTransaction, input: { ownerScopeId: string }): Promise<DecisionProjectionRow[]> {
  return (await tx.query('SELECT * FROM decision_projection WHERE owner_scope_id=$1 ORDER BY decision_frame_instance_id',
    [input.ownerScopeId])).rows.map(toDecisionRow);
}

/** The comparable content of a row: everything but the run that wrote it. */
export function decisionRowContent(row: DecisionProjectionRow): string {
  const { projectionVersion: _run, ...content } = row;
  return canonicalJson(content);
}

/** Recompute the named decision rows (every row when none are named) from
 * canonical memory, under `memory.project`. */
export async function applyDecisionProjection(tx: MemoryTransaction, input: {
  ownerScopeId: string; asOf: Date; frameInstanceIds?: readonly string[];
}): Promise<{ projectionVersion: string; rowsWritten: number; rows: readonly DecisionProjectionRow[] }> {
  const projectionVersion = uuidV7();
  const rows = await buildDecisionRows(tx, { ownerScopeId: input.ownerScopeId, asOf: input.asOf, projectionVersion,
    watermarks: await readWatermarks(tx, input.ownerScopeId), frameInstanceIds: input.frameInstanceIds });
  for (const row of rows) await writeDecisionRow(tx, row);
  return { projectionVersion, rowsWritten: rows.length, rows };
}

/**
 * Rebuild the whole decision projection from canonical memory and record the
 * receipt, with `equalsIncremental` computed by comparing row content with what
 * was stored before (PRD §25.4).
 */
export async function replayDecisionProjection(tx: MemoryTransaction, input: {
  ownerScopeId: string; asOf: Date; trigger?: RebuildTrigger; transactionId?: string | null;
}): Promise<ProjectionRebuildReceipt> {
  const trigger = rebuildTriggerSchema.parse(input.trigger ?? 'MANUAL_REPLAY');
  const before = await readDecisionRows(tx, input);
  const applied = await applyDecisionProjection(tx, input);
  const keep = applied.rows.map(row => row.decisionFrameInstanceId);
  const pruned = (await tx.query(
    `DELETE FROM decision_projection p WHERE p.owner_scope_id=$1 AND (NOT (p.decision_frame_instance_id=ANY($2::uuid[]))
       OR NOT EXISTS(SELECT 1 FROM frame_instances f WHERE f.owner_scope_id=p.owner_scope_id
         AND f.id=p.decision_frame_instance_id AND f.lifecycle='ACTIVE'))`, [input.ownerScopeId, keep])).rowCount ?? 0;
  const after = await readDecisionRows(tx, input);
  const equal = before.length === after.length
    && before.every((row, index) => decisionRowContent(row) === decisionRowContent(after[index]!));
  const row = (await tx.query(
    `INSERT INTO projection_rebuild_receipts(id,owner_scope_id,projection_name,trigger,transaction_id,rows_rebuilt,
      equals_incremental,projection_version,reducer_version,detail)
     VALUES($1,$2,'decision_projection',$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [uuidV7(), input.ownerScopeId, trigger, input.transactionId ?? null, applied.rowsWritten, equal, applied.projectionVersion,
      DECISION_REDUCER_VERSION, JSON.stringify({ comparedRows: before.length, prunedRows: pruned, asOf: input.asOf.toISOString() })])).rows[0]!;
  return projectionRebuildReceiptSchema.parse({
    projectionRebuildReceiptId: row['id'], projectionName: row['projection_name'], trigger: row['trigger'],
    transactionId: row['transaction_id'] ?? null, rowsRebuilt: Number(row['rows_rebuilt']),
    equalsIncremental: row['equals_incremental'], projectionVersion: row['projection_version'],
    reducerVersion: row['reducer_version'], detail: row['detail'], createdAt: (row['created_at'] as Date).toISOString(),
  });
}

/**
 * GET /v1/projections/decisions: the stored rows with the owner's later writes
 * folded in memory, the completeness flag and both watermarks (PRD §25.4,
 * CRT-PRJ-04-A's rule applied to the decision projection). Writes nothing.
 */
export async function readDecisionProjection(tx: MemoryTransaction, input: { ownerScopeId: string; asOf: Date }): Promise<DecisionProjectionView> {
  const stored = await readDecisionRows(tx, input);
  const overlay = await deltasByFrame(tx, input.ownerScopeId);
  const rows: DecisionProjectionRow[] = [];
  const pending: PendingAssertion[] = [];
  for (const row of stored) {
    const fold = foldDecisionDeltas(overlay.byFrame.get(row.decisionFrameInstanceId) ?? []);
    const all = [...row.pendingAssertions, ...fold.pending]
      .filter((assertion, index, list) => list.findIndex(other => other.overlayDeltaId === assertion.overlayDeltaId) === index);
    if (fold.suppressed || row.sourceManifest['ownerSuppressed'] === true) continue;
    pending.push(...all);
    rows.push(all.length === row.pendingAssertions.length ? row : { ...row, isComplete: all.length === 0, pendingAssertions: all });
  }
  const canonical = stored.map(row => new Date(row.canonicalTransactionWatermark))
    .reduce((latest, time) => time.getTime() > latest.getTime() ? time : latest, new Date(0));
  return decisionProjectionViewSchema.parse({
    projectionName: DECISION_PROJECTION, rows,
    isComplete: pending.length === 0 && rows.every(row => row.isComplete),
    ownerOverlayWatermark: Math.max(overlay.watermark, ...stored.map(row => row.ownerOverlayWatermark), 0),
    canonicalTransactionWatermark: canonical.toISOString(),
    projectionVersion: stored[0]?.projectionVersion ?? null,
    reducerVersion: DECISION_REDUCER_VERSION,
    pendingAssertions: pending,
    readAt: input.asOf.toISOString(),
  });
}

/** The reducer's purpose, re-exported so a caller opens the rebuild under it. */
export const DECISION_PROJECTION_PURPOSE = PROJECTION_PURPOSE;
