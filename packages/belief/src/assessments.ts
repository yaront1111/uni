import { assessmentStatusSchema, type AssessmentStatus } from '@unai/domain';
import type { MemoryTransaction } from '@unai/memory';
import { uuidV7 } from '../../../src/kernel/identities.js';
import { POLICY_VERSION } from './policy.js';

/** The belief assessment engine and the derived-dependency record.
 *
 * Every verdict is appended: `recordBeliefAssessment` closes the live row's
 * recorded-time window and writes a new row, so what the kernel believed at any
 * recorded time stays readable for good (PRD §14, §33.7). Nothing here opens a
 * transaction or decides policy; the caller has already done both.
 */

export class BeliefAssessmentError extends Error {
  constructor(code: string) { super(code); this.name = 'BeliefAssessmentError'; }
}

export interface StoredAssessment {
  readonly id: string;
  readonly propositionId: string;
  readonly assessmentStatus: AssessmentStatus;
  readonly validFrom: string | null;
  readonly validTo: string | null;
  readonly recordedAt: string;
  readonly supersededRecordedAt: string | null;
  readonly policyVersion: string;
  readonly decisionReason: Record<string, unknown>;
  readonly transactionId: string;
}

function toAssessment(row: Record<string, unknown>): StoredAssessment {
  return Object.freeze({
    id: row['id'] as string,
    propositionId: row['proposition_id'] as string,
    assessmentStatus: assessmentStatusSchema.parse(row['assessment_status']),
    validFrom: row['valid_from'] ? (row['valid_from'] as Date).toISOString() : null,
    validTo: row['valid_to'] ? (row['valid_to'] as Date).toISOString() : null,
    recordedAt: (row['recorded_at'] as Date).toISOString(),
    supersededRecordedAt: row['superseded_recorded_at'] ? (row['superseded_recorded_at'] as Date).toISOString() : null,
    policyVersion: row['policy_version'] as string,
    decisionReason: (row['decision_reason'] as Record<string, unknown>) ?? {},
    transactionId: row['transaction_id'] as string,
  });
}

/**
 * Append one recorded-time version of what the kernel believes (PRD §33.7).
 *
 * The previous live version is closed rather than replaced, and the database
 * refuses any other edit to it (`BELIEF_ASSESSMENT_APPEND_ONLY`), so an earlier
 * verdict can never be rewritten into a later one.
 */
export async function recordBeliefAssessment(
  tx: MemoryTransaction,
  input: {
    ownerScopeId: string; propositionId: string; assessmentStatus: AssessmentStatus; transactionId: string;
    validFrom?: string | null; validTo?: string | null;
    decisionReason?: Record<string, unknown>; policyVersion?: string;
  },
): Promise<StoredAssessment> {
  const status = assessmentStatusSchema.parse(input.assessmentStatus);
  await tx.query(
    `UPDATE belief_assessments SET superseded_recorded_at=now()
     WHERE owner_scope_id=$1 AND proposition_id=$2 AND superseded_recorded_at IS NULL`,
    [input.ownerScopeId, input.propositionId]);
  const id = uuidV7();
  const inserted = await tx.query(
    `INSERT INTO belief_assessments(id,owner_scope_id,proposition_id,assessment_status,valid_from,valid_to,
      policy_version,decision_reason,transaction_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id,proposition_id,assessment_status,valid_from,valid_to,recorded_at,superseded_recorded_at,
      policy_version,decision_reason,transaction_id`,
    [id, input.ownerScopeId, input.propositionId, status, input.validFrom ?? null, input.validTo ?? null,
      input.policyVersion ?? POLICY_VERSION, JSON.stringify(input.decisionReason ?? {}), input.transactionId]);
  const row = inserted.rows[0];
  if (!row) throw new BeliefAssessmentError('BELIEF_ASSESSMENT_NOT_RECORDED');
  return toAssessment(row);
}

/** What the kernel believes now, or null when no verdict was ever recorded. */
export async function readCurrentAssessment(tx: MemoryTransaction, ownerScopeId: string, propositionId: string): Promise<StoredAssessment | null> {
  const row = (await tx.query(
    `SELECT id,proposition_id,assessment_status,valid_from,valid_to,recorded_at,superseded_recorded_at,
      policy_version,decision_reason,transaction_id
     FROM belief_assessments WHERE owner_scope_id=$1 AND proposition_id=$2 AND superseded_recorded_at IS NULL`,
    [ownerScopeId, propositionId])).rows[0];
  return row ? toAssessment(row) : null;
}

/** Every recorded-time version, oldest first: the Memory inspector's history. */
export async function readAssessmentHistory(tx: MemoryTransaction, ownerScopeId: string, propositionId: string): Promise<StoredAssessment[]> {
  const rows = (await tx.query(
    `SELECT id,proposition_id,assessment_status,valid_from,valid_to,recorded_at,superseded_recorded_at,
      policy_version,decision_reason,transaction_id
     FROM belief_assessments WHERE owner_scope_id=$1 AND proposition_id=$2 ORDER BY recorded_at,id`,
    [ownerScopeId, propositionId])).rows;
  return rows.map(toAssessment);
}

export interface DerivedDependency {
  readonly id: string;
  readonly derivedPropositionId: string;
  readonly inputClaimIds: readonly string[];
  readonly inputPropositionIds: readonly string[];
  readonly evaluatorId: string;
  readonly modelOrCodeVersion: string;
  readonly registryReleaseId: string;
  readonly calculationInputs: Record<string, unknown>;
  readonly createdByTransactionId: string;
  readonly createdAt: string;
}

/**
 * Record how a derived proposition was computed (CRT-AI-02-A).
 *
 * Input ids, evaluator, code or model version, pinned registry release,
 * calculation inputs and creation time are all stored; the schema refuses a
 * derivation with no inputs at all, so "derived from nothing" is unrepresentable.
 */
export async function recordDerivedDependency(
  tx: MemoryTransaction,
  input: {
    ownerScopeId: string; derivedPropositionId: string; inputClaimIds?: readonly string[];
    inputPropositionIds?: readonly string[]; evaluatorId: string; modelOrCodeVersion: string;
    registryReleaseId: string; calculationInputs: Record<string, unknown>; createdByTransactionId: string;
  },
): Promise<DerivedDependency> {
  const id = uuidV7();
  const row = (await tx.query(
    `INSERT INTO derived_proposition_dependencies(id,owner_scope_id,derived_proposition_id,input_claim_ids,
      input_proposition_ids,evaluator_id,model_or_code_version,registry_release_id,calculation_inputs,created_by_transaction_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id,derived_proposition_id,input_claim_ids,input_proposition_ids,evaluator_id,model_or_code_version,
      registry_release_id,calculation_inputs,created_by_transaction_id,created_at`,
    [id, input.ownerScopeId, input.derivedPropositionId, [...(input.inputClaimIds ?? [])],
      [...(input.inputPropositionIds ?? [])], input.evaluatorId, input.modelOrCodeVersion,
      input.registryReleaseId, JSON.stringify(input.calculationInputs), input.createdByTransactionId])).rows[0];
  if (!row) throw new BeliefAssessmentError('DERIVED_DEPENDENCY_NOT_RECORDED');
  return Object.freeze({
    id: row['id'] as string,
    derivedPropositionId: row['derived_proposition_id'] as string,
    inputClaimIds: Object.freeze([...(row['input_claim_ids'] as string[])]),
    inputPropositionIds: Object.freeze([...(row['input_proposition_ids'] as string[])]),
    evaluatorId: row['evaluator_id'] as string,
    modelOrCodeVersion: row['model_or_code_version'] as string,
    registryReleaseId: row['registry_release_id'] as string,
    calculationInputs: row['calculation_inputs'] as Record<string, unknown>,
    createdByTransactionId: row['created_by_transaction_id'] as string,
    createdAt: (row['created_at'] as Date).toISOString(),
  });
}

export async function readDerivedDependencies(tx: MemoryTransaction, ownerScopeId: string, derivedPropositionId: string): Promise<DerivedDependency[]> {
  const rows = (await tx.query(
    `SELECT id,derived_proposition_id,input_claim_ids,input_proposition_ids,evaluator_id,model_or_code_version,
      registry_release_id,calculation_inputs,created_by_transaction_id,created_at
     FROM derived_proposition_dependencies WHERE owner_scope_id=$1 AND derived_proposition_id=$2 ORDER BY created_at,id`,
    [ownerScopeId, derivedPropositionId])).rows;
  return rows.map(row => Object.freeze({
    id: row['id'] as string,
    derivedPropositionId: row['derived_proposition_id'] as string,
    inputClaimIds: Object.freeze([...(row['input_claim_ids'] as string[])]),
    inputPropositionIds: Object.freeze([...(row['input_proposition_ids'] as string[])]),
    evaluatorId: row['evaluator_id'] as string,
    modelOrCodeVersion: row['model_or_code_version'] as string,
    registryReleaseId: row['registry_release_id'] as string,
    calculationInputs: row['calculation_inputs'] as Record<string, unknown>,
    createdByTransactionId: row['created_by_transaction_id'] as string,
    createdAt: (row['created_at'] as Date).toISOString(),
  }));
}

/** A claim no longer carries its assertion forward once it is rejected,
 * superseded or suppressed; a proposition stops carrying one once its own verdict
 * is any of those or `UNSUPPORTED`. */
const INVALID_CLAIM_LIFECYCLES = ['REJECTED', 'SUPERSEDED', 'SUPPRESSED'];
const INVALID_ASSESSMENTS = ['REJECTED', 'SUPERSEDED', 'SUPPRESSED', 'UNSUPPORTED'];

/**
 * Move every derived proposition whose inputs are all invalidated to
 * `UNSUPPORTED` (CRT-AI-02-A), and answer which ones moved.
 *
 * "All", not "any": a derivation that still has one live input is still
 * supported, and its verdict is left exactly as it was. The transition is an
 * append like every other verdict -- the earlier `ACCEPTED` row stays readable
 * with its own recorded-time window, which is what the Memory inspector's
 * UNSUPPORTED state shows.
 */
export async function reassessDerivedPropositions(
  tx: MemoryTransaction,
  input: { ownerScopeId: string; transactionId: string; candidatePropositionIds?: readonly string[] },
): Promise<StoredAssessment[]> {
  const scoped = input.candidatePropositionIds && input.candidatePropositionIds.length > 0;
  const rows = (await tx.query(
    `SELECT DISTINCT d.derived_proposition_id AS id
     FROM derived_proposition_dependencies d
     WHERE d.owner_scope_id=$1
       AND ($2::uuid[] IS NULL OR d.derived_proposition_id = ANY($2::uuid[]))
       -- Every input claim has stopped carrying its assertion...
       AND NOT EXISTS(
         SELECT 1 FROM claims c WHERE c.owner_scope_id=d.owner_scope_id
           AND c.id = ANY(d.input_claim_ids) AND c.lifecycle <> ALL($3::text[]))
       -- ...and so has every input proposition, judged by its live verdict.
       AND NOT EXISTS(
         SELECT 1 FROM propositions p
         LEFT JOIN belief_assessments a ON a.owner_scope_id=p.owner_scope_id
           AND a.proposition_id=p.id AND a.superseded_recorded_at IS NULL
         WHERE p.owner_scope_id=d.owner_scope_id AND p.id = ANY(d.input_proposition_ids)
           AND (a.assessment_status IS NULL OR a.assessment_status <> ALL($4::text[])))
       -- ...and the derived belief has not already been moved there.
       AND EXISTS(
         SELECT 1 FROM belief_assessments a WHERE a.owner_scope_id=d.owner_scope_id
           AND a.proposition_id=d.derived_proposition_id AND a.superseded_recorded_at IS NULL
           AND a.assessment_status <> 'UNSUPPORTED')`,
    [input.ownerScopeId, scoped ? [...input.candidatePropositionIds!] : null,
      INVALID_CLAIM_LIFECYCLES, INVALID_ASSESSMENTS])).rows;

  const moved: StoredAssessment[] = [];
  for (const row of rows) {
    moved.push(await recordBeliefAssessment(tx, {
      ownerScopeId: input.ownerScopeId, propositionId: row['id'] as string,
      assessmentStatus: 'UNSUPPORTED', transactionId: input.transactionId,
      decisionReason: { code: 'ALL_DERIVATION_INPUTS_INVALIDATED' },
    }));
  }
  return moved;
}
