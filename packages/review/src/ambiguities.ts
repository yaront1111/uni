import {
  ambiguitySchema, cardChoiceSchema, sensitivityScopeSchema,
  type Ambiguity, type AmbiguityKind, type CardChoice, type ContextBelief, type ContextPacket, type LifeCategory,
} from '@unai/domain';

/**
 * Ambiguities and the cards that group them (PRD §19.2 BATCH_REVIEW, §19.3,
 * §37.4; ADR 0029 §1-§3).
 *
 * Pure: a Context Broker packet and the situation each of its frames belongs to
 * go in, card drafts come out. No transaction, no clock (the instant is a
 * parameter), no model. Every word on a card is composed here from the packet,
 * so a card can only say what the packet supplied.
 */

export const CARD_COMPOSER_VERSION = 'clarification-cards-0.1.0';

/** Where one frame sits: the memory thread it belongs to, else itself. */
export interface Situation {
  readonly situationKey: string;
  readonly title: string | null;
}

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';
export interface CardRisk {
  readonly errorProbability: number;
  readonly consequence: RiskLevel;
  readonly irreversibility: 'REVERSIBLE' | 'COSTLY_TO_REVERSE' | 'IRREVERSIBLE';
  readonly urgency: RiskLevel;
  readonly interruptionCost: RiskLevel;
}

/** What a learned rule can match a card on (ADR 0029 §6): the situation kind and
 * an exact text, such as a transfer memo. */
export interface RuleBasis {
  readonly situationKind: 'REPAYMENT' | 'GENERAL';
  readonly matchText: string;
}

export interface CardDraft {
  readonly situationKey: string;
  readonly situationKind: 'REPAYMENT' | 'GENERAL';
  readonly title: string;
  readonly facts: readonly string[];
  readonly whyItMatters: string;
  readonly choices: readonly CardChoice[];
  readonly ambiguities: readonly Ambiguity[];
  readonly groupedAmbiguityIds: readonly string[];
  readonly sensitivityScope: string;
  readonly evidenceIds: readonly string[];
  readonly risk: CardRisk;
  readonly ruleBasis: RuleBasis | null;
}

const ERROR_PROBABILITY: Readonly<Record<AmbiguityKind, number>> = Object.freeze({
  CONFLICTING_VALUES: 0.5, CONTESTED_BELIEF: 0.5, UNCONFIRMED_INTERPRETATION: 0.4,
});
const LEVEL_ORDER: readonly RiskLevel[] = ['LOW', 'MEDIUM', 'HIGH'];
const strongest = (levels: readonly RiskLevel[]): RiskLevel =>
  levels.reduce<RiskLevel>((best, level) => LEVEL_ORDER.indexOf(level) > LEVEL_ORDER.indexOf(best) ? level : best, 'LOW');
const SENSITIVITY_ORDER = ['NORMAL', 'PRIVATE', 'RESTRICTED'] as const;
/** The categories more specific than PERSONAL, in the order a scope names them. */
const SPECIFIC_CATEGORIES: readonly LifeCategory[] = ['FINANCE', 'FAMILY', 'WORK', 'HEALTH', 'ADMIN'];
const MONEY_FRAMES = new Set(['shared.obligation', 'finance.payment_allocation']);
const ALLOCATION_AMOUNT = 'finance.payment_allocation.allocated_amount';
const OBLIGATION_PRINCIPAL = 'shared.obligation.principal_amount';
const EVENT_DESCRIPTION = 'shared.event_occurrence.description';
const EVENT_PARTICIPANTS = 'shared.event_occurrence.participants';
const DUE_PREDICATES = new Set(['shared.commitment.due_time', 'shared.obligation.due_time']);
/** The owner's own decisions on a value: once recorded, the value is not asked
 * about again, even before the governor commits what they decided. */
const DECIDING_DELTAS = new Set(['USER_CONFIRMATION', 'USER_REJECTION']);

const CURRENCY_SIGNS: Readonly<Record<string, string>> = Object.freeze({ ILS: '₪', USD: '$', EUR: '€', GBP: '£' });

/** A stored value in words. Money is stated exactly as recorded, with trailing
 * zero minor units dropped from the text only: nothing here does arithmetic. */
export function describeValue(value: unknown): string {
  if (value === null || value === undefined) return 'no value';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record['amount'] === 'string' && typeof record['currency'] === 'string') {
      const amount = /^\d+\.0+$/.test(record['amount']) ? record['amount'].split('.')[0]! : record['amount'];
      const sign = CURRENCY_SIGNS[record['currency']];
      return sign ? sign + amount : record['currency'] + ' ' + amount;
    }
    for (const key of ['text', 'description', 'label', 'value', 'time', 'start']) {
      if (typeof record[key] === 'string') return record[key] as string;
    }
    if (typeof record['entityId'] === 'string') return 'a participant';
  }
  return 'a recorded value';
}

/** "shared.commitment.due_time" -> "commitment due time". */
export function describeContract(predicateId: string): string {
  const [, frame = '', predicate = ''] = /^[a-z_]+\.([a-z_]+)\.([a-z_]+)$/.exec(predicateId) ?? [];
  return [frame, predicate].filter(part => part.length > 0).join(' ').replaceAll('_', ' ') || 'a recorded value';
}

function sortedUnique(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort();
}

/**
 * The ambiguities one packet holds (ADR 0029 §1). A conflict's propositions are
 * one ambiguity, so the same values are never also counted as contested
 * singles. A value the owner already confirmed or rejected is not an ambiguity
 * any more, whatever its assessment still says.
 */
export function collectAmbiguities(packet: ContextPacket): Ambiguity[] {
  const decided = new Set(packet.ownerOverlayDeltas
    .filter(delta => DECIDING_DELTAS.has(delta.deltaKind) && delta.lifecycle !== 'WITHDRAWN'
      && delta.target?.objectType === 'proposition')
    .map(delta => delta.target!.objectId));
  const beliefs = [...packet.currentBeliefs, ...packet.historicalBeliefs];
  const frameTypes = new Map(beliefs.map(belief => [belief.frameInstanceId, belief.frameTypeId]));
  const ambiguities: Ambiguity[] = [];
  const inConflict = new Set<string>();

  for (const conflict of packet.conflicts) {
    const propositionIds = conflict.positions.map(position => position.propositionId);
    if (propositionIds.every(id => decided.has(id))) continue;
    for (const id of propositionIds) inConflict.add(id);
    const values = conflict.positions.map(position => describeValue(position.normalizedValue));
    ambiguities.push(ambiguitySchema.parse({
      ambiguityId: conflict.beliefSlotId, kind: 'CONFLICTING_VALUES', frameInstanceId: conflict.frameInstanceId,
      frameTypeId: frameTypes.get(conflict.frameInstanceId) ?? conflict.predicateId.split('.').slice(0, 2).join('.'),
      predicateId: conflict.predicateId, propositionIds: [...propositionIds].sort(),
      evidenceIds: sortedUnique(conflict.positions.flatMap(position => position.evidenceIds ?? [])),
      detail: ('Two or more values are recorded for ' + describeContract(conflict.predicateId) + ': ' + values.join(', ') + '.').slice(0, 500),
    }));
  }
  for (const belief of packet.currentBeliefs) {
    if (inConflict.has(belief.propositionId) || decided.has(belief.propositionId)) continue;
    const kind: AmbiguityKind | null = belief.assessmentStatus === 'CANDIDATE' ? 'UNCONFIRMED_INTERPRETATION'
      : belief.assessmentStatus === 'CONTESTED' ? 'CONTESTED_BELIEF' : null;
    if (kind === null) continue;
    const words = describeContract(belief.predicateId);
    const value = describeValue(belief.normalizedValue);
    ambiguities.push(ambiguitySchema.parse({
      ambiguityId: belief.propositionId, kind, frameInstanceId: belief.frameInstanceId, frameTypeId: belief.frameTypeId,
      predicateId: belief.predicateId, propositionIds: [belief.propositionId], evidenceIds: sortedUnique(belief.evidenceIds ?? []),
      detail: (kind === 'UNCONFIRMED_INTERPRETATION'
        ? 'The ' + words + ' "' + value + '" is not confirmed.'
        : 'The ' + words + ' "' + value + '" is contested.').slice(0, 500),
    }));
  }
  return ambiguities.sort((left, right) => left.ambiguityId.localeCompare(right.ambiguityId));
}

function situationOf(situations: ReadonlyMap<string, Situation>, frameInstanceId: string): Situation {
  return situations.get(frameInstanceId) ?? { situationKey: 'frame:' + frameInstanceId, title: null };
}

function scopeOf(packet: ContextPacket, frameIds: ReadonlySet<string>, evidenceIds: readonly string[]): string {
  const categories = new Set<LifeCategory>();
  for (const belief of [...packet.currentBeliefs, ...packet.historicalBeliefs]) {
    if (frameIds.has(belief.frameInstanceId)) for (const category of belief.lifeCategories) categories.add(category);
  }
  for (const claim of packet.futureClaims) {
    if (frameIds.has(claim.frameInstanceId)) for (const category of claim.lifeCategories) categories.add(category);
  }
  const category = SPECIFIC_CATEGORIES.find(candidate => categories.has(candidate)) ?? 'PERSONAL';
  const sensitivities = packet.evidenceRefs
    .filter(reference => evidenceIds.includes(reference.evidenceId)).map(reference => reference.sensitivity);
  // Evidence the packet did not describe is read as private rather than normal:
  // an unknown ceiling is never assumed to be the lowest one.
  const sensitivity = sensitivities.length === 0 ? 'PRIVATE'
    : sensitivities.reduce((most, level) =>
      SENSITIVITY_ORDER.indexOf(level) > SENSITIVITY_ORDER.indexOf(most) ? level : most, 'NORMAL' as typeof SENSITIVITY_ORDER[number]);
  return sensitivityScopeSchema.parse(category + '/' + sensitivity);
}

function textOf(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    for (const key of ['text', 'description', 'value']) if (typeof record[key] === 'string' && (record[key] as string).trim()) return (record[key] as string).trim();
  }
  return null;
}

function dueInstant(value: unknown): Date | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const raw = record['time'] ?? record['start'] ?? record['end'];
  if (typeof raw !== 'string') return null;
  const time = new Date(raw);
  return Number.isNaN(time.getTime()) ? null : time;
}

function riskOf(packet: ContextPacket, ambiguities: readonly Ambiguity[], frameIds: ReadonlySet<string>,
  scope: string, now: Date): CardRisk {
  const money = ambiguities.some(ambiguity => MONEY_FRAMES.has(ambiguity.frameTypeId)
    || ambiguity.frameTypeId.startsWith('finance.')) || scope.startsWith('FINANCE/');
  const commitment = ambiguities.some(ambiguity => ambiguity.frameTypeId === 'shared.commitment');
  // Urgency comes from the situation's own due times: a question about something
  // due within days is worth more now than one due in a month (PRD §19.4).
  const dues = [...packet.currentBeliefs, ...packet.futureClaims]
    .filter(item => frameIds.has(item.frameInstanceId) && DUE_PREDICATES.has(item.predicateId))
    .map(item => dueInstant(item.normalizedValue)).filter((time): time is Date => time !== null)
    .map(time => time.getTime() - now.getTime()).filter(delta => delta >= 0);
  const soonest = dues.length === 0 ? null : Math.min(...dues);
  const urgency: RiskLevel = soonest === null ? 'LOW' : soonest <= 2 * 86_400_000 ? 'HIGH' : soonest <= 7 * 86_400_000 ? 'MEDIUM' : 'LOW';
  return {
    errorProbability: Math.max(...ambiguities.map(ambiguity => ERROR_PROBABILITY[ambiguity.kind])),
    consequence: strongest([money ? 'HIGH' : commitment ? 'MEDIUM' : 'LOW']),
    irreversibility: money ? 'COSTLY_TO_REVERSE' : 'REVERSIBLE',
    urgency,
    interruptionCost: scope.endsWith('/RESTRICTED') ? 'MEDIUM' : 'LOW',
  };
}

function choice(input: CardChoice): CardChoice {
  return cardChoiceSchema.parse(input);
}
const targetsOf = (propositionIds: Iterable<string>) =>
  sortedUnique(propositionIds).map(objectId => ({ objectType: 'proposition' as const, objectId }));

function keepUncertain(targets: ReturnType<typeof targetsOf>, suppressionDays: number, subject: string): CardChoice {
  return choice({
    choiceId: 'keep_uncertain', label: 'Keep uncertain', effect: 'KEEP_UNCERTAIN', targets,
    whatWillChange: 'Nothing is decided: ' + subject + ' stay exactly as they are, and this question is not asked again for '
      + suppressionDays + (suppressionDays === 1 ? ' day' : ' days') + ' unless new evidence arrives.',
  });
}

/** The §37.4 Daniel card: an obligation and an unconfirmed allocation of a transfer. */
function repaymentCard(packet: ContextPacket, situation: Situation, ambiguities: readonly Ambiguity[],
  frameIds: ReadonlySet<string>, suppressionDays: number): Omit<CardDraft, 'sensitivityScope' | 'evidenceIds' | 'risk' | 'situationKey' | 'ambiguities' | 'groupedAmbiguityIds'> | null {
  const allocation = ambiguities.filter(ambiguity => ambiguity.predicateId === ALLOCATION_AMOUNT);
  if (allocation.length === 0) return null;
  const inSituation = (belief: ContextBelief) => frameIds.has(belief.frameInstanceId);
  const principal = packet.currentBeliefs
    .filter(belief => inSituation(belief) && belief.predicateId === OBLIGATION_PRINCIPAL)
    .sort((left, right) => (right.assessmentStatus === 'ACCEPTED' ? 1 : 0) - (left.assessmentStatus === 'ACCEPTED' ? 1 : 0))[0];
  if (!principal) return null;
  const owed = describeValue(principal.normalizedValue);
  const allocated = packet.currentBeliefs.find(belief => belief.propositionId === allocation[0]!.propositionIds[0])
    ?? packet.conflicts.flatMap(conflict => conflict.positions).find(position => position.propositionId === allocation[0]!.propositionIds[0]);
  const paid = describeValue(allocated?.normalizedValue);
  const memo = [...packet.currentBeliefs, ...packet.futureClaims]
    .filter(item => frameIds.has(item.frameInstanceId) && item.predicateId === EVENT_DESCRIPTION)
    .map(item => textOf(item.normalizedValue)).find((text): text is string => text !== null) ?? null;
  const counterparty = ambiguities.filter(ambiguity => ambiguity.predicateId === EVENT_PARTICIPANTS);
  const allocationIds = allocation.flatMap(ambiguity => ambiguity.propositionIds);
  const everyId = ambiguities.flatMap(ambiguity => ambiguity.propositionIds);
  const facts = [
    'An obligation of ' + owed + ' is on record.',
    'A ' + paid + ' transfer' + (memo ? ' with the memo "' + memo + '"' : '') + ' was recorded.',
    ...(counterparty.length > 0 ? ['The counterparty is not confirmed as the same person.'] : []),
    'The purpose is not confirmed.',
  ];
  return {
    situationKind: 'REPAYMENT',
    title: (situation.title ? 'Possible ' + situation.title + ' repayment' : 'Possible repayment').slice(0, 200),
    facts,
    whyItMatters: 'Whether this transfer repaid the ' + owed + ' obligation decides whether you still owe it. Until you say, '
      + 'the obligation is shown as open and the transfer as unexplained, and neither is used as settled.',
    choices: [
      choice({ choiceId: 'confirm_repayment', label: 'Confirm repayment', effect: 'CONFIRM', targets: targetsOf(everyId),
        whatWillChange: 'Records that the ' + paid + ' transfer repaid this obligation. The allocation is proposed as confirmed, '
          + 'and the obligations view recomputes what remains of the ' + owed + ' from it.' }),
      choice({ choiceId: 'different_person', label: 'Different person',
        effect: 'REJECT', targets: targetsOf([...counterparty.flatMap(ambiguity => ambiguity.propositionIds), ...allocationIds]),
        whatWillChange: 'Records that the transfer went to someone else. Its allocation to this obligation is proposed as '
          + 'rejected, the transfer stays on record, and the obligation stays open at ' + owed + '.' }),
      choice({ choiceId: 'different_purpose', label: 'Different purpose', effect: 'REJECT', targets: targetsOf(allocationIds),
        whatWillChange: 'Records that the transfer was for something else. Its allocation to this obligation is proposed as '
          + 'rejected, the transfer stays on record, and the obligation stays open at ' + owed + '.' }),
      keepUncertain(targetsOf(everyId), suppressionDays, 'the transfer and the obligation'),
    ],
    ruleBasis: memo ? { situationKind: 'REPAYMENT', matchText: memo.slice(0, 200) } : null,
  };
}

function generalCard(packet: ContextPacket, situation: Situation, ambiguities: readonly Ambiguity[], consequence: RiskLevel,
  suppressionDays: number): Omit<CardDraft, 'sensitivityScope' | 'evidenceIds' | 'risk' | 'situationKey' | 'ambiguities' | 'groupedAmbiguityIds'> {
  const subject = situation.title ?? describeContract(ambiguities[0]!.predicateId).split(' ')[0] ?? 'this situation';
  const everyId = ambiguities.flatMap(ambiguity => ambiguity.propositionIds);
  const single = ambiguities.length === 1 && ambiguities[0]!.kind === 'CONFLICTING_VALUES' ? ambiguities[0]! : null;
  const positions = single ? packet.conflicts.find(conflict => conflict.beliefSlotId === single.ambiguityId)?.positions ?? [] : [];
  const choices: CardChoice[] = single && positions.length >= 2
    ? positions.slice(0, 3).map((position, index) => choice({
      choiceId: 'keep_value_' + (index + 1), label: ('Keep ' + describeValue(position.normalizedValue)).slice(0, 80),
      effect: 'CONFIRM', targets: targetsOf([position.propositionId]),
      whatWillChange: ('Records that ' + describeValue(position.normalizedValue) + ' is right for the '
        + describeContract(single.predicateId) + '. It is proposed as confirmed; the other value stays on record, not confirmed.').slice(0, 600),
    }))
    : [
      choice({ choiceId: 'confirm', label: 'Confirm', effect: 'CONFIRM', targets: targetsOf(everyId),
        whatWillChange: 'Records your confirmation of ' + (everyId.length === 1 ? 'this detail' : 'these ' + everyId.length + ' details')
          + '. ' + (everyId.length === 1 ? 'It is' : 'Each is') + ' proposed as confirmed; nothing else changes.' }),
      choice({ choiceId: 'reject', label: 'Not right', effect: 'REJECT', targets: targetsOf(everyId),
        whatWillChange: 'Records that ' + (everyId.length === 1 ? 'this reading is' : 'these readings are') + ' wrong. '
          + (everyId.length === 1 ? 'It is' : 'Each is') + ' proposed as rejected; the evidence stays on record.' }),
    ];
  choices.push(keepUncertain(targetsOf(everyId), suppressionDays, 'the recorded details'));
  return {
    situationKind: 'GENERAL',
    title: ('Unconfirmed details: ' + subject).slice(0, 200),
    facts: ambiguities.slice(0, 16).map(ambiguity => ambiguity.detail),
    whyItMatters: consequence === 'HIGH'
      ? 'This affects money you owe or are owed. Until it is settled, answers about it are marked uncertain and actions that depend on it are withheld.'
      : consequence === 'MEDIUM'
        ? 'This affects a commitment. Until it is settled, answers and reminders about it are marked uncertain.'
        : 'Until it is settled, answers about it are marked uncertain.',
    choices,
    ruleBasis: null,
  };
}

/**
 * One card per situation (ADR 0029 §2): every ambiguity of one thread, or of one
 * frame outside any thread, becomes one card that says what is known, why it
 * matters and what each choice will change.
 */
export function composeCards(packet: ContextPacket, input: {
  ambiguities: readonly Ambiguity[];
  situations: ReadonlyMap<string, Situation>;
  now: Date;
  suppressionDays: number;
}): CardDraft[] {
  const groups = new Map<string, Ambiguity[]>();
  for (const ambiguity of input.ambiguities) {
    const key = situationOf(input.situations, ambiguity.frameInstanceId).situationKey;
    groups.set(key, [...(groups.get(key) ?? []), ambiguity]);
  }
  const packetFrames = new Set([...packet.currentBeliefs, ...packet.historicalBeliefs, ...packet.futureClaims]
    .map(item => item.frameInstanceId));
  const drafts: CardDraft[] = [];
  for (const [situationKey, ambiguities] of [...groups].sort(([left], [right]) => left.localeCompare(right))) {
    const situation = situationOf(input.situations, ambiguities[0]!.frameInstanceId);
    // Every frame of the situation, not only the ambiguous ones: the obligation a
    // transfer may have repaid is part of the question even when it is settled.
    const frameIds = new Set([...packetFrames].filter(frameId => situationOf(input.situations, frameId).situationKey === situationKey));
    for (const ambiguity of ambiguities) frameIds.add(ambiguity.frameInstanceId);
    const evidenceIds = sortedUnique(ambiguities.flatMap(ambiguity => ambiguity.evidenceIds));
    const sensitivityScope = scopeOf(packet, frameIds, evidenceIds);
    const risk = riskOf(packet, ambiguities, frameIds, sensitivityScope, input.now);
    const body = repaymentCard(packet, situation, ambiguities, frameIds, input.suppressionDays)
      ?? generalCard(packet, situation, ambiguities, risk.consequence, input.suppressionDays);
    drafts.push({
      ...body, situationKey, sensitivityScope, evidenceIds, risk, ambiguities,
      groupedAmbiguityIds: ambiguities.map(ambiguity => ambiguity.ambiguityId),
    });
  }
  return drafts;
}
