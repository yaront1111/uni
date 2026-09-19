import {
  reviewSectionSchema, reviewStatementSchema,
  type CertaintyLabel, type ContextBelief, type ContextPacket, type LifeCategory, type ReviewGround,
  type ReviewManifest, type ReviewSection, type ReviewStatement,
} from '@unai/domain';
import { suppliedContextOf } from '@unai/context';
import { describeValue } from './ambiguities.js';
import { repeatedPostponementObservation, OBSERVATION_WINDOW_DAYS, type ObservationDraft } from './observations.js';
import { DAY_MS, ownerLocalDate } from './time.js';

/**
 * The weekly review (PRD §7.5, §39; design GET /v1/weekly-review and entity
 * `weekly_reviews`; ADR 0028 §7).
 *
 * Pure: one persisted Context Broker packet and the owner-local week in, the
 * review's sections out. Every statement is composed by code from the packet
 * and names the packet objects it rests on; `checkGrounds` then holds each of
 * them against the manifest of the packet as persisted. Nothing here calls a
 * model, reads a clock or sums money.
 */

export const WEEKLY_REVIEW_VERSION = 'weekly-review-0.1.0';

export interface ReviewWeek {
  readonly weekStart: string;
  readonly weekEnd: string;
  readonly timeZone: string;
  /** The first instant of the week and the first instant after it. */
  readonly from: Date;
  readonly to: Date;
}

export interface ComposedWeeklyReview {
  readonly priorityVersusCalendar: ReviewSection & { allocation: Array<{ lifeCategory: LifeCategory; scheduledMinutes: number;
    eventCount: number; highPriorityCommitments: number; statedPriorityCommitments: number }> };
  readonly commitmentsVersusResolutions: ReviewSection & { openCount: number; slippingCount: number; completedCount: number };
  readonly decisionsVersusOutcomes: ReviewSection;
  readonly plannedVersusObservedSpending: ReviewSection;
  readonly materialChanges: ReviewSection;
  readonly repeatedPostponement: ReviewSection & { episodeCount: number };
  readonly observations: readonly ObservationDraft[];
}

const SPECIFIC_CATEGORIES: readonly LifeCategory[] = ['FINANCE', 'FAMILY', 'WORK', 'HEALTH', 'ADMIN'];
const primaryCategory = (categories: readonly LifeCategory[]): LifeCategory =>
  SPECIFIC_CATEGORIES.find(category => categories.includes(category)) ?? 'PERSONAL';
const CATEGORY_WORDS: Readonly<Record<LifeCategory, string>> = Object.freeze({
  FINANCE: 'Finance', FAMILY: 'Family', WORK: 'Work', HEALTH: 'Health', ADMIN: 'Administration', PERSONAL: 'Personal',
});
const HIGH_PRIORITY = /\b(high|urgent|critical|important|top|asap)\b/i;
const CLOSING_OUTCOMES = new Set(['FULFILLED', 'PARTIALLY_FULFILLED', 'WAIVED', 'CANCELLED', 'WITHDRAWN']);
const COMPLETING_OUTCOMES = new Set(['FULFILLED', 'PARTIALLY_FULFILLED']);
const STANDING_RESOLUTIONS = new Set(['ACCEPTED', 'PROPOSED']);
const MATERIAL_PREDICATES = new Set(['shared.obligation.principal_amount', 'shared.obligation.due_time',
  'shared.commitment.action_description', 'shared.commitment.due_time', 'shared.commitment.priority',
  'finance.payment_allocation.allocated_amount']);

type Item = { propositionId: string; frameInstanceId: string; frameTypeId: string; predicateId: string; normalizedValue?: unknown;
  validFrom?: string | null | undefined; lifeCategories: LifeCategory[]; evidenceIds?: string[] | undefined };

function timeOf(value: unknown): { start: Date | null; end: Date | null } {
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
const inWeek = (time: Date | null, week: ReviewWeek) =>
  time !== null && time.getTime() >= week.from.getTime() && time.getTime() < week.to.getTime();

function textOf(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'object' && value !== null) {
    for (const key of ['text', 'description', 'value']) {
      const candidate = (value as Record<string, unknown>)[key];
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    }
  }
  return null;
}

/** The current statement of one predicate per frame: the one stated last. */
function latestPerFrame(items: readonly Item[]): Map<string, Item> {
  const latest = new Map<string, Item>();
  for (const item of items) {
    const current = latest.get(item.frameInstanceId);
    const stated = item.validFrom ? Date.parse(item.validFrom) : 0;
    const currentStated = current?.validFrom ? Date.parse(current.validFrom) : 0;
    if (!current || stated > currentStated || (stated === currentStated && item.propositionId > current.propositionId)) {
      latest.set(item.frameInstanceId, item);
    }
  }
  return latest;
}

function labelOf(belief: ContextBelief): CertaintyLabel {
  return belief.certainty === 'ACCEPTED' ? 'CONFIRMED' : belief.certainty === 'CONTESTED' ? 'CONFLICTING' : 'REPORTED';
}

const hours = (minutes: number) => {
  const tenths = Math.round(minutes / 6);
  return (tenths % 10 === 0 ? String(tenths / 10) : (tenths / 10).toFixed(1)) + (tenths === 10 ? ' hour' : ' hours');
};

class Statements {
  private readonly list: ReviewStatement[] = [];
  constructor(private readonly prefix: string) {}
  add(text: string, label: CertaintyLabel, lifeCategory: LifeCategory | null, grounds: readonly ReviewGround[]): void {
    const unique = grounds.filter((ground, index) => grounds.findIndex(other => other.objectId === ground.objectId
      && other.objectType === ground.objectType) === index);
    this.list.push(reviewStatementSchema.parse({
      statementId: this.prefix + '-' + (this.list.length + 1), text: text.slice(0, 600), label, lifeCategory, grounds: unique.slice(0, 64),
    }));
  }
  section(emptyNote: string): ReviewSection {
    return reviewSectionSchema.parse(this.list.length === 0
      ? { availability: 'NO_MATCHING_MEMORY', note: emptyNote, statements: [] }
      : { availability: 'AVAILABLE', note: null, statements: this.list });
  }
}

const proposition = (objectId: string): ReviewGround => ({ objectType: 'proposition', objectId });
const frame = (objectId: string): ReviewGround => ({ objectType: 'frame_instance', objectId });

export function composeWeeklyReview(packet: ContextPacket, week: ReviewWeek): ComposedWeeklyReview {
  const day = (time: Date) => ownerLocalDate(time, week.timeZone);
  const future: Item[] = packet.futureClaims.map(claim => ({ ...claim }));
  const beliefs: Item[] = [...packet.currentBeliefs, ...packet.historicalBeliefs].map(belief => ({ ...belief }));
  const all = [...future, ...beliefs];
  const byPredicate = (predicateId: string) => all.filter(item => item.predicateId === predicateId);
  const actions = latestPerFrame(byPredicate('shared.commitment.action_description'));
  const actionText = (frameInstanceId: string) => {
    const action = actions.get(frameInstanceId);
    return action ? '"' + (textOf(action.normalizedValue) ?? describeValue(action.normalizedValue)) + '"' : 'a commitment';
  };
  const actionGround = (frameInstanceId: string): ReviewGround[] => {
    const action = actions.get(frameInstanceId);
    return action ? [proposition(action.propositionId)] : [];
  };

  // ---- Stated priorities versus calendar allocation --------------------------
  const priorities = [...latestPerFrame(byPredicate('shared.commitment.priority')).values()];
  const events = [...latestPerFrame(byPredicate('shared.event_occurrence.occurrence_time')).values()]
    .map(item => ({ item, time: timeOf(item.normalizedValue) }))
    .filter(({ time }) => inWeek(time.start, week) || inWeek(time.end, week));
  const allocation = new Map<LifeCategory, { minutes: number; events: typeof events; high: Item[]; stated: Item[] }>();
  const slot = (category: LifeCategory) => {
    if (!allocation.has(category)) allocation.set(category, { minutes: 0, events: [], high: [], stated: [] });
    return allocation.get(category)!;
  };
  for (const event of events) {
    const start = Math.max(event.time.start?.getTime() ?? week.from.getTime(), week.from.getTime());
    const end = Math.min(event.time.end?.getTime() ?? start, week.to.getTime());
    const entry = slot(primaryCategory(event.item.lifeCategories));
    entry.minutes += Math.max(0, Math.round((end - start) / 60_000));
    entry.events.push(event);
  }
  for (const priority of priorities) {
    const entry = slot(primaryCategory(priority.lifeCategories));
    entry.stated.push(priority);
    if (HIGH_PRIORITY.test(textOf(priority.normalizedValue) ?? '')) entry.high.push(priority);
  }
  const totalMinutes = [...allocation.values()].reduce((sum, entry) => sum + entry.minutes, 0);
  const priorityStatements = new Statements('priority');
  const categories = [...allocation.keys()].sort();
  for (const category of categories) {
    const entry = allocation.get(category)!;
    if (entry.high.length === 0) continue;
    const share = totalMinutes === 0 ? 0 : Math.round((entry.minutes / totalMinutes) * 100);
    const named = entry.high.slice(0, 3).map(item => actionText(item.frameInstanceId)).join(', ');
    priorityStatements.add(CATEGORY_WORDS[category] + ': you stated ' + entry.high.length + ' high-priority '
      + (entry.high.length === 1 ? 'commitment' : 'commitments') + ' (' + named + '), and ' + hours(entry.minutes) + ' of the '
      + hours(totalMinutes) + ' scheduled this week (' + share + '%) went to ' + CATEGORY_WORDS[category].toLowerCase() + '.',
      'INFERRED', category, [
        ...entry.high.flatMap(item => [proposition(item.propositionId), frame(item.frameInstanceId), ...actionGround(item.frameInstanceId)]),
        ...entry.events.flatMap(event => [proposition(event.item.propositionId)]),
      ]);
  }
  if (events.length > 0) {
    priorityStatements.add('Scheduled this week: ' + categories.filter(category => allocation.get(category)!.events.length > 0)
      .map(category => CATEGORY_WORDS[category] + ' ' + hours(allocation.get(category)!.minutes) + ' across '
        + allocation.get(category)!.events.length + (allocation.get(category)!.events.length === 1 ? ' event' : ' events'))
      .join('; ') + '.', 'SCHEDULED', null, events.map(event => proposition(event.item.propositionId)));
  }
  const unscheduled = categories.filter(category => allocation.get(category)!.stated.length > 0 && allocation.get(category)!.minutes === 0
    && allocation.get(category)!.high.length === 0);
  for (const category of unscheduled) {
    const entry = allocation.get(category)!;
    priorityStatements.add(CATEGORY_WORDS[category] + ': ' + entry.stated.length + ' commitment'
      + (entry.stated.length === 1 ? ' has' : 's have') + ' a stated priority and no time was scheduled for '
      + CATEGORY_WORDS[category].toLowerCase() + ' this week.', 'INFERRED', category,
    entry.stated.flatMap(item => [proposition(item.propositionId), frame(item.frameInstanceId)]));
  }
  const priorityVersusCalendar = {
    ...priorityStatements.section('No stated priority and no scheduled event fall in this week.'),
    allocation: categories.map(category => ({
      lifeCategory: category, scheduledMinutes: allocation.get(category)!.minutes, eventCount: allocation.get(category)!.events.length,
      highPriorityCommitments: allocation.get(category)!.high.length, statedPriorityCommitments: allocation.get(category)!.stated.length,
    })),
  };

  // ---- Open commitments versus completed resolutions -------------------------
  const commitmentFrames = new Set(all.filter(item => item.frameTypeId === 'shared.commitment').map(item => item.frameInstanceId));
  const resolutions = packet.resolutionAssertions.filter(resolution => STANDING_RESOLUTIONS.has(resolution.lifecycle)
    && commitmentFrames.has(resolution.sourceFrameInstanceId) && Date.parse(resolution.effectiveAt) < week.to.getTime());
  const closed = new Set(resolutions.filter(resolution => CLOSING_OUTCOMES.has(resolution.outcomeCode))
    .map(resolution => resolution.sourceFrameInstanceId));
  const completed = resolutions.filter(resolution => COMPLETING_OUTCOMES.has(resolution.outcomeCode)
    && inWeek(new Date(resolution.effectiveAt), week));
  const dues = latestPerFrame(byPredicate('shared.commitment.due_time'));
  const open = [...commitmentFrames].filter(frameId => !closed.has(frameId)).sort();
  const slipping = open.filter(frameId => {
    const due = timeOf(dues.get(frameId)?.normalizedValue).start;
    return due !== null && due.getTime() < week.to.getTime() && due.getTime() >= week.from.getTime();
  });
  const commitmentStatements = new Statements('commitments');
  for (const resolution of completed) {
    commitmentStatements.add('Completed: ' + actionText(resolution.sourceFrameInstanceId) + ' ('
      + resolution.outcomeCode.toLowerCase().replaceAll('_', ' ') + ' on ' + day(new Date(resolution.effectiveAt)) + ').',
    resolution.lifecycle === 'ACCEPTED' ? 'CONFIRMED' : 'REPORTED', null,
    [{ objectType: 'resolution_assertion', objectId: resolution.resolutionAssertionId }, frame(resolution.sourceFrameInstanceId),
      ...actionGround(resolution.sourceFrameInstanceId)]);
  }
  for (const frameId of slipping) {
    const due = dues.get(frameId)!;
    commitmentStatements.add('Slipping: ' + actionText(frameId) + ' was due ' + day(timeOf(due.normalizedValue).start!)
      + ' and has no recorded outcome.', 'COMMITTED', null, [frame(frameId), proposition(due.propositionId), ...actionGround(frameId)]);
  }
  if (commitmentFrames.size > 0) {
    commitmentStatements.add(completed.length + (completed.length === 1 ? ' commitment was' : ' commitments were')
      + ' completed this week; ' + open.length + (open.length === 1 ? ' remains' : ' remain') + ' open, '
      + slipping.length + ' of them past a due time inside the week.', 'INFERRED', null,
    [...completed.map(resolution => ({ objectType: 'resolution_assertion' as const, objectId: resolution.resolutionAssertionId })),
      ...open.map(frame)]);
  }
  const commitmentsVersusResolutions = {
    ...commitmentStatements.section('No commitment is recorded.'),
    openCount: open.length, slippingCount: slipping.length, completedCount: completed.length,
  };

  // ---- Decisions versus outcomes ----------------------------------------------
  // The decision frame arrives with registry release 0.2.0 (P6). Until then there
  // is nothing to compare and nothing is invented.
  const decisionsVersusOutcomes = reviewSectionSchema.parse({
    availability: 'NOT_AVAILABLE_IN_THIS_RELEASE',
    note: 'Decision records arrive with the Decisions workspace; no decision is compared here yet.', statements: [],
  });

  // ---- Planned versus observed spending ---------------------------------------
  const spending = new Statements('spending');
  const principals = latestPerFrame(byPredicate('shared.obligation.principal_amount'));
  const obligationDues = latestPerFrame(byPredicate('shared.obligation.due_time'));
  const beliefById = new Map([...packet.currentBeliefs, ...packet.historicalBeliefs].map(belief => [belief.propositionId, belief]));
  const planned = [...obligationDues.values()].filter(due => inWeek(timeOf(due.normalizedValue).start, week) && principals.has(due.frameInstanceId));
  for (const due of planned) {
    const principal = principals.get(due.frameInstanceId)!;
    const belief = beliefById.get(principal.propositionId);
    spending.add('Planned: ' + describeValue(principal.normalizedValue) + ' due ' + day(timeOf(due.normalizedValue).start!) + '.',
      belief ? labelOf(belief) : 'REPORTED', 'FINANCE',
      [proposition(principal.propositionId), proposition(due.propositionId), frame(due.frameInstanceId)]);
  }
  const observed = packet.currentBeliefs.filter(belief => belief.predicateId === 'finance.payment_allocation.allocated_amount'
    && inWeek(belief.validFrom ? new Date(belief.validFrom) : null, week));
  for (const belief of observed) {
    spending.add('Observed: ' + describeValue(belief.normalizedValue) + ' allocated to an obligation on '
      + day(new Date(belief.validFrom!)) + '.', labelOf(belief), 'FINANCE', [proposition(belief.propositionId), frame(belief.frameInstanceId)]);
  }
  if (planned.length > 0 || observed.length > 0) {
    spending.add(planned.length + ' planned ' + (planned.length === 1 ? 'payment was' : 'payments were') + ' due this week and '
      + observed.length + ' payment ' + (observed.length === 1 ? 'allocation was' : 'allocations were')
      + ' observed; the amounts are listed as recorded and are not added up here.', 'INFERRED', 'FINANCE',
    [...planned.map(due => proposition(due.propositionId)), ...observed.map(belief => proposition(belief.propositionId))]);
  }
  const plannedVersusObservedSpending = spending.section('No payment was due and none was observed this week.');

  // ---- Material changes --------------------------------------------------------
  const changes = new Statements('changes');
  const words = (predicateId: string) => predicateId.split('.').slice(1).join(' ').replaceAll('_', ' ');
  const changed = packet.historicalBeliefs.filter(belief => MATERIAL_PREDICATES.has(belief.predicateId)
    && inWeek(belief.validTo ? new Date(belief.validTo) : null, week))
    .sort((left, right) => primaryCategory(left.lifeCategories).localeCompare(primaryCategory(right.lifeCategories))
      || left.propositionId.localeCompare(right.propositionId));
  for (const old of changed) {
    const now = packet.currentBeliefs.find(belief => belief.beliefSlotId === old.beliefSlotId);
    changes.add('Changed (' + CATEGORY_WORDS[primaryCategory(old.lifeCategories)] + '): the ' + words(old.predicateId) + ' was '
      + describeValue(old.normalizedValue) + ' until ' + day(new Date(old.validTo!))
      + (now ? ' and is now ' + describeValue(now.normalizedValue) : '') + '.', now ? labelOf(now) : labelOf(old),
    primaryCategory(old.lifeCategories), [proposition(old.propositionId), ...(now ? [proposition(now.propositionId)] : []), frame(old.frameInstanceId)]);
  }
  const replaced = new Set(changed.map(old => old.beliefSlotId));
  const added = packet.currentBeliefs.filter(belief => MATERIAL_PREDICATES.has(belief.predicateId) && !replaced.has(belief.beliefSlotId)
    && inWeek(belief.validFrom ? new Date(belief.validFrom) : null, week))
    .sort((left, right) => primaryCategory(left.lifeCategories).localeCompare(primaryCategory(right.lifeCategories))
      || left.propositionId.localeCompare(right.propositionId));
  for (const belief of added) {
    changes.add('New (' + CATEGORY_WORDS[primaryCategory(belief.lifeCategories)] + '): the ' + words(belief.predicateId) + ' '
      + describeValue(belief.normalizedValue) + ' from ' + day(new Date(belief.validFrom!)) + '.', labelOf(belief),
    primaryCategory(belief.lifeCategories), [proposition(belief.propositionId), frame(belief.frameInstanceId)]);
  }
  for (const delta of packet.ownerOverlayDeltas.filter(delta => (delta.deltaKind === 'USER_CORRECTION' || delta.deltaKind === 'USER_STATE_CHANGE')
    && inWeek(new Date(delta.createdAt), week))) {
    changes.add('You recorded a ' + (delta.deltaKind === 'USER_CORRECTION' ? 'correction' : 'change') + ': "'
      + delta.rawText.slice(0, 200) + '" (' + day(new Date(delta.createdAt)) + ').', 'REPORTED', null,
    [{ objectType: 'owner_overlay_delta', objectId: delta.overlayDeltaId }]);
  }
  const materialChanges = changes.section('No material change was recorded this week.');

  // ---- Repeated postponement and the observation it may support ---------------
  const window = { from: new Date(week.to.getTime() - OBSERVATION_WINDOW_DAYS * DAY_MS), to: week.to };
  const { episodes, observation } = repeatedPostponementObservation(packet, { window, timeZone: week.timeZone });
  const postponement = new Statements('postponement');
  for (const episode of episodes) {
    postponement.add('Postponed: ' + actionText(episode.frameInstanceId) + ' moved from ' + day(new Date(episode.previousDueAt))
      + ' to ' + day(new Date(episode.newDueAt)) + ' (restated ' + day(new Date(episode.restatedAt)) + ').', 'COMMITTED', null,
    [proposition(episode.episodeId), proposition(episode.previousPropositionId), frame(episode.frameInstanceId),
      ...actionGround(episode.frameInstanceId)]);
  }
  const repeatedPostponement = {
    ...postponement.section('No due date was moved later in the ' + OBSERVATION_WINDOW_DAYS + ' days to the end of this week.'),
    episodeCount: episodes.length,
  };

  return {
    priorityVersusCalendar, commitmentsVersusResolutions, decisionsVersusOutcomes, plannedVersusObservedSpending,
    materialChanges, repeatedPostponement, observations: observation ? [observation] : [],
  };
}

/** The objects one persisted packet supplied: the answer manifest's four sets
 * (`suppliedContextOf`, ADR 0026 §1) plus the frames and outcomes it named. */
export function reviewManifestOf(packet: ContextPacket, options: { registryReleaseId: string | null }): ReviewManifest {
  const supplied = suppliedContextOf(packet, options);
  const withheld = new Set(packet.redactions.filter(redaction => redaction.fields.length === 0).map(redaction => redaction.objectId));
  const frames = new Set<string>();
  for (const item of [...packet.currentBeliefs, ...packet.historicalBeliefs, ...packet.futureClaims]) frames.add(item.frameInstanceId);
  for (const conflict of packet.conflicts) frames.add(conflict.frameInstanceId);
  for (const resolution of packet.resolutionAssertions) {
    frames.add(resolution.sourceFrameInstanceId);
    if (resolution.targetFrameInstanceId) frames.add(resolution.targetFrameInstanceId);
  }
  for (const fragment of packet.projectionFragments) for (const id of fragment.frameInstanceIds) frames.add(id);
  return {
    packetId: packet.packetId, packetHash: packet.packetHash,
    beliefIds: supplied.beliefIds, claimIds: supplied.claimIds, evidenceIds: supplied.evidenceIds,
    overlayDeltaIds: supplied.overlayDeltaIds,
    frameInstanceIds: [...frames].filter(id => !withheld.has(id)).sort(),
    resolutionAssertionIds: packet.resolutionAssertions.map(resolution => resolution.resolutionAssertionId)
      .filter(id => !withheld.has(id)).sort(),
  };
}

const MANIFEST_SET: Readonly<Record<ReviewGround['objectType'], keyof Omit<ReviewManifest, 'packetId' | 'packetHash'>>> = Object.freeze({
  proposition: 'beliefIds', claim: 'claimIds', source_item: 'evidenceIds', owner_overlay_delta: 'overlayDeltaIds',
  frame_instance: 'frameInstanceIds', resolution_assertion: 'resolutionAssertionIds',
});

/** Every ground of every statement that the manifest does not hold. Empty is the
 * only answer under which a review may be stored (ADR 0028 §7). */
export function ungroundedStatements(statements: ReadonlyArray<{ statementId: string; grounds: readonly ReviewGround[] }>,
  manifest: ReviewManifest): Array<{ statementId: string; ground: ReviewGround }> {
  const sets = Object.fromEntries(Object.entries(MANIFEST_SET).map(([type, key]) => [type, new Set(manifest[key])])) as
    Record<ReviewGround['objectType'], Set<string>>;
  return statements.flatMap(statement => statement.grounds
    .filter(ground => !sets[ground.objectType].has(ground.objectId))
    .map(ground => ({ statementId: statement.statementId, ground })));
}

/** Every statement of a composed review, observations included, for the check. */
export function statementsOf(review: ComposedWeeklyReview): Array<{ statementId: string; grounds: readonly ReviewGround[] }> {
  return [
    ...review.priorityVersusCalendar.statements, ...review.commitmentsVersusResolutions.statements,
    ...review.decisionsVersusOutcomes.statements, ...review.plannedVersusObservedSpending.statements,
    ...review.materialChanges.statements, ...review.repeatedPostponement.statements,
    ...review.observations.map((observation, index) => ({ statementId: 'observation-' + (index + 1), grounds: observation.grounds })),
  ];
}
