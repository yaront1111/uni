import {
  inspectorEvidenceSchema, memoryInspectorSchema, relatedFramesSchema,
  type InspectableObjectType, type MemoryInspector, type RelatedFrame, type RelatedFrames, type TargetObjectRef,
} from '@unai/domain';
import { listMemoryOperations, type MemoryTransaction } from '@unai/memory';
import { ContextBrokerError } from './broker.js';
import { explainProposition } from './explain.js';

/**
 * The Memory inspector and the related context of the Commitments and
 * Obligations screens (PRD §7.3, §7.6, §37.1; ADR 0028).
 *
 * The inspector is the ADR 0022 explanation plus the sections PRD §7.6 lists
 * that the explanation does not carry: who asserted each claim, the original
 * evidence with the text of its anchors, the inferences the belief takes part
 * in, the threads it belongs to, who has read it, and what the owner already did
 * to it. Everything is read from rows that exist; nothing is computed anew.
 *
 * Evidence is read through the row policies with the request's data purpose and
 * ceiling already set by the caller, so an item this request may not read is not
 * returned. It is counted instead, which is the difference between "withheld"
 * and "absent".
 */

export const INSPECTOR_VERSION = 'memory-inspector-0.1.0';

/** How many audit rows the access history lists, newest first. */
const ACCESS_HISTORY_LIMIT = 50;

const iso = (value: unknown): string | null => value instanceof Date ? value.toISOString() : null;
const number = (value: unknown): number | null => value === null || value === undefined ? null : Number(value);

/** The belief an inspected object is about, and the target a correction names.
 * A frame, a resolution or a delta is inspected through the first belief it
 * carries, ordered by predicate so the choice is stable across reads. */
async function resolveSubject(tx: MemoryTransaction, ownerScopeId: string, objectType: InspectableObjectType,
  objectId: string, depth = 0): Promise<{ propositionId: string; correctionTarget: TargetObjectRef }> {
  const firstOfFrame = async (frameInstanceId: string): Promise<string | null> => ((await tx.query(
    `SELECT p.id FROM propositions p JOIN belief_slots s ON s.owner_scope_id=p.owner_scope_id AND s.id=p.belief_slot_id
     WHERE p.owner_scope_id=$1 AND s.frame_instance_id=$2 ORDER BY s.predicate_id,p.created_at,p.id LIMIT 1`,
    [ownerScopeId, frameInstanceId])).rows[0]?.['id'] as string | undefined) ?? null;
  const unresolved = () => new ContextBrokerError('INSPECTOR_TARGET_NOT_FOUND');
  switch (objectType) {
    case 'proposition': {
      const row = (await tx.query('SELECT id FROM propositions WHERE owner_scope_id=$1 AND id=$2', [ownerScopeId, objectId])).rows[0];
      if (!row) throw unresolved();
      return { propositionId: objectId, correctionTarget: { objectType: 'proposition', objectId } };
    }
    case 'claim': {
      const row = (await tx.query('SELECT proposition_id FROM claims WHERE owner_scope_id=$1 AND id=$2', [ownerScopeId, objectId])).rows[0];
      // A claim no belief took up -- an assistant's invented fact, say -- is
      // conversation evidence and nothing more: there is no belief to inspect.
      if (!row || !row['proposition_id']) throw unresolved();
      return { propositionId: row['proposition_id'] as string, correctionTarget: { objectType: 'claim', objectId } };
    }
    case 'frame_instance': {
      const propositionId = await firstOfFrame(objectId);
      if (!propositionId) throw unresolved();
      return { propositionId, correctionTarget: { objectType: 'proposition', objectId: propositionId } };
    }
    case 'resolution_assertion': {
      const row = (await tx.query(
        'SELECT source_proposition_id,source_frame_instance_id FROM resolution_assertions WHERE owner_scope_id=$1 AND id=$2',
        [ownerScopeId, objectId])).rows[0];
      if (!row) throw unresolved();
      const propositionId = (row['source_proposition_id'] as string | null) ?? await firstOfFrame(row['source_frame_instance_id'] as string);
      if (!propositionId) throw unresolved();
      return { propositionId, correctionTarget: { objectType: 'resolution_assertion', objectId } };
    }
    case 'owner_overlay_delta': {
      const row = (await tx.query(
        'SELECT target_object_type,target_object_id,attached_frame_instance_id FROM owner_overlay_deltas WHERE owner_scope_id=$1 AND id=$2',
        [ownerScopeId, objectId])).rows[0];
      if (!row || depth > 0) throw unresolved();
      const targetType = row['target_object_type'] as string | null;
      if (targetType === 'proposition' || targetType === 'claim' || targetType === 'frame_instance' || targetType === 'resolution_assertion') {
        return resolveSubject(tx, ownerScopeId, targetType, row['target_object_id'] as string, depth + 1);
      }
      if (row['attached_frame_instance_id']) {
        return resolveSubject(tx, ownerScopeId, 'frame_instance', row['attached_frame_instance_id'] as string, depth + 1);
      }
      // An unattached owner statement names no belief yet (PRD §14.2).
      throw unresolved();
    }
  }
}

/** The evidence behind a set of claims, with the text of the anchors they cite.
 * Rows the request may not read are filtered out by the evidence policy and
 * reported only as a count. */
async function evidenceForClaims(tx: MemoryTransaction, ownerScopeId: string, claimIds: readonly string[]) {
  if (claimIds.length === 0) return { evidence: [], withheld: 0 };
  // Anchors carry no policy of their own beyond owner access; the join to
  // source_items is what applies the evidence gate.
  const anchorRows = (await tx.query(
    `SELECT DISTINCT a.id,a.source_item_id,a.anchor_kind,a.normalized_text FROM claims c
     JOIN source_anchors a ON a.owner_scope_id=c.owner_scope_id AND a.id=c.source_anchor_id
     WHERE c.owner_scope_id=$1 AND c.id=ANY($2::uuid[]) ORDER BY a.source_item_id,a.id`,
    [ownerScopeId, [...claimIds]])).rows;
  const evidenceIds = [...new Set(anchorRows.map(row => row['source_item_id'] as string))];
  if (evidenceIds.length === 0) return { evidence: [], withheld: 0 };
  const itemRows = (await tx.query(
    `SELECT id,source_type,sensitivity,occurred_at,observed_at FROM source_items
     WHERE owner_scope_id=$1 AND id=ANY($2::uuid[]) ORDER BY coalesce(occurred_at,observed_at),id`,
    [ownerScopeId, evidenceIds])).rows;
  const evidence = itemRows.map(row => inspectorEvidenceSchema.parse({
    evidenceId: row['id'], sourceType: row['source_type'], sensitivity: row['sensitivity'],
    occurredAt: iso(row['occurred_at']), observedAt: iso(row['observed_at']),
    anchors: anchorRows.filter(anchor => anchor['source_item_id'] === row['id']).slice(0, 64).map(anchor => ({
      sourceAnchorId: anchor['id'], anchorKind: anchor['anchor_kind'],
      text: typeof anchor['normalized_text'] === 'string' ? (anchor['normalized_text'] as string).slice(0, 2000) : null,
    })),
  }));
  return { evidence, withheld: evidenceIds.length - evidence.length };
}

async function entities(tx: MemoryTransaction, ownerScopeId: string, entityIds: readonly string[]) {
  if (entityIds.length === 0) return [];
  return (await tx.query('SELECT id,entity_kind,canonical_label FROM entities WHERE owner_scope_id=$1 AND id=ANY($2::uuid[]) ORDER BY id',
    [ownerScopeId, [...new Set(entityIds)]])).rows.map(row => ({
    entityId: row['id'] as string, entityKind: row['entity_kind'] as string,
    canonicalLabel: (row['canonical_label'] as string | null) ?? null,
  }));
}

export async function inspectMemory(tx: MemoryTransaction, input: {
  ownerScopeId: string; objectType: InspectableObjectType; objectId: string; readAt: Date; registryRelease?: string | null;
}): Promise<MemoryInspector> {
  const owner = input.ownerScopeId;
  const subject = await resolveSubject(tx, owner, input.objectType, input.objectId);
  const explanation = await explainProposition(tx, {
    ownerScopeId: owner, propositionId: subject.propositionId, readAt: input.readAt,
    registryRelease: input.registryRelease ?? null,
  });
  const claimIds = explanation.claims.map(claim => claim.claimId);

  const confidenceRows = claimIds.length === 0 ? [] : (await tx.query(
    `SELECT id,extraction_confidence,entity_resolution_confidence,temporal_resolution_confidence,instance_resolution_confidence
     FROM claims WHERE owner_scope_id=$1 AND id=ANY($2::uuid[]) ORDER BY recorded_at,id`, [owner, claimIds])).rows;

  const { evidence, withheld } = await evidenceForClaims(tx, owner, claimIds);

  // Inferences in both directions: what this belief was derived from, and which
  // derived beliefs rest on it or on one of its claims.
  const inferenceRows = (await tx.query(
    `SELECT d.id,d.derived_proposition_id,d.input_claim_ids,d.input_proposition_ids,d.evaluator_id,d.model_or_code_version,
       d.registry_release_id,d.created_at,
       (SELECT b.assessment_status FROM belief_assessments b WHERE b.owner_scope_id=d.owner_scope_id
         AND b.proposition_id=d.derived_proposition_id AND b.superseded_recorded_at IS NULL
         ORDER BY b.recorded_at DESC,b.id DESC LIMIT 1) AS derived_status
     FROM derived_proposition_dependencies d
     WHERE d.owner_scope_id=$1 AND (d.derived_proposition_id=$2 OR $2=ANY(d.input_proposition_ids)
       OR d.input_claim_ids && $3::uuid[])
     ORDER BY d.created_at,d.id LIMIT 200`, [owner, subject.propositionId, claimIds])).rows;

  // Threads: memberships of the belief itself, of its claims and of its frame.
  const threadRows = (await tx.query(
    `SELECT t.id,t.display_title,t.lifecycle,m.membership_kind,m.object_type FROM memory_thread_members m
     JOIN memory_threads t ON t.owner_scope_id=m.owner_scope_id AND t.id=m.memory_thread_id
     WHERE m.owner_scope_id=$1 AND ((m.object_type='proposition' AND m.object_id=$2)
       OR (m.object_type='frame_instance' AND m.object_id=$3) OR (m.object_type='claim' AND m.object_id=ANY($4::uuid[])))
     ORDER BY t.created_at,t.id,m.object_type LIMIT 100`,
    [owner, subject.propositionId, explanation.frameInstanceId, claimIds])).rows;
  const seenThreads = new Set<string>();

  // Access history: audit rows naming the belief, a claim of it or its frame,
  // and the answers given with it in context (ADR 0028 §2).
  const named = [subject.propositionId, explanation.frameInstanceId, ...claimIds].map(id => JSON.stringify([{ id }]));
  const auditRows = (await tx.query(
    `SELECT id,purpose,result,created_at,objects_and_fields_accessed FROM audit_events
     WHERE owner_scope_id=$1 AND objects_and_fields_accessed @> ANY($2::jsonb[])
     ORDER BY created_at DESC,id DESC LIMIT ${ACCESS_HISTORY_LIMIT}`, [owner, named])).rows;
  const manifestRows = (await tx.query(
    `SELECT id,created_at FROM answer_manifests WHERE owner_scope_id=$1 AND $2=ANY(belief_ids)
     ORDER BY created_at DESC,id DESC LIMIT 50`, [owner, subject.propositionId])).rows;
  const namedIds = new Set([subject.propositionId, explanation.frameInstanceId, ...claimIds]);

  const operations = [
    ...await listMemoryOperations(tx, { ownerScopeId: owner, target: { objectType: 'proposition', objectId: subject.propositionId } }),
    ...await listMemoryOperations(tx, { ownerScopeId: owner, target: { objectType: 'frame_instance', objectId: explanation.frameInstanceId } }),
    ...(await Promise.all(claimIds.map(claimId =>
      listMemoryOperations(tx, { ownerScopeId: owner, target: { objectType: 'claim', objectId: claimId } })))).flat(),
  ].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.memoryOperationId.localeCompare(right.memoryOperationId));

  return memoryInspectorSchema.parse({
    subject: { requestedType: input.objectType, requestedId: input.objectId, propositionId: subject.propositionId,
      correctionTarget: subject.correctionTarget },
    explanation,
    assertingActors: await entities(tx, owner, explanation.claims
      .map(claim => claim.assertedByEntityId).filter((id): id is string => id !== null)),
    claimConfidences: confidenceRows.map(row => ({
      claimId: row['id'], extraction: number(row['extraction_confidence']),
      entityResolution: number(row['entity_resolution_confidence']),
      temporalResolution: number(row['temporal_resolution_confidence']),
      instanceResolution: number(row['instance_resolution_confidence']),
    })),
    originalEvidence: evidence,
    withheldEvidenceCount: withheld,
    inferences: inferenceRows.map(row => ({
      dependencyId: row['id'],
      role: row['derived_proposition_id'] === subject.propositionId ? 'DERIVED_FROM_INPUTS' : 'INPUT_TO_DERIVED',
      derivedPropositionId: row['derived_proposition_id'],
      derivedAssessmentStatus: (row['derived_status'] as string | null) ?? null,
      inputClaimIds: (row['input_claim_ids'] as string[] | null) ?? [],
      inputPropositionIds: (row['input_proposition_ids'] as string[] | null) ?? [],
      evaluatorId: row['evaluator_id'], modelOrCodeVersion: row['model_or_code_version'],
      registryReleaseId: (row['registry_release_id'] as string | null) ?? null,
      createdAt: iso(row['created_at']),
    })),
    connectedThreads: threadRows.filter(row => {
      if (seenThreads.has(row['id'] as string)) return false;
      seenThreads.add(row['id'] as string); return true;
    }).map(row => ({
      memoryThreadId: row['id'], displayTitle: (row['display_title'] as string | null) ?? null,
      lifecycle: row['lifecycle'], membershipKind: row['membership_kind'], memberObjectType: row['object_type'],
    })),
    accessHistory: [
      ...auditRows.map(row => ({
        kind: 'AUDIT_EVENT' as const, id: row['id'] as string, at: iso(row['created_at'])!,
        purpose: row['purpose'] as string, result: row['result'] as string,
        fields: [...new Set(((row['objects_and_fields_accessed'] ?? []) as Array<{ id?: string; fields?: string[] }>)
          .filter(entry => entry.id !== undefined && namedIds.has(entry.id))
          .flatMap(entry => entry.fields ?? []))].slice(0, 64),
      })),
      ...manifestRows.map(row => ({
        kind: 'ANSWER_MANIFEST' as const, id: row['id'] as string, at: iso(row['created_at'])!,
        purpose: null, result: null, fields: ['belief_ids'],
      })),
    ].sort((left, right) => right.at.localeCompare(left.at) || left.id.localeCompare(right.id)).slice(0, 100),
    memoryOperations: operations.slice(0, 200).map(operation => ({
      memoryOperationId: operation.memoryOperationId, operationKind: operation.operationKind, target: operation.target,
      overlayDeltaId: operation.overlayDeltaId, transactionId: operation.transactionId, createdAt: operation.createdAt,
    })),
    inspectorVersion: INSPECTOR_VERSION,
    readAt: input.readAt.toISOString(),
  });
}

/** The people, sources, resolution evidence, beliefs and threads of a set of
 * frame instances: what the Commitments and Obligations screens show beside
 * each typed projection row (ADR 0028 §1). */
export async function readRelatedFrames(tx: MemoryTransaction, input: {
  ownerScopeId: string; frameInstanceIds: readonly string[]; readAt: Date;
}): Promise<RelatedFrames> {
  const owner = input.ownerScopeId;
  const ids = [...new Set(input.frameInstanceIds)].slice(0, 100);
  if (ids.length === 0) return relatedFramesSchema.parse({ frames: [], readAt: input.readAt.toISOString() });
  const frameRows = (await tx.query(
    'SELECT id,frame_type_id,lifecycle FROM frame_instances WHERE owner_scope_id=$1 AND id=ANY($2::uuid[]) ORDER BY created_at,id',
    [owner, ids])).rows;
  const roleRows = (await tx.query(
    `SELECT frame_instance_id,role_id,entity_id FROM frame_instance_roles
     WHERE owner_scope_id=$1 AND frame_instance_id=ANY($2::uuid[]) AND entity_id IS NOT NULL ORDER BY role_id,entity_id`,
    [owner, ids])).rows;
  const beliefRows = (await tx.query(
    `SELECT s.frame_instance_id,p.id,s.predicate_id,s.modality,
       (SELECT b.assessment_status FROM belief_assessments b WHERE b.owner_scope_id=p.owner_scope_id
         AND b.proposition_id=p.id AND b.superseded_recorded_at IS NULL ORDER BY b.recorded_at DESC,b.id DESC LIMIT 1) AS status
     FROM propositions p JOIN belief_slots s ON s.owner_scope_id=p.owner_scope_id AND s.id=p.belief_slot_id
     WHERE p.owner_scope_id=$1 AND s.frame_instance_id=ANY($2::uuid[]) ORDER BY s.predicate_id,p.created_at,p.id`,
    [owner, ids])).rows;
  const claimRows = (await tx.query(
    `SELECT s.frame_instance_id,c.id FROM claims c
     JOIN propositions p ON p.owner_scope_id=c.owner_scope_id AND p.id=c.proposition_id
     JOIN belief_slots s ON s.owner_scope_id=p.owner_scope_id AND s.id=p.belief_slot_id
     WHERE c.owner_scope_id=$1 AND s.frame_instance_id=ANY($2::uuid[]) ORDER BY c.recorded_at,c.id`, [owner, ids])).rows;
  const resolutionRows = (await tx.query(
    `SELECT id,source_frame_instance_id,outcome_code,effective_at,lifecycle,asserted_by_entity_id,claim_id
     FROM resolution_assertions WHERE owner_scope_id=$1 AND source_frame_instance_id=ANY($2::uuid[])
     ORDER BY effective_at,id`, [owner, ids])).rows;
  const threadRows = (await tx.query(
    `SELECT DISTINCT m.object_id,t.id,t.display_title,t.created_at FROM memory_thread_members m
     JOIN memory_threads t ON t.owner_scope_id=m.owner_scope_id AND t.id=m.memory_thread_id
     WHERE m.owner_scope_id=$1 AND m.object_type='frame_instance' AND m.object_id=ANY($2::uuid[])
     ORDER BY t.created_at,t.id`, [owner, ids])).rows;
  const people = await entities(tx, owner, [
    ...roleRows.map(row => row['entity_id'] as string),
    ...resolutionRows.map(row => row['asserted_by_entity_id'] as string),
  ]);
  const person = (entityId: string) => people.find(entry => entry.entityId === entityId) ?? null;

  const frames: RelatedFrame[] = [];
  for (const frame of frameRows) {
    const frameId = frame['id'] as string;
    const sources = await evidenceForClaims(tx, owner,
      claimRows.filter(row => row['frame_instance_id'] === frameId).map(row => row['id'] as string));
    const resolutions = [];
    for (const row of resolutionRows.filter(entry => entry['source_frame_instance_id'] === frameId)) {
      const grounded = await evidenceForClaims(tx, owner, [row['claim_id'] as string]);
      resolutions.push({
        resolutionAssertionId: row['id'], outcomeCode: row['outcome_code'], effectiveAt: iso(row['effective_at']),
        lifecycle: row['lifecycle'], assertedBy: person(row['asserted_by_entity_id'] as string),
        claimId: row['claim_id'], evidence: grounded.evidence.slice(0, 20),
      });
    }
    frames.push({
      frameInstanceId: frameId, frameTypeId: frame['frame_type_id'] as string, lifecycle: frame['lifecycle'] as string,
      people: roleRows.filter(row => row['frame_instance_id'] === frameId).flatMap(row => {
        const found = person(row['entity_id'] as string);
        return found ? [{ ...found, roleId: row['role_id'] as string }] : [];
      }).slice(0, 50),
      sources: sources.evidence.slice(0, 50), withheldSourceCount: sources.withheld,
      resolutions: resolutions as RelatedFrame['resolutions'],
      beliefs: beliefRows.filter(row => row['frame_instance_id'] === frameId).slice(0, 100).map(row => ({
        propositionId: row['id'] as string, predicateId: row['predicate_id'] as string, modality: row['modality'] as string,
        assessmentStatus: (row['status'] as string | null) ?? null,
      })),
      threads: threadRows.filter(row => row['object_id'] === frameId).slice(0, 50).map(row => ({
        memoryThreadId: row['id'] as string, displayTitle: (row['display_title'] as string | null) ?? null,
      })),
    });
  }
  return relatedFramesSchema.parse({ frames, readAt: input.readAt.toISOString() });
}
