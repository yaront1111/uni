import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { runMigrations } from '@unai/postgres';
import { postgresAdapter, SESSION_COOKIE } from '@unai/auth';
import { weeklyReviewSchema, type WeeklyReview } from '@unai/domain';
import { uuidV7 } from '../../../src/kernel/identities.js';
import { createPlatformApi } from './platform.js';

/**
 * The weekly review over the real boundary (PRD §7.5, §39; design GET
 * /v1/weekly-review): the Context Broker reads the fixture week under
 * `memory.read`, the review is composed from the packet as persisted, and it is
 * recorded under `review.weekly` with its behavioral observations.
 *
 * The groundedness check here is independent of the one the service makes: it
 * reads the stored packet JSON straight from `context_packets` and holds every
 * statement's grounds against the objects that JSON names.
 *
 * Covers CRT-UX-05-A and CRT-UX-06-A.
 */

if (!process.env.UNAI_TEST_DATABASE_URL) throw new Error('Run pnpm test for the required PostgreSQL harness');
const admin = new Pool({ connectionString: process.env.UNAI_TEST_DATABASE_URL });
const url = new URL(process.env.UNAI_TEST_DATABASE_URL); url.username = 'weekly_review_test_app'; url.password = 'test-only';
const appPool = new Pool({ connectionString: url.href });

let owner = '', userId = '', token = '', contextSpaceId = '', transactionId = '', ownerEntity = '';
const evidenceFor: Record<'WORK' | 'FAMILY' | 'FINANCE', string> = { WORK: '', FAMILY: '', FINANCE: '' };
const WEEK = '2026-03-02';
const ids: Record<string, string> = {};

beforeAll(async () => {
  await runMigrations(admin, resolve('migrations'));
  await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='weekly_review_test_app') THEN CREATE ROLE weekly_review_test_app LOGIN PASSWORD 'test-only'; END IF; END $$; GRANT unai_app TO weekly_review_test_app");
  const adapter = postgresAdapter(admin);
  const user = await adapter.createUser!({ name: 'Weekly Review', email: 'weekly.review@example.test', emailVerified: null });
  userId = user.id;
  owner = (user as unknown as { ownerScopeId: string }).ownerScopeId;
  token = randomBytes(32).toString('base64url');
  await adapter.createSession!({ userId: user.id, sessionToken: token, expires: new Date(Date.now() + 604800000) });
  contextSpaceId = (await admin.query("SELECT id FROM context_spaces WHERE owner_scope_id=$1 AND context_kind='BASE'", [owner])).rows[0].id;
  transactionId = randomUUID();
  await admin.query(`INSERT INTO belief_transactions(id,owner_scope_id,transaction_kind,requested_by_actor_id,registry_release_id,
    status,risk,idempotency_key,commit_receipt,committed_at) VALUES($1,$2,'CANONICALIZE',$3,$4,'COMMITTED','LOW',$5,'{}',now())`,
    [transactionId, owner, userId, randomUUID(), randomUUID().replaceAll('-', '')]);
  ownerEntity = uuidV7();
  await admin.query("INSERT INTO entities(id,owner_scope_id,entity_kind,canonical_label) VALUES($1,$2,'PERSON','Owner')", [ownerEntity, owner]);
  for (const [category, purpose] of [['WORK', 'WORK_ASSISTANCE'], ['FAMILY', 'FAMILY_COORDINATION'], ['FINANCE', 'PERSONAL_FINANCE']] as const) {
    const evidenceId = randomUUID(), connectorId = randomUUID();
    await admin.query("INSERT INTO connectors(id,owner_scope_id,connector_type,external_account_ref,permission_manifest,status) VALUES($1,$2,'CONVERSATION',$3,'{}','ACTIVE')",
      [connectorId, owner, randomUUID()]);
    await admin.query(`INSERT INTO source_items(id,owner_scope_id,connector_id,source_type,external_id,actor_ref,submitted_by_user_id,
      raw_object_ref,content_hash,sensitivity,allowed_purposes,ingestion_version,idempotency_key)
      VALUES($1,$2,$3,'CONVERSATION',$4,$5,$6,$7,$8,'PRIVATE',$9,'evidence-json-v1',$10)`,
      [evidenceId, owner, connectorId, 'week-' + category, JSON.stringify({ type: 'USER', id: userId }), userId, randomUUID(),
        randomBytes(32).toString('hex'), ['PERSONAL_ASSISTANCE', purpose], randomUUID()]);
    evidenceFor[category] = evidenceId;
  }

  // Three commitments. The quarterly report is low priority and its due time was
  // moved once, into this week, where it passes without an outcome; the school
  // forms are the owner's stated high priority; calling the bank was fulfilled
  // this week.
  ids['report'] = await commitment('WORK', 'Ship the quarterly report', 'low',
    [['2026-03-03T17:00:00.000Z', '2026-02-20T09:00:00.000Z'], ['2026-03-04T17:00:00.000Z', '2026-03-02T09:00:00.000Z']]);
  ids['forms'] = await commitment('FAMILY', 'Prepare the school forms', 'high', [['2026-03-20T17:00:00.000Z', '2026-02-25T09:00:00.000Z']]);
  ids['bank'] = await commitment('FINANCE', 'Call the bank', null, []);
  const bankAction = (await admin.query(`SELECT p.id FROM propositions p JOIN belief_slots s ON s.owner_scope_id=p.owner_scope_id
    AND s.id=p.belief_slot_id WHERE s.owner_scope_id=$1 AND s.frame_instance_id=$2`, [owner, ids['bank']])).rows[0].id as string;
  const resolutionClaim = await claimFor('FINANCE', bankAction, '2026-03-04T08:00:00.000Z');
  ids['resolution'] = uuidV7();
  await admin.query(`INSERT INTO resolution_assertions(id,owner_scope_id,source_frame_instance_id,outcome_code,effective_at,
    asserted_by_entity_id,claim_id,transition_contract_id,lifecycle) VALUES($1,$2,$3,'FULFILLED','2026-03-04T08:00:00.000Z',$4,$5,
    'shared.commitment.resolution','ACCEPTED')`, [ids['resolution'], owner, ids['bank'], ownerEntity, resolutionClaim]);

  // Calendar: ten hours of work, one hour of family.
  await event('WORK', { start: '2026-03-03T09:00:00.000Z', end: '2026-03-03T19:00:00.000Z' });
  await event('FAMILY', { start: '2026-03-05T16:00:00.000Z', end: '2026-03-05T17:00:00.000Z' });

  // An obligation corrected from ₪50 to ₪60 during the week, due inside it, and
  // a ₪60 allocation observed two days later.
  const obligation = await frame('shared.obligation');
  const principal = await slot(obligation, 'shared.obligation.principal_amount', 'ACTUAL');
  await value(principal, { amount: '50.00', currency: 'ILS' }, 'FINANCE', { claimFrom: '2026-02-01T09:00:00.000Z',
    assessment: 'ACCEPTED', assessmentTo: '2026-03-04T00:00:00.000Z' });
  await value(principal, { amount: '60.00', currency: 'ILS' }, 'FINANCE', { claimFrom: '2026-03-04T00:00:00.000Z',
    assessment: 'ACCEPTED', assessmentFrom: '2026-03-04T00:00:00.000Z' });
  await value(await slot(obligation, 'shared.obligation.due_time', 'ACTUAL'), { time: '2026-03-05T12:00:00.000Z' }, 'FINANCE',
    { claimFrom: '2026-02-01T09:00:00.000Z', assessment: 'ACCEPTED' });
  const allocation = await frame('finance.payment_allocation');
  await value(await slot(allocation, 'finance.payment_allocation.allocated_amount', 'ACTUAL'), { amount: '60.00', currency: 'ILS' }, 'FINANCE',
    { claimFrom: '2026-03-06T10:00:00.000Z', assessment: 'ACCEPTED' });
});
afterAll(async () => { await appPool.end(); await admin.end(); });

async function frame(frameTypeId: string): Promise<string> {
  const id = uuidV7();
  await admin.query('INSERT INTO frame_instances(id,owner_scope_id,frame_type_id,context_space_id) VALUES($1,$2,$3,$4)', [id, owner, frameTypeId, contextSpaceId]);
  return id;
}
async function slot(frameInstanceId: string, predicateId: string, modality: string): Promise<string> {
  const id = uuidV7();
  await admin.query(`INSERT INTO belief_slots(id,owner_scope_id,frame_instance_id,predicate_id,context_space_id,modality)
    VALUES($1,$2,$3,$4,$5,$6)`, [id, owner, frameInstanceId, predicateId, contextSpaceId, modality]);
  return id;
}
let anchorCount = 0;
async function claimFor(category: keyof typeof evidenceFor, propositionId: string, validFrom: string): Promise<string> {
  const anchorId = randomUUID(), claimId = uuidV7();
  await admin.query(`INSERT INTO source_anchors(id,owner_scope_id,source_item_id,anchor_kind,anchor) VALUES($1,$2,$3,'MESSAGE_SPAN',$4)`,
    [anchorId, owner, evidenceFor[category], JSON.stringify({ start: 0, end: ++anchorCount })]);
  await admin.query(`INSERT INTO claims(id,owner_scope_id,source_anchor_id,proposition_id,claim_origin,lifecycle,valid_from)
    VALUES($1,$2,$3,$4,'USER_STATEMENT','PROVISIONAL',$5)`, [claimId, owner, anchorId, propositionId, validFrom]);
  return claimId;
}
async function value(slotId: string, normalized: unknown, category: keyof typeof evidenceFor, input: {
  claimFrom: string; assessment?: 'ACCEPTED' | 'SUPERSEDED'; assessmentFrom?: string; assessmentTo?: string;
}): Promise<string> {
  const id = uuidV7();
  await admin.query('INSERT INTO propositions(id,owner_scope_id,belief_slot_id,normalized_value) VALUES($1,$2,$3,$4)', [id, owner, slotId, JSON.stringify(normalized)]);
  await claimFor(category, id, input.claimFrom);
  if (input.assessment) {
    await admin.query(`INSERT INTO belief_assessments(id,owner_scope_id,proposition_id,assessment_status,policy_version,transaction_id,
      valid_from,valid_to) VALUES($1,$2,$3,$4,'local-policy-0.1.0',$5,$6,$7)`,
      [randomUUID(), owner, id, input.assessment, transactionId, input.assessmentFrom ?? null, input.assessmentTo ?? null]);
  }
  return id;
}
/** A commitment with its action, an optional stated priority, and each due time
 * it was ever given with the instant it was stated. */
async function commitment(category: keyof typeof evidenceFor, action: string, priority: string | null,
  dues: Array<[string, string]>): Promise<string> {
  const id = await frame('shared.commitment');
  await value(await slot(id, 'shared.commitment.action_description', 'COMMITTED'), { text: action }, category, { claimFrom: '2026-02-01T09:00:00.000Z', assessment: 'ACCEPTED' });
  if (priority) await value(await slot(id, 'shared.commitment.priority', 'COMMITTED'), { text: priority }, category, { claimFrom: '2026-02-01T09:00:00.000Z', assessment: 'ACCEPTED' });
  if (dues.length > 0) {
    const dueSlot = await slot(id, 'shared.commitment.due_time', 'COMMITTED');
    for (const [index, [time, statedAt]] of dues.entries()) {
      await value(dueSlot, { time }, category, { claimFrom: statedAt, assessment: index === dues.length - 1 ? 'ACCEPTED' : 'SUPERSEDED' });
    }
  }
  return id;
}
async function event(category: keyof typeof evidenceFor, interval: { start: string; end: string }): Promise<void> {
  const id = await frame('shared.event_occurrence');
  await value(await slot(id, 'shared.event_occurrence.occurrence_time', 'SCHEDULED'), interval, category,
    { claimFrom: '2026-02-01T09:00:00.000Z', assessment: 'ACCEPTED' });
}

function api() {
  const app = createPlatformApi({ authPool: admin, appPool, registryReleaseId: randomUUID(), registryRelease: '0.1.0' });
  app.addHook('onRequest', async request => { Object.defineProperty(request.raw.socket, 'encrypted', { value: true }); });
  return app;
}
function headers(purpose = 'review.weekly') {
  return {
    cookie: SESSION_COOKIE + '=' + token, 'x-owner-scope-id': owner, 'x-purpose': purpose, 'x-correlation-id': randomUUID(),
    'x-data-purpose': 'PERSONAL_ASSISTANCE', 'x-maximum-sensitivity': 'RESTRICTED',
  };
}
async function review(): Promise<WeeklyReview> {
  const response = await api().inject({ method: 'GET', url: '/v1/weekly-review?weekStart=' + WEEK + '&timeZone=UTC', headers: headers() });
  expect(response.statusCode, response.body).toBe(200);
  return weeklyReviewSchema.parse(response.json());
}

/** Every object the stored packet names, read from the stored JSON itself. */
async function persistedObjects(packetId: string): Promise<Set<string>> {
  const row = (await admin.query('SELECT packet FROM context_packets WHERE owner_scope_id=$1 AND id=$2', [owner, packetId])).rows[0];
  const packet = row.packet as Record<string, Array<Record<string, unknown>>>;
  const named = new Set<string>();
  for (const item of [...packet['currentBeliefs']!, ...packet['historicalBeliefs']!, ...packet['futureClaims']!]) {
    named.add(item['propositionId'] as string); named.add(item['frameInstanceId'] as string);
    for (const id of [...(item['claimIds'] as string[] | undefined ?? []), ...(item['evidenceIds'] as string[] | undefined ?? [])]) named.add(id);
  }
  for (const resolution of packet['resolutionAssertions']!) {
    named.add(resolution['resolutionAssertionId'] as string); named.add(resolution['sourceFrameInstanceId'] as string);
  }
  for (const delta of packet['ownerOverlayDeltas']!) named.add(delta['overlayDeltaId'] as string);
  return named;
}
function allStatements(weekly: WeeklyReview) {
  return [weekly.priorityVersusCalendar, weekly.commitmentsVersusResolutions, weekly.decisionsVersusOutcomes,
    weekly.plannedVersusObservedSpending, weekly.materialChanges, weekly.repeatedPostponement].flatMap(section => section.statements);
}

describe('CRT-UX-05-A: the weekly review of a fixture week', () => {
  it('compares stated priorities with calendar allocation, open commitments with completed resolutions, and reports material changes', async () => {
    const weekly = await review();
    expect(weekly).toMatchObject({ weekStart: '2026-03-02', weekEnd: '2026-03-08', timeZone: 'UTC' });
    const texts = (section: { statements: Array<{ text: string }> }) => section.statements.map(statement => statement.text);

    expect(weekly.priorityVersusCalendar.availability).toBe('AVAILABLE');
    expect(texts(weekly.priorityVersusCalendar)).toEqual(expect.arrayContaining([
      'Family: you stated 1 high-priority commitment ("Prepare the school forms"), and 1 hour of the 11 hours scheduled this week (9%) went to family.',
      'Scheduled this week: Family 1 hour across 1 event; Work 10 hours across 1 event.']));
    expect(weekly.priorityVersusCalendar.allocation).toEqual(expect.arrayContaining([
      expect.objectContaining({ lifeCategory: 'WORK', scheduledMinutes: 600, eventCount: 1, statedPriorityCommitments: 1, highPriorityCommitments: 0 }),
      expect.objectContaining({ lifeCategory: 'FAMILY', scheduledMinutes: 60, eventCount: 1, highPriorityCommitments: 1 })]));

    expect(weekly.commitmentsVersusResolutions).toMatchObject({ availability: 'AVAILABLE', completedCount: 1, openCount: 2, slippingCount: 1 });
    expect(texts(weekly.commitmentsVersusResolutions)).toEqual(expect.arrayContaining([
      'Completed: "Call the bank" (fulfilled on 2026-03-04).',
      'Slipping: "Ship the quarterly report" was due 2026-03-04 and has no recorded outcome.',
      '1 commitment was completed this week; 2 remain open, 1 of them past a due time inside the week.']));
    const completed = weekly.commitmentsVersusResolutions.statements.find(statement => statement.text.startsWith('Completed'))!;
    expect(completed.grounds).toEqual(expect.arrayContaining([{ objectType: 'resolution_assertion', objectId: ids['resolution'] }]));

    expect(weekly.decisionsVersusOutcomes).toMatchObject({ availability: 'NOT_AVAILABLE_IN_THIS_RELEASE', statements: [] });
    expect(texts(weekly.plannedVersusObservedSpending)).toEqual(expect.arrayContaining([
      'Planned: ₪60 due 2026-03-05.', 'Observed: ₪60 allocated to an obligation on 2026-03-06.']));
    expect(texts(weekly.materialChanges)).toContain('Changed (Finance): the obligation principal amount was ₪50 until 2026-03-04 and is now ₪60.');
  });

  it('grounds every statement in the persisted packet manifest', async () => {
    const weekly = await review();
    const statements = allStatements(weekly);
    expect(statements.length).toBeGreaterThanOrEqual(9);
    expect(weekly.statementCount).toBe(statements.length);
    // The service's own manifest, and an independent reading of the stored packet.
    const named = await persistedObjects(weekly.contextPacketId);
    for (const statement of statements) {
      expect(statement.grounds.length, statement.statementId).toBeGreaterThan(0);
      for (const ground of statement.grounds) expect(named.has(ground.objectId), statement.statementId + ' ' + ground.objectId).toBe(true);
    }
    const row = (await admin.query(`SELECT context_packet_id,packet_hash,statement_count,manifest FROM weekly_reviews WHERE owner_scope_id=$1 AND id=$2`,
      [owner, weekly.weeklyReviewId])).rows[0];
    const packet = (await admin.query('SELECT packet_hash FROM context_packets WHERE id=$1', [weekly.contextPacketId])).rows[0];
    expect(row).toMatchObject({ context_packet_id: weekly.contextPacketId, packet_hash: packet.packet_hash, statement_count: statements.length });
    expect(row.manifest.packetId).toBe(weekly.contextPacketId);
    // Recorded as a read of memory and a review, never as a write to memory.
    const audited = (await admin.query(`SELECT purpose FROM audit_events WHERE owner_scope_id=$1 AND objects_and_fields_accessed::text LIKE $2`,
      [owner, '%' + weekly.weeklyReviewId + '%'])).rows.map(entry => entry.purpose);
    expect(audited).toEqual(['review.weekly']);
  });

  it('refuses a review without a week, without an evidence context, or under another purpose', async () => {
    const noWeek = await api().inject({ method: 'GET', url: '/v1/weekly-review', headers: headers() });
    expect(noWeek.statusCode).toBe(400);
    const badWeek = await api().inject({ method: 'GET', url: '/v1/weekly-review?weekStart=2026-02-30', headers: headers() });
    expect(badWeek.statusCode).toBe(400);
    const { 'x-data-purpose': _dropped, ...withoutContext } = headers();
    const noContext = await api().inject({ method: 'GET', url: '/v1/weekly-review?weekStart=' + WEEK, headers: withoutContext });
    expect(noContext.statusCode).toBe(400);
    expect(noContext.json().code).toBe('REVIEW_CONTEXT_REQUIRED');
    const purpose = await api().inject({ method: 'GET', url: '/v1/weekly-review?weekStart=' + WEEK, headers: headers('memory.read') });
    expect(purpose.statusCode).toBe(403);
  });
});

describe('CRT-UX-06-A: behavioral observations', () => {
  it('a single postponement episode produces no observation', async () => {
    const weekly = await review();
    expect(weekly.repeatedPostponement.episodeCount).toBe(1);
    expect(weekly.repeatedPostponement.statements.map(statement => statement.text))
      .toEqual(['Postponed: "Ship the quarterly report" moved from 2026-03-03 to 2026-03-04 (restated 2026-03-02).']);
    expect(weekly.behavioralObservations).toEqual([]);
    expect((await admin.query('SELECT count(*)::int AS n FROM behavioral_observations WHERE owner_scope_id=$1', [owner])).rows[0].n).toBe(0);
  });

  it('an emitted observation records more than one episode, its counterexample search, window, confidence and review date', async () => {
    // A second commitment moved later inside the window, and one due in the same
    // window that kept its date -- the counterexample the search must find.
    ids['passport'] = await commitment('FAMILY', 'Renew the passport', null,
      [['2026-03-01T12:00:00.000Z', '2026-02-10T09:00:00.000Z'], ['2026-03-12T12:00:00.000Z', '2026-02-28T09:00:00.000Z']]);
    ids['dentist'] = await commitment('FAMILY', 'Book the dentist', null, [['2026-03-06T08:00:00.000Z', '2026-02-15T09:00:00.000Z']]);
    const weekly = await review();
    expect(weekly.repeatedPostponement.episodeCount).toBe(2);
    expect(weekly.behavioralObservations).toHaveLength(1);
    const observation = weekly.behavioralObservations[0]!;
    expect(observation.supportingEpisodeIds.length).toBeGreaterThan(1);
    expect(observation.supportingEpisodes.map(episode => episode.frameInstanceId).sort()).toEqual([ids['report'], ids['passport']].sort());
    expect(observation.counterexampleSearch).toMatchObject({ counterexamplesFound: 1, counterexampleIds: [ids['dentist']] });
    expect(observation.observationWindow).toEqual({ from: '2026-02-09T00:00:00.000Z', to: '2026-03-09T00:00:00.000Z' });
    expect(observation.confidence).toBe(0.67);
    expect(observation.reviewOrExpiryDate).toBe('2026-04-05');
    expect(weekly.behavioralObservations.map(entry => entry.behavioralObservationId)).toHaveLength(1);

    const named = await persistedObjects(weekly.contextPacketId);
    for (const ground of observation.grounds) expect(named.has(ground.objectId)).toBe(true);
    const stored = (await admin.query(`SELECT supporting_episode_ids,counterexample_search,observation_window_start,observation_window_end,
      confidence::float AS confidence,review_or_expiry_date::text AS review,context_packet_id FROM behavioral_observations
      WHERE owner_scope_id=$1 AND id=$2`, [owner, observation.behavioralObservationId])).rows[0];
    expect(stored.supporting_episode_ids.sort()).toEqual([...observation.supportingEpisodeIds].sort());
    expect(stored.counterexample_search).toMatchObject({ counterexamplesFound: 1, counterexampleIds: [ids['dentist']] });
    expect(stored.observation_window_start.toISOString()).toBe('2026-02-09T00:00:00.000Z');
    expect(stored.observation_window_end.toISOString()).toBe('2026-03-09T00:00:00.000Z');
    expect(stored).toMatchObject({ confidence: 0.67, review: '2026-04-05', context_packet_id: weekly.contextPacketId });
    expect((await admin.query('SELECT behavioral_observation_ids FROM weekly_reviews WHERE id=$1', [weekly.weeklyReviewId])).rows[0]
      .behavioral_observation_ids).toEqual([observation.behavioralObservationId]);
  });
});
