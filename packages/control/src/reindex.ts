import { hashedLexicalEmbedder, indexClaimEmbeddings, type Embedder } from '@unai/memory';
import { requirePurpose, type ControlTransaction } from './transaction.js';

/**
 * Semantic index regeneration (PRD §33.13: embeddings are indexes, regenerable;
 * CRT-NFR-04-A).
 *
 * Dropping runs under `memory.reindex` through `unai_private.drop_semantic_index`,
 * so the application role still holds no DELETE on `memory_embeddings`.
 * Regenerating runs under `memory.govern`, the purpose the index is written
 * under at commit time, with the pinned embedder of ADR 0024: the same claims give
 * the same vectors, so the same queries find the same results again.
 */

export const MEMORY_REINDEX_PURPOSE = 'memory.reindex';
export const MEMORY_GOVERN_PURPOSE = 'memory.govern';

export async function dropSemanticIndex(tx: ControlTransaction): Promise<number> {
  requirePurpose(tx, MEMORY_REINDEX_PURPOSE);
  return Number((await tx.query('SELECT unai_private.drop_semantic_index($1) AS dropped',
    [tx.context.ownerScopeId])).rows[0]?.['dropped'] ?? 0);
}

export async function regenerateSemanticIndex(tx: ControlTransaction, embedder: Embedder = hashedLexicalEmbedder):
  Promise<{ indexed: number; skipped: number; embeddingModel: string; embeddingVersion: string }> {
  requirePurpose(tx, MEMORY_GOVERN_PURPOSE);
  const claimIds = (await tx.query('SELECT id FROM claims WHERE owner_scope_id=$1 ORDER BY id',
    [tx.context.ownerScopeId])).rows.map(row => row['id'] as string);
  let indexed = 0, skipped = 0;
  for (let start = 0; start < claimIds.length; start += 200) {
    const result = await indexClaimEmbeddings(tx, {
      ownerScopeId: tx.context.ownerScopeId, claimIds: claimIds.slice(start, start + 200), embedder });
    indexed += result.indexed.length; skipped += result.skipped.length;
  }
  return { indexed, skipped, embeddingModel: embedder.model, embeddingVersion: embedder.version };
}
