import { describe, expect, it } from 'vitest';
import type { AgingKind, AgingPolicyBinding, FreshnessEvidence } from '@unai/domain';
import { evaluateFreshness } from './aging.js';

const evidenceId = '00000000-0000-4000-8000-000000000001';
const claimId = '00000000-0000-4000-8000-000000000002';
const SOURCE = '2025-09-15T09:00:00.000Z';
const IMPORT = '2026-09-19T09:00:00.000Z';
const LATER = '2026-10-19T09:00:00.000Z';
const binding = (kind: AgingKind, days: number | null = null): AgingPolicyBinding => ({
  releaseId: '00000000-0000-4000-8000-000000000003', releaseVersion: '0.3.0', releaseContentHash: 'a'.repeat(64),
  policy: { policyId: 'memory_aging.' + kind.toLowerCase(), policyVersion: '0.3.0', kind,
    frameTypeId: 'fixture.fact', predicateId: 'fixture.fact.value', reviewAfterDays: days,
    verificationTrigger: days === null ? 'NEVER' : 'WHEN_RELEVANT', explanation: 'Explicit test semantic policy.' },
});
const evidence = (over: Partial<FreshnessEvidence> = {}): FreshnessEvidence => ({
  evidenceId, claimId, recordedAt: IMPORT, assertedAt: SOURCE, precision: 'INSTANT', kind: 'ASSERTION', original: null, ...over,
});
const input = (kind: AgingKind, days: number | null = null) => ({
  binding: binding(kind, days), frameTypeId: 'fixture.fact', predicateId: 'fixture.fact.value',
  evaluatedAt: IMPORT, worldTime: IMPORT, knowledgeTime: IMPORT, validFrom: null, validTo: null,
  evidence: [evidence()], decisionRelevant: false,
});

it('keeps decades-old stable information applicable while yesterday can be outside a bounded episode', () => {
  const stable = evaluateFreshness({ ...input('STABLE'), evidence: [evidence({ assertedAt: '1980-01-01T00:00:00.000Z' })] });
  const bounded = evaluateFreshness({ ...input('BOUNDED'), validFrom: '2026-09-17T21:00:00.000Z', validTo: '2026-09-18T21:00:00.000Z',
    evidence: [evidence({ assertedAt: '2026-09-17T21:00:00.000Z', precision: 'DAY' })] });
  expect(stable).toMatchObject({ state: 'CURRENT', basisAt: '1980-01-01T00:00:00.000Z', kind: 'STABLE' });
  expect(bounded).toMatchObject({ state: 'OUTSIDE_INTERVAL', validTo: '2026-09-18T21:00:00.000Z' });
  expect(bounded).not.toHaveProperty('recovered');
  expect(bounded).not.toHaveProperty('retention');
});

it.each(['STABLE', 'BOUNDED', 'LAST_KNOWN', 'PREFERENCE', 'UNRESOLVED', 'DECISION_HISTORY', 'INCIDENTAL'] as const)
  ('preserves original source time under %s rather than import, retrieval or processing time', kind => {
    const initial = input(kind, ['LAST_KNOWN', 'PREFERENCE', 'UNRESOLVED', 'INCIDENTAL'].includes(kind) ? 30 : null);
    const first = evaluateFreshness(initial);
    const repeated = evaluateFreshness({ ...initial, evaluatedAt: LATER, worldTime: LATER, knowledgeTime: LATER });
    expect(first.basisAt).toBe(SOURCE);
    expect(repeated.basisAt).toBe(SOURCE);
    expect(initial.evidence[0]!.assertedAt).toBe(SOURCE);
    expect(repeated).not.toHaveProperty('confidence');
    expect(repeated).not.toHaveProperty('outcome');
  });

it('uses explicit source-local interval boundaries without asserting an opposite condition', () => {
  const episode = { ...input('BOUNDED'), validFrom: '2026-09-12T21:00:00.000Z', validTo: '2026-09-19T21:00:00.000Z' };
  expect(evaluateFreshness({ ...episode, worldTime: '2026-09-19T20:59:59.999Z' }).state).toBe('CURRENT');
  expect(evaluateFreshness({ ...episode, worldTime: '2026-09-19T21:00:00.000Z' }).state).toBe('OUTSIDE_INTERVAL');
  expect(evaluateFreshness({ ...episode, validTo: null }).state).toBe('UNKNOWN');
});

it('keeps last-known and preference verification separate from historical support and relevance', () => {
  for (const kind of ['LAST_KNOWN', 'PREFERENCE'] as const) {
    const old = evaluateFreshness(input(kind, 90));
    const relevant = evaluateFreshness({ ...input(kind, 90), decisionRelevant: true });
    expect(old.state).toBe('VERIFY');
    expect(old.verificationRequired).toBe(false);
    expect(relevant).toMatchObject({ state: 'VERIFY', verificationRequired: true, basisAt: SOURCE });
    expect(relevant.evidenceIds).toEqual(old.evidenceIds);
    expect(evaluateFreshness({ ...input(kind, 90), worldTime: '2025-09-20T09:00:00.000Z' }).state).toBe('CURRENT');
  }
});

it('never resolves an old commitment and keeps decision history independently relevant', () => {
  const unresolved = evaluateFreshness({ ...input('UNRESOLVED', 30), decisionRelevant: true });
  expect(unresolved).toMatchObject({ state: 'VERIFY', kind: 'UNRESOLVED', verificationRequired: true });
  expect(unresolved).not.toHaveProperty('resolved');
  const history = evaluateFreshness({ ...input('DECISION_HISTORY'), worldTime: '2036-09-19T09:00:00.000Z', decisionRelevant: true });
  expect(history).toMatchObject({ state: 'CURRENT', basisAt: SOURCE });
  const incidental = evaluateFreshness(input('INCIDENTAL', 1));
  expect(incidental).toMatchObject({ defaultProminence: 'LOW', basisAt: SOURCE });
  expect(incidental).not.toHaveProperty('deleteAt');
});

it('keeps unknown policy, unknown source time and mismatched semantics explicitly unknown', () => {
  expect(evaluateFreshness({ ...input('STABLE'), binding: null }).state).toBe('UNKNOWN');
  expect(evaluateFreshness({ ...input('STABLE'), evidence: [evidence({ assertedAt: null, precision: 'UNKNOWN' })] }))
    .toMatchObject({ state: 'UNKNOWN', basisAt: null, basisPrecision: 'UNKNOWN' });
  expect(evaluateFreshness({ ...input('STABLE'), predicateId: 'unsupported.salary.amount' }).state).toBe('UNKNOWN');
  expect(evaluateFreshness({ ...input('STABLE'), evidence: [evidence({ kind: 'SUPPORT_ONLY' })] }).state).toBe('UNKNOWN');
});

it.each(['RESTATEMENT', 'QUOTATION'] as const)('requires qualifying original lineage for %s', kind => {
  const original = { evidenceId, claimId, recordedAt: IMPORT, assertedAt: SOURCE, precision: 'INSTANT' as const, kind: 'ASSERTION' as const };
  const summary = evidence({ kind, evidenceId: '00000000-0000-4000-8000-000000000004', claimId: '00000000-0000-4000-8000-000000000005',
    assertedAt: LATER, recordedAt: LATER });
  const read = { ...input('LAST_KNOWN', 30), evaluatedAt: LATER, worldTime: LATER, knowledgeTime: LATER };
  expect(evaluateFreshness({ ...read, evidence: [summary] }).state).toBe('UNKNOWN');
  const result = evaluateFreshness({ ...read, evidence: [{ ...summary, original }] });
  expect(result).toMatchObject({ state: 'VERIFY', basisAt: SOURCE, evidenceIds: [evidenceId], claimIds: [claimId] });
});

it('only advances freshness for a new qualifying confirmation known at the requested cutoff', () => {
  const confirmation = evidence({ evidenceId: '00000000-0000-4000-8000-000000000006', claimId: '00000000-0000-4000-8000-000000000007',
    kind: 'CONFIRMATION', recordedAt: LATER, assertedAt: LATER });
  const before = evaluateFreshness({ ...input('LAST_KNOWN', 90), evidence: [evidence(), confirmation] });
  const after = evaluateFreshness({ ...input('LAST_KNOWN', 90), evaluatedAt: LATER, worldTime: LATER, knowledgeTime: LATER,
    evidence: [evidence(), confirmation] });
  expect(before).toMatchObject({ state: 'VERIFY', basisAt: SOURCE, claimIds: [claimId] });
  expect(after).toMatchObject({ state: 'CURRENT', basisAt: LATER, claimIds: [confirmation.claimId] });
});

it('does not invent precision at a coarse review boundary', () => {
  const boundary = { ...input('LAST_KNOWN', 1), evidence: [evidence({ assertedAt: '2026-09-18T12:00:00.000Z', precision: 'DAY' })],
    worldTime: '2026-09-19T13:00:00.000Z' };
  expect(evaluateFreshness(boundary)).toMatchObject({ state: 'UNKNOWN', basisPrecision: 'DAY' });
});

it('produces deterministic immutable provenance while newer policy does not rewrite earlier results', () => {
  const source = input('LAST_KNOWN', 90);
  const first = evaluateFreshness(source);
  const snapshot = JSON.stringify(first);
  expect(evaluateFreshness(source)).toEqual(first);
  const newer = { ...source.binding, releaseVersion: '0.4.0', releaseContentHash: 'b'.repeat(64),
    policy: { ...source.binding.policy, policyVersion: '0.4.0', reviewAfterDays: 730 } };
  expect(evaluateFreshness({ ...source, binding: newer }).state).toBe('CURRENT');
  expect(JSON.stringify(first)).toBe(snapshot);
  expect(first).toMatchObject({ policyVersion: '0.3.0', releaseVersion: '0.3.0', releaseContentHash: 'a'.repeat(64) });
});
