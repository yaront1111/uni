import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { withOwnerTransaction } from '@unai/postgres';
import { DATA_DELETE_PURPOSE } from '@unai/control';
import { RETENTION_CLEANUP_BATCH, runRetentionCleanup, type ControlRunner } from './control.js';
import type { EvidenceObjects } from './evidence.js';

/**
 * Scheduled retention cleanup (PRD §12.10, §30.7): the owner's saved retention
 * rules take effect without the owner pressing "Clean up now". The processing
 * worker runs `runRetentionCleanup`, the function `POST /v1/data/retention/cleanup`
 * runs, so there is one cascade: raw evidence and its objects, expired
 * conversations, then the regenerable derivatives.
 *
 * One owner scope per process: every transaction runs under the worker's own owner
 * scope and actor, under `data.delete` (audit kind DELETION), except the projection
 * replay `deleteEvidence` opens under `memory.project`. A pass erases at most
 * RETENTION_CLEANUP_BATCH evidence items, oldest first, under one correlation id.
 * A tick repeats passes until one comes back short, at most `maxPasses`, and the
 * next window erases the rest.
 *
 * The window is process-local: a restarted worker, or each `--once` run, repeats
 * the cleanup. It is idempotent: an erased item is never listed again, and an empty
 * pass adds only the derived-expiry audit row. Only counts leave this file.
 */

/** At most 20 × 50 = 1000 evidence items per tick. */
export const RETENTION_MAX_PASSES = 20;

export interface RetentionTick {
  readonly passes: number;
  readonly evidenceErased: number;
  readonly conversationsDeleted: number;
  readonly derivedEvidenceItems: number;
  readonly derivedEmbeddings: number;
  readonly derivedSummaries: number;
  readonly projectionsRebuilt: number;
}

export interface RetentionSchedulerOptions {
  /** Milliseconds since the epoch. */
  readonly clock: () => number;
  /** A validated interval (processing-config.ts): 0 disables the cleanup. */
  readonly intervalMs: number;
  readonly cleanup: (asOf: Date) => Promise<RetentionTick>;
}

const log = (line: Record<string, unknown>) => console.info(JSON.stringify({ event: 'retention.scheduler', ...line }));

export function createRetentionScheduler(options: RetentionSchedulerOptions) {
  const { clock, intervalMs } = options;
  const disabled = intervalMs === 0;
  if (disabled) log({ status: 'RETENTION_SCHEDULER_DISABLED' });
  let nextTickAt = 0;

  async function pass(now: number): Promise<RetentionTick> {
    const result = await options.cleanup(new Date(now));
    // The counts by name, so nothing else a port returns reaches the log.
    const tick: RetentionTick = { passes: result.passes, evidenceErased: result.evidenceErased,
      conversationsDeleted: result.conversationsDeleted, derivedEvidenceItems: result.derivedEvidenceItems,
      derivedEmbeddings: result.derivedEmbeddings, derivedSummaries: result.derivedSummaries,
      projectionsRebuilt: result.projectionsRebuilt };
    log({ ...tick });
    return tick;
  }

  return {
    /** One cleanup now (`--once`). */
    tick: async (): Promise<RetentionTick | null> => disabled ? null : pass(clock()),
    /** The worker loop's call: one cleanup per window, not per poll turn. The next
     * boundary is fixed before the pass, so a failed pass waits for it. */
    tickIfDue: async (): Promise<RetentionTick | null> => {
      const now = clock();
      if (disabled || now < nextTickAt) return null;
      nextTickAt = (Math.floor(now / intervalMs) + 1) * intervalMs;
      return pass(now);
    },
  };
}

/** The real port: the route's cleanup, one owner transaction per step, bound to the
 * worker's owner scope and actor and to one correlation id per pass. */
export function retentionSchedulerPorts(options: { readonly appPool: Pool; readonly ownerScopeId: string;
  readonly actorId: string; readonly evidenceObjects: EvidenceObjects; readonly maxPasses?: number }) {
  const { appPool, ownerScopeId, actorId, evidenceObjects, maxPasses = RETENTION_MAX_PASSES } = options;
  return {
    cleanup: async (asOf: Date): Promise<RetentionTick> => {
      let passes = 0, evidenceErased = 0, conversationsDeleted = 0, projectionsRebuilt = 0;
      let derivedEvidenceItems = 0, derivedEmbeddings = 0, derivedSummaries = 0;
      while (passes < maxPasses) {
        const correlationId = randomUUID();
        const run: ControlRunner = (fn, purpose = DATA_DELETE_PURPOSE) =>
          withOwnerTransaction(appPool, { ownerScopeId, actorId, purpose, correlationId }, fn);
        const result = await runRetentionCleanup(run, evidenceObjects, asOf);
        const erased = result.deletion?.evidenceIds.length ?? 0;
        passes++;
        evidenceErased += erased;
        conversationsDeleted += result.conversationsDeleted.length;
        projectionsRebuilt += result.deletion?.projectionsRebuilt.length ?? 0;
        for (const expired of result.derivedExpired) {
          derivedEvidenceItems += expired.evidenceItems; derivedEmbeddings += expired.embeddings; derivedSummaries += expired.summaries;
        }
        // ponytail: the drain follows evidence batches only; past applyRetention's 200
        // conversations per pass, the rest wait for the next window.
        if (erased < RETENTION_CLEANUP_BATCH) break;
      }
      return { passes, evidenceErased, conversationsDeleted, derivedEvidenceItems, derivedEmbeddings, derivedSummaries, projectionsRebuilt };
    },
  };
}
