import { moneyAmountSchema, currencyCodeSchema, type Money } from '@unai/domain';

/**
 * Exact decimal money arithmetic -- the arithmetic the Memory Kernel must not
 * contain (PRD §16.7, §26.4, FR-036; CRT-OUT-06-A).
 *
 * This file is the reason `@unai/capabilities` exists as a package of its own.
 * The kernel stores the canonical allocation amount and says nothing about what
 * it adds up to; every sum, difference and comparison over those amounts happens
 * here, inside the capability that owns the rule, and can be recomputed from the
 * canonical `finance.payment_allocation` frames at any time.
 *
 * Two decisions that are not stylistic:
 *
 *  - **Scaled `BigInt`, never `number`.** `0.1 + 0.2` is not `0.3` in IEEE-754,
 *    and an obligation balance is exactly where that kind of drift becomes a
 *    wrong answer about somebody's money. Amounts are parsed into an integer
 *    number of units at a common scale and only formatted back at the end.
 *  - **No currency conversion, ever.** Adding ILS to USD is refused rather than
 *    resolved with a rate nobody supplied. A conversion is a claim about the
 *    world, and this capability has no evidence for one.
 */

export const MONEY_VERSION = 'capability-money-0.1.0';
/** Six fractional digits: enough for every ISO 4217 minor unit and for the
 * fractional allocations a connector may report, and fixed so that formatting is
 * a pure function of the scaled integer. */
const SCALE = 6;
const FACTOR = 10n ** BigInt(SCALE);

export class MoneyError extends Error {
  constructor(code: string) { super(code); this.name = 'MoneyError'; }
}

/** Parse an exact decimal string into units at SCALE.
 *
 * Refuses rather than truncating. `moneyAmountSchema` already bounds the value at
 * six fractional digits, so an amount with more precision than this capability
 * can hold exactly never reaches the multiplication below: it is refused as an
 * invalid money amount, which is the honest answer -- silently dropping a digit
 * of somebody's money is the one outcome that must not be possible. */
export function toUnits(amount: string): bigint {
  const parsed = moneyAmountSchema.safeParse(amount);
  if (!parsed.success) throw new MoneyError('MONEY_AMOUNT_INVALID');
  const negative = parsed.data.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? parsed.data.slice(1) : parsed.data).split('.');
  const units = BigInt(whole) * FACTOR + BigInt((fraction + '0'.repeat(SCALE)).slice(0, SCALE));
  return negative ? -units : units;
}

/** Format units back to the shortest exact decimal string. Exact: the digits
 * that come out are the digits that went in, with no rounding step anywhere. */
export function fromUnits(units: bigint): string {
  const negative = units < 0n;
  const absolute = negative ? -units : units;
  const whole = absolute / FACTOR;
  const fraction = (absolute % FACTOR).toString().padStart(SCALE, '0').replace(/0+$/, '');
  return (negative ? '-' : '') + whole.toString() + (fraction === '' ? '' : '.' + fraction);
}

export function money(amount: string, currency: string): Money {
  return Object.freeze({ amount: moneyAmountSchema.parse(amount), currency: currencyCodeSchema.parse(currency) });
}

/** Read a money value out of a stored `normalized_value`.
 *
 * Returns null rather than guessing. A slot whose value is not a money object is
 * not a money slot, and inventing an amount for it is exactly the failure this
 * capability exists to avoid. */
export function readMoney(value: unknown): Money | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const amount = record['amount'];
  const currency = record['currency'];
  if (typeof currency !== 'string') return null;
  // A stored amount may have arrived from `numeric` as a string or from JSON as a
  // number; a number is accepted only when it survives the round trip exactly.
  const text = typeof amount === 'string' ? amount
    : typeof amount === 'number' && Number.isFinite(amount) ? String(amount) : null;
  if (text === null) return null;
  const parsed = moneyAmountSchema.safeParse(text);
  const code = currencyCodeSchema.safeParse(currency);
  if (!parsed.success || !code.success) return null;
  try { toUnits(parsed.data); } catch { return null; }
  return Object.freeze({ amount: parsed.data, currency: code.data });
}

/** Sum money values that share one currency. A mixed-currency list is refused,
 * never converted. */
export function sumMoney(values: readonly Money[], currency: string): Money {
  const code = currencyCodeSchema.parse(currency);
  let units = 0n;
  for (const value of values) {
    if (value.currency !== code) throw new MoneyError('MONEY_CURRENCY_MISMATCH');
    units += toUnits(value.amount);
  }
  return money(fromUnits(units), code);
}

export function subtractMoney(left: Money, right: Money): Money {
  if (left.currency !== right.currency) throw new MoneyError('MONEY_CURRENCY_MISMATCH');
  return money(fromUnits(toUnits(left.amount) - toUnits(right.amount)), left.currency);
}

export function compareMoney(left: Money, right: Money): -1 | 0 | 1 {
  if (left.currency !== right.currency) throw new MoneyError('MONEY_CURRENCY_MISMATCH');
  const a = toUnits(left.amount), b = toUnits(right.amount);
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Are two amounts the same value? `50` and `50.00` are, and a comparison that
 * said otherwise would report a conflict between an amount and itself. */
export function sameMoney(left: Money, right: Money): boolean {
  return left.currency === right.currency && toUnits(left.amount) === toUnits(right.amount);
}

/** The canonical text for one money value, used as a grouping key when deciding
 * whether two propositions actually disagree. */
export function moneyKey(value: Money): string {
  return value.currency + ' ' + fromUnits(toUnits(value.amount));
}
