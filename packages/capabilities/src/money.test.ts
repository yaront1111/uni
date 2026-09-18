import { describe, expect, it } from 'vitest';
import { compareMoney, fromUnits, money, moneyKey, readMoney, sameMoney, subtractMoney, sumMoney, toUnits, MoneyError } from './money.js';
import { computeObligationArithmetic, amountConflict } from './obligations.js';
import type { SlotValue } from './canonical.js';

/** The arithmetic the Memory Kernel must not contain (CRT-OUT-06-A), tested
 * where it lives. No database: every rule below is a property of the numbers. */

describe('exact money arithmetic', () => {
  it('adds and subtracts without floating-point drift', () => {
    // The canonical counter-example. `0.1 + 0.2 !== 0.3` as doubles.
    expect(sumMoney([money('0.1', 'ILS'), money('0.2', 'ILS')], 'ILS').amount).toBe('0.3');
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(subtractMoney(money('50.00', 'ILS'), money('49.99', 'ILS')).amount).toBe('0.01');
    expect(sumMoney([money('19.99', 'ILS'), money('0.01', 'ILS')], 'ILS').amount).toBe('20');
    // Large values stay exact past the double's integer range.
    expect(sumMoney([money('9007199254740993', 'ILS'), money('1', 'ILS')], 'ILS').amount).toBe('9007199254740994');
  });
  it('treats 50 and 50.00 as one amount and 50 and 60 as two', () => {
    expect(sameMoney(money('50', 'ILS'), money('50.00', 'ILS'))).toBe(true);
    expect(moneyKey(money('50', 'ILS'))).toBe(moneyKey(money('50.000', 'ILS')));
    expect(sameMoney(money('50', 'ILS'), money('60', 'ILS'))).toBe(false);
    expect(compareMoney(money('50', 'ILS'), money('60', 'ILS'))).toBe(-1);
  });
  it('refuses to convert between currencies rather than inventing a rate', () => {
    expect(() => sumMoney([money('50', 'ILS'), money('50', 'USD')], 'ILS')).toThrow(MoneyError);
    expect(() => subtractMoney(money('50', 'ILS'), money('1', 'USD'))).toThrow('MONEY_CURRENCY_MISMATCH');
    expect(() => compareMoney(money('50', 'ILS'), money('50', 'USD'))).toThrow('MONEY_CURRENCY_MISMATCH');
  });
  it('round-trips through scaled units and refuses precision it cannot hold', () => {
    const canonical: Record<string, string> = { '0': '0', '1': '1', '50.00': '50', '0.000001': '0.000001',
      '123456789.123456': '123456789.123456', '-7.5': '-7.5' };
    for (const [amount, shortest] of Object.entries(canonical)) {
      expect(fromUnits(toUnits(amount)), amount).toBe(shortest);
      expect(toUnits(fromUnits(toUnits(amount))), amount).toBe(toUnits(amount));
    }
    // Refused, not truncated: dropping a digit of somebody's money silently is
    // the one outcome this module exists to make impossible.
    expect(() => toUnits('1.1234567')).toThrow('MONEY_AMOUNT_INVALID');
    expect(() => toUnits('1e3')).toThrow('MONEY_AMOUNT_INVALID');
    expect(() => toUnits('50 ILS')).toThrow('MONEY_AMOUNT_INVALID');
  });
  it('reads a stored value only when it is really a money value', () => {
    expect(readMoney({ amount: '50.00', currency: 'ILS' })).toEqual({ amount: '50.00', currency: 'ILS' });
    expect(readMoney({ amount: 50, currency: 'ILS' })).toEqual({ amount: '50', currency: 'ILS' });
    expect(readMoney({ amount: '50.00', currency: 'shekels' })).toBeNull();
    expect(readMoney({ text: 'fifty shekels' })).toBeNull();
    expect(readMoney(null)).toBeNull();
    expect(readMoney('50')).toBeNull();
  });
});

/** A hand-built canonical state, so the arithmetic can be shown to come from the
 * allocation frames and from nothing else. */
function slotValue(overrides: Partial<SlotValue> & { propositionId: string; normalizedValue: unknown }): SlotValue {
  return {
    frameInstanceId: '00000000-0000-7000-8000-000000000001',
    beliefSlotId: '00000000-0000-7000-8000-0000000000a1',
    predicateId: 'shared.obligation.principal_amount',
    claimIds: ['00000000-0000-7000-8000-0000000000c1'],
    claimOrigins: ['USER_STATEMENT'],
    latestClaimAt: new Date('2026-01-01T00:00:00.000Z'),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('obligation arithmetic', () => {
  const base = {
    obligationFrameInstanceId: '00000000-0000-7000-8000-000000000001',
    principalValues: [], principalConflict: null, dueTimeValues: [], advisoryCoverage: [],
  } as const;

  it('derives the remaining amount from the allocations alone (PRD §44.1)', () => {
    const result = computeObligationArithmetic({
      ...base, principal: money('50.00', 'ILS'),
      allocations: [{
        allocationFrameInstanceId: '00000000-0000-7000-8000-000000000002',
        obligationFrameInstanceId: base.obligationFrameInstanceId,
        allocated: money('50.00', 'ILS'), paymentReference: 'bank:tx-1',
        paymentTotal: money('60.00', 'ILS'), conflict: null,
      }],
    });
    expect(result.totalCanonicalAllocation.amount).toBe('50');
    expect(result.remainingAmount?.amount).toBe('0');
    // The ILS 10 surplus stays unclassified; nothing invents a purpose for it.
    expect(result.unclassifiedRemainder?.amount).toBe('10');
  });

  it('leaves the surplus unknown when no payment total was recorded', () => {
    const result = computeObligationArithmetic({
      ...base, principal: money('50.00', 'ILS'),
      allocations: [{
        allocationFrameInstanceId: '00000000-0000-7000-8000-000000000002',
        obligationFrameInstanceId: base.obligationFrameInstanceId,
        allocated: money('20.00', 'ILS'), paymentReference: null, paymentTotal: null, conflict: null,
      }],
    });
    expect(result.remainingAmount?.amount).toBe('30');
    expect(result.unclassifiedRemainder).toBeNull();
  });

  it('never sums across currencies and reports the allocation it refused', () => {
    const result = computeObligationArithmetic({
      ...base, principal: money('50.00', 'ILS'),
      allocations: [
        { allocationFrameInstanceId: '00000000-0000-7000-8000-000000000002',
          obligationFrameInstanceId: base.obligationFrameInstanceId,
          allocated: money('20.00', 'ILS'), paymentReference: null, paymentTotal: null, conflict: null },
        { allocationFrameInstanceId: '00000000-0000-7000-8000-000000000003',
          obligationFrameInstanceId: base.obligationFrameInstanceId,
          allocated: money('20.00', 'USD'), paymentReference: null, paymentTotal: null, conflict: null },
      ],
    });
    expect(result.totalCanonicalAllocation.amount).toBe('20');
    expect(result.remainingAmount?.amount).toBe('30');
    expect(result.currencyMismatchAllocationIds).toEqual(['00000000-0000-7000-8000-000000000003']);
  });

  it('answers a zero total in XXX when nothing states a currency', () => {
    const result = computeObligationArithmetic({ ...base, principal: null, allocations: [] });
    expect(result.totalCanonicalAllocation).toEqual({ amount: '0', currency: 'XXX' });
    expect(result.remainingAmount).toBeNull();
  });
});

describe('amount conflict detection', () => {
  it('reports two different amounts in one slot and keeps both', () => {
    const conflict = amountConflict([
      slotValue({ propositionId: '00000000-0000-7000-8000-0000000000f1', normalizedValue: { amount: '50.00', currency: 'ILS' } }),
      slotValue({ propositionId: '00000000-0000-7000-8000-0000000000f2', normalizedValue: { amount: '60.00', currency: 'ILS' },
        claimOrigins: ['DOCUMENT_ASSERTION'] }),
    ]);
    expect(conflict?.propositions.map(p => p.amount)).toEqual(['50.00', '60.00']);
    expect(conflict?.propositions.map(p => p.claimOrigins)).toEqual([['USER_STATEMENT'], ['DOCUMENT_ASSERTION']]);
  });
  it('does not call two spellings of one amount a conflict', () => {
    expect(amountConflict([
      slotValue({ propositionId: '00000000-0000-7000-8000-0000000000f1', normalizedValue: { amount: '50', currency: 'ILS' } }),
      slotValue({ propositionId: '00000000-0000-7000-8000-0000000000f2', normalizedValue: { amount: '50.00', currency: 'ILS' } }),
    ])).toBeNull();
    expect(amountConflict([])).toBeNull();
  });
});
