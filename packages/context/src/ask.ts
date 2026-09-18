import {
  REQUIRED_ASK_FIELDS, askAnswerSchema, askRequestSchema,
  type AskAnswer, type AskStatement, type CertaintyLabel, type ContextPacket, type ContextSelection,
  type RequiredAskField,
} from '@unai/domain';
import { canonicalJson } from '@unai/memory';
import { ContextBrokerError, readContextPacket, type ContextBrokerOptions, type ContextRunner } from './broker.js';
import { classifyQuestion, type QuestionClassification } from './question.js';

/**
 * Question answering (PRD §8.2; design POST /v1/ask; CRT-RD-12-A). ADR 0023 §5.
 *
 *  1. Classify the requested answer type -- one of the eight of §8.2 -- and the
 *     §23.3 query mode it is planned under.
 *  2. Ask the Context Broker for a purpose-bound packet planned for that mode.
 *  3. Use structured state first (the deterministic selections), then relations
 *     (conflicts, resolutions, future claims), then semantic evidence.
 *  4. Label every statement with the §24.5 label its support warrants.
 *  5. Return source links, and the path to each belief's explanation.
 *
 * The answer is composed by code from the packet. No model is called, so the
 * same question over the same memory yields the same statements; a statement
 * names the packet objects it rests on, a contested value is worded as contested,
 * a future modality as not having happened, and a slot with nothing selected as
 * unknown.
 */

export const ASK_COMPOSER_VERSION = 'ask-composer-0.1.0';

export function missingAskFields(body: unknown): RequiredAskField[] {
  const object = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {};
  return REQUIRED_ASK_FIELDS.filter(field => {
    const value = object[field];
    return value === undefined || value === null || value === '';
  });
}

export interface AskOptions extends ContextBrokerOptions {
  /** The session's actor. It is never read from the request body. */
  readonly requestingActorId: string;
}

/** "shared.obligation.principal_amount" -> "obligation principal amount". */
function describeContract(frameTypeId: string | null, predicateId: string | null): string {
  const frame = frameTypeId ? frameTypeId.split('.').slice(1).join(' ').replaceAll('_', ' ') : '';
  const predicate = predicateId ? (predicateId.split('.').at(-1) ?? '').replaceAll('_', ' ') : '';
  return [frame, predicate].filter(part => part.length > 0).join(' ') || 'value';
}

/** A normalized value in words. Money is stated as recorded -- the composer does
 * no arithmetic on it. */
function describeValue(value: unknown): string {
  if (value === null || value === undefined) return 'no value';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record['amount'] === 'string' && typeof record['currency'] === 'string') return record['currency'] + ' ' + record['amount'];
    for (const key of ['text', 'time', 'description', 'label']) if (typeof record[key] === 'string') return record[key] as string;
  }
  return canonicalJson(value);
}

const FUTURE_LABEL: Record<string, CertaintyLabel> = {
  SCHEDULED: 'SCHEDULED', INTENDED: 'INTENDED', COMMITTED: 'COMMITTED', EXPECTED: 'PREDICTED', PREDICTED: 'PREDICTED',
  RECOMMENDED: 'RECOMMENDED', CONDITIONAL: 'INFERRED',
};
const FUTURE_WORDING: Record<string, string> = {
  SCHEDULED: 'Scheduled, not yet happened', INTENDED: 'Intended, not yet done', COMMITTED: 'Committed, not yet fulfilled',
  EXPECTED: 'Expected, not yet known to have happened', PREDICTED: 'Predicted, not yet confirmed',
  RECOMMENDED: 'Recommended, not decided', CONDITIONAL: 'Conditional, not established',
};
const MODEL_ORIGINS = new Set(['MODEL_EXTRACTION', 'MODEL_INFERENCE', 'MODEL_RECOMMENDATION', 'MODEL_PREDICTION']);
const OWNER_OR_AUTHORITY = new Set(['USER_STATEMENT', 'USER_CONFIRMATION', 'USER_CORRECTION',
  'STRUCTURED_CONNECTOR_OBSERVATION', 'TOOL_EXECUTION_RECEIPT']);

/** PRD §24.5 for a selected value: accepted from the owner or an authoritative
 * source is confirmed; accepted on someone else's word is reported; resting only
 * on a model's reading is inferred; provisional is at most reported. */
function selectedLabel(selection: ContextSelection): CertaintyLabel {
  const origins = selection.claimOrigins;
  if (origins.length > 0 && origins.every(origin => MODEL_ORIGINS.has(origin))) return 'INFERRED';
  if (selection.certainty !== 'ACCEPTED') return 'REPORTED';
  return origins.some(origin => OWNER_OR_AUTHORITY.has(origin)) ? 'CONFIRMED' : 'REPORTED';
}

interface Draft {
  kind: AskStatement['kind'];
  label: CertaintyLabel;
  text: string;
  objectRefs: { objectType: string; objectId: string }[];
  evidenceIds: string[];
  explain: string | null;
}

/** Compose the statements for one answer type from one packet. Pure. */
export function composeStatements(packet: ContextPacket, classification: QuestionClassification, options: {
  historicalInstantMissing: boolean;
}): Draft[] {
  const drafts: Draft[] = [];
  const beliefs = new Map([...packet.currentBeliefs, ...packet.historicalBeliefs].map(belief => [belief.propositionId, belief]));
  const futures = new Map(packet.futureClaims.map(claim => [claim.propositionId, claim]));
  const evidenceOf = (propositionId: string | null): string[] =>
    propositionId ? [...(beliefs.get(propositionId)?.evidenceIds ?? futures.get(propositionId)?.evidenceIds ?? [])] : [];
  const explain = (propositionId: string | null) => propositionId ? '/v1/memory/propositions/' + propositionId + '/explain' : null;
  const stateSelections = packet.selections.filter(selection => selection.outcome !== 'EXCLUDED' && selection.outcome !== 'WITHHELD');

  const stateStatements = (prefix: string) => {
    for (const selection of stateSelections) {
      const subject = describeContract(selection.frameTypeId, selection.predicateId);
      if (selection.outcome === 'SELECTED') {
        const label = FUTURE_LABEL[selection.modality] ?? selectedLabel(selection);
        const lead = FUTURE_WORDING[selection.modality] ?? prefix;
        drafts.push({
          kind: 'SELECTED_STATE', label,
          text: lead + ': ' + subject + ' is ' + ('selectedValue' in selection ? describeValue(selection.selectedValue) : 'withheld') + '.'
            + (selection.ownerAssertionPending ? ' You have a pending correction on this that is not yet verified.' : ''),
          objectRefs: [{ objectType: 'belief_slots', objectId: selection.beliefSlotId },
            { objectType: 'propositions', objectId: selection.selectedPropositionId! }],
          evidenceIds: [...(selection.evidenceIds ?? evidenceOf(selection.selectedPropositionId))],
          explain: explain(selection.selectedPropositionId),
        });
      } else if (selection.outcome === 'CONTESTED') {
        const conflict = packet.conflicts.find(entry => entry.beliefSlotId === selection.beliefSlotId);
        const values = (conflict?.positions ?? []).map(position => 'normalizedValue' in position ? describeValue(position.normalizedValue) : 'a withheld value');
        drafts.push({
          kind: 'CONTESTED_STATE', label: 'CONFLICTING',
          text: 'Contested: ' + subject + ' has competing values' + (values.length > 0 ? ' (' + values.join(' versus ') + ')' : '')
            + ' and neither is settled.',
          objectRefs: [{ objectType: 'belief_slots', objectId: selection.beliefSlotId },
            ...selection.competingPropositionIds.map(objectId => ({ objectType: 'propositions', objectId }))],
          evidenceIds: selection.competingPropositionIds.flatMap(evidenceOf),
          explain: explain(selection.competingPropositionIds[0] ?? null),
        });
      } else {
        drafts.push({
          kind: 'NO_CURRENT_VALUE', label: 'UNKNOWN',
          text: 'Not known: no value for ' + subject + ' holds at the requested time.',
          objectRefs: [{ objectType: 'belief_slots', objectId: selection.beliefSlotId }], evidenceIds: [], explain: null,
        });
      }
    }
  };
  const futureStatements = (modalities: readonly string[]) => {
    for (const claim of packet.futureClaims.filter(entry => modalities.includes(entry.modality))) {
      drafts.push({
        kind: 'FUTURE_CLAIM', label: FUTURE_LABEL[claim.modality] ?? 'INFERRED',
        text: (FUTURE_WORDING[claim.modality] ?? 'Not established') + ': ' + describeContract(claim.frameTypeId, claim.predicateId)
          + ('normalizedValue' in claim ? ' ' + describeValue(claim.normalizedValue) : '') + '.',
        objectRefs: [{ objectType: 'propositions', objectId: claim.propositionId }],
        evidenceIds: evidenceOf(claim.propositionId), explain: explain(claim.propositionId),
      });
    }
  };
  const resolutionStatements = () => {
    for (const resolution of packet.resolutionAssertions) {
      drafts.push({
        kind: 'RESOLUTION', label: resolution.lifecycle === 'ACCEPTED' ? 'CONFIRMED' : 'REPORTED',
        text: 'Outcome recorded: ' + resolution.outcomeCode.toLowerCase().replaceAll('_', ' ') + ', effective '
          + resolution.effectiveAt.slice(0, 10) + (resolution.lifecycle === 'ACCEPTED' ? '.' : ' (not yet accepted).'),
        objectRefs: [{ objectType: 'resolution_assertions', objectId: resolution.resolutionAssertionId },
          { objectType: 'frame_instances', objectId: resolution.sourceFrameInstanceId }],
        evidenceIds: [], explain: null,
      });
    }
  };
  const semanticStatements = () => {
    for (const match of packet.semanticSearch?.matches ?? []) {
      const belief = match.propositionId ? beliefs.get(match.propositionId) : undefined;
      drafts.push({
        kind: 'SEMANTIC_RECALL', label: 'REPORTED',
        text: 'A recorded source mentions ' + describeContract(match.frameTypeId, match.predicateId)
          + (belief && 'normalizedValue' in belief ? ': ' + describeValue(belief.normalizedValue) : '')
          + (match.authority === 'NON_AUTHORITATIVE_UNREGISTERED_PREDICATE'
            ? ' (recalled from a source; not an established value).' : '.'),
        objectRefs: [{ objectType: 'claims', objectId: match.objectId },
          ...(match.propositionId ? [{ objectType: 'propositions', objectId: match.propositionId }] : [])],
        evidenceIds: [...match.evidenceIds], explain: explain(match.propositionId),
      });
    }
  };
  const conflictStatements = () => {
    for (const conflict of packet.conflicts) {
      const values = conflict.positions.map(position => 'normalizedValue' in position ? describeValue(position.normalizedValue) : 'a withheld value');
      drafts.push({
        kind: 'CONFLICT', label: 'CONFLICTING',
        text: 'These disagree about ' + describeContract(null, conflict.predicateId) + ': ' + values.join(' versus ') + '.',
        objectRefs: conflict.positions.map(position => ({ objectType: 'propositions', objectId: position.propositionId })),
        evidenceIds: conflict.positions.flatMap(position => position.evidenceIds ?? []),
        explain: explain(conflict.positions[0]?.propositionId ?? null),
      });
    }
  };

  if (options.historicalInstantMissing) {
    drafts.push({
      kind: 'HISTORICAL_INSTANT_MISSING', label: 'UNKNOWN',
      text: 'The question asks about a past time, but no past instant was given; this answers for the requested time.',
      objectRefs: [], evidenceIds: [], explain: null,
    });
  }
  switch (classification.answerType) {
    case 'CURRENT_STATE': stateStatements('Recorded'); break;
    case 'HISTORICAL_STATE':
      stateStatements(classification.historicalMode === 'HISTORICAL_BELIEF_STATE'
        ? 'What Uai believed then, from what it knew then' : 'What is now believed to have held then');
      break;
    case 'EPISODE_RECALL': semanticStatements(); resolutionStatements(); break;
    case 'CAUSAL_EXPLANATION': stateStatements('Recorded'); resolutionStatements(); semanticStatements(); break;
    // The broker planned this under OPEN_COMMITMENTS or FUTURE_PLANS, so the
    // selections already cover the committed, intended and scheduled slots --
    // with lifecycle, correction and conflicts applied, which raw future claims
    // are not -- and each is worded by its modality.
    case 'FUTURE_COMMITMENT': stateStatements('Recorded'); break;
    case 'PREDICTION_REVIEW':
      futureStatements(['PREDICTED', 'EXPECTED']); resolutionStatements();
      for (const claim of packet.futureClaims.filter(entry => entry.modality === 'PREDICTED' || entry.modality === 'EXPECTED')) {
        if (packet.resolutionAssertions.some(resolution => resolution.sourceFrameInstanceId === claim.frameInstanceId)) continue;
        drafts.push({
          kind: 'NO_CURRENT_VALUE', label: 'UNKNOWN',
          text: 'No confirmed outcome is recorded yet for ' + describeContract(claim.frameTypeId, claim.predicateId) + '.',
          objectRefs: [{ objectType: 'propositions', objectId: claim.propositionId }],
          evidenceIds: evidenceOf(claim.propositionId), explain: explain(claim.propositionId),
        });
      }
      break;
    case 'AGGREGATION': {
      stateStatements('Recorded');
      const counted = drafts.filter(draft => draft.kind === 'SELECTED_STATE');
      // A count of retrieved values, not arithmetic over them: a sum of money is
      // the capability projections' to compute (PRD §16.7).
      drafts.push({
        kind: 'AGGREGATE_COUNT', label: 'INFERRED',
        text: 'Matched ' + counted.length + ' recorded value' + (counted.length === 1 ? '' : 's')
          + '; totals of money come from the capability projections, not from this answer.',
        objectRefs: counted.flatMap(draft => draft.objectRefs.filter(ref => ref.objectType === 'propositions')),
        evidenceIds: counted.flatMap(draft => draft.evidenceIds), explain: null,
      });
      break;
    }
    case 'CONTRADICTION_CHECK':
      conflictStatements();
      if (packet.conflicts.length === 0) {
        drafts.push({
          kind: 'NO_CONFLICT_FOUND', label: 'UNKNOWN',
          text: 'No conflicting values were found in the memory this request could read.',
          objectRefs: [], evidenceIds: [], explain: null,
        });
      }
      break;
  }

  // What the answer must be able to say out loud whatever the type: the owner's
  // own pending word, and anything withheld above the requested ceiling.
  for (const delta of packet.ownerOverlayDeltas.filter(entry => entry.lifecycle === 'AWAITING_INSTANCE_RESOLUTION'
    || entry.lifecycle === 'USER_ASSERTED' || entry.lifecycle === 'RECEIVED')) {
    drafts.push({
      kind: 'OWNER_ASSERTION_PENDING', label: 'REPORTED',
      text: 'You said: "' + delta.rawText + '". This is your assertion and is not yet independently verified.',
      objectRefs: [{ objectType: 'owner_overlay_deltas', objectId: delta.overlayDeltaId }],
      evidenceIds: [delta.sourceEvidenceId], explain: null,
    });
  }
  if (packet.redactions.length > 0) {
    drafts.push({
      kind: 'WITHHELD', label: 'UNKNOWN',
      text: 'Some memory relevant to this question was withheld from this request; the answer does not include it.',
      objectRefs: [], evidenceIds: [], explain: null,
    });
  }
  if (drafts.every(draft => draft.kind === 'WITHHELD' || draft.kind === 'HISTORICAL_INSTANT_MISSING')) {
    drafts.push({
      kind: 'NOTHING_FOUND', label: 'UNKNOWN', text: 'Nothing in the memory this request could read answers this question.',
      objectRefs: [], evidenceIds: [], explain: null,
    });
  }
  return drafts;
}

const SETTLED_LABELS = new Set<CertaintyLabel>(['CONFIRMED', 'REPORTED', 'INFERRED', 'SCHEDULED', 'INTENDED', 'COMMITTED',
  'PREDICTED', 'RECOMMENDED']);

/**
 * Answer one question (design POST /v1/ask).
 *
 * The request is refused before any retrieval when it does not declare its owner
 * scope, question, purpose, times and ceiling. The context request the pipeline
 * then sends declares every field PRD §23.1 requires, with action risk LOW: an
 * answer performs no action, and an action founded on one goes through the
 * broker's own gate. A purpose the evidence does not admit is refused by the
 * broker, and that refusal is recorded (CRT-SEC-02-A).
 */
export async function answerQuestion(runner: ContextRunner, raw: unknown, options: AskOptions): Promise<AskAnswer> {
  const missing = missingAskFields(raw);
  if (missing.length > 0) throw new ContextBrokerError('ASK_REQUEST_INCOMPLETE', { missing });
  const parsed = askRequestSchema.safeParse(raw);
  if (!parsed.success) throw new ContextBrokerError('ASK_REQUEST_INVALID');
  const ask = parsed.data;
  const classification = classifyQuestion(ask.question);

  // PRD §12.3: "what did Uai believe then" is asked with the knowledge time at
  // the world time. A caller that left the knowledge time at LATEST gets that
  // mode's definition rather than today's knowledge about then.
  const beliefQuestion = classification.historicalMode === 'HISTORICAL_BELIEF_STATE';
  const knowledgeTime = beliefQuestion && ask.knowledgeTime === 'LATEST' && ask.worldTime !== 'NOW' ? ask.worldTime : ask.knowledgeTime;
  const historicalInstantMissing = classification.answerType === 'HISTORICAL_STATE' && ask.worldTime === 'NOW';

  const packet = await readContextPacket(runner, {
    ownerScopeId: ask.ownerScopeId, requestingActorId: options.requestingActorId, purpose: ask.purpose,
    query: ask.question, entityHints: ask.entityHints, worldlineHints: ask.worldlineHints,
    discourseAnchors: ask.discourseAnchors, frameTypeHints: ask.frameTypeHints, lifeCategory: ask.lifeCategory,
    worldTime: ask.worldTime, knowledgeTime, maximumSensitivity: ask.maximumSensitivity, actionRisk: 'LOW',
    requiredCertainty: ['ACCEPTED', 'CONTESTED', 'OWNER_OVERLAY'], includeEvidence: 'WHEN_NEEDED',
    answerType: classification.queryMode, timeWindow: ask.timeWindow, sourceTypes: ask.sourceTypes,
  }, options);

  const refs = new Map(packet.evidenceRefs.map(reference => [reference.evidenceId, reference]));
  const drafts = composeStatements(packet, classification, { historicalInstantMissing });
  const statements: AskStatement[] = drafts.map((draft, index) => ({
    statementId: 'S' + (index + 1), kind: draft.kind, label: draft.label, text: draft.text,
    objectRefs: draft.objectRefs,
    // A statement links only evidence the packet actually carries: nothing the
    // request could not read is linked, and nothing is linked twice.
    sourceEvidenceIds: [...new Set(draft.evidenceIds.filter(id => refs.has(id)))].sort(),
    explainPath: draft.explain,
  }));
  const linked = [...new Set(statements.flatMap(statement => statement.sourceEvidenceIds))].sort();
  return askAnswerSchema.parse({
    question: ask.question, answerType: classification.answerType, queryMode: classification.queryMode,
    historicalMode: classification.historicalMode,
    classification: { matchedRule: classification.matchedRule, classifierVersion: classification.classifierVersion },
    worldTime: packet.worldTime, knowledgeTime: packet.knowledgeTime,
    statements,
    sourceLinks: linked.map(evidenceId => {
      const reference = refs.get(evidenceId)!;
      return { evidenceId, sourceType: reference.sourceType, occurredAt: reference.occurredAt,
        anchorIds: reference.anchorIds, href: '/v1/evidence/' + evidenceId };
    }),
    // The owner's own pending word and a count of retrieved values are not
    // assertions about the world; an answer made only of those declines.
    declinesToAssert: !statements.some(statement => SETTLED_LABELS.has(statement.label)
      && statement.kind !== 'OWNER_ASSERTION_PENDING' && statement.kind !== 'AGGREGATE_COUNT'),
    packetId: packet.packetId, packetHash: packet.packetHash, selectionsDigest: packet.selectionReason.selectionsDigest,
    composer: { kind: 'DETERMINISTIC_COMPOSER', version: ASK_COMPOSER_VERSION, modelCalled: false },
  });
}
