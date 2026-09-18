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
export {tier1RouteSchema,tier1SignalSchema,routingReasonSchema,tier0ParseSchema,triageDecisionSchema,publicTriageSchema,
  extractionRunKindSchema,extractionRunStatusSchema,extractionRunSchema,extractedSpanSchema,extractedClaimSchema,
  extractionOutputSchema,modelCallOutcomeSchema,modelCallRecordSchema,DEEP_EXTRACTION_ROUTES,
  type Tier1Route,type Tier1Signal,type RoutingReason,type Tier0Parse,type TriageDecision,
  type ExtractionRun,type ExtractedClaim,type ExtractionOutput,type ModelCallRecord} from './extraction.js';
export {objectRefSchema,beliefTransactionKindSchema,beliefTransactionStatusSchema,writeRiskSchema,admissionModeSchema,
  autoAcceptConditionSchema,assessmentStatusSchema,supportKindSchema,independenceGroupSchema,beliefOperationKindSchema,
  beliefOperationSchema,proposeBeliefTransactionSchema,policyPortSchema,writePolicyOutcomeSchema,readPolicyOutcomeSchema,
  actionPolicyOutcomeSchema,policyVerdictSchema,validationDecisionSchema,validationReportSchema,commitReceiptSchema,
  type ObjectRef,type AdmissionMode,type AutoAcceptCondition,type AssessmentStatus,type BeliefOperation,
  type ProposeBeliefTransaction,type PolicyVerdict,type ValidationReport,type CommitReceipt} from './governance.js';
export {jobStatusSchema,jobKindSchema,workerIdSchema,jobErrorCodeSchema,enqueueJobSchema,publicJobSchema,
  claimedJobSchema,queueDepthSchema,jobsViewSchema,deadLetterViewSchema,retryResultSchema,
  type JobStatus,type EnqueueJob,type PublicJob,type ClaimedJob,type QueueDepth,type JobsView} from './jobs.js';

