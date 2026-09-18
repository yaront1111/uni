/** Byte-stable JSON for the two places this package needs one: the input to a
 * fingerprint, and the semantic comparison that decides whether two descriptors
 * say the same thing. Object keys are sorted recursively and array order is kept,
 * so the same descriptor always produces the same bytes regardless of how the
 * caller built the object.
 *
 * This is a normalization detail, never an identity: the bytes feed a lookup
 * index and a comparison, and every durable object keeps its surrogate UUIDv7
 * (PRD §13.1, §13.2).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] !== undefined) sorted[key] = canonicalize(source[key]);
    }
    return sorted;
  }
  return value;
}
