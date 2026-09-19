import type { Pool } from 'pg';

/** Adding an application table requires an explicit classification and an
 * unfiltered cross-owner fixture in isolation.test.ts before migration exit.
 */
const classifiedTables=new Map([
  ['users','id'],['owner_scopes','id'],['owner_scope_members','owner_scope_id'],
  ['devices','owner_scope_id'],['audit_events','owner_scope_id'],
  ['auth_identities','owner_scope_id'],['auth_sessions','owner_scope_id'],
  ['connectors','owner_scope_id'],['connector_capability_grants','owner_scope_id'],
  ['source_items','owner_scope_id'],['source_anchors','owner_scope_id'],
  ['evidence_object_keys','owner_scope_id'],
  ['evidence_ingestion_receipts','owner_scope_id'],['jobs','owner_scope_id'],
  ['context_spaces','owner_scope_id'],
  ['entities','owner_scope_id'],['entity_aliases','owner_scope_id'],['entity_lineage','owner_scope_id'],
  ['frame_instances','owner_scope_id'],['frame_instance_roles','owner_scope_id'],
  ['belief_slots','owner_scope_id'],['slot_fingerprints','owner_scope_id'],
  ['propositions','owner_scope_id'],['proposition_fingerprints','owner_scope_id'],
  ['claims','owner_scope_id'],
  ['instance_match_candidates','owner_scope_id'],['claim_relations','owner_scope_id'],
  ['memory_links','owner_scope_id'],['resolution_assertions','owner_scope_id'],
  ['triage_decisions','owner_scope_id'],['extraction_runs','owner_scope_id'],
  ['model_call_records','owner_scope_id'],
  ['belief_transactions','owner_scope_id'],['belief_transaction_operations','owner_scope_id'],
  ['belief_assessments','owner_scope_id'],['belief_support','owner_scope_id'],
  ['derived_proposition_dependencies','owner_scope_id'],['policy_decisions','owner_scope_id'],
  ['owner_sequences','owner_scope_id'],['owner_overlay_deltas','owner_scope_id'],['memory_operations','owner_scope_id'],
  ['open_commitments_projection','owner_scope_id'],['obligations_projection','owner_scope_id'],
  ['schedule_projection','owner_scope_id'],['projection_rebuild_receipts','owner_scope_id'],
  ['memory_threads','owner_scope_id'],['memory_thread_members','owner_scope_id'],
  ['context_packets','owner_scope_id'],
  ['frame_instance_lineage','owner_scope_id'],['proposition_lineage','owner_scope_id'],
  ['memory_embeddings','owner_scope_id'],
  ['answer_manifests','owner_scope_id'],['reconsideration_candidates','owner_scope_id'],
  ['briefing_editions','owner_scope_id'],['briefing_items','owner_scope_id'],
  ['attention_budgets','owner_scope_id'],['learned_approval_rules','owner_scope_id'],['clarification_cards','owner_scope_id'],
  ['interruption_decisions','owner_scope_id'],['weekly_reviews','owner_scope_id'],['behavioral_observations','owner_scope_id'],
  ['plugin_capability_grants','owner_scope_id'],['recommendation_artifacts','owner_scope_id'],['drafts','owner_scope_id'],
  ['action_history','owner_scope_id'],['retention_settings','owner_scope_id'],
  ['domain_sensitivity_settings','owner_scope_id'],['memory_summaries','owner_scope_id'],
  ['retention_and_deletion_requests','owner_scope_id'],
  ['shadow_evaluation_runs','owner_scope_id'],['economic_and_quality_metrics','owner_scope_id'],
  ['goals','owner_scope_id'],['goal_priority_history','owner_scope_id'],['decision_projection','owner_scope_id'],
  ['mentor_cards','owner_scope_id'],
]);
/** CRT-SEC-01-A covers *every* owner-scoped table, so the cross-owner isolation
 * suite is driven from this classification instead of a second hand-kept list: a
 * new owner table with no unfiltered fixture fails the suite rather than passing
 * unexamined. */
export const OWNER_SCOPED_TABLES:readonly string[]=Object.freeze([...classifiedTables.keys()]);
/** Global Git registry snapshot (ADR 0011) and the migration manifests published
 * with it (ADR 0031): not owner data, so they must stay forced-RLS and completely
 * inaccessible to the application role.
 */
const globalReferenceTables=new Set(['registry_releases','registry_contracts','registry_migration_manifests']);

export async function assertOwnershipCoverage(pool:Pool):Promise<void>{
  const rows=(await pool.query(`SELECT n.nspname AS schema,c.relname,c.relrowsecurity,c.relforcerowsecurity,
    has_schema_privilege('unai_app',n.oid,'USAGE,CREATE') AS app_schema_access,
    has_table_privilege('unai_app',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS app_table_access,
    ARRAY(SELECT attname FROM pg_attribute WHERE attrelid=c.oid AND attnum>0 AND NOT attisdropped) AS columns,
    EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=c.oid) AS has_policy
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema')
    AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'`)).rows;
  const ownerTables=rows.filter(row=>!(row.schema==='unai_migrations' && row.relname==='applied'
    && !row.app_schema_access && !row.app_table_access));
  const globalTables=ownerTables.filter(row=>row.schema==='public' && globalReferenceTables.has(row.relname));
  if(globalTables.length!==globalReferenceTables.size || globalTables.some(row=>
    !row.relrowsecurity || !row.relforcerowsecurity || row.has_policy || row.app_table_access
  ))throw new Error('OWNERSHIP_COVERAGE_INVALID');
  const scopedTables=ownerTables.filter(row=>!globalTables.includes(row));
  if(scopedTables.length!==classifiedTables.size || scopedTables.some(row=>
    row.schema!=='public' || !classifiedTables.has(row.relname) || !row.relrowsecurity ||
    !row.relforcerowsecurity || !row.has_policy || !row.columns.includes(classifiedTables.get(row.relname))
  ))throw new Error('OWNERSHIP_COVERAGE_INVALID');
}

