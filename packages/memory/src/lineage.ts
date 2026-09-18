import { slotDescriptorSchema, type LineageObjectType, type LineageRecord, type ResolvedIdentity, type SlotDescriptor } from '@unai/domain';
import { uuidV7 } from '../../../src/kernel/identities.js';
import { canonicalJson } from './canonical-json.js';
import { CANONICAL_NORMALIZATION_VERSION, recordSlotFingerprint, slotFingerprint } from './slots.js';
import { MemoryStoreError, type MemoryTransaction } from './transaction.js';

/** Lineage: how an old identifier stays resolvable after a merge or a split
 * (PRD §13.1, §13.6, §14, §44.13, §44.14; ADR 0023).
 *
 * Nothing here deletes, re-points or reuses an identifier. A merged or split
 * object keeps its row and its id; its lifecycle leaves ACTIVE once and a lineage
 * row records where its meaning went. The writers below only append, and the
 * database refuses a lineage row that is not written by the MERGE or SPLIT
 * transaction committing right now (migration 0018), so this module cannot be
 * used as a shortcut around the write governor even by mistake.
 *
 * The readers are what every other reader uses to follow that history:
 * `listMergedFrameMembers` answers which old frames now speak for a survivor,
 * `resolveFrameInstanceSurvivors` and `resolveEntitySurvivors` answer which live
 * object an old id means today, and `resolveIdentity` answers both directions
 * for one id, as the Merge and split review screen and the endpoints show it.
 */

export type FrameLineageKind = 'MERGED_INTO' | 'SPLIT_INTO' | 'RETIRED_PARENT';
export type PropositionLineageKind = 'EQUIVALENT_TO' | 'CANONICAL_ALIAS_OF' | 'MERGED_INTO' | 'SPLIT_INTO';
export type EntityLineageKind = 'MERGED_INTO' | 'SPLIT_INTO' | 'ALIAS_OF' | 'RETIRED_PARENT';

const reasonJson = (reason: Record<string, unknown> | undefined) => JSON.stringify(reason ?? {});

export async function recordFrameInstanceLineage(tx: MemoryTransaction, input: {
  ownerScopeId: string; fromFrameInstanceId: string; toFrameInstanceId: string; lineageKind: FrameLineageKind;
  transactionId: string; reason?: Record<string, unknown>;
}): Promise<string> {
  if (input.fromFrameInstanceId === input.toFrameInstanceId) throw new MemoryStoreError('LINEAGE_SELF_REFERENCE');
  const id = uuidV7();
  await tx.query(`INSERT INTO frame_instance_lineage(id,owner_scope_id,from_frame_instance_id,to_frame_instance_id,
    lineage_kind,transaction_id,reason) VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [id, input.ownerScopeId, input.fromFrameInstanceId, input.toFrameInstanceId, input.lineageKind,
      input.transactionId, reasonJson(input.reason)]);
  return id;
}

export async function recordPropositionLineage(tx: MemoryTransaction, input: {
  ownerScopeId: string; fromPropositionId: string; toPropositionId: string; lineageKind: PropositionLineageKind;
  transactionId: string; reason?: Record<string, unknown>;
}): Promise<string> {
  if (input.fromPropositionId === input.toPropositionId) throw new MemoryStoreError('LINEAGE_SELF_REFERENCE');
  const id = uuidV7();
  await tx.query(`INSERT INTO proposition_lineage(id,owner_scope_id,from_proposition_id,to_proposition_id,
    lineage_kind,transaction_id,reason) VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [id, input.ownerScopeId, input.fromPropositionId, input.toPropositionId, input.lineageKind,
      input.transactionId, reasonJson(input.reason)]);
  return id;
}

/** The governed counterpart of `recordEntityMerge`: the same lineage row, naming
 * the transaction that recorded it. */
export async function recordEntityLineage(tx: MemoryTransaction, input: {
  ownerScopeId: string; fromEntityId: string; toEntityId: string; lineageKind: EntityLineageKind;
  transactionId: string; reason?: Record<string, unknown>;
}): Promise<string> {
  if (input.fromEntityId === input.toEntityId) throw new MemoryStoreError('LINEAGE_SELF_REFERENCE');
  const id = uuidV7();
  await tx.query(`INSERT INTO entity_lineage(id,owner_scope_id,from_entity_id,to_entity_id,lineage_kind,transaction_id,reason)
    VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [id, input.ownerScopeId, input.fromEntityId, input.toEntityId, input.lineageKind, input.transactionId, reasonJson(input.reason)]);
  return id;
}

/** Move an active frame instance to MERGED or SPLIT. The row, its id and every
 * row that points at it stay; the database refuses the change outside a
 * committing belief transaction and refuses it twice. */
export async function retireFrameInstance(tx: MemoryTransaction, input: {
  ownerScopeId: string; frameInstanceId: string; lifecycle: 'MERGED' | 'SPLIT';
}): Promise<void> {
  const changed = await tx.query(`UPDATE frame_instances SET lifecycle=$3,retired_at=now()
    WHERE owner_scope_id=$1 AND id=$2 AND lifecycle='ACTIVE'`, [input.ownerScopeId, input.frameInstanceId, input.lifecycle]);
  if (changed.rowCount !== 1) throw new MemoryStoreError('FRAME_INSTANCE_NOT_ACTIVE');
}

export async function retireEntity(tx: MemoryTransaction, input: {
  ownerScopeId: string; entityId: string; lifecycle: 'MERGED' | 'SPLIT';
}): Promise<void> {
  const changed = await tx.query(`UPDATE entities SET lifecycle=$3,retired_at=now()
    WHERE owner_scope_id=$1 AND id=$2 AND lifecycle='ACTIVE'`, [input.ownerScopeId, input.entityId, input.lifecycle]);
  if (changed.rowCount !== 1) throw new MemoryStoreError('ENTITY_NOT_ACTIVE');
}

// ---------------------------------------------------------------------------
// Following lineage
// ---------------------------------------------------------------------------

/**
 * Every frame that now speaks for one of the named frames: the frame itself and
 * every frame merged into it, transitively, mapped member -> survivor.
 *
 * A reader that projects a survivor reads its members' slots, roles,
 * resolutions and allocations through this map, so a merge moves no row and
 * still lands every fact on the survivor (PRD §14.1). With no lineage it is the
 * identity map, and the reader behaves exactly as before.
 */
export async function listMergedFrameMembers(tx: MemoryTransaction, input: {
  ownerScopeId: string; frameInstanceIds: readonly string[];
}): Promise<Map<string, string>> {
  const members = new Map<string, string>();
  for (const id of input.frameInstanceIds) members.set(id, id);
  if (input.frameInstanceIds.length === 0) return members;
  const rows = (await tx.query(
    `WITH RECURSIVE members(member_id,survivor_id,depth) AS (
       SELECT l.from_frame_instance_id,l.to_frame_instance_id,1 FROM frame_instance_lineage l
        WHERE l.owner_scope_id=$1 AND l.lineage_kind='MERGED_INTO' AND l.to_frame_instance_id=ANY($2::uuid[])
       UNION
       SELECT l.from_frame_instance_id,m.survivor_id,m.depth+1 FROM frame_instance_lineage l
        JOIN members m ON l.to_frame_instance_id=m.member_id
        WHERE l.owner_scope_id=$1 AND l.lineage_kind='MERGED_INTO' AND m.depth<32)
     SELECT DISTINCT member_id,survivor_id FROM members ORDER BY member_id`,
    [input.ownerScopeId, [...input.frameInstanceIds]])).rows;
  for (const row of rows) members.set(row['member_id'] as string, row['survivor_id'] as string);
  return members;
}

/**
 * Which live frame each named frame means today.
 *
 * Follows MERGED_INTO to the end. A chain that ends at a SPLIT instance resolves
 * to `null`: which of the new instances an old reference meant is exactly what a
 * split cannot know, so the caller reports it instead of guessing (PRD §14.2
 * item 3). A frame with no lineage resolves to itself.
 */
export async function resolveFrameInstanceSurvivors(tx: MemoryTransaction, input: {
  ownerScopeId: string; frameInstanceIds: readonly string[];
}): Promise<Map<string, string | null>> {
  const resolved = new Map<string, string | null>();
  const ids = [...new Set(input.frameInstanceIds)];
  if (ids.length === 0) return resolved;
  const rows = (await tx.query(
    `WITH RECURSIVE chain(origin_id,current_id,depth) AS (
       SELECT id,id,0 FROM unnest($2::uuid[]) AS id
       UNION ALL
       SELECT c.origin_id,l.to_frame_instance_id,c.depth+1 FROM chain c
        JOIN frame_instance_lineage l ON l.owner_scope_id=$1 AND l.from_frame_instance_id=c.current_id
         AND l.lineage_kind='MERGED_INTO'
        WHERE c.depth<32)
     SELECT DISTINCT ON (c.origin_id) c.origin_id,c.current_id,
       EXISTS(SELECT 1 FROM frame_instance_lineage s WHERE s.owner_scope_id=$1 AND s.from_frame_instance_id=c.current_id
         AND s.lineage_kind='SPLIT_INTO') AS split
     FROM chain c ORDER BY c.origin_id,c.depth DESC`, [input.ownerScopeId, ids])).rows;
  // Split is read from the lineage, not from the frame's lifecycle: a projection
  // read may see lineage without seeing frames, and must still report a delta
  // about a split frame rather than lose it.
  for (const row of rows) {
    resolved.set(row['origin_id'] as string, row['split'] === true ? null : row['current_id'] as string);
  }
  for (const id of ids) if (!resolved.has(id)) resolved.set(id, id);
  return resolved;
}

/** Which live entity each named entity means today, through MERGED_INTO. A split
 * parent keeps its own id: roles that name it stay on it (ADR 0023 §2). */
export async function resolveEntitySurvivors(tx: MemoryTransaction, input: {
  ownerScopeId: string; entityIds: readonly string[];
}): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  const ids = [...new Set(input.entityIds)];
  if (ids.length === 0) return resolved;
  const rows = (await tx.query(
    `WITH RECURSIVE chain(origin_id,current_id,depth) AS (
       SELECT id,id,0 FROM unnest($2::uuid[]) AS id
       UNION ALL
       SELECT c.origin_id,l.to_entity_id,c.depth+1 FROM chain c
        JOIN entity_lineage l ON l.owner_scope_id=$1 AND l.from_entity_id=c.current_id AND l.lineage_kind='MERGED_INTO'
        WHERE c.depth<32)
     SELECT DISTINCT ON (origin_id) origin_id,current_id FROM chain ORDER BY origin_id,depth DESC`,
    [input.ownerScopeId, ids])).rows;
  for (const row of rows) resolved.set(row['origin_id'] as string, row['current_id'] as string);
  for (const id of ids) if (!resolved.has(id)) resolved.set(id, id);
  return resolved;
}

const LINEAGE_TABLES: Readonly<Record<LineageObjectType, { table: string; from: string; to: string; objects: string }>> = Object.freeze({
  frame_instance: { table: 'frame_instance_lineage', from: 'from_frame_instance_id', to: 'to_frame_instance_id', objects: 'frame_instances' },
  entity: { table: 'entity_lineage', from: 'from_entity_id', to: 'to_entity_id', objects: 'entities' },
  proposition: { table: 'proposition_lineage', from: 'from_proposition_id', to: 'to_proposition_id', objects: 'propositions' },
});

function toLineageRecord(objectType: LineageObjectType, row: Record<string, unknown>): LineageRecord {
  const shape = LINEAGE_TABLES[objectType];
  return Object.freeze({
    lineageId: row['id'] as string,
    objectType,
    fromId: row[shape.from] as string,
    toId: row[shape.to] as string,
    lineageKind: row['lineage_kind'] as LineageRecord['lineageKind'],
    transactionId: (row['transaction_id'] as string | null) ?? null,
    createdAt: (row['created_at'] as Date).toISOString(),
  });
}

/** Every lineage row one merge or split transaction wrote, in the order written. */
export async function readLineageForTransaction(tx: MemoryTransaction, input: {
  ownerScopeId: string; transactionId: string;
}): Promise<{ frameInstances: LineageRecord[]; entities: LineageRecord[]; propositions: LineageRecord[] }> {
  const read = async (objectType: LineageObjectType) => {
    const shape = LINEAGE_TABLES[objectType];
    const rows = (await tx.query(`SELECT * FROM ${shape.table} WHERE owner_scope_id=$1 AND transaction_id=$2
      ORDER BY created_at,id`, [input.ownerScopeId, input.transactionId])).rows;
    return rows.map(row => toLineageRecord(objectType, row));
  };
  return { frameInstances: await read('frame_instance'), entities: await read('entity'), propositions: await read('proposition') };
}

/** The most recent lineage rows of an owner, newest first, for the review screen. */
export async function listRecentLineage(tx: MemoryTransaction, input: {
  ownerScopeId: string; limit?: number;
}): Promise<LineageRecord[]> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const records: LineageRecord[] = [];
  for (const objectType of ['frame_instance', 'entity', 'proposition'] as const) {
    const shape = LINEAGE_TABLES[objectType];
    const rows = (await tx.query(`SELECT * FROM ${shape.table} WHERE owner_scope_id=$1
      ORDER BY created_at DESC,id DESC LIMIT $2`, [input.ownerScopeId, limit])).rows;
    records.push(...rows.map(row => toLineageRecord(objectType, row)));
  }
  return records.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.lineageId.localeCompare(left.lineageId))
    .slice(0, limit);
}

/**
 * What one identifier names today (PRD §44.13 "old IDs remain resolvable").
 *
 * The object's own row is always found -- a merge or split never removes it --
 * together with every lineage row that mentions it and the live objects its
 * meaning moved to: itself while active, the survivor after a merge, each new
 * object after a split, followed transitively. Null only for an id that never
 * named anything this owner can read.
 */
export async function resolveIdentity(tx: MemoryTransaction, input: {
  ownerScopeId: string; objectType: LineageObjectType; id: string;
}): Promise<ResolvedIdentity | null> {
  const shape = LINEAGE_TABLES[input.objectType];
  const own = (await tx.query(`SELECT id,lifecycle FROM ${shape.objects} WHERE owner_scope_id=$1 AND id=$2`,
    [input.ownerScopeId, input.id])).rows[0];
  if (!own) return null;
  const lineage = (await tx.query(`SELECT * FROM ${shape.table} WHERE owner_scope_id=$1 AND ($2 IN (${shape.from},${shape.to}))
    ORDER BY created_at,id`, [input.ownerScopeId, input.id])).rows.map(row => toLineageRecord(input.objectType, row));

  // Walk forward through MERGED_INTO and SPLIT_INTO until only live objects remain.
  const resolvesTo = new Set<string>();
  const seen = new Set<string>();
  let frontier = [input.id];
  for (let depth = 0; depth < 32 && frontier.length > 0; depth++) {
    const rows = (await tx.query(`SELECT o.id,o.lifecycle,
        coalesce(array_agg(l.${shape.to} ORDER BY l.created_at,l.id) FILTER (WHERE l.id IS NOT NULL),'{}') AS next
      FROM ${shape.objects} o
      LEFT JOIN ${shape.table} l ON l.owner_scope_id=o.owner_scope_id AND l.${shape.from}=o.id
        AND l.lineage_kind IN ('MERGED_INTO','SPLIT_INTO')
      WHERE o.owner_scope_id=$1 AND o.id=ANY($2::uuid[]) GROUP BY o.id,o.lifecycle ORDER BY o.id`,
      [input.ownerScopeId, frontier])).rows;
    const next: string[] = [];
    for (const row of rows) {
      const id = row['id'] as string;
      seen.add(id);
      const successors = (row['next'] as string[]).filter(successor => !seen.has(successor));
      if (row['lifecycle'] === 'ACTIVE' || successors.length === 0) resolvesTo.add(id);
      else next.push(...successors);
    }
    frontier = [...new Set(next)];
  }
  return Object.freeze({
    objectType: input.objectType, id: input.id, lifecycle: own['lifecycle'] as string,
    resolvesTo: [...resolvesTo].sort(), lineage,
  });
}

// ---------------------------------------------------------------------------
// Slots under a merge
// ---------------------------------------------------------------------------

export interface FrameSlot {
  readonly beliefSlotId: string;
  /** The frame the slot row names. After a merge it may be a member of the frame
   * the slot now belongs to; the row never moves. */
  readonly rowFrameInstanceId: string;
  readonly descriptor: SlotDescriptor;
  readonly createdAt: Date;
}

/** The active slots of a frame, its merged members included, each with the
 * descriptor it has *as a slot of that frame*: the frame reference is the frame
 * asked about, everything else is the slot row's own. */
export async function listFrameSlots(tx: MemoryTransaction, input: {
  ownerScopeId: string; frameInstanceId: string;
}): Promise<FrameSlot[]> {
  const members = await listMergedFrameMembers(tx, { ownerScopeId: input.ownerScopeId, frameInstanceIds: [input.frameInstanceId] });
  const rows = (await tx.query(`SELECT id,frame_instance_id,predicate_id,context_space_id,modality,qualifiers,created_at
    FROM belief_slots WHERE owner_scope_id=$1 AND frame_instance_id=ANY($2::uuid[]) AND lifecycle='ACTIVE'
    ORDER BY created_at,id`, [input.ownerScopeId, [...members.keys()]])).rows;
  return rows.map(row => Object.freeze({
    beliefSlotId: row['id'] as string,
    rowFrameInstanceId: row['frame_instance_id'] as string,
    descriptor: slotDescriptorSchema.parse({
      frameInstanceId: input.frameInstanceId, predicateId: row['predicate_id'], contextSpaceId: row['context_space_id'],
      modality: row['modality'], qualifiers: row['qualifiers'],
    }),
    createdAt: row['created_at'] as Date,
  }));
}

/** The comparison form of a descriptor: two slots of one frame whose keys are
 * equal describe the same location, which is what a collision is (PRD §13.5). */
export function slotDescriptorKey(descriptor: SlotDescriptor): string {
  return canonicalJson(slotDescriptorSchema.parse(descriptor));
}

/**
 * Rehome a slot to the frame that absorbed its own (PRD §14.1 items 3-4).
 *
 * The slot keeps its id and its row. Its lookup index moves: each live
 * fingerprint version is closed and a new one appended whose descriptor names
 * the survivor, so a later lookup for the survivor finds this slot and the
 * fingerprint is recomputed under the version it was indexed with. Closing
 * precedes appending because only one live row per version may exist.
 */
export async function rehomeSlotDescriptor(tx: MemoryTransaction, input: {
  ownerScopeId: string; beliefSlotId: string; descriptor: SlotDescriptor; registryReleaseId?: string | null;
}): Promise<{ normalizationVersion: string; previousFingerprint: string | null; fingerprint: string }[]> {
  const descriptor = slotDescriptorSchema.parse(input.descriptor);
  const live = (await tx.query(`SELECT normalization_version,fingerprint FROM slot_fingerprints
    WHERE owner_scope_id=$1 AND belief_slot_id=$2 AND valid_to_recorded_at IS NULL ORDER BY normalization_version`,
    [input.ownerScopeId, input.beliefSlotId])).rows;
  const versions = live.length > 0
    ? live.map(row => ({ version: row['normalization_version'] as string, previous: row['fingerprint'] as string }))
    : [{ version: CANONICAL_NORMALIZATION_VERSION, previous: null }];
  const moved = [];
  for (const { version, previous } of versions) {
    if (previous !== null) {
      await tx.query(`UPDATE slot_fingerprints SET valid_to_recorded_at=now()
        WHERE owner_scope_id=$1 AND belief_slot_id=$2 AND normalization_version=$3 AND valid_to_recorded_at IS NULL`,
        [input.ownerScopeId, input.beliefSlotId, version]);
    }
    await recordSlotFingerprint(tx, { ownerScopeId: input.ownerScopeId, beliefSlotId: input.beliefSlotId, descriptor,
      normalizationVersion: version, registryReleaseId: input.registryReleaseId ?? null });
    moved.push({ normalizationVersion: version, previousFingerprint: previous, fingerprint: slotFingerprint(descriptor, version) });
  }
  return moved;
}
