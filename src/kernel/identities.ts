// Uai memory kernel — slice 1: the five core memory identities.
//
// PRD section 3 ("Identity is never a hash"): every durable memory object uses
// an opaque surrogate identifier (recommended format: UUIDv7). Hashes may only
// serve as candidate lookup indexes, duplicate-detection hints, cache keys, or
// migration comparison tools — never as authoritative identity.
//
// PRD section 4 ("Core memory identities"): Uai uses five distinct identity
// levels — frame type, frame instance, belief slot, proposition, claim.

import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Surrogate identifiers
// ---------------------------------------------------------------------------

declare const IdBrand: unique symbol;

/** An opaque, branded surrogate identifier. Never derived from content. */
export type SurrogateId<B extends string> = string & { readonly [IdBrand]: B };

export type FrameTypeId = SurrogateId<"FrameTypeId">;
export type FrameInstanceId = SurrogateId<"FrameInstanceId">;
export type BeliefSlotId = SurrogateId<"BeliefSlotId">;
export type PropositionId = SurrogateId<"PropositionId">;
export type ClaimId = SurrogateId<"ClaimId">;

/**
 * Mints a fresh UUIDv7 string. Takes NO content input whatsoever (section 3
 * invariant: identity is never a hash), so an id can never be re-derived from
 * an object's fields. Time-ordered prefix + cryptographically random suffix.
 */
export function uuidV7(): string {
  const bytes = randomBytes(16);
  const ms = BigInt(Date.now());
  bytes[0] = Number((ms >> 40n) & 0xffn);
  bytes[1] = Number((ms >> 32n) & 0xffn);
  bytes[2] = Number((ms >> 24n) & 0xffn);
  bytes[3] = Number((ms >> 16n) & 0xffn);
  bytes[4] = Number((ms >> 8n) & 0xffn);
  bytes[5] = Number(ms & 0xffn);
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x70; // version 7
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80; // variant 10
  const hex = bytes.toString("hex");
  return (
    hex.slice(0, 8) +
    "-" +
    hex.slice(8, 12) +
    "-" +
    hex.slice(12, 16) +
    "-" +
    hex.slice(16, 20) +
    "-" +
    hex.slice(20)
  );
}

/** Each minting function takes no input: identity is never a hash of content. */
export function mintFrameTypeId(): FrameTypeId {
  return uuidV7() as FrameTypeId;
}
export function mintFrameInstanceId(): FrameInstanceId {
  return uuidV7() as FrameInstanceId;
}
export function mintBeliefSlotId(): BeliefSlotId {
  return uuidV7() as BeliefSlotId;
}
export function mintPropositionId(): PropositionId {
  return uuidV7() as PropositionId;
}
export function mintClaimId(): ClaimId {
  return uuidV7() as ClaimId;
}

// ---------------------------------------------------------------------------
// Shared closed vocabularies used by the identity levels
// ---------------------------------------------------------------------------

/** Canonical modalities (PRD section 7). Closed: extractors cannot add values. */
export const MODALITIES = [
  "ACTUAL",
  "SCHEDULED",
  "INTENDED",
  "COMMITTED",
  "EXPECTED",
  "PREDICTED",
  "RECOMMENDED",
  "CONDITIONAL",
] as const;
export type Modality = (typeof MODALITIES)[number];

/** How a frame type keys its instances. Surrogate ids remain authoritative. */
export type IdentityStrategy =
  | { readonly kind: "SURROGATE_ONLY" }
  | {
      /** Roles usable as a duplicate-detection HINT — never as identity. */
      readonly kind: "ROLE_HINTED";
      readonly hintRoles: readonly string[];
    };

export type TemporalBehavior =
  | "ATEMPORAL"
  | "POINT_IN_TIME"
  | "INTERVAL"
  | "RECURRING";

export interface MergeSplitPolicy {
  readonly mergeable: boolean;
  readonly splittable: boolean;
}

export interface ModalityTransition {
  readonly from: Modality;
  readonly to: Modality;
}

// ---------------------------------------------------------------------------
// 4.1 Frame type — a registered class of situation
// ---------------------------------------------------------------------------

export interface FrameType {
  readonly frameTypeId: FrameTypeId;
  /** Registered name, e.g. "shared.obligation". */
  readonly name: string;
  readonly roles: readonly string[];
  readonly identityStrategy: IdentityStrategy;
  readonly allowedPredicates: readonly string[];
  readonly temporalBehavior: TemporalBehavior;
  readonly validModalityTransitions: readonly ModalityTransition[];
  readonly mergeSplitPolicy: MergeSplitPolicy;
}

export function createFrameType(input: Omit<FrameType, "frameTypeId">): FrameType {
  return Object.freeze({ ...input, frameTypeId: mintFrameTypeId() });
}

// ---------------------------------------------------------------------------
// 4.2 Frame instance — a particular real-world situation
// ---------------------------------------------------------------------------

export interface FrameInstance {
  /** Surrogate id — NEVER derived from the participants (or any content). */
  readonly frameInstanceId: FrameInstanceId;
  readonly frameTypeId: FrameTypeId;
  /** Role name -> entity reference. Not identity-bearing on its own. */
  readonly participants: Readonly<Record<string, string>>;
}

/**
 * Two obligations may involve the same people and amount while remaining
 * separate instances: every call mints a fresh surrogate id.
 */
export function createFrameInstance(
  input: Omit<FrameInstance, "frameInstanceId">,
): FrameInstance {
  return Object.freeze({
    ...input,
    participants: Object.freeze({ ...input.participants }),
    frameInstanceId: mintFrameInstanceId(),
  });
}

// ---------------------------------------------------------------------------
// 4.3 Belief slot — a governed location for compatible values. EXCLUDES value.
// ---------------------------------------------------------------------------

export interface BeliefSlot {
  readonly beliefSlotId: BeliefSlotId;
  readonly frameInstanceId: FrameInstanceId;
  readonly predicate: string;
  /** Closed dimension: a context-space reference, never free text (sections 5/6). */
  readonly contextSpaceId: string;
  readonly modality: Modality;
  readonly qualifiers: Readonly<Record<string, string>>;
}

export function createBeliefSlot(input: Omit<BeliefSlot, "beliefSlotId">): BeliefSlot {
  return Object.freeze({
    ...input,
    qualifiers: Object.freeze({ ...input.qualifiers }),
    beliefSlotId: mintBeliefSlotId(),
  });
}

/**
 * Candidate LOOKUP key for a slot (frame instance + predicate + context space +
 * modality + qualifiers). Permitted by section 3 only as an index / duplicate
 * hint; the authoritative identity remains the surrogate beliefSlotId.
 */
export function slotKeyOf(slot: BeliefSlot): string {
  const qualifiers = Object.keys(slot.qualifiers)
    .sort()
    .map((k) => [k, slot.qualifiers[k]]);
  return JSON.stringify([
    slot.frameInstanceId,
    slot.predicate,
    slot.contextSpaceId,
    slot.modality,
    qualifiers,
  ]);
}

// ---------------------------------------------------------------------------
// 4.4 Proposition — one exact normalized candidate value within a slot
// ---------------------------------------------------------------------------

export type NormalizedValue = string | number | boolean;

export interface Proposition {
  readonly propositionId: PropositionId;
  readonly beliefSlotId: BeliefSlotId;
  /** The one exact normalized candidate value, e.g. "50 ILS". */
  readonly value: NormalizedValue;
}

export function createProposition(
  input: Omit<Proposition, "propositionId">,
): Proposition {
  return Object.freeze({ ...input, propositionId: mintPropositionId() });
}

// ---------------------------------------------------------------------------
// 4.5 Claim — a specific source assertion about a proposition
// ---------------------------------------------------------------------------

export type ClaimStance = "SUPPORTS" | "CONTRADICTS" | "RELATES";

export interface Claim {
  readonly claimId: ClaimId;
  readonly propositionId: PropositionId;
  readonly stance: ClaimStance;
  /** Reference to the asserting source (speaker, document, extraction run…). */
  readonly sourceRef: string;
}

/** Claims remain distinct even when they refer to the same proposition. */
export function createClaim(input: Omit<Claim, "claimId">): Claim {
  return Object.freeze({ ...input, claimId: mintClaimId() });
}
