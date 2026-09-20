import { randomUUID } from 'node:crypto';
import { exportBundleSchema, type ExportBundle } from '@unai/domain';
import { requirePurpose, type ControlTransaction } from './transaction.js';
import { DATA_EXPORT_PURPOSE } from './erasure.js';
import { conversationRow, conversationTurnRow } from './conversations.js';

/**
 * Export (PRD §7.8, NFR portability; design `POST /v1/export`; CRT-NFR-04-A).
 *
 * The bundle is the owner's raw evidence -- metadata, anchors and the stored
 * bytes -- and their canonical memory objects, read under `data.export`, which
 * the row policies hold to the owner boundary and, for evidence, to the declared
 * sensitivity ceiling. It never contains an object-store key, a session, a
 * secret, a job payload or an embedding vector: an embedding is an index and is
 * regenerated from canonical memory, never exported as memory.
 */

const CANONICAL_TABLES = Object.freeze([
  ['entities', 'entities', 'created_at,id'],
  ['entityAliases', 'entity_aliases', 'id'],
  ['frameInstances', 'frame_instances', 'created_at,id'],
  ['frameInstanceRoles', 'frame_instance_roles', 'id'],
  ['beliefSlots', 'belief_slots', 'created_at,id'],
  ['propositions', 'propositions', 'created_at,id'],
  ['claims', 'claims', 'recorded_at,id'],
  ['beliefAssessments', 'belief_assessments', 'recorded_at,id'],
  ['beliefSupport', 'belief_support', 'id'],
  ['claimRelations', 'claim_relations', 'id'],
  ['resolutionAssertions', 'resolution_assertions', 'recorded_at,id'],
  ['memoryLinks', 'memory_links', 'id'],
  ['memoryThreads', 'memory_threads', 'created_at,id'],
  ['memoryThreadMembers', 'memory_thread_members', 'memory_thread_id,object_type,object_id'],
  ['derivedPropositionDependencies', 'derived_proposition_dependencies', 'created_at,id'],
  ['memorySummaries', 'memory_summaries', 'generated_at,id'],
] as const);
const ACTION_TABLES = Object.freeze([
  ['recommendations', 'recommendation_artifacts', 'created_at,id'],
  ['drafts', 'drafts', 'created_at,id'],
  ['actionHistory', 'action_history', 'created_at,id'],
] as const);

/** A database row as JSON: instants as ISO strings, everything else as stored. */
function plain(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) =>
    [key, value instanceof Date ? value.toISOString() : Buffer.isBuffer(value) ? value.toString('base64') : value]));
}

export async function buildExportBundle(tx: ControlTransaction, input: {
  includeRawEvidence: boolean; exportId?: string;
  /** Reads one item's stored bytes through the evidence object store. */
  readRaw: (rawObjectRef: string) => Promise<Uint8Array>;
}): Promise<ExportBundle> {
  requirePurpose(tx, DATA_EXPORT_PURPOSE);
  const owner = tx.context.ownerScopeId;
  const items = (await tx.query(
    `SELECT id,source_type,connector_id,external_id,parent_external_id,actor_ref,occurred_at,observed_at,content_hash,
       sensitivity,allowed_purposes,deterministic_metadata,raw_object_ref
     FROM source_items WHERE owner_scope_id=$1 AND deleted_at IS NULL ORDER BY observed_at,id`, [owner])).rows;
  const anchors = (await tx.query(
    `SELECT source_item_id,anchor_kind,anchor,normalized_text FROM source_anchors WHERE owner_scope_id=$1
     ORDER BY source_item_id,anchor_kind,id`, [owner])).rows;
  const evidence = [];
  for (const item of items) {
    const raw = input.includeRawEvidence ? Buffer.from(await input.readRaw(item['raw_object_ref'] as string)).toString('base64') : null;
    evidence.push({
      evidenceId: item['id'], sourceType: item['source_type'], connectorId: item['connector_id'] ?? null,
      externalId: item['external_id'], parentExternalId: item['parent_external_id'] ?? null, actorRef: item['actor_ref'],
      occurredAt: item['occurred_at'] ? (item['occurred_at'] as Date).toISOString() : null,
      observedAt: (item['observed_at'] as Date).toISOString(), contentHash: item['content_hash'],
      sensitivity: item['sensitivity'], allowedPurposes: item['allowed_purposes'],
      deterministicMetadata: item['deterministic_metadata'],
      anchors: anchors.filter(anchor => anchor['source_item_id'] === item['id']).map(anchor => ({
        kind: anchor['anchor_kind'], anchor: anchor['anchor'], normalizedText: anchor['normalized_text'] ?? null })),
      rawContentBase64: raw,
    });
  }
  const read = async (table: string, order: string) => (await tx.query(
    `SELECT * FROM ${table} WHERE owner_scope_id=$1 ORDER BY ${order}`, [owner])).rows.map(plain);
  const canonicalMemory: Record<string, Record<string, unknown>[]> = {};
  for (const [key, table, order] of CANONICAL_TABLES) canonicalMemory[key] = await read(table, order);
  const actions: Record<string, Record<string, unknown>[]> = {};
  for (const [key, table, order] of ACTION_TABLES) actions[key] = await read(table, order);
  const conversations = (await tx.query('SELECT * FROM conversations WHERE owner_scope_id=$1 ORDER BY created_at,id', [owner])).rows.map(conversationRow);
  const conversationTurns = (await tx.query(`SELECT t.* FROM conversation_turns t JOIN conversations c ON c.owner_scope_id=t.owner_scope_id AND c.id=t.conversation_id
    WHERE t.owner_scope_id=$1 ORDER BY c.created_at,c.id,t.stored_order`, [owner])).rows.map(conversationTurnRow);
  const counts: Record<string, number> = { evidence: evidence.length, conversations: conversations.length, conversationTurns: conversationTurns.length };
  for (const [key, rows] of [...Object.entries(canonicalMemory), ...Object.entries(actions)]) counts[key] = rows.length;
  return exportBundleSchema.parse({
    exportId: input.exportId ?? randomUUID(), formatVersion: 'unai-export-0.1.0', ownerScopeId: owner,
    generatedAt: new Date().toISOString(), evidence, canonicalMemory, actions, conversations, conversationTurns, counts,
  });
}
