import { z } from 'zod';
import { projectionRebuildReceiptSchema } from './projections.js';

/** Governed merge and split: request, result and review shapes (PRD §14, §35.11,
 * §44.13, §44.14; design routes POST /v1/memory/frame-instances/merge,
 * /frame-instances/{id}/split, /entities/merge, /entities/{id}/split, and the
 * Merge and split review screen).
 *
 * Schemas only, as every file in this package. The lineage vocabularies mirror
 * the CHECK lists of migrations 0010 and 0018, so a kind the database refuses
 * cannot be constructed here either.
 */

const registryId = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
const reasonCode = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);

export const frameInstanceLineageKindSchema = z.enum(['MERGED_INTO', 'SPLIT_INTO', 'RETIRED_PARENT']);
export const propositionLineageKindSchema = z.enum(['EQUIVALENT_TO', 'CANONICAL_ALIAS_OF', 'MERGED_INTO', 'SPLIT_INTO']);
export const lineageObjectTypeSchema = z.enum(['frame_instance', 'entity', 'proposition']);
export type LineageObjectType = z.infer<typeof lineageObjectTypeSchema>;

/** A partition of a split, named by the caller. Only a key: the kernel mints the
 * identity of whatever the partition becomes. */
export const partitionKeySchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
/** The owner's own words for why, stored on the lineage row. */
const reasonText = z.string().trim().min(1).max(2048);

const roleFill = z.strictObject({
  roleId: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  entityId: z.uuid().optional(),
  typedValue: z.unknown().optional(),
});

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/** Merging names every instance; the survivor is one of them, or a new canonical
 * instance (PRD §14.1 item 1). Without a hint the oldest instance survives. */
export const frameInstanceMergeRequestSchema = z.strictObject({
  instanceIds: z.array(z.uuid()).min(2).max(16),
  survivorHint: z.union([z.uuid(), z.literal('NEW_INSTANCE')]).optional(),
  reason: reasonText.optional(),
});
export type FrameInstanceMergeRequest = z.infer<typeof frameInstanceMergeRequestSchema>;

/** A split names the partitions and assigns only the claims the owner can place.
 * Every claim of the parent that is not assigned is, by definition, not safely
 * assignable (PRD §14.2 items 2-3). */
export const frameInstanceSplitRequestSchema = z.strictObject({
  targetPartitions: z.array(z.strictObject({
    partitionKey: partitionKeySchema,
    roles: z.array(roleFill).max(32).optional(),
  })).min(2).max(16),
  claimAssignments: z.array(z.strictObject({ claimId: z.uuid(), partitionKey: partitionKeySchema })).max(256),
  reason: reasonText.optional(),
});
export type FrameInstanceSplitRequest = z.infer<typeof frameInstanceSplitRequestSchema>;

export const entityMergeRequestSchema = z.strictObject({
  entityIds: z.array(z.uuid()).min(2).max(16),
  survivorHint: z.uuid().optional(),
  evidenceRef: z.uuid().optional(),
  reason: reasonText.optional(),
});
export type EntityMergeRequest = z.infer<typeof entityMergeRequestSchema>;

export const entitySplitRequestSchema = z.strictObject({
  partitions: z.array(z.strictObject({
    partitionKey: partitionKeySchema,
    canonicalLabel: z.string().trim().min(1).max(512).optional(),
  })).min(2).max(16),
  aliasAssignments: z.array(z.strictObject({ aliasId: z.uuid(), partitionKey: partitionKeySchema })).max(256),
  reason: reasonText.optional(),
});
export type EntitySplitRequest = z.infer<typeof entitySplitRequestSchema>;

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export const lineageRecordSchema = z.strictObject({
  lineageId: z.uuid(),
  objectType: lineageObjectTypeSchema,
  fromId: z.uuid(),
  toId: z.uuid(),
  lineageKind: z.enum(['MERGED_INTO', 'SPLIT_INTO', 'ALIAS_OF', 'RETIRED_PARENT', 'EQUIVALENT_TO', 'CANONICAL_ALIAS_OF']),
  transactionId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
});
export type LineageRecord = z.infer<typeof lineageRecordSchema>;

/** What an identifier names today. A retired id is still found -- same row, same
 * id -- and says where its meaning went; it is never reused for anything else. */
export const resolvedIdentitySchema = z.strictObject({
  objectType: lineageObjectTypeSchema,
  id: z.uuid(),
  lifecycle: z.string().regex(/^[A-Z_]{1,32}$/),
  /** The live objects this id resolves to: itself while active, the survivor
   * after a merge, every new object after a split. */
  resolvesTo: z.array(z.uuid()).max(64),
  lineage: z.array(lineageRecordSchema).max(256),
});
export type ResolvedIdentity = z.infer<typeof resolvedIdentitySchema>;

const assessmentChange = z.strictObject({
  propositionId: z.uuid(),
  assessmentId: z.uuid(),
  assessmentStatus: z.enum(['CANDIDATE','PROVISIONAL','ACCEPTED','CONTESTED','REJECTED','SUPERSEDED','UNSUPPORTED','SUPPRESSED']),
  reason: reasonCode,
});

export const frameMergeDetailSchema = z.strictObject({
  survivorFrameInstanceId: z.uuid(),
  mergedFrameInstanceId: z.uuid(),
  frameTypeId: registryId,
  /** PRD §14.1 items 3-4: the slot keeps its id; its index moves to the survivor. */
  rehomedSlots: z.array(z.strictObject({
    beliefSlotId: z.uuid(), predicateId: registryId, normalizationVersion: z.string(),
    previousFingerprint: z.string().regex(/^[a-f0-9]{64}$/).nullable(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })),
  /** Item 5: a rehomed slot whose descriptor now equals one already on the survivor. */
  collidingSlots: z.array(z.strictObject({
    beliefSlotId: z.uuid(), survivorBeliefSlotId: z.uuid(), predicateId: registryId,
  })),
  /** Item 6: every proposition of a colliding slot, merged into the survivor
   * slot's proposition with the same value, or into a new one there. */
  mergedPropositions: z.array(z.strictObject({
    fromPropositionId: z.uuid(), toPropositionId: z.uuid(), createdTarget: z.boolean(),
  })),
  /** Item 7: competing values now sharing one slot. Both stay (PRD §44.11). */
  conflicts: z.array(z.strictObject({ beliefSlotId: z.uuid(), propositionIds: z.array(z.uuid()).min(2) })),
  assessments: z.array(assessmentChange),
});
export type FrameMergeDetail = z.infer<typeof frameMergeDetailSchema>;

export const frameSplitDetailSchema = z.strictObject({
  parentFrameInstanceId: z.uuid(),
  frameTypeId: registryId,
  newFrameInstances: z.array(z.strictObject({ partitionKey: partitionKeySchema, frameInstanceId: z.uuid() })),
  reassignedClaims: z.array(z.strictObject({
    claimId: z.uuid(), partitionKey: partitionKeySchema, frameInstanceId: z.uuid(),
    fromPropositionId: z.uuid(), toPropositionId: z.uuid(), beliefSupportId: z.uuid(),
  })),
  /** Claims that could not be safely assigned, moved to CONTESTED and still
   * attached to the retired parent. */
  contestedClaims: z.array(z.strictObject({ claimId: z.uuid(), propositionId: z.uuid(), previousLifecycle: z.string() })),
  /** Claims left attached to the retired parent without a lifecycle change,
   * because theirs was already settled (rejected, suppressed, superseded or
   * contested) or because they name the parent only through a role. */
  retainedOnParentClaims: z.array(z.strictObject({ claimId: z.uuid(), lifecycle: z.string(), reason: reasonCode })),
  /** Item 4: one slot per partition that received a claim of a parent slot;
   * `mixedSituations` marks a parent slot whose claims went to more than one. */
  newSlots: z.array(z.strictObject({
    beliefSlotId: z.uuid(), fromBeliefSlotId: z.uuid(), frameInstanceId: z.uuid(), partitionKey: partitionKeySchema,
    predicateId: registryId, mixedSituations: z.boolean(),
  })),
  newPropositions: z.array(z.strictObject({ propositionId: z.uuid(), fromPropositionId: z.uuid(), partitionKey: partitionKeySchema })),
  assessments: z.array(assessmentChange),
});
export type FrameSplitDetail = z.infer<typeof frameSplitDetailSchema>;

export const entityMergeDetailSchema = z.strictObject({
  survivorEntityId: z.uuid(),
  mergedEntityId: z.uuid(),
  /** The merged entity's aliases, recorded again against the survivor so a
   * lookup by any of them finds the survivor. The originals stay where they were. */
  aliases: z.array(z.strictObject({
    aliasId: z.uuid(), copiedFromAliasId: z.uuid(), aliasType: z.string(), aliasValue: z.string(),
  })),
  /** Frames whose roles name the merged entity: their projection rows now read
   * the survivor (the recalculated beliefs of the design). */
  affectedFrameInstanceIds: z.array(z.uuid()),
});
export type EntityMergeDetail = z.infer<typeof entityMergeDetailSchema>;

export const entitySplitDetailSchema = z.strictObject({
  parentEntityId: z.uuid(),
  newEntities: z.array(z.strictObject({ partitionKey: partitionKeySchema, entityId: z.uuid() })),
  assignedAliases: z.array(z.strictObject({
    aliasId: z.uuid(), copiedFromAliasId: z.uuid(), entityId: z.uuid(), partitionKey: partitionKeySchema,
  })),
  /** Aliases nobody assigned: they stay on the retired parent and resolve to no
   * new entity, which is the ambiguous-alias handling of the design. */
  ambiguousAliases: z.array(z.strictObject({
    aliasId: z.uuid(), aliasType: z.string(), aliasValue: z.string(), handling: z.literal('RETAINED_ON_RETIRED_PARENT'),
  })),
  /** Roles filled by the parent are left pointing at it: which new entity a role
   * meant is exactly what the split cannot know. */
  rolesOnRetiredParent: z.array(z.strictObject({ frameInstanceRoleId: z.uuid(), frameInstanceId: z.uuid(), roleId: z.string() })),
});
export type EntitySplitDetail = z.infer<typeof entitySplitDetailSchema>;

const outcome = {
  transactionId: z.uuid(),
  committedAt: z.iso.datetime(),
  lineage: z.array(lineageRecordSchema),
  projectionRebuildReceipts: z.array(projectionRebuildReceiptSchema).min(1),
  resolution: z.array(resolvedIdentitySchema),
};

export const frameInstanceMergeResultSchema = z.strictObject({
  ...outcome,
  survivorFrameInstanceId: z.uuid(),
  survivorCreated: z.boolean(),
  mergedFrameInstanceIds: z.array(z.uuid()).min(1),
  propositionLineage: z.array(lineageRecordSchema),
  merges: z.array(frameMergeDetailSchema).min(1),
});
export type FrameInstanceMergeResult = z.infer<typeof frameInstanceMergeResultSchema>;

export const frameInstanceSplitResultSchema = z.strictObject({
  ...outcome,
  propositionLineage: z.array(lineageRecordSchema),
  split: frameSplitDetailSchema,
});
export type FrameInstanceSplitResult = z.infer<typeof frameInstanceSplitResultSchema>;

export const entityMergeResultSchema = z.strictObject({
  ...outcome,
  survivorEntityId: z.uuid(),
  mergedEntityIds: z.array(z.uuid()).min(1),
  merges: z.array(entityMergeDetailSchema).min(1),
});
export type EntityMergeResult = z.infer<typeof entityMergeResultSchema>;

export const entitySplitResultSchema = z.strictObject({
  ...outcome,
  split: entitySplitDetailSchema,
});
export type EntitySplitResult = z.infer<typeof entitySplitResultSchema>;

// ---------------------------------------------------------------------------
// The Merge and split review screen
// ---------------------------------------------------------------------------

/** One instance-match decision the matcher recorded. Anything but a
 * CONFIRMED_MATCH was kept separate and never reused for a material accepted
 * update (PRD §13.4, CRT-MEM-11-C); the review shows why. */
export const frameMergeCandidateSchema = z.strictObject({
  candidateId: z.uuid(),
  frameTypeId: registryId,
  candidateFrameInstanceId: z.uuid().nullable(),
  resolvedFrameInstanceId: z.uuid().nullable(),
  matchOutcome: z.enum(['CONFIRMED_MATCH','PROBABLE_MATCH','POSSIBLE_MATCH','CONFIRMED_DISTINCT','NEW_INSTANCE']),
  score: z.number().min(0).max(1).nullable(),
  scoreComponents: z.record(z.string(), z.unknown()),
  keptSeparate: z.boolean(),
  reusedExistingInstance: z.boolean(),
  createdAt: z.iso.datetime(),
});

/** Active entities of one kind that share a name and no strong identifier: the
 * under-merge default at work (PRD §44.12, CRT-MEM-11-B). */
export const entityMergeCandidateSchema = z.strictObject({
  entityKind: z.string(),
  sharedAlias: z.string(),
  entityIds: z.array(z.uuid()).min(2),
  keptSeparate: z.literal(true),
});

export const mergeSplitReviewSchema = z.strictObject({
  frameCandidates: z.array(frameMergeCandidateSchema).max(200),
  entityCandidates: z.array(entityMergeCandidateSchema).max(200),
  recentLineage: z.array(lineageRecordSchema).max(200),
  readAt: z.iso.datetime(),
});
export type MergeSplitReview = z.infer<typeof mergeSplitReviewSchema>;
