import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { OwnerTransaction } from '@unai/postgres';
import { dataPurposeSchema, sensitivitySchema, inspectableObjectTypeSchema, memoryInspectorSchema, relatedFramesSchema } from '@unai/domain';
import { ContextBrokerError, MEMORY_INSPECT_PURPOSE, inspectMemory, readRelatedFrames } from '@unai/context';

/**
 * The Memory inspector and the related context of the Commitments and
 * Obligations screens (ADR 0028 §1):
 *
 *  - GET /v1/memory/inspector/{objectType}/{id}
 *  - GET /v1/memory/frames/related?ids=<uuid>,<uuid>,...
 *
 * Both run under `memory.inspect` and write nothing but their audit row. The
 * evidence gate is set from the request's declared data purpose and ceiling in
 * the same transaction as the read, exactly as the explain route sets it, so an
 * item the request may not read is withheld by the row policy and counted.
 */

export const INSPECTION_PURPOSE = MEMORY_INSPECT_PURPOSE;
export const INSPECTION_URLS = Object.freeze(['/v1/memory/inspector/:objectType/:id', '/v1/memory/frames/related']);

type Work = (request: FastifyRequest, run: (tx: OwnerTransaction, sessionId: string) => Promise<unknown>) => Promise<unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FRAMES = 100;

export interface InspectionRouteOptions {
  readonly registryRelease?: string | null;
}

export function registerInspectionRoutes(app: FastifyInstance, work: Work, options: InspectionRouteOptions = {}): void {
  async function refuse(request: FastifyRequest, reply: FastifyReply, status: number, code: string): Promise<unknown> {
    // Its own transaction: nothing was read.
    await work(request, tx => tx.audit({ policyDecision: 'DENY', codeVersion: '0.1.0', result: 'REFUSED', objects: [] }));
    return reply.code(status).send({ code, correlationId: request.ownerContext!.correlationId });
  }
  const gate = (request: FastifyRequest, tx: OwnerTransaction) => tx.query(
    "SELECT set_config('unai.data_purpose',$1,true),set_config('unai.maximum_sensitivity',$2,true)",
    [request.headers['x-data-purpose'] ?? '', request.headers['x-maximum-sensitivity'] ?? '']);
  const declared = (request: FastifyRequest) => dataPurposeSchema.safeParse(request.headers['x-data-purpose']).success
    && sensitivitySchema.safeParse(request.headers['x-maximum-sensitivity']).success;

  app.get<{ Params: { objectType: string; id: string } }>('/v1/memory/inspector/:objectType/:id', async (request, reply) => {
    const objectType = inspectableObjectTypeSchema.safeParse(request.params.objectType);
    if (!objectType.success || !UUID.test(request.params.id)) return refuse(request, reply, 400, 'INSPECTOR_REQUEST_INVALID');
    if (!declared(request)) return refuse(request, reply, 400, 'INSPECTOR_REQUEST_INVALID');
    let inspector;
    try {
      inspector = await work(request, async tx => {
        await gate(request, tx);
        const answer = memoryInspectorSchema.parse(await inspectMemory(tx, {
          ownerScopeId: tx.context.ownerScopeId, objectType: objectType.data, objectId: request.params.id.toLowerCase(),
          readAt: new Date(), registryRelease: options.registryRelease ?? null,
        }));
        // Committed with the read, so the next inspection lists this one.
        await tx.audit({ policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS', objects: [
          { type: 'propositions', id: answer.subject.propositionId, fields: ['normalized_value', 'assessment_status', 'claims', 'support'] },
          ...answer.originalEvidence.slice(0, 99).map(item => ({ type: 'source_items', id: item.evidenceId, fields: ['source_type', 'anchors'] })),
        ] });
        return answer;
      });
    } catch (error) {
      if (error instanceof ContextBrokerError && error.message === 'INSPECTOR_TARGET_NOT_FOUND') {
        return refuse(request, reply, 404, error.message);
      }
      if (error instanceof ContextBrokerError && ['PROPOSITION_SOURCE_WITHHELD', 'INSPECTOR_TARGET_SOURCE_WITHHELD'].includes(error.message)) {
        return refuse(request, reply, 403, error.message);
      }
      throw error;
    }
    return inspector;
  });

  app.get<{ Querystring: { ids?: string } }>('/v1/memory/frames/related', async (request, reply) => {
    const ids = typeof request.query.ids === 'string' ? request.query.ids.split(',').map(id => id.trim()).filter(Boolean) : [];
    if (ids.length === 0 || ids.length > MAX_FRAMES || !ids.every(id => UUID.test(id))) {
      return refuse(request, reply, 400, 'RELATED_FRAMES_REQUEST_INVALID');
    }
    if (!declared(request)) return refuse(request, reply, 400, 'RELATED_FRAMES_REQUEST_INVALID');
    return work(request, async tx => {
      await gate(request, tx);
      const related = relatedFramesSchema.parse(await readRelatedFrames(tx, {
        ownerScopeId: tx.context.ownerScopeId, frameInstanceIds: ids.map(id => id.toLowerCase()), readAt: new Date(),
      }));
      await tx.audit({ policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS',
        objects: related.frames.slice(0, 100).map(frame => ({ type: 'frame_instances', id: frame.frameInstanceId,
          fields: ['roles', 'claims', 'resolution_assertions', 'thread_memberships'] })) });
      return related;
    });
  });
}
