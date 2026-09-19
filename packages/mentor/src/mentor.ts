import {
  interruptionPolicyInputsSchema, mentorCardSchema, mentorViewSchema,
  type AttentionBudget, type ContextPacket, type Goal, type LifeCategory, type MentorCard, type MentorGround, type MentorView,
} from '@unai/domain';
import type { MemoryTransaction } from '@unai/memory';
import { INTERRUPTION_POLICY_VERSION, decideInterruption, expectedValueOf, ownerLocalDate, readAttentionBudget, readProactiveAttentionCounts,
  type CardRisk } from '@unai/review';
import { uuidV7 } from '../../../src/kernel/identities.js';
import { standingStatement } from './goals.js';

/**
 * The mentor: contradictions between a stated goal and observed calendar
 * behaviour, surfaced within the attention budget (PRD §4.9, §36.13, §37.7, §52
 * exit criteria; design screen "Mentor contradiction card"; ADR 0029 §7;
 * CRT-DEC-03-A).
 *
 * Three rules shape every card:
 *
 *  1. **Evidence, inference and recommendation are three separate values**, each
 *     labelled, never one paragraph. Evidence is what the record shows (the goal
 *     as the owner stated it, the calendar time as the broker read it); the
 *     inference is the mentor's conclusion with its confidence and the
 *     counterexamples it looked for; the recommendation is advice, proportional
 *     to the evidence, and never an intent or an action.
 *  2. **Only evidence-backed patterns.** A goal is flagged only when it is stated
 *     HIGH now, at least two calendar events fall in the window, and the goal's
 *     domain received less than a tenth of the scheduled time. One event never
 *     supports a pattern. An explicit temporary override is respected.
 *  3. **One attention budget.** Every card goes through `@unai/review`'s
 *     `decideInterruption`, counted together with the day's asked clarification
 *     cards per owner and per sensitivity scope. A withheld card is recorded
 *     with its reason and never emitted.
 *
 * `composeContradictions` is pure; `evaluateMentor` and `readMentorView` run in
 * a `mentor.advise` transaction the caller opened. Memory is read only through
 * the Context Broker packet the caller supplies.
 */

export const MENTOR_PURPOSE = 'mentor.advise';
export const MENTOR_COMPOSER_VERSION = 'mentor-contradictions-0.1.0';
export const MENTOR_OBSERVATION_DAYS = 28;
/** Below this share of the scheduled time a HIGH goal's domain is flagged. */
export const MENTOR_SHARE_THRESHOLD = 0.1;
export const MENTOR_MINIMUM_EVENTS = 2;
const DAY_MS = 86_400_000;

const OCCURRENCE_TIME = 'shared.event_occurrence.occurrence_time';
const CALENDAR_MODALITIES = new Set(['SCHEDULED', 'ACTUAL']);
const SPECIFIC: readonly LifeCategory[] = ['FINANCE', 'FAMILY', 'WORK', 'HEALTH', 'ADMIN'];
const WORDS: Readonly<Record<LifeCategory, string>> = Object.freeze({
  FINANCE: 'Finance', FAMILY: 'Family', WORK: 'Work', HEALTH: 'Health', ADMIN: 'Administration', PERSONAL: 'Personal',
});
const SENSITIVITY_ORDER: readonly string[] = ['NORMAL', 'PRIVATE', 'RESTRICTED'];

/** The one category an event's time is counted under: the most specific view it
 * is in, the same rule the weekly review allocates time by. */
const primaryCategory = (categories: readonly LifeCategory[]): LifeCategory =>
  SPECIFIC.find(category => categories.includes(category)) ?? 'PERSONAL';

const hours = (minutes: number) => {
  const tenths = Math.round(minutes / 6);
  return (tenths % 10 === 0 ? String(tenths / 10) : (tenths / 10).toFixed(1)) + (tenths === 10 ? ' hour' : ' hours');
};
const day = (instant: Date | string) => new Date(instant).toISOString().slice(0, 10);

function intervalOf(value: unknown): { start: Date | null; end: Date | null } {
  if (typeof value !== 'object' || value === null) return { start: null, end: null };
  const record = value as Record<string, unknown>;
  const parse = (raw: unknown) => {
    if (typeof raw !== 'string') return null;
    const time = new Date(raw);
    return Number.isNaN(time.getTime()) ? null : time;
  };
  const instant = parse(record['time']);
  return instant ? { start: instant, end: null } : { start: parse(record['start']), end: parse(record['end']) };
}

export interface CalendarEvent {
  readonly propositionId: string;
  readonly frameInstanceId: string;
  readonly category: LifeCategory;
  readonly minutes: number;
  readonly start: Date;
  readonly evidenceIds: readonly string[];
}

/** The calendar time a packet shows inside a window: one reading per event
 * frame (its latest stated time), SCHEDULED or ACTUAL, clipped to the window. */
export function calendarEvents(packet: ContextPacket, window: { from: Date; to: Date }): CalendarEvent[] {
  const items = [
    ...packet.currentBeliefs.map(belief => ({ ...belief, stated: belief.validFrom ?? null })),
    ...packet.futureClaims.map(claim => ({ ...claim, stated: claim.validFrom ?? null })),
  ].filter(item => item.predicateId === OCCURRENCE_TIME && CALENDAR_MODALITIES.has(item.modality));
  const latest = new Map<string, typeof items[number]>();
  for (const item of items) {
    const current = latest.get(item.frameInstanceId);
    const stated = item.stated ? Date.parse(item.stated) : 0;
    const currentStated = current?.stated ? Date.parse(current.stated) : 0;
    if (!current || stated > currentStated || (stated === currentStated && item.propositionId > current.propositionId)) {
      latest.set(item.frameInstanceId, item);
    }
  }
  const events: CalendarEvent[] = [];
  for (const item of latest.values()) {
    const { start, end } = intervalOf(item.normalizedValue);
    if (start === null || start.getTime() < window.from.getTime() || start.getTime() >= window.to.getTime()) continue;
    const clippedEnd = Math.min(end?.getTime() ?? start.getTime(), window.to.getTime());
    events.push({
      propositionId: item.propositionId, frameInstanceId: item.frameInstanceId,
      category: primaryCategory(item.lifeCategories), minutes: Math.max(0, Math.round((clippedEnd - start.getTime()) / 60_000)),
      start, evidenceIds: [...(item.evidenceIds ?? [])],
    });
  }
  return events.sort((left, right) => left.start.getTime() - right.start.getTime() || left.propositionId.localeCompare(right.propositionId));
}

export interface MentorDraft {
  readonly goal: Goal;
  readonly goalPriorityHistoryId: string;
  readonly evidence: MentorCard['evidence'];
  readonly inference: MentorCard['inference'];
  readonly recommendation: MentorCard['recommendation'];
  readonly observationWindow: { from: Date; to: Date };
  readonly confidence: number;
  readonly sensitivityScope: string;
  readonly evidenceIds: readonly string[];
  readonly risk: CardRisk;
}

export interface ComposedContradictions {
  readonly drafts: readonly MentorDraft[];
  readonly respectedOverrides: MentorView['respectedOverrides'];
  readonly events: readonly CalendarEvent[];
}

/**
 * Compose one card per goal whose stated priority the calendar contradicts.
 * Pure: the goals, one broker packet and the window in; drafts out.
 */
export function composeContradictions(packet: ContextPacket, input: {
  goals: readonly Goal[]; window: { from: Date; to: Date };
}): ComposedContradictions {
  const events = calendarEvents(packet, input.window);
  const total = events.reduce((sum, event) => sum + event.minutes, 0);
  const byCategory = new Map<LifeCategory, CalendarEvent[]>();
  for (const event of events) byCategory.set(event.category, [...(byCategory.get(event.category) ?? []), event]);
  const sensitivityOf = new Map(packet.evidenceRefs.map(ref => [ref.evidenceId, ref.sensitivity]));
  const drafts: MentorDraft[] = [];
  const respected: Array<MentorView['respectedOverrides'][number]> = [];

  for (const goal of input.goals) {
    if (goal.retiredAt !== null) continue;
    // PRD §37.7: an explicit temporary override is the owner saying "not now";
    // measuring them against the standing priority would ignore what they said.
    if (goal.currentPriority === 'HIGH' && goal.overrideActive && goal.effectivePriority !== 'HIGH' && goal.temporaryOverride) {
      respected.push({ goalId: goal.goalId, goalTitle: goal.title, priority: goal.temporaryOverride.priority,
        until: goal.temporaryOverride.validTo });
      continue;
    }
    if (goal.effectivePriority !== 'HIGH') continue;
    const statement = standingStatement(goal);
    if (!statement || events.length < MENTOR_MINIMUM_EVENTS || total === 0) continue;
    const inDomain = byCategory.get(goal.domain) ?? [];
    const goalMinutes = inDomain.reduce((sum, event) => sum + event.minutes, 0);
    const share = goalMinutes / total;
    if (share >= MENTOR_SHARE_THRESHOLD) continue;

    const domain = WORDS[goal.domain];
    const sharePercent = Math.round(share * 100);
    const breakdown = [...byCategory.entries()].sort((left, right) =>
      right[1].reduce((sum, event) => sum + event.minutes, 0) - left[1].reduce((sum, event) => sum + event.minutes, 0)
      || left[0].localeCompare(right[0]))
      .map(([category, list]) => WORDS[category] + ' ' + hours(list.reduce((sum, event) => sum + event.minutes, 0))
        + ' across ' + list.length + (list.length === 1 ? ' event' : ' events'));
    const eventGrounds: MentorGround[] = events.slice(0, 62).map(event => ({ objectType: 'proposition', objectId: event.propositionId }));
    const confidence = events.length >= 6 ? 0.8 : 0.6;
    const evidenceIds = [...new Set(events.flatMap(event => [...event.evidenceIds]))].sort();
    const sensitivity = evidenceIds.map(id => sensitivityOf.get(id) ?? 'PRIVATE')
      .reduce((highest, level) => SENSITIVITY_ORDER.indexOf(level) > SENSITIVITY_ORDER.indexOf(highest) ? level : highest, 'PRIVATE' as string);

    drafts.push({
      goal, goalPriorityHistoryId: statement.goalPriorityHistoryId,
      evidence: [
        { label: 'EVIDENCE', kind: 'STATED_GOAL',
          text: 'You set "' + goal.title + '" (' + domain + ') to high priority on ' + day(statement.validFrom)
            + (statement.reason ? ': "' + statement.reason.slice(0, 200) + '"' : '') + '.',
          grounds: [{ objectType: 'goal', objectId: goal.goalId }, { objectType: 'goal_priority_history', objectId: statement.goalPriorityHistoryId }] },
        { label: 'EVIDENCE', kind: 'CALENDAR_ALLOCATION',
          text: ('Between ' + day(input.window.from) + ' and ' + day(new Date(input.window.to.getTime() - 1)) + ', ' + events.length
            + ' calendar events took ' + hours(total) + ': ' + breakdown.join('; ') + '. ' + domain + ': '
            + hours(goalMinutes) + (inDomain.length === 0 ? ', no event.' : ' across ' + inDomain.length + (inDomain.length === 1 ? ' event.' : ' events.'))).slice(0, 1000),
          grounds: eventGrounds },
      ],
      inference: {
        label: 'INFERENCE',
        text: (domain + ' received ' + sharePercent + '% of your scheduled time while "' + goal.title + '" is stated as high priority. '
          + 'This is a reading of your calendar, not of your intentions: time spent outside calendar events is not visible here.').slice(0, 1000),
        confidence, goalMinutes, totalMinutes: total, sharePercent, eventCount: events.length,
        counterexampleSearch: {
          searched: 'Scheduled or attended calendar events in ' + domain + ' between ' + day(input.window.from) + ' and '
            + day(new Date(input.window.to.getTime() - 1)) + '.',
          counterexamplesFound: inDomain.length,
          counterexampleIds: inDomain.map(event => event.propositionId).slice(0, 64),
        },
      },
      recommendation: {
        label: 'RECOMMENDATION',
        text: ('If "' + goal.title + '" is still a high priority, put time for it on your calendar this week. '
          + 'If it is not, lower its stated priority, so reviews measure you against what matters now.').slice(0, 1000),
      },
      observationWindow: input.window, confidence, sensitivityScope: goal.domain + '/' + sensitivity, evidenceIds,
      // The mentor's reading can be wrong (calendar time is not all time), the
      // cost of acting on it late is real but recoverable, and it is not urgent.
      risk: { errorProbability: confidence, consequence: 'HIGH', irreversibility: 'COSTLY_TO_REVERSE', urgency: 'MEDIUM',
        interruptionCost: 'LOW' },
    });
  }
  return { drafts, respectedOverrides: respected, events };
}

// ---------------------------------------------------------------------------
// The one attention budget
// ---------------------------------------------------------------------------

/**
 * Proactive items already put in front of the owner today, per sensitivity
 * scope: asked clarification cards, emitted mentor cards and initiative notices,
 * counted through the same content-free reader as Inbox and initiative.
 */
export async function proactiveItemsToday(tx: MemoryTransaction, input: { ownerScopeId: string; ownerLocalDate: string }): Promise<Map<string, number>> {
  return readProactiveAttentionCounts(tx, input);
}

const CARD_COLUMNS = `id,card_kind,goal_id,goal_priority_history_id,evidence,inference,recommendation,observation_window_start,
  observation_window_end,confidence,evidence_ids,sensitivity_scope,decision,reason,policy_inputs,owner_local_date::text AS owner_local_date,
  decided_at,context_packet_id`;

function publicCard(row: Record<string, unknown>, goals: ReadonlyMap<string, Goal>): MentorCard {
  const goal = goals.get(row['goal_id'] as string);
  return mentorCardSchema.parse({
    mentorCardId: row['id'], cardKind: row['card_kind'], goalId: row['goal_id'], goalTitle: goal?.title ?? 'Goal',
    goalDomain: goal?.domain ?? 'PERSONAL', goalPriorityHistoryId: row['goal_priority_history_id'],
    evidence: row['evidence'], inference: row['inference'], recommendation: row['recommendation'],
    observationWindow: { from: (row['observation_window_start'] as Date).toISOString(), to: (row['observation_window_end'] as Date).toISOString() },
    confidence: Number(row['confidence']), sensitivityScope: row['sensitivity_scope'], decision: row['decision'], reason: row['reason'],
    policyInputs: interruptionPolicyInputsSchema.parse(row['policy_inputs']), ownerLocalDate: row['owner_local_date'],
    decidedAt: (row['decided_at'] as Date).toISOString(), contextPacketId: row['context_packet_id'],
  });
}

const sameBudget = (counted: unknown, budget: AttentionBudget) => {
  const recorded = counted as Record<string, unknown> | undefined;
  return recorded !== undefined && recorded['maxCardsPerDay'] === budget.maxCardsPerDay
    && recorded['maxCardsPerSensitivityScopePerDay'] === budget.maxCardsPerSensitivityScopePerDay
    && recorded['repeatQuestionSuppressionDays'] === budget.repeatQuestionSuppressionDays;
};

export interface MentorEvaluation {
  readonly ownerLocalDate: string;
  readonly budget: AttentionBudget;
  readonly recorded: readonly MentorCard[];
}

/**
 * Decide, card by card, whether each drafted contradiction is emitted, deferred
 * or withheld, and record every decision with its logged inputs.
 *
 * A goal is evaluated once per owner-local day, and again only when the budget
 * it was counted against changes, so reloading spends no budget. Cards are
 * decided highest expected value first, so a cap withholds the least important.
 */
export async function evaluateMentor(tx: MemoryTransaction, input: {
  ownerScopeId: string; now: Date; timeZone: string; contextPacketId: string; packetHash: string;
  drafts: readonly MentorDraft[];
}): Promise<MentorEvaluation> {
  const budget = await readAttentionBudget(tx, input);
  const today = ownerLocalDate(input.now, input.timeZone);
  const todays = (await tx.query(
    `SELECT DISTINCT ON (goal_id) goal_id,decision,policy_inputs FROM mentor_cards
     WHERE owner_scope_id=$1 AND owner_local_date=$2::date ORDER BY goal_id,decided_at DESC,id DESC`,
    [input.ownerScopeId, today])).rows;
  const due = input.drafts.filter(draft => {
    const earlier = todays.find(row => row['goal_id'] === draft.goal.goalId);
    if (!earlier) return true;
    if (earlier['decision'] === 'ASK') return false;
    return !sameBudget((earlier['policy_inputs'] as Record<string, unknown>)['budget'], budget);
  }).sort((left, right) => expectedValueOf(right.risk) - expectedValueOf(left.risk)
    || left.goal.title.localeCompare(right.goal.title) || left.goal.goalId.localeCompare(right.goal.goalId));

  const counts = await proactiveItemsToday(tx, { ownerScopeId: input.ownerScopeId, ownerLocalDate: today });
  let askedToday = [...counts.values()].reduce((sum, n) => sum + n, 0);
  const goals = new Map(input.drafts.map(draft => [draft.goal.goalId, draft.goal]));
  const recorded: MentorCard[] = [];
  for (const draft of due) {
    const lastAsked = (await tx.query(
      `SELECT decided_at,evidence_ids FROM mentor_cards WHERE owner_scope_id=$1 AND goal_id=$2 AND decision='ASK'
       ORDER BY decided_at DESC,id DESC LIMIT 1`, [input.ownerScopeId, draft.goal.goalId])).rows[0];
    const knownEvidence = new Set((lastAsked?.['evidence_ids'] as string[] | undefined) ?? []);
    const outcome = decideInterruption({
      risk: draft.risk, sensitivityScope: draft.sensitivityScope, budget, ownerLocalDate: today, timeZone: input.timeZone,
      now: input.now, askedToday, askedInScopeToday: counts.get(draft.sensitivityScope) ?? 0,
      lastAskedAt: (lastAsked?.['decided_at'] as Date | undefined) ?? null, suppressedUntil: null,
      materialNewEvidenceIds: lastAsked ? draft.evidenceIds.filter(id => !knownEvidence.has(id)) : [],
      learnedApprovalRuleId: null,
    });
    const row = (await tx.query(
      `INSERT INTO mentor_cards(id,owner_scope_id,card_kind,goal_id,goal_priority_history_id,evidence,inference,recommendation,
         observation_window_start,observation_window_end,confidence,evidence_ids,sensitivity_scope,decision,reason,policy_inputs,
         owner_local_date,policy_version,composer_version,context_packet_id,packet_hash,decided_at)
       VALUES($1,$2,'GOAL_CALENDAR_CONTRADICTION',$3,$4,$5,$6,$7,$8,$9,$10,$11::uuid[],$12,$13,$14,$15,$16::date,$17,$18,$19,$20,$21)
       RETURNING ${CARD_COLUMNS}`,
      [uuidV7(), input.ownerScopeId, draft.goal.goalId, draft.goalPriorityHistoryId, JSON.stringify(draft.evidence),
        JSON.stringify(draft.inference), JSON.stringify(draft.recommendation), draft.observationWindow.from, draft.observationWindow.to,
        draft.confidence, [...draft.evidenceIds].slice(0, 256), draft.sensitivityScope, outcome.decision, outcome.reason,
        JSON.stringify(outcome.policyInputs), today, INTERRUPTION_POLICY_VERSION, MENTOR_COMPOSER_VERSION, input.contextPacketId,
        input.packetHash, input.now])).rows[0]!;
    recorded.push(publicCard(row, goals));
    if (outcome.decision === 'ASK') {
      askedToday += 1;
      counts.set(draft.sensitivityScope, (counts.get(draft.sensitivityScope) ?? 0) + 1);
    }
  }
  return { ownerLocalDate: today, budget, recorded };
}

/** What the Mentor contradiction card screen shows: today's emitted cards and
 * today's withheld ones, each with its logged decision. */
export async function readMentorView(tx: MemoryTransaction, input: {
  ownerScopeId: string; now: Date; timeZone: string; goals: readonly Goal[]; contextPacketId: string | null;
  respectedOverrides: MentorView['respectedOverrides'];
}): Promise<MentorView> {
  const budget = await readAttentionBudget(tx, input);
  const today = ownerLocalDate(input.now, input.timeZone);
  const goals = new Map(input.goals.map(goal => [goal.goalId, goal]));
  const rows = (await tx.query(
    `SELECT DISTINCT ON (goal_id) ${CARD_COLUMNS} FROM mentor_cards WHERE owner_scope_id=$1 AND owner_local_date=$2::date
     ORDER BY goal_id,(decision='ASK') DESC,decided_at DESC,id DESC`, [input.ownerScopeId, today])).rows;
  const cards = rows.map(row => publicCard(row, goals))
    .sort((left, right) => left.decidedAt.localeCompare(right.decidedAt) || left.mentorCardId.localeCompare(right.mentorCardId));
  const counts = await proactiveItemsToday(tx, { ownerScopeId: input.ownerScopeId, ownerLocalDate: today });
  const proactive = [...counts.values()].reduce((sum, n) => sum + n, 0);
  return mentorViewSchema.parse({
    ownerLocalDate: today, timeZone: input.timeZone, budget, proactiveItemsToday: proactive,
    remainingToday: Math.max(0, budget.maxCardsPerDay - proactive),
    cards: cards.filter(card => card.decision === 'ASK'), withheld: cards.filter(card => card.decision !== 'ASK'),
    respectedOverrides: [...input.respectedOverrides], contextPacketId: input.contextPacketId,
    composerVersion: MENTOR_COMPOSER_VERSION, readAt: input.now.toISOString(),
  });
}

/** The observation window ending at `now`. */
export function observationWindow(now: Date): { from: Date; to: Date } {
  return { from: new Date(now.getTime() - MENTOR_OBSERVATION_DAYS * DAY_MS), to: now };
}
