import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { OwnerTransaction } from '@unai/postgres';
import { dataPurposeSchema, sensitivitySchema, proposeBeliefTransactionSchema } from '@unai/domain';
import { BELIEF_PURPOSES, BeliefTransactionError, commitBeliefTransaction, proposeBeliefTransaction,
  validateBeliefTransaction, type BeliefTransactionRunner, type GovernorRequest } from '@unai/belief';

/** The governed memory write surface: propose, validate, commit.
 *
 * A caller may propose only. Nothing here decides an assessment, computes an
 * independence group or reads a registry release; the whole decision is
 * `@unai/belief`'s, and this file is the owner boundary in front of it.
 *
 * Every refusal is a stable code. Database and policy internals never reach the
 * response: a refused commit answers with the validation decision and the policy
 * reason code the governor recorded, and nothing else.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Work = (request: FastifyRequest, run: (tx: OwnerTransaction, sessionId: string) => Promise<unknown>) => Promise<unknown>;

const REFUSAL_STATUS = new Map<string, number>([
  ['BELIEF_TRANSACTION_NOT_FOUND', 404],
  ['BELIEF_TRANSACTION_REFUSED', 409],
  ['BELIEF_TRANSACTION_REJECTED', 409],
  ['BELIEF_TRANSACTION_ALREADY_COMMITTED', 409],
  ['BELIEF_TRANSACTION_IDEMPOTENCY_KEY_MISMATCH', 409],
  ['BELIEF_OPERATION_NOT_DELIVERED', 400],
  ['BELIEF_OPERATION_REF_UNRESOLVED', 400],
  ['BELIEF_OPERATION_REF_DUPLICATE', 400],
  ['BELIEF_SUPPORT_NAMES_ONE_SUPPORTER', 400],
  ['BELIEF_SUPPORT_ORIGIN_UNREADABLE', 409],
  ['BELIEF_SLOT_NOT_FOUND', 409],
  ['CLAIM_NOT_FOUND', 409],
]);

export function registerMemoryGovernorRoutes(app: FastifyInstance, work: Work): void {
  /** The governor opens one owner transaction per step through `work`, which
   * re-verifies the live session every time. Commit therefore runs its policy
   * decision and its material operations in two separate transactions, which is
   * what lets a refusal survive the rollback of the work it refused. */
  function governor(request: FastifyRequest): { runner: BeliefTransactionRunner; governed: GovernorRequest } | null {
    const dataPurpose = dataPurposeSchema.safeParse(request.headers['x-data-purpose']);
    const maximumSensitivity = sensitivitySchema.safeParse(request.headers['x-maximum-sensitivity']);
    if (!dataPurpose.success || !maximumSensitivity.success) return null;
    const context = request.ownerContext!;
    const runner: BeliefTransactionRunner = (purpose, run) => {
      // The purpose is the request's, established at the boundary and pinned by
      // the URL mapping; the governor may not widen it from inside.
      if (purpose !== context.purpose) return Promise.reject(new BeliefTransactionError('MEMORY_PURPOSE_REFUSED'));
      return work(request, async tx => {
        await tx.query("SELECT set_config('unai.data_purpose',$1,true),set_config('unai.maximum_sensitivity',$2,true)",
          [dataPurpose.data, maximumSensitivity.data]);
        return run(tx);
      }) as ReturnType<typeof run>;
    };
    return {
      runner,
      governed: {
        ownerScopeId: context.ownerScopeId, actorId: context.actorId, correlationId: context.correlationId,
        dataPurpose: dataPurpose.data, maximumSensitivity: maximumSensitivity.data,
      },
    };
  }

  async function governed(request: FastifyRequest, reply: FastifyReply,
    run: (runner: BeliefTransactionRunner, governed: GovernorRequest) => Promise<unknown>): Promise<unknown> {
    const correlationId = request.ownerContext!.correlationId;
    const opened = governor(request);
    if (!opened) return reply.code(400).send({ code: 'MEMORY_CONTEXT_REQUIRED', correlationId });
    try {
      return await run(opened.runner, opened.governed);
    } catch (error) {
      const code = error instanceof BeliefTransactionError ? error.message : 'MEMORY_TRANSACTION_UNAVAILABLE';
      const status = REFUSAL_STATUS.get(code) ?? (error instanceof BeliefTransactionError ? 400 : 503);
      // The refusal audit is its own transaction: the work it refused was rolled back.
      await work(request, tx => tx.audit({ policyDecision: status < 500 ? 'DENY' : 'ALLOW', codeVersion: '0.1.0',
        result: status < 500 ? 'REFUSED' : 'FAILURE', objects: [] }));
      const detail = error instanceof BeliefTransactionError && error.detail
        ? { decision: error.detail['decision'], reason: error.detail['reason'] } : {};
      return reply.code(status).send({ code, correlationId, ...(detail.decision ? detail : {}) });
    }
  }

  app.post('/v1/memory/transactions/propose', async (request, reply) => governed(request, reply, async (runner, context) => {
    // The idempotency key is the boundary's header, never a body field: the same
    // key that makes the HTTP request repeatable makes the transaction repeatable.
    const parsed = proposeBeliefTransactionSchema.safeParse({
      ...(request.body as Record<string, unknown>), idempotencyKey: request.headers['idempotency-key'],
    });
    if (!parsed.success) return reply.code(400).send({ code: 'MEMORY_TRANSACTION_INPUT_INVALID', correlationId: context.correlationId });
    const proposed = await proposeBeliefTransaction(runner, context, parsed.data);
    await work(request, tx => tx.audit({ policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS',
      objects: [{ type: 'belief_transactions', id: proposed.transactionId, fields: ['status'] }] }));
    return reply.code(proposed.alreadyProposed ? 200 : 201).send({ transactionId: proposed.transactionId, status: proposed.status });
  }));

  app.post<{ Params: { id: string } }>('/v1/memory/transactions/:id/validate', async (request, reply) =>
    governed(request, reply, async (runner, context) => {
      if (!UUID.test(request.params.id)) return reply.code(400).send({ code: 'MEMORY_TRANSACTION_INPUT_INVALID', correlationId: context.correlationId });
      const report = await validateBeliefTransaction(runner, context, request.params.id);
      await work(request, tx => tx.audit({ policyDecision: report.decision === 'REJECTED' ? 'DENY' : 'ALLOW', codeVersion: '0.1.0',
        result: 'SUCCESS', objects: [{ type: 'belief_transactions', id: request.params.id, fields: ['validation'] }] }));
      return report;
    }));

  app.post<{ Params: { id: string } }>('/v1/memory/transactions/:id/commit', async (request, reply) =>
    governed(request, reply, async (runner, context) => {
      const idempotencyKey = request.headers['idempotency-key'];
      if (!UUID.test(request.params.id) || typeof idempotencyKey !== 'string') {
        return reply.code(400).send({ code: 'MEMORY_TRANSACTION_INPUT_INVALID', correlationId: context.correlationId });
      }
      const receipt = await commitBeliefTransaction(runner, context, { transactionId: request.params.id, idempotencyKey });
      await work(request, tx => tx.audit({ policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS',
        objects: [{ type: 'belief_transactions', id: receipt.transactionId, fields: ['commit_receipt'] }] }));
      return receipt;
    }));
}
