import { triageDecisionSchema, publicTriageSchema, routingReasonSchema, tier1RouteSchema,
  type TriageDecision } from '@unai/domain';
import { uuidV7 } from '../../../src/kernel/identities.js';
import { triage, type TriageInput, type TriageResult } from './triage.js';
import type { ExtractionTransaction } from './runs.js';

/** Storage for triage decisions.
 *
 * `recordTriageDecision` runs inside the ingest transaction, so an ingested item
 * cannot exist without a recorded route (ADR 0016 §2, CRT-WRT-07-A). It is
 * idempotent on the source item: re-ingesting identical bytes re-derives the same
 * decision, and the second write is a no-op rather than a second opinion.
 */

export interface RecordTriageInput extends TriageInput {
  readonly ownerScopeId: string;
  readonly sourceItemId: string;
}

export async function recordTriageDecision(tx: ExtractionTransaction, input: RecordTriageInput):
  Promise<{ decision: TriageDecision; triaged: TriageResult; recorded: boolean }> {
  const triaged = triage(input);
  const id = uuidV7();
  const inserted = await tx.query(
    `INSERT INTO triage_decisions(id,owner_scope_id,source_item_id,tier0_parsed,tier1_route,routing_reason,cost_budget_microunits)
     VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING id,decided_at`,
    [id, input.ownerScopeId, input.sourceItemId, JSON.stringify(triaged.tier0), triaged.route,
      JSON.stringify(triaged.reason), triaged.costBudgetMicrounits]);
  if (inserted.rowCount === 1) {
    const row = inserted.rows[0]!;
    return {
      decision: triageDecisionSchema.parse({
        triageDecisionId: row.id, sourceItemId: input.sourceItemId, tier1Route: triaged.route,
        routingReason: triaged.reason, costBudgetMicrounits: triaged.costBudgetMicrounits,
        decidedAt: (row.decided_at as Date).toISOString(),
      }),
      triaged, recorded: true,
    };
  }
  const existing = await readTriageDecision(tx, { ownerScopeId: input.ownerScopeId, sourceItemId: input.sourceItemId });
  if (!existing) throw new Error('TRIAGE_DECISION_UNAVAILABLE');
  return { decision: existing, triaged, recorded: false };
}

export async function readTriageDecision(tx: ExtractionTransaction, input: { ownerScopeId: string; sourceItemId: string }):
  Promise<TriageDecision | null> {
  const row = (await tx.query(
    `SELECT id,source_item_id,tier1_route,routing_reason,cost_budget_microunits,decided_at
     FROM triage_decisions WHERE owner_scope_id=$1 AND source_item_id=$2`,
    [input.ownerScopeId, input.sourceItemId])).rows[0];
  if (!row) return null;
  return triageDecisionSchema.parse({
    triageDecisionId: row.id, sourceItemId: row.source_item_id,
    tier1Route: tier1RouteSchema.parse(row.tier1_route),
    routingReason: routingReasonSchema.parse(row.routing_reason),
    costBudgetMicrounits: Number(row.cost_budget_microunits),
    decidedAt: (row.decided_at as Date).toISOString(),
  });
}

/** The route and reason as the evidence read returns them. Null when nothing has
 * routed the item yet: evidence stays readable when later processing has not run
 * or has failed (PRD §11.1, §35.1). */
export function publicTriage(decision: TriageDecision | null) {
  return decision === null ? null : publicTriageSchema.parse({
    tier1Route: decision.tier1Route, routingReason: decision.routingReason, decidedAt: decision.decidedAt,
  });
}
