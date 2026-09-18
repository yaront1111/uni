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
export { normalizeAliasValue, createEntity, recordEntityAlias, findEntityCandidates, resolveEntity,
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
