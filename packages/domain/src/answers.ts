import { z } from 'zod';
import { sensitivitySchema } from './evidence.js';
import { certaintyLabelSchema } from './labels.js';

/** Answer provenance and grounding (PRD §23.6, §23.7, §24.6; design entities
 * `answer_manifests` and `reconsideration_candidates`; ADR 0026).
 *
 * Schemas only. `@unai/context` validates candidates and derives manifests; the
 * API records them. Nothing here names a model provider: the model a manifest was
 * supplied to is recorded as opaque configuration strings.
 */

const reasonCode = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);
const version = z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/);
const objectType = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);

// ---------------------------------------------------------------------------
// The grounding validator (PRD §24.6; CRT-RD-08-A)
// ---------------------------------------------------------------------------

/** The five checks the validator runs over every candidate statement. */
export const GROUNDING_RULES = Object.freeze([
  'UNGROUNDED_PERSONAL_FACT', 'SCHEDULED_WORDED_AS_OCCURRED', 'CONTESTED_WORDED_AS_CERTAIN',
  'INFERENCE_PRESENTED_AS_EVIDENCE', 'SENSITIVITY_SCOPE_LEAK', 'STALE_WORDED_AS_CURRENT',
] as const);
export const groundingRuleSchema = z.enum(GROUNDING_RULES);
export type GroundingRule = z.infer<typeof groundingRuleSchema>;

/** What one violation requires of the answer. The strongest across a candidate
 * wins: BLOCK over REGENERATE over DOWNGRADE. */
export const groundingViolationActionSchema = z.enum(['DOWNGRADE', 'REGENERATE', 'BLOCK']);
/** What happened to the answer as a whole. */
export const groundingActionSchema = z.enum(['PASSED', 'DOWNGRADED', 'REGENERATED', 'BLOCKED']);
export type GroundingAction = z.infer<typeof groundingActionSchema>;
export const candidateSourceSchema = z.enum(['MODEL', 'DETERMINISTIC_COMPOSER']);

export const groundingViolationSchema = z.strictObject({
  statementId: z.string().regex(/^S[0-9]{1,4}$/),
  rule: groundingRuleSchema,
  action: groundingViolationActionSchema,
  detail: reasonCode,
  /** The packet (or withheld) object ids the violation is about. */
  objectIds: z.array(z.uuid()).max(64),
});
export type GroundingViolation = z.infer<typeof groundingViolationSchema>;

export const groundingAttemptSchema = z.strictObject({
  attempt: z.number().int().min(1).max(8),
  candidateSource: candidateSourceSchema,
  outcome: groundingActionSchema,
  violations: z.array(groundingViolationSchema).max(200),
});

export const groundingResultSchema = z.strictObject({
  validatorVersion: version,
  action: groundingActionSchema,
  /** Where the presented statements came from after validation. */
  finalSource: candidateSourceSchema,
  attempts: z.array(groundingAttemptSchema).min(1).max(8),
  /** Every violation of every attempt, in order. */
  violations: z.array(groundingViolationSchema).max(400),
});
export type GroundingResult = z.infer<typeof groundingResultSchema>;

/**
 * One statement of a candidate answer, as a phrasing model must return it and as
 * the deterministic composer produces it: the words, the §24.5 label, the packet
 * objects it rests on, the evidence it cites and the sensitivity scope it draws
 * from. The validator checks each of these against the packet.
 */
export const answerCandidateStatementSchema = z.strictObject({
  text: z.string().min(1).max(2000),
  label: certaintyLabelSchema,
  objectRefs: z.array(z.strictObject({ objectType, objectId: z.uuid() })).max(64).default([]),
  sourceEvidenceIds: z.array(z.uuid()).max(64).default([]),
  sensitivityScope: sensitivitySchema.nullable().default(null),
});
export type AnswerCandidateStatement = z.infer<typeof answerCandidateStatementSchema>;

/** The whole output contract of an answer-phrasing model call. */
export const answerCandidateSchema = z.strictObject({
  statements: z.array(answerCandidateStatementSchema).min(1).max(50),
});
export type AnswerCandidate = z.infer<typeof answerCandidateSchema>;

// ---------------------------------------------------------------------------
// The answer manifest (PRD §23.6; CRT-RD-06-A, CRT-RD-07-A)
// ---------------------------------------------------------------------------

/** The one sentence every manifest carries, and the Answer provenance screen shows
 * (PRD §23.6, FR-066). */
export const SUPPLIED_CONTEXT_STATEMENT =
  'This records the context supplied to the model for this answer. It does not record which of these items the model used.';

/** The context one packet supplied, as sets. Every list is sorted and holds each id
 * once; nothing in it ranks, weights or selects an item. */
export const suppliedContextSchema = z.strictObject({
  packetId: z.uuid(),
  packetHash: z.string().regex(/^[a-f0-9]{64}$/),
  beliefIds: z.array(z.uuid()).max(2000),
  claimIds: z.array(z.uuid()).max(5000),
  evidenceIds: z.array(z.uuid()).max(2000),
  overlayDeltaIds: z.array(z.uuid()).max(1000),
  projectionVersions: z.record(z.string().min(1).max(64), z.uuid().nullable()),
  watermarks: z.record(z.string(), z.unknown()),
  registryRelease: z.string().max(32).nullable(),
  registryReleaseId: z.uuid().nullable(),
});
export type SuppliedContext = z.infer<typeof suppliedContextSchema>;

export const reconsiderationChangeSchema = z.strictObject({
  changedObjectType: z.enum(['belief', 'owner_overlay_delta']),
  changedObjectId: z.uuid(),
  changeKind: z.enum(['BELIEF_ASSESSMENT_CHANGED', 'CLAIM_CORRECTED', 'CLAIM_SUPERSEDED', 'CLAIM_RETRACTED',
    'CLAIM_CONTRADICTED', 'OVERLAY_DELTA_LIFECYCLE_CHANGED']),
  detectedAt: z.iso.datetime(),
});
export type ReconsiderationChange = z.infer<typeof reconsiderationChangeSchema>;

/** GET /v1/answers/{id}/manifest. Every field describes context supplied to a
 * model; none says which item the model used (CRT-RD-07-A). */
export const publicAnswerManifestSchema = z.strictObject({
  answerManifestId: z.uuid(),
  recordKind: z.literal('CONTEXT_SUPPLIED_TO_MODEL'),
  recordStatement: z.literal(SUPPLIED_CONTEXT_STATEMENT),
  question: z.string().max(2000).nullable(),
  contextSupplied: suppliedContextSchema,
  suppliedTo: z.strictObject({
    modelProvider: version,
    modelId: z.string().min(1).max(128),
    promptVersion: version,
    composerVersion: version,
  }),
  /** The assistant conversation evidence the presented answer is stored as. */
  conversationMessageId: z.uuid(),
  groundingValidator: groundingResultSchema,
  reconsideration: z.strictObject({
    isCandidate: z.boolean(),
    changes: z.array(reconsiderationChangeSchema).max(500),
  }),
  manifestVersion: version,
  createdAt: z.iso.datetime(),
});
export type PublicAnswerManifest = z.infer<typeof publicAnswerManifestSchema>;

/** GET /v1/answers/reconsideration-candidates (PRD §23.7; CRT-RD-11-A). */
export const reconsiderationCandidatesViewSchema = z.strictObject({
  changedObject: z.strictObject({ objectType: z.enum(['belief', 'owner_overlay_delta']), objectId: z.uuid() }),
  candidates: z.array(z.strictObject({
    answerManifestId: z.uuid(),
    contextPacketId: z.uuid(),
    conversationMessageId: z.uuid(),
    answeredAt: z.iso.datetime(),
    changes: z.array(reconsiderationChangeSchema).min(1).max(100),
  })).max(500),
  /** V0 marks earlier answers and rewrites none of them. */
  previousAnswersPreserved: z.literal(true),
  readAt: z.iso.datetime(),
});
export type ReconsiderationCandidatesView = z.infer<typeof reconsiderationCandidatesViewSchema>;

/** The failure record a contested overlay delta carries (PRD §21.7; CRT-RYW-05-A). */
export const deltaContestRecordSchema = z.strictObject({
  failureReason: reasonCode,
  conflictingEvidenceIds: z.array(z.uuid()).min(1).max(64),
  affectedProjections: z.array(z.string().min(1).max(64)).max(16),
  containingManifestIds: z.array(z.uuid()).max(1000),
  userAttentionRequired: z.boolean(),
});
export type DeltaContestRecord = z.infer<typeof deltaContestRecordSchema>;
