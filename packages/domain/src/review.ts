import { z } from 'zod';
import { certaintyLabelSchema } from './labels.js';
import { lifeCategorySchema } from './context.js';

/** Proactive clarification and the weekly review (PRD §19.3, §19.4, §19.5, §37.4,
 * §39; design entities `clarification_cards`, `attention_budgets`,
 * `interruption_decisions`, `learned_approval_rules`, `weekly_reviews`,
 * `behavioral_observations`; ADR 0029).
 *
 * Schemas only, as every file in this package. The closed enums are the contract
 * migration 0023's CHECK lists hold to.
 */

const version = z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/);
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// ---------------------------------------------------------------------------
// Attention budgets (PRD §19.3; design PATCH /v1/settings/attention-budgets)
// ---------------------------------------------------------------------------

/** The PRD §19.3 starting budget. A missing `attention_budgets` row means these. */
export const DEFAULT_ATTENTION_BUDGET = Object.freeze({
  maxCardsPerDay: 3, maxCardsPerSensitivityScopePerDay: 1, repeatQuestionSuppressionDays: 7,
});

export const attentionBudgetSchema = z.strictObject({
  maxCardsPerDay: z.number().int().min(0).max(50),
  maxCardsPerSensitivityScopePerDay: z.number().int().min(0).max(50),
  repeatQuestionSuppressionDays: z.number().int().min(1).max(365),
  /** True while no owner setting exists and the PRD defaults are enforced. */
  isDefault: z.boolean(),
  updatedAt: z.iso.datetime().nullable(),
});
export type AttentionBudget = z.infer<typeof attentionBudgetSchema>;

/** Every field is optional so a caller changes one cap without restating the
 * others; an empty patch is refused rather than recorded as a change. */
export const attentionBudgetPatchSchema = z.strictObject({
  maxCardsPerDay: z.number().int().min(0).max(50).optional(),
  maxCardsPerSensitivityScopePerDay: z.number().int().min(0).max(50).optional(),
  repeatQuestionSuppressionDays: z.number().int().min(1).max(365).optional(),
}).refine(patch => Object.keys(patch).length > 0, { message: 'ATTENTION_BUDGET_PATCH_EMPTY' });
export type AttentionBudgetPatch = z.infer<typeof attentionBudgetPatchSchema>;

// ---------------------------------------------------------------------------
// Ambiguities, cards and interruption decisions (PRD §19.3, §19.4, §37.4)
// ---------------------------------------------------------------------------

/** ADR 0029 §1: what the inbox treats as an ambiguity, each an object that
 * already exists. */
export const ambiguityKindSchema = z.enum(['UNCONFIRMED_INTERPRETATION', 'CONTESTED_BELIEF', 'CONFLICTING_VALUES']);
export type AmbiguityKind = z.infer<typeof ambiguityKindSchema>;

/** ADR 0029 §3: `<LIFE_CATEGORY>/<SENSITIVITY>`. */
export const sensitivityScopeSchema = z.string()
  .regex(/^(FINANCE|FAMILY|WORK|HEALTH|ADMIN|PERSONAL)\/(NORMAL|PRIVATE|RESTRICTED)$/);
export type SensitivityScope = z.infer<typeof sensitivityScopeSchema>;

export const situationKeySchema = z.string()
  .regex(/^(thread|frame):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
export const situationKindSchema = z.enum(['REPAYMENT', 'GENERAL']);

export const ambiguitySchema = z.strictObject({
  ambiguityId: z.uuid(),
  kind: ambiguityKindSchema,
  frameInstanceId: z.uuid(),
  frameTypeId: z.string().max(128),
  predicateId: z.string().max(128),
  /** The propositions a choice can confirm or reject for this ambiguity. */
  propositionIds: z.array(z.uuid()).min(1).max(32),
  evidenceIds: z.array(z.uuid()).max(256),
  detail: z.string().min(1).max(500),
});
export type Ambiguity = z.infer<typeof ambiguitySchema>;

/** The three owner controls a card choice can run (PRD §37.3). */
export const cardEffectSchema = z.enum(['CONFIRM', 'REJECT', 'KEEP_UNCERTAIN']);
export type CardEffect = z.infer<typeof cardEffectSchema>;

export const cardChoiceSchema = z.strictObject({
  choiceId: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  label: z.string().min(1).max(80),
  effect: cardEffectSchema,
  /** PRD §37.4: "Each card shows ... what will change." */
  whatWillChange: z.string().min(1).max(600),
  targets: z.array(z.strictObject({ objectType: z.literal('proposition'), objectId: z.uuid() })).max(32),
});
export type CardChoice = z.infer<typeof cardChoiceSchema>;

export const errorConsequenceSchema = z.enum(['LOW', 'MEDIUM', 'HIGH']);
export const irreversibilitySchema = z.enum(['REVERSIBLE', 'COSTLY_TO_REVERSE', 'IRREVERSIBLE']);
export const urgencySchema = z.enum(['LOW', 'MEDIUM', 'HIGH']);
export const interruptionCostSchema = z.enum(['LOW', 'MEDIUM', 'HIGH']);

/** PRD §19.4: the five inputs, plus the budget state the decision was counted
 * against. Logged whole with every decision. */
export const interruptionPolicyInputsSchema = z.strictObject({
  errorProbability: z.number().min(0).max(1),
  consequence: errorConsequenceSchema,
  irreversibility: irreversibilitySchema,
  urgency: urgencySchema,
  interruptionCost: interruptionCostSchema,
  /** The qualitative product of the four risk inputs and the cost it is weighed
   * against, both on the fixed scale of `@unai/review` (ADR 0029 §4). */
  expectedValue: z.number().min(0).max(1),
  interruptionCostValue: z.number().min(0).max(1),
  sensitivityScope: sensitivityScopeSchema,
  ownerLocalDate: localDate,
  timeZone: z.string().min(1).max(64),
  budget: z.strictObject({
    maxCardsPerDay: z.number().int().min(0),
    maxCardsPerSensitivityScopePerDay: z.number().int().min(0),
    repeatQuestionSuppressionDays: z.number().int().min(1),
    askedToday: z.number().int().min(0),
    askedInScopeToday: z.number().int().min(0),
  }),
  lastAskedAt: z.iso.datetime().nullable(),
  suppressedUntil: z.iso.datetime().nullable(),
  materialNewEvidenceIds: z.array(z.uuid()).max(256),
  learnedApprovalRuleId: z.uuid().nullable(),
});
export type InterruptionPolicyInputs = z.infer<typeof interruptionPolicyInputsSchema>;

export const interruptionDecisionKindSchema = z.enum(['ASK', 'BATCH', 'SUPPRESS']);
export const interruptionReasonSchema = z.enum([
  'WITHIN_ATTENTION_BUDGET', 'REOPENED_BY_MATERIAL_NEW_EVIDENCE', 'DAILY_BUDGET_EXHAUSTED', 'SCOPE_BUDGET_EXHAUSTED',
  'VALUE_BELOW_INTERRUPTION_COST', 'ASKED_WITHIN_SUPPRESSION_WINDOW', 'KEPT_UNCERTAIN_WITHIN_SUPPRESSION_WINDOW',
  'LEARNED_RULE_APPLIED',
]);
export type InterruptionReason = z.infer<typeof interruptionReasonSchema>;

export const interruptionDecisionSchema = z.strictObject({
  interruptionDecisionId: z.uuid(),
  clarificationCardId: z.uuid(),
  candidateAmbiguityId: z.uuid(),
  ambiguityKind: ambiguityKindSchema,
  decision: interruptionDecisionKindSchema,
  reason: interruptionReasonSchema,
  policyInputs: interruptionPolicyInputsSchema,
  ownerLocalDate: localDate,
  policyVersion: version,
  decidedAt: z.iso.datetime(),
});
export type InterruptionDecision = z.infer<typeof interruptionDecisionSchema>;

/** `CLEARED`: the ambiguity went away (another path settled it) before the owner
 * answered this card; it is history, like `RESOLVED`. */
export const clarificationCardStatusSchema = z.enum(['OPEN', 'ASKED', 'DEFERRED', 'SUPPRESSED', 'RESOLVED', 'CLEARED']);

export const cardAnswerSchema = z.strictObject({
  choiceId: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  effect: cardEffectSchema,
  answeredBy: z.enum(['OWNER', 'LEARNED_RULE']),
  learnedApprovalRuleId: z.uuid().nullable(),
  evidenceId: z.uuid(),
  overlayDeltaIds: z.array(z.uuid()).max(32),
  memoryOperationIds: z.array(z.uuid()).max(32),
  proposedTransactionId: z.uuid().nullable(),
});
export type CardAnswer = z.infer<typeof cardAnswerSchema>;

export const clarificationCardSchema = z.strictObject({
  clarificationCardId: z.uuid(),
  situationKey: situationKeySchema,
  situationKind: situationKindSchema,
  title: z.string().min(1).max(200),
  facts: z.array(z.string().min(1).max(500)).max(16),
  whyItMatters: z.string().min(1).max(1000),
  choices: z.array(cardChoiceSchema).min(2).max(8),
  groupedAmbiguityIds: z.array(z.uuid()).min(1).max(64),
  ambiguities: z.array(ambiguitySchema).min(1).max(64),
  sensitivityScope: sensitivityScopeSchema,
  status: clarificationCardStatusSchema,
  askedAt: z.iso.datetime().nullable(),
  answeredAt: z.iso.datetime().nullable(),
  suppressedUntil: z.iso.datetime().nullable(),
  reopenedByEvidenceId: z.uuid().nullable(),
  appliedRuleId: z.uuid().nullable(),
  answer: cardAnswerSchema.nullable(),
  /** The most recent decision logged for the card, when one exists. */
  interruption: z.strictObject({
    decision: interruptionDecisionKindSchema,
    reason: interruptionReasonSchema,
    policyInputs: interruptionPolicyInputsSchema,
    decidedAt: z.iso.datetime(),
  }).nullable(),
});
export type ClarificationCard = z.infer<typeof clarificationCardSchema>;

/** Design GET /v1/memory/inbox. Cards beyond the budget are deferred to batch
 * review rather than shown, so a deferred card is counted and never rendered. */
export const memoryInboxViewSchema = z.strictObject({
  ownerLocalDate: localDate,
  timeZone: z.string().min(1).max(64),
  budget: attentionBudgetSchema,
  remainingToday: z.number().int().min(0),
  remainingByScope: z.array(z.strictObject({ sensitivityScope: sensitivityScopeSchema, remaining: z.number().int().min(0) })).max(18),
  cards: z.array(clarificationCardSchema).max(50),
  deferredCount: z.number().int().min(0),
  withheld: z.array(clarificationCardSchema).max(200),
  resolvedToday: z.array(clarificationCardSchema).max(200),
  contextPacketId: z.uuid().nullable(),
  readAt: z.iso.datetime(),
});
export type MemoryInboxView = z.infer<typeof memoryInboxViewSchema>;

export const cardDecisionInputSchema = z.strictObject({
  choiceId: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  rawText: z.string().trim().min(1).max(2000).optional(),
});
export type CardDecisionInput = z.infer<typeof cardDecisionInputSchema>;

// ---------------------------------------------------------------------------
// Learned approval rules (PRD §19.5)
// ---------------------------------------------------------------------------

export const learnedRuleStatusSchema = z.enum(['PROPOSED', 'APPROVED', 'REVOKED']);
export const learnedRuleScopeSchema = z.strictObject({
  situationKind: situationKindSchema,
  /** The exact text the rule matches on (a transfer memo). Never a pattern. */
  matchText: z.string().min(1).max(200),
  choiceId: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  effect: cardEffectSchema,
  sensitivityScope: sensitivityScopeSchema,
});
export type LearnedRuleScope = z.infer<typeof learnedRuleScopeSchema>;

export const learnedApprovalRuleSchema = z.strictObject({
  learnedApprovalRuleId: z.uuid(),
  ruleText: z.string().min(1).max(500),
  scope: learnedRuleScopeSchema,
  status: learnedRuleStatusSchema,
  /** Whether the rule changes anything today: only an approved rule does. */
  inEffect: z.boolean(),
  proposedFromCardIds: z.array(z.uuid()).min(2).max(64),
  proposedAt: z.iso.datetime(),
  approvedByUserId: z.uuid().nullable(),
  approvedAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
  history: z.array(z.strictObject({
    event: z.enum(['PROPOSED', 'APPROVED', 'APPLIED', 'REVOKED']),
    at: z.iso.datetime(),
    clarificationCardId: z.uuid().nullable(),
  })).max(500),
});
export type LearnedApprovalRule = z.infer<typeof learnedApprovalRuleSchema>;

export const learnedApprovalRulesViewSchema = z.strictObject({
  rules: z.array(learnedApprovalRuleSchema).max(200),
  readAt: z.iso.datetime(),
});
export type LearnedApprovalRulesView = z.infer<typeof learnedApprovalRulesViewSchema>;

/** Design POST /v1/memory/inbox/cards/{id}/decide: the answer's evidence, overlay
 * deltas and proposed transaction, the interruption decision that put the card in
 * front of the owner, and any rule the answer led Uai to propose. */
export const cardDecisionResultSchema = z.strictObject({
  card: clarificationCardSchema,
  answer: cardAnswerSchema,
  interruptionDecision: interruptionDecisionSchema.nullable(),
  proposedRule: learnedApprovalRuleSchema.nullable(),
});
export type CardDecisionResult = z.infer<typeof cardDecisionResultSchema>;

// ---------------------------------------------------------------------------
// The weekly review and behavioral observations (PRD §39)
// ---------------------------------------------------------------------------

/** What a statement rests on: an object of the persisted packet's manifest. */
export const reviewGroundSchema = z.strictObject({
  objectType: z.enum(['proposition', 'claim', 'source_item', 'owner_overlay_delta', 'frame_instance', 'resolution_assertion']),
  objectId: z.uuid(),
});
export type ReviewGround = z.infer<typeof reviewGroundSchema>;

export const reviewStatementSchema = z.strictObject({
  statementId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  text: z.string().min(1).max(600),
  label: certaintyLabelSchema,
  lifeCategory: lifeCategorySchema.nullable(),
  grounds: z.array(reviewGroundSchema).min(1).max(64),
});
export type ReviewStatement = z.infer<typeof reviewStatementSchema>;

export const reviewAvailabilitySchema = z.enum(['AVAILABLE', 'NO_MATCHING_MEMORY', 'NOT_AVAILABLE_IN_THIS_RELEASE']);

export const reviewSectionSchema = z.strictObject({
  availability: reviewAvailabilitySchema,
  /** Why a section has nothing to say, in words. Never a personal claim. */
  note: z.string().max(300).nullable(),
  statements: z.array(reviewStatementSchema).max(100),
});
export type ReviewSection = z.infer<typeof reviewSectionSchema>;

export const calendarAllocationSchema = z.strictObject({
  lifeCategory: lifeCategorySchema,
  scheduledMinutes: z.number().int().min(0),
  eventCount: z.number().int().min(0),
  highPriorityCommitments: z.number().int().min(0),
  statedPriorityCommitments: z.number().int().min(0),
});

export const postponementEpisodeSchema = z.strictObject({
  /** The proposition carrying the later due time: the restatement is the episode. */
  episodeId: z.uuid(),
  frameInstanceId: z.uuid(),
  previousPropositionId: z.uuid(),
  previousDueAt: z.iso.datetime(),
  newDueAt: z.iso.datetime(),
  restatedAt: z.iso.datetime(),
});
export type PostponementEpisode = z.infer<typeof postponementEpisodeSchema>;

export const behavioralObservationSchema = z.strictObject({
  behavioralObservationId: z.uuid(),
  patternKind: z.literal('REPEATED_POSTPONEMENT'),
  statement: z.string().min(1).max(1000),
  supportingEpisodeIds: z.array(z.uuid()).min(2).max(200),
  supportingEpisodes: z.array(postponementEpisodeSchema).min(2).max(200),
  counterexampleSearch: z.strictObject({
    searched: z.string().min(1).max(300),
    counterexamplesFound: z.number().int().min(0),
    counterexampleIds: z.array(z.uuid()).max(200),
  }),
  observationWindow: z.strictObject({ from: z.iso.datetime(), to: z.iso.datetime() }),
  confidence: z.number().min(0).max(1),
  reviewOrExpiryDate: localDate,
  grounds: z.array(reviewGroundSchema).min(2).max(200),
});
export type BehavioralObservation = z.infer<typeof behavioralObservationSchema>;

/** The objects a persisted packet supplied, as the review checks grounds against
 * them: the answer manifest's four sets plus the packet's frames and outcomes. */
export const reviewManifestSchema = z.strictObject({
  packetId: z.uuid(),
  packetHash: z.string().regex(/^[a-f0-9]{64}$/),
  beliefIds: z.array(z.uuid()),
  claimIds: z.array(z.uuid()),
  evidenceIds: z.array(z.uuid()),
  overlayDeltaIds: z.array(z.uuid()),
  frameInstanceIds: z.array(z.uuid()),
  resolutionAssertionIds: z.array(z.uuid()),
});
export type ReviewManifest = z.infer<typeof reviewManifestSchema>;

export const weeklyReviewSchema = z.strictObject({
  weeklyReviewId: z.uuid(),
  weekStart: localDate,
  weekEnd: localDate,
  timeZone: z.string().min(1).max(64),
  priorityVersusCalendar: reviewSectionSchema.extend({ allocation: z.array(calendarAllocationSchema).max(6) }),
  commitmentsVersusResolutions: reviewSectionSchema.extend({
    openCount: z.number().int().min(0), slippingCount: z.number().int().min(0), completedCount: z.number().int().min(0),
  }),
  decisionsVersusOutcomes: reviewSectionSchema,
  plannedVersusObservedSpending: reviewSectionSchema,
  materialChanges: reviewSectionSchema,
  repeatedPostponement: reviewSectionSchema.extend({ episodeCount: z.number().int().min(0) }),
  behavioralObservations: z.array(behavioralObservationSchema).max(2),
  contextPacketId: z.uuid(),
  packetHash: z.string().regex(/^[a-f0-9]{64}$/),
  manifest: reviewManifestSchema,
  statementCount: z.number().int().min(0),
  reviewVersion: version,
  createdAt: z.iso.datetime(),
});
export type WeeklyReview = z.infer<typeof weeklyReviewSchema>;

export const weeklyReviewRequestSchema = z.strictObject({
  weekStart: localDate,
  timeZone: z.string().min(1).max(64).default('UTC'),
});
