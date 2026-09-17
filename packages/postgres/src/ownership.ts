import type { Pool } from 'pg';

/** Adding an application table requires an explicit classification and an
 * unfiltered cross-owner fixture in isolation.test.ts before migration exit.
 */
const classifiedTables=new Map([
  ['users','id'],['owner_scopes','id'],['owner_scope_members','owner_scope_id'],
  ['devices','owner_scope_id'],['audit_events','owner_scope_id'],
  ['auth_identities','owner_scope_id'],['auth_sessions','owner_scope_id'],
  ['connectors','owner_scope_id'],['source_items','owner_scope_id'],['source_anchors','owner_scope_id'],
  ['evidence_ingestion_receipts','owner_scope_id'],
]);
/** Global Git registry snapshot (ADR 0011): not owner data, so it must stay
 * forced-RLS and completely inaccessible to the application role.
 */
const globalReferenceTables=new Set(['registry_releases','registry_contracts']);

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

