import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { OwnerTransaction } from '@unai/postgres';
import {
  attentionBudgetPatchSchema, cardAnswerSchema, cardDecisionInputSchema, cardDecisionResultSchema, dataPurposeSchema,
  learnedApprovalRulesViewSchema, sensitivitySchema, weeklyReviewRequestSchema,
  type BeliefOperation, type CardAnswer, type CardChoice, type ClarificationCard, type ContextPacket, type LearnedApprovalRule,
} from '@unai/domain';
import { BELIEF_PURPOSES, BeliefTransactionError, proposeBeliefTransaction,
  type BeliefTransactionRunner, type PolicyPorts } from '@unai/belief';
import { MemoryStoreError, recordClaim, recordMemoryOperation, recordOverlayDelta } from '@unai/memory';
import { CONTEXT_READ_PURPOSE, ContextBrokerError, readContextPacket, readPersistedPacket } from '@unai/context';
import {
  APPROVAL_RULES_PURPOSE, ATTENTION_SETTINGS_PURPOSE, INBOX_PURPOSE, WEEKLY_REVIEW_PURPOSE,
  InboxError, LearnedRuleError, ReviewTimeError, WeeklyReviewError,
  addLocalDays, approveLearnedRule, askingDecision, assertTimeZone, collectAmbiguities, composeCards, composeWeeklyReview,
  evaluateInbox, listLearnedRules, proposeRuleIfRepeated, readAttentionBudget, readCard, readInbox, readSituations,
  recordCardAnswer, recordWeeklyReview, reviewManifestOf, revokeLearnedRule, startOfLocalDate, updateAttentionBudget,
  type RuleBasis,
} from '@unai/review';
import { ingestOwnerStatement, type EvidenceObjects } from './evidence.js';

/**
 * Proactive clarification and the weekly review (design GET /v1/memory/inbox,
 * POST /v1/memory/inbox/cards/{id}/decide, PATCH /v1/settings/attention-budgets,
 * GET /v1/approval-rules and its approve and revoke, GET /v1/weekly-review;
 * PRD §19.3-§19.5, §37.4, §39; ADR 0029).
 *
 * Each surface runs under its own purpose, and every step that is not the
 * surface's own is opened under the purpose that owns it, chosen here and never
 * from a header: memory is read through the Context Broker under `memory.read`,
 * and an answer to a card writes memory through the correction path under
 * `memory.correct` -- one new evidence row, an overlay delta and a memory
 * operation per target, and a *proposed* belief transaction.
 */

export { INBOX_PURPOSE, APPROVAL_RULES_PURPOSE, ATTENTION_SETTINGS_PURPOSE, WEEKLY_REVIEW_PURPOSE };
const CORRECTION_PURPOSE = 'memory.correct';

type Work = (request: FastifyRequest, run: (tx: OwnerTransaction, sessionId: string) => Promise<unknown>) => Promise<unknown>;
export type ReviewPurposeWork = <T>(request: FastifyRequest, purpose: string, run: (tx: OwnerTransaction) => Promise<T>) => Promise<T>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FRAME_TYPES = ['shared.commitment', 'shared.event_occurrence', 'shared.obligation', 'finance.payment_allocation'];

const REFUSAL_STATUS = new Map<string, number>([
  ['REVIEW_CONTEXT_REQUIRED', 400], ['REVIEW_INPUT_INVALID', 400], ['TIME_ZONE_INVALID', 400], ['LOCAL_DATE_INVALID', 400],
  ['CLARIFICATION_CARD_NOT_FOUND', 404], ['CLARIFICATION_CHOICE_UNKNOWN', 400], ['CLARIFICATION_CARD_ALREADY_ANSWERED', 409],
  ['LEARNED_RULE_NOT_FOUND', 404], ['LEARNED_RULE_NOT_PROPOSED', 409],
  ['CONTEXT_REQUEST_INCOMPLETE', 400], ['CONTEXT_REQUEST_INVALID', 400], ['CONTEXT_READ_DENIED', 403],
  ['STORAGE_UNAVAILABLE', 503], ['WEEKLY_REVIEW_UNGROUNDED', 503], ['INBOX_ANSWER_UNAVAILABLE', 503],
]);

class Refusal extends Error {
  constructor(readonly code: string, readonly detail: Record<string, unknown> = {}) { super(code); }
}

export interface ReviewRouteOptions {
  readonly purposeWork: ReviewPurposeWork;
  readonly evidenceObjects?: EvidenceObjects | undefined;
  readonly registryReleaseId?: string | undefined;
  readonly registryRelease?: string | null;
  readonly policyPorts?: PolicyPorts;
  /** The clock, so a test can put the inbox on another owner-local day. */
  readonly now?: () => Date;
}

const EFFECTS = Object.freeze({
  CONFIRM: { deltaKind: 'USER_CONFIRMATION', operationKind: 'CONFIRM', transactionKind: 'CONFIRM' },
  REJECT: { deltaKind: 'USER_REJECTION', operationKind: 'REJECT', transactionKind: 'REJECT' },
  KEEP_UNCERTAIN: { deltaKind: 'KEEP_UNCERTAIN', operationKind: 'KEEP_UNCERTAIN', transactionKind: null },
} as const);

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

export function registerReviewRoutes(app: FastifyInstance, work: Work, options: ReviewRouteOptions): void {
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
      if (error instanceof InboxError || error instanceof LearnedRuleError || error instanceof ReviewTimeError) {
        return refuse(request, reply, error.message);
      }
      if (error instanceof WeeklyReviewError) return refuse(request, reply, error.message, error.detail);
      if (error instanceof BeliefTransactionError || error instanceof MemoryStoreError) return refuse(request, reply, 'INBOX_ANSWER_UNAVAILABLE');
      throw error;
    }
  }

  /** The evidence context a memory read or write is gated on: declared by the
   * request, checked here, re-declared inside every transaction that needs it. */
  function evidenceContext(request: FastifyRequest): { dataPurpose: string; maximumSensitivity: 'NORMAL' | 'PRIVATE' | 'RESTRICTED' } {
    const dataPurpose = dataPurposeSchema.safeParse(request.headers['x-data-purpose']);
    const maximumSensitivity = sensitivitySchema.safeParse(request.headers['x-maximum-sensitivity']);
    if (!dataPurpose.success || !maximumSensitivity.success) throw new Refusal('REVIEW_CONTEXT_REQUIRED');
    return { dataPurpose: dataPurpose.data, maximumSensitivity: maximumSensitivity.data };
  }
  const declare = (tx: OwnerTransaction, evidence: ReturnType<typeof evidenceContext>) =>
    tx.query("SELECT set_config('unai.data_purpose',$1,true),set_config('unai.maximum_sensitivity',$2,true)",
      [evidence.dataPurpose, evidence.maximumSensitivity]);

  /** One Context Broker packet, through the broker's own two transactions. */
  async function brokerPacket(request: FastifyRequest, evidence: ReturnType<typeof evidenceContext>, body: Record<string, unknown>,
    at: Date): Promise<ContextPacket> {
    const context = request.ownerContext!;
    return readContextPacket(
      <T,>(run: (tx: OwnerTransaction) => Promise<T>) => as(request, CONTEXT_READ_PURPOSE, run),
      {
        ownerScopeId: context.ownerScopeId, requestingActorId: context.actorId, purpose: evidence.dataPurpose,
        maximumSensitivity: evidence.maximumSensitivity, knowledgeTime: 'LATEST', actionRisk: 'LOW',
        requiredCertainty: ['ACCEPTED', 'PROVISIONAL', 'CONTESTED', 'OWNER_OVERLAY'], includeEvidence: 'WHEN_NEEDED', ...body,
      },
      {
        ...(options.policyPorts ? { ports: options.policyPorts } : {}), correlationId: context.correlationId, now: at,
        registryReleaseId: options.registryReleaseId ?? null, registryRelease: options.registryRelease ?? null, frameLimit: 500,
      });
  }

  /**
   * Answer one card through the correction path (ADR 0029 §6). One evidence row
   * holds the owner's answer; every target gets an overlay delta and a memory
   * operation of the choice's kind; a confirmation records its own
   * USER_CONFIRMATION claim; and one belief transaction is proposed, never
   * committed. Keep uncertain proposes nothing.
   */
  async function applyAnswer(request: FastifyRequest, input: {
    card: ClarificationCard; choice: CardChoice; rawText: string; key: string;
    answeredBy: 'OWNER' | 'LEARNED_RULE'; ruleId: string | null;
  }): Promise<CardAnswer> {
    if (!options.evidenceObjects) throw new Refusal('STORAGE_UNAVAILABLE');
    const objects = options.evidenceObjects;
    const evidence = evidenceContext(request);
    const context = request.ownerContext!;
    const shape = EFFECTS[input.choice.effect];
    const written = await as(request, CORRECTION_PURPOSE, async tx => {
      await declare(tx, evidence);
      const statement = await ingestOwnerStatement(tx, objects, {
        text: input.rawText,
        externalId: 'inbox:' + sha256(context.ownerScopeId + ':' + input.key).slice(0, 32),
        idempotencyKey: sha256('inbox:' + input.key),
        sensitivity: evidence.maximumSensitivity, allowedPurposes: [evidence.dataPurpose],
        deterministicMetadata: { clarificationCardId: input.card.clarificationCardId, choiceId: input.choice.choiceId,
          answeredBy: input.answeredBy },
      });
      const deltas: Array<{ target: CardChoice['targets'][number]; overlayDeltaId: string; claimId: string | null }> = [];
      for (const target of input.choice.targets) {
        const delta = await recordOverlayDelta(tx, {
          ownerScopeId: context.ownerScopeId, deltaKind: shape.deltaKind, rawText: input.rawText,
          sourceEvidenceId: statement.evidenceId, lifecycle: 'USER_ASSERTED', target,
        });
        const claimId = input.choice.effect === 'CONFIRM' ? await recordClaim(tx, {
          ownerScopeId: context.ownerScopeId, sourceAnchorId: statement.sourceAnchorId, propositionId: target.objectId,
          claimOrigin: 'USER_CONFIRMATION', lifecycle: 'PROVISIONAL',
        }) : null;
        deltas.push({ target, overlayDeltaId: delta.overlayDeltaId, claimId });
      }
      return { evidenceId: statement.evidenceId, deltas };
    });

    let proposedTransactionId: string | null = null;
    if (shape.transactionKind && options.registryReleaseId && written.deltas.length > 0) {
      const runner: BeliefTransactionRunner = (purpose, run) => purpose !== BELIEF_PURPOSES.govern
        ? Promise.reject(new BeliefTransactionError('MEMORY_PURPOSE_REFUSED'))
        : as(request, CORRECTION_PURPOSE, async tx => { await declare(tx, evidence); return run(tx); });
      const operations: BeliefOperation[] = written.deltas.map(entry => input.choice.effect === 'CONFIRM'
        ? { kind: 'ADD_SUPPORT', proposition: entry.target.objectId, claim: entry.claimId!, supportKind: 'DIRECT_ASSERTION' }
        : { kind: 'SET_BELIEF_ASSESSMENT', proposition: entry.target.objectId, assessmentStatus: 'REJECTED',
          decisionReason: { code: 'USER_REJECTED_INTERPRETATION' } }) as BeliefOperation[];
      const proposed = await proposeBeliefTransaction(runner, {
        ownerScopeId: context.ownerScopeId, actorId: context.actorId, correlationId: context.correlationId,
        dataPurpose: evidence.dataPurpose, maximumSensitivity: evidence.maximumSensitivity,
      }, {
        transactionKind: shape.transactionKind, registryReleaseId: options.registryReleaseId, risk: 'LOW',
        sourceEvidenceIds: [written.evidenceId], operations,
        idempotencyKey: sha256('propose:inbox:' + input.key).slice(0, 64),
      });
      proposedTransactionId = proposed.transactionId;
    }

    const memoryOperationIds = await as(request, CORRECTION_PURPOSE, async tx => {
      const ids: string[] = [];
      for (const entry of written.deltas) {
        ids.push(await recordMemoryOperation(tx, {
          ownerScopeId: context.ownerScopeId, operationKind: shape.operationKind, target: entry.target,
          evidenceId: written.evidenceId, requestedByActorId: context.actorId, overlayDeltaId: entry.overlayDeltaId,
          transactionId: proposedTransactionId,
          detail: { clarificationCardId: input.card.clarificationCardId, choiceId: input.choice.choiceId, answeredBy: input.answeredBy,
            ...(input.ruleId ? { learnedApprovalRuleId: input.ruleId } : {}) },
        }));
      }
      await tx.audit({ policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS', objects: [
        ...ids.map(id => ({ type: 'memory_operations', id, fields: ['operation_kind', 'target_object_id'] })),
        ...written.deltas.map(entry => ({ type: 'owner_overlay_deltas', id: entry.overlayDeltaId, fields: ['delta_kind', 'owner_sequence'] })),
      ].slice(0, 100) });
      return ids;
    });
    return cardAnswerSchema.parse({
      choiceId: input.choice.choiceId, effect: input.choice.effect, answeredBy: input.answeredBy, learnedApprovalRuleId: input.ruleId,
      evidenceId: written.evidenceId, overlayDeltaIds: written.deltas.map(entry => entry.overlayDeltaId), memoryOperationIds,
      proposedTransactionId,
    });
  }

  // ---- GET /v1/memory/inbox -----------------------------------------------------
  app.get<{ Querystring: { timeZone?: string } }>('/v1/memory/inbox', async (request, reply) => guarded(request, reply, async () => {
    const context = request.ownerContext!;
    const timeZone = assertTimeZone(request.query.timeZone ?? 'UTC');
    const evidence = evidenceContext(request);
    const at = now();
    const packet = await brokerPacket(request, evidence, {
      query: 'Memory inbox: material ambiguities awaiting review', worldTime: 'NOW', answerType: 'CURRENT_VALUE',
    }, at);
    const frames = [...new Set([...packet.currentBeliefs, ...packet.historicalBeliefs, ...packet.futureClaims]
      .map(item => item.frameInstanceId))];
    const situations = await as(request, CONTEXT_READ_PURPOSE, tx => readSituations(tx, { ownerScopeId: context.ownerScopeId, frameInstanceIds: frames }));
    const evaluation = await as(request, INBOX_PURPOSE, async tx => {
      const budget = await readAttentionBudget(tx, { ownerScopeId: context.ownerScopeId });
      const drafts = composeCards(packet, { ambiguities: collectAmbiguities(packet), situations, now: at,
        suppressionDays: budget.repeatQuestionSuppressionDays });
      return evaluateInbox(tx, { ownerScopeId: context.ownerScopeId, now: at, timeZone, contextPacketId: packet.packetId, drafts });
    });
    // An approved learned rule answers its card instead of the owner. The write is
    // the same correction path an owner answer takes, with the rule named on it.
    for (const application of evaluation.ruleApplications) {
      const { card } = await as(request, INBOX_PURPOSE, tx => readCard(tx, { ownerScopeId: context.ownerScopeId, cardId: application.clarificationCardId }));
      const answer = await applyAnswer(request, {
        card, choice: application.choice, rawText: ('Applied learned rule: ' + application.ruleText).slice(0, 2000),
        key: 'rule:' + application.learnedApprovalRuleId + ':' + application.clarificationCardId,
        answeredBy: 'LEARNED_RULE', ruleId: application.learnedApprovalRuleId,
      });
      await as(request, INBOX_PURPOSE, tx => recordCardAnswer(tx, { ownerScopeId: context.ownerScopeId,
        cardId: application.clarificationCardId, answer, now: at, suppressionDays: evaluation.budget.repeatQuestionSuppressionDays }));
    }
    const view = await as(request, INBOX_PURPOSE, async tx => {
      const inbox = await readInbox(tx, { ownerScopeId: context.ownerScopeId, now: at, timeZone, contextPacketId: packet.packetId });
      await tx.audit({ policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS', objects: [
        { type: 'context_packets', id: packet.packetId, fields: ['packet', 'packet_hash'] },
        ...[...inbox.cards, ...inbox.resolvedToday].map(card => ({ type: 'clarification_cards', id: card.clarificationCardId,
          fields: ['status', 'choices', 'why_it_matters'] })),
        ...evaluation.decisions.map(decision => ({ type: 'interruption_decisions', id: decision.interruptionDecisionId,
          fields: ['decision', 'reason', 'policy_inputs'] })),
      ].slice(0, 100) });
      return inbox;
    });
    return reply.code(200).send(view);
  }));

  // ---- POST /v1/memory/inbox/cards/{id}/decide ---------------------------------
  app.post<{ Params: { id: string } }>('/v1/memory/inbox/cards/:id/decide', async (request, reply) => guarded(request, reply, async () => {
    const context = request.ownerContext!;
    if (!UUID.test(request.params.id)) throw new Refusal('REVIEW_INPUT_INVALID');
    const parsed = cardDecisionInputSchema.safeParse(request.body);
    if (!parsed.success) throw new Refusal('REVIEW_INPUT_INVALID');
    evidenceContext(request);
    const at = now();
    const current = await as(request, INBOX_PURPOSE, tx => readCard(tx, { ownerScopeId: context.ownerScopeId, cardId: request.params.id }));
    const card = current.card;
    const done = (proposedRule: LearnedApprovalRule | null, answer: CardAnswer, answered: ClarificationCard) => as(request, INBOX_PURPOSE, async tx => {
      const decision = await askingDecision(tx, { ownerScopeId: context.ownerScopeId, cardId: card.clarificationCardId });
      await tx.audit({ policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS', objects: [
        { type: 'clarification_cards', id: card.clarificationCardId, fields: ['status', 'answer'] },
        ...(proposedRule ? [{ type: 'learned_approval_rules', id: proposedRule.learnedApprovalRuleId, fields: ['status', 'scope'] }] : []),
      ] });
      return cardDecisionResultSchema.parse({ card: answered, answer, interruptionDecision: decision, proposedRule });
    });
    // A retry of the same answer is answered from what was recorded; a different
    // answer to a settled card is refused rather than recorded over it.
    if (card.status === 'RESOLVED' || card.status === 'CLEARED') {
      if (card.answer && card.answer.choiceId === parsed.data.choiceId) return reply.code(200).send(await done(null, card.answer, card));
      throw new Refusal('CLARIFICATION_CARD_ALREADY_ANSWERED');
    }
    const choice = card.choices.find(candidate => candidate.choiceId === parsed.data.choiceId);
    if (!choice) throw new Refusal('CLARIFICATION_CHOICE_UNKNOWN');
    const key = String(request.headers['idempotency-key']);
    const answer = await applyAnswer(request, {
      card, choice, rawText: parsed.data.rawText ?? (choice.label + ': ' + card.title), key: 'card:' + card.clarificationCardId + ':' + key,
      answeredBy: 'OWNER', ruleId: null,
    });
    const { answered, proposedRule } = await as(request, INBOX_PURPOSE, async tx => {
      const budget = await readAttentionBudget(tx, { ownerScopeId: context.ownerScopeId });
      const answeredCard = await recordCardAnswer(tx, { ownerScopeId: context.ownerScopeId, cardId: card.clarificationCardId, answer,
        now: at, suppressionDays: budget.repeatQuestionSuppressionDays });
      const rule = await proposeRuleIfRepeated(tx, { ownerScopeId: context.ownerScopeId, basis: current.ruleBasis as RuleBasis | null,
        sensitivityScope: card.sensitivityScope, choice, now: at });
      return { answered: answeredCard, proposedRule: rule };
    });
    return reply.code(201).send(await done(proposedRule, answer, answered));
  }));

  // ---- Attention budgets --------------------------------------------------------
  app.get('/v1/settings/attention-budgets', async (request, reply) => guarded(request, reply, async () => {
    const budget = await work(request, async tx => {
      const read = await readAttentionBudget(tx, { ownerScopeId: tx.context.ownerScopeId });
      await tx.audit({ policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS', objects: [] });
      return read;
    });
    return reply.code(200).send(budget);
  }));
  app.patch('/v1/settings/attention-budgets', async (request, reply) => guarded(request, reply, async () => {
    const parsed = attentionBudgetPatchSchema.safeParse(request.body);
    if (!parsed.success) throw new Refusal('REVIEW_INPUT_INVALID');
    const budget = await work(request, async tx => {
      const updated = await updateAttentionBudget(tx, { ownerScopeId: tx.context.ownerScopeId, actorId: tx.context.actorId,
        patch: parsed.data, now: now() });
      await tx.audit({ policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS', objects: [] });
      return updated;
    });
    return reply.code(200).send(budget);
  }));

  // ---- Learned approval rules ---------------------------------------------------
  app.get('/v1/approval-rules', async (request, reply) => guarded(request, reply, async () => {
    const rules = await work(request, async tx => {
      const list = await listLearnedRules(tx, { ownerScopeId: tx.context.ownerScopeId });
      await tx.audit({ policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS', objects: list.slice(0, 100).map(rule => ({
        type: 'learned_approval_rules', id: rule.learnedApprovalRuleId, fields: ['status', 'scope', 'rule_text'] })) });
      return list;
    }) as LearnedApprovalRule[];
    return reply.code(200).send(learnedApprovalRulesViewSchema.parse({ rules, readAt: now().toISOString() }));
  }));
  for (const action of ['approve', 'revoke'] as const) {
    app.post<{ Params: { id: string } }>('/v1/approval-rules/:id/' + action, async (request, reply) => guarded(request, reply, async () => {
      if (!UUID.test(request.params.id)) throw new Refusal('REVIEW_INPUT_INVALID');
      const rule = await work(request, async tx => {
        const input = { ownerScopeId: tx.context.ownerScopeId, ruleId: request.params.id, now: now() };
        const decided = action === 'approve'
          ? await approveLearnedRule(tx, { ...input, actorId: tx.context.actorId })
          : await revokeLearnedRule(tx, input);
        await tx.audit({ policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS', objects: [
          { type: 'learned_approval_rules', id: decided.learnedApprovalRuleId, fields: ['status', action === 'approve' ? 'approved_at' : 'revoked_at'] }] });
        return decided;
      });
      return reply.code(200).send(rule);
    }));
  }

  // ---- GET /v1/weekly-review -----------------------------------------------------
  app.get<{ Querystring: { weekStart?: string; timeZone?: string } }>('/v1/weekly-review', async (request, reply) => guarded(request, reply, async () => {
    const context = request.ownerContext!;
    const parsed = weeklyReviewRequestSchema.safeParse({ weekStart: request.query.weekStart, timeZone: request.query.timeZone ?? 'UTC' });
    if (!parsed.success) throw new Refusal('REVIEW_INPUT_INVALID');
    const timeZone = assertTimeZone(parsed.data.timeZone);
    const evidence = evidenceContext(request);
    const week = {
      weekStart: parsed.data.weekStart, weekEnd: addLocalDays(parsed.data.weekStart, 6), timeZone,
      from: startOfLocalDate(parsed.data.weekStart, timeZone), to: startOfLocalDate(addLocalDays(parsed.data.weekStart, 7), timeZone),
    };
    const at = now();
    const assembled = await brokerPacket(request, evidence, {
      query: 'Weekly review for the week starting ' + week.weekStart, worldTime: week.to.toISOString(),
      answerType: 'PATTERN_REVIEW', frameTypeHints: FRAME_TYPES,
    }, at);
    // Composed from the packet *as persisted*, read back and hash-checked: the
    // manifest the grounds are held against is the stored one.
    const persisted = await as(request, CONTEXT_READ_PURPOSE, async tx => {
      await declare(tx, evidence);
      return readPersistedPacket(tx, { ownerScopeId: context.ownerScopeId, packetId: assembled.packetId });
    });
    const composed = composeWeeklyReview(persisted.packet, week);
    const manifest = reviewManifestOf(persisted.packet, { registryReleaseId: persisted.registryReleaseId });
    const review = await as(request, WEEKLY_REVIEW_PURPOSE, async tx => {
      const recorded = await recordWeeklyReview(tx, { ownerScopeId: context.ownerScopeId, week, review: composed, manifest, now: at });
      await tx.audit({ policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS', objects: [
        { type: 'weekly_reviews', id: recorded.weeklyReviewId, fields: ['material_changes', 'priority_versus_calendar'] },
        { type: 'context_packets', id: recorded.contextPacketId, fields: ['packet', 'packet_hash'] },
        ...recorded.behavioralObservations.map(observation => ({ type: 'behavioral_observations',
          id: observation.behavioralObservationId, fields: ['statement', 'supporting_episode_ids'] })),
      ] });
      return recorded;
    });
    return reply.code(200).send(review);
  }));
}
