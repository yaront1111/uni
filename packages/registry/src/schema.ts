import { z } from 'zod';
import { agingPolicySchema } from '@unai/domain';

export const CARDINALITIES = ['FUNCTIONAL', 'SET', 'EVENT'] as const;
export const CONTEXT_KINDS = ['BASE', 'QUOTED', 'TEST'] as const;
export const MODALITIES = ['ACTUAL', 'SCHEDULED', 'INTENDED', 'COMMITTED', 'EXPECTED', 'PREDICTED', 'RECOMMENDED', 'CONDITIONAL'] as const;
export const OUTCOME_CODES = ['FULFILLED', 'PARTIALLY_FULFILLED', 'WAIVED', 'CANCELLED', 'WITHDRAWN', 'FAILED', 'MISSED',
  'OCCURRED', 'OCCURRED_MODIFIED', 'CONFIRMED', 'REFUTED', 'PARTIALLY_CONFIRMED'] as const;
export const LINK_KINDS = ['RESOLVES', 'REALIZES'] as const;
export const VALUE_TYPES = ['MONEY', 'TEXT', 'TIMESTAMP', 'TIME_OR_INTERVAL', 'ENTITY', 'FRAME_REFERENCE', 'EXTERNAL_REFERENCE', 'ACTION'] as const;
export const RELEASE_VERSION = /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/;

const id = z.string().regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/);
const localId = z.string().regex(/^[a-z][a-z0-9_]*$/);
const version = z.string().regex(RELEASE_VERSION);
const text = z.string().trim().min(1).max(4000);
const texts = z.array(text).max(100);
const rules = texts.min(1);
const modalities = z.array(z.enum(MODALITIES)).min(1).max(MODALITIES.length);

/** §17.4: every predicate field is an explicit key; empty lists are explicit values. */
export const predicateSchema = z.strictObject({
  id, frameType: id, description: text, valueType: z.enum(VALUE_TYPES), cardinality: z.enum(CARDINALITIES),
  required: z.boolean(), normalization: text, allowedModalities: modalities, slotQualifiers: z.array(localId).max(20),
  temporalBehavior: text, conflictBehavior: text, supersessionBehavior: text, sourceAuthorityPolicy: text,
  projectionContracts: texts,
  agingPolicy: agingPolicySchema.optional(),
});

/** §17.3: every frame field is an explicit key. */
export const frameSchema = z.strictObject({
  kind: z.literal('FRAME'), id, version, description: text,
  contextPolicy: z.strictObject({
    allowedKinds: z.array(z.enum(CONTEXT_KINDS)).min(1).max(CONTEXT_KINDS.length),
    defaultKind: z.literal('BASE'),
    quotedRule: text,
  }),
  identityStrategy: z.strictObject({
    kind: z.literal('SURROGATE'), matching: text, descriptivePredicates: z.array(id).max(100), newInstanceSignals: texts,
  }),
  identityAnchors: z.array(localId).min(1).max(20),
  roles: z.array(z.strictObject({ id: localId, valueType: z.enum(VALUE_TYPES), required: z.boolean(), description: text })).min(1).max(50),
  predicates: z.array(predicateSchema).min(1).max(100),
  allowedModalities: modalities, slotQualifiers: z.array(localId).max(20), authorityRules: rules,
  mergePolicy: text, splitPolicy: text, transitionContracts: z.array(id).max(50), projectionConsumers: texts,
  invariants: rules, acceptanceTests: rules,
});

export const transitionSchema = z.strictObject({
  kind: z.literal('TRANSITION'), id, version, description: text, linkKind: z.enum(LINK_KINDS),
  sourceFrameTypes: z.array(id).min(1).max(20), targetFrameTypes: z.array(id).max(20), targetRequired: z.boolean(),
  allowedOutcomes: z.array(z.enum(OUTCOME_CODES)).max(OUTCOME_CODES.length),
  authorityRules: rules, invariants: rules, acceptanceTests: rules,
});

export const manifestSchema = z.strictObject({
  version,
  contracts: z.array(z.strictObject({
    id, kind: z.enum(['FRAME', 'TRANSITION']), file: z.string().regex(/^[a-z][a-z0-9_.-]*\.yaml$/),
  })).min(1).max(200),
});

export const releaseIndexSchema = z.strictObject({
  releases: z.array(z.strictObject({
    version, tag: z.string().regex(/^registry-v\d+\.\d+\.\d+$/), contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  })).max(1000),
});

/** PRD §17.7 change classes, in increasing order of what they can disturb. */
export const CHANGE_CLASSES = ['ADDITIVE', 'COMPATIBLE_BEHAVIORAL', 'IDENTITY_AFFECTING', 'TRANSITION_AFFECTING', 'BREAKING'] as const;
export type ChangeClass = typeof CHANGE_CLASSES[number];
/** The classes that require shadow evaluation, a migration manifest, a slot and
 * proposition diff, a projection replay and a rollback plan (PRD §17.7). */
export const GOVERNED_CHANGE_CLASSES: readonly ChangeClass[] = Object.freeze(['IDENTITY_AFFECTING', 'TRANSITION_AFFECTING', 'BREAKING']);

const evidencePath = z.string().regex(/^registry\/evidence\/(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\/[a-z0-9][a-z0-9_.-]{0,63}\.json$/);

/** `migration.yaml` inside a release directory: part of the immutable release,
 * covered by its content hash and materialized by publish into
 * `registry_migration_manifests`. The evidence it names lives outside the
 * release under `registry/evidence/<version>/`, because it is regenerable output
 * rather than contract. */
export const migrationManifestSchema = z.strictObject({
  kind: z.literal('MIGRATION'),
  from: version,
  to: version,
  changeClass: z.enum(CHANGE_CLASSES),
  description: text,
  /** The shadow report of `uai registry shadow-diff --baseline <from> --candidate <to>`;
   * its slot-collision and proposition diffs are the slot and proposition diff.
   * Optional in the schema so the CI gate can name exactly which evidence a
   * governed change is missing, rather than one parse failure for all of them. */
  shadowDiff: evidencePath.optional(),
  /** The report of `uai registry projection-replay --registry-version <to>`. */
  projectionReplay: evidencePath.optional(),
  rollbackPlan: text.optional(),
  /** Test suites pinned to this release, so a later release cannot silently
   * change what they assert (PRD §17.7 "registry version pinning in tests"). */
  pinnedTests: texts.min(1),
});
export type MigrationManifest = z.infer<typeof migrationManifestSchema>;

/** What `uai registry projection-replay --report` writes. A governed migration
 * names one of these, run with `--registry-version <to>`. */
export const projectionReplayReportSchema = z.strictObject({
  event: z.literal('registry.projection-replay'),
  result: z.enum(['PASS', 'FAIL']),
  registryVersion: version.nullable(),
  ownerScopeId: z.uuid(),
  asOf: z.iso.datetime(),
  reducerVersion: z.string().min(1).max(64),
  equalsIncremental: z.boolean().nullable(),
  receipts: z.array(z.strictObject({
    projectionName: z.string().min(1).max(64), rowsRebuilt: z.int().min(0), equalsIncremental: z.boolean().nullable(),
    projectionVersion: z.string().min(1).max(64), receiptId: z.uuid(),
  })).max(16),
  correlationId: z.uuid(),
});
export type ProjectionReplayReport = z.infer<typeof projectionReplayReportSchema>;

export type PredicateContract = z.infer<typeof predicateSchema>;
export type FrameContract = z.infer<typeof frameSchema>;
export type TransitionContract = z.infer<typeof transitionSchema>;
export type RegistryManifest = z.infer<typeof manifestSchema>;

const keys = (schema: { shape: Record<string, unknown> }, omit: string[] = []) => Object.keys(schema.shape).filter(key => !omit.includes(key));
export const FRAME_CONTRACT_FIELDS: readonly string[] = Object.freeze(keys(frameSchema, ['kind']));
export const PREDICATE_CONTRACT_FIELDS: readonly string[] = Object.freeze(keys(predicateSchema, ['agingPolicy']));
export const TRANSITION_CONTRACT_FIELDS: readonly string[] = Object.freeze(keys(transitionSchema, ['kind']));
