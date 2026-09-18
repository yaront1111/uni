import { z } from 'zod';
import { dataPurposeSchema, sensitivitySchema } from './evidence.js';
import { lifeCategorySchema } from './context.js';

/**
 * Connectors, their manifests and their capability grants (PRD §27, §33.2;
 * design entities `connectors` and `connector_capability_grants`).
 *
 * Schemas only, as every file in this package. The permission model they encode
 * is the one rule the rest of the slice is built to obey: a capability is a
 * discrete named thing with its own risk classification, and a grant is one row
 * per capability, so `gmail.read_metadata` being granted says nothing whatever
 * about `gmail.read_content` (CRT-CON-07-A).
 */

export const capabilityIdSchema = z.string().regex(/^[a-z][a-z0-9_]{0,31}\.[a-z][a-z0-9_]{0,63}$/);
export const connectorTypeSchema = z.enum(['CONVERSATION', 'GMAIL', 'GOOGLE_CALENDAR', 'GITHUB', 'DOCUMENT']);
export type ConnectorType = z.infer<typeof connectorTypeSchema>;

/** The lifecycle the Connected sources screen draws. `TOKEN_REVOKED` is the
 * provider's answer and needs reauthorization; `DISCONNECTED` is the owner's own
 * instruction, after which no ingestion happens at all. */
export const connectorStatusSchema = z.enum([
  'PENDING_AUTHORIZATION', 'ACTIVE', 'SYNC_FAILED', 'TOKEN_REVOKED', 'DISCONNECTED']);
export type ConnectorStatus = z.infer<typeof connectorStatusSchema>;

/** PRD §27.1: each capability has an independent permission and risk
 * classification. `access` is the half that decides whether V0 may grant it at
 * all: every external write but draft creation is excluded (PRD §27.5). */
export const capabilityAccessSchema = z.enum(['READ', 'WRITE']);
export const capabilityRiskClassSchema = z.enum(['LOW', 'MEDIUM', 'HIGH']);

/**
 * The least-context profile of one capability (PRD §27.3).
 *
 * A plugin receives only the smallest context bundle its operation requires, so
 * the bundle's purpose, sensitivity ceiling, life-category view and excluded
 * categories are declared by the capability itself rather than chosen by the
 * caller. A work-email capability therefore cannot ask for health, family or
 * financial objects: the request it produces never admits them and the assembled
 * bundle drops any object that carries one of those categories (CRT-SEC-03-A).
 */
export const capabilityContextProfileSchema = z.strictObject({
  purpose: dataPurposeSchema,
  lifeCategory: lifeCategorySchema.nullable(),
  excludedLifeCategories: z.array(lifeCategorySchema).max(6),
  maximumSensitivity: sensitivitySchema,
  tokenBudget: z.number().int().min(256).max(200_000),
});
export type CapabilityContextProfile = z.infer<typeof capabilityContextProfileSchema>;

export const manifestCapabilitySchema = z.strictObject({
  capabilityId: capabilityIdSchema,
  description: z.string().min(1).max(240),
  access: capabilityAccessSchema,
  riskClass: capabilityRiskClassSchema,
  /** The provider scopes this capability needs. Every scope of a READ capability
   * of a V0 connector is a read-only scope, which is what the Gmail, Calendar and
   * GitHub criteria require of the consent handoff. */
  scopes: z.array(z.string().min(1).max(200)).max(8),
  contextProfile: capabilityContextProfileSchema,
});
export type ManifestCapability = z.infer<typeof manifestCapabilitySchema>;

/** PRD §27.2's minimum plugin manifest, as data rather than as a YAML file: the
 * runtime has to be able to list capabilities, refuse an ungranted one and show
 * the risk classification on the consent screen. */
export const connectorManifestSchema = z.strictObject({
  id: z.string().regex(/^connector\.[a-z][a-z0-9_]{0,63}$/),
  connectorType: connectorTypeSchema,
  version: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/),
  displayName: z.string().min(1).max(120),
  capabilities: z.array(manifestCapabilitySchema).min(1).max(32),
  sources: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/)).min(1).max(8),
  emits: z.array(z.enum(['SOURCE_ITEM'])).min(1).max(2),
  sensitivity: z.strictObject({ default: sensitivitySchema }),
  retention: z.strictObject({ raw: z.enum(['USER_CONFIGURABLE', 'FIXED']) }),
  /** Secret *names*, resolved through `@unai/secrets`. A manifest never carries a
   * credential and a connector row never carries anything but a handle. */
  requiredSecrets: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)).max(4),
  promptInjectionRisk: z.enum(['LOW', 'MEDIUM', 'HIGH']),
  /** The capability every sync of this connector needs before it reads anything. */
  minimumSyncCapability: capabilityIdSchema,
});
export type ConnectorManifest = z.infer<typeof connectorManifestSchema>;

export const connectorCursorSchema = z.strictObject({
  position: z.string().min(1).max(512),
  /** The provider's own paging token, kept verbatim so a resume asks the provider
   * the same question it answered last time. */
  providerToken: z.string().min(1).max(2048).nullable().default(null),
});
export type ConnectorCursor = z.infer<typeof connectorCursorSchema>;

export const connectCapabilityRequestSchema = z.strictObject({
  capabilityId: capabilityIdSchema,
  granted: z.boolean(),
});
export const createConnectorSchema = z.strictObject({
  connectorType: connectorTypeSchema,
  externalAccountRef: z.string().min(1).max(512),
  requestedCapabilities: z.array(connectCapabilityRequestSchema).max(32).default([]),
  /** A `secret://` handle, never a token. Absent for a first-party connector. */
  secretRef: z.string().min(1).max(512).nullable().default(null),
});
export type CreateConnector = z.infer<typeof createConnectorSchema>;

export const grantCapabilitiesSchema = z.strictObject({
  capabilities: z.array(connectCapabilityRequestSchema).min(1).max(32),
});

export const publicCapabilityGrantSchema = z.strictObject({
  capabilityId: capabilityIdSchema,
  description: z.string(),
  access: capabilityAccessSchema,
  riskClass: capabilityRiskClassSchema,
  scopes: z.array(z.string()),
  granted: z.boolean(),
  grantedAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
});
export type PublicCapabilityGrant = z.infer<typeof publicCapabilityGrantSchema>;

/** What the Connected sources screen reads. It carries the cursor *position*, so
 * a reader can see a second sync resumed where the first stopped, and it never
 * carries the secret handle, the provider token or a raw payload. */
export const publicConnectorSchema = z.strictObject({
  connectorId: z.uuid(),
  connectorType: connectorTypeSchema,
  manifestId: z.string(),
  manifestVersion: z.string(),
  displayName: z.string(),
  externalAccountRef: z.string(),
  status: connectorStatusSchema,
  promptInjectionRisk: z.enum(['LOW', 'MEDIUM', 'HIGH']),
  capabilities: z.array(publicCapabilityGrantSchema),
  grantedCapabilities: z.array(capabilityIdSchema),
  requestedScopes: z.array(z.string()),
  cursor: connectorCursorSchema.nullable(),
  cursorUpdatedAt: z.iso.datetime().nullable(),
  lastSyncError: z.string().nullable(),
  credentialHeld: z.boolean(),
  createdAt: z.iso.datetime(),
  disconnectedAt: z.iso.datetime().nullable(),
});
export type PublicConnector = z.infer<typeof publicConnectorSchema>;

export const syncModeSchema = z.enum(['INCREMENTAL', 'BACKFILL']);
export const syncRequestSchema = z.strictObject({
  mode: syncModeSchema.default('INCREMENTAL'),
  sensitivity: sensitivitySchema.default('PRIVATE'),
  allowedPurposes: z.array(dataPurposeSchema).min(1).max(32),
  /** Bound on how many provider pages one run consumes. */
  maxPages: z.number().int().min(1).max(20).default(1),
});
export type SyncRequest = z.infer<typeof syncRequestSchema>;

/** One item a run refused, with the reason. A refusal is reported rather than
 * silently skipped: an ungranted capability must be visible as a decision. */
export const syncRefusalSchema = z.strictObject({
  externalRef: z.string().min(1).max(512),
  code: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
  capabilityId: capabilityIdSchema.nullable(),
});

export const syncResultSchema = z.strictObject({
  syncRunId: z.uuid(),
  connectorId: z.uuid(),
  mode: syncModeSchema,
  /** What the request asked for, and what the run actually stored at. The second
   * is the stricter of the first and the manifest's declared default: the
   * default is a floor a request may raise and may not lower, and reporting both
   * makes a raised level visible instead of silent (PRD §7.8, §30.3). */
  requestedSensitivity: sensitivitySchema,
  storedSensitivity: sensitivitySchema,
  resumedFromCursor: connectorCursorSchema.nullable(),
  newCursor: connectorCursorSchema.nullable(),
  pagesFetched: z.number().int().min(0),
  itemsIngested: z.number().int().min(0),
  duplicatesSuppressed: z.number().int().min(0),
  /** GitHub commit and CI bursts aggregated into one episode each, rather than
   * one semantic extraction per event (PRD §20.5, CRT-CON-04-A). */
  episodesAggregated: z.number().int().min(0),
  aggregatedEvents: z.number().int().min(0),
  threadUpdatesApplied: z.number().int().min(0),
  recurrenceUpdatesApplied: z.number().int().min(0),
  evidenceIds: z.array(z.uuid()).max(2000),
  refusals: z.array(syncRefusalSchema).max(200),
});
export type SyncResult = z.infer<typeof syncResultSchema>;

export const disconnectResultSchema = z.strictObject({
  connectorId: z.uuid(),
  status: z.literal('DISCONNECTED'),
  tokensRevokedAtProvider: z.boolean(),
  secretReferenceDestroyed: z.boolean(),
  ingestionStopped: z.literal(true),
  capabilitiesRevoked: z.array(capabilityIdSchema),
  /** The already-stored evidence is kept: disconnecting stops ingestion and
   * deletes nothing (PRD §30.7). The count is deliberately absent — reading the
   * owner's evidence is an evidence purpose, and a consent operation does not
   * hold one — so the receipt states the disposition and the options instead. */
  retainedEvidence: z.literal('RETAINED'),
  /** What the owner may still choose after disconnecting; the deletion workflow
   * itself belongs to the export-and-deletion slice. */
  retainedEvidenceOptions: z.array(z.enum(['KEEP_EVIDENCE', 'REQUEST_DELETION'])),
});
export type DisconnectResult = z.infer<typeof disconnectResultSchema>;

/**
 * Document upload (design `POST /v1/documents`, PRD §20.5).
 *
 * `requestFullExtraction` is the user-requested trigger; the other three are
 * decided from the document itself and from the owner's memory, never guessed by
 * a model (CRT-CON-05-A).
 */
export const documentUploadSchema = z.strictObject({
  documentId: z.string().min(1).max(512),
  title: z.string().max(4096).nullable().default(null),
  mediaType: z.string().max(128).default('text/plain'),
  /** Extracted page text when the format carries text, else an empty list: an
   * unsupported format is stored as source-only evidence rather than refused. */
  pages: z.array(z.strictObject({ page: z.number().int().min(1), text: z.string().max(200_000) })).max(2048).default([]),
  /** Base64 of the original bytes, kept verbatim so the stored object is the
   * document the owner uploaded and not a reconstruction of it. */
  base64: z.string().max(1_400_000).nullable().default(null),
  sensitivity: sensitivitySchema,
  allowedPurposes: z.array(dataPurposeSchema).min(1).max(32),
  requestFullExtraction: z.boolean().default(false),
  /** The owner's own classification, shown on the Upload a document screen. */
  valueClassification: z.enum(['ORDINARY', 'HIGH_VALUE']).default('ORDINARY'),
  /** Memory threads or frame instances this upload belongs to, if the owner said
   * so on the upload screen. An active one makes the document workflow-related. */
  relatedThreadIds: z.array(z.uuid()).max(16).default([]),
  connectorId: z.uuid().nullable().default(null),
});
export type DocumentUpload = z.infer<typeof documentUploadSchema>;

export const extractionPlanReasonSchema = z.enum([
  'USER_REQUESTED', 'ACTIVE_WORKFLOW_RELATED', 'DEADLINE_BEARING', 'HIGH_VALUE',
  'NO_FULL_EXTRACTION_TRIGGER', 'UNSUPPORTED_FORMAT_STORED_AS_SOURCE_ONLY']);
export type ExtractionPlanReason = z.infer<typeof extractionPlanReasonSchema>;

export const documentReceiptSchema = z.strictObject({
  evidenceId: z.uuid(),
  ingestionStatus: z.literal('STORED'),
  /** Immediately true: the stored document's page text is indexed in the same
   * transaction that stores it, so it is findable before any extraction runs. */
  indexed: z.literal(true),
  indexedAnchors: z.number().int().min(0),
  searchable: z.literal(true),
  /** The level the upload was stored at: the stricter of what the request asked
   * for and the documents manifest's declared default. */
  storedSensitivity: sensitivitySchema,
  extractionPlan: z.enum(['DEFERRED', 'FULL']),
  extractionPlanReason: extractionPlanReasonSchema,
  triageRoute: z.string(),
  /** The queued extraction job, present only for a FULL plan. */
  extractionJobId: z.uuid().nullable(),
});
export type DocumentReceipt = z.infer<typeof documentReceiptSchema>;

export const documentSearchHitSchema = z.strictObject({
  evidenceId: z.uuid(),
  documentId: z.string(),
  title: z.string().nullable(),
  page: z.number().int().min(1).nullable(),
  /** A bounded excerpt of the owner's own document, from the stored anchor. */
  excerpt: z.string().max(400),
  occurredAt: z.iso.datetime().nullable(),
  observedAt: z.iso.datetime(),
  extractionPlan: z.enum(['DEFERRED', 'FULL', 'UNKNOWN']),
});
export const documentSearchResultSchema = z.strictObject({
  query: z.string(),
  hits: z.array(documentSearchHitSchema).max(50),
});
export type DocumentSearchResult = z.infer<typeof documentSearchResultSchema>;

/**
 * The least-context bundle one plugin operation receives (PRD §27.3).
 *
 * It is a *narrowed* context packet: the packet id it was derived from is kept,
 * so the read is auditable, and everything the capability's profile excludes is
 * listed in `withheld` rather than silently absent.
 */
export const bundleWithholdingSchema = z.strictObject({
  objectType: z.string(),
  objectId: z.string(),
  reason: z.enum(['LEAST_CONTEXT_CATEGORY_EXCLUDED', 'ABOVE_CAPABILITY_SENSITIVITY']),
  lifeCategories: z.array(lifeCategorySchema),
});
export const pluginContextBundleSchema = z.strictObject({
  packetId: z.uuid(),
  packetHash: z.string().regex(/^[a-f0-9]{64}$/),
  connectorId: z.uuid(),
  capabilityId: capabilityIdSchema,
  purpose: dataPurposeSchema,
  lifeCategory: lifeCategorySchema.nullable(),
  excludedLifeCategories: z.array(lifeCategorySchema),
  maximumSensitivity: sensitivitySchema,
  beliefs: z.array(z.object({}).loose()).max(200),
  futureClaims: z.array(z.object({}).loose()).max(200),
  evidenceRefs: z.array(z.object({}).loose()).max(200),
  allowedActions: z.array(z.string()).max(8),
  withheld: z.array(bundleWithholdingSchema).max(500),
});
export type PluginContextBundle = z.infer<typeof pluginContextBundleSchema>;
