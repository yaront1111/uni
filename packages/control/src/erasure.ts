import { randomUUID } from 'node:crypto';
import { cascadeCountsSchema, type CascadeCounts } from '@unai/domain';
import { ControlError, requirePurpose, type ControlTransaction } from './transaction.js';

/**
 * The deletion cascade and retention (PRD §30.7, §34 invariant 10; design entity
 * `retention_and_deletion_requests`; CRT-SEC-06-A; ADR 0030 §8).
 *
 * The cascade itself is `unai_private.erase_evidence`, one bounded definer the
 * application role may call under `data.delete` and nothing else: the role holds
 * no DELETE grant on any canonical or evidence table and keeps holding none. What
 * this file adds is the order around it -- the raw object is deleted from
 * storage after the database erasure and inside the same transaction, so a
 * storage failure rolls the erasure back -- and the request record, which holds
 * counts and identifiers only.
 */

export const DATA_DELETE_PURPOSE = 'data.delete';
export const DATA_EXPORT_PURPOSE = 'data.export';

export interface ErasedEvidence {
  readonly evidenceId: string;
  readonly rawObjectRef: string;
  readonly counts: Readonly<Record<string, number>>;
  readonly claimIds: readonly string[];
  readonly propositionIds: readonly string[];
  readonly resolutionAssertionIds: readonly string[];
  readonly frameInstanceIds: readonly string[];
}

/** Whether a live evidence item exists for this owner. Read under `data.delete`,
 * which sees the owner's evidence whatever purpose it was stored for. */
export async function liveEvidenceExists(tx: ControlTransaction, evidenceId: string): Promise<boolean> {
  requirePurpose(tx, DATA_DELETE_PURPOSE);
  return (await tx.query('SELECT 1 FROM source_items WHERE owner_scope_id=$1 AND id=$2 AND deleted_at IS NULL',
    [tx.context.ownerScopeId, evidenceId])).rowCount === 1;
}

/** Run the database half of the cascade for one evidence item. */
export async function eraseEvidence(tx: ControlTransaction, evidenceId: string): Promise<ErasedEvidence> {
  requirePurpose(tx, DATA_DELETE_PURPOSE);
  if (!await liveEvidenceExists(tx, evidenceId)) throw new ControlError('EVIDENCE_NOT_FOUND', { evidenceId });
  const receipt = (await tx.query('SELECT unai_private.erase_evidence($1,$2) AS receipt',
    [tx.context.ownerScopeId, evidenceId])).rows[0]?.['receipt'] as Record<string, any> | undefined;
  if (!receipt) throw new ControlError('ERASURE_NOT_RECORDED', { evidenceId });
  return {
    evidenceId, rawObjectRef: receipt['rawObjectRef'] as string, counts: receipt['counts'] as Record<string, number>,
    claimIds: receipt['claimIds'] as string[], propositionIds: receipt['propositionIds'] as string[],
    resolutionAssertionIds: receipt['resolutionAssertionIds'] as string[],
    frameInstanceIds: receipt['frameInstanceIds'] as string[],
  };
}

/** Sum what several erasures removed into the receipt's categories. Search index
 * entries are the lexical index (the anchors' text) and the semantic index. */
export function cascadeCounts(erased: readonly ErasedEvidence[], rawObjectsDeleted: number): CascadeCounts {
  const sum = (key: string) => erased.reduce((total, item) => total + Number(item.counts[key] ?? 0), 0);
  return cascadeCountsSchema.parse({
    rawObjects: rawObjectsDeleted, parsedContent: sum('parsedContent'), anchors: sum('anchors'), claims: sum('claims'),
    unsupportedBeliefs: sum('unsupportedBeliefs'), beliefAssessments: sum('beliefAssessments'),
    supportRows: sum('supportRows'), resolutionAssertions: sum('resolutionAssertions'), links: sum('links'),
    embeddings: sum('embeddings'), summaries: sum('summaries'),
    searchIndexEntries: sum('anchors') + sum('embeddings'), projectionRows: sum('projectionRows'),
    threadMemberships: sum('threadMemberships'), aliases: sum('aliases'), extractionRuns: sum('extractionRuns'),
    overlayTextsErased: sum('overlayTextsErased'), transactionPayloadsErased: sum('transactionPayloadsErased'),
    contextPacketsErased: sum('contextPacketsErased'), derivedRecords: sum('derivedRecords'),
  });
}

/** Record one export or deletion request with its receipt. The scope and the
 * receipt carry identifiers and counts; the request records no content. */
export async function recordDataRequest(tx: ControlTransaction, input: {
  requestKind: 'EXPORT' | 'DELETE'; trigger: 'OWNER_REQUEST' | 'RETENTION_POLICY'; scope: Record<string, unknown>;
  receipt: Record<string, unknown>; requestedAt: Date;
}): Promise<string> {
  requirePurpose(tx, DATA_DELETE_PURPOSE, DATA_EXPORT_PURPOSE);
  const id = randomUUID();
  await tx.query(
    `INSERT INTO retention_and_deletion_requests(id,owner_scope_id,request_kind,trigger,scope,status,cascade_receipt,
       requested_by_user_id,requested_at,completed_at) VALUES($1,$2,$3,$4,$5,'COMPLETED',$6,$7,$8,clock_timestamp())`,
    [id, tx.context.ownerScopeId, input.requestKind, input.trigger, JSON.stringify(input.scope),
      JSON.stringify(input.receipt), tx.context.actorId, input.requestedAt]);
  return id;
}

/**
 * The evidence past its source type's raw retention, oldest first. Read at
 * cleanup time from `retention_settings`, so the rule a cleanup applies is the
 * one saved before it ran.
 */
export async function listExpiredEvidence(tx: ControlTransaction, asOf: Date, limit = 50): Promise<string[]> {
  requirePurpose(tx, DATA_DELETE_PURPOSE);
  return (await tx.query(
    `SELECT s.id FROM source_items s JOIN retention_settings r ON r.owner_scope_id=s.owner_scope_id AND r.source_type=s.source_type
     WHERE s.owner_scope_id=$1 AND s.deleted_at IS NULL AND r.raw_retention_days IS NOT NULL
       AND s.observed_at < $2::timestamptz - make_interval(days => r.raw_retention_days)
     ORDER BY s.observed_at,s.id LIMIT $3`,
    [tx.context.ownerScopeId, asOf, Math.min(Math.max(limit, 1), 200)])).rows.map(row => row['id'] as string);
}

/** Expire the regenerable derivatives of each source type past its derived
 * retention. Raw evidence and canonical beliefs are untouched. */
export async function expireDerivedData(tx: ControlTransaction, asOf: Date): Promise<{
  sourceType: string; evidenceItems: number; embeddings: number; summaries: number }[]> {
  requirePurpose(tx, DATA_DELETE_PURPOSE);
  const rules = (await tx.query(
    `SELECT source_type,derived_retention_days FROM retention_settings
     WHERE owner_scope_id=$1 AND derived_retention_days IS NOT NULL ORDER BY source_type`, [tx.context.ownerScopeId])).rows;
  const results = [];
  for (const rule of rules) {
    const cutoff = new Date(asOf.getTime() - Number(rule['derived_retention_days']) * 86_400_000);
    const expired = (await tx.query('SELECT unai_private.expire_derived_data($1,$2,$3) AS expired',
      [tx.context.ownerScopeId, rule['source_type'], cutoff])).rows[0]?.['expired'] as Record<string, number>;
    results.push({ sourceType: rule['source_type'] as string, evidenceItems: Number(expired['evidenceItems'] ?? 0),
      embeddings: Number(expired['embeddings'] ?? 0), summaries: Number(expired['summaries'] ?? 0) });
  }
  return results;
}
