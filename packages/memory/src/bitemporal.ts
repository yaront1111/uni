import { assessmentStatusSchema, type AssessmentStatus } from '@unai/domain';
import { uuidV7 } from '../../../src/kernel/identities.js';
import { MemoryStoreError, type MemoryTransaction } from './transaction.js';

/** The bitemporal query operators of PRD §12.3 and the knowledge-time writer they
 * read (CRT-MEM-06-A, CRT-MEM-06-B).
 *
 * Two axes, never one. Valid time says when a proposition was true in the world;
 * recorded time says when Uai knew it. `belief_assessments` carries both -- valid
 * time in `valid_from`/`valid_to`, recorded time in
 * `recorded_at`/`superseded_recorded_at` -- and a changed verdict is a new row,
 * so the answer to "what did Uai believe on August 7" survives learning something
 * else on August 10.
 *
 * The three modes are three operators rather than one with optional arguments,
 * because the arguments they refuse are what makes them different questions:
 *
 *   CURRENT_STATE               world = now,       knowledge = latest
 *   CORRECTED_HISTORICAL_STATE  world = requested, knowledge = latest
 *   HISTORICAL_BELIEF_STATE     world = requested, knowledge = requested
 */

export const BITEMPORAL_QUERY_VERSION = 'bitemporal-query-0.1.0';
/** The policy version a canonicalization-time state version is recorded under.
 * The write governor records its own verdicts under its policy version; this one
 * marks a version written by the bitemporal recorder. */
export const BITEMPORAL_POLICY_VERSION = 'bitemporal-recorder-0.1.0';

export type BeliefQueryMode = 'CURRENT_STATE' | 'CORRECTED_HISTORICAL_STATE' | 'HISTORICAL_BELIEF_STATE';

/** The assessment vocabulary is the write governor's; this module reads it and
 * never widens it. */
export type AssessmentStatusName = AssessmentStatus;

const statusSchema = assessmentStatusSchema;

/** A belief holding over a valid interval, as one knowledge time saw it. */
export interface BeliefStateRow {
  readonly propositionId: string;
  readonly beliefSlotId: string;
  readonly frameInstanceId: string;
  readonly predicateId: string;
  readonly normalizedValue: unknown;
  readonly polarity: 'POSITIVE' | 'NEGATIVE';
  readonly assessmentId: string;
  readonly assessmentStatus: AssessmentStatusName;
  readonly validFrom: string | null;
  readonly validTo: string | null;
  readonly recordedAt: string;
  readonly supersededRecordedAt: string | null;
  readonly transactionId: string;
}

export interface BeliefStateAnswer {
  readonly mode: BeliefQueryMode;
  /** The world instant the answer is about. */
  readonly worldTime: string;
  /** The knowledge instant the answer used, or null for "everything known now". */
  readonly knowledgeTime: string | null;
  readonly states: readonly BeliefStateRow[];
  readonly queryVersion: string;
}

export interface BeliefStateScope {
  readonly ownerScopeId: string;
  readonly beliefSlotId?: string;
  readonly frameInstanceId?: string;
  readonly predicateId?: string;
  /** Which verdicts count as state. The default is the accepted belief; the
   * Memory inspector widens it to show contested and superseded values too. */
  readonly assessmentStatuses?: readonly AssessmentStatusName[];
}

function scopeClauses(scope: BeliefStateScope, values: unknown[]): string {
  const clauses: string[] = [];
  if (scope.beliefSlotId) { values.push(scope.beliefSlotId); clauses.push(`s.id=$${values.length}`); }
  if (scope.frameInstanceId) { values.push(scope.frameInstanceId); clauses.push(`s.frame_instance_id=$${values.length}`); }
  if (scope.predicateId) { values.push(scope.predicateId); clauses.push(`s.predicate_id=$${values.length}`); }
  if (clauses.length === 0) throw new MemoryStoreError('BITEMPORAL_QUERY_SCOPE_REQUIRED');
  return clauses.join(' AND ');
}

function toStateRow(row: Record<string, unknown>): BeliefStateRow {
  return Object.freeze({
    propositionId: row['proposition_id'] as string,
    beliefSlotId: row['belief_slot_id'] as string,
    frameInstanceId: row['frame_instance_id'] as string,
    predicateId: row['predicate_id'] as string,
    normalizedValue: row['normalized_value'],
    polarity: row['polarity'] as 'POSITIVE' | 'NEGATIVE',
    assessmentId: row['assessment_id'] as string,
    assessmentStatus: statusSchema.parse(row['assessment_status']),
    validFrom: row['valid_from'] ? (row['valid_from'] as Date).toISOString() : null,
    validTo: row['valid_to'] ? (row['valid_to'] as Date).toISOString() : null,
    recordedAt: (row['recorded_at'] as Date).toISOString(),
    supersededRecordedAt: row['superseded_recorded_at'] ? (row['superseded_recorded_at'] as Date).toISOString() : null,
    transactionId: row['transaction_id'] as string,
  });
}

/**
 * The one query behind the three operators.
 *
 * Valid time is a half-open interval `[valid_from, valid_to)`, so a state that
 * ends on August 5 and one that begins on August 5 never both answer for August
 * 5. Recorded time is the same shape over `[recorded_at,
 * superseded_recorded_at)`, so a knowledge instant selects exactly the version
 * that was live then.
 */
async function selectStates(tx: MemoryTransaction, scope: BeliefStateScope, worldTime: Date, knowledgeTime: Date | null): Promise<BeliefStateRow[]> {
  const statuses = [...(scope.assessmentStatuses ?? ['ACCEPTED'])].map(status => statusSchema.parse(status));
  const values: unknown[] = [scope.ownerScopeId];
  const scoped = scopeClauses(scope, values);
  values.push(statuses); const statusParameter = `$${values.length}`;
  values.push(worldTime); const worldParameter = `$${values.length}`;
  let knowledgeClause = 'a.superseded_recorded_at IS NULL';
  if (knowledgeTime !== null) {
    values.push(knowledgeTime);
    const parameter = `$${values.length}`;
    knowledgeClause = `a.recorded_at <= ${parameter} AND (a.superseded_recorded_at IS NULL OR a.superseded_recorded_at > ${parameter})`;
  }
  const rows = (await tx.query(
    `SELECT a.id AS assessment_id,a.proposition_id,a.assessment_status,a.valid_from,a.valid_to,a.recorded_at,
       a.superseded_recorded_at,a.transaction_id,p.belief_slot_id,p.normalized_value,p.polarity,
       s.frame_instance_id,s.predicate_id
     FROM belief_assessments a
     JOIN propositions p ON p.owner_scope_id=a.owner_scope_id AND p.id=a.proposition_id
     JOIN belief_slots s ON s.owner_scope_id=p.owner_scope_id AND s.id=p.belief_slot_id
     WHERE a.owner_scope_id=$1 AND ${scoped}
       AND a.assessment_status = ANY(${statusParameter})
       AND (a.valid_from IS NULL OR a.valid_from <= ${worldParameter})
       AND (a.valid_to IS NULL OR a.valid_to > ${worldParameter})
       AND ${knowledgeClause}
     ORDER BY a.valid_from NULLS FIRST,a.recorded_at,a.id`, values)).rows;
  return rows.map(toStateRow);
}

/** What is true now, using everything known now (PRD §12.3 "current state"). */
export async function queryCurrentState(tx: MemoryTransaction, scope: BeliefStateScope): Promise<BeliefStateAnswer> {
  const worldTime = (await tx.query('SELECT now() AS at')).rows[0]!['at'] as Date;
  return Object.freeze({
    mode: 'CURRENT_STATE' as const, worldTime: worldTime.toISOString(), knowledgeTime: null,
    states: Object.freeze(await selectStates(tx, scope, worldTime, null)), queryVersion: BITEMPORAL_QUERY_VERSION,
  });
}

/** What we now believe was true then (PRD §12.3 "corrected historical state"). */
export async function queryCorrectedHistoricalState(
  tx: MemoryTransaction, scope: BeliefStateScope & { worldTime: Date },
): Promise<BeliefStateAnswer> {
  return Object.freeze({
    mode: 'CORRECTED_HISTORICAL_STATE' as const, worldTime: scope.worldTime.toISOString(), knowledgeTime: null,
    states: Object.freeze(await selectStates(tx, scope, scope.worldTime, null)), queryVersion: BITEMPORAL_QUERY_VERSION,
  });
}

/** What Uai believed then, using only what it knew then (PRD §12.3 "historical
 * belief state"). The knowledge instant defaults to the world instant, which is
 * the mode as the PRD states it; a caller may name a different one to ask what
 * was believed at some later knowledge time about an earlier world time. */
export async function queryHistoricalBeliefState(
  tx: MemoryTransaction, scope: BeliefStateScope & { worldTime: Date; knowledgeTime?: Date },
): Promise<BeliefStateAnswer> {
  const knowledgeTime = scope.knowledgeTime ?? scope.worldTime;
  return Object.freeze({
    mode: 'HISTORICAL_BELIEF_STATE' as const, worldTime: scope.worldTime.toISOString(),
    knowledgeTime: knowledgeTime.toISOString(),
    states: Object.freeze(await selectStates(tx, scope, scope.worldTime, knowledgeTime)),
    queryVersion: BITEMPORAL_QUERY_VERSION,
  });
}

/** One entry point over the three, for a caller that carries the mode as data --
 * the Memory inspector's timeline control, for instance. The arguments each mode
 * refuses are part of its meaning, so a world time on a current-state query or a
 * knowledge time on a corrected-historical one is refused rather than ignored. */
export async function queryBeliefState(tx: MemoryTransaction, request: BeliefStateScope & {
  mode: BeliefQueryMode; worldTime?: Date; knowledgeTime?: Date;
}): Promise<BeliefStateAnswer> {
  switch (request.mode) {
    case 'CURRENT_STATE':
      if (request.worldTime || request.knowledgeTime) throw new MemoryStoreError('BITEMPORAL_QUERY_ARGUMENT_REFUSED');
      return queryCurrentState(tx, request);
    case 'CORRECTED_HISTORICAL_STATE':
      if (!request.worldTime) throw new MemoryStoreError('BITEMPORAL_QUERY_WORLD_TIME_REQUIRED');
      if (request.knowledgeTime) throw new MemoryStoreError('BITEMPORAL_QUERY_ARGUMENT_REFUSED');
      return queryCorrectedHistoricalState(tx, { ...request, worldTime: request.worldTime });
    case 'HISTORICAL_BELIEF_STATE': {
      if (!request.worldTime) throw new MemoryStoreError('BITEMPORAL_QUERY_WORLD_TIME_REQUIRED');
      return queryHistoricalBeliefState(tx, {
        ...request, worldTime: request.worldTime,
        ...(request.knowledgeTime ? { knowledgeTime: request.knowledgeTime } : {}),
      });
    }
  }
}

/** Every recorded-time version of every proposition in a slot, oldest first: the
 * Memory inspector's "historical timeline over valid time and recorded time". */
export async function readBeliefTimeline(tx: MemoryTransaction, scope: BeliefStateScope): Promise<BeliefStateRow[]> {
  const values: unknown[] = [scope.ownerScopeId];
  const scoped = scopeClauses(scope, values);
  const rows = (await tx.query(
    `SELECT a.id AS assessment_id,a.proposition_id,a.assessment_status,a.valid_from,a.valid_to,a.recorded_at,
       a.superseded_recorded_at,a.transaction_id,p.belief_slot_id,p.normalized_value,p.polarity,
       s.frame_instance_id,s.predicate_id
     FROM belief_assessments a
     JOIN propositions p ON p.owner_scope_id=a.owner_scope_id AND p.id=a.proposition_id
     JOIN belief_slots s ON s.owner_scope_id=p.owner_scope_id AND s.id=p.belief_slot_id
     WHERE a.owner_scope_id=$1 AND ${scoped}
     ORDER BY a.recorded_at,a.valid_from NULLS FIRST,a.id`, values)).rows;
  return rows.map(toStateRow);
}

export interface BeliefStateVersion extends BeliefStateRow { readonly policyVersion: string }

/**
 * Append one recorded-time version of a belief at a stated knowledge time.
 *
 * The write governor records its verdicts at `now()`. This writer exists for the
 * one case that needs more: a late-arriving correction is learned at a knowledge
 * instant that belongs to the evidence, and replaying a historical timeline --
 * PRD §44.10's "Uai learns on August 10 that a state changed on August 5" -- is
 * not expressible if every version is stamped with the wall clock of the replay.
 *
 * Nothing is rewritten. The live version's window is *closed* at the stated
 * instant and a new row is appended, and the knowledge time may never move
 * backwards (`KNOWLEDGE_TIME_NOT_MONOTONIC`) or into the future
 * (`KNOWLEDGE_TIME_IN_FUTURE`, enforced by the database as well). An earlier
 * answer therefore stays exactly the answer it was.
 */
export async function recordBeliefStateVersion(tx: MemoryTransaction, input: {
  ownerScopeId: string; propositionId: string; assessmentStatus: AssessmentStatusName; transactionId: string;
  validFrom?: Date | null; validTo?: Date | null; knowledgeTime?: Date | null;
  decisionReason?: Readonly<Record<string, unknown>>; policyVersion?: string;
}): Promise<BeliefStateVersion> {
  const status = statusSchema.parse(input.assessmentStatus);
  const knowledgeTime = input.knowledgeTime ?? null;
  if (knowledgeTime) {
    const bounds = (await tx.query(
      `SELECT now() AS at,(SELECT max(recorded_at) FROM belief_assessments
         WHERE owner_scope_id=$1 AND proposition_id=$2) AS latest_recorded_at`,
      [input.ownerScopeId, input.propositionId])).rows[0];
    const now = bounds?.['at'] as Date | undefined;
    const latest = (bounds?.['latest_recorded_at'] ?? null) as Date | null;
    if (now && knowledgeTime > now) throw new MemoryStoreError('KNOWLEDGE_TIME_IN_FUTURE');
    if (latest && knowledgeTime < latest) throw new MemoryStoreError('KNOWLEDGE_TIME_NOT_MONOTONIC');
  }
  await tx.query(
    `UPDATE belief_assessments SET superseded_recorded_at=coalesce($3,now())
     WHERE owner_scope_id=$1 AND proposition_id=$2 AND superseded_recorded_at IS NULL`,
    [input.ownerScopeId, input.propositionId, knowledgeTime]);
  const row = (await tx.query(
    `INSERT INTO belief_assessments(id,owner_scope_id,proposition_id,assessment_status,valid_from,valid_to,
      recorded_at,policy_version,decision_reason,transaction_id)
     VALUES($1,$2,$3,$4,$5,$6,coalesce($7,now()),$8,$9,$10)
     RETURNING id AS assessment_id,proposition_id,assessment_status,valid_from,valid_to,recorded_at,
      superseded_recorded_at,transaction_id,policy_version`,
    [uuidV7(), input.ownerScopeId, input.propositionId, status, input.validFrom ?? null, input.validTo ?? null,
      knowledgeTime, input.policyVersion ?? BITEMPORAL_POLICY_VERSION,
      JSON.stringify(input.decisionReason ?? { code: 'BITEMPORAL_STATE_VERSION' }), input.transactionId])).rows[0];
  if (!row) throw new MemoryStoreError('BELIEF_STATE_VERSION_NOT_RECORDED');
  const slot = (await tx.query(
    `SELECT p.belief_slot_id,p.normalized_value,p.polarity,s.frame_instance_id,s.predicate_id FROM propositions p
     JOIN belief_slots s ON s.owner_scope_id=p.owner_scope_id AND s.id=p.belief_slot_id
     WHERE p.owner_scope_id=$1 AND p.id=$2`, [input.ownerScopeId, input.propositionId])).rows[0];
  if (!slot) throw new MemoryStoreError('PROPOSITION_NOT_FOUND');
  return Object.freeze({ ...toStateRow({ ...row, ...slot }), policyVersion: row['policy_version'] as string });
}
