import {
  createGoalSchema, goalPriorityChangeSchema, goalPriorityHistoryEntrySchema, goalSchema, temporaryOverrideSchema,
  type CreateGoal, type Goal, type GoalPriority, type GoalPriorityChange, type GoalPriorityHistoryEntry,
} from '@unai/domain';
import type { MemoryTransaction } from '@unai/memory';
import { uuidV7 } from '../../../src/kernel/identities.js';

/**
 * Goals and their retained priority history (PRD §52 "goal model and priority
 * history", §37.7; design entities `goals`, `goal_priority_history`, routes
 * GET/POST /v1/goals and PATCH /v1/goals/{id}/priority; ADR 0029 §2;
 * CRT-DEC-01-A).
 *
 * The rule: **a priority change appends history and overwrites nothing.** Every
 * statement of a priority -- the first, every change and every temporary
 * override -- is a new `goal_priority_history` row, which no principal can update
 * or delete. `goals.current_priority` is only a cache of the latest standing
 * statement, and migration 0024 refuses to move it unless this transaction
 * appended the row it names.
 */

export const GOALS_READ_PURPOSE = 'goals.read';
export const GOALS_MANAGE_PURPOSE = 'goals.manage';

export class GoalError extends Error {
  constructor(code: string) { super(code); this.name = 'GoalError'; }
}

const iso = (value: unknown) => value === null || value === undefined ? null : (value as Date).toISOString();

function historyEntry(row: Record<string, unknown>): GoalPriorityHistoryEntry {
  return goalPriorityHistoryEntrySchema.parse({
    goalPriorityHistoryId: row['id'], changeKind: row['change_kind'], priority: row['priority'],
    validFrom: iso(row['valid_from']), validTo: iso(row['valid_to']), recordedAt: iso(row['recorded_at']), reason: row['reason'],
  });
}

/** The priority that applies at an instant: an override whose window holds it,
 * else the standing priority. */
export function effectivePriorityOf(goal: Pick<Goal, 'currentPriority' | 'temporaryOverride'>, at: Date): { priority: GoalPriority; overrideActive: boolean } {
  const override = goal.temporaryOverride;
  const active = override !== null && Date.parse(override.validFrom) <= at.getTime() && at.getTime() < Date.parse(override.validTo);
  return { priority: active ? override.priority : goal.currentPriority, overrideActive: active };
}

/** The standing statement a goal's current priority came from: its latest
 * INITIAL or CHANGE row. */
export function standingStatement(goal: Pick<Goal, 'priorityHistory'>): GoalPriorityHistoryEntry | null {
  return [...goal.priorityHistory].reverse().find(entry => entry.changeKind !== 'TEMPORARY_OVERRIDE') ?? null;
}

async function readGoals(tx: MemoryTransaction, input: { ownerScopeId: string; goalIds?: readonly string[]; at: Date }): Promise<Goal[]> {
  const only = input.goalIds ? [...input.goalIds] : null;
  const rows = (await tx.query(
    `SELECT id,title,domain,current_priority,temporary_override,created_at,retired_at FROM goals
     WHERE owner_scope_id=$1 AND ($2::uuid[] IS NULL OR id=ANY($2::uuid[])) ORDER BY created_at,id`,
    [input.ownerScopeId, only])).rows;
  if (rows.length === 0) return [];
  const ids = rows.map(row => row['id'] as string);
  const history = (await tx.query(
    `SELECT id,goal_id,change_kind,priority,valid_from,valid_to,recorded_at,reason FROM goal_priority_history
     WHERE owner_scope_id=$1 AND goal_id=ANY($2::uuid[]) ORDER BY recorded_at,valid_from,id`, [input.ownerScopeId, ids])).rows;
  return rows.map(row => {
    const override = row['temporary_override'] ? temporaryOverrideSchema.parse(row['temporary_override']) : null;
    const partial = { currentPriority: row['current_priority'] as GoalPriority, temporaryOverride: override };
    const effective = effectivePriorityOf(partial, input.at);
    return goalSchema.parse({
      goalId: row['id'], title: row['title'], domain: row['domain'], ...partial,
      effectivePriority: effective.priority, overrideActive: effective.overrideActive,
      createdAt: iso(row['created_at']), retiredAt: iso(row['retired_at']),
      priorityHistory: history.filter(entry => entry['goal_id'] === row['id']).map(historyEntry),
      contradiction: null,
    });
  });
}

/** The latest mentor reading of each goal, for the Goals screen's flag. Read
 * under a purpose that sees `mentor_cards` (`goals.read`). */
async function withContradictionFlags(tx: MemoryTransaction, ownerScopeId: string, goals: Goal[]): Promise<Goal[]> {
  if (goals.length === 0) return goals;
  const rows = (await tx.query(
    `SELECT DISTINCT ON (goal_id) id,goal_id,decision,reason,owner_local_date::text AS owner_local_date,decided_at FROM mentor_cards
     WHERE owner_scope_id=$1 AND goal_id=ANY($2::uuid[]) ORDER BY goal_id,decided_at DESC,id DESC`,
    [ownerScopeId, goals.map(goal => goal.goalId)])).rows;
  return goals.map(goal => {
    const row = rows.find(candidate => candidate['goal_id'] === goal.goalId);
    return row ? goalSchema.parse({ ...goal, contradiction: { mentorCardId: row['id'], decision: row['decision'], reason: row['reason'],
      ownerLocalDate: row['owner_local_date'], decidedAt: iso(row['decided_at']) } }) : goal;
  });
}

/** Every goal of the owner with its whole history, oldest first. */
export async function listGoals(tx: MemoryTransaction, input: { ownerScopeId: string; at: Date; includeFlags?: boolean }): Promise<Goal[]> {
  const goals = await readGoals(tx, input);
  return input.includeFlags ? withContradictionFlags(tx, input.ownerScopeId, goals) : goals;
}

export async function readGoal(tx: MemoryTransaction, input: { ownerScopeId: string; goalId: string; at: Date }): Promise<Goal> {
  const [goal] = await readGoals(tx, { ownerScopeId: input.ownerScopeId, goalIds: [input.goalId], at: input.at });
  if (!goal) throw new GoalError('GOAL_NOT_FOUND');
  return goal;
}

async function appendHistory(tx: MemoryTransaction, input: {
  ownerScopeId: string; goalId: string; actorId: string; changeKind: GoalPriorityHistoryEntry['changeKind'];
  priority: GoalPriority; validFrom: Date; validTo: Date | null; reason: string;
}): Promise<GoalPriorityHistoryEntry> {
  const row = (await tx.query(
    `INSERT INTO goal_priority_history(id,owner_scope_id,goal_id,change_kind,priority,valid_from,valid_to,reason,recorded_by_user_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,change_kind,priority,valid_from,valid_to,recorded_at,reason`,
    [uuidV7(), input.ownerScopeId, input.goalId, input.changeKind, input.priority, input.validFrom, input.validTo,
      input.reason, input.actorId])).rows[0]!;
  return historyEntry(row);
}

async function setOverride(tx: MemoryTransaction, input: { ownerScopeId: string; goalId: string; entry: GoalPriorityHistoryEntry }) {
  const override = temporaryOverrideSchema.parse({ historyId: input.entry.goalPriorityHistoryId, priority: input.entry.priority,
    validFrom: input.entry.validFrom, validTo: input.entry.validTo, reason: input.entry.reason });
  await tx.query('UPDATE goals SET temporary_override=$3 WHERE owner_scope_id=$1 AND id=$2',
    [input.ownerScopeId, input.goalId, JSON.stringify(override)]);
}

/** State a goal. Its first priority is its INITIAL history row, written in the
 * same transaction (migration 0024 refuses a goal without one at commit). */
export async function createGoal(tx: MemoryTransaction, input: {
  ownerScopeId: string; actorId: string; goal: CreateGoal; now: Date;
}): Promise<Goal> {
  const goal = createGoalSchema.parse(input.goal);
  const goalId = uuidV7();
  await tx.query(`INSERT INTO goals(id,owner_scope_id,title,domain,current_priority,created_by_user_id) VALUES($1,$2,$3,$4,$5,$6)`,
    [goalId, input.ownerScopeId, goal.title, goal.domain, goal.priority, input.actorId]);
  await appendHistory(tx, { ownerScopeId: input.ownerScopeId, goalId, actorId: input.actorId, changeKind: 'INITIAL',
    priority: goal.priority, validFrom: input.now, validTo: null, reason: goal.reason ?? 'Stated when the goal was set.' });
  if (goal.temporaryOverride) {
    const until = new Date(goal.temporaryOverride.until);
    if (until.getTime() <= input.now.getTime()) throw new GoalError('GOAL_OVERRIDE_WINDOW_INVALID');
    const entry = await appendHistory(tx, { ownerScopeId: input.ownerScopeId, goalId, actorId: input.actorId,
      changeKind: 'TEMPORARY_OVERRIDE', priority: goal.temporaryOverride.priority, validFrom: input.now, validTo: until,
      reason: goal.temporaryOverride.reason });
    await setOverride(tx, { ownerScopeId: input.ownerScopeId, goalId, entry });
  }
  return readGoal(tx, { ownerScopeId: input.ownerScopeId, goalId, at: input.now });
}

/**
 * Change a goal's priority by appending a history row (CRT-DEC-01-A).
 *
 * Without `until` it is a standing change: a `CHANGE` row, then the cached
 * current priority follows it, and an override the owner had set no longer
 * applies. With `until` it is a temporary override: a `TEMPORARY_OVERRIDE` row
 * bounded by `until`, and the standing priority is untouched (PRD §37.7).
 */
export async function changeGoalPriority(tx: MemoryTransaction, input: {
  ownerScopeId: string; actorId: string; goalId: string; change: GoalPriorityChange; now: Date;
}): Promise<{ goal: Goal; appended: GoalPriorityHistoryEntry }> {
  const change = goalPriorityChangeSchema.parse(input.change);
  const current = await readGoal(tx, { ownerScopeId: input.ownerScopeId, goalId: input.goalId, at: input.now });
  if (current.retiredAt !== null) throw new GoalError('GOAL_RETIRED');
  const validFrom = change.effectiveFrom ? new Date(change.effectiveFrom) : input.now;
  if (change.until) {
    const until = new Date(change.until);
    if (until.getTime() <= validFrom.getTime() || until.getTime() <= input.now.getTime()) throw new GoalError('GOAL_OVERRIDE_WINDOW_INVALID');
    const appended = await appendHistory(tx, { ownerScopeId: input.ownerScopeId, goalId: input.goalId, actorId: input.actorId,
      changeKind: 'TEMPORARY_OVERRIDE', priority: change.priority, validFrom, validTo: until, reason: change.reason });
    await setOverride(tx, { ownerScopeId: input.ownerScopeId, goalId: input.goalId, entry: appended });
    return { goal: await readGoal(tx, { ownerScopeId: input.ownerScopeId, goalId: input.goalId, at: input.now }), appended };
  }
  const appended = await appendHistory(tx, { ownerScopeId: input.ownerScopeId, goalId: input.goalId, actorId: input.actorId,
    changeKind: 'CHANGE', priority: change.priority, validFrom, validTo: null, reason: change.reason });
  await tx.query('UPDATE goals SET current_priority=$3,temporary_override=NULL WHERE owner_scope_id=$1 AND id=$2',
    [input.ownerScopeId, input.goalId, change.priority]);
  return { goal: await readGoal(tx, { ownerScopeId: input.ownerScopeId, goalId: input.goalId, at: input.now }), appended };
}
