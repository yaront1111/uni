import {
  DEFAULT_ATTENTION_BUDGET, attentionBudgetPatchSchema, attentionBudgetSchema,
  type AttentionBudget, type AttentionBudgetPatch,
} from '@unai/domain';
import type { MemoryTransaction } from '@unai/memory';

/**
 * Attention budgets (PRD §19.3; design entity `attention_budgets`, PATCH
 * /v1/settings/attention-budgets; ADR 0029 §5).
 *
 * One row per owner scope at most. No row is the PRD default, reported with
 * `isDefault: true` so a reader can tell "never configured" from "configured to
 * the same numbers". Every interruption decision reads the budget in its own
 * transaction, so a change is the cap the very next evaluation enforces.
 */

function toBudget(row: Record<string, unknown> | undefined): AttentionBudget {
  if (!row) return attentionBudgetSchema.parse({ ...DEFAULT_ATTENTION_BUDGET, isDefault: true, updatedAt: null });
  return attentionBudgetSchema.parse({
    maxCardsPerDay: row['max_cards_per_day'],
    maxCardsPerSensitivityScopePerDay: row['max_cards_per_sensitivity_scope_per_day'],
    repeatQuestionSuppressionDays: row['repeat_question_suppression_days'],
    isDefault: false,
    updatedAt: (row['updated_at'] as Date).toISOString(),
  });
}

export async function readAttentionBudget(tx: MemoryTransaction, input: { ownerScopeId: string }): Promise<AttentionBudget> {
  const row = (await tx.query(
    `SELECT max_cards_per_day,max_cards_per_sensitivity_scope_per_day,repeat_question_suppression_days,updated_at
     FROM attention_budgets WHERE owner_scope_id=$1`, [input.ownerScopeId])).rows[0];
  return toBudget(row);
}

/** Apply a patch over the effective budget and record who changed it. The
 * caller's transaction runs under `settings.attention`, the only purpose the
 * write policy admits. */
export async function updateAttentionBudget(tx: MemoryTransaction, input: {
  ownerScopeId: string; actorId: string; patch: AttentionBudgetPatch; now: Date;
}): Promise<AttentionBudget> {
  const patch = attentionBudgetPatchSchema.parse(input.patch);
  const current = await readAttentionBudget(tx, input);
  const next = {
    maxCardsPerDay: patch.maxCardsPerDay ?? current.maxCardsPerDay,
    maxCardsPerSensitivityScopePerDay: patch.maxCardsPerSensitivityScopePerDay ?? current.maxCardsPerSensitivityScopePerDay,
    repeatQuestionSuppressionDays: patch.repeatQuestionSuppressionDays ?? current.repeatQuestionSuppressionDays,
  };
  const row = (await tx.query(
    `INSERT INTO attention_budgets(owner_scope_id,max_cards_per_day,max_cards_per_sensitivity_scope_per_day,
       repeat_question_suppression_days,updated_by_user_id,updated_at)
     VALUES($1,$2,$3,$4,$5,$6)
     ON CONFLICT(owner_scope_id) DO UPDATE SET max_cards_per_day=EXCLUDED.max_cards_per_day,
       max_cards_per_sensitivity_scope_per_day=EXCLUDED.max_cards_per_sensitivity_scope_per_day,
       repeat_question_suppression_days=EXCLUDED.repeat_question_suppression_days,
       updated_by_user_id=EXCLUDED.updated_by_user_id,updated_at=EXCLUDED.updated_at
     RETURNING max_cards_per_day,max_cards_per_sensitivity_scope_per_day,repeat_question_suppression_days,updated_at`,
    [input.ownerScopeId, next.maxCardsPerDay, next.maxCardsPerSensitivityScopePerDay, next.repeatQuestionSuppressionDays,
      input.actorId, input.now])).rows[0];
  return toBudget(row);
}
