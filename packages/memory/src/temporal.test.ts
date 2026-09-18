import { expect, it } from 'vitest';
import { temporalInterpretationSchema } from '@unai/domain';
import { TEMPORAL_RESOLVER_VERSION, TemporalResolutionError, resolveTemporalExpression } from './temporal.js';

/** Temporal resolution keeps what was actually said (PRD §12.5). Pure: no
 * database, no harness, no clock of its own. */

const reference = new Date('2026-03-14T09:30:00Z');

it('CRT-MEM-07-A: resolves "last month" with original text, timezone, month precision, resolver version and confidence, and never an exact instant', () => {
  const resolved = resolveTemporalExpression({ text: 'last month', reference, timeZone: 'Asia/Jerusalem', locale: 'he-IL' });
  expect(resolved).not.toBeNull();
  const interpretation = temporalInterpretationSchema.parse(resolved);
  expect(interpretation.originalText).toBe('last month');
  expect(interpretation.timeZone).toBe('Asia/Jerusalem');
  expect(interpretation.locale).toBe('he-IL');
  expect(interpretation.precision).toBe('MONTH');
  expect(interpretation.precision).not.toBe('EXACT_INSTANT');
  expect(interpretation.resolverVersion).toBe(TEMPORAL_RESOLVER_VERSION);
  expect(interpretation.confidence).toBeGreaterThan(0);
  expect(interpretation.confidence).toBeLessThan(1);
  // February 2026 in Israel Standard Time (UTC+2), as an interval and not a point.
  expect(interpretation.normalizedTime).toEqual({ start: '2026-01-31T22:00:00.000Z', end: '2026-02-28T22:00:00.000Z' });
  expect(interpretation.normalizedTime.start).not.toBe(interpretation.normalizedTime.end);
});

it('CRT-MEM-07-A: reads the same phrase in the owner\'s own timezone', () => {
  const tokyo = resolveTemporalExpression({ text: 'last month', reference, timeZone: 'Asia/Tokyo' })!;
  const utc = resolveTemporalExpression({ text: 'last month', reference, timeZone: 'UTC' })!;
  expect(tokyo.precision).toBe('MONTH');
  expect(tokyo.normalizedTime.start).toBe('2026-01-31T15:00:00.000Z');
  expect(utc.normalizedTime).toEqual({ start: '2026-02-01T00:00:00.000Z', end: '2026-03-01T00:00:00.000Z' });
  expect(tokyo.normalizedTime.start).not.toBe(utc.normalizedTime.start);
  expect(() => resolveTemporalExpression({ text: 'last month', reference, timeZone: 'Mars/Olympus' }))
    .toThrow(TemporalResolutionError);
});

it('CRT-MEM-07-A: spends EXACT_INSTANT only on a phrase that already carried one', () => {
  const instant = resolveTemporalExpression({ text: '2026-03-14T09:30:00Z', reference, timeZone: 'UTC' })!;
  expect(instant).toMatchObject({ precision: 'EXACT_INSTANT', confidence: 1 });
  expect(instant.normalizedTime).toEqual({ start: '2026-03-14T09:30:00.000Z', end: '2026-03-14T09:30:00.000Z' });
  // Every vaguer shape stays vaguer, and none of them is an instant.
  const vaguer = ['yesterday', 'today', '2026-03-14', '2026-02', 'last week', 'recently', 'a while ago', 'next month', 'since 2026-01-01']
    .map(text => resolveTemporalExpression({ text, reference, timeZone: 'Asia/Jerusalem' })!);
  expect(vaguer.every(item => item.precision !== 'EXACT_INSTANT')).toBe(true);
  expect(vaguer.map(item => item.precision)).toEqual(['DAY', 'DAY', 'DAY', 'MONTH', 'APPROXIMATE', 'APPROXIMATE', 'APPROXIMATE', 'MONTH', 'OPEN_INTERVAL']);
  // An open interval has no end rather than an invented one.
  expect(vaguer.at(-1)!.normalizedTime.end).toBeNull();
  // An explicit calendar date is certain about the day it names; every phrase the
  // resolver had to interpret records that it was interpreting.
  const relative = ['yesterday', 'today', 'last week', 'recently', 'a while ago', 'next month']
    .map(text => resolveTemporalExpression({ text, reference, timeZone: 'Asia/Jerusalem' })!);
  expect(relative.every(item => item.confidence > 0 && item.confidence < 1)).toBe(true);
});

it('answers null for a phrase it does not recognise rather than guessing a time', () => {
  for (const text of ['sometime', 'when the project lands', 'בקרוב', '']) {
    expect(resolveTemporalExpression({ text, reference, timeZone: 'UTC' }), text).toBeNull();
  }
});

it('resolves a day across a daylight-saving change at the moment that day began', () => {
  // Israel moves to daylight time on 2026-03-27, so the days on either side start
  // at different UTC instants; a fixed offset would silently misplace one of them.
  const before = resolveTemporalExpression({ text: '2026-03-26', reference, timeZone: 'Asia/Jerusalem' })!;
  const after = resolveTemporalExpression({ text: '2026-03-28', reference, timeZone: 'Asia/Jerusalem' })!;
  expect(before.normalizedTime.start).toBe('2026-03-25T22:00:00.000Z');
  expect(after.normalizedTime.start).toBe('2026-03-27T21:00:00.000Z');
});

it('is reproducible from its recorded resolver version', () => {
  const first = resolveTemporalExpression({ text: 'Last Month', reference, timeZone: 'UTC' })!;
  const again = resolveTemporalExpression({ text: 'last  month', reference, timeZone: 'UTC' })!;
  expect(first.normalizedTime).toEqual(again.normalizedTime);
  expect(first.precision).toBe(again.precision);
  // The original text is retained exactly as written, casing included.
  expect(first.originalText).toBe('Last Month');
  expect(again.originalText).toBe('last  month');
});
