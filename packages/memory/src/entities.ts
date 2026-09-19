import { z } from 'zod';
import { entityKindSchema, entityAliasTypeSchema, entityMatchOutcomeSchema } from '@unai/domain';
import { uuidV7 } from '../../../src/kernel/identities.js';
import { MemoryStoreError, type MemoryTransaction } from './transaction.js';

/** Entity service (PRD §11.3, §36.4, CRT-MEM-11-B).
 *
 * The one behaviour worth stating plainly: **the default is under-merge**. Two
 * people named Daniel produce two entities. A shared name is a candidate, and a
 * candidate is never an identity -- only an exact strong identifier (a mailbox, a
 * handle, a phone number, a connector's own identifier) or an explicit user merge
 * makes two mentions one entity. Everything else stays separate, because a wrong
 * merge silently attributes one person's obligations to another and is far harder
 * to notice and undo than a duplicate.
 */

/** The version of the resolution rules below, recorded by anything that depends
 * on how this service decided -- an extraction run pins it so its entity
 * resolution stays reproducible (CRT-WRT-08-A). */
export const ENTITY_RESOLVER_VERSION = 'entity-resolver-1';

/** Alias types that identify one account or mailbox rather than describe a person.
 * An exact, unambiguous match on one of these is the "sufficient evidence" of
 * CRT-MEM-11-B; a name never is. */
const STRONG_ALIAS_TYPES = new Set(['EMAIL', 'HANDLE', 'PHONE', 'EXTERNAL_ID']);

export type EntityKind = z.infer<typeof entityKindSchema>;
export type EntityAliasType = z.infer<typeof entityAliasTypeSchema>;
export type EntityMatchOutcome = z.infer<typeof entityMatchOutcomeSchema>;

const aliasInputSchema = z.strictObject({
  aliasType: entityAliasTypeSchema,
  aliasValue: z.string().trim().min(1).max(512),
  confidence: z.number().min(0).max(1).optional(),
  sourceItemId: z.uuid().optional(),
  validFrom: z.date().optional(),
  validTo: z.date().optional(),
});
export type EntityAliasInput = z.infer<typeof aliasInputSchema>;

const resolveInputSchema = z.strictObject({
  ownerScopeId: z.uuid(),
  entityKind: entityKindSchema,
  canonicalLabel: z.string().trim().min(1).max(512).optional(),
  aliases: z.array(aliasInputSchema).min(1).max(32),
});

export interface EntityCandidate {
  readonly entityId: string;
  readonly entityKind: EntityKind;
  readonly canonicalLabel: string | null;
  readonly lifecycle: string;
  /** Which alias types of the request this candidate matched on, so a caller can
   * see *why* it is a candidate instead of trusting a bare score. */
  readonly matchedAliasTypes: readonly EntityAliasType[];
  readonly matchedStrongly: boolean;
}

export interface EntityResolution {
  readonly outcome: EntityMatchOutcome;
  readonly entityId: string;
  readonly candidates: readonly EntityCandidate[];
  /** False whenever the caller must not treat the candidates as one identity. */
  readonly identityEstablished: boolean;
  readonly created: boolean;
}

/** Comparison form of a surface string: NFC, case-folded, whitespace collapsed.
 * Normalization widens *candidate lookup* only. It never decides identity. */
export function normalizeAliasValue(value: string): string {
  return value.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

export async function createEntity(tx: MemoryTransaction, input: {
  ownerScopeId: string; entityKind: EntityKind; canonicalLabel?: string;
}): Promise<string> {
  const entityId = uuidV7();
  await tx.query('INSERT INTO entities(id,owner_scope_id,entity_kind,canonical_label) VALUES($1,$2,$3,$4)',
    [entityId, input.ownerScopeId, entityKindSchema.parse(input.entityKind), input.canonicalLabel ?? null]);
  return entityId;
}

export async function recordEntityAlias(tx: MemoryTransaction, input: EntityAliasInput & {
  ownerScopeId: string; entityId: string;
}): Promise<string> {
  const alias = aliasInputSchema.parse({
    aliasType: input.aliasType, aliasValue: input.aliasValue,
    ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
    ...(input.sourceItemId === undefined ? {} : { sourceItemId: input.sourceItemId }),
    ...(input.validFrom === undefined ? {} : { validFrom: input.validFrom }),
    ...(input.validTo === undefined ? {} : { validTo: input.validTo }),
  });
  const id = uuidV7();
  await tx.query(`INSERT INTO entity_aliases(id,owner_scope_id,entity_id,alias_type,alias_value,normalized_value,
    source_item_id,confidence,valid_from,valid_to) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id, input.ownerScopeId, input.entityId, alias.aliasType, alias.aliasValue, normalizeAliasValue(alias.aliasValue),
      alias.sourceItemId ?? null, alias.confidence ?? null, alias.validFrom ?? null, alias.validTo ?? null]);
  return id;
}

/** Every live entity of this kind that shares a normalized alias with the request.
 * The answer is a list on purpose: a name that two people share yields two
 * candidates, and the caller has to decide, not the index. */
export async function findEntityCandidates(tx: MemoryTransaction, input: {
  ownerScopeId: string; entityKind: EntityKind; aliases: readonly { aliasType: EntityAliasType; aliasValue: string }[];
}): Promise<EntityCandidate[]> {
  const types = input.aliases.map(alias => alias.aliasType);
  const values = input.aliases.map(alias => normalizeAliasValue(alias.aliasValue));
  const rows = (await tx.query(`SELECT e.id,e.entity_kind,e.canonical_label,e.lifecycle,
      array_agg(DISTINCT a.alias_type ORDER BY a.alias_type) AS matched
    FROM entities e JOIN entity_aliases a ON a.owner_scope_id=e.owner_scope_id AND a.entity_id=e.id
    WHERE e.owner_scope_id=$1 AND e.entity_kind=$2 AND e.lifecycle='ACTIVE'
      AND (a.alias_type,a.normalized_value) IN (SELECT * FROM unnest($3::text[],$4::text[]))
    GROUP BY e.id,e.entity_kind,e.canonical_label,e.lifecycle ORDER BY e.id`,
    [input.ownerScopeId, input.entityKind, types, values])).rows;
  return rows.map(row => {
    const matched = (row.matched as EntityAliasType[]);
    return {
      entityId: row.id as string,
      entityKind: row.entity_kind as EntityKind,
      canonicalLabel: (row.canonical_label as string | null),
      lifecycle: row.lifecycle as string,
      matchedAliasTypes: matched,
      matchedStrongly: matched.some(isStrongAliasType),
    };
  });
}

/** Whether an alias type identifies one account rather than describing a person. */
export function isStrongAliasType(aliasType: EntityAliasType): boolean {
  return STRONG_ALIAS_TYPES.has(aliasType);
}

/** The under-merge decision itself, over candidates already found. Pure, so the
 * gold-corpus runner scores exactly the rule `resolveEntity` applies
 * (CRT-QA-03-A) rather than a copy of it.
 *
 * Reuse only on exactly one candidate matched on a strong identifier. Ambiguous
 * strong evidence is not stronger evidence: two entities answering to one
 * mailbox is a conflict for a human, never a licence to pick one. */
export function decideEntityResolution(candidates: readonly Pick<EntityCandidate, 'entityId' | 'matchedAliasTypes' | 'matchedStrongly'>[])
  : { outcome: EntityMatchOutcome; reuseEntityId: string | null } {
  const strong = candidates.filter(candidate => candidate.matchedStrongly);
  if (strong.length === 1) return { outcome: 'CONFIRMED_MATCH', reuseEntityId: strong[0]!.entityId };
  const outcome: EntityMatchOutcome = candidates.length === 0 ? 'NEW_ENTITY'
    : strong.length > 1 ? 'POSSIBLE_MATCH'
    : candidates.some(candidate => candidate.matchedAliasTypes.length > 1) ? 'PROBABLE_MATCH' : 'POSSIBLE_MATCH';
  return { outcome, reuseEntityId: null };
}

/** Candidate lookup plus the under-merge decision, in one call.
 *
 * Reuses an existing entity only on CONFIRMED_MATCH -- exactly one candidate,
 * matched on a strong identifier. Every other shape creates a new entity and
 * hands back the candidates it deliberately did not merge with, which is what the
 * Merge and split review screen shows as two same-name people kept separate. */
export async function resolveEntity(tx: MemoryTransaction, input: {
  ownerScopeId: string; entityKind: EntityKind; canonicalLabel?: string; aliases: readonly EntityAliasInput[];
}): Promise<EntityResolution> {
  const request = resolveInputSchema.parse({
    ownerScopeId: input.ownerScopeId, entityKind: input.entityKind,
    ...(input.canonicalLabel === undefined ? {} : { canonicalLabel: input.canonicalLabel }),
    aliases: input.aliases,
  });
  const candidates = await findEntityCandidates(tx, request);
  const decision = decideEntityResolution(candidates);
  if (decision.reuseEntityId !== null) {
    const survivor = await resolveEntityReference(tx, { ownerScopeId: request.ownerScopeId, entityId: decision.reuseEntityId });
    return { outcome: decision.outcome, entityId: survivor, candidates, identityEstablished: true, created: false };
  }
  const outcome = decision.outcome;
  const entityId = await createEntity(tx, {
    ownerScopeId: request.ownerScopeId, entityKind: request.entityKind,
    ...(request.canonicalLabel === undefined ? {} : { canonicalLabel: request.canonicalLabel }),
  });
  for (const alias of request.aliases) await recordEntityAlias(tx, { ...alias, ownerScopeId: request.ownerScopeId, entityId });
  return { outcome, entityId, candidates, identityEstablished: false, created: true };
}

/** The identity an id names today. A merged id keeps resolving -- through its
 * lineage, to the survivor -- and is never repurposed (PRD §44.13). */
export async function resolveEntityReference(tx: MemoryTransaction, input: {
  ownerScopeId: string; entityId: string;
}): Promise<string> {
  let current = input.entityId;
  for (let hop = 0; hop < 32; hop++) {
    const next = (await tx.query(`SELECT to_entity_id FROM entity_lineage
      WHERE owner_scope_id=$1 AND from_entity_id=$2 AND lineage_kind='MERGED_INTO'
      ORDER BY created_at DESC,id DESC LIMIT 1`, [input.ownerScopeId, current])).rows[0];
    if (!next) return current;
    current = next.to_entity_id as string;
  }
  throw new MemoryStoreError('ENTITY_LINEAGE_CYCLE');
}

/** A user merge: the identity evidence could not establish, stated by the owner.
 *
 * Writes lineage first and retires the merged entity second, so the old id is
 * resolvable for the entire lifetime of the retirement. Nothing is deleted and no
 * id is reused; the projection rebuild and the merge endpoint that report this to
 * the user belong to the merge and split node. */
export async function recordEntityMerge(tx: MemoryTransaction, input: {
  ownerScopeId: string; survivorEntityId: string; mergedEntityId: string; reason?: Record<string, unknown>;
}): Promise<string> {
  if (input.survivorEntityId === input.mergedEntityId) throw new MemoryStoreError('ENTITY_MERGE_SELF');
  const lineageId = uuidV7();
  await tx.query(`INSERT INTO entity_lineage(id,owner_scope_id,from_entity_id,to_entity_id,lineage_kind,reason)
    VALUES($1,$2,$3,$4,'MERGED_INTO',$5)`,
    [lineageId, input.ownerScopeId, input.mergedEntityId, input.survivorEntityId, JSON.stringify(input.reason ?? {})]);
  const retired = await tx.query(`UPDATE entities SET lifecycle='MERGED',retired_at=now()
    WHERE owner_scope_id=$1 AND id=$2 AND lifecycle='ACTIVE'`, [input.ownerScopeId, input.mergedEntityId]);
  if (retired.rowCount !== 1) throw new MemoryStoreError('ENTITY_MERGE_TARGET_NOT_ACTIVE');
  return lineageId;
}

export async function readEntity(tx: MemoryTransaction, input: { ownerScopeId: string; entityId: string }): Promise<{
  entityId: string; entityKind: EntityKind; canonicalLabel: string | null; lifecycle: string; retiredAt: Date | null;
} | null> {
  const row = (await tx.query('SELECT id,entity_kind,canonical_label,lifecycle,retired_at FROM entities WHERE owner_scope_id=$1 AND id=$2',
    [input.ownerScopeId, input.entityId])).rows[0];
  if (!row) return null;
  return { entityId: row.id as string, entityKind: row.entity_kind as EntityKind,
    canonicalLabel: row.canonical_label as string | null, lifecycle: row.lifecycle as string,
    retiredAt: row.retired_at as Date | null };
}
