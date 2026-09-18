import { z } from 'zod';

/** Canonical identity vocabularies and record shapes (PRD §11, §12.5, §13, §15).
 *
 * Schemas only, as every file in this package: nothing here reads a database,
 * computes a fingerprint or decides a match. The closed enums are the contract
 * the identity migration's CHECK constraints and the `@unai/memory` services both
 * hold to, so a value the database refuses cannot be constructed here either.
 */

const registryId = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
const confidence = z.number().min(0).max(1);

export const entityKindSchema = z.enum(['PERSON','ORGANIZATION','PROJECT','ACCOUNT','DOCUMENT','PLACE','TRANSACTION','DECISION','EVENT','TOPIC']);
export const entityLifecycleSchema = z.enum(['ACTIVE','MERGED','SPLIT','RETIRED']);
/** Alias strength decides what an alias match is worth, never who the entity is.
 * A mailbox, handle or connector identifier identifies one account; a name is a
 * candidate hint that two different people can share. */
export const entityAliasTypeSchema = z.enum(['DISPLAY_NAME','GIVEN_NAME','FULL_NAME','NICKNAME','EMAIL','HANDLE','PHONE','EXTERNAL_ID']);
export const entityLineageKindSchema = z.enum(['MERGED_INTO','SPLIT_INTO','ALIAS_OF','RETIRED_PARENT']);

/** PRD §13.4 outcomes, with NEW_ENTITY standing where NEW_INSTANCE stands for a
 * frame instance. Only CONFIRMED_MATCH may reuse an identity automatically; the
 * two middle outcomes are the under-merge default and keep the rows separate. */
export const entityMatchOutcomeSchema = z.enum(['CONFIRMED_MATCH','PROBABLE_MATCH','POSSIBLE_MATCH','CONFIRMED_DISTINCT','NEW_ENTITY']);

export const modalitySchema = z.enum(['ACTUAL','SCHEDULED','INTENDED','COMMITTED','EXPECTED','PREDICTED','RECOMMENDED','CONDITIONAL']);
export const polaritySchema = z.enum(['POSITIVE','NEGATIVE']);
export const claimOriginSchema = z.enum(['USER_STATEMENT','USER_CONFIRMATION','USER_CORRECTION','EXTERNAL_PERSON_ASSERTION',
  'STRUCTURED_CONNECTOR_OBSERVATION','DOCUMENT_ASSERTION','MODEL_EXTRACTION','MODEL_INFERENCE','MODEL_RECOMMENDATION',
  'MODEL_PREDICTION','TOOL_EXECUTION_RECEIPT']);
export const claimLifecycleSchema = z.enum(['CANDIDATE','AWAITING_INSTANCE_RESOLUTION','PROVISIONAL','ACCEPTED','CONTESTED','REJECTED','SUPERSEDED','SUPPRESSED']);

/** PRD §12.5 precision ladder. There is no value between DAY and EXACT_INSTANT,
 * so a resolver that cannot justify an instant has to say DAY, MONTH or
 * APPROXIMATE instead of inventing one. */
export const temporalPrecisionSchema = z.enum(['EXACT_INSTANT','DAY','MONTH','APPROXIMATE','OPEN_INTERVAL']);

/** What a resolved time phrase actually said. Every field of PRD §12.5 is
 * required except locale, which is optional only because a timezone is the
 * stronger of the two and is always recorded. */
export const temporalInterpretationSchema = z.strictObject({
  originalText: z.string().trim().min(1).max(512),
  normalizedTime: z.strictObject({ start: z.iso.datetime({ offset: true }), end: z.iso.datetime({ offset: true }).nullable() }),
  timeZone: z.string().min(1).max(64),
  locale: z.string().min(2).max(35).optional(),
  precision: temporalPrecisionSchema,
  resolverVersion: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/),
  confidence,
});
export type TemporalInterpretation = z.infer<typeof temporalInterpretationSchema>;

/** The slot descriptor of PRD §11.8 -- and nothing more. The candidate value is
 * absent by construction: it belongs to a proposition inside the slot. */
export const slotDescriptorSchema = z.strictObject({
  frameInstanceId: z.uuid(),
  predicateId: registryId,
  contextSpaceId: z.uuid(),
  modality: modalitySchema,
  qualifiers: z.record(z.string().min(1).max(64), z.union([z.string().max(512), z.number(), z.boolean()])),
});
export type SlotDescriptor = z.infer<typeof slotDescriptorSchema>;

export const propositionDescriptorSchema = z.strictObject({
  beliefSlotId: z.uuid(),
  normalizedValue: z.unknown(),
  polarity: polaritySchema,
});

/** PRD §13.5/§13.6 lookup outcomes. A lookup answers with candidates; only an
 * unambiguous semantic comparison answers with an identity. */
export const slotLookupOutcomeSchema = z.enum(['MATCH_EXISTING_SLOT','POSSIBLE_SLOT_MATCH','CREATE_NEW_SLOT','BLOCK_CANONICALIZATION']);
export const propositionLookupOutcomeSchema = z.enum(['MATCH_EXISTING_PROPOSITION','POSSIBLE_PROPOSITION_MATCH','CREATE_NEW_PROPOSITION']);

/** A stored claim as the Memory inspector's advanced panel reads it: four named
 * confidences that are never collapsed into one number (PRD §15.3). */
export const storedClaimSchema = z.strictObject({
  claimId: z.uuid(),
  sourceAnchorId: z.uuid(),
  extractionRunId: z.uuid().nullable(),
  assertedByEntityId: z.uuid().nullable(),
  propositionId: z.uuid().nullable(),
  candidateFrameTypeId: registryId.nullable(),
  claimOrigin: claimOriginSchema,
  lifecycle: claimLifecycleSchema,
  validFrom: z.iso.datetime().nullable(),
  validTo: z.iso.datetime().nullable(),
  recordedAt: z.iso.datetime(),
  extractionConfidence: confidence.nullable(),
  entityResolutionConfidence: confidence.nullable(),
  temporalResolutionConfidence: confidence.nullable(),
  instanceResolutionConfidence: confidence.nullable(),
  temporalInterpretation: temporalInterpretationSchema.nullable(),
  metadata: z.record(z.string(), z.unknown()),
});
export type StoredClaim = z.infer<typeof storedClaimSchema>;
