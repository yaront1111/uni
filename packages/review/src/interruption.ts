import {
  interruptionPolicyInputsSchema,
  type AttentionBudget, type InterruptionPolicyInputs, type InterruptionReason,
} from '@unai/domain';
import type { CardRisk } from './ambiguities.js';

/**
 * The interruption decision (PRD §19.3, §19.4; ADR 0029 §4).
 *
 * §19.4 weighs probability of error x consequence x irreversibility x urgency
 * against interruption cost, and allows V0 to do so qualitatively provided the
 * inputs and the reason are logged. The scale below is fixed and public, so a
 * logged decision can be recomputed from its own inputs. The order of the
 * checks is the order of ADR 0029 §4 and is part of the contract: a learned rule
 * wins over everything, a repeat is withheld before any budget is spent on it,
 * and the budget caps come last so they only ever withhold questions worth
 * asking.
 */

export const INTERRUPTION_POLICY_VERSION = 'interruption-policy-0.1.0';

const CONSEQUENCE = Object.freeze({ LOW: 0.3, MEDIUM: 0.6, HIGH: 1 });
const IRREVERSIBILITY = Object.freeze({ REVERSIBLE: 0.5, COSTLY_TO_REVERSE: 0.75, IRREVERSIBLE: 1 });
const URGENCY = Object.freeze({ LOW: 0.5, MEDIUM: 0.75, HIGH: 1 });
const INTERRUPTION_COST = Object.freeze({ LOW: 0.05, MEDIUM: 0.1, HIGH: 0.2 });

const round = (value: number) => Math.round(value * 10_000) / 10_000;

/** The product §19.4 names, on the fixed scale above. */
export function expectedValueOf(risk: CardRisk): number {
  return round(risk.errorProbability * CONSEQUENCE[risk.consequence] * IRREVERSIBILITY[risk.irreversibility] * URGENCY[risk.urgency]);
}
export function interruptionCostOf(risk: CardRisk): number {
  return INTERRUPTION_COST[risk.interruptionCost];
}

export interface InterruptionState {
  readonly risk: CardRisk;
  readonly sensitivityScope: string;
  readonly budget: AttentionBudget;
  readonly ownerLocalDate: string;
  readonly timeZone: string;
  readonly now: Date;
  /** Cards already asked today, and in this card's scope today. */
  readonly askedToday: number;
  readonly askedInScopeToday: number;
  /** When this situation's question was last put to the owner, if ever. */
  readonly lastAskedAt: Date | null;
  /** Set when the owner chose to keep the question uncertain. */
  readonly suppressedUntil: Date | null;
  /** Evidence behind the card now that it was not asked with before. */
  readonly materialNewEvidenceIds: readonly string[];
  /** An approved learned rule whose scope matches the card. */
  readonly learnedApprovalRuleId: string | null;
}

export interface InterruptionOutcome {
  readonly decision: 'ASK' | 'BATCH' | 'SUPPRESS';
  readonly reason: InterruptionReason;
  readonly policyInputs: InterruptionPolicyInputs;
}

export function decideInterruption(state: InterruptionState): InterruptionOutcome {
  const expectedValue = expectedValueOf(state.risk);
  const cost = interruptionCostOf(state.risk);
  const policyInputs = interruptionPolicyInputsSchema.parse({
    errorProbability: state.risk.errorProbability, consequence: state.risk.consequence,
    irreversibility: state.risk.irreversibility, urgency: state.risk.urgency, interruptionCost: state.risk.interruptionCost,
    expectedValue, interruptionCostValue: cost, sensitivityScope: state.sensitivityScope,
    ownerLocalDate: state.ownerLocalDate, timeZone: state.timeZone,
    budget: {
      maxCardsPerDay: state.budget.maxCardsPerDay,
      maxCardsPerSensitivityScopePerDay: state.budget.maxCardsPerSensitivityScopePerDay,
      repeatQuestionSuppressionDays: state.budget.repeatQuestionSuppressionDays,
      askedToday: state.askedToday, askedInScopeToday: state.askedInScopeToday,
    },
    lastAskedAt: state.lastAskedAt?.toISOString() ?? null,
    suppressedUntil: state.suppressedUntil?.toISOString() ?? null,
    materialNewEvidenceIds: [...state.materialNewEvidenceIds].sort(),
    learnedApprovalRuleId: state.learnedApprovalRuleId,
  });
  const decide = (decision: InterruptionOutcome['decision'], reason: InterruptionReason): InterruptionOutcome =>
    Object.freeze({ decision, reason, policyInputs });

  // 1. The owner already said what to do with questions like this one.
  if (state.learnedApprovalRuleId !== null) return decide('SUPPRESS', 'LEARNED_RULE_APPLIED');

  // 2. The same unresolved question is not asked again inside the window unless
  //    material new evidence arrived (PRD §19.3).
  const windowMs = state.budget.repeatQuestionSuppressionDays * 86_400_000;
  const newEvidence = state.materialNewEvidenceIds.length > 0;
  const keptUncertain = state.suppressedUntil !== null && state.now.getTime() < state.suppressedUntil.getTime();
  const recentlyAsked = state.lastAskedAt !== null && state.now.getTime() < state.lastAskedAt.getTime() + windowMs;
  if (!newEvidence && keptUncertain) return decide('SUPPRESS', 'KEPT_UNCERTAIN_WITHIN_SUPPRESSION_WINDOW');
  if (!newEvidence && recentlyAsked) return decide('SUPPRESS', 'ASKED_WITHIN_SUPPRESSION_WINDOW');

  // 3. Never interrupt merely because ingestion produced uncertainty: a question
  //    has to be worth more than the interruption it costs.
  if (expectedValue < cost) return decide('BATCH', 'VALUE_BELOW_INTERRUPTION_COST');

  // 4 and 5. The budget, per owner and per sensitivity scope, per owner-local day.
  if (state.askedToday >= state.budget.maxCardsPerDay) return decide('BATCH', 'DAILY_BUDGET_EXHAUSTED');
  if (state.askedInScopeToday >= state.budget.maxCardsPerSensitivityScopePerDay) return decide('BATCH', 'SCOPE_BUDGET_EXHAUSTED');

  // 6. Asked -- and when the only reason it could be asked again is new
  //    evidence, the log says so.
  return decide('ASK', (keptUncertain || recentlyAsked) && newEvidence ? 'REOPENED_BY_MATERIAL_NEW_EVIDENCE' : 'WITHIN_ATTENTION_BUDGET');
}
