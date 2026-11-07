import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { OwnerTransaction } from '@unai/postgres';
import { PROJECTION_NAMES, dataPurposeSchema, resolutionReceiptSchema, resolutionSubmissionSchema, sensitivitySchema,
  transitionContractSetSchema, type BeliefOperation, type CommitReceipt, type OutcomeCode, type OutcomeProjectionState,
  type ResolutionReceipt, type ResolutionSubmission } from '@unai/domain';
import { BELIEF_PURPOSES, BeliefTransactionError, commitBeliefTransaction, proposeBeliefTransaction,
  type BeliefTransactionRunner, type GovernorRequest } from '@unai/belief';
import { MemoryStoreError, classifyResolutionStatement, frameOutcomeProjection, readResolutionAssertion,
  recordOverlayDelta, validateTransition } from '@unai/memory';
import { PROJECTION_PURPOSE, REDUCER_VERSION, applyProjectionDelta, resolveOwnerEntity } from '@unai/capabilities';
import { ingestOwnerStatement, type EvidenceObjects } from './evidence.js';

/**
 * POST /v1/memory/resolutions (PRD §16.1-§16.4, §18.7, §35.6; FR-032). With a
 * source frame, "Done, I sent it" is stored as evidence (`memory.correct`),
 * committed as a RESOLVE belief transaction, and the frame's typed projection is
 * rebuilt (`memory.project`): projection reads fold, they do not recompute. No
 * overlay delta on that path, as in lineage.ts. Without a source frame the words
 * become an AWAITING_INSTANCE_RESOLUTION owner delta (PRD §14.2, §44.5). Every
 * route-level refusal precedes the first write; purposes other than the
 * request's are chosen here, never by a header.
 */

export const RESOLUTION_WRITE_PURPOSE = BELIEF_PURPOSES.govern;
const EVIDENCE_PURPOSE = 'memory.correct';
const CANONICALIZE_PURPOSE = 'memory.canonicalize';

type Work = (request: FastifyRequest, run: (tx: OwnerTransaction, sessionId: string) => Promise<unknown>,
  purpose?: string) => Promise<unknown>;

export interface ResolutionRouteOptions {
  readonly registryReleaseId?: string | undefined; readonly evidenceObjects?: EvidenceObjects | undefined;
}
class Refusal extends Error { constructor(readonly status: number, code: string) { super(code); } }

const STATUS = new Map<string, number>([
  ['BELIEF_TRANSACTION_REFUSED', 409], ['BELIEF_TRANSACTION_REJECTED', 409],
  ['BELIEF_TRANSACTION_IDEMPOTENCY_KEY_MISMATCH', 409], ['OWNER_SEQUENCE_UNAVAILABLE', 503],
  // evidence.ts refusals, matched by code because its Refusal class is private.
  ['IDEMPOTENCY_CONFLICT', 409], ['EVIDENCE_POLICY_REFUSED', 403],
]);

interface Bound {
  readonly runner: BeliefTransactionRunner; readonly governed: GovernorRequest;
  readonly key: string; readonly releaseId: string; readonly objects: EvidenceObjects;
}
interface Submission { readonly input: ResolutionSubmission; readonly outcomeCode: OutcomeCode; readonly effectiveAt: string }

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

async function enterEvidenceGate(tx: OwnerTransaction, governed: GovernorRequest): Promise<void> {
  await tx.query("SELECT set_config('unai.data_purpose',$1,true),set_config('unai.maximum_sensitivity',$2,true)",
    [governed.dataPurpose, governed.maximumSensitivity]);
}

/** (a) The request's evidence context, key and configuration, and a governor
 * runner that refuses any purpose but the request's own (lineage.ts). */
function bind(request: FastifyRequest, work: Work, options: ResolutionRouteOptions): Bound {
  const dataPurpose = dataPurposeSchema.safeParse(request.headers['x-data-purpose']);
  const ceiling = sensitivitySchema.safeParse(request.headers['x-maximum-sensitivity']);
  if (!dataPurpose.success || !ceiling.success) throw new Refusal(400, 'MEMORY_CONTEXT_REQUIRED');
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string') throw new Refusal(400, 'RESOLUTION_INPUT_INVALID');
  if (!options.registryReleaseId) throw new Refusal(503, 'REGISTRY_RELEASE_NOT_CONFIGURED');
  if (!options.evidenceObjects) throw new Refusal(503, 'STORAGE_UNAVAILABLE');
  const context = request.ownerContext!;
  const governed: GovernorRequest = { ownerScopeId: context.ownerScopeId, actorId: context.actorId,
    correlationId: context.correlationId, dataPurpose: dataPurpose.data, maximumSensitivity: ceiling.data };
  const runner: BeliefTransactionRunner = (purpose, run) => {
    if (purpose !== context.purpose) return Promise.reject(new BeliefTransactionError('MEMORY_PURPOSE_REFUSED'));
    return work(request, async tx => { await enterEvidenceGate(tx, governed); return run(tx); }) as ReturnType<typeof run>;
  };
  return { runner, governed, key, releaseId: options.registryReleaseId, objects: options.evidenceObjects };
}

/** (b)(c) The body, its cross-field rules and the outcome code: the classifier's
 * reading, or the owner's explicit code, never one disagreeing with the other. */
function parseSubmission(body: unknown, now: Date): Submission {
  const parsed = resolutionSubmissionSchema.safeParse(body);
  if (!parsed.success) throw new Refusal(400, 'RESOLUTION_INPUT_INVALID');
  const input = parsed.data;
  const effective = input.effectiveAt === undefined ? now : new Date(input.effectiveAt);
  if ((input.targetFrameInstanceId !== undefined
      && (input.sourceFrameInstanceId === undefined || input.targetFrameInstanceId === input.sourceFrameInstanceId))
    || (input.candidateFrameTypes !== undefined && input.sourceFrameInstanceId !== undefined)
    || effective.getTime() > now.getTime()) throw new Refusal(400, 'RESOLUTION_INPUT_INVALID');
  const reading = classifyResolutionStatement(input.statement);
  if (reading === null && input.outcomeCode === undefined) throw new Refusal(422, 'RESOLUTION_STATEMENT_UNRECOGNIZED');
  if (reading !== null && input.outcomeCode !== undefined && reading.outcomeCode !== input.outcomeCode) {
    throw new Refusal(422, 'RESOLUTION_OUTCOME_DISAGREES_WITH_STATEMENT');
  }
  // The governor's datetimes take the UTC Z form only.
  return { input, outcomeCode: input.outcomeCode ?? reading!.outcomeCode, effectiveAt: effective.toISOString() };
}

/** (d) The transaction this key already proposed, if it is this same outcome. */
async function priorTransaction(request: FastifyRequest, work: Work, key: string, source: string | undefined): Promise<string | null> {
  return await work(request, async tx => {
    const owner = tx.context.ownerScopeId;
    const row = (await tx.query('SELECT id,transaction_kind FROM belief_transactions WHERE owner_scope_id=$1 AND idempotency_key=$2',
      [owner, key])).rows[0];
    if (!row) return null;
    if (source === undefined || row['transaction_kind'] !== 'RESOLVE') throw new Refusal(409, 'IDEMPOTENCY_KEY_REUSED');
    const named = (await tx.query(`SELECT payload->>'sourceFrameInstance' AS source FROM belief_transaction_operations
      WHERE owner_scope_id=$1 AND belief_transaction_id=$2 AND operation_kind='RESOLVE'`, [owner, row['id']])).rows;
    if (named.length !== 1 || named[0]!['source'] !== source) throw new Refusal(409, 'IDEMPOTENCY_KEY_REUSED');
    return row['id'] as string;
  }) as string | null;
}

/** (e) The pinned release's RESOLVES contract for the source frame type, checked
 * here so a refused outcome leaves no evidence and no transaction. The governor
 * checks it again at commit. */
async function checkTransition(request: FastifyRequest, work: Work, bound: Bound, submission: Submission): Promise<string> {
  const source = submission.input.sourceFrameInstanceId!, target = submission.input.targetFrameInstanceId;
  return await work(request, async tx => {
    const frames = new Map((await tx.query('SELECT id,frame_type_id,lifecycle FROM frame_instances WHERE owner_scope_id=$1 AND id=ANY($2::uuid[])',
      [tx.context.ownerScopeId, target === undefined ? [source] : [source, target]])).rows.map(row => [row['id'] as string, row]));
    const frameType = (id: string, end: 'SOURCE' | 'TARGET') => {
      const row = frames.get(id);
      if (!row) throw new Refusal(404, `RESOLUTION_${end}_NOT_FOUND`);
      if (row['lifecycle'] !== 'ACTIVE') throw new Refusal(409, `RESOLUTION_${end}_NOT_ACTIVE`);
      return row['frame_type_id'] as string;
    };
    const sourceFrameTypeId = frameType(source, 'SOURCE');
    const targetFrameTypeId = target === undefined ? null : frameType(target, 'TARGET');
    const contracts = transitionContractSetSchema.parse((await tx.query(
      'SELECT unai_private.registry_release_transition_contracts($1) AS contracts', [bound.releaseId])).rows[0]?.['contracts'] ?? []);
    const matching = contracts.filter(contract => contract.linkKind === 'RESOLVES' && contract.sourceFrameTypes.includes(sourceFrameTypeId));
    if (matching.length !== 1) throw new Refusal(422, 'RESOLUTION_CONTRACT_UNAVAILABLE');
    try {
      validateTransition({ transitionContractId: matching[0]!.id, transitionContracts: contracts, linkKind: 'RESOLVES',
        sourceFrameTypeId, targetFrameTypeId, outcomeCode: submission.outcomeCode });
    } catch (error) {
      if (error instanceof MemoryStoreError) throw new Refusal(422, error.message);
      throw error;
    }
    return matching[0]!.id;
  }) as string;
}

/** (f)(k) The owner's words as evidence, deduplicated by the request key. They are
 * PRIVATE (ADR 0028 §4) unless the request's ceiling is lower. */
async function ingestStatement(tx: OwnerTransaction, bound: Bound, submission: Submission, source: string | null) {
  await enterEvidenceGate(tx, bound.governed);
  return await ingestOwnerStatement(tx, bound.objects, {
    text: submission.input.statement,
    externalId: 'resolution:' + sha256(tx.context.ownerScopeId + ':' + bound.key).slice(0, 32),
    idempotencyKey: sha256('resolution:' + bound.key),
    sensitivity: bound.governed.maximumSensitivity === 'NORMAL' ? 'NORMAL' : 'PRIVATE',
    allowedPurposes: [bound.governed.dataPurpose],
    deterministicMetadata: { record: 'RESOLUTION', outcomeCode: submission.outcomeCode, sourceFrameInstanceId: source },
  });
}

async function deltaOn(tx: OwnerTransaction, evidenceId: string) {
  return (await tx.query(`SELECT id,owner_sequence FROM owner_overlay_deltas WHERE owner_scope_id=$1 AND source_evidence_id=$2
    ORDER BY owner_sequence LIMIT 1`, [tx.context.ownerScopeId, evidenceId])).rows[0];
}

/** (e)-(g) Evidence, the owner entity and the RESOLVE proposal for a new key. */
async function proposeOutcome(request: FastifyRequest, work: Work, bound: Bound, submission: Submission): Promise<{ id: string; created: boolean }> {
  const source = submission.input.sourceFrameInstanceId!, target = submission.input.targetFrameInstanceId;
  const transitionContractId = await checkTransition(request, work, bound, submission);
  const evidence = await work(request, async tx => {
    const stored = await ingestStatement(tx, bound, submission, source);
    // The same key already recorded an unattached statement: another request.
    if (!stored.stored && await deltaOn(tx, stored.evidenceId)) throw new Refusal(409, 'IDEMPOTENCY_KEY_REUSED');
    return stored;
  }, EVIDENCE_PURPOSE) as { evidenceId: string; sourceAnchorId: string };
  // entities INSERT is admitted only under memory.canonicalize (migration 0010).
  const owner = await work(request, tx => resolveOwnerEntity(tx, { ownerScopeId: tx.context.ownerScopeId,
    actorId: tx.context.actorId }), CANONICALIZE_PURPOSE) as string;
  const operations: BeliefOperation[] = [
    // CANDIDATE: a claim with no proposition may hold no other live lifecycle (claims.ts).
    { kind: 'ADD_CLAIM', operationRef: '#outcome', sourceAnchorId: evidence.sourceAnchorId, claimOrigin: 'USER_STATEMENT',
      lifecycle: 'CANDIDATE', assertedByEntityId: owner, validFrom: submission.effectiveAt },
    { kind: 'RESOLVE', sourceFrameInstance: source, ...(target === undefined ? {} : { targetFrameInstance: target }),
      claim: '#outcome', outcomeCode: submission.outcomeCode, transitionContractId, assertedByEntityId: owner,
      effectiveAt: submission.effectiveAt },
  ];
  const proposed = await proposeBeliefTransaction(bound.runner, bound.governed, { transactionKind: 'RESOLVE',
    registryReleaseId: bound.releaseId, risk: 'LOW', sourceEvidenceIds: [evidence.evidenceId], idempotencyKey: bound.key, operations,
  }).catch((error: unknown) => {
    if (error instanceof BeliefTransactionError) throw error;
    return { failure: error };
  });
  if ('transactionId' in proposed && !proposed.alreadyProposed) return { id: proposed.transactionId, created: true };
  // A concurrent first request with this key proposed first (or won the unique
  // index): answer its transaction, and only if it is this same outcome.
  const winner = await priorTransaction(request, work, bound.key, source);
  if (winner === null) throw 'failure' in proposed ? proposed.failure : new Refusal(503, 'RESOLUTION_UNAVAILABLE');
  return { id: winner, created: false };
}

/** (i) Rebuild the source frame's typed projection row, audited under the
 * reducer's own purpose, and read its outcome. */
async function rebuild(request: FastifyRequest, work: Work, source: string): Promise<OutcomeProjectionState> {
  return await work(request, async tx => {
    const ownerScopeId = tx.context.ownerScopeId, asOf = new Date(), written: string[] = [];
    for (const projectionName of PROJECTION_NAMES) {
      const applied = await applyProjectionDelta(tx, { ownerScopeId, projectionName, frameInstanceIds: [source], asOf });
      if (applied.rowsWritten > 0) written.push(projectionName);
    }
    const outcome = await frameOutcomeProjection(tx, { ownerScopeId, frameInstanceId: source, asOf });
    await tx.audit({ policyDecision: 'ALLOW', codeVersion: REDUCER_VERSION, result: 'SUCCESS',
      objects: written.map(type => ({ type, id: source, fields: ['outcome_state', 'projection_version'] })) });
    return outcome.state;
  }, PROJECTION_PURPOSE) as OutcomeProjectionState;
}

/** (j) The committed assertion as stored, so a retry answers the same body. */
async function committedReceipt(request: FastifyRequest, work: Work, receipt: CommitReceipt,
  outcomeState: OutcomeProjectionState): Promise<ResolutionReceipt> {
  const id = receipt.createdObjects.find(object => object.objectType === 'resolution_assertions')?.objectId;
  if (!id) throw new Refusal(503, 'RESOLUTION_UNAVAILABLE');
  return await work(request, async tx => {
    const ownerScopeId = tx.context.ownerScopeId;
    const stored = await readResolutionAssertion(tx, { ownerScopeId, resolutionAssertionId: id });
    const evidenceId = (await tx.query('SELECT source_evidence_ids FROM belief_transactions WHERE owner_scope_id=$1 AND id=$2',
      [ownerScopeId, receipt.transactionId])).rows[0]?.['source_evidence_ids']?.[0] as unknown;
    if (!stored || typeof evidenceId !== 'string') throw new Refusal(503, 'RESOLUTION_UNAVAILABLE');
    await tx.audit({ policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS', objects: [
      { type: 'resolution_assertions', id, fields: ['outcome_code', 'lifecycle', 'claim_id', 'creation_transaction_id'] },
      { type: 'belief_transactions', id: receipt.transactionId, fields: ['status', 'commit_receipt'] },
      { type: 'source_items', id: evidenceId, fields: ['content_hash'] }] });
    return resolutionReceiptSchema.parse({ status: 'COMMITTED', resolutionAssertionId: id, transactionId: receipt.transactionId,
      evidenceId, claimId: stored.claimId, sourceFrameInstanceId: stored.sourceFrameInstanceId,
      targetFrameInstanceId: stored.targetFrameInstanceId, outcomeCode: stored.outcomeCode,
      transitionContractId: stored.transitionContractId, lifecycle: stored.lifecycle, outcomeState });
  }) as ResolutionReceipt;
}

async function governedOutcome(request: FastifyRequest, work: Work, bound: Bound, submission: Submission) {
  const source = submission.input.sourceFrameInstanceId!;
  const prior = await priorTransaction(request, work, bound.key, source);
  const transaction = prior === null ? await proposeOutcome(request, work, bound, submission) : { id: prior, created: false };
  const receipt = await commitBeliefTransaction(bound.runner, bound.governed, { transactionId: transaction.id, idempotencyKey: bound.key });
  const outcomeState = await rebuild(request, work, source);
  return { status: transaction.created ? 201 : 200, body: await committedReceipt(request, work, receipt, outcomeState) };
}

/** (k) A statement naming no item: evidence plus an unattached owner delta. */
async function unattachedOutcome(request: FastifyRequest, work: Work, bound: Bound, submission: Submission) {
  await priorTransaction(request, work, bound.key, undefined);
  return await work(request, async tx => {
    const ownerScopeId = tx.context.ownerScopeId;
    const evidence = await ingestStatement(tx, bound, submission, null);
    const prior = await deltaOn(tx, evidence.evidenceId);
    const delta = prior ? { overlayDeltaId: prior['id'] as string, ownerSequence: Number(prior['owner_sequence']) }
      : await recordOverlayDelta(tx, { ownerScopeId, deltaKind: 'USER_ASSERTION', rawText: submission.input.statement,
        sourceEvidenceId: evidence.evidenceId, lifecycle: 'AWAITING_INSTANCE_RESOLUTION',
        ...(submission.input.candidateFrameTypes === undefined ? {} : { candidateFrameTypes: submission.input.candidateFrameTypes }),
        ...(submission.input.sourceDeviceId === undefined ? {} : { sourceDeviceId: submission.input.sourceDeviceId }) });
    // A retry answers the code the first request stored, whatever this body says.
    const storedCode = (await tx.query(`SELECT deterministic_metadata->>'outcomeCode' AS code FROM source_items
      WHERE owner_scope_id=$1 AND id=$2`, [ownerScopeId, evidence.evidenceId])).rows[0]?.['code'] as unknown;
    await tx.audit({ policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS', objects: [
      { type: 'owner_overlay_deltas', id: delta.overlayDeltaId, fields: ['delta_kind', 'owner_sequence'] },
      { type: 'source_items', id: evidence.evidenceId, fields: ['content_hash'] }] });
    return { status: prior ? 200 : 201, body: resolutionReceiptSchema.parse({ status: 'AWAITING_SOURCE',
      overlayDeltaId: delta.overlayDeltaId, ownerSequence: delta.ownerSequence, evidenceId: evidence.evidenceId,
      outcomeCode: storedCode ?? submission.outcomeCode, lifecycle: 'AWAITING_INSTANCE_RESOLUTION' }) };
  }, EVIDENCE_PURPOSE) as { status: number; body: ResolutionReceipt };
}

function refusalOf(error: unknown): { status: number; code: string } {
  if (error instanceof Refusal) return { status: error.status, code: error.message };
  if (error instanceof BeliefTransactionError) return { status: STATUS.get(error.message) ?? 400, code: error.message };
  if (error instanceof MemoryStoreError) return { status: STATUS.get(error.message) ?? 422, code: error.message };
  if (error instanceof Error && STATUS.has(error.message)) return { status: STATUS.get(error.message)!, code: error.message };
  return { status: 503, code: 'RESOLUTION_UNAVAILABLE' };
}

/** Every refusal is a stable code, audited in its own transaction after the
 * refused work rolled back. No raw error text reaches the body or the audit. */
async function guarded(request: FastifyRequest, reply: FastifyReply, work: Work,
  run: () => Promise<{ status: number; body: ResolutionReceipt }>): Promise<unknown> {
  const correlationId = request.ownerContext!.correlationId;
  try {
    const answered = await run();
    return reply.code(answered.status).send(answered.body);
  } catch (error) {
    if (error instanceof Error && error.message === 'SESSION_EXPIRED') throw error;
    const { status, code } = refusalOf(error);
    await work(request, tx => tx.audit({ policyDecision: status < 500 ? 'DENY' : 'ALLOW', codeVersion: '0.1.0',
      result: status < 500 ? 'REFUSED' : 'FAILURE', objects: [] }));
    const detail = error instanceof BeliefTransactionError && error.detail?.['decision']
      ? { decision: error.detail['decision'], reason: error.detail['reason'] } : {};
    return reply.code(status).send({ code, correlationId, ...detail });
  }
}

export function registerResolutionRoutes(app: FastifyInstance, work: Work, options: ResolutionRouteOptions): void {
  app.post('/v1/memory/resolutions', async (request, reply) => guarded(request, reply, work, async () => {
    const bound = bind(request, work, options);
    const submission = parseSubmission(request.body, new Date());
    return submission.input.sourceFrameInstanceId === undefined
      ? await unattachedOutcome(request, work, bound, submission)
      : await governedOutcome(request, work, bound, submission);
  }));
}
