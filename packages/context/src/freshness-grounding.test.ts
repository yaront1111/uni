import { expect, it } from 'vitest';
import type { ContextPacket } from '@unai/domain';
import { validateGrounding, type ValidatableStatement } from './grounding.js';

const valueId = '01900000-0000-7000-8000-000000000001';
const sourceId = '01900000-0000-7000-8000-000000000002';
const packet = {
  answerType: 'CURRENT_VALUE', currentBeliefs: [{ propositionId: valueId, normalizedValue: { amount: '60.00', currency: 'ILS' },
    beliefSlotId: '01900000-0000-7000-8000-000000000003', frameInstanceId: '01900000-0000-7000-8000-000000000004',
    claimIds: [], evidenceIds: [sourceId], certainty: 'ACCEPTED' }],
  historicalBeliefs: [], futureClaims: [], selections: [], conflicts: [], resolutionAssertions: [], ownerOverlayDeltas: [],
  semanticSearch: null, memoryThreads: [], redactions: [], unknowns: [], evidenceRefs: [{ evidenceId: sourceId, sourceType: 'CONVERSATION', sensitivity: 'PRIVATE' }],
  freshness: [{ propositionId: valueId, assessment: { state: 'VERIFY', basisAt: '2025-09-15T09:00:00.000Z' } }],
} as unknown as ContextPacket;
const statement = (text: string): ValidatableStatement => ({ statementId: 'S1', text, label: 'CONFIRMED',
  objectRefs: [{ objectType: 'propositions', objectId: valueId }], sourceEvidenceIds: [sourceId], sensitivityScope: 'PRIVATE' });

it('refuses wording that turns stale supported evidence into a current fact', () => {
  const result = validateGrounding(packet, [statement('You currently owe ILS 60.')], { maximumSensitivity: 'PRIVATE' });
  expect(result.verdict).toBe('REGENERATE');
  expect(result.violations.map(value => value.detail)).toContain('FRESHNESS_QUALIFIER_REQUIRED');
});
it('allows an explicitly last-known statement with the original evidence date', () => {
  const result = validateGrounding(packet, [statement('Last recorded: ILS 60. Original evidence dated 2025-09-15; verify whether this still applies.')], { maximumSensitivity: 'PRIVATE' });
  expect(result.verdict).toBe('PASSED');
});

it.each(['I verified that you currently owe ILS 60.', 'You currently owe ILS 60. The meeting has not yet happened.'])
  ('does not treat an affirmative verification claim or unrelated future qualifier as fresh evidence: %s', text => {
    expect(validateGrounding(packet, [statement(text)], { maximumSensitivity: 'PRIVATE' }).verdict).toBe('REGENERATE');
  });

it.each(['ILS 60; verify whether this still applies.', 'ILS 60 requires verification.',
  'ILS 60; current applicability is unknown.',
  'You said: "ILS 60". This is your assertion and is not yet independently verified.'])
  ('preserves explicit current uncertainty or pending assertion wording: %s', text => {
    expect(validateGrounding(packet, [statement(text)], { maximumSensitivity: 'PRIVATE' }).verdict).toBe('PASSED');
  });

it('allows a recorded resolution without treating every uncertain proposition in its frame as a current assertion', () => {
  const resolved = structuredClone(packet);
  const resolutionId = '01900000-0000-7000-8000-000000000007';
  const frameId = resolved.currentBeliefs[0]!.frameInstanceId;
  resolved.resolutionAssertions.push({ resolutionAssertionId: resolutionId, sourceFrameInstanceId: frameId,
    targetFrameInstanceId: null, lifecycle: 'ACCEPTED', outcomeCode: 'FULFILLED', effectiveAt: '2025-09-15T09:00:00.000Z',
  } as ContextPacket['resolutionAssertions'][number]);
  const recorded = { ...statement('Outcome recorded: fulfilled, effective 2025-09-15.'),
    objectRefs: [{ objectType: 'resolution_assertions', objectId: resolutionId },
      { objectType: 'frame_instances', objectId: frameId }] };
  expect(validateGrounding(resolved, [recorded], { maximumSensitivity: 'PRIVATE' }).verdict).toBe('PASSED');
});

it('uses specific propositions before container freshness without laundering stale sibling values through the frame', () => {
  const freshId = '01900000-0000-7000-8000-000000000005';
  const mixed = structuredClone(packet);
  mixed.currentBeliefs.push({ ...mixed.currentBeliefs[0]!, propositionId: freshId,
    beliefSlotId: '01900000-0000-7000-8000-000000000006', normalizedValue: { amount: '10.00', currency: 'ILS' } });
  mixed.freshness!.push({ ...mixed.freshness![0]!, propositionId: freshId,
    assessment: { ...mixed.freshness![0]!.assessment, state: 'CURRENT' } });
  const frameRef = { objectType: 'frame_instances', objectId: mixed.currentBeliefs[0]!.frameInstanceId };
  const current = { ...statement('You owe ILS 10.'), objectRefs: [{ objectType: 'propositions', objectId: freshId }, frameRef] };
  expect(validateGrounding(mixed, [current], { maximumSensitivity: 'PRIVATE' }).verdict).toBe('PASSED');
  expect(validateGrounding(mixed, [{ ...current, text: 'You currently owe ILS 60.' }], { maximumSensitivity: 'PRIVATE' }).verdict)
    .toBe('REGENERATE');
  expect(validateGrounding(mixed, [{ ...statement('You currently owe ILS 60.'), objectRefs: [frameRef] }],
    { maximumSensitivity: 'PRIVATE' }).verdict).toBe('REGENERATE');
  expect(validateGrounding(mixed, [{ ...current, text: 'You owe ILS 10 and ILS 60.',
    objectRefs: [...current.objectRefs, { objectType: 'propositions', objectId: valueId }] }],
  { maximumSensitivity: 'PRIVATE' }).verdict).toBe('REGENERATE');
});
