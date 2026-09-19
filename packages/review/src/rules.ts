import { createHash } from 'node:crypto';
import {
  learnedApprovalRuleSchema, learnedRuleScopeSchema,
  type CardChoice, type LearnedApprovalRule, type LearnedRuleScope,
} from '@unai/domain';
import { canonicalJson, type MemoryTransaction } from '@unai/memory';
import { uuidV7 } from '../../../src/kernel/identities.js';
import type { RuleBasis } from './ambiguities.js';

/**
 * Learned approval rules (PRD §19.5; design entity `learned_approval_rules`,
 * GET /v1/approval-rules, POST .../{id}/approve and .../{id}/revoke; ADR 0028 §6).
 *
 * "Uai may propose an explicit policy after repeated confirmations ... The rule
 * becomes active only after explicit user approval and remains inspectable,
 * reversible, and scoped." Three things make that checkable:
 *
 *  - The inbox can only *propose* (migration 0023's insert policy admits nothing
 *    but PROPOSED, approved by nobody).
 *  - `approvedRuleFor` matches APPROVED rules and nothing else, so a proposal or a
 *    revoked rule cannot change a single interruption decision.
 *  - Approval and revocation are their own purpose, and the transition trigger
 *    refuses every move but PROPOSED -> APPROVED -> REVOKED.
 */

export const RULES_VERSION = 'learned-approval-rules-0.1.0';
/** How many owner answers of the same choice on matching cards make a proposal. */
export const REPEATED_CONFIRMATIONS_FOR_PROPOSAL = 2;

export class LearnedRuleError extends Error {
  constructor(code: string) { super(code); this.name = 'LearnedRuleError'; }
}

const sha256 = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');

/** The lookup index a card is matched on: situation kind, exact text, scope. */
export function cardRuleSignature(basis: RuleBasis, sensitivityScope: string): string {
  return sha256({ situationKind: basis.situationKind, matchText: basis.matchText, sensitivityScope });
}
/** The lookup index of one rule: what it matches plus what it does. */
export function ruleSignature(scope: LearnedRuleScope): string {
  return sha256(learnedRuleScopeSchema.parse(scope));
}

function ruleTextOf(scope: LearnedRuleScope): string {
  if (scope.situationKind === 'REPAYMENT' && scope.effect === 'CONFIRM') {
    return ('Always link transfers with the exact memo "' + scope.matchText + '" to the matching open obligation.').slice(0, 500);
  }
  if (scope.situationKind === 'REPAYMENT') {
    return ('Always treat transfers with the exact memo "' + scope.matchText + '" as not repaying the matching open obligation.').slice(0, 500);
  }
  return ('Always answer "' + scope.choiceId.replaceAll('_', ' ') + '" for "' + scope.matchText + '".').slice(0, 500);
}

function toRule(row: Record<string, unknown>, applications: ReadonlyArray<{ cardId: string; at: Date }>): LearnedApprovalRule {
  const iso = (value: unknown) => value instanceof Date ? value.toISOString() : null;
  const history = [
    { event: 'PROPOSED' as const, at: iso(row['proposed_at'])!, clarificationCardId: null },
    ...(row['approved_at'] ? [{ event: 'APPROVED' as const, at: iso(row['approved_at'])!, clarificationCardId: null }] : []),
    ...applications.map(application => ({ event: 'APPLIED' as const, at: application.at.toISOString(), clarificationCardId: application.cardId })),
    ...(row['revoked_at'] ? [{ event: 'REVOKED' as const, at: iso(row['revoked_at'])!, clarificationCardId: null }] : []),
  ].sort((left, right) => left.at.localeCompare(right.at));
  return learnedApprovalRuleSchema.parse({
    learnedApprovalRuleId: row['id'], ruleText: row['rule_text'], scope: row['scope'], status: row['status'],
    inEffect: row['status'] === 'APPROVED',
    proposedFromCardIds: row['proposed_from_card_ids'], proposedAt: iso(row['proposed_at']),
    approvedByUserId: (row['approved_by_user_id'] as string | null) ?? null,
    approvedAt: iso(row['approved_at']), revokedAt: iso(row['revoked_at']), history,
  });
}

const RULE_COLUMNS = 'id,rule_text,scope,status,proposed_from_card_ids,proposed_at,approved_by_user_id,approved_at,revoked_at';

async function applicationsOf(tx: MemoryTransaction, ownerScopeId: string, ruleIds: readonly string[]) {
  if (ruleIds.length === 0) return new Map<string, Array<{ cardId: string; at: Date }>>();
  const rows = (await tx.query(
    `SELECT id,applied_rule_id,answered_at FROM clarification_cards
     WHERE owner_scope_id=$1 AND applied_rule_id=ANY($2::uuid[]) AND answered_at IS NOT NULL ORDER BY answered_at,id`,
    [ownerScopeId, [...ruleIds]])).rows;
  const byRule = new Map<string, Array<{ cardId: string; at: Date }>>();
  for (const row of rows) {
    const ruleId = row['applied_rule_id'] as string;
    byRule.set(ruleId, [...(byRule.get(ruleId) ?? []), { cardId: row['id'] as string, at: row['answered_at'] as Date }]);
  }
  return byRule;
}

/** Every rule of the owner, newest first, each with its decision history. */
export async function listLearnedRules(tx: MemoryTransaction, input: { ownerScopeId: string }): Promise<LearnedApprovalRule[]> {
  const rows = (await tx.query(`SELECT ${RULE_COLUMNS} FROM learned_approval_rules WHERE owner_scope_id=$1
    ORDER BY proposed_at DESC,id DESC LIMIT 200`, [input.ownerScopeId])).rows;
  const applications = await applicationsOf(tx, input.ownerScopeId, rows.map(row => row['id'] as string));
  return rows.map(row => toRule(row, applications.get(row['id'] as string) ?? []));
}

export async function readLearnedRule(tx: MemoryTransaction, input: { ownerScopeId: string; ruleId: string }): Promise<LearnedApprovalRule> {
  const row = (await tx.query(`SELECT ${RULE_COLUMNS} FROM learned_approval_rules WHERE owner_scope_id=$1 AND id=$2`,
    [input.ownerScopeId, input.ruleId])).rows[0];
  if (!row) throw new LearnedRuleError('LEARNED_RULE_NOT_FOUND');
  const applications = await applicationsOf(tx, input.ownerScopeId, [input.ruleId]);
  return toRule(row, applications.get(input.ruleId) ?? []);
}

/** The owner's explicit approval. Only a PROPOSED rule can be approved, and the
 * approving actor is the session's own (migration 0023 policy). */
export async function approveLearnedRule(tx: MemoryTransaction, input: {
  ownerScopeId: string; ruleId: string; actorId: string; now: Date;
}): Promise<LearnedApprovalRule> {
  const current = await readLearnedRule(tx, input);
  if (current.status === 'APPROVED') return current;
  if (current.status !== 'PROPOSED') throw new LearnedRuleError('LEARNED_RULE_NOT_PROPOSED');
  await tx.query(`UPDATE learned_approval_rules SET status='APPROVED',approved_by_user_id=$3,approved_at=$4
    WHERE owner_scope_id=$1 AND id=$2 AND status='PROPOSED'`, [input.ownerScopeId, input.ruleId, input.actorId, input.now]);
  return readLearnedRule(tx, input);
}

/** Revocation ends every effect from the next evaluation on. Revoking a proposal
 * declines it; revoking twice is the same revocation. */
export async function revokeLearnedRule(tx: MemoryTransaction, input: {
  ownerScopeId: string; ruleId: string; now: Date;
}): Promise<LearnedApprovalRule> {
  const current = await readLearnedRule(tx, input);
  if (current.status === 'REVOKED') return current;
  await tx.query(`UPDATE learned_approval_rules SET status='REVOKED',revoked_at=$3
    WHERE owner_scope_id=$1 AND id=$2 AND status IN ('PROPOSED','APPROVED')`, [input.ownerScopeId, input.ruleId, input.now]);
  return readLearnedRule(tx, input);
}

/** The approved rule, if any, whose scope matches a card. A proposed or revoked
 * rule never matches: that is the whole of "no effect until approved" and "no
 * longer applies once revoked" (CRT-WRT-06-A). */
export async function approvedRuleFor(tx: MemoryTransaction, input: {
  ownerScopeId: string; basis: RuleBasis | null; sensitivityScope: string; choices: readonly CardChoice[];
}): Promise<{ ruleId: string; ruleText: string; choice: CardChoice } | null> {
  if (input.basis === null) return null;
  const rows = (await tx.query(
    `SELECT id,rule_text,scope FROM learned_approval_rules
     WHERE owner_scope_id=$1 AND status='APPROVED' AND scope->>'situationKind'=$2 AND scope->>'matchText'=$3
       AND scope->>'sensitivityScope'=$4
     ORDER BY approved_at DESC,id DESC`,
    [input.ownerScopeId, input.basis.situationKind, input.basis.matchText, input.sensitivityScope])).rows;
  for (const row of rows) {
    const scope = learnedRuleScopeSchema.parse(row['scope']);
    const choice = input.choices.find(candidate => candidate.choiceId === scope.choiceId && candidate.effect === scope.effect);
    if (choice) return { ruleId: row['id'] as string, ruleText: row['rule_text'] as string, choice };
  }
  return null;
}

/**
 * After an owner answer: propose a rule when the owner has now given the same
 * answer on at least two cards with the same match (§19.5 "after repeated
 * confirmations"). Keep-uncertain is not a decision and teaches nothing; a
 * rule-applied answer is the rule's, not new evidence of the owner's habit.
 */
export async function proposeRuleIfRepeated(tx: MemoryTransaction, input: {
  ownerScopeId: string; basis: RuleBasis | null; sensitivityScope: string; choice: CardChoice; now: Date;
}): Promise<LearnedApprovalRule | null> {
  if (input.basis === null || input.choice.effect === 'KEEP_UNCERTAIN') return null;
  const matchSignature = cardRuleSignature(input.basis, input.sensitivityScope);
  const cards = (await tx.query(
    `SELECT id FROM clarification_cards
     WHERE owner_scope_id=$1 AND rule_signature=$2 AND answer IS NOT NULL
       AND answer->>'answeredBy'='OWNER' AND answer->>'choiceId'=$3 AND answer->>'effect'=$4
     ORDER BY answered_at,id LIMIT 64`,
    [input.ownerScopeId, matchSignature, input.choice.choiceId, input.choice.effect])).rows.map(row => row['id'] as string);
  if (cards.length < REPEATED_CONFIRMATIONS_FOR_PROPOSAL) return null;
  const scope = learnedRuleScopeSchema.parse({
    situationKind: input.basis.situationKind, matchText: input.basis.matchText, choiceId: input.choice.choiceId,
    effect: input.choice.effect, sensitivityScope: input.sensitivityScope,
  });
  const signature = ruleSignature(scope);
  const live = (await tx.query(`SELECT id FROM learned_approval_rules WHERE owner_scope_id=$1 AND rule_signature=$2
    AND status<>'REVOKED'`, [input.ownerScopeId, signature])).rows[0];
  if (live) return null;
  // A revoked rule is never proposed again from the answers it was built on:
  // only answers given after the revocation count towards a new proposal.
  const revoked = (await tx.query(`SELECT max(revoked_at) AS revoked_at FROM learned_approval_rules
    WHERE owner_scope_id=$1 AND rule_signature=$2 AND status='REVOKED'`, [input.ownerScopeId, signature])).rows[0]?.['revoked_at'] as Date | null;
  const eligible = revoked ? (await tx.query(`SELECT id FROM clarification_cards WHERE owner_scope_id=$1 AND id=ANY($2::uuid[])
    AND answered_at>$3 ORDER BY answered_at,id`, [input.ownerScopeId, cards, revoked])).rows.map(row => row['id'] as string) : cards;
  if (eligible.length < REPEATED_CONFIRMATIONS_FOR_PROPOSAL) return null;
  const id = uuidV7();
  await tx.query(
    `INSERT INTO learned_approval_rules(id,owner_scope_id,rule_text,scope,rule_signature,status,proposed_from_card_ids,proposed_at)
     VALUES($1,$2,$3,$4,$5,'PROPOSED',$6,$7)`,
    [id, input.ownerScopeId, ruleTextOf(scope), JSON.stringify(scope), signature, eligible, input.now]);
  return readLearnedRule(tx, { ownerScopeId: input.ownerScopeId, ruleId: id });
}
