import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import {
  LABEL_CATEGORIES, PRODUCTION_KEYING_RULES, corpusAnnotationSchema, corpusResultsSchema, corpusStatusSchema, gmailThreadSchema,
  identityThresholdsSchema, parseSourcePayload, slotDescriptorSchema,
  type CorpusAnnotation, type CorpusKind, type CorpusResults, type CorpusStatus, type IdentityThresholds, type KeyingRule,
  type KeyingRuleResult, type LabelCategory,
} from '@unai/domain';
import {
  CANONICAL_NORMALIZATION_VERSION, ENTITY_RESOLVER_VERSION, INSTANCE_MATCHER_VERSION, canonicalJson, decideEntityResolution,
  isStrongAliasType, mayReuseInstance, normalizeAliasValue, propositionFingerprint, scoreInstanceMatch, slotFingerprint,
  validateTransition, type EntityAliasType,
} from '@unai/memory';
import { classifyCommitmentLanguage } from '@unai/capabilities';
import { RegistryError, type LoadedRegistryRelease } from './release.js';
import { referenceUuid, type ShadowSample } from './shadow.js';
import { validatePredicateValue } from './values.js';

/** The gold corpus (PRD §43.4, §46; CRT-QA-02-A, CRT-QA-03-A).
 *
 * Layout, relative to the repository:
 *
 *   corpus/synthetic/{threads,annotations}/   committed synthetic equivalents
 *   corpus/private-local/{threads,annotations}/  the real corpus: gitignored, and
 *                                              a commit adding a file there is
 *                                              refused by `.githooks/pre-commit`
 *   corpus/expected/identity-thresholds.json   thresholds CI scores against
 *   corpus/expected/real-corpus-results.json   the recorded real-corpus results:
 *                                              counts and rates only
 *
 * `UNAI_PRIVATE_CORPUS_DIR` may move the private corpus onto an encrypted volume
 * outside the repository; inside the repository it must be gitignored.
 *
 * Scoring runs the *production* keying rules -- `decideEntityResolution`,
 * `scoreInstanceMatch` with `mayReuseInstance`, slot descriptor identity with
 * `slotFingerprint`, and proposition identity with the registry value validator
 * and `propositionFingerprint` -- over the labelled observations, and compares
 * the identities they produce with the labelled ones pair by pair. Nothing read
 * from a thread leaves this module except counts, rates and stable codes.
 */

export const SYNTHETIC_CORPUS_DIR = 'corpus/synthetic';
export const DEFAULT_PRIVATE_CORPUS_DIR = 'corpus/private-local';
export const THRESHOLDS_FILE = 'corpus/expected/identity-thresholds.json';
export const REAL_RESULTS_FILE = 'corpus/expected/real-corpus-results.json';
export const PRECOMMIT_HOOK = '.githooks/pre-commit';

/** The production version each keying rule is scored at. */
export const KEYING_RULE_VERSIONS: Readonly<Record<KeyingRule, string>> = Object.freeze({
  'entity.strong_alias_exact': ENTITY_RESOLVER_VERSION,
  'frame_instance.confirmed_match': INSTANCE_MATCHER_VERSION,
  'belief_slot.descriptor_identity': CANONICAL_NORMALIZATION_VERSION,
  'proposition.normalized_value_identity': CANONICAL_NORMALIZATION_VERSION,
});

export function privateCorpusDir(repository: string, env: NodeJS.ProcessEnv = process.env): string {
  return resolve(repository, env.UNAI_PRIVATE_CORPUS_DIR ?? DEFAULT_PRIVATE_CORPUS_DIR);
}
export const corpusDir = (repository: string, kind: CorpusKind, env: NodeJS.ProcessEnv = process.env) =>
  kind === 'REAL' ? privateCorpusDir(repository, env) : resolve(repository, SYNTHETIC_CORPUS_DIR);

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

function git(repository: string, args: string[]): { status: number | null; stdout: string } {
  const result = spawnSync('git', args, { cwd: repository, encoding: 'utf8', timeout: 30000, shell: false,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return { status: result.error ? null : result.status, stdout: result.stdout ?? '' };
}
const insideRepository = (repository: string, path: string) => {
  const rel = relative(resolve(repository), resolve(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/** A private corpus inside the repository must be gitignored before anything is
 * written into it; outside the repository it cannot be committed at all. */
export function privatePathIgnored(repository: string, directory: string): boolean {
  if (!insideRepository(repository, directory)) return true;
  return git(repository, ['check-ignore', '-q', '--no-index', relative(resolve(repository), resolve(directory, 'threads', 'probe.json'))]).status === 0;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export interface CorpusThread {
  readonly annotation: CorpusAnnotation;
  readonly annotationDigest: string;
  /** Message id to body text, from the Tier-0 parser. */
  readonly bodies: ReadonlyMap<string, string>;
  readonly messages: number;
  readonly labelled: boolean;
}

/** A thread counts as labelled once it carries entities and either frame
 * instances or explicit non-memory items; a fresh skeleton does not. */
export function isLabelled(annotation: CorpusAnnotation): boolean {
  return annotation.expectedEntities.length > 0
    && (annotation.expectedFrameInstances.length > 0 || annotation.expectedUnknownsAndNonMemoryItems.length > 0);
}

async function listJson(directory: string): Promise<string[]> {
  try { return (await readdir(directory)).filter(name => /^[a-z0-9][a-z0-9_.-]{0,127}\.json$/.test(name)).sort(); }
  catch (error) { if ((error as { code?: string }).code === 'ENOENT') return []; throw error; }
}

export async function loadCorpus(directory: string, kind: CorpusKind): Promise<CorpusThread[]> {
  const threads: CorpusThread[] = [];
  for (const name of await listJson(resolve(directory, 'annotations'))) {
    const bytes = await readFile(resolve(directory, 'annotations', name));
    let annotation: CorpusAnnotation;
    try { annotation = corpusAnnotationSchema.parse(JSON.parse(bytes.toString('utf8'))); }
    catch { throw new RegistryError('CORPUS_ANNOTATION_INVALID', [{ code: 'CORPUS_ANNOTATION_INVALID', contract: name, path: '' }]); }
    if (annotation.corpusKind !== kind || name !== annotation.threadRef + '.json') {
      throw new RegistryError('CORPUS_ANNOTATION_INVALID', [{ code: 'CORPUS_ANNOTATION_MISPLACED', contract: name, path: 'threadRef' }]);
    }
    let raw: Buffer;
    try { raw = await readFile(resolve(directory, 'threads', annotation.source.threadFile)); }
    catch { throw new RegistryError('CORPUS_THREAD_MISSING', [{ code: 'CORPUS_THREAD_MISSING', contract: name, path: 'source.threadFile' }]); }
    if (sha256(raw) !== annotation.source.contentHash) {
      throw new RegistryError('CORPUS_THREAD_CHANGED', [{ code: 'CORPUS_THREAD_CHANGED', contract: name, path: 'source.contentHash' }]);
    }
    const items = parseSourcePayload('GMAIL', JSON.parse(raw.toString('utf8')));
    const bodies = new Map(items.map(item => [item.externalId, String(item.content['body'] ?? '')]));
    threads.push({ annotation, annotationDigest: sha256(bytes), bodies, messages: items.length, labelled: isLabelled(annotation) });
  }
  return threads;
}

export async function loadThresholds(repository: string): Promise<IdentityThresholds> {
  try { return identityThresholdsSchema.parse(JSON.parse(await readFile(resolve(repository, THRESHOLDS_FILE), 'utf8'))); }
  catch { throw new RegistryError('CORPUS_THRESHOLDS_INVALID'); }
}

// ---------------------------------------------------------------------------
// Import and annotate (the `uai corpus import` and `annotate` commands)
// ---------------------------------------------------------------------------

/** Content-free reference of a real Gmail thread: a digest of its thread id. */
export const gmailThreadRef = (threadId: string) => 'gmail-' + sha256('gmail-thread:' + threadId).slice(0, 16);

/** Copies one raw Gmail thread into the private corpus. Idempotent: the same
 * bytes again answer ALREADY_IMPORTED and write nothing; different bytes for an
 * imported thread are refused unless `update` is set, because the annotation was
 * labelled against the old bytes. */
export async function importGmailThread(repository: string, sourcePath: string, options: { update?: boolean; env?: NodeJS.ProcessEnv } = {})
  : Promise<{ threadRef: string; outcome: 'IMPORTED' | 'ALREADY_IMPORTED' | 'UPDATED'; messages: number }> {
  const directory = privateCorpusDir(repository, options.env);
  if (!privatePathIgnored(repository, directory)) throw new RegistryError('CORPUS_PRIVATE_PATH_NOT_IGNORED');
  let raw: Buffer;
  try { raw = await readFile(resolve(sourcePath)); }
  catch { throw new RegistryError('CORPUS_SOURCE_UNREADABLE'); }
  let thread;
  try { thread = gmailThreadSchema.parse(JSON.parse(raw.toString('utf8'))); }
  catch { throw new RegistryError('CORPUS_SOURCE_INVALID'); }
  const items = parseSourcePayload('GMAIL', JSON.parse(raw.toString('utf8')));
  const threadRef = gmailThreadRef(thread.id);
  const target = resolve(directory, 'threads', threadRef + '.json');
  let existing: Buffer | null = null;
  try { existing = await readFile(target); } catch { existing = null; }
  if (existing && sha256(existing) === sha256(raw)) return { threadRef, outcome: 'ALREADY_IMPORTED', messages: items.length };
  if (existing && !options.update) throw new RegistryError('CORPUS_THREAD_CHANGED');
  await mkdir(resolve(directory, 'threads'), { recursive: true });
  await writeFile(target, raw);
  return { threadRef, outcome: existing ? 'UPDATED' : 'IMPORTED', messages: items.length };
}

/** Writes the annotation skeleton for an imported thread -- one span per message
 * body, every expectation empty -- or, when it exists, reports which PRD §43.4
 * categories it still lacks. Editing is done in the file itself: the private
 * corpus never passes through a server. */
export async function annotateThread(repository: string, kind: CorpusKind, threadRef: string, env: NodeJS.ProcessEnv = process.env)
  : Promise<{ path: string; created: boolean; missing: string[] }> {
  if (!/^[a-z0-9][a-z0-9_.:-]{0,127}$/.test(threadRef)) throw new RegistryError('CORPUS_THREAD_REF_INVALID');
  const directory = corpusDir(repository, kind, env);
  if (kind === 'REAL' && !privatePathIgnored(repository, directory)) throw new RegistryError('CORPUS_PRIVATE_PATH_NOT_IGNORED');
  const path = resolve(directory, 'annotations', threadRef + '.json');
  let annotation: CorpusAnnotation;
  let created = false;
  try { annotation = corpusAnnotationSchema.parse(JSON.parse(await readFile(path, 'utf8'))); }
  catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') throw new RegistryError('CORPUS_ANNOTATION_INVALID');
    let raw: Buffer;
    try { raw = await readFile(resolve(directory, 'threads', threadRef + '.json')); }
    catch { throw new RegistryError('CORPUS_THREAD_MISSING'); }
    const items = parseSourcePayload('GMAIL', JSON.parse(raw.toString('utf8')));
    const thresholds = await loadThresholds(repository);
    annotation = corpusAnnotationSchema.parse({
      format: 'unai-corpus-annotation/1', threadRef, corpusKind: kind,
      source: { connector: 'gmail', threadFile: threadRef + '.json', contentHash: sha256(raw) },
      labelledSourceSpans: items.flatMap((item, index) => {
        const body = String(item.content['body'] ?? '');
        return body === '' ? [] : [{ spanRef: 'm' + (index + 1), messageExternalId: item.externalId, start: 0, end: body.length, quote: body }];
      }),
      expectedEntities: [], expectedFrameInstances: [], instanceMatchCases: [], expectedSlotsAndPropositions: [],
      expectedCommitmentsAndResolutions: { commitments: [], resolutions: [] }, expectedUnknownsAndNonMemoryItems: [],
      identityAcceptanceThresholds: { version: thresholds.version },
    });
    await mkdir(resolve(directory, 'annotations'), { recursive: true });
    await writeFile(path, JSON.stringify(annotation, null, 2) + '\n');
    created = true;
  }
  return { path, created, missing: missingCategories(annotation) };
}

/** The PRD §43.4 label categories an annotation carries no item of. */
export function missingCategories(annotation: CorpusAnnotation | null): LabelCategory[] {
  if (!annotation) return [...LABEL_CATEGORIES];
  const coverage = coverageOf([annotation]);
  return LABEL_CATEGORIES.filter(category => coverage[category] === 0);
}

/** Every thread of a corpus with the categories it still lacks; an imported
 * thread without an annotation file lacks all of them. Thread references are
 * content-free digests, and this is printed on the owner's machine only. */
export async function annotationProgress(repository: string, kind: CorpusKind, env: NodeJS.ProcessEnv = process.env)
  : Promise<Array<{ threadRef: string; annotated: boolean; labelled: boolean; missing: LabelCategory[] }>> {
  const directory = corpusDir(repository, kind, env);
  const annotated = new Map((await loadCorpus(directory, kind)).map(thread => [thread.annotation.threadRef, thread]));
  const refs = new Set([...(await listJson(resolve(directory, 'threads'))).map(name => name.slice(0, -'.json'.length)), ...annotated.keys()]);
  return [...refs].sort().map(threadRef => {
    const thread = annotated.get(threadRef);
    return { threadRef, annotated: thread !== undefined, labelled: thread?.labelled ?? false,
      missing: missingCategories(thread?.annotation ?? null) };
  });
}

/** Per category: how many items the corpus carries and how many of its threads
 * carry none. Counts only -- what the Corpus and evaluation screen shows. */
function labelCoverageOf(threads: ReadonlyArray<{ missing: readonly LabelCategory[] }>, annotations: readonly CorpusAnnotation[]) {
  const items = coverageOf(annotations);
  const threadsMissing = Object.fromEntries(LABEL_CATEGORIES.map(category =>
    [category, threads.filter(thread => thread.missing.includes(category)).length])) as Record<LabelCategory, number>;
  return { threads: threads.length, items, threadsMissing };
}

// ---------------------------------------------------------------------------
// Scoring (the `uai corpus run` command)
// ---------------------------------------------------------------------------

interface Observation { readonly gold: string; readonly predicted: string }

/** Pairwise comparison of predicted identity against labelled identity. */
function pairwise(observations: readonly Observation[]) {
  let pairsCompared = 0, predictedSamePairs = 0, goldSamePairs = 0, falseMergePairs = 0, falseSplitPairs = 0;
  for (let i = 0; i < observations.length; i++) {
    for (let j = i + 1; j < observations.length; j++) {
      const a = observations[i]!, b = observations[j]!;
      const predicted = a.predicted === b.predicted, gold = a.gold === b.gold;
      pairsCompared++;
      if (predicted) predictedSamePairs++;
      if (gold) goldSamePairs++;
      if (predicted && !gold) falseMergePairs++;
      if (gold && !predicted) falseSplitPairs++;
    }
  }
  return { pairsCompared, predictedSamePairs, goldSamePairs, falseMergePairs, falseSplitPairs };
}

const ratio = (numerator: number, denominator: number) => denominator === 0 ? 0 : Number((numerator / denominator).toFixed(6));

function ruleResult(ruleId: KeyingRule, observations: number, counts: ReturnType<typeof pairwise>, thresholds: IdentityThresholds,
  extraFailures: string[] = []): KeyingRuleResult {
  const threshold = thresholds.rules[ruleId];
  const falseMergeRate = ratio(counts.falseMergePairs, counts.predictedSamePairs);
  const falseSplitRate = ratio(counts.falseSplitPairs, counts.goldSamePairs);
  const failures = [...extraFailures];
  if (observations < threshold.minObservations) failures.push('INSUFFICIENT_OBSERVATIONS');
  if (falseMergeRate > threshold.maxFalseMergeRate) failures.push('FALSE_MERGE_RATE_EXCEEDED');
  if (falseSplitRate > threshold.maxFalseSplitRate) failures.push('FALSE_SPLIT_RATE_EXCEEDED');
  return { ruleId, ruleVersion: KEYING_RULE_VERSIONS[ruleId], observations, ...counts, falseMergeRate, falseSplitRate,
    meetsThresholds: failures.length === 0, failures: [...new Set(failures)].slice(0, 10) };
}

/** `entity.strong_alias_exact`: mentions resolved in labelled order through the
 * production decision; the candidate index is the exact (alias type, normalized
 * value) lookup `findEntityCandidates` performs. A reused entity gains no
 * aliases, exactly as `resolveEntity` records none on reuse. */
function scoreEntities(threads: readonly CorpusThread[], thresholds: IdentityThresholds): KeyingRuleResult {
  const entities: { id: string; kind: string; aliases: Set<string> }[] = [];
  const observations: Observation[] = [];
  for (const thread of threads) {
    const order = new Map(thread.annotation.labelledSourceSpans.map((span, index) => [span.spanRef, index]));
    const mentions = thread.annotation.expectedEntities
      .flatMap(entity => entity.mentions.map(mention => ({ entity, mention })))
      .sort((a, b) => (order.get(a.mention.spanRef) ?? 0) - (order.get(b.mention.spanRef) ?? 0));
    for (const { entity, mention } of mentions) {
      const keys = mention.aliases.map(alias => ({ type: alias.aliasType as EntityAliasType, key: alias.aliasType + '\u0000' + normalizeAliasValue(alias.aliasValue) }));
      const candidates = entities.filter(candidate => candidate.kind === entity.entityKind).flatMap(candidate => {
        const matched = [...new Set(keys.filter(key => candidate.aliases.has(key.key)).map(key => key.type))].sort();
        return matched.length ? [{ entityId: candidate.id, matchedAliasTypes: matched, matchedStrongly: matched.some(isStrongAliasType) }] : [];
      });
      const decision = decideEntityResolution(candidates);
      let id = decision.reuseEntityId;
      if (id === null) {
        id = 'e' + entities.length;
        entities.push({ id, kind: entity.entityKind, aliases: new Set(keys.map(key => key.key)) });
      }
      observations.push({ gold: entity.entityRef, predicted: id });
    }
  }
  return ruleResult('entity.strong_alias_exact', observations.length, pairwise(observations), thresholds);
}

/** `frame_instance.confirmed_match`: each labelled case through the production
 * matcher; reuse is only what `mayReuseInstance` permits. */
function scoreInstances(threads: readonly CorpusThread[], thresholds: IdentityThresholds): KeyingRuleResult {
  let cases = 0, predictedSamePairs = 0, goldSamePairs = 0, falseMergePairs = 0, falseSplitPairs = 0;
  for (const thread of threads) {
    for (const matchCase of thread.annotation.instanceMatchCases) {
      // Absent signals are absent, exactly as the matcher's own callers pass them.
      const signals = Object.fromEntries(Object.entries(matchCase.signals).filter(([, value]) => value !== undefined));
      const outcome = scoreInstanceMatch(signals as Parameters<typeof scoreInstanceMatch>[0]).outcome;
      const reused = mayReuseInstance(outcome, 'MATERIAL_ACCEPTED_UPDATE');
      const same = matchCase.mentionInstanceRef === matchCase.candidateInstanceRef;
      cases++;
      if (reused) predictedSamePairs++;
      if (same) goldSamePairs++;
      if (reused && !same) falseMergePairs++;
      if (same && !reused) falseSplitPairs++;
    }
  }
  return ruleResult('frame_instance.confirmed_match', cases,
    { pairsCompared: cases, predictedSamePairs, goldSamePairs, falseMergePairs, falseSplitPairs }, thresholds);
}

/** Slot and proposition identity over every labelled observation. The slot is
 * keyed by its canonical descriptor (which excludes the value), the proposition
 * by slot, registry-normalized value and polarity; the fingerprints are computed
 * as the stores compute them, and a fingerprint that disagrees with descriptor
 * identity is its own failure. */
function scoreSlotsAndPropositions(threads: readonly CorpusThread[], thresholds: IdentityThresholds,
  release: Pick<LoadedRegistryRelease, 'frames'>): [KeyingRuleResult, KeyingRuleResult] {
  const slots: Observation[] = [], propositions: Observation[] = [];
  const slotFingerprints = new Map<string, string>(), propositionFingerprints = new Map<string, string>();
  let slotFingerprintConflicts = 0, propositionFingerprintConflicts = 0, invalidValues = 0;
  for (const thread of threads) {
    for (const slot of thread.annotation.expectedSlotsAndPropositions) {
      const descriptor = slotDescriptorSchema.parse({ frameInstanceId: referenceUuid('instance:' + slot.instanceRef),
        predicateId: slot.predicateId, contextSpaceId: referenceUuid('context:' + slot.contextKind), modality: slot.modality,
        qualifiers: slot.qualifiers });
      const slotKey = canonicalJson(descriptor);
      const slotPrint = slotFingerprint(descriptor, CANONICAL_NORMALIZATION_VERSION);
      if ((slotFingerprints.get(slotPrint) ?? slotKey) !== slotKey) slotFingerprintConflicts++;
      slotFingerprints.set(slotPrint, slotKey);
      for (const proposition of slot.propositions) {
        for (const observation of proposition.observations) {
          slots.push({ gold: slot.slotRef, predicted: slotKey });
          let normalizedValue: unknown;
          try { normalizedValue = validatePredicateValue(release, slot.predicateId, observation.value); }
          catch { invalidValues++; propositions.push({ gold: proposition.propositionRef, predicted: 'invalid:' + thread.annotation.threadRef + ':' + observation.spanRef }); continue; }
          const propositionKey = canonicalJson({ slotKey, normalizedValue, polarity: proposition.polarity });
          const print = propositionFingerprint({ beliefSlotId: referenceUuid('slot:' + slotKey), normalizedValue,
            polarity: proposition.polarity }, CANONICAL_NORMALIZATION_VERSION);
          if ((propositionFingerprints.get(print) ?? propositionKey) !== propositionKey) propositionFingerprintConflicts++;
          propositionFingerprints.set(print, propositionKey);
          propositions.push({ gold: proposition.propositionRef, predicted: propositionKey });
        }
      }
    }
  }
  return [
    ruleResult('belief_slot.descriptor_identity', slots.length, pairwise(slots), thresholds,
      slotFingerprintConflicts ? ['FINGERPRINT_IDENTITY_CONFLICT'] : []),
    ruleResult('proposition.normalized_value_identity', propositions.length, pairwise(propositions), thresholds,
      [...(propositionFingerprintConflicts ? ['FINGERPRINT_IDENTITY_CONFLICT'] : []), ...(invalidValues ? ['VALUE_NOT_NORMALIZABLE'] : [])]),
  ];
}

function coverageOf(annotations: readonly CorpusAnnotation[]): Record<LabelCategory, number> {
  const sum = (pick: (annotation: CorpusAnnotation) => number) => annotations.reduce((total, annotation) => total + pick(annotation), 0);
  return {
    sourceSpans: sum(a => a.labelledSourceSpans.length),
    entities: sum(a => a.expectedEntities.length),
    frameInstances: sum(a => a.expectedFrameInstances.length),
    slots: sum(a => a.expectedSlotsAndPropositions.length),
    propositions: sum(a => a.expectedSlotsAndPropositions.reduce((total, slot) => total + slot.propositions.length, 0)),
    commitments: sum(a => a.expectedCommitmentsAndResolutions.commitments.length),
    resolutions: sum(a => a.expectedCommitmentsAndResolutions.resolutions.length),
    nonMemoryItems: sum(a => a.expectedUnknownsAndNonMemoryItems.length),
  };
}

/** Consistency of the labels with the thread and with the pinned release, and
 * the two deterministic classifiers the labels exercise. */
function pipelineChecks(threads: readonly CorpusThread[], release: Pick<LoadedRegistryRelease, 'transitions'>) {
  const check = () => ({ checked: 0, failed: 0 });
  const spanIntegrity = check(), tier0Import = check(), commitmentLanguage = check(), resolutionTransitions = check(), nonMemoryItems = check();
  for (const thread of threads) {
    const annotation = thread.annotation;
    tier0Import.checked++;
    if (thread.messages === 0) tier0Import.failed++;
    const spans = new Map(annotation.labelledSourceSpans.map(span => [span.spanRef, span]));
    for (const span of annotation.labelledSourceSpans) {
      spanIntegrity.checked++;
      const body = thread.bodies.get(span.messageExternalId);
      if (body === undefined || span.end <= span.start || body.slice(span.start, span.end) !== span.quote) spanIntegrity.failed++;
    }
    // Every reference to a span must name a labelled span.
    const referenced = [
      ...annotation.expectedEntities.flatMap(entity => entity.mentions.map(mention => mention.spanRef)),
      ...annotation.expectedFrameInstances.flatMap(instance => instance.spanRefs),
      ...annotation.instanceMatchCases.map(matchCase => matchCase.mentionSpanRef),
      ...annotation.expectedSlotsAndPropositions.flatMap(slot => slot.propositions.flatMap(p => p.observations.map(o => o.spanRef))),
      ...annotation.expectedCommitmentsAndResolutions.commitments.map(commitment => commitment.spanRef),
      ...annotation.expectedCommitmentsAndResolutions.resolutions.map(resolution => resolution.spanRef),
      ...annotation.expectedUnknownsAndNonMemoryItems.map(item => item.spanRef),
    ];
    for (const spanRef of referenced) { spanIntegrity.checked++; if (!spans.has(spanRef)) spanIntegrity.failed++; }
    for (const commitment of annotation.expectedCommitmentsAndResolutions.commitments) {
      commitmentLanguage.checked++;
      if (classifyCommitmentLanguage(spans.get(commitment.spanRef)?.quote).language !== 'COMMITMENT') commitmentLanguage.failed++;
    }
    const frameTypes = new Map(annotation.expectedFrameInstances.map(instance => [instance.instanceRef, instance.frameType]));
    for (const resolution of annotation.expectedCommitmentsAndResolutions.resolutions) {
      resolutionTransitions.checked++;
      try {
        validateTransition({ transitionContracts: release.transitions as never, transitionContractId: resolution.transitionContractId,
          linkKind: resolution.linkKind, sourceFrameTypeId: frameTypes.get(resolution.instanceRef) ?? 'unknown.frame',
          targetFrameTypeId: resolution.targetFrameType, outcomeCode: resolution.outcomeCode as never });
      } catch { resolutionTransitions.failed++; }
    }
    // A span labelled non-memory must not also be labelled as a canonical claim,
    // and consideration language must not read as a commitment.
    const observed = new Set(annotation.expectedSlotsAndPropositions.flatMap(slot => slot.propositions.flatMap(p => p.observations.map(o => o.spanRef))));
    for (const item of annotation.expectedUnknownsAndNonMemoryItems) {
      nonMemoryItems.checked++;
      if (observed.has(item.spanRef)) nonMemoryItems.failed++;
      else if (item.kind === 'CONSIDERATION_ONLY' && classifyCommitmentLanguage(spans.get(item.spanRef)?.quote).language === 'COMMITMENT') nonMemoryItems.failed++;
    }
  }
  return { spanIntegrity, tier0Import, commitmentLanguage, resolutionTransitions, nonMemoryItems };
}

export function scoreCorpus(input: {
  kind: CorpusKind; threads: readonly CorpusThread[]; thresholds: IdentityThresholds;
  release: Pick<LoadedRegistryRelease, 'version' | 'frames' | 'transitions'>; now?: Date;
}): CorpusResults {
  const threads = input.threads.filter(thread => thread.labelled);
  const failures: string[] = [];
  const stale = threads.filter(thread => thread.annotation.identityAcceptanceThresholds.version !== input.thresholds.version);
  if (stale.length) failures.push('ANNOTATION_THRESHOLDS_STALE');
  const rules = [scoreEntities(threads, input.thresholds), scoreInstances(threads, input.thresholds),
    ...scoreSlotsAndPropositions(threads, input.thresholds, input.release)];
  if (rules.some(rule => !rule.meetsThresholds)) failures.push('KEYING_RULE_THRESHOLD_FAILED');
  const checks = pipelineChecks(threads, input.release);
  for (const [name, value] of Object.entries(checks)) {
    if (value.failed > 0) failures.push(name.replace(/[A-Z]/g, letter => '_' + letter).toUpperCase() + '_FAILED');
  }
  const coverage = coverageOf(threads.map(thread => thread.annotation));
  if (Object.values(coverage).some(value => value === 0)) failures.push('CORPUS_CATEGORY_MISSING');
  if (input.kind === 'REAL' && threads.length < input.thresholds.minimumRealThreads) failures.push('REAL_THREADS_INSUFFICIENT');
  return corpusResultsSchema.parse({
    format: 'unai-corpus-results/1', corpusKind: input.kind, threadCount: threads.length,
    annotationDigest: sha256(threads.map(thread => thread.annotationDigest).sort().join('\n')),
    thresholdsVersion: input.thresholds.version, registryRelease: input.release.version,
    scoredAt: (input.now ?? new Date()).toISOString(),
    rules, coverage, pipelineChecks: checks,
    result: failures.length ? 'FAIL' : 'PASS', failures,
  });
}

// ---------------------------------------------------------------------------
// Verification and status (the `uai corpus verify` and `status` commands)
// ---------------------------------------------------------------------------

/** PRD §42 invariant 40 and §46 exit: no production keying rule is approved on
 * synthetic data alone. Refuses unless the recorded real-corpus results cover
 * every production rule at its current version, over at least the minimum
 * number of real threads, under the current thresholds, and pass. */
export async function verifyRealCorpusResults(repository: string): Promise<{ result: 'PASS' | 'FAIL'; failures: string[]; results: CorpusResults | null }> {
  const thresholds = await loadThresholds(repository);
  let raw: string;
  try { raw = await readFile(resolve(repository, REAL_RESULTS_FILE), 'utf8'); }
  catch { return { result: 'FAIL', failures: ['REAL_RESULTS_MISSING'], results: null }; }
  const parsed = corpusResultsSchema.safeParse((() => { try { return JSON.parse(raw); } catch { return null; } })());
  if (!parsed.success) return { result: 'FAIL', failures: ['REAL_RESULTS_INVALID'], results: null };
  const results = parsed.data;
  const failures: string[] = [];
  if (results.corpusKind !== 'REAL') failures.push('REAL_RESULTS_NOT_REAL');
  if (results.threadCount < thresholds.minimumRealThreads) failures.push('REAL_THREADS_INSUFFICIENT');
  if (results.thresholdsVersion !== thresholds.version) failures.push('REAL_RESULTS_THRESHOLDS_STALE');
  for (const rule of PRODUCTION_KEYING_RULES) {
    const recorded = results.rules.find(entry => entry.ruleId === rule);
    if (!recorded || recorded.observations === 0) failures.push('KEYING_RULE_NOT_EVALUATED');
    else if (recorded.ruleVersion !== KEYING_RULE_VERSIONS[rule]) failures.push('KEYING_RULE_VERSION_STALE');
    else if (!recorded.meetsThresholds) failures.push('KEYING_RULE_THRESHOLD_FAILED');
  }
  if (Object.values(results.coverage).some(value => value === 0)) failures.push('CORPUS_CATEGORY_MISSING');
  if (results.result !== 'PASS') failures.push('REAL_RESULTS_FAILED');
  return { result: failures.length ? 'FAIL' : 'PASS', failures: [...new Set(failures)], results };
}

async function exists(path: string) { try { await stat(path); return true; } catch { return false; } }

/** What the Corpus and evaluation screen displays. */
export async function corpusStatus(repository: string, release: Pick<LoadedRegistryRelease, 'version' | 'frames' | 'transitions'>,
  env: NodeJS.ProcessEnv = process.env, now = new Date()): Promise<CorpusStatus> {
  const directory = privateCorpusDir(repository, env);
  const inside = insideRepository(repository, directory);
  const thresholds = await loadThresholds(repository);
  const hooksPath = git(repository, ['config', '--get', 'core.hooksPath']).stdout.trim();
  const hookFile = await exists(resolve(repository, PRECOMMIT_HOOK));
  const tracked = inside ? git(repository, ['ls-files', '--', relative(resolve(repository), directory).replaceAll('\\', '/')]).stdout
    .split('\n').filter(Boolean).length : 0;
  const realThreads = await loadCorpus(directory, 'REAL');
  const syntheticThreads = await loadCorpus(corpusDir(repository, 'SYNTHETIC'), 'SYNTHETIC');
  const verification = await verifyRealCorpusResults(repository);
  const labelCoverage = {
    real: labelCoverageOf(await annotationProgress(repository, 'REAL', env), realThreads.map(thread => thread.annotation)),
    synthetic: labelCoverageOf(await annotationProgress(repository, 'SYNTHETIC', env), syntheticThreads.map(thread => thread.annotation)),
  };
  return corpusStatusSchema.parse({
    format: 'unai-corpus-status/1', checkedAt: now.toISOString(),
    privatePath: { location: inside ? 'REPOSITORY_LOCAL' : 'EXTERNAL', gitignored: privatePathIgnored(repository, directory),
      precommitBlockInstalled: hookFile && hooksPath === '.githooks', trackedFiles: tracked },
    realThreads: { imported: (await listJson(resolve(directory, 'threads'))).length, annotated: realThreads.filter(thread => thread.labelled).length },
    syntheticThreads: { annotated: syntheticThreads.filter(thread => thread.labelled).length },
    labelCoverage,
    thresholds,
    synthetic: scoreCorpus({ kind: 'SYNTHETIC', threads: syntheticThreads, thresholds, release, now }),
    real: verification.results,
    verification: { result: verification.result, failures: verification.failures },
  });
}

// ---------------------------------------------------------------------------
// Corpus as a shadow sample
// ---------------------------------------------------------------------------

/** The labelled threads as a shadow evaluation sample: labelled instances with
 * their role fillers, one claim per labelled observation, and the labelled
 * resolutions. A corpus sample touches no production table. */
export function corpusShadowSample(threads: readonly CorpusThread[], kind: CorpusKind): ShadowSample {
  const labelled = threads.filter(thread => thread.labelled);
  // An instance discussed in two threads is one instance: refs are corpus-wide.
  const instances = [...new Map(labelled.flatMap(thread => thread.annotation.expectedFrameInstances.map(instance => [instance.instanceRef, {
    ref: instance.instanceRef, frameType: instance.frameType,
    roles: instance.roles.map(role => ({ roleId: role.roleId, entityRef: role.entityRef })),
  }] as const))).values()];
  const claims = labelled.flatMap(thread => thread.annotation.expectedSlotsAndPropositions.flatMap(slot =>
    slot.propositions.flatMap(proposition => proposition.observations.map(observation => {
      const ref = thread.annotation.threadRef + ':' + proposition.propositionRef + ':' + observation.spanRef;
      return { ref, matchKey: ref, instanceRef: slot.instanceRef, predicateId: slot.predicateId, contextKind: slot.contextKind,
        modality: slot.modality, qualifiers: slot.qualifiers, value: observation.value, polarity: proposition.polarity,
        recordedStatus: null, sourceAuthoritative: false };
    }))));
  const resolutions = labelled.flatMap(thread => thread.annotation.expectedCommitmentsAndResolutions.resolutions.map(resolution => ({
    ref: thread.annotation.threadRef + ':' + resolution.resolutionRef, instanceRef: resolution.instanceRef,
    transitionContractId: resolution.transitionContractId, linkKind: resolution.linkKind,
    outcomeCode: resolution.outcomeCode, targetFrameType: resolution.targetFrameType,
  })));
  return { kind: 'CORPUS', corpus: kind, limit: Math.max(1, claims.length), instances, resolutions,
    baseline: { claims, cost: null }, candidate: { claims, cost: null } };
}
