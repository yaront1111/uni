import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { ClaimedJob, RequestContext } from '@unai/domain';
import { withOwnerTransaction, type OwnerTransaction } from '@unai/postgres';
import { createModelGateway, type ModelProvider } from '@unai/model';
import { EXTRACTION_JOB_KIND, extractionJobPayloadSchema, runExtraction } from '@unai/extraction';
import { runJobAttempt } from '@unai/jobs';
import { proposeBeliefTransaction, validateBeliefTransaction, commitBeliefTransaction } from '@unai/belief';
import { replayProjection } from '@unai/capabilities';
import type { BeliefOperation } from '@unai/domain';
import { enqueueEvidenceProcessing, processingKey } from './processing-store.js';
import { canonicalizeProcessingClaims, type ProcessedAssertion } from './processing-canonicalization.js';

export interface ProcessingRuntimeOptions {
  appPool: Pool;
  ownerScopeId: string;
  actorId: string;
  registryReleaseId: string;
  provider: ModelProvider;
  dataPurpose: string;
  maximumSensitivity: 'NORMAL' | 'PRIVATE' | 'RESTRICTED';
  workerId: string;
  leaseSeconds?: number;
  /** A stage-completion observer; failures are retryable, including a process
   * death immediately after a durable stage committed. */
  onCheckpoint?: (stage: 'EXTRACTED' | 'CANONICALIZED' | 'GOVERNED' | 'PROJECTED') => Promise<void>;
}

const ranks = { NORMAL: 0, PRIVATE: 1, RESTRICTED: 2 };

/** No timer and no implicit owner discovery. The process entry point repeatedly
 * calls this bounded owner-scoped turn; queue/ledger state survives its restart. */
export function createProcessingRuntime(options: ProcessingRuntimeOptions) {
  const context = (purpose: string, correlationId: string = randomUUID()): RequestContext => ({
    ownerScopeId: options.ownerScopeId, actorId: options.actorId, purpose, correlationId,
  });
  async function dispatch(): Promise<number> {
    const rows = await withOwnerTransaction(options.appPool, context('memory.extract'), async tx => {
      await declare(tx, options.dataPurpose, options.maximumSensitivity);
      return (await tx.query(`SELECT p.source_item_id FROM evidence_processing p
        JOIN source_items s ON s.owner_scope_id=p.owner_scope_id AND s.id=p.source_item_id
        WHERE p.owner_scope_id=$1 AND p.job_id IS NULL AND p.data_purpose=$2
        ORDER BY p.created_at,p.id LIMIT 20`, [options.ownerScopeId, options.dataPurpose])).rows;
    });
    for (const row of rows) await enqueueEvidenceProcessing({ appPool: options.appPool, context: context('jobs.enqueue'),
      evidenceId: row.source_item_id as string, registryReleaseId: options.registryReleaseId });
    return rows.length;
  }
  async function handle(job: ClaimedJob): Promise<void> {
    const payload = extractionJobPayloadSchema.parse(job.payload);
    if (payload.ownerScopeId !== options.ownerScopeId || job.ownerScopeId !== options.ownerScopeId) throw new Error('PROCESSING_OWNER_MISMATCH');
    if (payload.registryReleaseId !== options.registryReleaseId) throw new Error('PROCESSING_RELEASE_MISMATCH');
    if (payload.dataPurpose !== options.dataPurpose) throw new Error('PROCESSING_PURPOSE_REFUSED');
    const ceiling = ranks[options.maximumSensitivity] < ranks[payload.maximumSensitivity] ? options.maximumSensitivity : payload.maximumSensitivity;
    const runner = <T,>(purpose: string, run: (tx: OwnerTransaction) => Promise<T>) =>
      withOwnerTransaction(options.appPool, context(purpose, payload.correlationId), async tx => {
        await declare(tx, payload.dataPurpose, ceiling);
        return run(tx);
      });
    // A session lock spans stage transactions. A reclaimed lease cannot execute
    // overlapping canonical writes; PostgreSQL releases this lock on process loss.
    const lock = await options.appPool.connect();
    const key = 'process:' + options.ownerScopeId + ':' + payload.sourceItemId;
    try {
      await lock.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [key]);
      let row = await runner('memory.extract', async tx => {
        const source = (await tx.query('SELECT id FROM source_items WHERE owner_scope_id=$1 AND id=$2',
          [options.ownerScopeId, payload.sourceItemId])).rows[0];
        if (!source) throw new Error('PROCESSING_SOURCE_UNAVAILABLE');
        const state = (await tx.query('SELECT * FROM evidence_processing WHERE owner_scope_id=$1 AND source_item_id=$2',
          [options.ownerScopeId, payload.sourceItemId])).rows[0];
        if (!state) throw new Error('PROCESSING_INTENT_REQUIRED');
        return state;
      });
      if (row.status === 'SUCCEEDED' || row.status === 'NEEDS_REVIEW') {
        // The stage may have committed before a lost queue acknowledgement.
        // A successful retry clears that delivery error without repeating work.
        await runner('memory.extract', tx => tx.query('UPDATE evidence_processing SET last_error=NULL WHERE owner_scope_id=$1 AND source_item_id=$2',
          [options.ownerScopeId, payload.sourceItemId]));
        return;
      }
      const gateway = createModelGateway({ provider: options.provider,
        recordCall: run => withOwnerTransaction(options.appPool, context('model.call', payload.correlationId), run) });
      if (row.status === 'PENDING') {
        const result = await runExtraction({ runner, gateway, request: {
          ownerScopeId: options.ownerScopeId, sourceItemId: payload.sourceItemId, registryReleaseId: options.registryReleaseId,
          correlationId: payload.correlationId, dataPurpose: payload.dataPurpose, maximumSensitivity: ceiling,
          referenceInstant: row.reference_instant as Date | null, timeZone: row.time_zone as string | null,
          runKind: row.run_kind as 'FULL'|'TARGETED', attempt: job.attemptCount, processingKey: processingKey(payload.sourceItemId, options.registryReleaseId),
        } });
        await options.onCheckpoint?.('EXTRACTED');
        await runner('memory.extract', tx => tx.query(`UPDATE evidence_processing SET status='EXTRACTED',extraction_run_id=$3,
          unresolved_claims=$4,last_error=NULL WHERE owner_scope_id=$1 AND source_item_id=$2`,
        [options.ownerScopeId, payload.sourceItemId, result.extractionRunId, result.unknowns.length]));
      }
      const state = () => runner('memory.extract', async tx => {
        const current = (await tx.query(`SELECT p.* FROM evidence_processing p JOIN source_items s
          ON s.owner_scope_id=p.owner_scope_id AND s.id=p.source_item_id
          WHERE p.owner_scope_id=$1 AND p.source_item_id=$2`, [options.ownerScopeId,payload.sourceItemId])).rows[0];
        if (!current) throw new Error('PROCESSING_SOURCE_UNAVAILABLE');
        return current;
      });
      row = await state();
      if (row.status === 'EXTRACTED') {
        await runner('memory.canonicalize', async tx => {
          const canonical = await canonicalizeProcessingClaims(tx, { sourceItemId: payload.sourceItemId,
            extractionRunId: row.extraction_run_id as string, registryReleaseId: options.registryReleaseId,
            referenceInstant: row.reference_instant as Date | null, timeZone: row.time_zone as string | null });
          await tx.query(`UPDATE evidence_processing SET status='CANONICALIZED',canonicalized=$3,
            unresolved_claims=unresolved_claims+$4 WHERE owner_scope_id=$1 AND source_item_id=$2`,
          [options.ownerScopeId,payload.sourceItemId,JSON.stringify(canonical.assertions),canonical.unresolved]);
        });
        await options.onCheckpoint?.('CANONICALIZED');
      }
      row = await state();
      if (row.status === 'CANONICALIZED') {
        const assertions = row.canonicalized as ProcessedAssertion[];
        let transactionId: string | null = null;
        if (assertions.length > 0) {
          const request = { ownerScopeId: options.ownerScopeId, actorId: options.actorId,
            correlationId: payload.correlationId, dataPurpose: payload.dataPurpose, maximumSensitivity: ceiling };
          const operations: BeliefOperation[] = assertions.flatMap(assertion => [
            { kind: 'ADD_SUPPORT' as const, proposition: assertion.propositionId, claim: assertion.claimId, supportKind: 'DIRECT_ASSERTION' as const },
            { kind: 'SET_BELIEF_ASSESSMENT' as const, proposition: assertion.propositionId, assessmentStatus: 'PROVISIONAL' as const,
              ...(assertion.validFrom ? { validFrom: assertion.validFrom } : {}), decisionReason: { code: 'GROUNDED_EXTRACTION_REQUIRES_CONFIRMATION' } },
          ]);
          const key = processingKey(payload.sourceItemId, options.registryReleaseId);
          const proposed = await proposeBeliefTransaction(runner, request, { registryReleaseId: options.registryReleaseId,
            transactionKind: 'CANONICALIZE', risk: 'LOW', idempotencyKey: key, sourceEvidenceIds: [payload.sourceItemId], operations });
          transactionId = proposed.transactionId;
          if (proposed.status !== 'COMMITTED') {
            const validation = await validateBeliefTransaction(runner, request, transactionId);
            if (validation.decision !== 'COMMITTABLE') throw new Error('PROCESSING_GOVERNANCE_REFUSED');
          }
          await commitBeliefTransaction(runner, request, { transactionId, idempotencyKey: key });
        }
        await options.onCheckpoint?.('GOVERNED');
        await runner('memory.govern', tx => tx.query(`UPDATE evidence_processing SET status='GOVERNED',transaction_id=$3
          WHERE owner_scope_id=$1 AND source_item_id=$2`, [options.ownerScopeId,payload.sourceItemId,transactionId]));
      }
      row = await state();
      if (row.status === 'GOVERNED') {
        await runner('memory.project', async tx => {
          for (const projectionName of ['open_commitments_projection','obligations_projection','schedule_projection'] as const) {
            await replayProjection(tx, { ownerScopeId: options.ownerScopeId, projectionName, asOf: new Date(),
              transactionId: row.transaction_id as string | null, detail: { processingIntentId: row.id } });
          }
          await tx.query(`UPDATE evidence_processing SET status=CASE WHEN unresolved_claims>0 THEN 'NEEDS_REVIEW' ELSE 'SUCCEEDED' END,
            completed_at=now(),last_error=NULL WHERE owner_scope_id=$1 AND source_item_id=$2`, [options.ownerScopeId,payload.sourceItemId]);
        });
        await options.onCheckpoint?.('PROJECTED');
      }
    } catch (error) {
      const code = error instanceof Error && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.message) ? error.message : 'PROCESSING_FAILED';
      await runner('memory.extract', tx => tx.query('UPDATE evidence_processing SET last_error=$3 WHERE owner_scope_id=$1 AND source_item_id=$2',
        [options.ownerScopeId, payload.sourceItemId, code])).catch(() => undefined);
      throw new Error(code);
    } finally {
      await lock.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [key]).finally(() => lock.release());
    }
  }
  return {
    async validate(): Promise<string> {
      return withOwnerTransaction(options.appPool, context('memory.govern'), async tx => {
        const present = (await tx.query(`SELECT unai_private.processing_release_version($1) AS version,
          unai_private.registry_contract_present($1,'shared.commitment','FRAME') AS frame,
          unai_private.registry_contract_present($1,'shared.commitment.action_description','PREDICATE') AS description`,
        [options.registryReleaseId])).rows[0];
        if (!present?.version || !present.frame || !present.description) throw new Error('PROCESSING_RELEASE_UNAVAILABLE');
        return present.version as string;
      });
    },
    dispatch,
    async runOnce() {
      await dispatch();
      return runJobAttempt(options.appPool, context('jobs.work'), { worker: options.workerId,
        leaseSeconds: options.leaseSeconds ?? 300, jobKinds: [EXTRACTION_JOB_KIND], handler: handle });
    },
  };
}

async function declare(tx: OwnerTransaction, purpose: string, sensitivity: string): Promise<void> {
  await tx.query("SELECT set_config('unai.data_purpose',$1,true),set_config('unai.maximum_sensitivity',$2,true)", [purpose, sensitivity]);
}
