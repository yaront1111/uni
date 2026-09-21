import type { ContextRequest } from '@unai/domain';
import type { MemoryTransaction } from '@unai/memory';
import { selectCurrentStates } from './selector.js';
import type { PropositionAuthority } from './support-authority.js';

/** Restrict candidates using independent, authorized canonical state. This does
 * not alter selection, evidence authority, modality or certainty rules. */
export async function obligationQueryFrames(tx: MemoryTransaction, input: {
  request: ContextRequest; frameIds: string[]; authority: Map<string, PropositionAuthority>;
  worldTime: Date; knowledgeTime: Date; registryReleaseId: string | null;
  withheldObjects: ReadonlySet<string>; withheldFields: ReadonlyMap<string, ReadonlySet<string>>;
  removedObjects: ReadonlySet<string>;
}): Promise<string[]> {
  const query = input.request.referenceQuery;
  if (!query) return input.frameIds;
  if (query.kind === 'UNRESOLVED') return [];
  const owner = input.request.ownerScopeId;
  const entities = (await tx.query(`SELECT id FROM entities WHERE owner_scope_id=$1
    AND (($2::uuid IS NOT NULL AND id=$2) OR ($3::text IS NOT NULL AND canonical_label=$3))
    AND created_at<=$4 ORDER BY id LIMIT 2`, [owner,
    'entityId' in query.creditor ? query.creditor.entityId : null,
    'canonicalLabel' in query.creditor ? query.creditor.canonicalLabel : null, input.knowledgeTime])).rows;
  if (entities.length !== 1) return [];
  const creditor = entities[0]!['id'] as string;
  const blocked = (id: string) => input.withheldObjects.has(id) || input.removedObjects.has(id)
    || input.withheldFields.has(id);
  if (blocked(creditor)) return [];
  const sourceIds = [...new Set([...input.authority.values()].flatMap(value => value.evidenceIds))];
  const independentSources = new Set((await tx.query(`SELECT id FROM source_items WHERE owner_scope_id=$1
    AND id=ANY($2::uuid[]) AND source_type<>'ASSISTANT_CONVERSATION'
    AND coalesce(actor_ref->>'type','')<>'ASSISTANT'`, [owner, sourceIds])).rows.map(row => row['id'] as string));
  const independent = new Map([...input.authority].filter(([, proof]) => proof.readable
    && proof.evidenceIds.length > 0 && proof.evidenceIds.every(id => independentSources.has(id) && !blocked(id))));
  const claims = [...new Set([...independent.values()].flatMap(value => value.claimIds))].filter(id => !blocked(id));
  // A role needs its own independent readable assertion, valid at both request
  // instants. Transcript records and assistant-authored source items cannot qualify.
  const roles = (await tx.query(`SELECT r.id,r.frame_instance_id,r.claim_id,
      (unai_private.object_state_at(c.owner_scope_id,'claims',c.id,$5)->>'proposition_id')::uuid AS proposition_id
    FROM frame_instance_roles r JOIN claims c ON c.owner_scope_id=r.owner_scope_id AND c.id=r.claim_id
    JOIN source_anchors a ON a.owner_scope_id=c.owner_scope_id AND a.id=c.source_anchor_id
    JOIN source_items s ON s.owner_scope_id=a.owner_scope_id AND s.id=a.source_item_id
    WHERE r.owner_scope_id=$1 AND r.entity_id=$2 AND r.role_id='creditor'
      AND r.frame_instance_id=ANY($3::uuid[]) AND r.claim_id=ANY($4::uuid[])
      AND r.created_at<=$5 AND c.recorded_at<=$5
      AND (r.valid_from IS NULL OR r.valid_from<=$6) AND (r.valid_to IS NULL OR r.valid_to>$6)
      AND s.source_type<>'ASSISTANT_CONVERSATION' AND coalesce(s.actor_ref->>'type','')<>'ASSISTANT'
    ORDER BY r.id`, [owner, creditor, input.frameIds, claims, input.knowledgeTime, input.worldTime])).rows;
  const withheld = new Set([...input.withheldObjects, ...input.removedObjects,
    ...[...input.withheldFields].filter(([, fields]) => fields.has('normalizedValue')).map(([id]) => id),
    ...[...input.authority.keys()].filter(id => !independent.has(id))]);
  const states = await selectCurrentStates(tx, { ownerScopeId: owner, frameInstanceIds: input.frameIds,
    registryReleaseId: input.registryReleaseId, parameters: { worldTime: input.worldTime.toISOString(),
      knowledgeTime: input.knowledgeTime.toISOString(), modalities: ['ACTUAL'],
      admitProvisional: input.request.requiredCertainty.includes('PROVISIONAL') },
    withheldPropositionIds: withheld, outOfViewPropositionIds: new Set(), overlayDeltas: [], allowedClaimIds: new Set(claims) });
  const selected = new Set(states.filter(state => state.outcome === 'SELECTED'
    && (state.evidenceIds?.length ?? 0) > 0).map(state => state.selectedPropositionId));
  const owned = new Set(roles.filter(row => !blocked(row['id'] as string) && !blocked(row['claim_id'] as string)
    && selected.has(row['proposition_id'] as string)).map(row => row['frame_instance_id'] as string));
  if (!query.due) return input.frameIds.filter(id => owned.has(id));
  const { from, to } = query.due;
  const dueFrames = new Set(states.filter(state => {
    if (state.predicateId !== 'shared.obligation.due_time' || state.outcome !== 'SELECTED'
      || !state.selectedPropositionId || !selected.has(state.selectedPropositionId) || blocked(state.selectedPropositionId)) return false;
    const value = state.selectedValue as { time?: unknown } | undefined;
    const time = typeof value?.time === 'string' ? Date.parse(value.time) : NaN;
    return time >= Date.parse(from) && time < Date.parse(to);
  }).map(state => state.frameInstanceId));
  return input.frameIds.filter(id => owned.has(id) && dueFrames.has(id));
}
