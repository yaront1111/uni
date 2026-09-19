import { z } from 'zod';

export const requestContextSchema = z.strictObject({
  actorId: z.uuid(),
  ownerScopeId: z.uuid(),
  purpose: z.string().regex(/^[a-z][a-z0-9_.:-]{0,63}$/),
  correlationId: z.uuid(),
});
export type RequestContext = Readonly<z.infer<typeof requestContextSchema>>;

export const auditEventSchema = z.strictObject({
  policyDecision: z.enum(['ALLOW','DENY']),
  codeVersion: z.string().regex(/^[a-zA-Z0-9_.:@/-]{1,120}$/),
  result: z.enum(['SUCCESS','FAILURE','REFUSED']),
  objects: z.array(z.strictObject({
    type: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    id: z.uuid(),
    fields: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)).max(64),
  })).max(100),
});
export type AuditEvent = Readonly<z.infer<typeof auditEventSchema>>;

export const registerDeviceSchema=z.strictObject({
  displayName:z.string().trim().min(1).max(120),kind:z.enum(['DESKTOP','PHONE']),
});
export const publicDeviceSchema=registerDeviceSchema.extend({id:z.uuid(),lastSeenAt:z.iso.datetime()});
export type PublicDevice=z.infer<typeof publicDeviceSchema>;
export {evidenceInputSchema,publicEvidenceSchema,dataPurposeSchema,sensitivitySchema,type EvidenceInput,type PublicEvidence} from './evidence.js';
export {sourceAnchorKindSchema,parsedSourceAnchorSchema,parsedSourceItemSchema,parsedSourceTypeSchema,
  gmailThreadSchema,googleCalendarEventSchema,githubIssueThreadSchema,uploadedDocumentSchema,
  parseSourcePayload,SourcePayloadInvalid,
  type SourceAnchorKind,type ParsedSourceAnchor,type ParsedSourceItem,type ParsedSourceType} from './sources.js';
export {registryVersionSchema,registryContentHashSchema,registryContractKindSchema,publicRegistryContractSchema,
  loadedRegistryReleaseSchema,registrySnapshotViewSchema,registryLintIssueSchema,registryLintedReleaseSchema,
  registryLintReportSchema,
  type PublicRegistryContract,type LoadedRegistryRelease,type RegistrySnapshotView,type RegistryLintReport} from './registry.js';
export {entityKindSchema,entityLifecycleSchema,entityAliasTypeSchema,entityLineageKindSchema,entityMatchOutcomeSchema,
  modalitySchema,polaritySchema,claimOriginSchema,claimLifecycleSchema,temporalPrecisionSchema,temporalInterpretationSchema,
  slotDescriptorSchema,propositionDescriptorSchema,slotLookupOutcomeSchema,propositionLookupOutcomeSchema,storedClaimSchema,
  type TemporalInterpretation,type SlotDescriptor,type StoredClaim} from './memory.js';
export {memoryLinkKindSchema,memoryLinkObjectTypeSchema,memoryLinkLifecycleSchema,outcomeCodeSchema,
  resolutionLifecycleSchema,outcomeProjectionStateSchema,transitionContractSchema,transitionContractSetSchema,
  storedResolutionAssertionSchema,storedMemoryLinkSchema,outcomeProjectionSchema,
  TRANSITION_LINK_KINDS,PARTIAL_OUTCOME_CODES,
  type MemoryLinkKind,type OutcomeCode,type ResolutionLifecycle,type OutcomeProjectionState,type TransitionContract,
  type StoredResolutionAssertion,type StoredMemoryLink,type OutcomeProjection} from './outcomes.js';
export {tier1RouteSchema,tier1SignalSchema,routingReasonSchema,tier0ParseSchema,triageDecisionSchema,publicTriageSchema,
  extractionRunKindSchema,extractionRunStatusSchema,extractionRunSchema,extractedSpanSchema,extractedClaimSchema,
  extractionOutputSchema,modelCallOutcomeSchema,modelCallRecordSchema,DEEP_EXTRACTION_ROUTES,
  type Tier1Route,type Tier1Signal,type RoutingReason,type Tier0Parse,type TriageDecision,
  type ExtractionRun,type ExtractedClaim,type ExtractionOutput,type ModelCallRecord} from './extraction.js';
export {objectRefSchema,beliefTransactionKindSchema,beliefTransactionStatusSchema,writeRiskSchema,admissionModeSchema,
  autoAcceptConditionSchema,assessmentStatusSchema,supportKindSchema,independenceGroupSchema,beliefOperationKindSchema,
  beliefOperationSchema,proposeBeliefTransactionSchema,policyPortSchema,writePolicyOutcomeSchema,readPolicyOutcomeSchema,
  actionPolicyOutcomeSchema,policyVerdictSchema,validationDecisionSchema,validationReportSchema,commitReceiptSchema,
  unregisteredPredicateUseSchema,type UnregisteredPredicateUse,
  type ObjectRef,type AdmissionMode,type AutoAcceptCondition,type AssessmentStatus,type BeliefOperation,
  type ProposeBeliefTransaction,type PolicyVerdict,type ValidationReport,type CommitReceipt} from './governance.js';
export {overlayDeltaKindSchema,overlayLifecycleSchema,memoryOperationKindSchema,memoryObjectTypeSchema,
  targetObjectRefSchema,overlayDeltaInputSchema,validIntervalSchema,correctionInputSchema,stateChangeInputSchema,
  confirmationInputSchema,rejectionInputSchema,keepUncertainInputSchema,suppressionScopeSchema,suppressionInputSchema,
  archiveInputSchema,deletionInputSchema,memoryWriteReceiptSchema,assertionKindSchema,independentVerificationSchema,
  INDEPENDENT_CLAIM_ORIGINS,
  publicOverlayDeltaSchema,ownerOverlaySchema,
  type OverlayDeltaKind,type OverlayLifecycle,type MemoryOperationKind,type TargetObjectRef,type OverlayDeltaInput,
  type MemoryWriteReceipt,type PublicOverlayDelta,type OwnerOverlay} from './overlay.js';
export {moneyAmountSchema,currencyCodeSchema,moneySchema,projectionNameSchema,rebuildTriggerSchema,sourceStrengthSchema,
  outcomeStateSchema,pendingAssertionReasonSchema,pendingAssertionSchema,projectionRowMetadataSchema,
  commitmentProjectionRowSchema,obligationProjectionRowSchema,scheduleProjectionRowSchema,
  commitmentsProjectionViewSchema,obligationsProjectionViewSchema,scheduleProjectionViewSchema,
  projectionRebuildReceiptSchema,projectionHealthSchema,amountConflictSchema,obligationCalculationSchema,
  commitmentLanguageSchema,commitmentReadingSchema,PROJECTION_NAMES,
  type Money,type ProjectionName,type RebuildTrigger,type SourceStrength,type PendingAssertion,
  type PendingAssertionReason,type CommitmentProjectionRow,type ObligationProjectionRow,type ScheduleProjectionRow,
  type CommitmentsProjectionView,type ObligationsProjectionView,type ScheduleProjectionView,
  type ProjectionRebuildReceipt,type ProjectionHealth,type AmountConflict,type ObligationCalculation,
  type CommitmentLanguage,type CommitmentReading} from './projections.js';
export {answerTypeSchema,worldTimeSchema,knowledgeTimeSchema,certaintySchema,actionRiskSchema,lifeCategorySchema,
  contextActionKindSchema,intendedActionSchema,contextActionDecisionSchema,
  REQUIRED_CONTEXT_FIELDS,REDACTABLE_BELIEF_FIELDS,contextRequestSchema,contextBeliefSchema,contextFutureClaimSchema,contextConflictSchema,
  contextUnknownSchema,contextRedactionSchema,contextProjectionFragmentSchema,contextEvidenceRefSchema,
  contextResolutionSchema,contextThreadRefSchema,contextWatermarksSchema,selectionReasonSchema,contextPacketSchema,
  explainClaimSchema,explainEvidenceAnchorSchema,explainSupportSchema,explainContradictionSchema,
  explainTemporalEntrySchema,explainResolutionLinkSchema,explainProjectionConsumerSchema,beliefExplanationSchema,
  threadObjectTypeSchema,threadMembershipKindSchema,threadLifecycleSchema,threadMemberInputSchema,threadMemberSchema,
  memoryThreadViewSchema,
  type AnswerType,type LifeCategory,type RequiredContextField,type ContextRequest,type ContextBelief,
  type ContextActionKind,type IntendedAction,
  type ContextRedaction,type ContextPacket,type BeliefExplanation,type ThreadMemberInput,type ThreadMember,
  type MemoryThreadView} from './context.js';
export {SELECTION_RULES,selectionRuleSchema,selectionOutcomeSchema,selectionStepSchema,contextSelectionSchema,
  semanticFiltersSchema,semanticMatchSchema,semanticSearchSchema,
  type SelectionRule,type SelectionOutcome,type SelectionStep,type ContextSelection,type SemanticFilters,
  type SemanticMatch,type SemanticSearch} from './selection.js';
export {questionTypeSchema,historicalModeSchema,certaintyLabelSchema,REQUIRED_ASK_FIELDS,askRequestSchema,
  askSourceLinkSchema,askStatementKindSchema,askStatementSchema,askAnswerSchema,
  type QuestionType,type HistoricalMode,type CertaintyLabel,type RequiredAskField,type AskRequest,
  type AskSourceLink,type AskStatement,type AskAnswer} from './ask.js';
export {GROUNDING_RULES,groundingRuleSchema,groundingViolationActionSchema,groundingActionSchema,candidateSourceSchema,
  groundingViolationSchema,groundingAttemptSchema,groundingResultSchema,answerCandidateStatementSchema,
  answerCandidateSchema,SUPPLIED_CONTEXT_STATEMENT,suppliedContextSchema,reconsiderationChangeSchema,
  publicAnswerManifestSchema,reconsiderationCandidatesViewSchema,deltaContestRecordSchema,
  type GroundingRule,type GroundingAction,type GroundingViolation,type GroundingResult,
  type AnswerCandidateStatement,type AnswerCandidate,type SuppliedContext,type ReconsiderationChange,
  type PublicAnswerManifest,type ReconsiderationCandidatesView,type DeltaContestRecord} from './answers.js';
export {jobStatusSchema,jobKindSchema,workerIdSchema,jobErrorCodeSchema,enqueueJobSchema,publicJobSchema,
  claimedJobSchema,queueDepthSchema,jobsViewSchema,deadLetterViewSchema,retryResultSchema,
  type JobStatus,type EnqueueJob,type PublicJob,type ClaimedJob,type QueueDepth,type JobsView} from './jobs.js';

