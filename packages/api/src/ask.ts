import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { OwnerTransaction } from '@unai/postgres';
import type { PolicyPorts } from '@unai/belief';
import { CONTEXT_READ_PURPOSE, ContextBrokerError, answerQuestion, missingAskFields } from '@unai/context';

/**
 * Question answering (design POST /v1/ask; PRD §8.2; CRT-RD-12-A).
 *
 * The route drives the Ask surface: it classifies the question into one of the
 * eight §8.2 answer types, reads a purpose-bound packet through the Context Broker
 * and returns labelled statements with their source links. It runs under the
 * broker's own read purpose, because the packet it records is the broker's.
 *
 * Two properties belong to this file:
 *
 *  - A request that does not declare its owner scope, question, purpose, times
 *    and ceiling is refused before `work(...)` opens a transaction, so it reaches
 *    no row (the Ask screen's "refused because the request declared no purpose").
 *  - The actor is the session's. A body naming another owner scope is refused
 *    rather than obeyed; no body field can name the actor.
 *
 * The answer manifest and the grounding validator are not produced here; they
 * belong to the node that builds them over this pipeline (ADR 0023 §5).
 */

type Work = (request: FastifyRequest, run: (tx: OwnerTransaction, sessionId: string) => Promise<unknown>) => Promise<unknown>;

export const ASK_PURPOSE = CONTEXT_READ_PURPOSE;

const REFUSAL_STATUS = new Map<string, number>([
  ['ASK_REQUEST_INCOMPLETE', 400],
  ['ASK_REQUEST_INVALID', 400],
  ['CONTEXT_REQUEST_INCOMPLETE', 400],
  ['CONTEXT_REQUEST_INVALID', 400],
  ['CONTEXT_READ_DENIED', 403],
  ['CONTEXT_ACTION_DENIED', 403],
]);

export interface AskRouteOptions {
  readonly policyPorts?: PolicyPorts;
  readonly registryReleaseId?: string | null;
  readonly registryRelease?: string | null;
}

export function registerAskRoutes(app: FastifyInstance, work: Work, options: AskRouteOptions = {}): void {
  async function refuse(request: FastifyRequest, reply: FastifyReply, code: string,
    extra: Record<string, unknown> = {}): Promise<unknown> {
    // Its own transaction: whatever it refused has already been rolled back.
    await work(request, tx => tx.audit({ policyDecision: 'DENY', codeVersion: '0.1.0', result: 'REFUSED', objects: [] }));
    return reply.code(REFUSAL_STATUS.get(code) ?? 400).send({ code, correlationId: request.ownerContext!.correlationId, ...extra });
  }

  app.post('/v1/ask', async (request, reply) => {
    const context = request.ownerContext!;
    const body = typeof request.body === 'object' && request.body !== null ? request.body as Record<string, unknown> : {};
    const missing = missingAskFields(body);
    if (missing.length > 0) return refuse(request, reply, 'ASK_REQUEST_INCOMPLETE', { missing });
    if (body['ownerScopeId'] !== context.ownerScopeId || 'requestingActorId' in body) {
      return refuse(request, reply, 'ASK_REQUEST_INVALID');
    }
    try {
      const answer = await answerQuestion(
        <T,>(run: (tx: OwnerTransaction) => Promise<T>) => work(request, tx => run(tx)) as Promise<T>,
        body,
        {
          ...(options.policyPorts ? { ports: options.policyPorts } : {}),
          correlationId: context.correlationId, requestingActorId: context.actorId,
          registryReleaseId: options.registryReleaseId ?? null, registryRelease: options.registryRelease ?? null,
        });
      await work(request, tx => tx.audit({
        policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS',
        objects: [{ type: 'context_packets', id: answer.packetId, fields: ['packet', 'packet_hash', 'purpose'] },
          ...answer.sourceLinks.slice(0, 99).map(link => ({ type: 'source_items', id: link.evidenceId, fields: ['sensitivity', 'allowed_purposes'] }))],
      }));
      return reply.code(200).send(answer);
    } catch (error) {
      if (error instanceof ContextBrokerError) return refuse(request, reply, error.message, error.detail);
      throw error;
    }
  });
}
