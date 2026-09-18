/** `@unai/extraction` — triage and bounded extraction.
 *
 * Two services, in the order they must happen:
 *
 *  - **Triage** (PRD §36.2): Tier-0 deterministic parsing and Tier-1 routing,
 *    both pure and model-free, recorded for every ingested item before anything
 *    deep runs.
 *  - **Extraction** (PRD §36.3): one run per attempt, producing span-anchored
 *    claims through the `@unai/model` gateway, pinned to the registry release,
 *    normalization, entity-resolver and temporal-resolver versions it used.
 *
 * Neither writes a belief. Extraction produces claims with
 * `claim_origin = MODEL_EXTRACTION` and no proposition; admitting one is the
 * Belief Transaction service's work.
 */
export { TIER0_PARSER_VERSION, TIER1_ROUTER_VERSION, ROUTE_COST_BUDGET_MICROUNITS,
  splitQuotedHistory, parseTier0, routeTier1, triage,
  type TriageInput, type TriageResult } from './triage.js';
export { recordTriageDecision, readTriageDecision, publicTriage, type RecordTriageInput } from './store.js';
export { EXTRACTION_PROMPT_VERSION, EXTRACTION_PURPOSES, ExtractionError, runExtraction, readExtractionRun,
  buildExtractionInput, resolveExtractedSpan,
  type ExtractionRequest, type ExtractionResult, type ExtractionTransaction,
  type ExtractionTransactionRunner, type StoredAnchor } from './runs.js';
export { EXTRACTION_JOB_KIND, extractionJobPayloadSchema, createExtractionJobHandler,
  type ExtractionJobPayload } from './worker.js';
