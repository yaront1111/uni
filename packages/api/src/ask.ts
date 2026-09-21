import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { OwnerTransaction } from '@unai/postgres';
import type { PolicyPorts } from '@unai/belief';
import { askRequestSchema } from '@unai/domain';
import { ConversationService, ControlError, resolveConversationReference, conversationReferenceQuery } from '@unai/control';
import { CONTEXT_READ_PURPOSE, ContextBrokerError, answerQuestion, missingAskFields, type AnswerPhraser } from '@unai/context';
import { createAnswerRecorder, type PurposeWork } from './answers.js';
import type { EvidenceObjects } from './evidence.js';

/**
 * Question answering (design POST /v1/ask; PRD §8.2, §23.6, §24; CRT-RD-12-A,
 * CRT-RD-06-A, CRT-RD-08-A, CRT-AI-01-A).
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
 * Every answer the route returns has passed the grounding validator and has
 * been recorded as a conversation turn with its supplied-context manifest before
 * it is returned. The purpose-bound recorder is required; evidence object
 * storage is not part of conversation recording.
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
  ['ANSWER_RECORDING_UNAVAILABLE', 503],
  ['CONVERSATION_NOT_FOUND', 404],
]);

export interface AskRouteOptions {
  readonly policyPorts?: PolicyPorts;
  readonly registryReleaseId?: string | null;
  readonly registryRelease?: string | null;
  /** Legacy composition option; conversation recording does not use object storage. */
  readonly evidenceObjects?: EvidenceObjects | undefined;
  /** Opens the recording transaction under its own purpose. */
  readonly purposeWork?: PurposeWork;
  /** The model that phrases answers, when one is configured. Without one the
   * deterministic composer answers, through the same validator. */
  readonly phraser?: AnswerPhraser | undefined;
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
    if (!options.purposeWork) return refuse(request, reply, 'ANSWER_RECORDING_UNAVAILABLE');
    const { conversationId, ...askBody } = body;
    if (conversationId !== undefined && (typeof conversationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(conversationId))) return refuse(request, reply, 'ASK_REQUEST_INVALID');
    const parsed = askRequestSchema.safeParse(askBody);
    if (!parsed.success) return refuse(request, reply, 'ASK_REQUEST_INVALID');
    const engineRequest = parsed.data;
    const originalQuestion = engineRequest.question;
    let reference = resolveConversationReference(originalQuestion, []);
    let association: { conversationId: string; turnId: string } | undefined;
    try {
      if (typeof conversationId === 'string') await options.purposeWork(request, 'conversation.read', async tx => {
        await tx.query("SELECT set_config('unai.data_purpose',$1,true),set_config('unai.maximum_sensitivity',$2,true)",
          [engineRequest.purpose, engineRequest.maximumSensitivity]);
        reference = await new ConversationService(tx).resolveReference(conversationId, originalQuestion);
        engineRequest.question = reference.question;
        await tx.audit({ policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS',
          objects: [{ type: 'conversations', id: conversationId, fields: ['id'] }] });
      });
      const queryNow = new Date();
      const referenceQuery = conversationReferenceQuery(reference,
        engineRequest.worldTime === 'NOW' ? queryNow : new Date(engineRequest.worldTime));
      if (referenceQuery?.kind === 'UNRESOLVED' || !engineRequest.referenceQuery) {
        if (referenceQuery) engineRequest.referenceQuery = referenceQuery;
      }
      const answer = await answerQuestion(
        <T,>(run: (tx: OwnerTransaction) => Promise<T>) => work(request, tx => run(tx)) as Promise<T>,
        engineRequest,
        {
          ...(options.policyPorts ? { ports: options.policyPorts } : {}),
          correlationId: context.correlationId, requestingActorId: context.actorId,
          registryReleaseId: options.registryReleaseId ?? null, registryRelease: options.registryRelease ?? null,
          ...(options.phraser ? { phraser: options.phraser } : {}),
          ...(referenceQuery ? { now: queryNow } : {}),
          recorder: createAnswerRecorder({ request, purposeWork: options.purposeWork, originalQuestion,
            ...(typeof conversationId === 'string' ? { conversationId } : {}), onRecorded: value => { association = value; },
            dataPurpose: String(body['purpose']), maximumSensitivity: String(body['maximumSensitivity']) }),
        });
      if (!association) throw new Error('ANSWER_ASSOCIATION_MISSING');
      const { conversationId: recordedConversationId, turnId } = association;
      await work(request, tx => tx.audit({
        policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS',
        objects: [{ type: 'context_packets', id: answer.packetId, fields: ['packet', 'packet_hash', 'purpose'] },
          { type: 'answer_manifests', id: answer.answerManifestId!, fields: ['grounding_validator_result'] },
          { type: 'conversations', id: recordedConversationId, fields: ['id'] },
          { type: 'conversation_turns', id: turnId, fields: ['id'] },
          ...answer.sourceLinks.slice(0, 96).map(link => ({ type: 'source_items', id: link.evidenceId, fields: ['sensitivity', 'allowed_purposes'] }))],
      }));
      return reply.code(200).send({ ...answer, question: originalQuestion, conversationId: recordedConversationId, turnId });
    } catch (error) {
      if (error instanceof ContextBrokerError || error instanceof ControlError) return refuse(request, reply, error.message, error.detail);
      throw error;
    }
  });
}
