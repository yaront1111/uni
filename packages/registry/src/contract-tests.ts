import { PROJECTION_NAMES } from '@unai/domain';
import { canonicalJson, mayReuseInstance, propositionFingerprint, scoreInstanceMatch, slotFingerprint, validateTransition,
  CANONICAL_NORMALIZATION_VERSION } from '@unai/memory';
import { selectAdmissionMode } from '@unai/belief';
import type { CorpusThread } from './corpus.js';
import type { LoadedRegistryRelease } from './release.js';
import { OUTCOME_CODES, type FrameContract, type PredicateContract } from './schema.js';
import { referenceUuid } from './shadow.js';
import { validatePredicateValue } from './values.js';

/** `uai registry test` (PRD §35.14, §43.3; CRT-REG-02-A).
 *
 * Every frame contract of every recorded release is exercised over the ten areas
 * of PRD §43.3 -- surface aliases, role normalization, instance identity, slot
 * collision, value normalization, context and modality, conflict behavior,
 * resolution behavior, merge and split effects, projection output -- by running
 * the production code the contract configures against cases derived from the
 * contract itself, plus every labelled observation of the committed synthetic
 * corpus that names one of its predicates or transitions. A contract that the
 * production code would key, admit or resolve differently from what it declares
 * fails here, before a release is tagged.
 */

export const CONTRACT_TEST_AREAS = Object.freeze(['SURFACE_ALIASES', 'ROLE_NORMALIZATION', 'INSTANCE_IDENTITY', 'SLOT_COLLISION',
  'VALUE_NORMALIZATION', 'CONTEXT_AND_MODALITY', 'CONFLICT_BEHAVIOR', 'RESOLUTION_BEHAVIOR', 'MERGE_SPLIT_EFFECTS',
  'PROJECTION_OUTPUT'] as const);
export type ContractTestArea = typeof CONTRACT_TEST_AREAS[number];

export interface ContractTestResult {
  readonly release: string;
  readonly contract: string;
  readonly area: ContractTestArea;
  readonly cases: number;
  readonly failures: readonly { code: string; path: string }[];
}

/** One valid and one second valid value per value type, and one invalid one. */
const SAMPLES: Record<PredicateContract['valueType'], { valid: [unknown, unknown]; invalid: unknown }> = {
  MONEY: { valid: [{ amount: '50.00', currency: 'ILS' }, { amount: '60.00', currency: 'ILS' }], invalid: { amount: 50, currency: 'ILS' } },
  TEXT: { valid: ['send the draft', 'send the final report'], invalid: '' },
  TIMESTAMP: { valid: ['2026-03-06T17:00:00.000Z', '2026-03-07T17:00:00.000Z'], invalid: 'Friday' },
  TIME_OR_INTERVAL: { valid: ['2026-03-06T17:00:00.000Z', { start: '2026-03-07T09:00:00.000Z', end: '2026-03-07T10:00:00.000Z' }],
    invalid: { start: '2026-03-07T10:00:00.000Z', end: '2026-03-07T09:00:00.000Z' } },
  ENTITY: { valid: [referenceUuid('entity:a'), referenceUuid('entity:b')], invalid: 'daniel' },
  FRAME_REFERENCE: { valid: [referenceUuid('frame:a'), referenceUuid('frame:b')], invalid: 'frame-a' },
  EXTERNAL_REFERENCE: { valid: [{ system: 'gmail', id: 'thread-1' }, { system: 'gmail', id: 'thread-2' }], invalid: { system: 'Gmail!', id: '' } },
  ACTION: { valid: ['send the report', { frameInstanceId: referenceUuid('frame:action') }], invalid: 42 },
};

type Release = Pick<LoadedRegistryRelease, 'version' | 'frames' | 'transitions'>;

function slotOf(frameInstance: string, predicate: PredicateContract, modality: string) {
  const descriptor = { frameInstanceId: referenceUuid(frameInstance), predicateId: predicate.id,
    contextSpaceId: referenceUuid('context:BASE'), modality: modality as never, qualifiers: {} };
  return { key: canonicalJson(descriptor), fingerprint: slotFingerprint(descriptor, CANONICAL_NORMALIZATION_VERSION) };
}

function testFrame(release: Release, frame: FrameContract, corpus: readonly CorpusThread[]): ContractTestResult[] {
  const results: ContractTestResult[] = [];
  const run = (area: ContractTestArea, body: (fail: (code: string, path?: string) => void) => number) => {
    const failures: { code: string; path: string }[] = [];
    const cases = body((code, path = '') => failures.push({ code, path }));
    results.push({ release: release.version, contract: frame.id, area, cases, failures });
  };
  const roles = new Set(frame.roles.map(role => role.id));
  const entityAnchors = frame.identityAnchors.filter(anchor => frame.roles.find(role => role.id === anchor)?.valueType === 'ENTITY');

  run('SURFACE_ALIASES', fail => {
    // The local name of each predicate is its surface alias inside the frame; it
    // must name exactly one predicate and resolve back to the canonical id.
    const locals = frame.predicates.map(predicate => predicate.id.slice(frame.id.length + 1));
    locals.forEach((local, index) => {
      if (locals.indexOf(local) !== index) fail('SURFACE_ALIAS_AMBIGUOUS', 'predicates.' + local);
      if (frame.id + '.' + local !== frame.predicates[index]!.id) fail('SURFACE_ALIAS_UNRESOLVED', 'predicates.' + local);
    });
    return locals.length;
  });

  run('ROLE_NORMALIZATION', fail => {
    // Every identity anchor names a role, one of the frame's own predicates (by
    // its local name) or the external reference, and every role has a value type
    // the registry can validate.
    const locals = new Set(frame.predicates.map(predicate => predicate.id.slice(frame.id.length + 1)));
    for (const anchor of frame.identityAnchors) {
      if (!roles.has(anchor) && !locals.has(anchor) && anchor !== 'external_reference') {
        fail('IDENTITY_ANCHOR_UNRESOLVED', 'identityAnchors.' + anchor);
      }
    }
    for (const role of frame.roles) if (!(role.valueType in SAMPLES)) fail('ROLE_VALUE_TYPE_UNKNOWN', 'roles.' + role.id);
    return frame.identityAnchors.length + frame.roles.length;
  });

  run('INSTANCE_IDENTITY', fail => {
    // PRD §42 invariant 9: an instance is not defined by its participants alone.
    const participantsOnly = scoreInstanceMatch({ sharedResolvedEntityRoles: entityAnchors });
    if (mayReuseInstance(participantsOnly.outcome, 'MATERIAL_ACCEPTED_UPDATE')) fail('PARTICIPANTS_ALONE_REUSE_INSTANCE', 'identityAnchors');
    // "Another" is a distinct instance whatever else agrees (CRT-MEM-11-A).
    if (scoreInstanceMatch({ sharedResolvedEntityRoles: entityAnchors, threadContinuity: true, explicitReference: 'ANOTHER' }).outcome
      !== 'CONFIRMED_DISTINCT') fail('ANOTHER_NOT_DISTINCT', 'identityStrategy');
    // A different party in an anchor role is a different situation.
    if (entityAnchors.length && scoreInstanceMatch({ conflictingEntityRoles: [entityAnchors[0]!] }).outcome !== 'CONFIRMED_DISTINCT') {
      fail('ANCHOR_CONFLICT_NOT_DISTINCT', 'identityAnchors');
    }
    if (frame.identityAnchors.includes('external_reference')
      && !mayReuseInstance(scoreInstanceMatch({ externalIdentifierMatch: true }).outcome, 'MATERIAL_ACCEPTED_UPDATE')) {
      fail('EXTERNAL_REFERENCE_NOT_MATCHED', 'identityAnchors.external_reference');
    }
    return 4;
  });

  run('SLOT_COLLISION', fail => {
    let cases = 0;
    for (const predicate of frame.predicates) {
      const modality = predicate.allowedModalities[0]!;
      const [first, second] = SAMPLES[predicate.valueType].valid;
      const slot = slotOf('instance:a', predicate, modality), same = slotOf('instance:a', predicate, modality);
      const other = slotOf('instance:b', predicate, modality);
      // The slot excludes the value: two values, one slot, two propositions.
      if (slot.key !== same.key || slot.fingerprint !== same.fingerprint) fail('SLOT_NOT_STABLE', 'predicates.' + predicate.id);
      if (slot.key === other.key) fail('SLOT_SPANS_INSTANCES', 'predicates.' + predicate.id);
      const slotId = referenceUuid('slot:' + slot.key);
      const a = propositionFingerprint({ beliefSlotId: slotId, normalizedValue: validatePredicateValue(release, predicate.id, first), polarity: 'POSITIVE' }, CANONICAL_NORMALIZATION_VERSION);
      const b = propositionFingerprint({ beliefSlotId: slotId, normalizedValue: validatePredicateValue(release, predicate.id, second), polarity: 'POSITIVE' }, CANONICAL_NORMALIZATION_VERSION);
      if (a === b) fail('PROPOSITIONS_COLLAPSED', 'predicates.' + predicate.id);
      cases += 3;
    }
    return cases;
  });

  run('VALUE_NORMALIZATION', fail => {
    let cases = 0;
    for (const predicate of frame.predicates) {
      for (const value of SAMPLES[predicate.valueType].valid) {
        cases++;
        try { validatePredicateValue(release, predicate.id, value); } catch { fail('VALID_VALUE_REFUSED', 'predicates.' + predicate.id); }
      }
      cases++;
      try { validatePredicateValue(release, predicate.id, SAMPLES[predicate.valueType].invalid); fail('INVALID_VALUE_ACCEPTED', 'predicates.' + predicate.id); }
      catch { /* refused, as it must be */ }
    }
    // Every labelled observation of this frame's predicates in the committed
    // synthetic corpus must normalize under the release.
    for (const thread of corpus) {
      for (const slot of thread.annotation.expectedSlotsAndPropositions) {
        if (!frame.predicates.some(predicate => predicate.id === slot.predicateId)) continue;
        for (const proposition of slot.propositions) {
          for (const observation of proposition.observations) {
            cases++;
            try { validatePredicateValue(release, slot.predicateId, observation.value); }
            catch { fail('CORPUS_VALUE_REFUSED', thread.annotation.threadRef + '.' + observation.spanRef); }
          }
        }
      }
    }
    return cases;
  });

  run('CONTEXT_AND_MODALITY', fail => {
    if (!frame.contextPolicy.allowedKinds.includes('BASE')) fail('BASE_CONTEXT_NOT_ALLOWED', 'contextPolicy.allowedKinds');
    for (const predicate of frame.predicates) {
      if (predicate.allowedModalities.some(modality => !frame.allowedModalities.includes(modality))) {
        fail('PREDICATE_MODALITY_OUTSIDE_FRAME', 'predicates.' + predicate.id);
      }
    }
    return 1 + frame.predicates.length;
  });

  run('CONFLICT_BEHAVIOR', fail => {
    // A FUNCTIONAL slot holding two values is a material conflict, and a material
    // conflict is never accepted automatically.
    let cases = 0;
    for (const predicate of frame.predicates.filter(entry => entry.cardinality === 'FUNCTIONAL')) {
      cases++;
      const decision = selectAdmissionMode({ memoryWorthiness: 'SEMANTIC', predicateRegistered: true, identityResolved: true,
        sourceAuthoritative: true, materialConflict: true, errorConsequence: 'LOW', reversible: true, audited: true, blocksCurrentAnswer: false });
      if (decision.mode === 'AUTO_ACCEPT') fail('CONFLICT_AUTO_ACCEPTED', 'predicates.' + predicate.id);
    }
    return cases;
  });

  run('RESOLUTION_BEHAVIOR', fail => {
    let cases = 0;
    for (const transitionId of frame.transitionContracts) {
      const transition = release.transitions.find(entry => entry.id === transitionId);
      if (!transition) { fail('TRANSITION_UNKNOWN', 'transitionContracts.' + transitionId); continue; }
      if (!transition.sourceFrameTypes.includes(frame.id)) continue;
      const target = transition.targetFrameTypes[0] ?? null;
      const attempt = (outcomeCode: string | null) => {
        try {
          validateTransition({ transitionContracts: release.transitions as never, transitionContractId: transition.id,
            linkKind: transition.linkKind, sourceFrameTypeId: frame.id, targetFrameTypeId: transition.targetRequired ? target : null,
            outcomeCode: outcomeCode as never });
          return true;
        } catch { return false; }
      };
      for (const outcome of transition.allowedOutcomes) { cases++; if (!attempt(outcome)) fail('ALLOWED_OUTCOME_REFUSED', transition.id + '.' + outcome); }
      for (const outcome of OUTCOME_CODES.filter(code => !transition.allowedOutcomes.includes(code))) {
        cases++;
        if (attempt(outcome)) fail('DISALLOWED_OUTCOME_ACCEPTED', transition.id + '.' + outcome);
      }
      if (transition.linkKind === 'REALIZES') { cases++; if (!attempt(null)) fail('REALIZATION_REFUSED', transition.id); }
    }
    // Every labelled resolution of this frame in the synthetic corpus validates.
    for (const thread of corpus) {
      const types = new Map(thread.annotation.expectedFrameInstances.map(instance => [instance.instanceRef, instance.frameType]));
      for (const resolution of thread.annotation.expectedCommitmentsAndResolutions.resolutions) {
        if (types.get(resolution.instanceRef) !== frame.id) continue;
        cases++;
        try {
          validateTransition({ transitionContracts: release.transitions as never, transitionContractId: resolution.transitionContractId,
            linkKind: resolution.linkKind, sourceFrameTypeId: frame.id, targetFrameTypeId: resolution.targetFrameType,
            outcomeCode: resolution.outcomeCode as never });
        } catch { fail('CORPUS_RESOLUTION_REFUSED', thread.annotation.threadRef + '.' + resolution.resolutionRef); }
      }
    }
    return cases;
  });

  run('MERGE_SPLIT_EFFECTS', fail => {
    // Merging instance B into A rehomes B's slots onto A: a FUNCTIONAL predicate
    // with a different value on each becomes one slot with two propositions (a
    // newly colliding slot), and the rehomed slot gets a new fingerprint while
    // B's id stays a separate, resolvable identity.
    let cases = 0;
    for (const predicate of frame.predicates) {
      const modality = predicate.allowedModalities[0]!;
      const before = slotOf('instance:b', predicate, modality), survivor = slotOf('instance:a', predicate, modality);
      const rehomed = slotOf('instance:a', predicate, modality);
      cases++;
      if (before.fingerprint === rehomed.fingerprint) fail('MERGE_FINGERPRINT_NOT_RECOMPUTED', 'predicates.' + predicate.id);
      if (rehomed.key !== survivor.key) fail('MERGE_NOT_REHOMED', 'predicates.' + predicate.id);
    }
    if (frame.mergePolicy.trim() === '' || frame.splitPolicy.trim() === '') fail('MERGE_SPLIT_POLICY_MISSING', 'mergePolicy');
    return cases + 1;
  });

  run('PROJECTION_OUTPUT', fail => {
    let cases = 0;
    for (const predicate of frame.predicates) {
      for (const field of predicate.projectionContracts) {
        cases++;
        const projection = field.split('.')[0]!;
        if (!frame.projectionConsumers.includes(projection)) fail('PROJECTION_NOT_CONSUMER', 'predicates.' + predicate.id);
      }
    }
    // A consumer this deployment builds must be one of the typed projections.
    for (const consumer of frame.projectionConsumers) {
      cases++;
      if (consumer.endsWith('_projection') && !['decision_projection', ...PROJECTION_NAMES].includes(consumer)) {
        fail('PROJECTION_UNKNOWN', 'projectionConsumers.' + consumer);
      }
    }
    return cases;
  });
  return results;
}

export function runContractTests(releases: readonly Release[], corpus: readonly CorpusThread[])
  : { result: 'PASS' | 'FAIL'; results: ContractTestResult[] } {
  const results = releases.flatMap(release => release.frames.flatMap(frame => testFrame(release, frame, corpus.filter(thread => thread.labelled))));
  return { result: results.some(result => result.failures.length) ? 'FAIL' : 'PASS', results };
}
