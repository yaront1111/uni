import { z } from 'zod';

/** Evaluation shapes: the gold corpus, the shadow evaluation run and the
 * economic and quality metrics (PRD §20.6, §22.2, §22.4, §43.4, §43.5, §45;
 * design entities `corpus_annotations`, `shadow_evaluation_runs`,
 * `economic_and_quality_metrics`).
 *
 * Schemas only. Every report here is a statement of counts, rates, stable codes
 * and object identifiers: the private corpus never leaves its gitignored path,
 * so nothing that crosses into a committed file, a database row or a screen may
 * carry a quote, an address or a value from it.
 */

const registryId = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
const localId = z.string().regex(/^[a-z][a-z0-9_]*$/);
const ref = z.string().regex(/^[a-z0-9][a-z0-9_.:-]{0,127}$/);
const code = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);
const versionLabel = z.string().regex(/^[a-z0-9][a-z0-9_.:@/-]{0,127}$/);
const rate = z.number().min(0).max(1);
const count = z.int().min(0);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

// ---------------------------------------------------------------------------
// Production canonical keying rules (PRD §13, §42 invariant 40)
// ---------------------------------------------------------------------------

/** Every rule that decides a canonical identity in production. A rule is listed
 * here, scored by `uai corpus run` and required by `uai corpus verify` on the
 * real corpus; adding a keying rule without adding it here is what the
 * `CRT-QA-03-A` test refuses. */
export const PRODUCTION_KEYING_RULES = Object.freeze([
  /** `resolveEntity`: only one exact strong-alias match reuses an entity. */
  'entity.strong_alias_exact',
  /** `scoreInstanceMatch` + `mayReuseInstance`: only CONFIRMED_MATCH reuses an instance. */
  'frame_instance.confirmed_match',
  /** `slotFingerprint` + descriptor equality: the slot excludes the value. */
  'belief_slot.descriptor_identity',
  /** `propositionFingerprint` + registry value normalization: identity includes the value. */
  'proposition.normalized_value_identity',
] as const);
export const keyingRuleSchema = z.enum(PRODUCTION_KEYING_RULES);
export type KeyingRule = z.infer<typeof keyingRuleSchema>;

export const corpusKindSchema = z.enum(['REAL', 'SYNTHETIC']);
export type CorpusKind = z.infer<typeof corpusKindSchema>;

// ---------------------------------------------------------------------------
// corpus_annotations (PRD §43.4)
// ---------------------------------------------------------------------------

const aliasSchema = z.strictObject({
  aliasType: z.enum(['DISPLAY_NAME', 'GIVEN_NAME', 'FULL_NAME', 'NICKNAME', 'EMAIL', 'HANDLE', 'PHONE', 'EXTERNAL_ID']),
  aliasValue: z.string().trim().min(1).max(512),
});

/** The evidence a frame-instance matcher may use, mirroring `InstanceMatchSignals`
 * in `@unai/memory` field for field. An annotator records what the discourse
 * shows; the production matcher decides. */
export const instanceMatchSignalsSchema = z.strictObject({
  externalIdentifierMatch: z.boolean().optional(),
  sharedResolvedEntityRoles: z.array(localId).max(20).optional(),
  conflictingEntityRoles: z.array(localId).max(20).optional(),
  threadContinuity: z.boolean().optional(),
  explicitReference: z.enum(['SAME', 'THAT_ONE', 'ANOTHER', 'DIFFERENT']).nullable().optional(),
  temporalCompatibility: z.enum(['COMPATIBLE', 'INCOMPATIBLE', 'UNKNOWN']).optional(),
  sharedOriginEvent: z.boolean().optional(),
  sharedDocumentAnchor: z.boolean().optional(),
  amountCompatibility: z.enum(['EQUAL', 'DIFFERENT', 'UNKNOWN']).optional(),
  semanticSimilarity: z.number().min(0).max(1).optional(),
  capabilityRule: z.enum(['CONFIRMED_MATCH', 'CONFIRMED_DISTINCT']).nullable().optional(),
});

export const corpusAnnotationSchema = z.strictObject({
  format: z.literal('unai-corpus-annotation/1'),
  /** Stable, content-free thread reference. Real threads use a digest of the
   * Gmail thread id, never the subject or a participant. */
  threadRef: ref,
  corpusKind: corpusKindSchema,
  source: z.strictObject({
    connector: z.literal('gmail'),
    /** File name of the raw thread next to the annotation, under `threads/`. */
    threadFile: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,127}\.json$/),
    /** SHA-256 of the raw thread bytes the spans were labelled against. */
    contentHash: sha256,
  }),
  labelledSourceSpans: z.array(z.strictObject({
    spanRef: ref,
    messageExternalId: z.string().min(1).max(512),
    start: count,
    end: count,
    /** The exact characters `[start,end)` of the message body. Checked against
     * the raw thread by `uai corpus run`; never copied into a report. */
    quote: z.string().min(1).max(4000),
  })).min(1).max(500),
  expectedEntities: z.array(z.strictObject({
    entityRef: ref,
    entityKind: z.enum(['PERSON', 'ORGANIZATION', 'PROJECT', 'ACCOUNT', 'DOCUMENT', 'PLACE', 'TRANSACTION', 'DECISION', 'EVENT', 'TOPIC']),
    mentions: z.array(z.strictObject({ spanRef: ref, aliases: z.array(aliasSchema).min(1).max(8) })).min(1).max(200),
  })).max(200),
  expectedFrameInstances: z.array(z.strictObject({
    instanceRef: ref,
    frameType: registryId,
    roles: z.array(z.strictObject({ roleId: localId, entityRef: ref.nullable() })).max(20),
    spanRefs: z.array(ref).min(1).max(50),
  })).max(200),
  /** Pairs the frame-instance matcher is asked about: a mention against an
   * earlier candidate, with the signals the discourse carries. Gold identity is
   * whether the two instance refs are the same. */
  instanceMatchCases: z.array(z.strictObject({
    caseRef: ref,
    mentionSpanRef: ref,
    mentionInstanceRef: ref,
    candidateInstanceRef: ref,
    signals: instanceMatchSignalsSchema,
  })).max(200),
  expectedSlotsAndPropositions: z.array(z.strictObject({
    slotRef: ref,
    instanceRef: ref,
    predicateId: registryId,
    contextKind: z.enum(['BASE', 'QUOTED', 'TEST']),
    modality: z.enum(['ACTUAL', 'SCHEDULED', 'INTENDED', 'COMMITTED', 'EXPECTED', 'PREDICTED', 'RECOMMENDED', 'CONDITIONAL']),
    qualifiers: z.record(z.string().min(1).max(64), z.union([z.string().max(512), z.number(), z.boolean()])),
    /** Each span of a proposition is one observation (one claim) of it. */
    propositions: z.array(z.strictObject({
      propositionRef: ref,
      polarity: z.enum(['POSITIVE', 'NEGATIVE']),
      observations: z.array(z.strictObject({ spanRef: ref, value: z.json() })).min(1).max(50),
    })).min(1).max(50),
  })).max(300),
  expectedCommitmentsAndResolutions: z.strictObject({
    commitments: z.array(z.strictObject({ instanceRef: ref, spanRef: ref })).max(100),
    resolutions: z.array(z.strictObject({
      resolutionRef: ref,
      instanceRef: ref,
      spanRef: ref,
      transitionContractId: registryId,
      linkKind: z.enum(['RESOLVES', 'REALIZES']),
      outcomeCode: code.nullable(),
      targetFrameType: registryId.nullable(),
    })).max(100),
  }),
  expectedUnknownsAndNonMemoryItems: z.array(z.strictObject({
    spanRef: ref,
    kind: z.enum(['UNKNOWN_PREDICATE', 'NON_MEMORY', 'CONSIDERATION_ONLY', 'AMBIGUOUS']),
  })).max(200),
  /** The thresholds version the thread was labelled against (the recorded file
   * in `corpus/expected/`); a thread annotated under older thresholds is
   * re-reviewed before it can count toward a newer version. */
  identityAcceptanceThresholds: z.strictObject({ version: versionLabel }),
});
export type CorpusAnnotation = z.infer<typeof corpusAnnotationSchema>;

export const ruleThresholdSchema = z.strictObject({
  /** False merges are the dangerous error: one person's debt on another. */
  maxFalseMergeRate: rate,
  /** Splits are the under-merge default and are tolerated up to this rate. */
  maxFalseSplitRate: rate,
  /** A rule scored on fewer observations than this has not been evaluated. */
  minObservations: count,
});
export const identityThresholdsSchema = z.strictObject({
  format: z.literal('unai-identity-thresholds/1'),
  version: versionLabel,
  minimumRealThreads: z.int().min(1),
  rules: z.strictObject(Object.fromEntries(PRODUCTION_KEYING_RULES.map(rule => [rule, ruleThresholdSchema])) as
    Record<KeyingRule, typeof ruleThresholdSchema>),
});
export type IdentityThresholds = z.infer<typeof identityThresholdsSchema>;

export const keyingRuleResultSchema = z.strictObject({
  ruleId: keyingRuleSchema,
  /** The production version of the rule that was scored. `uai corpus verify`
   * refuses results recorded against any other version. */
  ruleVersion: versionLabel,
  observations: count,
  pairsCompared: count,
  predictedSamePairs: count,
  goldSamePairs: count,
  falseMergePairs: count,
  falseSplitPairs: count,
  falseMergeRate: rate,
  falseSplitRate: rate,
  meetsThresholds: z.boolean(),
  failures: z.array(code).max(10),
});
export type KeyingRuleResult = z.infer<typeof keyingRuleResultSchema>;

const checkSchema = z.strictObject({ checked: count, failed: count });

/** The PRD §43.4 label categories a corpus must cover. */
export const LABEL_CATEGORIES = Object.freeze(['sourceSpans', 'entities', 'frameInstances', 'slots', 'propositions',
  'commitments', 'resolutions', 'nonMemoryItems'] as const);
export type LabelCategory = typeof LABEL_CATEGORIES[number];
const categoryCountsSchema = z.strictObject(Object.fromEntries(LABEL_CATEGORIES.map(category => [category, count])) as
  Record<LabelCategory, typeof count>);
/** Per category, the items a corpus carries and how many of its threads carry
 * none (an imported thread without annotation carries none of any). */
const labelCoverageSchema = z.strictObject({ threads: count, items: categoryCountsSchema, threadsMissing: categoryCountsSchema });

/** Written by `uai corpus run --report`, and for the real corpus recorded at
 * `corpus/expected/real-corpus-results.json` by `--record`. Counts and rates
 * only: no thread reference, span, alias or value. */
export const corpusResultsSchema = z.strictObject({
  format: z.literal('unai-corpus-results/1'),
  corpusKind: corpusKindSchema,
  threadCount: count,
  /** SHA-256 over the sorted annotation digests: which labelled set was scored,
   * without saying what is in it. */
  annotationDigest: sha256,
  thresholdsVersion: versionLabel,
  registryRelease: z.string().regex(/^\d+\.\d+\.\d+$/),
  scoredAt: z.iso.datetime(),
  rules: z.array(keyingRuleResultSchema).length(PRODUCTION_KEYING_RULES.length),
  /** How many of each PRD §43.4 label category the scored threads carry. */
  coverage: categoryCountsSchema,
  pipelineChecks: z.strictObject({
    spanIntegrity: checkSchema,
    tier0Import: checkSchema,
    commitmentLanguage: checkSchema,
    resolutionTransitions: checkSchema,
    nonMemoryItems: checkSchema,
  }),
  result: z.enum(['PASS', 'FAIL']),
  failures: z.array(code).max(50),
});
export type CorpusResults = z.infer<typeof corpusResultsSchema>;

/** What the Corpus and evaluation screen shows about the corpus store itself. */
export const corpusStatusSchema = z.strictObject({
  format: z.literal('unai-corpus-status/1'),
  checkedAt: z.iso.datetime(),
  privatePath: z.strictObject({
    location: z.enum(['REPOSITORY_LOCAL', 'EXTERNAL']),
    gitignored: z.boolean(),
    precommitBlockInstalled: z.boolean(),
    trackedFiles: count,
  }),
  realThreads: z.strictObject({ imported: count, annotated: count }),
  syntheticThreads: z.strictObject({ annotated: count }),
  /** Label coverage of each corpus as it stands, recorded results or not. */
  labelCoverage: z.strictObject({ real: labelCoverageSchema, synthetic: labelCoverageSchema }),
  thresholds: identityThresholdsSchema,
  synthetic: corpusResultsSchema.nullable(),
  real: corpusResultsSchema.nullable(),
  verification: z.strictObject({ result: z.enum(['PASS', 'FAIL']), failures: z.array(code).max(50) }),
});
export type CorpusStatus = z.infer<typeof corpusStatusSchema>;

// ---------------------------------------------------------------------------
// shadow_evaluation_runs (PRD §22.2 Shadow, §22.4, §43.5)
// ---------------------------------------------------------------------------

export const shadowRunKindSchema = z.enum(['REGISTRY', 'EXTRACTOR']);
export const SHADOW_DIFF_NAMES = Object.freeze(['instanceMatch', 'slotCollision', 'proposition', 'beliefStatus',
  'resolution', 'projection'] as const);

/** One changed object: its identifier or corpus reference and a stable code on
 * each side. Codes are outcomes and short group digests, never values. */
export const shadowDiffEntrySchema = z.strictObject({
  ref: z.string().min(1).max(200),
  code: code,
  baseline: z.string().max(80).nullable(),
  candidate: z.string().max(80).nullable(),
});
export const shadowDiffSchema = z.strictObject({
  compared: count,
  changed: count,
  entries: z.array(shadowDiffEntrySchema).max(500),
  /** Set when more entries changed than the report lists. */
  truncated: z.boolean(),
  notes: z.record(z.string().regex(/^[a-z][a-zA-Z0-9]{0,63}$/), z.union([count, z.boolean(), z.string().max(80)])),
});
export type ShadowDiff = z.infer<typeof shadowDiffSchema>;

const costSide = z.strictObject({ items: count, costMicrounits: count, latencyMs: z.number().min(0) });
export const costAndLatencyDiffSchema = z.strictObject({
  baseline: costSide,
  candidate: costSide,
  deltaCostMicrounits: z.int(),
  deltaLatencyMs: z.number(),
});

export const shadowSampleRefSchema = z.strictObject({
  kind: z.enum(['CORPUS', 'OWNER_SAMPLE']),
  corpus: corpusKindSchema.nullable(),
  frameInstances: count,
  claims: count,
  resolutions: count,
  limit: z.int().min(1).max(100000),
});

/** PRD §22.4: every evaluation run pins what it compared. */
export const evaluationVersionsSchema = z.strictObject({
  extractor: z.strictObject({ baseline: versionLabel, candidate: versionLabel }),
  registryRelease: z.strictObject({ baseline: z.string().max(20), candidate: z.string().max(20) }),
  beliefEngine: versionLabel,
  projectionReducer: versionLabel,
  normalization: versionLabel,
  instanceMatcher: versionLabel,
});

export const shadowReportSchema = z.strictObject({
  format: z.literal('unai-shadow-diff/1'),
  runId: z.uuid(),
  runKind: shadowRunKindSchema,
  sampleRef: shadowSampleRefSchema,
  baselineVersion: versionLabel,
  candidateVersion: versionLabel,
  evaluationVersions: evaluationVersionsSchema,
  diffs: z.strictObject({
    instanceMatch: shadowDiffSchema,
    slotCollision: shadowDiffSchema,
    proposition: shadowDiffSchema,
    beliefStatus: shadowDiffSchema,
    resolution: shadowDiffSchema,
    projection: shadowDiffSchema,
    costAndLatency: costAndLatencyDiffSchema,
  }),
  /** Null for a corpus sample, which touches no production table at all. For an
   * owner sample it is the computed comparison of the production digest taken
   * before the run with the one taken after it, never an assertion. */
  productionUnchanged: z.boolean().nullable(),
  createdAt: z.iso.datetime(),
});
export type ShadowReport = z.infer<typeof shadowReportSchema>;

/** A recorded run as the operations console lists it. */
export const publicShadowRunSchema = z.strictObject({
  shadowRunId: z.uuid(),
  runKind: shadowRunKindSchema,
  baselineVersion: versionLabel,
  candidateVersion: versionLabel,
  sampleRef: shadowSampleRefSchema,
  changed: z.strictObject({
    instanceMatch: count, slotCollision: count, proposition: count, beliefStatus: count, resolution: count, projection: count,
  }),
  costAndLatency: costAndLatencyDiffSchema,
  productionUnchanged: z.boolean().nullable(),
  createdAt: z.iso.datetime(),
});
export type PublicShadowRun = z.infer<typeof publicShadowRunSchema>;
export const shadowRunsViewSchema = z.strictObject({ runs: z.array(publicShadowRunSchema).max(50) });
export type ShadowRunsView = z.infer<typeof shadowRunsViewSchema>;

// ---------------------------------------------------------------------------
// economic_and_quality_metrics (PRD §20.6, §45)
// ---------------------------------------------------------------------------

/** The closed metric vocabulary of the design entity, matching the SQL CHECK in
 * migration 0025. */
export const METRIC_KEYS = Object.freeze([
  'cost_per_source_item', 'cost_per_canonical_claim', 'cost_per_accepted_belief', 'cost_per_belief_later_retrieved',
  'extracted_claims_never_used', 'tier_routing_distribution', 'user_confirmation_rate', 'user_correction_rate',
  'false_instance_merge_rate', 'entity_false_merge_rate', 'entity_false_split_rate', 'overlay_visibility_success',
  'projection_rebuild_equivalence', 'false_certainty_incidents', 'unsupported_personal_claim_rate',
  'clarification_prompts_per_active_day', 'repeated_question_violation_rate',
] as const);
export const metricKeySchema = z.enum(METRIC_KEYS);
export type MetricKey = z.infer<typeof metricKeySchema>;
export const metricUnitSchema = z.enum(['MICROUNITS_PER_ITEM', 'RATIO', 'COUNT', 'PER_DAY']);

export const metricValueSchema = z.strictObject({
  metricKey: metricKeySchema,
  unit: metricUnitSchema,
  /** Null when the denominator is zero: an undefined rate is reported as such,
   * never as zero. Decimal string so a cost never passes through a float. */
  value: z.string().regex(/^-?\d{1,18}(\.\d{1,6})?$/).nullable(),
  numerator: count.nullable(),
  denominator: count.nullable(),
  /** Tier routing is a distribution, not a scalar. */
  distribution: z.record(code, count).nullable(),
});
export type MetricValue = z.infer<typeof metricValueSchema>;

export const metricsViewSchema = z.strictObject({
  windowStart: z.iso.datetime(),
  windowEnd: z.iso.datetime(),
  metricsVersion: versionLabel,
  metrics: z.array(metricValueSchema).max(METRIC_KEYS.length),
  /** Metrics the backend cannot compute yet because the rows they are derived
   * from are not recorded by any delivered component. Listed, never faked. */
  notMeasured: z.array(z.strictObject({ metricKey: metricKeySchema, reason: code })).max(METRIC_KEYS.length),
  recordedAt: z.iso.datetime(),
});
export type MetricsView = z.infer<typeof metricsViewSchema>;
