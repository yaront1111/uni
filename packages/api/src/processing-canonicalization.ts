import type { OwnerTransaction } from '@unai/postgres';
import type { TemporalInterpretation } from '@unai/domain';
import { classifyCommitmentLanguage, resolveOwnerEntity } from '@unai/capabilities';
import { canonicalizeClaim, recordClaim, recordFrameInstanceRole, resolveBeliefSlot, resolveEntity,
  resolveProposition, resolveTemporalExpression } from '@unai/memory';

export interface ProcessedAssertion { propositionId: string; claimId: string; frameInstanceId: string; validFrom: string | null }

function interpret(text: string | null, reference: Date | null, zone: string | null): TemporalInterpretation | null {
  if (!text) return null;
  try {
    if (reference && zone) return resolveTemporalExpression({ text, reference, timeZone: zone });
    // An explicit offset-bearing instant is self-contained. No relative phrase
    // reaches this branch and no import/processing clock supplies missing time.
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(text)) {
      return resolveTemporalExpression({ text, reference: new Date(text), timeZone: 'UTC' });
    }
  } catch { /* Unknown source timezone remains unknown. */ }
  return null;
}

/** The first supported semantic path. A model only identifies grounded spans;
 * the delivered commitment classifier, entity/instance resolvers and governor
 * decide what can be represented and how strongly it may be used. */
export async function canonicalizeProcessingClaims(tx: OwnerTransaction, input: {
  sourceItemId: string; extractionRunId: string; registryReleaseId: string;
  referenceInstant: Date | null; timeZone: string | null;
}): Promise<{ assertions: ProcessedAssertion[]; unresolved: number }> {
  const ownerScopeId = tx.context.ownerScopeId;
  const source = (await tx.query(`SELECT s.actor_ref,s.source_type,t.routing_reason->>'newContentLength' AS content_length
    FROM source_items s JOIN triage_decisions t ON t.owner_scope_id=s.owner_scope_id AND t.source_item_id=s.id
    WHERE s.owner_scope_id=$1 AND s.id=$2`,
    [ownerScopeId, input.sourceItemId])).rows[0];
  if (!source) throw new Error('PROCESSING_SOURCE_UNAVAILABLE');
  const claims = (await tx.query(`SELECT c.id,c.source_anchor_id,c.candidate_frame_type_id,c.extraction_confidence,
      a.normalized_text FROM claims c JOIN source_anchors a ON a.owner_scope_id=c.owner_scope_id AND a.id=c.source_anchor_id
    WHERE c.owner_scope_id=$1 AND c.extraction_run_id=$2 AND c.proposition_id IS NULL AND a.source_item_id=$3 ORDER BY c.id`,
  [ownerScopeId, input.extractionRunId, input.sourceItemId])).rows;
  const assertions: ProcessedAssertion[] = [];
  let unresolved = Number(source.content_length) > 8192 ? 1 : 0;
  for (const claim of claims) {
    const quote = typeof claim.normalized_text === 'string' ? claim.normalized_text : '';
    const reading = classifyCommitmentLanguage(quote);
    // A document's submitting account is not evidence of its author's identity.
    // Reported speech and ambiguous third-person undertakings also stay pending.
    if (claim.candidate_frame_type_id !== 'shared.commitment' || source.source_type === 'DOCUMENT'
      || reading.language !== 'COMMITMENT' || !/^I(?:['’]ll| will| am going to|['’]m going to| shall| promise| commit| undertake)\b/i.test(quote.trim())) {
      unresolved++; continue;
    }
    const actor = source.actor_ref as { type: string; id: string };
    let entityId: string;
    if (actor.type === 'USER' && actor.id === tx.context.actorId) {
      entityId = await resolveOwnerEntity(tx, { ownerScopeId, actorId: actor.id });
    } else if (actor.type === 'EXTERNAL' && source.source_type === 'GMAIL') {
      const address = /[^\s<>]+@[^\s<>]+/.exec(actor.id)?.[0];
      if (!address) { unresolved++; continue; }
      const entity = await resolveEntity(tx, { ownerScopeId, entityKind: 'PERSON', aliases: [{ aliasType: 'EMAIL',
        aliasValue: address, sourceItemId: input.sourceItemId, ...(input.referenceInstant ? { validFrom: input.referenceInstant } : {}) }] });
      if (entity.outcome !== 'NEW_ENTITY' && !entity.identityEstablished) { unresolved++; continue; }
      entityId = entity.entityId;
    } else { unresolved++; continue; }
    const common = { ownerScopeId, sourceAnchorId: claim.source_anchor_id as string, claimOrigin: 'MODEL_EXTRACTION' as const,
      extractionRunId: input.extractionRunId, assertedByEntityId: entityId, validFrom: input.referenceInstant,
      extractionConfidence: Number(claim.extraction_confidence), entityResolutionConfidence: 1,
      metadata: { originalCandidateClaimId: claim.id, originalAssertionAt: input.referenceInstant?.toISOString() ?? null,
        originalTimeZone: input.timeZone, normalizationSource: 'CHECKED_SOURCE_SPAN' } };
    const action = await canonicalizeClaim(tx, { ...common,
      frameTypeId: 'shared.commitment', predicateId: 'shared.commitment.action_description', modality: 'COMMITTED',
      normalizedValue: { text: reading.actionDescription ?? quote }, statement: quote,
      registryReleaseId: input.registryReleaseId, roles: [{ roleId: 'promisor', entityId }], identityAnchorRoles: ['promisor'],
      materiality: 'MATERIAL_ACCEPTED_UPDATE',
    });
    if (action.instanceMatch.outcome === 'POSSIBLE_MATCH' || action.instanceMatch.outcome === 'PROBABLE_MATCH') {
      unresolved++; continue;
    }
    await recordFrameInstanceRole(tx, { ownerScopeId, frameInstanceId: action.frameInstanceId,
      roleId: 'promisor', entityId, claimId: action.claimId, validFrom: input.referenceInstant });
    assertions.push({ propositionId: action.propositionId, claimId: action.claimId,
      frameInstanceId: action.frameInstanceId, validFrom: input.referenceInstant?.toISOString() ?? null });
    const temporal = interpret(reading.dueTimeText, input.referenceInstant, input.timeZone);
    if (!temporal) { if (reading.dueTimeText) unresolved++; continue; }
    const slot = await resolveBeliefSlot(tx, { ownerScopeId, registryReleaseId: input.registryReleaseId,
      descriptor: { frameInstanceId: action.frameInstanceId, predicateId: 'shared.commitment.due_time',
        contextSpaceId: action.context.contextSpaceId, modality: 'COMMITTED', qualifiers: {} } });
    const due = await resolveProposition(tx, { ownerScopeId, beliefSlotId: slot.beliefSlotId,
      registryReleaseId: input.registryReleaseId, normalizedValue: { ...temporal.normalizedTime, precision: temporal.precision, timeZone: temporal.timeZone } });
    const dueClaim = await recordClaim(tx, { ...common, propositionId: due.propositionId, candidateFrameTypeId: 'shared.commitment',
      lifecycle: 'CANDIDATE', temporalInterpretation: temporal, temporalResolutionConfidence: temporal.confidence });
    assertions.push({ propositionId: due.propositionId, claimId: dueClaim,
      frameInstanceId: action.frameInstanceId, validFrom: input.referenceInstant?.toISOString() ?? null });
  }
  return { assertions, unresolved };
}
