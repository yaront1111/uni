import {
  amountConflictSchema, obligationCalculationSchema,
  type AmountConflict, type Money, type ObligationCalculation, type PendingAssertion,
} from '@unai/domain';
import { resolveFrameInstanceSurvivors, type MemoryTransaction } from '@unai/memory';
import {
  listFrameInstances, readResolutions, readRoles, readSlotValues, roleValue, selectSlotValue,
  type SlotValue,
} from './canonical.js';
import { moneyKey, readMoney, sameMoney, subtractMoney, sumMoney } from './money.js';
import { readFrameReference } from './values.js';

/**
 * The obligations capability: allocation arithmetic and conflict reporting
 * (PRD §16.7, §26.4, §44.1, §44.11; CRT-OUT-06-A, CRT-MEM-08-A).
 *
 * Three rules, each of which is a rule about what *not* to do:
 *
 *  1. **Remaining amount is recomputed, never remembered.** Every number this
 *     module returns is derived, here and now, from the canonical principal
 *     proposition and the canonical `finance.payment_allocation` frames. Nothing
 *     reads a previously stored total, so a stored total that is wrong changes no
 *     answer.
 *  2. **`advisory_coverage` is never an input.** It is read, carried out in
 *     `advisoryCoverageIgnored` so a surface can show it labelled as advisory,
 *     and used in no expression. Setting it to a wrong value moves nothing
 *     (CRT-OUT-06-A).
 *  3. **A conflict is reported, not resolved.** When one slot holds two
 *     different amounts, both are kept, the calculation says so, and a HIGH-risk
 *     calculation over that slot is refused outright rather than answered from
 *     the value that happens to sort first (CRT-MEM-08-A).
 *
 * The surplus of an overpayment stays unclassified. "He paid me ILS 60 against an
 * ILS 50 debt" allocates ILS 50 and leaves ILS 10 whose purpose nobody has
 * stated; the capability reports the ILS 10 as an unclassified remainder and
 * invents no reason for it (PRD §26.4, §44.1).
 */

export const OBLIGATION_CAPABILITY_VERSION = 'capability-obligations-0.1.0';
export const OBLIGATION_FRAME_TYPE = 'shared.obligation';
export const ALLOCATION_FRAME_TYPE = 'finance.payment_allocation';
export const PRINCIPAL_PREDICATE = 'shared.obligation.principal_amount';
export const DUE_TIME_PREDICATE = 'shared.obligation.due_time';
export const ALLOCATED_AMOUNT_PREDICATE = 'finance.payment_allocation.allocated_amount';

/** One payment allocation as the capability needs it. */
export interface AllocationReading {
  readonly allocationFrameInstanceId: string;
  readonly obligationFrameInstanceId: string | null;
  readonly allocated: Money | null;
  /** The payment the allocation came out of, when the connector recorded its
   * total. Null keeps the remainder unknown rather than assuming the payment was
   * exactly the allocation. */
  readonly paymentReference: string | null;
  readonly paymentTotal: Money | null;
  readonly conflict: AmountConflict | null;
}

/** Every proposition that disagrees with another in the same slot, kept whole.
 *
 * Returns null when the slot holds one value, or several spellings of one value:
 * `50` and `50.00` are the same amount, and calling that a conflict would put a
 * warning in front of the owner about nothing. */
export function amountConflict(values: readonly SlotValue[]): AmountConflict | null {
  const priced = values
    .map(value => ({ value, money: readMoney(value.normalizedValue) }))
    .filter((entry): entry is { value: SlotValue; money: Money } => entry.money !== null);
  const distinct = new Set(priced.map(entry => moneyKey(entry.money)));
  if (distinct.size < 2) return null;
  const first = priced[0]!;
  return amountConflictSchema.parse({
    beliefSlotId: first.value.beliefSlotId,
    predicateId: first.value.predicateId,
    propositions: priced.map(entry => ({
      propositionId: entry.value.propositionId,
      amount: entry.money.amount,
      currency: entry.money.currency,
      claimIds: [...entry.value.claimIds],
      claimOrigins: [...entry.value.claimOrigins],
    })),
  });
}

/**
 * Every canonical allocation applied to the named obligations.
 *
 * The allocation frame is canonical and its amount is the canonical record (PRD
 * §26.4). This reads them; it does not create them, and a payment transaction on
 * its own creates none -- an allocation is a governed write the owner or a
 * deterministic connector reconciliation made.
 */
export async function readAllocations(tx: MemoryTransaction, input: {
  ownerScopeId: string; obligationFrameInstanceIds: readonly string[];
}): Promise<AllocationReading[]> {
  const frames = await listFrameInstances(tx, { ownerScopeId: input.ownerScopeId, frameTypeId: ALLOCATION_FRAME_TYPE });
  if (frames.length === 0) return [];
  const ids = frames.map(frame => frame.frameInstanceId);
  const roles = await readRoles(tx, { ownerScopeId: input.ownerScopeId, frameInstanceIds: ids });
  const amounts = await readSlotValues(tx, {
    ownerScopeId: input.ownerScopeId, frameInstanceIds: ids,
    predicateId: ALLOCATED_AMOUNT_PREDICATE, modality: 'ACTUAL',
  });
  const wanted = new Set(input.obligationFrameInstanceIds);
  // An allocation recorded against an obligation that was later merged applies to
  // the survivor; one against a split obligation applies to neither half until
  // the owner says which (ADR 0025 §3).
  const survivors = await resolveFrameInstanceSurvivors(tx, { ownerScopeId: input.ownerScopeId,
    frameInstanceIds: frames.map(frame => readFrameReference(roleValue(roles, frame.frameInstanceId, 'obligation')))
      .filter((id): id is string => id !== null) });

  const readings: AllocationReading[] = [];
  for (const frame of frames) {
    const referenced = readFrameReference(roleValue(roles, frame.frameInstanceId, 'obligation'));
    const obligation = referenced === null ? null : survivors.get(referenced) ?? referenced;
    if (obligation === null || !wanted.has(obligation)) continue;
    const values = amounts.filter(value => value.frameInstanceId === frame.frameInstanceId);
    const payment = roleValue(roles, frame.frameInstanceId, 'payment_transaction');
    const paymentRecord = typeof payment === 'object' && payment !== null ? payment as Record<string, unknown> : {};
    readings.push(Object.freeze({
      allocationFrameInstanceId: frame.frameInstanceId,
      obligationFrameInstanceId: obligation,
      allocated: readMoney(selectSlotValue(values)?.normalizedValue),
      paymentReference: typeof paymentRecord['externalId'] === 'string' ? paymentRecord['externalId']
        : typeof paymentRecord['reference'] === 'string' ? paymentRecord['reference'] : null,
      paymentTotal: readMoney(paymentRecord['total'] ?? paymentRecord['paymentTotal'] ?? null),
      conflict: amountConflict(values),
    }));
  }
  return readings;
}

/** What the capability found in canonical memory about one obligation, before
 * any owner overlay is folded in. */
export interface ObligationCanonicalState {
  readonly obligationFrameInstanceId: string;
  readonly principalValues: readonly SlotValue[];
  readonly principal: Money | null;
  readonly principalConflict: AmountConflict | null;
  readonly dueTimeValues: readonly SlotValue[];
  readonly allocations: readonly AllocationReading[];
  readonly advisoryCoverage: readonly number[];
}

export interface ObligationArithmetic {
  readonly totalCanonicalAllocation: Money;
  readonly remainingAmount: Money | null;
  readonly unclassifiedRemainder: Money | null;
  /** Allocations in a currency the principal is not stated in. They are neither
   * summed nor converted; they are reported. */
  readonly currencyMismatchAllocationIds: readonly string[];
}

/**
 * The arithmetic, over values a caller already read.
 *
 * Pure and synchronous on purpose: this is the whole of the financial
 * computation, it touches no database, and it can be run over a hand-built state
 * in a unit test to show that the numbers come from the allocations and from
 * nothing else.
 *
 * When the principal's currency is unknown the total is stated in the currency
 * the allocations agree on, because "ILS 50 has been allocated" is still true and
 * useful when nobody has said what the debt was.
 */
export function computeObligationArithmetic(state: ObligationCanonicalState): ObligationArithmetic {
  const allocated = state.allocations.map(allocation => allocation.allocated)
    .filter((value): value is Money => value !== null);
  const currency = state.principal?.currency
    ?? allocated[0]?.currency
    ?? 'XXX'; // ISO 4217 "no currency": a zero total nobody can misread as money.
  const matching = allocated.filter(value => value.currency === currency);
  const mismatched = state.allocations.filter(allocation =>
    allocation.allocated !== null && allocation.allocated.currency !== currency);
  const totalCanonicalAllocation = sumMoney(matching, currency);
  const remainingAmount = state.principal === null ? null
    : subtractMoney(state.principal, totalCanonicalAllocation);

  // The surplus of each payment over what was allocated from it, and null when
  // no payment total was recorded: an unstated surplus is unknown, not zero.
  let remainderUnits: Money | null = null;
  const byPayment = new Map<string, { total: Money; allocated: Money[] }>();
  for (const allocation of state.allocations) {
    if (allocation.paymentTotal === null || allocation.allocated === null) continue;
    if (allocation.paymentTotal.currency !== allocation.allocated.currency) continue;
    const key = allocation.paymentReference ?? allocation.allocationFrameInstanceId;
    const entry = byPayment.get(key) ?? { total: allocation.paymentTotal, allocated: [] };
    entry.allocated.push(allocation.allocated);
    byPayment.set(key, entry);
  }
  for (const [, entry] of [...byPayment.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
    const surplus = subtractMoney(entry.total, sumMoney(entry.allocated, entry.total.currency));
    if (surplus.amount.startsWith('-')) continue; // Allocated more than the payment: a conflict, not a remainder.
    remainderUnits = remainderUnits === null ? surplus : sumMoney([remainderUnits, surplus], surplus.currency);
  }

  return Object.freeze({
    totalCanonicalAllocation,
    remainingAmount,
    unclassifiedRemainder: remainderUnits,
    currencyMismatchAllocationIds: Object.freeze(mismatched.map(allocation => allocation.allocationFrameInstanceId)),
  });
}

/** Read the canonical state of one obligation. */
export async function readObligationState(tx: MemoryTransaction, input: {
  ownerScopeId: string; obligationFrameInstanceId: string;
}): Promise<ObligationCanonicalState> {
  const frameInstanceIds = [input.obligationFrameInstanceId];
  const principalValues = await readSlotValues(tx, {
    ownerScopeId: input.ownerScopeId, frameInstanceIds, predicateId: PRINCIPAL_PREDICATE, modality: 'ACTUAL',
  });
  const dueTimeValues = await readSlotValues(tx, {
    ownerScopeId: input.ownerScopeId, frameInstanceIds, predicateId: DUE_TIME_PREDICATE, modality: 'ACTUAL',
  });
  const allocations = await readAllocations(tx, {
    ownerScopeId: input.ownerScopeId, obligationFrameInstanceIds: frameInstanceIds,
  });
  const resolutions = await readResolutions(tx, { ownerScopeId: input.ownerScopeId, frameInstanceIds });
  return Object.freeze({
    obligationFrameInstanceId: input.obligationFrameInstanceId,
    principalValues,
    principal: readMoney(selectSlotValue(principalValues)?.normalizedValue),
    principalConflict: amountConflict(principalValues),
    dueTimeValues,
    allocations,
    // Read so it can be displayed as advisory. It appears in no expression above.
    advisoryCoverage: Object.freeze(resolutions
      .map(resolution => resolution.advisoryCoverage)
      .filter((coverage): coverage is number => coverage !== null)),
  });
}

export interface ObligationCalculationRequest {
  readonly ownerScopeId: string;
  readonly obligationFrameInstanceId: string;
  readonly risk?: 'LOW' | 'MEDIUM' | 'HIGH';
  /** Owner writes the projection could not fold in. A HIGH-risk calculation over
   * an incomplete state is refused for the same reason a conflicting one is. */
  readonly pendingAssertions?: readonly PendingAssertion[];
  /** An overlay correction the reducer *could* apply, already read. It moves the
   * principal the calculation works from and is reported as the owner's own
   * pending assertion rather than as canonical memory. */
  readonly pendingPrincipal?: Money | null;
}

/**
 * The capability's answer about one obligation, at a declared risk.
 *
 * A HIGH-risk calculation is the one the PRD singles out (FR-016, §44.11): it is
 * the calculation that would authorize moving money, so it must not be answered
 * from a slot whose value is disputed or from a projection that is missing an
 * owner write. Those two cases come back `blocked` with the conflict attached.
 * A LOW or MEDIUM calculation answers, and still reports the conflict.
 */
export async function calculateObligation(
  tx: MemoryTransaction, request: ObligationCalculationRequest,
): Promise<ObligationCalculation> {
  const risk = request.risk ?? 'LOW';
  const state = await readObligationState(tx, request);
  const pending = [...(request.pendingAssertions ?? [])];
  const effective: ObligationCanonicalState = request.pendingPrincipal
    ? Object.freeze({ ...state, principal: request.pendingPrincipal })
    : state;
  const arithmetic = computeObligationArithmetic(effective);
  const conflicts = [
    ...(state.principalConflict ? [state.principalConflict] : []),
    ...state.allocations.map(allocation => allocation.conflict).filter((conflict): conflict is AmountConflict => conflict !== null),
  ];
  const isComplete = pending.length === 0;
  const blockedReason = risk !== 'HIGH' ? null
    : conflicts.length > 0 ? 'HIGH_RISK_CALCULATION_OVER_CONFLICTING_SLOT'
      : !isComplete ? 'HIGH_RISK_CALCULATION_OVER_INCOMPLETE_PROJECTION'
        : arithmetic.currencyMismatchAllocationIds.length > 0 ? 'HIGH_RISK_CALCULATION_ACROSS_CURRENCIES'
          : null;

  return obligationCalculationSchema.parse({
    obligationFrameInstanceId: request.obligationFrameInstanceId,
    risk,
    principalAmount: effective.principal?.amount ?? null,
    currency: effective.principal?.currency ?? null,
    totalCanonicalAllocation: arithmetic.totalCanonicalAllocation.amount,
    remainingAmount: arithmetic.remainingAmount?.amount ?? null,
    unclassifiedRemainder: arithmetic.unclassifiedRemainder?.amount ?? null,
    allocationFrameInstanceIds: state.allocations.map(allocation => allocation.allocationFrameInstanceId),
    conflicts,
    advisoryCoverageIgnored: [...state.advisoryCoverage],
    blocked: blockedReason !== null,
    blockedReason,
    isComplete,
    pendingAssertions: pending,
    capabilityVersion: OBLIGATION_CAPABILITY_VERSION,
  });
}

/** True when two money values state the same amount. Re-exported so a caller
 * comparing a stored projection value with a freshly computed one uses the same
 * equality the capability does. */
export { sameMoney };
