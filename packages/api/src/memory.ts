import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { OwnerTransaction } from '@unai/postgres';
import { dataPurposeSchema, sensitivitySchema, proposeBeliefTransactionSchema,selectedTurnProposalSchema } from '@unai/domain';
import { BELIEF_PURPOSES, BeliefTransactionError, commitBeliefTransaction, proposeBeliefTransaction,
  validateBeliefTransaction, type BeliefTransactionRunner, type GovernorRequest } from '@unai/belief';
import {readPendingTransactions, rejectBeliefTransaction} from '@unai/belief';
import {ConversationService,ControlError} from '@unai/control';
import {ingestOwnerStatement,type EvidenceObjects} from './evidence.js';

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
type Work = (request: FastifyRequest, run: (tx: OwnerTransaction, sessionId: string) => Promise<unknown>,purpose?:string) => Promise<unknown>;

const REFUSAL_STATUS = new Map<string, number>([
  ['BELIEF_TRANSACTION_NOT_FOUND', 404],
  ['BELIEF_TRANSACTION_REFUSED', 409],
  ['BELIEF_TRANSACTION_REJECTED', 409],
  ['BELIEF_TRANSACTION_ALREADY_COMMITTED', 409],
  ['BELIEF_TRANSACTION_IDEMPOTENCY_KEY_MISMATCH', 409],
  ['BELIEF_OPERATION_NOT_DELIVERED', 400],
  ['BELIEF_OPERATION_KIND_MISMATCH', 400],
  ['BELIEF_OPERATION_REF_UNRESOLVED', 400],
  ['BELIEF_OPERATION_REF_DUPLICATE', 400],
  ['BELIEF_SUPPORT_NAMES_ONE_SUPPORTER', 400],
  ['BELIEF_SUPPORT_ORIGIN_UNREADABLE', 409],
  ['BELIEF_SLOT_NOT_FOUND', 409],
  ['CLAIM_NOT_FOUND', 409],
  ['REMEMBER_TURN_NOT_FOUND',404],
  ['REMEMBER_OWNER_STATEMENT_REQUIRED',400],
  ['REMEMBER_UNAVAILABLE',503],
]);

export function registerMemoryGovernorRoutes(app: FastifyInstance, work: Work, options:{evidenceObjects?:EvidenceObjects|undefined;registryReleaseId?:string|undefined}={}): void {
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
    let input:unknown=request.body;
    if(input&&typeof input==='object'&&'selectedTurn' in input){
      const selected=selectedTurnProposalSchema.safeParse(input);
      const key=proposeBeliefTransactionSchema.shape.idempotencyKey.safeParse(request.headers['idempotency-key']);
      if(!selected.success||!key.success)return reply.code(400).send({code:'MEMORY_TRANSACTION_INPUT_INVALID'});
      const {registryReleaseId,evidenceObjects}=options;
      if(!registryReleaseId||!evidenceObjects)throw new BeliefTransactionError('REMEMBER_UNAVAILABLE');
      const {conversationId,turnId}=selected.data.selectedTurn;
      let text:string;
      try{
        text=await work(request,async tx=>{
          await tx.query("SELECT set_config('unai.data_purpose',$1,true),set_config('unai.maximum_sensitivity',$2,true)",[context.dataPurpose,context.maximumSensitivity]);
          const view=await new ConversationService(tx).get(conversationId);
          const turn=view.turns.find(turn=>turn.id===turnId);
          if(!turn)throw new BeliefTransactionError('REMEMBER_TURN_NOT_FOUND');
          if(turn.speaker!=='owner'||turn.status!=='accepted'||!turn.text||turn.text.length>8192)throw new BeliefTransactionError('REMEMBER_OWNER_STATEMENT_REQUIRED');
          await tx.audit({policyDecision:'ALLOW',codeVersion:'0.1.0',result:'SUCCESS',objects:[{type:'conversation_turns',id:turnId,fields:['text','speaker']}]});
          return turn.text;
        },'conversation.read') as string;
      }catch(error){if(error instanceof ControlError)throw new BeliefTransactionError('REMEMBER_TURN_NOT_FOUND');throw error;}
      // Explicit owner source admission reuses the correction path. Its existing
      // SQL trigger does not enqueue automatic extraction (migration 0031).
      // The selected turn identity is provenance only, never an evidence anchor.
      const source=await work(request,async tx=>{
        await tx.query("SELECT set_config('unai.data_purpose',$1,true),set_config('unai.maximum_sensitivity',$2,true)",[context.dataPurpose,context.maximumSensitivity]);
        return ingestOwnerStatement(tx,evidenceObjects,{text,externalId:'remember:'+conversationId+':'+turnId,
          idempotencyKey:key.data,sensitivity:'PRIVATE',allowedPurposes:[context.dataPurpose],deterministicMetadata:{conversationId,turnId}});
      },'memory.correct') as Awaited<ReturnType<typeof ingestOwnerStatement>>;
      input={transactionKind:'CANONICALIZE',registryReleaseId,risk:'LOW',sourceEvidenceIds:[source.evidenceId],
        // An unbound source assertion remains CANDIDATE under recordClaim's
        // existing rule. Selecting text does not infer a predicate or a belief.
        operations:[{kind:'ADD_CLAIM',operationRef:'#statement',sourceAnchorId:source.sourceAnchorId,claimOrigin:'USER_STATEMENT',lifecycle:'CANDIDATE'}]};
    }
    // The idempotency key is the boundary's header, never a body field: the same
    // key that makes the HTTP request repeatable makes the transaction repeatable.
    const parsed = proposeBeliefTransactionSchema.safeParse({
      ...(input as Record<string, unknown>), idempotencyKey: request.headers['idempotency-key'],
    });
    if (!parsed.success) return reply.code(400).send({ code: 'MEMORY_TRANSACTION_INPUT_INVALID', correlationId: context.correlationId });
    const proposed = await proposeBeliefTransaction(runner, context, parsed.data);
    await work(request, tx => tx.audit({ policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS',
      objects: [{ type: 'belief_transactions', id: proposed.transactionId, fields: ['status'] }] }));
    return reply.code(proposed.alreadyProposed ? 200 : 201).send({ transactionId: proposed.transactionId, status: proposed.status });
  }));

  app.get('/v1/memory/transactions', async (request, reply) => governed(request, reply, async (runner, context) => {
    const result = await readPendingTransactions(runner, context);
    await work(request, tx => tx.audit({policyDecision:'ALLOW',codeVersion:'0.1.0',result:'SUCCESS',
      objects:result.proposals.map(proposal => ({type:'belief_transactions',id:proposal.transactionId as string,fields:['status','operations']}))}));
    return result;
  }));

  app.post<{Params:{id:string}}>('/v1/memory/transactions/:id/reject', async (request, reply) => governed(request, reply, async (runner, context) => {
    const key = request.headers['idempotency-key'];
    if (!UUID.test(request.params.id) || typeof key !== 'string') return reply.code(400).send({code:'MEMORY_TRANSACTION_INPUT_INVALID'});
    const result = await rejectBeliefTransaction(runner, context, {transactionId:request.params.id,idempotencyKey:key});
    await work(request, tx => tx.audit({policyDecision:'ALLOW',codeVersion:'0.1.0',result:'SUCCESS',
      objects:[{type:'belief_transactions',id:result.transactionId,fields:['status','rejection_reason']}]}));
    return result;
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
