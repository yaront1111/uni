import { z } from 'zod';
import { dataPurposeSchema, sensitivitySchema } from './evidence.js';
import { actionRiskSchema } from './context.js';
import { capabilityIdSchema, connectorStatusSchema, connectorTypeSchema } from './connectors.js';
import { attentionBudgetSchema } from './review.js';

/**
 * Governed action and the data-control surface (PRD §7.8, §8.4, §27, §29.3,
 * §30.7, §60; design entities `drafts`, `recommendation_artifacts`,
 * `action_history`, `memory_summaries` and `retention_and_deletion_requests`;
 * ADR 0030). The attention budget shown on the Permissions surface is the
 * memory inbox's own (`./review.js`, ADR 0029).
 *
 * Schemas only. The rules they carry: an action-history entry is exactly one of
 * six stages, a draft is a Uai artifact that is never executed, a recommendation
 * is RECOMMENDED and never user intent, and every external write but a draft is
 * refused in V0.
 */

const uuid = z.uuid();
const instant = z.iso.datetime({ offset: true });
const reasonCode = z.string().regex(/^[A-Z][A-Z0-9_]{0,95}$/);

// ---------------------------------------------------------------------------
// Actions

/** What an action does. `OTHER` is a recommendation that proposes no action. */
export const actionKindSchema = z.enum(['DRAFT', 'EMAIL_SEND', 'CALENDAR_CREATE', 'CALENDAR_UPDATE',
  'MONEY_MOVEMENT', 'TRADE', 'OTHER']);
export type ActionKind = z.infer<typeof actionKindSchema>;
/** The external actions `POST /v1/actions/execute` names. V0 refuses every one. */
export const externalActionKindSchema = z.enum(['EMAIL_SEND', 'CALENDAR_CREATE', 'CALENDAR_UPDATE',
  'MONEY_MOVEMENT', 'TRADE']);
export type ExternalActionKind = z.infer<typeof externalActionKindSchema>;

/** The six labels of the Action history screen (PRD §37.8). One column, so an
 * entry is exactly one of them (CRT-UX-13-A). */
export const actionStageSchema = z.enum(['OBSERVED', 'SUGGESTED', 'DRAFTED', 'REQUESTED_APPROVAL', 'EXECUTED',
  'RECEIVED_CONFIRMATION']);
export type ActionStage = z.infer<typeof actionStageSchema>;
export const ACTION_STAGE_LABELS: Readonly<Record<ActionStage, string>> = Object.freeze({
  OBSERVED: 'observed', SUGGESTED: 'suggested', DRAFTED: 'drafted', REQUESTED_APPROVAL: 'requested approval',
  EXECUTED: 'executed', RECEIVED_CONFIRMATION: 'received confirmation',
});

export const actionHistoryEntrySchema = z.strictObject({
  entryId: uuid,
  stage: actionStageSchema,
  label: z.enum(['observed', 'suggested', 'drafted', 'requested approval', 'executed', 'received confirmation']),
  actionKind: actionKindSchema,
  subject: z.strictObject({ objectType: z.enum(['recommendation', 'draft', 'evidence']), objectId: uuid }),
  recommendationId: uuid.nullable(),
  policyDecisionId: uuid.nullable(),
  /** The authoritative receipt behind an EXECUTED or RECEIVED_CONFIRMATION entry. */
  receiptEvidenceId: uuid.nullable(),
  createdAt: instant,
}).refine(entry => entry.label === ACTION_STAGE_LABELS[entry.stage], { message: 'ACTION_LABEL_MISMATCH' })
  .refine(entry => !['EXECUTED', 'RECEIVED_CONFIRMATION'].includes(entry.stage) || entry.receiptEvidenceId !== null,
    { message: 'EXECUTION_REQUIRES_RECEIPT' })
  .refine(entry => entry.subject.objectType !== 'draft' || ['DRAFTED', 'REQUESTED_APPROVAL'].includes(entry.stage),
    { message: 'DRAFT_NEVER_EXECUTED' });
export type ActionHistoryEntry = z.infer<typeof actionHistoryEntrySchema>;
export const actionHistoryViewSchema = z.strictObject({ entries: z.array(actionHistoryEntrySchema).max(500) });
export type ActionHistoryView = z.infer<typeof actionHistoryViewSchema>;

/** The memory an action or recommendation rests on, asked of the Context Broker. */
export const actionBasisSchema = z.strictObject({
  query: z.string().trim().min(1).max(2000),
  entityHints: z.array(uuid).max(64).default([]),
  frameTypeHints: z.array(z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/)).max(32).default([]),
});
export type ActionBasis = z.infer<typeof actionBasisSchema>;

export const draftKindSchema = z.enum(['EMAIL', 'CALENDAR_EVENT']);
/** The draft capability of each draft kind (ADR 0030 §2). */
export const DRAFT_CAPABILITY: Readonly<Record<z.infer<typeof draftKindSchema>, string>> = Object.freeze({
  EMAIL: 'gmail.create_draft', CALENDAR_EVENT: 'calendar.create_draft',
});
export const draftContentSchema = z.strictObject({
  subject: z.string().max(500).nullable().default(null),
  body: z.string().min(1).max(20000),
  recipients: z.array(z.string().min(1).max(320)).max(50).default([]),
  startsAt: instant.nullable().default(null),
  endsAt: instant.nullable().default(null),
});
export const createDraftSchema = z.strictObject({
  draftKind: draftKindSchema,
  capabilityId: capabilityIdSchema,
  content: draftContentSchema,
  /** The data purpose the draft declares: the evidence it rests on must admit it. */
  purpose: dataPurposeSchema,
  basis: actionBasisSchema,
  actionRisk: actionRiskSchema,
  maximumSensitivity: sensitivitySchema,
  recommendationId: uuid.nullable().default(null),
});
export type CreateDraft = z.infer<typeof createDraftSchema>;
export const draftStatusSchema = z.enum(['CREATED', 'AWAITING_APPROVAL', 'APPROVED', 'DISCARDED']);
export const publicDraftSchema = z.strictObject({
  draftId: uuid,
  draftKind: draftKindSchema,
  capabilityId: capabilityIdSchema,
  content: draftContentSchema,
  status: draftStatusSchema,
  /** Always a draft artifact. A draft is never recorded as an external action. */
  recordedAs: z.literal('DRAFT_ARTIFACT'),
  recommendationId: uuid.nullable(),
  supportingPacketId: uuid,
  policyDecisionId: uuid,
  createdAt: instant,
  updatedAt: instant,
});
export type PublicDraft = z.infer<typeof publicDraftSchema>;
export const draftsViewSchema = z.strictObject({ drafts: z.array(publicDraftSchema).max(200) });
export const draftDecisionSchema = z.strictObject({ decision: z.enum(['REQUEST_APPROVAL', 'APPROVE', 'DISCARD']) });

export const executeActionSchema = z.strictObject({
  actionKind: externalActionKindSchema,
  subjectRef: z.strictObject({ objectType: z.enum(['recommendation', 'draft']), objectId: uuid }).nullable().default(null),
  approvalRef: z.string().min(1).max(200).nullable().default(null),
  purpose: dataPurposeSchema,
  actionRisk: actionRiskSchema,
});
export type ExecuteAction = z.infer<typeof executeActionSchema>;

export const recommendationStatusSchema = z.enum(['ACTIVE', 'BLOCKED']);
export const recommendationResponseSchema = z.enum(['NONE', 'ACCEPTED_AS_INTENT_TO_PREPARE', 'DISMISSED', 'SNOOZED']);
export const createRecommendationSchema = z.strictObject({
  recommendationText: z.string().trim().min(1).max(2000),
  recommendedActionKind: actionKindSchema,
  actionRisk: actionRiskSchema,
  recommendedPropositionId: uuid.nullable().default(null),
  purpose: dataPurposeSchema,
  basis: actionBasisSchema,
  maximumSensitivity: sensitivitySchema,
});
export type CreateRecommendation = z.infer<typeof createRecommendationSchema>;
export const publicRecommendationSchema = z.strictObject({
  recommendationId: uuid,
  /** Stored as a recommendation, never as user intent, a claim or a fact. */
  semantics: z.literal('RECOMMENDED'),
  recommendationText: z.string(),
  recommendedActionKind: actionKindSchema,
  actionRisk: actionRiskSchema,
  recommendedPropositionId: uuid.nullable(),
  supportingPacketId: uuid.nullable(),
  /** The evidence behind it, listed apart from the inference and the recommendation. */
  supportingEvidenceIds: z.array(uuid).max(200),
  supportingAssessment: z.enum(['ACCEPTED', 'PROVISIONAL', 'CONTESTED', 'NONE']),
  projectionComplete: z.boolean(),
  status: recommendationStatusSchema,
  blockedReason: reasonCode.nullable(),
  requiresConfirmation: z.boolean(),
  policyDecisionId: uuid.nullable(),
  userResponse: recommendationResponseSchema,
  responseEvidenceId: uuid.nullable(),
  respondedAt: instant.nullable(),
  /** True only when an authoritative receipt has been ingested for it. */
  executionReceipted: z.boolean(),
  createdAt: instant,
});
export type PublicRecommendation = z.infer<typeof publicRecommendationSchema>;
export const recommendationsViewSchema = z.strictObject({ recommendations: z.array(publicRecommendationSchema).max(200) });
export const respondRecommendationSchema = z.strictObject({
  response: z.enum(['ACCEPTED_AS_INTENT_TO_PREPARE', 'DISMISSED', 'SNOOZED']),
  /** The owner's own words, stored verbatim as evidence. Required to accept. */
  rawText: z.string().trim().min(1).max(4000).nullable().default(null),
  dataPurpose: dataPurposeSchema,
  sensitivity: sensitivitySchema.default('PRIVATE'),
}).refine(body => body.response !== 'ACCEPTED_AS_INTENT_TO_PREPARE' || body.rawText !== null,
  { message: 'ACCEPTANCE_NEEDS_OWNER_WORDS' });

/** An authoritative external tool receipt: the only way an execution fact enters memory. */
export const toolReceiptSchema = z.strictObject({
  toolId: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/),
  actionKind: externalActionKindSchema,
  stage: z.enum(['EXECUTED', 'RECEIVED_CONFIRMATION']),
  externalActionRef: z.string().min(1).max(256),
  receipt: z.record(z.string(), z.unknown()),
  recommendationId: uuid.nullable().default(null),
  occurredAt: instant.nullable().default(null),
  dataPurpose: dataPurposeSchema,
  sensitivity: sensitivitySchema.default('PRIVATE'),
});
export type ToolReceipt = z.infer<typeof toolReceiptSchema>;
export const observedActionSchema = z.strictObject({ evidenceId: uuid, actionKind: actionKindSchema });

// ---------------------------------------------------------------------------
// Permissions and integrations

export const pluginCapabilityAccessSchema = z.enum(['DRAFT', 'WRITE']);
export const publicPluginCapabilitySchema = z.strictObject({
  capabilityId: capabilityIdSchema,
  description: z.string().max(500),
  access: pluginCapabilityAccessSchema,
  riskClass: z.enum(['LOW', 'MEDIUM', 'HIGH']),
  /** False for every external write: V0 lists it and refuses it (CRT-CON-08-A). */
  grantable: z.boolean(),
  granted: z.boolean(),
  grantedAt: instant.nullable(),
  revokedAt: instant.nullable(),
});
export type PublicPluginCapability = z.infer<typeof publicPluginCapabilitySchema>;
export const setPluginCapabilitiesSchema = z.strictObject({
  capabilities: z.array(z.strictObject({ capabilityId: capabilityIdSchema, granted: z.boolean() })).min(1).max(16),
});

const retentionDays = z.number().int().min(1).max(36500).nullable();
export const retentionRuleSchema = z.strictObject({
  sourceType: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
  /** Null keeps raw evidence until the owner deletes it. */
  rawRetentionDays: retentionDays,
  derivedRetentionDays: retentionDays,
  updatedAt: instant.nullable(),
});
export type RetentionRule = z.infer<typeof retentionRuleSchema>;
export const retentionUpdateSchema = z.strictObject({
  rules: z.array(z.strictObject({
    sourceType: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
    rawRetentionDays: retentionDays,
    derivedRetentionDays: retentionDays,
  })).min(1).max(32),
});

export const domainSensitivityEntrySchema = z.strictObject({
  sourceType: connectorTypeSchema,
  /** The connector manifest's declared default. */
  defaultSensitivity: sensitivitySchema,
  /** What the next stored item of this source type is stored at. */
  effectiveSensitivity: sensitivitySchema,
  ownerSetting: sensitivitySchema.nullable(),
  updatedAt: instant.nullable(),
});
export const domainSensitivityUpdateSchema = z.strictObject({
  mappings: z.array(z.strictObject({ sourceType: connectorTypeSchema, sensitivity: sensitivitySchema })).min(1).max(8),
});

export const dataRequestSummarySchema = z.strictObject({
  requestId: uuid,
  requestKind: z.enum(['EXPORT', 'SUPPRESS', 'ARCHIVE', 'DELETE']),
  trigger: z.enum(['OWNER_REQUEST', 'RETENTION_POLICY']),
  status: z.enum(['COMPLETED', 'FAILED']),
  requestedAt: instant,
  completedAt: instant.nullable(),
});

export const permissionsViewSchema = z.strictObject({
  connectedSources: z.array(z.strictObject({
    connectorId: uuid,
    connectorType: connectorTypeSchema,
    displayName: z.string(),
    status: connectorStatusSchema,
    readScopes: z.array(z.string()),
    /** Always empty in V0: no connector holds a write scope. */
    writeScopes: z.array(z.string()).max(0),
    grantedCapabilities: z.array(capabilityIdSchema),
  })).max(100),
  domainSensitivity: z.array(domainSensitivityEntrySchema),
  pluginCapabilities: z.array(publicPluginCapabilitySchema),
  attentionBudget: attentionBudgetSchema,
  retention: z.array(retentionRuleSchema),
  dataRequests: z.array(dataRequestSummarySchema).max(20),
});
export type PermissionsView = z.infer<typeof permissionsViewSchema>;

// ---------------------------------------------------------------------------
// Export and deletion

export const exportRequestSchema = z.strictObject({
  scope: z.literal('ALL').default('ALL'),
  includeRawEvidence: z.boolean().default(true),
});
const row = z.record(z.string(), z.unknown());
export const exportEvidenceSchema = z.strictObject({
  evidenceId: uuid,
  sourceType: z.string(),
  connectorId: uuid.nullable(),
  externalId: z.string(),
  parentExternalId: z.string().nullable(),
  actorRef: row,
  occurredAt: instant.nullable(),
  observedAt: instant,
  contentHash: z.string(),
  sensitivity: sensitivitySchema,
  allowedPurposes: z.array(z.string()),
  deterministicMetadata: row,
  anchors: z.array(z.strictObject({ kind: z.string(), anchor: row, normalizedText: z.string().nullable() })),
  /** The raw bytes, base64. Null when the owner asked for metadata only. */
  rawContentBase64: z.string().nullable(),
});
export const exportBundleSchema = z.strictObject({
  exportId: uuid,
  formatVersion: z.literal('unai-export-0.1.0'),
  ownerScopeId: uuid,
  generatedAt: instant,
  evidence: z.array(exportEvidenceSchema),
  canonicalMemory: z.strictObject({
    entities: z.array(row), entityAliases: z.array(row), frameInstances: z.array(row), frameInstanceRoles: z.array(row),
    beliefSlots: z.array(row), propositions: z.array(row), claims: z.array(row), beliefAssessments: z.array(row),
    beliefSupport: z.array(row), claimRelations: z.array(row), resolutionAssertions: z.array(row),
    memoryLinks: z.array(row), memoryThreads: z.array(row), memoryThreadMembers: z.array(row),
    derivedPropositionDependencies: z.array(row), memorySummaries: z.array(row),
  }),
  actions: z.strictObject({ recommendations: z.array(row), drafts: z.array(row), actionHistory: z.array(row) }),
  counts: z.record(z.string(), z.number().int().min(0)),
});
export type ExportBundle = z.infer<typeof exportBundleSchema>;

export const deletionRequestSchema = z.strictObject({
  evidenceIds: z.array(uuid).min(1).max(50),
  /** The owner types the word: a deletion is never one accidental click. */
  confirmation: z.literal('DELETE'),
});
export const deletionPreviewRequestSchema = z.strictObject({ evidenceIds: z.array(uuid).min(1).max(50) });
/** What a deletion removed, as counts: never a value, an excerpt or a key. */
export const cascadeCountsSchema = z.strictObject({
  rawObjects: z.number().int().min(0),
  parsedContent: z.number().int().min(0),
  anchors: z.number().int().min(0),
  claims: z.number().int().min(0),
  unsupportedBeliefs: z.number().int().min(0),
  beliefAssessments: z.number().int().min(0),
  supportRows: z.number().int().min(0),
  resolutionAssertions: z.number().int().min(0),
  links: z.number().int().min(0),
  embeddings: z.number().int().min(0),
  summaries: z.number().int().min(0),
  searchIndexEntries: z.number().int().min(0),
  projectionRows: z.number().int().min(0),
  threadMemberships: z.number().int().min(0),
  aliases: z.number().int().min(0),
  extractionRuns: z.number().int().min(0),
  overlayTextsErased: z.number().int().min(0),
  transactionPayloadsErased: z.number().int().min(0),
  contextPacketsErased: z.number().int().min(0),
  /** Briefings, clarification cards, weekly reviews and observations that
   * named a removed object. */
  derivedRecords: z.number().int().min(0),
});
export type CascadeCounts = z.infer<typeof cascadeCountsSchema>;
export const deletionReceiptSchema = z.strictObject({
  requestId: uuid.nullable(),
  status: z.enum(['PREVIEW', 'COMPLETED']),
  trigger: z.enum(['OWNER_REQUEST', 'RETENTION_POLICY']),
  evidenceIds: z.array(uuid),
  cascade: cascadeCountsSchema,
  /** Every typed projection replayed from canonical memory afterwards. */
  projectionsRebuilt: z.array(z.string()),
  /** The audit event names identifiers and field names, never content. */
  auditRetainsPayload: z.literal(false),
});
export type DeletionReceipt = z.infer<typeof deletionReceiptSchema>;
export const retentionCleanupSchema = z.strictObject({ asOf: instant.nullable().default(null) });
/** Drop the owner's semantic index, rebuild it from canonical memory, or both. */
export const regenerateEmbeddingsSchema = z.strictObject({
  dropExisting: z.boolean().default(false),
  regenerate: z.boolean().default(true),
});
export const regenerationReceiptSchema = z.strictObject({
  dropped: z.number().int().min(0),
  indexed: z.number().int().min(0),
  skipped: z.number().int().min(0),
  embeddingModel: z.string(),
  embeddingVersion: z.string(),
});
