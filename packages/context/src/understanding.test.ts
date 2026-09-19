import { expect, it } from 'vitest';
import { deriveUnderstanding, type UnderstandingInput } from './understanding.js';

const at = '2026-09-19T09:00:00.000Z';
const base = { worldTime: at, currentBeliefs: [], historicalBeliefs: [], futureClaims: [], selections: [],
  resolutionAssertions: [], freshness: [], transitions: [], goalLinks: [], unknowns: [] } satisfies UnderstandingInput;

it('does not attribute a derived value with no direct assertion to a reporter', () => {
  expect(deriveUnderstanding({ ...base,
    currentBeliefs: [{ propositionId: 'derived', frameInstanceId: 'calculation', frameTypeId: 'test.calculation' }],
    selections: [{ selectedPropositionId: 'derived', outcome: 'SELECTED', modality: 'ACTUAL', claimOrigins: [] }],
  }).origins).toEqual([{ propositionId: 'derived', basis: 'INFERRED' }]);
});

it('keeps last-known applicability separate from source confidence and historical truth', () => {
  const view = deriveUnderstanding({ ...base,
    currentBeliefs: [{ propositionId: 'salary', frameInstanceId: 'work', frameTypeId: 'test.employment' }],
    selections: [{ selectedPropositionId: 'salary', outcome: 'SELECTED', modality: 'ACTUAL', claimOrigins: ['USER_STATEMENT'] }],
    freshness: [{ propositionId: 'salary', assessment: { state: 'VERIFY' } }],
    historicalBeliefs: [{ propositionId: 'old-salary' }],
  });
  expect(view.currentPropositionIds).toEqual([]);
  expect(view.lastKnownPropositionIds).toEqual(['salary']);
  expect(view.historicalPropositionIds).toEqual(['old-salary']);
  expect(view.origins).toEqual([{ propositionId: 'salary', basis: 'EXPLICIT' }]);
});

it('does not age unfinished commitments into completion or turn temporary episodes into stable facts', () => {
  const input: UnderstandingInput = { ...base,
    futureClaims: [{ propositionId: 'promise', frameInstanceId: 'unfinished', modality: 'COMMITTED' }],
    currentBeliefs: [{ propositionId: 'sick', frameInstanceId: 'week', frameTypeId: 'test.health' }],
    selections: [{ selectedPropositionId: 'sick', outcome: 'SELECTED', modality: 'ACTUAL', claimOrigins: ['USER_STATEMENT'] }],
    freshness: [{ propositionId: 'sick', assessment: { state: 'OUTSIDE_INTERVAL' } }],
  };
  expect(deriveUnderstanding(input)).toMatchObject({ currentPropositionIds: [], lastKnownPropositionIds: [], unresolvedFrameIds: ['unfinished'] });
  expect(deriveUnderstanding({ ...input, resolutionAssertions: [{ sourceFrameInstanceId: 'unfinished', lifecycle: 'ACCEPTED', outcomeCode: 'PARTIALLY_FULFILLED' }] }).unresolvedFrameIds).toEqual(['unfinished']);
  expect(deriveUnderstanding({ ...input, resolutionAssertions: [{ sourceFrameInstanceId: 'unfinished', lifecycle: 'ACCEPTED', outcomeCode: 'FULFILLED' }] }).unresolvedFrameIds).toEqual([]);
});

it('only carries recorded, authorized transitions and goal links without inventing a change reason', () => {
  const view = deriveUnderstanding({ ...base,
    currentBeliefs: [{ propositionId: 'new', frameInstanceId: 'preference', frameTypeId: 'test.preference' }],
    historicalBeliefs: [{ propositionId: 'old' }],
    transitions: [
      { fromPropositionId: 'old', toPropositionId: 'new', kind: 'SUPERSEDES', recordedAt: at, effectiveAt: at },
      { fromPropositionId: 'hidden', toPropositionId: 'new', kind: 'CORRECTS', recordedAt: at, effectiveAt: at },
    ],
    goalLinks: [{ frameInstanceId: 'preference', goalId: 'goal', claimId: 'claim', evidenceId: 'source' },
      { frameInstanceId: 'hidden', goalId: 'other', claimId: 'claim', evidenceId: 'source' }],
    unknowns: [{ kind: 'PROCESSING_INCOMPLETE' }],
  });
  expect(view.transitions).toEqual([{ fromPropositionId: 'old', toPropositionId: 'new', kind: 'SUPERSEDES', recordedAt: at, effectiveAt: at, rationalePropositionId: null }]);
  expect(view.goalLinks.map(link => link.goalId)).toEqual(['goal']);
  expect(view.complete).toBe(false);
});
