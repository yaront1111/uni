import { Pool } from 'pg';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { runMigrations, withOwnerTransaction, type OwnerTransaction } from '@unai/postgres';
import { lintRegistryCheckout } from '@unai/registry';
import type { RequestContext, TransitionContract } from '@unai/domain';
import {
  createFrameInstance, recordClaim, recordFrameInstanceRole, recordOverlayDelta, resolveBeliefSlot, resolveEntity,
  resolveProposition,
} from '@unai/memory';
import { applyProjectionDelta, canonicalizeCommitmentStatement, projectionRowContent, readProjectionRows,
  runProjectionReplay } from './index.js';

/**
 * CRT-PRJ-02-B: dropping the projection tables and running the projection replay
 * tool rebuilds rows identical to those before the drop.
 *
 * This test owns a database of its own, created on the harness server for the
 * duration of the file and dropped afterwards. Dropping a table takes an ACCESS
 * EXCLUSIVE lock and leaves the table empty until the rebuild finishes, so doing
 * it on the shared suite database would make a concurrently running suite fail
 * for a reason that has nothing to do with that suite. A disposable database is
 * also the honest shape of the claim: the rebuild must work with nothing left of
 * the projections but canonical memory and the Git migrations.
 */

if (!process.env.UNAI_TEST_DATABASE_URL) throw new Error('Run pnpm test for the required PostgreSQL harness');
const serverUrl = process.env.UNAI_TEST_DATABASE_URL;
const databaseName = 'unai_replay_' + randomUUID().replaceAll('-', '');

let admin: Pool | undefined;
let appPool: Pool | undefined;
/** Set when the harness server refuses a database of its own; the file then
 * reports why it could not run instead of falsely passing. */
let unavailable: string | null = null;

const owner = randomUUID(), actor = randomUUID();
let baseContextSpaceId = '', sourceItemId = '', ownerEntityId = '', danielEntityId = '';
let contracts: TransitionContract[] = [];
const anchors: string[] = [];
let nextAnchor = 0;
const anchor = () => anchors[nextAnchor++]!;
const NOW = new Date('2026-03-02T09:00:00.000Z');
const FRIDAY = new Date('2026-02-27T17:00:00.000Z');

/** Migrate a database of this file's own. Roles are cluster-global and migration
 * 0001 alters them, while `runMigrations` serializes only within one database, so
 * two files migrating fresh databases at once would race on the same role rows.
 * Both such files take this advisory lock on the shared suite database first. */
async function migrateScratch(pool: Pool): Promise<void> {
  const shared = new Pool({ connectionString: serverUrl, max: 1 });
  const client = await shared.connect();
  try {
    await client.query('SELECT pg_advisory_lock(1970170217, 3)');
    await runMigrations(pool, resolve('migrations'));
  } finally {
    await client.query('SELECT pg_advisory_unlock(1970170217, 3)').catch(() => undefined);
    client.release();
    await shared.end().catch(() => undefined);
  }
}

beforeAll(async () => {
  const server = new Pool({ connectionString: serverUrl, max: 1 });
  try { await server.query('CREATE DATABASE ' + databaseName); }
  catch (error) { unavailable = error instanceof Error ? error.message : String(error); return; }
  finally { await server.end().catch(() => {}); }

  const url = new URL(serverUrl); url.pathname = '/' + databaseName;
  admin = new Pool({ connectionString: url.href });
  await migrateScratch(admin);
  await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='replay_test_app') THEN CREATE ROLE replay_test_app LOGIN PASSWORD 'test-only'; END IF; END $$; GRANT unai_app TO replay_test_app");
  const appUrl = new URL(url.href); appUrl.username = 'replay_test_app'; appUrl.password = 'test-only';
  appPool = new Pool({ connectionString: appUrl.href });

  await admin.query('INSERT INTO users(id,display_name) VALUES($1,$2)', [actor, 'Replay owner']);
  await admin.query("INSERT INTO owner_scopes(id,scope_kind,display_name,created_by_user_id) VALUES($1,'PERSONAL','Replay',$2)", [owner, actor]);
  await admin.query("INSERT INTO owner_scope_members(owner_scope_id,user_id,role) VALUES($1,$2,'OWNER')", [owner, actor]);
  baseContextSpaceId = (await admin.query('SELECT id FROM context_spaces WHERE owner_scope_id=$1', [owner])).rows[0].id;

  const connectorId = randomUUID(); sourceItemId = randomUUID();
  await admin.query("INSERT INTO connectors(id,owner_scope_id,connector_type,external_account_ref,permission_manifest,status) VALUES($1,$2,'CONVERSATION',$3,'{}','ACTIVE')", [connectorId, owner, owner]);
  await admin.query(`INSERT INTO source_items(id,owner_scope_id,connector_id,source_type,external_id,actor_ref,submitted_by_user_id,
    raw_object_ref,content_hash,sensitivity,allowed_purposes,ingestion_version,idempotency_key)
    VALUES($1,$2,$3,'CONVERSATION','replay-message-1',$4,$5,$6,$7,'PRIVATE',ARRAY['PERSONAL_ASSISTANCE'],'evidence-json-v1',$8)`,
    [sourceItemId, owner, connectorId, JSON.stringify({ type: 'USER', id: actor }), actor, randomUUID(), 'c'.repeat(64), randomUUID()]);
  for (let index = 0; index < 30; index += 1) {
    const id = randomUUID(); anchors.push(id);
    await admin.query(`INSERT INTO source_anchors(id,owner_scope_id,source_item_id,anchor_kind,anchor)
      VALUES($1,$2,$3,'MESSAGE_SPAN',$4)`, [id, owner, sourceItemId, JSON.stringify({ start: index * 10, end: index * 10 + 9 })]);
  }
  await admin.query(`INSERT INTO belief_transactions(id,owner_scope_id,transaction_kind,requested_by_actor_id,
    source_evidence_ids,registry_release_id,status,risk,idempotency_key,commit_receipt,committed_at)
    VALUES($1,$2,'CANONICALIZE',$3,ARRAY[$4::uuid],$5,'COMMITTED','LOW',$6,'{}',$7)`,
    [randomUUID(), owner, actor, sourceItemId, randomUUID(), randomUUID().replaceAll('-', ''), new Date('2026-02-01T00:00:00.000Z')]);

  contracts = [...(await lintRegistryCheckout({ repository: resolve('.'), version: '0.1.0' })).transitions];
  ownerEntityId = await person('Replay Owner', 'owner.replay@example.test');
  danielEntityId = await person('Daniel Replay', 'daniel.replay@example.test');
  await seed();
});

afterAll(async () => {
  await appPool?.end().catch(() => {});
  await admin?.end().catch(() => {});
  if (unavailable) return;
  const server = new Pool({ connectionString: serverUrl, max: 1 });
  try { await server.query('DROP DATABASE IF EXISTS ' + databaseName + ' WITH (FORCE)'); }
  catch { /* A leaked scratch database is an operator cleanup task, never a verdict. */ }
  finally { await server.end().catch(() => {}); }
});

function context(purpose: string): RequestContext { return { actorId: actor, ownerScopeId: owner, purpose, correlationId: randomUUID() }; }
const as = <T,>(purpose: string, run: (tx: OwnerTransaction) => Promise<T>) => withOwnerTransaction(appPool!, context(purpose), run);
const write = <T,>(run: (tx: OwnerTransaction) => Promise<T>) => as('memory.canonicalize', run);
const correct = <T,>(run: (tx: OwnerTransaction) => Promise<T>) => as('memory.correct', run);
const reduce = <T,>(run: (tx: OwnerTransaction) => Promise<T>) => as('memory.project', run);

async function person(label: string, mailbox: string): Promise<string> {
  return (await write(tx => resolveEntity(tx, {
    ownerScopeId: owner, entityKind: 'PERSON', canonicalLabel: label,
    aliases: [{ aliasType: 'EMAIL', aliasValue: mailbox }, { aliasType: 'DISPLAY_NAME', aliasValue: label }],
  }))).entityId;
}

async function statedValue(input: {
  frameInstanceId: string; predicateId: string; modality: 'ACTUAL' | 'SCHEDULED'; value: unknown;
}): Promise<string> {
  return write(async tx => {
    const slot = await resolveBeliefSlot(tx, {
      ownerScopeId: owner,
      descriptor: { frameInstanceId: input.frameInstanceId, predicateId: input.predicateId,
        contextSpaceId: baseContextSpaceId, modality: input.modality, qualifiers: {} },
    });
    const proposition = await resolveProposition(tx, {
      ownerScopeId: owner, beliefSlotId: slot.beliefSlotId, normalizedValue: input.value,
    });
    return recordClaim(tx, {
      ownerScopeId: owner, sourceAnchorId: anchor(), claimOrigin: 'USER_STATEMENT', lifecycle: 'PROVISIONAL',
      propositionId: proposition.propositionId, assertedByEntityId: ownerEntityId,
    });
  });
}

/** One of each projected situation, plus an owner write the reducer can apply and
 * one it cannot: the rebuild has to reproduce the incomplete row as faithfully as
 * the complete ones. */
async function seed(): Promise<void> {
  const obligationId = await write(tx => createFrameInstance(tx, {
    ownerScopeId: owner, frameTypeId: 'shared.obligation', contextSpaceId: baseContextSpaceId }));
  const principalClaim = await statedValue({ frameInstanceId: obligationId,
    predicateId: 'shared.obligation.principal_amount', modality: 'ACTUAL', value: { amount: '50.00', currency: 'ILS' } });
  await write(async tx => {
    await recordFrameInstanceRole(tx, { ownerScopeId: owner, frameInstanceId: obligationId, roleId: 'debtor',
      entityId: ownerEntityId, claimId: principalClaim });
    await recordFrameInstanceRole(tx, { ownerScopeId: owner, frameInstanceId: obligationId, roleId: 'creditor',
      entityId: danielEntityId, claimId: principalClaim });
  });

  const allocationId = await write(tx => createFrameInstance(tx, {
    ownerScopeId: owner, frameTypeId: 'finance.payment_allocation', contextSpaceId: baseContextSpaceId }));
  const allocationClaim = await statedValue({ frameInstanceId: allocationId,
    predicateId: 'finance.payment_allocation.allocated_amount', modality: 'ACTUAL',
    value: { amount: '50.00', currency: 'ILS' } });
  await write(async tx => {
    await recordFrameInstanceRole(tx, { ownerScopeId: owner, frameInstanceId: allocationId, roleId: 'obligation',
      typedValue: { frameInstanceId: obligationId }, claimId: allocationClaim });
    await recordFrameInstanceRole(tx, { ownerScopeId: owner, frameInstanceId: allocationId, roleId: 'payment_transaction',
      typedValue: { externalId: 'bank:replay-1', total: { amount: '60.00', currency: 'ILS' } }, claimId: allocationClaim });
  });

  await write(tx => canonicalizeCommitmentStatement(tx, {
    ownerScopeId: owner, contextSpaceId: baseContextSpaceId,
    statement: 'I will send Daniel the report by Friday', sourceAnchorId: anchor(),
    claimOrigin: 'USER_STATEMENT', assertedByEntityId: ownerEntityId,
    promisorEntityId: ownerEntityId, promiseeEntityId: danielEntityId,
    dueTime: FRIDAY, statedAt: new Date('2026-02-23T08:00:00.000Z'),
  }));

  const eventId = await write(tx => createFrameInstance(tx, {
    ownerScopeId: owner, frameTypeId: 'shared.event_occurrence', contextSpaceId: baseContextSpaceId }));
  await statedValue({ frameInstanceId: eventId, predicateId: 'shared.event_occurrence.occurrence_time',
    modality: 'SCHEDULED', value: { start: '2026-03-10T09:00:00.000Z', end: '2026-03-10T10:00:00.000Z' } });

  // Applied by the reducer...
  await correct(tx => recordOverlayDelta(tx, {
    ownerScopeId: owner, deltaKind: 'USER_CORRECTION', rawText: 'Actually, it was ILS 55',
    sourceEvidenceId: sourceItemId, lifecycle: 'USER_ASSERTED',
    target: { objectType: 'frame_instance', objectId: obligationId },
  }));
  // ...and one it must refuse, so a row with is_complete=false is part of what
  // gets rebuilt.
  await correct(tx => recordOverlayDelta(tx, {
    ownerScopeId: owner, deltaKind: 'USER_ASSERTION', rawText: 'Something about the meeting',
    sourceEvidenceId: sourceItemId, lifecycle: 'USER_ASSERTED',
    target: { objectType: 'frame_instance', objectId: eventId },
  }));

  await reduce(async tx => {
    for (const projectionName of ['open_commitments_projection', 'obligations_projection', 'schedule_projection'] as const) {
      await applyProjectionDelta(tx, { ownerScopeId: owner, projectionName, asOf: NOW });
    }
  });
}

const PROJECTIONS = ['open_commitments_projection', 'obligations_projection', 'schedule_projection'] as const;
const snapshot = () => reduce(async tx => Object.fromEntries(await Promise.all(
  PROJECTIONS.map(async projectionName =>
    [projectionName, await readProjectionRows(tx, { ownerScopeId: owner, projectionName })] as const))));

it('CRT-PRJ-02-B: dropping the projection tables and running the projection replay tool rebuilds identical rows', async () => {
  expect(unavailable, 'the harness server refused a disposable database for this file').toBeNull();
  const before = await snapshot();
  for (const projectionName of PROJECTIONS) expect(before[projectionName]!.length, projectionName).toBeGreaterThan(0);
  // The fixture really does contain an incomplete row, so the rebuild has to
  // reproduce incompleteness and not only happy rows.
  expect(before['schedule_projection']!.some(row => !row.isComplete)).toBe(true);
  const versionsBefore = new Set(PROJECTIONS.flatMap(name => before[name]!.map(row => row.projectionVersion)));

  // Drop them outright. Nothing of the projections survives, not the rows, not
  // the tables, not the receipts.
  await admin!.query('DROP TABLE open_commitments_projection, obligations_projection, schedule_projection, projection_rebuild_receipts CASCADE');
  await admin!.query(`DROP FUNCTION IF EXISTS unai_private.open_commitments_projection_identity(),
    unai_private.obligations_projection_identity(), unai_private.schedule_projection_identity()`);
  await expect(admin!.query('SELECT 1 FROM obligations_projection')).rejects.toMatchObject({ code: '42P01' });
  // The migration ledger is an ordered history, so re-applying 0016 means
  // re-applying everything recorded after it as well. Migration 0017's own tables
  // and function go with it -- this database is this file's alone, and nothing in
  // it depends on them -- and the rebuild below still comes from the Git files the
  // deployment applies, digests and order checked by `runMigrations` as always.
  await admin!.query('DROP TABLE memory_thread_members, memory_threads, context_packets CASCADE');
  await admin!.query('DROP FUNCTION IF EXISTS unai_private.memory_thread_identity(), unai_private.evidence_labels(uuid)');
  // Migration 0020's lineage tables, its triggers on two earlier tables, the
  // retirement policy it added and its functions go the same way. The policies it
  // replaced are dropped and recreated by 0020 itself.
  await admin!.query('DROP TABLE frame_instance_lineage, proposition_lineage CASCADE');
  await admin!.query(`DROP TRIGGER frame_instance_governed_retirement ON frame_instances;
    DROP TRIGGER entity_lineage_governed ON entity_lineage; DROP TRIGGER entity_lineage_immutable ON entity_lineage;
    DROP POLICY governed_retire ON frame_instances; REVOKE UPDATE(lifecycle,retired_at) ON frame_instances FROM unai_app`);
  await admin!.query(`DROP FUNCTION unai_private.lineage_governed(), unai_private.entity_lineage_governed(),
    unai_private.lineage_immutable(), unai_private.frame_instance_governed_retirement()`);
  // Migration 0019's semantic index and its evidence-scope reader likewise; its
  // registry reader is a CREATE OR REPLACE and re-applies over itself.
  await admin!.query('DROP TABLE memory_embeddings CASCADE');
  await admin!.query('DROP FUNCTION IF EXISTS unai_private.anchor_evidence_scope(uuid,uuid[])');
  // ...and so do migration 0018's connector capability grants, connector
  // lifecycle columns and the policies it added to the delivered evidence
  // tables. `CREATE OR REPLACE` definitions (evidence_access) and the grants are
  // idempotent, so only what 0018 created outright is removed here.
  await admin!.query('DROP TABLE connector_capability_grants CASCADE');
  await admin!.query(`DROP FUNCTION IF EXISTS unai_private.connector_grant_identity() CASCADE;
    DROP FUNCTION IF EXISTS unai_private.connector_update_guard() CASCADE;
    DROP FUNCTION IF EXISTS unai_private.connector_ingestion_active() CASCADE`);
  await admin!.query(`ALTER TABLE connectors
    DROP CONSTRAINT IF EXISTS connectors_status,
    DROP CONSTRAINT IF EXISTS connectors_disconnected_state,
    DROP CONSTRAINT IF EXISTS connectors_revoked_secret,
    DROP COLUMN IF EXISTS secret_ref, DROP COLUMN IF EXISTS manifest_version,
    DROP COLUMN IF EXISTS cursor_updated_at, DROP COLUMN IF EXISTS disconnected_at,
    DROP COLUMN IF EXISTS last_sync_error, DROP COLUMN IF EXISTS updated_at`);
  await admin!.query(`DROP POLICY IF EXISTS owner_connect ON connectors;
    DROP POLICY IF EXISTS owner_lifecycle ON connectors;
    DROP POLICY IF EXISTS evidence_append_sync ON source_items;
    DROP POLICY IF EXISTS anchor_append_sync ON source_anchors;
    DROP POLICY IF EXISTS object_key_append_sync ON evidence_object_keys;
    DROP POLICY IF EXISTS owner_append_sync ON triage_decisions;
    DROP POLICY IF EXISTS owner_read_sync ON triage_decisions;
    DROP POLICY IF EXISTS owner_append_sync ON evidence_ingestion_receipts`);
  // Migration 0021's answer manifests and reconsideration candidates, and the
  // policies it added beside the evidence tables' own; its functions and
  // triggers are CREATE OR REPLACE and re-apply over themselves.
  await admin!.query('DROP TABLE reconsideration_candidates, answer_manifests CASCADE');
  for (const [policy, table] of [['evidence_append_answer', 'source_items'], ['receipt_append_answer', 'evidence_ingestion_receipts'],
    ['object_key_append_answer', 'evidence_object_keys'], ['anchor_append_answer', 'source_anchors'],
    ['owner_append_answer', 'triage_decisions'], ['owner_read_answer', 'triage_decisions']] as const) {
    await admin!.query(`DROP POLICY IF EXISTS ${policy} ON ${table}`);
  }
  // Migration 0025's evaluation records, the migration manifest snapshot, and
  // its two functions.
  await admin!.query('DROP TABLE shadow_evaluation_runs, economic_and_quality_metrics, registry_migration_manifests CASCADE');
  await admin!.query(`DROP FUNCTION IF EXISTS unai_private.evaluation_record_immutable() CASCADE;
    DROP FUNCTION IF EXISTS unai_private.economic_and_quality_inputs(timestamptz,timestamptz)`);

  // Migration 0022's briefing editions and items; it adds no function.
  await admin!.query('DROP TABLE briefing_items, briefing_editions CASCADE');

  // Migration 0023's inbox, budget, rule and review tables and the two trigger
  // functions it created outright.
  await admin!.query(`DROP TABLE interruption_decisions, clarification_cards, learned_approval_rules, attention_budgets,
    behavioral_observations, weekly_reviews CASCADE`);
  await admin!.query('DROP FUNCTION unai_private.learned_rule_transition(), unai_private.clarification_card_identity()');

  // Migration 0026's goal, decision projection and mentor tables and the functions
  // it created outright. The policies it replaced on 0023's tables and the
  // receipts constraint it widened go with the tables they belong to.
  await admin!.query('DROP TABLE mentor_cards, decision_projection, goal_priority_history, goals CASCADE');
  await admin!.query(`DROP FUNCTION unai_private.goal_priority_history_stamp(), unai_private.goal_priority_history_immutable(),
    unai_private.goal_update_guard(), unai_private.goal_has_history(), unai_private.decision_projection_identity(),
    unai_private.mentor_card_immutable(), unai_private.registry_transition_contracts()`);

  // Migration 0024's governed-action and data-control tables, the functions it
  // created outright, and the export and erasure policies it added beside the
  // earlier tables' own. Its replaced trigger functions are CREATE OR REPLACE and
  // re-apply over themselves.
  await admin!.query(`DROP TABLE action_history, drafts, recommendation_artifacts, plugin_capability_grants,
    retention_settings, domain_sensitivity_settings, memory_summaries,
    retention_and_deletion_requests CASCADE`);
  await admin!.query(`DROP FUNCTION unai_private.plugin_grant_identity(), unai_private.recommendation_response_only(),
    unai_private.draft_transition(), unai_private.action_history_subject(), unai_private.erase_evidence(uuid,uuid),
    unai_private.expire_derived_data(uuid,text,timestamptz), unai_private.drop_semantic_index(uuid)`);
  for (const table of ['source_items', 'source_anchors', 'entities', 'entity_aliases', 'frame_instances', 'frame_instance_roles',
    'belief_slots', 'propositions', 'claims', 'belief_assessments', 'belief_support', 'claim_relations',
    'resolution_assertions', 'memory_links', 'derived_proposition_dependencies']) {
    await admin!.query(`DROP POLICY IF EXISTS data_export_read ON ${table}`);
  }
  await admin!.query(`DROP POLICY IF EXISTS data_erasure_read ON source_items;
    DROP POLICY IF EXISTS data_erasure_read ON evidence_object_keys`);

  // Migration 0027's audit-trail columns, indexes, triggers and functions. The
  // audit rows themselves stay: dropping the columns is DDL, which the
  // row-level immutability trigger does not govern.
  await admin!.query(`DROP TRIGGER audit_event_defaults ON audit_events; DROP TRIGGER audit_event_immutable ON audit_events;
    DROP TRIGGER audit_event_no_truncate ON audit_events;
    ALTER TABLE audit_events DROP COLUMN event_kind, DROP COLUMN policy_decision_id;
    DROP INDEX audit_events_objects;
    DROP FUNCTION unai_private.audit_event_defaults(), unai_private.audit_event_immutable(), unai_private.audit_event_kind(text)`);

  await admin!.query('DROP TABLE performance_measurements CASCADE');
  // Rebuild the schema from the same Git migrations the deployment applies.
  await admin!.query('DELETE FROM unai_migrations.applied WHERE name>=$1', ['0016_typed_projections.sql']);
  const applied = await runMigrations(admin!, resolve('migrations'));
  expect(applied).toEqual(['0016_typed_projections.sql', '0017_context_broker_and_memory_threads.sql',
    '0018_connector_capabilities_and_lifecycle.sql', '0019_semantic_index.sql', '0020_merge_split_lineage.sql',
    '0021_answer_manifests_and_reconsideration.sql',
    '0022_today_briefing.sql', '0023_memory_inbox_and_weekly_review.sql', '0024_governed_action_and_data_control.sql',
    '0025_evaluation_and_metrics.sql', '0026_goals_decisions_and_mentor.sql', '0027_audit_trail.sql', '0028_performance_measurements.sql']);
  expect((await admin!.query('SELECT count(*)::int n FROM obligations_projection')).rows[0].n).toBe(0);

  // The projection replay tool -- the same function `uai registry
  // projection-replay` runs -- rebuilds from canonical memory alone.
  const result = await reduce(tx => runProjectionReplay(tx, {
    ownerScopeId: owner, asOf: NOW, trigger: 'DROP_AND_REBUILD',
  }));
  expect(result.receipts.map(receipt => receipt.projectionName).sort()).toEqual([...PROJECTIONS].sort());
  expect(result.receipts.map(receipt => receipt.rowsRebuilt))
    .toEqual(PROJECTIONS.map(name => before[name]!.length));

  const after = await snapshot();
  for (const projectionName of PROJECTIONS) {
    // Identical, column by column, in everything that describes the projected
    // situation -- including `updated_at`, which is derived from the canonical
    // inputs rather than from the clock.
    expect(after[projectionName]!.map(projectionRowContent), projectionName)
      .toEqual(before[projectionName]!.map(projectionRowContent));
    // ...and the only column that moved is the identity of the run that wrote
    // the row, which is a different run.
    for (const row of after[projectionName]!) expect(versionsBefore.has(row.projectionVersion), projectionName).toBe(false);
  }
  // The incomplete row came back incomplete, with the owner write that made it so.
  const schedule = after['schedule_projection']!.find(row => !row.isComplete)!;
  expect(schedule.pendingAssertions[0]).toMatchObject({ reason: 'DELTA_VALUE_UNPARSEABLE' });

  // And the rebuild is on the record.
  const receipts = (await admin!.query('SELECT projection_name,trigger,rows_rebuilt,reducer_version FROM projection_rebuild_receipts WHERE owner_scope_id=$1 ORDER BY projection_name', [owner])).rows;
  expect(receipts.map((row: { trigger: string }) => row.trigger)).toEqual(['DROP_AND_REBUILD', 'DROP_AND_REBUILD', 'DROP_AND_REBUILD']);
});
