import { createHash } from 'node:crypto';
import { semanticSearchSchema, type SemanticSearch } from '@unai/domain';
import { uuidV7 } from '../../../src/kernel/identities.js';
import { MemoryStoreError, type MemoryTransaction } from './transaction.js';

/** The semantic index (design entity `memory_embeddings`; PRD §23.2 step 10,
 * §33.13; FR-063; CRT-RD-04-A, CRT-REG-04-A). ADR 0023 §2 and §3.
 *
 * Embeddings are indexes only. Nothing here writes a belief, a support row or a
 * projection, and no belief can cite an embedding: a match is a pointer back to
 * the claim and the evidence it was made from.
 *
 * The search applies the hard filters -- owner, permission, sensitivity, time,
 * source and entity -- inside a materialized expression and ranks only what that
 * expression returned, so the nearest embedding is never one a filter excluded.
 */

export const EMBEDDING_MODEL = 'unai-hashed-lexical';
export const EMBEDDING_VERSION = 'hashed-lexical-256-0.1.0';
export const EMBEDDING_DIMENSIONS = 256;

/** The seam a different embedding model replaces this one through. A new model is
 * a new `version`, and its rows are written beside the old ones. */
export interface Embedder {
  readonly model: string;
  readonly version: string;
  readonly dimensions: number;
  /** Null when the text carries nothing to embed: a zero vector has no direction
   * and would match everything equally badly. */
  embed(text: string): number[] | null;
}

/** Words that carry no content in a question about one's own memory. Removing
 * them is what lets "what did I promise Daniel" land near "promise Daniel". */
const STOP_WORDS = new Set(['a', 'an', 'the', 'i', 'me', 'my', 'mine', 'you', 'your', 'uai', 'we', 'our', 'us', 'it',
  'its', 'is', 'am', 'are', 'was', 'were', 'be', 'been', 'being', 'do', 'does', 'did', 'have', 'has', 'had', 'to', 'of',
  'in', 'on', 'at', 'for', 'with', 'from', 'by', 'as', 'about', 'and', 'or', 'but', 'that', 'this', 'these', 'those',
  'what', 'when', 'where', 'which', 'who', 'whom', 'why', 'how', 'there', 'then', 'than', 'so', 'if', 'any', 'some']);

export function embeddingTokens(text: string): string[] {
  return text.normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}]+/u)
    .filter(token => token.length > 0 && !STOP_WORDS.has(token));
}

function bucket(feature: string): { index: number; sign: number } {
  const digest = createHash('sha256').update(feature).digest();
  return { index: digest.readUInt32BE(0) % EMBEDDING_DIMENSIONS, sign: (digest[4]! & 1) === 1 ? 1 : -1 };
}

/**
 * The V0 embedder: hashed lexical features, pinned by name and version.
 *
 * Unigrams carry the words, bigrams their order, character trigrams the shared
 * stems ("promise"/"promised"). Each feature is hashed with SHA-256 into one of
 * 256 signed dimensions and the vector is L2-normalized. It reads no model, no
 * clock and no network, so the same text gives the same vector on every run and
 * the index can be regenerated bit for bit (ADR 0023 §2).
 */
export const hashedLexicalEmbedder: Embedder = Object.freeze({
  model: EMBEDDING_MODEL,
  version: EMBEDDING_VERSION,
  dimensions: EMBEDDING_DIMENSIONS,
  embed(text: string): number[] | null {
    const tokens = embeddingTokens(text);
    if (tokens.length === 0) return null;
    const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
    const add = (feature: string, weight: number) => {
      const { index, sign } = bucket(feature);
      vector[index] = vector[index]! + sign * weight;
    };
    tokens.forEach((token, position) => {
      add('w:' + token, 1);
      const next = tokens[position + 1];
      if (next !== undefined) add('b:' + token + ' ' + next, 0.5);
      const padded = '#' + token + '#';
      if (token.length >= 4) {
        for (let start = 0; start + 3 <= padded.length; start++) add('c:' + padded.slice(start, start + 3), 0.25);
      }
    });
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    if (norm === 0) return null;
    return vector.map(value => value / norm);
  },
});

export function vectorLiteral(vector: readonly number[]): string {
  return '[' + vector.join(',') + ']';
}

/** A registry id read as words: `shared.obligation.due_time` -> "shared obligation due time". */
function contractWords(id: string | null): string {
  return id ? id.split(/[._]/).join(' ') : '';
}

/** Every string, number and key in a JSON value, in a stable order. */
function flattenText(value: unknown, into: string[]): void {
  if (value === null || value === undefined) return;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') { into.push(String(value)); return; }
  if (Array.isArray(value)) { for (const item of value) flattenText(item, into); return; }
  if (typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      into.push(key.replace(/([a-z])([A-Z])/g, '$1 $2'));
      flattenText((value as Record<string, unknown>)[key], into);
    }
  }
}

const SENSITIVITY_ORDER = ['NORMAL', 'PRIVATE', 'RESTRICTED'] as const;
type Sensitivity = (typeof SENSITIVITY_ORDER)[number];

export interface IndexedClaims {
  readonly indexed: readonly string[];
  readonly skipped: readonly { readonly claimId: string; readonly reason: string }[];
}

/**
 * Index claims (design entity `memory_embeddings`).
 *
 * The caller holds `memory.govern` -- the belief governor calls this inside the
 * commit that created the claims, so a committed claim is searchable the moment
 * it is visible and a rolled-back one never was. What is embedded is canonical
 * memory only: frame type, predicate (registered or not -- PRD §17.5 lets an
 * unknown predicate be indexed), the value, the claim's metadata and the labels of
 * the entities in the frame. The evidence classification comes from
 * `anchor_evidence_scope`, which answers labels and no content, so a row's
 * security scope does not depend on the data purpose of whoever committed.
 *
 * Indexing the same content again is one row; a claim whose evidence is gone is
 * skipped and named, never indexed with a guessed scope.
 */
export async function indexClaimEmbeddings(tx: MemoryTransaction, input: {
  ownerScopeId: string; claimIds: readonly string[]; embedder?: Embedder;
}): Promise<IndexedClaims> {
  const embedder = input.embedder ?? hashedLexicalEmbedder;
  if (input.claimIds.length === 0) return { indexed: [], skipped: [] };
  const claims = (await tx.query(
    `SELECT c.id,c.source_anchor_id,c.proposition_id,c.candidate_frame_type_id,c.asserted_by_entity_id,
       c.valid_from,c.valid_to,c.recorded_at,c.metadata,p.normalized_value,s.predicate_id,s.frame_instance_id,
       f.frame_type_id
     FROM claims c
     LEFT JOIN propositions p ON p.owner_scope_id=c.owner_scope_id AND p.id=c.proposition_id
     LEFT JOIN belief_slots s ON s.owner_scope_id=p.owner_scope_id AND s.id=p.belief_slot_id
     LEFT JOIN frame_instances f ON f.owner_scope_id=s.owner_scope_id AND f.id=s.frame_instance_id
     WHERE c.owner_scope_id=$1 AND c.id=ANY($2::uuid[]) ORDER BY c.id`,
    [input.ownerScopeId, [...input.claimIds]])).rows;
  const frameIds = [...new Set(claims.map(row => row['frame_instance_id'] as string | null).filter((id): id is string => !!id))];
  const roleRows = frameIds.length === 0 ? [] : (await tx.query(
    `SELECT r.frame_instance_id,r.entity_id FROM frame_instance_roles r
     WHERE r.owner_scope_id=$1 AND r.frame_instance_id=ANY($2::uuid[]) AND r.entity_id IS NOT NULL
     ORDER BY r.frame_instance_id,r.entity_id`, [input.ownerScopeId, frameIds])).rows;
  const entityIds = [...new Set([...roleRows.map(row => row['entity_id'] as string),
    ...claims.map(row => row['asserted_by_entity_id'] as string | null).filter((id): id is string => !!id)])];
  const labels = new Map((entityIds.length === 0 ? [] : (await tx.query(
    'SELECT id,canonical_label FROM entities WHERE owner_scope_id=$1 AND id=ANY($2::uuid[])',
    [input.ownerScopeId, entityIds])).rows).map(row => [row['id'] as string, (row['canonical_label'] as string | null) ?? '']));
  const scopes = new Map((await tx.query(
    'SELECT * FROM unai_private.anchor_evidence_scope($1,$2::uuid[])',
    [input.ownerScopeId, claims.map(row => row['source_anchor_id'] as string)])).rows
    .map(row => [row['source_anchor_id'] as string, row]));

  const indexed: string[] = [];
  const skipped: { claimId: string; reason: string }[] = [];
  const found = new Set(claims.map(row => row['id'] as string));
  for (const claimId of [...input.claimIds].sort()) if (!found.has(claimId)) skipped.push({ claimId, reason: 'CLAIM_NOT_FOUND' });

  for (const claim of claims) {
    const claimId = claim['id'] as string;
    const scope = scopes.get(claim['source_anchor_id'] as string);
    if (!scope) { skipped.push({ claimId, reason: 'EVIDENCE_SCOPE_UNAVAILABLE' }); continue; }
    const frameInstanceId = (claim['frame_instance_id'] as string | null) ?? null;
    const frameEntities = roleRows.filter(row => row['frame_instance_id'] === frameInstanceId).map(row => row['entity_id'] as string);
    const asserter = (claim['asserted_by_entity_id'] as string | null) ?? null;
    const claimEntities = [...new Set([...frameEntities, ...(asserter ? [asserter] : [])])].sort();
    const frameTypeId = (claim['frame_type_id'] as string | null) ?? (claim['candidate_frame_type_id'] as string | null) ?? null;
    const predicateId = (claim['predicate_id'] as string | null) ?? null;

    const words: string[] = [contractWords(frameTypeId), contractWords(predicateId)];
    flattenText(claim['normalized_value'], words);
    flattenText(claim['metadata'], words);
    for (const entityId of claimEntities) words.push(labels.get(entityId) ?? '');
    const text = words.filter(word => word.length > 0).join(' ');
    const vector = embedder.embed(text);
    if (!vector) { skipped.push({ claimId, reason: 'NOTHING_TO_EMBED' }); continue; }
    if (vector.length !== EMBEDDING_DIMENSIONS) throw new MemoryStoreError('EMBEDDING_DIMENSIONS_MISMATCH');

    const occurredAt = (scope['occurred_at'] as Date | null) ?? null;
    const timeStart = (claim['valid_from'] as Date | null) ?? occurredAt;
    const contentHash = createHash('sha256').update(embedder.version + '\n' + text).digest('hex');
    await tx.query(
      `INSERT INTO memory_embeddings(id,owner_scope_id,object_type,object_id,proposition_id,frame_type_id,predicate_id,
         embedding_model,embedding_version,vector,security_scope,allowed_purposes,source_item_ids,source_types,
         entity_ids,time_start,time_end,recorded_at,content_hash)
       VALUES($1,$2,'claim',$3,$4,$5,$6,$7,$8,$9::vector,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       ON CONFLICT (owner_scope_id,object_type,object_id,embedding_version,content_hash) DO NOTHING`,
      [uuidV7(), input.ownerScopeId, claimId, (claim['proposition_id'] as string | null) ?? null, frameTypeId, predicateId,
        embedder.model, embedder.version, vectorLiteral(vector), scope['sensitivity'], scope['allowed_purposes'],
        [scope['source_item_id']], [scope['source_type']], claimEntities, timeStart,
        (claim['valid_to'] as Date | null) ?? null, claim['recorded_at'], contentHash]);
    indexed.push(claimId);
  }
  return { indexed, skipped };
}

export interface SemanticSearchRequest {
  readonly ownerScopeId: string;
  readonly query: string;
  /** The data purpose declared for this read. A row is a candidate only when the
   * evidence behind it admits exactly this purpose. */
  readonly dataPurpose: string;
  readonly maximumSensitivity: Sensitivity;
  /** Only what Uai had recorded by this instant is a candidate. */
  readonly knowledgeTime: Date;
  readonly timeWindow?: { readonly from: Date | null; readonly to: Date | null } | null;
  /** Null or empty means no entity filter; otherwise a candidate must involve at
   * least one of these entities. */
  readonly entityIds?: readonly string[] | null;
  /** A candidate's every evidence item must be of one of these source types. */
  readonly sourceTypes?: readonly string[] | null;
  /** A candidate's every evidence item must be one of these. */
  readonly sourceItemIds?: readonly string[] | null;
  /** The release registration is judged against. Null means none is pinned, and
   * no match is then authoritative. */
  readonly registryReleaseId?: string | null;
  readonly limit?: number;
  readonly embedder?: Embedder;
}

const orNull = <T,>(values: readonly T[] | null | undefined): T[] | null =>
  values && values.length > 0 ? [...values] : null;

/**
 * Nearest-neighbour search after the hard filters (PRD §23.2 step 10, FR-063).
 *
 * The filters run inside `candidates AS MATERIALIZED`, which PostgreSQL evaluates
 * on its own before the outer query ranks by distance: the ranking sees the
 * filtered rows and nothing else, and no approximate index is consulted that
 * could reintroduce a row the filters removed. On top of the explicit filters,
 * the row policy applies the evidence gate to every row, every evidence item
 * behind a candidate must still be readable under the `source_items` policy, and
 * a rejected or suppressed claim is not a candidate (CRT-RD-04-A).
 *
 * The caller must already have declared `unai.data_purpose` and
 * `unai.maximum_sensitivity` for the transaction, as every evidence reader does;
 * the parameters here repeat them so the application filter never leans on the
 * policy alone.
 */
export async function searchMemoryEmbeddings(tx: MemoryTransaction, request: SemanticSearchRequest): Promise<SemanticSearch | null> {
  const embedder = request.embedder ?? hashedLexicalEmbedder;
  const vector = embedder.embed(request.query);
  if (!vector) return null;
  const limit = Math.min(Math.max(request.limit ?? 10, 1), 50);
  const timeFrom = request.timeWindow?.from ?? null;
  const timeTo = request.timeWindow?.to ?? null;
  const entityIds = orNull(request.entityIds);
  const sourceTypes = orNull(request.sourceTypes);
  const sourceItemIds = orNull(request.sourceItemIds);
  const values: unknown[] = [request.ownerScopeId, embedder.version, request.dataPurpose, request.maximumSensitivity,
    request.knowledgeTime, timeFrom, timeTo, entityIds, sourceTypes, sourceItemIds];
  const candidates = `candidates AS MATERIALIZED (
      SELECT e.object_type,e.object_id,e.proposition_id,e.frame_type_id,e.predicate_id,e.source_item_ids,e.entity_ids,
        e.security_scope,e.time_start,e.time_end,e.vector
      FROM memory_embeddings e
      JOIN claims c ON c.owner_scope_id=e.owner_scope_id AND c.id=e.object_id
      WHERE e.owner_scope_id=$1
        AND e.embedding_version=$2
        AND $3=ANY(e.allowed_purposes)
        AND array_position(ARRAY['NORMAL','PRIVATE','RESTRICTED'],e.security_scope)
          <= array_position(ARRAY['NORMAL','PRIVATE','RESTRICTED'],$4::text)
        AND e.recorded_at <= $5
        AND ($6::timestamptz IS NULL OR (e.time_start IS NOT NULL AND (e.time_end IS NULL OR e.time_end > $6)))
        AND ($7::timestamptz IS NULL OR (e.time_start IS NOT NULL AND e.time_start < $7))
        AND ($8::uuid[] IS NULL OR e.entity_ids && $8::uuid[])
        AND ($9::text[] IS NULL OR e.source_types <@ $9::text[])
        AND ($10::uuid[] IS NULL OR e.source_item_ids <@ $10::uuid[])
        AND c.lifecycle NOT IN ('REJECTED','SUPPRESSED')
        AND NOT EXISTS(SELECT 1 FROM unnest(e.source_item_ids) AS behind(id)
          WHERE NOT EXISTS(SELECT 1 FROM source_items s WHERE s.owner_scope_id=e.owner_scope_id AND s.id=behind.id)))`;
  const total = Number((await tx.query(
    `WITH ${candidates} SELECT count(DISTINCT object_id)::int AS n FROM candidates`, values)).rows[0]?.['n'] ?? 0);
  const rows = total === 0 ? [] : (await tx.query(
    `WITH ${candidates},
     nearest AS (SELECT DISTINCT ON (object_id) *, round((vector <=> $11::vector)::numeric,6) AS distance
       FROM candidates ORDER BY object_id, vector <=> $11::vector)
     SELECT object_type,object_id,proposition_id,frame_type_id,predicate_id,source_item_ids,entity_ids,security_scope,
       time_start,time_end,distance FROM nearest ORDER BY distance,object_id LIMIT $12`,
    [...values, vectorLiteral(vector), limit])).rows;

  // Registration is judged against the pinned release, once per contract. With no
  // release pinned nothing is registered, and no match is authoritative.
  const presence = new Map<string, boolean>();
  const present = async (contract: string | null, kind: 'FRAME' | 'PREDICATE'): Promise<boolean> => {
    if (!contract || !request.registryReleaseId) return false;
    const key = kind + ':' + contract;
    if (!presence.has(key)) {
      presence.set(key, (await tx.query('SELECT unai_private.registry_contract_present($1,$2,$3) AS present',
        [request.registryReleaseId, contract, kind])).rows[0]?.['present'] === true);
    }
    return presence.get(key)!;
  };

  const matches = [];
  for (const row of rows) {
    const predicateId = (row['predicate_id'] as string | null) ?? null;
    const frameTypeId = (row['frame_type_id'] as string | null) ?? null;
    const registered = await present(predicateId, 'PREDICATE') && await present(frameTypeId, 'FRAME');
    matches.push({
      objectType: 'claim' as const, objectId: row['object_id'] as string,
      propositionId: (row['proposition_id'] as string | null) ?? null, frameTypeId, predicateId,
      predicateRegistered: registered,
      authority: registered ? 'INDEX_MATCH' as const : 'NON_AUTHORITATIVE_UNREGISTERED_PREDICATE' as const,
      distance: Number(row['distance']),
      evidenceIds: [...(row['source_item_ids'] as string[])].sort(),
      entityIds: [...(row['entity_ids'] as string[])].sort(),
      securityScope: row['security_scope'] as Sensitivity,
      timeStart: row['time_start'] ? (row['time_start'] as Date).toISOString() : null,
      timeEnd: row['time_end'] ? (row['time_end'] as Date).toISOString() : null,
    });
  }
  return semanticSearchSchema.parse({
    embeddingModel: embedder.model, embeddingVersion: embedder.version,
    filters: {
      ownerScopeId: request.ownerScopeId, dataPurpose: request.dataPurpose, maximumSensitivity: request.maximumSensitivity,
      knowledgeTime: request.knowledgeTime.toISOString(),
      timeWindow: timeFrom || timeTo ? { from: timeFrom ? timeFrom.toISOString() : null, to: timeTo ? timeTo.toISOString() : null } : null,
      entityIds: entityIds ? [...entityIds].sort() : null, sourceTypes: sourceTypes ? [...sourceTypes].sort() : null,
      sourceItemIds: sourceItemIds ? [...sourceItemIds].sort() : null,
    },
    candidatesAfterFilters: total,
    matches,
  });
}
