import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { OwnerTransaction } from '@unai/postgres';
import { dataPurposeSchema, sensitivitySchema, threadMemberInputSchema } from '@unai/domain';
import type { PolicyPorts } from '@unai/belief';
import {
  CONTEXT_READ_PURPOSE, MEMORY_INSPECT_PURPOSE, MEMORY_THREAD_PURPOSE, ContextBrokerError, MemoryThreadError,
  addThreadMember, readContextPacket, explainProposition, missingContextFields, readMemoryThread,
} from '@unai/context';

/**
 * The Context Broker and the inspection reads (design POST /v1/memory/context,
 * GET /v1/memory/propositions/{id}/explain, GET /v1/memory/threads/{id},
 * POST /v1/memory/threads/{id}/members).
 *
 * The broker route is the only memory read path a model or a plugin has
 * (FR-060). Two things about it are properties of *this* file rather than of the
 * broker:
 *
 *  - The incomplete-request refusal happens before `work(...)` is called, so no
 *    owner transaction is opened and no query runs for a request that never
 *    declared its purpose, actor, scope, times, ceiling or risk (CRT-RD-02-A).
 *  - The refusal audit is written in its own transaction, because the work it
 *    refused was rolled back.
 *
 * A request declaring an intended action is answered `403 CONTEXT_ACTION_DENIED`
 * when the purpose that action declares is not admitted by the evidence behind the
 * memory it would rest on, and the packet is not issued (CRT-SEC-02-A).
 */

export { CONTEXT_READ_PURPOSE, MEMORY_INSPECT_PURPOSE, MEMORY_THREAD_PURPOSE };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Work = (request: FastifyRequest, run: (tx: OwnerTransaction, sessionId: string) => Promise<unknown>) => Promise<unknown>;

const REFUSAL_STATUS = new Map<string, number>([
  ['CONTEXT_REQUEST_INCOMPLETE', 400],
  ['CONTEXT_REQUEST_INVALID', 400],
  ['CONTEXT_READ_DENIED', 403],
  ['CONTEXT_ACTION_DENIED', 403],
  ['PROPOSITION_NOT_FOUND', 404],
  ['PROPOSITION_SOURCE_WITHHELD', 403],
  ['PROPOSITION_HISTORY_UNAVAILABLE', 409],
  ['MEMORY_THREAD_NOT_FOUND', 404],
  ['MEMORY_THREAD_HISTORY_UNAVAILABLE', 409],
  ['MEMORY_THREAD_OBJECT_NOT_FOUND', 404],
  ['MEMORY_THREAD_OBJECT_TYPE_UNKNOWN', 400],
  ['MEMORY_THREAD_MEMBER_NOT_STORED', 409],
]);

export interface ContextRouteOptions {
  readonly policyPorts?: PolicyPorts;
  readonly registryReleaseId?: string | null;
  readonly registryRelease?: string | null;
}

export function registerContextRoutes(app: FastifyInstance, work: Work, options: ContextRouteOptions = {}): void {
  async function refuse(request: FastifyRequest, reply: FastifyReply, code: string,
    extra: Record<string, unknown> = {}): Promise<unknown> {
    const status = REFUSAL_STATUS.get(code) ?? 400;
    // Its own transaction: whatever it refused has already been rolled back.
    await work(request, tx => tx.audit({ policyDecision: 'DENY', codeVersion: '0.1.0', result: 'REFUSED', objects: [] }));
    return reply.code(status).send({ code, correlationId: request.ownerContext!.correlationId, ...extra });
  }

  async function guarded(request: FastifyRequest, reply: FastifyReply, run: () => Promise<unknown>): Promise<unknown> {
    try { return await run(); }
    catch (error) {
      if (error instanceof ContextBrokerError) return refuse(request, reply, error.message, error.detail);
      if (error instanceof MemoryThreadError) return refuse(request, reply, error.message);
      throw error;
    }
  }

  app.post('/v1/memory/context', async (request, reply) => {
    const context = request.ownerContext!;
    const body = typeof request.body === 'object' && request.body !== null ? request.body as Record<string, unknown> : {};
    // The declarations PRD §23.1 requires, checked before any retrieval: this
    // runs before `work` opens a transaction, so a request that never declared
    // its authority reaches no row (CRT-RD-02-A).
    const missing = missingContextFields(body);
    if (missing.length > 0) return refuse(request, reply, 'CONTEXT_REQUEST_INCOMPLETE', { missing });
    // The owner scope and the actor are the boundary's, never the body's: a body
    // that names another scope or another actor is refused rather than obeyed.
    if (body['ownerScopeId'] !== context.ownerScopeId || body['requestingActorId'] !== context.actorId) {
      return refuse(request, reply, 'CONTEXT_REQUEST_INVALID');
    }
    return guarded(request, reply, async () => {
      // Two transactions, from the broker's own runner: the verdict commits
      // before a denial is raised, so a refused read is still a recorded one.
      const packet = await readContextPacket(
        <T,>(run: (tx: OwnerTransaction) => Promise<T>) => work(request, tx => run(tx)) as Promise<T>,
        body,
        {
          ...(options.policyPorts ? { ports: options.policyPorts } : {}),
          correlationId: context.correlationId,
          registryReleaseId: options.registryReleaseId ?? null,
          registryRelease: options.registryRelease ?? null,
        });
      await work(request, tx => tx.audit({
        policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS',
        objects: [{ type: 'context_packets', id: packet.packetId, fields: ['packet', 'packet_hash', 'purpose'] },
          ...packet.currentBeliefs.slice(0, 99).map(belief => ({
            type: 'propositions', id: belief.propositionId, fields: ['normalized_value', 'assessment_status'] }))],
      }));
      return reply.code(201).send(packet);
    });
  });

  app.get<{ Params: { id: string } }>('/v1/memory/propositions/:id/explain', async (request, reply) => {
    if (!UUID.test(request.params.id)) return refuse(request, reply, 'CONTEXT_REQUEST_INVALID');
    const purpose = dataPurposeSchema.safeParse(request.headers['x-data-purpose']);
    const sensitivity = sensitivitySchema.safeParse(request.headers['x-maximum-sensitivity']);
    if (!purpose.success || !sensitivity.success) return refuse(request, reply, 'CONTEXT_REQUEST_INVALID');
    return guarded(request, reply, async () => {
      const explanation = await work(request, async tx => {
        // The inspector reads evidence anchors, so the data purpose and the
        // ceiling the request declared decide what it may see, exactly as they do
        // on the evidence routes.
        await tx.query("SELECT set_config('unai.data_purpose',$1,true),set_config('unai.maximum_sensitivity',$2,true)",
          [purpose.data, sensitivity.data]);
        return explainProposition(tx, {
          ownerScopeId: tx.context.ownerScopeId, propositionId: request.params.id, readAt: new Date(),
          registryRelease: options.registryRelease ?? null,
        });
      }) as Awaited<ReturnType<typeof explainProposition>>;
      await work(request, tx => tx.audit({
        policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS',
        objects: [{ type: 'propositions', id: explanation.propositionId,
          fields: ['normalized_value', 'assessment_status', 'support', 'claims'] }],
      }));
      return explanation;
    });
  });

  app.get<{ Params: { id: string } }>('/v1/memory/threads/:id', async (request, reply) => {
    if (!UUID.test(request.params.id)) return refuse(request, reply, 'CONTEXT_REQUEST_INVALID');
    return guarded(request, reply, async () => {
      const view = await work(request, async tx => {
        await tx.query("SELECT set_config('unai.data_purpose',$1,true),set_config('unai.maximum_sensitivity',$2,true)",
          [request.headers['x-data-purpose'] ?? '', request.headers['x-maximum-sensitivity'] ?? '']);
        return readMemoryThread(tx, {
          ownerScopeId: tx.context.ownerScopeId, memoryThreadId: request.params.id, readAt: new Date(),
        });
      }) as Awaited<ReturnType<typeof readMemoryThread>>;
      await work(request, tx => tx.audit({
        policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS',
        objects: [{ type: 'memory_threads', id: view.memoryThreadId, fields: ['display_title', 'lifecycle'] }],
      }));
      return view;
    });
  });

  app.post<{ Params: { id: string } }>('/v1/memory/threads/:id/members', async (request, reply) => {
    if (!UUID.test(request.params.id)) return refuse(request, reply, 'CONTEXT_REQUEST_INVALID');
    const parsed = threadMemberInputSchema.safeParse(request.body);
    if (!parsed.success) return refuse(request, reply, 'CONTEXT_REQUEST_INVALID');
    return guarded(request, reply, async () => {
      const result = await work(request, tx => addThreadMember(tx, {
        ownerScopeId: tx.context.ownerScopeId, memoryThreadId: request.params.id, member: parsed.data,
      })) as Awaited<ReturnType<typeof addThreadMember>>;
      await work(request, tx => tx.audit({
        policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS',
        objects: [{ type: 'memory_thread_members', id: result.member.objectId,
          fields: ['membership_kind', 'confidence'] }],
      }));
      return reply.code(result.created ? 201 : 200).send(result.member);
    });
  });
}
