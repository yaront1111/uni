import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import {
  connectorSyncJobPayloadSchema, syncRequestSchema,
  type ClaimedJob, type ConnectorSyncJobPayload, type PublicJob, type RequestContext,
} from '@unai/domain';
import { withOwnerTransaction, type OwnerTransaction } from '@unai/postgres';
import { enqueueJob, runJobAttempt, type JobAttempt } from '@unai/jobs';
import {
  CONNECTOR_MANAGE_PURPOSE, CONNECTOR_SYNC_PURPOSE, ConnectorError, LIFECYCLE_REFUSALS, ceilingAdmits, credentialRevoked,
  manifestFor, markTokenRevoked, recordSyncFailure, runConnectorSync, storedSensitivity,
  type ConnectorClient, type SourceIngest,
} from '@unai/connectors';
import { readSensitivityFloor } from '@unai/control';
import { hasSyncClient, type ConnectorClientInput } from './connectors.js';
import { importSource, type EvidenceObjects } from './evidence.js';

/**
 * Connector sync as a durable job (PRD §41 Reliability): the same import path as
 * `POST /v1/connectors/:id/sync`, run by the processing worker so a provider
 * outage is retried within the job's bounded attempts and then lands in the
 * dead-letter view, instead of depending on the owner pressing "Sync".
 *
 * One owner scope per process, like the other worker runtimes: the queue is
 * claimed under the configured owner scope, and a connector of another owner is
 * invisible under row-level security, so it fails as CONNECTOR_NOT_FOUND.
 *
 * A provider 401 (after one forced refresh for Google), or a Google token
 * exchange invalid_grant (400), marks TOKEN_REVOKED. A 403 never does: Google
 * and GitHub use it for rate limits and insufficient scope, so it is recorded
 * as a sync failure and retried with its credential handle intact. A stop or a
 * consent change committed before the run's commit point (CONNECTOR_INGESTION_STOPPED,
 * CONNECTOR_CAPABILITY_NOT_GRANTED) is a refusal, not a failure: the job is done
 * with one REFUSED audit row and the connector is left as that change left it.
 *
 * Only stable codes leave this file: a ConnectorError's detail, provider text and
 * database text never reach jobs.last_error, an audit row or a log line.
 */

export const CONNECTOR_SYNC_JOB_KIND = 'connector.sync';
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
type Sensitivity = 'NORMAL' | 'PRIVATE' | 'RESTRICTED';

/** Enqueue one sync under `jobs.enqueue` (enqueueJob enforces the purpose). The
 * key is derived from connector, mode and window, so a scheduler tick that fires
 * twice in one window enqueues one job; the same window with a different
 * maxPages is JOB_IDEMPOTENCY_CONFLICT. */
export async function enqueueConnectorSync(tx: OwnerTransaction, input: {
  readonly connectorId: string; readonly mode: ConnectorSyncJobPayload['mode']; readonly window: string;
  readonly maxPages?: number; readonly maxAttempts?: number;
}): Promise<PublicJob> {
  const parsed = connectorSyncJobPayloadSchema.safeParse({
    connectorId: input.connectorId, mode: input.mode, maxPages: input.maxPages ?? 1, window: input.window,
  });
  if (!parsed.success) throw new Error('CONNECTOR_SYNC_JOB_INVALID');
  const payload = parsed.data;
  return enqueueJob(tx, {
    jobKind: CONNECTOR_SYNC_JOB_KIND, payload, maxAttempts: input.maxAttempts ?? 3,
    idempotencyKey: 'connector_sync_' + payload.connectorId + '_' + payload.mode + '_' + payload.window,
  });
}

export interface ConnectorSyncRuntimeOptions {
  readonly appPool: Pool;
  readonly ownerScopeId: string;
  readonly actorId: string;
  readonly dataPurpose: string;
  readonly maximumSensitivity: Sensitivity;
  readonly workerId: string;
  readonly evidenceObjects: EvidenceObjects;
  readonly connectorClient: (input: ConnectorClientInput)
    => ConnectorClient | Promise<ConnectorClient>;
  readonly leaseSeconds?: number;
}

const context = (options: ConnectorSyncRuntimeOptions, purpose: string, correlationId: string): RequestContext => ({
  ownerScopeId: options.ownerScopeId, actorId: options.actorId, purpose, correlationId,
});

/** The sync transaction. Answers null when the run completed, otherwise the stable
 * code of a refusal that leaves the job done, with the refusal audited: a connector
 * that may not ingest (its status is checked before a client is built, because a
 * revoked or disconnected connector holds no credential handle) or a type with no
 * provider to poll. */
async function sync(options: ConnectorSyncRuntimeOptions, ingest: SourceIngest, payload: ConnectorSyncJobPayload,
  correlationId: string): Promise<string | null> {
  return withOwnerTransaction(options.appPool, context(options, CONNECTOR_SYNC_PURPOSE, correlationId), async tx => {
    await tx.query("SELECT set_config('unai.data_purpose',$1,true),set_config('unai.maximum_sensitivity',$2,true)",
      [options.dataPurpose, options.maximumSensitivity]);
    const connector = (await tx.query('SELECT connector_type,secret_ref,status FROM connectors WHERE id=$1 AND owner_scope_id=$2',
      [payload.connectorId, options.ownerScopeId])).rows[0];
    if (!connector) throw new ConnectorError('CONNECTOR_NOT_FOUND', { connectorId: payload.connectorId });
    if (connector.status !== 'ACTIVE' && connector.status !== 'SYNC_FAILED') {
      await tx.audit({ policyDecision: 'DENY', codeVersion: '0.1.0', result: 'REFUSED',
        objects: [{ type: 'connectors', id: payload.connectorId, fields: ['status'] }] });
      return 'CONNECTOR_INGESTION_STOPPED';
    }
    const connectorType = connector.connector_type as string;
    // First: past this point a ceiling below the type's floor throws CEILING_TOO_LOW
    // and the production factory throws CREDENTIAL_MISSING, and settle() records and
    // retries both. A first-party type must never be recorded as a failed sync.
    if (!hasSyncClient(connectorType)) {
      await tx.audit({ policyDecision: 'DENY', codeVersion: '0.1.0', result: 'REFUSED',
        objects: [{ type: 'connectors', id: payload.connectorId, fields: ['connector_type'] }] });
      return 'CONNECTOR_CLIENT_UNSUPPORTED';
    }
    const request = syncRequestSchema.parse({ mode: payload.mode, maxPages: payload.maxPages, allowedPurposes: [options.dataPurpose] });
    const sensitivityFloor = await readSensitivityFloor(tx, connectorType);
    // The route's ceiling check (connectors.ts assertCeilingAdmitsFloor), by name.
    if (!ceilingAdmits(options.maximumSensitivity, storedSensitivity(manifestFor(connectorType), request.sensitivity, sensitivityFloor))) {
      throw new ConnectorError('CONNECTOR_SENSITIVITY_CEILING_TOO_LOW');
    }
    const client = await options.connectorClient({
      connectorType, ownerScopeId: options.ownerScopeId, secretRef: (connector.secret_ref as string | null) ?? null });
    const result = await runConnectorSync(tx, { connectorId: payload.connectorId, request, client, ingest, sensitivityFloor });
    await tx.audit({ policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS',
      objects: [{ type: 'connectors', id: payload.connectorId, fields: ['last_cursor', 'cursor_updated_at'] },
        ...result.evidenceIds.slice(0, 99).map(id => ({
          type: 'source_items', id, fields: ['source_type', 'external_id', 'content_hash'] }))] });
    return null;
  });
}

/** Bookkeeping after a failed sync, each in its own transaction because the
 * sync's own work has rolled back. Answers the code when the job is done;
 * throws it when the attempt must fail (retried unless runOnce lists it terminal).
 * Three outcomes:
 * - a lifecycle refusal (LIFECYCLE_REFUSALS: a stop or a consent change committed
 *   before the run's commit point) is done, audited REFUSED with the connector and no field, because
 *   another transaction decided it, nothing is written to the connector, and a retry
 *   would be refused the same way;
 * - a revocation (credentialRevoked) is done, marking TOKEN_REVOKED;
 * - any other failure is recorded and thrown, then retried unless terminal. */
async function settle(options: ConnectorSyncRuntimeOptions, connectorId: string, correlationId: string,
  error: unknown): Promise<string> {
  const code = error instanceof Error && CODE.test(error.message) ? error.message : 'CONNECTOR_SYNC_FAILED';
  if (!(error instanceof ConnectorError) || code === 'CONNECTOR_NOT_FOUND') throw new Error(code);
  if (LIFECYCLE_REFUSALS.includes(code)) {
    await withOwnerTransaction(options.appPool, context(options, CONNECTOR_SYNC_PURPOSE, correlationId), tx =>
      tx.audit({ policyDecision: 'DENY', codeVersion: '0.1.0', result: 'REFUSED',
        objects: [{ type: 'connectors', id: connectorId, fields: [] }] })).catch(() => undefined);
    return code;
  }
  if (credentialRevoked(error)) {
    await withOwnerTransaction(options.appPool, context(options, CONNECTOR_MANAGE_PURPOSE, correlationId), async tx => {
      await markTokenRevoked(tx, connectorId);
      await tx.audit({ policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS',
        objects: [{ type: 'connectors', id: connectorId, fields: ['status', 'secret_ref', 'last_sync_error'] }] });
    }).catch(() => undefined);
    return code;
  }
  await withOwnerTransaction(options.appPool, context(options, CONNECTOR_SYNC_PURPOSE, correlationId), async tx => {
    await recordSyncFailure(tx, connectorId, code);
    await tx.audit({ policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'FAILURE',
      objects: [{ type: 'connectors', id: connectorId, fields: ['status', 'last_sync_error'] }] });
  }).catch(() => undefined);
  throw new Error(code);
}

/** Codes that dead-letter the job on the failing attempt (ADR 0012 terminal codes).
 * A FAILED job is claimable again at the worker's next poll with no backoff, so a
 * retry of a rate-limited run would land inside the provider's Retry-After and spend
 * its hourly budget (ADR 0041 D7). The connector stays SYNC_FAILED with its cursor,
 * and the scheduler's next window is the next sync. Every other code keeps the
 * bounded retry. */
export const TERMINAL_CONNECTOR_SYNC_ERROR_CODES = Object.freeze(['CONNECTOR_RATE_LIMITED'] as const);

/** No dispatch and no timer: something else enqueues, and the worker loop calls runOnce. */
export function createConnectorSyncRuntime(options: ConnectorSyncRuntimeOptions) {
  const ingest: SourceIngest = (tx, request) => importSource(tx as unknown as OwnerTransaction, options.evidenceObjects, {
    sourceType: request.sourceType, connectorId: request.connectorId, payload: request.payload,
    sensitivity: request.sensitivity, allowedPurposes: request.allowedPurposes,
  });
  const log = (correlationId: string, status: string) => console.info(JSON.stringify({
    event: 'connector.sync', correlationId, ownerScopeId: options.ownerScopeId, purpose: CONNECTOR_SYNC_PURPOSE, status,
  }));
  async function handle(job: ClaimedJob): Promise<void> {
    if (job.ownerScopeId !== options.ownerScopeId) throw new Error('PROCESSING_OWNER_MISMATCH');
    const parsed = connectorSyncJobPayloadSchema.safeParse(job.payload);
    if (!parsed.success) throw new Error('CONNECTOR_SYNC_JOB_INVALID');
    // The job id is the correlation id of every transaction of the attempt, so
    // its audit rows can be found from the jobs console.
    const correlationId = job.jobId;
    try {
      const refused = await sync(options, ingest, parsed.data, correlationId);
      if (refused !== null) log(correlationId, refused);
    } catch (error) {
      // settle only ever throws an Error carrying a stable code.
      try { log(correlationId, await settle(options, parsed.data.connectorId, correlationId, error)); }
      catch (failure) { log(correlationId, (failure as Error).message); throw failure; }
    }
  }
  return {
    handle,
    runOnce: (): Promise<JobAttempt> => runJobAttempt(options.appPool, context(options, 'jobs.work', randomUUID()), {
      worker: options.workerId, leaseSeconds: options.leaseSeconds ?? 600,
      jobKinds: [CONNECTOR_SYNC_JOB_KIND], terminalErrorCodes: TERMINAL_CONNECTOR_SYNC_ERROR_CODES, handler: handle,
    }),
  };
}
