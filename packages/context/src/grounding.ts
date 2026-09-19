import {
  groundingViolationSchema,
  type AnswerCandidateStatement, type CertaintyLabel, type ContextPacket, type GroundingViolation,
} from '@unai/domain';
import { FUTURE_LABEL, FUTURE_WORDING, describeContract, describeValue } from './wording.js';

/**
 * The grounding validator (PRD §24.6; design component
 * "grounding-validator-block-downgrade-add-uncertainty-or-regenerate";
 * CRT-RD-08-A; ADR 0026 §3).
 *
 * A pure function of one packet and one candidate answer. It never reads memory,
 * a clock or a model: what a statement may say is decided by what the packet
 * supplied, so the same candidate over the same packet gets the same verdict.
 *
 * Five checks, each with the action it requires:
 *
 *  - `UNGROUNDED_PERSONAL_FACT` (REGENERATE): an asserting statement that names no
 *    packet object, names one the packet does not hold, cites evidence the packet
 *    did not supply, or states a number none of its objects carries.
 *  - `SCHEDULED_WORDED_AS_OCCURRED` (DOWNGRADE): a statement about a future
 *    modality with no accepted occurrence, labelled as settled fact or worded as
 *    having happened.
 *  - `CONTESTED_WORDED_AS_CERTAIN` (DOWNGRADE): a statement about a contested value
 *    that is not labelled conflicting, or is worded with certainty.
 *  - `INFERENCE_PRESENTED_AS_EVIDENCE` (DOWNGRADE): a statement citing assistant
 *    conversation evidence, or labelling a value resting only on a model's reading
 *    as confirmed or reported.
 *  - `SENSITIVITY_SCOPE_LEAK` (BLOCK): a statement naming or citing an object the
 *    packet withheld, or drawing from a sensitivity scope the packet does not
 *    hold or the request may not read.
 */

export const GROUNDING_VALIDATOR_VERSION = 'grounding-validator-0.1.0';
/** The source type every assistant answer is stored under (ADR 0026 §4). */
export const ASSISTANT_CONVERSATION_SOURCE_TYPE = 'ASSISTANT_CONVERSATION';

export interface ValidatableStatement extends AnswerCandidateStatement {
  readonly statementId: string;
}

export type StatementVerdict = 'PASSED' | 'DOWNGRADED' | 'REGENERATE' | 'BLOCKED';

export interface GroundingValidation {
  /** The strongest action any statement requires. */
  readonly verdict: StatementVerdict;
  readonly violations: GroundingViolation[];
  /** The statements with every downgrade applied. Meaningful when the verdict is
   * PASSED or DOWNGRADED; a REGENERATE or BLOCKED verdict presents none of them. */
  readonly statements: ValidatableStatement[];
}

const SENSITIVITY_ORDER = ['NORMAL', 'PRIVATE', 'RESTRICTED'] as const;
type Sensitivity = typeof SENSITIVITY_ORDER[number];

/** Labels a statement uses to assert something about the owner's world. */
const FACT_LABELS = new Set<CertaintyLabel>(['CONFIRMED', 'REPORTED', 'SCHEDULED', 'INTENDED', 'COMMITTED', 'PREDICTED',
  'CONFLICTING']);
/** Labels that present a value as settled fact from a source. */
const SOURCE_LABELS = new Set<CertaintyLabel>(['CONFIRMED', 'REPORTED']);
/** A model's own conclusion, as opposed to a model's span-anchored reading of a
 * source (`MODEL_EXTRACTION`), which does rest on source evidence. */
const INFERENCE_ORIGINS = new Set(['MODEL_INFERENCE', 'MODEL_RECOMMENDATION', 'MODEL_PREDICTION']);
/** Labels under which a contested value is not being stated as certain. REPORTED
 * qualifies only when the words attribute it to someone. */
const UNCERTAIN_LABELS = new Set<CertaintyLabel>(['CONFLICTING', 'UNKNOWN', 'INFERRED']);
const ATTRIBUTION_WORDS = /\b(says|said|say|reported|reports|according to|mentions|mentioned|claims|claimed|wrote|writes|states|stated|asserts|asserted)\b/i;
/** Outcomes that say a future thing did happen, when accepted. */
const OCCURRENCE_OUTCOMES = new Set(['OCCURRED', 'OCCURRED_MODIFIED', 'FULFILLED', 'PARTIALLY_FULFILLED', 'CONFIRMED',
  'PARTIALLY_CONFIRMED']);

const OCCURRENCE_WORDS = /\b(happened|occurred|took place|was held|were held|has been held|attended|went ahead|completed|was completed|has been completed|was done|has been done|is done|finished|was paid|has been paid|were paid|was fulfilled|has been fulfilled|was delivered|came true)\b/gi;
const NEGATION = /\b(not|never|no|yet to|hasn't|has not|haven't|have not|didn't|did not|wasn't|was not|weren't|isn't|is not)\b[^.;:]*$/i;
const CERTAINTY_WORDS = /\b(definitely|certainly|for sure|without (a )?doubt|undoubtedly|is confirmed|was confirmed|confirmed that|it is settled|is certain|clearly is)\b/i;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Numbers as values: "60.00", "060" and "60" are one number; a date's parts are
 * numbers too, so "August 8" is grounded by "2026-08-08". */
function numbersIn(text: string): Set<string> {
  const found = new Set<string>();
  for (const match of text.replaceAll(UUID, ' ').matchAll(/\d+(?:[.,]\d+)?/g)) {
    const value = Number(match[0].replace(',', '.'));
    if (Number.isFinite(value)) found.add(String(value));
  }
  return found;
}

function occurrenceAsserted(text: string): boolean {
  for (const match of text.matchAll(OCCURRENCE_WORDS)) {
    const before = text.slice(Math.max(0, (match.index ?? 0) - 40), match.index ?? 0);
    if (!NEGATION.test(before)) return true;
  }
  return false;
}

interface PacketObject {
  /** Text whose numbers ground a statement naming this object. */
  readonly grounding: string[];
}

/** What the packet supplied, indexed for the checks. Built once per packet. */
export interface PacketIndex {
  readonly objects: Map<string, PacketObject>;
  readonly futureModality: Map<string, { modality: string; frameInstanceId: string; frameTypeId: string; predicateId: string; value: unknown }>;
  readonly contested: Set<string>;
  readonly contestedSlot: Map<string, { slotId: string; predicateId: string; frameTypeId: string | null }>;
  readonly modelOnly: Set<string>;
  readonly occurredFrames: Set<string>;
  readonly packetEvidence: Set<string>;
  readonly assistantEvidence: Set<string>;
  readonly evidenceScopes: Set<string>;
  readonly withheld: Set<string>;
}

export function indexPacket(packet: ContextPacket): PacketIndex {
  const objects = new Map<string, PacketObject>();
  const add = (id: string | null | undefined, ...grounding: unknown[]) => {
    if (!id) return;
    const entry = objects.get(id) ?? { grounding: [] };
    for (const value of grounding) if (value !== undefined && value !== null) entry.grounding.push(typeof value === 'string' ? value : JSON.stringify(value));
    objects.set(id, entry);
  };
  const futureModality: PacketIndex['futureModality'] = new Map();
  const contested = new Set<string>();
  const contestedSlot: PacketIndex['contestedSlot'] = new Map();
  const modelOnly = new Set<string>();
  const occurredFrames = new Set<string>();

  for (const belief of [...packet.currentBeliefs, ...packet.historicalBeliefs]) {
    const values = [belief.normalizedValue, belief.validFrom, belief.validTo];
    add(belief.propositionId, ...values);
    add(belief.beliefSlotId, ...values);
    add(belief.frameInstanceId, ...values);
    for (const claimId of belief.claimIds ?? []) add(claimId, ...values);
    if (belief.certainty === 'CONTESTED' || belief.assessmentStatus === 'CONTESTED') {
      contested.add(belief.propositionId);
      contestedSlot.set(belief.propositionId, { slotId: belief.beliefSlotId, predicateId: belief.predicateId, frameTypeId: belief.frameTypeId });
    }
  }
  for (const claim of packet.futureClaims) {
    const values = [claim.normalizedValue, claim.validFrom];
    add(claim.propositionId, ...values);
    add(claim.frameInstanceId, ...values);
    futureModality.set(claim.propositionId, { modality: claim.modality, frameInstanceId: claim.frameInstanceId,
      frameTypeId: claim.frameTypeId, predicateId: claim.predicateId, value: claim.normalizedValue });
  }
  for (const selection of packet.selections) {
    const value = 'selectedValue' in selection ? selection.selectedValue : undefined;
    add(selection.beliefSlotId, value, selection.validFrom, selection.validTo);
    add(selection.frameInstanceId, value);
    add(selection.selectedPropositionId, value, selection.validFrom, selection.validTo);
    for (const id of selection.competingPropositionIds) add(id);
    for (const id of selection.overlayDeltaIds) add(id);
    if (selection.outcome === 'CONTESTED') {
      for (const id of [selection.beliefSlotId, ...selection.competingPropositionIds]) {
        contested.add(id);
        contestedSlot.set(id, { slotId: selection.beliefSlotId, predicateId: selection.predicateId, frameTypeId: selection.frameTypeId });
      }
    }
    const future = FUTURE_LABEL[selection.modality] !== undefined;
    if (future && selection.outcome === 'SELECTED' && selection.selectedPropositionId) {
      for (const id of [selection.selectedPropositionId, selection.beliefSlotId]) {
        futureModality.set(id, { modality: selection.modality, frameInstanceId: selection.frameInstanceId,
          frameTypeId: selection.frameTypeId, predicateId: selection.predicateId, value });
      }
    }
    if (selection.selectedPropositionId && selection.claimOrigins.length > 0
      && selection.claimOrigins.every(origin => INFERENCE_ORIGINS.has(origin))) modelOnly.add(selection.selectedPropositionId);
  }
  for (const conflict of packet.conflicts) {
    add(conflict.beliefSlotId, ...conflict.positions.map(position => position.normalizedValue));
    for (const position of conflict.positions) {
      add(position.propositionId, position.normalizedValue);
      if (position.assessmentStatus === 'CONTESTED') {
        contested.add(position.propositionId);
        contestedSlot.set(position.propositionId, { slotId: conflict.beliefSlotId, predicateId: conflict.predicateId, frameTypeId: null });
      }
    }
  }
  for (const resolution of packet.resolutionAssertions) {
    add(resolution.resolutionAssertionId, resolution.effectiveAt, resolution.outcomeCode);
    add(resolution.sourceFrameInstanceId, resolution.effectiveAt);
    if (resolution.targetFrameInstanceId) add(resolution.targetFrameInstanceId, resolution.effectiveAt);
    if (resolution.lifecycle === 'ACCEPTED' && OCCURRENCE_OUTCOMES.has(resolution.outcomeCode)) {
      occurredFrames.add(resolution.sourceFrameInstanceId);
      if (resolution.targetFrameInstanceId) occurredFrames.add(resolution.targetFrameInstanceId);
    }
  }
  for (const delta of packet.ownerOverlayDeltas) add(delta.overlayDeltaId, delta.rawText);
  for (const match of packet.semanticSearch?.matches ?? []) {
    const belief = [...packet.currentBeliefs, ...packet.historicalBeliefs].find(entry => entry.propositionId === match.propositionId);
    add(match.objectId, belief?.normalizedValue, match.timeStart, match.timeEnd);
    add(match.propositionId, belief?.normalizedValue);
  }
  for (const thread of packet.memoryThreads) add(thread.memoryThreadId);

  const packetEvidence = new Set(packet.evidenceRefs.map(reference => reference.evidenceId));
  const assistantEvidence = new Set(packet.evidenceRefs
    .filter(reference => reference.sourceType === ASSISTANT_CONVERSATION_SOURCE_TYPE).map(reference => reference.evidenceId));
  const evidenceScopes = new Set(packet.evidenceRefs.map(reference => reference.sensitivity as string));
  // Withheld is what the packet names without supplying: an object-level
  // redaction, and evidence above the ceiling. A field-level redaction still
  // supplies the object, so naming it is not a leak.
  const withheld = new Set([
    ...packet.redactions.filter(redaction => redaction.fields.length === 0).map(redaction => redaction.objectId),
    ...packet.unknowns.filter(unknown => unknown.kind === 'EVIDENCE_WITHHELD' && unknown.objectId !== null)
      .map(unknown => unknown.objectId as string),
  ]);
  return { objects, futureModality, contested, contestedSlot, modelOnly, occurredFrames, packetEvidence,
    assistantEvidence, evidenceScopes, withheld };
}

function violation(statementId: string, rule: GroundingViolation['rule'], action: GroundingViolation['action'],
  detail: string, objectIds: readonly string[]): GroundingViolation {
  return groundingViolationSchema.parse({ statementId, rule, action, detail, objectIds: [...new Set(objectIds)].sort().slice(0, 64) });
}

/** The conflict's values in words, for a contested downgrade. */
function contestedWording(packet: ContextPacket, slotId: string, predicateId: string, frameTypeId: string | null): string {
  const conflict = packet.conflicts.find(entry => entry.beliefSlotId === slotId);
  const values = (conflict?.positions ?? []).map(position => 'normalizedValue' in position ? describeValue(position.normalizedValue) : 'a withheld value');
  return 'Contested: ' + describeContract(frameTypeId, predicateId) + ' has competing values'
    + (values.length > 0 ? ' (' + values.join(' versus ') + ')' : '') + ' and neither is settled.';
}

/**
 * Validate one candidate answer against the packet it was phrased from.
 *
 * `maximumSensitivity` is the request's ceiling: a statement declaring a scope
 * above it leaks, whatever the packet holds.
 */
export function validateGrounding(packet: ContextPacket, candidate: readonly ValidatableStatement[], options: {
  maximumSensitivity: Sensitivity; index?: PacketIndex;
}): GroundingValidation {
  const index = options.index ?? indexPacket(packet);
  const violations: GroundingViolation[] = [];
  const statements: ValidatableStatement[] = [];
  let verdict: StatementVerdict = 'PASSED';
  const escalate = (to: StatementVerdict) => {
    const rank: Record<StatementVerdict, number> = { PASSED: 0, DOWNGRADED: 1, REGENERATE: 2, BLOCKED: 3 };
    if (rank[to] > rank[verdict]) verdict = to;
  };

  for (const statement of candidate) {
    const id = statement.statementId;
    const refIds = statement.objectRefs.map(ref => ref.objectId);
    const asserting = statement.label !== 'UNKNOWN';

    // SENSITIVITY_SCOPE_LEAK: the one violation no rewording can repair.
    const leaked = [...refIds, ...statement.sourceEvidenceIds, ...(statement.text.match(UUID) ?? []).map(value => value.toLowerCase())]
      .filter(objectId => index.withheld.has(objectId));
    const scope = statement.sensitivityScope;
    const scopeLeak = scope !== null && (SENSITIVITY_ORDER.indexOf(scope) > SENSITIVITY_ORDER.indexOf(options.maximumSensitivity)
      || !index.evidenceScopes.has(scope));
    if (leaked.length > 0 || scopeLeak) {
      violations.push(violation(id, 'SENSITIVITY_SCOPE_LEAK', 'BLOCK',
        leaked.length > 0 ? 'NAMES_WITHHELD_OBJECT' : 'SCOPE_ABSENT_FROM_PACKET', leaked));
      escalate('BLOCKED');
      continue;
    }

    // UNGROUNDED_PERSONAL_FACT: every object named and every source cited must be
    // one the packet supplied; an asserting statement must name at least one.
    const unknownRefs = refIds.filter(objectId => !index.objects.has(objectId));
    const unsuppliedCitations = statement.sourceEvidenceIds.filter(evidenceId => !index.packetEvidence.has(evidenceId));
    let ungrounded: { detail: string; objectIds: string[] } | null = null;
    if (asserting && refIds.length === 0) ungrounded = { detail: 'NAMES_NO_PACKET_OBJECT', objectIds: [] };
    else if (unknownRefs.length > 0) ungrounded = { detail: 'NAMES_OBJECT_NOT_IN_PACKET', objectIds: unknownRefs };
    else if (unsuppliedCitations.length > 0) ungrounded = { detail: 'CITES_EVIDENCE_NOT_IN_PACKET', objectIds: unsuppliedCitations };
    else if (FACT_LABELS.has(statement.label)) {
      const grounded = new Set(refIds.flatMap(objectId => index.objects.get(objectId)!.grounding.flatMap(text => [...numbersIn(text)])));
      const invented = [...numbersIn(statement.text)].filter(value => !grounded.has(value));
      if (invented.length > 0) ungrounded = { detail: 'STATES_VALUE_NOT_IN_NAMED_OBJECTS', objectIds: refIds };
    }
    if (ungrounded) {
      violations.push(violation(id, 'UNGROUNDED_PERSONAL_FACT', 'REGENERATE', ungrounded.detail, ungrounded.objectIds));
      escalate('REGENERATE');
      continue;
    }

    let next: ValidatableStatement = statement;
    // CONTESTED_WORDED_AS_CERTAIN.
    const contestedRef = refIds.find(objectId => index.contested.has(objectId));
    const settledLabel = !UNCERTAIN_LABELS.has(statement.label)
      && !(statement.label === 'REPORTED' && ATTRIBUTION_WORDS.test(statement.text));
    if (contestedRef && (settledLabel || CERTAINTY_WORDS.test(statement.text))) {
      violations.push(violation(id, 'CONTESTED_WORDED_AS_CERTAIN', 'DOWNGRADE',
        settledLabel ? 'CONTESTED_VALUE_LABELLED_AS_SETTLED' : 'CERTAINTY_WORDING',
        refIds.filter(objectId => index.contested.has(objectId))));
      const slot = index.contestedSlot.get(contestedRef);
      next = { ...next, label: 'CONFLICTING',
        text: slot ? contestedWording(packet, slot.slotId, slot.predicateId, slot.frameTypeId)
          : 'Contested: the recorded sources disagree about this and neither is settled.' };
      escalate('DOWNGRADED');
    }

    // SCHEDULED_WORDED_AS_OCCURRED.
    const futureRef = refIds.find(objectId => {
      const future = index.futureModality.get(objectId);
      return future !== undefined && !index.occurredFrames.has(future.frameInstanceId);
    });
    if (futureRef && next === statement && (SOURCE_LABELS.has(statement.label) || occurrenceAsserted(statement.text))) {
      const future = index.futureModality.get(futureRef)!;
      violations.push(violation(id, 'SCHEDULED_WORDED_AS_OCCURRED', 'DOWNGRADE',
        SOURCE_LABELS.has(statement.label) ? 'FUTURE_VALUE_LABELLED_AS_FACT' : 'OCCURRENCE_WORDING', [futureRef]));
      next = { ...next, label: FUTURE_LABEL[future.modality] ?? 'INFERRED',
        text: (FUTURE_WORDING[future.modality] ?? 'Not established') + ': '
          + describeContract(future.frameTypeId, future.predicateId) + ' ' + describeValue(future.value) + '.' };
      escalate('DOWNGRADED');
    }

    // INFERENCE_PRESENTED_AS_EVIDENCE.
    const assistantCitations = next.sourceEvidenceIds.filter(evidenceId => index.assistantEvidence.has(evidenceId));
    const propositionRefs = next.objectRefs.filter(ref => ref.objectType === 'propositions' || ref.objectType === 'proposition')
      .map(ref => ref.objectId);
    const inferredOnly = SOURCE_LABELS.has(next.label) && propositionRefs.length > 0
      && propositionRefs.every(objectId => index.modelOnly.has(objectId));
    if (assistantCitations.length > 0 || inferredOnly) {
      violations.push(violation(id, 'INFERENCE_PRESENTED_AS_EVIDENCE', 'DOWNGRADE',
        assistantCitations.length > 0 ? 'CITES_ASSISTANT_CONVERSATION' : 'MODEL_READING_LABELLED_AS_SOURCE',
        assistantCitations.length > 0 ? assistantCitations : propositionRefs));
      next = { ...next,
        label: SOURCE_LABELS.has(next.label) ? 'INFERRED' : next.label,
        text: /^Inferred, not stated in a source: /.test(next.text) ? next.text : 'Inferred, not stated in a source: ' + next.text,
        sourceEvidenceIds: next.sourceEvidenceIds.filter(evidenceId => !index.assistantEvidence.has(evidenceId)) };
      escalate('DOWNGRADED');
    }
    statements.push(next);
  }
  return { verdict, violations, statements };
}
