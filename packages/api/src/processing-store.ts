import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { RequestContext } from '@unai/domain';
import { withOwnerTransaction, type OwnerTransaction } from '@unai/postgres';
import { enqueueJob } from '@unai/jobs';
import { EXTRACTION_JOB_KIND } from '@unai/extraction';

export const processingKey = (sourceItemId: string, releaseId: string) =>
  createHash('sha256').update('processing-v1:' + sourceItemId + ':' + releaseId).digest('hex');

/** Explicit document triggers promote a deferred item in the ingest transaction.
 * The actual job may be dispatched later; this row is the recoverable intent. */
export async function requestDocumentProcessing(tx: OwnerTransaction, sourceItemId: string): Promise<void> {
  await tx.query(`INSERT INTO evidence_processing(id,owner_scope_id,source_item_id,actor_id,data_purpose,maximum_sensitivity,
    reference_instant,time_zone,source_time_precision,run_kind)
    SELECT s.id,s.owner_scope_id,s.id,$3,current_setting('unai.data_purpose',true),current_setting('unai.maximum_sensitivity',true),
      s.occurred_at,CASE WHEN length(s.deterministic_metadata->>'timeZone') BETWEEN 1 AND 64 THEN s.deterministic_metadata->>'timeZone' END,
      CASE WHEN s.occurred_at IS NULL THEN 'UNKNOWN' ELSE 'EXACT_INSTANT' END,
      CASE WHEN t.tier1_route='DEFER_UNTIL_RELEVANT' THEN 'TARGETED' ELSE 'FULL' END
    FROM source_items s JOIN triage_decisions t ON t.owner_scope_id=s.owner_scope_id AND t.source_item_id=s.id
    WHERE s.owner_scope_id=$1 AND s.id=$2 AND t.tier1_route IN ('FULL_EXTRACTION','ENTITY_EXTRACTION','DEFER_UNTIL_RELEVANT')
    ON CONFLICT(owner_scope_id,source_item_id) DO NOTHING`, [tx.context.ownerScopeId, sourceItemId, tx.context.actorId]);
}

/** Dispatch is idempotent across crashes between queue insertion and ledger update.
 * IDs, source time and the release pin form the immutable payload; no clock tick or
 * request correlation changes its identity on a retry. */
export async function enqueueEvidenceProcessing(options: {
  appPool: Pool; context: RequestContext; evidenceId: string; registryReleaseId: string;
}): Promise<{ jobId: string }> {
  return withOwnerTransaction(options.appPool, { ...options.context, purpose: 'jobs.enqueue' }, async tx => {
    const row = (await tx.query('SELECT * FROM evidence_processing WHERE owner_scope_id=$1 AND source_item_id=$2 FOR UPDATE',
      [tx.context.ownerScopeId, options.evidenceId])).rows[0];
    if (!row) throw new Error('PROCESSING_INTENT_REQUIRED');
    if (row.registry_release_id !== null && row.registry_release_id !== options.registryReleaseId) throw new Error('PROCESSING_RELEASE_MISMATCH');
    if (row.job_id !== null) return { jobId: row.job_id as string };
    const job = await enqueueJob(tx, { jobKind: EXTRACTION_JOB_KIND,
      idempotencyKey: processingKey(options.evidenceId, options.registryReleaseId), maxAttempts: 3,
      payload: { ownerScopeId: tx.context.ownerScopeId, sourceItemId: options.evidenceId,
        registryReleaseId: options.registryReleaseId, correlationId: row.id, runKind: row.run_kind,
        dataPurpose: row.data_purpose, maximumSensitivity: row.maximum_sensitivity,
        referenceInstant: row.reference_instant?.toISOString() ?? null, timeZone: row.time_zone ?? null } });
    await tx.query('UPDATE evidence_processing SET registry_release_id=$3,job_id=$4 WHERE owner_scope_id=$1 AND source_item_id=$2',
      [tx.context.ownerScopeId, options.evidenceId, options.registryReleaseId, job.jobId]);
    await tx.audit({ policyDecision: 'ALLOW', codeVersion: 'processing-0.1.0', result: 'SUCCESS',
      objects: [{ type: 'jobs', id: job.jobId, fields: ['job_kind','status'] }] });
    return { jobId: job.jobId };
  });
}
