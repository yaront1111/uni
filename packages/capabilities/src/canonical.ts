import {
  listMergedFrameMembers, resolveEntitySurvivors, resolveFrameInstanceSurvivors, type MemoryTransaction,
} from '@unai/memory';
import { type PendingAssertion } from '@unai/domain';

/**
 * The read side every reducer shares: canonical memory in, nothing out.
 *
 * A capability may read canonical memory and build a projection over it; it may
 * never mutate an accepted belief (PRD §25.2). Every query in this file is a
 * `SELECT`, and the purpose the caller holds (`memory.project`) is admitted by
 * no INSERT, UPDATE or DELETE policy on any canonical table, so that rule is
 * enforced by the database and not only by this comment.
 *
 * Everything here is deterministic for a pinned input set: every query has a
 * total `ORDER BY`, every selection rule breaks its ties on an identifier, and
 * no reader looks at the wall clock. That is what makes a full replay equal an
 * incremental apply (CRT-PRJ-02-A).
 *
 * Every reader follows lineage (ADR 0023 §3). A frame merged into a survivor
 * keeps its rows; the readers read them for the survivor and report them under
 * the survivor's id, a proposition merged away counts its claims for the
 * proposition it merged into, a claim a split assigned counts for the new
 * instance's proposition, and a merged entity reads as its survivor. With no
 * lineage every map below is the identity and the readers answer exactly what
 * they answered before.
 */

/** Re-sort rows whose frame id was mapped to a survivor, so the order is the one
 * the SQL would have produced had the rows been recorded against the survivor. */
function byFrameThen<T extends { frameInstanceId: string }>(rows: T[], rest: (left: T, right: T) => number): T[] {
  return rows.sort((left, right) =>
    left.frameInstanceId < right.frameInstanceId ? -1 : left.frameInstanceId > right.frameInstanceId ? 1 : rest(left, right));
}
const compareIds = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const compareTimes = (left: Date, right: Date) => left.getTime() - right.getTime();
const mapped = (members: ReadonlyMap<string, string>) => [...members].some(([member, survivor]) => member !== survivor);

/** The two watermarks every projection row carries (PRD §33.12). */
export interface CanonicalWatermarks {
  readonly canonicalTransactionWatermark: Date;
  readonly ownerOverlayWatermark: number;
}

/** `epoch` rather than null for an owner with no committed transaction yet: the
 * column is NOT NULL because a row must always say how far it read, and "as far
 * as nothing" is a real answer. */
export async function readWatermarks(tx: MemoryTransaction, ownerScopeId: string): Promise<CanonicalWatermarks> {
  const canonical = (await tx.query(
    `SELECT coalesce(max(committed_at), timestamptz 'epoch') AS watermark
     FROM belief_transactions WHERE owner_scope_id=$1 AND status='COMMITTED'`, [ownerScopeId])).rows[0];
  const overlay = (await tx.query(
    'SELECT coalesce(max(owner_sequence),0)::bigint AS watermark FROM owner_overlay_deltas WHERE owner_scope_id=$1',
    [ownerScopeId])).rows[0];
  const sequence = Number(overlay?.['watermark'] ?? 0);
  return Object.freeze({
    canonicalTransactionWatermark: (canonical?.['watermark'] as Date) ?? new Date(0),
    ownerOverlayWatermark: Number.isSafeInteger(sequence) ? sequence : 0,
  });
}

export interface FrameRow {
  readonly frameInstanceId: string;
  readonly frameTypeId: string;
  readonly createdAt: Date;
}

/** The active instances of one frame type, oldest first. A retired, merged or
 * split instance is not projected: its lineage survivor is. */
export async function listFrameInstances(tx: MemoryTransaction, input: {
  ownerScopeId: string; frameTypeId: string; frameInstanceIds?: readonly string[] | undefined;
}): Promise<FrameRow[]> {
  const only = input.frameInstanceIds ? [...input.frameInstanceIds] : null;
  const rows = (await tx.query(
    `SELECT id,frame_type_id,created_at FROM frame_instances
     WHERE owner_scope_id=$1 AND frame_type_id=$2 AND lifecycle='ACTIVE'
       AND ($3::uuid[] IS NULL OR id=ANY($3::uuid[]))
     ORDER BY created_at,id`, [input.ownerScopeId, input.frameTypeId, only])).rows;
  return rows.map(row => Object.freeze({
    frameInstanceId: row['id'] as string, frameTypeId: row['frame_type_id'] as string,
    createdAt: row['created_at'] as Date,
  }));
}

export interface SlotValue {
  readonly frameInstanceId: string;
  readonly beliefSlotId: string;
  readonly predicateId: string;
  readonly propositionId: string;
  readonly normalizedValue: unknown;
  readonly claimIds: readonly string[];
  readonly claimOrigins: readonly string[];
  /** The newest recorded time among the claims supporting this proposition, and
   * null when nothing supports it yet. Selection orders on it, so a later
   * statement wins over an earlier one without anyone reading a clock. */
  readonly latestClaimAt: Date | null;
  readonly createdAt: Date;
}

/** Every live proposition in the named slots of the named frames, with the
 * claims behind it.
 *
 * Both competing values come back. Nothing here chooses between them, because
 * dropping one is precisely the silent overwrite PRD §44.11 forbids
 * (CRT-MEM-08-A); `selectSlotValue` below names the reading rule separately so
 * the conflict stays visible beside the choice. */
export async function readSlotValues(tx: MemoryTransaction, input: {
  ownerScopeId: string; frameInstanceIds: readonly string[]; predicateId: string; modality: string;
}): Promise<SlotValue[]> {
  if (input.frameInstanceIds.length === 0) return [];
  const members = await listMergedFrameMembers(tx, { ownerScopeId: input.ownerScopeId, frameInstanceIds: input.frameInstanceIds });
  const rows = (await tx.query(
    `SELECT s.frame_instance_id, s.id AS belief_slot_id, s.predicate_id, p.id AS proposition_id,
       p.normalized_value, p.created_at,
       coalesce(array_agg(c.id ORDER BY c.recorded_at,c.id) FILTER (WHERE c.id IS NOT NULL),'{}') AS claim_ids,
       coalesce(array_agg(DISTINCT c.claim_origin) FILTER (WHERE c.id IS NOT NULL),'{}') AS claim_origins,
       max(c.recorded_at) AS latest_claim_at
     FROM belief_slots s
     JOIN propositions p ON p.owner_scope_id=s.owner_scope_id AND p.belief_slot_id=s.id AND p.lifecycle='ACTIVE'
     LEFT JOIN claims c ON c.owner_scope_id=p.owner_scope_id AND c.proposition_id=p.id
       AND c.lifecycle NOT IN ('REJECTED','SUPPRESSED')
     WHERE s.owner_scope_id=$1 AND s.frame_instance_id=ANY($2::uuid[]) AND s.predicate_id=$3
       AND s.modality=$4 AND s.lifecycle='ACTIVE'
     GROUP BY s.frame_instance_id,s.id,s.predicate_id,p.id,p.normalized_value,p.created_at
     ORDER BY s.frame_instance_id,p.created_at,p.id`,
    [input.ownerScopeId, [...members.keys()], input.predicateId, input.modality])).rows;
  const inherited = await readInheritedClaims(tx, input.ownerScopeId, rows.map(row => row['proposition_id'] as string));
  const values = rows.map(row => {
    const propositionId = row['proposition_id'] as string;
    const extra = inherited.get(propositionId);
    return Object.freeze({
      frameInstanceId: members.get(row['frame_instance_id'] as string) ?? row['frame_instance_id'] as string,
      beliefSlotId: row['belief_slot_id'] as string,
      predicateId: row['predicate_id'] as string,
      propositionId,
      normalizedValue: row['normalized_value'],
      claimIds: Object.freeze(extra ? extra.claimIds : [...(row['claim_ids'] as string[])]),
      claimOrigins: Object.freeze(extra ? extra.claimOrigins : [...(row['claim_origins'] as string[])].sort()),
      latestClaimAt: extra ? extra.latestClaimAt : (row['latest_claim_at'] as Date | null) ?? null,
      createdAt: row['created_at'] as Date,
    });
  });
  return mapped(members)
    ? byFrameThen(values, (left, right) => compareTimes(left.createdAt, right.createdAt) || compareIds(left.propositionId, right.propositionId))
    : values;
}

/**
 * The claims a proposition carries through lineage: those of every proposition
 * merged into it (transitively), and those a split assigned to it with a support
 * row of the split transaction (ADR 0023 §2). Only propositions that carry any
 * are returned, with their whole claim set -- attached and inherited -- in the
 * order the main query uses, so a proposition with no lineage keeps the answer
 * the main query gave it.
 */
async function readInheritedClaims(tx: MemoryTransaction, ownerScopeId: string, propositionIds: readonly string[]): Promise<Map<string, {
  claimIds: string[]; claimOrigins: string[]; latestClaimAt: Date | null;
}>> {
  const result = new Map<string, { claimIds: string[]; claimOrigins: string[]; latestClaimAt: Date | null }>();
  if (propositionIds.length === 0) return result;
  const rows = (await tx.query(
    `WITH RECURSIVE merged(proposition_id,into_id,depth) AS (
       SELECT l.from_proposition_id,l.to_proposition_id,1 FROM proposition_lineage l
        WHERE l.owner_scope_id=$1 AND l.lineage_kind='MERGED_INTO' AND l.to_proposition_id=ANY($2::uuid[])
       UNION
       SELECT l.from_proposition_id,m.into_id,m.depth+1 FROM proposition_lineage l JOIN merged m ON l.to_proposition_id=m.proposition_id
        WHERE l.owner_scope_id=$1 AND l.lineage_kind='MERGED_INTO' AND m.depth<32),
     inherited(proposition_id,claim_id) AS (
       SELECT m.into_id,c.id FROM merged m JOIN claims c ON c.owner_scope_id=$1 AND c.proposition_id=m.proposition_id
       UNION
       SELECT s.proposition_id,s.claim_id FROM belief_support s
        JOIN belief_transactions t ON t.owner_scope_id=s.owner_scope_id AND t.id=s.created_by_transaction_id
         AND t.transaction_kind='SPLIT'
        WHERE s.owner_scope_id=$1 AND s.proposition_id=ANY($2::uuid[]) AND s.claim_id IS NOT NULL),
     carriers AS (SELECT DISTINCT proposition_id FROM inherited),
     every_claim(proposition_id,claim_id) AS (
       SELECT proposition_id,claim_id FROM inherited
       UNION
       SELECT c.proposition_id,c.id FROM claims c JOIN carriers k ON k.proposition_id=c.proposition_id WHERE c.owner_scope_id=$1)
     SELECT e.proposition_id,c.id,c.claim_origin,c.recorded_at FROM every_claim e
     JOIN claims c ON c.owner_scope_id=$1 AND c.id=e.claim_id AND c.lifecycle NOT IN ('REJECTED','SUPPRESSED')
     ORDER BY e.proposition_id,c.recorded_at,c.id`, [ownerScopeId, [...new Set(propositionIds)]])).rows;
  for (const row of rows) {
    const propositionId = row['proposition_id'] as string;
    const entry = result.get(propositionId) ?? { claimIds: [], claimOrigins: [], latestClaimAt: null };
    entry.claimIds.push(row['id'] as string);
    const origin = row['claim_origin'] as string;
    if (!entry.claimOrigins.includes(origin)) entry.claimOrigins.push(origin);
    const at = row['recorded_at'] as Date;
    if (entry.latestClaimAt === null || at.getTime() > entry.latestClaimAt.getTime()) entry.latestClaimAt = at;
    result.set(propositionId, entry);
  }
  for (const entry of result.values()) entry.claimOrigins.sort();
  return result;
}

/**
 * Which of several competing propositions the projection displays.
 *
 * The newest supported statement, with the proposition id breaking every tie, so
 * two reducer runs over the same rows always display the same one. This is a
 * *display* rule and not a truth rule: the values it did not pick are still
 * returned by `readSlotValues`, still stored, and still reported as a conflict.
 */
export function selectSlotValue(values: readonly SlotValue[]): SlotValue | null {
  if (values.length === 0) return null;
  return [...values].sort((left, right) => {
    const a = left.latestClaimAt?.getTime() ?? left.createdAt.getTime();
    const b = right.latestClaimAt?.getTime() ?? right.createdAt.getTime();
    if (a !== b) return b - a;
    return left.propositionId < right.propositionId ? 1 : left.propositionId > right.propositionId ? -1 : 0;
  })[0]!;
}

export interface RoleFill {
  readonly frameInstanceId: string;
  readonly roleId: string;
  readonly entityId: string | null;
  readonly typedValue: unknown;
  readonly createdAt: Date;
}

export async function readRoles(tx: MemoryTransaction, input: {
  ownerScopeId: string; frameInstanceIds: readonly string[];
}): Promise<RoleFill[]> {
  if (input.frameInstanceIds.length === 0) return [];
  const members = await listMergedFrameMembers(tx, { ownerScopeId: input.ownerScopeId, frameInstanceIds: input.frameInstanceIds });
  const rows = (await tx.query(
    `SELECT id,frame_instance_id,role_id,entity_id,typed_value,created_at FROM frame_instance_roles
     WHERE owner_scope_id=$1 AND frame_instance_id=ANY($2::uuid[])
     ORDER BY frame_instance_id,role_id,created_at,id`,
    [input.ownerScopeId, [...members.keys()]])).rows;
  // A merged entity reads as its survivor, so the person a role names is the one
  // identity the owner said it is (PRD §14.3).
  const entities = await resolveEntitySurvivors(tx, { ownerScopeId: input.ownerScopeId,
    entityIds: rows.map(row => row['entity_id'] as string | null).filter((id): id is string => id !== null) });
  const roles = rows.map(row => ({
    frameInstanceId: members.get(row['frame_instance_id'] as string) ?? row['frame_instance_id'] as string,
    roleId: row['role_id'] as string,
    entityId: row['entity_id'] === null || row['entity_id'] === undefined ? null
      : entities.get(row['entity_id'] as string) ?? row['entity_id'] as string,
    typedValue: row['typed_value'] as unknown,
    createdAt: row['created_at'] as Date,
    id: row['id'] as string,
  }));
  const ordered = mapped(members)
    ? byFrameThen(roles, (left, right) => compareIds(left.roleId, right.roleId) || compareTimes(left.createdAt, right.createdAt)
      || compareIds(left.id, right.id))
    : roles;
  return ordered.map(({ id: _id, ...role }) => Object.freeze(role));
}

/** The first filler of one role, or null. First rather than last: a role names a
 * participant of the situation, and a second filler is a signal to review the
 * instance, never a replacement for the first (PRD §11.5). */
export function roleEntity(roles: readonly RoleFill[], frameInstanceId: string, roleId: string): string | null {
  return roles.find(role => role.frameInstanceId === frameInstanceId && role.roleId === roleId && role.entityId !== null)?.entityId ?? null;
}
export function roleValue(roles: readonly RoleFill[], frameInstanceId: string, roleId: string): unknown {
  return roles.find(role => role.frameInstanceId === frameInstanceId && role.roleId === roleId && role.typedValue !== null)?.typedValue ?? null;
}

export interface ResolutionRow {
  readonly resolutionAssertionId: string;
  readonly sourceFrameInstanceId: string;
  readonly outcomeCode: string;
  readonly lifecycle: string;
  readonly advisoryCoverage: number | null;
  readonly effectiveAt: Date;
  readonly recordedAt: Date;
}

/** Every resolution asserted about the named frames. The reducer reads the
 * *state* through `frameOutcomeProjection` in `@unai/memory` rather than
 * recomputing the rule; this query exists for the assertion ids and for the
 * advisory coverage it must be able to show and must never use. */
export async function readResolutions(tx: MemoryTransaction, input: {
  ownerScopeId: string; frameInstanceIds: readonly string[];
}): Promise<ResolutionRow[]> {
  if (input.frameInstanceIds.length === 0) return [];
  const members = await listMergedFrameMembers(tx, { ownerScopeId: input.ownerScopeId, frameInstanceIds: input.frameInstanceIds });
  const rows = (await tx.query(
    `SELECT id,source_frame_instance_id,outcome_code,lifecycle,advisory_coverage,effective_at,recorded_at
     FROM resolution_assertions WHERE owner_scope_id=$1 AND source_frame_instance_id=ANY($2::uuid[])
     ORDER BY source_frame_instance_id,effective_at,recorded_at,id`,
    [input.ownerScopeId, [...members.keys()]])).rows;
  const resolutions = rows.map(row => Object.freeze({
    resolutionAssertionId: row['id'] as string,
    sourceFrameInstanceId: members.get(row['source_frame_instance_id'] as string) ?? row['source_frame_instance_id'] as string,
    outcomeCode: row['outcome_code'] as string,
    lifecycle: row['lifecycle'] as string,
    advisoryCoverage: row['advisory_coverage'] === null || row['advisory_coverage'] === undefined
      ? null : Number(row['advisory_coverage']),
    effectiveAt: row['effective_at'] as Date,
    recordedAt: row['recorded_at'] as Date,
  }));
  if (!mapped(members)) return resolutions;
  return resolutions.sort((left, right) => compareIds(left.sourceFrameInstanceId, right.sourceFrameInstanceId)
    || compareTimes(left.effectiveAt, right.effectiveAt) || compareTimes(left.recordedAt, right.recordedAt)
    || compareIds(left.resolutionAssertionId, right.resolutionAssertionId));
}

export interface RealizationRow {
  readonly memoryLinkId: string;
  readonly sourceFrameInstanceId: string;
  readonly realizingFrameInstanceId: string;
  readonly createdAt: Date;
}

export async function readRealizations(tx: MemoryTransaction, input: {
  ownerScopeId: string; frameInstanceIds: readonly string[];
}): Promise<RealizationRow[]> {
  if (input.frameInstanceIds.length === 0) return [];
  const members = await listMergedFrameMembers(tx, { ownerScopeId: input.ownerScopeId, frameInstanceIds: input.frameInstanceIds });
  const rows = (await tx.query(
    `SELECT id,to_object_id,from_object_id,created_at FROM memory_links
     WHERE owner_scope_id=$1 AND link_kind='REALIZES' AND to_object_type='frame_instance'
       AND to_object_id=ANY($2::uuid[]) AND lifecycle<>'RETRACTED'
     ORDER BY to_object_id,created_at,id`, [input.ownerScopeId, [...members.keys()]])).rows;
  const links = rows.map(row => Object.freeze({
    memoryLinkId: row['id'] as string,
    sourceFrameInstanceId: members.get(row['to_object_id'] as string) ?? row['to_object_id'] as string,
    realizingFrameInstanceId: row['from_object_id'] as string, createdAt: row['created_at'] as Date,
  }));
  if (!mapped(members)) return links;
  return links.sort((left, right) => compareIds(left.sourceFrameInstanceId, right.sourceFrameInstanceId)
    || compareTimes(left.createdAt, right.createdAt) || compareIds(left.memoryLinkId, right.memoryLinkId));
}

export interface OwnerDelta {
  readonly overlayDeltaId: string;
  readonly ownerSequence: number;
  readonly deltaKind: string;
  readonly lifecycle: string;
  readonly rawText: string;
  readonly frameInstanceId: string | null;
  readonly beliefSlotId: string | null;
  readonly predicateId: string | null;
  readonly createdAt: Date;
}

/**
 * Every owner overlay delta, resolved to the frame it speaks about.
 *
 * A delta may name its frame outright, or name a slot, a proposition or a claim
 * that belongs to one; all four are followed here, because the owner pointed at
 * the object the surface showed them and should not have to know which table it
 * lived in. A delta that resolves to no frame is still returned -- with a null
 * frame -- so the reducer can report it as pending rather than lose it
 * (CRT-RYW-04-A).
 */
export async function readOwnerDeltas(tx: MemoryTransaction, ownerScopeId: string): Promise<OwnerDelta[]> {
  const rows = (await tx.query(
    `SELECT d.id, d.owner_sequence, d.delta_kind, d.lifecycle, d.raw_text, d.created_at,
       coalesce(d.attached_frame_instance_id, a.frame_instance_id, s.frame_instance_id, ps.frame_instance_id,
         cs.frame_instance_id,
         CASE WHEN d.target_object_type='frame_instance' THEN d.target_object_id END) AS frame_instance_id,
       coalesce(d.attached_belief_slot_id, s.id, ps.id, cs.id) AS belief_slot_id,
       coalesce(a.predicate_id, s.predicate_id, ps.predicate_id, cs.predicate_id) AS predicate_id
     FROM owner_overlay_deltas d
     LEFT JOIN belief_slots a ON a.owner_scope_id=d.owner_scope_id AND a.id=d.attached_belief_slot_id
     LEFT JOIN belief_slots s ON s.owner_scope_id=d.owner_scope_id
       AND d.target_object_type='belief_slot' AND s.id=d.target_object_id
     LEFT JOIN propositions p ON p.owner_scope_id=d.owner_scope_id
       AND d.target_object_type='proposition' AND p.id=d.target_object_id
     LEFT JOIN belief_slots ps ON ps.owner_scope_id=p.owner_scope_id AND ps.id=p.belief_slot_id
     LEFT JOIN claims c ON c.owner_scope_id=d.owner_scope_id
       AND d.target_object_type='claim' AND c.id=d.target_object_id
     LEFT JOIN propositions cp ON cp.owner_scope_id=c.owner_scope_id AND cp.id=c.proposition_id
     LEFT JOIN belief_slots cs ON cs.owner_scope_id=cp.owner_scope_id AND cs.id=cp.belief_slot_id
     WHERE d.owner_scope_id=$1
     ORDER BY d.owner_sequence`, [ownerScopeId])).rows;
  // A delta about a merged frame speaks about its survivor. One about a split
  // frame resolves to no frame and is reported as unattached, never re-attached
  // to a guessed half (ADR 0023 §3).
  const survivors = await resolveFrameInstanceSurvivors(tx, { ownerScopeId,
    frameInstanceIds: rows.map(row => row['frame_instance_id'] as string | null).filter((id): id is string => id !== null) });
  return rows.map(row => Object.freeze({
    overlayDeltaId: row['id'] as string,
    ownerSequence: Number(row['owner_sequence']),
    deltaKind: row['delta_kind'] as string,
    lifecycle: row['lifecycle'] as string,
    rawText: row['raw_text'] as string,
    frameInstanceId: row['frame_instance_id'] === null || row['frame_instance_id'] === undefined ? null
      : survivors.has(row['frame_instance_id'] as string) ? survivors.get(row['frame_instance_id'] as string)!
        : row['frame_instance_id'] as string,
    beliefSlotId: (row['belief_slot_id'] as string | null) ?? null,
    predicateId: (row['predicate_id'] as string | null) ?? null,
    createdAt: row['created_at'] as Date,
  }));
}

/** A delta the reducer could not fold in, in the shape the read answers with. */
export function pendingAssertion(delta: OwnerDelta, reason: PendingAssertion['reason']): PendingAssertion {
  return Object.freeze({
    overlayDeltaId: delta.overlayDeltaId,
    ownerSequence: delta.ownerSequence,
    deltaKind: delta.deltaKind,
    lifecycle: delta.lifecycle,
    rawText: delta.rawText,
    reason,
    targetFrameInstanceId: delta.frameInstanceId,
  });
}

/** Lifecycles a delta has already left the pending state through. A committed
 * delta is canonical memory now and is read from there; a withdrawn, rejected or
 * superseded one no longer asks anything of the projection. */
const SETTLED_LIFECYCLES = new Set(['COMMITTED', 'WITHDRAWN', 'REJECTED_AS_INTERPRETATION', 'SUPERSEDED']);
export function isSettledDelta(delta: OwnerDelta): boolean { return SETTLED_LIFECYCLES.has(delta.lifecycle); }

/** The latest of a set of times, used for `updated_at` and
 * `last_material_update`.
 *
 * Derived from the inputs rather than from `now()` on purpose: a rebuild days
 * later must reproduce the same value, which is what lets CRT-PRJ-02-B compare
 * rows column by column instead of column by column minus the timestamps.
 */
export function latestTime(times: ReadonlyArray<Date | null | undefined>, fallback: Date): Date {
  let latest = fallback;
  for (const time of times) if (time && time.getTime() > latest.getTime()) latest = time;
  return latest;
}
