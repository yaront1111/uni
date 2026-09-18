import {
  entityMergeDetailSchema, entitySplitDetailSchema, frameMergeDetailSchema, frameSplitDetailSchema,
  type AssessmentStatus, type EntityMergeDetail, type EntitySplitDetail, type FrameMergeDetail, type FrameSplitDetail,
} from '@unai/domain';
import {
  canonicalJson, createBeliefSlot, createEntity, createProposition, listFrameSlots, listMergedFrameMembers,
  normalizeAliasValue, recordEntityLineage, recordFrameInstanceLineage, recordFrameInstanceRole, recordPropositionLineage,
  rehomeSlotDescriptor, retireEntity, retireFrameInstance, slotDescriptorKey, MemoryStoreError, type EntityKind,
  type MemoryTransaction,
} from '@unai/memory';
import { uuidV7 } from '../../../src/kernel/identities.js';
import { readCurrentAssessment, recordBeliefAssessment, type StoredAssessment } from './assessments.js';
import { independenceGroupKey } from './support.js';

/**
 * Governed merge and split (PRD §14; CRT-MEM-10-A, CRT-MEM-10-B, CRT-MEM-10-C;
 * ADR 0023).
 *
 * These are the bodies of the `MERGE` and `SPLIT` operations a belief
 * transaction commits. They run only inside the governor's commit: the
 * transaction is `COMMITTING` and named by `unai.belief_transaction_id`, which is
 * what the lineage and retirement triggers of migration 0018 require. Nothing
 * here is a shortcut around that -- called from anywhere else the database
 * refuses the first lineage row.
 *
 * The rules they keep:
 *
 *  - No id is reused or rewritten. A merged or split object keeps its row; its
 *    lifecycle leaves ACTIVE and a lineage row names where it went. Lineage is
 *    written before the retirement, so the old id is resolvable for the whole
 *    life of the retirement.
 *  - No claim is re-pointed. A claim stays attached to the proposition it was
 *    recorded against; a merge carries it through `MERGED_INTO` lineage and a
 *    split assigns it with a support row from the split transaction.
 *  - Nothing is decided by a guess. A split claim nobody assigned is contested
 *    and stays on the retired parent; an entity alias nobody assigned stays on
 *    the retired parent; a role that named a split entity keeps naming it.
 */

export class LineageOperationError extends Error {
  constructor(code: string) { super(code); this.name = 'LineageOperationError'; }
}

export interface LineageOperationContext {
  readonly ownerScopeId: string;
  readonly transactionId: string;
  readonly registryReleaseId: string;
}

export interface LineageOperationResult<T> {
  readonly detail: T;
  /** Every row the operation created, in the order created, for the commit receipt. */
  readonly created: readonly { objectType: string; objectId: string }[];
  readonly assessments: readonly StoredAssessment[];
  readonly touchedPropositions: readonly string[];
}

interface FrameRow { id: string; frameTypeId: string; contextSpaceId: string; lifecycle: string }

async function lockFrame(tx: MemoryTransaction, ownerScopeId: string, id: string): Promise<FrameRow> {
  const row = (await tx.query(`SELECT id,frame_type_id,context_space_id,lifecycle FROM frame_instances
    WHERE owner_scope_id=$1 AND id=$2 FOR UPDATE`, [ownerScopeId, id])).rows[0];
  if (!row) throw new LineageOperationError('FRAME_INSTANCE_NOT_FOUND');
  return { id: row['id'] as string, frameTypeId: row['frame_type_id'] as string,
    contextSpaceId: row['context_space_id'] as string, lifecycle: row['lifecycle'] as string };
}

interface PropositionRow { id: string; normalizedValue: unknown; polarity: 'POSITIVE' | 'NEGATIVE' }

async function activePropositions(tx: MemoryTransaction, ownerScopeId: string, beliefSlotId: string): Promise<PropositionRow[]> {
  return (await tx.query(`SELECT id,normalized_value,polarity FROM propositions
    WHERE owner_scope_id=$1 AND belief_slot_id=$2 AND lifecycle='ACTIVE' ORDER BY created_at,id`,
    [ownerScopeId, beliefSlotId])).rows.map(row => ({
    id: row['id'] as string, normalizedValue: row['normalized_value'], polarity: row['polarity'] as 'POSITIVE' | 'NEGATIVE',
  }));
}

const valueKey = (proposition: { normalizedValue: unknown; polarity: string }) =>
  canonicalJson({ value: proposition.normalizedValue ?? null, polarity: proposition.polarity });

/** Append one assessment version, with the reason code the result reports. */
async function assess(tx: MemoryTransaction, context: LineageOperationContext, propositionId: string,
  status: AssessmentStatus, code: string, detail: Record<string, unknown>): Promise<StoredAssessment> {
  return recordBeliefAssessment(tx, {
    ownerScopeId: context.ownerScopeId, propositionId, assessmentStatus: status,
    transactionId: context.transactionId, decisionReason: { code, ...detail },
  });
}

// ---------------------------------------------------------------------------
// Frame-instance merge (PRD §14.1, §44.13; CRT-MEM-10-A)
// ---------------------------------------------------------------------------

/**
 * Merge one frame instance into a survivor.
 *
 * The ten obligations of PRD §14.1, in order: the survivor is chosen by the
 * caller (item 1); lineage is written from the merged instance (2); every active
 * slot of the merged instance is rehomed -- its index moves to the survivor and
 * its fingerprint is recomputed (3, 4); a rehomed slot whose descriptor now
 * equals a survivor slot is a new collision (5), and each of its propositions is
 * merged into the survivor slot's proposition with the same value, or into a new
 * one there, through governed lineage (6); assessments are carried and competing
 * accepted values in one slot become CONTESTED (7). The rebuild of every affected
 * projection (8) is the caller's, in its own transaction (ADR 0023 §3). The old
 * id keeps its row (9) and can never be merged again (10).
 */
export async function applyFrameMerge(tx: MemoryTransaction, context: LineageOperationContext, input: {
  mergedFrameInstanceId: string; survivorFrameInstanceId: string; reason?: string | undefined;
}): Promise<LineageOperationResult<FrameMergeDetail>> {
  const owner = context.ownerScopeId;
  if (input.mergedFrameInstanceId === input.survivorFrameInstanceId) throw new LineageOperationError('FRAME_MERGE_SELF');
  // Lock in id order so two merges over the same pair cannot deadlock.
  const [first, second] = [input.mergedFrameInstanceId, input.survivorFrameInstanceId].sort();
  const locked = new Map([[first!, await lockFrame(tx, owner, first!)], [second!, await lockFrame(tx, owner, second!)]]);
  const merged = locked.get(input.mergedFrameInstanceId)!;
  const survivor = locked.get(input.survivorFrameInstanceId)!;
  if (merged.lifecycle !== 'ACTIVE' || survivor.lifecycle !== 'ACTIVE') throw new LineageOperationError('FRAME_INSTANCE_NOT_ACTIVE');
  if (merged.frameTypeId !== survivor.frameTypeId) throw new LineageOperationError('FRAME_MERGE_TYPE_MISMATCH');
  if (merged.contextSpaceId !== survivor.contextSpaceId) throw new LineageOperationError('FRAME_MERGE_CONTEXT_MISMATCH');

  const created: { objectType: string; objectId: string }[] = [];
  const assessments: StoredAssessment[] = [];
  const touched = new Set<string>();

  // Read both slot sets before anything moves: afterwards the merged instance's
  // slots are the survivor's too, and the comparison would be with itself.
  const survivorSlots = await listFrameSlots(tx, { ownerScopeId: owner, frameInstanceId: survivor.id });
  const mergedSlots = await listFrameSlots(tx, { ownerScopeId: owner, frameInstanceId: merged.id });

  const lineageId = await recordFrameInstanceLineage(tx, {
    ownerScopeId: owner, fromFrameInstanceId: merged.id, toFrameInstanceId: survivor.id, lineageKind: 'MERGED_INTO',
    transactionId: context.transactionId, reason: input.reason ? { text: input.reason } : { code: 'OWNER_MERGE' },
  });
  created.push({ objectType: 'frame_instance_lineage', objectId: lineageId });
  await retireFrameInstance(tx, { ownerScopeId: owner, frameInstanceId: merged.id, lifecycle: 'MERGED' });

  const bySurvivorKey = new Map<string, string>();
  for (const slot of survivorSlots) {
    const key = slotDescriptorKey(slot.descriptor);
    if (!bySurvivorKey.has(key)) bySurvivorKey.set(key, slot.beliefSlotId);
  }

  const rehomedSlots: FrameMergeDetail['rehomedSlots'] = [];
  const collidingSlots: FrameMergeDetail['collidingSlots'] = [];
  const mergedPropositions: FrameMergeDetail['mergedPropositions'] = [];
  const collisionTargets = new Set<string>();

  for (const slot of mergedSlots) {
    const descriptor = { ...slot.descriptor, frameInstanceId: survivor.id };
    for (const moved of await rehomeSlotDescriptor(tx, { ownerScopeId: owner, beliefSlotId: slot.beliefSlotId,
      descriptor, registryReleaseId: context.registryReleaseId })) {
      rehomedSlots.push({ beliefSlotId: slot.beliefSlotId, predicateId: descriptor.predicateId, ...moved });
    }
    const key = slotDescriptorKey(descriptor);
    const target = bySurvivorKey.get(key);
    if (target === undefined) { bySurvivorKey.set(key, slot.beliefSlotId); continue; }

    // A new collision. The survivor's slot is the location from now on; every
    // value the merged slot held moves into it by lineage, never by rewriting.
    collidingSlots.push({ beliefSlotId: slot.beliefSlotId, survivorBeliefSlotId: target, predicateId: descriptor.predicateId });
    collisionTargets.add(target);
    const existing = await activePropositions(tx, owner, target);
    for (const proposition of await activePropositions(tx, owner, slot.beliefSlotId)) {
      let destination = existing.find(candidate => valueKey(candidate) === valueKey(proposition));
      const createdTarget = destination === undefined;
      if (!destination) {
        const id = await createProposition(tx, { ownerScopeId: owner, beliefSlotId: target,
          normalizedValue: proposition.normalizedValue, polarity: proposition.polarity,
          registryReleaseId: context.registryReleaseId });
        destination = { id, normalizedValue: proposition.normalizedValue, polarity: proposition.polarity };
        existing.push(destination);
        created.push({ objectType: 'propositions', objectId: id });
      }
      const propositionLineageId = await recordPropositionLineage(tx, {
        ownerScopeId: owner, fromPropositionId: proposition.id, toPropositionId: destination.id,
        lineageKind: 'MERGED_INTO', transactionId: context.transactionId,
        reason: { code: createdTarget ? 'REHOMED_INTO_SURVIVOR_SLOT' : 'EQUIVALENT_VALUE_IN_SURVIVOR_SLOT' },
      });
      created.push({ objectType: 'proposition_lineage', objectId: propositionLineageId });
      await tx.query(`UPDATE propositions SET lifecycle='MERGED',retired_at=now() WHERE owner_scope_id=$1 AND id=$2`,
        [owner, proposition.id]);
      mergedPropositions.push({ fromPropositionId: proposition.id, toPropositionId: destination.id, createdTarget });
      touched.add(proposition.id); touched.add(destination.id);

      // The verdict follows the value: the merged proposition's own history closes
      // as SUPERSEDED, and a destination with no verdict of its own inherits it.
      const previous = await readCurrentAssessment(tx, owner, proposition.id);
      if (previous) {
        assessments.push(await assess(tx, context, proposition.id, 'SUPERSEDED', 'MERGED_INTO',
          { toPropositionId: destination.id }));
        if (!await readCurrentAssessment(tx, owner, destination.id)) {
          assessments.push(await assess(tx, context, destination.id, previous.assessmentStatus, 'INHERITED_FROM_MERGE',
            { fromPropositionId: proposition.id }));
        }
      }
    }
    await tx.query(`UPDATE belief_slots SET lifecycle='MERGED' WHERE owner_scope_id=$1 AND id=$2`, [owner, slot.beliefSlotId]);
  }

  // Competing values now sharing one slot. Both stay; accepted ones become
  // CONTESTED, because two accepted values in one slot is exactly the silent
  // contradiction PRD §44.11 forbids.
  const conflicts: FrameMergeDetail['conflicts'] = [];
  for (const beliefSlotId of [...collisionTargets].sort()) {
    const values = await activePropositions(tx, owner, beliefSlotId);
    if (new Set(values.map(valueKey)).size < 2) continue;
    conflicts.push({ beliefSlotId, propositionIds: values.map(value => value.id) });
    for (const value of values) {
      const current = await readCurrentAssessment(tx, owner, value.id);
      if (current?.assessmentStatus === 'ACCEPTED') {
        assessments.push(await assess(tx, context, value.id, 'CONTESTED', 'MERGE_COLLISION', { beliefSlotId }));
        touched.add(value.id);
      }
    }
  }

  return {
    detail: frameMergeDetailSchema.parse({
      survivorFrameInstanceId: survivor.id, mergedFrameInstanceId: merged.id, frameTypeId: merged.frameTypeId,
      rehomedSlots, collidingSlots, mergedPropositions, conflicts,
      assessments: assessments.map(assessment => ({ propositionId: assessment.propositionId, assessmentId: assessment.id,
        assessmentStatus: assessment.assessmentStatus, reason: String(assessment.decisionReason['code']) })),
    }),
    created, assessments, touchedPropositions: [...touched],
  };
}

// ---------------------------------------------------------------------------
// Frame-instance split (PRD §14.2, §44.14; CRT-MEM-10-B)
// ---------------------------------------------------------------------------

interface ParentClaim {
  claimId: string; lifecycle: string; recordedPropositionId: string;
  /** The parent proposition the claim speaks for, after following MERGED_INTO. */
  propositionId: string; beliefSlotId: string;
}

/** Every claim that speaks for the parent: attached to one of its active
 * propositions, attached to a proposition merged into one of them, or assigned
 * to one by an earlier split. */
async function parentClaims(tx: MemoryTransaction, ownerScopeId: string, propositionIds: readonly string[],
  slotOf: ReadonlyMap<string, string>): Promise<ParentClaim[]> {
  if (propositionIds.length === 0) return [];
  const rows = (await tx.query(
    `WITH RECURSIVE merged(proposition_id,into_id,depth) AS (
       SELECT l.from_proposition_id,l.to_proposition_id,1 FROM proposition_lineage l
        WHERE l.owner_scope_id=$1 AND l.lineage_kind='MERGED_INTO' AND l.to_proposition_id=ANY($2::uuid[])
       UNION
       SELECT l.from_proposition_id,m.into_id,m.depth+1 FROM proposition_lineage l JOIN merged m ON l.to_proposition_id=m.proposition_id
        WHERE l.owner_scope_id=$1 AND l.lineage_kind='MERGED_INTO' AND m.depth<32),
     speaks(claim_id,proposition_id) AS (
       SELECT c.id,c.proposition_id FROM claims c WHERE c.owner_scope_id=$1 AND c.proposition_id=ANY($2::uuid[])
       UNION SELECT c.id,m.into_id FROM claims c JOIN merged m ON m.proposition_id=c.proposition_id WHERE c.owner_scope_id=$1
       UNION SELECT s.claim_id,s.proposition_id FROM belief_support s
        JOIN belief_transactions t ON t.owner_scope_id=s.owner_scope_id AND t.id=s.created_by_transaction_id AND t.transaction_kind='SPLIT'
        WHERE s.owner_scope_id=$1 AND s.proposition_id=ANY($2::uuid[]) AND s.claim_id IS NOT NULL)
     SELECT DISTINCT ON (c.id) c.id,c.lifecycle,c.proposition_id AS recorded_proposition_id,s.proposition_id,c.recorded_at
     FROM speaks s JOIN claims c ON c.owner_scope_id=$1 AND c.id=s.claim_id
     ORDER BY c.id,s.proposition_id`, [ownerScopeId, [...propositionIds]])).rows;
  return rows.map(row => ({
    claimId: row['id'] as string, lifecycle: row['lifecycle'] as string,
    recordedPropositionId: row['recorded_proposition_id'] as string,
    propositionId: row['proposition_id'] as string, beliefSlotId: slotOf.get(row['proposition_id'] as string)!,
  })).sort((left, right) => left.claimId.localeCompare(right.claimId));
}

async function claimIndependenceGroup(tx: MemoryTransaction, ownerScopeId: string, claimId: string): Promise<string> {
  const row = (await tx.query(
    `SELECT c.asserted_by_entity_id,s.connector_id,s.source_type,s.actor_ref,s.actor_entity_id
     FROM claims c
     JOIN source_anchors a ON a.owner_scope_id=c.owner_scope_id AND a.id=c.source_anchor_id
     JOIN source_items s ON s.owner_scope_id=a.owner_scope_id AND s.id=a.source_item_id
     WHERE c.owner_scope_id=$1 AND c.id=$2`, [ownerScopeId, claimId])).rows[0];
  if (!row) throw new LineageOperationError('BELIEF_SUPPORT_ORIGIN_UNREADABLE');
  return independenceGroupKey({
    assertedByEntityId: (row['asserted_by_entity_id'] as string | null) ?? null,
    sourceActorEntityId: (row['actor_entity_id'] as string | null) ?? null,
    sourceActorRef: row['actor_ref'] ?? null, connectorId: (row['connector_id'] as string | null) ?? null,
    sourceType: row['source_type'] as string,
  });
}

/** A claim lifecycle a split may still move to CONTESTED. The others are already
 * a settled verdict about the claim, and the split leaves them as they are. */
const CONTESTABLE = new Set(['CANDIDATE', 'PROVISIONAL', 'ACCEPTED']);

/**
 * Split one frame instance into new ones (PRD §14.2).
 *
 * New instances are created, one per partition (item 1), carrying the parent's
 * roles unless the partition names its own. Only the claims the caller assigned
 * are reassigned (item 2): each gets, on its partition's instance, the slot with
 * the parent slot's descriptor and the proposition with the same value -- a new
 * slot per partition wherever one parent slot mixed situations (item 4) -- and a
 * support row from this transaction. Every other claim is moved to CONTESTED
 * when its lifecycle allows and stays attached to the retired parent (item 3).
 * The parent keeps every slot, proposition and claim as lineage history (item 5)
 * and its verdicts are closed or contested (item 6); previous answers stay
 * explainable because nothing they cited moved (item 7).
 */
export async function applyFrameSplit(tx: MemoryTransaction, context: LineageOperationContext, input: {
  parentFrameInstanceId: string; partitions: readonly string[];
  partitionSpecs?: readonly { partition: string; roles?: readonly { roleId: string; entityId?: string | undefined; typedValue?: unknown }[] | undefined }[] | undefined;
  claimAssignments?: readonly { claimId: string; partition: string }[] | undefined;
  reason?: string | undefined;
}): Promise<LineageOperationResult<FrameSplitDetail>> {
  const owner = context.ownerScopeId;
  const partitions = [...input.partitions];
  if (new Set(partitions).size !== partitions.length) throw new LineageOperationError('SPLIT_PARTITION_DUPLICATE');
  const known = new Set(partitions);
  for (const spec of input.partitionSpecs ?? []) if (!known.has(spec.partition)) throw new LineageOperationError('SPLIT_PARTITION_UNKNOWN');
  const assignments = new Map<string, string>();
  for (const assignment of input.claimAssignments ?? []) {
    if (!known.has(assignment.partition)) throw new LineageOperationError('SPLIT_PARTITION_UNKNOWN');
    if (assignments.has(assignment.claimId)) throw new LineageOperationError('SPLIT_CLAIM_ASSIGNED_TWICE');
    assignments.set(assignment.claimId, assignment.partition);
  }

  const parent = await lockFrame(tx, owner, input.parentFrameInstanceId);
  if (parent.lifecycle !== 'ACTIVE') throw new LineageOperationError('FRAME_INSTANCE_NOT_ACTIVE');

  const slots = await listFrameSlots(tx, { ownerScopeId: owner, frameInstanceId: parent.id });
  const slotById = new Map(slots.map(slot => [slot.beliefSlotId, slot]));
  const propositionById = new Map<string, PropositionRow & { beliefSlotId: string }>();
  for (const slot of slots) {
    for (const proposition of await activePropositions(tx, owner, slot.beliefSlotId)) {
      propositionById.set(proposition.id, { ...proposition, beliefSlotId: slot.beliefSlotId });
    }
  }
  const claims = await parentClaims(tx, owner, [...propositionById.keys()],
    new Map([...propositionById.values()].map(proposition => [proposition.id, proposition.beliefSlotId])));
  const claimIds = new Set(claims.map(claim => claim.claimId));
  for (const claimId of assignments.keys()) if (!claimIds.has(claimId)) throw new LineageOperationError('SPLIT_CLAIM_NOT_IN_TARGET');

  const created: { objectType: string; objectId: string }[] = [];
  const assessments: StoredAssessment[] = [];
  const touched = new Set<string>();

  // 1. The new instances, with the parent's roles unless the partition names its own.
  const members = await listMergedFrameMembers(tx, { ownerScopeId: owner, frameInstanceIds: [parent.id] });
  const parentRoles = (await tx.query(`SELECT id,role_id,entity_id,typed_value,claim_id,valid_from,valid_to
    FROM frame_instance_roles WHERE owner_scope_id=$1 AND frame_instance_id=ANY($2::uuid[]) ORDER BY created_at,id`,
    [owner, [...members.keys()]])).rows;
  const children = new Map<string, string>();
  for (const partition of partitions) {
    const id = uuidV7();
    await tx.query(`INSERT INTO frame_instances(id,owner_scope_id,frame_type_id,context_space_id,created_by_transaction_id)
      VALUES($1,$2,$3,$4,$5)`, [id, owner, parent.frameTypeId, parent.contextSpaceId, context.transactionId]);
    created.push({ objectType: 'frame_instances', objectId: id });
    children.set(partition, id);
    const spec = input.partitionSpecs?.find(candidate => candidate.partition === partition);
    const ownRoles = new Set((spec?.roles ?? []).map(role => role.roleId));
    for (const role of spec?.roles ?? []) {
      created.push({ objectType: 'frame_instance_roles', objectId: await recordFrameInstanceRole(tx, {
        ownerScopeId: owner, frameInstanceId: id, roleId: role.roleId,
        ...(role.entityId === undefined ? {} : { entityId: role.entityId }),
        ...(role.typedValue === undefined ? {} : { typedValue: role.typedValue }),
      }) });
    }
    for (const role of parentRoles) {
      if (ownRoles.has(role['role_id'] as string)) continue;
      created.push({ objectType: 'frame_instance_roles', objectId: await recordFrameInstanceRole(tx, {
        ownerScopeId: owner, frameInstanceId: id, roleId: role['role_id'] as string,
        entityId: (role['entity_id'] as string | null) ?? null, typedValue: role['typed_value'] ?? null,
        claimId: (role['claim_id'] as string | null) ?? null,
        validFrom: (role['valid_from'] as Date | null) ?? null, validTo: (role['valid_to'] as Date | null) ?? null,
      }) });
    }
  }

  // 5. The parent becomes lineage history: lineage first, then the retirement.
  for (const [partition, childId] of children) {
    created.push({ objectType: 'frame_instance_lineage', objectId: await recordFrameInstanceLineage(tx, {
      ownerScopeId: owner, fromFrameInstanceId: parent.id, toFrameInstanceId: childId, lineageKind: 'SPLIT_INTO',
      transactionId: context.transactionId,
      reason: { partitionKey: partition, ...(input.reason ? { text: input.reason } : { code: 'OWNER_SPLIT' }) },
    }) });
  }
  await retireFrameInstance(tx, { ownerScopeId: owner, frameInstanceId: parent.id, lifecycle: 'SPLIT' });

  // 2 and 4. Reassign only what the caller assigned.
  const partitionsBySlot = new Map<string, Set<string>>();
  for (const claim of claims) {
    const partition = assignments.get(claim.claimId);
    if (partition === undefined) continue;
    const set = partitionsBySlot.get(claim.beliefSlotId) ?? new Set<string>();
    set.add(partition); partitionsBySlot.set(claim.beliefSlotId, set);
  }
  const childSlots = new Map<string, string>();
  const childPropositions = new Map<string, string>();
  const newSlots: FrameSplitDetail['newSlots'] = [];
  const newPropositions: FrameSplitDetail['newPropositions'] = [];
  const reassignedClaims: FrameSplitDetail['reassignedClaims'] = [];
  for (const claim of claims) {
    const partition = assignments.get(claim.claimId);
    if (partition === undefined) continue;
    const childId = children.get(partition)!;
    const slot = slotById.get(claim.beliefSlotId)!;
    const slotKey = slot.beliefSlotId + ' ' + partition;
    let childSlotId = childSlots.get(slotKey);
    if (!childSlotId) {
      childSlotId = await createBeliefSlot(tx, { ownerScopeId: owner, descriptor: { ...slot.descriptor, frameInstanceId: childId },
        registryReleaseId: context.registryReleaseId });
      childSlots.set(slotKey, childSlotId);
      created.push({ objectType: 'belief_slots', objectId: childSlotId });
      newSlots.push({ beliefSlotId: childSlotId, fromBeliefSlotId: slot.beliefSlotId, frameInstanceId: childId,
        partitionKey: partition, predicateId: slot.descriptor.predicateId,
        mixedSituations: (partitionsBySlot.get(slot.beliefSlotId)?.size ?? 0) > 1 });
    }
    const source = propositionById.get(claim.propositionId)!;
    const propositionKey = source.id + ' ' + partition;
    let childPropositionId = childPropositions.get(propositionKey);
    if (!childPropositionId) {
      childPropositionId = await createProposition(tx, { ownerScopeId: owner, beliefSlotId: childSlotId,
        normalizedValue: source.normalizedValue, polarity: source.polarity, registryReleaseId: context.registryReleaseId });
      childPropositions.set(propositionKey, childPropositionId);
      created.push({ objectType: 'propositions', objectId: childPropositionId });
      created.push({ objectType: 'proposition_lineage', objectId: await recordPropositionLineage(tx, {
        ownerScopeId: owner, fromPropositionId: source.id, toPropositionId: childPropositionId, lineageKind: 'SPLIT_INTO',
        transactionId: context.transactionId, reason: { partitionKey: partition },
      }) });
      newPropositions.push({ propositionId: childPropositionId, fromPropositionId: source.id, partitionKey: partition });
      touched.add(childPropositionId);
    }
    const supportId = uuidV7();
    await tx.query(`INSERT INTO belief_support(id,owner_scope_id,proposition_id,claim_id,support_kind,independence_group,
      created_by_transaction_id) VALUES($1,$2,$3,$4,'DIRECT_ASSERTION',$5,$6)`,
      [supportId, owner, childPropositionId, claim.claimId, await claimIndependenceGroup(tx, owner, claim.claimId),
        context.transactionId]);
    created.push({ objectType: 'belief_support', objectId: supportId });
    reassignedClaims.push({ claimId: claim.claimId, partitionKey: partition, frameInstanceId: childId,
      fromPropositionId: source.id, toPropositionId: childPropositionId, beliefSupportId: supportId });
  }

  // 3. Everything else stays on the retired parent, contested where it can be.
  const contestedClaims: FrameSplitDetail['contestedClaims'] = [];
  const retainedOnParentClaims: FrameSplitDetail['retainedOnParentClaims'] = [];
  const contestedPropositions = new Set<string>();
  for (const claim of claims) {
    if (assignments.has(claim.claimId)) continue;
    if (CONTESTABLE.has(claim.lifecycle)) {
      await tx.query(`UPDATE claims SET lifecycle='CONTESTED' WHERE owner_scope_id=$1 AND id=$2`, [owner, claim.claimId]);
      contestedClaims.push({ claimId: claim.claimId, propositionId: claim.recordedPropositionId, previousLifecycle: claim.lifecycle });
    } else {
      retainedOnParentClaims.push({ claimId: claim.claimId, lifecycle: claim.lifecycle,
        reason: claim.lifecycle === 'CONTESTED' ? 'ALREADY_CONTESTED' : 'LIFECYCLE_ALREADY_SETTLED' });
    }
    contestedPropositions.add(claim.propositionId);
  }
  // A claim that names the parent only through a role has no proposition to
  // follow; it stays exactly where it was, on the retired parent.
  for (const role of parentRoles) {
    const claimId = role['claim_id'] as string | null;
    if (!claimId || claimIds.has(claimId) || retainedOnParentClaims.some(entry => entry.claimId === claimId)) continue;
    const lifecycle = (await tx.query('SELECT lifecycle FROM claims WHERE owner_scope_id=$1 AND id=$2', [owner, claimId])).rows[0]?.['lifecycle'];
    if (typeof lifecycle === 'string') retainedOnParentClaims.push({ claimId, lifecycle, reason: 'ROLE_CLAIM_ON_RETIRED_PARENT' });
  }

  // 6. Verdicts: each new proposition inherits its source's; each parent
  // proposition closes as SUPERSEDED, or CONTESTED where a claim was left behind.
  for (const { propositionId, fromPropositionId } of newPropositions) {
    const previous = await readCurrentAssessment(tx, owner, fromPropositionId);
    if (previous) assessments.push(await assess(tx, context, propositionId, previous.assessmentStatus, 'SPLIT_REHOMED', { fromPropositionId }));
  }
  for (const proposition of propositionById.values()) {
    const previous = await readCurrentAssessment(tx, owner, proposition.id);
    if (!previous) continue;
    const status: AssessmentStatus = contestedPropositions.has(proposition.id) ? 'CONTESTED' : 'SUPERSEDED';
    assessments.push(await assess(tx, context, proposition.id, status,
      status === 'CONTESTED' ? 'SPLIT_UNASSIGNED_CLAIMS' : 'SPLIT_INTO', { parentFrameInstanceId: parent.id }));
    touched.add(proposition.id);
  }

  return {
    detail: frameSplitDetailSchema.parse({
      parentFrameInstanceId: parent.id, frameTypeId: parent.frameTypeId,
      newFrameInstances: [...children].map(([partitionKey, frameInstanceId]) => ({ partitionKey, frameInstanceId })),
      reassignedClaims, contestedClaims, retainedOnParentClaims, newSlots, newPropositions,
      assessments: assessments.map(assessment => ({ propositionId: assessment.propositionId, assessmentId: assessment.id,
        assessmentStatus: assessment.assessmentStatus, reason: String(assessment.decisionReason['code']) })),
    }),
    created, assessments, touchedPropositions: [...touched],
  };
}

// ---------------------------------------------------------------------------
// Entity merge and split (PRD §14.3; CRT-MEM-10-C)
// ---------------------------------------------------------------------------

interface EntityRow { id: string; entityKind: string; canonicalLabel: string | null; lifecycle: string }

async function lockEntity(tx: MemoryTransaction, ownerScopeId: string, id: string): Promise<EntityRow> {
  const row = (await tx.query(`SELECT id,entity_kind,canonical_label,lifecycle FROM entities
    WHERE owner_scope_id=$1 AND id=$2 FOR UPDATE`, [ownerScopeId, id])).rows[0];
  if (!row) throw new LineageOperationError('ENTITY_NOT_FOUND');
  return { id: row['id'] as string, entityKind: row['entity_kind'] as string,
    canonicalLabel: (row['canonical_label'] as string | null) ?? null, lifecycle: row['lifecycle'] as string };
}

interface AliasRow { id: string; aliasType: string; aliasValue: string; sourceItemId: string | null;
  confidence: string | null; validFrom: Date | null; validTo: Date | null }

async function aliasesOf(tx: MemoryTransaction, ownerScopeId: string, entityId: string): Promise<AliasRow[]> {
  return (await tx.query(`SELECT id,alias_type,alias_value,source_item_id,confidence,valid_from,valid_to FROM entity_aliases
    WHERE owner_scope_id=$1 AND entity_id=$2 ORDER BY created_at,id`, [ownerScopeId, entityId])).rows.map(row => ({
    id: row['id'] as string, aliasType: row['alias_type'] as string, aliasValue: row['alias_value'] as string,
    sourceItemId: (row['source_item_id'] as string | null) ?? null,
    confidence: row['confidence'] === null || row['confidence'] === undefined ? null : String(row['confidence']),
    validFrom: (row['valid_from'] as Date | null) ?? null, validTo: (row['valid_to'] as Date | null) ?? null,
  }));
}

/** The same alias again, against another entity. The original row stays where it
 * was, so the retired entity is still findable by what it was called. */
async function copyAlias(tx: MemoryTransaction, ownerScopeId: string, alias: AliasRow, entityId: string): Promise<string> {
  const id = uuidV7();
  await tx.query(`INSERT INTO entity_aliases(id,owner_scope_id,entity_id,alias_type,alias_value,normalized_value,
    source_item_id,confidence,valid_from,valid_to) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id, ownerScopeId, entityId, alias.aliasType, alias.aliasValue, normalizeAliasValue(alias.aliasValue),
      alias.sourceItemId, alias.confidence, alias.validFrom, alias.validTo]);
  return id;
}

/** Merge one entity into a survivor: the identity evidence could not establish,
 * stated by the owner (PRD §14.3, §44.12). */
export async function applyEntityMerge(tx: MemoryTransaction, context: LineageOperationContext, input: {
  mergedEntityId: string; survivorEntityId: string; reason?: string | undefined;
}): Promise<LineageOperationResult<EntityMergeDetail>> {
  const owner = context.ownerScopeId;
  if (input.mergedEntityId === input.survivorEntityId) throw new LineageOperationError('ENTITY_MERGE_SELF');
  const [first, second] = [input.mergedEntityId, input.survivorEntityId].sort();
  const locked = new Map([[first!, await lockEntity(tx, owner, first!)], [second!, await lockEntity(tx, owner, second!)]]);
  const merged = locked.get(input.mergedEntityId)!;
  const survivor = locked.get(input.survivorEntityId)!;
  if (merged.lifecycle !== 'ACTIVE' || survivor.lifecycle !== 'ACTIVE') throw new LineageOperationError('ENTITY_NOT_ACTIVE');
  if (merged.entityKind !== survivor.entityKind) throw new LineageOperationError('ENTITY_MERGE_KIND_MISMATCH');

  const created: { objectType: string; objectId: string }[] = [];
  created.push({ objectType: 'entity_lineage', objectId: await recordEntityLineage(tx, {
    ownerScopeId: owner, fromEntityId: merged.id, toEntityId: survivor.id, lineageKind: 'MERGED_INTO',
    transactionId: context.transactionId, reason: input.reason ? { text: input.reason } : { code: 'OWNER_MERGE' },
  }) });
  await retireEntity(tx, { ownerScopeId: owner, entityId: merged.id, lifecycle: 'MERGED' });

  const held = new Set((await aliasesOf(tx, owner, survivor.id)).map(alias => alias.aliasType + ' ' + normalizeAliasValue(alias.aliasValue)));
  const aliases: EntityMergeDetail['aliases'] = [];
  for (const alias of await aliasesOf(tx, owner, merged.id)) {
    const key = alias.aliasType + ' ' + normalizeAliasValue(alias.aliasValue);
    if (held.has(key)) continue;
    held.add(key);
    const aliasId = await copyAlias(tx, owner, alias, survivor.id);
    created.push({ objectType: 'entity_aliases', objectId: aliasId });
    aliases.push({ aliasId, copiedFromAliasId: alias.id, aliasType: alias.aliasType, aliasValue: alias.aliasValue });
  }
  const affected = (await tx.query(`SELECT DISTINCT frame_instance_id FROM frame_instance_roles
    WHERE owner_scope_id=$1 AND entity_id=$2 ORDER BY frame_instance_id`, [owner, merged.id])).rows
    .map(row => row['frame_instance_id'] as string);

  return {
    detail: entityMergeDetailSchema.parse({ survivorEntityId: survivor.id, mergedEntityId: merged.id, aliases,
      affectedFrameInstanceIds: affected }),
    created, assessments: [], touchedPropositions: [],
  };
}

/** Split one entity that combined several (PRD §14.3). Only assigned aliases move;
 * what the split cannot place stays on the retired parent. */
export async function applyEntitySplit(tx: MemoryTransaction, context: LineageOperationContext, input: {
  parentEntityId: string; partitions: readonly string[];
  partitionSpecs?: readonly { partition: string; canonicalLabel?: string | undefined }[] | undefined;
  aliasAssignments?: readonly { aliasId: string; partition: string }[] | undefined;
  reason?: string | undefined;
}): Promise<LineageOperationResult<EntitySplitDetail>> {
  const owner = context.ownerScopeId;
  const partitions = [...input.partitions];
  if (new Set(partitions).size !== partitions.length) throw new LineageOperationError('SPLIT_PARTITION_DUPLICATE');
  const known = new Set(partitions);
  for (const spec of input.partitionSpecs ?? []) if (!known.has(spec.partition)) throw new LineageOperationError('SPLIT_PARTITION_UNKNOWN');
  const assignments = new Map<string, string>();
  for (const assignment of input.aliasAssignments ?? []) {
    if (!known.has(assignment.partition)) throw new LineageOperationError('SPLIT_PARTITION_UNKNOWN');
    if (assignments.has(assignment.aliasId)) throw new LineageOperationError('SPLIT_ALIAS_ASSIGNED_TWICE');
    assignments.set(assignment.aliasId, assignment.partition);
  }
  const parent = await lockEntity(tx, owner, input.parentEntityId);
  if (parent.lifecycle !== 'ACTIVE') throw new LineageOperationError('ENTITY_NOT_ACTIVE');
  const aliases = await aliasesOf(tx, owner, parent.id);
  const aliasIds = new Set(aliases.map(alias => alias.id));
  for (const aliasId of assignments.keys()) if (!aliasIds.has(aliasId)) throw new LineageOperationError('SPLIT_ALIAS_NOT_ON_TARGET');

  const created: { objectType: string; objectId: string }[] = [];
  const children = new Map<string, string>();
  for (const partition of partitions) {
    const label = input.partitionSpecs?.find(spec => spec.partition === partition)?.canonicalLabel ?? parent.canonicalLabel;
    const id = await createEntity(tx, { ownerScopeId: owner, entityKind: parent.entityKind as EntityKind,
      ...(label === null ? {} : { canonicalLabel: label }) });
    created.push({ objectType: 'entities', objectId: id });
    children.set(partition, id);
  }
  for (const [partition, childId] of children) {
    created.push({ objectType: 'entity_lineage', objectId: await recordEntityLineage(tx, {
      ownerScopeId: owner, fromEntityId: parent.id, toEntityId: childId, lineageKind: 'SPLIT_INTO',
      transactionId: context.transactionId,
      reason: { partitionKey: partition, ...(input.reason ? { text: input.reason } : { code: 'OWNER_SPLIT' }) },
    }) });
  }
  await retireEntity(tx, { ownerScopeId: owner, entityId: parent.id, lifecycle: 'SPLIT' });

  const assignedAliases: EntitySplitDetail['assignedAliases'] = [];
  const ambiguousAliases: EntitySplitDetail['ambiguousAliases'] = [];
  for (const alias of aliases) {
    const partition = assignments.get(alias.id);
    if (partition === undefined) {
      ambiguousAliases.push({ aliasId: alias.id, aliasType: alias.aliasType, aliasValue: alias.aliasValue,
        handling: 'RETAINED_ON_RETIRED_PARENT' });
      continue;
    }
    const entityId = children.get(partition)!;
    const aliasId = await copyAlias(tx, owner, alias, entityId);
    created.push({ objectType: 'entity_aliases', objectId: aliasId });
    assignedAliases.push({ aliasId, copiedFromAliasId: alias.id, entityId, partitionKey: partition });
  }
  const rolesOnRetiredParent = (await tx.query(`SELECT id,frame_instance_id,role_id FROM frame_instance_roles
    WHERE owner_scope_id=$1 AND entity_id=$2 ORDER BY created_at,id`, [owner, parent.id])).rows.map(row => ({
    frameInstanceRoleId: row['id'] as string, frameInstanceId: row['frame_instance_id'] as string, roleId: row['role_id'] as string,
  }));

  return {
    detail: entitySplitDetailSchema.parse({
      parentEntityId: parent.id,
      newEntities: [...children].map(([partitionKey, entityId]) => ({ partitionKey, entityId })),
      assignedAliases, ambiguousAliases, rolesOnRetiredParent,
    }),
    created, assessments: [], touchedPropositions: [],
  };
}

/** Memory-store refusals raised underneath an operation keep their stable code. */
export function lineageErrorCode(error: unknown): string | null {
  if (error instanceof LineageOperationError || error instanceof MemoryStoreError) return error.message;
  return null;
}
