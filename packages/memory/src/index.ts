/** `@unai/memory` -- canonical identity storage and its resolvers.
 *
 * The four stores this package delivers (PRD §36.4, §36.5, phase 1 deliverables):
 * the entity service with candidate lookup, aliases and the under-merge default;
 * the temporal resolver that records precision instead of inventing it; the slot
 * and proposition store with versioned lookup fingerprints; and the claim store
 * with its four separate confidences and AWAITING_INSTANCE_RESOLUTION state.
 *
 * Every function takes a `MemoryTransaction` its caller already opened inside the
 * owner boundary. Nothing here opens a connection, commits, audits, calls a model
 * or reaches the network, and nothing accepts an accepted-belief decision: that is
 * the belief transaction service's work, not this layer's.
 */
export { canonicalJson } from './canonical-json.js';
export { MEMORY_PURPOSES, MemoryStoreError, type MemoryTransaction } from './transaction.js';
export { TEMPORAL_RESOLVER_VERSION, TemporalResolutionError, resolveTemporalExpression,
  type TemporalResolutionRequest } from './temporal.js';
export { ENTITY_RESOLVER_VERSION, normalizeAliasValue, createEntity, recordEntityAlias, findEntityCandidates, resolveEntity,
  resolveEntityReference, recordEntityMerge, readEntity,
  type EntityKind, type EntityAliasType, type EntityAliasInput, type EntityCandidate,
  type EntityMatchOutcome, type EntityResolution } from './entities.js';
export { CANONICAL_NORMALIZATION_VERSION, slotFingerprint, propositionFingerprint, lookupBeliefSlot,
  createBeliefSlot, recordSlotFingerprint, resolveBeliefSlot, readBeliefSlot, lookupProposition,
  createProposition, recordPropositionFingerprint, resolveProposition, readProposition,
  recomputeCanonicalFingerprints,
  type SlotCandidate, type SlotLookup, type SlotLookupOutcome,
  type PropositionCandidate, type PropositionLookup, type PropositionLookupOutcome } from './slots.js';
export { createFrameInstance, recordFrameInstanceRole, recordClaim, readClaim, listClaimsForProposition,
  claimTemporalInterpretation, type ClaimInput } from './claims.js';
export { CANONICALIZATION_VERSION, resolveCanonicalContext, classifySourceAttribution, canonicalizeClaim,
  type ContextKind, type ContextRule, type ContextDecision, type ExtractorContextSelection,
  type AttributionKind, type SourceAttribution, type CanonicalizationRequest, type CanonicalizedClaim } from './canonicalize.js';
export { INSTANCE_MATCHER_VERSION, INSTANCE_MATCH_OUTCOMES, scoreInstanceMatch, mayReuseInstance, matchFrameInstance,
  resolveFrameInstance, applyInstanceDecision, recordInstanceDecision, recordInstanceMatchCandidate,
  listInstanceMatchCandidates,
  type InstanceMatchOutcome, type UpdateMateriality, type ExplicitReference, type TemporalCompatibility,
  type AmountCompatibility, type InstanceMatchSignals, type InstanceMatchScore, type RoleFiller,
  type InstanceMatchRequest, type ScoredCandidate, type InstanceMatch, type ResolvedFrameInstance,
  type AppliedInstanceDecision, type StoredInstanceMatchCandidate } from './instances.js';
export { CLAIM_RELATION_KINDS, classifyTemporalUpdate, recordClaimRelation, listClaimRelations,
  recordCorrection, recordChange,
  type ClaimRelationKind, type TemporalEffect, type TemporalUpdateKind, type StoredClaimRelation,
  type ValidPeriod, type TemporalUpdateResult, type FollowUpClaim } from './relations.js';
export { OVERLAY_VERSION, allocateOwnerSequence, recordOverlayDelta, attachOverlayDelta, contestOverlayDelta,
  recordMemoryOperation, listMemoryOperations, readOwnerOverlay, isOverlayRemoved,
  type RecordOverlayDeltaInput, type RecordedOverlayDelta, type ContestedReason } from './overlay.js';
export { RESOLUTION_VERSION, OUTCOME_PROJECTION_VERSION, RESOLUTION_CLASSIFIER_VERSION,
  validateTransition, recordMemoryLink, listMemoryLinks, recordResolutionAssertion, readResolutionAssertion,
  listResolutionAssertions, setResolutionLifecycle, recordRealization, classifyResolutionStatement,
  canonicalizeResolutionStatement, frameOutcomeProjection, sweepElapsedSchedules,
  type TransitionValidationRequest, type ValidatedTransition, type MemoryLinkEndpoint, type MemoryLinkInput,
  type ResolutionAssertionInput, type RecordedResolutionAssertion, type RealizationInput,
  type ResolutionStatementReading, type ResolutionStatementRequest, type CanonicalizedResolution,
  type ElapsedSchedule, type ElapsedScheduleSweep } from './resolutions.js';
export { recordFrameInstanceLineage, recordPropositionLineage, recordEntityLineage, retireFrameInstance, retireEntity,
  listMergedFrameMembers, resolveFrameInstanceSurvivors, resolveEntitySurvivors, readLineageForTransaction,
  listRecentLineage, resolveIdentity, listFrameSlots, slotDescriptorKey, rehomeSlotDescriptor,
  type FrameLineageKind, type PropositionLineageKind, type EntityLineageKind, type FrameSlot } from './lineage.js';
export { BITEMPORAL_QUERY_VERSION, BITEMPORAL_POLICY_VERSION, queryCurrentState, queryCorrectedHistoricalState,
  queryHistoricalBeliefState, queryBeliefState, readBeliefTimeline, recordBeliefStateVersion,
  type BeliefQueryMode, type AssessmentStatusName, type BeliefStateRow, type BeliefStateAnswer,
  type BeliefStateScope, type BeliefStateVersion } from './bitemporal.js';
export { EMBEDDING_MODEL, EMBEDDING_VERSION, EMBEDDING_DIMENSIONS, hashedLexicalEmbedder, embeddingTokens, vectorLiteral,
  indexClaimEmbeddings, searchMemoryEmbeddings,
  type Embedder, type IndexedClaims, type SemanticSearchRequest } from './embeddings.js';
