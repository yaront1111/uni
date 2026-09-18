import { z } from 'zod';

/** Owner read-your-writes and the correction controls (PRD §14, §20, §57).
 *
 * Schemas only, as every file in this package. The closed enums are the contract
 * migration 0014's CHECK lists and the `@unai/memory` overlay store both hold to:
 * a lifecycle or operation kind the database refuses cannot be constructed here
 * either. Nothing here reads a database, allocates a sequence or decides a
 * verdict.
 */

/** What the owner did, as the delta records it. The three write verbs of PRD
 * §20.2 that remove something from view -- suppress, archive, delete -- stay
 * separate kinds, because they are different promises to the owner. */
export const overlayDeltaKindSchema = z.enum(['USER_ASSERTION','USER_CORRECTION','USER_STATE_CHANGE','USER_CONFIRMATION',
  'USER_REJECTION','KEEP_UNCERTAIN','SUPPRESSION','ARCHIVE','DELETION','MERGE','SPLIT']);
export type OverlayDeltaKind = z.infer<typeof overlayDeltaKindSchema>;

/** PRD §14.3. `RECEIVED` is the acknowledgement state: the write is durable and
 * every device of the owner reads it, long before anything canonical exists. */
export const overlayLifecycleSchema = z.enum(['RECEIVED','USER_ASSERTED','AWAITING_INSTANCE_RESOLUTION',
  'CANONICALIZATION_PENDING','COMMITTED','CONTESTED','REJECTED_AS_INTERPRETATION','WITHDRAWN','SUPERSEDED']);
export type OverlayLifecycle = z.infer<typeof overlayLifecycleSchema>;

/** The ten correction controls of PRD §20.2, one persisted kind each. There is
 * deliberately no generic EDIT: a reader must be able to tell which control the
 * owner used. */
export const memoryOperationKindSchema = z.enum(['CORRECT','CHANGED','CONFIRM','REJECT','KEEP_UNCERTAIN',
  'SUPPRESS','ARCHIVE','DELETE','MERGE','SPLIT']);
export type MemoryOperationKind = z.infer<typeof memoryOperationKindSchema>;

export const memoryObjectTypeSchema = z.enum(['claim','proposition','belief_slot','frame_instance','entity','resolution_assertion']);
export const targetObjectRefSchema = z.strictObject({
  objectType: memoryObjectTypeSchema,
  objectId: z.uuid(),
});
export type TargetObjectRef = z.infer<typeof targetObjectRefSchema>;

const rawText = z.string().trim().min(1).max(8192);
const registryId = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);

/** POST /v1/memory/overlay-deltas. `sourceDeviceId` and `sourceSessionId` are
 * audit only: the overlay is owner-wide, so naming a device never narrows who
 * reads the delta back (CRT-RYW-02-A). */
export const overlayDeltaInputSchema = z.strictObject({
  deltaKind: overlayDeltaKindSchema,
  rawText,
  target: targetObjectRefSchema.optional(),
  candidateEntityRefs: z.array(z.uuid()).max(32).optional(),
  candidateWorldlineRefs: z.array(z.uuid()).max(32).optional(),
  candidateFrameTypes: z.array(registryId).max(32).optional(),
  discourseAnchor: z.string().trim().min(1).max(512).optional(),
  temporalHints: z.record(z.string().min(1).max(64), z.unknown()).optional(),
  sourceDeviceId: z.uuid().optional(),
  sensitivity: z.enum(['NORMAL','PRIVATE','RESTRICTED']).optional(),
});
export type OverlayDeltaInput = z.infer<typeof overlayDeltaInputSchema>;

/** A valid interval as the correction path states it. Both axes are half-open,
 * as everywhere else in the kernel. */
export const validIntervalSchema = z.strictObject({
  validFrom: z.iso.datetime({ offset: true }).nullable(),
  validTo: z.iso.datetime({ offset: true }).nullable(),
});

/** POST /v1/memory/corrections: the earlier information was wrong for the same
 * valid period (PRD §57). */
export const correctionInputSchema = z.strictObject({
  target: targetObjectRefSchema,
  correctedValue: z.unknown(),
  validInterval: validIntervalSchema.optional(),
  rawText,
  sourceDeviceId: z.uuid().optional(),
});

/** POST /v1/memory/state-changes: the earlier information was true and later
 * changed, which opens a second non-overlapping period instead of restating the
 * first one. */
export const stateChangeInputSchema = z.strictObject({
  target: targetObjectRefSchema,
  newValue: z.unknown(),
  changeEffectiveFrom: z.iso.datetime({ offset: true }),
  rawText,
  sourceDeviceId: z.uuid().optional(),
});

/** POST /v1/memory/confirmations. The confirmed statement's own claim origin is
 * left alone; this records a second, separate claim (CRT-AI-03-A). */
export const confirmationInputSchema = z.strictObject({
  target: targetObjectRefSchema,
  confirmedText: rawText,
  sourceMessageId: z.string().trim().min(1).max(512).optional(),
  sourceDeviceId: z.uuid().optional(),
});

/** The four controls that carry only a target and a reason, plus the scope the
 * suppression and deletion workflows need. */
export const rejectionInputSchema = z.strictObject({
  target: targetObjectRefSchema,
  reason: z.string().trim().min(1).max(2048),
  sourceDeviceId: z.uuid().optional(),
});
export const keepUncertainInputSchema = z.strictObject({
  target: targetObjectRefSchema,
  rawText: rawText.optional(),
  sourceDeviceId: z.uuid().optional(),
});
export const suppressionScopeSchema = z.enum(['OBJECT','OBJECT_AND_DERIVATIVES']);
export const suppressionInputSchema = z.strictObject({
  target: targetObjectRefSchema,
  scope: suppressionScopeSchema.optional(),
  rawText: rawText.optional(),
  sourceDeviceId: z.uuid().optional(),
});
export const archiveInputSchema = z.strictObject({
  target: targetObjectRefSchema,
  rawText: rawText.optional(),
  sourceDeviceId: z.uuid().optional(),
});
/** Deletion asks for an explicit confirmation string, because the workflow it
 * starts cascades past the named object. */
export const deletionInputSchema = z.strictObject({
  target: targetObjectRefSchema,
  scope: suppressionScopeSchema.optional(),
  confirmation: z.literal('DELETE'),
  rawText: rawText.optional(),
  sourceDeviceId: z.uuid().optional(),
});

/** What every correction control answers with: the three rows it created and the
 * owner sequence that makes the write observable from the owner's other devices
 * (CRT-RYW-06-A, CRT-RYW-02-A). */
export const memoryWriteReceiptSchema = z.strictObject({
  operationKind: memoryOperationKindSchema,
  memoryOperationId: z.uuid(),
  evidenceId: z.uuid(),
  overlayDeltaId: z.uuid(),
  ownerSequence: z.number().int().positive(),
  proposedTransactionId: z.uuid().nullable(),
  lifecycle: overlayLifecycleSchema,
  /** Owner-wide by construction: the delta is scoped to the owner, not to the
   * device that wrote it. */
  visibilityStatus: z.literal('OWNER_VISIBLE'),
  createdClaimId: z.uuid().nullable(),
});
export type MemoryWriteReceipt = z.infer<typeof memoryWriteReceiptSchema>;

/** A delta is the owner speaking, by construction: it exists because the owner
 * wrote it. Saying so on every returned delta is half of what CRT-RYW-02-A asks
 * for; `independentVerification` is the other half, and an answer that reports
 * only one of the two is the failure that criterion names. */
export const assertionKindSchema = z.literal('USER_ASSERTION');
/** What, other than the owner's own words behind this delta, supports the same
 * target. A model reading of the owner's message is not independent of it
 * (PRD §15.4), so only an external person, a structured connector observation, a
 * document or an authoritative tool receipt counts here. */
export const INDEPENDENT_CLAIM_ORIGINS = Object.freeze(
  ['EXTERNAL_PERSON_ASSERTION','STRUCTURED_CONNECTOR_OBSERVATION','DOCUMENT_ASSERTION','TOOL_EXECUTION_RECEIPT'] as const);
export const independentVerificationSchema = z.strictObject({
  verified: z.boolean(),
  independentEvidenceIds: z.array(z.uuid()).max(100),
  independentClaimOrigins: z.array(z.enum(INDEPENDENT_CLAIM_ORIGINS)).max(4),
});

export const publicOverlayDeltaSchema = z.strictObject({
  overlayDeltaId: z.uuid(),
  ownerSequence: z.number().int().positive(),
  deltaKind: overlayDeltaKindSchema,
  lifecycle: overlayLifecycleSchema,
  rawText: z.string(),
  target: targetObjectRefSchema.nullable(),
  sourceEvidenceId: z.uuid(),
  attachedFrameInstanceId: z.uuid().nullable(),
  attachedBeliefSlotId: z.uuid().nullable(),
  candidateEntityRefs: z.array(z.uuid()),
  candidateFrameTypes: z.array(z.string()),
  discourseAnchor: z.string().nullable(),
  createdAt: z.iso.datetime(),
  contestedReason: z.record(z.string(), z.unknown()).nullable(),
  assertionKind: assertionKindSchema,
  independentVerification: independentVerificationSchema,
});
export type PublicOverlayDelta = z.infer<typeof publicOverlayDeltaSchema>;

/** The owner's overlay as one read: every delta at or after a watermark, plus the
 * targets a suppression, archive or deletion has removed from normal retrieval.
 * A reader that honours `suppressedTargets` honours CRT-RYW-02-B whichever device
 * asked. */
export const ownerOverlaySchema = z.strictObject({
  ownerOverlayWatermark: z.number().int().nonnegative(),
  deltas: z.array(publicOverlayDeltaSchema),
  suppressedTargets: z.array(targetObjectRefSchema),
  archivedTargets: z.array(targetObjectRefSchema),
  deletedTargets: z.array(targetObjectRefSchema),
});
export type OwnerOverlay = z.infer<typeof ownerOverlaySchema>;
