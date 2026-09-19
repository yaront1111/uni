import { describe, expect, it } from 'vitest';
import { DEFAULT_ATTENTION_BUDGET, contextPacketSchema, type ContextPacket, type LifeCategory } from '@unai/domain';
import {
  collectAmbiguities, composeCards, composeWeeklyReview, decideInterruption, expectedValueOf, interruptionCostOf,
  ownerLocalDate, repeatedPostponementObservation, reviewManifestOf, startOfLocalDate, statementsOf, ungroundedStatements,
  addLocalDays, type CardRisk, type Situation,
} from './index.js';

/**
 * The pure halves of proactive clarification and the weekly review, over
 * synthetic Context Broker packets: card grouping and wording (CRT-UX-08-A), the
 * interruption policy's order and logged inputs (CRT-WRT-05-A, CRT-WRT-05-B), the
 * weekly review's sections and their grounds (CRT-UX-05-A) and the behavioral
 * observation's evidence requirements (CRT-UX-06-A). The database-backed halves
 * are exercised through the HTTP boundary in `packages/api/src/inbox.test.ts`
 * and `packages/api/src/weekly-review.test.ts`.
 */

let counter = 0;
const id = () => '0192f3a0-0000-7000-8000-' + String(++counter).padStart(12, '0');
const OWNER = id(), ACTOR = id();

type Belief = ContextPacket['currentBeliefs'][number];
type Future = ContextPacket['futureClaims'][number];

function belief(input: Partial<Belief> & Pick<Belief, 'frameInstanceId' | 'frameTypeId' | 'predicateId'>): Belief {
  return {
    propositionId: id(), beliefSlotId: id(), modality: 'ACTUAL', polarity: 'POSITIVE', normalizedValue: null,
    assessmentStatus: 'ACCEPTED', assessmentRecordedAt: '2026-03-01T00:00:00.000Z', validFrom: '2026-02-01T00:00:00.000Z',
    validTo: null, certainty: 'ACCEPTED', lifeCategories: ['PERSONAL'], claimIds: [id()], evidenceIds: [id()],
    selectionReason: 'VALID_AT_WORLD_TIME_AND_KNOWLEDGE_TIME', ...input,
  };
}
function future(input: Partial<Future> & Pick<Future, 'frameInstanceId' | 'frameTypeId' | 'predicateId'>): Future {
  return { propositionId: id(), modality: 'COMMITTED', normalizedValue: null, validFrom: '2026-02-01T00:00:00.000Z',
    lifeCategories: ['PERSONAL'], evidenceIds: [id()], ...input };
}

function packet(parts: Partial<Pick<ContextPacket, 'currentBeliefs' | 'historicalBeliefs' | 'futureClaims' | 'conflicts'
  | 'resolutionAssertions' | 'evidenceRefs' | 'ownerOverlayDeltas'>>, worldTime = '2026-03-09T00:00:00.000Z'): ContextPacket {
  return contextPacketSchema.parse({
    packetId: id(), packetHash: 'a'.repeat(64), ownerScopeId: OWNER, requestingActorId: ACTOR, purpose: 'PERSONAL_ASSISTANCE',
    answerType: 'PATTERN_REVIEW', lifeCategory: null, registryRelease: '0.1.0', worldTime, knowledgeTime: '2026-03-10T00:00:00.000Z',
    currentBeliefs: [], historicalBeliefs: [], futureClaims: [], resolutionAssertions: [], conflicts: [], unknowns: [],
    ownerOverlayDeltas: [], projectionFragments: [], evidenceRefs: [], memoryThreads: [], allowedActions: ['ANSWER_WITH_CITATIONS'],
    actionDecision: null, redactions: [],
    watermarks: { ownerOverlayWatermark: 0, canonicalTransactionWatermark: '2026-03-01T00:00:00.000Z', projectionVersions: {},
      registryRelease: '0.1.0', knowledgeTime: '2026-03-10T00:00:00.000Z', worldTime },
    selections: [], semanticSearch: null,
    selectionReason: { answerType: 'PATTERN_REVIEW', worldTimeFilter: worldTime, knowledgeTimeFilter: '2026-03-10T00:00:00.000Z',
      requiredCertainty: ['ACCEPTED'], contextKind: 'BASE', appliedRules: ['APPLY_READ_POLICY'], overlayDeltasApplied: [],
      selectorVersion: 'deterministic-selector-0.1.0', selectionsDigest: 'b'.repeat(64) },
    policy: { outcome: 'ALLOW', reason: 'PURPOSE_ADMITTED', policyVersion: 'local-policy-0.1.0', policyDecisionId: id() },
    brokerVersion: 'context-broker-0.1.0', createdAt: '2026-03-10T00:00:00.000Z',
    ...parts,
  });
}

describe('CRT-UX-08-A: related ambiguities about one situation become one card', () => {
  // The §37.4 Daniel example: an obligation of ₪50, a ₪60 transfer with the memo
  // "Daniel dinner" whose allocation to that obligation is not confirmed, and a
  // counterparty that is not confirmed as the same Daniel -- one thread.
  const obligation = id(), allocation = id(), transfer = id(), unrelated = id(), thread = id();
  const principal = belief({ frameInstanceId: obligation, frameTypeId: 'shared.obligation',
    predicateId: 'shared.obligation.principal_amount', normalizedValue: { amount: '50.00', currency: 'ILS' },
    lifeCategories: ['FINANCE', 'PERSONAL'] });
  const allocated = belief({ frameInstanceId: allocation, frameTypeId: 'finance.payment_allocation',
    predicateId: 'finance.payment_allocation.allocated_amount', normalizedValue: { amount: '60.00', currency: 'ILS' },
    assessmentStatus: 'CANDIDATE', certainty: 'PROVISIONAL', lifeCategories: ['FINANCE', 'PERSONAL'] });
  const counterparty = belief({ frameInstanceId: transfer, frameTypeId: 'shared.event_occurrence',
    predicateId: 'shared.event_occurrence.participants', normalizedValue: { entityId: id() },
    assessmentStatus: 'CANDIDATE', certainty: 'PROVISIONAL', lifeCategories: ['FINANCE', 'PERSONAL'] });
  const memo = belief({ frameInstanceId: transfer, frameTypeId: 'shared.event_occurrence',
    predicateId: 'shared.event_occurrence.description', normalizedValue: { text: 'Daniel dinner' } });
  const elsewhere = belief({ frameInstanceId: unrelated, frameTypeId: 'shared.commitment',
    predicateId: 'shared.commitment.created_at', normalizedValue: { time: '2026-03-01T10:00:00.000Z' },
    assessmentStatus: 'CANDIDATE', certainty: 'PROVISIONAL', lifeCategories: ['WORK', 'PERSONAL'] });
  const source = packet({
    currentBeliefs: [principal, allocated, counterparty, memo, elsewhere],
    evidenceRefs: [...allocated.evidenceIds!, ...counterparty.evidenceIds!].map(evidenceId => ({
      evidenceId, sourceType: 'CONVERSATION', sensitivity: 'PRIVATE' as const, occurredAt: null, anchorIds: [],
      lifeCategories: ['FINANCE' as LifeCategory] })),
  });
  const situation: Situation = { situationKey: 'thread:' + thread, title: 'Daniel' };
  const situations = new Map([[obligation, situation], [allocation, situation], [transfer, situation]]);
  const ambiguities = collectAmbiguities(source);
  const cards = composeCards(source, { ambiguities, situations, now: new Date('2026-03-02T09:00:00.000Z'), suppressionDays: 7 });

  it('groups the transfer, its purpose and its counterparty into one card, and keeps another situation apart', () => {
    expect(ambiguities.map(ambiguity => ambiguity.ambiguityId).sort())
      .toEqual([allocated.propositionId, counterparty.propositionId, elsewhere.propositionId].sort());
    expect(cards).toHaveLength(2);
    const daniel = cards.find(card => card.situationKey === 'thread:' + thread)!;
    expect(daniel.situationKind).toBe('REPAYMENT');
    expect(daniel.groupedAmbiguityIds).toHaveLength(2);
    expect(daniel.title).toBe('Possible Daniel repayment');
    expect(daniel.facts).toEqual([
      'An obligation of ₪50 is on record.',
      'A ₪60 transfer with the memo "Daniel dinner" was recorded.',
      'The counterparty is not confirmed as the same person.',
      'The purpose is not confirmed.',
    ]);
    expect(daniel.sensitivityScope).toBe('FINANCE/PRIVATE');
    expect(daniel.ruleBasis).toEqual({ situationKind: 'REPAYMENT', matchText: 'Daniel dinner' });
    const other = cards.find(card => card !== daniel)!;
    expect(other.situationKind).toBe('GENERAL');
    expect(other.sensitivityScope).toBe('WORK/PRIVATE');
  });

  it('states why the card matters and what each choice will change', () => {
    const daniel = cards.find(card => card.situationKey === 'thread:' + thread)!;
    expect(daniel.whyItMatters).toContain('decides whether you still owe it');
    expect(daniel.choices.map(choice => choice.label)).toEqual(['Confirm repayment', 'Different person', 'Different purpose', 'Keep uncertain']);
    for (const choice of daniel.choices) expect(choice.whatWillChange.length).toBeGreaterThan(40);
    const confirm = daniel.choices.find(choice => choice.choiceId === 'confirm_repayment')!;
    expect(confirm.effect).toBe('CONFIRM');
    expect(confirm.targets.map(target => target.objectId).sort()).toEqual([allocated.propositionId, counterparty.propositionId].sort());
    expect(confirm.whatWillChange).toContain('recomputes what remains of the ₪50');
    const person = daniel.choices.find(choice => choice.choiceId === 'different_person')!;
    expect(person.effect).toBe('REJECT');
    expect(person.whatWillChange).toContain('stays open at ₪50');
    const purpose = daniel.choices.find(choice => choice.choiceId === 'different_purpose')!;
    expect(purpose.targets.map(target => target.objectId)).toEqual([allocated.propositionId]);
    const keep = daniel.choices.find(choice => choice.choiceId === 'keep_uncertain')!;
    expect(keep.effect).toBe('KEEP_UNCERTAIN');
    expect(keep.whatWillChange).toContain('not asked again for 7 days unless new evidence arrives');
  });

  it('does not ask about a value the owner already confirmed or rejected', () => {
    const confirmed = packet({
      currentBeliefs: [principal, allocated, memo],
      ownerOverlayDeltas: [{ overlayDeltaId: id(), ownerSequence: 1, deltaKind: 'USER_CONFIRMATION', lifecycle: 'USER_ASSERTED',
        rawText: 'Yes, that was the repayment', target: { objectType: 'proposition', objectId: allocated.propositionId },
        sourceEvidenceId: id(), attachedFrameInstanceId: null, attachedBeliefSlotId: null, candidateEntityRefs: [],
        candidateFrameTypes: [], discourseAnchor: null, createdAt: '2026-03-01T00:00:00.000Z', contestedReason: null,
        assertionKind: 'USER_ASSERTION', independentVerification: { verified: false, independentEvidenceIds: [], independentClaimOrigins: [] } }],
    });
    expect(collectAmbiguities(confirmed)).toEqual([]);
  });

  it('offers one "keep" choice per side of a single conflict', () => {
    const frame = id(), slot = id();
    const left = id(), right = id();
    const conflicted = packet({
      currentBeliefs: [belief({ frameInstanceId: frame, frameTypeId: 'shared.obligation', predicateId: 'shared.obligation.principal_amount',
        propositionId: left, beliefSlotId: slot, normalizedValue: { amount: '50', currency: 'ILS' }, lifeCategories: ['FINANCE'] })],
      conflicts: [{ beliefSlotId: slot, frameInstanceId: frame, predicateId: 'shared.obligation.principal_amount',
        reason: 'COMPETING_LIVE_PROPOSITIONS_IN_ONE_SLOT', positions: [
          { propositionId: left, normalizedValue: { amount: '50', currency: 'ILS' }, assessmentStatus: 'ACCEPTED', claimOrigins: ['USER_STATEMENT'], evidenceIds: [] },
          { propositionId: right, normalizedValue: { amount: '60', currency: 'ILS' }, assessmentStatus: 'ACCEPTED', claimOrigins: ['DOCUMENT_ASSERTION'], evidenceIds: [] }] }],
    });
    const [card] = composeCards(conflicted, { ambiguities: collectAmbiguities(conflicted), situations: new Map(), now: new Date(), suppressionDays: 7 });
    expect(card!.groupedAmbiguityIds).toEqual([slot]);
    expect(card!.choices.map(choice => choice.label)).toEqual(['Keep ₪50', 'Keep ₪60', 'Keep uncertain']);
    expect(card!.facts[0]).toContain('Two or more values are recorded for obligation principal amount: ₪50, ₪60');
  });
});

describe('CRT-WRT-05-A and CRT-WRT-05-B: the interruption decision', () => {
  const risk: CardRisk = { errorProbability: 0.4, consequence: 'HIGH', irreversibility: 'COSTLY_TO_REVERSE', urgency: 'LOW', interruptionCost: 'LOW' };
  const now = new Date('2026-03-02T09:00:00.000Z');
  const base = {
    risk, sensitivityScope: 'FINANCE/PRIVATE', budget: { ...DEFAULT_ATTENTION_BUDGET, isDefault: true, updatedAt: null },
    ownerLocalDate: '2026-03-02', timeZone: 'UTC', now, askedToday: 0, askedInScopeToday: 0, lastAskedAt: null,
    suppressedUntil: null, materialNewEvidenceIds: [] as string[], learnedApprovalRuleId: null,
  };

  it('logs the five §19.4 inputs, the budget it counted against and a reason with every decision', () => {
    const outcome = decideInterruption(base);
    expect(outcome).toMatchObject({ decision: 'ASK', reason: 'WITHIN_ATTENTION_BUDGET' });
    expect(outcome.policyInputs).toMatchObject({ errorProbability: 0.4, consequence: 'HIGH', irreversibility: 'COSTLY_TO_REVERSE',
      urgency: 'LOW', interruptionCost: 'LOW', expectedValue: expectedValueOf(risk), interruptionCostValue: interruptionCostOf(risk),
      budget: { maxCardsPerDay: 3, maxCardsPerSensitivityScopePerDay: 1, repeatQuestionSuppressionDays: 7, askedToday: 0, askedInScopeToday: 0 } });
  });

  it('enforces the daily cap, then the scope cap, and never asks what is not worth its interruption', () => {
    expect(decideInterruption({ ...base, askedToday: 3 })).toMatchObject({ decision: 'BATCH', reason: 'DAILY_BUDGET_EXHAUSTED' });
    expect(decideInterruption({ ...base, askedToday: 1, askedInScopeToday: 1 })).toMatchObject({ decision: 'BATCH', reason: 'SCOPE_BUDGET_EXHAUSTED' });
    const cheap: CardRisk = { ...risk, consequence: 'LOW', irreversibility: 'REVERSIBLE' };
    expect(decideInterruption({ ...base, risk: cheap })).toMatchObject({ decision: 'BATCH', reason: 'VALUE_BELOW_INTERRUPTION_COST' });
  });

  it('a configured budget changes the cap', () => {
    const wider = { ...base, budget: { maxCardsPerDay: 5, maxCardsPerSensitivityScopePerDay: 2, repeatQuestionSuppressionDays: 7, isDefault: false, updatedAt: now.toISOString() } };
    expect(decideInterruption({ ...wider, askedToday: 3, askedInScopeToday: 1 }).decision).toBe('ASK');
    expect(decideInterruption({ ...wider, askedToday: 5 }).decision).toBe('BATCH');
    const narrower = { ...base, budget: { ...wider.budget, maxCardsPerDay: 1, maxCardsPerSensitivityScopePerDay: 1 } };
    expect(decideInterruption({ ...narrower, askedToday: 1 })).toMatchObject({ decision: 'BATCH', reason: 'DAILY_BUDGET_EXHAUSTED' });
  });

  it('does not ask again within the suppression window unless material new evidence arrived', () => {
    const asked = new Date(now.getTime() - 6 * 86_400_000);
    expect(decideInterruption({ ...base, lastAskedAt: asked })).toMatchObject({ decision: 'SUPPRESS', reason: 'ASKED_WITHIN_SUPPRESSION_WINDOW' });
    expect(decideInterruption({ ...base, lastAskedAt: asked, materialNewEvidenceIds: [id()] }))
      .toMatchObject({ decision: 'ASK', reason: 'REOPENED_BY_MATERIAL_NEW_EVIDENCE' });
    expect(decideInterruption({ ...base, lastAskedAt: new Date(now.getTime() - 7 * 86_400_000) }))
      .toMatchObject({ decision: 'ASK', reason: 'WITHIN_ATTENTION_BUDGET' });
    expect(decideInterruption({ ...base, suppressedUntil: new Date(now.getTime() + 1000) }))
      .toMatchObject({ decision: 'SUPPRESS', reason: 'KEPT_UNCERTAIN_WITHIN_SUPPRESSION_WINDOW' });
  });

  it('an approved learned rule answers instead of asking, before any budget is spent', () => {
    const rule = id();
    expect(decideInterruption({ ...base, askedToday: 3, learnedApprovalRuleId: rule }))
      .toMatchObject({ decision: 'SUPPRESS', reason: 'LEARNED_RULE_APPLIED', policyInputs: { learnedApprovalRuleId: rule } });
  });
});

describe('owner-local days', () => {
  it('counts the day in the owner zone and finds its first instant', () => {
    expect(ownerLocalDate(new Date('2026-03-01T22:30:00.000Z'), 'Asia/Jerusalem')).toBe('2026-03-02');
    expect(startOfLocalDate('2026-03-02', 'Asia/Jerusalem').toISOString()).toBe('2026-03-01T22:00:00.000Z');
    expect(startOfLocalDate('2026-03-02', 'UTC').toISOString()).toBe('2026-03-02T00:00:00.000Z');
    expect(addLocalDays('2026-02-27', 3)).toBe('2026-03-02');
  });
});

describe('the weekly review over one packet', () => {
  const week = { weekStart: '2026-03-02', weekEnd: '2026-03-08', timeZone: 'UTC',
    from: new Date('2026-03-02T00:00:00.000Z'), to: new Date('2026-03-09T00:00:00.000Z') };
  const work = id(), family = id(), done = id(), obligation = id(), allocation = id(), meeting = id(), school = id();
  const resolution = id();
  const oldPrincipal = belief({ frameInstanceId: obligation, frameTypeId: 'shared.obligation', predicateId: 'shared.obligation.principal_amount',
    normalizedValue: { amount: '50', currency: 'ILS' }, validTo: '2026-03-04T00:00:00.000Z', lifeCategories: ['FINANCE'] });
  const newPrincipal = belief({ frameInstanceId: obligation, frameTypeId: 'shared.obligation', predicateId: 'shared.obligation.principal_amount',
    beliefSlotId: oldPrincipal.beliefSlotId, normalizedValue: { amount: '60', currency: 'ILS' }, validFrom: '2026-03-04T00:00:00.000Z',
    lifeCategories: ['FINANCE'] });
  const base = {
    currentBeliefs: [newPrincipal,
      belief({ frameInstanceId: obligation, frameTypeId: 'shared.obligation', predicateId: 'shared.obligation.due_time',
        normalizedValue: { time: '2026-03-05T12:00:00.000Z' }, lifeCategories: ['FINANCE'] }),
      belief({ frameInstanceId: allocation, frameTypeId: 'finance.payment_allocation', predicateId: 'finance.payment_allocation.allocated_amount',
        normalizedValue: { amount: '60', currency: 'ILS' }, validFrom: '2026-03-06T10:00:00.000Z', lifeCategories: ['FINANCE'] }),
      belief({ frameInstanceId: meeting, frameTypeId: 'shared.event_occurrence', predicateId: 'shared.event_occurrence.occurrence_time',
        normalizedValue: { start: '2026-03-03T09:00:00.000Z', end: '2026-03-03T19:00:00.000Z' }, lifeCategories: ['WORK', 'PERSONAL'] })],
    historicalBeliefs: [oldPrincipal],
    futureClaims: [
      future({ frameInstanceId: work, frameTypeId: 'shared.commitment', predicateId: 'shared.commitment.action_description', normalizedValue: { text: 'Ship the quarterly report' }, lifeCategories: ['WORK'] }),
      future({ frameInstanceId: work, frameTypeId: 'shared.commitment', predicateId: 'shared.commitment.priority', normalizedValue: { text: 'low' }, lifeCategories: ['WORK'] }),
      future({ frameInstanceId: work, frameTypeId: 'shared.commitment', predicateId: 'shared.commitment.due_time', normalizedValue: { time: '2026-03-04T17:00:00.000Z' }, lifeCategories: ['WORK'] }),
      future({ frameInstanceId: family, frameTypeId: 'shared.commitment', predicateId: 'shared.commitment.action_description', normalizedValue: { text: 'Prepare the school forms' }, lifeCategories: ['FAMILY'] }),
      future({ frameInstanceId: family, frameTypeId: 'shared.commitment', predicateId: 'shared.commitment.priority', normalizedValue: { text: 'high' }, lifeCategories: ['FAMILY'] }),
      future({ frameInstanceId: done, frameTypeId: 'shared.commitment', predicateId: 'shared.commitment.action_description', normalizedValue: { text: 'Call the bank' }, lifeCategories: ['FINANCE'] }),
      future({ frameInstanceId: school, frameTypeId: 'shared.event_occurrence', predicateId: 'shared.event_occurrence.occurrence_time', modality: 'SCHEDULED',
        normalizedValue: { start: '2026-03-05T16:00:00.000Z', end: '2026-03-05T17:00:00.000Z' }, lifeCategories: ['FAMILY', 'PERSONAL'] }),
    ],
    resolutionAssertions: [{ resolutionAssertionId: resolution, claimId: null, evidenceIds: [], sourceFrameInstanceId: done, targetFrameInstanceId: null, outcomeCode: 'FULFILLED' as const,
      effectiveAt: '2026-03-04T08:00:00.000Z', lifecycle: 'ACCEPTED', transitionContractId: 'shared.commitment.resolution' }],
  };

  it('CRT-UX-05-A: compares stated priorities with calendar allocation, commitments with resolutions, and reports material changes', () => {
    const review = composeWeeklyReview(packet(base), week);
    const texts = (section: { statements: Array<{ text: string }> }) => section.statements.map(statement => statement.text);
    expect(review.priorityVersusCalendar.availability).toBe('AVAILABLE');
    expect(texts(review.priorityVersusCalendar)).toContain(
      'Family: you stated 1 high-priority commitment ("Prepare the school forms"), and 1 hour of the 11 hours scheduled this week (9%) went to family.');
    expect(texts(review.priorityVersusCalendar)).toContain('Scheduled this week: Family 1 hour across 1 event; Work 10 hours across 1 event.');
    expect(review.priorityVersusCalendar.allocation).toEqual(expect.arrayContaining([
      { lifeCategory: 'WORK', scheduledMinutes: 600, eventCount: 1, highPriorityCommitments: 0, statedPriorityCommitments: 1 },
      { lifeCategory: 'FAMILY', scheduledMinutes: 60, eventCount: 1, highPriorityCommitments: 1, statedPriorityCommitments: 1 }]));
    expect(review.commitmentsVersusResolutions).toMatchObject({ completedCount: 1, openCount: 2, slippingCount: 1 });
    expect(texts(review.commitmentsVersusResolutions)).toEqual(expect.arrayContaining([
      'Completed: "Call the bank" (fulfilled on 2026-03-04).',
      'Slipping: "Ship the quarterly report" was due 2026-03-04 and has no recorded outcome.']));
    expect(review.decisionsVersusOutcomes).toMatchObject({ availability: 'NOT_AVAILABLE_IN_THIS_RELEASE', statements: [] });
    expect(texts(review.plannedVersusObservedSpending)).toEqual(expect.arrayContaining([
      'Planned: ₪60 due 2026-03-05.', 'Observed: ₪60 allocated to an obligation on 2026-03-06.']));
    expect(texts(review.materialChanges)).toContain('Changed (Finance): the obligation principal amount was ₪50 until 2026-03-04 and is now ₪60.');
  });

  it('CRT-UX-05-A: every statement names objects the persisted packet supplied, and a foreign ground is caught', () => {
    const source = packet(base);
    const review = composeWeeklyReview(source, week);
    const manifest = reviewManifestOf(source, { registryReleaseId: null });
    const statements = statementsOf(review);
    expect(statements.length).toBeGreaterThan(6);
    for (const statement of statements) expect(statement.grounds.length).toBeGreaterThan(0);
    expect(ungroundedStatements(statements, manifest)).toEqual([]);
    const forged = [{ statementId: 'forged-1', grounds: [{ objectType: 'proposition' as const, objectId: id() }] }];
    expect(ungroundedStatements(forged, manifest)).toHaveLength(1);
  });

  const due = (frame: string, time: string, statedAt: string) => future({ frameInstanceId: frame, frameTypeId: 'shared.commitment',
    predicateId: 'shared.commitment.due_time', normalizedValue: { time }, validFrom: statedAt });

  it('CRT-UX-06-A: a single postponement produces no behavioral observation', () => {
    const report = id();
    const single = packet({ futureClaims: [
      due(report, '2026-03-03T17:00:00.000Z', '2026-02-20T09:00:00.000Z'),
      due(report, '2026-03-10T17:00:00.000Z', '2026-03-03T09:00:00.000Z')] });
    const review = composeWeeklyReview(single, week);
    expect(review.repeatedPostponement.episodeCount).toBe(1);
    expect(review.repeatedPostponement.statements).toHaveLength(1);
    expect(review.observations).toEqual([]);
    const window = { from: new Date(week.to.getTime() - 28 * 86_400_000), to: week.to };
    expect(repeatedPostponementObservation(single, { window, timeZone: 'UTC' }).observation).toBeNull();
  });

  it('CRT-UX-06-A: an observation records its episodes, counterexample search, window, confidence and review date', () => {
    const report = id(), taxes = id(), dentist = id();
    const repeated = packet({ futureClaims: [
      due(report, '2026-03-03T17:00:00.000Z', '2026-02-20T09:00:00.000Z'),
      due(report, '2026-03-10T17:00:00.000Z', '2026-03-03T09:00:00.000Z'),
      due(taxes, '2026-02-25T17:00:00.000Z', '2026-02-10T09:00:00.000Z'),
      due(taxes, '2026-03-06T17:00:00.000Z', '2026-02-24T09:00:00.000Z'),
      due(dentist, '2026-03-04T08:00:00.000Z', '2026-02-15T09:00:00.000Z')] });
    const review = composeWeeklyReview(repeated, week);
    expect(review.observations).toHaveLength(1);
    const [observation] = review.observations;
    expect(observation!.supportingEpisodes.length).toBeGreaterThan(1);
    expect(observation!.supportingEpisodes.map(episode => episode.frameInstanceId).sort()).toEqual([report, taxes].sort());
    expect(observation!.counterexampleSearch).toEqual({
      searched: expect.stringContaining('never restated later'), counterexamplesFound: 1, counterexampleIds: [dentist] });
    expect(observation!.observationWindow).toEqual({ from: '2026-02-09T00:00:00.000Z', to: '2026-03-09T00:00:00.000Z' });
    expect(observation!.confidence).toBe(0.67);
    expect(observation!.reviewOrExpiryDate).toBe('2026-04-05');
    expect(observation!.statement).toBe('Between 2026-02-09 and 2026-03-08, due dates were moved later 2 times across 2 commitments; '
      + '1 commitment due in the same period kept its original date.');
    // Direct, without flattery, guilt or a character claim (PRD §37.7).
    expect(observation!.statement).not.toMatch(/\b(you always|lazy|procrastinat|great job|should feel)\b/i);
    expect(ungroundedStatements(statementsOf(review), reviewManifestOf(repeated, { registryReleaseId: null }))).toEqual([]);
  });
});
