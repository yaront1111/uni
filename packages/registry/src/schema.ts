import { z } from 'zod';

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

export type PredicateContract = z.infer<typeof predicateSchema>;
export type FrameContract = z.infer<typeof frameSchema>;
export type TransitionContract = z.infer<typeof transitionSchema>;
export type RegistryManifest = z.infer<typeof manifestSchema>;

const keys = (schema: { shape: Record<string, unknown> }, omit: string[] = []) => Object.keys(schema.shape).filter(key => !omit.includes(key));
export const FRAME_CONTRACT_FIELDS: readonly string[] = Object.freeze(keys(frameSchema, ['kind']));
export const PREDICATE_CONTRACT_FIELDS: readonly string[] = Object.freeze(keys(predicateSchema));
export const TRANSITION_CONTRACT_FIELDS: readonly string[] = Object.freeze(keys(transitionSchema, ['kind']));
