import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { runMigrations } from '@unai/postgres';
import { changeGoalPriority, createGoal } from '@unai/mentor';
import type { GoalPriority } from '@unai/domain';

if (!process.env.UNAI_TEST_DATABASE_URL) throw new Error('Run pnpm test for the required PostgreSQL harness');
const pool = new Pool({ connectionString: process.env.UNAI_TEST_DATABASE_URL });
beforeAll(async () => { await runMigrations(pool, resolve('migrations')); });
afterAll(async () => { await pool.end(); });
const HOUR = 3_600_000;
type Owner = { owner: string; actor: string };
async function owner(): Promise<Owner> {
  const value = { owner: randomUUID(), actor: randomUUID() };
  await pool.query("INSERT INTO users(id,display_name) VALUES($1,'Goal authority')", [value.actor]);
  await pool.query("INSERT INTO owner_scopes(id,scope_kind,display_name,created_by_user_id) VALUES($1,'PERSONAL','Goals',$2)",
    [value.owner, value.actor]);
  await pool.query("INSERT INTO owner_scope_members(owner_scope_id,user_id,role) VALUES($1,$2,'OWNER')", [value.owner, value.actor]);
  return value;
}
async function appTx<T>(o: Owner, purpose: string, run: (tx: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE unai_app');
    await client.query(`SELECT set_config('unai.owner_scope_id',$1,true),set_config('unai.actor_id',$2,true),
      set_config('unai.purpose',$3,true)`, [o.owner, o.actor, purpose]);
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
const checkpoint = async () => (await pool.query('SELECT clock_timestamp()::text AS at')).rows[0].at as string;
async function goal(o: Owner, priority: GoalPriority = 'HIGH', starts = new Date(Date.now() - HOUR)) {
  return appTx(o, 'goals.manage', tx => createGoal(tx, { ownerScopeId: o.owner, actorId: o.actor,
    goal: { title: 'Private goal title', domain: 'WORK', priority, reason: 'Private goal reason' }, now: starts }));
}
async function priority(o: Owner, goalId: string, value: GoalPriority, starts: Date, until?: Date) {
  return appTx(o, 'goals.manage', tx => changeGoalPriority(tx, { ownerScopeId: o.owner, actorId: o.actor, goalId,
    change: { priority: value, reason: 'Private priority reason', effectiveFrom: starts.toISOString(),
      ...(until ? { until: until.toISOString() } : {}) }, now: new Date() }));
}
async function read(o: Owner, ids: string[], world: Date, knowledge?: string, purpose = 'memory.read', requestedOwner = o.owner) {
  const known = knowledge ?? await checkpoint();
  return appTx(o, purpose, async tx => (await tx.query(
    'SELECT * FROM unai_private.active_goal_priorities($1,$2::uuid[],$3,$4)',
    [requestedOwner, ids, world, known])).rows);
}

it('uses append-only goal priority history at knowledge time and returns only active IDs and priorities', async () => {
  const o = await owner(), world = new Date(Date.now() + HOUR);
  const active = await goal(o), retired = await goal(o), paused = await goal(o, 'PAUSED');
  const beforeChange = await checkpoint();
  await priority(o, active.goalId, 'LOW', new Date(world.getTime() - HOUR));
  await appTx(o, 'goals.manage', tx => tx.query('UPDATE goals SET retired_at=now() WHERE id=$1', [retired.goalId]));
  const ids = [active.goalId, retired.goalId, paused.goalId, randomUUID()];
  expect(await read(o, ids, world)).toEqual([{ goal_id: active.goalId, priority: 'LOW' }]);
  expect(await read(o, [active.goalId], world, beforeChange)).toEqual([{ goal_id: active.goalId, priority: 'HIGH' }]);
  expect(await appTx(o, 'memory.read', async tx => (await tx.query('SELECT * FROM goals WHERE owner_scope_id=$1', [o.owner])).rows))
    .toEqual([]);
  await priority(o, active.goalId, 'PAUSED', new Date(world.getTime() - HOUR));
  expect(await read(o, [active.goalId], world)).toEqual([]);
});

it('does not use future goals, future standing changes or history recorded after the knowledge cutoff', async () => {
  const o = await owner(), world = new Date(Date.now() + HOUR), later = new Date(world.getTime() + 2 * HOUR);
  const beforeCreation = await checkpoint();
  const scheduled = await goal(o, 'HIGH', later), active = await goal(o, 'MEDIUM');
  await priority(o, active.goalId, 'PAUSED', later);
  expect(await read(o, [scheduled.goalId, active.goalId], world))
    .toEqual([{ goal_id: active.goalId, priority: 'MEDIUM' }]);
  expect(await read(o, [scheduled.goalId, active.goalId], later)).toEqual([{ goal_id: scheduled.goalId, priority: 'HIGH' }]);
  expect(await read(o, [scheduled.goalId, active.goalId], later, beforeCreation)).toEqual([]);
});

it('expires the latest temporary override back to standing priority without reviving an older override', async () => {
  const o = await owner(), world = new Date(Date.now() + HOUR);
  const active = await goal(o);
  await priority(o, active.goalId, 'LOW', new Date(world.getTime() - HOUR), new Date(world.getTime() + 3 * HOUR));
  await priority(o, active.goalId, 'MEDIUM', new Date(world.getTime() - HOUR), new Date(world.getTime() + HOUR));
  expect(await read(o, [active.goalId], world)).toEqual([{ goal_id: active.goalId, priority: 'MEDIUM' }]);
  expect(await read(o, [active.goalId], new Date(world.getTime() + HOUR)))
    .toEqual([{ goal_id: active.goalId, priority: 'HIGH' }]);
  await priority(o, active.goalId, 'LOW', new Date(world.getTime() + HOUR / 2));
  expect(await read(o, [active.goalId], world)).toEqual([{ goal_id: active.goalId, priority: 'MEDIUM' }]);
  expect(await read(o, [active.goalId], new Date(world.getTime() + HOUR / 2)))
    .toEqual([{ goal_id: active.goalId, priority: 'LOW' }]);
});

it('applies the explicit initial temporary override written in the same transaction as goal creation', async () => {
  const o = await owner(), world = new Date(Date.now() + HOUR);
  const active = await appTx(o, 'goals.manage', tx => createGoal(tx, { ownerScopeId: o.owner, actorId: o.actor,
    goal: { title: 'Goal with initial override', domain: 'WORK', priority: 'HIGH',
      temporaryOverride: { priority: 'PAUSED', reason: 'Temporarily paused', until: new Date(world.getTime() + HOUR).toISOString() } },
    now: new Date() }));
  expect(await read(o, [active.goalId], world)).toEqual([]);
  expect(await read(o, [active.goalId], new Date(world.getTime() + HOUR)))
    .toEqual([{ goal_id: active.goalId, priority: 'HIGH' }]);
});

it('fails closed outside the declared owner, membership, read purpose and bounded request', async () => {
  const a = await owner(), b = await owner(), world = new Date(Date.now() + HOUR);
  const first = await goal(a), second = await goal(b);
  expect(await read(a, [first.goalId, second.goalId], world)).toEqual([{ goal_id: first.goalId, priority: 'HIGH' }]);
  expect(await read(a, [second.goalId], world, undefined, 'memory.read', b.owner)).toEqual([]);
  expect(await read({ owner: a.owner, actor: b.actor }, [first.goalId], world)).toEqual([]);
  expect(await read(a, [first.goalId], world, undefined, 'goals.manage')).toEqual([]);
  expect(await read(a, [first.goalId], world, undefined, 'memory.inspect')).toEqual([{ goal_id: first.goalId, priority: 'HIGH' }]);
  expect(await read(a, Array.from({ length: 501 }, () => first.goalId), world)).toEqual([]);
  expect(await appTx(a, 'memory.read', async tx => (await tx.query(
    'SELECT * FROM unai_private.active_goal_priorities($1,$2::uuid[],NULL,NULL)', [a.owner, [first.goalId]])).rows)).toEqual([]);
});
