import { createHash } from 'node:crypto';
import { z } from 'zod';
import { slotDescriptorSchema, polaritySchema, type SlotDescriptor } from '@unai/domain';
import { uuidV7 } from '../../../src/kernel/identities.js';
import { canonicalJson } from './canonical-json.js';
import { MemoryStoreError, type MemoryTransaction } from './transaction.js';

/** Belief slots, propositions and their versioned lookup fingerprints
 * (PRD §11.8, §11.9, §13.2, §13.5, §13.6; CRT-MEM-04-A, CRT-MEM-04-B, CRT-MEM-05-A).
 *
 * Two rules shape every function below.
 *
 * A fingerprint is an index, not a name. It is computed from a descriptor under a
 * normalization version, it is stored in its own recorded-time row, and it may
 * match several objects. When it does, the lookup returns all of them: identity
 * comes from comparing descriptors, never from the hash agreeing. Recomputing
 * under a new normalization version therefore appends new index rows and closes
 * the old ones while every id issued earlier keeps naming the same object.
 *
 * A slot excludes the candidate value. `shared.obligation.principal_amount` for
 * one obligation is one slot; "ILS 50" and "ILS 60" are two propositions inside
 * it. That is why `slotDescriptor` cannot carry a value and why a second amount
 * never overwrites the first.
 */

/** The version of the descriptor-to-fingerprint normalization. Bumping it changes
 * every fingerprint and no identity, which is exactly what CRT-MEM-04-A tests. */
export const CANONICAL_NORMALIZATION_VERSION = 'normalization-1';

const normalizationVersionSchema = z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/);

export type SlotLookupOutcome = 'MATCH_EXISTING_SLOT' | 'POSSIBLE_SLOT_MATCH' | 'CREATE_NEW_SLOT';
export type PropositionLookupOutcome = 'MATCH_EXISTING_PROPOSITION' | 'POSSIBLE_PROPOSITION_MATCH' | 'CREATE_NEW_PROPOSITION';

export interface SlotCandidate { readonly beliefSlotId: string; readonly descriptor: SlotDescriptor; readonly fingerprint: string }
export interface SlotLookup {
  readonly outcome: SlotLookupOutcome;
  readonly fingerprint: string;
  readonly candidates: readonly SlotCandidate[];
  /** True only when one candidate is semantically identical and nothing else
   * competes with it. A fingerprint agreeing is never enough on its own. */
  readonly identityEstablished: boolean;
}

export interface PropositionCandidate { readonly propositionId: string; readonly normalizedValue: unknown; readonly polarity: 'POSITIVE' | 'NEGATIVE' }
export interface PropositionLookup {
  readonly outcome: PropositionLookupOutcome;
  readonly fingerprint: string;
  readonly candidates: readonly PropositionCandidate[];
  readonly identityEstablished: boolean;
}

/** sha256 over the canonical descriptor bytes *including* the normalization
 * version, so an index entry can never be read under the wrong version. */
export function slotFingerprint(descriptor: SlotDescriptor, normalizationVersion: string): string {
  return createHash('sha256').update(canonicalJson({
    kind: 'belief-slot', normalizationVersion: normalizationVersionSchema.parse(normalizationVersion),
    descriptor: slotDescriptorSchema.parse(descriptor),
  })).digest('hex');
}

export function propositionFingerprint(descriptor: {
  beliefSlotId: string; normalizedValue: unknown; polarity: 'POSITIVE' | 'NEGATIVE';
}, normalizationVersion: string): string {
  return createHash('sha256').update(canonicalJson({
    kind: 'proposition', normalizationVersion: normalizationVersionSchema.parse(normalizationVersion),
    descriptor: { beliefSlotId: z.uuid().parse(descriptor.beliefSlotId), normalizedValue: descriptor.normalizedValue,
      polarity: polaritySchema.parse(descriptor.polarity) },
  })).digest('hex');
}

/** Every live slot whose current index entry under this version carries the same
 * fingerprint, with the descriptor each one actually stores so the caller can
 * compare meanings rather than hashes. */
export async function lookupBeliefSlot(tx: MemoryTransaction, input: {
  ownerScopeId: string; descriptor: SlotDescriptor; normalizationVersion?: string;
}): Promise<SlotLookup> {
  const descriptor = slotDescriptorSchema.parse(input.descriptor);
  const version = normalizationVersionSchema.parse(input.normalizationVersion ?? CANONICAL_NORMALIZATION_VERSION);
  const fingerprint = slotFingerprint(descriptor, version);
  const rows = (await tx.query(`SELECT f.belief_slot_id,f.descriptor,f.fingerprint FROM slot_fingerprints f
    JOIN belief_slots s ON s.owner_scope_id=f.owner_scope_id AND s.id=f.belief_slot_id
    WHERE f.owner_scope_id=$1 AND f.normalization_version=$2 AND f.fingerprint=$3
      AND f.valid_to_recorded_at IS NULL AND s.lifecycle='ACTIVE'
    ORDER BY f.belief_slot_id`, [input.ownerScopeId, version, fingerprint])).rows;
  const candidates: SlotCandidate[] = rows.map(row => ({
    beliefSlotId: row.belief_slot_id as string,
    descriptor: row.descriptor as SlotDescriptor,
    fingerprint: row.fingerprint as string,
  }));
  return decideSlot(descriptor, fingerprint, candidates);
}

function decideSlot(descriptor: SlotDescriptor, fingerprint: string, candidates: SlotCandidate[]): SlotLookup {
  if (candidates.length === 0) return { outcome: 'CREATE_NEW_SLOT', fingerprint, candidates, identityEstablished: false };
  const wanted = canonicalJson(descriptor);
  const identical = candidates.filter(candidate => canonicalJson(candidate.descriptor) === wanted);
  // One candidate, and it says the same thing: identity, established by the
  // comparison and not by the index. Anything else -- two slots behind one
  // fingerprint, or a candidate whose descriptor differs -- stays a candidate list.
  if (candidates.length === 1 && identical.length === 1) {
    return { outcome: 'MATCH_EXISTING_SLOT', fingerprint, candidates, identityEstablished: true };
  }
  return { outcome: 'POSSIBLE_SLOT_MATCH', fingerprint, candidates, identityEstablished: false };
}

export async function createBeliefSlot(tx: MemoryTransaction, input: {
  ownerScopeId: string; descriptor: SlotDescriptor; normalizationVersion?: string; registryReleaseId?: string | null;
}): Promise<string> {
  const descriptor = slotDescriptorSchema.parse(input.descriptor);
  const version = normalizationVersionSchema.parse(input.normalizationVersion ?? CANONICAL_NORMALIZATION_VERSION);
  const beliefSlotId = uuidV7();
  await tx.query(`INSERT INTO belief_slots(id,owner_scope_id,frame_instance_id,predicate_id,context_space_id,modality,qualifiers)
    VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [beliefSlotId, input.ownerScopeId, descriptor.frameInstanceId, descriptor.predicateId, descriptor.contextSpaceId,
      descriptor.modality, JSON.stringify(descriptor.qualifiers)]);
  await recordSlotFingerprint(tx, { ownerScopeId: input.ownerScopeId, beliefSlotId, descriptor,
    normalizationVersion: version, registryReleaseId: input.registryReleaseId ?? null });
  return beliefSlotId;
}

export async function recordSlotFingerprint(tx: MemoryTransaction, input: {
  ownerScopeId: string; beliefSlotId: string; descriptor: SlotDescriptor;
  normalizationVersion: string; registryReleaseId?: string | null;
}): Promise<string> {
  const id = uuidV7();
  await tx.query(`INSERT INTO slot_fingerprints(id,owner_scope_id,belief_slot_id,registry_release_id,
    normalization_version,fingerprint,descriptor) VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [id, input.ownerScopeId, input.beliefSlotId, input.registryReleaseId ?? null, input.normalizationVersion,
      slotFingerprint(input.descriptor, input.normalizationVersion), JSON.stringify(input.descriptor)]);
  return id;
}

/** Lookup, then reuse only on an established identity. A POSSIBLE_SLOT_MATCH
 * creates a new slot and reports the candidates it did not join. */
export async function resolveBeliefSlot(tx: MemoryTransaction, input: {
  ownerScopeId: string; descriptor: SlotDescriptor; normalizationVersion?: string; registryReleaseId?: string | null;
}): Promise<SlotLookup & { beliefSlotId: string; created: boolean }> {
  const lookup = await lookupBeliefSlot(tx, input);
  if (lookup.identityEstablished) return { ...lookup, beliefSlotId: lookup.candidates[0]!.beliefSlotId, created: false };
  const beliefSlotId = await createBeliefSlot(tx, input);
  return { ...lookup, beliefSlotId, created: true };
}

export async function readBeliefSlot(tx: MemoryTransaction, input: { ownerScopeId: string; beliefSlotId: string }): Promise<{
  beliefSlotId: string; descriptor: SlotDescriptor; lifecycle: string; createdAt: Date;
} | null> {
  const row = (await tx.query(`SELECT id,frame_instance_id,predicate_id,context_space_id,modality,qualifiers,lifecycle,created_at
    FROM belief_slots WHERE owner_scope_id=$1 AND id=$2`, [input.ownerScopeId, input.beliefSlotId])).rows[0];
  if (!row) return null;
  return {
    beliefSlotId: row.id as string,
    descriptor: slotDescriptorSchema.parse({
      frameInstanceId: row.frame_instance_id, predicateId: row.predicate_id, contextSpaceId: row.context_space_id,
      modality: row.modality, qualifiers: row.qualifiers,
    }),
    lifecycle: row.lifecycle as string,
    createdAt: row.created_at as Date,
  };
}

export async function lookupProposition(tx: MemoryTransaction, input: {
  ownerScopeId: string; beliefSlotId: string; normalizedValue: unknown; polarity?: 'POSITIVE' | 'NEGATIVE';
  normalizationVersion?: string;
}): Promise<PropositionLookup> {
  const polarity = polaritySchema.parse(input.polarity ?? 'POSITIVE');
  const version = normalizationVersionSchema.parse(input.normalizationVersion ?? CANONICAL_NORMALIZATION_VERSION);
  const fingerprint = propositionFingerprint({ beliefSlotId: input.beliefSlotId, normalizedValue: input.normalizedValue, polarity }, version);
  const rows = (await tx.query(`SELECT p.id,p.normalized_value,p.polarity FROM proposition_fingerprints f
    JOIN propositions p ON p.owner_scope_id=f.owner_scope_id AND p.id=f.proposition_id
    WHERE f.owner_scope_id=$1 AND f.normalization_version=$2 AND f.fingerprint=$3
      AND f.valid_to_recorded_at IS NULL AND p.lifecycle='ACTIVE' AND p.belief_slot_id=$4
    ORDER BY p.id`, [input.ownerScopeId, version, fingerprint, input.beliefSlotId])).rows;
  const candidates: PropositionCandidate[] = rows.map(row => ({
    propositionId: row.id as string, normalizedValue: row.normalized_value, polarity: row.polarity as 'POSITIVE' | 'NEGATIVE',
  }));
  if (candidates.length === 0) return { outcome: 'CREATE_NEW_PROPOSITION', fingerprint, candidates, identityEstablished: false };
  const wanted = canonicalJson({ value: input.normalizedValue, polarity });
  const identical = candidates.filter(c => canonicalJson({ value: c.normalizedValue, polarity: c.polarity }) === wanted);
  if (candidates.length === 1 && identical.length === 1) {
    return { outcome: 'MATCH_EXISTING_PROPOSITION', fingerprint, candidates, identityEstablished: true };
  }
  return { outcome: 'POSSIBLE_PROPOSITION_MATCH', fingerprint, candidates, identityEstablished: false };
}

export async function createProposition(tx: MemoryTransaction, input: {
  ownerScopeId: string; beliefSlotId: string; normalizedValue: unknown; polarity?: 'POSITIVE' | 'NEGATIVE';
  normalizationVersion?: string; registryReleaseId?: string | null;
}): Promise<string> {
  const polarity = polaritySchema.parse(input.polarity ?? 'POSITIVE');
  const version = normalizationVersionSchema.parse(input.normalizationVersion ?? CANONICAL_NORMALIZATION_VERSION);
  const propositionId = uuidV7();
  await tx.query('INSERT INTO propositions(id,owner_scope_id,belief_slot_id,normalized_value,polarity) VALUES($1,$2,$3,$4,$5)',
    [propositionId, input.ownerScopeId, input.beliefSlotId, JSON.stringify(input.normalizedValue), polarity]);
  await recordPropositionFingerprint(tx, { ownerScopeId: input.ownerScopeId, propositionId,
    descriptor: { beliefSlotId: input.beliefSlotId, normalizedValue: input.normalizedValue, polarity },
    normalizationVersion: version, registryReleaseId: input.registryReleaseId ?? null });
  return propositionId;
}

export async function recordPropositionFingerprint(tx: MemoryTransaction, input: {
  ownerScopeId: string; propositionId: string;
  descriptor: { beliefSlotId: string; normalizedValue: unknown; polarity: 'POSITIVE' | 'NEGATIVE' };
  normalizationVersion: string; registryReleaseId?: string | null;
}): Promise<string> {
  const id = uuidV7();
  await tx.query(`INSERT INTO proposition_fingerprints(id,owner_scope_id,proposition_id,registry_release_id,
    normalization_version,fingerprint,descriptor) VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [id, input.ownerScopeId, input.propositionId, input.registryReleaseId ?? null, input.normalizationVersion,
      propositionFingerprint(input.descriptor, input.normalizationVersion), JSON.stringify(input.descriptor)]);
  return id;
}

export async function resolveProposition(tx: MemoryTransaction, input: {
  ownerScopeId: string; beliefSlotId: string; normalizedValue: unknown; polarity?: 'POSITIVE' | 'NEGATIVE';
  normalizationVersion?: string; registryReleaseId?: string | null;
}): Promise<PropositionLookup & { propositionId: string; created: boolean }> {
  const lookup = await lookupProposition(tx, input);
  if (lookup.identityEstablished) return { ...lookup, propositionId: lookup.candidates[0]!.propositionId, created: false };
  const propositionId = await createProposition(tx, input);
  return { ...lookup, propositionId, created: true };
}

export async function readProposition(tx: MemoryTransaction, input: { ownerScopeId: string; propositionId: string }): Promise<{
  propositionId: string; beliefSlotId: string; normalizedValue: unknown; polarity: string; lifecycle: string; createdAt: Date;
} | null> {
  const row = (await tx.query(`SELECT id,belief_slot_id,normalized_value,polarity,lifecycle,created_at
    FROM propositions WHERE owner_scope_id=$1 AND id=$2`, [input.ownerScopeId, input.propositionId])).rows[0];
  if (!row) return null;
  return { propositionId: row.id as string, beliefSlotId: row.belief_slot_id as string, normalizedValue: row.normalized_value,
    polarity: row.polarity as string, lifecycle: row.lifecycle as string, createdAt: row.created_at as Date };
}

/** Re-index every live slot and proposition under a new normalization version.
 *
 * Nothing is rewritten: the previous index rows are closed at their recorded time
 * and new rows are appended from the descriptors already stored. No slot,
 * proposition, frame instance or claim row is touched, so every identifier issued
 * before the recomputation still resolves to the same object afterwards
 * (CRT-MEM-04-A). Running it twice for the same version is a no-op. */
export async function recomputeCanonicalFingerprints(tx: MemoryTransaction, input: {
  ownerScopeId: string; fromNormalizationVersion?: string; toNormalizationVersion: string; registryReleaseId?: string | null;
}): Promise<{ slots: number; propositions: number }> {
  const from = normalizationVersionSchema.parse(input.fromNormalizationVersion ?? CANONICAL_NORMALIZATION_VERSION);
  const to = normalizationVersionSchema.parse(input.toNormalizationVersion);
  if (from === to) throw new MemoryStoreError('NORMALIZATION_VERSION_UNCHANGED');

  const slots = (await tx.query(`SELECT belief_slot_id,descriptor FROM slot_fingerprints
    WHERE owner_scope_id=$1 AND normalization_version=$2 AND valid_to_recorded_at IS NULL ORDER BY belief_slot_id`,
    [input.ownerScopeId, from])).rows;
  for (const row of slots) {
    await recordSlotFingerprint(tx, { ownerScopeId: input.ownerScopeId, beliefSlotId: row.belief_slot_id as string,
      descriptor: row.descriptor as SlotDescriptor, normalizationVersion: to, registryReleaseId: input.registryReleaseId ?? null });
  }
  const propositions = (await tx.query(`SELECT proposition_id,descriptor FROM proposition_fingerprints
    WHERE owner_scope_id=$1 AND normalization_version=$2 AND valid_to_recorded_at IS NULL ORDER BY proposition_id`,
    [input.ownerScopeId, from])).rows;
  for (const row of propositions) {
    const descriptor = row.descriptor as { beliefSlotId: string; normalizedValue: unknown; polarity: 'POSITIVE' | 'NEGATIVE' };
    await recordPropositionFingerprint(tx, { ownerScopeId: input.ownerScopeId, propositionId: row.proposition_id as string,
      descriptor, normalizationVersion: to, registryReleaseId: input.registryReleaseId ?? null });
  }
  // Close the superseded index rows last: until this point both versions are
  // live, so a concurrent reader is never left without an index to look in.
  await tx.query(`UPDATE slot_fingerprints SET valid_to_recorded_at=now()
    WHERE owner_scope_id=$1 AND normalization_version=$2 AND valid_to_recorded_at IS NULL`, [input.ownerScopeId, from]);
  await tx.query(`UPDATE proposition_fingerprints SET valid_to_recorded_at=now()
    WHERE owner_scope_id=$1 AND normalization_version=$2 AND valid_to_recorded_at IS NULL`, [input.ownerScopeId, from]);
  return { slots: slots.length, propositions: propositions.length };
}
