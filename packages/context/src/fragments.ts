import { contextProjectionFragmentSchema, type ProjectionName, type PublicOverlayDelta } from '@unai/domain';
import type { MemoryTransaction } from '@unai/memory';
import { readCommitmentsProjection, readObligationsProjection, readScheduleProjection } from '@unai/capabilities';
import type { z } from 'zod';

/** The typed projection state a packet or a thread view carries (PRD §23.2 step
 * 3, §23.5 `projectionFragments`).
 *
 * The broker reads the projections through the capability package's own reads, so
 * the fragment it reports is the same state the Commitments and Obligations
 * screens read -- including the owner's pending corrections folded in, the
 * completeness flag and the watermarks. It reduces nothing and writes nothing.
 */

export type ContextProjectionFragment = z.infer<typeof contextProjectionFragmentSchema>;

const READS = Object.freeze({
  open_commitments_projection: readCommitmentsProjection,
  obligations_projection: readObligationsProjection,
  schedule_projection: readScheduleProjection,
});

function frameIdsOf(projection: ProjectionName, rows: readonly Record<string, unknown>[]): string[] {
  const column = projection === 'open_commitments_projection' ? 'commitmentFrameInstanceId'
    : projection === 'obligations_projection' ? 'obligationFrameInstanceId' : 'scheduledFrameInstanceId';
  return rows.map(row => row[column] as string);
}

/**
 * Read every projection, optionally narrowed to one set of frame instances.
 *
 * Narrowing drops rows from the fragment and never from the completeness answer:
 * `isComplete` and the watermarks stay the projection's own, because "was this
 * the whole story" is a question about the projection, not about the slice a
 * caller asked to see (PRD §21.6).
 */
export async function readProjectionFragments(tx: MemoryTransaction, input: {
  ownerScopeId: string; asOf: Date; frameInstanceIds?: readonly string[] | null;
  /** When supplied by the broker, projection caches cannot widen the pending
   * assertions authorized for the packet's source and knowledge-time bounds. */
  authorizedOverlayDeltas?: readonly PublicOverlayDelta[];
}): Promise<ContextProjectionFragment[]> {
  const narrow = input.frameInstanceIds ? new Set(input.frameInstanceIds) : null;
  const allowedDeltas = input.authorizedOverlayDeltas === undefined ? null
    : new Map(input.authorizedOverlayDeltas.map(delta => [delta.overlayDeltaId, delta]));
  const fragments: ContextProjectionFragment[] = [];
  for (const [name, read] of Object.entries(READS)) {
    const projection = name as ProjectionName;
    const view = await read(tx, { ownerScopeId: input.ownerScopeId, asOf: input.asOf, includeResolved: true });
    const ids = frameIdsOf(projection, view.rows as unknown as Record<string, unknown>[])
      .filter(id => narrow === null || narrow.has(id));
    fragments.push(contextProjectionFragmentSchema.parse({
      projectionName: projection,
      rowCount: ids.length,
      frameInstanceIds: ids,
      isComplete: view.isComplete,
      projectionVersion: view.projectionVersion,
      reducerVersion: view.reducerVersion,
      ownerOverlayWatermark: view.ownerOverlayWatermark,
      canonicalTransactionWatermark: view.canonicalTransactionWatermark,
      pendingAssertions: view.pendingAssertions
        .filter(assertion => allowedDeltas === null || allowedDeltas.has(assertion.overlayDeltaId))
        .map(assertion => allowedDeltas === null ? assertion
          : { ...assertion, rawText: allowedDeltas.get(assertion.overlayDeltaId)!.rawText }),
      highRiskActionsBlocked: view.highRiskActionsBlocked,
    }));
  }
  return fragments;
}
