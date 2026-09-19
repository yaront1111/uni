import { expect, it } from 'vitest';
import { actionHistoryEntrySchema, publicRecommendationSchema } from '@unai/domain';
import { PLUGIN_CAPABILITIES, capabilityForAction } from './catalog.js';
import { DEFAULT_ATTENTION_BUDGET, admitsClarification } from './permissions.js';

/** The pure halves of the data-control surface: the plugin capability catalog,
 * the attention-budget rule and the schema rules the screens rely on. No
 * database: `packages/api/src/control.test.ts` covers the routes. */

it('CRT-CON-08-A: only draft capabilities are grantable, and every external action kind names a WRITE capability', () => {
  const grantable = PLUGIN_CAPABILITIES.filter(entry => entry.access === 'DRAFT').map(entry => entry.capabilityId).sort();
  expect(grantable).toEqual(['calendar.create_draft', 'gmail.create_draft']);
  for (const kind of ['EMAIL_SEND', 'CALENDAR_CREATE', 'CALENDAR_UPDATE', 'MONEY_MOVEMENT', 'TRADE'] as const) {
    expect(capabilityForAction(kind), kind).toMatchObject({ access: 'WRITE', riskClass: 'HIGH' });
  }
  expect(new Set(PLUGIN_CAPABILITIES.map(entry => entry.capabilityId)).size).toBe(PLUGIN_CAPABILITIES.length);
});

it('CRT-UX-09-A: the attention budget batches over the daily and per-scope caps and suppresses a repeat within its window', () => {
  const now = new Date('2026-09-19T10:00:00.000Z');
  const input = { askedToday: 0, askedInScopeToday: 0, sameQuestionAskedAt: null, reopenedByNewEvidence: false, now };
  expect(admitsClarification(DEFAULT_ATTENTION_BUDGET, input)).toEqual({ decision: 'ASK', reason: 'WITHIN_ATTENTION_BUDGET' });
  expect(admitsClarification(DEFAULT_ATTENTION_BUDGET, { ...input, askedToday: 3 }).reason).toBe('DAILY_BUDGET_EXHAUSTED');
  expect(admitsClarification(DEFAULT_ATTENTION_BUDGET, { ...input, askedInScopeToday: 1 }).reason).toBe('SENSITIVITY_SCOPE_BUDGET_EXHAUSTED');
  const askedYesterday = new Date(now.getTime() - 86_400_000);
  expect(admitsClarification(DEFAULT_ATTENTION_BUDGET, { ...input, sameQuestionAskedAt: askedYesterday }).decision).toBe('SUPPRESS');
  // Material new evidence reopens the question; a narrower window lets it through.
  expect(admitsClarification(DEFAULT_ATTENTION_BUDGET, { ...input, sameQuestionAskedAt: askedYesterday, reopenedByNewEvidence: true }).decision).toBe('ASK');
  expect(admitsClarification({ ...DEFAULT_ATTENTION_BUDGET, repeatQuestionSuppressionDays: 0 },
    { ...input, sameQuestionAskedAt: askedYesterday }).decision).toBe('ASK');
});

it('CRT-UX-13-A and CRT-AI-04-A: the public schemas refuse a mislabelled entry, a receiptless execution, a draft marked executed and a non-RECOMMENDED recommendation', () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const base = { entryId: id, actionKind: 'TRADE', subject: { objectType: 'evidence', objectId: id }, recommendationId: null,
    policyDecisionId: null, receiptEvidenceId: id, createdAt: '2026-09-19T10:00:00.000Z' };
  expect(actionHistoryEntrySchema.safeParse({ ...base, stage: 'EXECUTED', label: 'executed' }).success).toBe(true);
  expect(actionHistoryEntrySchema.safeParse({ ...base, stage: 'EXECUTED', label: 'drafted' }).success).toBe(false);
  expect(actionHistoryEntrySchema.safeParse({ ...base, stage: 'EXECUTED', label: 'executed', receiptEvidenceId: null }).success).toBe(false);
  expect(actionHistoryEntrySchema.safeParse({ ...base, stage: 'EXECUTED', label: 'executed', actionKind: 'DRAFT',
    subject: { objectType: 'draft', objectId: id } }).success).toBe(false);
  expect(publicRecommendationSchema.shape.semantics.safeParse('INTENT').success).toBe(false);
});
