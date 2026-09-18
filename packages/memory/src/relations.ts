import { z } from 'zod';
import { claimOriginSchema, claimLifecycleSchema, temporalInterpretationSchema } from '@unai/domain';
import { uuidV7 } from '../../../src/kernel/identities.js';
import { recordClaim } from './claims.js';
import { resolveProposition } from './slots.js';
import { recordBeliefStateVersion, type BeliefStateVersion } from './bitemporal.js';
import { MemoryStoreError, type MemoryTransaction } from './transaction.js';

/** Claim relations, and the difference between a correction and a change
 * (PRD §57, §33.6; CRT-MEM-09-A, CRT-PRJ-06-A).
 *
 * ```text
 * "My salary is 50,000."  then  "Actually it was 55,000."   -> one valid interval
 * "salary 50,000."        then  "it changed to 55,000 on August 1." -> two periods
 * ```
 *
 * Both start from the same shape -- a second claim, a second proposition in the
 * *same* belief slot -- and they must not end in the same representation. A
 * correction says the interval already covered was described wrongly: the old
 * value becomes SUPERSEDED over that interval and the new value is accepted over
 * exactly the same one. A change says the world moved: the old value stays
 * accepted over the period that ended, and the new value is accepted over the
 * period that began. `claim_relations.temporal_effect` records which was meant,
 * and the schema refuses the wrong pairing.
 *
 * Neither rewrites anything. The corrected claim, its proposition and every
 * earlier assessment version remain readable afterwards, which is what makes the
 * original "ILS 50" claim retrievable after "Actually, it was ILS 60".
 */

export const CLAIM_RELATION_KINDS = Object.freeze([
  'CORRECTS', 'SUPERSEDES', 'REPEATS', 'CONFIRMS', 'CONTRADICTS', 'CLARIFIES', 'RETRACTS',
] as const);
export type ClaimRelationKind = (typeof CLAIM_RELATION_KINDS)[number];
export type TemporalEffect = 'SAME_VALID_INTERVAL' | 'NEW_VALID_PERIOD' | 'NO_VALID_TIME_EFFECT';

const relationKindSchema = z.enum(CLAIM_RELATION_KINDS);
const temporalEffectSchema = z.enum(['SAME_VALID_INTERVAL', 'NEW_VALID_PERIOD', 'NO_VALID_TIME_EFFECT']);

/** What a follow-up statement means for valid time. Pure, and deliberately
 * willing to answer `AMBIGUOUS`: PRD §57 requires the product to ask rather than
 * to guess when the distinction is material. */
export type TemporalUpdateKind = 'CORRECTION' | 'CHANGE' | 'AMBIGUOUS';

const CORRECTION_MARKERS = [
  /\bactually\b/i, /\bi meant\b/i, /\bi said it wrong\b/i, /\bmy mistake\b/i, /\bcorrection\b/i,
  /\bsorry,? it (?:is|was|'s)\b/i, /\bnot \d[\d,.]*,? (?:it|it's|it is|it was)\b/i, /\btypo\b/i,
];
const CHANGE_MARKERS = [
  /\bchanged\b/i, /\bchanges\b/i, /\bincreased\b/i, /\bdecreased\b/i, /\braised\b/i, /\bwent up\b/i,
  /\bwent down\b/i, /\bas of\b/i, /\bstarting\b/i, /\bfrom now on\b/i, /\bsince\b/i, /\beffective\b/i,
];

export function classifyTemporalUpdate(statement: string): {
  kind: TemporalUpdateKind; correctionMarkers: readonly string[]; changeMarkers: readonly string[];
} {
  const correctionMarkers = CORRECTION_MARKERS.filter(marker => marker.test(statement)).map(marker => marker.source);
  const changeMarkers = CHANGE_MARKERS.filter(marker => marker.test(statement)).map(marker => marker.source);
  const kind: TemporalUpdateKind = correctionMarkers.length > 0 && changeMarkers.length === 0 ? 'CORRECTION'
    : changeMarkers.length > 0 && correctionMarkers.length === 0 ? 'CHANGE'
      : 'AMBIGUOUS';
  return { kind, correctionMarkers: Object.freeze(correctionMarkers), changeMarkers: Object.freeze(changeMarkers) };
}

export interface StoredClaimRelation {
  readonly id: string;
  readonly fromClaimId: string;
  readonly toClaimId: string;
  readonly relationKind: ClaimRelationKind;
  readonly temporalEffect: TemporalEffect;
  readonly validFrom: string | null;
  readonly validTo: string | null;
  readonly createdByTransactionId: string | null;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: string;
}

function toRelation(row: Record<string, unknown>): StoredClaimRelation {
  return Object.freeze({
    id: row['id'] as string,
    fromClaimId: row['from_claim_id'] as string,
    toClaimId: row['to_claim_id'] as string,
    relationKind: relationKindSchema.parse(row['relation_kind']),
    temporalEffect: temporalEffectSchema.parse(row['temporal_effect']),
    validFrom: row['valid_from'] ? (row['valid_from'] as Date).toISOString() : null,
    validTo: row['valid_to'] ? (row['valid_to'] as Date).toISOString() : null,
    createdByTransactionId: (row['created_by_transaction_id'] as string | null) ?? null,
    metadata: (row['metadata'] as Record<string, unknown>) ?? {},
    createdAt: (row['created_at'] as Date).toISOString(),
  });
}

export async function recordClaimRelation(tx: MemoryTransaction, input: {
  ownerScopeId: string; fromClaimId: string; toClaimId: string; relationKind: ClaimRelationKind;
  temporalEffect: TemporalEffect; validFrom?: Date | null; validTo?: Date | null;
  createdByTransactionId?: string | null; metadata?: Readonly<Record<string, unknown>>;
}): Promise<StoredClaimRelation> {
  const relationKind = relationKindSchema.parse(input.relationKind);
  const temporalEffect = temporalEffectSchema.parse(input.temporalEffect);
  if (input.fromClaimId === input.toClaimId) throw new MemoryStoreError('CLAIM_RELATION_SELF_REFERENCE');
  const row = (await tx.query(
    `INSERT INTO claim_relations(id,owner_scope_id,from_claim_id,to_claim_id,relation_kind,temporal_effect,
      valid_from,valid_to,created_by_transaction_id,metadata)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id,from_claim_id,to_claim_id,relation_kind,temporal_effect,valid_from,valid_to,
      created_by_transaction_id,metadata,created_at`,
    [uuidV7(), input.ownerScopeId, input.fromClaimId, input.toClaimId, relationKind, temporalEffect,
      input.validFrom ?? null, input.validTo ?? null, input.createdByTransactionId ?? null,
      JSON.stringify(input.metadata ?? {})])).rows[0];
  if (!row) throw new MemoryStoreError('CLAIM_RELATION_NOT_RECORDED');
  return toRelation(row);
}

/** Every relation a claim stands in, in either direction. */
export async function listClaimRelations(tx: MemoryTransaction, input: {
  ownerScopeId: string; claimId: string;
}): Promise<StoredClaimRelation[]> {
  const rows = (await tx.query(
    `SELECT id,from_claim_id,to_claim_id,relation_kind,temporal_effect,valid_from,valid_to,
      created_by_transaction_id,metadata,created_at FROM claim_relations
     WHERE owner_scope_id=$1 AND (from_claim_id=$2 OR to_claim_id=$2) ORDER BY created_at,id`,
    [input.ownerScopeId, input.claimId])).rows;
  return rows.map(toRelation);
}

/** One accepted or superseded value over one valid period. Two of these that do
 * not overlap are a change; two over the same interval, one of them superseded,
 * are a correction. */
export interface ValidPeriod {
  readonly propositionId: string;
  readonly assessmentStatus: string;
  readonly validFrom: string | null;
  readonly validTo: string | null;
}

export interface TemporalUpdateResult {
  readonly kind: 'CORRECTION' | 'CHANGE';
  readonly beliefSlotId: string;
  readonly priorClaimId: string;
  readonly priorPropositionId: string;
  readonly claimId: string;
  readonly propositionId: string;
  readonly relation: StoredClaimRelation;
  readonly validPeriods: readonly ValidPeriod[];
  readonly assessments: readonly BeliefStateVersion[];
}

interface PriorClaim { claimId: string; propositionId: string; beliefSlotId: string; validFrom: Date | null; validTo: Date | null }

async function readPriorClaim(tx: MemoryTransaction, ownerScopeId: string, claimId: string): Promise<PriorClaim> {
  const row = (await tx.query(
    `SELECT c.id,c.proposition_id,c.valid_from,c.valid_to,p.belief_slot_id FROM claims c
     LEFT JOIN propositions p ON p.owner_scope_id=c.owner_scope_id AND p.id=c.proposition_id
     WHERE c.owner_scope_id=$1 AND c.id=$2`, [ownerScopeId, claimId])).rows[0];
  if (!row) throw new MemoryStoreError('CLAIM_NOT_FOUND');
  if (!row['proposition_id']) throw new MemoryStoreError('CLAIM_HAS_NO_PROPOSITION');
  return {
    claimId: row['id'] as string, propositionId: row['proposition_id'] as string,
    beliefSlotId: row['belief_slot_id'] as string,
    validFrom: (row['valid_from'] as Date | null) ?? null, validTo: (row['valid_to'] as Date | null) ?? null,
  };
}

/** The live accepted interval of a proposition, falling back to the claim's own
 * interval when no verdict was recorded yet. */
async function liveInterval(tx: MemoryTransaction, ownerScopeId: string, propositionId: string, fallback: PriorClaim): Promise<{ validFrom: Date | null; validTo: Date | null }> {
  const row = (await tx.query(
    `SELECT valid_from,valid_to FROM belief_assessments
     WHERE owner_scope_id=$1 AND proposition_id=$2 AND superseded_recorded_at IS NULL`,
    [ownerScopeId, propositionId])).rows[0];
  if (!row) return { validFrom: fallback.validFrom, validTo: fallback.validTo };
  return { validFrom: (row['valid_from'] as Date | null) ?? null, validTo: (row['valid_to'] as Date | null) ?? null };
}

const followUpClaimSchema = z.strictObject({
  sourceAnchorId: z.uuid(),
  claimOrigin: claimOriginSchema.default('USER_CORRECTION'),
  lifecycle: claimLifecycleSchema.default('PROVISIONAL'),
  extractionRunId: z.uuid().nullable().default(null),
  assertedByEntityId: z.uuid().nullable().default(null),
  extractionConfidence: z.number().min(0).max(1).nullable().default(null),
  entityResolutionConfidence: z.number().min(0).max(1).nullable().default(null),
  temporalResolutionConfidence: z.number().min(0).max(1).nullable().default(null),
  instanceResolutionConfidence: z.number().min(0).max(1).nullable().default(null),
  temporalInterpretation: temporalInterpretationSchema.nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type FollowUpClaim = z.input<typeof followUpClaimSchema>;

/**
 * "Actually, it was ILS 60" (PRD §57 correction; CRT-MEM-09-A, CRT-PRJ-06-A).
 *
 * The corrected claim's valid interval is reused exactly. The new value becomes a
 * second proposition in the belief slot the first one already occupies -- a slot
 * excludes the value (PRD §11.8), so a correction never replaces a row -- and the
 * corrected value is recorded SUPERSEDED over that same interval. The original
 * claim and its proposition stay exactly as they were recorded.
 */
export async function recordCorrection(tx: MemoryTransaction, input: {
  ownerScopeId: string; correctedClaimId: string; normalizedValue: unknown; polarity?: 'POSITIVE' | 'NEGATIVE';
  claim: FollowUpClaim; transactionId: string; knowledgeTime?: Date | null;
  registryReleaseId?: string | null; normalizationVersion?: string;
  decisionReason?: Readonly<Record<string, unknown>>;
}): Promise<TemporalUpdateResult> {
  const prior = await readPriorClaim(tx, input.ownerScopeId, input.correctedClaimId);
  const claim = followUpClaimSchema.parse(input.claim);
  const interval = await liveInterval(tx, input.ownerScopeId, prior.propositionId, prior);

  const proposition = await resolveProposition(tx, {
    ownerScopeId: input.ownerScopeId, beliefSlotId: prior.beliefSlotId, normalizedValue: input.normalizedValue,
    ...(input.polarity ? { polarity: input.polarity } : {}),
    ...(input.normalizationVersion ? { normalizationVersion: input.normalizationVersion } : {}),
    registryReleaseId: input.registryReleaseId ?? null,
  });
  if (proposition.propositionId === prior.propositionId) throw new MemoryStoreError('CORRECTION_VALUE_UNCHANGED');

  const claimId = await recordClaim(tx, {
    ownerScopeId: input.ownerScopeId, sourceAnchorId: claim.sourceAnchorId, claimOrigin: claim.claimOrigin,
    lifecycle: claim.lifecycle, propositionId: proposition.propositionId,
    extractionRunId: claim.extractionRunId, assertedByEntityId: claim.assertedByEntityId,
    validFrom: interval.validFrom, validTo: interval.validTo,
    extractionConfidence: claim.extractionConfidence, entityResolutionConfidence: claim.entityResolutionConfidence,
    temporalResolutionConfidence: claim.temporalResolutionConfidence,
    instanceResolutionConfidence: claim.instanceResolutionConfidence,
    temporalInterpretation: claim.temporalInterpretation,
    metadata: { ...claim.metadata, temporalUpdate: 'CORRECTION', correctsClaimId: prior.claimId },
  });

  const relation = await recordClaimRelation(tx, {
    ownerScopeId: input.ownerScopeId, fromClaimId: claimId, toClaimId: prior.claimId,
    relationKind: 'CORRECTS', temporalEffect: 'SAME_VALID_INTERVAL',
    validFrom: interval.validFrom, validTo: interval.validTo,
    createdByTransactionId: input.transactionId,
    metadata: { ...(input.decisionReason ?? {}), reason: 'SAME_VALID_INTERVAL_RESTATED' },
  });

  const superseded = await recordBeliefStateVersion(tx, {
    ownerScopeId: input.ownerScopeId, propositionId: prior.propositionId, assessmentStatus: 'SUPERSEDED',
    transactionId: input.transactionId, validFrom: interval.validFrom, validTo: interval.validTo,
    knowledgeTime: input.knowledgeTime ?? null, decisionReason: { code: 'CORRECTED_BY_CLAIM', claimId },
  });
  const accepted = await recordBeliefStateVersion(tx, {
    ownerScopeId: input.ownerScopeId, propositionId: proposition.propositionId, assessmentStatus: 'ACCEPTED',
    transactionId: input.transactionId, validFrom: interval.validFrom, validTo: interval.validTo,
    knowledgeTime: input.knowledgeTime ?? null, decisionReason: { code: 'CORRECTION_ACCEPTED', correctsClaimId: prior.claimId },
  });

  return Object.freeze({
    kind: 'CORRECTION' as const, beliefSlotId: prior.beliefSlotId, priorClaimId: prior.claimId,
    priorPropositionId: prior.propositionId, claimId, propositionId: proposition.propositionId, relation,
    validPeriods: Object.freeze([superseded, accepted].map(version => Object.freeze({
      propositionId: version.propositionId, assessmentStatus: version.assessmentStatus,
      validFrom: version.validFrom, validTo: version.validTo,
    }))),
    assessments: Object.freeze([superseded, accepted]),
  });
}

/**
 * "Salary changed to 55,000 on August 1" (PRD §57 change; CRT-MEM-09-A,
 * CRT-MEM-06-A).
 *
 * The earlier value stays accepted -- it was true -- over a period that now ends
 * at the change instant, and the new value is accepted from that instant on. The
 * two periods are half-open and adjacent, so no instant is covered twice. When
 * the change is learned late, `knowledgeTime` is the instant Uai learned it: the
 * earlier version keeps answering for every knowledge time before that.
 */
export async function recordChange(tx: MemoryTransaction, input: {
  ownerScopeId: string; previousClaimId: string; changedAt: Date; normalizedValue: unknown;
  polarity?: 'POSITIVE' | 'NEGATIVE'; claim: FollowUpClaim; transactionId: string; knowledgeTime?: Date | null;
  registryReleaseId?: string | null; normalizationVersion?: string;
  decisionReason?: Readonly<Record<string, unknown>>;
}): Promise<TemporalUpdateResult> {
  const prior = await readPriorClaim(tx, input.ownerScopeId, input.previousClaimId);
  const claim = followUpClaimSchema.parse(input.claim);
  const interval = await liveInterval(tx, input.ownerScopeId, prior.propositionId, prior);
  if (interval.validFrom && interval.validFrom >= input.changedAt) throw new MemoryStoreError('CHANGE_NOT_AFTER_PREVIOUS_PERIOD');
  if (interval.validTo && interval.validTo <= input.changedAt) throw new MemoryStoreError('CHANGE_AFTER_PREVIOUS_PERIOD_ENDED');

  const proposition = await resolveProposition(tx, {
    ownerScopeId: input.ownerScopeId, beliefSlotId: prior.beliefSlotId, normalizedValue: input.normalizedValue,
    ...(input.polarity ? { polarity: input.polarity } : {}),
    ...(input.normalizationVersion ? { normalizationVersion: input.normalizationVersion } : {}),
    registryReleaseId: input.registryReleaseId ?? null,
  });
  if (proposition.propositionId === prior.propositionId) throw new MemoryStoreError('CHANGE_VALUE_UNCHANGED');

  const claimId = await recordClaim(tx, {
    ownerScopeId: input.ownerScopeId, sourceAnchorId: claim.sourceAnchorId, claimOrigin: claim.claimOrigin,
    lifecycle: claim.lifecycle, propositionId: proposition.propositionId,
    extractionRunId: claim.extractionRunId, assertedByEntityId: claim.assertedByEntityId,
    validFrom: input.changedAt, validTo: interval.validTo,
    extractionConfidence: claim.extractionConfidence, entityResolutionConfidence: claim.entityResolutionConfidence,
    temporalResolutionConfidence: claim.temporalResolutionConfidence,
    instanceResolutionConfidence: claim.instanceResolutionConfidence,
    temporalInterpretation: claim.temporalInterpretation,
    metadata: { ...claim.metadata, temporalUpdate: 'CHANGE', supersedesClaimId: prior.claimId },
  });

  const relation = await recordClaimRelation(tx, {
    ownerScopeId: input.ownerScopeId, fromClaimId: claimId, toClaimId: prior.claimId,
    relationKind: 'SUPERSEDES', temporalEffect: 'NEW_VALID_PERIOD',
    validFrom: input.changedAt, validTo: interval.validTo,
    createdByTransactionId: input.transactionId,
    metadata: { ...(input.decisionReason ?? {}), reason: 'NEW_VALID_PERIOD_OPENED' },
  });

  // The earlier belief is not wrong, so it stays ACCEPTED; only its period ends.
  const closed = await recordBeliefStateVersion(tx, {
    ownerScopeId: input.ownerScopeId, propositionId: prior.propositionId, assessmentStatus: 'ACCEPTED',
    transactionId: input.transactionId, validFrom: interval.validFrom, validTo: input.changedAt,
    knowledgeTime: input.knowledgeTime ?? null, decisionReason: { code: 'VALID_PERIOD_CLOSED_BY_CHANGE', claimId },
  });
  const opened = await recordBeliefStateVersion(tx, {
    ownerScopeId: input.ownerScopeId, propositionId: proposition.propositionId, assessmentStatus: 'ACCEPTED',
    transactionId: input.transactionId, validFrom: input.changedAt, validTo: interval.validTo,
    knowledgeTime: input.knowledgeTime ?? null, decisionReason: { code: 'NEW_VALID_PERIOD_ACCEPTED', supersedesClaimId: prior.claimId },
  });

  return Object.freeze({
    kind: 'CHANGE' as const, beliefSlotId: prior.beliefSlotId, priorClaimId: prior.claimId,
    priorPropositionId: prior.propositionId, claimId, propositionId: proposition.propositionId, relation,
    validPeriods: Object.freeze([closed, opened].map(version => Object.freeze({
      propositionId: version.propositionId, assessmentStatus: version.assessmentStatus,
      validFrom: version.validFrom, validTo: version.validTo,
    }))),
    assessments: Object.freeze([closed, opened]),
  });
}
