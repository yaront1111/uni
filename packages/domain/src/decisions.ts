import { z } from 'zod';
import { lifeCategorySchema } from './context.js';
import { certaintyLabelSchema } from './labels.js';
import { outcomeCodeSchema, resolutionLifecycleSchema } from './outcomes.js';
import { outcomeStateSchema, pendingAssertionSchema, projectionRowMetadataSchema } from './projections.js';
import { attentionBudgetSchema, interruptionDecisionKindSchema, interruptionPolicyInputsSchema, interruptionReasonSchema,
  sensitivityScopeSchema } from './review.js';

/** Goals, decisions and the mentor (PRD §7.4, §25.3, §36.13, §37.7, §52; design
 * entities `goals`, `goal_priority_history`, `decision_projection`; ADR 0029).
 *
 * Schemas only, as every file in this package. The closed enums are the contract
 * migration 0026's CHECK lists and `@unai/capabilities` / `@unai/mentor` hold to.
 */

const registryId = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
const version = z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/);
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const text = (max: number) => z.string().trim().min(1).max(max);

// ---------------------------------------------------------------------------
// Goals and their priority history (design GET/POST /v1/goals,
// PATCH /v1/goals/{id}/priority)
// ---------------------------------------------------------------------------

export const goalPrioritySchema = z.enum(['HIGH', 'MEDIUM', 'LOW', 'PAUSED']);
export type GoalPriority = z.infer<typeof goalPrioritySchema>;
export const goalChangeKindSchema = z.enum(['INITIAL', 'CHANGE', 'TEMPORARY_OVERRIDE']);

/** One retained priority statement. Rows are appended and never rewritten, so a
 * goal's history is the whole list, oldest first (CRT-DEC-01-A). */
export const goalPriorityHistoryEntrySchema = z.strictObject({
  goalPriorityHistoryId: z.uuid(),
  changeKind: goalChangeKindSchema,
  priority: goalPrioritySchema,
  validFrom: z.iso.datetime(),
  validTo: z.iso.datetime().nullable(),
  recordedAt: z.iso.datetime(),
  reason: text(500),
});
export type GoalPriorityHistoryEntry = z.infer<typeof goalPriorityHistoryEntrySchema>;

export const temporaryOverrideSchema = z.strictObject({
  historyId: z.uuid(),
  priority: goalPrioritySchema,
  validFrom: z.iso.datetime(),
  validTo: z.iso.datetime(),
  reason: text(500),
});
export type TemporaryOverride = z.infer<typeof temporaryOverrideSchema>;

/** The latest mentor reading of a goal, shown on the Goals screen as a flag. */
export const goalContradictionFlagSchema = z.strictObject({
  mentorCardId: z.uuid(),
  decision: interruptionDecisionKindSchema,
  reason: interruptionReasonSchema,
  ownerLocalDate: localDate,
  decidedAt: z.iso.datetime(),
});

export const goalSchema = z.strictObject({
  goalId: z.uuid(),
  title: text(200),
  domain: lifeCategorySchema,
  /** The owner's standing statement: the latest INITIAL or CHANGE row. */
  currentPriority: goalPrioritySchema,
  /** What applies now: an unexpired temporary override, else the current priority. */
  effectivePriority: goalPrioritySchema,
  temporaryOverride: temporaryOverrideSchema.nullable(),
  overrideActive: z.boolean(),
  createdAt: z.iso.datetime(),
  retiredAt: z.iso.datetime().nullable(),
  priorityHistory: z.array(goalPriorityHistoryEntrySchema).max(500),
  contradiction: goalContradictionFlagSchema.nullable(),
});
export type Goal = z.infer<typeof goalSchema>;

export const goalsViewSchema = z.strictObject({
  goals: z.array(goalSchema).max(200),
  readAt: z.iso.datetime(),
});
export type GoalsView = z.infer<typeof goalsViewSchema>;

export const createGoalSchema = z.strictObject({
  title: text(200),
  domain: lifeCategorySchema,
  priority: goalPrioritySchema,
  reason: text(500).optional(),
  temporaryOverride: z.strictObject({
    priority: goalPrioritySchema, reason: text(500), until: z.iso.datetime({ offset: true }),
  }).optional(),
});
export type CreateGoal = z.infer<typeof createGoalSchema>;

/** A priority change. With `until` it is a temporary override: the standing
 * priority is unchanged and the override applies until then (PRD §37.7). */
export const goalPriorityChangeSchema = z.strictObject({
  priority: goalPrioritySchema,
  reason: text(500),
  effectiveFrom: z.iso.datetime({ offset: true }).optional(),
  until: z.iso.datetime({ offset: true }).optional(),
});
export type GoalPriorityChange = z.infer<typeof goalPriorityChangeSchema>;

export const goalPriorityChangeResultSchema = z.strictObject({
  goal: goalSchema,
  appended: goalPriorityHistoryEntrySchema,
});

// ---------------------------------------------------------------------------
// Decisions (design POST /v1/decisions, GET /v1/decisions/{id},
// GET /v1/projections/decisions, POST /v1/decisions/{id}/review)
// ---------------------------------------------------------------------------

export const DECISION_FRAME_TYPE = 'shared.decision';
export const DECISION_REVIEW_CONTRACT = 'shared.decision.prediction_review';

export const recordDecisionSchema = z.strictObject({
  question: text(1000),
  options: z.array(text(1000)).min(1).max(12),
  assumptions: z.array(z.strictObject({
    text: text(1000),
    /** Evidence the owner cites for the assumption. Linked, never copied, and
     * never counted as support for it. */
    sourceEvidenceIds: z.array(z.uuid()).max(16).default([]),
  })).max(24).default([]),
  consequences: z.array(z.strictObject({ domain: lifeCategorySchema, text: text(1000) })).max(24).default([]),
  recommendation: text(1000).optional(),
  userChoice: text(1000).optional(),
  rationale: text(2000).optional(),
  expectedResult: text(1000).optional(),
  reviewDate: z.iso.datetime({ offset: true }).optional(),
  goalId: z.uuid().optional(),
});
export type RecordDecision = z.input<typeof recordDecisionSchema>;

const statedValue = z.strictObject({ propositionId: z.uuid(), text: text(4096) });

export const decisionProjectionRowSchema = projectionRowMetadataSchema.extend({
  decisionFrameInstanceId: z.uuid(),
  question: z.string().max(4096).nullable(),
  alternatives: z.array(statedValue).max(64),
  assumptions: z.array(statedValue.extend({
    claimIds: z.array(z.uuid()).max(64),
    citedEvidenceIds: z.array(z.uuid()).max(64),
  })).max(64),
  crossDomainConsequences: z.array(statedValue.extend({ domain: lifeCategorySchema })).max(64),
  recommendation: z.string().max(4096).nullable(),
  userChoice: z.string().max(4096).nullable(),
  rationale: z.string().max(4096).nullable(),
  expectedResult: z.string().max(4096).nullable(),
  reviewDate: z.iso.datetime().nullable(),
  /** The review date has passed and no review is recorded. Set by the clock only. */
  reviewDue: z.boolean(),
  actualOutcome: z.string().max(4096).nullable(),
  reviewOutcomeCode: z.enum(['CONFIRMED', 'REFUTED', 'PARTIALLY_CONFIRMED']).nullable(),
  /** A review is PROPOSED until a governed transaction accepts it. */
  reviewLifecycle: z.enum(['PROPOSED', 'ACCEPTED', 'CONTESTED']).nullable(),
  outcomeState: outcomeStateSchema,
  relatedGoalId: z.uuid().nullable(),
  predictedOutcomePropositionIds: z.array(z.uuid()).max(64),
  actualResolutionIds: z.array(z.uuid()).max(64),
  conflictFlag: z.boolean(),
  pendingAssertions: z.array(pendingAssertionSchema).max(200),
});
export type DecisionProjectionRow = z.infer<typeof decisionProjectionRowSchema>;

export const decisionProjectionViewSchema = z.strictObject({
  projectionName: z.literal('decision_projection'),
  rows: z.array(decisionProjectionRowSchema).max(500),
  isComplete: z.boolean(),
  ownerOverlayWatermark: z.number().int().nonnegative(),
  canonicalTransactionWatermark: z.iso.datetime(),
  projectionVersion: z.uuid().nullable(),
  reducerVersion: version,
  pendingAssertions: z.array(pendingAssertionSchema).max(500),
  readAt: z.iso.datetime(),
});
export type DecisionProjectionView = z.infer<typeof decisionProjectionViewSchema>;

/** Where a rationale statement comes from: the owner's own recorded words, or a
 * source the owner cited for an assumption. */
export const decisionSourceSchema = z.strictObject({
  evidenceId: z.uuid(),
  relation: z.enum(['STATED_IN', 'CITED']),
  sourceType: z.string().max(64).nullable(),
  occurredAt: z.iso.datetime().nullable(),
  /** The anchored words, or null when the source is withheld from this read. */
  excerpt: z.string().max(600).nullable(),
});
export type DecisionSource = z.infer<typeof decisionSourceSchema>;

export const decisionRationaleItemSchema = z.strictObject({
  kind: z.enum(['QUESTION', 'OPTION', 'ASSUMPTION', 'CONSEQUENCE', 'RECOMMENDATION', 'CHOICE', 'RATIONALE', 'EXPECTED_RESULT']),
  propositionId: z.uuid(),
  text: text(4096),
  label: certaintyLabelSchema,
  sources: z.array(decisionSourceSchema).max(32),
});
export type DecisionRationaleItem = z.infer<typeof decisionRationaleItemSchema>;

/** The answer to "Why did I make this decision?" (PRD §52 exit criterion;
 * CRT-DEC-02-A): composed from one Context Broker packet, every statement with
 * its sources. */
export const decisionRationaleSchema = z.strictObject({
  question: text(500),
  answerType: z.string().max(64),
  queryMode: z.string().max(64),
  answer: text(4000),
  /** False when the decision records no rationale and no assumption: the answer
   * then says so rather than inventing one. */
  reasonRecorded: z.boolean(),
  items: z.array(decisionRationaleItemSchema).max(128),
  contextPacketId: z.uuid(),
  packetHash: z.string().regex(/^[a-f0-9]{64}$/),
  composerVersion: version,
});
export type DecisionRationale = z.infer<typeof decisionRationaleSchema>;

export const decisionReviewInputSchema = z.strictObject({
  actualOutcome: text(1000).optional(),
  actualOutcomeEvidenceRef: z.uuid().optional(),
  /** The reviewer's reading of how the prediction held. Only the codes the
   * pinned transition contract allows are recorded. */
  outcomeCode: outcomeCodeSchema,
  transitionContractId: registryId.default(DECISION_REVIEW_CONTRACT),
  effectiveAt: z.iso.datetime({ offset: true }).optional(),
}).refine(input => input.actualOutcome !== undefined || input.actualOutcomeEvidenceRef !== undefined,
  { message: 'DECISION_ACTUAL_OUTCOME_REQUIRED' });
export type DecisionReviewInput = z.input<typeof decisionReviewInputSchema>;

/** Predicted versus actual, side by side, with the resolution that compares them.
 * The PREDICTED proposition is shown as it was stated: nothing in a review
 * rewrites it (CRT-DEC-02-A, CRT-OUT-05-A). */
export const predictionComparisonSchema = z.strictObject({
  decisionFrameInstanceId: z.uuid(),
  predicted: z.strictObject({
    propositionId: z.uuid(), text: text(4096), modality: z.literal('PREDICTED'),
    claimIds: z.array(z.uuid()).max(64), evidenceIds: z.array(z.uuid()).max(64),
  }),
  actual: z.strictObject({
    propositionId: z.uuid(), text: text(4096), modality: z.literal('ACTUAL'),
    claimIds: z.array(z.uuid()).max(64), evidenceIds: z.array(z.uuid()).max(64),
    citedEvidenceIds: z.array(z.uuid()).max(16),
  }),
  resolutionAssertionId: z.uuid(),
  resolutionCode: z.enum(['CONFIRMED', 'REFUTED', 'PARTIALLY_CONFIRMED']),
  resolutionLifecycle: resolutionLifecycleSchema,
  transitionContractId: registryId,
  effectiveAt: z.iso.datetime(),
});
export type PredictionComparison = z.infer<typeof predictionComparisonSchema>;

export const recordDecisionResultSchema = z.strictObject({
  decision: decisionProjectionRowSchema,
  evidenceId: z.uuid(),
  rationale: decisionRationaleSchema,
});
export const decisionDetailSchema = z.strictObject({
  decision: decisionProjectionRowSchema,
  rationale: decisionRationaleSchema,
  reviews: z.array(predictionComparisonSchema).max(64),
  readAt: z.iso.datetime(),
});
export type DecisionDetail = z.infer<typeof decisionDetailSchema>;
export const decisionReviewResultSchema = z.strictObject({
  comparison: predictionComparisonSchema,
  decision: decisionProjectionRowSchema,
  evidenceId: z.uuid(),
});
export type DecisionReviewResult = z.infer<typeof decisionReviewResultSchema>;

// ---------------------------------------------------------------------------
// The mentor (design screen "Mentor contradiction card"; ADR 0029 §7)
// ---------------------------------------------------------------------------

export const mentorGroundSchema = z.strictObject({
  objectType: z.enum(['goal', 'goal_priority_history', 'proposition', 'frame_instance', 'source_item']),
  objectId: z.uuid(),
});
export type MentorGround = z.infer<typeof mentorGroundSchema>;

/** What the record shows. Never an opinion. */
export const mentorEvidenceSchema = z.strictObject({
  label: z.literal('EVIDENCE'),
  kind: z.enum(['STATED_GOAL', 'CALENDAR_ALLOCATION']),
  text: text(1000),
  grounds: z.array(mentorGroundSchema).min(1).max(64),
});
/** What the mentor concludes from the evidence, labelled as a conclusion. */
export const mentorInferenceSchema = z.strictObject({
  label: z.literal('INFERENCE'),
  text: text(1000),
  confidence: z.number().min(0).max(1),
  goalMinutes: z.number().int().min(0),
  totalMinutes: z.number().int().min(0),
  /** The goal's share of the scheduled time, in whole percent. */
  sharePercent: z.number().int().min(0).max(100),
  eventCount: z.number().int().min(0),
  counterexampleSearch: z.strictObject({
    searched: text(500),
    counterexamplesFound: z.number().int().min(0),
    counterexampleIds: z.array(z.uuid()).max(64),
  }),
});
/** What the mentor suggests. Advice, never an intent or an action. */
export const mentorRecommendationSchema = z.strictObject({
  label: z.literal('RECOMMENDATION'),
  text: text(1000),
});

export const mentorCardSchema = z.strictObject({
  mentorCardId: z.uuid(),
  cardKind: z.literal('GOAL_CALENDAR_CONTRADICTION'),
  goalId: z.uuid(),
  goalTitle: text(200),
  goalDomain: lifeCategorySchema,
  goalPriorityHistoryId: z.uuid(),
  evidence: z.array(mentorEvidenceSchema).min(1).max(20),
  inference: mentorInferenceSchema,
  recommendation: mentorRecommendationSchema,
  observationWindow: z.strictObject({ from: z.iso.datetime(), to: z.iso.datetime() }),
  confidence: z.number().min(0).max(1),
  sensitivityScope: sensitivityScopeSchema,
  decision: interruptionDecisionKindSchema,
  reason: interruptionReasonSchema,
  policyInputs: interruptionPolicyInputsSchema,
  ownerLocalDate: localDate,
  decidedAt: z.iso.datetime(),
  contextPacketId: z.uuid(),
});
export type MentorCard = z.infer<typeof mentorCardSchema>;

export const mentorViewSchema = z.strictObject({
  ownerLocalDate: localDate,
  timeZone: z.string().min(1).max(64),
  budget: attentionBudgetSchema,
  /** Clarification cards asked and mentor cards emitted today: one budget. */
  proactiveItemsToday: z.number().int().min(0),
  remainingToday: z.number().int().min(0),
  /** Emitted today, within the budget. */
  cards: z.array(mentorCardSchema).max(50),
  /** Evaluated today and withheld, each with the reason. */
  withheld: z.array(mentorCardSchema).max(50),
  /** Goals whose explicit temporary override the mentor respected. */
  respectedOverrides: z.array(z.strictObject({
    goalId: z.uuid(), goalTitle: text(200), priority: goalPrioritySchema, until: z.iso.datetime(),
  })).max(200),
  contextPacketId: z.uuid().nullable(),
  composerVersion: version,
  readAt: z.iso.datetime(),
});
export type MentorView = z.infer<typeof mentorViewSchema>;
