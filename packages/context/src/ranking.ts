import { createHash } from 'node:crypto';
import type {
  BriefingDomain, BriefingItemKind, BriefingPriority, MemoryLabel, RankComponents, WhyRef,
} from '@unai/domain';
import { canonicalJson } from '@unai/memory';

/**
 * The Today briefing's selection and ranking (PRD §7.1, §26; design "today view
 * and briefing ranking service", "briefing edition history for low-priority
 * repeat suppression"; CRT-UX-01-A, CRT-UX-01-B, CRT-UX-02-A). ADR 0026.
 *
 * Pure: no transaction, no clock of its own, no model. `today.ts` reads the
 * candidates from a Context Broker packet and the typed projections, hands them
 * here with the instant and the owner's timezone, and persists what comes back.
 *
 * Four rules decide what a reader sees:
 *
 *  1. Only current or imminent material items. An unresolved item whose target
 *     time is within `IMMINENT_HOURS` ahead, or passed within `PAST_TARGET_DAYS`,
 *     or which carries a decision-affecting conflict, is material. A resolved one
 *     is not, and neither is one weeks away.
 *  2. The order is the seven rank components, never a recording time. An older
 *     urgent high-consequence item outranks a newer low-consequence one because
 *     nothing in the score knows which is newer.
 *  3. A low-priority item shown on an earlier date within
 *     `REPEAT_SUPPRESSION_DAYS`, whose material state is unchanged, is not
 *     repeated. The edition history is the memory of what was shown.
 *  4. A small set: at most `MAX_ITEMS_PER_SECTION` per domain section and
 *     `MAX_ITEMS_SHOWN` in all; the rest are deferred to their own views, and at
 *     most `MAX_RECOMMENDATIONS` recommendations are made.
 */

export const RANKING_VERSION = 'briefing-ranking-0.1.0';
export const IMMINENT_HOURS = 48;
export const PAST_TARGET_DAYS = 14;
export const REPEAT_SUPPRESSION_DAYS = 7;
export const MAX_ITEMS_PER_SECTION = 3;
export const MAX_ITEMS_SHOWN = 7;
export const MAX_RECOMMENDATIONS = 3;

/** How much each component weighs. They sum to one, so a score is in [0,1]. */
export const RANK_WEIGHTS: Readonly<Record<keyof RankComponents, number>> = Object.freeze({
  consequence: 0.30, urgency: 0.25, goalRelevance: 0.10, confidence: 0.10,
  // Lower effort and lower reversibility rank higher: a quick task and an
  // irreversible consequence both earn attention.
  effort: 0.05, reversibility: 0.10, attentionBudget: 0.10,
});

// ---------------------------------------------------------------------------
// Owner-local time
// ---------------------------------------------------------------------------

export class BriefingTimeError extends Error {
  constructor(code: 'TODAY_TIME_ZONE_INVALID') { super(code); this.name = 'BriefingTimeError'; }
}

/** Throws unless `Intl` knows the zone. */
export function assertTimeZone(timeZone: string): void {
  try { new Intl.DateTimeFormat('en-US', { timeZone }).format(0); }
  catch { throw new BriefingTimeError('TODAY_TIME_ZONE_INVALID'); }
}

function parts(instant: Date, timeZone: string): Record<string, string> {
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23', weekday: 'short',
  }).formatToParts(instant);
  return Object.fromEntries(formatted.map(part => [part.type, part.value]));
}

/** The owner's calendar date at `instant`: in Asia/Jerusalem 22:30 UTC is already
 * the next day, which is the whole point of asking. */
export function ownerLocalDate(instant: Date, timeZone: string): string {
  const p = parts(instant, timeZone);
  return p['year'] + '-' + p['month'] + '-' + p['day'];
}

/** "+03:00" for Asia/Jerusalem in summer, "+00:00" for UTC. */
export function utcOffset(instant: Date, timeZone: string): string {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(instant).find(part => part.type === 'timeZoneName')?.value ?? 'GMT';
  const match = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name);
  if (!match) return '+00:00';
  return match[1] + match[2]!.padStart(2, '0') + ':' + (match[3] ?? '00');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Fri 19 Sep, 14:00" in the owner's zone. */
export function formatLocal(instant: Date, timeZone: string): string {
  const p = parts(instant, timeZone);
  return p['weekday'] + ' ' + Number(p['day']) + ' ' + MONTHS[Number(p['month']) - 1] + ', ' + p['hour'] + ':' + p['minute'];
}

/** Whole days from one local date to another ("2026-09-18" to "2026-09-19" is 1). */
export function dayDifference(from: string, to: string): number {
  return Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86_400_000);
}

export function shiftLocalDate(date: string, days: number): string {
  return new Date(Date.parse(date + 'T00:00:00Z') + days * 86_400_000).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

/** One thing the briefing might surface, as `today.ts` read it from the packet. */
export interface BriefingCandidate {
  readonly itemObjectType: 'frame_instance' | 'owner_overlay_delta';
  readonly itemObjectId: string;
  readonly kind: BriefingItemKind;
  readonly domainSection: BriefingDomain;
  readonly label: MemoryLabel;
  readonly outcomeState: 'UNRESOLVED' | 'PARTIALLY_RESOLVED' | 'RESOLVED' | 'CONTESTED' | 'PENDING';
  readonly targetTime: Date | null;
  /** What the item is about, in the owner's words where there are some. */
  readonly subject: string;
  /** "with Daniel", "to Dana"; empty when nobody is named. */
  readonly counterpart: string;
  /** Money as recorded ("ILS 450"), never computed here. */
  readonly amount: string | null;
  readonly statedPriority: string | null;
  readonly decisionAffectingConflict: boolean;
  readonly ownerAssertionPending: boolean;
  /** A HIGH-risk recommendation over this item needs a complete projection. */
  readonly projectionComplete: boolean;
  /** The support is accepted (not merely provisional). */
  readonly supportAccepted: boolean;
  readonly sourceRefs: readonly WhyRef[];
  readonly evidenceIds: readonly string[];
  /** The values the item states, by proposition, so a changed value is a change. */
  readonly materialValues: readonly string[];
}

/** An item as it was shown on an earlier date. */
export interface ShownBefore {
  readonly itemObjectType: string;
  readonly itemObjectId: string;
  readonly materialFingerprint: string;
  readonly ownerLocalDate: string;
}

export interface RankedItem {
  readonly candidate: BriefingCandidate;
  readonly headline: string;
  readonly whySurfaced: string;
  readonly targetLocal: string | null;
  readonly pastTarget: boolean;
  readonly components: RankComponents;
  readonly score: number;
  readonly priority: BriefingPriority;
  readonly materialFingerprint: string;
  readonly presentation: 'SHOWN' | 'SUPPRESSED_UNCHANGED' | 'DEFERRED_BY_ATTENTION_BUDGET';
  /** 1-based among shown items. */
  readonly rankPosition: number | null;
  readonly lastShownOn: string | null;
}

export interface RankedRecommendation {
  readonly text: string;
  readonly basedOnItemId: string;
  readonly risk: 'LOW' | 'MEDIUM' | 'HIGH';
}
export interface WithheldRecommendationValue {
  readonly basedOnItemId: string;
  readonly risk: 'HIGH';
  readonly reason: 'SUPPORT_PROVISIONAL' | 'SUPPORT_CONTESTED' | 'PROJECTION_INCOMPLETE';
}

export interface RankedBriefing {
  readonly items: readonly RankedItem[];
  readonly recommendations: readonly RankedRecommendation[];
  readonly withheldRecommendations: readonly WithheldRecommendationValue[];
}

// ---------------------------------------------------------------------------
// Wording
// ---------------------------------------------------------------------------

function quoted(text: string): string { return '“' + text + '”'; }

/** The headline, worded by what the item is and whether its time has passed. A
 * scheduled event is "scheduled" or "planned" and never said to have happened:
 * only an accepted resolution assertion can say that, and a resolved item is not
 * material today (CRT-UX-01-B). */
export function headlineOf(candidate: BriefingCandidate, pastTarget: boolean, targetLocal: string | null): string {
  const who = candidate.counterpart ? ' ' + candidate.counterpart : '';
  const when = targetLocal ?? 'no stated time';
  switch (candidate.kind) {
    case 'COMMITMENT':
      return pastTarget
        ? 'Commitment' + who + ': ' + candidate.subject + '. It was due ' + when + ' and no resolution is recorded.'
        : 'Commitment' + who + ': ' + candidate.subject + '. Due ' + when + '; not yet fulfilled.';
    case 'OBLIGATION':
      return 'Payment obligation' + who + ': ' + candidate.subject + (candidate.amount ? ' (' + candidate.amount + ')' : '')
        + (pastTarget ? '. It was due ' + when + ' and no payment resolving it is recorded.' : '. Due ' + when + '.');
    case 'SCHEDULED_EVENT':
      return pastTarget
        ? 'Planned for ' + when + ': ' + candidate.subject + '. Nothing recorded says whether it took place.'
        : 'Scheduled, not yet happened: ' + candidate.subject + ' at ' + when + '.';
    case 'OWNER_ASSERTION':
      return 'Your statement ' + quoted(candidate.subject) + ' is not yet verified or attached to what it is about.';
  }
}

function dominant(components: RankComponents): string {
  const named: Array<[string, number]> = [
    ['consequence', components.consequence], ['urgency', components.urgency],
    ['confidence', components.confidence], ['irreversibility', 1 - components.reversibility],
  ];
  const top = named.filter(([, value]) => value >= 0.7).map(([name]) => name);
  const listed = top.length > 1 ? top.slice(0, -1).join(', ') + ' and ' + top.at(-1) : top[0];
  return top.length > 0 ? 'Ranked for its ' + listed + ', not for when it was recorded.'
    : 'Ranked by consequence, urgency and confidence, not by when it was recorded.';
}

function whyOf(candidate: BriefingCandidate, pastTarget: boolean, hoursUntil: number | null, targetLocal: string | null,
  components: RankComponents): string {
  const reasons: string[] = [];
  if (candidate.kind === 'OWNER_ASSERTION') reasons.push('You said this recently and it is still waiting to be matched to what it is about.');
  else if (pastTarget && candidate.kind === 'SCHEDULED_EVENT') reasons.push('Its planned time (' + targetLocal + ') has passed and no outcome is recorded.');
  else if (pastTarget) reasons.push('Its due time (' + targetLocal + ') has passed and no resolution is recorded.');
  else if (hoursUntil !== null && hoursUntil <= 24) reasons.push(candidate.kind === 'SCHEDULED_EVENT' ? 'It starts within the next 24 hours.' : 'It is due within the next 24 hours.');
  else if (hoursUntil !== null) reasons.push(candidate.kind === 'SCHEDULED_EVENT' ? 'It starts within the next ' + IMMINENT_HOURS + ' hours.' : 'It is due within the next ' + IMMINENT_HOURS + ' hours.');
  if (candidate.decisionAffectingConflict) reasons.push('Sources disagree about it, which affects what to do.');
  if (candidate.ownerAssertionPending && candidate.kind !== 'OWNER_ASSERTION') reasons.push('Your own statement about it is not yet verified.');
  if (candidate.statedPriority) reasons.push('Stated priority: ' + candidate.statedPriority + '.');
  reasons.push(dominant(components));
  return reasons.join(' ');
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

const BASE_CONSEQUENCE: Readonly<Record<BriefingItemKind, number>> = Object.freeze({
  OBLIGATION: 0.7, COMMITMENT: 0.5, SCHEDULED_EVENT: 0.4, OWNER_ASSERTION: 0.4,
});
const EFFORT: Readonly<Record<BriefingItemKind, number>> = Object.freeze({
  OBLIGATION: 0.4, COMMITMENT: 0.5, SCHEDULED_EVENT: 0.2, OWNER_ASSERTION: 0.1,
});
/** How easily a missed item is undone: money moved late is the hardest. */
const REVERSIBILITY: Readonly<Record<BriefingItemKind, number>> = Object.freeze({
  OBLIGATION: 0.2, COMMITMENT: 0.5, SCHEDULED_EVENT: 0.6, OWNER_ASSERTION: 0.9,
});
const CONFIDENCE: Readonly<Partial<Record<MemoryLabel, number>>> = Object.freeze({
  CONFIRMED: 1, SCHEDULED: 0.8, COMMITTED: 0.8, REPORTED: 0.7, PENDING_OWNER_ASSERTION: 0.6, INFERRED: 0.5,
  CONTESTED: 0.4,
});
/** A stated priority is the owner's or the promisor's word, never an inference. */
const HIGH_PRIORITY = /\b(high|urgent|critical|important|asap|top)\b/i;
const LOW_PRIORITY = /\b(low|minor|whenever|someday|optional|no rush)\b/i;
/** No goal model exists before P6: every item is equally goal-relevant until one
 * does, and the component is recorded so the edition says so. */
export const GOAL_RELEVANCE_WITHOUT_GOALS = 0.5;

function round(value: number): number { return Math.round(value * 10_000) / 10_000; }

export function rankComponentsOf(candidate: BriefingCandidate, context: {
  pastTarget: boolean; hoursUntil: number | null; shownUnchanged: boolean;
}): RankComponents {
  let consequence = BASE_CONSEQUENCE[candidate.kind];
  if (candidate.statedPriority && HIGH_PRIORITY.test(candidate.statedPriority)) consequence = Math.max(consequence, 0.9);
  else if (candidate.statedPriority && LOW_PRIORITY.test(candidate.statedPriority)) consequence = Math.min(consequence, 0.2);
  if (candidate.decisionAffectingConflict) consequence = Math.min(1, consequence + 0.15);
  const urgency = context.pastTarget ? 1
    : context.hoursUntil === null ? 0.3
      : context.hoursUntil <= 24 ? 0.9 : 0.6;
  return {
    consequence: round(consequence), urgency, goalRelevance: GOAL_RELEVANCE_WITHOUT_GOALS,
    confidence: CONFIDENCE[candidate.label] ?? 0.5, effort: EFFORT[candidate.kind],
    reversibility: REVERSIBILITY[candidate.kind],
    // A repeat costs the reader attention it already spent.
    attentionBudget: context.shownUnchanged ? 0.3 : 1,
  };
}

export function scoreOf(components: RankComponents): number {
  return round(RANK_WEIGHTS.consequence * components.consequence + RANK_WEIGHTS.urgency * components.urgency
    + RANK_WEIGHTS.goalRelevance * components.goalRelevance + RANK_WEIGHTS.confidence * components.confidence
    + RANK_WEIGHTS.effort * (1 - components.effort) + RANK_WEIGHTS.reversibility * (1 - components.reversibility)
    + RANK_WEIGHTS.attentionBudget * components.attentionBudget);
}

/** HIGH by score; LOW when its consequence is low and nothing about it is
 * overdue or disputed; NORMAL otherwise. */
export function priorityOf(components: RankComponents, candidate: BriefingCandidate, pastTarget: boolean, score: number): BriefingPriority {
  if (score >= 0.7) return 'HIGH';
  if (components.consequence <= 0.3 && !pastTarget && !candidate.decisionAffectingConflict) return 'LOW';
  return 'NORMAL';
}

/** The material state an item was shown in. Wording that depends on the day
 * ("due in 20 hours") is not part of it; whether its time has passed is. */
export function materialFingerprintOf(candidate: BriefingCandidate, pastTarget: boolean): string {
  return createHash('sha256').update(canonicalJson({
    kind: candidate.kind, item: candidate.itemObjectId, outcomeState: candidate.outcomeState,
    targetTime: candidate.targetTime ? candidate.targetTime.toISOString() : null, label: candidate.label,
    conflict: candidate.decisionAffectingConflict, pending: candidate.ownerAssertionPending,
    values: [...candidate.materialValues].sort(), subject: candidate.subject, amount: candidate.amount,
    priority: candidate.statedPriority, pastTarget,
  })).digest('hex');
}

/** Rule 1: current or imminent, and material. */
export function isCurrentOrImminent(candidate: BriefingCandidate, now: Date): boolean {
  if (candidate.outcomeState === 'RESOLVED') return false;
  if (candidate.kind === 'OWNER_ASSERTION') return true;
  if (candidate.targetTime === null) return candidate.decisionAffectingConflict;
  const hours = (candidate.targetTime.getTime() - now.getTime()) / 3_600_000;
  if (hours < 0) return -hours <= PAST_TARGET_DAYS * 24;
  return hours <= IMMINENT_HOURS;
}

function recommendationFor(item: RankedItem): RankedRecommendation {
  const { candidate } = item;
  const about = quoted(candidate.subject);
  switch (candidate.kind) {
    case 'SCHEDULED_EVENT':
      return item.pastTarget
        ? { text: 'Record whether ' + about + ' took place, so it stops showing as only planned.', basedOnItemId: candidate.itemObjectId, risk: 'LOW' }
        : { text: 'Prepare for ' + about + ' before ' + item.targetLocal + '.', basedOnItemId: candidate.itemObjectId, risk: 'LOW' };
    case 'OBLIGATION':
      return item.pastTarget
        ? { text: 'Check whether ' + about + ' has been paid; if it has, record the payment.', basedOnItemId: candidate.itemObjectId, risk: 'HIGH' }
        : { text: 'Arrange the payment for ' + about + ' before ' + item.targetLocal + '.', basedOnItemId: candidate.itemObjectId, risk: 'HIGH' };
    case 'OWNER_ASSERTION':
      return { text: 'Confirm or correct your statement ' + about + ' so it can be matched.', basedOnItemId: candidate.itemObjectId, risk: 'LOW' };
    case 'COMMITMENT':
      if (candidate.decisionAffectingConflict) {
        return { text: 'Check which source is right about ' + about + ' before relying on it.', basedOnItemId: candidate.itemObjectId, risk: 'LOW' };
      }
      return item.pastTarget
        ? { text: 'Decide what happens with ' + about + ': record it as done, set a new due time, or tell the other person.', basedOnItemId: candidate.itemObjectId, risk: 'MEDIUM' }
        : { text: 'Set aside time for ' + about + ' before ' + item.targetLocal + '.', basedOnItemId: candidate.itemObjectId, risk: 'LOW' };
  }
}

/** Why a HIGH-risk recommendation may not be made on this item's memory, if it
 * may not (PRD §27: high-risk suggestions need settled, complete support). */
function withholdingReason(candidate: BriefingCandidate): WithheldRecommendationValue['reason'] | null {
  if (candidate.decisionAffectingConflict || candidate.label === 'CONTESTED') return 'SUPPORT_CONTESTED';
  if (!candidate.projectionComplete || candidate.ownerAssertionPending) return 'PROJECTION_INCOMPLETE';
  if (!candidate.supportAccepted || candidate.label !== 'CONFIRMED') return 'SUPPORT_PROVISIONAL';
  return null;
}

/**
 * Rank one day's candidates. `shownBefore` is every item shown on the
 * `REPEAT_SUPPRESSION_DAYS` owner-local dates before `localDate`.
 */
export function rankBriefing(candidates: readonly BriefingCandidate[], input: {
  now: Date; timeZone: string; localDate: string; shownBefore: readonly ShownBefore[];
}): RankedBriefing {
  const material = candidates.filter(candidate => isCurrentOrImminent(candidate, input.now));
  const scored = material.map(candidate => {
    const hoursUntil = candidate.targetTime ? (candidate.targetTime.getTime() - input.now.getTime()) / 3_600_000 : null;
    const pastTarget = hoursUntil !== null && hoursUntil < 0;
    const fingerprint = materialFingerprintOf(candidate, pastTarget);
    const earlier = input.shownBefore
      .filter(shown => shown.itemObjectType === candidate.itemObjectType && shown.itemObjectId === candidate.itemObjectId
        && shown.materialFingerprint === fingerprint)
      .filter(shown => {
        const days = dayDifference(shown.ownerLocalDate, input.localDate);
        return days >= 1 && days <= REPEAT_SUPPRESSION_DAYS;
      })
      .map(shown => shown.ownerLocalDate).sort();
    const lastShownOn = earlier.at(-1) ?? null;
    const components = rankComponentsOf(candidate, { pastTarget, hoursUntil, shownUnchanged: lastShownOn !== null });
    const score = scoreOf(components);
    const priority = priorityOf(components, candidate, pastTarget, score);
    const targetLocal = candidate.targetTime ? formatLocal(candidate.targetTime, input.timeZone) : null;
    return {
      candidate, pastTarget, hoursUntil, fingerprint, lastShownOn, components, score, priority, targetLocal,
      headline: headlineOf(candidate, pastTarget, targetLocal),
      whySurfaced: whyOf(candidate, pastTarget, hoursUntil, targetLocal, components),
    };
  });
  // The order: score, then an item whose time has passed, then the sooner target,
  // then the identifier -- so equal scores still order the same way every run.
  // No recording time appears anywhere in it (CRT-UX-02-A).
  scored.sort((left, right) => right.score - left.score
    || Number(right.pastTarget) - Number(left.pastTarget)
    || (left.candidate.targetTime?.getTime() ?? Number.MAX_SAFE_INTEGER) - (right.candidate.targetTime?.getTime() ?? Number.MAX_SAFE_INTEGER)
    || left.candidate.itemObjectId.localeCompare(right.candidate.itemObjectId));

  const perSection = new Map<BriefingDomain, number>();
  let shown = 0;
  const items: RankedItem[] = scored.map(entry => {
    let presentation: RankedItem['presentation'] = 'SHOWN';
    if (entry.priority === 'LOW' && entry.lastShownOn !== null) presentation = 'SUPPRESSED_UNCHANGED';
    else if (shown >= MAX_ITEMS_SHOWN || (perSection.get(entry.candidate.domainSection) ?? 0) >= MAX_ITEMS_PER_SECTION) {
      presentation = 'DEFERRED_BY_ATTENTION_BUDGET';
    }
    let rankPosition: number | null = null;
    if (presentation === 'SHOWN') {
      shown += 1; rankPosition = shown;
      perSection.set(entry.candidate.domainSection, (perSection.get(entry.candidate.domainSection) ?? 0) + 1);
    }
    return {
      candidate: entry.candidate, headline: entry.headline, whySurfaced: entry.whySurfaced, targetLocal: entry.targetLocal,
      pastTarget: entry.pastTarget, components: entry.components, score: entry.score, priority: entry.priority,
      materialFingerprint: entry.fingerprint, presentation, rankPosition,
      lastShownOn: presentation === 'SUPPRESSED_UNCHANGED' ? entry.lastShownOn : null,
    };
  });

  const recommendations: RankedRecommendation[] = [];
  const withheldRecommendations: WithheldRecommendationValue[] = [];
  for (const item of items.filter(entry => entry.presentation === 'SHOWN')) {
    if (recommendations.length >= MAX_RECOMMENDATIONS) break;
    const recommendation = recommendationFor(item);
    if (recommendation.risk === 'HIGH') {
      const reason = withholdingReason(item.candidate);
      if (reason) { withheldRecommendations.push({ basedOnItemId: item.candidate.itemObjectId, risk: 'HIGH', reason }); continue; }
    }
    recommendations.push(recommendation);
  }
  return { items, recommendations, withheldRecommendations };
}
