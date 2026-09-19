import { evaluateFreshness, readAgingPolicy, type MemoryTransaction } from '@unai/memory';
import type { AgingPolicyBinding, FreshnessAssessment, FreshnessEvidence } from '@unai/domain';

type Instant = Date | string;
export interface ContextFreshnessBelief {
  readonly propositionId: string;
  readonly frameTypeId: string;
  readonly predicateId: string;
  readonly validFrom: Instant | null;
  readonly validTo: Instant | null;
  readonly claimIds: readonly string[];
  readonly evidenceIds: readonly string[];
}
export interface ContextFreshnessInput {
  readonly ownerScopeId: string;
  readonly registryReleaseId: string | null;
  readonly worldTime: Instant;
  readonly knowledgeTime: Instant;
  readonly evaluatedAt: Instant;
  readonly beliefs: readonly ContextFreshnessBelief[];
  readonly decisionRelevant: boolean;
}
const instant = (value: Instant): string => value instanceof Date ? value.toISOString() : new Date(value).toISOString();
const MAX_BELIEFS = 1000, MAX_CLAIMS = 4096, MAX_PER_BELIEF = 256;
const dateOrNull = (value: unknown): string | null => {
  if (!(value instanceof Date) && typeof value !== 'string') return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
};
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};

function originalEvidence(row: Record<string, unknown>, sameFact: boolean, quoted: boolean): FreshnessEvidence {
  const sourceTime = dateOrNull(row['occurred_at']);
  const evidence: FreshnessEvidence = { evidenceId: row['evidence_id'] as string, claimId: row['id'] as string,
    recordedAt: instant(row['recorded_at'] as Instant), assertedAt: sourceTime,
    precision: sourceTime === null ? 'UNKNOWN' : 'INSTANT', kind: 'SUPPORT_ONLY', original: null };
  if (!sameFact || object(row['actor_ref'])['type'] === 'ASSISTANT') return evidence;
  if (quoted) return { ...evidence, kind: 'QUOTATION' };
  switch (row['claim_origin']) {
    case 'USER_CONFIRMATION': case 'USER_CORRECTION': return { ...evidence, kind: 'CONFIRMATION' };
    case 'USER_STATEMENT': case 'EXTERNAL_PERSON_ASSERTION': case 'DOCUMENT_ASSERTION':
      return { ...evidence, kind: 'ASSERTION' };
    case 'STRUCTURED_CONNECTOR_OBSERVATION': case 'TOOL_EXECUTION_RECEIPT':
      return { ...evidence, kind: 'OBSERVATION' };
    case 'MODEL_EXTRACTION': {
      // The extractor records the original source reference alongside its span.
      // A processing timestamp or a merely asserted metadata clock cannot renew
      // it: the reference must equal the immutable source's own occurred_at.
      const reference = dateOrNull(object(row['metadata'])['assertionReferenceInstant']);
      const intervalEnd = dateOrNull(object(object(row['temporal_interpretation'])['normalizedTime'])['end']);
      const retrospective = sourceTime !== null && intervalEnd !== null && intervalEnd <= sourceTime;
      return { ...evidence, kind: 'RESTATEMENT', original: sourceTime !== null && reference === sourceTime && !retrospective
        ? { evidenceId: evidence.evidenceId, claimId: evidence.claimId, recordedAt: evidence.recordedAt,
          assertedAt: sourceTime, precision: 'INSTANT', kind: 'ASSERTION' } : null };
    }
    default: return evidence;
  }
}

/** Freshness never grants source authority: all claims and evidence must already
 * be admitted for this belief by the broker, then pass the source read boundary. */
export async function readContextFreshness(tx: MemoryTransaction, input: ContextFreshnessInput): Promise<{
  propositionId: string; assessment: FreshnessAssessment;
}[]> {
  if (input.beliefs.length > MAX_BELIEFS) throw new Error('FRESHNESS_BELIEF_LIMIT');
  const knowledgeTime = instant(input.knowledgeTime);
  const claimIds = [...new Set(input.beliefs.flatMap(belief => [...belief.claimIds]))];
  const propositionIds = [...new Set(input.beliefs.map(belief => belief.propositionId))];
  const overLimit = claimIds.length > MAX_CLAIMS;
  // The caller's exact authority set bounds this read. Joining source_items is
  // essential: claims themselves do not inherit source-purpose/ceiling RLS.
  const rows = claimIds.length === 0 || overLimit ? [] : (await tx.query(`
    SELECT c.id,c.claim_origin,c.recorded_at,c.metadata,c.temporal_interpretation,
      (history.state->>'proposition_id')::uuid AS proposition_id,history.state->>'lifecycle' AS lifecycle,
      a.source_item_id AS evidence_id,s.occurred_at,s.actor_ref,ctx.context_kind
    FROM claims c
    JOIN source_anchors a ON a.owner_scope_id=c.owner_scope_id AND a.id=c.source_anchor_id
    JOIN source_items s ON s.owner_scope_id=a.owner_scope_id AND s.id=a.source_item_id
    CROSS JOIN LATERAL (SELECT unai_private.object_state_at(c.owner_scope_id,'claims',c.id,$3) AS state) history
    LEFT JOIN propositions p ON p.owner_scope_id=c.owner_scope_id AND p.id=(history.state->>'proposition_id')::uuid
    LEFT JOIN belief_slots slot ON slot.owner_scope_id=p.owner_scope_id AND slot.id=p.belief_slot_id
    LEFT JOIN context_spaces ctx ON ctx.owner_scope_id=slot.owner_scope_id
      AND ctx.id=(unai_private.object_state_at(slot.owner_scope_id,'belief_slots',slot.id,$3)->>'context_space_id')::uuid
    WHERE c.owner_scope_id=$1 AND c.id=ANY($2::uuid[]) AND c.recorded_at<=$3
      AND history.state IS NOT NULL AND history.state->>'lifecycle' NOT IN ('REJECTED','SUPPRESSED','SUPERSEDED')
    ORDER BY c.id LIMIT $4`, [input.ownerScopeId, claimIds, knowledgeTime, MAX_CLAIMS + 1])).rows;
  const truncated = rows.length > MAX_CLAIMS;
  const byId = new Map((truncated ? [] : rows).map(row => [row['id'] as string, row]));
  // An explicit same-fact assertion may be linked without claim.proposition_id.
  // Other support kinds and all transitive DERIVE inputs remain SUPPORT_ONLY.
  const supportRows = byId.size === 0 ? [] : (await tx.query(`
    SELECT b.proposition_id,b.claim_id,ctx.context_kind FROM belief_support b
    JOIN propositions p ON p.owner_scope_id=b.owner_scope_id AND p.id=b.proposition_id
    JOIN belief_slots slot ON slot.owner_scope_id=p.owner_scope_id AND slot.id=p.belief_slot_id
    JOIN context_spaces ctx ON ctx.owner_scope_id=slot.owner_scope_id
      AND ctx.id=(unai_private.object_state_at(slot.owner_scope_id,'belief_slots',slot.id,$4)->>'context_space_id')::uuid
    WHERE b.owner_scope_id=$1 AND b.proposition_id=ANY($2::uuid[]) AND b.claim_id=ANY($3::uuid[])
      AND b.support_kind='DIRECT_ASSERTION' AND b.created_at<=$4 ORDER BY b.id LIMIT $5`,
  [input.ownerScopeId, propositionIds, [...byId.keys()], knowledgeTime, MAX_CLAIMS + 1])).rows;
  const supportTruncated = supportRows.length > MAX_CLAIMS;
  const directSupports = new Map((supportTruncated ? [] : supportRows)
    .map(row => [row['proposition_id'] + ':' + row['claim_id'], row['context_kind'] as string]));
  const policies = new Map<string, AgingPolicyBinding | null>();
  const output: { propositionId: string; assessment: FreshnessAssessment }[] = [];
  for (const belief of input.beliefs) {
    if (!policies.has(belief.predicateId)) policies.set(belief.predicateId,
      await readAgingPolicy(tx, { registryReleaseId: input.registryReleaseId, predicateId: belief.predicateId }));
    const binding = policies.get(belief.predicateId) ?? null;
    const evidenceIds = new Set(belief.evidenceIds);
    const bounded = !overLimit && !truncated && !supportTruncated && belief.claimIds.length <= MAX_PER_BELIEF;
    const evidence = bounded ? [...new Set(belief.claimIds)].flatMap(claimId => {
      const row = byId.get(claimId);
      if (!row || !evidenceIds.has(row['evidence_id'] as string)) return [];
      const linkedContext = directSupports.get(belief.propositionId + ':' + claimId);
      const ownAssertion = row['proposition_id'] === belief.propositionId;
      const contextKind = ownAssertion ? row['context_kind'] : linkedContext;
      const sameFact = (ownAssertion || linkedContext !== undefined) && contextKind !== null && contextKind !== undefined;
      return [originalEvidence(row, sameFact, contextKind !== 'BASE')];
    }) : [];
    output.push({ propositionId: belief.propositionId, assessment: evaluateFreshness({
      binding, frameTypeId: belief.frameTypeId, predicateId: belief.predicateId,
      evaluatedAt: instant(input.evaluatedAt), worldTime: instant(input.worldTime), knowledgeTime,
      validFrom: belief.validFrom === null ? null : instant(belief.validFrom),
      validTo: belief.validTo === null ? null : instant(belief.validTo),
      evidence, decisionRelevant: input.decisionRelevant,
    }) });
  }
  return output;
}
