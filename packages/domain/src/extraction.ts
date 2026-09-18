import { z } from 'zod';
import { sourceAnchorKindSchema } from './sources.js';

/** Triage, extraction and model-call vocabularies (PRD §20, §22.1, §36.2, §36.3).
 *
 * Schemas only, as every file in this package. Nothing here calls a model, reads
 * a database or names a provider: the provider a deployment happens to use is a
 * configuration value in `@unai/model`, so swapping it changes no file here
 * (CRT-NFR-06-A).
 */

const version = z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/);
const registryId = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
const confidence = z.number().min(0).max(1);
/** Cost in millionths of the billing unit, as an integer: money is never a float. */
const microunits = z.int().min(0).max(1_000_000_000_000);

// --- Tier 1 routing --------------------------------------------------------

/** The five routes of PRD §20.2, and no sixth. A route is required for every
 * ingested item, so this enum is the whole answer space (CRT-WRT-07-A). */
export const tier1RouteSchema = z.enum([
  'SOURCE_ONLY', 'INDEX_ONLY', 'ENTITY_EXTRACTION', 'FULL_EXTRACTION', 'DEFER_UNTIL_RELEVANT',
]);
export type Tier1Route = z.infer<typeof tier1RouteSchema>;

/** The routes that admit a deep extraction run. INDEX_ONLY and SOURCE_ONLY never
 * do; DEFER_UNTIL_RELEVANT admits one only when something later asks for it,
 * which is a TARGETED run rather than the scheduled path. */
export const DEEP_EXTRACTION_ROUTES: readonly Tier1Route[] = Object.freeze(['ENTITY_EXTRACTION', 'FULL_EXTRACTION']);

/** Named signals of PRD §20.2, positive and negative. A reason carries the
 * signals that actually fired, so "why was this held back" is answerable from
 * the row rather than from the router's source. */
export const tier1SignalSchema = z.enum([
  'USER_AUTHORED', 'AMOUNT', 'DEADLINE', 'COMMITMENT', 'DECISION', 'CORRECTION', 'PREFERENCE',
  'STATE_TRANSITION', 'SCHEDULED_EVENT', 'KNOWN_PARTICIPANT', 'FUTURE_ACTIONABILITY',
  'NEWSLETTER', 'ROUTINE_AUTOMATED_NOTIFICATION', 'LOW_VALUE_CI_NOISE', 'REPEATED_QUOTED_HISTORY',
  'SIGNATURE_ONLY', 'NO_EXTRACTABLE_TEXT', 'LAZY_DOCUMENT',
]);
export type Tier1Signal = z.infer<typeof tier1SignalSchema>;

/** Why a route was chosen. `code` is required by the database CHECK as well, so a
 * route can never be recorded without a reason. */
export const routingReasonSchema = z.strictObject({
  code: z.enum([
    'NEWSLETTER', 'ROUTINE_CI_NOTIFICATION', 'REPEATED_QUOTED_HISTORY', 'NO_NEW_CONTENT',
    'STRUCTURED_SOURCE_FIELDS', 'MEMORY_WORTHY_SIGNALS', 'PARTICIPANTS_ONLY',
    'LAZY_DOCUMENT_EXTRACTION', 'TIER1_ROUTER_UNAVAILABLE',
  ]),
  routerVersion: version,
  positiveSignals: z.array(tier1SignalSchema).max(32),
  negativeSignals: z.array(tier1SignalSchema).max(32),
  /** Bytes of novel text the route was decided over: quoted history excluded. */
  newContentLength: z.int().min(0),
});
export type RoutingReason = z.infer<typeof routingReasonSchema>;

/** Tier 0: the structure the source itself provides, with no model call at all
 * (PRD §20.1). Fields absent from a given source type are simply absent. */
export const tier0ParseSchema = z.strictObject({
  parserVersion: version,
  sourceType: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
  externalId: z.string().min(1).max(512),
  parentExternalId: z.string().min(1).max(512).nullable(),
  threadExternalId: z.string().min(1).max(512).nullable(),
  occurredAt: z.iso.datetime({ offset: true }).nullable(),
  participants: z.array(z.string().min(1).max(512)).max(64),
  subject: z.string().max(4096).nullable(),
  /** Text with quoted history and signature blocks removed. */
  newText: z.string().max(200000),
  quotedTextLength: z.int().min(0),
  automated: z.boolean(),
  structuredFields: z.record(z.string().min(1).max(64), z.json()),
});
export type Tier0Parse = z.infer<typeof tier0ParseSchema>;

/** The triage decision as a reader sees it, including on the evidence read. */
export const triageDecisionSchema = z.strictObject({
  triageDecisionId: z.uuid(),
  sourceItemId: z.uuid(),
  tier1Route: tier1RouteSchema,
  routingReason: routingReasonSchema,
  costBudgetMicrounits: microunits,
  decidedAt: z.iso.datetime(),
});
export type TriageDecision = z.infer<typeof triageDecisionSchema>;

/** What `GET /v1/evidence/{id}` adds once triage exists: route and reason only.
 * The Tier-0 parse is not part of the public read — it restates payload content
 * the evidence read already governs through its own anchors. */
export const publicTriageSchema = z.strictObject({
  tier1Route: tier1RouteSchema,
  routingReason: routingReasonSchema,
  decidedAt: z.iso.datetime(),
});

// --- Extraction runs -------------------------------------------------------

export const extractionRunKindSchema = z.enum(['LAZY', 'TARGETED', 'SHADOW', 'FULL']);
export const extractionRunStatusSchema = z.enum(['RUNNING', 'SUCCEEDED', 'FAILED']);

/** Every version an extraction run is reproducible from (CRT-WRT-08-A). */
export const extractionRunSchema = z.strictObject({
  extractionRunId: z.uuid(),
  sourceItemId: z.uuid(),
  triageDecisionId: z.uuid(),
  runKind: extractionRunKindSchema,
  modelProvider: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/).nullable(),
  modelId: z.string().min(1).max(128).nullable(),
  promptVersion: version.nullable(),
  registryReleaseId: z.uuid(),
  normalizationVersion: version,
  entityResolverVersion: version,
  temporalResolverVersion: version,
  status: extractionRunStatusSchema,
  costMicrounits: microunits.nullable(),
  latencyMs: z.int().min(0).nullable(),
  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
  errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).nullable(),
});
export type ExtractionRun = z.infer<typeof extractionRunSchema>;

// --- Model output ----------------------------------------------------------

/** Where an extracted statement was read from. The span is a half-open range over
 * the parent anchor's normalized text, so it can be checked against stored
 * evidence rather than believed (CRT-EVD-06-A). */
export const extractedSpanSchema = z.strictObject({
  anchorKind: sourceAnchorKindSchema,
  /** The parser-derived anchor this span lies inside. */
  parentAnchor: z.record(z.string(), z.json()),
  start: z.int().min(0),
  end: z.int().min(0),
  quote: z.string().min(1).max(8192),
});

/** One surface frame the extractor proposes. It is a *claim*, never an accepted
 * belief: the extraction service writes it with `claim_origin = MODEL_EXTRACTION`
 * and no proposition, and only a Belief Transaction may admit it (PRD §19.1). */
export const extractedClaimSchema = z.strictObject({
  frameTypeId: registryId,
  statement: z.string().min(1).max(4096),
  span: extractedSpanSchema,
  extractionConfidence: confidence,
  /** A time phrase exactly as the source wrote it, for the temporal resolver.
   * The extractor never resolves it to an instant itself. */
  temporalExpression: z.string().min(1).max(512).nullable(),
  participants: z.array(z.string().min(1).max(512)).max(16),
});
export type ExtractedClaim = z.infer<typeof extractedClaimSchema>;

/** The contract a model response must satisfy to become claims. Strict on
 * purpose: an unknown key is a contract violation, and a violating response is
 * rejected whole rather than half-stored (CRT-NFR-06-A). */
export const extractionOutputSchema = z.strictObject({
  claims: z.array(extractedClaimSchema).max(64),
  unknowns: z.array(z.string().min(1).max(512)).max(32).default([]),
});
export type ExtractionOutput = z.infer<typeof extractionOutputSchema>;

// --- Model call accounting -------------------------------------------------

export const modelCallOutcomeSchema = z.enum(['SUCCEEDED', 'OUTPUT_REJECTED', 'PROVIDER_FAILED']);

/** One row per model call, with no prompt text, no provider message and no
 * secret value — only what cost accounting and audit need (CRT-NFR-06-A). */
export const modelCallRecordSchema = z.strictObject({
  modelCallRecordId: z.uuid(),
  purpose: z.string().regex(/^[a-z][a-z0-9_.:-]{0,63}$/),
  modelProvider: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/),
  modelId: z.string().min(1).max(128),
  promptVersion: version,
  costMicrounits: microunits,
  latencyMs: z.int().min(0),
  correlationId: z.uuid(),
  outcome: modelCallOutcomeSchema,
  createdAt: z.iso.datetime(),
});
export type ModelCallRecord = z.infer<typeof modelCallRecordSchema>;
