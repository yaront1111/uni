import { z } from 'zod';

const semanticId = z.string().regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/);
const version = z.string().regex(/^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/);
export const agingKindSchema = z.enum(['STABLE', 'BOUNDED', 'LAST_KNOWN', 'PREFERENCE', 'UNRESOLVED', 'DECISION_HISTORY', 'INCIDENTAL']);
export const freshnessStateSchema = z.enum(['CURRENT', 'VERIFY', 'OUTSIDE_INTERVAL', 'UNKNOWN']);
export const freshnessPrecisionSchema = z.enum(['INSTANT', 'DAY', 'MONTH', 'APPROXIMATE', 'UNKNOWN']);
export const agingPolicySchema = z.strictObject({
  policyId: semanticId,
  policyVersion: version,
  kind: agingKindSchema,
  frameTypeId: semanticId,
  predicateId: semanticId,
  reviewAfterDays: z.number().finite().positive().max(36500).nullable(),
  verificationTrigger: z.enum(['NEVER', 'WHEN_RELEVANT', 'WHEN_STALE']),
  explanation: z.string().trim().min(1).max(2000),
}).superRefine((policy, ctx) => {
  if (['STABLE', 'BOUNDED', 'DECISION_HISTORY'].includes(policy.kind) && policy.reviewAfterDays !== null) {
    ctx.addIssue({ code: 'custom', path: ['reviewAfterDays'], message: 'POLICY_KIND_HAS_NO_REVIEW_CLOCK' });
  }
  if (['LAST_KNOWN', 'PREFERENCE', 'INCIDENTAL'].includes(policy.kind) && policy.reviewAfterDays === null) {
    ctx.addIssue({ code: 'custom', path: ['reviewAfterDays'], message: 'POLICY_REVIEW_INTERVAL_REQUIRED' });
  }
});
export const agingPolicyBindingSchema = z.strictObject({
  releaseId: z.uuid(), releaseVersion: version, releaseContentHash: z.string().regex(/^[a-f0-9]{64}$/),
  policy: agingPolicySchema,
});

const originalFreshnessEvidenceSchema = z.strictObject({
  evidenceId: z.uuid(), claimId: z.uuid(), recordedAt: z.iso.datetime(),
  assertedAt: z.iso.datetime().nullable(), precision: freshnessPrecisionSchema,
  kind: z.enum(['ASSERTION', 'CONFIRMATION', 'OBSERVATION']),
});
/** Callers supply only authorized same-fact original assertions. A summary,
 * quote or processing run is never a new assertion by virtue of its timestamp. */
export const freshnessEvidenceSchema = originalFreshnessEvidenceSchema.extend({
  kind: z.enum(['ASSERTION', 'CONFIRMATION', 'OBSERVATION', 'RESTATEMENT', 'QUOTATION', 'SUPPORT_ONLY']),
  original: originalFreshnessEvidenceSchema.nullable(),
});

export const freshnessAssessmentSchema = z.strictObject({
  policyId: semanticId.nullable(), policyVersion: version.nullable(), kind: agingKindSchema.nullable(),
  evaluatorVersion: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/),
  releaseId: z.uuid().nullable(), releaseVersion: version.nullable(), releaseContentHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  state: freshnessStateSchema,
  evaluatedAt: z.iso.datetime(), worldTime: z.iso.datetime(), knowledgeTime: z.iso.datetime(),
  basisAt: z.iso.datetime().nullable(), basisPrecision: freshnessPrecisionSchema,
  validFrom: z.iso.datetime().nullable(), validTo: z.iso.datetime().nullable(),
  evidenceIds: z.array(z.uuid()).max(256), claimIds: z.array(z.uuid()).max(256),
  verificationRequired: z.boolean(), defaultProminence: z.enum(['NORMAL', 'LOW']),
  reason: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/),
});
export type AgingKind = z.infer<typeof agingKindSchema>;
export type FreshnessState = z.infer<typeof freshnessStateSchema>;
export type AgingPolicy = z.infer<typeof agingPolicySchema>;
export type AgingPolicyBinding = z.infer<typeof agingPolicyBindingSchema>;
export type FreshnessEvidence = z.infer<typeof freshnessEvidenceSchema>;
export type FreshnessAssessment = z.infer<typeof freshnessAssessmentSchema>;
