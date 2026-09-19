import { z } from 'zod';
import { agingPolicyBindingSchema, freshnessAssessmentSchema, freshnessEvidenceSchema,
  type AgingPolicyBinding, type FreshnessAssessment, type FreshnessState } from '@unai/domain';
import type { MemoryTransaction } from './transaction.js';

export const AGING_EVALUATOR_VERSION = 'contextual-aging-0.1.0';
const DAY = 86_400_000;
const evaluationSchema = z.strictObject({
  binding: agingPolicyBindingSchema.nullable(), frameTypeId: z.string().min(1).max(200), predicateId: z.string().min(1).max(200),
  evaluatedAt: z.iso.datetime(), worldTime: z.iso.datetime(), knowledgeTime: z.iso.datetime(),
  validFrom: z.iso.datetime().nullable(), validTo: z.iso.datetime().nullable(),
  evidence: z.array(freshnessEvidenceSchema).max(256), decisionRelevant: z.boolean(),
}).refine(input => input.validFrom === null || input.validTo === null || Date.parse(input.validFrom) <= Date.parse(input.validTo),
  { message: 'VALID_INTERVAL_INVALID', path: ['validTo'] });
export type FreshnessEvaluationInput = z.input<typeof evaluationSchema>;

/** No clocks, writes, confidence arithmetic or retention decisions. A later
 * read evaluates the same source basis; it cannot renew the source assertion. */
export function evaluateFreshness(raw: FreshnessEvaluationInput): FreshnessAssessment {
  const input = evaluationSchema.parse(raw);
  const policy = input.binding?.policy ?? null;
  const knowledge = Date.parse(input.knowledgeTime), world = Date.parse(input.worldTime);
  const qualifying = input.evidence.filter(entry => Date.parse(entry.recordedAt) <= knowledge).flatMap(entry => {
    if (entry.kind === 'SUPPORT_ONLY') return [];
    const basis = entry.kind === 'RESTATEMENT' || entry.kind === 'QUOTATION' ? entry.original : entry;
    return basis && Date.parse(basis.recordedAt) <= knowledge ? [basis] : [];
  });
  const known = qualifying.filter(entry => entry.assertedAt !== null && entry.precision !== 'UNKNOWN'
    && Date.parse(entry.assertedAt) <= knowledge);
  const precisionOrder = ['INSTANT', 'DAY', 'MONTH', 'APPROXIMATE', 'UNKNOWN'];
  known.sort((a, b) => Date.parse(b.assertedAt!) - Date.parse(a.assertedAt!)
    || precisionOrder.indexOf(a.precision) - precisionOrder.indexOf(b.precision) || a.claimId.localeCompare(b.claimId));
  const latest = known[0] ?? null;
  const basis = latest === null ? qualifying : known.filter(entry => entry.assertedAt === latest.assertedAt && entry.precision === latest.precision);
  let state: FreshnessState = 'UNKNOWN', reason = 'SOURCE_TIME_UNKNOWN';
  let lowProminence = false;
  if (policy === null) reason = 'AGING_POLICY_UNKNOWN';
  else if (policy.frameTypeId !== input.frameTypeId || policy.predicateId !== input.predicateId) reason = 'AGING_POLICY_NOT_APPLICABLE';
  else if (latest === null) reason = qualifying.length === 0 ? 'NO_QUALIFYING_SOURCE_ASSERTION' : 'SOURCE_TIME_UNKNOWN';
  else if (input.validFrom !== null && world < Date.parse(input.validFrom)) {
    state = 'OUTSIDE_INTERVAL'; reason = 'VALID_INTERVAL_NOT_STARTED';
  } else if (input.validTo !== null && world >= Date.parse(input.validTo)) {
    state = 'OUTSIDE_INTERVAL'; reason = 'VALID_INTERVAL_ENDED';
  } else if (policy.kind === 'BOUNDED') {
    if (input.validFrom === null || input.validTo === null) reason = 'BOUNDED_INTERVAL_UNKNOWN';
    else { state = 'CURRENT'; reason = 'WITHIN_SOURCE_VALID_INTERVAL'; }
  } else if (policy.reviewAfterDays === null) {
    state = 'CURRENT';
    reason = policy.kind === 'STABLE' ? 'STABLE_UNLESS_CORRECTED'
      : policy.kind === 'DECISION_HISTORY' ? 'RECORDED_DECISION_HISTORY' : 'UNRESOLVED_UNTIL_OUTCOME';
  } else {
    const age = Math.max(0, world - Date.parse(latest.assertedAt!));
    const reviewAfter = policy.reviewAfterDays * DAY;
    const uncertainty = latest.precision === 'DAY' ? DAY : latest.precision === 'MONTH' ? 31 * DAY : 0;
    if (latest.precision === 'APPROXIMATE' || (age >= reviewAfter && age - uncertainty < reviewAfter)) {
      reason = 'SOURCE_TIME_PRECISION_INSUFFICIENT';
    } else if (age >= reviewAfter) {
      state = 'VERIFY'; reason = policy.kind === 'UNRESOLVED' ? 'UNRESOLVED_REVIEW_DUE'
        : policy.kind === 'PREFERENCE' ? 'PREFERENCE_APPLICABILITY_UNCERTAIN'
          : policy.kind === 'INCIDENTAL' ? 'INCIDENTAL_CONTEXT_ONLY' : 'LAST_KNOWN_REVIEW_DUE';
      lowProminence = policy.kind === 'INCIDENTAL' && !input.decisionRelevant;
    } else { state = 'CURRENT'; reason = 'WITHIN_POLICY_REVIEW_WINDOW'; }
  }
  const result = freshnessAssessmentSchema.parse({
    policyId: policy?.policyId ?? null, policyVersion: policy?.policyVersion ?? null, kind: policy?.kind ?? null,
    evaluatorVersion: AGING_EVALUATOR_VERSION,
    releaseId: input.binding?.releaseId ?? null, releaseVersion: input.binding?.releaseVersion ?? null,
    releaseContentHash: input.binding?.releaseContentHash ?? null,
    state, evaluatedAt: input.evaluatedAt, worldTime: input.worldTime, knowledgeTime: input.knowledgeTime,
    basisAt: latest?.assertedAt ?? null, basisPrecision: latest?.precision ?? 'UNKNOWN',
    validFrom: input.validFrom, validTo: input.validTo,
    evidenceIds: [...new Set(basis.map(entry => entry.evidenceId))].sort(),
    claimIds: [...new Set(basis.map(entry => entry.claimId))].sort(),
    verificationRequired: state === 'VERIFY' && (policy?.verificationTrigger === 'WHEN_STALE'
      || (policy?.verificationTrigger === 'WHEN_RELEVANT' && input.decisionRelevant)),
    defaultProminence: lowProminence ? 'LOW' : 'NORMAL', reason,
  });
  Object.freeze(result.evidenceIds); Object.freeze(result.claimIds);
  return Object.freeze(result);
}

/** Exact immutable snapshot pin. A missing policy remains unknown; there is no
 * source-type fallback and no deployed dependency on file-based registry tools. */
export async function readAgingPolicy(tx: MemoryTransaction, input: {
  registryReleaseId: string | null; predicateId: string;
}): Promise<AgingPolicyBinding | null> {
  if (input.registryReleaseId === null) return null;
  const row = (await tx.query('SELECT unai_private.aging_policy($1,$2) AS binding',
    [input.registryReleaseId, input.predicateId])).rows[0];
  const parsed = agingPolicyBindingSchema.safeParse(row?.['binding']);
  return parsed.success ? parsed.data : null;
}
