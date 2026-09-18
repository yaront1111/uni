import { PROJECTION_NAMES, type ProjectionName, type ProjectionRebuildReceipt, type RebuildTrigger } from '@unai/domain';
import type { MemoryTransaction } from '@unai/memory';
import { replayProjection, REDUCER_VERSION } from './projections.js';

/**
 * The projection replay tool (PRD §25.4, §35.14, §49; CRT-PRJ-02-A,
 * CRT-PRJ-02-B).
 *
 * `uai registry projection-replay` is the operator surface; this is what it runs,
 * and the projection tests run the same function, so the tool the runbook names
 * and the tool the acceptance suite exercises are one implementation.
 *
 * It answers a rebuild receipt per projection, each carrying `equalsIncremental`:
 * the computed answer to "did replaying produce the rows that were already
 * there?". After the tables have been dropped and recreated there is nothing to
 * compare against, so that run reports `rowsRebuilt` and a null comparison, and
 * the caller compares the rebuilt rows with the snapshot it took before the drop
 * -- which is exactly what CRT-PRJ-02-B asks for and what
 * `packages/capabilities/src/projections.test.ts` does.
 *
 * `asOf` is an input, not the clock. Two replays of one pinned input set agree
 * only if they agree about what time it is when they decide whether a commitment
 * is overdue (PRD §25.4 "deterministic for a pinned input set").
 */

export interface ProjectionReplayRequest {
  readonly ownerScopeId: string;
  readonly projections?: readonly ProjectionName[];
  readonly asOf: Date;
  readonly trigger?: RebuildTrigger;
  readonly transactionId?: string | null;
  readonly compareWithStored?: boolean;
}

export interface ProjectionReplayResult {
  readonly ownerScopeId: string;
  readonly reducerVersion: string;
  readonly asOf: string;
  readonly receipts: readonly ProjectionRebuildReceipt[];
  /** True when every projection replayed equalled what was stored, and null when
   * no comparison was made. Never asserted: it is the conjunction of the
   * receipts' own computed verdicts. */
  readonly equalsIncremental: boolean | null;
}

export async function runProjectionReplay(
  tx: MemoryTransaction, request: ProjectionReplayRequest,
): Promise<ProjectionReplayResult> {
  const projections = request.projections ?? PROJECTION_NAMES;
  const receipts: ProjectionRebuildReceipt[] = [];
  for (const projectionName of projections) {
    receipts.push(await replayProjection(tx, {
      ownerScopeId: request.ownerScopeId, projectionName, asOf: request.asOf,
      trigger: request.trigger ?? 'MANUAL_REPLAY',
      transactionId: request.transactionId ?? null,
      compareWithStored: request.compareWithStored ?? true,
    }));
  }
  const verdicts = receipts.map(receipt => receipt.equalsIncremental).filter((value): value is boolean => value !== null);
  return Object.freeze({
    ownerScopeId: request.ownerScopeId,
    reducerVersion: REDUCER_VERSION,
    asOf: request.asOf.toISOString(),
    receipts: Object.freeze(receipts),
    equalsIncremental: verdicts.length === 0 ? null : verdicts.every(Boolean),
  });
}
