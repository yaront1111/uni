/** `@unai/capabilities` -- the commitment, obligation and schedule capabilities
 * and the typed projections they maintain.
 *
 * This package exists because of one rule: **the Memory Kernel performs no
 * financial arithmetic** (PRD §16.7, §26.4, invariant; CRT-OUT-06-A). Every sum,
 * difference and comparison over allocation amounts lives in `money.ts` here, and
 * `src/architecture.test.ts` fails if arithmetic over a money value appears in
 * `@unai/memory` or `src/kernel`. The kernel stores the canonical allocation
 * amount; this package recomputes what it adds up to, from those frames, every
 * time it is asked.
 *
 * A capability may read canonical memory, build a projection over it and propose
 * a belief transaction. It may not mutate an accepted belief (PRD §25.2), and the
 * database enforces that rather than this comment: the reducer's purpose
 * `memory.project` is admitted by no INSERT, UPDATE or DELETE policy on any
 * canonical table.
 *
 * Every function takes a transaction the caller opened inside the owner boundary,
 * exactly as `@unai/memory` and `@unai/belief` do. Nothing here opens a
 * connection, commits, audits, calls a model or reaches the network.
 */
export { MONEY_VERSION, MoneyError, toUnits, fromUnits, money, readMoney, sumMoney, subtractMoney, compareMoney,
  sameMoney, moneyKey } from './money.js';
export { readWatermarks, listFrameInstances, readSlotValues, selectSlotValue, readRoles, roleEntity, roleValue,
  readResolutions, readRealizations, readOwnerDeltas, pendingAssertion, isSettledDelta, latestTime,
  type CanonicalWatermarks, type FrameRow, type SlotValue, type RoleFill, type ResolutionRow, type RealizationRow,
  type OwnerDelta } from './canonical.js';
export { readTimeValue, dueInstant, readText, readReference, readEntityReference, readFrameReference,
  type TimeValue } from './values.js';
export { COMMITMENT_CAPABILITY_VERSION, COMMITMENT_CLASSIFIER_VERSION, COMMITMENT_FRAME_TYPE,
  COMMITMENT_RESOLUTION_CONTRACT, classifyCommitmentLanguage, canonicalizeCommitmentStatement,
  recordCommitmentCompletion,
  type CommitmentStatementRequest, type CanonicalizedCommitment, type CommitmentCompletionRequest } from './commitments.js';
export { OBLIGATION_CAPABILITY_VERSION, OBLIGATION_FRAME_TYPE, ALLOCATION_FRAME_TYPE, PRINCIPAL_PREDICATE,
  DUE_TIME_PREDICATE, ALLOCATED_AMOUNT_PREDICATE, amountConflict, readAllocations, computeObligationArithmetic,
  readObligationState, calculateObligation,
  type AllocationReading, type ObligationCanonicalState, type ObligationArithmetic,
  type ObligationCalculationRequest } from './obligations.js';
export { SCHEDULE_CAPABILITY_VERSION, SCHEDULE_FRAME_TYPE, OCCURRENCE_TIME_PREDICATE, PARTICIPANTS_PREDICATE,
  OCCURRENCE_REFERENCE_PREDICATE, readScheduleState, listScheduledFrameInstanceIds, acceptedResolutionId,
  type ScheduleCanonicalState } from './schedule.js';
export { REDUCER_VERSION, PROJECTION_PURPOSE, PROJECTION_READ_PURPOSE, ProjectionError, parseMoneyText,
  applyProjectionDelta, replayProjection, recordRebuildReceipt, listRebuildReceipts, readProjectionRows,
  projectionRowContent, readCommitmentsProjection, readObligationsProjection, readScheduleProjection,
  readProjectionHealth,
  type ApplyProjectionInput, type ReplayProjectionInput, type ProjectionReadFilters } from './projections.js';
export { runProjectionReplay, type ProjectionReplayRequest, type ProjectionReplayResult } from './replay.js';
