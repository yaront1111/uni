import { z } from 'zod';

/** The typed projections and their reads (PRD §25.3, §25.4, §33.12, §35.9;
 * design entities `open_commitments_projection`, `obligations_projection`,
 * `schedule_projection`, `projection_rebuild_receipts`).
 *
 * Schemas only, as every file in this package. Two things are worth stating
 * because they shape every schema below:
 *
 *  - **Money is a decimal string, never a number.** `1099.99` as an IEEE double
 *    is not `1099.99`, and an obligation is exactly the place where that
 *    matters. The amount crosses this boundary as the digits the capability
 *    computed, and the database column is `numeric`.
 *  - **Completeness travels with the answer.** Every projection read carries
 *    `isComplete`, the owner overlay watermark and the canonical transaction
 *    watermark, so a caller never has to ask a second question to find out
 *    whether what it just read was the whole story (CRT-PRJ-04-A, FR-082).
 */

const registryId = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
const version = z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/);

/** An exact decimal amount. No exponent, no thousands separator, no currency
 * symbol: the digits and at most one point. */
export const moneyAmountSchema = z.string().regex(/^-?\d{1,18}(\.\d{1,6})?$/);
export const currencyCodeSchema = z.string().regex(/^[A-Z]{3}$/);
export const moneySchema = z.strictObject({ amount: moneyAmountSchema, currency: currencyCodeSchema });
export type Money = z.infer<typeof moneySchema>;

export const PROJECTION_NAMES = Object.freeze(['open_commitments_projection', 'obligations_projection', 'schedule_projection'] as const);
export const projectionNameSchema = z.enum(PROJECTION_NAMES);
export type ProjectionName = z.infer<typeof projectionNameSchema>;
/** Every projection a rebuild receipt may name: the three V0 projections and the
 * decision projection of registry release 0.2.0 (ADR 0029 §4), which is reduced
 * by its own reducer and is therefore not in `PROJECTION_NAMES`. */
export const recordedProjectionNameSchema = z.enum([...PROJECTION_NAMES, 'decision_projection']);

export const rebuildTriggerSchema = z.enum(['MERGE', 'SPLIT', 'MIGRATION', 'MANUAL_REPLAY', 'DROP_AND_REBUILD', 'INCREMENTAL_APPLY']);
export type RebuildTrigger = z.infer<typeof rebuildTriggerSchema>;

/** How well supported the projected reading is. `PENDING_OWNER_ASSERTION` says
 * the owner's own unreduced write is what moved the row, which a surface must be
 * able to word differently from an independently corroborated fact
 * (CRT-RYW-02-A). */
export const sourceStrengthSchema = z.enum(['NONE', 'MODEL_ONLY', 'OWNER_STATEMENT', 'PENDING_OWNER_ASSERTION', 'INDEPENDENTLY_CORROBORATED']);
export type SourceStrength = z.infer<typeof sourceStrengthSchema>;

export const outcomeStateSchema = z.enum(['UNRESOLVED', 'PARTIALLY_RESOLVED', 'RESOLVED', 'CONTESTED']);

/** Why an owner delta could not be folded into the row.
 *
 * Each value is a refusal the reducer is *right* to make, not a defect: an
 * unattached delta names no situation, a contested one is under dispute, an
 * unparseable one states no value, and converting between currencies is
 * arithmetic nobody authorized. The delta stays visible either way
 * (CRT-RYW-04-A). */
export const pendingAssertionReasonSchema = z.enum([
  'DELTA_NOT_ATTACHED', 'DELTA_CONTESTED', 'DELTA_VALUE_UNPARSEABLE', 'DELTA_CURRENCY_CONVERSION_REFUSED',
  'DELTA_KIND_NOT_REDUCIBLE',
]);
export type PendingAssertionReason = z.infer<typeof pendingAssertionReasonSchema>;

/** One owner write the projection could not reduce, returned beside the row it
 * belongs to so an incomplete read still says what it is missing. */
export const pendingAssertionSchema = z.strictObject({
  overlayDeltaId: z.uuid(),
  ownerSequence: z.number().int().nonnegative(),
  deltaKind: z.string().regex(/^[A-Z][A-Z_]{0,63}$/),
  lifecycle: z.string().regex(/^[A-Z][A-Z_]{0,63}$/),
  rawText: z.string().max(8192),
  reason: pendingAssertionReasonSchema,
  targetFrameInstanceId: z.uuid().nullable(),
});
export type PendingAssertion = z.infer<typeof pendingAssertionSchema>;

/** The nine fields PRD §33.12 requires on every projection row. Every read below
 * extends this, so a projection that forgot one would not type-check. */
export const projectionRowMetadataSchema = z.strictObject({
  ownerScopeId: z.uuid(),
  projectionVersion: z.uuid(),
  canonicalTransactionWatermark: z.iso.datetime(),
  ownerOverlayWatermark: z.number().int().nonnegative(),
  reducerVersion: version,
  isComplete: z.boolean(),
  sourceManifest: z.record(z.string(), z.unknown()),
  updatedAt: z.iso.datetime(),
});

export const commitmentProjectionRowSchema = projectionRowMetadataSchema.extend({
  commitmentFrameInstanceId: z.uuid(),
  promisorEntityId: z.uuid().nullable(),
  promiseeEntityId: z.uuid().nullable(),
  actionDescription: z.string().max(4096).nullable(),
  dueTime: z.iso.datetime().nullable(),
  outcomeState: outcomeStateSchema,
  overdue: z.boolean(),
  dueSoon: z.boolean(),
  sourceStrength: sourceStrengthSchema,
  conflictFlag: z.boolean(),
  overlayComplete: z.boolean(),
  lastMaterialUpdate: z.iso.datetime(),
  pendingAssertions: z.array(pendingAssertionSchema).max(200),
});
export type CommitmentProjectionRow = z.infer<typeof commitmentProjectionRowSchema>;

export const obligationProjectionRowSchema = projectionRowMetadataSchema.extend({
  obligationFrameInstanceId: z.uuid(),
  debtorEntityId: z.uuid().nullable(),
  creditorEntityId: z.uuid().nullable(),
  principalAmount: moneyAmountSchema.nullable(),
  currency: currencyCodeSchema.nullable(),
  dueTime: z.iso.datetime().nullable(),
  totalCanonicalAllocation: moneyAmountSchema,
  remainingAmountCapabilityDerived: moneyAmountSchema.nullable(),
  unclassifiedRemainder: moneyAmountSchema.nullable(),
  outcomeState: outcomeStateSchema,
  conflictFlag: z.boolean(),
  overlayComplete: z.boolean(),
  pendingAssertions: z.array(pendingAssertionSchema).max(200),
});
export type ObligationProjectionRow = z.infer<typeof obligationProjectionRowSchema>;

export const scheduleProjectionRowSchema = projectionRowMetadataSchema.extend({
  scheduledFrameInstanceId: z.uuid(),
  startTime: z.iso.datetime().nullable(),
  endTime: z.iso.datetime().nullable(),
  recurrenceInstanceId: z.string().max(512).nullable(),
  participants: z.array(z.uuid()).max(500),
  realizationLinkId: z.uuid().nullable(),
  outcomeResolutionId: z.uuid().nullable(),
  preparationRequirement: z.string().max(2048).nullable(),
  pendingAssertions: z.array(pendingAssertionSchema).max(200),
});
export type ScheduleProjectionRow = z.infer<typeof scheduleProjectionRowSchema>;

/** What GET /v1/projections/{commitments,obligations,schedule} answers.
 *
 * `isComplete` is the conjunction over the rows returned *and* over anything the
 * reducer could not fold in, and `pendingAssertions` is never dropped when it is
 * false: an incomplete read shows the persisted state together with the owner
 * write that has not landed yet (CRT-PRJ-04-A, CRT-RYW-04-A). */
function projectionView<T extends z.ZodTypeAny>(row: T) {
  return z.strictObject({
    projectionName: projectionNameSchema,
    rows: z.array(row).max(500),
    isComplete: z.boolean(),
    ownerOverlayWatermark: z.number().int().nonnegative(),
    canonicalTransactionWatermark: z.iso.datetime(),
    projectionVersion: z.uuid().nullable(),
    reducerVersion: version,
    pendingAssertions: z.array(pendingAssertionSchema).max(500),
    /** True when a high-risk action over this read must be refused rather than
     * confirmed, because the state behind it is incomplete or contested. */
    highRiskActionsBlocked: z.boolean(),
    readAt: z.iso.datetime(),
  });
}
export const commitmentsProjectionViewSchema = projectionView(commitmentProjectionRowSchema);
export const obligationsProjectionViewSchema = projectionView(obligationProjectionRowSchema);
export const scheduleProjectionViewSchema = projectionView(scheduleProjectionRowSchema);
export type CommitmentsProjectionView = z.infer<typeof commitmentsProjectionViewSchema>;
export type ObligationsProjectionView = z.infer<typeof obligationsProjectionViewSchema>;
export type ScheduleProjectionView = z.infer<typeof scheduleProjectionViewSchema>;

export const projectionRebuildReceiptSchema = z.strictObject({
  projectionRebuildReceiptId: z.uuid(),
  projectionName: recordedProjectionNameSchema,
  trigger: rebuildTriggerSchema,
  transactionId: z.uuid().nullable(),
  rowsRebuilt: z.number().int().nonnegative(),
  /** Null only when the run made no comparison. False is a finding and is
   * recorded as false. */
  equalsIncremental: z.boolean().nullable(),
  projectionVersion: z.uuid(),
  reducerVersion: version,
  detail: z.record(z.string(), z.unknown()),
  createdAt: z.iso.datetime(),
});
export type ProjectionRebuildReceipt = z.infer<typeof projectionRebuildReceiptSchema>;

/** The Projection health screen (design screen "Projection health",
 * GET /v1/ops/projections). */
export const projectionHealthSchema = z.strictObject({
  projections: z.array(z.strictObject({
    projectionName: projectionNameSchema,
    reducerVersion: version,
    projectionVersion: z.uuid().nullable(),
    canonicalTransactionWatermark: z.iso.datetime().nullable(),
    ownerOverlayWatermark: z.number().int().nonnegative().nullable(),
    rowCount: z.number().int().nonnegative(),
    incompleteRowCount: z.number().int().nonnegative(),
    pendingAssertions: z.array(pendingAssertionSchema).max(200),
  })).max(20),
  receipts: z.array(projectionRebuildReceiptSchema).max(50),
  readAt: z.iso.datetime(),
});
export type ProjectionHealth = z.infer<typeof projectionHealthSchema>;

/** What the obligations capability computed, and what it refused to compute.
 *
 * The whole point of the shape is that a conflict is *reported* rather than
 * resolved by picking one value: `conflictingAmounts` keeps every competing
 * proposition with the claim and origin behind it, and a HIGH-risk calculation
 * over a slot that has one is `blocked` (CRT-MEM-08-A, FR-016). */
export const amountConflictSchema = z.strictObject({
  beliefSlotId: z.uuid(),
  predicateId: registryId,
  propositions: z.array(z.strictObject({
    propositionId: z.uuid(),
    amount: moneyAmountSchema,
    currency: currencyCodeSchema,
    claimIds: z.array(z.uuid()).max(200),
    claimOrigins: z.array(z.string().regex(/^[A-Z][A-Z_]{0,63}$/)).max(20),
  })).min(2).max(50),
});
export type AmountConflict = z.infer<typeof amountConflictSchema>;

export const obligationCalculationSchema = z.strictObject({
  obligationFrameInstanceId: z.uuid(),
  risk: z.enum(['LOW', 'MEDIUM', 'HIGH']),
  principalAmount: moneyAmountSchema.nullable(),
  currency: currencyCodeSchema.nullable(),
  totalCanonicalAllocation: moneyAmountSchema,
  remainingAmount: moneyAmountSchema.nullable(),
  unclassifiedRemainder: moneyAmountSchema.nullable(),
  allocationFrameInstanceIds: z.array(z.uuid()).max(500),
  /** Present and non-empty exactly when two propositions in one slot disagree.
   * It is never emptied by choosing a winner. */
  conflicts: z.array(amountConflictSchema).max(20),
  /** Read from the resolution assertions and reported so a surface can show it
   * as advisory, never used in any sum above (PRD §16.7, CRT-OUT-06-A). */
  advisoryCoverageIgnored: z.array(z.number()).max(200),
  blocked: z.boolean(),
  blockedReason: z.string().regex(/^[A-Z][A-Z_]{0,63}$/).nullable(),
  isComplete: z.boolean(),
  pendingAssertions: z.array(pendingAssertionSchema).max(200),
  capabilityVersion: version,
});
export type ObligationCalculation = z.infer<typeof obligationCalculationSchema>;

/** How a sentence reads as a commitment. `CONSIDERATION` is a first-class
 * answer: "I am considering sending it Friday" is evidence and creates nothing
 * (PRD §26.2, §44.8, §58; CRT-PRJ-07-A). */
export const commitmentLanguageSchema = z.enum(['COMMITMENT', 'CONSIDERATION', 'NONE']);
export type CommitmentLanguage = z.infer<typeof commitmentLanguageSchema>;

export const commitmentReadingSchema = z.strictObject({
  language: commitmentLanguageSchema,
  matchedText: z.string().max(512).nullable(),
  actionDescription: z.string().max(4096).nullable(),
  dueTimeText: z.string().max(512).nullable(),
  classifierVersion: version,
});
export type CommitmentReading = z.infer<typeof commitmentReadingSchema>;
