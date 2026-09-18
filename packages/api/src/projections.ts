import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { OwnerTransaction } from '@unai/postgres';
import {
  commitmentsProjectionViewSchema, obligationsProjectionViewSchema, scheduleProjectionViewSchema,
  projectionHealthSchema,
} from '@unai/domain';
import {
  readCommitmentsProjection, readObligationsProjection, readScheduleProjection, readProjectionHealth,
  type ProjectionReadFilters,
} from '@unai/capabilities';

/**
 * The typed projection reads (PRD §35.9; design routes
 * GET /v1/projections/commitments, /obligations, /schedule and
 * GET /v1/ops/projections; CRT-PRJ-04-A).
 *
 * Every response carries its completeness flag and its owner overlay watermark at
 * the top level rather than buried per row, because the question a caller must be
 * able to answer before acting is "was this the whole story?" (FR-082).
 *
 * The read refreshes before it answers. That is what puts the owner's correction
 * from another device in *this* read rather than the next one (CRT-RYW-02-A,
 * CRT-RYW-04-A), and it costs only a recomputation from canonical rows the owner
 * already holds.
 *
 * `highRiskActionsBlocked` travels with the answer so a caller cannot act on an
 * incomplete or contested projection without seeing that it is one. The decision
 * itself stays `EvaluateMemoryAction`'s: this flag is the `projectionComplete`
 * input that port consumes (PRD §29.3).
 */

export const PROJECTION_READ_PURPOSE = 'projection.read';
export const PROJECTION_HEALTH_PURPOSE = 'ops.projections.read';

type Work = (request: FastifyRequest, run: (tx: OwnerTransaction, sessionId: string) => Promise<unknown>) => Promise<unknown>;

const projectionFields = ['outcome_state', 'due_time', 'is_complete', 'owner_overlay_watermark', 'projection_version'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class FilterRefused extends Error { constructor() { super('PROJECTION_FILTER_INVALID'); } }

/** Read the filters the Commitments screen offers -- person, due window,
 * include-resolved -- and refuse anything malformed rather than silently
 * widening the answer. */
function filters(request: FastifyRequest, ownerScopeId: string, asOf: Date): ProjectionReadFilters {
  const query = request.query as Record<string, unknown>;
  const time = (value: unknown): Date | null => {
    if (value === undefined || value === '') return null;
    if (typeof value !== 'string') throw new FilterRefused();
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) throw new FilterRefused();
    return parsed;
  };
  const person = query['person'];
  if (person !== undefined && (typeof person !== 'string' || !UUID.test(person))) throw new FilterRefused();
  const includeResolved = query['includeResolved'];
  if (includeResolved !== undefined && includeResolved !== 'true' && includeResolved !== 'false') throw new FilterRefused();
  return {
    ownerScopeId, asOf,
    personEntityId: typeof person === 'string' ? person : null,
    dueBefore: time(query['dueBefore']),
    dueAfter: time(query['dueAfter']),
    includeResolved: includeResolved === 'true',
  };
}

export function registerProjectionRoutes(app: FastifyInstance, work: Work) {
  app.get('/v1/projections/commitments', async (request, reply) => work(request, async tx => {
    let view;
    try { view = commitmentsProjectionViewSchema.parse(await readCommitmentsProjection(tx, filters(request, tx.context.ownerScopeId, new Date()))); }
    catch (error) { if (error instanceof FilterRefused) return reply.code(400).send({ code: error.message }); throw error; }
    await tx.audit({ policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS',
      objects: view.rows.slice(0, 100).map(row => ({ type: 'open_commitments_projection',
        id: row.commitmentFrameInstanceId, fields: projectionFields })) });
    return view;
  }));

  app.get('/v1/projections/obligations', async (request, reply) => work(request, async tx => {
    let view;
    try { view = obligationsProjectionViewSchema.parse(await readObligationsProjection(tx, filters(request, tx.context.ownerScopeId, new Date()))); }
    catch (error) { if (error instanceof FilterRefused) return reply.code(400).send({ code: error.message }); throw error; }
    await tx.audit({ policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS',
      objects: view.rows.slice(0, 100).map(row => ({ type: 'obligations_projection',
        id: row.obligationFrameInstanceId, fields: projectionFields })) });
    return view;
  }));

  app.get('/v1/projections/schedule', async (request, reply) => work(request, async tx => {
    let view;
    try { view = scheduleProjectionViewSchema.parse(await readScheduleProjection(tx, filters(request, tx.context.ownerScopeId, new Date()))); }
    catch (error) { if (error instanceof FilterRefused) return reply.code(400).send({ code: error.message }); throw error; }
    await tx.audit({ policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS',
      objects: view.rows.slice(0, 100).map(row => ({ type: 'schedule_projection',
        id: row.scheduledFrameInstanceId, fields: projectionFields })) });
    return view;
  }));

  /** The Projection health screen. It reports the stored state and the latest
   * receipts and rebuilds nothing: a rebuild is an operator decision made through
   * the replay tool, never a side effect of opening a console. */
  app.get('/v1/ops/projections', async request => work(request, async tx => {
    const health = projectionHealthSchema.parse(await readProjectionHealth(tx, {
      ownerScopeId: tx.context.ownerScopeId, readAt: new Date(),
    }));
    await tx.audit({ policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS',
      objects: health.receipts.slice(0, 100).map(receipt => ({
        type: 'projection_rebuild_receipts', id: receipt.projectionRebuildReceiptId,
        fields: ['projection_name', 'trigger', 'rows_rebuilt', 'equals_incremental', 'reducer_version'] })) });
    return health;
  }));
}
