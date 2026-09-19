import type { CertaintyLabel } from '@unai/domain';
import { canonicalJson } from '@unai/memory';

/** How an answer words a packet object (PRD §24.5). Shared by the deterministic
 * composer, which writes statements this way, and the grounding validator, which
 * rewrites a downgraded statement this way (ADR 0026 §3), so a downgrade reads
 * exactly like the composer's own wording for the same object. */

/** "shared.obligation.principal_amount" -> "obligation principal amount". */
export function describeContract(frameTypeId: string | null, predicateId: string | null): string {
  const frame = frameTypeId ? frameTypeId.split('.').slice(1).join(' ').replaceAll('_', ' ') : '';
  const predicate = predicateId ? (predicateId.split('.').at(-1) ?? '').replaceAll('_', ' ') : '';
  return [frame, predicate].filter(part => part.length > 0).join(' ') || 'value';
}

/** A normalized value in words. Money is stated as recorded -- nothing here does
 * arithmetic on it. */
export function describeValue(value: unknown): string {
  if (value === null || value === undefined) return 'no value';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record['amount'] === 'string' && typeof record['currency'] === 'string') return record['currency'] + ' ' + record['amount'];
    for (const key of ['text', 'time', 'description', 'label']) if (typeof record[key] === 'string') return record[key] as string;
  }
  return canonicalJson(value);
}

/** The label a future modality warrants. */
export const FUTURE_LABEL: Readonly<Record<string, CertaintyLabel>> = Object.freeze({
  SCHEDULED: 'SCHEDULED', INTENDED: 'INTENDED', COMMITTED: 'COMMITTED', EXPECTED: 'PREDICTED', PREDICTED: 'PREDICTED',
  RECOMMENDED: 'RECOMMENDED', CONDITIONAL: 'INFERRED',
});
/** How a future modality is worded: never as having happened. */
export const FUTURE_WORDING: Readonly<Record<string, string>> = Object.freeze({
  SCHEDULED: 'Scheduled, not yet happened', INTENDED: 'Intended, not yet done', COMMITTED: 'Committed, not yet fulfilled',
  EXPECTED: 'Expected, not yet known to have happened', PREDICTED: 'Predicted, not yet confirmed',
  RECOMMENDED: 'Recommended, not decided', CONDITIONAL: 'Conditional, not established',
});
