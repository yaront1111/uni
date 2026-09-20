import { expect, it } from 'vitest';
import { askRequestSchema } from './ask.js';
import { referenceQuerySchema } from './reference-query.js';

it('keeps the query optional and validates creditor identity and increasing due intervals', () => {
  const base = { ownerScopeId: '11111111-1111-4111-8111-111111111111', question: 'What is next week?',
    purpose: 'PERSONAL_FINANCE', worldTime: 'NOW', knowledgeTime: 'LATEST', maximumSensitivity: 'PRIVATE' };
  expect(askRequestSchema.parse(base)).not.toHaveProperty('referenceQuery');
  const query = { kind: 'OBLIGATION', creditor: { canonicalLabel: 'Dana' },
    due: { from: '2026-09-21T00:00:00Z', to: '2026-09-28T00:00:00Z' } };
  expect(referenceQuerySchema.parse(query)).toEqual(query);
  for (const invalid of [null, {}, { kind: 'UNRESOLVED', evidenceIds: [] },
    { ...query, creditor: {} }, { ...query, creditor: { entityId: 'not-a-uuid' } },
    { ...query, creditor: { canonicalLabel: ' ' } }, { ...query, due: { from: query.due.to, to: query.due.from } },
    { ...query, due: { from: query.due.from, to: query.due.from } },
    { ...query, due: { from: 'yesterday', to: query.due.to } }]) {
    expect(referenceQuerySchema.safeParse(invalid).success).toBe(false);
  }
});
