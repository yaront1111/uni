import { z } from 'zod';
import { beliefExplanationSchema, threadLifecycleSchema, threadMembershipKindSchema } from './context.js';
import { memoryOperationKindSchema, targetObjectRefSchema } from './overlay.js';
import { sensitivitySchema } from './evidence.js';

/** The Memory inspector and the related context behind the Commitments and
 * Obligations screens (PRD §7.3, §7.6; ADR 0027).
 *
 * Schemas only, as every file in this package. Both reads are inspection reads:
 * they answer what memory already holds and never compute a new belief.
 */

const registryId = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
const code = z.string().regex(/^[A-Z][A-Z_]{0,63}$/);
const label = z.string().max(200).nullable();
const excerpt = z.string().max(2000).nullable();

/** What a surface may hand the inspector: whatever object it showed. The route
 * resolves it to the belief it is about (ADR 0027 §1). */
export const inspectableObjectTypeSchema = z.enum(['proposition', 'claim', 'frame_instance', 'resolution_assertion', 'owner_overlay_delta']);
export type InspectableObjectType = z.infer<typeof inspectableObjectTypeSchema>;

export const inspectorEntitySchema = z.strictObject({
  entityId: z.uuid(),
  entityKind: z.string().max(32),
  canonicalLabel: label,
});

export const inspectorEvidenceSchema = z.strictObject({
  evidenceId: z.uuid(),
  sourceType: z.string().max(64),
  sensitivity: sensitivitySchema,
  occurredAt: z.iso.datetime().nullable(),
  observedAt: z.iso.datetime(),
  anchors: z.array(z.strictObject({
    sourceAnchorId: z.uuid(),
    anchorKind: z.string().max(64),
    text: excerpt,
  })).max(64),
});

/** A derivation the belief takes part in: either it was derived from inputs, or
 * it is an input to another derived belief (PRD §35.8 "inferences"). */
export const inspectorInferenceSchema = z.strictObject({
  dependencyId: z.uuid(),
  role: z.enum(['DERIVED_FROM_INPUTS', 'INPUT_TO_DERIVED']),
  derivedPropositionId: z.uuid(),
  derivedAssessmentStatus: z.string().max(32).nullable(),
  inputClaimIds: z.array(z.uuid()).max(200),
  inputPropositionIds: z.array(z.uuid()).max(200),
  evaluatorId: z.string().max(200),
  modelOrCodeVersion: z.string().max(200),
  registryReleaseId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
});

export const inspectorThreadSchema = z.strictObject({
  memoryThreadId: z.uuid(),
  displayTitle: label,
  lifecycle: threadLifecycleSchema,
  membershipKind: threadMembershipKindSchema,
  memberObjectType: z.string().max(32),
});

/** One access to the belief. `AUDIT_EVENT` is a recorded read or write that
 * named it; `ANSWER_MANIFEST` is an answer given with it in context. Neither
 * carries any payload (ADR 0027 §2). */
export const inspectorAccessSchema = z.strictObject({
  kind: z.enum(['AUDIT_EVENT', 'ANSWER_MANIFEST']),
  id: z.uuid(),
  at: z.iso.datetime(),
  purpose: z.string().max(64).nullable(),
  result: z.string().max(16).nullable(),
  fields: z.array(z.string().max(64)).max(64),
});

export const inspectorClaimConfidenceSchema = z.strictObject({
  claimId: z.uuid(),
  extraction: z.number().min(0).max(1).nullable(),
  entityResolution: z.number().min(0).max(1).nullable(),
  temporalResolution: z.number().min(0).max(1).nullable(),
  instanceResolution: z.number().min(0).max(1).nullable(),
});

export const inspectorOperationSchema = z.strictObject({
  memoryOperationId: z.uuid(),
  operationKind: memoryOperationKindSchema,
  target: targetObjectRefSchema,
  overlayDeltaId: z.uuid().nullable(),
  transactionId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
});

/** GET /v1/memory/inspector/{objectType}/{id}. */
export const memoryInspectorSchema = z.strictObject({
  subject: z.strictObject({
    requestedType: inspectableObjectTypeSchema,
    requestedId: z.uuid(),
    propositionId: z.uuid(),
    /** The target every correction control names for this belief. */
    correctionTarget: targetObjectRefSchema,
  }),
  explanation: beliefExplanationSchema,
  assertingActors: z.array(inspectorEntitySchema).max(200),
  claimConfidences: z.array(inspectorClaimConfidenceSchema).max(500),
  originalEvidence: z.array(inspectorEvidenceSchema).max(200),
  /** Evidence behind the belief that this request may not read. Counted, never shown. */
  withheldEvidenceCount: z.number().int().nonnegative(),
  inferences: z.array(inspectorInferenceSchema).max(200),
  connectedThreads: z.array(inspectorThreadSchema).max(100),
  accessHistory: z.array(inspectorAccessSchema).max(100),
  memoryOperations: z.array(inspectorOperationSchema).max(200),
  inspectorVersion: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/),
  readAt: z.iso.datetime(),
});
export type MemoryInspector = z.infer<typeof memoryInspectorSchema>;

export const relatedResolutionSchema = z.strictObject({
  resolutionAssertionId: z.uuid(),
  outcomeCode: code,
  effectiveAt: z.iso.datetime(),
  lifecycle: code,
  assertedBy: inspectorEntitySchema.nullable(),
  claimId: z.uuid(),
  /** The evidence the resolving claim is grounded in: the resolution evidence. */
  evidence: z.array(inspectorEvidenceSchema).max(20),
});

/** One frame instance as the Commitments and Obligations screens show it. */
export const relatedFrameSchema = z.strictObject({
  frameInstanceId: z.uuid(),
  frameTypeId: registryId,
  lifecycle: z.string().max(32),
  people: z.array(inspectorEntitySchema.extend({ roleId: z.string().max(64) })).max(50),
  sources: z.array(inspectorEvidenceSchema).max(50),
  withheldSourceCount: z.number().int().nonnegative(),
  resolutions: z.array(relatedResolutionSchema).max(50),
  beliefs: z.array(z.strictObject({
    propositionId: z.uuid(),
    predicateId: registryId,
    modality: z.string().max(32),
    assessmentStatus: z.string().max(32).nullable(),
  })).max(100),
  threads: z.array(z.strictObject({ memoryThreadId: z.uuid(), displayTitle: label })).max(50),
});
export type RelatedFrame = z.infer<typeof relatedFrameSchema>;

/** GET /v1/memory/frames/related?ids=… */
export const relatedFramesSchema = z.strictObject({
  frames: z.array(relatedFrameSchema).max(100),
  readAt: z.iso.datetime(),
});
export type RelatedFrames = z.infer<typeof relatedFramesSchema>;
