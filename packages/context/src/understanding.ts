import { closedFrameIds } from './resolutions.js';

export interface UnderstandingTransition {
  fromPropositionId: string; toPropositionId: string; kind: string;
  recordedAt: string; effectiveAt: string | null;
}
export interface UnderstandingGoalLink {
  frameInstanceId: string; goalId: string; claimId: string; evidenceId: string;
}
export interface UnderstandingInput {
  worldTime: string;
  currentBeliefs: readonly { propositionId: string; frameInstanceId: string; frameTypeId: string }[];
  historicalBeliefs: readonly { propositionId: string }[];
  futureClaims: readonly { propositionId: string; frameInstanceId: string; modality: string }[];
  selections: readonly { selectedPropositionId: string | null; outcome: string; modality: string; claimOrigins: readonly string[] }[];
  resolutionAssertions: readonly { sourceFrameInstanceId: string; lifecycle: string; outcomeCode: string }[];
  freshness: readonly { propositionId: string; assessment: { state: string } }[];
  transitions: readonly UnderstandingTransition[];
  goalLinks: readonly UnderstandingGoalLink[];
  unknowns: readonly { kind: string }[];
}

/** A read view over an authorized packet, never an independent truth store. */
export function deriveUnderstanding(input: UnderstandingInput) {
  const sorted = (ids: Iterable<string>) => [...new Set(ids)].sort();
  const supplied = new Set([...input.currentBeliefs, ...input.historicalBeliefs, ...input.futureClaims].map(value => value.propositionId));
  const frames = new Set([...input.currentBeliefs, ...input.futureClaims].map(value => value.frameInstanceId));
  const freshness = new Map(input.freshness.map(value => [value.propositionId, value.assessment.state]));
  const selected = input.selections.filter(value => value.outcome === 'SELECTED' && value.selectedPropositionId
    && supplied.has(value.selectedPropositionId));
  const actual = selected.filter(value => value.modality === 'ACTUAL');
  const origins = selected.map(value => ({ propositionId: value.selectedPropositionId!,
    basis: value.claimOrigins.some(origin => ['USER_STATEMENT', 'USER_CONFIRMATION', 'USER_CORRECTION'].includes(origin))
      ? 'EXPLICIT' as const : value.claimOrigins.every(origin => origin.startsWith('MODEL_'))
        ? 'INFERRED' as const : 'REPORTED' as const }));
  const openFrames = new Set([...input.futureClaims.filter(value => ['COMMITTED', 'INTENDED'].includes(value.modality)).map(value => value.frameInstanceId),
    ...input.currentBeliefs.filter(value => value.frameTypeId === 'shared.obligation').map(value => value.frameInstanceId)]);
  for (const frame of closedFrameIds(input.resolutionAssertions)) openFrames.delete(frame);
  return { asOf: input.worldTime,
    currentPropositionIds: sorted(actual.filter(value => freshness.get(value.selectedPropositionId!) === 'CURRENT').map(value => value.selectedPropositionId!)),
    lastKnownPropositionIds: sorted(actual.filter(value => !['CURRENT', 'OUTSIDE_INTERVAL'].includes(freshness.get(value.selectedPropositionId!) ?? 'UNKNOWN')).map(value => value.selectedPropositionId!)),
    historicalPropositionIds: sorted(input.historicalBeliefs.map(value => value.propositionId)),
    unresolvedFrameIds: sorted(openFrames), origins,
    transitions: input.transitions.filter(value => supplied.has(value.fromPropositionId) && supplied.has(value.toPropositionId)
      && (value.effectiveAt === null || value.effectiveAt <= input.worldTime))
      .map(value => ({ ...value, rationalePropositionId: null as string | null })),
    goalLinks: input.goalLinks.filter(value => frames.has(value.frameInstanceId)),
    complete: !input.unknowns.some(value => ['RETRIEVAL_INCOMPLETE', 'PROCESSING_INCOMPLETE', 'HISTORY_NOT_RECORDED',
      'EVIDENCE_WITHHELD', 'PROJECTION_INCOMPLETE'].includes(value.kind)),
  };
}
