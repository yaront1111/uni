// Uai memory kernel — the recording clock.
//
// Every durable memory object carries a `recordedAt` stamp (PRD section 11:
// claims record `recordedAt` alongside their valid time). Two rules govern it:
//
//   1. One shape only. A recorded instant is an ISO-8601 UTC instant with
//      exactly three fractional-second digits and a trailing `Z`, so stamps
//      compare, sort and hash lexicographically without renormalization.
//   2. Time is an input, not an ambient fact. Anything that stamps records
//      takes a clock, so tests and replays can hand it a fixed millisecond
//      source instead of the wall clock.

/**
 * An ISO-8601 UTC instant with exactly three fractional-second digits and a
 * trailing `Z`, e.g. `"2023-11-14T22:13:20.123Z"` — the one recorded shape.
 */
export type RecordedAt = string;

/** A millisecond source, e.g. `Date.now` or a fixed value in a test. */
export type MillisecondSource = () => number;

export interface Clock {
  /** The instant this clock's source is currently at. */
  recordedAt(): RecordedAt;
  /** Whether `value` is a well-formed recorded instant. Clock-independent. */
  isRecordedAt(value: unknown): value is RecordedAt;
}

/**
 * The one accepted shape. Exactly three fractional digits (not two, not six)
 * and the `Z` designator (no `+00:00`, no bare local time).
 */
const RECORDED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Widest instant `Date` can represent: ±100,000,000 days from the epoch. */
const MAX_TIME_VALUE = 8.64e15;

/**
 * Renders a millisecond instant in the recorded shape.
 *
 * A source that answers something unrepresentable is a defect in the caller's
 * clock, not a stamp to paper over: fail loudly rather than record a lie.
 */
function format(milliseconds: number): RecordedAt {
  if (!Number.isFinite(milliseconds) || Math.abs(milliseconds) > MAX_TIME_VALUE) {
    throw new RangeError(
      `recordedAt: millisecond source answered ${String(milliseconds)}, which is not a representable instant`,
    );
  }
  // Truncate rather than round: a fractional source must not stamp a future
  // millisecond. Years outside 0000-9999 would render with an expanded
  // (±YYYYYY) year, which the recorded shape does not admit.
  const iso = new Date(Math.trunc(milliseconds)).toISOString();
  if (!RECORDED_AT.test(iso)) {
    throw new RangeError(
      `recordedAt: instant ${iso} falls outside the four-digit-year range the recorded shape admits`,
    );
  }
  return iso;
}

/**
 * True only for what {@link recordedAt} produces. Rejects non-strings, the
 * empty string, and date-times missing millisecond precision or the `Z`
 * designator — including otherwise valid ISO-8601 spellings of the same
 * instant, because one instant must have one recorded spelling.
 */
export function isRecordedAt(value: unknown): value is RecordedAt {
  if (typeof value !== "string" || !RECORDED_AT.test(value)) {
    return false;
  }
  // The shape is right; confirm the instant is real. Round-tripping rejects
  // both impossible dates ("2024-02-30") and any value a lenient parser would
  // silently shift onto a different instant.
  const milliseconds = Date.parse(value);
  return !Number.isNaN(milliseconds) && new Date(milliseconds).toISOString() === value;
}

/**
 * A clock over a caller-supplied millisecond source. Consults `now` on each
 * call and touches the wall clock nowhere, so a fixed source yields a fixed
 * instant however many times it is asked.
 */
export function createClock(now: MillisecondSource): Clock {
  if (typeof now !== "function") {
    throw new TypeError("createClock: expected a millisecond source function");
  }
  return Object.freeze({
    recordedAt: (): RecordedAt => format(now()),
    isRecordedAt,
  });
}

/** The system clock — the wall clock, in the one recorded shape. */
const systemClock = createClock(() => Date.now());

/** The current instant, as an ISO-8601 UTC instant with millisecond precision. */
export function recordedAt(): RecordedAt {
  return systemClock.recordedAt();
}
