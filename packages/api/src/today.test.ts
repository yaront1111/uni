import { Pool } from 'pg';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { runMigrations, withOwnerTransaction } from '@unai/postgres';
import { postgresAdapter, SESSION_COOKIE } from '@unai/auth';
import { applyProjectionDelta } from '@unai/capabilities';
import { todayBriefingSchema, whySourcesSchema, type BriefingItem, type TodayBriefing } from '@unai/domain';
// The registry library stays out of the API's manifest (registry-boundary.test.ts);
// only this test publishes the pinned release, through the package's own source.
import { loadRegistryRelease, publishRegistryRelease } from '../../registry/src/index.js';
import { uuidV7 } from '../../../src/kernel/identities.js';
import { createPlatformApi } from './platform.js';

/**
 * The Today briefing and the Why? / Sources panel over the real boundary, the
 * real owner transaction, the real Context Broker, the real typed projection
 * reducers and the real pinned registry release 0.1.0 (ADR 0027).
 *
 * The fixture owner lives in Asia/Tokyo and the briefing is built at 20:00 UTC,
 * which is 05:00 on the *next* calendar day in Tokyo: a briefing that used the
 * UTC date would show the wrong day.
 *
 *  - CRT-UX-01-A: the owner's local date and timezone; only current or imminent
 *    material items (not one due in a month, not a resolved one, not one above
 *    the request's ceiling); a past-due unresolved planned outcome; a reason on
 *    every item; at most three recommendations; a persisted packet manifest.
 *  - CRT-UX-01-B: a scheduled event is never worded as having happened, and an
 *    unchanged low-priority item shown yesterday is not repeated today.
 *  - CRT-UX-02-A: an older urgent high-consequence commitment ranks above a newer
 *    low-consequence one.
 *  - CRT-UX-11-A (Today half): Why? / Sources on a Today item opens the belief or
 *    the owner assertion with its claiming actor, source excerpt, effective time,
 *    confidence, conflict status, and the derivation path of an inferred value.
 */

if (!process.env.UNAI_TEST_DATABASE_URL) throw new Error('Run pnpm test for the required PostgreSQL harness');
const admin = new Pool({ connectionString: process.env.UNAI_TEST_DATABASE_URL });
const url = new URL(process.env.UNAI_TEST_DATABASE_URL); url.username = 'today_api_test_app'; url.password = 'test-only';
const appPool = new Pool({ connectionString: url.href });

const ZONE = 'Asia/Tokyo';
const ASSISTANCE = 'PERSONAL_ASSISTANCE';
const HOUR = 3_600_000;
/** 20:00 UTC, two days out: every fixture row is recorded before it, and in Tokyo
 * it is already the next calendar day. */
const NOW = (() => { const day = new Date(Date.now() + 2 * 24 * HOUR); day.setUTCHours(20, 0, 0, 0); return day; })();
const TOMORROW = new Date(NOW.getTime() + 24 * HOUR);
const at = (hours: number) => new Date(NOW.getTime() + hours * HOUR);
const RECORDED = new Date(Date.now() - 2 * HOUR);

let owner = '', actor = '', token = '', registryReleaseId = '', transactionId = '', baseContext = '';
let maya = '', daniel = '', dana = '';
let clock = NOW;
/** The fixture's frames and propositions by role. */
const f = { old: '', repeat: '', overdue: '', far: '', resolved: '', inferred: '', loan: '', dentist: '', planning: '', restricted: '' };
const p = { oldAction: '', inferredAction: '', principal450: '', principal540: '', planningTime: '' };
let dentistDelta = '', unattachedDelta = '', resolution = '', emailClaim = '';

function git(repository: string, ...args: string[]) {
  const result = spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=Registry Test', '-c', 'user.email=registry@test.invalid', ...args],
    { cwd: repository, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: '2024-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2024-01-01T00:00:00Z' } });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
/** The immutable 0.1.0 snapshot, published by whichever suite gets there first. */
async function pinnedRegistryRelease(): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const existing = (await admin.query("SELECT id FROM registry_releases WHERE semantic_version='0.1.0'")).rows[0];
    if (existing) return existing.id as string;
    await sleep(250);
  }
  const repository = await mkdtemp(join(tmpdir(), 'unai-today-registry-'));
  try {
    await cp(resolve('registry'), join(repository, 'registry'), { recursive: true });
    git(repository, 'init', '--quiet'); git(repository, 'add', 'registry');
    git(repository, 'commit', '--quiet', '-m', 'release'); git(repository, 'tag', 'registry-v0.1.0');
    const release = await loadRegistryRelease({ repository, version: '0.1.0' });
    try { return (await publishRegistryRelease(admin, release, randomUUID())).releaseId; }
    catch { return (await admin.query("SELECT id FROM registry_releases WHERE semantic_version='0.1.0'")).rows[0].id as string; }
  } finally { await rm(repository, { recursive: true, force: true }); }
}

/** One evidence item with one anchor carrying the words the Why? panel quotes. */
async function source(externalId: string, sourceType: string, words: string, purposes: string[], sensitivity = 'PRIVATE') {
  const evidenceId = uuidV7(), anchorId = uuidV7(), connectorId = randomUUID();
  await admin.query("INSERT INTO connectors(id,owner_scope_id,connector_type,external_account_ref,permission_manifest,status) VALUES($1,$2,'CONVERSATION',$3,'{}','ACTIVE')",
    [connectorId, owner, externalId]);
  await admin.query(`INSERT INTO source_items(id,owner_scope_id,connector_id,source_type,external_id,actor_ref,submitted_by_user_id,
    raw_object_ref,content_hash,sensitivity,allowed_purposes,ingestion_version,idempotency_key,occurred_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'evidence-json-v1',$12,$13)`,
    [evidenceId, owner, connectorId, sourceType, externalId, JSON.stringify({ type: 'USER', id: actor }), actor, randomUUID(),
      randomBytes(32).toString('hex'), sensitivity, purposes, randomUUID(), RECORDED]);
  await admin.query(`INSERT INTO source_anchors(id,owner_scope_id,source_item_id,anchor_kind,anchor,normalized_text)
    VALUES($1,$2,$3,'MESSAGE_SPAN',$4,$5)`, [anchorId, owner, evidenceId, JSON.stringify({ start: 0, end: words.length }), words]);
  return { evidenceId, anchorId };
}
async function frame(frameTypeId: string, createdAt: Date) {
  const id = uuidV7();
  await admin.query('INSERT INTO frame_instances(id,owner_scope_id,frame_type_id,context_space_id,created_at) VALUES($1,$2,$3,$4,$5)',
    [id, owner, frameTypeId, baseContext, createdAt]);
  return id;
}
async function role(frameInstanceId: string, roleId: string, entityId: string) {
  await admin.query('INSERT INTO frame_instance_roles(id,owner_scope_id,frame_instance_id,role_id,entity_id) VALUES($1,$2,$3,$4,$5)',
    [uuidV7(), owner, frameInstanceId, roleId, entityId]);
}
/** One value in one slot: the proposition, a claim anchored in `anchorId`, and --
 * unless `status` is null -- the assessment that stands over it. */
async function value(frameInstanceId: string, predicateId: string, modality: string, normalized: unknown, anchorId: string,
  status: string | null, origin = 'USER_STATEMENT', assertedBy: string | null = maya) {
  let slot = (await admin.query(`SELECT id FROM belief_slots WHERE owner_scope_id=$1 AND frame_instance_id=$2 AND predicate_id=$3`,
    [owner, frameInstanceId, predicateId])).rows[0]?.id as string | undefined;
  if (!slot) {
    slot = uuidV7();
    await admin.query(`INSERT INTO belief_slots(id,owner_scope_id,frame_instance_id,predicate_id,context_space_id,modality)
      VALUES($1,$2,$3,$4,$5,$6)`, [slot, owner, frameInstanceId, predicateId, baseContext, modality]);
  }
  const propositionId = uuidV7(), claimId = uuidV7();
  await admin.query('INSERT INTO propositions(id,owner_scope_id,belief_slot_id,normalized_value) VALUES($1,$2,$3,$4)',
    [propositionId, owner, slot, JSON.stringify(normalized)]);
  await admin.query(`INSERT INTO claims(id,owner_scope_id,source_anchor_id,proposition_id,claim_origin,lifecycle,valid_from,recorded_at,
    asserted_by_entity_id,extraction_confidence,temporal_resolution_confidence)
    VALUES($1,$2,$3,$4,$5,'PROVISIONAL',$6,$7,$8,0.93,0.88)`,
    [claimId, owner, anchorId, propositionId, origin, new Date(RECORDED.getTime() - 24 * HOUR), RECORDED, assertedBy]);
  if (status) {
    await admin.query(`INSERT INTO belief_assessments(id,owner_scope_id,proposition_id,assessment_status,valid_from,recorded_at,
      policy_version,decision_reason,transaction_id) VALUES($1,$2,$3,$4,$5,$6,'local-policy-0.1.0','{"code":"FIXTURE"}',$7)`,
      [uuidV7(), owner, propositionId, status, new Date(RECORDED.getTime() - 24 * HOUR), RECORDED, transactionId]);
  }
  return { propositionId, claimId };
}
async function commitment(input: { action: string; due: Date; createdAt: Date; anchorId: string; priority?: string;
  promisee?: string; origin?: string; status?: string }) {
  const id = await frame('shared.commitment', input.createdAt);
  await role(id, 'promisor', maya);
  if (input.promisee) await role(id, 'promisee', input.promisee);
  const action = await value(id, 'shared.commitment.action_description', 'COMMITTED', { text: input.action }, input.anchorId,
    input.status ?? 'ACCEPTED', input.origin);
  await value(id, 'shared.commitment.due_time', 'COMMITTED', { time: input.due.toISOString() }, input.anchorId, input.status ?? 'ACCEPTED', input.origin);
  if (input.priority) await value(id, 'shared.commitment.priority', 'COMMITTED', { text: input.priority }, input.anchorId, 'ACCEPTED', input.origin);
  return { id, action };
}
async function event(description: string, start: Date, anchorId: string, createdAt: Date) {
  const id = await frame('shared.event_occurrence', createdAt);
  const time = await value(id, 'shared.event_occurrence.occurrence_time', 'SCHEDULED',
    { start: start.toISOString(), end: new Date(start.getTime() + HOUR).toISOString() }, anchorId, 'ACCEPTED', 'STRUCTURED_CONNECTOR_OBSERVATION', null);
  await value(id, 'shared.event_occurrence.description', 'SCHEDULED', { text: description }, anchorId, 'ACCEPTED', 'STRUCTURED_CONNECTOR_OBSERVATION', null);
  return { id, time };
}
async function person(label: string) {
  const id = uuidV7();
  await admin.query("INSERT INTO entities(id,owner_scope_id,entity_kind,canonical_label) VALUES($1,$2,'PERSON',$3)", [id, owner, label]);
  return id;
}

beforeAll(async () => {
  await runMigrations(admin, resolve('migrations'));
  await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='today_api_test_app') THEN CREATE ROLE today_api_test_app LOGIN PASSWORD 'test-only'; END IF; END $$; GRANT unai_app TO today_api_test_app");
  const adapter = postgresAdapter(admin);
  const user = await adapter.createUser!({ name: 'Maya', email: 'today-api@example.test', emailVerified: null });
  actor = user.id;
  owner = (user as unknown as { ownerScopeId: string }).ownerScopeId;
  token = randomBytes(32).toString('base64url');
  await adapter.createSession!({ userId: user.id, sessionToken: token, expires: new Date(Date.now() + 604800000) });
  baseContext = (await admin.query("SELECT id FROM context_spaces WHERE owner_scope_id=$1 AND context_kind='BASE'", [owner])).rows[0].id;
  registryReleaseId = await pinnedRegistryRelease();
  transactionId = uuidV7();
  await admin.query(`INSERT INTO belief_transactions(id,owner_scope_id,transaction_kind,requested_by_actor_id,
    source_evidence_ids,registry_release_id,status,risk,idempotency_key,commit_receipt,committed_at)
    VALUES($1,$2,'CANONICALIZE',$3,'{}',$4,'COMMITTED','LOW',$5,'{}',$6)`,
    [transactionId, owner, actor, registryReleaseId, randomUUID().replaceAll('-', ''), RECORDED]);
  maya = await person('Maya'); daniel = await person('Daniel'); dana = await person('Dana');

  const personal = [ASSISTANCE], work = [ASSISTANCE, 'WORK_ASSISTANCE'], finance = [ASSISTANCE, 'PERSONAL_FINANCE'];
  const chat = await source('chat-lease', 'CONVERSATION', 'I will send Daniel the signed lease by this afternoon, it is urgent.', personal);
  const drill = await source('chat-drill', 'CONVERSATION', 'I promised to return the drill to Dana by the weekend.', personal);
  const passport = await source('chat-passport', 'CONVERSATION', 'Renew the passport next month.', personal);
  const plumber = await source('chat-plumber', 'CONVERSATION', 'Pay the plumber; paid him this morning in cash.', personal);
  const paper = await source('email-paper', 'EMAIL', 'Dana: could you order printer paper when you get a chance? Low priority.', work);
  const email = await source('email-board', 'EMAIL', 'Dana: the board expects the quarterly summary before tomorrow morning.', work);
  const loanChat = await source('chat-loan', 'CONVERSATION', 'Daniel lent me 450 for the car repair.', finance);
  const loanDoc = await source('loan-note.pdf', 'DOCUMENT', 'Loan note: principal 540 ILS, repayable to Daniel.', finance);
  const calendar = await source('calendar-dentist', 'CALENDAR_EVENT', 'Dentist appointment, clinic on Main Street.', personal);
  const planning = await source('calendar-planning', 'CALENDAR_EVENT', 'Planning call with the design team.', work);
  const clinic = await source('clinic-results', 'DOCUMENT', 'Collect the biopsy results from the clinic.', personal, 'RESTRICTED');
  const said = await source('owner-said', 'CONVERSATION', 'The dentist moved it to 16:00.', personal);
  const noa = await source('owner-noa', 'CONVERSATION', 'I told Noa I would call her back about the school trip.', personal);

  // Created first: old, urgent, high consequence. Created last: new, low consequence.
  const old = await commitment({ action: 'send Daniel the signed lease', due: at(6), createdAt: at(-240), anchorId: chat.anchorId,
    priority: 'high', promisee: daniel });
  f.old = old.id; p.oldAction = old.action.propositionId;
  f.overdue = (await commitment({ action: 'return the drill to Dana', due: at(-48), createdAt: at(-200), anchorId: drill.anchorId, promisee: dana })).id;
  f.far = (await commitment({ action: 'renew the passport', due: at(24 * 30), createdAt: at(-150), anchorId: passport.anchorId })).id;
  f.resolved = (await commitment({ action: 'pay the plumber', due: at(-24), createdAt: at(-120), anchorId: plumber.anchorId })).id;
  const inferred = await commitment({ action: 'prepare the quarterly board summary', due: at(10), createdAt: at(-90), anchorId: email.anchorId,
    origin: 'MODEL_INFERENCE' });
  f.inferred = inferred.id; p.inferredAction = inferred.action.propositionId;
  f.restricted = (await commitment({ action: 'collect the biopsy results', due: at(8), createdAt: at(-80), anchorId: clinic.anchorId })).id;
  f.repeat = (await commitment({ action: 'order printer paper', due: at(44), createdAt: at(-2), anchorId: paper.anchorId,
    priority: 'low', origin: 'EXTERNAL_PERSON_ASSERTION', promisee: dana })).id;

  // The inferred commitment's derivation: read by a model from Dana's email.
  emailClaim = uuidV7();
  await admin.query(`INSERT INTO claims(id,owner_scope_id,source_anchor_id,claim_origin,lifecycle,recorded_at,asserted_by_entity_id)
    VALUES($1,$2,$3,'EXTERNAL_PERSON_ASSERTION','CANDIDATE',$4,$5)`, [emailClaim, owner, email.anchorId, RECORDED, dana]);
  await admin.query(`INSERT INTO derived_proposition_dependencies(id,owner_scope_id,derived_proposition_id,input_claim_ids,
    evaluator_id,model_or_code_version,registry_release_id,calculation_inputs,created_by_transaction_id)
    VALUES($1,$2,$3,ARRAY[$4::uuid],'extraction.commitment_inference','fixture-model-1',$5,'{"rule":"deadline_request"}',$6)`,
    [uuidV7(), owner, p.inferredAction, emailClaim, registryReleaseId, transactionId]);

  // The plumber was paid: an accepted, target-less FULFILLED resolution.
  const paid = await value(f.resolved, 'shared.commitment.action_description', 'COMMITTED', { text: 'pay the plumber' }, plumber.anchorId, null);
  resolution = uuidV7();
  await admin.query(`INSERT INTO resolution_assertions(id,owner_scope_id,source_frame_instance_id,outcome_code,effective_at,
    asserted_by_entity_id,claim_id,transition_contract_id,lifecycle,creation_transaction_id,recorded_at)
    VALUES($1,$2,$3,'FULFILLED',$4,$5,$6,'shared.commitment.resolution','ACCEPTED',$7,$8)`,
    [resolution, owner, f.resolved, at(-30), maya, paid.claimId, transactionId, RECORDED]);

  // A loan whose principal two sources disagree about.
  f.loan = await frame('shared.obligation', at(-60));
  await role(f.loan, 'debtor', maya); await role(f.loan, 'creditor', daniel);
  await value(f.loan, 'shared.obligation.description', 'ACTUAL', { text: 'loan for the car repair' }, loanChat.anchorId, 'ACCEPTED');
  p.principal450 = (await value(f.loan, 'shared.obligation.principal_amount', 'ACTUAL', { amount: '450.00', currency: 'ILS' }, loanChat.anchorId, 'CONTESTED')).propositionId;
  p.principal540 = (await value(f.loan, 'shared.obligation.principal_amount', 'ACTUAL', { amount: '540.00', currency: 'ILS' }, loanDoc.anchorId,
    'CONTESTED', 'DOCUMENT_ASSERTION', null)).propositionId;
  await value(f.loan, 'shared.obligation.due_time', 'ACTUAL', { time: at(23).toISOString() }, loanChat.anchorId, 'ACCEPTED');

  // Two calendar events: one tomorrow morning, one whose time passed an hour ago
  // with nothing recorded about whether it took place.
  f.dentist = (await event('Dentist appointment', at(20), calendar.anchorId, at(-50))).id;
  const call = await event('Planning call with the design team', at(-5), planning.anchorId, at(-40));
  f.planning = call.id; p.planningTime = call.time.propositionId;

  // The owner's pending word on the dentist appointment, and one statement that
  // no frame holds yet.
  dentistDelta = uuidV7(); unattachedDelta = uuidV7();
  await admin.query(`INSERT INTO owner_overlay_deltas(id,owner_scope_id,owner_sequence,source_evidence_id,raw_text,delta_kind,
    lifecycle,target_object_type,target_object_id,attached_frame_instance_id,created_at)
    VALUES($1,$2,1,$3,'The dentist moved it to 16:00.','USER_ASSERTION','USER_ASSERTED','frame_instance',$4,$4,$5)`,
    [dentistDelta, owner, said.evidenceId, f.dentist, RECORDED]);
  await admin.query(`INSERT INTO owner_overlay_deltas(id,owner_scope_id,owner_sequence,source_evidence_id,raw_text,delta_kind,
    lifecycle,candidate_frame_types,created_at)
    VALUES($1,$2,2,$3,'I told Noa I would call her back about the school trip.','USER_ASSERTION','AWAITING_INSTANCE_RESOLUTION',
    ARRAY['shared.commitment'],$4)`, [unattachedDelta, owner, noa.evidenceId, RECORDED]);

  // The typed projections, reduced by the capabilities as a governed commit does.
  await withOwnerTransaction(appPool, { actorId: actor, ownerScopeId: owner, purpose: 'memory.project', correlationId: randomUUID() }, async tx => {
    for (const projectionName of ['open_commitments_projection', 'obligations_projection', 'schedule_projection'] as const) {
      await applyProjectionDelta(tx, { ownerScopeId: owner, projectionName, asOf: NOW });
    }
  });
});
afterAll(async () => { await appPool.end(); await admin.end(); });

function api() {
  const app = createPlatformApi({ authPool: admin, appPool, registryReleaseId, registryRelease: '0.1.0', todayClock: () => clock });
  app.addHook('onRequest', async request => { Object.defineProperty(request.raw.socket, 'encrypted', { value: true }); });
  return app;
}
const headers = (purpose: string, extra: Record<string, string> = {}) => ({
  cookie: SESSION_COOKIE + '=' + token, 'x-owner-scope-id': owner, 'x-purpose': purpose, 'x-correlation-id': randomUUID(),
  'x-data-purpose': ASSISTANCE, 'x-maximum-sensitivity': 'PRIVATE', ...extra,
});
const items = (briefing: TodayBriefing) => briefing.sections.flatMap(section => section.items);
const itemFor = (briefing: TodayBriefing, frameId: string) => items(briefing).find(item => item.itemObjectId === frameId);
async function today(app: ReturnType<typeof api>, query = '?timeZone=' + encodeURIComponent(ZONE)): Promise<TodayBriefing> {
  const response = await app.inject({ method: 'GET', url: '/v1/today' + query, headers: headers('memory.read') });
  expect(response.statusCode, response.body).toBe(200);
  return todayBriefingSchema.parse(response.json());
}
async function why(app: ReturnType<typeof api>, objectType: string, id: string, ceiling = 'PRIVATE') {
  const response = await app.inject({ method: 'GET', url: '/v1/memory/why/' + objectType + '/' + id,
    headers: headers('memory.inspect', { 'x-maximum-sensitivity': ceiling }) });
  expect(response.statusCode, response.body).toBe(200);
  return whySourcesSchema.parse(response.json());
}
/** Wording that says a scheduled thing happened, once the negated forms are gone. */
const HAPPENED = /\b(happened|took place|occurred|attended|was held|went ahead)\b/i;
const NEGATED = /not yet happened|nothing recorded says whether it took place/gi;

let first: TodayBriefing;

it('CRT-UX-01-A: builds the briefing on the owner\'s local date and timezone, not the UTC date', async () => {
  const app = api();
  try {
    clock = NOW;
    first = await today(app);
    const tokyoDate = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(NOW);
    expect(first.ownerLocalDate).toBe(tokyoDate);
    expect(first.ownerLocalDate).not.toBe(NOW.toISOString().slice(0, 10));
    expect(first.timeZone).toBe(ZONE);
    expect(first.utcOffset).toBe('+09:00');
    const edition = (await admin.query(`SELECT to_char(owner_local_date,'YYYY-MM-DD') AS date,timezone,utc_offset FROM briefing_editions WHERE id=$1`,
      [first.briefingEditionId])).rows[0];
    expect(edition).toEqual({ date: tokyoDate, timezone: ZONE, utc_offset: '+09:00' });
    // Due times are shown in Tokyo time: 20:00 UTC + 6h is 11:00 in Tokyo.
    expect(itemFor(first, f.old)!.targetLocal).toMatch(/, 11:00$/);
    // A later request without a timezone reuses the owner's last one.
    const remembered = await today(app, '');
    expect(remembered.timeZone).toBe(ZONE);
    // A date that is not the owner's current local date is refused, not guessed.
    const stale = await app.inject({ method: 'GET', url: '/v1/today?timeZone=' + ZONE + '&date=' + NOW.toISOString().slice(0, 10), headers: headers('memory.read') });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'TODAY_DATE_NOT_CURRENT', ownerLocalDate: tokyoDate });
  } finally { await app.close(); }
});

it('CRT-UX-01-A: shows only current or imminent material items, a past-due planned outcome and a reason for each', async () => {
  const shown = items(first);
  const ids = shown.map(item => item.itemObjectId);
  // Current or imminent: due within 48 hours, or overdue.
  for (const frameId of [f.old, f.overdue, f.inferred, f.repeat, f.loan, f.dentist, f.planning]) expect(ids, frameId).toContain(frameId);
  // Not material today: due in a month, already fulfilled, or above the ceiling.
  for (const frameId of [f.far, f.resolved, f.restricted]) expect(ids).not.toContain(frameId);
  expect(JSON.stringify(first)).not.toContain('biopsy');
  // Unresolved planned outcomes past their target time.
  const overdue = itemFor(first, f.overdue)!;
  expect(overdue).toMatchObject({ pastTarget: true, outcomeState: 'UNRESOLVED', kind: 'COMMITMENT' });
  expect(overdue.headline).toMatch(/was due .* and no resolution is recorded/);
  const call = itemFor(first, f.planning)!;
  expect(call).toMatchObject({ pastTarget: true, outcomeState: 'UNRESOLVED', kind: 'SCHEDULED_EVENT', certaintyLabel: 'SCHEDULED' });
  // A reason and a certainty label on every item.
  for (const item of shown) {
    expect(item.whySurfaced.length, item.headline).toBeGreaterThan(20);
    expect(item.certaintyLabel).toBeTruthy();
    expect(item.sourceRefs.length, item.headline).toBeGreaterThan(0);
  }
  expect(overdue.whySurfaced).toMatch(/due time .* has passed and no resolution is recorded/);
  expect(itemFor(first, f.loan)!.whySurfaced).toMatch(/Sources disagree/);
  // A disputed amount is stated as the dispute, never as one of its sides.
  expect(itemFor(first, f.loan)!.headline).toMatch(/\((ILS 450\.00 or ILS 540\.00|ILS 540\.00 or ILS 450\.00), sources disagree\)/);
  // Distinct labels reach the reader: confirmed, reported, inferred, contested,
  // pending owner assertion and scheduled.
  expect(itemFor(first, f.old)!.certaintyLabel).toBe('CONFIRMED');
  expect(itemFor(first, f.repeat)!.certaintyLabel).toBe('REPORTED');
  expect(itemFor(first, f.inferred)!.certaintyLabel).toBe('INFERRED');
  expect(itemFor(first, f.loan)!.certaintyLabel).toBe('CONTESTED');
  expect(itemFor(first, f.dentist)!.certaintyLabel).toBe('PENDING_OWNER_ASSERTION');
  // A small set: at most three per section, seven in all; the rest are deferred.
  expect(first.sections.every(section => section.items.length <= 3)).toBe(true);
  expect(shown.length).toBeLessThanOrEqual(7);
  expect(first.deferredByAttentionBudget).toBeGreaterThan(0);
  expect(first.sections.map(section => section.domain).sort()).toEqual(['FINANCE', 'PERSONAL', 'WORK']);
  // The incomplete schedule projection is said, with the owner's pending words.
  const schedule = first.projectionCompleteness.find(entry => entry.projectionName === 'schedule_projection')!;
  expect(schedule.isComplete).toBe(false);
  expect(schedule.pendingAssertions.map(entry => entry.rawText)).toContain('The dentist moved it to 16:00.');
});

it('CRT-UX-01-A: lists at most a few recommendations and withholds a high-risk one on contested support', async () => {
  expect(first.recommendations.length).toBeGreaterThan(0);
  expect(first.recommendations.length).toBeLessThanOrEqual(3);
  expect(first.recommendations.every(entry => entry.label === 'RECOMMENDED')).toBe(true);
  expect(first.withheldRecommendations).toContainEqual({ basedOnItemId: f.loan, risk: 'HIGH', reason: 'SUPPORT_CONTESTED' });
  expect(first.recommendations.some(entry => entry.basedOnItemId === f.loan)).toBe(false);
  const stored = (await admin.query('SELECT recommendations FROM briefing_editions WHERE id=$1', [first.briefingEditionId])).rows[0];
  expect(stored.recommendations).toEqual(first.recommendations);
});

it('CRT-UX-01-A: persists the context packet manifest the edition was built from', async () => {
  const row = (await admin.query('SELECT context_packet_id,packet_hash,packet_manifest FROM briefing_editions WHERE id=$1',
    [first.briefingEditionId])).rows[0];
  expect(row.context_packet_id).toBe(first.packetManifest.contextPacketId);
  expect(row.packet_manifest).toEqual(first.packetManifest);
  const packet = (await admin.query('SELECT packet_hash,purpose,answer_type_classification,packet FROM context_packets WHERE id=$1',
    [row.context_packet_id])).rows[0];
  // The packet is the Context Broker's own record, under the declared purpose.
  expect(packet).toMatchObject({ packet_hash: row.packet_hash, purpose: ASSISTANCE, answer_type_classification: 'OPEN_COMMITMENTS' });
  // Every item shown rests on memory the packet supplied.
  for (const item of items(first)) {
    if (item.itemObjectType === 'frame_instance') expect(first.packetManifest.frameInstanceIds).toContain(item.itemObjectId);
    for (const ref of item.sourceRefs.filter(entry => entry.objectType === 'propositions')) {
      expect(first.packetManifest.beliefIds, item.headline).toContain(ref.objectId);
    }
  }
  expect(first.packetManifest.overlayDeltaIds).toContain(dentistDelta);
  // Every ranked item is recorded with its seven components, shown or not.
  const stored = (await admin.query('SELECT item_object_id,rank_components,rank_position,certainty_label FROM briefing_items WHERE briefing_edition_id=$1',
    [first.briefingEditionId])).rows;
  expect(stored.length).toBe(items(first).length + first.deferredByAttentionBudget);
  for (const row of stored) {
    expect(Object.keys(row.rank_components).sort()).toEqual(['attentionBudget', 'confidence', 'consequence', 'effort',
      'goalRelevance', 'reversibility', 'urgency']);
  }
});

it('CRT-UX-02-A: ranks an older urgent high-consequence item above a newer low-consequence item', async () => {
  const older = itemFor(first, f.old)!, newer = itemFor(first, f.repeat)!;
  const created = (await admin.query('SELECT id,created_at FROM frame_instances WHERE id=ANY($1::uuid[])', [[f.old, f.repeat]])).rows;
  const createdAt = (id: string) => (created.find(row => row.id === id)!.created_at as Date).getTime();
  expect(createdAt(f.old)).toBeLessThan(createdAt(f.repeat));
  expect(older.rankComponents.consequence).toBeGreaterThan(newer.rankComponents.consequence);
  expect(older.rankComponents.urgency).toBeGreaterThan(newer.rankComponents.urgency);
  expect(older.rankPosition!).toBeLessThan(newer.rankPosition!);
  expect(older.rankScore).toBeGreaterThan(newer.rankScore);
  expect(older.priority).toBe('HIGH');
  expect(newer.priority).toBe('LOW');
  // The overall order is by score, never by recency.
  const positions = items(first).sort((a, b) => a.rankPosition! - b.rankPosition!);
  for (let index = 1; index < positions.length; index++) {
    expect(positions[index - 1]!.rankScore).toBeGreaterThanOrEqual(positions[index]!.rankScore);
  }
});

it('CRT-UX-01-B: never words a scheduled event without a resolution as having happened', async () => {
  const scheduled = (briefing: TodayBriefing) => items(briefing).filter(item => item.kind === 'SCHEDULED_EVENT');
  for (const item of [...scheduled(first), ...first.suppressedRepeats.filter(entry => entry.itemObjectId === f.planning)]) {
    expect(item.headline.replace(NEGATED, ''), item.headline).not.toMatch(HAPPENED);
  }
  expect(itemFor(first, f.dentist)!.headline).toMatch(/^Scheduled, not yet happened: Dentist appointment/);
  expect(itemFor(first, f.planning)!.headline).toMatch(/^Planned for .*: Planning call with the design team\. Nothing recorded says whether it took place\.$/);
});

it('CRT-UX-01-B: does not repeat an unchanged low-priority item that was shown yesterday', async () => {
  const app = api();
  try {
    const yesterday = itemFor(first, f.repeat)!;
    expect(yesterday).toMatchObject({ priority: 'LOW' });
    expect(yesterday.rankPosition).not.toBeNull();
    clock = TOMORROW;
    const second = await today(app);
    expect(second.ownerLocalDate).not.toBe(first.ownerLocalDate);
    expect(items(second).map(item => item.itemObjectId)).not.toContain(f.repeat);
    expect(second.suppressedRepeats).toContainEqual(expect.objectContaining({
      itemObjectType: 'frame_instance', itemObjectId: f.repeat, lastShownOn: first.ownerLocalDate }));
    const row = (await admin.query(`SELECT suppressed_as_unchanged,rank_position FROM briefing_items
      WHERE briefing_edition_id=$1 AND item_object_id=$2`, [second.briefingEditionId, f.repeat])).rows[0];
    expect(row).toEqual({ suppressed_as_unchanged: true, rank_position: null });
    // A high-consequence item shown yesterday is not suppressed: only low priority is.
    expect(items(second).map(item => item.itemObjectId)).toContain(f.old);
    // The dentist appointment's time has passed by now; it is still only planned.
    const dentist = itemFor(second, f.dentist)!;
    expect(dentist.pastTarget).toBe(true);
    expect(dentist.headline.replace(NEGATED, '')).not.toMatch(HAPPENED);
    // The edition history cannot be rewritten to change what was shown.
    await expect(admin.query('UPDATE briefing_items SET suppressed_as_unchanged=false WHERE briefing_edition_id=$1', [second.briefingEditionId]))
      .rejects.toThrow('CANONICALIZATION_RECORD_IMMUTABLE');
  } finally { clock = NOW; await app.close(); }
});

it('CRT-UX-11-A: Why? / Sources on a Today item opens the belief with claiming actor, excerpt, effective time, confidence and conflict status', async () => {
  const app = api();
  try {
    const item: BriefingItem = itemFor(first, f.old)!;
    expect(item.sourceRefs[0]).toEqual({ objectType: 'propositions', objectId: p.oldAction });
    const panel = await why(app, item.sourceRefs[0]!.objectType, item.sourceRefs[0]!.objectId);
    expect(panel).toMatchObject({ subjectKind: 'BELIEF', label: 'CONFIRMED', assessmentStatus: 'ACCEPTED',
      conflict: { status: 'NO_CONFLICT' }, derivation: { isInferred: false, steps: [] } });
    expect(panel.statement).toContain('send Daniel the signed lease');
    expect(panel.claimingActors).toContainEqual({ kind: 'PERSON', label: 'Maya', entityId: maya });
    expect(panel.sources[0]!.excerpt).toBe('I will send Daniel the signed lease by this afternoon, it is urgent.');
    expect(panel.effectiveTime.from).not.toBeNull();
    expect(panel.confidence).toMatchObject({ assessmentStatus: 'ACCEPTED', extraction: 0.93, temporalResolution: 0.88 });

    // A contested value: both competing values and the conflict status.
    const loan = itemFor(first, f.loan)!;
    const disputed = await why(app, 'propositions', loan.sourceRefs[0]!.objectId);
    expect(disputed.label).toBe('CONTESTED');
    expect(disputed.conflict.status).toBe('CONTESTED');
    expect(disputed.conflict.competing.map(entry => entry.statement).join(' ')).toMatch(/ILS (450|540)\.00/);
    expect([p.principal450, p.principal540]).toContain(disputed.subject.objectId);

    // An inferred value: its derivation path, back to the email a model read.
    const inferred = await why(app, 'propositions', itemFor(first, f.inferred)!.sourceRefs[0]!.objectId);
    expect(inferred).toMatchObject({ label: 'INFERRED', derivation: { isInferred: true } });
    expect(inferred.derivation.steps[0]).toMatchObject({ evaluatorId: 'extraction.commitment_inference', version: 'fixture-model-1' });
    expect(inferred.derivation.steps[0]!.inputs[0]).toMatchObject({ objectType: 'claims', objectId: emailClaim });
    expect(inferred.derivation.modelClaims.map(entry => entry.claimOrigin)).toContain('MODEL_INFERENCE');
    expect(inferred.claimingActors).toContainEqual(expect.objectContaining({ kind: 'PERSON', label: 'Maya' }));

    // A pending owner assertion opens the overlay assertion itself.
    const dentist = itemFor(first, f.dentist)!;
    expect(dentist.sourceRefs[0]).toEqual({ objectType: 'owner_overlay_deltas', objectId: dentistDelta });
    const pending = await why(app, 'owner_overlay_deltas', dentistDelta);
    expect(pending).toMatchObject({ subjectKind: 'OWNER_ASSERTION', label: 'PENDING_OWNER_ASSERTION',
      claimingActors: [{ kind: 'OWNER', label: 'You', entityId: null }] });
    expect(pending.statement).toContain('not yet independently verified');
    expect(pending.sources[0]!.excerpt).toBe('The dentist moved it to 16:00.');

    // A scheduled item, and a resolved one linked to its resolution assertion.
    expect((await why(app, 'propositions', p.planningTime)).label).toBe('SCHEDULED');
    const settled = await why(app, 'resolution_assertions', resolution);
    expect(settled).toMatchObject({ subjectKind: 'RESOLUTION', label: 'RESOLVED',
      resolutions: [{ resolutionAssertionId: resolution, outcomeCode: 'FULFILLED', lifecycle: 'ACCEPTED' }] });
    expect(settled.sources[0]!.excerpt).toContain('paid him this morning');
  } finally { await app.close(); }
});

it('CRT-UX-11-A: lists a source above the request ceiling as withheld instead of quoting it', async () => {
  const app = api();
  try {
    const restricted = (await admin.query(`SELECT p.id FROM propositions p JOIN belief_slots s ON s.owner_scope_id=p.owner_scope_id
      AND s.id=p.belief_slot_id WHERE s.frame_instance_id=$1 AND s.predicate_id='shared.commitment.action_description'`, [f.restricted])).rows[0].id;
    const withheld = await why(app, 'propositions', restricted, 'PRIVATE');
    expect(withheld.sources).toEqual([]);
    expect(withheld.redactions.length).toBeGreaterThan(0);
    expect(JSON.stringify(withheld)).not.toContain('biopsy results from the clinic');
    const shown = await why(app, 'propositions', restricted, 'RESTRICTED');
    expect(shown.sources[0]!.excerpt).toBe('Collect the biopsy results from the clinic.');
  } finally { await app.close(); }
});

it('refuses a Today request that declares no purpose or ceiling, or no timezone, before any retrieval', async () => {
  const app = api();
  try {
    const packets = async () => (await admin.query('SELECT count(*)::int AS n FROM context_packets WHERE owner_scope_id=$1', [owner])).rows[0].n;
    const before = await packets();
    const missing = await app.inject({ method: 'GET', url: '/v1/today?timeZone=' + ZONE,
      headers: { ...headers('memory.read'), 'x-data-purpose': '' } });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ code: 'TODAY_REQUEST_INCOMPLETE', missing: ['dataPurpose'] });
    const zone = await app.inject({ method: 'GET', url: '/v1/today?timeZone=Mars/Olympus', headers: headers('memory.read') });
    expect(zone.json()).toMatchObject({ code: 'TODAY_TIME_ZONE_INVALID' });
    expect(await packets()).toBe(before);
    // The route holds its own purpose, and the panel holds the inspector's.
    expect((await app.inject({ method: 'GET', url: '/v1/today?timeZone=' + ZONE, headers: headers('memory.inspect') })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/v1/memory/why/propositions/' + p.oldAction, headers: headers('memory.read') })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/v1/memory/why/claims/' + p.oldAction, headers: headers('memory.inspect') })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/v1/memory/why/propositions/' + randomUUID(), headers: headers('memory.inspect') })).statusCode).toBe(404);
  } finally { await app.close(); }
});

it.each(['sensitivity', 'purpose'] as const)('keeps Today projection fields within the packet\'s %s authority', async boundary => {
  const purpose = 'TODAY_PRIVACY_' + boundary.toUpperCase();
  const authorizedPurpose = boundary === 'purpose' ? purpose + '_FULL' : purpose;
  const publicSource = await source('today-public-' + boundary, 'CONVERSATION',
    'An administrative commitment and an ordinary payment are due today.', [...new Set([purpose, authorizedPurpose])]);
  const secretDescription = 'restricted medical appointment ' + boundary;
  const secretName = 'Confidential Counterparty ' + boundary;
  const secretAmount = '97241.18';
  const hiddenSource = await source('today-hidden-' + boundary, 'DOCUMENT',
    secretDescription + ' with ' + secretName + '; ILS ' + secretAmount,
    [authorizedPurpose], boundary === 'sensitivity' ? 'RESTRICTED' : 'PRIVATE');

  const commitmentId = await frame('shared.commitment', RECORDED);
  const hiddenAction = await value(commitmentId, 'shared.commitment.action_description', 'COMMITTED',
    { text: secretDescription }, hiddenSource.anchorId, 'ACCEPTED');
  await value(commitmentId, 'shared.commitment.due_time', 'COMMITTED', { time: at(3).toISOString() }, publicSource.anchorId, 'ACCEPTED');
  const counterpartyId = await person(secretName);
  await admin.query(`INSERT INTO frame_instance_roles(id,owner_scope_id,frame_instance_id,role_id,entity_id,claim_id)
    VALUES($1,$2,$3,'promisee',$4,$5)`, [uuidV7(), owner, commitmentId, counterpartyId, hiddenAction.claimId]);
  await admin.query(`INSERT INTO entity_aliases(id,owner_scope_id,entity_id,alias_type,alias_value,normalized_value,source_item_id)
    VALUES($1,$2,$3,'DISPLAY_NAME',$4,$5,$6)`,
    [uuidV7(), owner, counterpartyId, secretName, secretName.toLowerCase(), hiddenSource.evidenceId]);

  const obligationId = await frame('shared.obligation', RECORDED);
  const publicDescription = await value(obligationId, 'shared.obligation.description', 'ACTUAL',
    { text: 'ordinary administrative payment' }, publicSource.anchorId, 'ACCEPTED');
  await value(obligationId, 'shared.obligation.due_time', 'ACTUAL', { time: at(4).toISOString() }, publicSource.anchorId, 'ACCEPTED');
  await value(obligationId, 'shared.obligation.principal_amount', 'ACTUAL',
    { amount: secretAmount, currency: 'ILS' }, hiddenSource.anchorId, 'ACCEPTED');
  // A permitted alias remains useful even if the entity's preferred label is
  // private. Merely admitting its id cannot authorize the canonical label.
  const publicAlias = 'Authorized Payee ' + boundary;
  const privateCanonical = 'Private Canonical Name ' + boundary;
  const payeeId = await person(privateCanonical);
  await admin.query(`INSERT INTO frame_instance_roles(id,owner_scope_id,frame_instance_id,role_id,entity_id,claim_id)
    VALUES($1,$2,$3,'creditor',$4,$5)`, [uuidV7(), owner, obligationId, payeeId, publicDescription.claimId]);
  await admin.query(`INSERT INTO entity_aliases(id,owner_scope_id,entity_id,alias_type,alias_value,normalized_value,source_item_id)
    VALUES($1,$2,$3,'DISPLAY_NAME',$4,$5,$6)`,
    [uuidV7(), owner, payeeId, publicAlias, publicAlias.toLowerCase(), publicSource.evidenceId]);

  await withOwnerTransaction(appPool, { actorId: actor, ownerScopeId: owner, purpose: 'memory.project', correlationId: randomUUID() }, async tx => {
    for (const projectionName of ['open_commitments_projection', 'obligations_projection'] as const) {
      await applyProjectionDelta(tx, { ownerScopeId: owner, projectionName, asOf: NOW });
    }
  });
  const app = api();
  const read = async (dataPurpose: string, ceiling: string) => {
    const response = await app.inject({ method: 'GET', url: '/v1/today?timeZone=' + ZONE,
      headers: headers('memory.read', { 'x-data-purpose': dataPurpose, 'x-maximum-sensitivity': ceiling }) });
    expect(response.statusCode, response.body).toBe(200);
    return todayBriefingSchema.parse(response.json());
  };
  try {
    const limited = await read(purpose, 'PRIVATE');
    expect.soft(itemFor(limited, commitmentId)?.headline).toContain('a commitment');
    expect.soft(itemFor(limited, obligationId)?.headline).toContain('ordinary administrative payment');
    expect.soft(itemFor(limited, obligationId)?.headline).toContain(publicAlias);
    const storedItems = (await admin.query('SELECT headline,why_surfaced FROM briefing_items WHERE briefing_edition_id=$1',
      [limited.briefingEditionId])).rows;
    const packet = (await admin.query('SELECT packet FROM context_packets WHERE id=$1',
      [limited.packetManifest.contextPacketId])).rows[0].packet;
    for (const surface of [limited, storedItems, packet]) {
      for (const hidden of [secretDescription, secretName, secretAmount, privateCanonical]) {
        expect.soft(JSON.stringify(surface), hidden).not.toContain(hidden);
      }
    }
    // The negative assertions must not pass by dropping the frame or every
    // field: the same real route returns restricted values when authorized.
    const authorized = await read(authorizedPurpose, 'RESTRICTED');
    expect(itemFor(authorized, commitmentId)?.headline).toContain(secretDescription);
    expect(itemFor(authorized, commitmentId)?.headline).toContain(secretName);
    expect(itemFor(authorized, obligationId)?.headline).toContain('ILS ' + secretAmount);
    expect(itemFor(authorized, obligationId)?.headline).toContain(publicAlias);
    expect(JSON.stringify(authorized)).not.toContain(privateCanonical);
  } finally { await app.close(); }
});
