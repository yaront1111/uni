import { z } from 'zod';
import { assessmentStatusSchema } from './governance.js';
import { claimOriginSchema } from './memory.js';
import { outcomeCodeSchema } from './outcomes.js';
import { pendingAssertionSchema, projectionNameSchema } from './projections.js';
import { contextWatermarksSchema } from './context.js';
import { memoryLabelSchema } from './labels.js';

/** The Today briefing and the Why? / Sources panel (PRD §7.1, §24.5, §26; design
 * GET /v1/today, screens "Today briefing" and "Why? / Sources panel"; entities
 * `briefing_editions` and `briefing_items`).
 *
 * Schemas only. `@unai/context` builds the briefing from a Context Broker packet
 * and reads the panel; this file only says what they look like.
 */

const reasonCode = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);
const version = z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/);
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** An IANA zone name as `Intl` accepts it ("Asia/Jerusalem", "America/New_York",
 * "UTC"). Whether the zone exists is checked where it is used. */
export const timeZoneSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_+/-]{0,63}$/);

/** GET /v1/today's query: the owner's timezone and, optionally, the owner-local
 * date the caller believes it is. Neither is taken from the server's clock zone. */
export const todayRequestSchema = z.strictObject({
  timeZone: timeZoneSchema.optional(),
  date: localDate.optional(),
});
export type TodayRequest = z.infer<typeof todayRequestSchema>;

export const briefingDomainSchema = z.enum(['WORK', 'PERSONAL', 'FINANCE']);
export type BriefingDomain = z.infer<typeof briefingDomainSchema>;
export const briefingPrioritySchema = z.enum(['HIGH', 'NORMAL', 'LOW']);
export type BriefingPriority = z.infer<typeof briefingPrioritySchema>;
/** PENDING is the state of the owner's own statement that no frame holds yet. */
export const briefingOutcomeStateSchema = z.enum(['UNRESOLVED', 'PARTIALLY_RESOLVED', 'RESOLVED', 'CONTESTED', 'PENDING']);
export const briefingItemKindSchema = z.enum(['COMMITMENT', 'OBLIGATION', 'SCHEDULED_EVENT', 'OWNER_ASSERTION']);
export type BriefingItemKind = z.infer<typeof briefingItemKindSchema>;

const unit = z.number().min(0).max(1);
/** The seven things an item is ranked by (design `briefing_items.rank_components`).
 * None of them is a recording time: Today is never ordered newest-first
 * (CRT-UX-02-A). */
export const rankComponentsSchema = z.strictObject({
  consequence: unit, urgency: unit, goalRelevance: unit, confidence: unit, effort: unit, reversibility: unit,
  attentionBudget: unit,
});
export type RankComponents = z.infer<typeof rankComponentsSchema>;

/** What a Why? / Sources action opens: a belief, the owner's own assertion, or
 * the resolution assertion that settled an outcome. */
export const whyObjectTypeSchema = z.enum(['propositions', 'owner_overlay_deltas', 'resolution_assertions']);
export type WhyObjectType = z.infer<typeof whyObjectTypeSchema>;
export const whyRefSchema = z.strictObject({ objectType: whyObjectTypeSchema, objectId: z.uuid() });
export type WhyRef = z.infer<typeof whyRefSchema>;

export const briefingItemSchema = z.strictObject({
  briefingItemId: z.uuid(),
  itemObjectType: z.enum(['frame_instance', 'owner_overlay_delta']),
  itemObjectId: z.uuid(),
  kind: briefingItemKindSchema,
  domainSection: briefingDomainSchema,
  /** The statement, worded by its label: a scheduled event is never described as
   * having happened (CRT-UX-01-B). */
  headline: z.string().min(1).max(1000),
  whySurfaced: z.string().min(1).max(1000),
  certaintyLabel: memoryLabelSchema,
  outcomeState: briefingOutcomeStateSchema,
  targetTime: z.iso.datetime().nullable(),
  /** The target time in the owner's timezone, as it is shown. */
  targetLocal: z.string().max(64).nullable(),
  /** The planned time passed and no accepted resolution says what happened. */
  pastTarget: z.boolean(),
  decisionAffectingConflict: z.boolean(),
  priority: briefingPrioritySchema,
  rankScore: unit,
  rankComponents: rankComponentsSchema,
  /** 1-based among the items shown; null for an item that was not shown. */
  rankPosition: z.number().int().min(1).nullable(),
  /** What the Why? / Sources action opens, primary first. */
  sourceRefs: z.array(whyRefSchema).max(16),
  evidenceIds: z.array(z.uuid()).max(64),
});
export type BriefingItem = z.infer<typeof briefingItemSchema>;

/** A recommendation is stored with RECOMMENDED semantics and never as the owner's
 * intent or an executed fact (design "Uai recommends" block). */
export const briefingRecommendationSchema = z.strictObject({
  label: z.literal('RECOMMENDED'),
  text: z.string().min(1).max(500),
  basedOnItemId: z.uuid(),
  risk: z.enum(['LOW', 'MEDIUM', 'HIGH']),
});
export type BriefingRecommendation = z.infer<typeof briefingRecommendationSchema>;

/** A high-risk recommendation that was not made, and why: its supporting memory
 * is provisional, contested or from an incomplete projection. */
export const withheldRecommendationSchema = z.strictObject({
  basedOnItemId: z.uuid(),
  risk: z.literal('HIGH'),
  reason: z.enum(['SUPPORT_PROVISIONAL', 'SUPPORT_CONTESTED', 'PROJECTION_INCOMPLETE']),
});
export type WithheldRecommendation = z.infer<typeof withheldRecommendationSchema>;

/** An unchanged low-priority item that was shown on an earlier date and is not
 * repeated today (CRT-UX-01-B). */
export const suppressedRepeatSchema = z.strictObject({
  briefingItemId: z.uuid(),
  itemObjectType: z.enum(['frame_instance', 'owner_overlay_delta']),
  itemObjectId: z.uuid(),
  headline: z.string().min(1).max(1000),
  lastShownOn: localDate,
});

/** The context the edition was built from, derived from the persisted packet
 * (design "persisted context packet manifest"). */
export const briefingPacketManifestSchema = z.strictObject({
  contextPacketId: z.uuid(),
  packetHash: z.string().regex(/^[a-f0-9]{64}$/),
  beliefIds: z.array(z.uuid()).max(2000),
  claimIds: z.array(z.uuid()).max(5000),
  evidenceIds: z.array(z.uuid()).max(2000),
  overlayDeltaIds: z.array(z.uuid()).max(1000),
  resolutionAssertionIds: z.array(z.uuid()).max(500),
  frameInstanceIds: z.array(z.uuid()).max(500),
  projectionVersions: z.record(z.string().min(1).max(64), z.uuid().nullable()),
  watermarks: contextWatermarksSchema,
});
export type BriefingPacketManifest = z.infer<typeof briefingPacketManifestSchema>;

export const briefingProjectionCompletenessSchema = z.strictObject({
  projectionName: projectionNameSchema,
  isComplete: z.boolean(),
  pendingAssertions: z.array(pendingAssertionSchema).max(200),
});

export const todayBriefingSchema = z.strictObject({
  briefingEditionId: z.uuid(),
  ownerLocalDate: localDate,
  timeZone: timeZoneSchema,
  utcOffset: z.string().regex(/^[+-]\d{2}:\d{2}$/),
  generatedAt: z.iso.datetime(),
  /** Nothing current or imminent is material today. */
  isEmpty: z.boolean(),
  /** Ranked by their best item; each holds only a small set of items. */
  sections: z.array(z.strictObject({
    domain: briefingDomainSchema,
    items: z.array(briefingItemSchema).min(1).max(3),
  })).max(3),
  recommendations: z.array(briefingRecommendationSchema).max(3),
  withheldRecommendations: z.array(withheldRecommendationSchema).max(20),
  suppressedRepeats: z.array(suppressedRepeatSchema).max(100),
  /** Material items beyond today's attention budget, left for their own views. */
  deferredByAttentionBudget: z.number().int().min(0),
  projectionCompleteness: z.array(briefingProjectionCompletenessSchema).max(16),
  memoryIncomplete: z.boolean().optional(),
  packetManifest: briefingPacketManifestSchema,
  rankingVersion: version,
});
export type TodayBriefing = z.infer<typeof todayBriefingSchema>;

// ---------------------------------------------------------------------------
// The Why? / Sources panel (CRT-UX-11-A)
// ---------------------------------------------------------------------------

const confidences = z.strictObject({
  extraction: unit.nullable(),
  entityResolution: unit.nullable(),
  temporalResolution: unit.nullable(),
  instanceResolution: unit.nullable(),
});

/** Who claimed it. An entity the owner's memory names carries its label; a claim
 * with no asserting entity is described by its origin, never left blank. */
export const claimingActorSchema = z.strictObject({
  kind: z.enum(['OWNER', 'PERSON', 'ORGANIZATION', 'CONNECTED_SOURCE', 'DOCUMENT', 'MODEL', 'TOOL', 'UNKNOWN']),
  label: z.string().min(1).max(200),
  entityId: z.uuid().nullable(),
});

export const sourceExcerptSchema = z.strictObject({
  evidenceId: z.uuid(),
  sourceType: z.string().max(64),
  occurredAt: z.iso.datetime().nullable(),
  anchorKind: z.string().max(64),
  /** The anchored words, bounded. Null when the anchor records a position but no
   * text. */
  excerpt: z.string().max(600).nullable(),
});

export const whyClaimSchema = z.strictObject({
  claimId: z.uuid(),
  claimOrigin: claimOriginSchema,
  claimingActor: claimingActorSchema,
  recordedAt: z.iso.datetime(),
  validFrom: z.iso.datetime().nullable(),
  validTo: z.iso.datetime().nullable(),
  confidence: confidences,
  /** Null when this request may not read the source: see `redactions`. */
  source: sourceExcerptSchema.nullable(),
});

export const whySourcesSchema = z.strictObject({
  subject: whyRefSchema,
  subjectKind: z.enum(['BELIEF', 'OWNER_ASSERTION', 'RESOLUTION']),
  label: memoryLabelSchema,
  /** What is stated, in words. */
  statement: z.string().min(1).max(1000),
  modality: z.string().max(32).nullable(),
  assessmentStatus: assessmentStatusSchema.nullable(),
  /** When the statement holds (a belief's valid period, a resolution's effective
   * instant, an owner assertion's time) and when it was recorded. */
  effectiveTime: z.strictObject({
    from: z.iso.datetime().nullable(),
    to: z.iso.datetime().nullable(),
    recordedAt: z.iso.datetime().nullable(),
  }),
  /** The weakest recorded confidence of each kind across the claims, and the
   * assessment behind them. */
  confidence: confidences.extend({ assessmentStatus: assessmentStatusSchema.nullable() }),
  claims: z.array(whyClaimSchema).max(100),
  claimingActors: z.array(claimingActorSchema).max(50),
  sources: z.array(sourceExcerptSchema).max(100),
  /** A source the claim rests on that this request may not read. Listed, never
   * silently dropped. */
  redactions: z.array(z.strictObject({ claimId: z.uuid().nullable(), reason: reasonCode })).max(100),
  conflict: z.strictObject({
    status: z.enum(['NO_CONFLICT', 'CONTESTED', 'CORRECTED_OR_SUPERSEDED']),
    competing: z.array(z.strictObject({
      propositionId: z.uuid(),
      statement: z.string().max(1000),
      assessmentStatus: assessmentStatusSchema.nullable(),
    })).max(32),
    relations: z.array(z.strictObject({ kind: z.string().max(64), relation: z.string().max(64) })).max(64),
  }),
  /** How an inferred statement was reached: the recorded derivation steps and the
   * model claims behind it. Empty for a statement nobody inferred. */
  derivation: z.strictObject({
    isInferred: z.boolean(),
    steps: z.array(z.strictObject({
      evaluatorId: z.string().max(128),
      version: z.string().max(64),
      inputs: z.array(z.strictObject({
        objectType: z.enum(['claims', 'propositions']),
        objectId: z.uuid(),
        statement: z.string().max(1000),
      })).max(64),
    })).max(32),
    modelClaims: z.array(z.strictObject({
      claimId: z.uuid(),
      claimOrigin: claimOriginSchema,
      modelId: z.string().max(128).nullable(),
      promptVersion: z.string().max(128).nullable(),
    })).max(64),
  }),
  resolutions: z.array(z.strictObject({
    resolutionAssertionId: z.uuid(),
    outcomeCode: outcomeCodeSchema,
    effectiveAt: z.iso.datetime(),
    lifecycle: z.string().max(32),
  })).max(50),
  /** The full Memory inspector read, for a belief. */
  explainPath: z.string().regex(/^\/v1\/memory\/propositions\/[0-9a-f-]{36}\/explain$/).nullable(),
  panelVersion: version,
  readAt: z.iso.datetime(),
});
export type WhySources = z.infer<typeof whySourcesSchema>;
