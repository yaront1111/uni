import { z } from 'zod';
import { dataPurposeSchema, sensitivitySchema } from './evidence.js';
import { assessmentStatusSchema, supportKindSchema, independenceGroupSchema } from './governance.js';
import { claimOriginSchema, claimLifecycleSchema, modalitySchema, polaritySchema } from './memory.js';
import { memoryLinkKindSchema, outcomeCodeSchema } from './outcomes.js';
import { publicOverlayDeltaSchema } from './overlay.js';
import { pendingAssertionSchema, projectionNameSchema } from './projections.js';
import { contextSelectionSchema, semanticSearchSchema } from './selection.js';

/** The Context Broker's vocabularies and record shapes (PRD §21.4, §23, §33.11,
 * §33.14, §35.7, §35.8).
 *
 * Schemas only, as every file in this package: nothing here opens a transaction,
 * authorizes a purpose or assembles a packet. The closed enums are the contract
 * migration 0017's CHECK lists and `@unai/context` both hold to.
 */

const registryId = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
const reasonCode = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);
const version = z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/);

/** PRD §23.3: the query modes the planner must support. The broker classifies
 * every request into exactly one of them and records it on the packet, so an
 * answer can be read back against the question it was actually planned for. */
export const answerTypeSchema = z.enum(['CURRENT_VALUE', 'CORRECTED_HISTORICAL_VALUE', 'HISTORICAL_BELIEF_STATE',
  'EPISODE_RECALL', 'OPEN_COMMITMENTS', 'FUTURE_PLANS', 'PREDICTION_VERSUS_OUTCOME', 'AGGREGATION',
  'CAUSAL_EXPLANATION', 'CONTRADICTION_DETECTION', 'PATTERN_REVIEW', 'SOURCE_LOOKUP', 'DECISION_RECONSTRUCTION']);
export type AnswerType = z.infer<typeof answerTypeSchema>;

/** PRD §23.1. `NOW` and `LATEST` are the two intents that are *not* instants: a
 * caller asking about now must be able to say so rather than pin a clock reading
 * the broker would then have to trust. */
export const worldTimeSchema = z.union([z.literal('NOW'), z.iso.datetime({ offset: true })]);
export const knowledgeTimeSchema = z.union([z.literal('LATEST'), z.iso.datetime({ offset: true })]);
export const certaintySchema = z.enum(['ACCEPTED', 'PROVISIONAL', 'CONTESTED', 'OWNER_OVERLAY']);
export const actionRiskSchema = z.enum(['LOW', 'MEDIUM', 'HIGH']);

/** The action kinds `EvaluateMemoryAction` knows (PRD §27, §29.3). V0 refuses
 * every one of them but a draft; they are all nameable so a refusal says which
 * action was refused rather than that "an action" was. */
export const contextActionKindSchema = z.enum(['DRAFT', 'EMAIL_SEND', 'CALENDAR_WRITE', 'MONEY_MOVEMENT', 'TRADE']);
export type ContextActionKind = z.infer<typeof contextActionKindSchema>;

/**
 * An action a caller intends to found on the packet it is asking for.
 *
 * The Context Broker is the only memory read path a model or a plugin has
 * (FR-060), so it is where an action founded on memory is gated: a declared
 * intent is evaluated by `EvaluateMemoryAction` against the purposes the evidence
 * behind that memory admits, and a purpose the evidence never admitted is denied
 * before a packet exists (CRT-SEC-02-A). Declaring nothing asks for context and
 * no action, which is the default.
 */
export const intendedActionSchema = z.strictObject({
  actionKind: contextActionKindSchema,
  /** The data purpose the *action* declares, which need not be the read's. */
  actionPurpose: dataPurposeSchema,
  capabilityGranted: z.boolean().default(false),
});
export type IntendedAction = z.infer<typeof intendedActionSchema>;

/**
 * A life category is a *view*, never a stored label (PRD §3, §11: "One event may
 * be relevant to finance, family, work, a relationship, a goal, and a decision at
 * the same time. It is stored once and exposed through many views"; and "the
 * kernel uses universal structural and epistemic objects. These are not
 * user-facing life categories").
 *
 * So no table here carries a category column and nothing writes one. A category
 * is derived on read from two things the owner already declared once: the data
 * purposes the evidence admits, and the registry namespace of the frame the
 * object belongs to (CRT-MEM-02-A).
 */
export const lifeCategorySchema = z.enum(['FINANCE', 'FAMILY', 'WORK', 'HEALTH', 'ADMIN', 'PERSONAL']);
export type LifeCategory = z.infer<typeof lifeCategorySchema>;

/** The fields PRD §23.1 requires of every context request. A request missing one
 * of them is refused *before* retrieval, which is why they carry no default:
 * a default would answer a question the caller never asked (CRT-RD-02-A). */
export const REQUIRED_CONTEXT_FIELDS = Object.freeze([
  'purpose', 'requestingActorId', 'ownerScopeId', 'worldTime', 'knowledgeTime', 'maximumSensitivity', 'actionRisk',
] as const);
export type RequiredContextField = (typeof REQUIRED_CONTEXT_FIELDS)[number];

export const contextRequestSchema = z.strictObject({
  ownerScopeId: z.uuid(),
  requestingActorId: z.uuid(),
  purpose: dataPurposeSchema,
  query: z.string().trim().min(1).max(2000),
  /** PRD §21.4: the four intersection paths an unattached delta is found through,
   * each usable on its own (CRT-RYW-03-A). */
  entityHints: z.array(z.uuid()).max(64).default([]),
  worldlineHints: z.array(z.uuid()).max(64).default([]),
  discourseAnchors: z.array(z.string().min(1).max(512)).max(32).default([]),
  frameTypeHints: z.array(registryId).max(32).default([]),
  lifeCategory: lifeCategorySchema.nullable().default(null),
  worldTime: worldTimeSchema,
  knowledgeTime: knowledgeTimeSchema,
  requiredCertainty: z.array(certaintySchema).min(1).max(4).default(['ACCEPTED', 'CONTESTED', 'OWNER_OVERLAY']),
  maximumSensitivity: sensitivitySchema,
  actionRisk: actionRiskSchema,
  /** Optional, and refused when it is declared and the evidence does not admit
   * its purpose (CRT-SEC-02-A). It is *not* in `REQUIRED_CONTEXT_FIELDS`: a read
   * that intends no action declares none, and `actionRisk` -- which every request
   * must declare -- still bounds what the packet may be used for. */
  intendedAction: intendedActionSchema.nullable().default(null),
  tokenBudget: z.number().int().min(256).max(200_000).default(5000),
  includeEvidence: z.enum(['NEVER', 'WHEN_NEEDED', 'ALWAYS']).default('WHEN_NEEDED'),
  /** The query mode a caller already classified the question into (the Ask
   * pipeline does). Null leaves the broker to classify the query text itself. */
  answerType: answerTypeSchema.nullable().default(null),
  /** Hard filters for the semantic step (PRD §23.2 step 10). Owner, permission
   * and sensitivity come from the declarations above and are never optional; a
   * time window and source types narrow further, and the entity filter is the
   * request's entity hints. */
  timeWindow: z.strictObject({
    from: z.iso.datetime({ offset: true }).nullable().default(null),
    to: z.iso.datetime({ offset: true }).nullable().default(null),
  }).nullable().default(null),
  sourceTypes: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/)).max(32).default([]),
});
export type ContextRequest = z.infer<typeof contextRequestSchema>;

/** One retrieved belief, with everything a reader needs to say how sure it is and
 * where it came from. `selectionReason` is the deterministic selector's answer to
 * "why this value and not another" (PRD §23.4 step 8). */
export const contextBeliefSchema = z.strictObject({
  propositionId: z.uuid(),
  beliefSlotId: z.uuid(),
  frameInstanceId: z.uuid(),
  frameTypeId: registryId,
  predicateId: registryId,
  modality: modalitySchema,
  polarity: polaritySchema,
  // The seven fields a read policy may withhold. They are optional *only* because
  // a REDACT verdict removes them from the packet and lists them in `redactions`
  // (CRT-WRT-03-B); the identifying fields above stay required, so a redaction can
  // never hide that the object was supplied at all.
  normalizedValue: z.unknown().optional(),
  assessmentStatus: assessmentStatusSchema.nullable().optional(),
  assessmentRecordedAt: z.iso.datetime().nullable().optional(),
  validFrom: z.iso.datetime().nullable().optional(),
  validTo: z.iso.datetime().nullable().optional(),
  certainty: certaintySchema,
  lifeCategories: z.array(lifeCategorySchema),
  claimIds: z.array(z.uuid()).max(256).optional(),
  evidenceIds: z.array(z.uuid()).max(256).optional(),
  selectionReason: reasonCode,
});

/** The fields a field-level redaction may remove from a belief. A verdict naming
 * anything else is honoured as an object-level redaction instead: the broker
 * never half-supplies an object it cannot describe. */
export const REDACTABLE_BELIEF_FIELDS: readonly string[] = Object.freeze([
  'normalizedValue', 'assessmentStatus', 'assessmentRecordedAt', 'validFrom', 'validTo', 'claimIds', 'evidenceIds',
]);
export type ContextBelief = z.infer<typeof contextBeliefSchema>;

/** A claim about a time that has not happened yet: the SCHEDULED, INTENDED,
 * COMMITTED, EXPECTED and PREDICTED side of the same slot structure. */
export const contextFutureClaimSchema = z.strictObject({
  propositionId: z.uuid(),
  frameInstanceId: z.uuid(),
  frameTypeId: registryId,
  predicateId: registryId,
  modality: modalitySchema,
  // Optional for the same reason as on a belief: a REDACT verdict removes the
  // field from every place the packet would otherwise carry it (CRT-WRT-03-B).
  normalizedValue: z.unknown().optional(),
  validFrom: z.iso.datetime().nullable().optional(),
  lifeCategories: z.array(lifeCategorySchema),
  /** The evidence the claim rests on, so an answer about a plan or a prediction
   * can link its source. Redactable like a belief's. */
  evidenceIds: z.array(z.uuid()).max(256).optional(),
});

/** Two values in one slot, both retained (PRD §16.5, CRT-MEM-08-A). The broker
 * reports the conflict; it never picks a winner.
 *
 * A position is another place the packet would state a value, so the redactable
 * fields are optional here too: a REDACT verdict over a proposition has to remove
 * its value from the conflict as well, or the redaction would only have moved it
 * (CRT-WRT-03-B). The proposition id stays required, so a redacted position still
 * counts as a side of the disagreement. */
export const contextConflictSchema = z.strictObject({
  beliefSlotId: z.uuid(),
  frameInstanceId: z.uuid(),
  predicateId: registryId,
  reason: reasonCode,
  positions: z.array(z.strictObject({
    propositionId: z.uuid(),
    normalizedValue: z.unknown().optional(),
    assessmentStatus: assessmentStatusSchema.nullable().optional(),
    claimOrigins: z.array(claimOriginSchema).max(16),
    evidenceIds: z.array(z.uuid()).max(64).optional(),
  })).min(2).max(32),
});

/** What the broker could not answer, named rather than omitted. An answer that
 * cannot distinguish "no" from "not known" is the failure PRD §16.6 forbids. */
export const contextUnknownSchema = z.strictObject({
  kind: z.enum(['NO_ACCEPTED_VALUE', 'ENTITY_UNRESOLVED', 'UNATTACHED_OWNER_ASSERTION',
    'PROJECTION_INCOMPLETE', 'EVIDENCE_WITHHELD', 'NO_MATCHING_MEMORY']),
  objectType: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  objectId: z.string().min(1).max(512).nullable(),
  detail: reasonCode,
});

/** An object, or named fields of one, that the read policy withheld. A redaction
 * is a statement that something exists and was not supplied; it carries no value
 * (CRT-SEC-09-A, CRT-WRT-03-B). */
export const contextRedactionSchema = z.strictObject({
  objectType: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  objectId: z.string().min(1).max(512),
  fields: z.array(z.string().min(1).max(64)).max(64),
  reason: reasonCode,
});
export type ContextRedaction = z.infer<typeof contextRedactionSchema>;

/** A typed projection fragment and, with it, whether it was the whole story
 * (PRD §21.6, §23.2 step 3; CRT-RD-05-A). */
export const contextProjectionFragmentSchema = z.strictObject({
  projectionName: projectionNameSchema,
  rowCount: z.number().int().min(0),
  frameInstanceIds: z.array(z.uuid()).max(500),
  isComplete: z.boolean(),
  projectionVersion: z.uuid().nullable(),
  reducerVersion: version,
  ownerOverlayWatermark: z.number().int().min(0),
  canonicalTransactionWatermark: z.iso.datetime(),
  pendingAssertions: z.array(pendingAssertionSchema).max(200),
  highRiskActionsBlocked: z.boolean(),
});

export const contextEvidenceRefSchema = z.strictObject({
  evidenceId: z.uuid(),
  sourceType: z.string().max(64),
  sensitivity: sensitivitySchema,
  occurredAt: z.iso.datetime().nullable(),
  anchorIds: z.array(z.uuid()).max(64),
  lifeCategories: z.array(lifeCategorySchema),
});

export const contextResolutionSchema = z.strictObject({
  resolutionAssertionId: z.uuid(),
  sourceFrameInstanceId: z.uuid(),
  targetFrameInstanceId: z.uuid().nullable(),
  outcomeCode: outcomeCodeSchema,
  effectiveAt: z.iso.datetime(),
  lifecycle: z.string().max(32),
  transitionContractId: z.string().max(128),
});

export const contextThreadRefSchema = z.strictObject({
  memoryThreadId: z.uuid(),
  displayTitle: z.string().max(200).nullable(),
  memberCount: z.number().int().min(0),
});

export const contextWatermarksSchema = z.strictObject({
  ownerOverlayWatermark: z.number().int().min(0),
  canonicalTransactionWatermark: z.iso.datetime(),
  projectionVersions: z.record(z.string().min(1).max(64), z.uuid().nullable()),
  registryRelease: z.string().max(32).nullable(),
  knowledgeTime: z.iso.datetime(),
  worldTime: z.iso.datetime(),
});

/** PRD §23.4 step 8: the selector returns the state *and the reason for it*, so
 * no reader has to guess how "latest" was decided. */
export const selectionReasonSchema = z.strictObject({
  answerType: answerTypeSchema,
  worldTimeFilter: z.iso.datetime(),
  knowledgeTimeFilter: z.iso.datetime(),
  requiredCertainty: z.array(certaintySchema),
  contextKind: z.string().max(32),
  appliedRules: z.array(reasonCode).max(32),
  overlayDeltasApplied: z.array(z.uuid()).max(200),
  selectorVersion: version,
  /** SHA-256 of the canonical JSON of the packet's `selections`: the same memory
   * and the same request give the same digest, run after run (CRT-RD-03-A). */
  selectionsDigest: z.string().regex(/^[a-f0-9]{64}$/),
});

/** The recorded `EvaluateMemoryAction` verdict over a declared intended action.
 *
 * `DENY` never appears here: a denied action produces no packet at all, only the
 * `policy_decisions` row and the refusal (CRT-SEC-02-A). What a packet can carry
 * is the action it permits, or the one it will permit only on confirmation. */
export const contextActionDecisionSchema = z.strictObject({
  actionKind: contextActionKindSchema,
  actionPurpose: dataPurposeSchema,
  outcome: z.enum(['ALLOW', 'REQUIRE_CONFIRMATION']),
  reason: reasonCode,
  policyVersion: version,
  policyDecisionId: z.uuid(),
  /** How many evidence items behind this packet the purpose was checked against. */
  evidenceConsidered: z.number().int().min(0),
});

/** PRD §23.5, with the request's own authority recorded beside the content. */
export const contextPacketSchema = z.strictObject({
  packetId: z.uuid(),
  packetHash: z.string().regex(/^[a-f0-9]{64}$/),
  ownerScopeId: z.uuid(),
  requestingActorId: z.uuid(),
  purpose: dataPurposeSchema,
  answerType: answerTypeSchema,
  lifeCategory: lifeCategorySchema.nullable(),
  registryRelease: z.string().max(32).nullable(),
  worldTime: z.iso.datetime(),
  knowledgeTime: z.iso.datetime(),
  currentBeliefs: z.array(contextBeliefSchema).max(500),
  historicalBeliefs: z.array(contextBeliefSchema).max(500),
  futureClaims: z.array(contextFutureClaimSchema).max(500),
  resolutionAssertions: z.array(contextResolutionSchema).max(500),
  conflicts: z.array(contextConflictSchema).max(200),
  unknowns: z.array(contextUnknownSchema).max(200),
  ownerOverlayDeltas: z.array(publicOverlayDeltaSchema).max(500),
  projectionFragments: z.array(contextProjectionFragmentSchema).max(16),
  evidenceRefs: z.array(contextEvidenceRefSchema).max(500),
  memoryThreads: z.array(contextThreadRefSchema).max(100),
  allowedActions: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/)).max(32),
  /** Null when the request declared no intended action. */
  actionDecision: contextActionDecisionSchema.nullable(),
  redactions: z.array(contextRedactionSchema).max(500),
  watermarks: contextWatermarksSchema,
  /** The deterministic selector's state per slot, with the reason (PRD §23.4). */
  selections: z.array(contextSelectionSchema).max(500),
  /** The semantic step, run only after the hard filters (PRD §23.2 step 10).
   * Null when the query carries nothing an embedding can be made of. */
  semanticSearch: semanticSearchSchema.nullable(),
  selectionReason: selectionReasonSchema,
  policy: z.strictObject({
    outcome: z.enum(['ALLOW', 'REDACT']),
    reason: reasonCode,
    policyVersion: version,
    policyDecisionId: z.uuid(),
  }),
  brokerVersion: version,
  createdAt: z.iso.datetime(),
});
export type ContextPacket = z.infer<typeof contextPacketSchema>;

// ---------------------------------------------------------------------------
// GET /v1/memory/propositions/{id}/explain (PRD §35.8, CRT-RD-09-A)
// ---------------------------------------------------------------------------

export const explainClaimSchema = z.strictObject({
  claimId: z.uuid(),
  claimOrigin: claimOriginSchema,
  lifecycle: claimLifecycleSchema,
  assertedByEntityId: z.uuid().nullable(),
  extractionRunId: z.uuid().nullable(),
  recordedAt: z.iso.datetime(),
  validFrom: z.iso.datetime().nullable(),
  validTo: z.iso.datetime().nullable(),
});

export const explainEvidenceAnchorSchema = z.strictObject({
  sourceAnchorId: z.uuid(),
  evidenceId: z.uuid(),
  anchorKind: z.string().max(64),
  sourceType: z.string().max(64),
  sensitivity: sensitivitySchema,
  claimIds: z.array(z.uuid()).max(64),
  occurredAt: z.iso.datetime().nullable(),
});

export const explainSupportSchema = z.strictObject({
  supportId: z.uuid(),
  supportKind: supportKindSchema,
  claimId: z.uuid().nullable(),
  supportingPropositionId: z.uuid().nullable(),
  independenceGroup: independenceGroupSchema.nullable(),
});

export const explainContradictionSchema = z.strictObject({
  kind: z.enum(['COMPETING_PROPOSITION', 'CLAIM_RELATION', 'MEMORY_LINK', 'CONTESTED_OVERLAY_DELTA']),
  objectType: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  objectId: z.uuid(),
  relation: z.string().max(64),
  detail: reasonCode,
});

export const explainTemporalEntrySchema = z.strictObject({
  assessmentId: z.uuid().nullable(),
  assessmentStatus: assessmentStatusSchema,
  validFrom: z.iso.datetime().nullable(),
  validTo: z.iso.datetime().nullable(),
  recordedAt: z.iso.datetime(),
  supersededRecordedAt: z.iso.datetime().nullable(),
  transactionId: z.uuid().nullable(),
});

export const explainResolutionLinkSchema = z.strictObject({
  objectType: z.enum(['resolution_assertion', 'memory_link']),
  objectId: z.uuid(),
  linkKind: memoryLinkKindSchema.nullable(),
  outcomeCode: outcomeCodeSchema.nullable(),
  effectiveAt: z.iso.datetime().nullable(),
  lifecycle: z.string().max(32),
});

export const explainProjectionConsumerSchema = z.strictObject({
  projectionName: projectionNameSchema,
  frameInstanceId: z.uuid(),
  projectionVersion: z.uuid().nullable(),
  reducerVersion: version,
  isComplete: z.boolean(),
  /** The registry predicate contract that names this projection column, so the
   * consumer is the registry's statement and not a guess from a column name. */
  projectionContracts: z.array(z.string().max(128)).max(32),
});

export const beliefExplanationSchema = z.strictObject({
  propositionId: z.uuid(),
  beliefSlotId: z.uuid(),
  frameInstanceId: z.uuid(),
  frameTypeId: registryId,
  predicateId: registryId,
  modality: modalitySchema,
  polarity: polaritySchema,
  normalizedValue: z.unknown(),
  currentAssessment: z.strictObject({
    assessmentId: z.uuid().nullable(),
    assessmentStatus: assessmentStatusSchema.nullable(),
    recordedAt: z.iso.datetime().nullable(),
    policyVersion: version.nullable(),
    decisionReason: z.record(z.string(), z.unknown()).nullable(),
  }),
  claims: z.array(explainClaimSchema).max(500),
  evidenceAnchors: z.array(explainEvidenceAnchorSchema).max(500),
  supportGraph: z.array(explainSupportSchema).max(500),
  independenceGroups: z.array(z.strictObject({
    independenceGroup: independenceGroupSchema, supportCount: z.number().int().min(1),
  })).max(200),
  contradictions: z.array(explainContradictionSchema).max(200),
  temporalHistory: z.array(explainTemporalEntrySchema).max(500),
  resolutionLinks: z.array(explainResolutionLinkSchema).max(200),
  registryVersions: z.strictObject({
    registryReleaseId: z.uuid().nullable(),
    registryRelease: z.string().max(32).nullable(),
    normalizationVersion: version.nullable(),
    canonicalizationVersion: version,
  }),
  extractorVersions: z.array(z.strictObject({
    extractionRunId: z.uuid(),
    runKind: z.string().max(32),
    modelId: z.string().max(128).nullable(),
    promptVersion: z.string().max(128).nullable(),
    normalizationVersion: version,
    entityResolverVersion: version,
    temporalResolverVersion: version,
    registryReleaseId: z.uuid().nullable(),
  })).max(100),
  projectionConsumers: z.array(explainProjectionConsumerSchema).max(50),
  ownerOverlayDeltas: z.array(publicOverlayDeltaSchema).max(200),
  explanationVersion: version,
  readAt: z.iso.datetime(),
});
export type BeliefExplanation = z.infer<typeof beliefExplanationSchema>;

// ---------------------------------------------------------------------------
// Memory threads (PRD §33.11, §50; CRT-RD-10-A)
// ---------------------------------------------------------------------------

export const threadObjectTypeSchema = z.enum(['frame_instance', 'proposition', 'claim', 'entity', 'resolution_assertion']);
export const threadMembershipKindSchema = z.enum(['SUBJECT', 'PARTICIPANT', 'PLAN', 'EVENT', 'OUTCOME', 'RELATED']);
export const threadLifecycleSchema = z.enum(['ACTIVE', 'DORMANT', 'CLOSED', 'MERGED', 'RETIRED']);

export const threadMemberInputSchema = z.strictObject({
  objectType: threadObjectTypeSchema,
  objectId: z.uuid(),
  membershipKind: threadMembershipKindSchema,
  confidence: z.number().min(0).max(1).nullable().default(null),
  transactionId: z.uuid().nullable().default(null),
});
export type ThreadMemberInput = z.infer<typeof threadMemberInputSchema>;

export const threadMemberSchema = z.strictObject({
  memoryThreadId: z.uuid(),
  objectType: threadObjectTypeSchema,
  objectId: z.uuid(),
  membershipKind: threadMembershipKindSchema,
  confidence: z.number().min(0).max(1).nullable(),
  transactionId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  /** The evidence already behind the object. A membership adds none: this list is
   * read from the object's own claims (CRT-RD-10-A). */
  evidenceIds: z.array(z.uuid()).max(64),
});
export type ThreadMember = z.infer<typeof threadMemberSchema>;

/** The Memory thread screen's read (design GET /v1/memory/threads/{id}). */
export const memoryThreadViewSchema = z.strictObject({
  memoryThreadId: z.uuid(),
  displayTitle: z.string().max(200).nullable(),
  lifecycle: threadLifecycleSchema,
  createdAt: z.iso.datetime(),
  members: z.array(threadMemberSchema).max(500),
  currentProjection: z.array(contextProjectionFragmentSchema).max(16),
  timeline: z.array(z.strictObject({
    at: z.iso.datetime(),
    kind: z.enum(['EVIDENCE', 'CLAIM', 'PLAN', 'EVENT', 'RESOLUTION', 'OWNER_ASSERTION']),
    objectType: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    objectId: z.uuid(),
    detail: z.string().max(512).nullable(),
  })).max(500),
  plansAndExpectedOutcomes: z.array(contextFutureClaimSchema).max(200),
  actualEvents: z.array(contextBeliefSchema).max(200),
  resolutionLinks: z.array(contextResolutionSchema).max(200),
  openUncertainties: z.array(contextUnknownSchema).max(200),
  relatedPeople: z.array(z.strictObject({ entityId: z.uuid(), entityKind: z.string().max(32), canonicalLabel: z.string().max(200).nullable() })).max(200),
  relatedDocuments: z.array(z.strictObject({ entityId: z.uuid(), canonicalLabel: z.string().max(200).nullable() })).max(200),
  relatedDecisions: z.array(z.strictObject({ frameInstanceId: z.uuid(), frameTypeId: registryId })).max(200),
  evidenceIds: z.array(z.uuid()).max(500),
  threadVersion: version,
  readAt: z.iso.datetime(),
});
export type MemoryThreadView = z.infer<typeof memoryThreadViewSchema>;
