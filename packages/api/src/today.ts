import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { OwnerTransaction } from '@unai/postgres';
import type { PolicyPorts } from '@unai/belief';
import { dataPurposeSchema, sensitivitySchema, todayRequestSchema, whyObjectTypeSchema } from '@unai/domain';
import {
  CONTEXT_READ_PURPOSE, MEMORY_INSPECT_PURPOSE, ContextBrokerError, buildTodayBriefing, readWhySources,
} from '@unai/context';

/**
 * The Today briefing and the Why? / Sources panel (design GET /v1/today; screens
 * "Today briefing" and "Why? / Sources panel"; CRT-UX-01-A, CRT-UX-01-B,
 * CRT-UX-02-A, CRT-UX-11-A). ADR 0027.
 *
 *  - `GET /v1/today` runs under the Context Broker's read purpose, because the
 *    briefing's only memory read is a broker packet, and the edition it records
 *    is a record of that read, as the packet is. The data purpose and the
 *    sensitivity ceiling are the request's declarations, carried in the same
 *    `x-data-purpose` / `x-maximum-sensitivity` headers the inspection routes use;
 *    a request without them is refused before any transaction opens.
 *  - `GET /v1/memory/why/{objectType}/{id}` runs under the Memory inspector's
 *    purpose. It opens a belief, an owner assertion or a resolution assertion;
 *    the evidence excerpt is read through the evidence policies, so the declared
 *    purpose and ceiling decide whether it is shown or listed as withheld.
 */

type Work = (request: FastifyRequest, run: (tx: OwnerTransaction, sessionId: string) => Promise<unknown>) => Promise<unknown>;

export const TODAY_PURPOSE = CONTEXT_READ_PURPOSE;
export const WHY_PURPOSE = MEMORY_INSPECT_PURPOSE;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const REFUSAL_STATUS = new Map<string, number>([
  ['TODAY_REQUEST_INCOMPLETE', 400],
  ['TODAY_REQUEST_INVALID', 400],
  ['TODAY_TIME_ZONE_REQUIRED', 400],
  ['TODAY_TIME_ZONE_INVALID', 400],
  ['TODAY_DATE_NOT_CURRENT', 409],
  ['CONTEXT_REQUEST_INCOMPLETE', 400],
  ['CONTEXT_REQUEST_INVALID', 400],
  ['CONTEXT_READ_DENIED', 403],
  ['CONTEXT_ACTION_DENIED', 403],
  ['CONTEXT_PACKET_HASH_MISMATCH', 500],
  ['WHY_REQUEST_INVALID', 400],
  ['WHY_OBJECT_NOT_FOUND', 404],
]);

export interface TodayRouteOptions {
  readonly policyPorts?: PolicyPorts;
  readonly registryReleaseId?: string | null;
  readonly registryRelease?: string | null;
  /** The instant a briefing is built for. Only tests pin it. */
  readonly clock?: () => Date;
}

function header(request: FastifyRequest, name: string): string | null {
  const value = request.headers[name];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function registerTodayRoutes(app: FastifyInstance, work: Work, options: TodayRouteOptions = {}): void {
  const clock = options.clock ?? (() => new Date());
  async function refuse(request: FastifyRequest, reply: FastifyReply, code: string, extra: Record<string, unknown> = {}): Promise<unknown> {
    // Its own transaction: whatever it refused has already been rolled back.
    await work(request, tx => tx.audit({ policyDecision: 'DENY', codeVersion: '0.1.0', result: 'REFUSED', objects: [] }));
    return reply.code(REFUSAL_STATUS.get(code) ?? 400).send({ code, correlationId: request.ownerContext!.correlationId, ...extra });
  }

  app.get('/v1/today', async (request, reply) => {
    const context = request.ownerContext!;
    const dataPurpose = header(request, 'x-data-purpose'), ceiling = header(request, 'x-maximum-sensitivity');
    const missing = [...(dataPurpose ? [] : ['dataPurpose']), ...(ceiling ? [] : ['maximumSensitivity'])];
    if (missing.length > 0) return refuse(request, reply, 'TODAY_REQUEST_INCOMPLETE', { missing });
    const query = todayRequestSchema.safeParse(request.query ?? {});
    const purpose = dataPurposeSchema.safeParse(dataPurpose), sensitivity = sensitivitySchema.safeParse(ceiling);
    if (!query.success || !purpose.success || !sensitivity.success) return refuse(request, reply, 'TODAY_REQUEST_INVALID');
    try {
      const briefing = await buildTodayBriefing(
        <T,>(run: (tx: OwnerTransaction) => Promise<T>) => work(request, tx => run(tx)) as Promise<T>,
        { ownerScopeId: context.ownerScopeId, timeZone: query.data.timeZone ?? null, date: query.data.date ?? null,
          dataPurpose: purpose.data, maximumSensitivity: sensitivity.data },
        {
          ...(options.policyPorts ? { ports: options.policyPorts } : {}),
          correlationId: context.correlationId, requestingActorId: context.actorId, now: clock(),
          registryReleaseId: options.registryReleaseId ?? null, registryRelease: options.registryRelease ?? null,
        });
      await work(request, tx => tx.audit({
        policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS',
        objects: [{ type: 'briefing_editions', id: briefing.briefingEditionId, fields: ['owner_local_date', 'timezone', 'packet_manifest'] },
          { type: 'context_packets', id: briefing.packetManifest.contextPacketId, fields: ['packet', 'packet_hash', 'purpose'] },
          ...briefing.sections.flatMap(section => section.items).map(item => ({
            type: 'briefing_items', id: item.briefingItemId, fields: ['headline', 'why_surfaced', 'certainty_label', 'rank_components'] }))],
      }));
      return reply.code(200).send(briefing);
    } catch (error) {
      if (error instanceof ContextBrokerError) return refuse(request, reply, error.message, error.detail);
      throw error;
    }
  });

  app.get<{ Params: { objectType: string; id: string } }>('/v1/memory/why/:objectType/:id', async (request, reply) => {
    const objectType = whyObjectTypeSchema.safeParse(request.params.objectType);
    if (!objectType.success || !UUID.test(request.params.id)) return refuse(request, reply, 'WHY_REQUEST_INVALID');
    try {
      const panel = await work(request, async tx => {
        // The excerpt is evidence: the purpose and ceiling the request declared
        // decide whether it may be read, exactly as on the evidence routes.
        await tx.query("SELECT set_config('unai.data_purpose',$1,true),set_config('unai.maximum_sensitivity',$2,true)",
          [header(request, 'x-data-purpose') ?? '', header(request, 'x-maximum-sensitivity') ?? '']);
        return readWhySources(tx, {
          ownerScopeId: tx.context.ownerScopeId, ref: { objectType: objectType.data, objectId: request.params.id }, readAt: new Date(),
        });
      }) as Awaited<ReturnType<typeof readWhySources>>;
      await work(request, tx => tx.audit({
        policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS',
        objects: [{ type: objectType.data, id: request.params.id, fields: ['claims', 'source_excerpt', 'assessment_status'] },
          ...panel.sources.slice(0, 50).map(source => ({ type: 'source_items', id: source.evidenceId, fields: ['normalized_text'] }))],
      }));
      return panel;
    } catch (error) {
      if (error instanceof ContextBrokerError) return refuse(request, reply, error.message, error.detail);
      throw error;
    }
  });
}
