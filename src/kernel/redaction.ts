// Uai memory kernel — secret redaction.
//
// PRD section 30.5 ("Never place secrets in model prompts or logs"), FR-104
// ("Secrets must never enter prompts or normal logs") and section 30.9, which
// lists secret leakage in logs as a named threat.
//
// Three rules govern this module:
//
//   1. Removal is destruction, not encoding. A removed secret is replaced by a
//      fixed literal that carries nothing of what it replaced — no cipher, no
//      hash, no prefix sample, not even a length. `[REDACTED]` is the same ten
//      bytes whether it stands in for four characters or four hundred.
//   2. Redaction is silent. Nothing here writes to a console, a logger, a file
//      or any other sink. The only place a caller can observe a secret was
//      found is the returned string — which by rule 1 no longer holds it.
//   3. Non-secrets are untouched. Text with no secret comes back byte for byte
//      as it went in, so redaction can sit on every path without rewriting the
//      text it guards.

/**
 * The single stand-in for every removed secret. One fixed literal, deliberately
 * carrying no marker of kind, position or length: two secrets of different
 * kinds and different lengths leave identical residue.
 */
const REDACTED = "[REDACTED]";

/**
 * The secrets this module removes, as one alternation so a single left-to-right
 * pass settles overlaps. The leftmost alternative wins, which is what nesting
 * demands: `ANTHROPIC_API_KEY=sk-...` and `Authorization: Bearer sk-...` are
 * consumed by the assignment and header rules respectively, and the `sk-` rule
 * never gets a second bite at a value already gone.
 *
 * Two capture groups, at most one of which participates in any match: the part
 * of the match that must survive the replacement.
 *
 *   1. The key name and `=` of an API-key assignment (with an opening quote, if
 *      the value is quoted — a quote is punctuation, not a secret).
 *   2. The header name and `Bearer` scheme of an authorization line.
 *
 * A bare `sk-` key captures nothing: the whole match is the secret.
 *
 * Matching is case-insensitive because the spellings genuinely vary — HTTP
 * field names and auth schemes are case-insensitive by RFC 9110, and env files
 * are read by tools that lowercase. Over-matching here costs a false redaction;
 * under-matching leaks a key.
 */
const SECRET = new RegExp(
  [
    // ANTHROPIC_API_KEY=<value> / OPENAI_API_KEY=<value>. No leading word
    // boundary: a prefixed name (`MY_OPENAI_API_KEY=`) still assigns a key.
    // The value runs to whitespace or a closing quote, so it cannot span lines.
    `((?:ANTHROPIC|OPENAI)_API_KEY[ \\t]*=[ \\t]*["']?)[^\\s"']+`,
    // Authorization: Bearer <token>, on one line.
    "(authorization[ \\t]*:[ \\t]*bearer[ \\t]+)\\S+",
    // An sk- prefixed API key: `sk-` at a word boundary, then the key body.
    // No minimum length — every `sk-` token is treated as a key rather than
    // guessed at by size. The boundary keeps ordinary hyphenated words
    // ("task-list", "risk-free") out, since neither breaks before `sk`.
    "\\bsk-[A-Za-z0-9_-]+",
  ].join("|"),
  "gi",
);

/**
 * Removes every API key, key assignment value and bearer token from `text`,
 * replacing each with `[REDACTED]`.
 *
 * Removed irreversibly: the result holds no encoding, no length hint and no
 * other residue of a removed secret, and nothing is written to any log or
 * console sink along the way — a caller cannot recover a secret from the
 * return value, and no other observer gets a copy.
 *
 * Text containing none of these secrets is returned byte-identical.
 *
 * @throws TypeError if `text` is not a string. Redaction is a guard; a caller
 * that hands it a non-string has not had its secrets removed, and must hear so
 * rather than receive a coerced `"[object Object]"` it might mistake for safe.
 */
export function redactSecrets(text: string): string {
  if (typeof text !== "string") {
    throw new TypeError(`redactSecrets: expected a string, received ${typeof text}`);
  }
  // `replace` with a global pattern already returns the original string when
  // nothing matches; resetting lastIndex keeps this shared pattern stateless
  // across calls.
  SECRET.lastIndex = 0;
  return text.replace(SECRET, (_match, assignment?: string, header?: string) =>
    // Whichever prefix participated survives; the rest of the match is gone.
    // Nothing derived from the match itself reaches the result.
    `${assignment ?? header ?? ""}${REDACTED}`,
  );
}
