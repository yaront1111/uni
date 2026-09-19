import { z } from 'zod';
import { auditEventKindSchema } from './audit.js';

export {AUDIT_EVENT_KINDS,AUDIT_READ_PURPOSES,AUDIT_LOG_MAX_LIMIT,auditEventKindSchema,auditEventKindFor,auditObjectSchema,
  publicAuditEventSchema,auditLogQuerySchema,auditLogSchema,
  type AuditEventKind,type PublicAuditEvent,type AuditLogQuery,type AuditLog} from './audit.js';

export const requestContextSchema = z.strictObject({
  actorId: z.uuid(),
  ownerScopeId: z.uuid(),
  purpose: z.string().regex(/^[a-z][a-z0-9_.:-]{0,63}$/),
  correlationId: z.uuid(),
});
export type RequestContext = Readonly<z.infer<typeof requestContextSchema>>;

export const auditEventSchema = z.strictObject({
  /** Read, write, projection rebuild, export, deletion or external action. The
   * owner transaction derives it from the purpose when the caller does not name
   * it, and the API boundary from the HTTP method (migration 0027). */
  eventKind: auditEventKindSchema.optional(),
  policyDecision: z.enum(['ALLOW','DENY']),
  /** The recorded policy-port decision this event acted under, where one exists. */
  policyDecisionId: z.uuid().optional(),
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
  conversationSchema,gmailThreadSchema,googleCalendarEventSchema,githubIssueThreadSchema,uploadedDocumentSchema,
  parseSourcePayload,SourcePayloadInvalid,
  type SourceAnchorKind,type ParsedSourceAnchor,type ParsedSourceItem,type ParsedSourceType} from './sources.js';
export {registryVersionSchema,registryContentHashSchema,registryContractKindSchema,publicRegistryContractSchema,
  loadedRegistryReleaseSchema,registrySnapshotViewSchema,registryLintIssueSchema,registryLintedReleaseSchema,
  registryLintReportSchema,registryMigrationStatusSchema,
  type PublicRegistryContract,type LoadedRegistryRelease,type RegistrySnapshotView,type RegistryLintReport,
  type RegistryMigrationStatus} from './registry.js';
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
export {frameInstanceLineageKindSchema,propositionLineageKindSchema,lineageObjectTypeSchema,partitionKeySchema,
  frameInstanceMergeRequestSchema,frameInstanceSplitRequestSchema,entityMergeRequestSchema,entitySplitRequestSchema,
  lineageRecordSchema,resolvedIdentitySchema,frameMergeDetailSchema,frameSplitDetailSchema,entityMergeDetailSchema,
  entitySplitDetailSchema,frameInstanceMergeResultSchema,frameInstanceSplitResultSchema,entityMergeResultSchema,
  entitySplitResultSchema,frameMergeCandidateSchema,entityMergeCandidateSchema,mergeSplitReviewSchema,
  type LineageObjectType,type FrameInstanceMergeRequest,type FrameInstanceSplitRequest,type EntityMergeRequest,
  type EntitySplitRequest,type LineageRecord,type ResolvedIdentity,type FrameMergeDetail,type FrameSplitDetail,
  type EntityMergeDetail,type EntitySplitDetail,type FrameInstanceMergeResult,type FrameInstanceSplitResult,
  type EntityMergeResult,type EntitySplitResult,type MergeSplitReview} from './lineage.js';
export {mergeTargetTypeSchema,objectRefSchema,beliefTransactionKindSchema,beliefTransactionStatusSchema,writeRiskSchema,admissionModeSchema,
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
export {moneyAmountSchema,currencyCodeSchema,moneySchema,projectionNameSchema,recordedProjectionNameSchema,rebuildTriggerSchema,sourceStrengthSchema,
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
export {capabilityIdSchema,connectorTypeSchema,connectorStatusSchema,capabilityAccessSchema,capabilityRiskClassSchema,
  capabilityContextProfileSchema,manifestCapabilitySchema,connectorManifestSchema,connectorCursorSchema,
  connectCapabilityRequestSchema,createConnectorSchema,grantCapabilitiesSchema,publicCapabilityGrantSchema,
  publicConnectorSchema,syncModeSchema,syncRequestSchema,syncRefusalSchema,syncResultSchema,disconnectResultSchema,
  documentUploadSchema,extractionPlanReasonSchema,documentReceiptSchema,documentSearchHitSchema,
  documentSearchResultSchema,bundleWithholdingSchema,pluginContextBundleSchema,
  type ConnectorType,type ConnectorStatus,type CapabilityContextProfile,type ManifestCapability,
  type ConnectorManifest,type ConnectorCursor,type CreateConnector,type PublicCapabilityGrant,type PublicConnector,
  type SyncRequest,type SyncResult,type DisconnectResult,type DocumentUpload,type ExtractionPlanReason,
  type DocumentReceipt,type DocumentSearchResult,type PluginContextBundle} from './connectors.js';
export {inspectableObjectTypeSchema,inspectorEntitySchema,inspectorEvidenceSchema,inspectorInferenceSchema,
  inspectorThreadSchema,inspectorAccessSchema,inspectorClaimConfidenceSchema,inspectorOperationSchema,
  memoryInspectorSchema,relatedResolutionSchema,relatedFrameSchema,relatedFramesSchema,
  type InspectableObjectType,type MemoryInspector,type RelatedFrame,type RelatedFrames} from './inspection.js';
export {memoryLabelSchema,type MemoryLabel} from './labels.js';
export {timeZoneSchema,todayRequestSchema,briefingDomainSchema,briefingPrioritySchema,briefingOutcomeStateSchema,
  briefingItemKindSchema,rankComponentsSchema,whyObjectTypeSchema,whyRefSchema,briefingItemSchema,
  briefingRecommendationSchema,withheldRecommendationSchema,suppressedRepeatSchema,briefingPacketManifestSchema,
  briefingProjectionCompletenessSchema,todayBriefingSchema,claimingActorSchema,sourceExcerptSchema,whyClaimSchema,
  whySourcesSchema,
  type TodayRequest,type BriefingDomain,type BriefingPriority,type BriefingItemKind,type RankComponents,
  type WhyObjectType,type WhyRef,type BriefingItem,type BriefingRecommendation,type WithheldRecommendation,
  type BriefingPacketManifest,type TodayBriefing,type WhySources} from './today.js';
export {DEFAULT_ATTENTION_BUDGET,attentionBudgetSchema,attentionBudgetPatchSchema,ambiguityKindSchema,
  sensitivityScopeSchema,situationKeySchema,situationKindSchema,ambiguitySchema,cardEffectSchema,cardChoiceSchema,
  errorConsequenceSchema,irreversibilitySchema,urgencySchema,interruptionCostSchema,interruptionPolicyInputsSchema,
  interruptionDecisionKindSchema,interruptionReasonSchema,interruptionDecisionSchema,clarificationCardStatusSchema,
  cardAnswerSchema,clarificationCardSchema,memoryInboxViewSchema,cardDecisionInputSchema,cardDecisionResultSchema,
  learnedRuleStatusSchema,learnedRuleScopeSchema,learnedApprovalRuleSchema,learnedApprovalRulesViewSchema,
  reviewGroundSchema,reviewStatementSchema,reviewAvailabilitySchema,reviewSectionSchema,calendarAllocationSchema,
  postponementEpisodeSchema,behavioralObservationSchema,reviewManifestSchema,weeklyReviewSchema,weeklyReviewRequestSchema,
  type AttentionBudget,type AttentionBudgetPatch,type AmbiguityKind,type SensitivityScope,type Ambiguity,type CardEffect,
  type CardChoice,type InterruptionPolicyInputs,type InterruptionReason,type InterruptionDecision,type CardAnswer,
  type ClarificationCard,type MemoryInboxView,type CardDecisionInput,type CardDecisionResult,type LearnedRuleScope,
  type LearnedApprovalRule,type LearnedApprovalRulesView,type ReviewGround,type ReviewStatement,type ReviewSection,
  type PostponementEpisode,type BehavioralObservation,type ReviewManifest,type WeeklyReview} from './review.js';
export {PRODUCTION_KEYING_RULES,keyingRuleSchema,corpusKindSchema,instanceMatchSignalsSchema,corpusAnnotationSchema,
  ruleThresholdSchema,identityThresholdsSchema,keyingRuleResultSchema,LABEL_CATEGORIES,corpusResultsSchema,corpusStatusSchema,
  shadowRunKindSchema,SHADOW_DIFF_NAMES,shadowDiffEntrySchema,shadowDiffSchema,costAndLatencyDiffSchema,
  shadowSampleRefSchema,evaluationVersionsSchema,shadowReportSchema,publicShadowRunSchema,shadowRunsViewSchema,
  METRIC_KEYS,metricKeySchema,metricUnitSchema,metricValueSchema,metricsViewSchema,performanceMeasurementSchema,type PerformanceMeasurement,
  type KeyingRule,type CorpusKind,type CorpusAnnotation,type IdentityThresholds,type KeyingRuleResult,type LabelCategory,
  type CorpusResults,type CorpusStatus,type ShadowDiff,type ShadowReport,type PublicShadowRun,type ShadowRunsView,
  type MetricKey,type MetricValue,type MetricsView} from './evaluation.js';
export {jobStatusSchema,jobKindSchema,workerIdSchema,jobErrorCodeSchema,enqueueJobSchema,publicJobSchema,
  claimedJobSchema,queueDepthSchema,jobsViewSchema,deadLetterViewSchema,retryResultSchema,
  type JobStatus,type EnqueueJob,type PublicJob,type ClaimedJob,type QueueDepth,type JobsView} from './jobs.js';

export {goalPrioritySchema,goalChangeKindSchema,goalPriorityHistoryEntrySchema,temporaryOverrideSchema,goalContradictionFlagSchema,
  goalSchema,goalsViewSchema,createGoalSchema,goalPriorityChangeSchema,goalPriorityChangeResultSchema,DECISION_FRAME_TYPE,
  DECISION_REVIEW_CONTRACT,recordDecisionSchema,decisionProjectionRowSchema,decisionProjectionViewSchema,decisionSourceSchema,
  decisionRationaleItemSchema,decisionRationaleSchema,decisionReviewInputSchema,predictionComparisonSchema,
  recordDecisionResultSchema,decisionDetailSchema,decisionReviewResultSchema,mentorGroundSchema,mentorEvidenceSchema,
  mentorInferenceSchema,mentorRecommendationSchema,mentorCardSchema,mentorViewSchema,
  type GoalPriority,type GoalPriorityHistoryEntry,type TemporaryOverride,type Goal,type GoalsView,type CreateGoal,
  type GoalPriorityChange,type RecordDecision,type DecisionProjectionRow,type DecisionProjectionView,type DecisionSource,
  type DecisionRationaleItem,type DecisionRationale,type DecisionReviewInput,type PredictionComparison,type DecisionDetail,
  type DecisionReviewResult,type MentorGround,type MentorCard,type MentorView} from './decisions.js';
export {actionKindSchema,externalActionKindSchema,actionStageSchema,ACTION_STAGE_LABELS,actionHistoryEntrySchema,
  actionHistoryViewSchema,actionBasisSchema,draftKindSchema,DRAFT_CAPABILITY,draftContentSchema,createDraftSchema,
  draftStatusSchema,publicDraftSchema,draftsViewSchema,draftDecisionSchema,executeActionSchema,
  recommendationStatusSchema,recommendationResponseSchema,createRecommendationSchema,publicRecommendationSchema,
  recommendationsViewSchema,respondRecommendationSchema,toolReceiptSchema,observedActionSchema,
  pluginCapabilityAccessSchema,publicPluginCapabilitySchema,setPluginCapabilitiesSchema,
  retentionRuleSchema,retentionUpdateSchema,domainSensitivityEntrySchema,
  domainSensitivityUpdateSchema,dataRequestSummarySchema,permissionsViewSchema,exportRequestSchema,
  exportEvidenceSchema,exportBundleSchema,deletionRequestSchema,deletionPreviewRequestSchema,cascadeCountsSchema,
  deletionReceiptSchema,retentionCleanupSchema,regenerateEmbeddingsSchema,regenerationReceiptSchema,
  type ActionKind,type ExternalActionKind,type ActionStage,type ActionHistoryEntry,type ActionHistoryView,
  type ActionBasis,type CreateDraft,type PublicDraft,type ExecuteAction,type CreateRecommendation,
  type PublicRecommendation,type ToolReceipt,type PublicPluginCapability,type RetentionRule,
  type PermissionsView,type ExportBundle,type CascadeCounts,type DeletionReceipt} from './control.js';
export { agingKindSchema, freshnessStateSchema, freshnessPrecisionSchema, agingPolicySchema, agingPolicyBindingSchema,
  freshnessEvidenceSchema, freshnessAssessmentSchema, type AgingKind, type FreshnessState, type AgingPolicy,
  type AgingPolicyBinding, type FreshnessEvidence, type FreshnessAssessment } from './aging.js';
export { initiativeSettingsInputSchema, initiativeSettingsSchema, initiativeWatchInputSchema, initiativeWatchPatchSchema,
  initiativeWatchSchema, initiativeNoticeSchema, type InitiativeSettings, type InitiativeWatch } from './initiative.js';
export {RUNBOOK_IDS,V0_CI_STAGES,operationsReportSchema,evaluateV0Release,type OperationsReport} from './operations.js';
