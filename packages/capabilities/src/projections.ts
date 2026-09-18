import {
  PROJECTION_NAMES, commitmentProjectionRowSchema, obligationProjectionRowSchema, scheduleProjectionRowSchema,
  commitmentsProjectionViewSchema, obligationsProjectionViewSchema, scheduleProjectionViewSchema,
  projectionRebuildReceiptSchema, projectionHealthSchema, projectionNameSchema, rebuildTriggerSchema,
  type CommitmentProjectionRow, type CommitmentsProjectionView, type Money, type ObligationProjectionRow,
  type ObligationsProjectionView, type PendingAssertion, type ProjectionHealth, type ProjectionName,
  type ProjectionRebuildReceipt, type RebuildTrigger, type ScheduleProjectionRow, type ScheduleProjectionView,
  type SourceStrength,
} from '@unai/domain';
import {
  canonicalJson, classifyResolutionStatement, frameOutcomeProjection, resolveEntitySurvivors, type MemoryTransaction,
} from '@unai/memory';
import { uuidV7 } from '../../../src/kernel/identities.js';
import {
  isSettledDelta, latestTime, listFrameInstances, pendingAssertion, readOwnerDeltas, readResolutions, readRoles,
  readSlotValues, readWatermarks, roleEntity, selectSlotValue,
  type CanonicalWatermarks, type OwnerDelta, type SlotValue,
} from './canonical.js';
import { COMMITMENT_FRAME_TYPE } from './commitments.js';
import {
  ALLOCATION_FRAME_TYPE, DUE_TIME_PREDICATE, OBLIGATION_FRAME_TYPE, PRINCIPAL_PREDICATE, amountConflict,
  computeObligationArithmetic, readAllocations, type AllocationReading,
} from './obligations.js';
import { moneyKey, readMoney, money, subtractMoney } from './money.js';
import {
  SCHEDULE_FRAME_TYPE, acceptedResolutionId, listScheduledFrameInstanceIds, readScheduleState,
} from './schedule.js';
import { dueInstant, readEntityReference, readReference, readText, readTimeValue } from './values.js';

/**
 * The projection service: incremental apply, bounded replay, explicit
 * incompleteness and rebuild receipts (PRD §25.3, §25.4, §33.12, §49;
 * CRT-PRJ-01-A, CRT-PRJ-02-A, CRT-PRJ-02-B, CRT-PRJ-03-A, CRT-PRJ-04-A,
 * CRT-OUT-07-A, CRT-RYW-04-A).
 *
 * The design rule that makes replay equal incremental apply is that there is only
 * one reducer. `applyProjectionDelta` and `replayProjection` differ in *which
 * frames* they hand to `buildRows`, and in nothing else: there is no fast path
 * that updates a column in place and no second implementation to drift. A full
 * replay is the same function over every frame.
 *
 * Determinism is the other half. Every value a row carries is a function of the
 * canonical rows, the owner's overlay and the `asOf` instant the caller declared.
 * `updated_at` and `last_material_update` are the newest *input* time and never
 * `now()`, which is why a rebuild days later reproduces the same row -- the only
 * column a rebuild changes is `projection_version`, which identifies the run that
 * wrote it (PRD §25.4 "deterministic for a pinned input set").
 *
 * Three things a projection row is not:
 *
 *  - It is not an outcome. `outcome_state` is `frameOutcomeProjection`'s reading
 *    of accepted resolution assertions, read here and stored nowhere else.
 *  - It is not a clock decision about failure. Passing a due time sets `overdue`
 *    and `due_soon` and creates no resolution assertion of any kind
 *    (CRT-OUT-07-A).
 *  - It is not complete by assumption. An owner write the reducer cannot fold in
 *    makes the row say `is_complete=false` and travels out with it
 *    (CRT-RYW-04-A).
 */

export const REDUCER_VERSION = 'projection-reducers-0.1.0';
export const PROJECTION_PURPOSE = 'memory.project';
export const PROJECTION_READ_PURPOSE = 'projection.read';
/** How far ahead of `asOf` a due time still counts as soon. A fixed window, not
 * a setting: a projection flag the owner cannot predict is worse than none. */
const DUE_SOON_MS = 48 * 60 * 60 * 1000;

export class ProjectionError extends Error {
  constructor(code: string) { super(code); this.name = 'ProjectionError'; }
}

const FRAME_COLUMN: Readonly<Record<ProjectionName, string>> = Object.freeze({
  open_commitments_projection: 'commitment_frame_instance_id',
  obligations_projection: 'obligation_frame_instance_id',
  schedule_projection: 'scheduled_frame_instance_id',
});

// ---------------------------------------------------------------------------
// Owner overlay: what the reducer can fold in, and what it must report instead
// ---------------------------------------------------------------------------

/** Money stated in the owner's own words. Currency first ("ILS 60") or after
 * ("60 ILS"); anything else is not a money statement and is reported as
 * unparseable rather than guessed at. */
export function parseMoneyText(text: string): Money | null {
  const leading = /\b([A-Z]{3})\s*(\d{1,18}(?:[.,]\d{1,6})?)\b/.exec(text);
  const trailing = /\b(\d{1,18}(?:[.,]\d{1,6})?)\s*([A-Z]{3})\b/.exec(text);
  const [code, amount] = leading ? [leading[1]!, leading[2]!]
    : trailing ? [trailing[2]!, trailing[1]!] : [null, null];
  if (code === null || amount === null) return null;
  try { return money(amount.replace(',', '.'), code); } catch { return null; }
}

interface DeltaFold {
  readonly applied: readonly string[];
  readonly pending: readonly PendingAssertion[];
  readonly suppressed: boolean;
  readonly principal: Money | null;
  readonly outcomeOverride: 'RESOLVED' | 'PARTIALLY_RESOLVED' | null;
  readonly latestAt: Date | null;
}

const EMPTY_FOLD: DeltaFold = Object.freeze({
  applied: Object.freeze([]), pending: Object.freeze([]), suppressed: false,
  principal: null, outcomeOverride: null, latestAt: null,
});

/** Kinds that hide an object from ordinary reads without stating a value. They
 * reduce cleanly: the row is still built, and the read leaves it out. */
const HIDING_KINDS = new Set(['SUPPRESSION', 'ARCHIVE', 'DELETION']);
/** Kinds that state no value at all and therefore need no reduction. */
const NEUTRAL_KINDS = new Set(['USER_CONFIRMATION', 'USER_REJECTION', 'KEEP_UNCERTAIN']);
/** Merge and split are governed belief transactions, not projection input. The
 * reducer reports one rather than pretending to have applied it. */
const GOVERNED_KINDS = new Set(['MERGE', 'SPLIT']);
const VALUE_KINDS = new Set(['USER_ASSERTION', 'USER_CORRECTION', 'USER_STATE_CHANGE']);

/**
 * Fold the owner's writes about one frame into the reading the projection shows.
 *
 * "Applied" means the owner's write moved the row before any canonicalization
 * ran, which is the whole promise of read-your-writes (CRT-RYW-02-A,
 * CRT-RYW-04-A). "Pending" means the reducer refused to move it and said why --
 * a contested delta, an unparseable one, a cross-currency one, or a merge. Both
 * are recorded; neither is dropped.
 */
function foldOwnerDeltas(
  deltas: readonly OwnerDelta[], projection: ProjectionName, currency: string | null,
): DeltaFold {
  const applied: string[] = [];
  const pending: PendingAssertion[] = [];
  let suppressed = false;
  let principal: Money | null = null;
  let outcomeOverride: 'RESOLVED' | 'PARTIALLY_RESOLVED' | null = null;
  let latestAt: Date | null = null;

  for (const delta of deltas) {
    if (isSettledDelta(delta)) continue;
    latestAt = latestTime([latestAt, delta.createdAt], delta.createdAt);
    if (delta.lifecycle === 'CONTESTED') { pending.push(pendingAssertion(delta, 'DELTA_CONTESTED')); continue; }
    if (GOVERNED_KINDS.has(delta.deltaKind)) { pending.push(pendingAssertion(delta, 'DELTA_KIND_NOT_REDUCIBLE')); continue; }
    if (HIDING_KINDS.has(delta.deltaKind)) { suppressed = true; applied.push(delta.overlayDeltaId); continue; }
    if (NEUTRAL_KINDS.has(delta.deltaKind)) { applied.push(delta.overlayDeltaId); continue; }
    if (!VALUE_KINDS.has(delta.deltaKind)) { pending.push(pendingAssertion(delta, 'DELTA_KIND_NOT_REDUCIBLE')); continue; }

    if (projection === 'obligations_projection') {
      const stated = parseMoneyText(delta.rawText);
      if (stated === null) { pending.push(pendingAssertion(delta, 'DELTA_VALUE_UNPARSEABLE')); continue; }
      // No conversion, ever: the capability has no rate and will not invent one
      // (PRD §26.1 normalization, §16.7).
      if (currency !== null && stated.currency !== currency) {
        pending.push(pendingAssertion(delta, 'DELTA_CURRENCY_CONVERSION_REFUSED'));
        continue;
      }
      principal = stated;
      applied.push(delta.overlayDeltaId);
      continue;
    }
    if (projection === 'open_commitments_projection') {
      const reading = classifyResolutionStatement(delta.rawText);
      if (reading === null) { pending.push(pendingAssertion(delta, 'DELTA_VALUE_UNPARSEABLE')); continue; }
      outcomeOverride = reading.outcomeCode === 'PARTIALLY_FULFILLED' || reading.outcomeCode === 'PARTIALLY_CONFIRMED'
        ? 'PARTIALLY_RESOLVED' : 'RESOLVED';
      applied.push(delta.overlayDeltaId);
      continue;
    }
    // A schedule row holds times and participants, which an owner sentence does
    // not state in a form this reducer can read.
    pending.push(pendingAssertion(delta, 'DELTA_VALUE_UNPARSEABLE'));
  }
  return Object.freeze({ applied: Object.freeze(applied), pending: Object.freeze(pending), suppressed,
    principal, outcomeOverride, latestAt });
}

/** How well supported the displayed reading is. An owner write the projection
 * applied outranks nothing: it says exactly that the owner asserted it and
 * nothing has verified it yet (PRD §15.4, CRT-RYW-02-A). */
function sourceStrength(origins: readonly string[], ownerApplied: boolean): SourceStrength {
  if (ownerApplied) return 'PENDING_OWNER_ASSERTION';
  const independent = ['EXTERNAL_PERSON_ASSERTION', 'STRUCTURED_CONNECTOR_OBSERVATION', 'DOCUMENT_ASSERTION', 'TOOL_EXECUTION_RECEIPT'];
  if (origins.some(origin => independent.includes(origin))) return 'INDEPENDENTLY_CORROBORATED';
  if (origins.some(origin => origin.startsWith('USER_'))) return 'OWNER_STATEMENT';
  if (origins.some(origin => origin.startsWith('MODEL_'))) return 'MODEL_ONLY';
  return 'NONE';
}

/** Two propositions in one slot that state different values. Used for the
 * conflict flag on the non-money projections, where "different" is textual. */
function textConflict(values: readonly SlotValue[]): boolean {
  return new Set(values.map(value => canonicalJson(value.normalizedValue ?? null))).size > 1;
}

interface OverlayContext {
  readonly deltasByFrame: ReadonlyMap<string, readonly OwnerDelta[]>;
  /** Deltas that name no frame at all. They belong to no row and are reported on
   * the view, which is what makes an unattached owner write visible rather than
   * lost (CRT-RYW-04-A). */
  readonly unattached: readonly PendingAssertion[];
  readonly ownerOverlayWatermark: number;
}

interface BuildContext extends OverlayContext {
  readonly ownerScopeId: string;
  readonly asOf: Date;
  readonly projectionVersion: string;
  readonly watermarks: CanonicalWatermarks;
}

/** The owner's overlay, grouped by the frame each delta speaks about.
 *
 * Split out from `buildContext` because the read path needs *only* this: a
 * projection read holds `projection.read`, which sees the projection rows and the
 * overlay and no canonical table at all. Recomputing the canonical watermark
 * there would silently answer "epoch" rather than fail, so the read takes that
 * watermark from the rows, which recorded it when the reducer wrote them.
 */
async function buildOverlayContext(tx: MemoryTransaction, ownerScopeId: string): Promise<OverlayContext> {
  const deltas = await readOwnerDeltas(tx, ownerScopeId);
  const byFrame = new Map<string, OwnerDelta[]>();
  const unattached: PendingAssertion[] = [];
  let watermark = 0;
  for (const delta of deltas) {
    watermark = Math.max(watermark, delta.ownerSequence);
    if (delta.frameInstanceId === null) {
      if (!isSettledDelta(delta)) unattached.push(pendingAssertion(delta, 'DELTA_NOT_ATTACHED'));
      continue;
    }
    const list = byFrame.get(delta.frameInstanceId) ?? [];
    list.push(delta);
    byFrame.set(delta.frameInstanceId, list);
  }
  return Object.freeze({ deltasByFrame: byFrame, unattached: Object.freeze(unattached), ownerOverlayWatermark: watermark });
}

async function buildContext(tx: MemoryTransaction, ownerScopeId: string, asOf: Date): Promise<BuildContext> {
  return Object.freeze({
    ...await buildOverlayContext(tx, ownerScopeId),
    ownerScopeId, asOf, projectionVersion: uuidV7(),
    watermarks: await readWatermarks(tx, ownerScopeId),
  });
}

function metadata(context: BuildContext, pending: readonly PendingAssertion[], manifest: Record<string, unknown>, updatedAt: Date) {
  return {
    ownerScopeId: context.ownerScopeId,
    projectionVersion: context.projectionVersion,
    canonicalTransactionWatermark: context.watermarks.canonicalTransactionWatermark.toISOString(),
    ownerOverlayWatermark: context.watermarks.ownerOverlayWatermark,
    reducerVersion: REDUCER_VERSION,
    isComplete: pending.length === 0,
    sourceManifest: { ...manifest, pendingAssertions: [...pending], reducerVersion: REDUCER_VERSION },
    updatedAt: updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// The three reducers
// ---------------------------------------------------------------------------

async function buildCommitmentRows(
  tx: MemoryTransaction, context: BuildContext, frameInstanceIds?: readonly string[],
): Promise<CommitmentProjectionRow[]> {
  const frames = await listFrameInstances(tx, { ownerScopeId: context.ownerScopeId,
    frameTypeId: COMMITMENT_FRAME_TYPE, frameInstanceIds });
  if (frames.length === 0) return [];
  const ids = frames.map(frame => frame.frameInstanceId);
  const roles = await readRoles(tx, { ownerScopeId: context.ownerScopeId, frameInstanceIds: ids });
  const actions = await readSlotValues(tx, { ownerScopeId: context.ownerScopeId, frameInstanceIds: ids,
    predicateId: 'shared.commitment.action_description', modality: 'COMMITTED' });
  const dueTimes = await readSlotValues(tx, { ownerScopeId: context.ownerScopeId, frameInstanceIds: ids,
    predicateId: 'shared.commitment.due_time', modality: 'COMMITTED' });
  const resolutions = await readResolutions(tx, { ownerScopeId: context.ownerScopeId, frameInstanceIds: ids });

  const rows: CommitmentProjectionRow[] = [];
  for (const frame of frames) {
    const frameActions = actions.filter(value => value.frameInstanceId === frame.frameInstanceId);
    const frameDue = dueTimes.filter(value => value.frameInstanceId === frame.frameInstanceId);
    const selectedAction = selectSlotValue(frameActions);
    const selectedDue = selectSlotValue(frameDue);
    const fold = foldOwnerDeltas(context.deltasByFrame.get(frame.frameInstanceId) ?? [], 'open_commitments_projection', null);
    // The outcome is the kernel's reading of accepted resolutions; an applied
    // owner statement shows on top of it and never rewrites it.
    const outcome = await frameOutcomeProjection(tx, { ownerScopeId: context.ownerScopeId, frameInstanceId: frame.frameInstanceId });
    const outcomeState = fold.outcomeOverride !== null && outcome.state === 'UNRESOLVED' ? fold.outcomeOverride : outcome.state;
    const due = dueInstant(selectedDue?.normalizedValue);
    const unresolved = outcomeState === 'UNRESOLVED' || outcomeState === 'PARTIALLY_RESOLVED';
    // Time passage moves these two booleans and nothing else (PRD §12.6).
    const overdue = due !== null && due.getTime() < context.asOf.getTime() && unresolved;
    const dueSoon = due !== null && !overdue && unresolved
      && due.getTime() <= context.asOf.getTime() + DUE_SOON_MS;
    const claimTimes = [...frameActions, ...frameDue].map(value => value.latestClaimAt);
    const resolutionTimes = resolutions
      .filter(resolution => resolution.sourceFrameInstanceId === frame.frameInstanceId)
      .map(resolution => resolution.recordedAt);
    const lastMaterialUpdate = latestTime([...claimTimes, ...resolutionTimes, fold.latestAt], frame.createdAt);

    rows.push(commitmentProjectionRowSchema.parse({
      ...metadata(context, fold.pending, {
        frameInstanceId: frame.frameInstanceId,
        frameTypeId: frame.frameTypeId,
        beliefSlotIds: [...new Set([...frameActions, ...frameDue].map(value => value.beliefSlotId))].sort(),
        propositionIds: [...frameActions, ...frameDue].map(value => value.propositionId).sort(),
        claimIds: [...new Set([...frameActions, ...frameDue].flatMap(value => [...value.claimIds]))].sort(),
        resolutionAssertionIds: resolutions
          .filter(resolution => resolution.sourceFrameInstanceId === frame.frameInstanceId)
          .map(resolution => resolution.resolutionAssertionId),
        acceptedResolutionIds: [...outcome.acceptedResolutionIds],
        appliedOverlayDeltaIds: [...fold.applied],
        ownerSuppressed: fold.suppressed,
      }, lastMaterialUpdate),
      commitmentFrameInstanceId: frame.frameInstanceId,
      promisorEntityId: roleEntity(roles, frame.frameInstanceId, 'promisor'),
      promiseeEntityId: roleEntity(roles, frame.frameInstanceId, 'promisee'),
      actionDescription: readText(selectedAction?.normalizedValue),
      dueTime: due === null ? null : due.toISOString(),
      outcomeState,
      overdue,
      dueSoon,
      sourceStrength: sourceStrength(selectedAction?.claimOrigins ?? [], fold.outcomeOverride !== null),
      conflictFlag: outcomeState === 'CONTESTED' || textConflict(frameActions) || textConflict(frameDue),
      overlayComplete: fold.pending.length === 0,
      lastMaterialUpdate: lastMaterialUpdate.toISOString(),
      pendingAssertions: [...fold.pending],
    }));
  }
  return rows;
}

async function buildObligationRows(
  tx: MemoryTransaction, context: BuildContext, frameInstanceIds?: readonly string[],
): Promise<ObligationProjectionRow[]> {
  const frames = await listFrameInstances(tx, { ownerScopeId: context.ownerScopeId,
    frameTypeId: OBLIGATION_FRAME_TYPE, frameInstanceIds });
  if (frames.length === 0) return [];
  const ids = frames.map(frame => frame.frameInstanceId);
  const roles = await readRoles(tx, { ownerScopeId: context.ownerScopeId, frameInstanceIds: ids });
  const principals = await readSlotValues(tx, { ownerScopeId: context.ownerScopeId, frameInstanceIds: ids,
    predicateId: PRINCIPAL_PREDICATE, modality: 'ACTUAL' });
  const dueTimes = await readSlotValues(tx, { ownerScopeId: context.ownerScopeId, frameInstanceIds: ids,
    predicateId: DUE_TIME_PREDICATE, modality: 'ACTUAL' });
  const allocations = await readAllocations(tx, { ownerScopeId: context.ownerScopeId, obligationFrameInstanceIds: ids });
  const resolutions = await readResolutions(tx, { ownerScopeId: context.ownerScopeId, frameInstanceIds: ids });

  const rows: ObligationProjectionRow[] = [];
  for (const frame of frames) {
    const framePrincipals = principals.filter(value => value.frameInstanceId === frame.frameInstanceId);
    const frameDue = dueTimes.filter(value => value.frameInstanceId === frame.frameInstanceId);
    const canonicalPrincipal = readMoney(selectSlotValue(framePrincipals)?.normalizedValue);
    const frameAllocations: AllocationReading[] = allocations
      .filter(allocation => allocation.obligationFrameInstanceId === frame.frameInstanceId);
    const fold = foldOwnerDeltas(context.deltasByFrame.get(frame.frameInstanceId) ?? [],
      'obligations_projection', canonicalPrincipal?.currency ?? null);
    const principal = fold.principal ?? canonicalPrincipal;
    // Every number below is recomputed here from the canonical allocation frames.
    // `advisory_coverage` is read on the resolutions and is not among the inputs
    // (PRD §16.7, CRT-OUT-06-A).
    const arithmetic = computeObligationArithmetic({
      obligationFrameInstanceId: frame.frameInstanceId,
      principalValues: framePrincipals, principal, principalConflict: null,
      dueTimeValues: frameDue, allocations: frameAllocations, advisoryCoverage: [],
    });
    const outcome = await frameOutcomeProjection(tx, { ownerScopeId: context.ownerScopeId, frameInstanceId: frame.frameInstanceId });
    const conflict = amountConflict(framePrincipals);
    const frameResolutions = resolutions.filter(resolution => resolution.sourceFrameInstanceId === frame.frameInstanceId);
    const updatedAt = latestTime([
      ...[...framePrincipals, ...frameDue].map(value => value.latestClaimAt),
      ...frameResolutions.map(resolution => resolution.recordedAt),
      fold.latestAt,
    ], frame.createdAt);

    rows.push(obligationProjectionRowSchema.parse({
      ...metadata(context, fold.pending, {
        frameInstanceId: frame.frameInstanceId,
        frameTypeId: frame.frameTypeId,
        beliefSlotIds: [...new Set([...framePrincipals, ...frameDue].map(value => value.beliefSlotId))].sort(),
        propositionIds: [...framePrincipals, ...frameDue].map(value => value.propositionId).sort(),
        claimIds: [...new Set([...framePrincipals, ...frameDue].flatMap(value => [...value.claimIds]))].sort(),
        allocationFrameInstanceIds: frameAllocations.map(allocation => allocation.allocationFrameInstanceId).sort(),
        allocationFrameTypeId: ALLOCATION_FRAME_TYPE,
        resolutionAssertionIds: frameResolutions.map(resolution => resolution.resolutionAssertionId),
        acceptedResolutionIds: [...outcome.acceptedResolutionIds],
        // Carried so a surface can label it advisory. It is an output of this
        // manifest and an input to nothing.
        advisoryCoverageIgnored: frameResolutions
          .map(resolution => resolution.advisoryCoverage)
          .filter((coverage): coverage is number => coverage !== null),
        conflictingAmounts: conflict === null ? [] : conflict.propositions.map(proposition => ({
          propositionId: proposition.propositionId, amount: proposition.amount, currency: proposition.currency,
        })),
        currencyMismatchAllocationIds: [...arithmetic.currencyMismatchAllocationIds],
        appliedOverlayDeltaIds: [...fold.applied],
        ownerSuppressed: fold.suppressed,
      }, updatedAt),
      obligationFrameInstanceId: frame.frameInstanceId,
      debtorEntityId: roleEntity(roles, frame.frameInstanceId, 'debtor'),
      creditorEntityId: roleEntity(roles, frame.frameInstanceId, 'creditor'),
      principalAmount: principal?.amount ?? null,
      currency: principal?.currency ?? null,
      dueTime: dueInstant(selectSlotValue(frameDue)?.normalizedValue)?.toISOString() ?? null,
      totalCanonicalAllocation: arithmetic.totalCanonicalAllocation.amount,
      remainingAmountCapabilityDerived: arithmetic.remainingAmount?.amount ?? null,
      unclassifiedRemainder: arithmetic.unclassifiedRemainder?.amount ?? null,
      outcomeState: outcome.state,
      conflictFlag: conflict !== null || outcome.state === 'CONTESTED'
        || arithmetic.currencyMismatchAllocationIds.length > 0,
      overlayComplete: fold.pending.length === 0,
      pendingAssertions: [...fold.pending],
    }));
  }
  return rows;
}

async function buildScheduleRows(
  tx: MemoryTransaction, context: BuildContext, frameInstanceIds?: readonly string[],
): Promise<ScheduleProjectionRow[]> {
  const ids = await listScheduledFrameInstanceIds(tx, { ownerScopeId: context.ownerScopeId, frameInstanceIds });
  if (ids.length === 0) return [];
  const frames = await listFrameInstances(tx, { ownerScopeId: context.ownerScopeId,
    frameTypeId: SCHEDULE_FRAME_TYPE, frameInstanceIds: ids });
  const state = await readScheduleState(tx, { ownerScopeId: context.ownerScopeId, frameInstanceIds: ids });
  // A participant named by value reads as its survivor after an entity merge, as
  // one named by role already does (ADR 0023 §3).
  const participantSurvivors = await resolveEntitySurvivors(tx, { ownerScopeId: context.ownerScopeId,
    entityIds: state.participantValues.map(value => readEntityReference(value.normalizedValue))
      .filter((entityId): entityId is string => entityId !== null) });

  const rows: ScheduleProjectionRow[] = [];
  for (const frame of frames) {
    const times = state.occurrenceTimes.filter(value => value.frameInstanceId === frame.frameInstanceId);
    const selected = selectSlotValue(times);
    const interval = readTimeValue(selected?.normalizedValue);
    const participantValues = state.participantValues.filter(value => value.frameInstanceId === frame.frameInstanceId);
    const participants = [...new Set([
      ...state.roles.filter(role => role.frameInstanceId === frame.frameInstanceId && role.entityId !== null)
        .map(role => role.entityId!),
      ...participantValues.map(value => readEntityReference(value.normalizedValue))
        .filter((entityId): entityId is string => entityId !== null)
        .map(entityId => participantSurvivors.get(entityId) ?? entityId),
    ])].sort();
    const references = state.referenceValues.filter(value => value.frameInstanceId === frame.frameInstanceId);
    const realization = state.realizations
      .filter(link => link.sourceFrameInstanceId === frame.frameInstanceId)
      .at(-1) ?? null;
    const fold = foldOwnerDeltas(context.deltasByFrame.get(frame.frameInstanceId) ?? [], 'schedule_projection', null);
    const frameResolutions = state.resolutions.filter(resolution => resolution.sourceFrameInstanceId === frame.frameInstanceId);
    const updatedAt = latestTime([
      ...[...times, ...participantValues, ...references].map(value => value.latestClaimAt),
      ...frameResolutions.map(resolution => resolution.recordedAt),
      realization?.createdAt ?? null, fold.latestAt,
    ], frame.createdAt);

    rows.push(scheduleProjectionRowSchema.parse({
      ...metadata(context, fold.pending, {
        frameInstanceId: frame.frameInstanceId,
        frameTypeId: frame.frameTypeId,
        beliefSlotIds: [...new Set([...times, ...participantValues, ...references].map(value => value.beliefSlotId))].sort(),
        propositionIds: [...times, ...participantValues, ...references].map(value => value.propositionId).sort(),
        claimIds: [...new Set([...times, ...participantValues, ...references].flatMap(value => [...value.claimIds]))].sort(),
        realizingFrameInstanceIds: state.realizations
          .filter(link => link.sourceFrameInstanceId === frame.frameInstanceId)
          .map(link => link.realizingFrameInstanceId),
        resolutionAssertionIds: frameResolutions.map(resolution => resolution.resolutionAssertionId),
        appliedOverlayDeltaIds: [...fold.applied],
        ownerSuppressed: fold.suppressed,
        // Release 0.1.0 declares no preparation-requirement predicate, so the
        // column stays null until a registry release defines one. Recording the
        // absence keeps it from reading as "nothing to prepare".
        preparationRequirementPredicate: null,
      }, updatedAt),
      scheduledFrameInstanceId: frame.frameInstanceId,
      startTime: interval?.start?.toISOString() ?? null,
      endTime: interval?.end?.toISOString() ?? null,
      recurrenceInstanceId: readReference(selectSlotValue(references)?.normalizedValue),
      participants,
      realizationLinkId: realization?.memoryLinkId ?? null,
      outcomeResolutionId: acceptedResolutionId(state.resolutions, frame.frameInstanceId),
      preparationRequirement: null,
      pendingAssertions: [...fold.pending],
    }));
  }
  return rows;
}

type AnyRow = CommitmentProjectionRow | ObligationProjectionRow | ScheduleProjectionRow;

async function buildRows(
  tx: MemoryTransaction, context: BuildContext, projection: ProjectionName, frameInstanceIds?: readonly string[],
): Promise<AnyRow[]> {
  return projection === 'open_commitments_projection' ? buildCommitmentRows(tx, context, frameInstanceIds)
    : projection === 'obligations_projection' ? buildObligationRows(tx, context, frameInstanceIds)
      : buildScheduleRows(tx, context, frameInstanceIds);
}

// ---------------------------------------------------------------------------
// Writing rows
// ---------------------------------------------------------------------------

async function writeCommitmentRow(tx: MemoryTransaction, row: CommitmentProjectionRow): Promise<void> {
  await tx.query(
    `INSERT INTO open_commitments_projection(owner_scope_id,commitment_frame_instance_id,promisor_entity_id,
      promisee_entity_id,action_description,due_time,outcome_state,overdue,due_soon,source_strength,conflict_flag,
      overlay_complete,last_material_update,projection_version,canonical_transaction_watermark,owner_overlay_watermark,
      reducer_version,is_complete,source_manifest,updated_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
     ON CONFLICT(owner_scope_id,commitment_frame_instance_id) DO UPDATE SET
      promisor_entity_id=EXCLUDED.promisor_entity_id, promisee_entity_id=EXCLUDED.promisee_entity_id,
      action_description=EXCLUDED.action_description, due_time=EXCLUDED.due_time,
      outcome_state=EXCLUDED.outcome_state, overdue=EXCLUDED.overdue, due_soon=EXCLUDED.due_soon,
      source_strength=EXCLUDED.source_strength, conflict_flag=EXCLUDED.conflict_flag,
      overlay_complete=EXCLUDED.overlay_complete, last_material_update=EXCLUDED.last_material_update,
      projection_version=EXCLUDED.projection_version,
      canonical_transaction_watermark=EXCLUDED.canonical_transaction_watermark,
      owner_overlay_watermark=EXCLUDED.owner_overlay_watermark, reducer_version=EXCLUDED.reducer_version,
      is_complete=EXCLUDED.is_complete, source_manifest=EXCLUDED.source_manifest, updated_at=EXCLUDED.updated_at`,
    [row.ownerScopeId, row.commitmentFrameInstanceId, row.promisorEntityId, row.promiseeEntityId,
      row.actionDescription, row.dueTime, row.outcomeState, row.overdue, row.dueSoon, row.sourceStrength,
      row.conflictFlag, row.overlayComplete, row.lastMaterialUpdate, row.projectionVersion,
      row.canonicalTransactionWatermark, row.ownerOverlayWatermark, row.reducerVersion, row.isComplete,
      JSON.stringify(row.sourceManifest), row.updatedAt]);
}

async function writeObligationRow(tx: MemoryTransaction, row: ObligationProjectionRow): Promise<void> {
  await tx.query(
    `INSERT INTO obligations_projection(owner_scope_id,obligation_frame_instance_id,debtor_entity_id,
      creditor_entity_id,principal_amount,currency,due_time,total_canonical_allocation,
      remaining_amount_capability_derived,unclassified_remainder,outcome_state,conflict_flag,overlay_complete,
      projection_version,canonical_transaction_watermark,owner_overlay_watermark,reducer_version,is_complete,
      source_manifest,updated_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
     ON CONFLICT(owner_scope_id,obligation_frame_instance_id) DO UPDATE SET
      debtor_entity_id=EXCLUDED.debtor_entity_id, creditor_entity_id=EXCLUDED.creditor_entity_id,
      principal_amount=EXCLUDED.principal_amount, currency=EXCLUDED.currency, due_time=EXCLUDED.due_time,
      total_canonical_allocation=EXCLUDED.total_canonical_allocation,
      remaining_amount_capability_derived=EXCLUDED.remaining_amount_capability_derived,
      unclassified_remainder=EXCLUDED.unclassified_remainder, outcome_state=EXCLUDED.outcome_state,
      conflict_flag=EXCLUDED.conflict_flag, overlay_complete=EXCLUDED.overlay_complete,
      projection_version=EXCLUDED.projection_version,
      canonical_transaction_watermark=EXCLUDED.canonical_transaction_watermark,
      owner_overlay_watermark=EXCLUDED.owner_overlay_watermark, reducer_version=EXCLUDED.reducer_version,
      is_complete=EXCLUDED.is_complete, source_manifest=EXCLUDED.source_manifest, updated_at=EXCLUDED.updated_at`,
    [row.ownerScopeId, row.obligationFrameInstanceId, row.debtorEntityId, row.creditorEntityId,
      row.principalAmount, row.currency, row.dueTime, row.totalCanonicalAllocation,
      row.remainingAmountCapabilityDerived, row.unclassifiedRemainder, row.outcomeState, row.conflictFlag,
      row.overlayComplete, row.projectionVersion, row.canonicalTransactionWatermark, row.ownerOverlayWatermark,
      row.reducerVersion, row.isComplete, JSON.stringify(row.sourceManifest), row.updatedAt]);
}

async function writeScheduleRow(tx: MemoryTransaction, row: ScheduleProjectionRow): Promise<void> {
  await tx.query(
    `INSERT INTO schedule_projection(owner_scope_id,scheduled_frame_instance_id,start_time,end_time,
      recurrence_instance_id,participants,realization_link_id,outcome_resolution_id,preparation_requirement,
      projection_version,canonical_transaction_watermark,owner_overlay_watermark,reducer_version,is_complete,
      source_manifest,updated_at)
     VALUES($1,$2,$3,$4,$5,$6::uuid[],$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT(owner_scope_id,scheduled_frame_instance_id) DO UPDATE SET
      start_time=EXCLUDED.start_time, end_time=EXCLUDED.end_time,
      recurrence_instance_id=EXCLUDED.recurrence_instance_id, participants=EXCLUDED.participants,
      realization_link_id=EXCLUDED.realization_link_id, outcome_resolution_id=EXCLUDED.outcome_resolution_id,
      preparation_requirement=EXCLUDED.preparation_requirement, projection_version=EXCLUDED.projection_version,
      canonical_transaction_watermark=EXCLUDED.canonical_transaction_watermark,
      owner_overlay_watermark=EXCLUDED.owner_overlay_watermark, reducer_version=EXCLUDED.reducer_version,
      is_complete=EXCLUDED.is_complete, source_manifest=EXCLUDED.source_manifest, updated_at=EXCLUDED.updated_at`,
    [row.ownerScopeId, row.scheduledFrameInstanceId, row.startTime, row.endTime, row.recurrenceInstanceId,
      [...row.participants], row.realizationLinkId, row.outcomeResolutionId, row.preparationRequirement,
      row.projectionVersion, row.canonicalTransactionWatermark, row.ownerOverlayWatermark, row.reducerVersion,
      row.isComplete, JSON.stringify(row.sourceManifest), row.updatedAt]);
}

async function writeRows(tx: MemoryTransaction, projection: ProjectionName, rows: readonly AnyRow[]): Promise<void> {
  for (const row of rows) {
    if (projection === 'open_commitments_projection') await writeCommitmentRow(tx, row as CommitmentProjectionRow);
    else if (projection === 'obligations_projection') await writeObligationRow(tx, row as ObligationProjectionRow);
    else await writeScheduleRow(tx, row as ScheduleProjectionRow);
  }
}

/**
 * Remove the rows of frames this projection no longer projects.
 *
 * A frame merged into a survivor or split into new instances is not active any
 * more; its situation is projected under the survivor or the new instances, and a
 * row still keyed by the old id would show one situation twice. A projection row
 * is a rebuildable cache (ADR 0021 §7), so removing it destroys nothing canonical:
 * the old id keeps resolving through lineage (ADR 0023 §3). With `keep` given,
 * every row outside it goes too, which is what a full replay means by "rebuild".
 */
async function pruneRows(tx: MemoryTransaction, ownerScopeId: string, projection: ProjectionName,
  keep: readonly string[] | null): Promise<number> {
  const column = FRAME_COLUMN[projection];
  const removed = await tx.query(
    `DELETE FROM ${projection} p WHERE p.owner_scope_id=$1
       AND (($2::uuid[] IS NOT NULL AND NOT (p.${column}=ANY($2::uuid[])))
         OR NOT EXISTS(SELECT 1 FROM frame_instances f
           WHERE f.owner_scope_id=p.owner_scope_id AND f.id=p.${column} AND f.lifecycle='ACTIVE'))`,
    [ownerScopeId, keep === null ? null : [...keep]]);
  return removed.rowCount ?? 0;
}

// ---------------------------------------------------------------------------
// Reading rows back
// ---------------------------------------------------------------------------

function storedMetadata(row: Record<string, unknown>) {
  const manifest = (row['source_manifest'] ?? {}) as Record<string, unknown>;
  const pending = Array.isArray(manifest['pendingAssertions']) ? manifest['pendingAssertions'] as PendingAssertion[] : [];
  return {
    metadata: {
      ownerScopeId: row['owner_scope_id'] as string,
      projectionVersion: row['projection_version'] as string,
      canonicalTransactionWatermark: (row['canonical_transaction_watermark'] as Date).toISOString(),
      ownerOverlayWatermark: Number(row['owner_overlay_watermark']),
      reducerVersion: row['reducer_version'] as string,
      isComplete: row['is_complete'] as boolean,
      sourceManifest: manifest,
      updatedAt: (row['updated_at'] as Date).toISOString(),
    },
    pending,
    manifest,
  };
}

function toCommitmentRow(row: Record<string, unknown>): CommitmentProjectionRow {
  const { metadata: meta, pending } = storedMetadata(row);
  return commitmentProjectionRowSchema.parse({
    ...meta,
    commitmentFrameInstanceId: row['commitment_frame_instance_id'],
    promisorEntityId: (row['promisor_entity_id'] as string | null) ?? null,
    promiseeEntityId: (row['promisee_entity_id'] as string | null) ?? null,
    actionDescription: (row['action_description'] as string | null) ?? null,
    dueTime: row['due_time'] === null || row['due_time'] === undefined ? null : (row['due_time'] as Date).toISOString(),
    outcomeState: row['outcome_state'], overdue: row['overdue'], dueSoon: row['due_soon'],
    sourceStrength: row['source_strength'], conflictFlag: row['conflict_flag'],
    overlayComplete: row['overlay_complete'],
    lastMaterialUpdate: (row['last_material_update'] as Date).toISOString(),
    pendingAssertions: pending,
  });
}

/** `numeric` arrives from node-postgres as a string, which is exactly what a
 * money amount must stay: parsing it into a double here would undo the whole
 * point of the typed column. */
const amount = (value: unknown): string | null => value === null || value === undefined ? null : String(value);

function toObligationRow(row: Record<string, unknown>): ObligationProjectionRow {
  const { metadata: meta, pending } = storedMetadata(row);
  return obligationProjectionRowSchema.parse({
    ...meta,
    obligationFrameInstanceId: row['obligation_frame_instance_id'],
    debtorEntityId: (row['debtor_entity_id'] as string | null) ?? null,
    creditorEntityId: (row['creditor_entity_id'] as string | null) ?? null,
    principalAmount: amount(row['principal_amount']),
    currency: (row['currency'] as string | null) ?? null,
    dueTime: row['due_time'] === null || row['due_time'] === undefined ? null : (row['due_time'] as Date).toISOString(),
    totalCanonicalAllocation: amount(row['total_canonical_allocation']) ?? '0',
    remainingAmountCapabilityDerived: amount(row['remaining_amount_capability_derived']),
    unclassifiedRemainder: amount(row['unclassified_remainder']),
    outcomeState: row['outcome_state'], conflictFlag: row['conflict_flag'],
    overlayComplete: row['overlay_complete'], pendingAssertions: pending,
  });
}

function toScheduleRow(row: Record<string, unknown>): ScheduleProjectionRow {
  const { metadata: meta, pending } = storedMetadata(row);
  return scheduleProjectionRowSchema.parse({
    ...meta,
    scheduledFrameInstanceId: row['scheduled_frame_instance_id'],
    startTime: row['start_time'] === null || row['start_time'] === undefined ? null : (row['start_time'] as Date).toISOString(),
    endTime: row['end_time'] === null || row['end_time'] === undefined ? null : (row['end_time'] as Date).toISOString(),
    recurrenceInstanceId: (row['recurrence_instance_id'] as string | null) ?? null,
    participants: [...(row['participants'] as string[])],
    realizationLinkId: (row['realization_link_id'] as string | null) ?? null,
    outcomeResolutionId: (row['outcome_resolution_id'] as string | null) ?? null,
    preparationRequirement: (row['preparation_requirement'] as string | null) ?? null,
    pendingAssertions: pending,
  });
}

/** Every stored row of one projection, in source-frame order. */
export async function readProjectionRows(tx: MemoryTransaction, input: {
  ownerScopeId: string; projectionName: ProjectionName;
}): Promise<AnyRow[]> {
  const projection = projectionNameSchema.parse(input.projectionName);
  const rows = (await tx.query(
    `SELECT * FROM ${projection} WHERE owner_scope_id=$1 ORDER BY ${FRAME_COLUMN[projection]}`,
    [input.ownerScopeId])).rows;
  return projection === 'open_commitments_projection' ? rows.map(toCommitmentRow)
    : projection === 'obligations_projection' ? rows.map(toObligationRow)
      : rows.map(toScheduleRow);
}

/**
 * The comparable content of a row.
 *
 * Everything except `projectionVersion`, which is the identity of the *run* that
 * wrote the row rather than anything about the situation it projects: a rebuild
 * is a new run and mints a new one. Every other column, including `updatedAt`, is
 * a function of the canonical inputs, so two runs over the same inputs produce
 * the same fingerprint (CRT-PRJ-02-A, CRT-PRJ-02-B).
 */
export function projectionRowContent(row: AnyRow): string {
  const { projectionVersion: _ignored, ...content } = row as AnyRow & { projectionVersion: string };
  return canonicalJson(content);
}

function sameRows(left: readonly AnyRow[], right: readonly AnyRow[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((row, index) => projectionRowContent(row) === projectionRowContent(right[index]!));
}

// ---------------------------------------------------------------------------
// Apply, replay and receipts
// ---------------------------------------------------------------------------

export interface ApplyProjectionInput {
  readonly ownerScopeId: string;
  readonly projectionName: ProjectionName;
  /** The frames the caller knows changed. Omitting it rebuilds every row, which
   * is what a replay does. */
  readonly frameInstanceIds?: readonly string[] | undefined;
  readonly asOf: Date;
}

/**
 * Recompute the named rows from canonical memory.
 *
 * Incremental only in *scope*: the rows it touches are recomputed from scratch by
 * the same reducer a replay uses, never patched. There is therefore no accumulated
 * state that could drift from the canonical rows between replays.
 */
export async function applyProjectionDelta(tx: MemoryTransaction, input: ApplyProjectionInput): Promise<{
  readonly projectionName: ProjectionName; readonly projectionVersion: string; readonly rowsWritten: number;
  readonly pendingAssertions: readonly PendingAssertion[];
}> {
  const projection = projectionNameSchema.parse(input.projectionName);
  const context = await buildContext(tx, input.ownerScopeId, input.asOf);
  const rows = await buildRows(tx, context, projection, input.frameInstanceIds);
  await writeRows(tx, projection, rows);
  return Object.freeze({
    projectionName: projection, projectionVersion: context.projectionVersion, rowsWritten: rows.length,
    pendingAssertions: Object.freeze([...context.unattached, ...rows.flatMap(row => [...row.pendingAssertions])]),
  });
}

export interface ReplayProjectionInput {
  readonly ownerScopeId: string;
  readonly projectionName: ProjectionName;
  readonly asOf: Date;
  readonly trigger?: RebuildTrigger;
  readonly transactionId?: string | null;
  /** Compare the rebuilt rows with whatever was stored before the rebuild and
   * record the verdict on the receipt. False is recorded as false. */
  readonly compareWithStored?: boolean;
  /** Context the caller records on the receipt, such as the frames a merge touched. */
  readonly detail?: Record<string, unknown>;
}

/**
 * Rebuild a whole projection from canonical memory and record the receipt.
 *
 * `equalsIncremental` on the receipt is the answer to the question PRD §25.4 and
 * §49 actually ask: did replaying produce the rows the incremental path had
 * already written? It is computed by comparing content, never asserted.
 */
export async function replayProjection(tx: MemoryTransaction, input: ReplayProjectionInput): Promise<ProjectionRebuildReceipt> {
  const projection = projectionNameSchema.parse(input.projectionName);
  const trigger = rebuildTriggerSchema.parse(input.trigger ?? 'MANUAL_REPLAY');
  const compare = input.compareWithStored ?? true;
  const before = compare ? await readProjectionRows(tx, { ownerScopeId: input.ownerScopeId, projectionName: projection }) : [];
  const context = await buildContext(tx, input.ownerScopeId, input.asOf);
  const rows = await buildRows(tx, context, projection);
  await writeRows(tx, projection, rows);
  // A rebuild from canonical memory holds exactly the rows canonical memory
  // produces: the row of a frame no longer projected does not survive it.
  const pruned = await pruneRows(tx, input.ownerScopeId, projection, rows.map(row => frameIdOf(row, projection)));
  const after = await readProjectionRows(tx, { ownerScopeId: input.ownerScopeId, projectionName: projection });
  return recordRebuildReceipt(tx, {
    ownerScopeId: input.ownerScopeId, projectionName: projection, trigger,
    transactionId: input.transactionId ?? null, rowsRebuilt: rows.length,
    equalsIncremental: compare ? sameRows(before, after) : null,
    projectionVersion: context.projectionVersion,
    detail: {
      ...(input.detail ?? {}),
      comparedRows: before.length,
      prunedRows: pruned,
      unattachedPendingAssertions: context.unattached.length,
      incompleteRows: after.filter(row => !row.isComplete).length,
      asOf: input.asOf.toISOString(),
    },
  });
}

export async function recordRebuildReceipt(tx: MemoryTransaction, input: {
  ownerScopeId: string; projectionName: ProjectionName; trigger: RebuildTrigger; transactionId?: string | null;
  rowsRebuilt: number; equalsIncremental: boolean | null; projectionVersion: string;
  detail?: Record<string, unknown>;
}): Promise<ProjectionRebuildReceipt> {
  const id = uuidV7();
  const row = (await tx.query(
    `INSERT INTO projection_rebuild_receipts(id,owner_scope_id,projection_name,trigger,transaction_id,rows_rebuilt,
      equals_incremental,projection_version,reducer_version,detail)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [id, input.ownerScopeId, projectionNameSchema.parse(input.projectionName), rebuildTriggerSchema.parse(input.trigger),
      input.transactionId ?? null, input.rowsRebuilt, input.equalsIncremental, input.projectionVersion,
      REDUCER_VERSION, JSON.stringify(input.detail ?? {})])).rows[0];
  if (!row) throw new ProjectionError('PROJECTION_RECEIPT_NOT_RECORDED');
  return toReceipt(row);
}

function toReceipt(row: Record<string, unknown>): ProjectionRebuildReceipt {
  return projectionRebuildReceiptSchema.parse({
    projectionRebuildReceiptId: row['id'], projectionName: row['projection_name'], trigger: row['trigger'],
    transactionId: (row['transaction_id'] as string | null) ?? null,
    rowsRebuilt: Number(row['rows_rebuilt']),
    equalsIncremental: (row['equals_incremental'] as boolean | null) ?? null,
    projectionVersion: row['projection_version'], reducerVersion: row['reducer_version'],
    detail: row['detail'], createdAt: (row['created_at'] as Date).toISOString(),
  });
}

export interface LineageRebuildInput {
  readonly ownerScopeId: string;
  readonly trigger: 'MERGE' | 'SPLIT';
  /** The committed MERGE or SPLIT transaction the rebuild answers for. */
  readonly transactionId: string;
  /** Every frame the transaction touched: survivors and new instances, and the
   * merged or split frames whose rows must go. */
  readonly frameInstanceIds: readonly string[];
  readonly asOf: Date;
}

/**
 * Rebuild every typed projection after a governed merge or split (PRD §14.1
 * item 8, §14.2 item 6; CRT-MEM-10-A, CRT-MEM-10-B, CRT-MEM-10-C).
 *
 * The incremental step first: the one reducer recomputes the rows -- every row,
 * because the commit moved the canonical transaction watermark each row carries
 * (PRD §33.12), and the affected frames among them -- and the rows of frames the
 * transaction retired are removed. Then a full replay of each projection is
 * compared with that state, and its receipt -- trigger MERGE or SPLIT, naming
 * the transaction -- records whether the two agreed. The comparison is
 * computed, never asserted.
 *
 * Idempotent per transaction: a retried request finds the receipts already
 * recorded for this transaction and answers with them instead of rebuilding
 * twice, so the same request always answers the same receipts.
 */
export async function rebuildProjectionsAfterLineageChange(tx: MemoryTransaction, input: LineageRebuildInput): Promise<ProjectionRebuildReceipt[]> {
  const trigger = rebuildTriggerSchema.parse(input.trigger);
  const recorded = (await tx.query(
    `SELECT * FROM projection_rebuild_receipts WHERE owner_scope_id=$1 AND transaction_id=$2 AND trigger=$3
     ORDER BY created_at,id`, [input.ownerScopeId, input.transactionId, trigger])).rows.map(toReceipt);
  if (recorded.length >= PROJECTION_NAMES.length) return recorded;

  const affected = [...new Set(input.frameInstanceIds)].sort();
  const receipts: ProjectionRebuildReceipt[] = [];
  for (const projectionName of PROJECTION_NAMES) {
    const existing = recorded.find(receipt => receipt.projectionName === projectionName);
    if (existing) { receipts.push(existing); continue; }
    const applied = await applyProjectionDelta(tx, { ownerScopeId: input.ownerScopeId, projectionName, asOf: input.asOf });
    const retired = await pruneRows(tx, input.ownerScopeId, projectionName, null);
    receipts.push(await replayProjection(tx, {
      ownerScopeId: input.ownerScopeId, projectionName, asOf: input.asOf, trigger,
      transactionId: input.transactionId, compareWithStored: true,
      detail: { affectedFrameInstanceIds: affected.slice(0, 64), incrementalRowsWritten: applied.rowsWritten,
        retiredRowsRemoved: retired },
    }));
  }
  return receipts;
}

export async function listRebuildReceipts(tx: MemoryTransaction, input: {
  ownerScopeId: string; projectionName?: ProjectionName; limit?: number;
}): Promise<ProjectionRebuildReceipt[]> {
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);
  const rows = (await tx.query(
    `SELECT * FROM projection_rebuild_receipts WHERE owner_scope_id=$1
      AND ($2::text IS NULL OR projection_name=$2) ORDER BY created_at DESC,id DESC LIMIT $3`,
    [input.ownerScopeId, input.projectionName ? projectionNameSchema.parse(input.projectionName) : null, limit])).rows;
  return rows.map(toReceipt);
}

// ---------------------------------------------------------------------------
// The reads behind GET /v1/projections/*
// ---------------------------------------------------------------------------

export interface ProjectionReadFilters {
  readonly ownerScopeId: string;
  /** The instant the read speaks about. `overdue` and `due_soon` are read against
   * it, so a caller replaying a fixture pins it rather than inheriting the clock. */
  readonly asOf: Date;
  readonly personEntityId?: string | null;
  readonly dueBefore?: Date | null;
  readonly dueAfter?: Date | null;
  readonly includeResolved?: boolean;
  readonly limit?: number;
}

function hidden(row: AnyRow): boolean {
  return (row.sourceManifest as Record<string, unknown>)['ownerSuppressed'] === true;
}

/**
 * Fold the owner's later writes over a persisted row, in memory.
 *
 * A read is a read: it writes no projection row, and it holds no purpose that
 * could. What it does instead is exactly what the Commitments and Obligations
 * screens promise -- the owner's correction from another device shows in *this*
 * answer, marked as the owner's own pending assertion rather than as canonical
 * memory, and a write the reducer cannot fold in comes back beside the persisted
 * state with `isComplete` false (CRT-RYW-02-A, CRT-RYW-04-A).
 */
function foldOverRow(row: AnyRow, projection: ProjectionName, deltas: readonly OwnerDelta[]): {
  row: AnyRow; pending: readonly PendingAssertion[]; suppressed: boolean;
} {
  const currency = projection === 'obligations_projection' ? (row as ObligationProjectionRow).currency : null;
  const fold = foldOwnerDeltas(deltas, projection, currency);
  const pending = [...row.pendingAssertions, ...fold.pending]
    .filter((assertion, index, all) => all.findIndex(other => other.overlayDeltaId === assertion.overlayDeltaId) === index);
  const isComplete = pending.length === 0;

  if (projection === 'obligations_projection' && fold.principal !== null) {
    const obligation = row as ObligationProjectionRow;
    const total = money(obligation.totalCanonicalAllocation, fold.principal.currency);
    return {
      row: obligationProjectionRowSchema.parse({
        ...obligation,
        principalAmount: fold.principal.amount,
        currency: fold.principal.currency,
        // Recomputed, never read back from the stored column: the owner's amount
        // is a different principal and the remainder follows from it.
        remainingAmountCapabilityDerived: subtractMoneyAmount(fold.principal.amount, total),
        isComplete, overlayComplete: fold.pending.length === 0, pendingAssertions: pending,
      }),
      pending, suppressed: fold.suppressed,
    };
  }
  if (projection === 'open_commitments_projection' && fold.outcomeOverride !== null) {
    const commitment = row as CommitmentProjectionRow;
    // An owner statement of completion moves an unresolved commitment and leaves
    // an already-resolved or contested one exactly where the accepted resolution
    // assertions put it: the overlay never overrides a governed outcome.
    const outcomeState = commitment.outcomeState === 'UNRESOLVED' ? fold.outcomeOverride : commitment.outcomeState;
    const unresolved = outcomeState === 'PARTIALLY_RESOLVED';
    return {
      row: commitmentProjectionRowSchema.parse({
        ...commitment, outcomeState,
        overdue: commitment.overdue && unresolved,
        dueSoon: commitment.dueSoon && unresolved,
        sourceStrength: 'PENDING_OWNER_ASSERTION',
        isComplete, overlayComplete: fold.pending.length === 0, pendingAssertions: pending,
      }),
      pending, suppressed: fold.suppressed,
    };
  }
  if (pending.length === row.pendingAssertions.length && !fold.suppressed) {
    return { row, pending, suppressed: false };
  }
  return {
    row: { ...row, isComplete, overlayComplete: fold.pending.length === 0, pendingAssertions: pending } as AnyRow,
    pending, suppressed: fold.suppressed,
  };
}

/** The difference of two exact amounts in one currency, as the amount string the
 * column holds. */
function subtractMoneyAmount(principal: string, allocated: Money): string {
  return subtractMoney(money(principal, allocated.currency), allocated).amount;
}

async function readView(tx: MemoryTransaction, projection: ProjectionName, filters: ProjectionReadFilters): Promise<{
  rows: AnyRow[]; pending: PendingAssertion[]; watermarks: CanonicalWatermarks; unattached: PendingAssertion[];
}> {
  const overlay = await buildOverlayContext(tx, filters.ownerScopeId);
  const stored = await readProjectionRows(tx, { ownerScopeId: filters.ownerScopeId, projectionName: projection });
  const folded = stored.map(row => foldOverRow(row, projection,
    overlay.deltasByFrame.get(frameIdOf(row, projection)) ?? []));
  const visible = folded.filter(entry => !entry.suppressed && !hidden(entry.row));
  // The canonical watermark is the furthest any row in this projection read, and
  // `epoch` when there is no row: it is what the reducer recorded, not a number
  // the read invented (PRD §33.12).
  const canonicalTransactionWatermark = stored
    .map(row => new Date(row.canonicalTransactionWatermark))
    .reduce((latest, time) => time.getTime() > latest.getTime() ? time : latest, new Date(0));
  return {
    rows: visible.map(entry => entry.row),
    pending: visible.flatMap(entry => [...entry.pending]),
    unattached: [...overlay.unattached],
    watermarks: {
      canonicalTransactionWatermark,
      // The overlay's own high-water mark, which may be ahead of every row: that
      // gap is exactly what an incomplete read is telling the caller about.
      ownerOverlayWatermark: Math.max(overlay.ownerOverlayWatermark,
        ...stored.map(row => row.ownerOverlayWatermark), 0),
    },
  };
}

function frameIdOf(row: AnyRow, projection: ProjectionName): string {
  return projection === 'open_commitments_projection' ? (row as CommitmentProjectionRow).commitmentFrameInstanceId
    : projection === 'obligations_projection' ? (row as ObligationProjectionRow).obligationFrameInstanceId
      : (row as ScheduleProjectionRow).scheduledFrameInstanceId;
}

/** A read is safe to authorize a high-risk action from only when nothing is
 * pending and nothing is contested. This is the flag `EvaluateMemoryAction`
 * consumes as `projectionComplete` (PRD §29.3, CRT-RYW-04-A). */
function blocksHighRisk(rows: readonly AnyRow[], pending: readonly PendingAssertion[]): boolean {
  return pending.length > 0 || rows.some(row => !row.isComplete)
    || rows.some(row => 'conflictFlag' in row && row.conflictFlag === true);
}

export async function readCommitmentsProjection(tx: MemoryTransaction, filters: ProjectionReadFilters): Promise<CommitmentsProjectionView> {
  const { rows, pending, watermarks, unattached } = await readView(tx, 'open_commitments_projection', filters);
  const limit = Math.min(Math.max(filters.limit ?? 200, 1), 500);
  const selected = (rows as CommitmentProjectionRow[]).filter(row => {
    if (filters.includeResolved !== true && (row.outcomeState === 'RESOLVED')) return false;
    if (filters.personEntityId && row.promiseeEntityId !== filters.personEntityId && row.promisorEntityId !== filters.personEntityId) return false;
    if (filters.dueBefore && (row.dueTime === null || new Date(row.dueTime).getTime() > filters.dueBefore.getTime())) return false;
    if (filters.dueAfter && (row.dueTime === null || new Date(row.dueTime).getTime() < filters.dueAfter.getTime())) return false;
    return true;
  }).slice(0, limit);
  const allPending = [...unattached, ...pending];
  return commitmentsProjectionViewSchema.parse({
    projectionName: 'open_commitments_projection', rows: selected,
    isComplete: allPending.length === 0 && rows.every(row => row.isComplete),
    ownerOverlayWatermark: watermarks.ownerOverlayWatermark,
    canonicalTransactionWatermark: watermarks.canonicalTransactionWatermark.toISOString(),
    projectionVersion: rows[0]?.projectionVersion ?? null,
    reducerVersion: REDUCER_VERSION,
    pendingAssertions: allPending,
    highRiskActionsBlocked: blocksHighRisk(rows, allPending),
    readAt: filters.asOf.toISOString(),
  });
}

export async function readObligationsProjection(tx: MemoryTransaction, filters: ProjectionReadFilters): Promise<ObligationsProjectionView> {
  const { rows, pending, watermarks, unattached } = await readView(tx, 'obligations_projection', filters);
  const limit = Math.min(Math.max(filters.limit ?? 200, 1), 500);
  const selected = (rows as ObligationProjectionRow[]).filter(row => {
    if (filters.includeResolved !== true && row.outcomeState === 'RESOLVED') return false;
    if (filters.personEntityId && row.creditorEntityId !== filters.personEntityId && row.debtorEntityId !== filters.personEntityId) return false;
    if (filters.dueBefore && (row.dueTime === null || new Date(row.dueTime).getTime() > filters.dueBefore.getTime())) return false;
    if (filters.dueAfter && (row.dueTime === null || new Date(row.dueTime).getTime() < filters.dueAfter.getTime())) return false;
    return true;
  }).slice(0, limit);
  const allPending = [...unattached, ...pending];
  return obligationsProjectionViewSchema.parse({
    projectionName: 'obligations_projection', rows: selected,
    isComplete: allPending.length === 0 && rows.every(row => row.isComplete),
    ownerOverlayWatermark: watermarks.ownerOverlayWatermark,
    canonicalTransactionWatermark: watermarks.canonicalTransactionWatermark.toISOString(),
    projectionVersion: rows[0]?.projectionVersion ?? null,
    reducerVersion: REDUCER_VERSION,
    pendingAssertions: allPending,
    highRiskActionsBlocked: blocksHighRisk(rows, allPending),
    readAt: filters.asOf.toISOString(),
  });
}

export async function readScheduleProjection(tx: MemoryTransaction, filters: ProjectionReadFilters): Promise<ScheduleProjectionView> {
  const { rows, pending, watermarks, unattached } = await readView(tx, 'schedule_projection', filters);
  const limit = Math.min(Math.max(filters.limit ?? 200, 1), 500);
  const selected = (rows as ScheduleProjectionRow[]).filter(row => {
    if (filters.dueBefore && (row.startTime === null || new Date(row.startTime).getTime() > filters.dueBefore.getTime())) return false;
    if (filters.dueAfter && (row.startTime === null || new Date(row.startTime).getTime() < filters.dueAfter.getTime())) return false;
    if (filters.personEntityId && !row.participants.includes(filters.personEntityId)) return false;
    return true;
  }).slice(0, limit);
  const allPending = [...unattached, ...pending];
  return scheduleProjectionViewSchema.parse({
    projectionName: 'schedule_projection', rows: selected,
    isComplete: allPending.length === 0 && rows.every(row => row.isComplete),
    ownerOverlayWatermark: watermarks.ownerOverlayWatermark,
    canonicalTransactionWatermark: watermarks.canonicalTransactionWatermark.toISOString(),
    projectionVersion: rows[0]?.projectionVersion ?? null,
    reducerVersion: REDUCER_VERSION,
    pendingAssertions: allPending,
    highRiskActionsBlocked: blocksHighRisk(rows, allPending),
    readAt: filters.asOf.toISOString(),
  });
}

/** The Projection health screen: where each projection stands and what the last
 * rebuilds found (design screen "Projection health", GET /v1/ops/projections). */
export async function readProjectionHealth(tx: MemoryTransaction, input: {
  ownerScopeId: string; readAt: Date;
}): Promise<ProjectionHealth> {
  const projections = [];
  for (const projectionName of ['open_commitments_projection', 'obligations_projection', 'schedule_projection'] as const) {
    const rows = await readProjectionRows(tx, { ownerScopeId: input.ownerScopeId, projectionName });
    const incomplete = rows.filter(row => !row.isComplete);
    projections.push({
      projectionName,
      reducerVersion: REDUCER_VERSION,
      projectionVersion: rows[0]?.projectionVersion ?? null,
      canonicalTransactionWatermark: rows[0]?.canonicalTransactionWatermark ?? null,
      ownerOverlayWatermark: rows[0]?.ownerOverlayWatermark ?? null,
      rowCount: rows.length,
      incompleteRowCount: incomplete.length,
      pendingAssertions: incomplete.flatMap(row => [...row.pendingAssertions]).slice(0, 200),
    });
  }
  return projectionHealthSchema.parse({
    projections,
    receipts: await listRebuildReceipts(tx, { ownerScopeId: input.ownerScopeId, limit: 20 }),
    readAt: input.readAt.toISOString(),
  });
}

export { moneyKey };
