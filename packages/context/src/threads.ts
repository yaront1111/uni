import {
  memoryThreadViewSchema, threadMemberInputSchema, threadMemberSchema, threadObjectTypeSchema,
  contextBeliefSchema, contextFutureClaimSchema, contextResolutionSchema, contextUnknownSchema,
  type MemoryThreadView, type ThreadMember, type ThreadMemberInput,
} from '@unai/domain';
import { MemoryStoreError, type MemoryTransaction } from '@unai/memory';
import { uuidV7 } from '../../../src/kernel/identities.js';
import { deriveLifeCategories } from './categories.js';
import { readProjectionFragments } from './fragments.js';

/**
 * The memory thread service (PRD §33.11, §50; design GET /v1/memory/threads/{id}
 * and POST /v1/memory/threads/{id}/members).
 *
 * A thread is a worldline: the situation a set of already-stored objects belongs
 * to. It is not a container and it owns nothing. That is the whole of
 * CRT-RD-10-A: attaching an object to a second thread writes one membership row
 * naming an object that already exists, so no evidence, claim, proposition or
 * frame instance is created, copied or duplicated, and the object appears in both
 * threads' reads from the one row it always had.
 *
 * Every function takes a transaction the caller opened inside the owner boundary.
 */

export const THREAD_SERVICE_VERSION = 'memory-threads-0.1.0';

export class MemoryThreadError extends Error {
  constructor(code: string) { super(code); this.name = 'MemoryThreadError'; }
}

export async function createMemoryThread(tx: MemoryTransaction, input: {
  ownerScopeId: string; displayTitle?: string | null;
}): Promise<string> {
  const id = uuidV7();
  await tx.query('INSERT INTO memory_threads(id,owner_scope_id,display_title) VALUES($1,$2,$3)',
    [id, input.ownerScopeId, input.displayTitle ?? null]);
  return id;
}

/** Which of the given threads are still open. The narrow read a plugin needs to
 * decide whether an upload belongs to an active workflow (CRT-CON-05-A); it lives
 * here so the plugin runtime reads no memory table itself (CRT-RD-01-A). */
export async function listOpenThreadIds(tx: MemoryTransaction, input: {
  ownerScopeId: string; threadIds: readonly string[];
}): Promise<string[]> {
  if (input.threadIds.length === 0) return [];
  const rows = (await tx.query(
    `SELECT id FROM memory_threads WHERE owner_scope_id=$1 AND id=ANY($2::uuid[]) AND lifecycle='OPEN' ORDER BY id`,
    [input.ownerScopeId, [...input.threadIds]])).rows;
  return rows.map(row => row['id'] as string);
}

/** The object types a membership may name, and the table each one lives in. A
 * membership that named a row that does not exist would be a thread that shows
 * something the owner never recorded. */
const MEMBER_TABLES: Readonly<Record<string, string>> = Object.freeze({
  frame_instance: 'frame_instances', proposition: 'propositions', claim: 'claims',
  entity: 'entities', resolution_assertion: 'resolution_assertions',
});

/**
 * Attach one existing object to one thread.
 *
 * Idempotent by primary key: repeating the request is the same single row, and
 * the answer says whether this call created it. Nothing is written outside
 * `memory_thread_members` -- not an evidence row, not a claim, not a belief
 * transaction (CRT-RD-10-A).
 */
export async function addThreadMember(tx: MemoryTransaction, input: {
  ownerScopeId: string; memoryThreadId: string; member: ThreadMemberInput;
}): Promise<{ created: boolean; member: ThreadMember }> {
  const member = threadMemberInputSchema.parse(input.member);
  const thread = await tx.query('SELECT id FROM memory_threads WHERE owner_scope_id=$1 AND id=$2',
    [input.ownerScopeId, input.memoryThreadId]);
  if (thread.rowCount !== 1) throw new MemoryThreadError('MEMORY_THREAD_NOT_FOUND');
  const table = MEMBER_TABLES[member.objectType];
  if (!table) throw new MemoryThreadError('MEMORY_THREAD_OBJECT_TYPE_UNKNOWN');
  const object = await tx.query(`SELECT id FROM ${table} WHERE owner_scope_id=$1 AND id=$2`,
    [input.ownerScopeId, member.objectId]);
  if (object.rowCount !== 1) throw new MemoryThreadError('MEMORY_THREAD_OBJECT_NOT_FOUND');
  const inserted = await tx.query(
    `INSERT INTO memory_thread_members(owner_scope_id,memory_thread_id,object_type,object_id,membership_kind,
       confidence,transaction_id)
     VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING created_at`,
    [input.ownerScopeId, input.memoryThreadId, member.objectType, member.objectId, member.membershipKind,
      member.confidence, member.transactionId]);
  const stored = await readMember(tx, input.ownerScopeId, input.memoryThreadId, member.objectType, member.objectId);
  if (!stored) throw new MemoryThreadError('MEMORY_THREAD_MEMBER_NOT_STORED');
  return { created: inserted.rowCount === 1, member: stored };
}

/** Every thread one object already belongs to. The Context Broker uses it to put
 * a thread reference beside a retrieved belief. */
export async function listThreadsForObject(tx: MemoryTransaction, input: {
  ownerScopeId: string; objectType: string; objectId: string;
}): Promise<Array<{ memoryThreadId: string; displayTitle: string | null; memberCount: number }>> {
  const rows = (await tx.query(
    `SELECT t.id,t.display_title,
       (SELECT count(*)::int FROM memory_thread_members c WHERE c.owner_scope_id=t.owner_scope_id AND c.memory_thread_id=t.id) AS member_count
     FROM memory_thread_members m JOIN memory_threads t ON t.owner_scope_id=m.owner_scope_id AND t.id=m.memory_thread_id
     WHERE m.owner_scope_id=$1 AND m.object_type=$2 AND m.object_id=$3 ORDER BY t.created_at,t.id`,
    [input.ownerScopeId, input.objectType, input.objectId])).rows;
  return rows.map(row => ({
    memoryThreadId: row['id'] as string,
    displayTitle: (row['display_title'] as string | null) ?? null,
    memberCount: row['member_count'] as number,
  }));
}

/**
 * The evidence already behind one object.
 *
 * It is read from the object's own claims and never from the membership, which
 * carries no evidence column at all. Two threads holding the same object
 * therefore report the same evidence ids, which is what "without creating a
 * second evidence row" means when the reader checks it.
 */
async function evidenceOf(tx: MemoryTransaction, ownerScopeId: string, objectType: string, objectId: string): Promise<string[]> {
  const claimEvidence = `SELECT DISTINCT a.source_item_id AS evidence_id FROM claims c
     JOIN source_anchors a ON a.owner_scope_id=c.owner_scope_id AND a.id=c.source_anchor_id
     WHERE c.owner_scope_id=$1 AND `;
  const sql = objectType === 'claim' ? claimEvidence + 'c.id=$2'
    : objectType === 'proposition' ? claimEvidence + 'c.proposition_id=$2'
      : objectType === 'frame_instance' ? claimEvidence + `c.proposition_id IN (
          SELECT p.id FROM propositions p JOIN belief_slots s ON s.owner_scope_id=p.owner_scope_id AND s.id=p.belief_slot_id
          WHERE p.owner_scope_id=c.owner_scope_id AND s.frame_instance_id=$2)`
        : objectType === 'resolution_assertion' ? claimEvidence + `c.id=(
            SELECT r.claim_id FROM resolution_assertions r WHERE r.owner_scope_id=c.owner_scope_id AND r.id=$2)`
          : `SELECT DISTINCT source_item_id AS evidence_id FROM entity_aliases
             WHERE owner_scope_id=$1 AND entity_id=$2 AND source_item_id IS NOT NULL`;
  const rows = (await tx.query(sql + ' ORDER BY 1', [ownerScopeId, objectId])).rows;
  return rows.map(row => row['evidence_id'] as string);
}

async function readMember(tx: MemoryTransaction, ownerScopeId: string, memoryThreadId: string,
  objectType: string, objectId: string): Promise<ThreadMember | null> {
  const row = (await tx.query(
    `SELECT memory_thread_id,object_type,object_id,membership_kind,confidence,transaction_id,created_at
     FROM memory_thread_members WHERE owner_scope_id=$1 AND memory_thread_id=$2 AND object_type=$3 AND object_id=$4`,
    [ownerScopeId, memoryThreadId, objectType, objectId])).rows[0];
  if (!row) return null;
  return threadMemberSchema.parse({
    memoryThreadId: row['memory_thread_id'], objectType: row['object_type'], objectId: row['object_id'],
    membershipKind: row['membership_kind'],
    confidence: row['confidence'] === null || row['confidence'] === undefined ? null : Number(row['confidence']),
    transactionId: (row['transaction_id'] as string | null) ?? null,
    createdAt: (row['created_at'] as Date).toISOString(),
    evidenceIds: await evidenceOf(tx, ownerScopeId, objectType as string, objectId),
  });
}

/**
 * The Memory thread screen's read: current projection, timeline, plans and
 * expected outcomes, actual events, resolution links, open uncertainties and the
 * related people, documents and decisions.
 *
 * Every section is computed from the membership rows and the canonical objects
 * they name. The thread stores none of it, so a thread cannot disagree with
 * memory.
 */
export async function readMemoryThread(tx: MemoryTransaction, input: {
  ownerScopeId: string; memoryThreadId: string; readAt: Date;
}): Promise<MemoryThreadView> {
  const thread = (await tx.query(
    'SELECT id,display_title,lifecycle,created_at FROM memory_threads WHERE owner_scope_id=$1 AND id=$2',
    [input.ownerScopeId, input.memoryThreadId])).rows[0];
  if (!thread) throw new MemoryThreadError('MEMORY_THREAD_NOT_FOUND');

  const memberRows = (await tx.query(
    `SELECT object_type,object_id FROM memory_thread_members WHERE owner_scope_id=$1 AND memory_thread_id=$2
     ORDER BY object_type,object_id`, [input.ownerScopeId, input.memoryThreadId])).rows;
  const members: ThreadMember[] = [];
  for (const row of memberRows) {
    const member = await readMember(tx, input.ownerScopeId, input.memoryThreadId,
      row['object_type'] as string, row['object_id'] as string);
    if (member) members.push(member);
  }
  const frameInstanceIds = members.filter(member => member.objectType === 'frame_instance').map(member => member.objectId);
  const entityIds = members.filter(member => member.objectType === 'entity').map(member => member.objectId);

  // Every proposition the thread's frames and propositions cover, with the frame
  // it belongs to and the assessment that stands over it now.
  const beliefRows = frameInstanceIds.length === 0 && members.every(member => member.objectType !== 'proposition') ? []
    : (await tx.query(
      `SELECT p.id AS proposition_id,p.belief_slot_id,p.normalized_value,p.polarity,s.frame_instance_id,s.predicate_id,
         s.modality,f.frame_type_id,
         (SELECT b.assessment_status FROM belief_assessments b WHERE b.owner_scope_id=p.owner_scope_id
           AND b.proposition_id=p.id AND b.superseded_recorded_at IS NULL ORDER BY b.recorded_at DESC,b.id DESC LIMIT 1) AS assessment_status,
         (SELECT b.recorded_at FROM belief_assessments b WHERE b.owner_scope_id=p.owner_scope_id
           AND b.proposition_id=p.id AND b.superseded_recorded_at IS NULL ORDER BY b.recorded_at DESC,b.id DESC LIMIT 1) AS assessment_recorded_at
       FROM propositions p
       JOIN belief_slots s ON s.owner_scope_id=p.owner_scope_id AND s.id=p.belief_slot_id
       JOIN frame_instances f ON f.owner_scope_id=s.owner_scope_id AND f.id=s.frame_instance_id
       WHERE p.owner_scope_id=$1 AND (s.frame_instance_id=ANY($2::uuid[]) OR p.id=ANY($3::uuid[]))
       ORDER BY f.id,s.id,p.id`,
      [input.ownerScopeId, frameInstanceIds,
        members.filter(member => member.objectType === 'proposition').map(member => member.objectId)])).rows;

  const ACTUAL_MODALITIES = new Set(['ACTUAL']);
  const actualEvents = [];
  const plans = [];
  for (const row of beliefRows) {
    const categories = deriveLifeCategories({ frameTypeId: row['frame_type_id'] as string });
    if (ACTUAL_MODALITIES.has(row['modality'] as string)) {
      actualEvents.push(contextBeliefSchema.parse({
        propositionId: row['proposition_id'], beliefSlotId: row['belief_slot_id'],
        frameInstanceId: row['frame_instance_id'], frameTypeId: row['frame_type_id'],
        predicateId: row['predicate_id'], modality: row['modality'], polarity: row['polarity'],
        normalizedValue: row['normalized_value'],
        assessmentStatus: (row['assessment_status'] as string | null) ?? null,
        assessmentRecordedAt: row['assessment_recorded_at'] ? (row['assessment_recorded_at'] as Date).toISOString() : null,
        validFrom: null, validTo: null,
        certainty: row['assessment_status'] === 'ACCEPTED' ? 'ACCEPTED'
          : row['assessment_status'] === 'CONTESTED' ? 'CONTESTED' : 'PROVISIONAL',
        lifeCategories: categories, claimIds: [], evidenceIds: [],
        selectionReason: 'THREAD_MEMBER_ACTUAL_STATE',
      }));
    } else {
      plans.push(contextFutureClaimSchema.parse({
        propositionId: row['proposition_id'], frameInstanceId: row['frame_instance_id'],
        frameTypeId: row['frame_type_id'], predicateId: row['predicate_id'], modality: row['modality'],
        normalizedValue: row['normalized_value'], validFrom: null, lifeCategories: categories,
      }));
    }
  }

  const resolutionRows = frameInstanceIds.length === 0 ? [] : (await tx.query(
    `SELECT id,source_frame_instance_id,target_frame_instance_id,outcome_code,effective_at,lifecycle,transition_contract_id
     FROM resolution_assertions WHERE owner_scope_id=$1
       AND (source_frame_instance_id=ANY($2::uuid[]) OR target_frame_instance_id=ANY($2::uuid[]))
     ORDER BY effective_at,id`, [input.ownerScopeId, frameInstanceIds])).rows;
  const resolutionLinks = resolutionRows.map(row => contextResolutionSchema.parse({
    resolutionAssertionId: row['id'], sourceFrameInstanceId: row['source_frame_instance_id'],
    targetFrameInstanceId: (row['target_frame_instance_id'] as string | null) ?? null,
    outcomeCode: row['outcome_code'], effectiveAt: (row['effective_at'] as Date).toISOString(),
    lifecycle: row['lifecycle'], transitionContractId: row['transition_contract_id'],
  }));

  // The timeline: evidence, claims, plans, events, resolutions and the owner's
  // own assertions, in the order they happened.
  const timeline: MemoryThreadView['timeline'] = [];
  const evidenceIds = [...new Set(members.flatMap(member => member.evidenceIds))];
  if (evidenceIds.length > 0) {
    const evidenceRows = (await tx.query(
      `SELECT id,source_type,coalesce(occurred_at,observed_at) AS at FROM source_items
       WHERE owner_scope_id=$1 AND id=ANY($2::uuid[]) ORDER BY at,id`, [input.ownerScopeId, evidenceIds])).rows;
    for (const row of evidenceRows) {
      timeline.push({ at: (row['at'] as Date).toISOString(), kind: 'EVIDENCE', objectType: 'source_items',
        objectId: row['id'] as string, detail: row['source_type'] as string });
    }
  }
  for (const resolution of resolutionLinks) {
    timeline.push({ at: resolution.effectiveAt, kind: 'RESOLUTION', objectType: 'resolution_assertions',
      objectId: resolution.resolutionAssertionId, detail: resolution.outcomeCode });
  }
  const deltaRows = (await tx.query(
    `SELECT id,created_at,delta_kind FROM owner_overlay_deltas
     WHERE owner_scope_id=$1 AND (attached_frame_instance_id=ANY($2::uuid[]) OR $3=ANY(candidate_worldline_refs))
     ORDER BY owner_sequence`, [input.ownerScopeId, frameInstanceIds, input.memoryThreadId])).rows;
  for (const row of deltaRows) {
    timeline.push({ at: (row['created_at'] as Date).toISOString(), kind: 'OWNER_ASSERTION',
      objectType: 'owner_overlay_deltas', objectId: row['id'] as string, detail: row['delta_kind'] as string });
  }
  timeline.sort((left, right) => left.at.localeCompare(right.at) || left.objectId.localeCompare(right.objectId));

  // Open uncertainties: what the thread shows that memory has not settled.
  const openUncertainties = beliefRows
    .filter(row => row['assessment_status'] !== 'ACCEPTED')
    .map(row => contextUnknownSchema.parse({
      kind: 'NO_ACCEPTED_VALUE', objectType: 'propositions', objectId: row['proposition_id'] as string,
      detail: row['assessment_status'] === 'CONTESTED' ? 'CONTESTED_BELIEF' : 'NO_ACCEPTED_ASSESSMENT',
    }));

  // Related people and documents: the entities that fill a role of the thread's
  // frames, plus the entities named as members outright.
  const roleEntityRows = frameInstanceIds.length === 0 ? [] : (await tx.query(
    `SELECT DISTINCT entity_id FROM frame_instance_roles
     WHERE owner_scope_id=$1 AND frame_instance_id=ANY($2::uuid[]) AND entity_id IS NOT NULL`,
    [input.ownerScopeId, frameInstanceIds])).rows;
  const relatedEntityIds = [...new Set([...entityIds, ...roleEntityRows.map(row => row['entity_id'] as string)])];
  const entityRows = relatedEntityIds.length === 0 ? [] : (await tx.query(
    'SELECT id,entity_kind,canonical_label FROM entities WHERE owner_scope_id=$1 AND id=ANY($2::uuid[]) ORDER BY id',
    [input.ownerScopeId, relatedEntityIds])).rows;

  const frameRows = frameInstanceIds.length === 0 ? [] : (await tx.query(
    'SELECT id,frame_type_id FROM frame_instances WHERE owner_scope_id=$1 AND id=ANY($2::uuid[]) ORDER BY id',
    [input.ownerScopeId, frameInstanceIds])).rows;

  return memoryThreadViewSchema.parse({
    memoryThreadId: thread['id'], displayTitle: (thread['display_title'] as string | null) ?? null,
    lifecycle: thread['lifecycle'], createdAt: (thread['created_at'] as Date).toISOString(),
    members,
    currentProjection: await readProjectionFragments(tx, {
      ownerScopeId: input.ownerScopeId, asOf: input.readAt, frameInstanceIds,
    }),
    timeline, plansAndExpectedOutcomes: plans, actualEvents, resolutionLinks, openUncertainties,
    relatedPeople: entityRows.filter(row => row['entity_kind'] !== 'DOCUMENT').map(row => ({
      entityId: row['id'], entityKind: row['entity_kind'], canonicalLabel: (row['canonical_label'] as string | null) ?? null,
    })),
    relatedDocuments: entityRows.filter(row => row['entity_kind'] === 'DOCUMENT').map(row => ({
      entityId: row['id'], canonicalLabel: (row['canonical_label'] as string | null) ?? null,
    })),
    relatedDecisions: frameRows.filter(row => (row['frame_type_id'] as string).includes('decision')).map(row => ({
      frameInstanceId: row['id'], frameTypeId: row['frame_type_id'],
    })),
    evidenceIds,
    threadVersion: THREAD_SERVICE_VERSION,
    readAt: input.readAt.toISOString(),
  });
}

/** Re-exported so a caller that already depends on the memory store's error type
 * can catch both without importing two packages. */
export { MemoryStoreError };
