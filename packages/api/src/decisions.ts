import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { OwnerTransaction } from '@unai/postgres';
import {
  DECISION_FRAME_TYPE, createGoalSchema, dataPurposeSchema, decisionDetailSchema, decisionProjectionViewSchema,
  decisionReviewInputSchema, decisionReviewResultSchema, goalPriorityChangeResultSchema, goalPriorityChangeSchema, goalSchema,
  goalsViewSchema, mentorViewSchema, recordDecisionResultSchema, recordDecisionSchema, sensitivitySchema,
  transitionContractSetSchema,
  type ContextPacket, type DecisionProjectionRow, type DecisionSource, type TransitionContract,
} from '@unai/domain';
import type { PolicyPorts } from '@unai/belief';
import { MemoryStoreError } from '@unai/memory';
import {
  DECISION_PROJECTION_PURPOSE, DecisionError, applyDecisionProjection, canonicalizeDecision, findDecisionForEvidence,
  listDecisionReviews, readDecisionProjection, readDecisionRows, recordDecisionReview, renderDecisionStatement,
  resolveOwnerEntity,
} from '@unai/capabilities';
import { CONTEXT_READ_PURPOSE, ContextBrokerError, MEMORY_INSPECT_PURPOSE, readContextPacket } from '@unai/context';
import { ReviewTimeError, assertTimeZone } from '@unai/review';
import {
  GOALS_MANAGE_PURPOSE, GOALS_READ_PURPOSE, GoalError, MENTOR_PURPOSE, WHY_QUESTION, changeGoalPriority,
  composeContradictions, composeDecisionRationale, createGoal, evaluateMentor, listGoals, observationWindow, readMentorView,
} from '@unai/mentor';
import { ingestOwnerStatement, type EvidenceObjects } from './evidence.js';

/**
 * Goals, decisions, the prediction review and the mentor (design GET/POST
 * /v1/goals, PATCH /v1/goals/{id}/priority, POST /v1/decisions,
 * GET /v1/decisions/{id}, POST /v1/decisions/{id}/review,
 * GET /v1/projections/decisions; ADR 0029 adds GET /v1/mentor/contradictions).
 *
 * Each surface runs under its own purpose; every step that is not the surface's
 * own is opened under the purpose that owns it, chosen here and never from a
 * header: the owner's words are stored as evidence under `memory.correct`, the
 * decision is canonicalized under `memory.canonicalize`, its projection is
 * reduced under `memory.project` and read under `projection.read`, and memory is
 * read through the Context Broker under `memory.read` and inspected for source
 * excerpts under `memory.inspect`.
 */

export const DECISIONS_READ_PURPOSE = 'decisions.read';
export const DECISIONS_RECORD_PURPOSE = 'decisions.record';
export { GOALS_READ_PURPOSE, GOALS_MANAGE_PURPOSE, MENTOR_PURPOSE };
const CORRECTION_PURPOSE = 'memory.correct';
const CANONICALIZE_PURPOSE = 'memory.canonicalize';
const PROJECTION_READ = 'projection.read';

type Work = (request: FastifyRequest, run: (tx: OwnerTransaction, sessionId: string) => Promise<unknown>) => Promise<unknown>;
export type DecisionPurposeWork = <T>(request: FastifyRequest, purpose: string, run: (tx: OwnerTransaction) => Promise<T>) => Promise<T>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const REFUSAL_STATUS = new Map<string, number>([
  ['DECISION_CONTEXT_REQUIRED', 400], ['DECISION_INPUT_INVALID', 400], ['GOAL_INPUT_INVALID', 400], ['TIME_ZONE_INVALID', 400],
  ['GOAL_NOT_FOUND', 404], ['GOAL_RETIRED', 409], ['GOAL_OVERRIDE_WINDOW_INVALID', 400],
  ['DECISION_NOT_FOUND', 404], ['DECISION_GOAL_UNKNOWN', 422], ['DECISION_SOURCE_UNKNOWN', 422],
  ['DECISION_PREDICTION_MISSING', 409], ['DECISION_REVIEW_CODE_REFUSED', 422], ['EVIDENCE_SPAN_INVALID', 400],
  ['TRANSITION_CONTRACT_REQUIRED', 422], ['TRANSITION_CONTRACT_UNKNOWN', 422], ['TRANSITION_LINK_KIND_REFUSED', 422],
  ['TRANSITION_SOURCE_FRAME_TYPE_REFUSED', 422], ['TRANSITION_TARGET_REQUIRED', 422],
  ['TRANSITION_TARGET_FRAME_TYPE_REFUSED', 422], ['RESOLUTION_OUTCOME_REQUIRED', 422], ['TRANSITION_OUTCOME_REFUSED', 422],
  ['CONTEXT_REQUEST_INCOMPLETE', 400], ['CONTEXT_REQUEST_INVALID', 400], ['CONTEXT_READ_DENIED', 403],
  ['STORAGE_UNAVAILABLE', 503], ['DECISION_UNAVAILABLE', 503],
]);

class Refusal extends Error {
  constructor(readonly code: string, readonly detail: Record<string, unknown> = {}) { super(code); }
}

export interface DecisionRouteOptions {
  readonly purposeWork: DecisionPurposeWork;
  readonly evidenceObjects?: EvidenceObjects | undefined;
  readonly registryReleaseId?: string | undefined;
  readonly registryRelease?: string | null;
  readonly policyPorts?: PolicyPorts;
  /** The pinned release's transition contracts. Without them the review reads the
   * newest published release's from the database snapshot (ADR 0029 §6). */
  readonly transitionContracts?: readonly TransitionContract[];
  /** The clock, so a test can pin an instant. */
  readonly now?: () => Date;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const EXCERPT = 280;
const excerptOf = (words: string | null) => words === null ? null : words.length > EXCERPT ? words.slice(0, EXCERPT - 1) + '…' : words;

export function registerDecisionRoutes(app: FastifyInstance, work: Work, options: DecisionRouteOptions): void {
  const now = options.now ?? (() => new Date());
  const as = <T,>(request: FastifyRequest, purpose: string, run: (tx: OwnerTransaction) => Promise<T>) =>
    options.purposeWork(request, purpose, run);

  async function refuse(request: FastifyRequest, reply: FastifyReply, code: string, detail: Record<string, unknown> = {}) {
    // Its own transaction: whatever it refused has already been rolled back.
    await work(request, tx => tx.audit({ policyDecision: 'DENY', codeVersion: '0.1.0', result: 'REFUSED', objects: [] }));
    return reply.code(REFUSAL_STATUS.get(code) ?? 400).send({ code, correlationId: request.ownerContext!.correlationId, ...detail });
  }

  async function guarded(request: FastifyRequest, reply: FastifyReply, run: () => Promise<unknown>): Promise<unknown> {
    try { return await run(); }
    catch (error) {
      if (error instanceof Refusal) return refuse(request, reply, error.code, error.detail);
      if (error instanceof ContextBrokerError) return refuse(request, reply, error.message, error.detail);
      if (error instanceof GoalError || error instanceof DecisionError || error instanceof ReviewTimeError) return refuse(request, reply, error.message);
      if (error instanceof MemoryStoreError && REFUSAL_STATUS.has(error.message)) return refuse(request, reply, error.message);
      if (error instanceof Error && error.message === 'EVIDENCE_SPAN_INVALID') return refuse(request, reply, error.message);
      throw error;
    }
  }

  /** The evidence context a memory read or write is gated on: declared by the
   * request, checked here, re-declared inside every transaction that needs it. */
  function evidenceContext(request: FastifyRequest): { dataPurpose: string; maximumSensitivity: 'NORMAL' | 'PRIVATE' | 'RESTRICTED' } {
    const dataPurpose = dataPurposeSchema.safeParse(request.headers['x-data-purpose']);
    const maximumSensitivity = sensitivitySchema.safeParse(request.headers['x-maximum-sensitivity']);
    if (!dataPurpose.success || !maximumSensitivity.success) throw new Refusal('DECISION_CONTEXT_REQUIRED');
    return { dataPurpose: dataPurpose.data, maximumSensitivity: maximumSensitivity.data };
  }
  const declare = (tx: OwnerTransaction, evidence: ReturnType<typeof evidenceContext>) =>
    tx.query("SELECT set_config('unai.data_purpose',$1,true),set_config('unai.maximum_sensitivity',$2,true)",
      [evidence.dataPurpose, evidence.maximumSensitivity]);

  /** One Context Broker packet, through the broker's own two transactions. */
  function brokerPacket(request: FastifyRequest, evidence: ReturnType<typeof evidenceContext>, body: Record<string, unknown>,
    at: Date): Promise<ContextPacket> {
    const context = request.ownerContext!;
    return readContextPacket(
      <T,>(run: (tx: OwnerTransaction) => Promise<T>) => as(request, CONTEXT_READ_PURPOSE, run),
      {
        ownerScopeId: context.ownerScopeId, requestingActorId: context.actorId, purpose: evidence.dataPurpose,
        maximumSensitivity: evidence.maximumSensitivity, knowledgeTime: 'LATEST', actionRisk: 'LOW',
        requiredCertainty: ['ACCEPTED', 'PROVISIONAL', 'CONTESTED', 'OWNER_OVERLAY'], includeEvidence: 'ALWAYS', ...body,
      },
      {
        ...(options.policyPorts ? { ports: options.policyPorts } : {}), correlationId: context.correlationId, now: at,
        registryReleaseId: options.registryReleaseId ?? null, registryRelease: options.registryRelease ?? null, frameLimit: 500,
      });
  }

  // ---- Goals --------------------------------------------------------------------
  app.get('/v1/goals', async (request, reply) => guarded(request, reply, async () => {
    const at = now();
    const goals = await work(request, async tx => {
      const list = await listGoals(tx, { ownerScopeId: tx.context.ownerScopeId, at, includeFlags: true });
      await tx.audit({ policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS', objects: list.slice(0, 100).map(goal => ({
        type: 'goals', id: goal.goalId, fields: ['title', 'domain', 'current_priority', 'temporary_override'] })) });
      return list;
    });
    return reply.code(200).send(goalsViewSchema.parse({ goals, readAt: at.toISOString() }));
  }));

  app.post('/v1/goals', async (request, reply) => guarded(request, reply, async () => {
    const parsed = createGoalSchema.safeParse(request.body);
    if (!parsed.success) throw new Refusal('GOAL_INPUT_INVALID');
    const goal = await work(request, async tx => {
      const created = await createGoal(tx, { ownerScopeId: tx.context.ownerScopeId, actorId: tx.context.actorId, goal: parsed.data, now: now() });
      await tx.audit({ policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS', objects: [
        { type: 'goals', id: created.goalId, fields: ['title', 'domain', 'current_priority'] },
        ...created.priorityHistory.map(entry => ({ type: 'goal_priority_history', id: entry.goalPriorityHistoryId,
          fields: ['change_kind', 'priority', 'valid_from', 'reason'] })) ] });
      return created;
    });
    return reply.code(201).send(goalSchema.parse(goal));
  }));

  app.patch<{ Params: { id: string } }>('/v1/goals/:id/priority', async (request, reply) => guarded(request, reply, async () => {
    if (!UUID.test(request.params.id)) throw new Refusal('GOAL_INPUT_INVALID');
    const parsed = goalPriorityChangeSchema.safeParse(request.body);
    if (!parsed.success) throw new Refusal('GOAL_INPUT_INVALID');
    const result = await work(request, async tx => {
      const changed = await changeGoalPriority(tx, { ownerScopeId: tx.context.ownerScopeId, actorId: tx.context.actorId,
        goalId: request.params.id, change: parsed.data, now: now() });
      await tx.audit({ policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS', objects: [
        { type: 'goals', id: changed.goal.goalId, fields: ['current_priority', 'temporary_override'] },
        { type: 'goal_priority_history', id: changed.appended.goalPriorityHistoryId, fields: ['change_kind', 'priority', 'valid_from', 'reason'] }] });
      return changed;
    });
    return reply.code(200).send(goalPriorityChangeResultSchema.parse(result));
  }));

  // ---- Decisions ------------------------------------------------------------------

  /** "Why did I make this decision?", answered from one broker packet, with the
   * anchored words each statement came from and the sources cited for it. */
  async function rationaleFor(request: FastifyRequest, evidence: ReturnType<typeof evidenceContext>, decision: DecisionProjectionRow,
    question: string, at: Date) {
    const context = request.ownerContext!;
    const packet = await brokerPacket(request, evidence, {
      query: question, worldTime: 'NOW', answerType: 'DECISION_RECONSTRUCTION', frameTypeHints: [DECISION_FRAME_TYPE],
    }, at);
    const propositionIds = [...packet.currentBeliefs, ...packet.futureClaims]
      .filter(item => item.frameInstanceId === decision.decisionFrameInstanceId).map(item => item.propositionId);
    const byProposition = await as(request, MEMORY_INSPECT_PURPOSE, async tx => {
      await declare(tx, evidence);
      const map = new Map<string, DecisionSource[]>();
      if (propositionIds.length === 0) return map;
      const stated = (await tx.query(
        `SELECT c.proposition_id,a.source_item_id,a.normalized_text,s.source_type,s.occurred_at FROM claims c
         JOIN source_anchors a ON a.owner_scope_id=c.owner_scope_id AND a.id=c.source_anchor_id
         JOIN source_items s ON s.owner_scope_id=a.owner_scope_id AND s.id=a.source_item_id
         WHERE c.owner_scope_id=$1 AND c.proposition_id=ANY($2::uuid[]) ORDER BY c.recorded_at,c.id`,
        [context.ownerScopeId, propositionIds])).rows;
      const cited = (await tx.query(
        `SELECT l.from_object_id,s.id AS source_item_id,s.source_type,s.occurred_at,
           (SELECT a.normalized_text FROM source_anchors a WHERE a.owner_scope_id=s.owner_scope_id AND a.source_item_id=s.id
              AND a.normalized_text IS NOT NULL ORDER BY a.id LIMIT 1) AS normalized_text
         FROM memory_links l JOIN source_items s ON s.owner_scope_id=l.owner_scope_id AND s.id=l.to_object_id
         WHERE l.owner_scope_id=$1 AND l.link_kind='REFERENCES' AND l.from_object_type='proposition'
           AND l.from_object_id=ANY($2::uuid[]) AND l.to_object_type='source_item' AND l.lifecycle<>'RETRACTED'
         ORDER BY l.created_at,l.id`, [context.ownerScopeId, propositionIds])).rows;
      const add = (propositionId: string, source: DecisionSource) => {
        const list = map.get(propositionId) ?? [];
        if (!list.some(entry => entry.evidenceId === source.evidenceId && entry.relation === source.relation)) list.push(source);
        map.set(propositionId, list);
      };
      const occurred = (value: unknown) => value instanceof Date ? value.toISOString() : null;
      for (const row of stated) add(row['proposition_id'] as string, { evidenceId: row['source_item_id'] as string, relation: 'STATED_IN',
        sourceType: row['source_type'] as string, occurredAt: occurred(row['occurred_at']), excerpt: excerptOf((row['normalized_text'] as string | null) ?? null) });
      for (const row of cited) add(row['from_object_id'] as string, { evidenceId: row['source_item_id'] as string, relation: 'CITED',
        sourceType: row['source_type'] as string, occurredAt: occurred(row['occurred_at']), excerpt: excerptOf((row['normalized_text'] as string | null) ?? null) });
      return map;
    });
    return composeDecisionRationale(packet, { decisionFrameInstanceId: decision.decisionFrameInstanceId, question, sources: { byProposition } });
  }

  const projectDecision = (request: FastifyRequest, frameInstanceId: string, at: Date) =>
    as(request, DECISION_PROJECTION_PURPOSE, async tx => {
      await applyDecisionProjection(tx, { ownerScopeId: tx.context.ownerScopeId, asOf: at, frameInstanceIds: [frameInstanceId] });
    });
  const readDecisionRow = (request: FastifyRequest, frameInstanceId: string, at: Date) =>
    as(request, PROJECTION_READ, async tx => {
      const view = await readDecisionProjection(tx, { ownerScopeId: tx.context.ownerScopeId, asOf: at });
      const row = view.rows.find(candidate => candidate.decisionFrameInstanceId === frameInstanceId);
      if (!row) throw new Refusal('DECISION_NOT_FOUND');
      return row;
    });

  app.post('/v1/decisions', async (request, reply) => guarded(request, reply, async () => {
    const parsed = recordDecisionSchema.safeParse(request.body);
    if (!parsed.success) throw new Refusal('DECISION_INPUT_INVALID');
    const evidence = evidenceContext(request);
    if (!options.evidenceObjects) throw new Refusal('STORAGE_UNAVAILABLE');
    const objects = options.evidenceObjects;
    const context = request.ownerContext!;
    const at = now();
    const key = String(request.headers['idempotency-key']);
    if (parsed.data.goalId) {
      const goalId = parsed.data.goalId;
      const known = await work(request, async tx => (await tx.query('SELECT id FROM goals WHERE owner_scope_id=$1 AND id=$2',
        [tx.context.ownerScopeId, goalId])).rows.length === 1);
      if (!known) throw new Refusal('DECISION_GOAL_UNKNOWN');
    }
    const statement = renderDecisionStatement(parsed.data);
    const stored = await as(request, CORRECTION_PURPOSE, async tx => {
      await declare(tx, evidence);
      return ingestOwnerStatement(tx, objects, {
        text: statement.text,
        externalId: 'decision:' + sha256(context.ownerScopeId + ':' + key).slice(0, 32),
        idempotencyKey: sha256('decision:' + key),
        sensitivity: evidence.maximumSensitivity, allowedPurposes: [evidence.dataPurpose],
        deterministicMetadata: { record: 'DECISION', frameTypeId: DECISION_FRAME_TYPE },
        spans: statement.spans.map(span => ({ start: span.start, end: span.end })),
      });
    });
    const anchors = new Map(statement.spans.map((span, index) => [span.key, stored.spanAnchorIds[index]!]));
    const frameInstanceId = await as(request, CANONICALIZE_PURPOSE, async tx => {
      await declare(tx, evidence);
      // A retry under the same key answers the decision its evidence already holds.
      const existing = stored.stored ? null : await findDecisionForEvidence(tx, { ownerScopeId: context.ownerScopeId, evidenceId: stored.evidenceId });
      if (existing) return existing;
      const base = (await tx.query(`SELECT id FROM context_spaces WHERE owner_scope_id=$1 AND context_kind='BASE' AND lifecycle='ACTIVE'`,
        [context.ownerScopeId])).rows[0];
      if (!base) throw new Refusal('DECISION_UNAVAILABLE');
      const decider = await resolveOwnerEntity(tx, { ownerScopeId: context.ownerScopeId, actorId: context.actorId });
      return (await canonicalizeDecision(tx, {
        ownerScopeId: context.ownerScopeId, contextSpaceId: base['id'] as string, decision: parsed.data, deciderEntityId: decider,
        anchorFor: field => anchors.get(field) ?? stored.sourceAnchorId, statedAt: at, registryReleaseId: options.registryReleaseId ?? null,
      })).decisionFrameInstanceId;
    });
    await projectDecision(request, frameInstanceId, at);
    const decision = await readDecisionRow(request, frameInstanceId, at);
    const rationale = await rationaleFor(request, evidence, decision, WHY_QUESTION, at);
    await work(request, tx => tx.audit({ policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS', objects: [
      { type: 'frame_instances', id: frameInstanceId, fields: ['frame_type_id'] },
      { type: 'source_items', id: stored.evidenceId, fields: ['content_hash', 'raw_object_ref'] },
      { type: 'decision_projection', id: frameInstanceId, fields: ['question', 'user_choice', 'expected_result', 'review_date'] },
      { type: 'context_packets', id: rationale.contextPacketId, fields: ['packet', 'packet_hash'] }] }));
    return reply.code(201).send(recordDecisionResultSchema.parse({ decision, evidenceId: stored.evidenceId, rationale }));
  }));

  app.get<{ Params: { id: string }; Querystring: { question?: string } }>('/v1/decisions/:id', async (request, reply) => guarded(request, reply, async () => {
    if (!UUID.test(request.params.id)) throw new Refusal('DECISION_INPUT_INVALID');
    const question = typeof request.query.question === 'string' && request.query.question.trim() !== ''
      ? request.query.question.trim().slice(0, 500) : WHY_QUESTION;
    const evidence = evidenceContext(request);
    const at = now();
    const decision = await readDecisionRow(request, request.params.id, at);
    const rationale = await rationaleFor(request, evidence, decision, question, at);
    const reviews = await as(request, MEMORY_INSPECT_PURPOSE, async tx => {
      await declare(tx, evidence);
      return listDecisionReviews(tx, { ownerScopeId: tx.context.ownerScopeId, decisionFrameInstanceId: decision.decisionFrameInstanceId });
    });
    await work(request, tx => tx.audit({ policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS', objects: [
      { type: 'decision_projection', id: decision.decisionFrameInstanceId, fields: ['question', 'assumptions', 'rationale', 'actual_outcome'] },
      { type: 'context_packets', id: rationale.contextPacketId, fields: ['packet', 'packet_hash'] },
      ...reviews.map(review => ({ type: 'resolution_assertions', id: review.resolutionAssertionId, fields: ['outcome_code', 'lifecycle'] }))].slice(0, 100) }));
    return reply.code(200).send(decisionDetailSchema.parse({ decision, rationale, reviews, readAt: at.toISOString() }));
  }));

  /** The pinned release's transition contracts: the deployment's own, or the
   * newest published release's from the database snapshot. */
  async function transitionContracts(request: FastifyRequest): Promise<readonly TransitionContract[]> {
    if (options.transitionContracts) return options.transitionContracts;
    return work(request, async tx => {
      const snapshot = (await tx.query('SELECT unai_private.registry_transition_contracts() AS snapshot')).rows[0]?.['snapshot'] as
        { contracts?: unknown } | null | undefined;
      return transitionContractSetSchema.parse(snapshot?.contracts ?? []);
    }) as Promise<readonly TransitionContract[]>;
  }

  app.post<{ Params: { id: string } }>('/v1/decisions/:id/review', async (request, reply) => guarded(request, reply, async () => {
    if (!UUID.test(request.params.id)) throw new Refusal('DECISION_INPUT_INVALID');
    const parsed = decisionReviewInputSchema.safeParse(request.body);
    if (!parsed.success) throw new Refusal('DECISION_INPUT_INVALID');
    const evidence = evidenceContext(request);
    if (!options.evidenceObjects) throw new Refusal('STORAGE_UNAVAILABLE');
    const objects = options.evidenceObjects;
    const context = request.ownerContext!;
    const at = now();
    const key = String(request.headers['idempotency-key']);
    const current = (await work(request, tx => readDecisionRows(tx, { ownerScopeId: tx.context.ownerScopeId })) as DecisionProjectionRow[])
      .find(row => row.decisionFrameInstanceId === request.params.id);
    if (!current) throw new Refusal('DECISION_NOT_FOUND');
    if (current.expectedResult === null) throw new Refusal('DECISION_PREDICTION_MISSING');
    const contracts = await transitionContracts(request);
    const review = parsed.data;
    const effectiveAt = review.effectiveAt ? new Date(review.effectiveAt) : at;

    // The review statement, one span for what happened and one for the verdict.
    const observed = review.actualOutcome ?? 'as recorded in the cited source';
    const prefix = 'Review of "' + (current.question ?? 'the decision') + '": what happened: ';
    const middle = '. Against the prediction "' + current.expectedResult + '" the outcome is: ';
    const text = prefix + observed + middle + review.outcomeCode + '.';
    const spans = [{ start: prefix.length, end: prefix.length + observed.length },
      { start: prefix.length + observed.length + middle.length, end: prefix.length + observed.length + middle.length + review.outcomeCode.length }];
    const stored = await as(request, CORRECTION_PURPOSE, async tx => {
      await declare(tx, evidence);
      return ingestOwnerStatement(tx, objects, {
        text, externalId: 'decision-review:' + sha256(context.ownerScopeId + ':' + key).slice(0, 32),
        idempotencyKey: sha256('decision-review:' + key), sensitivity: evidence.maximumSensitivity, allowedPurposes: [evidence.dataPurpose],
        deterministicMetadata: { record: 'DECISION_REVIEW', decisionFrameInstanceId: current.decisionFrameInstanceId }, spans,
      });
    });
    const comparison = await as(request, CANONICALIZE_PURPOSE, async tx => {
      await declare(tx, evidence);
      if (!stored.stored) {
        // A retry: the review this evidence already holds, unchanged.
        const recorded = (await tx.query(
          `SELECT r.id FROM resolution_assertions r
           JOIN claims c ON c.owner_scope_id=r.owner_scope_id AND c.id=r.claim_id
           JOIN source_anchors a ON a.owner_scope_id=c.owner_scope_id AND a.id=c.source_anchor_id
           WHERE r.owner_scope_id=$1 AND a.source_item_id=$2 LIMIT 1`, [context.ownerScopeId, stored.evidenceId])).rows[0];
        if (recorded) {
          const existing = (await listDecisionReviews(tx, { ownerScopeId: context.ownerScopeId, decisionFrameInstanceId: current.decisionFrameInstanceId }))
            .find(entry => entry.resolutionAssertionId === recorded['id']);
          if (existing) return existing;
        }
      }
      const base = (await tx.query(`SELECT id FROM context_spaces WHERE owner_scope_id=$1 AND context_kind='BASE' AND lifecycle='ACTIVE'`,
        [context.ownerScopeId])).rows[0];
      if (!base) throw new Refusal('DECISION_UNAVAILABLE');
      const reviewer = await resolveOwnerEntity(tx, { ownerScopeId: context.ownerScopeId, actorId: context.actorId });
      return recordDecisionReview(tx, {
        ownerScopeId: context.ownerScopeId, contextSpaceId: base['id'] as string, decisionFrameInstanceId: current.decisionFrameInstanceId,
        reviewerEntityId: reviewer, actualOutcome: review.actualOutcome ?? null, actualOutcomeEvidenceId: review.actualOutcomeEvidenceRef ?? null,
        outcomeCode: review.outcomeCode, transitionContractId: review.transitionContractId, transitionContracts: contracts, effectiveAt,
        observedAnchorId: stored.spanAnchorIds[0]!, verdictAnchorId: stored.spanAnchorIds[1]!, registryReleaseId: options.registryReleaseId ?? null,
      });
    });
    await projectDecision(request, current.decisionFrameInstanceId, at);
    const decision = await readDecisionRow(request, current.decisionFrameInstanceId, at);
    await work(request, tx => tx.audit({ policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS', objects: [
      { type: 'resolution_assertions', id: comparison.resolutionAssertionId, fields: ['outcome_code', 'source_proposition_id', 'transition_contract_id'] },
      { type: 'source_items', id: stored.evidenceId, fields: ['content_hash', 'raw_object_ref'] },
      { type: 'decision_projection', id: current.decisionFrameInstanceId, fields: ['actual_outcome', 'review_outcome_code'] }] }));
    return reply.code(201).send(decisionReviewResultSchema.parse({ comparison, decision, evidenceId: stored.evidenceId }));
  }));

  app.get('/v1/projections/decisions', async (request, reply) => guarded(request, reply, async () => {
    const at = now();
    const view = await work(request, async tx => {
      const read = decisionProjectionViewSchema.parse(await readDecisionProjection(tx, { ownerScopeId: tx.context.ownerScopeId, asOf: at }));
      await tx.audit({ policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS', objects: read.rows.slice(0, 100).map(row => ({
        type: 'decision_projection', id: row.decisionFrameInstanceId,
        fields: ['question', 'user_choice', 'review_date', 'is_complete', 'owner_overlay_watermark', 'projection_version'] })) });
      return read;
    });
    return reply.code(200).send(view);
  }));

  // ---- The mentor ------------------------------------------------------------------
  app.get<{ Querystring: { timeZone?: string } }>('/v1/mentor/contradictions', async (request, reply) => guarded(request, reply, async () => {
    const timeZone = assertTimeZone(request.query.timeZone ?? 'UTC');
    const evidence = evidenceContext(request);
    const at = now();
    const goals = await work(request, tx => listGoals(tx, { ownerScopeId: tx.context.ownerScopeId, at })) as Awaited<ReturnType<typeof listGoals>>;
    const window = observationWindow(at);
    const packet = await brokerPacket(request, evidence, {
      query: 'Mentor: stated goals against the time the calendar shows', worldTime: 'NOW', answerType: 'PATTERN_REVIEW',
      frameTypeHints: ['shared.event_occurrence'],
    }, at);
    const composed = composeContradictions(packet, { goals, window });
    const view = await work(request, async tx => {
      const evaluation = await evaluateMentor(tx, { ownerScopeId: tx.context.ownerScopeId, now: at, timeZone,
        contextPacketId: packet.packetId, packetHash: packet.packetHash, drafts: composed.drafts });
      const read = await readMentorView(tx, { ownerScopeId: tx.context.ownerScopeId, now: at, timeZone, goals,
        contextPacketId: packet.packetId, respectedOverrides: composed.respectedOverrides });
      await tx.audit({ policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS', objects: [
        { type: 'context_packets', id: packet.packetId, fields: ['packet', 'packet_hash'] },
        ...evaluation.recorded.map(card => ({ type: 'mentor_cards', id: card.mentorCardId, fields: ['decision', 'reason', 'policy_inputs'] })),
      ].slice(0, 100) });
      return read;
    });
    return reply.code(200).send(mentorViewSchema.parse(view));
  }));
}
