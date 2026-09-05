// Uai memory kernel — provenance stamping.
//
// A provenance stamp answers "when did Uai record this, and where did it come
// from?" for one piece of text. It owns neither of the primitives that answer
// require: the instant comes from the recording clock (src/kernel/clock.ts) and
// the removal of secrets from the redaction guard (src/kernel/redaction.ts).
//
// This module deliberately holds no second implementation of either. No date
// formatting, no `toISOString`, no secret-matching pattern of its own — a
// stamp that spelled its own instant would drift from the one recorded shape,
// and a stamp that matched its own secrets would drift from what every other
// guarded path removes. Composition here means exactly one place to fix.

import { recordedAt, type Clock, type RecordedAt } from "./clock.ts";
import { redactSecrets } from "./redaction.ts";

export interface ProvenanceInput {
  /** The text being stamped. Redacted on the way out. */
  readonly text: string;
  /** Where the text came from. Redacted too: a source can carry a key. */
  readonly source: string;
}

export interface Provenance {
  /** When this stamp was taken, in the one recorded shape (see clock.ts). */
  readonly recordedAt: RecordedAt;
  readonly source: string;
  readonly text: string;
}

/**
 * Stamps `text` and its `source` with the instant they were recorded, with
 * every secret removed from both fields.
 *
 * The result carries exactly three keys — `recordedAt`, `source` and `text` —
 * and nothing else: a stamp is not a place to smuggle the unredacted original.
 * `recordedAt` satisfies `isRecordedAt`, and each redacted field is byte for
 * byte what `redactSecrets` answers for the corresponding input string, so a
 * secret in either one is gone and `[REDACTED]` stands exactly where it stood.
 *
 * A source is redacted for the same reason text is: a URL, a curl line or a
 * connector label is as capable of embedding a key as prose, and PRD FR-104
 * admits no field that is exempt.
 *
 * Time is an input, not an ambient fact (clock.ts, rule 2): `clock` defaults to
 * the module's system clock and can be handed a fixed one in a test or replay.
 *
 * @throws TypeError, from `redactSecrets`, if `text` or `source` is not a
 * string — an unredacted value must never be coerced into a stamp.
 */
export function stampProvenance(
  { text, source }: ProvenanceInput,
  clock: Pick<Clock, "recordedAt"> = { recordedAt },
): Provenance {
  // Redact before stamping, so nothing built here ever holds the raw values.
  const redactedText = redactSecrets(text);
  const redactedSource = redactSecrets(source);

  return Object.freeze({
    recordedAt: clock.recordedAt(),
    source: redactedSource,
    text: redactedText,
  });
}
