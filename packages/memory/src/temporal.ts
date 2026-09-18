import { temporalInterpretationSchema, type TemporalInterpretation } from '@unai/domain';

/** Temporal resolution (PRD §12.5, §36.5, CRT-MEM-07-A).
 *
 * The rule the whole module exists for: a vague phrase must not be stored as
 * falsely precise. Resolution therefore always answers two things at once -- an
 * interval, and how precisely that interval was actually known. "last month"
 * resolves to a month-precision interval with the original text, the timezone it
 * was read in, the resolver version and a confidence below certainty; it can
 * never resolve to EXACT_INSTANT, because no phrase of that shape names one.
 *
 * Pure: no database, no clock of its own, no model. The caller supplies the
 * reference instant, so the same phrase in the same zone always resolves the same
 * way and the result is reproducible from the recorded resolver version.
 */
export const TEMPORAL_RESOLVER_VERSION = 'temporal-resolver-1';

export class TemporalResolutionError extends Error {
  constructor(code: 'TEMPORAL_TIMEZONE_INVALID' | 'TEMPORAL_REFERENCE_INVALID') { super(code); this.name = 'TemporalResolutionError'; }
}

export interface TemporalResolutionRequest {
  /** The phrase exactly as the source wrote it; it is retained verbatim. */
  readonly text: string;
  /** Instant the phrase is read relative to. */
  readonly reference: Date;
  /** IANA zone the speaker's "last month" is a month of. */
  readonly timeZone: string;
  readonly locale?: string;
}

/** A phrase the resolver does not recognise answers null. An unrecognised phrase
 * is an unknown, and an unknown is never a guessed instant. */
export function resolveTemporalExpression(request: TemporalResolutionRequest): TemporalInterpretation | null {
  const { text, reference, timeZone, locale } = request;
  if (!Number.isFinite(reference.getTime())) throw new TemporalResolutionError('TEMPORAL_REFERENCE_INVALID');
  assertZone(timeZone);
  const phrase = text.trim();
  if (!phrase) return null;
  const resolved = interpret(phrase.toLowerCase().replace(/\s+/g, ' '), phrase, reference, timeZone);
  if (!resolved) return null;
  return temporalInterpretationSchema.parse({
    originalText: phrase,
    normalizedTime: { start: resolved.start, end: resolved.end },
    timeZone,
    ...(locale === undefined ? {} : { locale }),
    precision: resolved.precision,
    resolverVersion: TEMPORAL_RESOLVER_VERSION,
    confidence: resolved.confidence,
  });
}

interface Resolved { start: string; end: string | null; precision: TemporalInterpretation['precision']; confidence: number }

function interpret(phrase: string, original: string, reference: Date, zone: string): Resolved | null {
  // An explicit instant is the only shape that earns EXACT_INSTANT: the source
  // already carried the offset, so nothing is being inferred. It is parsed from
  // the text as written, because the ISO grammar is case-sensitive.
  if (/^\d{4}-\d{2}-\d{2}t\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(z|[+-]\d{2}:\d{2})$/.test(phrase)) {
    const instant = new Date(original);
    if (!Number.isFinite(instant.getTime())) return null;
    return { start: instant.toISOString(), end: instant.toISOString(), precision: 'EXACT_INSTANT', confidence: 1 };
  }
  const isoDay = /^(\d{4})-(\d{2})-(\d{2})$/.exec(phrase);
  if (isoDay) return day(Number(isoDay[1]), Number(isoDay[2]), Number(isoDay[3]), zone, 1);
  const isoMonth = /^(\d{4})-(\d{2})$/.exec(phrase);
  if (isoMonth) return month(Number(isoMonth[1]), Number(isoMonth[2]), zone, 1);

  const today = zonedParts(reference, zone);
  const relativeDays: Record<string, number> = { 'today': 0, 'tonight': 0, 'yesterday': -1, 'tomorrow': 1,
    'the day before yesterday': -2, 'the day after tomorrow': 2 };
  const offset = relativeDays[phrase];
  // A named day is a whole day, not the instant the sentence was written.
  if (offset !== undefined) return shiftDay(today, offset, zone, 0.9);

  const months: Record<string, number> = { 'this month': 0, 'last month': -1, 'the last month': -1,
    'previous month': -1, 'the previous month': -1, 'next month': 1 };
  const monthOffset = months[phrase];
  if (monthOffset !== undefined) {
    const shifted = shiftMonth(today.year, today.month, monthOffset);
    // Month precision and never an instant: the phrase names a month, and the
    // confidence records that the speaker's month boundary is an assumption.
    return month(shifted.year, shifted.month, zone, 0.6);
  }

  // Phrases whose extent is genuinely unclear keep APPROXIMATE precision: the
  // interval is a bounded reading, not a claim about which days were meant.
  const approximate: Record<string, number> = { 'last week': -7, 'the last week': -7, 'this week': 0, 'next week': 7,
    'recently': -14, 'a while ago': -30, 'soon': 7, 'last year': -365, 'a few days ago': -3, 'a couple of days ago': -2 };
  const span = approximate[phrase];
  if (span !== undefined) {
    const from = span <= 0 ? shiftDay(today, span, zone, 0).start : shiftDay(today, 0, zone, 0).start;
    const to = span <= 0 ? shiftDay(today, 0, zone, 0).end : shiftDay(today, span, zone, 0).end;
    return { start: from, end: to, precision: 'APPROXIMATE', confidence: 0.4 };
  }

  // "since <date>" states a beginning and no end: an open interval, recorded as
  // one rather than closed at the moment of reading.
  const since = /^since (\d{4}-\d{2}-\d{2})$/.exec(phrase);
  if (since) {
    const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(since[1]!)!;
    const from = day(Number(parts[1]), Number(parts[2]), Number(parts[3]), zone, 1);
    return { start: from.start, end: null, precision: 'OPEN_INTERVAL', confidence: 0.7 };
  }
  return null;
}

function day(year: number, monthNumber: number, dayNumber: number, zone: string, confidence: number): Resolved {
  const start = zonedInstant(year, monthNumber, dayNumber, zone);
  const end = zonedInstant(year, monthNumber, dayNumber + 1, zone);
  return { start: start.toISOString(), end: end.toISOString(), precision: 'DAY', confidence };
}

function shiftDay(from: { year: number; month: number; day: number }, days: number, zone: string, confidence: number): Resolved {
  const shifted = new Date(Date.UTC(from.year, from.month - 1, from.day + days));
  return day(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate(), zone, confidence);
}

function month(year: number, monthNumber: number, zone: string, confidence: number): Resolved {
  const next = shiftMonth(year, monthNumber, 1);
  return {
    start: zonedInstant(year, monthNumber, 1, zone).toISOString(),
    end: zonedInstant(next.year, next.month, 1, zone).toISOString(),
    precision: 'MONTH',
    confidence,
  };
}

function shiftMonth(year: number, monthNumber: number, by: number): { year: number; month: number } {
  const index = (year * 12 + (monthNumber - 1)) + by;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

function assertZone(timeZone: string): void {
  try { new Intl.DateTimeFormat('en-US', { timeZone }); }
  catch { throw new TemporalResolutionError('TEMPORAL_TIMEZONE_INVALID'); }
}

const zoneFormats = new Map<string, Intl.DateTimeFormat>();
function zoneFormat(timeZone: string): Intl.DateTimeFormat {
  let format = zoneFormats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    zoneFormats.set(timeZone, format);
  }
  return format;
}

/** Wall-clock fields an instant shows in a zone. */
function zonedParts(instant: Date, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts: Record<string, string> = {};
  for (const part of zoneFormat(timeZone).formatToParts(instant)) parts[part.type] = part.value;
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second) };
}

/** Midnight of a local calendar day, as the instant it happened at.
 *
 * Two passes: the first uses the offset near the guessed instant, the second the
 * offset that actually applies at the result, so a day that begins on one side of
 * a daylight-saving change still starts at the right moment. */
function zonedInstant(year: number, monthNumber: number, dayNumber: number, timeZone: string): Date {
  const wall = Date.UTC(year, monthNumber - 1, dayNumber);
  let instant = wall - offsetAt(new Date(wall), timeZone);
  instant = wall - offsetAt(new Date(instant), timeZone);
  return new Date(instant);
}

function offsetAt(instant: Date, timeZone: string): number {
  const parts = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}
