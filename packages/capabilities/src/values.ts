/**
 * Reading typed values out of a stored `normalized_value`.
 *
 * Every function here answers null for anything it does not recognise. A
 * projection column is a typed answer a surface will show without checking it
 * again, so a reader that guessed would put an invented time or an invented
 * amount in front of the owner. Null means "this projection has nothing to say
 * about that", which is always a true statement.
 */

/** A time value as the registry's `TIME_OR_INTERVAL` predicates normalize it:
 * `{time}` for an instant, `{start,end}` for an interval. An interval's start is
 * its due time; nothing here widens a day into an instant. */
export interface TimeValue { readonly start: Date | null; readonly end: Date | null }

function parseInstant(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? null : time;
}

export function readTimeValue(value: unknown): TimeValue | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const instant = parseInstant(record['time']);
  if (instant) return Object.freeze({ start: instant, end: null });
  const start = parseInstant(record['start']);
  const end = parseInstant(record['end']);
  if (start === null && end === null) return null;
  return Object.freeze({ start, end });
}

/** The single instant a due time reads as: the start of an interval, or the
 * instant itself. An interval with only an end is due at its end. */
export function dueInstant(value: unknown): Date | null {
  const time = readTimeValue(value);
  return time === null ? null : time.start ?? time.end;
}

export function readText(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() === '' ? null : value;
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  for (const key of ['text', 'description', 'value']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate;
  }
  return null;
}

/** A reference value: the connector identifier a recurrence instance carries. */
export function readReference(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() === '' ? null : value;
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  for (const key of ['recurrenceInstanceId', 'recurrenceId', 'externalId', 'reference']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate;
  }
  return null;
}

/** An entity identifier stored as a SET member of a participants predicate. */
export function readEntityReference(value: unknown): string | null {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (typeof value === 'string') return uuid.test(value) ? value : null;
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  for (const key of ['entityId', 'participantEntityId', 'id']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && uuid.test(candidate)) return candidate;
  }
  return null;
}

/** The frame a role points at, for `FRAME_REFERENCE` role fillers such as the
 * obligation an allocation was applied to. */
export function readFrameReference(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  for (const key of ['frameInstanceId', 'obligationFrameInstanceId', 'frameId']) {
    const candidate = record[key];
    if (typeof candidate === 'string') return candidate;
  }
  return null;
}
