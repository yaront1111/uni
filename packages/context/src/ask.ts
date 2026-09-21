import { closedFrameIds } from './resolutions.js';
import {traceStage,traceStageSync} from '@unai/observability';
import {
  REQUIRED_ASK_FIELDS, answerCandidateSchema, askAnswerSchema, askRequestSchema, groundingResultSchema,
  type AnswerCandidate, type AnswerCandidateStatement, type AskAnswer, type AskStatement, type CertaintyLabel,
  type ContextPacket, type ContextSelection, type GroundingResult, type GroundingViolation, type QuestionType,
  type RequiredAskField,
} from '@unai/domain';
import { ContextBrokerError, readContextPacket, type ContextBrokerOptions, type ContextRunner } from './broker.js';
import { GROUNDING_VALIDATOR_VERSION, indexPacket, validateGrounding, type ValidatableStatement } from './grounding.js';
import { classifyQuestion, type QuestionClassification } from './question.js';
import { FUTURE_LABEL, FUTURE_WORDING, describeContract, describeValue, describeFreshness } from './wording.js';
import { changeWindow } from './change-window.js';

/**
 * Question answering (PRD §8.2, §23.6, §24.6; design POST /v1/ask; CRT-RD-12-A,
 * CRT-RD-06-A, CRT-RD-08-A). ADR 0024 §5, ADR 0026.
 *
 *  1. Classify the requested answer type -- one of the eight of §8.2 -- and the
 *     §23.3 query mode it is planned under.
 *  2. Ask the Context Broker for a purpose-bound packet planned for that mode.
 *  3. Use structured state first (the deterministic selections), then relations
 *     (conflicts, resolutions, future claims), then semantic evidence.
 *  4. Label every statement with the §24.5 label its support warrants.
 *  5. When a phrasing model is configured, let it phrase the answer from the
 *     packet, and put every candidate through the grounding validator: block,
 *     downgrade or regenerate before anything is presented.
 *  6. Return source links, the path to each belief's explanation, and -- through
 *     the recorder -- the manifest of the context supplied.
 *
 * Without a phrasing model the answer is composed by code from the packet, so the
 * same question over the same memory yields the same statements; a statement
 * names the packet objects it rests on, a contested value is worded as contested,
 * a future modality as not having happened, and a slot with nothing selected as
 * unknown. The composer is also what a rejected model candidate is regenerated
 * from, and its output passes the same validator.
 */

export const ASK_COMPOSER_VERSION = 'ask-composer-0.2.0';
/** How many candidates a phrasing model gets before the composer takes over. */
export const MAX_PHRASING_ATTEMPTS = 2;

export function missingAskFields(body: unknown): RequiredAskField[] {
  const object = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {};
  return REQUIRED_ASK_FIELDS.filter(field => {
    const value = object[field];
    return value === undefined || value === null || value === '';
  });
}

/** What a phrasing model is given: the question, the packet, the composer's own
 * grounded draft, and on a retry the violations its last candidate committed. */
export interface AnswerPhrasingRequest {
  readonly ownerScopeId: string;
  readonly correlationId: string;
  readonly question: string;
  readonly answerType: QuestionType;
  readonly packet: ContextPacket;
  readonly draft: readonly AnswerCandidateStatement[];
  readonly attempt: number;
  readonly violations: readonly GroundingViolation[];
}

/**
 * A model that phrases an answer from a packet. This package depends on no
 * gateway: the implementation is supplied by the caller, and every call it makes
 * must go through the LLM gateway, which validates the output against
 * `answerCandidateSchema` and records the call (ADR 0026 §3).
 */
export interface AnswerPhraser {
  readonly modelProvider: string;
  readonly modelId: string;
  readonly promptVersion: string;
  phrase(request: AnswerPhrasingRequest): Promise<AnswerCandidate>;
}

/** One model candidate, kept so it can be stored as the assistant conversation
 * evidence it is (PRD §24.2, CRT-AI-01-A) whatever the validator did with it. */
export interface ModelCandidateRecord {
  readonly attempt: number;
  readonly outcome: GroundingResult['action'];
  readonly statements: readonly AnswerCandidateStatement[];
}

/** Everything the recorder needs to store one answer and its manifest. */
export interface AnswerRecording {
  readonly packet: ContextPacket;
  readonly answer: Omit<AskAnswer, 'answerManifestId'>;
  readonly grounding: GroundingResult;
  readonly suppliedTo: { modelProvider: string; modelId: string; promptVersion: string; composerVersion: string };
  readonly modelCandidates: readonly ModelCandidateRecord[];
}

/** Records the validated conversation turn and its supplied-context
 * manifest; answers the manifest id. The API opens its own `answer.record`
 * transaction for this (ADR 0026 §4). */
export type AnswerRecorder = (recording: AnswerRecording) => Promise<{ answerManifestId: string }>;

export interface AskOptions extends ContextBrokerOptions {
  /** The session's actor. It is never read from the request body. */
  readonly requestingActorId: string;
  readonly phraser?: AnswerPhraser;
  readonly recorder?: AnswerRecorder;
}

/** The provider name the manifest records when no model phrased the answer. */
export const DETERMINISTIC_COMPOSER_PROVIDER = 'unai-deterministic';

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
  changes?: ReturnType<typeof changeWindow>;
}): Draft[] {
  const drafts: Draft[] = [];
  const beliefs = new Map([...packet.currentBeliefs, ...packet.historicalBeliefs].map(belief => [belief.propositionId, belief]));
  const futures = new Map(packet.futureClaims.map(claim => [claim.propositionId, claim]));
  const evidenceOf = (propositionId: string | null): string[] =>
    propositionId ? [...(beliefs.get(propositionId)?.evidenceIds ?? futures.get(propositionId)?.evidenceIds ?? [])] : [];
  const explain = (propositionId: string | null) => propositionId ? '/v1/memory/propositions/' + propositionId + '/explain' : null;
  const closedFrames = closedFrameIds(packet.resolutionAssertions);
  const stateSelections = packet.selections.filter(selection => selection.outcome !== 'EXCLUDED' && selection.outcome !== 'WITHHELD'
    && (classification.queryMode !== 'OPEN_COMMITMENTS' || !closedFrames.has(selection.frameInstanceId)));
  const freshnessByValue = new Map(packet.freshness?.map(value => [value.propositionId, value.assessment]) ?? []);

  const stateStatements = (prefix: string) => {
    for (const selection of stateSelections) {
      const subject = describeContract(selection.frameTypeId, selection.predicateId);
      if (selection.outcome === 'SELECTED') {
        const label = selection.certainty === 'ACCEPTED' ? FUTURE_LABEL[selection.modality] ?? selectedLabel(selection) : selectedLabel(selection);
        const freshness = freshnessByValue.get(selection.selectedPropositionId!);
        const lead = FUTURE_WORDING[selection.modality] ?? (freshness && freshness.state !== 'CURRENT' ? 'Last recorded' : prefix);
        drafts.push({
          kind: 'SELECTED_STATE', label,
          text: lead + ': ' + subject + ' is ' + ('selectedValue' in selection ? describeValue(selection.selectedValue) : 'withheld') + '.'
            + describeFreshness(freshness)
            + (selection.certainty === 'PROVISIONAL' ? ' This interpretation is provisional.' : '')
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
    case 'EPISODE_RECALL':
      if (classification.matchedRule === 'LIFE_CHANGES') {
        const window = options.changes ?? changeWindow('', packet.worldTime);
        drafts.push({kind:'NO_CURRENT_VALUE',label:'UNKNOWN',text:window.description,objectRefs:[],evidenceIds:[],explain:null});
        for (const transition of packet.understanding?.transitions ?? []) {
          if ((window.from && new Date(transition.recordedAt) < new Date(window.from))
            || (window.to && new Date(transition.recordedAt) >= new Date(window.to))) continue;
          const before = beliefs.get(transition.fromPropositionId), after = beliefs.get(transition.toPropositionId);
          if (!before || !after || !('normalizedValue' in before) || !('normalizedValue' in after)) continue;
          drafts.push({ kind: 'RECORDED_CHANGE', label: 'REPORTED',
            text: 'Historical record learned ' + transition.recordedAt.slice(0, 10)
              + (transition.effectiveAt ? ', effective ' + transition.effectiveAt.slice(0, 10) : ', effective date not recorded')
              + ': ' + describeContract(after.frameTypeId, after.predicateId)
              + ' changed from ' + describeValue(before.normalizedValue) + ' to ' + describeValue(after.normalizedValue)
              + (transition.kind === 'CORRECTS' ? ' (a correction to the record).' : '.') + ' No change reason is recorded in this link.',
            objectRefs: [before, after].map(value => ({ objectType: 'propositions', objectId: value.propositionId })),
            evidenceIds: [...new Set([...(before.evidenceIds ?? []), ...(after.evidenceIds ?? [])])], explain: explain(after.propositionId) });
        }
        if(!drafts.some(draft=>draft.kind==='RECORDED_CHANGE')) drafts.push({kind:'NO_CURRENT_VALUE',label:'UNKNOWN',
          text:'No recorded transition in the available memory answers this date range.',objectRefs:[],evidenceIds:[],explain:null});
      } else { semanticStatements(); resolutionStatements(); }
      break;
    case 'CAUSAL_EXPLANATION':
      if(classification.queryMode==='DECISION_RECONSTRUCTION'){
        const rationaleSlots = new Set(packet.selections.filter(selection => selection.contextKind === 'BASE'
          && selection.predicateRegistered && selection.outcome !== 'WITHHELD' && selection.outcome !== 'EXCLUDED')
          .map(selection => selection.beliefSlotId));
        const reasons=[...beliefs.values()].filter(value=>value.frameTypeId==='shared.decision'
          && value.predicateId==='shared.decision.rationale' && 'normalizedValue' in value
          && rationaleSlots.has(value.beliefSlotId)
          && ['ACCEPTED','SUPERSEDED','PROVISIONAL'].includes(value.assessmentStatus ?? ''));
        for(const reason of reasons)drafts.push({kind:'HISTORICAL_VALUE',label:'REPORTED',
          text:'Historical decision rationale: '+describeValue(reason.normalizedValue)+'.'
            + (reason.assessmentStatus === 'PROVISIONAL' ? ' This interpretation is provisional.' : ''),
          objectRefs:[{objectType:'propositions',objectId:reason.propositionId}],evidenceIds:[...(reason.evidenceIds??[])],explain:explain(reason.propositionId)});
        if(reasons.length===0)drafts.push({kind:'NO_CURRENT_VALUE',label:'UNKNOWN',
          text:'No recorded rationale for that decision was found in the available memory.',objectRefs:[],evidenceIds:[],explain:null});
      }else{stateStatements('Recorded');resolutionStatements();semanticStatements();}
      break;
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
      // Nothing matched is not an inference about the owner, and names no object.
      drafts.push({
        kind: 'AGGREGATE_COUNT', label: counted.length === 0 ? 'UNKNOWN' : 'INFERRED',
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

  if (classification.matchedRule === 'ASSISTANT_CAPABILITIES') drafts.push({ kind: 'CAPABILITY_SUMMARY', label: 'UNKNOWN',
    text: 'I can summarize these records and prepare a plan.' + (packet.allowedActions.includes('DRAFT')
      ? ' Draft preparation is available, subject to the current draft permission check.' : 'More information or confirmation is needed before preparing a draft.'),
    objectRefs: [], evidenceIds: [], explain: null });
  if (classification.matchedRule === 'FOCUS_PRIORITIES') {
    const unresolved = new Set(packet.understanding?.unresolvedFrameIds ?? []);
    const linkedFrames = new Set(packet.understanding?.goalLinks.filter(link => unresolved.has(link.frameInstanceId)).map(link => link.frameInstanceId) ?? []);
    const linked = stateSelections.filter(selection => linkedFrames.has(selection.frameInstanceId) && selection.selectedPropositionId);
    drafts.push({ kind: 'FOCUS_SUMMARY', label: linked.length > 0 ? 'RECOMMENDED' : 'UNKNOWN',
      text: linked.length > 0 ? 'Start with the unfinished items explicitly linked to your recorded goals, then review deadlines and unresolved conflicts.'
        : 'Review these unfinished items by deadline and consequence. No explicit goal link was available for this prioritization.',
      objectRefs: linked.map(selection => ({ objectType: 'propositions', objectId: selection.selectedPropositionId! })),
      evidenceIds: linked.flatMap(selection => [...(selection.evidenceIds ?? [])]), explain: null });
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
  if (packet.unknowns.some(unknown => ['PROCESSING_INCOMPLETE','RETRIEVAL_INCOMPLETE','HISTORY_NOT_RECORDED'].includes(unknown.kind))) {
    drafts.push({ kind: 'MEMORY_INCOMPLETE', label: 'UNKNOWN',
      text: 'This view is incomplete: some evidence is still being processed, exceeds this retrieval window, or has no recorded historical state.',
      objectRefs: [], evidenceIds: [], explain: null });
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

/** The prompt version the manifest records when the deterministic composer, not a
 * model, was supplied the packet: its wording templates are its prompt. */
export const DETERMINISTIC_PROMPT_VERSION = 'composer-templates-0.2.0';

/** The only statement of an answer the grounding validator blocked. It says that
 * something was withheld and names none of it. */
export const GROUNDING_BLOCKED_TEXT =
  'This answer was withheld: it would have stated memory this request is not permitted to read.';

const EXPLAINABLE = new Set(['propositions', 'proposition']);

function explainPathOf(statement: AnswerCandidateStatement): string | null {
  const proposition = statement.objectRefs.find(ref => EXPLAINABLE.has(ref.objectType));
  return proposition ? '/v1/memory/propositions/' + proposition.objectId + '/explain' : null;
}

function numbered(statements: readonly AnswerCandidateStatement[]): ValidatableStatement[] {
  return statements.map((statement, position) => ({ ...statement, statementId: 'S' + (position + 1) }));
}

type Verdict = GroundingResult['action'];
const VERDICT_OUTCOME: Readonly<Record<string, Verdict>> = Object.freeze({
  PASSED: 'PASSED', DOWNGRADED: 'DOWNGRADED', REGENERATE: 'REGENERATED', BLOCKED: 'BLOCKED',
});
const BLOCKED_STATEMENT: AskStatement = Object.freeze({
  statementId: 'S1', kind: 'GROUNDING_BLOCKED', label: 'UNKNOWN', text: GROUNDING_BLOCKED_TEXT,
  objectRefs: [], sourceEvidenceIds: [], explainPath: null,
}) as AskStatement;

/**
 * Answer one question (design POST /v1/ask).
 *
 * The request is refused before any retrieval when it does not declare its owner
 * scope, question, purpose, times and ceiling. The context request the pipeline
 * then sends declares every field PRD §23.1 requires, with action risk LOW: an
 * answer performs no action, and an action founded on one goes through the
 * broker's own gate. A purpose the evidence does not admit is refused by the
 * broker, and that refusal is recorded (CRT-SEC-02-A).
 *
 * Whatever phrased it, nothing is presented before the grounding validator has
 * checked it against the packet (PRD §24.6, CRT-RD-08-A):
 *
 *  - a candidate the validator passes or downgrades is presented, downgraded;
 *  - a candidate that needs regenerating is phrased again with its violations,
 *    up to `MAX_PHRASING_ATTEMPTS`, and then replaced by the composer's own
 *    statements, which pass the same validator;
 *  - a candidate that leaks is blocked: the answer says it was withheld and
 *    states nothing.
 *
 * With a recorder, the validated turn and manifest of the supplied context are
 * recorded before the answer is returned (CRT-RD-06-A, CRT-AI-01-A).
 */
async function answerQuestionImpl(runner: ContextRunner, raw: unknown, options: AskOptions): Promise<AskAnswer> {
  const missing = missingAskFields(raw);
  if (missing.length > 0) throw new ContextBrokerError('ASK_REQUEST_INCOMPLETE', { missing });
  const parsed = askRequestSchema.safeParse(raw);
  if (!parsed.success) throw new ContextBrokerError('ASK_REQUEST_INVALID');
  const ask = parsed.data;
  const classified = classifyQuestion(ask.question);
  const classification: QuestionClassification = ask.referenceQuery?.kind === 'OBLIGATION'
    ? { ...classified, answerType: 'CURRENT_STATE', queryMode: 'CURRENT_VALUE', historicalMode: null,
      matchedRule: 'EXPLICIT_OBLIGATION_QUERY' } : classified;

  // PRD §12.3: "what did Uai believe then" is asked with the knowledge time at
  // the world time. A caller that left the knowledge time at LATEST gets that
  // mode's definition rather than today's knowledge about then.
  const beliefQuestion = classification.historicalMode === 'HISTORICAL_BELIEF_STATE';
  const knowledgeTime = beliefQuestion && ask.knowledgeTime === 'LATEST' && ask.worldTime !== 'NOW' ? ask.worldTime : ask.knowledgeTime;
  const historicalInstantMissing = classification.answerType === 'HISTORICAL_STATE' && ask.worldTime === 'NOW';

  const packet = await readContextPacket(runner, {
    ownerScopeId: ask.ownerScopeId, requestingActorId: options.requestingActorId, purpose: ask.purpose,
    query: ask.question, entityHints: ask.entityHints, worldlineHints: ask.worldlineHints,
    discourseAnchors: ask.discourseAnchors,
    ...(ask.referenceQuery ? { referenceQuery: ask.referenceQuery } : {}),
    frameTypeHints: ask.frameTypeHints.length>0?ask.frameTypeHints:classification.queryMode==='DECISION_RECONSTRUCTION'?['shared.decision']:[], lifeCategory: ask.lifeCategory,
    worldTime: ask.worldTime, knowledgeTime, maximumSensitivity: ask.maximumSensitivity, actionRisk: 'LOW',
    requiredCertainty: ['ACCEPTED', 'PROVISIONAL', 'CONTESTED', 'OWNER_OVERLAY'], includeEvidence: 'WHEN_NEEDED',
    answerType: classification.queryMode, timeWindow: ask.timeWindow, sourceTypes: ask.sourceTypes,
  }, options);

  const index = indexPacket(packet);
  const refs = new Map(packet.evidenceRefs.map(reference => [reference.evidenceId, reference]));
  // A statement links only evidence the packet actually carries: nothing the
  // request could not read is linked, nothing is linked twice, and an assistant's
  // own earlier message is never linked as a source (CRT-AI-01-A).
  const linkable = (evidenceIds: readonly string[]) =>
    [...new Set(evidenceIds.filter(id => refs.has(id) && !index.assistantEvidence.has(id)))].sort();

  const drafts: Draft[] = ask.referenceQuery?.kind === 'UNRESOLVED'
    ? [{ kind: 'NOTHING_FOUND', label: 'UNKNOWN',
      text: 'Nothing in the memory this request could read answers this question.',
      objectRefs: [], evidenceIds: [], explain: null }]
    : composeStatements(packet, classification, { historicalInstantMissing,
      changes: changeWindow(ask.question,packet.worldTime,ask.timeWindow) });
  const composed: AskStatement[] = drafts.map((draft, position) => ({
    statementId: 'S' + (position + 1), kind: draft.kind, label: draft.label, text: draft.text,
    objectRefs: draft.objectRefs, sourceEvidenceIds: linkable(draft.evidenceIds), explainPath: draft.explain,
  }));
  const draftCandidate: AnswerCandidateStatement[] = composed.map(statement => ({
    text: statement.text, label: statement.label, objectRefs: statement.objectRefs,
    sourceEvidenceIds: statement.sourceEvidenceIds, sensitivityScope: null,
  }));

  const attempts: GroundingResult['attempts'] = [];
  const violations: GroundingViolation[] = [];
  const modelCandidates: ModelCandidateRecord[] = [];
  let presented: AskStatement[] | null = null;
  let finalSource: 'MODEL' | 'DETERMINISTIC_COMPOSER' = 'DETERMINISTIC_COMPOSER';
  let finalVerdict: Verdict = 'PASSED';
  const validate = (statements: readonly ValidatableStatement[]) =>
    traceStageSync('answer.ground',{ownerScopeId:ask.ownerScopeId,correlationId:options.correlationId},
      ()=>validateGrounding(packet, statements, { maximumSensitivity: ask.maximumSensitivity, index }),
      {componentVersion:GROUNDING_VALIDATOR_VERSION,registryReleaseId:options.registryReleaseId});

  const phraser = ask.referenceQuery?.kind === 'UNRESOLVED' ? undefined : options.phraser;
  if (phraser) {
    let lastViolations: GroundingViolation[] = [];
    for (let attempt = 1; attempt <= MAX_PHRASING_ATTEMPTS && presented === null; attempt++) {
      let candidate: AnswerCandidate;
      try {
        candidate = answerCandidateSchema.parse(await traceStage('model.generate',{ownerScopeId:ask.ownerScopeId,correlationId:options.correlationId},()=>phraser.phrase({
          ownerScopeId: ask.ownerScopeId, correlationId: options.correlationId, question: ask.question,
          answerType: classification.answerType, packet, draft: draftCandidate, attempt, violations: lastViolations,
        }),{attempt,registryReleaseId:options.registryReleaseId}));
      } catch {
        // A model that failed or answered outside its contract produced no
        // candidate (the gateway recorded the call); the composer answers.
        break;
      }
      const result = validate(numbered(candidate.statements));
      const outcome = VERDICT_OUTCOME[result.verdict]!;
      attempts.push({ attempt, candidateSource: 'MODEL', outcome, violations: result.violations });
      violations.push(...result.violations);
      modelCandidates.push({ attempt, outcome, statements: candidate.statements });
      lastViolations = result.violations;
      if (result.verdict === 'BLOCKED') {
        presented = [BLOCKED_STATEMENT];
        finalSource = 'MODEL'; finalVerdict = 'BLOCKED';
      } else if (result.verdict !== 'REGENERATE') {
        presented = result.statements.map(statement => ({
          statementId: statement.statementId, kind: 'MODEL_PHRASED', label: statement.label, text: statement.text,
          objectRefs: statement.objectRefs, sourceEvidenceIds: linkable(statement.sourceEvidenceIds),
          explainPath: explainPathOf(statement),
        }));
        finalSource = 'MODEL'; finalVerdict = outcome;
      }
    }
  }
  if (presented === null) {
    // No model, or a model that could not produce a grounded candidate: the
    // composer's statements, through the same validator. A composer statement
    // the validator will not pass is a defect, and it fails closed as a block.
    const result = validate(numbered(draftCandidate));
    const outcome = VERDICT_OUTCOME[result.verdict]!;
    attempts.push({ attempt: attempts.length + 1, candidateSource: 'DETERMINISTIC_COMPOSER', outcome,
      violations: result.violations });
    violations.push(...result.violations);
    finalSource = 'DETERMINISTIC_COMPOSER';
    if (result.verdict === 'PASSED') {
      presented = composed; finalVerdict = 'PASSED';
    } else if (result.verdict === 'DOWNGRADED') {
      presented = result.statements.map((statement, position) => ({
        ...composed[position]!, label: statement.label, text: statement.text,
        sourceEvidenceIds: linkable(statement.sourceEvidenceIds),
      }));
      finalVerdict = 'DOWNGRADED';
    } else {
      presented = [BLOCKED_STATEMENT]; finalVerdict = 'BLOCKED';
    }
  }
  const regenerated = attempts.some(entry => entry.outcome === 'REGENERATED');
  const grounding = groundingResultSchema.parse({
    validatorVersion: GROUNDING_VALIDATOR_VERSION,
    action: finalVerdict === 'BLOCKED' ? 'BLOCKED' : regenerated ? 'REGENERATED' : finalVerdict,
    finalSource, attempts, violations,
  });

  const statements = presented;
  const linked = [...new Set(statements.flatMap(statement => statement.sourceEvidenceIds))].sort();
  const answer = askAnswerSchema.omit({ answerManifestId: true }).parse({
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
    composer: {
      kind: finalSource === 'MODEL' ? 'MODEL_PHRASED' : 'DETERMINISTIC_COMPOSER', version: ASK_COMPOSER_VERSION,
      modelCalled: phraser !== undefined, modelId: phraser?.modelId ?? null, promptVersion: phraser?.promptVersion ?? null,
    },
    grounding,
  });

  let answerManifestId: string | null = null;
  if (options.recorder) {
    const recorder=options.recorder;
    answerManifestId = (await traceStage('answer.record',{ownerScopeId:ask.ownerScopeId,correlationId:options.correlationId},()=>recorder({
      packet, answer, grounding, modelCandidates,
      suppliedTo: phraser
        ? { modelProvider: phraser.modelProvider, modelId: phraser.modelId, promptVersion: phraser.promptVersion,
          composerVersion: ASK_COMPOSER_VERSION }
        : { modelProvider: DETERMINISTIC_COMPOSER_PROVIDER, modelId: ASK_COMPOSER_VERSION,
          promptVersion: DETERMINISTIC_PROMPT_VERSION, composerVersion: ASK_COMPOSER_VERSION },
    }),{registryReleaseId:options.registryReleaseId})).answerManifestId;
  }
  return askAnswerSchema.parse({ ...answer, answerManifestId });
}

export function answerQuestion(...args:Parameters<typeof answerQuestionImpl>):ReturnType<typeof answerQuestionImpl>{
  return traceStage('answer.compose',{ownerScopeId:askRequestSchema.safeParse(args[1]).data?.ownerScopeId??'INVALID',correlationId:args[2].correlationId},()=>answerQuestionImpl(...args),{registryReleaseId:args[2].registryReleaseId,componentVersion:ASK_COMPOSER_VERSION});
}
