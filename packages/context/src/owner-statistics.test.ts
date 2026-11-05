import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { runMigrations, withOwnerTransaction } from '@unai/postgres';
import { loadRegistryRelease, publishRegistryRelease } from '@unai/registry';
import { readOwnerDeltas } from '@unai/capabilities';
import type { MemoryTransaction } from '@unai/memory';
import { readContextPacket, type ContextRunner } from './index.js';

const serverUrl = process.env.UNAI_TEST_DATABASE_URL;
if (!serverUrl) throw new Error('Run pnpm test for the required PostgreSQL harness');
const suffix = randomUUID().replaceAll('-', '');
const database = 'unai_ownerstats_' + suffix, role = 'ownerstats_' + suffix;
const NOW = new Date('2026-03-02T09:00:00Z'), CREATED = '2026-01-01T00:00:00Z';
const tables = ['claims', 'propositions', 'belief_slots'] as const;
const predicate = 'shared.obligation.description';
let admin: Pool | undefined, app: Pool | undefined, registryReleaseId = '', created = false;
let decoy: Fixture;
function pool(url: string) { const result = new Pool({ connectionString: url }); result.on('error', () => {}); return result; }
function db() { if (!admin) throw new Error('OWNER_STATISTICS_NOT_READY'); return admin; }
interface Unit { frame: string; slot: string; proposition: string; claim: string; evidence: string; anchor: string }
interface ExpectedDelta { overlayDeltaId: string; frameInstanceId: string | null; beliefSlotId: string | null; predicateId: string | null }
interface Fixture { owner: string; actor: string; context: string; transaction: string; units: Unit[]; deltas: ExpectedDelta[] }
type Cost = { evaluations: number; claims: number; propositions: number; belief_slots: number };
interface Measurement { sql: string; cost: Cost }

async function pinRelease(): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), 'unai-ownerstats-registry-'));
  try {
    await cp(resolve('registry'), join(repository, 'registry'), { recursive: true });
    for (const args of [['init', '--quiet'], ['add', 'registry'], ['commit', '--quiet', '-m', 'release'], ['tag', 'registry-v0.1.0']]) {
      const result = spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args],
        { cwd: repository, encoding: 'utf8' });
      if (result.status !== 0) throw new Error('OWNER_STATISTICS_REGISTRY_FAILED');
    }
    return (await publishRegistryRelease(db(), await loadRegistryRelease({ repository, version: '0.1.0' }), randomUUID())).releaseId;
  } finally { await rm(repository, { recursive: true, force: true }); }
}

async function makeFixture(count: number): Promise<Fixture> {
  const f: Fixture = { owner: randomUUID(), actor: randomUUID(), context: '', transaction: randomUUID(), units: [], deltas: [] };
  await db().query("INSERT INTO users(id,display_name) VALUES($1,'Owner statistics')", [f.actor]);
  await db().query("INSERT INTO owner_scopes(id,scope_kind,display_name,created_by_user_id) VALUES($1,'PERSONAL','Statistics',$2)", [f.owner, f.actor]);
  await db().query("INSERT INTO owner_scope_members(owner_scope_id,user_id,role) VALUES($1,$2,'OWNER')", [f.owner, f.actor]);
  f.context = (await db().query("SELECT id FROM context_spaces WHERE owner_scope_id=$1 AND context_kind='BASE'", [f.owner])).rows[0].id as string;
  await db().query(`INSERT INTO belief_transactions(id,owner_scope_id,transaction_kind,requested_by_actor_id,
    source_evidence_ids,registry_release_id,status,risk,idempotency_key,commit_receipt,committed_at)
    VALUES($1,$2,'CANONICALIZE',$3,'{}',$4,'COMMITTED','LOW',$5,'{}',$6)`,
  [f.transaction, f.owner, f.actor, registryReleaseId, randomUUID(), CREATED]);
  for (let index = 0; index < count; index++) {
    const u = { frame: randomUUID(), slot: randomUUID(), proposition: randomUUID(), claim: randomUUID(), evidence: randomUUID(), anchor: randomUUID() };
    await seedUnit(f, u);
    f.units.push(u);
    for (const kind of ['claim', 'proposition', 'belief_slot', 'frame_instance']) {
      const target = kind === 'claim' ? u.claim : kind === 'proposition' ? u.proposition : kind === 'belief_slot' ? u.slot : u.frame;
      await delta(f, kind, target, u.frame, kind === 'frame_instance' ? null : u.slot);
    }
  }
  return f;
}

async function seedUnit(f: Fixture, u: Unit): Promise<void> {
  await db().query(`INSERT INTO source_items(id,owner_scope_id,source_type,external_id,actor_ref,submitted_by_user_id,
    raw_object_ref,content_hash,sensitivity,allowed_purposes,ingestion_version,idempotency_key,occurred_at,observed_at)
    VALUES($1,$2,'CONVERSATION',$1::uuid::text,$3,$4,$5,$6,'PRIVATE',ARRAY['PERSONAL_FINANCE'],'evidence-json-v1',$1::uuid::text,$7,$7)`,
  [u.evidence, f.owner, JSON.stringify({ type: 'USER', id: f.actor }), f.actor, randomUUID(), 'a'.repeat(64), CREATED]);
  await db().query(`INSERT INTO source_anchors(id,owner_scope_id,source_item_id,anchor_kind,anchor,normalized_text,created_at)
    VALUES($1,$2,$3,'MESSAGE_SPAN','{"start":0,"end":10}','fixture',$4)`, [u.anchor, f.owner, u.evidence, CREATED]);
  await db().query(`INSERT INTO frame_instances(id,owner_scope_id,frame_type_id,context_space_id,created_at)
    VALUES($1,$2,'shared.obligation',$3,$4)`, [u.frame, f.owner, f.context, CREATED]);
  await db().query(`INSERT INTO belief_slots(id,owner_scope_id,frame_instance_id,predicate_id,context_space_id,modality,created_at)
    VALUES($1,$2,$3,$4,$5,'ACTUAL',$6)`, [u.slot, f.owner, u.frame, predicate, f.context, CREATED]);
  await db().query(`INSERT INTO propositions(id,owner_scope_id,belief_slot_id,normalized_value,created_at)
    VALUES($1,$2,$3,$4,$5)`, [u.proposition, f.owner, u.slot, JSON.stringify({ text: u.proposition }), CREATED]);
  await db().query(`INSERT INTO claims(id,owner_scope_id,source_anchor_id,proposition_id,claim_origin,lifecycle,valid_from,recorded_at)
    VALUES($1,$2,$3,$4,'USER_STATEMENT','PROVISIONAL',$5,$5)`, [u.claim, f.owner, u.anchor, u.proposition, CREATED]);
  await db().query(`INSERT INTO belief_assessments(id,owner_scope_id,proposition_id,assessment_status,valid_from,recorded_at,
    policy_version,decision_reason,transaction_id) VALUES($1,$2,$3,'ACCEPTED',$4,$4,'local-policy-0.1.0','{"code":"FIXTURE"}',$5)`,
  [randomUUID(), f.owner, u.proposition, CREATED, f.transaction]);
}

async function delta(f: Fixture, kind: string, target: string, frame: string | null, slot: string | null, attached?: Unit) {
  const id = randomUUID(), source = f.units[0];
  if (!source) throw new Error('OWNER_STATISTICS_SOURCE_MISSING');
  await db().query(`INSERT INTO owner_overlay_deltas(id,owner_scope_id,owner_sequence,source_evidence_id,raw_text,
    delta_kind,target_object_type,target_object_id,attached_belief_slot_id,created_at)
    VALUES($1,$2,$3,$4,'fixture','USER_ASSERTION',$5,$6,$7,$8)`,
  [id, f.owner, f.deltas.length + 1, source.evidence, kind, target, attached?.slot ?? null, CREATED]);
  f.deltas.push({ overlayDeltaId: id, frameInstanceId: attached?.frame ?? frame,
    beliefSlotId: attached?.slot ?? slot, predicateId: attached || slot ? predicate : null });
}

async function edgeDeltas(f: Fixture) {
  const [first, second] = f.units;
  if (!first || !second) throw new Error('OWNER_STATISTICS_FIXTURE_MISSING');
  await delta(f, 'claim', randomUUID(), null, null); // Deleted/absent target remains pending.
  await delta(f, 'claim', decoy.units[0]!.claim, null, null); // Existing but hidden by RLS.
  const unattached = randomUUID();
  await db().query(`INSERT INTO claims(id,owner_scope_id,source_anchor_id,claim_origin,recorded_at)
    VALUES($1,$2,$3,'USER_STATEMENT',$4)`, [unattached, f.owner, first.anchor, CREATED]);
  await delta(f, 'claim', unattached, null, null);
  await delta(f, 'proposition', first.proposition, first.frame, first.slot, second);
  const emptyFrame = randomUUID();
  await db().query(`INSERT INTO frame_instances(id,owner_scope_id,frame_type_id,context_space_id,created_at)
    VALUES($1,$2,'shared.obligation',$3,$4)`, [emptyFrame, f.owner, f.context, CREATED]);
  await delta(f, 'frame_instance', emptyFrame, emptyFrame, null);
}

async function freshFixture(): Promise<Fixture> {
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const table of [...tables, 'owner_overlay_deltas', 'belief_assessments', 'frame_instances', 'source_anchors', 'source_items']) {
      await db().query('ANALYZE ' + table);
    }
    const f = await makeFixture(40);
    await edgeDeltas(f);
    const estimates: number[] = [];
    for (const table of tables) {
      const result = await db().query('EXPLAIN (FORMAT JSON) SELECT 1 FROM ' + table + ' WHERE owner_scope_id=$1', [f.owner]);
      estimates.push(Number(result.rows[0]['QUERY PLAN'][0].Plan['Plan Rows']));
    }
    console.info('OWNER_STATISTICS_PRECONDITION', estimates);
    if (estimates.every(rows => rows <= 2)) return f;
  }
  throw new Error('OWNER_STATISTICS_PRECONDITION_UNMET');
}

async function counters(tx: MemoryTransaction): Promise<Cost> {
  const rows = (await tx.query(`SELECT relname,coalesce(idx_scan,0)+seq_scan AS scans,
    coalesce(idx_tup_fetch,0)+seq_tup_read AS fetched FROM pg_stat_xact_user_tables
    WHERE relname=ANY($1::text[])`, [['owner_scope_members', ...tables]])).rows;
  const result: Cost = { evaluations: 0, claims: 0, propositions: 0, belief_slots: 0 };
  for (const row of rows) {
    if (row['relname'] === 'owner_scope_members') result.evaluations = Number(row['scans']);
    for (const table of tables) if (row['relname'] === table) result[table] = Number(row['fetched']);
  }
  return result;
}
function difference(after: Cost, before: Cost): Cost {
  return { evaluations: after.evaluations - before.evaluations, claims: after.claims - before.claims,
    propositions: after.propositions - before.propositions, belief_slots: after.belief_slots - before.belief_slots };
}
function observed(tx: MemoryTransaction, measurements: Measurement[]): MemoryTransaction {
  return { ...(tx.context ? { context: tx.context } : {}), async query(sql, values) {
    const before = await counters(tx), result = await tx.query(sql, values);
    measurements.push({ sql, cost: difference(await counters(tx), before) });
    return result;
  } };
}
function linear(cost: Cost, f: Fixture) {
  const counts = { claims: f.units.length + 1, propositions: f.units.length, belief_slots: f.units.length };
  expect(cost.evaluations).toBeLessThanOrEqual(4 * (counts.claims + counts.propositions + counts.belief_slots) + 50);
  for (const table of tables) expect(cost[table], table).toBeLessThanOrEqual(3 * counts[table] + 20);
}
function runAs<T>(f: Fixture, run: (tx: MemoryTransaction) => Promise<T>): Promise<T> {
  if (!app) throw new Error('OWNER_STATISTICS_NOT_READY');
  return withOwnerTransaction(app, { ownerScopeId: f.owner, actorId: f.actor, purpose: 'memory.read', correlationId: randomUUID() }, run);
}

beforeAll(async () => {
  const server = pool(serverUrl);
  try { await server.query('CREATE DATABASE ' + database); created = true; }
  finally { await server.end(); }
  const url = new URL(serverUrl); url.pathname = '/' + database;
  admin = pool(url.href);
  await runMigrations(admin, resolve('migrations'));
  await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD 'test-only'; GRANT unai_app TO ${role}`);
  url.username = role; url.password = 'test-only'; app = pool(url.href);
  registryReleaseId = await pinRelease();
  decoy = await makeFixture(30);
}, 60_000);

afterAll(async () => {
  await app?.end(); await admin?.end();
  const server = pool(serverUrl);
  try {
    if (created) {
      let idle = false;
      for (let attempt = 0; attempt < 200; attempt++) {
        const result = await server.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1', [database]);
        if (result.rows[0].n === 0) { idle = true; break; }
        await sleep(25);
      }
      if (!idle) throw new Error('OWNER_STATISTICS_BACKENDS_STILL_ACTIVE');
      await server.query('DROP DATABASE ' + database);
      await server.query('DROP ROLE IF EXISTS ' + role);
    }
  } finally { await server.end(); }
});

it('resolves every owner delta with linear RLS work despite a one-row owner estimate', async () => {
  const f = await freshFixture();
  await runAs(f, async tx => {
    const before = await counters(tx), deltas = await readOwnerDeltas(tx, f.owner);
    const cost = difference(await counters(tx), before);
    console.info('OWNER_STATISTICS_DELTAS', cost);
    expect(deltas.map(({ overlayDeltaId, frameInstanceId, beliefSlotId, predicateId }) =>
      ({ overlayDeltaId, frameInstanceId, beliefSlotId, predicateId }))).toEqual(f.deltas);
    expect(deltas.map(d => d.ownerSequence)).toEqual(f.deltas.map((_, index) => index + 1));
    linear(cost, f);
  });
}, 60_000);

it('reads the fresh owner beliefs with linear hot-statement RLS work', async () => {
  const f = await freshFixture(), measurements: Measurement[] = [];
  const runner: ContextRunner = run => runAs(f, async tx => {
    const before = await counters(tx), result = await run(observed(tx, measurements));
    console.info('OWNER_STATISTICS_PACKET_TRANSACTION', difference(await counters(tx), before));
    return result;
  });
  const packet = await readContextPacket(runner, { ownerScopeId: f.owner, requestingActorId: f.actor, purpose: 'PERSONAL_FINANCE',
    query: 'What is the current state?', worldTime: 'NOW', knowledgeTime: 'LATEST', maximumSensitivity: 'PRIVATE',
    actionRisk: 'LOW', answerType: 'CURRENT_VALUE', frameTypeHints: ['shared.obligation'] },
  { now: NOW, correlationId: randomUUID(), registryReleaseId, registryRelease: '0.1.0', frameLimit: 100 });
  console.table(measurements.map(m => ({ sql: m.sql.replace(/\s+/g, ' ').slice(0, 80), ...m.cost })));
  expect(packet.currentBeliefs.map(b => b.propositionId).sort()).toEqual(f.units.map(u => u.proposition).sort());
  expect(packet.evidenceRefs.map(e => e.evidenceId).sort()).toEqual(f.units.map(u => u.evidence).sort());
  expect(packet.currentBeliefs.some(b => decoy.units.some(u => u.proposition === b.propositionId))).toBe(false);
  const hot = measurements.filter(m => m.sql.includes('known_claims'));
  expect(hot).toHaveLength(1);
  console.info('OWNER_STATISTICS_BELIEFS', hot[0]!.cost);
  linear(hot[0]!.cost, f);
}, 60_000);
