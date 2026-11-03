import { z } from 'zod';
import type { ClaimedJob } from '@unai/domain';
import type { ModelGateway } from '@unai/model';
import { runExtraction, ExtractionError,
  type ExtractionRequest, type ExtractionTransactionRunner } from './runs.js';

/** The extraction worker's handler for the durable queue (ADR 0012).
 *
 * Deep extraction runs here and nowhere else: the ingest path stores evidence
 * synchronously and returns, so an acknowledged ingestion never waits on a model
 * (PRD §35.1). A handler that throws a stable code lets `runJobAttempt` retry the
 * job within its attempt budget and dead-letter it when the budget is spent.
 * A code in TERMINAL_EXTRACTION_ERROR_CODES dead-letters on the failing attempt
 * when the worker turn passes the list as `runJobAttempt`'s `terminalErrorCodes`;
 * the evidence it read is untouched in both cases (CRT-EVD-05-A).
 */

export const EXTRACTION_JOB_KIND = 'evidence.extract';

/** Explicit deterministic refusals; every other code remains retryable.
 * EXTRACTION_TRIAGE_REQUIRED may recover when the missing decision is written (no model call).
 * MODEL_OUTPUT_INVALID and MODEL_PROVIDER_FAILED may succeed on a later call. */
export const TERMINAL_EXTRACTION_ERROR_CODES = Object.freeze([
  'EXTRACTION_INPUT_TOO_LARGE', // Immutable bytes/anchors and triage route exceed fixed bounds before any run INSERT or call.
  'MODEL_COST_BUDGET_EXCEEDED', // The immutable triage budget was exceeded by a recorded, billed call; retries bill again.
  'EXTRACTION_ROUTE_REFUSED', // Immutable triage route and job payload run kind cannot become admissible on retry.
] as const);

export const extractionJobPayloadSchema = z.strictObject({
  ownerScopeId: z.uuid(),
  sourceItemId: z.uuid(),
  runKind: z.enum(['LAZY', 'TARGETED', 'SHADOW', 'FULL']).default('FULL'),
  registryReleaseId: z.uuid(),
  correlationId: z.uuid(),
  /** The evidence access context the run reads under, carried on the job so a
   * retry reads under exactly the same gate the first attempt did. */
  dataPurpose: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
  maximumSensitivity: z.enum(['NORMAL', 'PRIVATE', 'RESTRICTED']),
  /** The instant relative time phrases are read against, carried on the job so a
   * retry resolves them exactly as the first attempt would have. */
  referenceInstant: z.iso.datetime({ offset: true }).nullable(),
  timeZone: z.string().min(1).max(64).nullable(),
  promptVersion: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/).optional(),
  modelId: z.string().min(1).max(128).optional(),
});
export type ExtractionJobPayload = z.input<typeof extractionJobPayloadSchema>;

export function createExtractionJobHandler(options: {
  gateway: ModelGateway;
  /** Opens a transaction under the purpose the step needs, for the owner scope
   * the job belongs to. */
  runnerFor(ownerScopeId: string): ExtractionTransactionRunner;
}): (job: ClaimedJob) => Promise<void> {
  return async job => {
    if (job.jobKind !== EXTRACTION_JOB_KIND) throw new ExtractionError('EXTRACTION_JOB_KIND_UNEXPECTED');
    const parsed = extractionJobPayloadSchema.safeParse(job.payload);
    if (!parsed.success) throw new ExtractionError('EXTRACTION_JOB_PAYLOAD_INVALID');
    const payload = parsed.data;
    if (payload.ownerScopeId !== job.ownerScopeId) throw new ExtractionError('EXTRACTION_JOB_OWNER_MISMATCH');
    const request: ExtractionRequest = {
      attempt:job.attemptCount,
      ownerScopeId: payload.ownerScopeId,
      sourceItemId: payload.sourceItemId,
      runKind: payload.runKind,
      registryReleaseId: payload.registryReleaseId,
      correlationId: payload.correlationId,
      dataPurpose: payload.dataPurpose,
      maximumSensitivity: payload.maximumSensitivity,
      referenceInstant: payload.referenceInstant === null ? null : new Date(payload.referenceInstant),
      timeZone: payload.timeZone,
      ...(payload.promptVersion === undefined ? {} : { promptVersion: payload.promptVersion }),
      ...(payload.modelId === undefined ? {} : { modelId: payload.modelId }),
    };
    await runExtraction({ runner: options.runnerFor(payload.ownerScopeId), gateway: options.gateway, request });
  };
}
