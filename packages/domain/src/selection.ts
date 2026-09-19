import { z } from 'zod';
import { assessmentStatusSchema } from './governance.js';
import { claimOriginSchema, modalitySchema } from './memory.js';

/** Deterministic selection and the semantic index (PRD §23.2 step 10, §23.4,
 * §33.13; FR-062, FR-063).
 *
 * Schemas only, as every file in this package. `@unai/context` produces these
 * shapes and `@unai/memory` produces the semantic match; nothing here selects,
 * embeds or ranks anything.
 */

const registryId = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
const reasonCode = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);
const version = z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/);

/** The rules of PRD §23.4, in the order the selector applies them, plus the read
 * policy that runs before them and the registry rule of PRD §17.5. */
export const SELECTION_RULES = Object.freeze([
  'APPLY_READ_POLICY', 'FILTER_VALID_TIME', 'FILTER_KNOWLEDGE_TIME', 'APPLY_CONTEXT_AND_MODALITY',
  'REQUIRE_REGISTERED_CONTRACT', 'APPLY_BELIEF_LIFECYCLE', 'APPLY_CORRECTION_AND_SUPERSESSION',
  'INCLUDE_UNRESOLVED_CONFLICTS', 'INCLUDE_APPLICABLE_OVERLAY_DELTAS',
] as const);
export const selectionRuleSchema = z.enum(SELECTION_RULES);
export type SelectionRule = z.infer<typeof selectionRuleSchema>;

/**
 * What the selector concluded about one belief slot.
 *
 * `SELECTED` names one proposition. `CONTESTED` names none: two values stand and
 * the broker never picks between them. `NO_CURRENT_VALUE` means nothing survived.
 * `EXCLUDED` means the slot itself is outside the request (another context, a
 * modality the question is not about, an unregistered contract). `WITHHELD`
 * means part of the slot is above the request's authority, so no selection is
 * made over the part that is not.
 */
export const selectionOutcomeSchema = z.enum(['SELECTED', 'CONTESTED', 'NO_CURRENT_VALUE', 'EXCLUDED', 'WITHHELD']);
export type SelectionOutcome = z.infer<typeof selectionOutcomeSchema>;

export const selectionStepSchema = z.strictObject({
  rule: selectionRuleSchema,
  kept: z.array(z.uuid()).max(256),
  excluded: z.array(z.strictObject({ objectId: z.uuid(), reason: reasonCode })).max(256),
});
export type SelectionStep = z.infer<typeof selectionStepSchema>;

/** One slot's selected state and the reason for it (PRD §23.4 step 8). Every list
 * is sorted and every instant is the request's, so the same memory and the same
 * request produce the same bytes (CRT-RD-03-A). */
export const contextSelectionSchema = z.strictObject({
  beliefSlotId: z.uuid(),
  frameInstanceId: z.uuid(),
  frameTypeId: registryId,
  predicateId: registryId,
  modality: modalitySchema,
  contextKind: z.enum(['BASE', 'QUOTED', 'TEST']),
  predicateRegistered: z.boolean(),
  outcome: selectionOutcomeSchema,
  reason: reasonCode,
  selectedPropositionId: z.uuid().nullable(),
  // `selectedValue`, `assessmentStatus`, `validFrom`, `validTo` and `evidenceIds`
  // are optional for the reason a belief's are: a REDACT verdict naming the field
  // removes it here too, or the selection would state what the belief was not
  // allowed to (CRT-WRT-03-B).
  selectedValue: z.unknown().optional(),
  certainty: z.enum(['ACCEPTED', 'PROVISIONAL']).nullable(),
  assessmentId: z.uuid().nullable(),
  assessmentStatus: assessmentStatusSchema.nullable().optional(),
  validFrom: z.iso.datetime().nullable().optional(),
  validTo: z.iso.datetime().nullable().optional(),
  competingPropositionIds: z.array(z.uuid()).max(64),
  claimOrigins: z.array(claimOriginSchema).max(16),
  evidenceIds: z.array(z.uuid()).max(256).optional(),
  appliedRelations: z.array(z.strictObject({
    relationKind: z.enum(['CORRECTS', 'SUPERSEDES', 'RETRACTS']),
    fromPropositionId: z.uuid().nullable(),
    toPropositionId: z.uuid(),
  })).max(64),
  overlayDeltaIds: z.array(z.uuid()).max(64),
  ownerAssertionPending: z.boolean(),
  steps: z.array(selectionStepSchema).max(16),
});
export type ContextSelection = z.infer<typeof contextSelectionSchema>;

/** The six hard filters of PRD §23.2 step 10, as they were applied to one search.
 * `null` means the request did not narrow on that axis; owner, permission and
 * sensitivity are never null, because a search without them is not allowed to
 * run at all. */
export const semanticFiltersSchema = z.strictObject({
  ownerScopeId: z.uuid(),
  dataPurpose: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
  maximumSensitivity: z.enum(['NORMAL', 'PRIVATE', 'RESTRICTED']),
  knowledgeTime: z.iso.datetime(),
  timeWindow: z.strictObject({ from: z.iso.datetime().nullable(), to: z.iso.datetime().nullable() }).nullable(),
  entityIds: z.array(z.uuid()).max(64).nullable(),
  sourceTypes: z.array(z.string().min(1).max(64)).max(32).nullable(),
  sourceItemIds: z.array(z.uuid()).max(256).nullable(),
});
export type SemanticFilters = z.infer<typeof semanticFiltersSchema>;

/** One nearest match that survived every hard filter. `authority` says what the
 * match may be used for: an index hit is a pointer to evidence, and one under an
 * unregistered predicate is never an authoritative value (PRD §17.5). */
export const semanticMatchSchema = z.strictObject({
  objectType: z.enum(['claim']),
  objectId: z.uuid(),
  propositionId: z.uuid().nullable(),
  frameTypeId: registryId.nullable(),
  predicateId: registryId.nullable(),
  predicateRegistered: z.boolean(),
  authority: z.enum(['INDEX_MATCH', 'NON_AUTHORITATIVE_UNREGISTERED_PREDICATE']),
  /** Cosine distance, rounded to six places so a repeated run compares equal. */
  distance: z.number().min(0).max(2),
  evidenceIds: z.array(z.uuid()).max(64),
  entityIds: z.array(z.uuid()).max(64),
  securityScope: z.enum(['NORMAL', 'PRIVATE', 'RESTRICTED']),
  timeStart: z.iso.datetime().nullable(),
  timeEnd: z.iso.datetime().nullable(),
});
export type SemanticMatch = z.infer<typeof semanticMatchSchema>;

export const semanticSearchSchema = z.strictObject({
  embeddingModel: version,
  embeddingVersion: version,
  filters: semanticFiltersSchema,
  /** How many rows the hard filters left for ranking. The ranking saw these and
   * no others. */
  candidatesAfterFilters: z.number().int().min(0),
  matches: z.array(semanticMatchSchema).max(50),
});
export type SemanticSearch = z.infer<typeof semanticSearchSchema>;
