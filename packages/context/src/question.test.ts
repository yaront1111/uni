import { expect, it } from 'vitest';
import { questionTypeSchema, type QuestionType } from '@unai/domain';
import { classifyQuestion } from './question.js';
import { selectSlotState, selectionsDigest, type SlotSelectionInput } from './selector.js';

/**
 * The question classifier and the deterministic selector, as pure functions: no
 * database, no model, no clock. What these prove holds for any caller, and the
 * database-backed suites (`answering.test.ts`, `semantic.test.ts`) prove the same
 * functions are the ones the broker and the Ask pipeline run.
 */

/** Fixture questions for each of the eight §8.2 answer types, including every
 * question PRD §7.2 lists for the Ask surface. */
const FIXTURE: Record<QuestionType, readonly string[]> = {
  CURRENT_STATE: ['Do I still owe Daniel?', 'What is my current salary?', 'How much do I owe Daniel?', 'Is the car loan open?'],
  HISTORICAL_STATE: ['What was true at that time?', 'What did Uai believe at that time?', 'What was the loan amount as of March 1?',
    'What did you know back then about the lease?', 'Where did I live in 2024?'],
  EPISODE_RECALL: ['What happened at the meeting with Daniel last Tuesday?', 'Remember when we met Alice in Berlin?',
    'When did I last talk to the landlord?', 'What did Daniel say about the loan?'],
  CAUSAL_EXPLANATION: ['Why did I make this decision?', 'What caused the delay in the project?', 'Why is the rent higher now?',
    'What was the reason for cancelling the trip?'],
  FUTURE_COMMITMENT: ['What did I promise Daniel?', 'What am I forgetting?', 'When is my dentist appointment scheduled?',
    'What do I need to send before Friday?', 'Which deadlines are coming up?'],
  PREDICTION_REVIEW: ['Which plans have no confirmed outcome?', 'Did my prediction about the launch date come true?',
    'How did the migration turn out compared to what I forecast?'],
  AGGREGATION: ['How much did I spend on groceries in August?', 'How many times did I postpone the report?',
    'Where am I repeatedly postponing action?', 'What is the total I paid Daniel altogether?'],
  CONTRADICTION_CHECK: ['What conflicts with my financial goal?', 'Does Daniel\'s message disagree with my note?',
    'Is anything I recorded about the loan inconsistent?', 'Why do these two amounts contradict each other?'],
};

it('CRT-RD-12-A: classifies fixture questions for each of the eight answer types to the correct type', () => {
  expect(Object.keys(FIXTURE).sort()).toEqual([...questionTypeSchema.options].sort());
  for (const [answerType, questions] of Object.entries(FIXTURE)) {
    for (const question of questions) {
      const classification = classifyQuestion(question);
      expect(classification.answerType, question).toBe(answerType);
      // Deterministic: the same question is the same type, by the same rule.
      expect(classifyQuestion(question), question).toEqual(classification);
      expect(classifyQuestion(question.toUpperCase() + '  '), question).toEqual(classification);
    }
  }
  // Each type maps onto the §23.3 query mode the broker plans under.
  expect(classifyQuestion('What did Uai believe at that time?')).toMatchObject({
    queryMode: 'HISTORICAL_BELIEF_STATE', historicalMode: 'HISTORICAL_BELIEF_STATE', matchedRule: 'HISTORICAL_BELIEF_TERMS' });
  expect(classifyQuestion('What was true at that time?')).toMatchObject({
    queryMode: 'CORRECTED_HISTORICAL_VALUE', historicalMode: 'CORRECTED_HISTORICAL_STATE' });
  expect(classifyQuestion('Why did I make this decision?').queryMode).toBe('DECISION_RECONSTRUCTION');
  expect(classifyQuestion('What caused the delay in the project?').queryMode).toBe('CAUSAL_EXPLANATION');
  expect(classifyQuestion('What did I promise Daniel?').queryMode).toBe('OPEN_COMMITMENTS');
  expect(classifyQuestion('When is my dentist appointment scheduled?').queryMode).toBe('FUTURE_PLANS');
  expect(classifyQuestion('Which plans have no confirmed outcome?').queryMode).toBe('PREDICTION_VERSUS_OUTCOME');
  expect(classifyQuestion('Do I still owe Daniel?')).toMatchObject({ queryMode: 'CURRENT_VALUE', matchedRule: 'DEFAULT_CURRENT_STATE' });
});

const SLOT = '01900000-0000-7000-8000-000000000001';
const FRAME = '01900000-0000-7000-8000-000000000002';
const OLD = '01900000-0000-7000-8000-00000000000a', NEW = '01900000-0000-7000-8000-00000000000b';
const OTHER = '01900000-0000-7000-8000-00000000000c';
const DELTA = '01900000-0000-7000-8000-0000000000dd';
const id = (n: number) => '01900000-0000-7000-8000-' + String(n).padStart(12, '0');

/** A corrected value: 50 accepted on Feb 1, corrected to 60 on Feb 10, with the
 * owner's pending "actually 65" on Feb 20, and a provisional competitor. */
function corrected(): SlotSelectionInput {
  return {
    slot: { beliefSlotId: SLOT, frameInstanceId: FRAME, frameTypeId: 'shared.obligation',
      predicateId: 'shared.obligation.principal_amount', modality: 'ACTUAL', contextKind: 'BASE', predicateRegistered: true },
    propositions: [
      { propositionId: OTHER, lifecycle: 'ACTIVE', normalizedValue: { amount: '70.00', currency: 'ILS' }, withheld: false, outOfView: false },
      { propositionId: NEW, lifecycle: 'ACTIVE', normalizedValue: { amount: '60.00', currency: 'ILS' }, withheld: false, outOfView: false },
      { propositionId: OLD, lifecycle: 'ACTIVE', normalizedValue: { amount: '50.00', currency: 'ILS' }, withheld: false, outOfView: false },
    ],
    assessments: [
      { assessmentId: id(21), propositionId: OLD, status: 'ACCEPTED', validFrom: '2026-01-01T00:00:00.000Z', validTo: null,
        recordedAt: '2026-02-01T09:00:00.000Z', supersededRecordedAt: '2026-02-10T09:00:00.000Z' },
      { assessmentId: id(22), propositionId: OLD, status: 'SUPERSEDED', validFrom: '2026-01-01T00:00:00.000Z', validTo: null,
        recordedAt: '2026-02-10T09:00:00.000Z', supersededRecordedAt: null },
      { assessmentId: id(23), propositionId: NEW, status: 'ACCEPTED', validFrom: '2026-01-01T00:00:00.000Z', validTo: null,
        recordedAt: '2026-02-10T09:00:00.000Z', supersededRecordedAt: null },
      { assessmentId: id(24), propositionId: OTHER, status: 'PROVISIONAL', validFrom: null, validTo: null,
        recordedAt: '2026-02-12T09:00:00.000Z', supersededRecordedAt: null },
    ],
    claims: [
      { claimId: id(31), propositionId: OLD, claimOrigin: 'USER_STATEMENT', recordedAt: '2026-02-01T09:00:00.000Z', evidenceId: id(41) },
      { claimId: id(32), propositionId: NEW, claimOrigin: 'USER_CORRECTION', recordedAt: '2026-02-10T09:00:00.000Z', evidenceId: id(42) },
      { claimId: id(33), propositionId: OTHER, claimOrigin: 'DOCUMENT_ASSERTION', recordedAt: '2026-02-12T09:00:00.000Z', evidenceId: id(43) },
    ],
    relations: [{ fromClaimId: id(32), toClaimId: id(31), relationKind: 'CORRECTS', validFrom: '2026-01-01T00:00:00.000Z',
      createdAt: '2026-02-10T09:00:00.000Z' }],
    overlayDeltas: [{ overlayDeltaId: DELTA, lifecycle: 'USER_ASSERTED', targetPropositionId: NEW, attachedBeliefSlotId: null,
      createdAt: '2026-02-20T09:00:00.000Z' }],
  };
}
const LATEST = { worldTime: '2026-03-02T09:00:00.000Z', knowledgeTime: '2026-03-02T09:00:00.000Z', modalities: ['ACTUAL'], admitProvisional: false };

it('CRT-RD-03-A: the selector is a pure function -- same input, same state, same reason, whatever the row order', () => {
  const first = selectSlotState(corrected(), LATEST);
  expect(first).toMatchObject({
    outcome: 'SELECTED', selectedPropositionId: NEW, reason: 'SELECTED_AFTER_CORRECTION', certainty: 'ACCEPTED',
    selectedValue: { amount: '60.00', currency: 'ILS' }, evidenceIds: [id(42)], overlayDeltaIds: [DELTA],
    ownerAssertionPending: true, appliedRelations: [{ relationKind: 'CORRECTS', fromPropositionId: NEW, toPropositionId: OLD }],
  });
  const lifecycle = first.steps.find(step => step.rule === 'APPLY_BELIEF_LIFECYCLE')!;
  expect(lifecycle.excluded).toEqual([{ objectId: OLD, reason: 'ASSESSMENT_SUPERSEDED' },
    { objectId: OTHER, reason: 'PROVISIONAL_NOT_REQUESTED' }].sort((a, b) => a.objectId < b.objectId ? -1 : 1));
  expect(first.steps.map(step => step.rule)).toEqual(['APPLY_READ_POLICY', 'FILTER_VALID_TIME', 'FILTER_KNOWLEDGE_TIME',
    'APPLY_CONTEXT_AND_MODALITY', 'REQUIRE_REGISTERED_CONTRACT', 'APPLY_BELIEF_LIFECYCLE', 'APPLY_CORRECTION_AND_SUPERSESSION',
    'INCLUDE_UNRESOLVED_CONFLICTS', 'INCLUDE_APPLICABLE_OVERLAY_DELTAS']);

  // Reversing every input list changes nothing, byte for byte.
  const input = corrected();
  const reversed: SlotSelectionInput = { ...input, propositions: [...input.propositions].reverse(),
    assessments: [...input.assessments].reverse(), claims: [...input.claims].reverse() };
  for (let run = 0; run < 5; run++) {
    expect(JSON.stringify(selectSlotState(run % 2 === 0 ? reversed : corrected(), LATEST))).toBe(JSON.stringify(first));
  }
  expect(selectionsDigest([selectSlotState(reversed, LATEST)])).toBe(selectionsDigest([first]));

  // What Uai believed on Feb 5, from what it knew on Feb 5: the uncorrected value,
  // with neither the correction nor the owner's later delta known yet.
  const then = selectSlotState(corrected(), { ...LATEST, worldTime: '2026-02-05T00:00:00.000Z', knowledgeTime: '2026-02-05T00:00:00.000Z' });
  expect(then).toMatchObject({ outcome: 'SELECTED', selectedPropositionId: OLD, reason: 'ONLY_ACCEPTED_VALUE',
    overlayDeltaIds: [], appliedRelations: [] });
  // What is now believed to have held on Feb 5: the corrected value.
  expect(selectSlotState(corrected(), { ...LATEST, worldTime: '2026-02-05T00:00:00.000Z' }))
    .toMatchObject({ selectedPropositionId: NEW, reason: 'SELECTED_AFTER_CORRECTION' });
});

it('CRT-RD-03-A and CRT-REG-04-A: contested values are reported, never chosen; context, modality and registration exclude the slot', () => {
  const contested = corrected();
  const withConflict: SlotSelectionInput = { ...contested, assessments: [...contested.assessments,
    { assessmentId: id(25), propositionId: OTHER, status: 'CONTESTED', validFrom: null, validTo: null,
      recordedAt: '2026-02-15T09:00:00.000Z', supersededRecordedAt: null }].map(version =>
    version.propositionId === OTHER && version.status === 'PROVISIONAL' ? { ...version, supersededRecordedAt: '2026-02-15T09:00:00.000Z' } : version) };
  expect(selectSlotState(withConflict, LATEST)).toMatchObject({
    outcome: 'CONTESTED', selectedPropositionId: null, reason: 'UNRESOLVED_CONFLICT', competingPropositionIds: [NEW, OTHER].sort() });
  expect(selectSlotState(withConflict, LATEST)).not.toHaveProperty('selectedValue');

  const slot = corrected().slot;
  for (const [change, reason] of [
    [{ contextKind: 'QUOTED' as const }, 'CONTEXT_NOT_BASE'],
    [{ modality: 'SCHEDULED' as const }, 'MODALITY_NOT_REQUESTED'],
    [{ predicateRegistered: false }, 'UNREGISTERED_PREDICATE_NOT_AUTHORITATIVE'],
  ] as const) {
    const selection = selectSlotState({ ...corrected(), slot: { ...slot, ...change } }, LATEST);
    expect(selection, reason).toMatchObject({ outcome: 'EXCLUDED', reason, selectedPropositionId: null });
  }
  // A withheld value makes the slot WITHHELD rather than a partial selection.
  const input = corrected();
  expect(selectSlotState({ ...input, propositions: input.propositions.map(entry =>
    entry.propositionId === OLD ? { ...entry, withheld: true } : entry) }, LATEST))
    .toMatchObject({ outcome: 'WITHHELD', selectedPropositionId: null, reason: 'SLOT_PARTLY_WITHHELD_BY_READ_POLICY' });
});
