import { commitmentReadingSchema, type CommitmentReading, type OutcomeCode, type TransitionContract } from '@unai/domain';
import {
  canonicalizeResolutionStatement, createFrameInstance, recordClaim, recordFrameInstanceRole, resolveBeliefSlot,
  resolveProposition, type CanonicalizedResolution, type MemoryTransaction,
} from '@unai/memory';

/**
 * The commitments capability (PRD §26.2, §44.8, §58; CRT-PRJ-07-A, CRT-OUT-07-A).
 *
 * Two rules the whole file exists to hold:
 *
 *  1. **Commitment language creates a commitment; consideration language does
 *     not.** "I will send Daniel the report by Friday" is an undertaking. "I am
 *     considering sending it Friday" is a thought about one, and turning it into
 *     a promise would put a duty in front of the owner that they never took on.
 *     The classifier answers `CONSIDERATION` for it and this module then creates
 *     nothing at all -- no frame instance, no slot, no proposition.
 *  2. **Completion is a resolution assertion, never a status field.** "Done, I
 *     sent it" records a target-less FULFILLED resolution beside the commitment;
 *     the commitment's own slots are not touched. That path is
 *     `@unai/memory`'s `canonicalizeResolutionStatement`, reused rather than
 *     restated, so the transition contract still decides what may be asserted.
 *
 * `shared.commitment` in release 0.1.0 defines no status predicate, which is what
 * makes rule 2 the only way completion can be written down at all.
 */

export const COMMITMENT_CAPABILITY_VERSION = 'capability-commitments-0.1.0';
// Unchanged by the long-input fix: only inputs that used to throw (a ZodError on an
// over-bound action or due phrase) get new readings, and every reading recorded under
// 0.1.0 is reproduced byte for byte. A bump would make identical readings look
// different in claim metadata and in replays.
export const COMMITMENT_CLASSIFIER_VERSION = 'commitment-language-0.1.0';
export const COMMITMENT_FRAME_TYPE = 'shared.commitment';
export const COMMITMENT_RESOLUTION_CONTRACT = 'shared.commitment.resolution';

/** Consideration, deliberation and conditionality. Tried first and on the whole
 * sentence: "I am considering whether I will send it" is deliberation even
 * though it contains "I will". */
const CONSIDERATION = /\b(?:consider(?:ing)?|thinking about|thinking of|might|maybe|perhaps|possibly|weighing|debating|tempted to|toying with|not sure (?:if|whether)|may(?: well)? send|leaning towards?|if I (?:get|have) time)\b/i;

/** An undertaking in the first person. A promise somebody else made is their
 * commitment and is recorded with them as promisor by the caller, not read out
 * of this pattern. */
const COMMITMENT = /\b(?:I['’]ll|I will|I am going to|I'm going to|I’m going to|I shall|I promise(?: to)?|I commit(?: to)?|I undertake(?: to)?|I'll be|will send|will deliver|will finish|will get)\b/i;

/** The tail that states when. Kept as the owner's words: resolving it into an
 * instant is the temporal resolver's work and carries its own precision and
 * confidence (PRD §12.5). */
const DUE_PHRASE = /\b(?:by|before|on|no later than)\s+([^.,;!?]+)/i;

/** Mirror commitmentReadingSchema's bounds (@unai/domain projections.ts), in UTF-16
 * code units, the unit zod's max() counts. The schema itself is not loosened. */
const MAX_ACTION = 4096;
const MAX_DUE = 512;

/** The first `max` code units of `text`, or one fewer when that would split a
 * surrogate pair (the same rule as boundedBody in @unai/domain, private there). */
function codeUnitPrefix(text: string, max: number): string {
  if (text.length <= max) return text;
  const high = text.charCodeAt(max - 1);
  return text.slice(0, high >= 0xd800 && high <= 0xdbff ? max - 1 : max);
}

/**
 * Read a sentence as commitment language, consideration language, or neither.
 *
 * Deterministic and pure: the same sentence always reads the same way, there is
 * no model call, and `NONE` is an ordinary answer. A caller that wants a
 * commitment out of a sentence this returns `CONSIDERATION` or `NONE` for has to
 * say so explicitly somewhere else; there is no confidence threshold here to
 * lean on.
 */
export function classifyCommitmentLanguage(statement?: string | null): CommitmentReading {
  const text = (statement ?? '').trim();
  const none = { language: 'NONE' as const, matchedText: null, actionDescription: null, dueTimeText: null,
    classifierVersion: COMMITMENT_CLASSIFIER_VERSION };
  if (text === '') return commitmentReadingSchema.parse(none);

  const consideration = CONSIDERATION.exec(text);
  if (consideration) {
    return commitmentReadingSchema.parse({ ...none, language: 'CONSIDERATION', matchedText: consideration[0] });
  }
  const commitment = COMMITMENT.exec(text);
  if (!commitment) return commitmentReadingSchema.parse(none);

  const after = text.slice(commitment.index + commitment[0].length).trim();
  // A capture over MAX_DUE is a sentence that kept going, not a stated time. Cutting it
  // would hand the temporal resolver prose it can never resolve (it matches whole
  // phrases) and count an unresolved due time the owner never stated, so such a text
  // has no due phrase and the action runs to the end of it.
  const found = DUE_PHRASE.exec(after);
  const due = found && found[1]!.trim().length <= MAX_DUE ? found : null;
  const action = (due ? after.slice(0, due.index) : after).replace(/\s+/g, ' ').trim().replace(/[.,;!?]+$/, '');
  return commitmentReadingSchema.parse({
    language: 'COMMITMENT',
    matchedText: commitment[0],
    actionDescription: action === '' ? null : codeUnitPrefix(action, MAX_ACTION),
    dueTimeText: due?.[1]?.trim() ?? null,
    classifierVersion: COMMITMENT_CLASSIFIER_VERSION,
  });
}

export interface CommitmentStatementRequest {
  readonly ownerScopeId: string;
  readonly contextSpaceId: string;
  readonly statement: string;
  readonly sourceAnchorId: string;
  readonly claimOrigin: 'USER_STATEMENT' | 'USER_CONFIRMATION' | 'USER_CORRECTION' | 'EXTERNAL_PERSON_ASSERTION'
  | 'STRUCTURED_CONNECTOR_OBSERVATION' | 'DOCUMENT_ASSERTION' | 'MODEL_EXTRACTION';
  readonly assertedByEntityId: string;
  readonly promisorEntityId: string;
  readonly promiseeEntityId?: string | null;
  /** The resolved due instant, when a temporal resolver produced one. The
   * statement's own wording is kept on the claim either way. */
  readonly dueTime?: Date | null;
  readonly statedAt: Date;
  readonly extractionRunId?: string | null;
  readonly registryReleaseId?: string | null;
}

export interface CanonicalizedCommitment {
  readonly reading: CommitmentReading;
  readonly created: boolean;
  readonly commitmentFrameInstanceId: string | null;
  readonly actionDescriptionPropositionId: string | null;
  readonly dueTimePropositionId: string | null;
  readonly claimIds: readonly string[];
  /** The modality every slot this created carries. `COMMITTED` is the only value
   * release 0.1.0 allows for a commitment predicate, and it is stored separately
   * from the belief status and the claim origin (PRD §11.7). */
  readonly modality: 'COMMITTED' | null;
  readonly capabilityVersion: string;
}

/**
 * Canonicalize an undertaking, or decline to.
 *
 * On `CONSIDERATION` and `NONE` this writes nothing and says so. The sentence is
 * still evidence -- the caller already ingested it -- and a later explicit
 * promise about the same action creates the commitment then.
 */
export async function canonicalizeCommitmentStatement(
  tx: MemoryTransaction, request: CommitmentStatementRequest,
): Promise<CanonicalizedCommitment> {
  const reading = classifyCommitmentLanguage(request.statement);
  if (reading.language !== 'COMMITMENT') {
    return Object.freeze({
      reading, created: false, commitmentFrameInstanceId: null, actionDescriptionPropositionId: null,
      dueTimePropositionId: null, claimIds: Object.freeze([]), modality: null,
      capabilityVersion: COMMITMENT_CAPABILITY_VERSION,
    });
  }
  const release = request.registryReleaseId ?? null;
  const commitmentFrameInstanceId = await createFrameInstance(tx, {
    ownerScopeId: request.ownerScopeId, frameTypeId: COMMITMENT_FRAME_TYPE, contextSpaceId: request.contextSpaceId,
  });
  const description = reading.actionDescription ?? request.statement.trim();
  const claimIds: string[] = [];

  const actionSlot = await resolveBeliefSlot(tx, {
    ownerScopeId: request.ownerScopeId, registryReleaseId: release,
    descriptor: { frameInstanceId: commitmentFrameInstanceId, predicateId: 'shared.commitment.action_description',
      contextSpaceId: request.contextSpaceId, modality: 'COMMITTED', qualifiers: {} },
  });
  const actionProposition = await resolveProposition(tx, {
    ownerScopeId: request.ownerScopeId, beliefSlotId: actionSlot.beliefSlotId,
    normalizedValue: { text: description }, registryReleaseId: release,
  });
  const actionClaimId = await recordClaim(tx, {
    ownerScopeId: request.ownerScopeId, sourceAnchorId: request.sourceAnchorId, claimOrigin: request.claimOrigin,
    lifecycle: 'CANDIDATE', propositionId: actionProposition.propositionId,
    candidateFrameTypeId: COMMITMENT_FRAME_TYPE, assertedByEntityId: request.assertedByEntityId,
    extractionRunId: request.extractionRunId ?? null, validFrom: request.statedAt,
    metadata: { commitmentStatement: { statement: request.statement, matchedText: reading.matchedText,
      classifierVersion: COMMITMENT_CLASSIFIER_VERSION } },
  });
  claimIds.push(actionClaimId);

  await recordFrameInstanceRole(tx, { ownerScopeId: request.ownerScopeId, frameInstanceId: commitmentFrameInstanceId,
    roleId: 'promisor', entityId: request.promisorEntityId, claimId: actionClaimId });
  if (request.promiseeEntityId) {
    await recordFrameInstanceRole(tx, { ownerScopeId: request.ownerScopeId, frameInstanceId: commitmentFrameInstanceId,
      roleId: 'promisee', entityId: request.promiseeEntityId, claimId: actionClaimId });
  }
  await recordFrameInstanceRole(tx, { ownerScopeId: request.ownerScopeId, frameInstanceId: commitmentFrameInstanceId,
    roleId: 'action', typedValue: { description }, claimId: actionClaimId });

  let dueTimePropositionId: string | null = null;
  if (request.dueTime) {
    const dueSlot = await resolveBeliefSlot(tx, {
      ownerScopeId: request.ownerScopeId, registryReleaseId: release,
      descriptor: { frameInstanceId: commitmentFrameInstanceId, predicateId: 'shared.commitment.due_time',
        contextSpaceId: request.contextSpaceId, modality: 'COMMITTED', qualifiers: {} },
    });
    const dueProposition = await resolveProposition(tx, {
      ownerScopeId: request.ownerScopeId, beliefSlotId: dueSlot.beliefSlotId, registryReleaseId: release,
      normalizedValue: { time: request.dueTime.toISOString() },
    });
    dueTimePropositionId = dueProposition.propositionId;
    claimIds.push(await recordClaim(tx, {
      ownerScopeId: request.ownerScopeId, sourceAnchorId: request.sourceAnchorId, claimOrigin: request.claimOrigin,
      lifecycle: 'CANDIDATE', propositionId: dueProposition.propositionId,
      candidateFrameTypeId: COMMITMENT_FRAME_TYPE, assertedByEntityId: request.assertedByEntityId,
      extractionRunId: request.extractionRunId ?? null, validFrom: request.statedAt,
      // The owner's own words for the deadline, kept beside the resolved instant.
      metadata: { dueTimeText: reading.dueTimeText },
    }));
  }

  return Object.freeze({
    reading, created: true, commitmentFrameInstanceId,
    actionDescriptionPropositionId: actionProposition.propositionId, dueTimePropositionId,
    claimIds: Object.freeze(claimIds), modality: 'COMMITTED' as const,
    capabilityVersion: COMMITMENT_CAPABILITY_VERSION,
  });
}

export interface CommitmentCompletionRequest {
  readonly ownerScopeId: string;
  readonly commitmentFrameInstanceId: string;
  readonly statement: string;
  readonly sourceAnchorId: string;
  readonly claimOrigin: CommitmentStatementRequest['claimOrigin'];
  readonly assertedByEntityId: string;
  readonly effectiveAt: Date;
  readonly transitionContracts: readonly TransitionContract[];
  readonly outcomeCode?: OutcomeCode;
  readonly lifecycle?: 'PROPOSED' | 'ACCEPTED';
  readonly creationTransactionId?: string | null;
}

/**
 * "Done, I sent it" -- a target-less resolution over the commitment.
 *
 * No target: the owner's statement that they did it is the whole evidence, and
 * there is no separate occurrence frame to point at (PRD §16.2, §44.8). A later
 * external receipt may REALIZE the same commitment and support this resolution;
 * it does not replace it.
 */
export async function recordCommitmentCompletion(
  tx: MemoryTransaction, request: CommitmentCompletionRequest,
): Promise<CanonicalizedResolution> {
  return canonicalizeResolutionStatement(tx, {
    ownerScopeId: request.ownerScopeId,
    sourceFrameInstanceId: request.commitmentFrameInstanceId,
    sourceFrameTypeId: COMMITMENT_FRAME_TYPE,
    statement: request.statement,
    sourceAnchorId: request.sourceAnchorId,
    claimOrigin: request.claimOrigin,
    assertedByEntityId: request.assertedByEntityId,
    effectiveAt: request.effectiveAt,
    transitionContractId: COMMITMENT_RESOLUTION_CONTRACT,
    transitionContracts: request.transitionContracts,
    targetFrameInstanceId: null,
    ...(request.outcomeCode === undefined ? {} : { outcomeCode: request.outcomeCode }),
    lifecycle: request.lifecycle ?? 'PROPOSED',
    creationTransactionId: request.creationTransactionId ?? null,
  });
}
