import { randomUUID } from 'node:crypto';
import {
  ACTION_STAGE_LABELS, actionHistoryEntrySchema, publicDraftSchema, publicRecommendationSchema,
  type ActionBasis, type ActionHistoryEntry, type ActionKind, type ActionStage, type ExternalActionKind,
  type PublicDraft, type PublicRecommendation,
} from '@unai/domain';
import { createLocalPolicyAdapters, recordPolicyDecision, type PolicyPorts } from '@unai/belief';
import { CONTEXT_ACTION_PURPOSE, ContextBrokerError, readContextPacket, type ContextRunner } from '@unai/context';
import { ControlError, iso, requirePurpose, type ControlTransaction } from './transaction.js';
import { capabilityForAction } from './catalog.js';

/**
 * Governed action (PRD §8.4, §27.5, §29.3, §60; CRT-AI-04-A, CRT-CON-08-A,
 * CRT-SEC-11-A, CRT-UX-13-A).
 *
 * The flow PRD §8.4 draws is Recommendation → Draft → Explicit approval →
 * Validated execution → External receipt → Memory update. V0 stops after
 * approval: execution is refused by `EvaluateMemoryAction`, and the only thing
 * that can say an action *happened* is an authoritative receipt, ingested as
 * evidence. So nothing in this file writes an EXECUTED entry except
 * `recordReceiptEntry`, and that needs the receipt's evidence row.
 */

export const ACTION_READ_PURPOSE = 'action.read';
export const ACTION_DRAFT_PURPOSE = 'action.draft';
export const ACTION_EXECUTE_PURPOSE = 'action.execute';
export const ACTION_RECOMMEND_PURPOSE = 'action.recommend';
export const ACTION_RECEIPT_PURPOSE = 'action.receipt';
/** The port's own action purpose: the one `policy_decisions` admits for actions. */
export const ACTION_POLICY_PURPOSE = CONTEXT_ACTION_PURPOSE;
/** The source type of an authoritative external tool receipt. */
export const TOOL_RECEIPT_SOURCE_TYPE = 'TOOL_RECEIPT';

// ---------------------------------------------------------------------------
// The action history

function entryOf(row: Record<string, any>): ActionHistoryEntry {
  const stage = row['stage'] as ActionStage;
  return actionHistoryEntrySchema.parse({
    entryId: row['id'], stage, label: ACTION_STAGE_LABELS[stage], actionKind: row['action_kind'],
    subject: { objectType: row['subject_object_type'], objectId: row['subject_object_id'] },
    recommendationId: row['recommendation_id'] ?? null, policyDecisionId: row['policy_decision_id'] ?? null,
    receiptEvidenceId: row['receipt_evidence_id'] ?? null, createdAt: iso(row['created_at']),
  });
}

/** Append one entry. The table is append-only and its checks are the rules: a
 * draft only DRAFTED or REQUESTED_APPROVAL, execution only with a receipt. */
export async function appendActionHistory(tx: ControlTransaction, input: {
  stage: ActionStage; actionKind: ActionKind; subject: { objectType: 'recommendation' | 'draft' | 'evidence'; objectId: string };
  recommendationId?: string | null; policyDecisionId?: string | null; receiptEvidenceId?: string | null;
}): Promise<ActionHistoryEntry> {
  const row = (await tx.query(
    `INSERT INTO action_history(id,owner_scope_id,stage,action_kind,subject_object_type,subject_object_id,
       recommendation_id,policy_decision_id,receipt_evidence_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [randomUUID(), tx.context.ownerScopeId, input.stage, input.actionKind, input.subject.objectType,
      input.subject.objectId, input.recommendationId ?? null, input.policyDecisionId ?? null,
      input.receiptEvidenceId ?? null])).rows[0];
  if (!row) throw new ControlError('ACTION_HISTORY_NOT_RECORDED');
  return entryOf(row);
}

export async function listActionHistory(tx: ControlTransaction, limit = 200): Promise<ActionHistoryEntry[]> {
  return (await tx.query(
    'SELECT * FROM action_history WHERE owner_scope_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2',
    [tx.context.ownerScopeId, Math.min(Math.max(limit, 1), 500)])).rows.map(entryOf);
}

// ---------------------------------------------------------------------------
// The memory an action rests on

export interface BasisVerdict {
  readonly outcome: 'ALLOW' | 'REQUIRE_CONFIRMATION' | 'DENY';
  readonly reason: string;
  readonly policyDecisionId: string | null;
  readonly packetId: string | null;
  readonly evidenceIds: readonly string[];
  readonly supportingAssessment: 'ACCEPTED' | 'PROVISIONAL' | 'CONTESTED' | 'NONE';
  readonly projectionComplete: boolean;
}

/**
 * Ask the Context Broker for the memory an action would rest on, declaring the
 * action, and answer `EvaluateMemoryAction`'s recorded verdict.
 *
 * The broker is the only memory read path (FR-060), and it already evaluates a
 * declared action against the evidence behind *this* packet and records the
 * verdict in its own transaction, so a refusal is kept even though no packet is
 * issued (ADR 0022 §10). The action declared is a DRAFT: preparing is the one
 * step V0 can take, so "may Uai prepare this?" is the question whether the
 * caller is a draft or a recommendation to prepare. A HIGH-risk action on memory
 * that is only PROVISIONAL, CONTESTED or from an incomplete projection is denied
 * by the port, and a lower-risk one requires confirmation (CRT-SEC-11-A).
 */
export async function evaluateActionBasis(runner: ContextRunner, input: {
  ownerScopeId: string; actorId: string; purpose: string; basis: ActionBasis;
  maximumSensitivity: 'NORMAL' | 'PRIVATE' | 'RESTRICTED'; actionRisk: 'LOW' | 'MEDIUM' | 'HIGH'; capabilityGranted: boolean;
}, options: { ports?: PolicyPorts; correlationId: string; registryReleaseId?: string | null; registryRelease?: string | null }):
  Promise<BasisVerdict> {
  try {
    const packet = await readContextPacket(runner, {
      ownerScopeId: input.ownerScopeId, requestingActorId: input.actorId, purpose: input.purpose,
      query: input.basis.query, entityHints: input.basis.entityHints, frameTypeHints: input.basis.frameTypeHints,
      worldTime: 'NOW', knowledgeTime: 'LATEST', maximumSensitivity: input.maximumSensitivity,
      actionRisk: input.actionRisk,
      intendedAction: { actionKind: 'DRAFT', actionPurpose: input.purpose, capabilityGranted: input.capabilityGranted },
    }, {
      ...(options.ports ? { ports: options.ports } : {}), correlationId: options.correlationId,
      registryReleaseId: options.registryReleaseId ?? null, registryRelease: options.registryRelease ?? null,
    });
    const decision = packet.actionDecision;
    if (!decision) throw new ControlError('ACTION_DECISION_MISSING');
    const supportingAssessment = packet.conflicts.length > 0 ? 'CONTESTED' as const
      : packet.currentBeliefs.some(belief => belief.certainty === 'ACCEPTED') ? 'ACCEPTED' as const
        : packet.currentBeliefs.length > 0 ? 'PROVISIONAL' as const : 'NONE' as const;
    return {
      outcome: decision.outcome, reason: decision.reason, policyDecisionId: decision.policyDecisionId,
      packetId: packet.packetId,
      // A belief's evidence ids may have been redacted from it; only what the
      // packet actually carries is named.
      evidenceIds: [...new Set([...packet.evidenceRefs.map(ref => ref.evidenceId),
        ...packet.currentBeliefs.flatMap(belief => belief.evidenceIds ?? [])])].sort(),
      supportingAssessment, projectionComplete: packet.projectionFragments.every(fragment => fragment.isComplete),
    };
  } catch (error) {
    if (error instanceof ContextBrokerError && (error.message === 'CONTEXT_ACTION_DENIED' || error.message === 'CONTEXT_READ_DENIED')) {
      return {
        outcome: 'DENY', reason: String(error.detail['reason'] ?? error.message),
        policyDecisionId: (error.detail['policyDecisionId'] as string | undefined) ?? null, packetId: null,
        evidenceIds: [], supportingAssessment: 'NONE', projectionComplete: false,
      };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// External actions

/** The port's vocabulary for an external action kind. */
function portActionKind(kind: ExternalActionKind): 'EMAIL_SEND' | 'CALENDAR_WRITE' | 'MONEY_MOVEMENT' | 'TRADE' {
  return kind === 'CALENDAR_CREATE' || kind === 'CALENDAR_UPDATE' ? 'CALENDAR_WRITE' : kind;
}

/**
 * Put one external action to `EvaluateMemoryAction` and record the verdict.
 *
 * Runs under the port's own purpose (`memory.act`), which is the one purpose
 * `policy_decisions` admits for an action. In V0 the local adapter refuses every
 * non-draft kind before support is even considered, so there is no memory good
 * enough to turn this into an execution (CRT-CON-08-A). A deployment that
 * installs other ports is still asked, and still recorded.
 */
export async function evaluateExternalAction(tx: ControlTransaction, input: {
  actionKind: ExternalActionKind; purpose: string; actionRisk: 'LOW' | 'MEDIUM' | 'HIGH';
  subjectRef: { objectType: string; objectId: string } | null;
}, ports: PolicyPorts = createLocalPolicyAdapters()) {
  requirePurpose(tx, ACTION_POLICY_PURPOSE);
  const capability = capabilityForAction(input.actionKind);
  // A WRITE capability can never be granted (migration 0024), so the port is
  // told the truth: this action has no capability behind it.
  const request = {
    actorId: tx.context.actorId, ownerScopeId: tx.context.ownerScopeId, purpose: ACTION_POLICY_PURPOSE,
    sensitivity: 'PRIVATE' as const, risk: input.actionRisk, evidenceRefs: [],
    allowedPurposes: [ACTION_POLICY_PURPOSE], actionKind: portActionKind(input.actionKind), capabilityGranted: false,
    supportingAssessment: 'NONE' as const, projectionComplete: false,
  };
  const verdict = await ports.evaluateMemoryAction(request);
  const policyDecisionId = await recordPolicyDecision(tx, {
    ownerScopeId: tx.context.ownerScopeId, correlationId: tx.context.correlationId, port: 'EvaluateMemoryAction',
    request: {
      actionKind: input.actionKind, portActionKind: request.actionKind, actionPurpose: input.purpose,
      actionRisk: input.actionRisk, capabilityId: capability?.capabilityId ?? null, capabilityGranted: false,
      subjectObjectType: input.subjectRef?.objectType ?? null, subjectObjectId: input.subjectRef?.objectId ?? null,
    },
    verdict,
  });
  return { outcome: verdict.outcome, reason: verdict.reason, policyDecisionId, capabilityId: capability?.capabilityId ?? null };
}

// ---------------------------------------------------------------------------
// Drafts

function draftOf(row: Record<string, any>): PublicDraft {
  return publicDraftSchema.parse({
    draftId: row['id'], draftKind: row['draft_kind'], capabilityId: row['capability_id'], content: row['content'],
    status: row['status'], recordedAs: 'DRAFT_ARTIFACT', recommendationId: row['recommendation_id'] ?? null,
    supportingPacketId: row['supporting_packet_id'], policyDecisionId: row['policy_decision_id'],
    createdAt: iso(row['created_at']), updatedAt: iso(row['updated_at']),
  });
}

/** Store a draft the port allowed, and its DRAFTED history entry. The caller has
 * already checked the grant and received ALLOW; the row names that decision. */
export async function insertDraft(tx: ControlTransaction, input: {
  draftKind: string; capabilityId: string; content: Record<string, unknown>; recommendationId: string | null;
  supportingPacketId: string; policyDecisionId: string;
}): Promise<{ draft: PublicDraft; entry: ActionHistoryEntry }> {
  requirePurpose(tx, ACTION_DRAFT_PURPOSE);
  const row = (await tx.query(
    `INSERT INTO drafts(id,owner_scope_id,draft_kind,capability_id,content,recommendation_id,supporting_packet_id,
       policy_decision_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [randomUUID(), tx.context.ownerScopeId, input.draftKind, input.capabilityId, JSON.stringify(input.content),
      input.recommendationId, input.supportingPacketId, input.policyDecisionId])).rows[0];
  if (!row) throw new ControlError('DRAFT_NOT_STORED');
  const draft = draftOf(row);
  const entry = await appendActionHistory(tx, {
    stage: 'DRAFTED', actionKind: 'DRAFT', subject: { objectType: 'draft', objectId: draft.draftId },
    recommendationId: input.recommendationId, policyDecisionId: input.policyDecisionId,
  });
  return { draft, entry };
}

export async function listDrafts(tx: ControlTransaction): Promise<PublicDraft[]> {
  return (await tx.query('SELECT * FROM drafts WHERE owner_scope_id=$1 ORDER BY created_at DESC,id LIMIT 200',
    [tx.context.ownerScopeId])).rows.map(draftOf);
}

export async function readDraft(tx: ControlTransaction, draftId: string): Promise<PublicDraft> {
  const row = (await tx.query('SELECT * FROM drafts WHERE owner_scope_id=$1 AND id=$2', [tx.context.ownerScopeId, draftId])).rows[0];
  if (!row) throw new ControlError('DRAFT_NOT_FOUND', { draftId });
  return draftOf(row);
}

/**
 * The owner's decision on a draft. Asking for approval appends a
 * REQUESTED_APPROVAL entry; approving records the approval and nothing more --
 * there is no executed state for a draft to move to, and no provider call.
 */
export async function decideDraft(tx: ControlTransaction, draftId: string, decision: 'REQUEST_APPROVAL' | 'APPROVE' | 'DISCARD'):
  Promise<{ draft: PublicDraft; entry: ActionHistoryEntry | null }> {
  requirePurpose(tx, ACTION_DRAFT_PURPOSE);
  const current = await readDraft(tx, draftId);
  const next = decision === 'REQUEST_APPROVAL' ? 'AWAITING_APPROVAL' : decision === 'APPROVE' ? 'APPROVED' : 'DISCARDED';
  const allowed = (current.status === 'CREATED' && (next === 'AWAITING_APPROVAL' || next === 'DISCARDED'))
    || (current.status === 'AWAITING_APPROVAL' && (next === 'APPROVED' || next === 'DISCARDED'));
  if (!allowed) throw new ControlError('DRAFT_TRANSITION_REFUSED', { draftId, from: current.status, to: next });
  const row = (await tx.query('UPDATE drafts SET status=$3,updated_at=now() WHERE owner_scope_id=$1 AND id=$2 RETURNING *',
    [tx.context.ownerScopeId, draftId, next])).rows[0];
  if (!row) throw new ControlError('DRAFT_NOT_FOUND', { draftId });
  const entry = next === 'AWAITING_APPROVAL' ? await appendActionHistory(tx, {
    stage: 'REQUESTED_APPROVAL', actionKind: 'DRAFT', subject: { objectType: 'draft', objectId: draftId },
    recommendationId: current.recommendationId, policyDecisionId: current.policyDecisionId,
  }) : null;
  return { draft: draftOf(row), entry };
}

// ---------------------------------------------------------------------------
// Recommendations

async function recommendationOf(tx: ControlTransaction, row: Record<string, any>): Promise<PublicRecommendation> {
  const receipted = (await tx.query(
    `SELECT 1 FROM action_history WHERE owner_scope_id=$1 AND recommendation_id=$2 AND stage IN ('EXECUTED','RECEIVED_CONFIRMATION')
     LIMIT 1`, [tx.context.ownerScopeId, row['id']])).rowCount === 1;
  return publicRecommendationSchema.parse({
    recommendationId: row['id'], semantics: row['semantics'], recommendationText: row['recommendation_text'],
    recommendedActionKind: row['recommended_action_kind'], actionRisk: row['action_risk'],
    recommendedPropositionId: row['recommended_proposition_id'] ?? null,
    supportingPacketId: row['supporting_packet_id'] ?? null, supportingEvidenceIds: row['supporting_evidence_ids'] ?? [],
    supportingAssessment: row['supporting_assessment'], projectionComplete: row['projection_complete'],
    status: row['status'], blockedReason: row['blocked_reason'] ?? null, requiresConfirmation: row['requires_confirmation'],
    policyDecisionId: row['policy_decision_id'] ?? null, userResponse: row['user_response'],
    responseEvidenceId: row['response_evidence_id'] ?? null, respondedAt: iso(row['responded_at']),
    executionReceipted: receipted, createdAt: iso(row['created_at']),
  });
}

/**
 * Store a recommendation with RECOMMENDED semantics (PRD §24.2, §60).
 *
 * It is neither a claim nor user intent. A recommendation whose memory the port
 * refused is stored BLOCKED with the decision behind it, so the Recommendation
 * detail screen can say why it was withheld; only an ACTIVE one is SUGGESTED.
 */
export async function insertRecommendation(tx: ControlTransaction, input: {
  recommendationText: string; recommendedActionKind: ActionKind; actionRisk: string;
  recommendedPropositionId: string | null; verdict: BasisVerdict;
}): Promise<{ recommendation: PublicRecommendation; entry: ActionHistoryEntry | null }> {
  requirePurpose(tx, ACTION_RECOMMEND_PURPOSE);
  const blocked = input.verdict.outcome === 'DENY';
  const row = (await tx.query(
    `INSERT INTO recommendation_artifacts(id,owner_scope_id,recommendation_text,recommended_action_kind,action_risk,
       recommended_proposition_id,supporting_packet_id,supporting_evidence_ids,supporting_assessment,projection_complete,
       status,requires_confirmation,policy_decision_id,blocked_reason)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [randomUUID(), tx.context.ownerScopeId, input.recommendationText, input.recommendedActionKind, input.actionRisk,
      input.recommendedPropositionId, input.verdict.packetId, [...input.verdict.evidenceIds],
      input.verdict.supportingAssessment, input.verdict.projectionComplete, blocked ? 'BLOCKED' : 'ACTIVE',
      input.verdict.outcome === 'REQUIRE_CONFIRMATION', input.verdict.policyDecisionId,
      blocked ? input.verdict.reason : null])).rows[0];
  if (!row) throw new ControlError('RECOMMENDATION_NOT_STORED');
  const recommendation = await recommendationOf(tx, row);
  const entry = blocked ? null : await appendActionHistory(tx, {
    stage: 'SUGGESTED', actionKind: input.recommendedActionKind,
    subject: { objectType: 'recommendation', objectId: recommendation.recommendationId },
    recommendationId: recommendation.recommendationId, policyDecisionId: input.verdict.policyDecisionId,
  });
  return { recommendation, entry };
}

export async function readRecommendation(tx: ControlTransaction, recommendationId: string): Promise<PublicRecommendation> {
  const row = (await tx.query('SELECT * FROM recommendation_artifacts WHERE owner_scope_id=$1 AND id=$2',
    [tx.context.ownerScopeId, recommendationId])).rows[0];
  if (!row) throw new ControlError('RECOMMENDATION_NOT_FOUND', { recommendationId });
  return recommendationOf(tx, row);
}

export async function listRecommendations(tx: ControlTransaction): Promise<PublicRecommendation[]> {
  const rows = (await tx.query(
    'SELECT * FROM recommendation_artifacts WHERE owner_scope_id=$1 ORDER BY created_at DESC,id LIMIT 200',
    [tx.context.ownerScopeId])).rows;
  const out: PublicRecommendation[] = [];
  for (const row of rows) out.push(await recommendationOf(tx, row));
  return out;
}

/**
 * Record the owner's answer to a recommendation.
 *
 * "Yes, prepare the order, but do not submit it" is ACCEPTED_AS_INTENT_TO_PREPARE
 * with the owner's words already stored as evidence: intent to prepare, and
 * nothing else. It appends no EXECUTED entry, writes no claim and asserts no
 * executed-order fact (PRD §60, CRT-AI-04-A).
 */
export async function respondToRecommendation(tx: ControlTransaction, recommendationId: string, input: {
  response: 'ACCEPTED_AS_INTENT_TO_PREPARE' | 'DISMISSED' | 'SNOOZED'; responseEvidenceId: string | null;
}): Promise<PublicRecommendation> {
  requirePurpose(tx, ACTION_RECOMMEND_PURPOSE);
  const current = await readRecommendation(tx, recommendationId);
  if (current.status === 'BLOCKED' && input.response !== 'DISMISSED') {
    throw new ControlError('RECOMMENDATION_BLOCKED', { recommendationId, reason: current.blockedReason });
  }
  if (current.userResponse !== 'NONE' && current.userResponse !== 'SNOOZED') {
    throw new ControlError('RECOMMENDATION_ALREADY_ANSWERED', { recommendationId, userResponse: current.userResponse });
  }
  await tx.query(
    `UPDATE recommendation_artifacts SET user_response=$3,response_evidence_id=$4,responded_at=now()
     WHERE owner_scope_id=$1 AND id=$2`,
    [tx.context.ownerScopeId, recommendationId, input.response, input.responseEvidenceId]);
  return readRecommendation(tx, recommendationId);
}

// ---------------------------------------------------------------------------
// Receipts and observations

/**
 * Append the execution fact an authoritative receipt establishes. The receipt is
 * already stored as TOOL_RECEIPT evidence; the table refuses any other item.
 */
export async function recordReceiptEntry(tx: ControlTransaction, input: {
  stage: 'EXECUTED' | 'RECEIVED_CONFIRMATION'; actionKind: ExternalActionKind; receiptEvidenceId: string;
  recommendationId: string | null;
}): Promise<ActionHistoryEntry> {
  requirePurpose(tx, ACTION_RECEIPT_PURPOSE);
  if (input.recommendationId !== null) await readRecommendationRow(tx, input.recommendationId);
  return appendActionHistory(tx, {
    stage: input.stage, actionKind: input.actionKind, subject: { objectType: 'evidence', objectId: input.receiptEvidenceId },
    recommendationId: input.recommendationId, receiptEvidenceId: input.receiptEvidenceId,
  });
}

async function readRecommendationRow(tx: ControlTransaction, recommendationId: string): Promise<void> {
  const found = await tx.query('SELECT 1 FROM recommendation_artifacts WHERE owner_scope_id=$1 AND id=$2',
    [tx.context.ownerScopeId, recommendationId]);
  if (found.rowCount !== 1) throw new ControlError('RECOMMENDATION_NOT_FOUND', { recommendationId });
}

/** An action Uai saw in a source -- the owner's own sent mail, say -- recorded as
 * OBSERVED against the evidence that shows it. */
export async function recordObservedAction(tx: ControlTransaction, input: { evidenceId: string; actionKind: ActionKind }):
  Promise<ActionHistoryEntry> {
  requirePurpose(tx, ACTION_RECEIPT_PURPOSE);
  return appendActionHistory(tx, {
    stage: 'OBSERVED', actionKind: input.actionKind, subject: { objectType: 'evidence', objectId: input.evidenceId },
  });
}
