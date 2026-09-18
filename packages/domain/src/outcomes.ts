import { z } from 'zod';

/** Outcome vocabularies, the transition-contract descriptor and the derived
 * outcome projection (PRD §11.12, §11.13, §16.2-§16.6, §33.7, §33.8).
 *
 * Schemas only, as every file in this package: nothing here opens a transaction,
 * loads a registry release or decides an outcome. The closed enums are the
 * contract that migration 0015's CHECK lists and the `@unai/memory` resolution
 * store both hold to, so a value the database refuses cannot be constructed here
 * either.
 *
 * The transition-contract descriptor deliberately mirrors the registry's
 * `transitionSchema` field for field. The registry library loads and lints YAML
 * from Git and no deployed package imports it (CRT-REG-01-B), so the *pinned*
 * contracts reach the kernel as data: the caller reads the release it pinned and
 * hands the descriptors to the resolution store, which refuses anything they do
 * not allow.
 */

const registryId = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);

/** PRD §11.13. Ten protocol links; open semantic links may exist alongside them
 * but carry no belief-engine semantics, so they are not members of this set. */
export const memoryLinkKindSchema = z.enum(['SUPPORTS','CONTRADICTS','SUPERSEDES','DERIVED_FROM','SAME_AS','NOT_SAME_AS',
  'PART_OF','REFERENCES','REALIZES','RESOLVES']);
export type MemoryLinkKind = z.infer<typeof memoryLinkKindSchema>;

/** The two links a registered transition contract governs (PRD §16.3, §16.4). */
export const TRANSITION_LINK_KINDS = Object.freeze(['REALIZES', 'RESOLVES'] as const);

export const memoryLinkObjectTypeSchema = z.enum(['frame_instance','proposition','claim','resolution_assertion','entity','source_item']);
export const memoryLinkLifecycleSchema = z.enum(['PROPOSED','ACTIVE','CONTESTED','RETRACTED','SUPERSEDED']);

/** PRD §16.5. The twelve V0 outcome codes; each transition contract declares
 * which of them it allows, and nothing outside a contract's list is writable. */
export const outcomeCodeSchema = z.enum(['FULFILLED','PARTIALLY_FULFILLED','WAIVED','CANCELLED','WITHDRAWN','FAILED','MISSED',
  'OCCURRED','OCCURRED_MODIFIED','CONFIRMED','REFUTED','PARTIALLY_CONFIRMED']);
export type OutcomeCode = z.infer<typeof outcomeCodeSchema>;

/** The two codes that state a partial outcome. Everything else settles the frame,
 * which is why two different ones accepted at once is a contradiction rather than
 * a progression (PRD §16.6). */
export const PARTIAL_OUTCOME_CODES: readonly OutcomeCode[] = Object.freeze(['PARTIALLY_FULFILLED', 'PARTIALLY_CONFIRMED']);

export const resolutionLifecycleSchema = z.enum(['PROPOSED','ACCEPTED','CONTESTED','REJECTED','SUPERSEDED','WITHDRAWN']);
export type ResolutionLifecycle = z.infer<typeof resolutionLifecycleSchema>;

/** PRD §16.6. Derived from accepted resolution assertions and stored nowhere:
 * a frame's outcome is read, never written. */
export const outcomeProjectionStateSchema = z.enum(['UNRESOLVED','PARTIALLY_RESOLVED','RESOLVED','CONTESTED']);
export type OutcomeProjectionState = z.infer<typeof outcomeProjectionStateSchema>;

/** One registry transition contract as the kernel needs it (registry §17.5).
 *
 * Not a strict object, and deliberately: a loaded release contract also carries
 * `kind`, `version`, `description`, `authorityRules`, `invariants` and
 * `acceptanceTests`, which are documentation for the contract author and play no
 * part in validation. Stripping them here lets a caller hand the pinned release's
 * own contract straight to the kernel instead of copying six fields out of it by
 * hand -- and a copy is exactly where the pinned release and the enforced rule
 * would drift apart. */
export const transitionContractSchema = z.object({
  id: registryId,
  linkKind: z.enum(TRANSITION_LINK_KINDS),
  sourceFrameTypes: z.array(registryId).min(1).max(20),
  targetFrameTypes: z.array(registryId).max(20),
  targetRequired: z.boolean(),
  /** Empty for REALIZES, which carries no outcome: outcome is a separate RESOLVES
   * assertion (PRD §16.3). */
  allowedOutcomes: z.array(outcomeCodeSchema).max(12),
});
export type TransitionContract = z.infer<typeof transitionContractSchema>;

/** The pinned release's transition contracts, by id. */
export const transitionContractSetSchema = z.array(transitionContractSchema).max(200);

/** A stored resolution assertion as the Memory inspector and the Commitment
 * detail screen read it (design screens "Memory inspector", "Commitment
 * detail"). `advisoryCoverage` is displayed as a cache and never summed. */
export const storedResolutionAssertionSchema = z.strictObject({
  resolutionAssertionId: z.uuid(),
  sourceFrameInstanceId: z.uuid(),
  sourcePropositionId: z.uuid().nullable(),
  targetFrameInstanceId: z.uuid().nullable(),
  targetPropositionId: z.uuid().nullable(),
  outcomeCode: outcomeCodeSchema,
  effectiveAt: z.iso.datetime(),
  assertedByEntityId: z.uuid(),
  claimId: z.uuid(),
  transitionContractId: registryId,
  lifecycle: resolutionLifecycleSchema,
  advisoryCoverage: z.number().min(0).max(1).nullable(),
  resolutionLinkId: z.uuid().nullable(),
  creationTransactionId: z.uuid().nullable(),
  recordedAt: z.iso.datetime(),
  metadata: z.record(z.string(), z.unknown()),
});
export type StoredResolutionAssertion = z.infer<typeof storedResolutionAssertionSchema>;

export const storedMemoryLinkSchema = z.strictObject({
  memoryLinkId: z.uuid(),
  fromObjectType: memoryLinkObjectTypeSchema,
  fromObjectId: z.uuid(),
  toObjectType: memoryLinkObjectTypeSchema,
  toObjectId: z.uuid(),
  linkKind: memoryLinkKindSchema,
  lifecycle: memoryLinkLifecycleSchema,
  transitionContractId: registryId.nullable(),
  transactionId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  metadata: z.record(z.string(), z.unknown()),
});
export type StoredMemoryLink = z.infer<typeof storedMemoryLinkSchema>;

/** What a frame's outcome reads as, and the accepted assertions it was read
 * from. `conflictingOutcomes` is empty unless the state is CONTESTED. */
export const outcomeProjectionSchema = z.strictObject({
  frameInstanceId: z.uuid(),
  state: outcomeProjectionStateSchema,
  acceptedOutcomes: z.array(outcomeCodeSchema).max(200),
  conflictingOutcomes: z.array(outcomeCodeSchema).max(12),
  acceptedResolutionIds: z.array(z.uuid()).max(200),
  projectionVersion: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/),
});
export type OutcomeProjection = z.infer<typeof outcomeProjectionSchema>;
