import { expect, it } from 'vitest';
import { describeFreshness } from './wording.js';

it('states applicability separately from confidence, using the original source date', () => {
  expect(describeFreshness({ state: 'VERIFY', basisAt: '2025-09-15T09:00:00.000Z', verificationRequired: true }))
    .toBe(' Original evidence dated 2025-09-15; verify whether this still applies.');
  expect(describeFreshness({ state: 'CURRENT', basisAt: '1980-01-01T00:00:00.000Z', verificationRequired: false }))
    .toBe(' Evidence dated 1980-01-01; no freshness check is due.');
});
it('does not manufacture confirmation or an opposite state from missing or expired evidence', () => {
  expect(describeFreshness({ state: 'UNKNOWN', basisAt: null, verificationRequired: false })).toContain('Current applicability is unknown');
  expect(describeFreshness({ state: 'OUTSIDE_INTERVAL', basisAt: '2026-09-18T00:00:00.000Z', verificationRequired: false,
    reason: 'VALID_INTERVAL_ENDED' }))
    .toContain('Its recorded interval has ended; no replacement state is established');
  expect(describeFreshness(undefined)).toBe('');
});

it('distinguishes an interval that has not started from one that ended without guessing missing reasons', () => {
  expect(describeFreshness({ state: 'OUTSIDE_INTERVAL', basisAt: '2026-09-18T00:00:00.000Z', verificationRequired: false,
    reason: 'VALID_INTERVAL_NOT_STARTED' })).toContain('Its recorded interval has not started');
  const unknownBoundary = describeFreshness({ state: 'OUTSIDE_INTERVAL', basisAt: null, verificationRequired: false });
  expect(unknownBoundary).not.toMatch(/has ended|has not started/);
  expect(unknownBoundary).toContain('outside its recorded interval');
});
