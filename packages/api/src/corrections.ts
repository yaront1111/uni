import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { OwnerTransaction } from '@unai/postgres';
import {
  archiveInputSchema, confirmationInputSchema, correctionInputSchema, dataPurposeSchema, deletionInputSchema,
  keepUncertainInputSchema, memoryWriteReceiptSchema, overlayDeltaInputSchema, rejectionInputSchema,
  sensitivitySchema, stateChangeInputSchema, suppressionInputSchema,
  type BeliefOperation, type MemoryOperationKind, type OverlayDeltaKind, type OverlayLifecycle,
  type ProposeBeliefTransaction, type TargetObjectRef,
} from '@unai/domain';
import { BELIEF_PURPOSES, BeliefTransactionError, proposeBeliefTransaction,
  type BeliefTransactionRunner, type GovernorRequest } from '@unai/belief';
import { MemoryStoreError, recordClaim, recordMemoryOperation, recordOverlayDelta, readOwnerOverlay } from '@unai/memory';
import { ingestOwnerStatement, type EvidenceObjects } from './evidence.js';

/** The correction write paths and the owner overlay (PRD §14, §20, §57).
 *
 * Every control here writes forward. A correction, a state change, a
 * confirmation, a rejection, a keep-uncertain, a suppression, an archive and a
 * deletion each store the owner's words as a *new* evidence row, allocate an
 * owner sequence, record an overlay delta the owner's other devices read at once,
 * record the memory operation that names which control was used, and propose a
 * belief transaction. None of them updates an existing claim, proposition or
 * assessment row: what the kernel believed stays exactly as it was until the
 * governor commits a change (CRT-RYW-06-A).
 *
 * Confirmation is the one control that also records a claim of its own, because
 * confirming is itself an assertion. It leaves the confirmed statement's claim
 * origin untouched (CRT-AI-03-A).
 */

export const CORRECTION_PURPOSE = 'memory.correct';

type Work = (request: FastifyRequest, run: (tx: OwnerTransaction, sessionId: string) => Promise<unknown>) => Promise<unknown>;

const REFUSAL_STATUS = new Map<string, number>([
  ['MEMORY_TARGET_NOT_FOUND', 404],
  ['MEMORY_CORRECTION_INPUT_INVALID', 400],
  ['EVIDENCE_POLICY_REFUSED', 403],
  ['OVERLAY_DELTA_NOT_FOUND', 404],
  ['OWNER_SEQUENCE_UNAVAILABLE', 503],
]);

class CorrectionRefusal extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

/** One control's shape: which delta kind it records, which operation kind it
 * persists, and which transaction kind it proposes. Keeping the three together
 * is what makes "ten distinct kinds" checkable rather than aspirational. */
interface ControlShape {
  readonly deltaKind: OverlayDeltaKind;
  readonly operationKind: MemoryOperationKind;
  readonly transactionKind: ProposeBeliefTransaction['transactionKind'] | null;
  readonly lifecycle: OverlayLifecycle;
}
const CONTROLS: Readonly<Record<string, ControlShape>> = Object.freeze({
  correction: { deltaKind: 'USER_CORRECTION', operationKind: 'CORRECT', transactionKind: 'CORRECT', lifecycle: 'USER_ASSERTED' },
  stateChange: { deltaKind: 'USER_STATE_CHANGE', operationKind: 'CHANGED', transactionKind: 'STATE_CHANGE', lifecycle: 'USER_ASSERTED' },
  confirmation: { deltaKind: 'USER_CONFIRMATION', operationKind: 'CONFIRM', transactionKind: 'CONFIRM', lifecycle: 'USER_ASSERTED' },
  rejection: { deltaKind: 'USER_REJECTION', operationKind: 'REJECT', transactionKind: 'REJECT', lifecycle: 'USER_ASSERTED' },
  keepUncertain: { deltaKind: 'KEEP_UNCERTAIN', operationKind: 'KEEP_UNCERTAIN', transactionKind: null, lifecycle: 'USER_ASSERTED' },
  suppression: { deltaKind: 'SUPPRESSION', operationKind: 'SUPPRESS', transactionKind: 'SUPPRESS', lifecycle: 'USER_ASSERTED' },
  archive: { deltaKind: 'ARCHIVE', operationKind: 'ARCHIVE', transactionKind: 'ARCHIVE', lifecycle: 'USER_ASSERTED' },
  deletion: { deltaKind: 'DELETION', operationKind: 'DELETE', transactionKind: 'DELETE', lifecycle: 'USER_ASSERTED' },
});

/** The evidence external id a control derives rather than invents, so a retried
 * request with the same idempotency key resolves to the same source item instead
 * of a second copy of the owner's sentence. */
function statementExternalId(prefix: string, ownerScopeId: string, idempotencyKey: string): string {
  return prefix + ':' + createHash('sha256').update(ownerScopeId + ':' + idempotencyKey).digest('hex').slice(0, 32);
}
function statementIdempotencyKey(prefix: string, idempotencyKey: string): string {
  return createHash('sha256').update(prefix + ':' + idempotencyKey).digest('hex');
}

/** Does the object the owner pointed at exist, and where does it sit? A control
 * that names a claim also learns its proposition, which is what the proposed
 * transaction and the confirmation claim both need. */
async function resolveTarget(tx: OwnerTransaction, target: TargetObjectRef):
  Promise<{ propositionId: string | null; beliefSlotId: string | null; frameInstanceId: string | null }> {
  const owner = tx.context.ownerScopeId;
  switch (target.objectType) {
    case 'claim': {
      const row = (await tx.query('SELECT proposition_id FROM claims WHERE owner_scope_id=$1 AND id=$2', [owner, target.objectId])).rows[0];
      if (!row) throw new CorrectionRefusal(404, 'MEMORY_TARGET_NOT_FOUND');
      const propositionId = (row['proposition_id'] as string | null) ?? null;
      return propositionId ? { ...await slotOfProposition(tx, propositionId), propositionId } : { propositionId: null, beliefSlotId: null, frameInstanceId: null };
    }
    case 'proposition': {
      const row = (await tx.query('SELECT id FROM propositions WHERE owner_scope_id=$1 AND id=$2', [owner, target.objectId])).rows[0];
      if (!row) throw new CorrectionRefusal(404, 'MEMORY_TARGET_NOT_FOUND');
      return { ...await slotOfProposition(tx, target.objectId), propositionId: target.objectId };
    }
    case 'belief_slot': {
      const row = (await tx.query('SELECT frame_instance_id FROM belief_slots WHERE owner_scope_id=$1 AND id=$2', [owner, target.objectId])).rows[0];
      if (!row) throw new CorrectionRefusal(404, 'MEMORY_TARGET_NOT_FOUND');
      return { propositionId: null, beliefSlotId: target.objectId, frameInstanceId: row['frame_instance_id'] as string };
    }
    case 'frame_instance': {
      const row = (await tx.query('SELECT id FROM frame_instances WHERE owner_scope_id=$1 AND id=$2', [owner, target.objectId])).rows[0];
      if (!row) throw new CorrectionRefusal(404, 'MEMORY_TARGET_NOT_FOUND');
      return { propositionId: null, beliefSlotId: null, frameInstanceId: target.objectId };
    }
    default:
      // An entity or a resolution assertion is a legitimate target for a
      // suppression or a deletion; it carries no slot of its own.
      return { propositionId: null, beliefSlotId: null, frameInstanceId: null };
  }
}
async function slotOfProposition(tx: OwnerTransaction, propositionId: string): Promise<{ beliefSlotId: string | null; frameInstanceId: string | null }> {
  const row = (await tx.query(
    `SELECT s.id AS slot_id,s.frame_instance_id FROM propositions p
     JOIN belief_slots s ON s.owner_scope_id=p.owner_scope_id AND s.id=p.belief_slot_id
     WHERE p.owner_scope_id=$1 AND p.id=$2`, [tx.context.ownerScopeId, propositionId])).rows[0];
  return { beliefSlotId: (row?.['slot_id'] as string) ?? null, frameInstanceId: (row?.['frame_instance_id'] as string) ?? null };
}

export interface CorrectionRouteOptions {
  readonly evidenceObjects: EvidenceObjects | undefined;
  /** The release a proposed transaction is pinned to. Supplied by the caller so
   * this file reads no registry and pins nothing on its own authority. */
  readonly registryReleaseId?: string | undefined;
}

export function registerCorrectionRoutes(app: FastifyInstance, work: Work, options: CorrectionRouteOptions): void {
  /** The correction path runs under its own purpose, pinned by the URL mapping in
   * `platform.ts`. The governor's runner is bound to it here: proposing is the
   * governor's function, and `memory.correct` is the purpose migration 0014
   * admits for a proposal that comes from a correction control. The runner
   * refuses any other purpose, so this cannot become a way to widen a request. */
  function bindings(request: FastifyRequest): { runner: BeliefTransactionRunner; governed: GovernorRequest } | null {
    const dataPurpose = dataPurposeSchema.safeParse(request.headers['x-data-purpose']);
    const maximumSensitivity = sensitivitySchema.safeParse(request.headers['x-maximum-sensitivity']);
    if (!dataPurpose.success || !maximumSensitivity.success) return null;
    const context = request.ownerContext!;
    const runner: BeliefTransactionRunner = (purpose, run) => {
      if (purpose !== BELIEF_PURPOSES.govern || context.purpose !== CORRECTION_PURPOSE) {
        return Promise.reject(new BeliefTransactionError('MEMORY_PURPOSE_REFUSED'));
      }
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

  async function guarded(request: FastifyRequest, reply: FastifyReply,
    run: (bound: { runner: BeliefTransactionRunner; governed: GovernorRequest }) => Promise<unknown>): Promise<unknown> {
    const correlationId = request.ownerContext!.correlationId;
    const bound = bindings(request);
    if (!bound) return reply.code(400).send({ code: 'MEMORY_CONTEXT_REQUIRED', correlationId });
    try {
      return await run(bound);
    } catch (error) {
      const code = error instanceof CorrectionRefusal ? error.code
        : error instanceof MemoryStoreError || error instanceof BeliefTransactionError ? error.message
          : 'MEMORY_CORRECTION_UNAVAILABLE';
      const status = error instanceof CorrectionRefusal ? error.status : REFUSAL_STATUS.get(code) ?? 503;
      // Its own transaction: the work it refused was rolled back with everything
      // the refusal would otherwise have been recorded beside.
      await work(request, tx => tx.audit({ policyDecision: status < 500 ? 'DENY' : 'ALLOW', codeVersion: '0.1.0',
        result: status < 500 ? 'REFUSED' : 'FAILURE', objects: [] }));
      return reply.code(status).send({ code, correlationId });
    }
  }

  interface ControlRequest {
    readonly control: keyof typeof CONTROLS;
    readonly target: TargetObjectRef;
    readonly rawText: string;
    readonly sourceDeviceId?: string | undefined;
    readonly detail: Record<string, unknown>;
    /** The operations the proposed transaction carries. Built by the caller, so
     * a correction proposes a correction and a suppression proposes a
     * suppression rather than everything proposing the same thing. */
    operations(context: { propositionId: string | null; claimId: string | null; sourceAnchorId: string }): BeliefOperation[];
    /** Confirmation alone records a claim inside the write, because confirming is
     * an assertion of its own (CRT-AI-03-A). */
    readonly recordsConfirmationClaim?: boolean;
  }

  /** One control, start to finish, in one owner transaction: evidence, sequence,
   * delta, operation, proposal. They commit together or not at all, so an
   * acknowledged write is never half a write. */
  async function applyControl(request: FastifyRequest, reply: FastifyReply, input: ControlRequest): Promise<unknown> {
    return guarded(request, reply, async bound => {
      const idempotencyKey = request.headers['idempotency-key'];
      if (typeof idempotencyKey !== 'string') throw new CorrectionRefusal(400, 'MEMORY_CORRECTION_INPUT_INVALID');
      if (!options.evidenceObjects) throw new CorrectionRefusal(503, 'STORAGE_UNAVAILABLE');
      const objects = options.evidenceObjects;
      const shape = CONTROLS[input.control]!;
      const maximumSensitivity = sensitivitySchema.parse(request.headers['x-maximum-sensitivity']);
      const dataPurpose = dataPurposeSchema.parse(request.headers['x-data-purpose']);

      const receipt = await work(request, async tx => {
        await tx.query("SELECT set_config('unai.data_purpose',$1,true),set_config('unai.maximum_sensitivity',$2,true)",
          [dataPurpose, maximumSensitivity]);
        const resolved = await resolveTarget(tx, input.target);

        // 1. The owner's words, as a new evidence row. Nothing existing is touched.
        const evidence = await ingestOwnerStatement(tx, objects, {
          text: input.rawText,
          externalId: statementExternalId(shape.operationKind.toLowerCase(), tx.context.ownerScopeId, idempotencyKey),
          idempotencyKey: statementIdempotencyKey(shape.operationKind, idempotencyKey),
          sensitivity: maximumSensitivity, allowedPurposes: [dataPurpose],
          deterministicMetadata: { memoryOperationKind: shape.operationKind, targetObjectType: input.target.objectType },
        });

        // 2. The delta, with a freshly allocated owner sequence: from here the
        //    write is visible to every device of this owner (CRT-RYW-02-A).
        const delta = await recordOverlayDelta(tx, {
          ownerScopeId: tx.context.ownerScopeId, deltaKind: shape.deltaKind, rawText: input.rawText,
          sourceEvidenceId: evidence.evidenceId, lifecycle: shape.lifecycle, target: input.target,
          ...(input.sourceDeviceId === undefined ? {} : { sourceDeviceId: input.sourceDeviceId }),
          ...(resolved.frameInstanceId ? { candidateWorldlineRefs: [resolved.frameInstanceId] } : {}),
        });

        // 3. The confirmation claim, which is the only canonical row any control
        //    writes. It is a new row beside the confirmed one, never an edit of it.
        let claimId: string | null = null;
        if (input.recordsConfirmationClaim && resolved.propositionId) {
          claimId = await recordClaim(tx, {
            ownerScopeId: tx.context.ownerScopeId, sourceAnchorId: evidence.sourceAnchorId,
            propositionId: resolved.propositionId, claimOrigin: 'USER_CONFIRMATION', lifecycle: 'PROVISIONAL',
          });
        }
        return { evidence, delta, claimId, resolved };
      }) as { evidence: { evidenceId: string; sourceAnchorId: string }; delta: { overlayDeltaId: string; ownerSequence: number; lifecycle: OverlayLifecycle };
        claimId: string | null; resolved: { propositionId: string | null } };

      // 4. The proposal. The governor owns it, and it is a proposal only: nothing
      //    is accepted here, and a control whose transaction kind is null (keep
      //    uncertain) proposes nothing at all, which is the point of that control.
      let proposedTransactionId: string | null = null;
      if (shape.transactionKind && options.registryReleaseId) {
        const operations = input.operations({
          propositionId: receipt.resolved.propositionId, claimId: receipt.claimId,
          sourceAnchorId: receipt.evidence.sourceAnchorId,
        });
        if (operations.length > 0) {
          const proposed = await proposeBeliefTransaction(bound.runner, bound.governed, {
            transactionKind: shape.transactionKind, registryReleaseId: options.registryReleaseId,
            risk: 'LOW', sourceEvidenceIds: [receipt.evidence.evidenceId], operations,
            idempotencyKey: statementIdempotencyKey('propose:' + shape.operationKind, idempotencyKey).slice(0, 64),
          });
          proposedTransactionId = proposed.transactionId;
        }
      }

      // 5. The operation record, naming which of the ten controls this was, and
      //    the audit row, in the same transaction as each other.
      const memoryOperationId = await work(request, async tx => {
        const id = await recordMemoryOperation(tx, {
          ownerScopeId: tx.context.ownerScopeId, operationKind: shape.operationKind, target: input.target,
          evidenceId: receipt.evidence.evidenceId, requestedByActorId: tx.context.actorId,
          overlayDeltaId: receipt.delta.overlayDeltaId, transactionId: proposedTransactionId, detail: input.detail,
        });
        await tx.audit({ policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS', objects: [
          { type: 'memory_operations', id, fields: ['operation_kind', 'target_object_id'] },
          { type: 'owner_overlay_deltas', id: receipt.delta.overlayDeltaId, fields: ['delta_kind', 'owner_sequence'] },
        ] });
        return id;
      }) as string;

      return reply.code(201).send(memoryWriteReceiptSchema.parse({
        operationKind: shape.operationKind, memoryOperationId, evidenceId: receipt.evidence.evidenceId,
        overlayDeltaId: receipt.delta.overlayDeltaId, ownerSequence: receipt.delta.ownerSequence,
        proposedTransactionId, lifecycle: receipt.delta.lifecycle, visibilityStatus: 'OWNER_VISIBLE',
        createdClaimId: receipt.claimId,
      }));
    });
  }

  /** A direct owner assertion with no correction control behind it: "I paid him
   * back", typed on a phone. It is acknowledged as soon as the delta is durable,
   * and the desktop's next read has it (CRT-RYW-02-A). */
  app.post('/v1/memory/overlay-deltas', async (request, reply) => guarded(request, reply, async () => {
    const parsed = overlayDeltaInputSchema.safeParse(request.body);
    if (!parsed.success) throw new CorrectionRefusal(400, 'MEMORY_CORRECTION_INPUT_INVALID');
    const idempotencyKey = request.headers['idempotency-key'];
    if (typeof idempotencyKey !== 'string') throw new CorrectionRefusal(400, 'MEMORY_CORRECTION_INPUT_INVALID');
    if (!options.evidenceObjects) throw new CorrectionRefusal(503, 'STORAGE_UNAVAILABLE');
    const objects = options.evidenceObjects;
    const input = parsed.data;
    const dataPurpose = dataPurposeSchema.parse(request.headers['x-data-purpose']);
    const maximumSensitivity = sensitivitySchema.parse(request.headers['x-maximum-sensitivity']);
    const sensitivity = input.sensitivity ?? maximumSensitivity;

    const written = await work(request, async tx => {
      await tx.query("SELECT set_config('unai.data_purpose',$1,true),set_config('unai.maximum_sensitivity',$2,true)",
        [dataPurpose, maximumSensitivity]);
      if (input.target) await resolveTarget(tx, input.target);
      const evidence = await ingestOwnerStatement(tx, objects, {
        text: input.rawText, externalId: statementExternalId('delta', tx.context.ownerScopeId, idempotencyKey),
        idempotencyKey: statementIdempotencyKey('delta', idempotencyKey),
        sensitivity, allowedPurposes: [dataPurpose], deterministicMetadata: { deltaKind: input.deltaKind },
      });
      // A delta that names no frame instance is not lost: it is retrievable by
      // candidate entity, thread, discourse anchor and frame type until
      // canonicalization attaches it (PRD §14.2).
      const attached = input.target?.objectType === 'frame_instance';
      const delta = await recordOverlayDelta(tx, {
        ownerScopeId: tx.context.ownerScopeId, deltaKind: input.deltaKind, rawText: input.rawText,
        sourceEvidenceId: evidence.evidenceId,
        lifecycle: attached ? 'USER_ASSERTED' : 'AWAITING_INSTANCE_RESOLUTION',
        ...(input.target === undefined ? {} : { target: input.target }),
        ...(input.sourceDeviceId === undefined ? {} : { sourceDeviceId: input.sourceDeviceId }),
        ...(input.candidateEntityRefs === undefined ? {} : { candidateEntityRefs: input.candidateEntityRefs }),
        ...(input.candidateWorldlineRefs === undefined ? {} : { candidateWorldlineRefs: input.candidateWorldlineRefs }),
        ...(input.candidateFrameTypes === undefined ? {} : { candidateFrameTypes: input.candidateFrameTypes }),
        ...(input.discourseAnchor === undefined ? {} : { discourseAnchor: input.discourseAnchor }),
        ...(input.temporalHints === undefined ? {} : { temporalHints: input.temporalHints }),
      });
      await tx.audit({ policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS',
        objects: [{ type: 'owner_overlay_deltas', id: delta.overlayDeltaId, fields: ['delta_kind', 'owner_sequence'] }] });
      return { evidence, delta };
    }) as { evidence: { evidenceId: string }; delta: { overlayDeltaId: string; ownerSequence: number; lifecycle: OverlayLifecycle } };

    return reply.code(201).send({
      overlayDeltaId: written.delta.overlayDeltaId, ownerSequence: written.delta.ownerSequence,
      evidenceId: written.evidence.evidenceId, lifecycle: written.delta.lifecycle, visibilityStatus: 'OWNER_VISIBLE',
    });
  }));

  /** The owner's overlay, read by owner scope: the same rows whichever device
   * asks (CRT-RYW-02-A, CRT-RYW-02-B). */
  app.get<{ Querystring: { sinceSequence?: string } }>('/v1/memory/overlay-deltas', async (request, reply) =>
    guarded(request, reply, async () => {
      const since = request.query.sinceSequence;
      if (since !== undefined && !/^\d{1,15}$/.test(since)) throw new CorrectionRefusal(400, 'MEMORY_CORRECTION_INPUT_INVALID');
      const overlay = await work(request, async tx => {
        await tx.query("SELECT set_config('unai.data_purpose',$1,true),set_config('unai.maximum_sensitivity',$2,true)",
          [request.headers['x-data-purpose'], request.headers['x-maximum-sensitivity']]);
        const readableEvidenceIds = (await tx.query('SELECT id FROM source_items WHERE owner_scope_id=$1',
          [tx.context.ownerScopeId])).rows.map(row => row['id'] as string);
        const answer = await readOwnerOverlay(tx, {
          ownerScopeId: tx.context.ownerScopeId, ...(since === undefined ? {} : { sinceSequence: Number(since) }),
          readableEvidenceIds,
        });
        await tx.audit({ policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS',
          objects: answer.deltas.slice(0, 100).map(delta => ({
            type: 'owner_overlay_deltas', id: delta.overlayDeltaId, fields: ['delta_kind', 'lifecycle'] })) });
        return answer;
      });
      return reply.code(200).send(overlay);
    }));

  app.post('/v1/memory/corrections', async (request, reply) => {
    const parsed = correctionInputSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ code: 'MEMORY_CORRECTION_INPUT_INVALID', correlationId: request.ownerContext!.correlationId });
    const input = parsed.data;
    return applyControl(request, reply, {
      control: 'correction', target: input.target, rawText: input.rawText,
      ...(input.sourceDeviceId === undefined ? {} : { sourceDeviceId: input.sourceDeviceId }),
      detail: { correctedValue: input.correctedValue, validInterval: input.validInterval ?? null },
      // A correction restates the same valid interval. The claim it proposes says
      // so; the governor and `@unai/memory`'s claim relations keep it apart from a
      // change, which opens a new period instead (CRT-MEM-09-A).
      operations: ({ sourceAnchorId }) => [{
        kind: 'ADD_CLAIM', operationRef: '#correction', sourceAnchorId, claimOrigin: 'USER_CORRECTION',
        lifecycle: 'PROVISIONAL',
        ...(input.validInterval?.validFrom ? { validFrom: input.validInterval.validFrom } : {}),
        ...(input.validInterval?.validTo ? { validTo: input.validInterval.validTo } : {}),
      }],
    });
  });

  app.post('/v1/memory/state-changes', async (request, reply) => {
    const parsed = stateChangeInputSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ code: 'MEMORY_CORRECTION_INPUT_INVALID', correlationId: request.ownerContext!.correlationId });
    const input = parsed.data;
    return applyControl(request, reply, {
      control: 'stateChange', target: input.target, rawText: input.rawText,
      ...(input.sourceDeviceId === undefined ? {} : { sourceDeviceId: input.sourceDeviceId }),
      detail: { newValue: input.newValue, changeEffectiveFrom: input.changeEffectiveFrom },
      // The new period begins where the change happened; the earlier value keeps
      // the interval it already covered.
      operations: ({ sourceAnchorId }) => [{
        kind: 'ADD_CLAIM', operationRef: '#change', sourceAnchorId, claimOrigin: 'USER_STATEMENT',
        lifecycle: 'PROVISIONAL', validFrom: input.changeEffectiveFrom,
      }],
    });
  });

  app.post('/v1/memory/confirmations', async (request, reply) => {
    const parsed = confirmationInputSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ code: 'MEMORY_CORRECTION_INPUT_INVALID', correlationId: request.ownerContext!.correlationId });
    const input = parsed.data;
    return applyControl(request, reply, {
      control: 'confirmation', target: input.target, rawText: input.confirmedText,
      ...(input.sourceDeviceId === undefined ? {} : { sourceDeviceId: input.sourceDeviceId }),
      detail: { ...(input.sourceMessageId === undefined ? {} : { sourceMessageId: input.sourceMessageId }) },
      recordsConfirmationClaim: true,
      // The claim itself is already written; the proposal only asks the governor
      // to weigh it as support. It adds no origin to the confirmed claim and
      // touches nothing that exists (CRT-AI-03-A).
      operations: ({ propositionId, claimId }) => propositionId && claimId
        ? [{ kind: 'ADD_SUPPORT', proposition: propositionId, claim: claimId, supportKind: 'DIRECT_ASSERTION' }]
        : [],
    });
  });

  app.post('/v1/memory/rejections', async (request, reply) => {
    const parsed = rejectionInputSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ code: 'MEMORY_CORRECTION_INPUT_INVALID', correlationId: request.ownerContext!.correlationId });
    const input = parsed.data;
    return applyControl(request, reply, {
      control: 'rejection', target: input.target, rawText: input.reason,
      ...(input.sourceDeviceId === undefined ? {} : { sourceDeviceId: input.sourceDeviceId }),
      detail: { reason: input.reason },
      // Rejecting an interpretation is not rejecting the evidence: the underlying
      // source item stays exactly as it is, and only the reading of it is refused.
      operations: ({ propositionId }) => propositionId
        ? [{ kind: 'SET_BELIEF_ASSESSMENT', proposition: propositionId, assessmentStatus: 'REJECTED',
          decisionReason: { code: 'USER_REJECTED_INTERPRETATION' } }]
        : [],
    });
  });

  app.post('/v1/memory/keep-uncertain', async (request, reply) => {
    const parsed = keepUncertainInputSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ code: 'MEMORY_CORRECTION_INPUT_INVALID', correlationId: request.ownerContext!.correlationId });
    const input = parsed.data;
    // Keeping something uncertain proposes nothing on purpose: the object is
    // retained exactly as it is, without a decision, and leaves the clarification
    // queue for the suppression window.
    return applyControl(request, reply, {
      control: 'keepUncertain', target: input.target, rawText: input.rawText ?? 'Keep uncertain',
      ...(input.sourceDeviceId === undefined ? {} : { sourceDeviceId: input.sourceDeviceId }),
      detail: { decision: 'KEEP_UNCERTAIN' }, operations: () => [],
    });
  });

  app.post('/v1/memory/suppressions', async (request, reply) => {
    const parsed = suppressionInputSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ code: 'MEMORY_CORRECTION_INPUT_INVALID', correlationId: request.ownerContext!.correlationId });
    const input = parsed.data;
    return applyControl(request, reply, {
      control: 'suppression', target: input.target, rawText: input.rawText ?? 'Suppress from normal retrieval',
      ...(input.sourceDeviceId === undefined ? {} : { sourceDeviceId: input.sourceDeviceId }),
      detail: { scope: input.scope ?? 'OBJECT' },
      operations: ({ propositionId }) => propositionId
        ? [{ kind: 'SUPPRESS', target: propositionId, targetObjectType: 'proposition' }]
        : [],
    });
  });

  app.post('/v1/memory/archives', async (request, reply) => {
    const parsed = archiveInputSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ code: 'MEMORY_CORRECTION_INPUT_INVALID', correlationId: request.ownerContext!.correlationId });
    const input = parsed.data;
    // Archive is its own kind, distinct from suppress and delete: the object stays
    // available for explicit historical access with reduced salience. The
    // canonical ARCHIVE operation belongs to the deletion-workflow node, so this
    // control records the overlay delta and the operation and proposes no
    // canonical change it does not own.
    return applyControl(request, reply, {
      control: 'archive', target: input.target, rawText: input.rawText ?? 'Archive',
      ...(input.sourceDeviceId === undefined ? {} : { sourceDeviceId: input.sourceDeviceId }),
      detail: { salience: 'REDUCED' }, operations: () => [],
    });
  });

  app.post('/v1/memory/deletions', async (request, reply) => {
    const parsed = deletionInputSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ code: 'MEMORY_CORRECTION_INPUT_INVALID', correlationId: request.ownerContext!.correlationId });
    const input = parsed.data;
    // The cascade -- raw object, parsed content, anchors, claims, unsupported
    // derived beliefs, embeddings, summaries, indexes, projection rows and plugin
    // caches -- is the export-and-deletion node's workflow (CRT-SEC-11-A). What
    // this control owns is the acknowledged request: the delta that removes the
    // object from every device's next read straight away (CRT-RYW-02-B), and the
    // operation row that records the request as a DELETE and nothing weaker.
    return applyControl(request, reply, {
      control: 'deletion', target: input.target, rawText: input.rawText ?? 'Delete',
      ...(input.sourceDeviceId === undefined ? {} : { sourceDeviceId: input.sourceDeviceId }),
      detail: { scope: input.scope ?? 'OBJECT', confirmation: input.confirmation, cascade: 'PENDING_DELETION_WORKFLOW' },
      operations: () => [],
    });
  });
}
