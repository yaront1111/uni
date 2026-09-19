import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { runMigrations } from '@unai/postgres';
import { postgresAdapter, SESSION_COOKIE } from '@unai/auth';
import {
  cardDecisionResultSchema, learnedApprovalRuleSchema, learnedApprovalRulesViewSchema, memoryInboxViewSchema,
  attentionBudgetSchema, type ClarificationCard, type MemoryInboxView,
} from '@unai/domain';
import { uuidV7 } from '../../../src/kernel/identities.js';
import { createPlatformApi } from './platform.js';
import type { EvidenceObjects } from './evidence.js';

/**
 * The Memory inbox, the attention budget and learned approval rules over the
 * real boundary: TLS, session, owner scope, purpose, the Context Broker read
 * under `memory.read`, the evaluation under `memory.inbox`, and an answer written
 * through the correction path under `memory.correct` -- all as the low-privilege
 * application role, so migration 0023's policies are part of what is exercised.
 *
 * The clock the inbox reads is the test's, so a day can pass between two reads;
 * it always runs ahead of the fixtures' recorded time, which the broker's
 * knowledge-time filter requires.
 *
 * Covers CRT-WRT-05-A, CRT-WRT-05-B, CRT-UX-08-A and CRT-WRT-06-A.
 */

if (!process.env.UNAI_TEST_DATABASE_URL) throw new Error('Run pnpm test for the required PostgreSQL harness');
const admin = new Pool({ connectionString: process.env.UNAI_TEST_DATABASE_URL });
const url = new URL(process.env.UNAI_TEST_DATABASE_URL); url.username = 'inbox_test_app'; url.password = 'test-only';
const appPool = new Pool({ connectionString: url.href });

const registryReleaseId = randomUUID();
const DAY = 86_400_000;
const START = new Date(Math.ceil((Date.now() + DAY) / DAY) * DAY + 9 * 3_600_000);
let clockNow = START;
const at = (days: number) => { clockNow = new Date(START.getTime() + days * DAY); };

const stored = new Map<string, Uint8Array>();
const evidenceObjects: EvidenceObjects = {
  encryptionKeyRef: 'kms:test-double',
  async put(_tx, key, bytes) { stored.set(key, bytes); },
  async get(_tx, key) { return stored.get(key)!; },
};

interface Owner { owner: string; userId: string; token: string; contextSpaceId: string; transactionId: string }

beforeAll(async () => {
  await runMigrations(admin, resolve('migrations'));
  await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='inbox_test_app') THEN CREATE ROLE inbox_test_app LOGIN PASSWORD 'test-only'; END IF; END $$; GRANT unai_app TO inbox_test_app");
});
afterAll(async () => { await appPool.end(); await admin.end(); });

async function makeOwner(name: string): Promise<Owner> {
  const adapter = postgresAdapter(admin);
  const user = await adapter.createUser!({ name, email: name.toLowerCase().replaceAll(' ', '.') + '.' + randomUUID().slice(0, 8) + '@example.test', emailVerified: null });
  const owner = (user as unknown as { ownerScopeId: string }).ownerScopeId;
  const token = randomBytes(32).toString('base64url');
  await adapter.createSession!({ userId: user.id, sessionToken: token, expires: new Date(Date.now() + 604800000) });
  const contextSpaceId = (await admin.query("SELECT id FROM context_spaces WHERE owner_scope_id=$1 AND context_kind='BASE'", [owner])).rows[0].id;
  const transactionId = randomUUID();
  await admin.query(`INSERT INTO belief_transactions(id,owner_scope_id,transaction_kind,requested_by_actor_id,
    registry_release_id,status,risk,idempotency_key,commit_receipt,committed_at) VALUES($1,$2,'CANONICALIZE',$3,$4,'COMMITTED','LOW',$5,'{}',now())`,
    [transactionId, owner, user.id, registryReleaseId, randomUUID().replaceAll('-', '')]);
  return { owner, userId: user.id, token, contextSpaceId, transactionId };
}

async function evidence(o: Owner, purposes: string[], sensitivity = 'PRIVATE'): Promise<{ evidenceId: string; anchorId: string }> {
  const evidenceId = randomUUID(), anchorId = randomUUID(), connectorId = randomUUID();
  await admin.query("INSERT INTO connectors(id,owner_scope_id,connector_type,external_account_ref,permission_manifest,status) VALUES($1,$2,'CONVERSATION',$3,'{}','ACTIVE')",
    [connectorId, o.owner, randomUUID()]);
  await admin.query(`INSERT INTO source_items(id,owner_scope_id,connector_id,source_type,external_id,actor_ref,submitted_by_user_id,
    raw_object_ref,content_hash,sensitivity,allowed_purposes,ingestion_version,idempotency_key)
    VALUES($1,$2,$3,'CONVERSATION',$4,$5,$6,$7,$8,$9,$10,'evidence-json-v1',$11)`,
    [evidenceId, o.owner, connectorId, 'item-' + randomUUID(), JSON.stringify({ type: 'USER', id: o.userId }), o.userId, randomUUID(),
      randomBytes(32).toString('hex'), sensitivity, purposes, randomUUID()]);
  await admin.query(`INSERT INTO source_anchors(id,owner_scope_id,source_item_id,anchor_kind,anchor) VALUES($1,$2,$3,'MESSAGE_SPAN','{"start":0,"end":20}')`,
    [anchorId, o.owner, evidenceId]);
  return { evidenceId, anchorId };
}

async function frame(o: Owner, frameTypeId: string): Promise<string> {
  const id = uuidV7();
  await admin.query('INSERT INTO frame_instances(id,owner_scope_id,frame_type_id,context_space_id) VALUES($1,$2,$3,$4)',
    [id, o.owner, frameTypeId, o.contextSpaceId]);
  return id;
}

/** One value in its own slot, stated by a claim anchored in `anchorId`, with the
 * assessment the admission engine would have recorded. */
async function stated(o: Owner, frameInstanceId: string, predicateId: string, value: unknown, input: {
  anchorId: string; assessment: 'ACCEPTED' | 'CANDIDATE'; modality?: string;
}): Promise<{ propositionId: string; slotId: string }> {
  const slotId = uuidV7(), propositionId = uuidV7();
  await admin.query(`INSERT INTO belief_slots(id,owner_scope_id,frame_instance_id,predicate_id,context_space_id,modality)
    VALUES($1,$2,$3,$4,$5,$6)`, [slotId, o.owner, frameInstanceId, predicateId, o.contextSpaceId, input.modality ?? 'ACTUAL']);
  await admin.query('INSERT INTO propositions(id,owner_scope_id,belief_slot_id,normalized_value) VALUES($1,$2,$3,$4)',
    [propositionId, o.owner, slotId, JSON.stringify(value)]);
  await claim(o, propositionId, input.anchorId);
  await admin.query(`INSERT INTO belief_assessments(id,owner_scope_id,proposition_id,assessment_status,policy_version,transaction_id,
    decision_reason) VALUES($1,$2,$3,$4,'local-policy-0.1.0',$5,'{"code":"FIXTURE"}')`,
    [randomUUID(), o.owner, propositionId, input.assessment, o.transactionId]);
  return { propositionId, slotId };
}
async function claim(o: Owner, propositionId: string, anchorId: string): Promise<void> {
  await admin.query(`INSERT INTO claims(id,owner_scope_id,source_anchor_id,proposition_id,claim_origin,lifecycle)
    VALUES($1,$2,$3,$4,'USER_STATEMENT','PROVISIONAL')`, [uuidV7(), o.owner, anchorId, propositionId]);
}

/** A qualifying ambiguity in a situation of its own: a candidate value the
 * admission engine queued for batch review. An obligation is a finance question;
 * a commitment falls in the life category its evidence admits. */
async function ambiguity(o: Owner, kind: 'FINANCE' | 'FAMILY' | 'WORK' | 'HEALTH'): Promise<{ frameInstanceId: string; propositionId: string }> {
  const purpose = { FINANCE: 'PERSONAL_FINANCE', FAMILY: 'FAMILY_COORDINATION', WORK: 'WORK_ASSISTANCE', HEALTH: 'HEALTH_ADMINISTRATION' }[kind];
  const source = await evidence(o, ['PERSONAL_ASSISTANCE', purpose]);
  const frameInstanceId = await frame(o, kind === 'FINANCE' ? 'shared.obligation' : 'shared.commitment');
  const { propositionId } = kind === 'FINANCE'
    ? await stated(o, frameInstanceId, 'shared.obligation.principal_amount', { amount: '40.00', currency: 'ILS' }, { anchorId: source.anchorId, assessment: 'CANDIDATE' })
    : await stated(o, frameInstanceId, 'shared.commitment.created_at', { time: '2026-03-01T10:00:00.000Z' }, { anchorId: source.anchorId, assessment: 'CANDIDATE' });
  return { frameInstanceId, propositionId };
}
async function tenAmbiguities(o: Owner): Promise<void> {
  for (const kind of ['FINANCE', 'FINANCE', 'FINANCE', 'FINANCE', 'FAMILY', 'FAMILY', 'WORK', 'WORK', 'HEALTH', 'HEALTH'] as const) {
    await ambiguity(o, kind);
  }
}

/** The §37.4 situation, in one memory thread: an owner-reported obligation of
 * ₪50 to Daniel, a ₪60 transfer with the memo "Daniel dinner" to a Daniel-like
 * counterparty that is not confirmed as him, and its unconfirmed allocation. */
async function danielRepayment(o: Owner): Promise<{ allocationProposition: string; participantProposition: string; threadId: string }> {
  const source = await evidence(o, ['PERSONAL_ASSISTANCE', 'PERSONAL_FINANCE']);
  const transferEvidence = await evidence(o, ['PERSONAL_ASSISTANCE', 'PERSONAL_FINANCE']);
  const obligation = await frame(o, 'shared.obligation');
  await stated(o, obligation, 'shared.obligation.principal_amount', { amount: '50.00', currency: 'ILS' }, { anchorId: source.anchorId, assessment: 'ACCEPTED' });
  const transfer = await frame(o, 'shared.event_occurrence');
  await stated(o, transfer, 'shared.event_occurrence.description', { text: 'Daniel dinner' }, { anchorId: transferEvidence.anchorId, assessment: 'ACCEPTED' });
  const lookalike = uuidV7();
  await admin.query("INSERT INTO entities(id,owner_scope_id,entity_kind,canonical_label) VALUES($1,$2,'PERSON','Daniel K.')", [lookalike, o.owner]);
  const participant = await stated(o, transfer, 'shared.event_occurrence.participants', { entityId: lookalike },
    { anchorId: transferEvidence.anchorId, assessment: 'CANDIDATE' });
  const allocation = await frame(o, 'finance.payment_allocation');
  await admin.query(`INSERT INTO frame_instance_roles(id,owner_scope_id,frame_instance_id,role_id,typed_value) VALUES($1,$2,$3,'obligation',$4)`,
    [randomUUID(), o.owner, allocation, JSON.stringify({ frameInstanceId: obligation })]);
  const allocated = await stated(o, allocation, 'finance.payment_allocation.allocated_amount', { amount: '60.00', currency: 'ILS' },
    { anchorId: transferEvidence.anchorId, assessment: 'CANDIDATE' });
  const threadId = uuidV7();
  await admin.query("INSERT INTO memory_threads(id,owner_scope_id,display_title) VALUES($1,$2,'Daniel')", [threadId, o.owner]);
  for (const member of [obligation, transfer, allocation]) {
    await admin.query(`INSERT INTO memory_thread_members(owner_scope_id,memory_thread_id,object_type,object_id,membership_kind)
      VALUES($1,$2,'frame_instance',$3,'RELATED')`, [o.owner, threadId, member]);
  }
  return { allocationProposition: allocated.propositionId, participantProposition: participant.propositionId, threadId };
}

function api() {
  const app = createPlatformApi({ authPool: admin, appPool, evidenceObjects, registryReleaseId, registryRelease: '0.1.0', clock: () => clockNow });
  app.addHook('onRequest', async request => { Object.defineProperty(request.raw.socket, 'encrypted', { value: true }); });
  return app;
}
function headers(o: Owner, purpose: string, extra: Record<string, string> = {}) {
  return {
    cookie: SESSION_COOKIE + '=' + o.token, 'x-owner-scope-id': o.owner, 'x-purpose': purpose, 'x-correlation-id': randomUUID(),
    'idempotency-key': randomUUID().replaceAll('-', ''), 'x-data-purpose': 'PERSONAL_ASSISTANCE', 'x-maximum-sensitivity': 'RESTRICTED',
    ...extra,
  };
}
async function inbox(o: Owner, timeZone = 'UTC'): Promise<MemoryInboxView> {
  const response = await api().inject({ method: 'GET', url: '/v1/memory/inbox?timeZone=' + encodeURIComponent(timeZone), headers: headers(o, 'memory.inbox') });
  expect(response.statusCode, response.body).toBe(200);
  return memoryInboxViewSchema.parse(response.json());
}
async function decide(o: Owner, card: ClarificationCard, choiceId: string, key?: string) {
  return api().inject({ method: 'POST', url: '/v1/memory/inbox/cards/' + card.clarificationCardId + '/decide',
    headers: headers(o, 'memory.inbox', key ? { 'idempotency-key': key } : {}), payload: { choiceId } });
}
async function patchBudget(o: Owner, patch: Record<string, number>) {
  const response = await api().inject({ method: 'PATCH', url: '/v1/settings/attention-budgets', headers: headers(o, 'settings.attention'), payload: patch });
  expect(response.statusCode, response.body).toBe(200);
  return attentionBudgetSchema.parse(response.json());
}
async function decisions(o: Owner) {
  return (await admin.query(`SELECT d.candidate_ambiguity_id,d.decision,d.reason,d.policy_inputs,c.sensitivity_scope,c.id AS card_id
    FROM interruption_decisions d JOIN clarification_cards c ON c.id=d.clarification_card_id WHERE d.owner_scope_id=$1
    ORDER BY d.decided_at,d.id`, [o.owner])).rows;
}

describe('CRT-WRT-05-A: ten qualifying ambiguities in one owner-local day', () => {
  it('yield at most three proactive cards, at most one per sensitivity scope, and every decision logs its inputs and reason', async () => {
    at(0);
    const o = await makeOwner('Budget Default');
    await tenAmbiguities(o);
    const view = await inbox(o);
    expect(view.budget).toMatchObject({ maxCardsPerDay: 3, maxCardsPerSensitivityScopePerDay: 1, repeatQuestionSuppressionDays: 7, isDefault: true });
    expect(view.cards).toHaveLength(3);
    expect(new Set(view.cards.map(card => card.sensitivityScope)).size).toBe(3);
    expect(view.deferredCount).toBe(7);
    expect(view.remainingToday).toBe(0);
    for (const card of view.cards) expect(card.interruption).toMatchObject({ decision: 'ASK', reason: 'WITHIN_ATTENTION_BUDGET' });

    const logged = await decisions(o);
    expect(logged).toHaveLength(10);
    expect(new Set(logged.map(row => row.candidate_ambiguity_id)).size).toBe(10);
    for (const row of logged) {
      expect(Object.keys(row.policy_inputs)).toEqual(expect.arrayContaining(
        ['errorProbability', 'consequence', 'irreversibility', 'urgency', 'interruptionCost', 'budget']));
      expect(row.reason).toMatch(/^(WITHIN_ATTENTION_BUDGET|DAILY_BUDGET_EXHAUSTED|SCOPE_BUDGET_EXHAUSTED)$/);
    }
    const asked = logged.filter(row => row.decision === 'ASK');
    expect(asked).toHaveLength(3);
    expect(new Set(asked.map(row => row.sensitivity_scope)).size).toBe(3);
    expect(logged.filter(row => row.decision === 'BATCH').map(row => row.reason)).toEqual(expect.arrayContaining(['SCOPE_BUDGET_EXHAUSTED']));
    // The finance questions carry more value than the others, so the finance
    // scope is the first one spent.
    expect(asked.map(row => row.sensitivity_scope)).toContain('FINANCE/PRIVATE');

    // Reading the inbox again the same day spends no budget and logs nothing new.
    const again = await inbox(o);
    expect(again.cards.map(card => card.clarificationCardId).sort()).toEqual(view.cards.map(card => card.clarificationCardId).sort());
    expect(await decisions(o)).toHaveLength(10);
  });
});

describe('CRT-WRT-05-B: repeat suppression and the configured cap', () => {
  it('does not ask an unresolved question again within seven days unless material new evidence arrives', async () => {
    at(0);
    const o = await makeOwner('Repeat Owner');
    const { propositionId } = await ambiguity(o, 'FINANCE');
    const first = await inbox(o);
    expect(first.cards).toHaveLength(1);
    const cardId = first.cards[0]!.clarificationCardId;

    at(1);
    const nextDay = await inbox(o);
    expect(nextDay.cards).toEqual([]);
    expect(nextDay.withheld.map(card => card.clarificationCardId)).toEqual([cardId]);
    expect(nextDay.withheld[0]!.interruption).toMatchObject({ decision: 'SUPPRESS', reason: 'ASKED_WITHIN_SUPPRESSION_WINDOW' });

    // Material new evidence: a second source now bears on the same question.
    at(3);
    const fresh = await evidence(o, ['PERSONAL_ASSISTANCE', 'PERSONAL_FINANCE']);
    await claim(o, propositionId, fresh.anchorId);
    const reopened = await inbox(o);
    expect(reopened.cards.map(card => card.clarificationCardId)).toEqual([cardId]);
    expect(reopened.cards[0]!.interruption).toMatchObject({ decision: 'ASK', reason: 'REOPENED_BY_MATERIAL_NEW_EVIDENCE',
      policyInputs: { materialNewEvidenceIds: [fresh.evidenceId] } });
    expect(reopened.cards[0]!.reopenedByEvidenceId).toBe(fresh.evidenceId);

    at(9);
    const sixDaysLater = await inbox(o);
    expect(sixDaysLater.cards).toEqual([]);
    expect(sixDaysLater.withheld[0]!.interruption).toMatchObject({ reason: 'ASKED_WITHIN_SUPPRESSION_WINDOW' });

    at(10);
    const sevenDaysLater = await inbox(o);
    expect(sevenDaysLater.cards.map(card => card.clarificationCardId)).toEqual([cardId]);
    expect(sevenDaysLater.cards[0]!.interruption).toMatchObject({ decision: 'ASK', reason: 'WITHIN_ATTENTION_BUDGET' });
  });

  it('changing the configured budget changes the cap, from the next evaluation on', async () => {
    at(0);
    const o = await makeOwner('Budget Configured');
    const defaults = await api().inject({ method: 'GET', url: '/v1/settings/attention-budgets', headers: headers(o, 'settings.attention') });
    expect(defaults.json()).toMatchObject({ maxCardsPerDay: 3, maxCardsPerSensitivityScopePerDay: 1, repeatQuestionSuppressionDays: 7, isDefault: true });
    await tenAmbiguities(o);
    const wider = await patchBudget(o, { maxCardsPerDay: 5, maxCardsPerSensitivityScopePerDay: 2 });
    expect(wider).toMatchObject({ maxCardsPerDay: 5, maxCardsPerSensitivityScopePerDay: 2, repeatQuestionSuppressionDays: 7, isDefault: false });
    const view = await inbox(o);
    expect(view.cards).toHaveLength(5);
    const perScope = new Map<string, number>();
    for (const card of view.cards) perScope.set(card.sensitivityScope, (perScope.get(card.sensitivityScope) ?? 0) + 1);
    expect(Math.max(...perScope.values())).toBe(2);

    // Raised again the same day: the deferred questions are counted against the
    // new cap at once.
    await patchBudget(o, { maxCardsPerDay: 6 });
    expect((await inbox(o)).cards).toHaveLength(6);

    // Lowered: the next day asks exactly one.
    await patchBudget(o, { maxCardsPerDay: 1, maxCardsPerSensitivityScopePerDay: 1 });
    at(1);
    const narrow = await inbox(o);
    expect(narrow.cards).toHaveLength(1);
    expect(narrow.budget).toMatchObject({ maxCardsPerDay: 1, maxCardsPerSensitivityScopePerDay: 1 });
    const today = (await decisions(o)).filter(row => row.policy_inputs.ownerLocalDate === narrow.ownerLocalDate);
    expect(today.filter(row => row.decision === 'ASK')).toHaveLength(1);
    expect(today.filter(row => row.decision === 'BATCH').every(row => row.policy_inputs.budget.maxCardsPerDay === 1)).toBe(true);
  });

  it('refuses a budget outside its bounds and an unknown time zone', async () => {
    const o = await makeOwner('Budget Refusals');
    const invalid = await api().inject({ method: 'PATCH', url: '/v1/settings/attention-budgets', headers: headers(o, 'settings.attention'),
      payload: { maxCardsPerDay: -1 } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().code).toBe('REVIEW_INPUT_INVALID');
    const empty = await api().inject({ method: 'PATCH', url: '/v1/settings/attention-budgets', headers: headers(o, 'settings.attention'), payload: {} });
    expect(empty.statusCode).toBe(400);
    const zone = await api().inject({ method: 'GET', url: '/v1/memory/inbox?timeZone=Mars/Olympus', headers: headers(o, 'memory.inbox') });
    expect(zone.statusCode).toBe(400);
    expect(zone.json().code).toBe('TIME_ZONE_INVALID');
    const purpose = await api().inject({ method: 'GET', url: '/v1/memory/inbox', headers: headers(o, 'memory.read') });
    expect(purpose.statusCode).toBe(403);
    expect(purpose.json().code).toBe('PURPOSE_REFUSED');
    const { 'x-data-purpose': _purpose, ...withoutEvidenceContext } = headers(o, 'memory.inbox');
    const context = await api().inject({ method: 'GET', url: '/v1/memory/inbox', headers: withoutEvidenceContext });
    expect(context.statusCode).toBe(400);
    expect(context.json().code).toBe('REVIEW_CONTEXT_REQUIRED');
  });
});

describe('CRT-UX-08-A and CRT-WRT-06-A: the Daniel card, its answer, and a learned rule', () => {
  it('groups the situation into one card, answers it through the correction path, and applies a rule only while it is approved', async () => {
    at(0);
    const o = await makeOwner('Daniel Owner');
    const first = await danielRepayment(o);

    // One card for the whole situation, saying why it matters and what each
    // choice will change (§37.4).
    const view = await inbox(o);
    expect(view.cards).toHaveLength(1);
    const card = view.cards[0]!;
    expect(card).toMatchObject({ situationKey: 'thread:' + first.threadId, situationKind: 'REPAYMENT', title: 'Possible Daniel repayment',
      sensitivityScope: 'FINANCE/PRIVATE', status: 'ASKED' });
    expect(card.groupedAmbiguityIds.sort()).toEqual([first.allocationProposition, first.participantProposition].sort());
    expect(card.facts).toEqual(['An obligation of ₪50 is on record.', 'A ₪60 transfer with the memo "Daniel dinner" was recorded.',
      'The counterparty is not confirmed as the same person.', 'The purpose is not confirmed.']);
    expect(card.whyItMatters).toContain('decides whether you still owe it');
    expect(card.choices.map(choice => choice.label)).toEqual(['Confirm repayment', 'Different person', 'Different purpose', 'Keep uncertain']);
    for (const choice of card.choices) expect(choice.whatWillChange).toMatch(/\.$/);
    expect(card.interruption).toMatchObject({ decision: 'ASK', reason: 'WITHIN_ATTENTION_BUDGET',
      policyInputs: { consequence: 'HIGH', sensitivityScope: 'FINANCE/PRIVATE' } });

    // The answer: one evidence row, an overlay delta and a CONFIRM operation per
    // target, a USER_CONFIRMATION claim each, and a proposed transaction.
    const key = randomUUID().replaceAll('-', '');
    const answered = await decide(o, card, 'confirm_repayment', key);
    expect(answered.statusCode, answered.body).toBe(201);
    const result = cardDecisionResultSchema.parse(answered.json());
    expect(result.card.status).toBe('RESOLVED');
    expect(result.answer).toMatchObject({ choiceId: 'confirm_repayment', effect: 'CONFIRM', answeredBy: 'OWNER', learnedApprovalRuleId: null });
    expect(result.answer.overlayDeltaIds).toHaveLength(2);
    expect(result.answer.memoryOperationIds).toHaveLength(2);
    expect(result.answer.proposedTransactionId).not.toBeNull();
    expect(result.interruptionDecision).toMatchObject({ decision: 'ASK', reason: 'WITHIN_ATTENTION_BUDGET', clarificationCardId: card.clarificationCardId });
    expect(result.proposedRule).toBeNull();
    const confirmations = (await admin.query(`SELECT proposition_id FROM claims WHERE owner_scope_id=$1 AND claim_origin='USER_CONFIRMATION'`,
      [o.owner])).rows.map(row => row.proposition_id);
    expect(confirmations.sort()).toEqual([first.allocationProposition, first.participantProposition].sort());
    expect((await admin.query(`SELECT operation_kind FROM memory_operations WHERE owner_scope_id=$1`, [o.owner])).rows
      .map(row => row.operation_kind)).toEqual(['CONFIRM', 'CONFIRM']);
    expect((await admin.query(`SELECT transaction_kind,status FROM belief_transactions WHERE owner_scope_id=$1 AND id=$2`,
      [o.owner, result.answer.proposedTransactionId])).rows).toEqual([{ transaction_kind: 'CONFIRM', status: 'PROPOSED' }]);
    // Nothing canonical was updated in place: the candidates are still candidates.
    expect((await admin.query(`SELECT assessment_status FROM belief_assessments WHERE owner_scope_id=$1 AND proposition_id=$2`,
      [o.owner, first.allocationProposition])).rows).toEqual([{ assessment_status: 'CANDIDATE' }]);

    // A retry answers from the record; a different answer to a settled card is refused.
    const retry = await decide(o, card, 'confirm_repayment', key);
    expect(retry.statusCode).toBe(200);
    expect(retry.json().answer).toEqual(result.answer);
    const changed = await decide(o, card, 'different_purpose');
    expect(changed.statusCode).toBe(409);
    expect(changed.json().code).toBe('CLARIFICATION_CARD_ALREADY_ANSWERED');
    // A confirmed value is not asked about again.
    expect((await inbox(o)).cards).toEqual([]);

    // The same answer on a second matching card: Uai proposes a rule.
    at(1);
    await danielRepayment(o);
    const secondCard = (await inbox(o)).cards[0]!;
    const second = cardDecisionResultSchema.parse((await decide(o, secondCard, 'confirm_repayment')).json());
    const proposed = learnedApprovalRuleSchema.parse(second.proposedRule);
    expect(proposed).toMatchObject({ status: 'PROPOSED', inEffect: false,
      ruleText: 'Always link transfers with the exact memo "Daniel dinner" to the matching open obligation.',
      scope: { situationKind: 'REPAYMENT', matchText: 'Daniel dinner', choiceId: 'confirm_repayment', effect: 'CONFIRM', sensitivityScope: 'FINANCE/PRIVATE' } });
    expect(proposed.proposedFromCardIds.sort()).toEqual([card.clarificationCardId, secondCard.clarificationCardId].sort());

    // Proposed has no effect: the next matching card is asked like any other.
    at(2);
    await danielRepayment(o);
    const third = await inbox(o);
    expect(third.cards).toHaveLength(1);
    expect(third.cards[0]!.interruption).toMatchObject({ decision: 'ASK', reason: 'WITHIN_ATTENTION_BUDGET', policyInputs: { learnedApprovalRuleId: null } });
    expect(third.resolvedToday).toEqual([]);

    const listed = await api().inject({ method: 'GET', url: '/v1/approval-rules', headers: headers(o, 'approval.rules') });
    expect(learnedApprovalRulesViewSchema.parse(listed.json()).rules.map(rule => [rule.learnedApprovalRuleId, rule.status]))
      .toEqual([[proposed.learnedApprovalRuleId, 'PROPOSED']]);

    // Explicit approval, by the owner's own session.
    const approved = await api().inject({ method: 'POST', url: '/v1/approval-rules/' + proposed.learnedApprovalRuleId + '/approve', headers: headers(o, 'approval.rules') });
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json()).toMatchObject({ status: 'APPROVED', inEffect: true, approvedByUserId: o.userId });

    // Approved: a matching card is answered by the rule, not put to the owner --
    // even with today's finance budget already spent -- through the same write path.
    const fourth = await danielRepayment(o);
    const applied = await inbox(o);
    expect(applied.cards.map(entry => entry.clarificationCardId)).toEqual([third.cards[0]!.clarificationCardId]);
    const byRule = applied.resolvedToday.find(entry => entry.situationKey === 'thread:' + fourth.threadId)!;
    expect(byRule).toMatchObject({ status: 'RESOLVED', appliedRuleId: proposed.learnedApprovalRuleId,
      answer: { answeredBy: 'LEARNED_RULE', choiceId: 'confirm_repayment', learnedApprovalRuleId: proposed.learnedApprovalRuleId } });
    expect(byRule.interruption).toMatchObject({ decision: 'SUPPRESS', reason: 'LEARNED_RULE_APPLIED',
      policyInputs: { learnedApprovalRuleId: proposed.learnedApprovalRuleId } });
    expect((await admin.query(`SELECT delta_kind FROM owner_overlay_deltas WHERE owner_scope_id=$1 AND target_object_id=$2`,
      [o.owner, fourth.allocationProposition])).rows).toEqual([{ delta_kind: 'USER_CONFIRMATION' }]);
    expect((await admin.query(`SELECT detail->>'learnedApprovalRuleId' AS rule FROM memory_operations WHERE owner_scope_id=$1
      AND target_object_id=$2`, [o.owner, fourth.allocationProposition])).rows).toEqual([{ rule: proposed.learnedApprovalRuleId }]);

    // Inspectable: the rule's history names the card it answered.
    const inspected = learnedApprovalRulesViewSchema.parse((await api().inject({ method: 'GET', url: '/v1/approval-rules',
      headers: headers(o, 'approval.rules') })).json()).rules[0]!;
    expect(inspected.history.map(entry => entry.event)).toEqual(['PROPOSED', 'APPROVED', 'APPLIED']);
    expect(inspected.history[2]!.clarificationCardId).toBe(byRule.clarificationCardId);

    // Revoked: it no longer applies.
    const revoked = await api().inject({ method: 'POST', url: '/v1/approval-rules/' + proposed.learnedApprovalRuleId + '/revoke', headers: headers(o, 'approval.rules') });
    expect(revoked.json()).toMatchObject({ status: 'REVOKED', inEffect: false });
    const reapprove = await api().inject({ method: 'POST', url: '/v1/approval-rules/' + proposed.learnedApprovalRuleId + '/approve', headers: headers(o, 'approval.rules') });
    expect(reapprove.statusCode).toBe(409);
    expect(reapprove.json().code).toBe('LEARNED_RULE_NOT_PROPOSED');
    at(3);
    const fifth = await danielRepayment(o);
    const afterRevoke = await inbox(o);
    const asked = afterRevoke.cards.find(entry => entry.situationKey === 'thread:' + fifth.threadId)!;
    expect(asked).toMatchObject({ status: 'ASKED', appliedRuleId: null, answer: null });
    expect(asked.interruption).toMatchObject({ decision: 'ASK', policyInputs: { learnedApprovalRuleId: null } });
    expect(afterRevoke.resolvedToday).toEqual([]);
  },20_000);

  it('keeps a question uncertain for the suppression window, and refuses unknown cards, choices and rules', async () => {
    at(0);
    const o = await makeOwner('Keep Uncertain Owner');
    await danielRepayment(o);
    const card = (await inbox(o)).cards[0]!;
    const kept = cardDecisionResultSchema.parse((await decide(o, card, 'keep_uncertain')).json());
    expect(kept.card).toMatchObject({ status: 'SUPPRESSED', answer: { effect: 'KEEP_UNCERTAIN' } });
    expect(kept.answer.proposedTransactionId).toBeNull();
    expect((await admin.query(`SELECT count(*)::int AS n FROM belief_transactions WHERE owner_scope_id=$1 AND transaction_kind<>'CANONICALIZE'`,
      [o.owner])).rows[0].n).toBe(0);
    at(2);
    const later = await inbox(o);
    expect(later.cards).toEqual([]);
    expect(later.withheld[0]!.interruption).toMatchObject({ decision: 'SUPPRESS', reason: 'KEPT_UNCERTAIN_WITHIN_SUPPRESSION_WINDOW' });

    const unknownCard = await api().inject({ method: 'POST', url: '/v1/memory/inbox/cards/' + randomUUID() + '/decide',
      headers: headers(o, 'memory.inbox'), payload: { choiceId: 'confirm' } });
    expect(unknownCard.statusCode).toBe(404);
    const unknownChoice = await decide(o, later.withheld[0]!, 'something_else');
    expect(unknownChoice.statusCode).toBe(400);
    expect(unknownChoice.json().code).toBe('CLARIFICATION_CHOICE_UNKNOWN');
    const unknownRule = await api().inject({ method: 'POST', url: '/v1/approval-rules/' + randomUUID() + '/approve', headers: headers(o, 'approval.rules') });
    expect(unknownRule.statusCode).toBe(404);
    const wrongPurpose = await api().inject({ method: 'GET', url: '/v1/approval-rules', headers: headers(o, 'memory.inbox') });
    expect(wrongPurpose.statusCode).toBe(403);
  });
});
