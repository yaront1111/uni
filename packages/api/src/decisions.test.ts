import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { runMigrations } from '@unai/postgres';
import { postgresAdapter, SESSION_COOKIE } from '@unai/auth';
import {
  decisionDetailSchema, decisionProjectionViewSchema, decisionReviewResultSchema, goalPriorityChangeResultSchema, goalSchema,
  goalsViewSchema, memoryInboxViewSchema, mentorViewSchema, recordDecisionResultSchema,
  type MentorView, type RecordDecision, type TransitionContract,
} from '@unai/domain';
import { lintRegistryCheckout } from '../../registry/src/index.js';
import { uuidV7 } from '../../../src/kernel/identities.js';
import { createPlatformApi } from './platform.js';
import type { EvidenceObjects } from './evidence.js';

/**
 * Goals, decisions, the prediction review and the mentor over the real boundary:
 * TLS, session, owner scope, purpose, the owner's words stored as evidence under
 * `memory.correct`, canonicalized under `memory.canonicalize`, reduced under
 * `memory.project`, read through the Context Broker under `memory.read` -- all as
 * the low-privilege application role, so migration 0024's policies are part of
 * what is exercised. The transition contracts are read out of
 * `registry/releases/0.2.0` by the registry library, so the review is validated
 * against the release's YAML and not a copy of it.
 *
 * Covers CRT-DEC-01-A, CRT-DEC-02-A and CRT-DEC-03-A.
 */

if (!process.env.UNAI_TEST_DATABASE_URL) throw new Error('Run pnpm test for the required PostgreSQL harness');
const admin = new Pool({ connectionString: process.env.UNAI_TEST_DATABASE_URL });
const url = new URL(process.env.UNAI_TEST_DATABASE_URL); url.username = 'decisions_test_app'; url.password = 'test-only';
const appPool = new Pool({ connectionString: url.href });

const DAY = 86_400_000;
const stored = new Map<string, Uint8Array>();
const evidenceObjects: EvidenceObjects = {
  encryptionKeyRef: 'kms:test-double',
  async put(_tx, key, bytes) { stored.set(key, bytes); },
  async get(_tx, key) { return stored.get(key)!; },
};
let release020: TransitionContract[] = [];

interface Owner { owner: string; userId: string; token: string; contextSpaceId: string }

beforeAll(async () => {
  await runMigrations(admin, resolve('migrations'));
  await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='decisions_test_app') THEN CREATE ROLE decisions_test_app LOGIN PASSWORD 'test-only'; END IF; END $$; GRANT unai_app TO decisions_test_app");
  release020 = [...(await lintRegistryCheckout({ repository: resolve('.'), version: '0.2.0' })).transitions];
});
afterAll(async () => { await appPool.end(); await admin.end(); });

async function makeOwner(name: string): Promise<Owner> {
  const adapter = postgresAdapter(admin);
  const user = await adapter.createUser!({ name, email: name.toLowerCase().replaceAll(' ', '.') + '.' + randomUUID().slice(0, 8) + '@example.test', emailVerified: null });
  const owner = (user as unknown as { ownerScopeId: string }).ownerScopeId;
  const token = randomBytes(32).toString('base64url');
  await adapter.createSession!({ userId: user.id, sessionToken: token, expires: new Date(Date.now() + 604800000) });
  const contextSpaceId = (await admin.query("SELECT id FROM context_spaces WHERE owner_scope_id=$1 AND context_kind='BASE'", [owner])).rows[0].id;
  return { owner, userId: user.id, token, contextSpaceId };
}

function api(options: { transitionContracts?: readonly TransitionContract[] | null } = {}) {
  const contracts = options.transitionContracts === undefined ? release020 : options.transitionContracts;
  const app = createPlatformApi({ authPool: admin, appPool, evidenceObjects, registryRelease: '0.2.0',
    ...(contracts ? { transitionContracts: contracts } : {}) });
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

/** One evidence item with one anchored excerpt, admitting the given purposes. */
async function evidence(o: Owner, purposes: string[], words: string, sourceType = 'DOCUMENT'): Promise<{ evidenceId: string; anchorId: string }> {
  const evidenceId = randomUUID(), anchorId = randomUUID(), connectorId = randomUUID();
  await admin.query("INSERT INTO connectors(id,owner_scope_id,connector_type,external_account_ref,permission_manifest,status) VALUES($1,$2,'CONVERSATION',$3,'{}','ACTIVE')",
    [connectorId, o.owner, randomUUID()]);
  await admin.query(`INSERT INTO source_items(id,owner_scope_id,connector_id,source_type,external_id,actor_ref,submitted_by_user_id,
    raw_object_ref,content_hash,sensitivity,allowed_purposes,ingestion_version,idempotency_key)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'PRIVATE',$10,'evidence-json-v1',$11)`,
    [evidenceId, o.owner, connectorId, sourceType, 'item-' + randomUUID(), JSON.stringify({ type: 'USER', id: o.userId }), o.userId,
      randomUUID(), randomBytes(32).toString('hex'), purposes, randomUUID()]);
  await admin.query(`INSERT INTO source_anchors(id,owner_scope_id,source_item_id,anchor_kind,anchor,normalized_text)
    VALUES($1,$2,$3,'MESSAGE_SPAN',$4,$5)`, [anchorId, o.owner, evidenceId, JSON.stringify({ start: 0, end: words.length }), words]);
  return { evidenceId, anchorId };
}

const PURPOSE_OF = { WORK: 'WORK_ASSISTANCE', HEALTH: 'HEALTH_ADMINISTRATION', FAMILY: 'FAMILY_COORDINATION', FINANCE: 'PERSONAL_FINANCE' } as const;

/** One calendar event, SCHEDULED, in the life category its evidence admits. */
async function calendarEvent(o: Owner, category: keyof typeof PURPOSE_OF, start: Date, minutes: number): Promise<string> {
  const source = await evidence(o, ['PERSONAL_ASSISTANCE', PURPOSE_OF[category]], category + ' event', 'GOOGLE_CALENDAR_EVENT');
  const frame = uuidV7(), slot = uuidV7(), proposition = uuidV7();
  await admin.query('INSERT INTO frame_instances(id,owner_scope_id,frame_type_id,context_space_id) VALUES($1,$2,$3,$4)',
    [frame, o.owner, 'shared.event_occurrence', o.contextSpaceId]);
  await admin.query(`INSERT INTO belief_slots(id,owner_scope_id,frame_instance_id,predicate_id,context_space_id,modality)
    VALUES($1,$2,$3,'shared.event_occurrence.occurrence_time',$4,'SCHEDULED')`, [slot, o.owner, frame, o.contextSpaceId]);
  await admin.query('INSERT INTO propositions(id,owner_scope_id,belief_slot_id,normalized_value) VALUES($1,$2,$3,$4)',
    [proposition, o.owner, slot, JSON.stringify({ start: start.toISOString(), end: new Date(start.getTime() + minutes * 60_000).toISOString() })]);
  await admin.query(`INSERT INTO claims(id,owner_scope_id,source_anchor_id,proposition_id,claim_origin,lifecycle,valid_from)
    VALUES($1,$2,$3,$4,'STRUCTURED_CONNECTOR_OBSERVATION','PROVISIONAL',$5)`, [uuidV7(), o.owner, source.anchorId, proposition, start]);
  return proposition;
}

async function goal(o: Owner, body: Record<string, unknown>) {
  const response = await api().inject({ method: 'POST', url: '/v1/goals', headers: headers(o, 'goals.manage'), payload: body });
  expect(response.statusCode, response.body).toBe(201);
  return goalSchema.parse(response.json());
}
async function changePriority(o: Owner, goalId: string, body: Record<string, unknown>) {
  const response = await api().inject({ method: 'PATCH', url: '/v1/goals/' + goalId + '/priority', headers: headers(o, 'goals.manage'), payload: body });
  expect(response.statusCode, response.body).toBe(200);
  return goalPriorityChangeResultSchema.parse(response.json());
}
async function recordDecision(o: Owner, body: RecordDecision, key?: string) {
  const response = await api().inject({ method: 'POST', url: '/v1/decisions',
    headers: headers(o, 'decisions.record', key ? { 'idempotency-key': key } : {}), payload: body });
  expect(response.statusCode, response.body).toBe(201);
  return recordDecisionResultSchema.parse(response.json());
}
async function mentor(o: Owner): Promise<MentorView> {
  const response = await api().inject({ method: 'GET', url: '/v1/mentor/contradictions?timeZone=UTC', headers: headers(o, 'mentor.advise') });
  expect(response.statusCode, response.body).toBe(200);
  return mentorViewSchema.parse(response.json());
}

const FUTURE_REVIEW = new Date(Date.now() + 180 * DAY);
FUTURE_REVIEW.setUTCHours(0, 0, 0, 0);

describe('CRT-DEC-01-A: goals keep their priority history, and the Decisions workspace is backed by a decision_projection row', () => {
  it('appends a history row for every priority change and overwrites nothing', async () => {
    const o = await makeOwner('Goal Keeper');
    const created = await goal(o, { title: 'Run a half marathon', domain: 'HEALTH', priority: 'HIGH', reason: 'Doctor asked me to get fit.' });
    expect(created).toMatchObject({ currentPriority: 'HIGH', effectivePriority: 'HIGH', temporaryOverride: null });
    expect(created.priorityHistory.map(entry => [entry.changeKind, entry.priority])).toEqual([['INITIAL', 'HIGH']]);
    const first = (await admin.query('SELECT * FROM goal_priority_history WHERE owner_scope_id=$1', [o.owner])).rows;

    const lowered = await changePriority(o, created.goalId, { priority: 'MEDIUM', reason: 'Work launch this quarter.' });
    expect(lowered.appended).toMatchObject({ changeKind: 'CHANGE', priority: 'MEDIUM', reason: 'Work launch this quarter.' });
    expect(lowered.goal.currentPriority).toBe('MEDIUM');
    const raised = await changePriority(o, created.goalId, { priority: 'HIGH', reason: 'Launch is done.' });
    expect(raised.goal.priorityHistory.map(entry => [entry.changeKind, entry.priority, entry.reason])).toEqual([
      ['INITIAL', 'HIGH', 'Doctor asked me to get fit.'], ['CHANGE', 'MEDIUM', 'Work launch this quarter.'], ['CHANGE', 'HIGH', 'Launch is done.']]);

    // Retained: the first statement is byte-for-byte what it was, beside the two after it.
    const rows = (await admin.query('SELECT * FROM goal_priority_history WHERE owner_scope_id=$1 ORDER BY recorded_at,id', [o.owner])).rows;
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual(first[0]);

    // A temporary override is its own row and leaves the standing priority alone.
    const until = new Date(Date.now() + 14 * DAY).toISOString();
    const override = await changePriority(o, created.goalId, { priority: 'LOW', reason: 'Recovering from an injury.', until });
    expect(override.appended).toMatchObject({ changeKind: 'TEMPORARY_OVERRIDE', priority: 'LOW' });
    expect(override.goal).toMatchObject({ currentPriority: 'HIGH', effectivePriority: 'LOW', overrideActive: true });
    expect(override.goal.priorityHistory).toHaveLength(4);

    const listed = goalsViewSchema.parse((await api().inject({ method: 'GET', url: '/v1/goals', headers: headers(o, 'goals.read') })).json());
    expect(listed.goals.map(entry => entry.goalId)).toEqual([created.goalId]);
    expect(listed.goals[0]!.priorityHistory).toHaveLength(4);
    // The history cannot be rewritten through the application or by anyone else.
    await expect(admin.query("UPDATE goal_priority_history SET priority='PAUSED' WHERE owner_scope_id=$1", [o.owner]))
      .rejects.toThrow('GOAL_PRIORITY_HISTORY_IMMUTABLE');
    // The screen's writes are refused under another purpose, and an unknown goal is named.
    expect((await api().inject({ method: 'PATCH', url: '/v1/goals/' + created.goalId + '/priority', headers: headers(o, 'goals.read'),
      payload: { priority: 'LOW', reason: 'x' } })).statusCode).toBe(403);
    const unknown = await api().inject({ method: 'PATCH', url: '/v1/goals/' + randomUUID() + '/priority', headers: headers(o, 'goals.manage'),
      payload: { priority: 'LOW', reason: 'x' } });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().code).toBe('GOAL_NOT_FOUND');
  });

  it('shows question, options, assumptions, cross-domain consequences, recommendation, choice, expected result, review date and actual outcome from a decision_projection row', async () => {
    const o = await makeOwner('Decision Maker');
    const career = await goal(o, { title: 'Lead a team', domain: 'WORK', priority: 'HIGH' });
    const offer = await evidence(o, ['PERSONAL_ASSISTANCE'], 'Offer letter: base salary 20% above my current one.');
    const recorded = await recordDecision(o, {
      question: 'Should I take the Berlin job offer?',
      options: ['Take the Berlin offer', 'Stay in my current role'],
      assumptions: [{ text: 'The Berlin salary is 20% higher', sourceEvidenceIds: [offer.evidenceId] }, { text: 'My partner can work remotely' }],
      consequences: [{ domain: 'FINANCE', text: 'Higher savings rate' }, { domain: 'FAMILY', text: 'We move away from my parents' }],
      recommendation: 'Negotiate a later start date before accepting',
      userChoice: 'Take the Berlin offer',
      rationale: 'Career growth outweighs the move, and the salary covers the higher rent.',
      expectedResult: 'Within a year I lead a team and save 15% more',
      reviewDate: FUTURE_REVIEW.toISOString(),
      goalId: career.goalId,
    });
    const id = recorded.decision.decisionFrameInstanceId;
    expect(recorded.decision).toMatchObject({
      question: 'Should I take the Berlin job offer?',
      recommendation: 'Negotiate a later start date before accepting',
      userChoice: 'Take the Berlin offer', expectedResult: 'Within a year I lead a team and save 15% more',
      rationale: 'Career growth outweighs the move, and the salary covers the higher rent.',
      reviewDate: FUTURE_REVIEW.toISOString(), reviewDue: false, actualOutcome: null, reviewOutcomeCode: null,
      outcomeState: 'UNRESOLVED', relatedGoalId: career.goalId, isComplete: true,
    });
    expect(recorded.decision.alternatives.map(option => option.text)).toEqual(['Take the Berlin offer', 'Stay in my current role']);
    expect(recorded.decision.assumptions.map(assumption => [assumption.text, assumption.citedEvidenceIds]))
      .toEqual([['The Berlin salary is 20% higher', [offer.evidenceId]], ['My partner can work remotely', []]]);
    expect(recorded.decision.crossDomainConsequences.map(consequence => [consequence.domain, consequence.text]))
      .toEqual([['FINANCE', 'Higher savings rate'], ['FAMILY', 'We move away from my parents']]);
    expect(recorded.decision.predictedOutcomePropositionIds).toHaveLength(1);

    // The workspace's read: the projection route, with completeness and watermarks.
    const view = decisionProjectionViewSchema.parse((await api().inject({ method: 'GET', url: '/v1/projections/decisions',
      headers: headers(o, 'projection.read') })).json());
    expect(view.rows.map(row => row.decisionFrameInstanceId)).toEqual([id]);
    expect(view).toMatchObject({ isComplete: true, reducerVersion: 'decision-reducer-0.1.0' });
    expect(Number.isInteger(view.ownerOverlayWatermark)).toBe(true);

    // Backed by a decision_projection row with typed columns.
    const row = (await admin.query('SELECT * FROM decision_projection WHERE owner_scope_id=$1', [o.owner])).rows;
    expect(row).toHaveLength(1);
    expect(row[0]).toMatchObject({ decision_frame_instance_id: id, question: 'Should I take the Berlin job offer?',
      user_choice: 'Take the Berlin offer', related_goal_id: career.goalId, outcome_state: 'UNRESOLVED' });
    expect(row[0].review_date).toEqual(FUTURE_REVIEW);
    // Canonical memory under it: one decision frame, each field its own proposition
    // in the slot and modality release 0.2.0 gives it, and no status slot anywhere.
    const slots = (await admin.query(`SELECT predicate_id,modality,qualifiers FROM belief_slots WHERE owner_scope_id=$1 AND frame_instance_id=$2
      ORDER BY predicate_id,qualifiers::text`, [o.owner, id])).rows;
    expect(slots.map(slot => slot.predicate_id + ':' + slot.modality)).toEqual([
      'shared.decision.assumption:EXPECTED', 'shared.decision.assumption:EXPECTED', 'shared.decision.choice:ACTUAL',
      'shared.decision.consequence:EXPECTED', 'shared.decision.consequence:EXPECTED', 'shared.decision.expected_result:PREDICTED',
      'shared.decision.option:ACTUAL', 'shared.decision.option:ACTUAL', 'shared.decision.question:ACTUAL',
      'shared.decision.rationale:ACTUAL', 'shared.decision.recommendation:RECOMMENDED', 'shared.decision.review_date:INTENDED']);
    const claims = (await admin.query(`SELECT c.claim_origin,c.lifecycle,a.normalized_text FROM claims c JOIN source_anchors a ON a.id=c.source_anchor_id
      WHERE c.owner_scope_id=$1 AND a.source_item_id=$2`, [o.owner, recorded.evidenceId])).rows;
    expect(claims).toHaveLength(12);
    expect(claims.every(claim => claim.claim_origin === 'USER_STATEMENT' && claim.lifecycle === 'CANDIDATE')).toBe(true);
    // Each claim rests on the owner's exact words for its field.
    expect(claims.map(claim => claim.normalized_text)).toContain('Career growth outweighs the move, and the salary covers the higher rent.');

    // A retry under the same key is the same decision, not a second one.
    const key = randomUUID().replaceAll('-', '');
    const once = await recordDecision(o, { question: 'Which bank?', options: ['Keep mine', 'Switch'] }, key);
    const twice = await recordDecision(o, { question: 'Which bank?', options: ['Keep mine', 'Switch'] }, key);
    expect(twice.decision.decisionFrameInstanceId).toBe(once.decision.decisionFrameInstanceId);
    expect((await admin.query("SELECT count(*)::int n FROM frame_instances WHERE owner_scope_id=$1 AND frame_type_id='shared.decision'", [o.owner])).rows[0].n).toBe(2);

    // A goal from nowhere and an uncited source are refused before anything is written.
    for (const [body, code] of [[{ question: 'x?', options: ['a'], goalId: randomUUID() }, 'DECISION_GOAL_UNKNOWN'],
      [{ question: 'y?', options: ['a'], assumptions: [{ text: 'z', sourceEvidenceIds: [randomUUID()] }] }, 'DECISION_SOURCE_UNKNOWN']] as const) {
      const refused = await api().inject({ method: 'POST', url: '/v1/decisions', headers: headers(o, 'decisions.record'), payload: body });
      expect(refused.statusCode, code).toBe(422);
      expect(refused.json().code).toBe(code);
    }
    expect((await api().inject({ method: 'POST', url: '/v1/decisions', headers: headers(o, 'decisions.read'),
      payload: { question: 'x?', options: ['a'] } })).statusCode).toBe(403);
  });
});

describe('CRT-DEC-02-A: "Why did I make this decision?" and the prediction review', () => {
  it('answers with the recorded rationale and assumptions, each with its sources', async () => {
    const o = await makeOwner('Why Asker');
    const offer = await evidence(o, ['PERSONAL_ASSISTANCE'], 'Offer letter: base salary 20% above my current one.');
    const recorded = await recordDecision(o, {
      question: 'Should I take the Berlin job offer?', options: ['Take the Berlin offer', 'Stay'],
      assumptions: [{ text: 'The Berlin salary is 20% higher', sourceEvidenceIds: [offer.evidenceId] }],
      userChoice: 'Take the Berlin offer', rationale: 'Career growth outweighs the move.',
      expectedResult: 'Within a year I lead a team',
    });
    const id = recorded.decision.decisionFrameInstanceId;
    const response = await api().inject({ method: 'GET', url: '/v1/decisions/' + id + '?question=' + encodeURIComponent('Why did I make this decision?'),
      headers: headers(o, 'decisions.read') });
    expect(response.statusCode, response.body).toBe(200);
    const detail = decisionDetailSchema.parse(response.json());
    const rationale = detail.rationale;
    expect(rationale).toMatchObject({ question: 'Why did I make this decision?', answerType: 'CAUSAL_EXPLANATION',
      queryMode: 'DECISION_RECONSTRUCTION', reasonRecorded: true });
    expect(rationale.answer).toContain('You chose "Take the Berlin offer" for "Should I take the Berlin job offer?".');
    expect(rationale.answer).toContain('Your recorded reason: "Career growth outweighs the move."');
    expect(rationale.answer).toContain('You assumed "The Berlin salary is 20% higher".');
    const item = (kind: string) => rationale.items.find(entry => entry.kind === kind)!;
    // The rationale and the assumption each come with the owner's own words ...
    expect(item('RATIONALE').sources).toContainEqual(expect.objectContaining({ evidenceId: recorded.evidenceId, relation: 'STATED_IN',
      excerpt: 'Career growth outweighs the move.' }));
    expect(item('ASSUMPTION').sources).toContainEqual(expect.objectContaining({ evidenceId: recorded.evidenceId, relation: 'STATED_IN',
      excerpt: 'The Berlin salary is 20% higher' }));
    // ... and the assumption with the source the owner cited for it.
    expect(item('ASSUMPTION').sources).toContainEqual(expect.objectContaining({ evidenceId: offer.evidenceId, relation: 'CITED',
      excerpt: 'Offer letter: base salary 20% above my current one.' }));
    expect(item('ASSUMPTION').label).toBe('REPORTED');
    expect(item('EXPECTED_RESULT').label).toBe('PREDICTED');
    // The answer is auditable: the packet it was composed from is on record.
    expect((await admin.query('SELECT answer_type_classification FROM context_packets WHERE id=$1', [rationale.contextPacketId])).rows[0])
      .toEqual({ answer_type_classification: 'DECISION_RECONSTRUCTION' });

    // With no reason on record the answer says so and invents none.
    const bare = await recordDecision(o, { question: 'Which gym?', options: ['The near one', 'The cheap one'], userChoice: 'The near one' });
    expect(bare.rationale.reasonRecorded).toBe(false);
    expect(bare.rationale.answer).toContain('No reason and no assumption were recorded for this decision');
  });

  it('reviews a prediction as CONFIRMED, REFUTED or PARTIALLY_CONFIRMED with predicted versus actual, and leaves the PREDICTED proposition and its claims intact', async () => {
    const o = await makeOwner('Prediction Reviewer');
    for (const [outcomeCode, actual] of [['CONFIRMED', 'I lead a team of four'], ['REFUTED', 'I am still an individual contributor'],
      ['PARTIALLY_CONFIRMED', 'I lead the team, savings are up only 5%']] as const) {
      const recorded = await recordDecision(o, { question: 'Take the lead role? (' + outcomeCode + ')', options: ['Yes', 'No'], userChoice: 'Yes',
        expectedResult: 'Within a year I lead a team and save 15% more', reviewDate: new Date(Date.now() - DAY).toISOString() });
      const id = recorded.decision.decisionFrameInstanceId;
      // The review date has passed: the clock marks it due and creates nothing else.
      expect(recorded.decision).toMatchObject({ reviewDue: true, reviewOutcomeCode: null, actualResolutionIds: [] });
      const predicted = recorded.decision.predictedOutcomePropositionIds[0]!;
      const before = {
        proposition: (await admin.query('SELECT * FROM propositions WHERE id=$1', [predicted])).rows[0],
        slot: (await admin.query('SELECT s.* FROM belief_slots s JOIN propositions p ON p.belief_slot_id=s.id WHERE p.id=$1', [predicted])).rows[0],
        claims: (await admin.query('SELECT * FROM claims WHERE proposition_id=$1 ORDER BY id', [predicted])).rows,
      };
      expect(before.slot.modality).toBe('PREDICTED');

      const key = randomUUID().replaceAll('-', '');
      const review = () => api().inject({ method: 'POST', url: '/v1/decisions/' + id + '/review',
        headers: headers(o, 'decisions.record', { 'idempotency-key': key }), payload: { actualOutcome: actual, outcomeCode } });
      const response = await review();
      expect(response.statusCode, response.body).toBe(201);
      const result = decisionReviewResultSchema.parse(response.json());
      expect(result.comparison).toMatchObject({
        predicted: { propositionId: predicted, text: 'Within a year I lead a team and save 15% more', modality: 'PREDICTED' },
        actual: { text: actual, modality: 'ACTUAL' }, resolutionCode: outcomeCode, resolutionLifecycle: 'PROPOSED',
        transitionContractId: 'shared.decision.prediction_review',
      });
      expect(result.decision).toMatchObject({ actualOutcome: actual, reviewOutcomeCode: outcomeCode, reviewLifecycle: 'PROPOSED',
        reviewDue: false, actualResolutionIds: [result.comparison.resolutionAssertionId] });
      // The resolution names the prediction as its source and the contract that allowed the code.
      expect((await admin.query('SELECT source_frame_instance_id,source_proposition_id,target_frame_instance_id,outcome_code,transition_contract_id FROM resolution_assertions WHERE id=$1',
        [result.comparison.resolutionAssertionId])).rows[0]).toEqual({ source_frame_instance_id: id, source_proposition_id: predicted,
        target_frame_instance_id: null, outcome_code: outcomeCode, transition_contract_id: 'shared.decision.prediction_review' });
      // Intact: every column of the prediction's slot, proposition and claims.
      expect((await admin.query('SELECT * FROM propositions WHERE id=$1', [predicted])).rows[0], outcomeCode).toEqual(before.proposition);
      expect((await admin.query('SELECT s.* FROM belief_slots s JOIN propositions p ON p.belief_slot_id=s.id WHERE p.id=$1', [predicted])).rows[0], outcomeCode).toEqual(before.slot);
      expect((await admin.query('SELECT * FROM claims WHERE proposition_id=$1 ORDER BY id', [predicted])).rows, outcomeCode).toEqual(before.claims);
      // The actual outcome is its own ACTUAL proposition beside it.
      expect((await admin.query('SELECT s.modality,s.predicate_id FROM belief_slots s JOIN propositions p ON p.belief_slot_id=s.id WHERE p.id=$1',
        [result.comparison.actual.propositionId])).rows[0]).toEqual({ modality: 'ACTUAL', predicate_id: 'shared.decision.observed_result' });

      // A retry is the same review.
      const again = decisionReviewResultSchema.parse((await review()).json());
      expect(again.comparison.resolutionAssertionId).toBe(result.comparison.resolutionAssertionId);
      expect((await admin.query('SELECT count(*)::int n FROM resolution_assertions WHERE source_frame_instance_id=$1', [id])).rows[0].n).toBe(1);

      // The detail shows the comparison with its resolution code.
      const detail = decisionDetailSchema.parse((await api().inject({ method: 'GET', url: '/v1/decisions/' + id, headers: headers(o, 'decisions.read') })).json());
      expect(detail.reviews).toEqual([expect.objectContaining({ resolutionCode: outcomeCode,
        predicted: expect.objectContaining({ text: 'Within a year I lead a team and save 15% more' }), actual: expect.objectContaining({ text: actual }) })]);
      expect(detail.decision.actualOutcome).toBe(actual);
    }
  });

  it('refuses a code the pinned transition contract does not allow, a missing contract, and a decision with nothing predicted', async () => {
    const o = await makeOwner('Review Refusals');
    const recorded = await recordDecision(o, { question: 'Move to Haifa?', options: ['Move', 'Stay'], userChoice: 'Move',
      expectedResult: 'A shorter commute' });
    const id = recorded.decision.decisionFrameInstanceId;
    const refuse = async (payload: Record<string, unknown>, app = api()) => {
      const response = await app.inject({ method: 'POST', url: '/v1/decisions/' + id + '/review', headers: headers(o, 'decisions.record'), payload });
      return { status: response.statusCode, code: response.json().code as string };
    };
    expect(await refuse({ actualOutcome: 'Commute halved', outcomeCode: 'FULFILLED' })).toEqual({ status: 422, code: 'TRANSITION_OUTCOME_REFUSED' });
    expect(await refuse({ actualOutcome: 'Commute halved', outcomeCode: 'CONFIRMED', transitionContractId: 'shared.decision.unknown' }))
      .toEqual({ status: 422, code: 'TRANSITION_CONTRACT_UNKNOWN' });
    expect(await refuse({ actualOutcome: 'Commute halved', outcomeCode: 'CONFIRMED', transitionContractId: 'shared.commitment.resolution' }))
      .toEqual({ status: 422, code: 'TRANSITION_SOURCE_FRAME_TYPE_REFUSED' });
    // No contracts given and none of the published snapshot's allow it: refused, never waved through.
    expect(await refuse({ actualOutcome: 'Commute halved', outcomeCode: 'CONFIRMED' }, api({ transitionContracts: null })))
      .toEqual({ status: 422, code: 'TRANSITION_CONTRACT_UNKNOWN' });
    expect(await refuse({ outcomeCode: 'CONFIRMED' })).toEqual({ status: 400, code: 'DECISION_INPUT_INVALID' });
    const unpredicted = await recordDecision(o, { question: 'Paint the flat?', options: ['Blue', 'White'] });
    const response = await api().inject({ method: 'POST', url: '/v1/decisions/' + unpredicted.decision.decisionFrameInstanceId + '/review',
      headers: headers(o, 'decisions.record'), payload: { actualOutcome: 'White', outcomeCode: 'CONFIRMED' } });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe('DECISION_PREDICTION_MISSING');
    // Nothing of any refusal was written.
    expect((await admin.query('SELECT count(*)::int n FROM resolution_assertions WHERE owner_scope_id=$1', [o.owner])).rows[0].n).toBe(0);
  });
});

describe('CRT-DEC-03-A: the mentor labels evidence, inference and recommendation and stays within the attention budget', () => {
  /** Four weeks of work on the calendar and nearly nothing else. */
  async function workHeavyCalendar(o: Owner): Promise<void> {
    for (let index = 1; index <= 6; index++) await calendarEvent(o, 'WORK', new Date(Date.now() - index * 3 * DAY), 120);
    await calendarEvent(o, 'HEALTH', new Date(Date.now() - 4 * DAY), 30);
  }

  it('surfaces a goal the calendar contradicts, with evidence, inference and recommendation labelled distinctly', async () => {
    const o = await makeOwner('Mentor Owner');
    await workHeavyCalendar(o);
    const fitness = await goal(o, { title: 'Get fit', domain: 'HEALTH', priority: 'HIGH', reason: 'Doctor asked me to.' });
    await goal(o, { title: 'Ship the product', domain: 'WORK', priority: 'HIGH' });
    await goal(o, { title: 'Learn piano', domain: 'PERSONAL', priority: 'LOW' });
    const view = await mentor(o);
    expect(view.cards).toHaveLength(1);
    const card = view.cards[0]!;
    expect(card).toMatchObject({ goalId: fitness.goalId, goalTitle: 'Get fit', decision: 'ASK', reason: 'WITHIN_ATTENTION_BUDGET',
      sensitivityScope: 'HEALTH/PRIVATE', cardKind: 'GOAL_CALENDAR_CONTRADICTION' });
    // Three values, three labels, three different texts.
    expect(card.evidence.map(item => [item.label, item.kind])).toEqual([['EVIDENCE', 'STATED_GOAL'], ['EVIDENCE', 'CALENDAR_ALLOCATION']]);
    expect(card.inference.label).toBe('INFERENCE');
    expect(card.recommendation.label).toBe('RECOMMENDATION');
    expect(new Set([...card.evidence.map(item => item.text), card.inference.text, card.recommendation.text]).size).toBe(4);
    expect(card.evidence[0]!.text).toContain('You set "Get fit" (Health) to high priority');
    expect(card.evidence[1]!.text).toContain('7 calendar events took 12.5 hours');
    expect(card.evidence[1]!.text).toContain('Work 12 hours across 6 events');
    expect(card.inference).toMatchObject({ goalMinutes: 30, totalMinutes: 750, sharePercent: 4, eventCount: 7, confidence: 0.8,
      counterexampleSearch: expect.objectContaining({ counterexamplesFound: 1 }) });
    expect(card.inference.text).toContain('This is a reading of your calendar, not of your intentions');
    expect(card.recommendation.text).toContain('put time for it on your calendar');
    // Evidence names what it rests on: the goal, its priority statement and the calendar propositions.
    expect(card.evidence[0]!.grounds).toEqual([{ objectType: 'goal', objectId: fitness.goalId },
      { objectType: 'goal_priority_history', objectId: fitness.priorityHistory[0]!.goalPriorityHistoryId }]);
    expect(card.evidence[1]!.grounds).toHaveLength(7);
    expect(card.policyInputs).toMatchObject({ consequence: 'HIGH', budget: expect.objectContaining({ askedToday: 0 }) });

    // The Goals screen flags the contradicted goal.
    const goals = goalsViewSchema.parse((await api().inject({ method: 'GET', url: '/v1/goals', headers: headers(o, 'goals.read') })).json());
    expect(goals.goals.find(entry => entry.goalId === fitness.goalId)!.contradiction).toMatchObject({ decision: 'ASK', mentorCardId: card.mentorCardId });
    expect(goals.goals.filter(entry => entry.contradiction !== null)).toHaveLength(1);

    // Reloading spends nothing: the card is shown again, nothing new is recorded.
    const again = await mentor(o);
    expect(again.cards.map(entry => entry.mentorCardId)).toEqual([card.mentorCardId]);
    expect((await admin.query('SELECT count(*)::int n FROM mentor_cards WHERE owner_scope_id=$1', [o.owner])).rows[0].n).toBe(1);
  });

  it('emits no more proactive items than the budget allows, per day and per sensitivity scope, and records why the rest were withheld', async () => {
    const daily = await makeOwner('Mentor Daily Budget');
    await workHeavyCalendar(daily);
    await goal(daily, { title: 'Get fit', domain: 'HEALTH', priority: 'HIGH' });
    await goal(daily, { title: 'Family dinners', domain: 'FAMILY', priority: 'HIGH' });
    const budget = await api().inject({ method: 'PATCH', url: '/v1/settings/attention-budgets', headers: headers(daily, 'settings.attention'),
      payload: { maxCardsPerDay: 1 } });
    expect(budget.statusCode, budget.body).toBe(200);
    const view = await mentor(daily);
    expect(view.cards).toHaveLength(1);
    expect(view.withheld).toHaveLength(1);
    expect(view.withheld[0]).toMatchObject({ decision: 'BATCH', reason: 'DAILY_BUDGET_EXHAUSTED' });
    expect(view).toMatchObject({ proactiveItemsToday: 1, remainingToday: 0 });

    const scoped = await makeOwner('Mentor Scope Budget');
    await workHeavyCalendar(scoped);
    await goal(scoped, { title: 'Get fit', domain: 'HEALTH', priority: 'HIGH' });
    await goal(scoped, { title: 'Sleep eight hours', domain: 'HEALTH', priority: 'HIGH' });
    const scopedView = await mentor(scoped);
    expect(scopedView.cards).toHaveLength(1);
    expect(scopedView.withheld.map(card => card.reason)).toEqual(['SCOPE_BUDGET_EXHAUSTED']);
    // Every decision is on record with its logged inputs.
    const logged = (await admin.query('SELECT decision,reason,policy_inputs FROM mentor_cards WHERE owner_scope_id=$1 ORDER BY decided_at,id',
      [scoped.owner])).rows;
    expect(logged.map(row => row.decision)).toEqual(['ASK', 'BATCH']);
    for (const row of logged) expect(Object.keys(row.policy_inputs)).toEqual(expect.arrayContaining(
      ['errorProbability', 'consequence', 'irreversibility', 'urgency', 'interruptionCost', 'budget']));
  });

  it('shares one budget with the Memory inbox, respects a temporary override and never builds a pattern from one event', async () => {
    const shared = await makeOwner('Mentor Shared Budget');
    await workHeavyCalendar(shared);
    await goal(shared, { title: 'Get fit', domain: 'HEALTH', priority: 'HIGH' });
    await api().inject({ method: 'PATCH', url: '/v1/settings/attention-budgets', headers: headers(shared, 'settings.attention'),
      payload: { maxCardsPerDay: 1 } });
    expect((await mentor(shared)).cards).toHaveLength(1);
    // An unconfirmed finance value the inbox would otherwise ask about today.
    const source = await evidence(shared, ['PERSONAL_ASSISTANCE', 'PERSONAL_FINANCE'], 'Daniel lent me 40');
    const obligation = uuidV7(), slot = uuidV7(), proposition = uuidV7(), transaction = randomUUID();
    await admin.query('INSERT INTO frame_instances(id,owner_scope_id,frame_type_id,context_space_id) VALUES($1,$2,$3,$4)',
      [obligation, shared.owner, 'shared.obligation', shared.contextSpaceId]);
    await admin.query(`INSERT INTO belief_slots(id,owner_scope_id,frame_instance_id,predicate_id,context_space_id,modality)
      VALUES($1,$2,$3,'shared.obligation.principal_amount',$4,'ACTUAL')`, [slot, shared.owner, obligation, shared.contextSpaceId]);
    await admin.query('INSERT INTO propositions(id,owner_scope_id,belief_slot_id,normalized_value) VALUES($1,$2,$3,$4)',
      [proposition, shared.owner, slot, JSON.stringify({ amount: '40.00', currency: 'ILS' })]);
    await admin.query(`INSERT INTO claims(id,owner_scope_id,source_anchor_id,proposition_id,claim_origin,lifecycle)
      VALUES($1,$2,$3,$4,'USER_STATEMENT','PROVISIONAL')`, [uuidV7(), shared.owner, source.anchorId, proposition]);
    await admin.query(`INSERT INTO belief_transactions(id,owner_scope_id,transaction_kind,requested_by_actor_id,registry_release_id,status,risk,
      idempotency_key,commit_receipt,committed_at) VALUES($1,$2,'CANONICALIZE',$3,$4,'COMMITTED','LOW',$5,'{}',now())`,
      [transaction, shared.owner, shared.userId, randomUUID(), randomUUID().replaceAll('-', '')]);
    await admin.query(`INSERT INTO belief_assessments(id,owner_scope_id,proposition_id,assessment_status,policy_version,transaction_id,decision_reason)
      VALUES($1,$2,$3,'CANDIDATE','local-policy-0.1.0',$4,'{"code":"FIXTURE"}')`, [randomUUID(), shared.owner, proposition, transaction]);
    const inbox = await api().inject({ method: 'GET', url: '/v1/memory/inbox?timeZone=UTC', headers: headers(shared, 'memory.inbox') });
    expect(inbox.statusCode, inbox.body).toBe(200);
    const inboxView = memoryInboxViewSchema.parse(inbox.json());
    // The mentor's card spent the day's one proactive item.
    expect(inboxView.cards).toEqual([]);
    expect(inboxView.remainingToday).toBe(0);
    expect((await admin.query('SELECT decision,reason FROM interruption_decisions WHERE owner_scope_id=$1', [shared.owner])).rows)
      .toEqual([{ decision: 'BATCH', reason: 'DAILY_BUDGET_EXHAUSTED' }]);

    // An explicit temporary override is the owner saying "not now".
    const resting = await makeOwner('Mentor Override');
    await workHeavyCalendar(resting);
    const rest = await goal(resting, { title: 'Get fit', domain: 'HEALTH', priority: 'HIGH',
      temporaryOverride: { priority: 'LOW', reason: 'Recovering from an injury.', until: new Date(Date.now() + 10 * DAY).toISOString() } });
    const restingView = await mentor(resting);
    expect(restingView.cards).toEqual([]);
    expect(restingView.withheld).toEqual([]);
    expect(restingView.respectedOverrides).toEqual([expect.objectContaining({ goalId: rest.goalId, priority: 'LOW' })]);

    // One event is not a pattern.
    const single = await makeOwner('Mentor Single Event');
    await calendarEvent(single, 'WORK', new Date(Date.now() - 2 * DAY), 480);
    await goal(single, { title: 'Get fit', domain: 'HEALTH', priority: 'HIGH' });
    const singleView = await mentor(single);
    expect(singleView.cards).toEqual([]);
    expect(singleView.withheld).toEqual([]);
    expect((await admin.query('SELECT count(*)::int n FROM mentor_cards WHERE owner_scope_id=$1', [single.owner])).rows[0].n).toBe(0);
  });
});
