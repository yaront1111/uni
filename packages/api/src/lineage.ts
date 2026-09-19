import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { OwnerTransaction } from '@unai/postgres';
import {
  dataPurposeSchema, sensitivitySchema, entityMergeRequestSchema, entityMergeResultSchema, entitySplitRequestSchema,
  entitySplitResultSchema, frameInstanceMergeRequestSchema, frameInstanceMergeResultSchema, frameInstanceSplitRequestSchema,
  frameInstanceSplitResultSchema, mergeSplitReviewSchema,
  type BeliefOperation, type EntityMergeDetail, type EntitySplitDetail, type FrameMergeDetail, type FrameSplitDetail,
  type LineageObjectType, type ProjectionRebuildReceipt, type ResolvedIdentity, type TargetObjectRef,
} from '@unai/domain';
import {
  BELIEF_PURPOSES, BeliefTransactionError, commitBeliefTransaction, proposeBeliefTransaction,
  type BeliefTransactionRunner, type GovernorRequest,
} from '@unai/belief';
import { listRecentLineage, readLineageForTransaction, recordMemoryOperation, resolveIdentity } from '@unai/memory';
import { PROJECTION_PURPOSE, rebuildProjectionsAfterLineageChange } from '@unai/capabilities';
import { ingestOwnerStatement, type EvidenceObjects } from './evidence.js';

/**
 * Governed merge and split (PRD §14, §35.11; design routes
 * POST /v1/memory/frame-instances/merge, POST /v1/memory/frame-instances/{id}/split,
 * POST /v1/memory/entities/merge, POST /v1/memory/entities/{id}/split, and the
 * Merge and split review screen; CRT-MEM-10-A, CRT-MEM-10-B, CRT-MEM-10-C).
 *
 * Each write is a belief transaction of kind MERGE or SPLIT, proposed and
 * committed through the write governor, never a database shortcut (PRD §14): the
 * policy decision, the idempotency key and the stored receipt are the
 * governor's. Then the typed projections are rebuilt under `memory.project`, the
 * only purpose that writes projection rows (ADR 0021 §7), and the answer carries
 * the lineage the transaction wrote, a rebuild receipt per projection, and what
 * every old and new identifier resolves to now.
 *
 * A retry with the same idempotency key finds the committed transaction and
 * answers from what it stored -- the operation results, the lineage and the
 * receipts already recorded for it -- so the same request always answers the
 * same body and nothing is merged or rebuilt twice.
 *
 * The Merge and Split correction controls are these endpoints. Each committed
 * merge or split is also recorded as a `memory_operations` row of kind MERGE or
 * SPLIT, beside the owner's statement stored as evidence, so every one of the ten
 * controls leaves its own persisted kind (ADR 0028 §3; CRT-UX-10-A).
 */

export const LINEAGE_WRITE_PURPOSE = BELIEF_PURPOSES.govern;
export const MERGE_SPLIT_REVIEW_PURPOSE = 'memory.inspect';

type Work = (request: FastifyRequest, run: (tx: OwnerTransaction, sessionId: string) => Promise<unknown>,
  purpose?: string) => Promise<unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class LineageRefusal extends Error {
  constructor(readonly status: number, code: string) { super(code); }
}

const REFUSAL_STATUS = new Map<string, number>([
  ['FRAME_INSTANCE_NOT_FOUND', 404], ['ENTITY_NOT_FOUND', 404],
  ['FRAME_INSTANCE_NOT_ACTIVE', 409], ['ENTITY_NOT_ACTIVE', 409],
  ['FRAME_MERGE_TYPE_MISMATCH', 409], ['FRAME_MERGE_CONTEXT_MISMATCH', 409], ['ENTITY_MERGE_KIND_MISMATCH', 409],
  ['FRAME_MERGE_SELF', 400], ['ENTITY_MERGE_SELF', 400],
  ['SPLIT_CLAIM_NOT_IN_TARGET', 409], ['SPLIT_ALIAS_NOT_ON_TARGET', 409],
  ['SPLIT_PARTITION_DUPLICATE', 400], ['SPLIT_PARTITION_UNKNOWN', 400],
  ['SPLIT_CLAIM_ASSIGNED_TWICE', 400], ['SPLIT_ALIAS_ASSIGNED_TWICE', 400],
  ['BELIEF_TRANSACTION_REFUSED', 409], ['BELIEF_TRANSACTION_REJECTED', 409],
  ['BELIEF_TRANSACTION_IDEMPOTENCY_KEY_MISMATCH', 409], ['BELIEF_SUPPORT_ORIGIN_UNREADABLE', 409],
]);

export interface LineageRouteOptions {
  /** The release a merge or split transaction is pinned to, supplied by the
   * caller exactly as the correction routes receive it. */
  readonly registryReleaseId?: string | undefined;
  /** Where the owner's statement behind a merge or split is stored. Without one
   * the endpoints refuse before proposing anything, as the correction endpoints
   * do: a merge is never committed without the record of the request. */
  readonly evidenceObjects?: EvidenceObjects | undefined;
}

/** The correction write path's purpose, under which the MERGE and SPLIT
 * operation records are written (migration 0014 admits no other). */
const OPERATION_PURPOSE = 'memory.correct';

interface Plan {
  readonly transactionKind: 'MERGE' | 'SPLIT';
  readonly operations: BeliefOperation[];
  readonly sourceEvidenceIds: string[];
}

interface Committed {
  readonly transactionId: string;
  readonly committedAt: string;
  readonly results: Record<string, unknown>[];
}

export function registerLineageRoutes(app: FastifyInstance, work: Work, options: LineageRouteOptions): void {
  function bindings(request: FastifyRequest): { runner: BeliefTransactionRunner; governed: GovernorRequest } | null {
    const dataPurpose = dataPurposeSchema.safeParse(request.headers['x-data-purpose']);
    const maximumSensitivity = sensitivitySchema.safeParse(request.headers['x-maximum-sensitivity']);
    if (!dataPurpose.success || !maximumSensitivity.success) return null;
    const context = request.ownerContext!;
    const runner: BeliefTransactionRunner = (purpose, run) => {
      // The request's purpose, pinned by the URL mapping; the governor may not widen it.
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

  async function guarded(request: FastifyRequest, reply: FastifyReply, run: (bound: {
    runner: BeliefTransactionRunner; governed: GovernorRequest; idempotencyKey: string; registryReleaseId: string;
  }) => Promise<unknown>): Promise<unknown> {
    const correlationId = request.ownerContext!.correlationId;
    const bound = bindings(request);
    if (!bound) return reply.code(400).send({ code: 'MEMORY_CONTEXT_REQUIRED', correlationId });
    const idempotencyKey = request.headers['idempotency-key'];
    try {
      if (typeof idempotencyKey !== 'string') throw new LineageRefusal(400, 'LINEAGE_INPUT_INVALID');
      if (!options.registryReleaseId) throw new LineageRefusal(503, 'REGISTRY_RELEASE_NOT_CONFIGURED');
      if (!options.evidenceObjects) throw new LineageRefusal(503, 'STORAGE_UNAVAILABLE');
      return await run({ ...bound, idempotencyKey, registryReleaseId: options.registryReleaseId });
    } catch (error) {
      const code = error instanceof LineageRefusal || error instanceof BeliefTransactionError ? error.message : 'LINEAGE_UNAVAILABLE';
      const status = error instanceof LineageRefusal ? error.status
        : REFUSAL_STATUS.get(code) ?? (error instanceof BeliefTransactionError ? 400 : 503);
      // Its own transaction: the work it refused was rolled back.
      await work(request, tx => tx.audit({ policyDecision: status < 500 ? 'DENY' : 'ALLOW', codeVersion: '0.1.0',
        result: status < 500 ? 'REFUSED' : 'FAILURE', objects: [] }));
      return reply.code(status).send({ code, correlationId });
    }
  }

  /**
   * Propose and commit one merge or split, or find the one this idempotency key
   * already committed. Planning happens only for a new key: after a merge the
   * merged ids are no longer active, so a retry must not be re-planned against
   * them -- it is answered from the transaction it already committed.
   */
  async function commitOnce(bound: { runner: BeliefTransactionRunner; governed: GovernorRequest; idempotencyKey: string;
    registryReleaseId: string }, request: FastifyRequest, kind: 'MERGE' | 'SPLIT',
    plan: (tx: OwnerTransaction) => Promise<Plan>): Promise<Committed> {
    const existing = await work(request, async tx => (await tx.query(
      'SELECT id,transaction_kind FROM belief_transactions WHERE owner_scope_id=$1 AND idempotency_key=$2',
      [tx.context.ownerScopeId, bound.idempotencyKey])).rows[0]) as Record<string, unknown> | undefined;
    if (existing && existing['transaction_kind'] !== kind) throw new LineageRefusal(409, 'IDEMPOTENCY_KEY_REUSED');
    let transactionId = existing?.['id'] as string | undefined;
    if (!transactionId) {
      const planned = await work(request, tx => plan(tx)) as Plan;
      const proposed = await proposeBeliefTransaction(bound.runner, bound.governed, {
        transactionKind: planned.transactionKind, registryReleaseId: bound.registryReleaseId,
        // An explicit owner decision that rewrites identity: material, never
        // high-risk enough to need a second confirmation of the confirmation.
        risk: 'MEDIUM', idempotencyKey: bound.idempotencyKey,
        sourceEvidenceIds: planned.sourceEvidenceIds, operations: planned.operations,
      });
      transactionId = proposed.transactionId;
    }
    const receipt = await commitBeliefTransaction(bound.runner, bound.governed, { transactionId, idempotencyKey: bound.idempotencyKey });
    const results = await work(request, async tx => (await tx.query(
      `SELECT result_object_refs FROM belief_transaction_operations WHERE owner_scope_id=$1 AND belief_transaction_id=$2
       ORDER BY operation_order`, [tx.context.ownerScopeId, transactionId])).rows
      .map(row => (row['result_object_refs'] ?? {}) as Record<string, unknown>)) as Record<string, unknown>[];
    return { transactionId: receipt.transactionId, committedAt: receipt.committedAt, results };
  }

  /** Rebuild the typed projections under the reducer's own purpose. The purpose is
   * chosen here, by server code, never by a header (ADR 0025 §4). */
  async function rebuild(request: FastifyRequest, trigger: 'MERGE' | 'SPLIT', transactionId: string,
    frameInstanceIds: readonly string[]): Promise<ProjectionRebuildReceipt[]> {
    return await work(request, tx => rebuildProjectionsAfterLineageChange(tx, {
      ownerScopeId: tx.context.ownerScopeId, trigger, transactionId, frameInstanceIds, asOf: new Date(),
    }), PROJECTION_PURPOSE) as ProjectionRebuildReceipt[];
  }

  async function answer(request: FastifyRequest, committed: Committed, identities: readonly { objectType: LineageObjectType; id: string }[]) {
    return await work(request, async tx => {
      const owner = tx.context.ownerScopeId;
      const lineage = await readLineageForTransaction(tx, { ownerScopeId: owner, transactionId: committed.transactionId });
      const resolution: ResolvedIdentity[] = [];
      const seen = new Set<string>();
      for (const identity of identities) {
        if (seen.has(identity.objectType + identity.id)) continue;
        seen.add(identity.objectType + identity.id);
        const resolved = await resolveIdentity(tx, { ownerScopeId: owner, objectType: identity.objectType, id: identity.id });
        if (resolved) resolution.push(resolved);
      }
      return { lineage, resolution };
    }) as { lineage: Awaited<ReturnType<typeof readLineageForTransaction>>; resolution: ResolvedIdentity[] };
  }

  /**
   * Record the Merge or Split control the owner used: their statement as a new
   * evidence row and one MERGE or SPLIT memory operation naming the committed
   * transaction. Written under `memory.correct`, chosen here and never read from
   * a header. No overlay delta: the change is already canonical, and a delta on
   * the frame would be one no projection can fold (ADR 0028 §3). A retry finds the
   * operation already recorded for the transaction and writes nothing.
   */
  async function recordOperation(request: FastifyRequest, input: {
    kind: 'MERGE' | 'SPLIT'; target: TargetObjectRef; transactionId: string; reason: string | undefined; idempotencyKey: string;
  }): Promise<string> {
    const objects = options.evidenceObjects!;
    const dataPurpose = dataPurposeSchema.parse(request.headers['x-data-purpose']);
    const maximumSensitivity = sensitivitySchema.parse(request.headers['x-maximum-sensitivity']);
    return await work(request, async tx => {
      const owner = tx.context.ownerScopeId;
      const existing = (await tx.query(
        'SELECT id FROM memory_operations WHERE owner_scope_id=$1 AND transaction_id=$2 AND operation_kind=$3 ORDER BY created_at,id LIMIT 1',
        [owner, input.transactionId, input.kind])).rows[0];
      if (existing) return existing['id'] as string;
      await tx.query("SELECT set_config('unai.data_purpose',$1,true),set_config('unai.maximum_sensitivity',$2,true)",
        [dataPurpose, maximumSensitivity]);
      const digest = (prefix: string) => createHash('sha256').update(prefix + ':' + owner + ':' + input.idempotencyKey).digest('hex');
      const evidence = await ingestOwnerStatement(tx, objects, {
        text: input.reason ?? (input.kind === 'MERGE' ? 'Merge' : 'Split'),
        externalId: input.kind.toLowerCase() + ':' + digest('external').slice(0, 32),
        idempotencyKey: digest(input.kind),
        sensitivity: maximumSensitivity, allowedPurposes: [dataPurpose],
        deterministicMetadata: { memoryOperationKind: input.kind, targetObjectType: input.target.objectType },
      });
      const id = await recordMemoryOperation(tx, {
        ownerScopeId: owner, operationKind: input.kind, target: input.target, evidenceId: evidence.evidenceId,
        requestedByActorId: tx.context.actorId, overlayDeltaId: null, transactionId: input.transactionId,
        detail: { reason: input.reason ?? null },
      });
      await tx.audit({ policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS',
        objects: [{ type: 'memory_operations', id, fields: ['operation_kind', 'target_object_id', 'transaction_id'] }] });
      return id;
    }, OPERATION_PURPOSE) as string;
  }

  async function audited<T>(request: FastifyRequest, objects: { type: string; id: string; fields: string[] }[], body: T): Promise<T> {
    await work(request, tx => tx.audit({ policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS', objects: objects.slice(0, 100) }));
    return body;
  }

  async function lockedRows(tx: OwnerTransaction, table: 'frame_instances' | 'entities', ids: readonly string[]) {
    return (await tx.query(`SELECT * FROM ${table} WHERE owner_scope_id=$1 AND id=ANY($2::uuid[]) ORDER BY created_at,id`,
      [tx.context.ownerScopeId, [...ids]])).rows;
  }

  // -------------------------------------------------------------------------

  app.post('/v1/memory/frame-instances/merge', async (request, reply) => guarded(request, reply, async bound => {
    const parsed = frameInstanceMergeRequestSchema.safeParse(request.body);
    if (!parsed.success || new Set(parsed.data.instanceIds).size !== parsed.data.instanceIds.length) {
      throw new LineageRefusal(400, 'LINEAGE_INPUT_INVALID');
    }
    const input = parsed.data;
    const committed = await commitOnce(bound, request, 'MERGE', async tx => {
      const rows = await lockedRows(tx, 'frame_instances', input.instanceIds);
      if (rows.length !== input.instanceIds.length) throw new LineageRefusal(404, 'FRAME_INSTANCE_NOT_FOUND');
      if (rows.some(row => row['lifecycle'] !== 'ACTIVE')) throw new LineageRefusal(409, 'FRAME_INSTANCE_NOT_ACTIVE');
      if (new Set(rows.map(row => row['frame_type_id'])).size !== 1) throw new LineageRefusal(409, 'FRAME_MERGE_TYPE_MISMATCH');
      if (new Set(rows.map(row => row['context_space_id'])).size !== 1) throw new LineageRefusal(409, 'FRAME_MERGE_CONTEXT_MISMATCH');
      const operations: BeliefOperation[] = [];
      let survivor: string;
      if (input.survivorHint === 'NEW_INSTANCE') {
        // PRD §14.1 item 1: a new canonical instance may survive; every named one merges into it.
        operations.push({ kind: 'CREATE_FRAME_INSTANCE', operationRef: '#survivor',
          frameTypeId: rows[0]!['frame_type_id'] as string, contextSpaceId: rows[0]!['context_space_id'] as string });
        survivor = '#survivor';
      } else if (input.survivorHint !== undefined) {
        if (!input.instanceIds.includes(input.survivorHint)) throw new LineageRefusal(400, 'SURVIVOR_NOT_IN_MERGE');
        survivor = input.survivorHint;
      } else {
        survivor = rows[0]!['id'] as string; // the oldest instance, ties broken by id
      }
      for (const id of input.instanceIds) {
        if (id === survivor) continue;
        operations.push({ kind: 'MERGE', targetObjectType: 'frame_instance', target: id, survivor,
          ...(input.reason === undefined ? {} : { reason: input.reason }) });
      }
      return { transactionKind: 'MERGE', operations, sourceEvidenceIds: [] };
    });
    const merges = committed.results.map(result => result['merge']).filter(Boolean) as FrameMergeDetail[];
    if (merges.length === 0) throw new LineageRefusal(503, 'LINEAGE_UNAVAILABLE');
    const survivorId = merges[0]!.survivorFrameInstanceId;
    const mergedIds = merges.map(merge => merge.mergedFrameInstanceId);
    const survivorCreated = committed.results.some(result => result['objectType'] === 'frame_instances'
      && result['objectId'] === survivorId && !('merge' in result));
    const receipts = await rebuild(request, 'MERGE', committed.transactionId, [survivorId, ...mergedIds]);
    const { lineage, resolution } = await answer(request, committed, [
      ...[survivorId, ...mergedIds].map(id => ({ objectType: 'frame_instance' as const, id })),
      ...merges.flatMap(merge => merge.mergedPropositions.map(entry => ({ objectType: 'proposition' as const, id: entry.fromPropositionId }))),
    ]);
    const body = frameInstanceMergeResultSchema.parse({
      transactionId: committed.transactionId, committedAt: committed.committedAt,
      survivorFrameInstanceId: survivorId, survivorCreated, mergedFrameInstanceIds: mergedIds,
      lineage: lineage.frameInstances, propositionLineage: lineage.propositions, merges,
      projectionRebuildReceipts: receipts, resolution,
    });
    const memoryOperationId = await recordOperation(request, { kind: 'MERGE', target: { objectType: 'frame_instance', objectId: survivorId },
      transactionId: body.transactionId, reason: input.reason, idempotencyKey: bound.idempotencyKey });
    return audited(request, [
      { type: 'belief_transactions', id: body.transactionId, fields: ['commit_receipt'] },
      ...body.lineage.map(record => ({ type: 'frame_instance_lineage', id: record.lineageId, fields: ['lineage_kind'] })),
      ...body.projectionRebuildReceipts.map(receipt => ({ type: 'projection_rebuild_receipts', id: receipt.projectionRebuildReceiptId, fields: ['trigger'] })),
    ], { ...body, memoryOperationId });
  }));

  app.post<{ Params: { id: string } }>('/v1/memory/frame-instances/:id/split', async (request, reply) => guarded(request, reply, async bound => {
    const parsed = frameInstanceSplitRequestSchema.safeParse(request.body);
    if (!UUID.test(request.params.id) || !parsed.success) throw new LineageRefusal(400, 'LINEAGE_INPUT_INVALID');
    const input = parsed.data;
    const parentId = request.params.id.toLowerCase();
    const committed = await commitOnce(bound, request, 'SPLIT', async tx => {
      const rows = await lockedRows(tx, 'frame_instances', [parentId]);
      if (rows.length !== 1) throw new LineageRefusal(404, 'FRAME_INSTANCE_NOT_FOUND');
      if (rows[0]!['lifecycle'] !== 'ACTIVE') throw new LineageRefusal(409, 'FRAME_INSTANCE_NOT_ACTIVE');
      return {
        transactionKind: 'SPLIT', sourceEvidenceIds: [],
        operations: [{
          kind: 'SPLIT', targetObjectType: 'frame_instance', target: parentId,
          partitions: input.targetPartitions.map(partition => partition.partitionKey),
          partitionSpecs: input.targetPartitions.filter(partition => partition.roles !== undefined)
            .map(partition => ({ partition: partition.partitionKey, roles: partition.roles! })),
          claimAssignments: input.claimAssignments.map(assignment => ({ claimId: assignment.claimId, partition: assignment.partitionKey })),
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        }],
      };
    });
    const split = committed.results.map(result => result['split']).find(Boolean) as FrameSplitDetail | undefined;
    if (!split) throw new LineageRefusal(503, 'LINEAGE_UNAVAILABLE');
    const children = split.newFrameInstances.map(child => child.frameInstanceId);
    const receipts = await rebuild(request, 'SPLIT', committed.transactionId, [split.parentFrameInstanceId, ...children]);
    const { lineage, resolution } = await answer(request, committed, [
      ...[split.parentFrameInstanceId, ...children].map(id => ({ objectType: 'frame_instance' as const, id })),
      ...split.newPropositions.map(entry => ({ objectType: 'proposition' as const, id: entry.fromPropositionId })),
    ]);
    const body = frameInstanceSplitResultSchema.parse({
      transactionId: committed.transactionId, committedAt: committed.committedAt,
      lineage: lineage.frameInstances, propositionLineage: lineage.propositions, split,
      projectionRebuildReceipts: receipts, resolution,
    });
    const memoryOperationId = await recordOperation(request, { kind: 'SPLIT', target: { objectType: 'frame_instance', objectId: parentId },
      transactionId: body.transactionId, reason: input.reason, idempotencyKey: bound.idempotencyKey });
    return audited(request, [
      { type: 'belief_transactions', id: body.transactionId, fields: ['commit_receipt'] },
      ...body.lineage.map(record => ({ type: 'frame_instance_lineage', id: record.lineageId, fields: ['lineage_kind'] })),
      ...body.split.contestedClaims.map(claim => ({ type: 'claims', id: claim.claimId, fields: ['lifecycle'] })),
      ...body.projectionRebuildReceipts.map(receipt => ({ type: 'projection_rebuild_receipts', id: receipt.projectionRebuildReceiptId, fields: ['trigger'] })),
    ], { ...body, memoryOperationId });
  }));

  app.post('/v1/memory/entities/merge', async (request, reply) => guarded(request, reply, async bound => {
    const parsed = entityMergeRequestSchema.safeParse(request.body);
    if (!parsed.success || new Set(parsed.data.entityIds).size !== parsed.data.entityIds.length) {
      throw new LineageRefusal(400, 'LINEAGE_INPUT_INVALID');
    }
    const input = parsed.data;
    const committed = await commitOnce(bound, request, 'MERGE', async tx => {
      const rows = await lockedRows(tx, 'entities', input.entityIds);
      if (rows.length !== input.entityIds.length) throw new LineageRefusal(404, 'ENTITY_NOT_FOUND');
      if (rows.some(row => row['lifecycle'] !== 'ACTIVE')) throw new LineageRefusal(409, 'ENTITY_NOT_ACTIVE');
      if (new Set(rows.map(row => row['entity_kind'])).size !== 1) throw new LineageRefusal(409, 'ENTITY_MERGE_KIND_MISMATCH');
      if (input.survivorHint !== undefined && !input.entityIds.includes(input.survivorHint)) {
        throw new LineageRefusal(400, 'SURVIVOR_NOT_IN_MERGE');
      }
      const survivor = input.survivorHint ?? rows[0]!['id'] as string;
      return {
        transactionKind: 'MERGE', sourceEvidenceIds: input.evidenceRef ? [input.evidenceRef] : [],
        operations: input.entityIds.filter(id => id !== survivor).map(id => ({
          kind: 'MERGE' as const, targetObjectType: 'entity' as const, target: id, survivor,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        })),
      };
    });
    const merges = committed.results.map(result => result['merge']).filter(Boolean) as EntityMergeDetail[];
    if (merges.length === 0) throw new LineageRefusal(503, 'LINEAGE_UNAVAILABLE');
    const survivorId = merges[0]!.survivorEntityId;
    const mergedIds = merges.map(merge => merge.mergedEntityId);
    const receipts = await rebuild(request, 'MERGE', committed.transactionId,
      [...new Set(merges.flatMap(merge => merge.affectedFrameInstanceIds))]);
    const { lineage, resolution } = await answer(request, committed,
      [survivorId, ...mergedIds].map(id => ({ objectType: 'entity' as const, id })));
    const body = entityMergeResultSchema.parse({
      transactionId: committed.transactionId, committedAt: committed.committedAt,
      survivorEntityId: survivorId, mergedEntityIds: mergedIds, merges,
      lineage: lineage.entities, projectionRebuildReceipts: receipts, resolution,
    });
    const memoryOperationId = await recordOperation(request, { kind: 'MERGE', target: { objectType: 'entity', objectId: survivorId },
      transactionId: body.transactionId, reason: input.reason, idempotencyKey: bound.idempotencyKey });
    return audited(request, [
      { type: 'belief_transactions', id: body.transactionId, fields: ['commit_receipt'] },
      ...body.lineage.map(record => ({ type: 'entity_lineage', id: record.lineageId, fields: ['lineage_kind'] })),
      ...body.projectionRebuildReceipts.map(receipt => ({ type: 'projection_rebuild_receipts', id: receipt.projectionRebuildReceiptId, fields: ['trigger'] })),
    ], { ...body, memoryOperationId });
  }));

  app.post<{ Params: { id: string } }>('/v1/memory/entities/:id/split', async (request, reply) => guarded(request, reply, async bound => {
    const parsed = entitySplitRequestSchema.safeParse(request.body);
    if (!UUID.test(request.params.id) || !parsed.success) throw new LineageRefusal(400, 'LINEAGE_INPUT_INVALID');
    const input = parsed.data;
    const parentId = request.params.id.toLowerCase();
    const committed = await commitOnce(bound, request, 'SPLIT', async tx => {
      const rows = await lockedRows(tx, 'entities', [parentId]);
      if (rows.length !== 1) throw new LineageRefusal(404, 'ENTITY_NOT_FOUND');
      if (rows[0]!['lifecycle'] !== 'ACTIVE') throw new LineageRefusal(409, 'ENTITY_NOT_ACTIVE');
      return {
        transactionKind: 'SPLIT', sourceEvidenceIds: [],
        operations: [{
          kind: 'SPLIT', targetObjectType: 'entity', target: parentId,
          partitions: input.partitions.map(partition => partition.partitionKey),
          partitionSpecs: input.partitions.filter(partition => partition.canonicalLabel !== undefined)
            .map(partition => ({ partition: partition.partitionKey, canonicalLabel: partition.canonicalLabel! })),
          aliasAssignments: input.aliasAssignments.map(assignment => ({ aliasId: assignment.aliasId, partition: assignment.partitionKey })),
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        }],
      };
    });
    const split = committed.results.map(result => result['split']).find(Boolean) as EntitySplitDetail | undefined;
    if (!split) throw new LineageRefusal(503, 'LINEAGE_UNAVAILABLE');
    const receipts = await rebuild(request, 'SPLIT', committed.transactionId,
      [...new Set(split.rolesOnRetiredParent.map(role => role.frameInstanceId))]);
    const { lineage, resolution } = await answer(request, committed,
      [split.parentEntityId, ...split.newEntities.map(child => child.entityId)].map(id => ({ objectType: 'entity' as const, id })));
    const body = entitySplitResultSchema.parse({
      transactionId: committed.transactionId, committedAt: committed.committedAt,
      split, lineage: lineage.entities, projectionRebuildReceipts: receipts, resolution,
    });
    const memoryOperationId = await recordOperation(request, { kind: 'SPLIT', target: { objectType: 'entity', objectId: parentId },
      transactionId: body.transactionId, reason: input.reason, idempotencyKey: bound.idempotencyKey });
    return audited(request, [
      { type: 'belief_transactions', id: body.transactionId, fields: ['commit_receipt'] },
      ...body.lineage.map(record => ({ type: 'entity_lineage', id: record.lineageId, fields: ['lineage_kind'] })),
      ...body.projectionRebuildReceipts.map(receipt => ({ type: 'projection_rebuild_receipts', id: receipt.projectionRebuildReceiptId, fields: ['trigger'] })),
    ], { ...body, memoryOperationId });
  }));

  /**
   * The read behind the Merge and split review screen: the instance-match
   * decisions the matcher recorded with their outcomes and score components,
   * same-name entities the under-merge default kept apart, and the most recent
   * lineage. It proposes nothing; merging is the owner's decision.
   */
  app.get('/v1/memory/merge-split/review', async request => work(request, async tx => {
    const owner = tx.context.ownerScopeId;
    const frameCandidates = (await tx.query(
      `SELECT id,frame_type_id,candidate_frame_instance_id,resolved_frame_instance_id,match_outcome,score,score_components,
         reused_existing_instance,created_at
       FROM instance_match_candidates WHERE owner_scope_id=$1 AND match_outcome<>'NEW_INSTANCE'
       ORDER BY created_at DESC,id DESC LIMIT 100`, [owner])).rows.map(row => ({
      candidateId: row['id'], frameTypeId: row['frame_type_id'],
      candidateFrameInstanceId: row['candidate_frame_instance_id'] ?? null,
      resolvedFrameInstanceId: row['resolved_frame_instance_id'] ?? null,
      matchOutcome: row['match_outcome'],
      score: row['score'] === null || row['score'] === undefined ? null : Number(row['score']),
      scoreComponents: row['score_components'] ?? {},
      keptSeparate: row['reused_existing_instance'] !== true,
      reusedExistingInstance: row['reused_existing_instance'] === true,
      createdAt: (row['created_at'] as Date).toISOString(),
    }));
    // Names only: two entities sharing a mailbox or a handle would already be one.
    const entityCandidates = (await tx.query(
      `SELECT e.entity_kind,a.normalized_value,array_agg(DISTINCT e.id ORDER BY e.id) AS entity_ids
       FROM entities e JOIN entity_aliases a ON a.owner_scope_id=e.owner_scope_id AND a.entity_id=e.id
       WHERE e.owner_scope_id=$1 AND e.lifecycle='ACTIVE' AND a.alias_type IN ('DISPLAY_NAME','GIVEN_NAME','FULL_NAME','NICKNAME')
       GROUP BY e.entity_kind,a.normalized_value HAVING count(DISTINCT e.id)>1
       ORDER BY a.normalized_value,e.entity_kind LIMIT 100`, [owner])).rows.map(row => ({
      entityKind: row['entity_kind'], sharedAlias: row['normalized_value'],
      entityIds: [...(row['entity_ids'] as string[])], keptSeparate: true as const,
    }));
    const review = mergeSplitReviewSchema.parse({
      frameCandidates, entityCandidates,
      recentLineage: await listRecentLineage(tx, { ownerScopeId: owner, limit: 50 }),
      readAt: new Date().toISOString(),
    });
    await tx.audit({ policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS',
      objects: review.frameCandidates.slice(0, 100).map(candidate => ({ type: 'instance_match_candidates',
        id: candidate.candidateId, fields: ['match_outcome', 'score_components'] })) });
    return review;
  }));
}
