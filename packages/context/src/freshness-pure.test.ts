import { expect, it } from 'vitest';
import type { MemoryTransaction } from '@unai/memory';
import { readContextFreshness } from './freshness.js';

// Contract-level RED can run without the shared PostgreSQL harness. The adjacent
// freshness.test.ts verifies these same inputs through real RLS and source rows.
it('carries an original source clock through the context assessment DTO', async () => {
  const owner = '00000000-0000-4000-8000-000000000001';
  const propositionId = '00000000-0000-4000-8000-000000000002';
  const claimId = '00000000-0000-4000-8000-000000000003';
  const evidenceId = '00000000-0000-4000-8000-000000000004';
  const releaseId = '00000000-0000-4000-8000-000000000005';
  const source = '2020-01-01T00:00:00.000Z', recorded = '2026-09-01T00:00:00.000Z', now = '2026-09-19T00:00:00.000Z';
  const tx: MemoryTransaction = { async query(sql) {
    if (sql.includes('unai_private.aging_policy')) return { rowCount: 1, rows: [{ binding: {
      releaseId, releaseVersion: '0.3.0', releaseContentHash: 'a'.repeat(64), policy: {
        policyId: 'aging.shared.commitment.priority', policyVersion: '0.3.0', kind: 'LAST_KNOWN',
        frameTypeId: 'shared.commitment', predicateId: 'shared.commitment.priority', reviewAfterDays: 30,
        verificationTrigger: 'WHEN_RELEVANT', explanation: 'Check an old priority when it affects a decision.',
      },
    } }] };
    if (sql.includes('FROM claims')) return { rowCount: 1, rows: [{ id: claimId, proposition_id: propositionId,
      claim_origin: 'USER_STATEMENT', lifecycle: 'PROVISIONAL', recorded_at: new Date(recorded), metadata: {},
      temporal_interpretation: null, evidence_id: evidenceId, occurred_at: new Date(source),
      actor_ref: { type: 'USER', id: owner }, context_kind: 'BASE' }] };
    return { rowCount: 0, rows: [] };
  } };
  const result = await readContextFreshness(tx, { ownerScopeId: owner, registryReleaseId: releaseId,
    evaluatedAt: now, worldTime: now, knowledgeTime: now, decisionRelevant: true,
    beliefs: [{ propositionId, frameTypeId: 'shared.commitment', predicateId: 'shared.commitment.priority',
      validFrom: null, validTo: null, claimIds: [claimId], evidenceIds: [evidenceId] }] });
  expect(result).toHaveLength(1);
  expect(result[0]!.assessment).toMatchObject({ state: 'VERIFY', basisAt: source, verificationRequired: true,
    evaluatedAt: now, evidenceIds: [evidenceId], claimIds: [claimId], releaseId, policyVersion: '0.3.0' });
});
