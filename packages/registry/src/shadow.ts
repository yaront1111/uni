import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { shadowReportSchema, type ShadowReport } from '@unai/domain';
import { CANONICAL_NORMALIZATION_VERSION, INSTANCE_MATCHER_VERSION, canonicalJson, propositionFingerprint,
  scoreInstanceMatch, slotFingerprint, validateTransition } from '@unai/memory';
import { admittedAssessmentStatus, selectAdmissionMode, VALIDATION_VERSION } from '@unai/belief';
import { REDUCER_VERSION } from '@unai/capabilities';
import type { LoadedRegistryRelease } from './release.js';
import { findPredicate, validatePredicateValue } from './values.js';

/** The shadow evaluation engine (PRD §22.2 Shadow, §22.4, §43.5; CRT-WRT-09-A).
 *
 * One sample, two pipelines. A REGISTRY run evaluates the same claims under a
 * baseline and a candidate registry release; an EXTRACTOR run evaluates the
 * claims two extractor versions produced under one release. Both sides run the
 * *production* keying and admission code -- `scoreInstanceMatch`,
 * `slotFingerprint`, `propositionFingerprint`, the registry value validator,
 * `validateTransition`, `selectAdmissionMode` -- so a diff is a statement about
 * what production would do, not about a model of it.
 *
 * The engine is pure: it reads nothing and writes nothing. Reading an owner's
 * sample happens in a READ ONLY transaction (`shadow-store.ts`), and the only
 * write of a run is its own `shadow_evaluation_runs` record afterwards.
 *
 * Every diff entry carries an object reference and a stable code on each side:
 * outcomes, admission statuses and short partition digests. No value from the
 * sample reaches a report.
 */

export type ContextKind = 'BASE' | 'QUOTED' | 'TEST';
export interface ShadowInstance { readonly ref: string; readonly frameType: string; readonly roles: readonly { roleId: string; entityRef: string | null }[] }
export interface ShadowClaim {
  readonly ref: string;
  /** What diffs are keyed on: the claim itself for a REGISTRY run, its source
   * anchor and predicate for an EXTRACTOR run (the two sides are different claims). */
  readonly matchKey: string;
  readonly instanceRef: string;
  readonly predicateId: string;
  readonly contextKind: ContextKind;
  readonly modality: string;
  readonly qualifiers: Readonly<Record<string, string | number | boolean>>;
  readonly value: unknown;
  readonly polarity: 'POSITIVE' | 'NEGATIVE';
  /** The live assessment in production, null for a corpus sample. */
  readonly recordedStatus: string | null;
  readonly sourceAuthoritative: boolean;
}
export interface ShadowResolution {
  readonly ref: string; readonly instanceRef: string; readonly transitionContractId: string;
  readonly linkKind: 'RESOLVES' | 'REALIZES'; readonly outcomeCode: string | null; readonly targetFrameType: string | null;
}
export interface ShadowCost { readonly items: number; readonly costMicrounits: number; readonly latencyMs: number }
export interface ShadowSide { readonly claims: readonly ShadowClaim[]; readonly cost: ShadowCost | null }
export interface ShadowSample {
  readonly kind: 'CORPUS' | 'OWNER_SAMPLE';
  readonly corpus: 'REAL' | 'SYNTHETIC' | null;
  readonly limit: number;
  readonly instances: readonly ShadowInstance[];
  readonly resolutions: readonly ShadowResolution[];
  readonly baseline: ShadowSide;
  readonly candidate: ShadowSide;
  /** Owner samples only: the stored projection rows against a read-only replay. */
  readonly storedProjection?: { readonly storedRows: number; readonly replayEqualsStored: boolean } | null;
}

type Release = Pick<LoadedRegistryRelease, 'version' | 'frames' | 'transitions'>;

interface Evaluation {
  readonly instancePairs: Map<string, string>;
  readonly slots: Map<string, string>;
  readonly propositions: Map<string, string>;
  readonly fingerprints: Map<string, string>;
  readonly statuses: Map<string, string>;
  readonly resolutions: Map<string, string>;
  readonly projectionRows: Map<string, string>;
  readonly latencyMs: number;
}

const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex').slice(0, 12);

/** A stable UUID for a corpus reference, so production fingerprint functions
 * that require identifiers can run over a sample that has none. Version nibble
 * 8 marks it as derived; it is never stored as an identity. */
export function referenceUuid(ref: string): string {
  const hex = createHash('sha256').update('unai-shadow-ref:' + ref).digest('hex');
  const variant = (8 + (parseInt(hex[16]!, 16) & 3)).toString(16);
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-8' + hex.slice(13, 16) + '-' + variant + hex.slice(17, 20) + '-' + hex.slice(20, 32);
}

/** Partition digest per member: every member of one group gets the digest of the
 * group's sorted member keys, so two runs agree exactly when they grouped alike,
 * whatever the groups are named. */
function partition(groups: Map<string, string[]>): Map<string, string> {
  const out = new Map<string, string>();
  for (const members of groups.values()) {
    const code = 'G' + digest([...members].sort());
    for (const member of members) out.set(member, code);
  }
  return out;
}

function evaluate(release: Release, sample: ShadowSample, claims: readonly ShadowClaim[], normalizationVersion: string): Evaluation {
  const started = performance.now();
  const frames = new Map(release.frames.map(frame => [frame.id, frame]));
  const instances = new Map(sample.instances.map(instance => [instance.ref, instance]));

  // Instance matching: every pair of same-type instances, with the signals the
  // release's identity anchors derive from their role fillers.
  const instancePairs = new Map<string, string>();
  const ordered = [...sample.instances].sort((a, b) => a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0);
  for (let i = 0; i < ordered.length; i++) {
    for (let j = i + 1; j < ordered.length; j++) {
      const left = ordered[i]!, right = ordered[j]!;
      if (left.frameType !== right.frameType) continue;
      const frame = frames.get(left.frameType);
      const key = left.ref + '|' + right.ref;
      if (!frame) { instancePairs.set(key, 'FRAME_UNREGISTERED'); continue; }
      const shared: string[] = [], conflicting: string[] = [];
      for (const anchor of frame.identityAnchors) {
        const a = left.roles.find(role => role.roleId === anchor)?.entityRef ?? null;
        const b = right.roles.find(role => role.roleId === anchor)?.entityRef ?? null;
        if (a !== null && b !== null) (a === b ? shared : conflicting).push(anchor);
      }
      instancePairs.set(key, scoreInstanceMatch({ sharedResolvedEntityRoles: shared, conflictingEntityRoles: conflicting }).outcome);
    }
  }

  // Slots and propositions, exactly as the stores key them: the slot by its
  // canonical descriptor (which excludes the value), the proposition by slot,
  // normalized value and polarity. A claim the release cannot key gets a code.
  const refused = new Map<string, string>();
  const slotGroups = new Map<string, string[]>(), propositionGroups = new Map<string, string[]>();
  const fingerprints = new Map<string, string>();
  const slotOf = new Map<string, string>(), cardinalityOf = new Map<string, string>(), valueOf = new Map<string, string>();
  for (const claim of claims) {
    const instance = instances.get(claim.instanceRef);
    const frame = instance ? frames.get(instance.frameType) : undefined;
    const predicate = findPredicate(release, claim.predicateId);
    if (!frame || !predicate || predicate.frameType !== frame.id) { refused.set(claim.matchKey, 'UNREGISTERED_PREDICATE'); continue; }
    if (!predicate.allowedModalities.includes(claim.modality as never)) { refused.set(claim.matchKey, 'MODALITY_REFUSED'); continue; }
    if (!frame.contextPolicy.allowedKinds.includes(claim.contextKind)) { refused.set(claim.matchKey, 'CONTEXT_REFUSED'); continue; }
    let normalizedValue: unknown;
    try { normalizedValue = validatePredicateValue(release, claim.predicateId, claim.value); }
    catch { refused.set(claim.matchKey, 'VALUE_INVALID'); continue; }
    // Only the qualifiers the predicate declares are part of the slot.
    const qualifiers = Object.fromEntries(Object.entries(claim.qualifiers).filter(([key]) => predicate.slotQualifiers.includes(key)));
    const descriptor = { frameInstanceId: referenceUuid(claim.instanceRef), predicateId: claim.predicateId,
      contextSpaceId: referenceUuid('context:' + claim.contextKind), modality: claim.modality as never, qualifiers };
    const slotKey = canonicalJson(descriptor);
    const slotId = referenceUuid('slot:' + slotKey);
    const propositionKey = canonicalJson({ slotKey, normalizedValue, polarity: claim.polarity });
    slotGroups.set(slotKey, [...(slotGroups.get(slotKey) ?? []), claim.matchKey]);
    propositionGroups.set(propositionKey, [...(propositionGroups.get(propositionKey) ?? []), claim.matchKey]);
    fingerprints.set(claim.matchKey, slotFingerprint(descriptor, normalizationVersion).slice(0, 12) + ':'
      + propositionFingerprint({ beliefSlotId: slotId, normalizedValue, polarity: claim.polarity }, normalizationVersion).slice(0, 12));
    slotOf.set(claim.matchKey, slotKey);
    cardinalityOf.set(slotKey, predicate.cardinality);
    valueOf.set(claim.matchKey, propositionKey);
  }
  // A FUNCTIONAL slot holding more than one proposition is a collision.
  const collided = new Set<string>();
  for (const [slotKey, members] of slotGroups) {
    if (cardinalityOf.get(slotKey) === 'FUNCTIONAL' && new Set(members.map(member => valueOf.get(member))).size > 1) collided.add(slotKey);
  }
  const slotPartition = partition(slotGroups), propositionPartition = partition(propositionGroups);
  const slots = new Map<string, string>(), propositions = new Map<string, string>(), statuses = new Map<string, string>();
  for (const claim of claims) {
    const code = refused.get(claim.matchKey);
    if (code) {
      slots.set(claim.matchKey, code);
      propositions.set(claim.matchKey, code);
    } else {
      const slotKey = slotOf.get(claim.matchKey)!;
      slots.set(claim.matchKey, slotPartition.get(claim.matchKey)! + (collided.has(slotKey) ? ':COLLISION' : ':NONE'));
      propositions.set(claim.matchKey, propositionPartition.get(claim.matchKey)!);
    }
    // Admission, through the governor's own decision: a claim the release cannot
    // key is not a registered predicate, and a collision is a material conflict.
    const predicate = findPredicate(release, claim.predicateId);
    const decision = selectAdmissionMode({
      memoryWorthiness: 'SEMANTIC', predicateRegistered: !code, identityResolved: instances.has(claim.instanceRef),
      sourceAuthoritative: claim.sourceAuthoritative, materialConflict: !code && collided.has(slotOf.get(claim.matchKey)!),
      errorConsequence: predicate?.valueType === 'MONEY' ? 'MEDIUM' : 'LOW', reversible: true, audited: true,
      blocksCurrentAnswer: false,
    });
    const admitted = admittedAssessmentStatus(decision.mode);
    // A recorded verdict stands while the claim stays admissible and
    // uncontested; the release can only take admission away or add a conflict.
    const status = admitted === null ? decision.mode
      : !code && collided.has(slotOf.get(claim.matchKey)!) && claim.recordedStatus === 'ACCEPTED' ? 'CONTESTED'
        : claim.recordedStatus ?? admitted;
    statuses.set(claim.matchKey, status);
  }

  const resolutions = new Map<string, string>();
  for (const resolution of sample.resolutions) {
    const instance = instances.get(resolution.instanceRef);
    try {
      validateTransition({ transitionContracts: release.transitions as never, transitionContractId: resolution.transitionContractId,
        linkKind: resolution.linkKind, sourceFrameTypeId: instance?.frameType ?? 'unknown.frame',
        targetFrameTypeId: resolution.targetFrameType, outcomeCode: resolution.outcomeCode as never });
      resolutions.set(resolution.ref, 'VALID');
    } catch (error) {
      resolutions.set(resolution.ref, error instanceof Error && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.message) ? error.message : 'TRANSITION_REFUSED');
    }
  }

  // Projection rows: which consumers project each instance under this release,
  // and which of their fields are fed by admissible claims.
  const projectionRows = new Map<string, string>();
  for (const instance of sample.instances) {
    const frame = frames.get(instance.frameType);
    if (!frame) continue;
    for (const consumer of frame.projectionConsumers) {
      const fields = new Set<string>();
      for (const claim of claims) {
        if (claim.instanceRef !== instance.ref || refused.has(claim.matchKey)) continue;
        for (const field of findPredicate(release, claim.predicateId)?.projectionContracts ?? []) {
          if (field.startsWith(consumer + '.')) fields.add(field);
        }
      }
      projectionRows.set(consumer + ':' + instance.ref, 'F' + digest([...fields].sort()));
    }
  }
  return { instancePairs, slots, propositions, fingerprints, statuses, resolutions, projectionRows, latencyMs: performance.now() - started };
}

const MAX_ENTRIES = 500;
function diff(baseline: Map<string, string>, candidate: Map<string, string>, codeFor: (b: string | null, c: string | null) => string,
  notes: Record<string, number | boolean | string> = {}) {
  const keys = [...new Set([...baseline.keys(), ...candidate.keys()])].sort();
  const entries: { ref: string; code: string; baseline: string | null; candidate: string | null }[] = [];
  let changed = 0;
  for (const key of keys) {
    const b = baseline.get(key) ?? null, c = candidate.get(key) ?? null;
    if (b === c) continue;
    changed++;
    if (entries.length < MAX_ENTRIES) entries.push({ ref: key.slice(0, 200), code: codeFor(b, c), baseline: b, candidate: c });
  }
  return { compared: keys.length, changed, entries, truncated: changed > entries.length, notes };
}
const presence = (fallback: string) => (b: string | null, c: string | null) => b === null ? 'ONLY_CANDIDATE' : c === null ? 'ONLY_BASELINE' : fallback;

export interface ShadowRunInput {
  readonly runKind: 'REGISTRY' | 'EXTRACTOR';
  readonly baselineVersion: string;
  readonly candidateVersion: string;
  readonly baselineRelease: Release;
  readonly candidateRelease: Release;
  readonly sample: ShadowSample;
  readonly extractor?: { readonly baseline: string; readonly candidate: string };
  readonly normalizationVersion?: { readonly baseline: string; readonly candidate: string };
  readonly runId?: string;
  readonly now?: Date;
  /** Set by the caller that compared the production digest before and after. */
  readonly productionUnchanged?: boolean | null;
}

/** Run both pipelines over the sample and emit the seven diffs of PRD §43.5. */
export function runShadowEvaluation(input: ShadowRunInput): ShadowReport {
  const normalization = input.normalizationVersion ?? { baseline: CANONICAL_NORMALIZATION_VERSION, candidate: CANONICAL_NORMALIZATION_VERSION };
  const baseline = evaluate(input.baselineRelease, input.sample, input.sample.baseline.claims, normalization.baseline);
  const candidate = evaluate(input.candidateRelease, input.sample, input.sample.candidate.claims, normalization.candidate);
  // A fingerprint may change with normalization while identity does not; the
  // proposition diff counts those separately so a version bump is visible
  // without being mistaken for a regrouping (PRD §13.2).
  let fingerprintOnly = 0;
  for (const [key, value] of baseline.fingerprints) {
    if (candidate.fingerprints.has(key) && candidate.fingerprints.get(key) !== value
      && baseline.propositions.get(key) === candidate.propositions.get(key)) fingerprintOnly++;
  }
  const cost = (side: ShadowSide, evaluation: Evaluation) => side.cost
    ? { items: side.cost.items, costMicrounits: side.cost.costMicrounits, latencyMs: side.cost.latencyMs }
    : { items: side.claims.length, costMicrounits: 0, latencyMs: Number(evaluation.latencyMs.toFixed(3)) };
  const baselineCost = cost(input.sample.baseline, baseline), candidateCost = cost(input.sample.candidate, candidate);
  const collisions = (evaluation: Evaluation) => [...evaluation.slots.values()].filter(value => value.endsWith(':COLLISION')).length;
  const report = {
    format: 'unai-shadow-diff/1' as const,
    runId: input.runId ?? randomUUID(),
    runKind: input.runKind,
    sampleRef: { kind: input.sample.kind, corpus: input.sample.corpus, frameInstances: input.sample.instances.length,
      claims: new Set([...input.sample.baseline.claims, ...input.sample.candidate.claims].map(claim => claim.matchKey)).size,
      resolutions: input.sample.resolutions.length, limit: input.sample.limit },
    baselineVersion: input.baselineVersion,
    candidateVersion: input.candidateVersion,
    evaluationVersions: {
      extractor: input.extractor ?? { baseline: 'recorded', candidate: 'recorded' },
      registryRelease: { baseline: input.baselineRelease.version, candidate: input.candidateRelease.version },
      beliefEngine: VALIDATION_VERSION,
      projectionReducer: REDUCER_VERSION,
      normalization: normalization.baseline === normalization.candidate ? normalization.baseline : normalization.baseline + '..' + normalization.candidate,
      instanceMatcher: INSTANCE_MATCHER_VERSION,
    },
    diffs: {
      instanceMatch: diff(baseline.instancePairs, candidate.instancePairs, presence('MATCH_OUTCOME_CHANGED')),
      slotCollision: diff(baseline.slots, candidate.slots, (b, c) => b === null ? 'ONLY_CANDIDATE' : c === null ? 'ONLY_BASELINE'
        : b.split(':')[0] === c.split(':')[0] ? (c.endsWith(':COLLISION') ? 'COLLISION_APPEARED' : 'COLLISION_RESOLVED') : 'SLOT_REGROUPED',
        { baselineCollisions: collisions(baseline), candidateCollisions: collisions(candidate) }),
      proposition: diff(baseline.propositions, candidate.propositions, presence('PROPOSITION_REGROUPED'), { fingerprintOnlyChanges: fingerprintOnly }),
      beliefStatus: diff(baseline.statuses, candidate.statuses, presence('STATUS_CHANGED')),
      resolution: diff(baseline.resolutions, candidate.resolutions, (_b, c) => c === 'VALID' ? 'RESOLUTION_ADMITTED' : 'RESOLUTION_REFUSED'),
      projection: diff(baseline.projectionRows, candidate.projectionRows, presence('PROJECTION_FIELDS_CHANGED'),
        input.sample.storedProjection ? { storedRows: input.sample.storedProjection.storedRows,
          replayEqualsStored: input.sample.storedProjection.replayEqualsStored } : {}),
      costAndLatency: { baseline: baselineCost, candidate: candidateCost,
        deltaCostMicrounits: candidateCost.costMicrounits - baselineCost.costMicrounits,
        deltaLatencyMs: Number((candidateCost.latencyMs - baselineCost.latencyMs).toFixed(3)) },
    },
    productionUnchanged: input.productionUnchanged ?? null,
    createdAt: (input.now ?? new Date()).toISOString(),
  };
  return shadowReportSchema.parse(report);
}
