import { z } from 'zod';

/** The write governor's vocabularies and record shapes (PRD §19, §29.3, §33.7, §33.9).
 *
 * Schemas only, as every file in this package: nothing here opens a transaction,
 * reads a registry release or reaches a decision. The closed enums are the
 * contract that migration 0012's CHECK lists and the `@unai/belief` services both
 * hold to, so a value the database refuses cannot be constructed here either.
 */

const registryId = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
const version = z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/);
const reasonCode = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);
const confidence = z.number().min(0).max(1);

/** A reference to an object that either already exists (a UUID) or is produced by
 * an earlier operation of the same transaction (`#slug`). The second form is what
 * makes an ordered operation list expressible without the caller inventing ids
 * for rows the kernel has not minted yet. */
export const objectRefSchema = z.union([z.uuid(), z.string().regex(/^#[a-z0-9][a-z0-9-]{0,31}$/)]);
export type ObjectRef = z.infer<typeof objectRefSchema>;
const operationRef = z.string().regex(/^#[a-z0-9][a-z0-9-]{0,31}$/);

export const beliefTransactionKindSchema = z.enum(['CANONICALIZE','CORRECT','STATE_CHANGE','CONFIRM','REJECT','DERIVE','MERGE','SPLIT','SUPPRESS','ARCHIVE','DELETE','RESOLVE']);
export const beliefTransactionStatusSchema = z.enum(['PROPOSED','VALIDATED','COMMITTING','COMMITTED','REJECTED']);
export const writeRiskSchema = z.enum(['LOW','MEDIUM','HIGH']);

/** PRD §19.2. Seven modes, and `AUTO_ACCEPT` is the only one that may place an
 * accepted belief without owner judgement. */
export const admissionModeSchema = z.enum(['SOURCE_ONLY','INDEX_ONLY','AUTO_CLAIM','AUTO_ACCEPT','AUTO_PROVISIONAL','BATCH_REVIEW','JUST_IN_TIME']);
export type AdmissionMode = z.infer<typeof admissionModeSchema>;

/** The six conditions PRD §19.2 requires of `AUTO_ACCEPT`, named so a refusal can
 * say which one failed rather than only that one did. */
export const autoAcceptConditionSchema = z.enum(['PREDICATE_REGISTERED','IDENTITY_RESOLVED','SOURCE_AUTHORITATIVE','NO_MATERIAL_CONFLICT','LOW_CONSEQUENCE','REVERSIBLE_AND_AUDITED']);
export type AutoAcceptCondition = z.infer<typeof autoAcceptConditionSchema>;

/** PRD §15.2. Distinct from `claims.lifecycle` and from the slot's modality: what
 * the kernel believes, what one source asserted and how the world is claimed to
 * relate to the value are three separate records (CRT-MEM-13-A). */
export const assessmentStatusSchema = z.enum(['CANDIDATE','PROVISIONAL','ACCEPTED','CONTESTED','REJECTED','SUPERSEDED','UNSUPPORTED','SUPPRESSED']);
export type AssessmentStatus = z.infer<typeof assessmentStatusSchema>;

export const supportKindSchema = z.enum(['DIRECT_ASSERTION','CORROBORATION','DERIVATION','QUOTED_RESTATEMENT','MODEL_SUMMARY','STRUCTURED_OBSERVATION','USER_CONFIRMATION']);
export const independenceGroupSchema = z.string().regex(/^[a-z0-9][a-z0-9_.:-]{0,127}$/);

export const beliefOperationKindSchema = z.enum(['CREATE_FRAME_INSTANCE','CREATE_SLOT','CREATE_PROPOSITION','ADD_CLAIM','ADD_SUPPORT','SET_BELIEF_ASSESSMENT','DERIVE','QUALIFY','MERGE','SPLIT','SUPPRESS','ARCHIVE','DELETE']);

const roleFill = z.strictObject({
  roleId: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  entityId: z.uuid().optional(),
  typedValue: z.unknown().optional(),
});

export const beliefOperationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('CREATE_FRAME_INSTANCE'), operationRef,
    frameTypeId: registryId, contextSpaceId: z.uuid().optional(), roles: z.array(roleFill).max(32).optional() }),
  z.strictObject({ kind: z.literal('CREATE_SLOT'), operationRef,
    frameInstance: objectRefSchema, predicateId: registryId, contextSpaceId: z.uuid().optional(),
    modality: z.enum(['ACTUAL','SCHEDULED','INTENDED','COMMITTED','EXPECTED','PREDICTED','RECOMMENDED','CONDITIONAL']),
    qualifiers: z.record(z.string().min(1).max(64), z.union([z.string().max(512), z.number(), z.boolean()])).optional() }),
  z.strictObject({ kind: z.literal('CREATE_PROPOSITION'), operationRef,
    beliefSlot: objectRefSchema, normalizedValue: z.unknown(), polarity: z.enum(['POSITIVE','NEGATIVE']).optional() }),
  z.strictObject({ kind: z.literal('ADD_CLAIM'), operationRef,
    sourceAnchorId: z.uuid(), proposition: objectRefSchema.optional(), assertedByEntityId: z.uuid().optional(),
    claimOrigin: z.enum(['USER_STATEMENT','USER_CONFIRMATION','USER_CORRECTION','EXTERNAL_PERSON_ASSERTION',
      'STRUCTURED_CONNECTOR_OBSERVATION','DOCUMENT_ASSERTION','MODEL_EXTRACTION','MODEL_INFERENCE','MODEL_RECOMMENDATION',
      'MODEL_PREDICTION','TOOL_EXECUTION_RECEIPT']),
    lifecycle: z.enum(['CANDIDATE','AWAITING_INSTANCE_RESOLUTION','PROVISIONAL','ACCEPTED','CONTESTED','REJECTED','SUPERSEDED','SUPPRESSED']).optional(),
    extractionRunId: z.uuid().optional(),
    validFrom: z.iso.datetime().optional(), validTo: z.iso.datetime().optional(),
    extractionConfidence: confidence.optional(), entityResolutionConfidence: confidence.optional(),
    temporalResolutionConfidence: confidence.optional(), instanceResolutionConfidence: confidence.optional() }),
  z.strictObject({ kind: z.literal('ADD_SUPPORT'),
    proposition: objectRefSchema, claim: objectRefSchema.optional(), supportingProposition: objectRefSchema.optional(),
    supportKind: supportKindSchema }),
  z.strictObject({ kind: z.literal('SET_BELIEF_ASSESSMENT'),
    proposition: objectRefSchema, assessmentStatus: assessmentStatusSchema,
    validFrom: z.iso.datetime().optional(), validTo: z.iso.datetime().optional(),
    decisionReason: z.record(z.string(), z.unknown()).optional() }),
  z.strictObject({ kind: z.literal('DERIVE'),
    derivedProposition: objectRefSchema, inputClaimIds: z.array(z.uuid()).max(256).optional(),
    inputPropositionIds: z.array(z.uuid()).max(256).optional(),
    evaluatorId: registryId, modelOrCodeVersion: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/),
    calculationInputs: z.record(z.string(), z.unknown()) }),
  z.strictObject({ kind: z.literal('QUALIFY'),
    beliefSlot: objectRefSchema, contextSpaceId: z.uuid().optional(),
    qualifiers: z.record(z.string().min(1).max(64), z.union([z.string().max(512), z.number(), z.boolean()])).optional() }),
  z.strictObject({ kind: z.literal('SUPPRESS'), target: objectRefSchema, targetObjectType: z.enum(['proposition','claim']) }),
  z.strictObject({ kind: z.literal('ARCHIVE'), target: objectRefSchema, targetObjectType: z.enum(['proposition','claim']) }),
  z.strictObject({ kind: z.literal('DELETE'), target: objectRefSchema, targetObjectType: z.enum(['proposition','claim']) }),
  z.strictObject({ kind: z.literal('MERGE'), target: objectRefSchema, survivor: objectRefSchema }),
  z.strictObject({ kind: z.literal('SPLIT'), target: objectRefSchema, partitions: z.array(z.string().max(64)).min(2).max(16) }),
]);
export type BeliefOperation = z.infer<typeof beliefOperationSchema>;

export const proposeBeliefTransactionSchema = z.strictObject({
  transactionKind: beliefTransactionKindSchema,
  registryReleaseId: z.uuid(),
  risk: writeRiskSchema,
  idempotencyKey: z.string().regex(/^[a-zA-Z0-9_-]{16,128}$/),
  sourceEvidenceIds: z.array(z.uuid()).max(256).optional(),
  admissionMode: admissionModeSchema.optional(),
  operations: z.array(beliefOperationSchema).min(1).max(256),
});
export type ProposeBeliefTransaction = z.infer<typeof proposeBeliefTransactionSchema>;

/** PRD §29.3. Outcome vocabularies differ per port; a read may be redacted and a
 * write may be staged, and neither borrows the other's answer. */
export const policyPortSchema = z.enum(['EvaluateMemoryWrite','EvaluateMemoryRead','EvaluateMemoryAction']);
export const writePolicyOutcomeSchema = z.enum(['ALLOW','STAGE','REQUIRE_CONFIRMATION','DENY']);
export const readPolicyOutcomeSchema = z.enum(['ALLOW','REDACT','DENY']);
export const actionPolicyOutcomeSchema = z.enum(['ALLOW','REQUIRE_CONFIRMATION','DENY']);

export const policyVerdictSchema = z.strictObject({
  outcome: z.enum(['ALLOW','STAGE','REQUIRE_CONFIRMATION','REDACT','DENY']),
  requiredConfirmation: z.boolean(),
  redactions: z.array(z.record(z.string(), z.unknown())).max(256),
  obligations: z.array(z.record(z.string(), z.unknown())).max(64),
  expiry: z.iso.datetime().nullable(),
  reason: reasonCode,
  policyVersion: version,
});
export type PolicyVerdict = z.infer<typeof policyVerdictSchema>;

export const validationDecisionSchema = z.enum(['COMMITTABLE','REQUIRES_CONFIRMATION','CONTESTED','REJECTED','SOURCE_ONLY']);

/** PRD §17.5: the four things an unregistered surface predicate may never be used
 * for. A transaction touching one is refused for each use it would make of it
 * (CRT-REG-04-A); storing and indexing it are not uses and stay permitted. */
export const unregisteredPredicateUseSchema = z.enum(['SUPERSEDE_ACCEPTED_BELIEF','RESOLVE_CONFLICT','SET_CURRENT_VALUE',
  'AUTHORIZE_HIGH_RISK_ACTION']);
export type UnregisteredPredicateUse = z.infer<typeof unregisteredPredicateUseSchema>;

export const validationReportSchema = z.strictObject({
  transactionId: z.uuid(),
  decision: validationDecisionSchema,
  policy: policyVerdictSchema,
  admissionMode: admissionModeSchema,
  withheldAutoAcceptConditions: z.array(autoAcceptConditionSchema),
  unregisteredContracts: z.array(z.strictObject({ contractId: z.string(), contractKind: z.enum(['FRAME','PREDICATE']) })),
  /** Each refused use of an unregistered contract this transaction touches, with
   * the contracts it touches and the operation that would have made the use. */
  unregisteredPredicateUses: z.array(z.strictObject({
    use: unregisteredPredicateUseSchema,
    operationOrder: z.number().int().min(0).nullable(),
    propositionRef: z.string().nullable(),
    contractIds: z.array(z.string()).min(1),
  })).default([]),
  circularSupport: z.array(z.strictObject({ propositionRef: z.string(), cycle: z.array(z.string()) })),
  independenceGroups: z.array(z.strictObject({ propositionRef: z.string(), groups: z.array(independenceGroupSchema), independentSourceCount: z.number().int().min(0) })),
  conflicts: z.array(z.record(z.string(), z.unknown())),
  warnings: z.array(reasonCode),
  validationVersion: version,
});
export type ValidationReport = z.infer<typeof validationReportSchema>;

export const commitReceiptSchema = z.strictObject({
  transactionId: z.uuid(),
  idempotencyKey: z.string(),
  registryReleaseId: z.uuid(),
  committedAt: z.iso.datetime(),
  policyDecisionId: z.uuid(),
  admissionMode: admissionModeSchema,
  createdObjects: z.array(z.strictObject({ operationOrder: z.number().int().min(0), objectType: z.string(), objectId: z.uuid() })),
  beliefAssessments: z.array(z.strictObject({ propositionId: z.uuid(), assessmentId: z.uuid(), assessmentStatus: assessmentStatusSchema, recordedAt: z.iso.datetime() })),
  affectedProjections: z.array(z.string()),
  projectionRebuildReceipts: z.array(z.uuid()),
  receiptVersion: version,
});
export type CommitReceipt = z.infer<typeof commitReceiptSchema>;
