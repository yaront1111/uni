import {
  ambiguitySchema, cardAnswerSchema, cardChoiceSchema, clarificationCardSchema, interruptionDecisionSchema,
  interruptionPolicyInputsSchema, memoryInboxViewSchema,
  type AttentionBudget, type CardAnswer, type CardChoice, type ClarificationCard, type InterruptionDecision,
  type MemoryInboxView,
} from '@unai/domain';
import type { MemoryTransaction } from '@unai/memory';
import { uuidV7 } from '../../../src/kernel/identities.js';
import type { CardDraft, RuleBasis, Situation } from './ambiguities.js';
import { readAttentionBudget } from './budgets.js';
import { INTERRUPTION_POLICY_VERSION, decideInterruption, expectedValueOf } from './interruption.js';
import { approvedRuleFor, cardRuleSignature } from './rules.js';
import { DAY_MS, addLocalDays, ownerLocalDate, startOfLocalDate } from './time.js';

/**
 * The Memory inbox (PRD §7.7, §19.3, §37.4; design GET /v1/memory/inbox,
 * clarification_cards and interruption_decisions; ADR 0029 §2-§5).
 *
 * `evaluateInbox` takes the card drafts composed from one Context Broker packet
 * and decides, card by card, whether each is asked, deferred to batch review or
 * withheld -- logging every decision with its inputs. `readInbox` answers what
 * the owner sees. Both run inside a `memory.inbox` transaction the caller opened;
 * neither reads canonical memory, which only the broker does.
 */

export const INBOX_PURPOSE = 'memory.inbox';

export class InboxError extends Error {
  constructor(code: string) { super(code); this.name = 'InboxError'; }
}

/** The thread each frame belongs to (its oldest, when several), read under the
 * broker's own `memory.read` purpose. A frame outside every thread is its own
 * situation. */
export async function readSituations(tx: MemoryTransaction, input: {
  ownerScopeId: string; frameInstanceIds: readonly string[];
}): Promise<Map<string, Situation>> {
  const situations = new Map<string, Situation>();
  if (input.frameInstanceIds.length === 0) return situations;
  const rows = (await tx.query(
    `SELECT DISTINCT ON (m.object_id) m.object_id,t.id AS thread_id,t.display_title
     FROM memory_thread_members m JOIN memory_threads t ON t.owner_scope_id=m.owner_scope_id AND t.id=m.memory_thread_id
     WHERE m.owner_scope_id=$1 AND m.object_type='frame_instance' AND m.object_id=ANY($2::uuid[])
     ORDER BY m.object_id,t.created_at,t.id`,
    [input.ownerScopeId, [...new Set(input.frameInstanceIds)]])).rows;
  for (const row of rows) {
    situations.set(row['object_id'] as string, {
      situationKey: 'thread:' + (row['thread_id'] as string), title: (row['display_title'] as string | null) ?? null,
    });
  }
  return situations;
}

/** `date` columns are read as text: they are owner-local calendar dates, and the
 * session's zone and `DateStyle` must not move them. */
const CARD_COLUMNS = `id,situation_key,situation_kind,title,facts,why_it_matters,choices,grouped_ambiguity_ids,ambiguities,
  sensitivity_scope,rule_signature,rule_scope,known_evidence_ids,evidence_ids,policy_inputs,status,asked_at,
  asked_on::text AS asked_on,last_evaluated_on::text AS last_evaluated_on,answered_at,answer,suppressed_until,
  reopened_by_evidence_id,applied_rule_id,created_at`;

interface CardRow {
  readonly id: string;
  readonly situationKey: string;
  readonly status: ClarificationCard['status'];
  readonly sensitivityScope: string;
  readonly knownEvidenceIds: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly askedAt: Date | null;
  readonly askedOn: string | null;
  readonly lastEvaluatedOn: string | null;
  readonly suppressedUntil: Date | null;
  readonly reopenedByEvidenceId: string | null;
  readonly raw: Record<string, unknown>;
}

const dateText = (value: unknown): string | null =>
  value instanceof Date ? value.toISOString().slice(0, 10) : typeof value === 'string' ? value.slice(0, 10) : null;

function cardRow(row: Record<string, unknown>): CardRow {
  return {
    id: row['id'] as string, situationKey: row['situation_key'] as string, status: row['status'] as CardRow['status'],
    sensitivityScope: row['sensitivity_scope'] as string,
    knownEvidenceIds: (row['known_evidence_ids'] as string[] | null) ?? [], evidenceIds: (row['evidence_ids'] as string[] | null) ?? [],
    askedAt: (row['asked_at'] as Date | null) ?? null, askedOn: dateText(row['asked_on']),
    lastEvaluatedOn: dateText(row['last_evaluated_on']), suppressedUntil: (row['suppressed_until'] as Date | null) ?? null,
    reopenedByEvidenceId: (row['reopened_by_evidence_id'] as string | null) ?? null, raw: row,
  };
}

const SELECT_CARD = `SELECT ${CARD_COLUMNS} FROM clarification_cards`;

function publicCard(row: Record<string, unknown>, decision: InterruptionDecision | null): ClarificationCard {
  const iso = (value: unknown) => value instanceof Date ? value.toISOString() : null;
  return clarificationCardSchema.parse({
    clarificationCardId: row['id'], situationKey: row['situation_key'], situationKind: row['situation_kind'],
    title: row['title'], facts: row['facts'], whyItMatters: row['why_it_matters'], choices: row['choices'],
    groupedAmbiguityIds: row['grouped_ambiguity_ids'], ambiguities: row['ambiguities'],
    sensitivityScope: row['sensitivity_scope'], status: row['status'],
    askedAt: iso(row['asked_at']), answeredAt: iso(row['answered_at']), suppressedUntil: iso(row['suppressed_until']),
    reopenedByEvidenceId: (row['reopened_by_evidence_id'] as string | null) ?? null,
    appliedRuleId: (row['applied_rule_id'] as string | null) ?? null,
    answer: row['answer'] ? cardAnswerSchema.parse(row['answer']) : null,
    interruption: decision === null ? null : {
      decision: decision.decision, reason: decision.reason, policyInputs: decision.policyInputs, decidedAt: decision.decidedAt,
    },
  });
}

function publicDecision(row: Record<string, unknown>): InterruptionDecision {
  return interruptionDecisionSchema.parse({
    interruptionDecisionId: row['id'], clarificationCardId: row['clarification_card_id'],
    candidateAmbiguityId: row['candidate_ambiguity_id'], ambiguityKind: row['ambiguity_kind'], decision: row['decision'],
    reason: row['reason'], policyInputs: interruptionPolicyInputsSchema.parse(row['policy_inputs']),
    ownerLocalDate: dateText(row['owner_local_date']), policyVersion: row['policy_version'],
    decidedAt: (row['decided_at'] as Date).toISOString(),
  });
}

/** The most recent logged decision per card. */
async function latestDecisions(tx: MemoryTransaction, ownerScopeId: string, cardIds: readonly string[]): Promise<Map<string, InterruptionDecision>> {
  const decisions = new Map<string, InterruptionDecision>();
  if (cardIds.length === 0) return decisions;
  const rows = (await tx.query(
    `SELECT DISTINCT ON (clarification_card_id) id,clarification_card_id,candidate_ambiguity_id,ambiguity_kind,decision,reason,
       policy_inputs,owner_local_date::text AS owner_local_date,policy_version,decided_at
     FROM interruption_decisions WHERE owner_scope_id=$1 AND clarification_card_id=ANY($2::uuid[])
     ORDER BY clarification_card_id,decided_at DESC,id DESC`, [ownerScopeId, [...cardIds]])).rows;
  for (const row of rows) decisions.set(row['clarification_card_id'] as string, publicDecision(row));
  return decisions;
}

export interface RuleApplication {
  readonly clarificationCardId: string;
  readonly learnedApprovalRuleId: string;
  readonly ruleText: string;
  readonly choice: CardChoice;
  readonly title: string;
}

export interface InboxEvaluation {
  readonly ownerLocalDate: string;
  readonly budget: AttentionBudget;
  readonly decisions: readonly InterruptionDecision[];
  readonly ruleApplications: readonly RuleApplication[];
}

/**
 * Evaluate the owner's cards against the drafts of one packet (ADR 0029 §4).
 *
 * Each card is evaluated at most once per owner-local day unless evidence it
 * had not seen arrives, so reloading the inbox spends no budget and floods no
 * log. Cards are decided highest expected value first, so a cap withholds the
 * least important questions.
 */
export async function evaluateInbox(tx: MemoryTransaction, input: {
  ownerScopeId: string; now: Date; timeZone: string; contextPacketId: string | null; drafts: readonly CardDraft[];
}): Promise<InboxEvaluation> {
  const budget = await readAttentionBudget(tx, input);
  const today = ownerLocalDate(input.now, input.timeZone);
  const open = new Map((await tx.query(`${SELECT_CARD} WHERE owner_scope_id=$1 AND status NOT IN ('RESOLVED','CLEARED')`,
    [input.ownerScopeId])).rows.map(row => { const card = cardRow(row); return [card.situationKey, card] as const; }));

  // A card whose situation no longer holds an ambiguity was settled elsewhere
  // (a correction control, a governed commit). It becomes history unasked.
  const drafted = new Set(input.drafts.map(draft => draft.situationKey));
  for (const card of open.values()) {
    if (drafted.has(card.situationKey)) continue;
    await tx.query(`UPDATE clarification_cards SET status='CLEARED',updated_at=$3 WHERE owner_scope_id=$1 AND id=$2`,
      [input.ownerScopeId, card.id, input.now]);
  }

  const cards: Array<{ draft: CardDraft; card: CardRow; evidenceChanged: boolean }> = [];
  for (const draft of input.drafts) {
    const signature = draft.ruleBasis ? cardRuleSignature(draft.ruleBasis, draft.sensitivityScope) : null;
    const ruleScope = draft.ruleBasis ? { ...draft.ruleBasis, sensitivityScope: draft.sensitivityScope } : null;
    const existing = open.get(draft.situationKey);
    const content = [draft.title, JSON.stringify(draft.facts), draft.whyItMatters, JSON.stringify(draft.choices),
      [...draft.groupedAmbiguityIds], JSON.stringify(draft.ambiguities.map(ambiguity => ambiguitySchema.parse(ambiguity))),
      draft.sensitivityScope, signature, ruleScope === null ? null : JSON.stringify(ruleScope), [...draft.evidenceIds]];
    if (existing) {
      const evidenceChanged = draft.evidenceIds.some(id => !existing.evidenceIds.includes(id));
      // A card on screen today shows the owner the question as it stands now, so
      // what it was asked with moves with it.
      const shownToday = existing.status === 'ASKED' && existing.askedOn === today;
      const row = (await tx.query(
        `UPDATE clarification_cards SET title=$3,facts=$4,why_it_matters=$5,choices=$6,grouped_ambiguity_ids=$7,ambiguities=$8,
           sensitivity_scope=$9,rule_signature=$10,rule_scope=$11,evidence_ids=$12,
           known_evidence_ids=CASE WHEN $13::boolean THEN $12 ELSE known_evidence_ids END,
           context_packet_id=coalesce($14,context_packet_id),updated_at=$15
         WHERE owner_scope_id=$1 AND id=$2 RETURNING ${CARD_COLUMNS}`,
        [input.ownerScopeId, existing.id, ...content, shownToday, input.contextPacketId, input.now])).rows[0]!;
      cards.push({ draft, card: cardRow(row), evidenceChanged });
      continue;
    }
    const id = uuidV7();
    const row = (await tx.query(
      `INSERT INTO clarification_cards(id,owner_scope_id,situation_key,situation_kind,title,facts,why_it_matters,choices,
         grouped_ambiguity_ids,ambiguities,sensitivity_scope,rule_signature,rule_scope,evidence_ids,policy_inputs,status,
         context_packet_id,created_at,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'{}','OPEN',$15,$16,$16)
       RETURNING ${CARD_COLUMNS}`,
      [id, input.ownerScopeId, draft.situationKey, draft.situationKind, ...content, input.contextPacketId, input.now])).rows[0]!;
    cards.push({ draft, card: cardRow(row), evidenceChanged: false });
  }

  const asked = (await tx.query(
    `SELECT sensitivity_scope,count(*)::int AS n FROM clarification_cards WHERE owner_scope_id=$1 AND asked_on=$2::date
     GROUP BY sensitivity_scope`, [input.ownerScopeId, today])).rows;
  const askedInScope = new Map(asked.map(row => [row['sensitivity_scope'] as string, row['n'] as number]));
  let askedToday = asked.reduce((sum, row) => sum + (row['n'] as number), 0);

  // A card is due for a decision once per owner-local day, again when evidence it
  // had not seen arrives, and again when the budget it was counted against
  // changed: a new cap is the cap from the next evaluation on (CRT-WRT-05-B).
  const countedAgainst = (card: CardRow) => {
    const inputs = card.raw['policy_inputs'] as Record<string, unknown> | null;
    const counted = inputs?.['budget'] as Record<string, unknown> | undefined;
    return counted !== undefined && (counted['maxCardsPerDay'] !== budget.maxCardsPerDay
      || counted['maxCardsPerSensitivityScopePerDay'] !== budget.maxCardsPerSensitivityScopePerDay
      || counted['repeatQuestionSuppressionDays'] !== budget.repeatQuestionSuppressionDays);
  };
  const due = cards
    .filter(({ card, evidenceChanged }) => !(card.status === 'ASKED' && card.askedOn === today)
      && (card.lastEvaluatedOn !== today || evidenceChanged || countedAgainst(card)))
    .sort((left, right) => expectedValueOf(right.draft.risk) - expectedValueOf(left.draft.risk)
      || left.draft.situationKey.localeCompare(right.draft.situationKey));

  const decisions: InterruptionDecision[] = [];
  const ruleApplications: RuleApplication[] = [];
  for (const { draft, card } of due) {
    // New evidence only matters to a question that was already put to the owner:
    // for one never asked, all of its evidence is simply its evidence.
    const previouslyPut = card.askedAt !== null || card.suppressedUntil !== null;
    const materialNewEvidenceIds = previouslyPut ? draft.evidenceIds.filter(id => !card.knownEvidenceIds.includes(id)) : [];
    const rule = await approvedRuleFor(tx, {
      ownerScopeId: input.ownerScopeId, basis: draft.ruleBasis, sensitivityScope: draft.sensitivityScope,
      choices: draft.choices,
    });
    const outcome = decideInterruption({
      risk: draft.risk, sensitivityScope: draft.sensitivityScope, budget, ownerLocalDate: today, timeZone: input.timeZone,
      now: input.now, askedToday, askedInScopeToday: askedInScope.get(draft.sensitivityScope) ?? 0,
      lastAskedAt: card.askedAt, suppressedUntil: card.suppressedUntil, materialNewEvidenceIds,
      learnedApprovalRuleId: rule?.ruleId ?? null,
    });
    for (const ambiguity of draft.ambiguities) {
      const decisionId = uuidV7();
      await tx.query(
        `INSERT INTO interruption_decisions(id,owner_scope_id,clarification_card_id,candidate_ambiguity_id,ambiguity_kind,
           policy_inputs,decision,reason,owner_local_date,policy_version,decided_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10,$11)`,
        [decisionId, input.ownerScopeId, card.id, ambiguity.ambiguityId, ambiguity.kind, JSON.stringify(outcome.policyInputs),
          outcome.decision, outcome.reason, today, INTERRUPTION_POLICY_VERSION, input.now]);
      decisions.push(interruptionDecisionSchema.parse({
        interruptionDecisionId: decisionId, clarificationCardId: card.id, candidateAmbiguityId: ambiguity.ambiguityId,
        ambiguityKind: ambiguity.kind, decision: outcome.decision, reason: outcome.reason, policyInputs: outcome.policyInputs,
        ownerLocalDate: today, policyVersion: INTERRUPTION_POLICY_VERSION, decidedAt: input.now.toISOString(),
      }));
    }
    const policyInputs = JSON.stringify(outcome.policyInputs);
    if (outcome.reason === 'LEARNED_RULE_APPLIED' && rule) {
      // Not marked evaluated: if applying the rule's choice fails, the next read
      // tries again rather than leaving the question unasked and unanswered.
      await tx.query(`UPDATE clarification_cards SET policy_inputs=$3,updated_at=$4 WHERE owner_scope_id=$1 AND id=$2`,
        [input.ownerScopeId, card.id, policyInputs, input.now]);
      ruleApplications.push({ clarificationCardId: card.id, learnedApprovalRuleId: rule.ruleId, ruleText: rule.ruleText,
        choice: cardChoiceSchema.parse(rule.choice), title: draft.title });
    } else if (outcome.decision === 'ASK') {
      await tx.query(
        `UPDATE clarification_cards SET status='ASKED',asked_at=$3,asked_on=$4::date,last_evaluated_on=$4::date,known_evidence_ids=$5,
           reopened_by_evidence_id=coalesce($6,reopened_by_evidence_id),suppressed_until=NULL,policy_inputs=$7,updated_at=$3
         WHERE owner_scope_id=$1 AND id=$2`,
        [input.ownerScopeId, card.id, input.now, today, [...draft.evidenceIds], materialNewEvidenceIds[0] ?? null, policyInputs]);
      askedToday += 1;
      askedInScope.set(draft.sensitivityScope, (askedInScope.get(draft.sensitivityScope) ?? 0) + 1);
    } else if (outcome.decision === 'BATCH') {
      await tx.query(`UPDATE clarification_cards SET status='DEFERRED',last_evaluated_on=$3::date,policy_inputs=$4,updated_at=$5
        WHERE owner_scope_id=$1 AND id=$2`, [input.ownerScopeId, card.id, today, policyInputs, input.now]);
    } else {
      const windowEnd = card.askedAt ? new Date(card.askedAt.getTime() + budget.repeatQuestionSuppressionDays * DAY_MS) : null;
      const until = [card.suppressedUntil, windowEnd].filter((time): time is Date => time !== null)
        .reduce((latest, time) => time.getTime() > latest.getTime() ? time : latest, input.now);
      await tx.query(`UPDATE clarification_cards SET status='SUPPRESSED',suppressed_until=$3,last_evaluated_on=$4::date,
        policy_inputs=$5,updated_at=$6 WHERE owner_scope_id=$1 AND id=$2`,
        [input.ownerScopeId, card.id, until, today, policyInputs, input.now]);
    }
  }
  return { ownerLocalDate: today, budget, decisions, ruleApplications };
}

/** What the owner sees (design GET /v1/memory/inbox). */
export async function readInbox(tx: MemoryTransaction, input: {
  ownerScopeId: string; now: Date; timeZone: string; contextPacketId: string | null;
}): Promise<MemoryInboxView> {
  const budget = await readAttentionBudget(tx, input);
  const today = ownerLocalDate(input.now, input.timeZone);
  const dayStart = startOfLocalDate(today, input.timeZone);
  const dayEnd = startOfLocalDate(addLocalDays(today, 1), input.timeZone);
  const rows = (await tx.query(
    `${SELECT_CARD} WHERE owner_scope_id=$1 AND (status IN ('ASKED','DEFERRED','SUPPRESSED')
       OR (status='RESOLVED' AND answered_at>=$2 AND answered_at<$3))
     ORDER BY created_at,id`, [input.ownerScopeId, dayStart, dayEnd])).rows;
  const decisions = await latestDecisions(tx, input.ownerScopeId, rows.map(row => row['id'] as string));
  const cards = rows.map(row => ({ row: cardRow(row), card: publicCard(row, decisions.get(row['id'] as string) ?? null) }));
  const askedRows = (await tx.query(
    `SELECT sensitivity_scope,count(*)::int AS n FROM clarification_cards WHERE owner_scope_id=$1 AND asked_on=$2::date
     GROUP BY sensitivity_scope`, [input.ownerScopeId, today])).rows;
  const askedToday = askedRows.reduce((sum, row) => sum + (row['n'] as number), 0);
  const scopes = new Set([...askedRows.map(row => row['sensitivity_scope'] as string),
    ...cards.filter(({ row }) => row.status === 'DEFERRED').map(({ row }) => row.sensitivityScope)]);
  return memoryInboxViewSchema.parse({
    ownerLocalDate: today, timeZone: input.timeZone, budget,
    remainingToday: Math.max(0, budget.maxCardsPerDay - askedToday),
    remainingByScope: [...scopes].sort().map(sensitivityScope => ({
      sensitivityScope,
      remaining: Math.max(0, budget.maxCardsPerSensitivityScopePerDay
        - ((askedRows.find(row => row['sensitivity_scope'] === sensitivityScope)?.['n'] as number | undefined) ?? 0)),
    })),
    // Shown: the cards asked today and still unanswered. A deferred card is
    // counted, never rendered: the budget decided it waits for batch review.
    cards: cards.filter(({ row }) => row.status === 'ASKED' && row.askedOn === today).map(({ card }) => card),
    deferredCount: cards.filter(({ row }) => row.status === 'DEFERRED').length,
    withheld: cards.filter(({ row }) => row.status === 'SUPPRESSED').map(({ card }) => card),
    resolvedToday: cards.filter(({ row }) => row.status === 'RESOLVED').map(({ card }) => card),
    contextPacketId: input.contextPacketId, readAt: input.now.toISOString(),
  });
}

export async function readCard(tx: MemoryTransaction, input: { ownerScopeId: string; cardId: string }): Promise<{
  card: ClarificationCard; ruleBasis: RuleBasis | null; latestDecision: InterruptionDecision | null;
}> {
  const row = (await tx.query(`${SELECT_CARD} WHERE owner_scope_id=$1 AND id=$2`, [input.ownerScopeId, input.cardId])).rows[0];
  if (!row) throw new InboxError('CLARIFICATION_CARD_NOT_FOUND');
  const decision = (await latestDecisions(tx, input.ownerScopeId, [input.cardId])).get(input.cardId) ?? null;
  const scope = row['rule_scope'] as Record<string, unknown> | null;
  return {
    card: publicCard(row, decision),
    ruleBasis: scope && (scope['situationKind'] === 'REPAYMENT' || scope['situationKind'] === 'GENERAL') && typeof scope['matchText'] === 'string'
      ? { situationKind: scope['situationKind'], matchText: scope['matchText'] } : null,
    latestDecision: decision,
  };
}

/** The decision that put a card in front of the owner: its most recent ASK, or
 * the rule application that answered it instead. */
export async function askingDecision(tx: MemoryTransaction, input: { ownerScopeId: string; cardId: string }): Promise<InterruptionDecision | null> {
  const row = (await tx.query(
    `SELECT id,clarification_card_id,candidate_ambiguity_id,ambiguity_kind,decision,reason,policy_inputs,
       owner_local_date::text AS owner_local_date,policy_version,decided_at
     FROM interruption_decisions WHERE owner_scope_id=$1 AND clarification_card_id=$2
       AND (decision='ASK' OR reason='LEARNED_RULE_APPLIED')
     ORDER BY decided_at DESC,id DESC LIMIT 1`, [input.ownerScopeId, input.cardId])).rows[0];
  return row ? publicDecision(row) : null;
}

/**
 * Record the answer to a card. A decision resolves it; keep-uncertain withholds
 * it for the suppression window instead, which is what that control promises.
 */
export async function recordCardAnswer(tx: MemoryTransaction, input: {
  ownerScopeId: string; cardId: string; answer: CardAnswer; now: Date; suppressionDays: number;
}): Promise<ClarificationCard> {
  const answer = cardAnswerSchema.parse(input.answer);
  const keep = answer.effect === 'KEEP_UNCERTAIN';
  const updated = await tx.query(
    `UPDATE clarification_cards SET status=$3,answered_at=$4,answer=$5,applied_rule_id=$6,
       suppressed_until=CASE WHEN $3='SUPPRESSED' THEN $7::timestamptz ELSE suppressed_until END,
       known_evidence_ids=evidence_ids,updated_at=$4
     WHERE owner_scope_id=$1 AND id=$2 AND status NOT IN ('RESOLVED','CLEARED')`,
    [input.ownerScopeId, input.cardId, keep ? 'SUPPRESSED' : 'RESOLVED', input.now, JSON.stringify(answer),
      answer.learnedApprovalRuleId, new Date(input.now.getTime() + input.suppressionDays * DAY_MS)]);
  if (updated.rowCount !== 1) throw new InboxError('CLARIFICATION_CARD_ALREADY_ANSWERED');
  return (await readCard(tx, input)).card;
}
