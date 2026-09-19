/**
 * Owner-local days (PRD §19.3 "per owner per day", §38 "owner-local date").
 *
 * A budget day and a review week are the owner's, not the server's. The zone is
 * an IANA name the request declares; nothing here reads the process time zone,
 * and nothing here reads a clock: every function takes the instant it is about.
 */

export class ReviewTimeError extends Error {
  constructor(code: string) { super(code); this.name = 'ReviewTimeError'; }
}

/** An IANA zone the runtime knows, or a refusal. `UTC` always passes. */
export function assertTimeZone(timeZone: string): string {
  if (typeof timeZone !== 'string' || timeZone.length === 0 || timeZone.length > 64) throw new ReviewTimeError('TIME_ZONE_INVALID');
  try { new Intl.DateTimeFormat('en-US', { timeZone }).format(0); }
  catch { throw new ReviewTimeError('TIME_ZONE_INVALID'); }
  return timeZone;
}

function parts(instant: Date, timeZone: string): Record<string, number> {
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(instant);
  const out: Record<string, number> = {};
  for (const part of formatted) if (part.type !== 'literal') out[part.type] = Number(part.value);
  return out;
}

/** `YYYY-MM-DD` of an instant in the owner's zone. */
export function ownerLocalDate(instant: Date, timeZone: string): string {
  const p = parts(instant, timeZone);
  return String(p['year']).padStart(4, '0') + '-' + String(p['month']).padStart(2, '0') + '-' + String(p['day']).padStart(2, '0');
}

/** The zone's offset from UTC at one instant, in milliseconds. */
function offsetAt(instant: Date, timeZone: string): number {
  const p = parts(instant, timeZone);
  const asUtc = Date.UTC(p['year']!, p['month']! - 1, p['day']!, p['hour']!, p['minute']!, p['second']!);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The instant a local calendar date begins in the owner's zone. Resolved twice so
 * a day that starts across an offset change still lands on its local midnight. */
export function startOfLocalDate(date: string, timeZone: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ReviewTimeError('LOCAL_DATE_INVALID');
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const naive = Date.UTC(year, month - 1, day);
  if (new Date(naive).toISOString().slice(0, 10) !== date) throw new ReviewTimeError('LOCAL_DATE_INVALID');
  let guess = naive - offsetAt(new Date(naive), timeZone);
  guess = naive - offsetAt(new Date(guess), timeZone);
  return new Date(guess);
}

/** A local date `days` later, as a date (calendar arithmetic, not 24-hour steps). */
export function addLocalDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

export const DAY_MS = 86_400_000;
