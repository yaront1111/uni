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
// The registry library stays out of the API's manifest (registry-boundary.test.ts);
// only this test publishes the pinned release, through the package's own source.
import { loadRegistryRelease, publishRegistryRelease } from '../../registry/src/index.js';
import { actionHistoryEntrySchema, exportBundleSchema, permissionsViewSchema } from '@unai/domain';
import { decideInterruption } from '@unai/review';
import { readPersistedPacket } from '@unai/context';
import { createPlatformApi } from './platform.js';
import type { EvidenceObjects } from './evidence.js';

/**
 * Governed action and the data-control surface over the real boundary, the real
 * owner transaction, the real Context Broker and the real pinned registry release
 * 0.1.0 (ADR 0030).
 *
 *  - CRT-CON-08-A: email send, calendar create and update, money movement and
 *    trading are refused with a recorded EvaluateMemoryAction decision, and a draft
 *    exists only when its capability is granted and the port allowed it.
 *  - CRT-SEC-11-A: a HIGH-risk action on memory that is only provisional,
 *    contested or from an incomplete projection is denied (or, at lower risk,
 *    needs confirmation), for a draft and for a recommendation.
 *  - CRT-AI-04-A: the §60 flow -- RECOMMENDED, intent to prepare only, and no
 *    executed-order fact until an authoritative receipt is ingested.
 *  - CRT-UX-13-A: every history entry is exactly one of six labels, and a draft is
 *    never labelled executed.
 *  - CRT-UX-09-A: the Permissions surface shows and changes sources, scopes,
 *    domain sensitivity, plugin capabilities, attention budgets and retention, and
 *    each change takes effect on the next operation.
 *  - CRT-NFR-04-A: export carries raw evidence and canonical memory, and dropping
 *    every embedding then regenerating restores the same semantic results.
 *  - CRT-SEC-06-A: after a deletion, the item and its raw object, anchors, claims,
 *    embeddings, summaries, index entries, projection rows and unsupported derived
 *    beliefs are not retrievable by any API or search, and no audit record holds
 *    its content.
 */

if (!process.env.UNAI_TEST_DATABASE_URL) throw new Error('Run pnpm test for the required PostgreSQL harness');
const admin = new Pool({ connectionString: process.env.UNAI_TEST_DATABASE_URL });
const url = new URL(process.env.UNAI_TEST_DATABASE_URL); url.username = 'control_api_test_app'; url.password = 'test-only';
const appPool = new Pool({ connectionString: url.href });

const FINANCE = 'PERSONAL_FINANCE', FAMILY = 'FAMILY_COORDINATION';
/** Before every fixture claim and assessment, so LATEST admits them on any run date. */
const RECORDED_AT = new Date('2026-02-01T09:00:00.000Z');
const MARKER = 'Zebracorn-4471';

const stored = new Map<string, Uint8Array>();
const evidenceObjects: EvidenceObjects = {
  encryptionKeyRef: 'kms:test-double',
  async put(_tx, id, bytes) { stored.set(id, bytes); },
  async get(_tx, id) { const bytes = stored.get(id); if (!bytes) throw new Error('OBJECT_NOT_FOUND'); return bytes; },
  async delete(_tx, id) { stored.delete(id); },
};

interface Owner { owner: string; actor: string; token: string; base: string; transaction: string }
let registryReleaseId = '';

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
  const repository = await mkdtemp(join(tmpdir(), 'unai-control-registry-'));
  try {
    await cp(resolve('registry'), join(repository, 'registry'), { recursive: true });
    git(repository, 'init', '--quiet'); git(repository, 'add', 'registry');
    git(repository, 'commit', '--quiet', '-m', 'release'); git(repository, 'tag', 'registry-v0.1.0');
    const release = await loadRegistryRelease({ repository, version: '0.1.0' });
    try { return (await publishRegistryRelease(admin, release, randomUUID())).releaseId; }
    catch { return (await admin.query("SELECT id FROM registry_releases WHERE semantic_version='0.1.0'")).rows[0].id as string; }
  } finally { await rm(repository, { recursive: true, force: true }); }
}

async function newOwner(label: string): Promise<Owner> {
  const adapter = postgresAdapter(admin);
  const user = await adapter.createUser!({ name: label, email: 'control-' + label + '-' + randomUUID() + '@example.test', emailVerified: null });
  const owner = (user as unknown as { ownerScopeId: string }).ownerScopeId;
  const token = randomBytes(32).toString('base64url');
  await adapter.createSession!({ userId: user.id, sessionToken: token, expires: new Date(Date.now() + 604800000) });
  const base = (await admin.query("SELECT id FROM context_spaces WHERE owner_scope_id=$1 AND context_kind='BASE'", [owner])).rows[0].id as string;
  const transaction = randomUUID();
  await admin.query(`INSERT INTO belief_transactions(id,owner_scope_id,transaction_kind,requested_by_actor_id,
    source_evidence_ids,registry_release_id,status,risk,idempotency_key,commit_receipt,committed_at)
    VALUES($1,$2,'CANONICALIZE',$3,'{}',$4,'COMMITTED','LOW',$5,'{}',$6)`,
    [transaction, owner, user.id, registryReleaseId, randomUUID().replaceAll('-', ''), RECORDED_AT]);
  return { owner, actor: user.id, token, base, transaction };
}

/** Evidence inserted directly, for the action scenarios that never read raw bytes. */
async function evidence(o: Owner, purposes: string[], text = 'fixture'): Promise<{ evidenceId: string; anchorId: string }> {
  const evidenceId = randomUUID(), anchorId = randomUUID();
  await admin.query(`INSERT INTO source_items(id,owner_scope_id,source_type,external_id,actor_ref,submitted_by_user_id,
    raw_object_ref,content_hash,sensitivity,allowed_purposes,ingestion_version,idempotency_key,occurred_at)
    VALUES($1,$2,'CONVERSATION',$3,$4,$5,$6,$7,'PRIVATE',$8,'evidence-json-v1',$9,$10)`,
    [evidenceId, o.owner, 'fixture-' + randomUUID(), JSON.stringify({ type: 'USER', id: o.actor }), o.actor, randomUUID(),
      randomBytes(32).toString('hex'), purposes, randomUUID(), new Date('2026-02-01T08:00:00.000Z')]);
  await admin.query(`INSERT INTO source_anchors(id,owner_scope_id,source_item_id,anchor_kind,anchor,normalized_text)
    VALUES($1,$2,$3,'MESSAGE_SPAN','{"start":0,"end":20}',$4)`, [anchorId, o.owner, evidenceId, text]);
  return { evidenceId, anchorId };
}

async function entity(o: Owner, label: string): Promise<string> {
  const id = randomUUID();
  await admin.query("INSERT INTO entities(id,owner_scope_id,entity_kind,canonical_label) VALUES($1,$2,'PERSON',$3)", [id, o.owner, label]);
  return id;
}

/** An obligation frame owed to `creditor`, with its principal-amount slot. */
async function obligation(o: Owner, creditor: string): Promise<{ frame: string; slot: string }> {
  const frame = randomUUID(), slot = randomUUID();
  await admin.query("INSERT INTO frame_instances(id,owner_scope_id,frame_type_id,context_space_id) VALUES($1,$2,'shared.obligation',$3)",
    [frame, o.owner, o.base]);
  await admin.query("INSERT INTO frame_instance_roles(id,owner_scope_id,frame_instance_id,role_id,entity_id) VALUES($1,$2,$3,'creditor',$4)",
    [randomUUID(), o.owner, frame, creditor]);
  await admin.query(`INSERT INTO belief_slots(id,owner_scope_id,frame_instance_id,predicate_id,context_space_id,modality)
    VALUES($1,$2,$3,'shared.obligation.principal_amount',$4,'ACTUAL')`, [slot, o.owner, frame, o.base]);
  return { frame, slot };
}

async function belief(o: Owner, input: { slot: string; value: unknown; anchorId: string; assessment: string | null }):
  Promise<{ propositionId: string; claimId: string }> {
  const propositionId = randomUUID(), claimId = randomUUID();
  await admin.query('INSERT INTO propositions(id,owner_scope_id,belief_slot_id,normalized_value) VALUES($1,$2,$3,$4)',
    [propositionId, o.owner, input.slot, JSON.stringify(input.value)]);
  await admin.query(`INSERT INTO claims(id,owner_scope_id,source_anchor_id,proposition_id,claim_origin,lifecycle,valid_from,recorded_at)
    VALUES($1,$2,$3,$4,'USER_STATEMENT','PROVISIONAL',$5,$6)`,
    [claimId, o.owner, input.anchorId, propositionId, new Date('2026-02-01T08:00:00.000Z'), RECORDED_AT]);
  if (input.assessment) {
    await admin.query(`INSERT INTO belief_assessments(id,owner_scope_id,proposition_id,assessment_status,policy_version,
      transaction_id,decision_reason,recorded_at) VALUES($1,$2,$3,$4,'local-policy-0.1.0',$5,'{"code":"FIXTURE"}',$6)`,
      [randomUUID(), o.owner, propositionId, input.assessment, o.transaction, RECORDED_AT]);
    await admin.query(`INSERT INTO belief_support(id,owner_scope_id,proposition_id,claim_id,support_kind,
      independence_group,created_by_transaction_id) VALUES($1,$2,$3,$4,'DIRECT_ASSERTION',$5,$6)`,
      [randomUUID(), o.owner, propositionId, claimId, 'source:' + input.anchorId.slice(0, 8), o.transaction]);
  }
  return { propositionId, claimId };
}

function api() {
  const app = createPlatformApi({ authPool: admin, appPool, evidenceObjects, registryReleaseId, registryRelease: '0.1.0' });
  app.addHook('onRequest', async request => { Object.defineProperty(request.raw.socket, 'encrypted', { value: true }); });
  return app;
}
const headers = (o: Owner, purpose: string, extra: Record<string, string> = {}) => ({
  cookie: SESSION_COOKIE + '=' + o.token, 'x-owner-scope-id': o.owner, 'x-purpose': purpose,
  'x-correlation-id': randomUUID(), 'idempotency-key': randomBytes(16).toString('hex'), ...extra,
});
const evidenceHeaders = (o: Owner, purpose: string, dataPurpose = FINANCE) =>
  headers(o, purpose, { 'x-data-purpose': dataPurpose, 'x-maximum-sensitivity': 'RESTRICTED' });
const draftBody = (overrides: Record<string, unknown> = {}) => ({
  draftKind: 'EMAIL', capabilityId: 'gmail.create_draft',
  content: { subject: 'Repayment', body: 'Hi, sending the repayment details as discussed.', recipients: ['owner@example.test'] },
  purpose: FINANCE, basis: { query: 'What do I owe?', entityHints: [] as string[] }, actionRisk: 'LOW',
  maximumSensitivity: 'RESTRICTED', ...overrides,
});
async function grantDraftCapability(app: ReturnType<typeof api>, o: Owner, granted = true) {
  const response = await app.inject({ method: 'POST', url: '/v1/plugin-capabilities', headers: headers(o, 'permissions.manage'),
    payload: { capabilities: [{ capabilityId: 'gmail.create_draft', granted }] } });
  expect(response.statusCode, response.body).toBe(200);
}
const count = async (sql: string, values: unknown[]) => Number((await admin.query(sql, values)).rows[0].n);

let actions: Owner, unsettled: Owner, incomplete: Owner, permissions: Owner, data: Owner;
let settledCreditor = '', provisionalCreditor = '', contestedCreditor = '', incompleteCreditor = '';
let observedEvidence = '';

beforeAll(async () => {
  await runMigrations(admin, resolve('migrations'));
  await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='control_api_test_app') THEN CREATE ROLE control_api_test_app LOGIN PASSWORD 'test-only'; END IF; END $$; GRANT unai_app TO control_api_test_app");
  registryReleaseId = await pinnedRegistryRelease();

  // Settled memory: one ACCEPTED value, no conflict, a complete projection.
  actions = await newOwner('actions');
  settledCreditor = await entity(actions, 'Sarah');
  const settled = await obligation(actions, settledCreditor);
  const settledEvidence = await evidence(actions, [FINANCE]);
  observedEvidence = settledEvidence.evidenceId;
  await belief(actions, { slot: settled.slot, value: { amount: '120.00', currency: 'ILS' }, anchorId: settledEvidence.anchorId, assessment: 'ACCEPTED' });
  // Unrelated family evidence: the owner's memory does admit that purpose, so a
  // family-purpose draft about this finance memory is read, and then refused by
  // the action port rather than by the read.
  await evidence(actions, [FAMILY]);

  // Unsettled memory: a value that is only PROVISIONAL, and a CONTESTED slot.
  unsettled = await newOwner('unsettled');
  provisionalCreditor = await entity(unsettled, 'Pat');
  const provisional = await obligation(unsettled, provisionalCreditor);
  await belief(unsettled, { slot: provisional.slot, value: { amount: '40.00', currency: 'ILS' },
    anchorId: (await evidence(unsettled, [FINANCE])).anchorId, assessment: 'PROVISIONAL' });
  contestedCreditor = await entity(unsettled, 'Cole');
  const contested = await obligation(unsettled, contestedCreditor);
  await belief(unsettled, { slot: contested.slot, value: { amount: '50.00', currency: 'ILS' },
    anchorId: (await evidence(unsettled, [FINANCE])).anchorId, assessment: 'ACCEPTED' });
  await belief(unsettled, { slot: contested.slot, value: { amount: '60.00', currency: 'ILS' },
    anchorId: (await evidence(unsettled, [FINANCE])).anchorId, assessment: 'PROVISIONAL' });

  // An ACCEPTED value whose typed projection is incomplete: the one thing wrong.
  incomplete = await newOwner('incomplete');
  incompleteCreditor = await entity(incomplete, 'Ivy');
  const pending = await obligation(incomplete, incompleteCreditor);
  await belief(incomplete, { slot: pending.slot, value: { amount: '75.00', currency: 'ILS' },
    anchorId: (await evidence(incomplete, [FINANCE])).anchorId, assessment: 'ACCEPTED' });
  await admin.query(`INSERT INTO obligations_projection(owner_scope_id,obligation_frame_instance_id,debtor_entity_id,
    creditor_entity_id,principal_amount,currency,total_canonical_allocation,remaining_amount_capability_derived,
    outcome_state,conflict_flag,overlay_complete,projection_version,canonical_transaction_watermark,
    owner_overlay_watermark,reducer_version,is_complete,source_manifest,updated_at)
    VALUES($1,$2,$3,$3,75.00,'ILS',0,75.00,'UNRESOLVED',false,false,$4,$5,0,'projection-reducers-0.1.0',false,'{}',$5)`,
    [incomplete.owner, pending.frame, incompleteCreditor, randomUUID(), RECORDED_AT]);

  permissions = await newOwner('permissions');
  data = await newOwner('data');
});
afterAll(async () => { await appPool.end(); await admin.end(); });

// ---------------------------------------------------------------------------

it('CRT-CON-08-A: a draft needs its granted capability and an EvaluateMemoryAction ALLOW, and every external action is refused in V0', async () => {
  const app = api();
  try {
    const basis = { query: 'What do I owe Sarah?', entityHints: [settledCreditor] };
    // Withheld capability: refused by name before any memory is read.
    const withheld = await app.inject({ method: 'POST', url: '/v1/drafts', headers: headers(actions, 'action.draft'), payload: draftBody({ basis }) });
    expect(withheld.statusCode, withheld.body).toBe(403);
    expect(withheld.json()).toMatchObject({ code: 'DRAFT_CAPABILITY_NOT_GRANTED', capabilityId: 'gmail.create_draft' });
    expect(await count('SELECT count(*) AS n FROM drafts WHERE owner_scope_id=$1', [actions.owner])).toBe(0);

    await grantDraftCapability(app, actions);
    // Granted, but EvaluateMemoryAction denies it: the evidence behind this memory
    // never admitted the purpose the draft declares. Refused, and the verdict kept.
    const denied = await app.inject({ method: 'POST', url: '/v1/drafts', headers: headers(actions, 'action.draft'),
      payload: draftBody({ basis, purpose: FAMILY }) });
    expect(denied.statusCode, denied.body).toBe(403);
    expect(denied.json()).toMatchObject({ code: 'DRAFT_POLICY_DENIED', reason: 'PURPOSE_NOT_IN_ALLOWED_PURPOSES' });
    const deniedDecision = (await admin.query('SELECT port,outcome FROM policy_decisions WHERE owner_scope_id=$1 AND id=$2',
      [actions.owner, denied.json().policyDecisionId])).rows[0];
    expect(deniedDecision).toEqual({ port: 'EvaluateMemoryAction', outcome: 'DENY' });
    expect(await count('SELECT count(*) AS n FROM drafts WHERE owner_scope_id=$1', [actions.owner])).toBe(0);

    // Granted and allowed: the draft exists, as a draft artifact naming the ALLOW.
    const created = await app.inject({ method: 'POST', url: '/v1/drafts', headers: headers(actions, 'action.draft'), payload: draftBody({ basis }) });
    expect(created.statusCode, created.body).toBe(201);
    const draft = created.json().draft;
    expect(draft).toMatchObject({ status: 'CREATED', recordedAs: 'DRAFT_ARTIFACT', capabilityId: 'gmail.create_draft' });
    const allowed = (await admin.query('SELECT port,outcome FROM policy_decisions WHERE owner_scope_id=$1 AND id=$2',
      [actions.owner, draft.policyDecisionId])).rows[0];
    expect(allowed).toEqual({ port: 'EvaluateMemoryAction', outcome: 'ALLOW' });
    expect(created.json().entry).toMatchObject({ stage: 'DRAFTED', label: 'drafted', subject: { objectType: 'draft', objectId: draft.draftId } });

    // A revoked capability stops the very next draft.
    await grantDraftCapability(app, actions, false);
    const revoked = await app.inject({ method: 'POST', url: '/v1/drafts', headers: headers(actions, 'action.draft'), payload: draftBody({ basis }) });
    expect(revoked.statusCode).toBe(403);
    expect(revoked.json().code).toBe('DRAFT_CAPABILITY_NOT_GRANTED');
    await grantDraftCapability(app, actions);

    // Email send, calendar create and update, money movement, trading: each one
    // refused by EvaluateMemoryAction with a recorded decision, and nothing executed.
    for (const actionKind of ['EMAIL_SEND', 'CALENDAR_CREATE', 'CALENDAR_UPDATE', 'MONEY_MOVEMENT', 'TRADE']) {
      const response = await app.inject({ method: 'POST', url: '/v1/actions/execute', headers: headers(actions, 'action.execute'),
        payload: { actionKind, subjectRef: { objectType: 'draft', objectId: draft.draftId }, purpose: FINANCE, actionRisk: 'LOW' } });
      expect(response.statusCode, actionKind + ' ' + response.body).toBe(403);
      expect(response.json(), actionKind).toMatchObject({ code: 'EXTERNAL_ACTION_REFUSED', outcome: 'DENY',
        reason: 'EXTERNAL_ACTION_REFUSED_IN_V0', executed: false });
      const decision = (await admin.query('SELECT port,outcome,reason FROM policy_decisions WHERE owner_scope_id=$1 AND id=$2',
        [actions.owner, response.json().policyDecisionId])).rows[0];
      expect(decision, actionKind).toEqual({ port: 'EvaluateMemoryAction', outcome: 'DENY', reason: 'EXTERNAL_ACTION_REFUSED_IN_V0' });
    }
    // The write capabilities can be listed and never granted.
    for (const capabilityId of ['gmail.send', 'calendar.create', 'calendar.update', 'finance.move_money', 'trading.submit_order']) {
      const response = await app.inject({ method: 'POST', url: '/v1/plugin-capabilities', headers: headers(actions, 'permissions.manage'),
        payload: { capabilities: [{ capabilityId, granted: true }] } });
      expect(response.statusCode, capabilityId).toBe(403);
      expect(response.json()).toMatchObject({ code: 'PLUGIN_CAPABILITY_WRITE_REFUSED', capabilityId });
    }
    expect(await count(`SELECT count(*) AS n FROM action_history WHERE owner_scope_id=$1 AND stage IN ('EXECUTED','RECEIVED_CONFIRMATION')`,
      [actions.owner])).toBe(0);
    // The route holds its own purpose.
    const wrongPurpose = await app.inject({ method: 'POST', url: '/v1/actions/execute', headers: headers(actions, 'action.draft'),
      payload: { actionKind: 'TRADE', purpose: FINANCE, actionRisk: 'LOW' } });
    expect(wrongPurpose.statusCode).toBe(403);
    expect(wrongPurpose.json().code).toBe('PURPOSE_REFUSED');
  } finally { await app.close(); }
});

it('CRT-SEC-11-A: a HIGH-risk action on provisional, contested or incompletely projected memory is denied, and needs confirmation at lower risk', async () => {
  const app = api();
  try {
    await grantDraftCapability(app, unsettled);
    await grantDraftCapability(app, incomplete);
    const cases: [Owner, string, string][] = [
      [unsettled, provisionalCreditor, 'PROVISIONAL'], [unsettled, contestedCreditor, 'CONTESTED'], [incomplete, incompleteCreditor, 'INCOMPLETE']];
    for (const [o, creditor, label] of cases) {
      const basis = { query: 'What do I owe?', entityHints: [creditor] };
      const high = await app.inject({ method: 'POST', url: '/v1/drafts', headers: headers(o, 'action.draft'),
        payload: draftBody({ basis, actionRisk: 'HIGH' }) });
      expect(high.statusCode, label + ' ' + high.body).toBe(403);
      expect(high.json(), label).toMatchObject({ code: 'DRAFT_POLICY_DENIED', reason: 'HIGH_RISK_ACTION_ON_UNSETTLED_MEMORY' });
      const decision = (await admin.query('SELECT outcome,reason FROM policy_decisions WHERE owner_scope_id=$1 AND id=$2',
        [o.owner, high.json().policyDecisionId])).rows[0];
      expect(decision, label).toEqual({ outcome: 'DENY', reason: 'HIGH_RISK_ACTION_ON_UNSETTLED_MEMORY' });
      // The same memory at MEDIUM risk is not allowed either: it needs confirmation.
      const medium = await app.inject({ method: 'POST', url: '/v1/drafts', headers: headers(o, 'action.draft'),
        payload: draftBody({ basis, actionRisk: 'MEDIUM' }) });
      expect(medium.statusCode, label).toBe(409);
      expect(medium.json(), label).toMatchObject({ code: 'DRAFT_CONFIRMATION_REQUIRED', reason: 'ACTION_ON_UNSETTLED_MEMORY' });
      // A HIGH-risk recommendation on the same memory is withheld, with the reason.
      const recommended = await app.inject({ method: 'POST', url: '/v1/recommendations', headers: headers(o, 'action.recommend'),
        payload: { recommendationText: 'Transfer the repayment today.', recommendedActionKind: 'MONEY_MOVEMENT', actionRisk: 'HIGH',
          purpose: FINANCE, basis, maximumSensitivity: 'RESTRICTED' } });
      expect(recommended.statusCode, label + ' ' + recommended.body).toBe(201);
      const recommendation = recommended.json().recommendation;
      expect(recommendation, label).toMatchObject({ semantics: 'RECOMMENDED', status: 'BLOCKED',
        blockedReason: 'HIGH_RISK_ACTION_ON_UNSETTLED_MEMORY' });
      expect(recommended.json().entry, label).toBeNull();
      // It can be dismissed, never acted on.
      const accept = await app.inject({ method: 'POST', url: '/v1/recommendations/' + recommendation.recommendationId + '/respond',
        headers: headers(o, 'action.recommend'),
        payload: { response: 'ACCEPTED_AS_INTENT_TO_PREPARE', rawText: 'Yes, do it.', dataPurpose: FINANCE } });
      expect(accept.statusCode, label).toBe(409);
      expect(accept.json().code).toBe('RECOMMENDATION_BLOCKED');
    }
    expect(await count('SELECT count(*) AS n FROM drafts WHERE owner_scope_id=ANY($1)', [[unsettled.owner, incomplete.owner]])).toBe(0);
    // And the external action kinds stay refused at HIGH risk as at any other.
    const execute = await app.inject({ method: 'POST', url: '/v1/actions/execute', headers: headers(unsettled, 'action.execute'),
      payload: { actionKind: 'MONEY_MOVEMENT', purpose: FINANCE, actionRisk: 'HIGH' } });
    expect(execute.statusCode).toBe(403);
    expect(execute.json().outcome).toBe('DENY');
  } finally { await app.close(); }
});

it('CRT-AI-04-A: the §60 recommendation is RECOMMENDED, "prepare but do not submit" is intent to prepare, and only a receipt establishes execution', async () => {
  const app = api();
  try {
    const before = {
      claims: await count('SELECT count(*) AS n FROM claims WHERE owner_scope_id=$1', [actions.owner]),
      propositions: await count('SELECT count(*) AS n FROM propositions WHERE owner_scope_id=$1', [actions.owner]),
    };
    const created = await app.inject({ method: 'POST', url: '/v1/recommendations', headers: headers(actions, 'action.recommend'),
      payload: { recommendationText: 'Selling 100 shares would reduce concentration.', recommendedActionKind: 'TRADE',
        actionRisk: 'MEDIUM', purpose: FINANCE, basis: { query: 'What do I owe Sarah?', entityHints: [settledCreditor] },
        maximumSensitivity: 'RESTRICTED' } });
    expect(created.statusCode, created.body).toBe(201);
    const recommendation = created.json().recommendation;
    expect(recommendation).toMatchObject({ semantics: 'RECOMMENDED', status: 'ACTIVE', userResponse: 'NONE',
      executionReceipted: false, supportingAssessment: 'ACCEPTED' });
    expect(recommendation.supportingEvidenceIds).toContain(observedEvidence);
    expect(created.json().entry).toMatchObject({ stage: 'SUGGESTED', label: 'suggested' });
    const row = (await admin.query('SELECT semantics,user_response FROM recommendation_artifacts WHERE id=$1', [recommendation.recommendationId])).rows[0];
    expect(row).toEqual({ semantics: 'RECOMMENDED', user_response: 'NONE' });

    // "Yes, prepare the order, but do not submit it."
    const words = 'Yes, prepare the order, but do not submit it.';
    const responded = await app.inject({ method: 'POST', url: '/v1/recommendations/' + recommendation.recommendationId + '/respond',
      headers: headers(actions, 'action.recommend'),
      payload: { response: 'ACCEPTED_AS_INTENT_TO_PREPARE', rawText: words, dataPurpose: FINANCE } });
    expect(responded.statusCode, responded.body).toBe(200);
    expect(responded.json()).toMatchObject({ intent: 'PREPARE_ONLY',
      recommendation: { userResponse: 'ACCEPTED_AS_INTENT_TO_PREPARE', semantics: 'RECOMMENDED', executionReceipted: false } });
    // The owner's words are evidence, verbatim, attributed to the owner.
    const reply = (await admin.query('SELECT source_type,actor_ref FROM source_items WHERE id=$1',
      [responded.json().recommendation.responseEvidenceId])).rows[0];
    expect(reply).toEqual({ source_type: 'CONVERSATION', actor_ref: { type: 'USER', id: actions.actor } });
    expect(Buffer.from(stored.get((await admin.query('SELECT raw_object_ref FROM source_items WHERE id=$1',
      [responded.json().recommendation.responseEvidenceId])).rows[0].raw_object_ref)!).toString()).toContain(words);
    // Intent to prepare is not an executed order: no claim, no belief, no
    // EXECUTED entry, and the execution request is still refused.
    expect(await count('SELECT count(*) AS n FROM claims WHERE owner_scope_id=$1', [actions.owner])).toBe(before.claims);
    expect(await count('SELECT count(*) AS n FROM propositions WHERE owner_scope_id=$1', [actions.owner])).toBe(before.propositions);
    expect(await count(`SELECT count(*) AS n FROM action_history WHERE owner_scope_id=$1 AND recommendation_id=$2
      AND stage IN ('EXECUTED','RECEIVED_CONFIRMATION')`, [actions.owner, recommendation.recommendationId])).toBe(0);
    const submit = await app.inject({ method: 'POST', url: '/v1/actions/execute', headers: headers(actions, 'action.execute'),
      payload: { actionKind: 'TRADE', subjectRef: { objectType: 'recommendation', objectId: recommendation.recommendationId },
        purpose: FINANCE, actionRisk: 'HIGH' } });
    expect(submit.statusCode).toBe(403);
    expect(submit.json()).toMatchObject({ code: 'EXTERNAL_ACTION_REFUSED', executed: false });
    const detail = await app.inject({ method: 'GET', url: '/v1/recommendations/' + recommendation.recommendationId, headers: headers(actions, 'action.read') });
    expect(detail.json()).toMatchObject({ executionReceipted: false, userResponse: 'ACCEPTED_AS_INTENT_TO_PREPARE' });

    // "Broker tool: order submitted and filled." Only this receipt, ingested as
    // authoritative evidence, establishes the execution.
    const receipt = await app.inject({ method: 'POST', url: '/v1/actions/receipts', headers: headers(actions, 'action.receipt'),
      payload: { toolId: 'broker.example', actionKind: 'TRADE', stage: 'EXECUTED', externalActionRef: 'order-' + randomUUID(),
        receipt: { status: 'FILLED', side: 'SELL', quantity: 100, symbol: 'ACME' },
        recommendationId: recommendation.recommendationId, dataPurpose: FINANCE } });
    expect(receipt.statusCode, receipt.body).toBe(201);
    expect(receipt.json().entry).toMatchObject({ stage: 'EXECUTED', label: 'executed', receiptEvidenceId: receipt.json().receiptEvidenceId });
    const receiptRow = (await admin.query('SELECT source_type,actor_ref FROM source_items WHERE id=$1', [receipt.json().receiptEvidenceId])).rows[0];
    expect(receiptRow).toEqual({ source_type: 'TOOL_RECEIPT', actor_ref: { type: 'EXTERNAL', id: 'broker.example' } });
    const after = await app.inject({ method: 'GET', url: '/v1/recommendations/' + recommendation.recommendationId, headers: headers(actions, 'action.read') });
    expect(after.json()).toMatchObject({ executionReceipted: true, semantics: 'RECOMMENDED' });
    // A non-receipt item can never stand behind an execution fact.
    await expect(admin.query(`INSERT INTO action_history(id,owner_scope_id,stage,action_kind,subject_object_type,subject_object_id,
      receipt_evidence_id) VALUES(gen_random_uuid(),$1,'EXECUTED','TRADE','evidence',$2,$2)`,
      [actions.owner, responded.json().recommendation.responseEvidenceId])).rejects.toThrow('ACTION_RECEIPT_NOT_AUTHORITATIVE');
  } finally { await app.close(); }
});

it('CRT-UX-13-A: every action-history entry is exactly one of six labels, and a draft is never labelled executed', async () => {
  const app = api();
  try {
    await grantDraftCapability(app, actions);
    const basis = { query: 'What do I owe Sarah?', entityHints: [settledCreditor] };
    const draft = (await app.inject({ method: 'POST', url: '/v1/drafts', headers: headers(actions, 'action.draft'), payload: draftBody({ basis }) })).json().draft;
    const requested = await app.inject({ method: 'POST', url: '/v1/drafts/' + draft.draftId + '/decision',
      headers: headers(actions, 'action.draft'), payload: { decision: 'REQUEST_APPROVAL' } });
    expect(requested.statusCode, requested.body).toBe(200);
    expect(requested.json().entry).toMatchObject({ stage: 'REQUESTED_APPROVAL', label: 'requested approval' });
    const approved = await app.inject({ method: 'POST', url: '/v1/drafts/' + draft.draftId + '/decision',
      headers: headers(actions, 'action.draft'), payload: { decision: 'APPROVE' } });
    expect(approved.json()).toMatchObject({ draft: { status: 'APPROVED', recordedAs: 'DRAFT_ARTIFACT' }, entry: null });
    // An approved draft has nowhere further to go: there is no executed state.
    const again = await app.inject({ method: 'POST', url: '/v1/drafts/' + draft.draftId + '/decision',
      headers: headers(actions, 'action.draft'), payload: { decision: 'APPROVE' } });
    expect(again.statusCode).toBe(409);
    const observed = await app.inject({ method: 'POST', url: '/v1/action-history/observations', headers: headers(actions, 'action.receipt'),
      payload: { evidenceId: observedEvidence, actionKind: 'EMAIL_SEND' } });
    expect(observed.statusCode, observed.body).toBe(201);
    expect(observed.json().entry).toMatchObject({ stage: 'OBSERVED', label: 'observed' });
    const confirmed = await app.inject({ method: 'POST', url: '/v1/actions/receipts', headers: headers(actions, 'action.receipt'),
      payload: { toolId: 'broker.example', actionKind: 'TRADE', stage: 'RECEIVED_CONFIRMATION', externalActionRef: 'confirmation-' + randomUUID(),
        receipt: { status: 'SETTLED' }, dataPurpose: FINANCE } });
    expect(confirmed.statusCode, confirmed.body).toBe(201);

    const history = await app.inject({ method: 'GET', url: '/v1/action-history', headers: headers(actions, 'action.read') });
    expect(history.statusCode).toBe(200);
    const entries = history.json().entries as Array<Record<string, any>>;
    const LABELS = ['observed', 'suggested', 'drafted', 'requested approval', 'executed', 'received confirmation'];
    for (const entry of entries) {
      actionHistoryEntrySchema.parse(entry);
      // Exactly one label, and it is one of the six.
      expect(LABELS.filter(label => label === entry.label)).toHaveLength(1);
      if (entry.subject.objectType === 'draft') expect(['DRAFTED', 'REQUESTED_APPROVAL']).toContain(entry.stage);
      if (['EXECUTED', 'RECEIVED_CONFIRMATION'].includes(entry.stage)) expect(entry.receiptEvidenceId).not.toBeNull();
    }
    expect(new Set(entries.map(entry => entry.label))).toEqual(new Set(LABELS));
    // The schema refuses a draft labelled executed, even from the migration principal.
    const receiptId = entries.find(entry => entry.stage === 'EXECUTED')!.receiptEvidenceId;
    await expect(admin.query(`INSERT INTO action_history(id,owner_scope_id,stage,action_kind,subject_object_type,subject_object_id,
      receipt_evidence_id) VALUES(gen_random_uuid(),$1,'EXECUTED','DRAFT','draft',$2,$3)`, [actions.owner, draft.draftId, receiptId]))
      .rejects.toMatchObject({ constraint: 'action_history_draft_never_executed' });
    // Drafts are listed as drafts.
    const drafts = await app.inject({ method: 'GET', url: '/v1/drafts', headers: headers(actions, 'action.read') });
    expect((drafts.json().drafts as Array<Record<string, unknown>>).every(item => item['recordedAs'] === 'DRAFT_ARTIFACT')).toBe(true);
  } finally { await app.close(); }
});

it('CRT-UX-09-A: the Permissions surface shows and changes sources, scopes, sensitivity, plugin capabilities, budgets and retention, each applied to the next operation', async () => {
  const app = api();
  const o = permissions;
  try {
    // A connected source with one read scope.
    const connected = await app.inject({ method: 'POST', url: '/v1/connectors', headers: headers(o, 'connector.manage'),
      payload: { connectorType: 'GMAIL', externalAccountRef: 'owner@example.test',
        requestedCapabilities: [{ capabilityId: 'gmail.read_metadata', granted: true }] } });
    expect(connected.statusCode, connected.body).toBe(201);
    const connectorId = connected.json().connectorId as string;
    const view = async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/permissions', headers: headers(o, 'permissions.read') });
      expect(response.statusCode, response.body).toBe(200);
      return permissionsViewSchema.parse(response.json());
    };
    const first = await view();
    expect(first.connectedSources).toEqual([expect.objectContaining({ connectorId, status: 'ACTIVE', writeScopes: [],
      readScopes: ['https://www.googleapis.com/auth/gmail.metadata'], grantedCapabilities: ['gmail.read_metadata'] })]);
    expect(first.domainSensitivity.map(entry => [entry.sourceType, entry.effectiveSensitivity])).toEqual(
      expect.arrayContaining([['GMAIL', 'PRIVATE'], ['DOCUMENT', 'PRIVATE']]));
    expect(first.pluginCapabilities.filter(entry => entry.grantable).map(entry => entry.capabilityId).sort())
      .toEqual(['calendar.create_draft', 'gmail.create_draft']);
    expect(first.pluginCapabilities.find(entry => entry.capabilityId === 'trading.submit_order'))
      .toMatchObject({ access: 'WRITE', riskClass: 'HIGH', grantable: false, granted: false });
    expect(first.attentionBudget).toMatchObject({ maxCardsPerDay: 3, maxCardsPerSensitivityScopePerDay: 1,
      repeatQuestionSuppressionDays: 7, isDefault: true });
    expect(first.retention).toEqual([]);

    // Scopes: a second read capability widens the read scopes on the next read.
    const scoped = await app.inject({ method: 'POST', url: '/v1/connectors/' + connectorId + '/capabilities', headers: headers(o, 'connector.manage'),
      payload: { capabilities: [{ capabilityId: 'gmail.read_content', granted: true }] } });
    expect(scoped.statusCode, scoped.body).toBe(200);
    expect((await view()).connectedSources[0]!.readScopes).toContain('https://www.googleapis.com/auth/gmail.readonly');

    // Plugin capabilities: the draft capability toggles; a write one never does.
    await grantDraftCapability(app, o);
    const refused = await app.inject({ method: 'POST', url: '/v1/plugin-capabilities', headers: headers(o, 'permissions.manage'),
      payload: { capabilities: [{ capabilityId: 'gmail.create_draft', granted: false }, { capabilityId: 'gmail.send', granted: true }] } });
    expect(refused.statusCode).toBe(403);
    const afterRefusal = await view();
    // Refused whole: the draft capability in the same request did not move either.
    expect(afterRefusal.pluginCapabilities.find(entry => entry.capabilityId === 'gmail.create_draft')!.granted).toBe(true);
    expect(afterRefusal.pluginCapabilities.find(entry => entry.capabilityId === 'gmail.send')!.granted).toBe(false);

    // Attention budget: the memory inbox's setting (ADR 0029), changed from this
    // surface through its own route, and the saved cap is the one the next
    // interruption decision applies.
    const decide = (budget: typeof first.attentionBudget, askedToday: number, lastAskedAt: Date | null) => decideInterruption({
      risk: { errorProbability: 0.9, consequence: 'HIGH', irreversibility: 'IRREVERSIBLE', urgency: 'HIGH', interruptionCost: 'LOW' },
      sensitivityScope: 'FINANCE/PRIVATE', budget, ownerLocalDate: '2026-09-19', timeZone: 'UTC', now: new Date(),
      askedToday, askedInScopeToday: 0, lastAskedAt, suppressedUntil: null, materialNewEvidenceIds: [], learnedApprovalRuleId: null,
    });
    expect(decide(first.attentionBudget, 1, null).decision).toBe('ASK');
    const wrongPurpose = await app.inject({ method: 'PATCH', url: '/v1/settings/attention-budgets', headers: headers(o, 'permissions.manage'),
      payload: { maxCardsPerDay: 1 } });
    expect(wrongPurpose.statusCode).toBe(403);
    const budget = await app.inject({ method: 'PATCH', url: '/v1/settings/attention-budgets', headers: headers(o, 'settings.attention'),
      payload: { maxCardsPerDay: 1, repeatQuestionSuppressionDays: 3 } });
    expect(budget.statusCode, budget.body).toBe(200);
    const saved = (await view()).attentionBudget;
    expect(saved).toMatchObject({ maxCardsPerDay: 1, maxCardsPerSensitivityScopePerDay: 1, repeatQuestionSuppressionDays: 3, isDefault: false });
    expect(decide(saved, 1, null)).toMatchObject({ decision: 'BATCH', reason: 'DAILY_BUDGET_EXHAUSTED' });
    expect(decide(saved, 0, new Date(Date.now() - 4 * 86_400_000)).decision).toBe('ASK');

    // Domain sensitivity: the next upload is stored at the owner's setting, in
    // either direction, and an item already stored is never rewritten.
    const upload = async (documentId: string, sensitivity: string) => {
      const response = await app.inject({ method: 'POST', url: '/v1/documents', headers: evidenceHeaders(o, 'evidence.ingest', 'PERSONAL_ASSISTANCE'),
        payload: { documentId, title: documentId, pages: [{ page: 1, text: 'Notes for ' + documentId }], sensitivity,
          allowedPurposes: ['PERSONAL_ASSISTANCE'] } });
      expect(response.statusCode, response.body).toBe(201);
      return response.json() as { evidenceId: string; storedSensitivity: string };
    };
    const raised = await app.inject({ method: 'PATCH', url: '/v1/settings/domain-sensitivity', headers: headers(o, 'permissions.manage'),
      payload: { mappings: [{ sourceType: 'DOCUMENT', sensitivity: 'RESTRICTED' }] } });
    expect(raised.statusCode, raised.body).toBe(200);
    const restrictedDocument = await upload('doc-restricted', 'PRIVATE');
    expect(restrictedDocument.storedSensitivity).toBe('RESTRICTED');
    await app.inject({ method: 'PATCH', url: '/v1/settings/domain-sensitivity', headers: headers(o, 'permissions.manage'),
      payload: { mappings: [{ sourceType: 'DOCUMENT', sensitivity: 'NORMAL' }] } });
    const normalDocument = await upload('doc-normal', 'NORMAL');
    expect(normalDocument.storedSensitivity).toBe('NORMAL');
    expect((await admin.query('SELECT sensitivity FROM source_items WHERE id=$1', [restrictedDocument.evidenceId])).rows[0].sensitivity).toBe('RESTRICTED');
    expect((await view()).domainSensitivity.find(entry => entry.sourceType === 'DOCUMENT'))
      .toMatchObject({ defaultSensitivity: 'PRIVATE', ownerSetting: 'NORMAL', effectiveSensitivity: 'NORMAL' });

    // Retention: with no rule a cleanup removes nothing; the rule saved next is
    // the one the next cleanup applies.
    const later = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const before = await app.inject({ method: 'POST', url: '/v1/data/retention/cleanup', headers: headers(o, 'data.delete'), payload: { asOf: later } });
    expect(before.statusCode, before.body).toBe(200);
    expect(before.json().deletion).toBeNull();
    const rule = await app.inject({ method: 'PATCH', url: '/v1/settings/retention', headers: headers(o, 'permissions.manage'),
      payload: { rules: [{ sourceType: 'DOCUMENT', rawRetentionDays: 1, derivedRetentionDays: null }] } });
    expect(rule.statusCode, rule.body).toBe(200);
    expect((await view()).retention).toEqual([expect.objectContaining({ sourceType: 'DOCUMENT', rawRetentionDays: 1, derivedRetentionDays: null })]);
    const cleaned = await app.inject({ method: 'POST', url: '/v1/data/retention/cleanup', headers: headers(o, 'data.delete'), payload: { asOf: later } });
    expect(cleaned.statusCode, cleaned.body).toBe(200);
    expect(cleaned.json().deletion).toMatchObject({ status: 'COMPLETED', trigger: 'RETENTION_POLICY' });
    expect([...cleaned.json().deletion.evidenceIds].sort()).toEqual([normalDocument.evidenceId, restrictedDocument.evidenceId].sort());
    const gone = await app.inject({ method: 'GET', url: '/v1/evidence/' + normalDocument.evidenceId,
      headers: evidenceHeaders(o, 'evidence.read', 'PERSONAL_ASSISTANCE') });
    expect(gone.statusCode).toBe(404);

    // Export and deletion are triggered from this surface and listed on it.
    const exported = await app.inject({ method: 'POST', url: '/v1/export', headers: headers(o, 'data.export', { 'x-maximum-sensitivity': 'RESTRICTED' }), payload: {} });
    expect(exported.statusCode, exported.body).toBe(201);
    const requests = (await view()).dataRequests.map(request => request.requestKind);
    expect(requests).toEqual(expect.arrayContaining(['EXPORT', 'DELETE']));

    // Every change is audited with field names only.
    const audited = (await admin.query(`SELECT objects_and_fields_accessed FROM audit_events WHERE owner_scope_id=$1 AND purpose='permissions.manage'
      AND result='SUCCESS'`, [o.owner])).rows.map(row => JSON.stringify(row.objects_and_fields_accessed));
    for (const table of ['plugin_capability_grants', 'domain_sensitivity_settings', 'retention_settings']) {
      expect(audited.some(text => text.includes('"' + table + '"')), table).toBe(true);
    }
  } finally { await app.close(); }
});

it('CRT-SEC-06-A: retained assistant history cannot reconstruct erased memory', async () => {
  const app = api();
  const o = await newOwner('erased-answer');
  const erasedValue = '4471.99', controlValue = '30.77';
  try {
    const upload = async (name: string, amount: string) => {
      const text = name + ' lent me ILS ' + amount;
      const response = await app.inject({ method: 'POST', url: '/v1/documents', headers: evidenceHeaders(o, 'evidence.ingest'),
        payload: { documentId: name, title: name, pages: [{ page: 1, text }], sensitivity: 'PRIVATE',
          allowedPurposes: [FINANCE], base64: Buffer.from(text).toString('base64') } });
      expect(response.statusCode, response.body).toBe(201);
      const evidenceId = response.json().evidenceId as string;
      const anchorId = (await admin.query("SELECT id FROM source_anchors WHERE source_item_id=$1 AND anchor_kind='DOCUMENT_RANGE'",
        [evidenceId])).rows[0].id as string;
      const frame = await obligation(o, await entity(o, name));
      const value = await belief(o, { slot: frame.slot, value: { amount, currency: 'ILS' }, anchorId, assessment: 'ACCEPTED' });
      return { evidenceId, ...value };
    };
    const doomed = await upload('Erased creditor', erasedValue);
    const control = await upload('Retained creditor', controlValue);
    const indexed = await app.inject({ method: 'POST', url: '/v1/memory/embeddings/regenerate',
      headers: headers(o, 'memory.reindex'), payload: {} });
    expect(indexed.statusCode, indexed.body).toBe(200);
    expect(indexed.json().indexed).toBe(2);
    const ask = async (overrides: Record<string, unknown> = {}) => {
      const response = await app.inject({ method: 'POST', url: '/v1/ask', headers: headers(o, 'memory.read'),
        payload: { ownerScopeId: o.owner, purpose: FINANCE, question: 'What do I currently owe?',
          worldTime: 'NOW', knowledgeTime: 'LATEST', maximumSensitivity: 'RESTRICTED', ...overrides } });
      expect(response.statusCode, response.body).toBe(200);
      return response.json();
    };
    const why = (propositionId: string) => app.inject({ method: 'GET',
      url: '/v1/memory/why/propositions/' + propositionId, headers: evidenceHeaders(o, 'memory.inspect') });
    const packetOf = (packetId: string) => withOwnerTransaction(appPool,
      { ownerScopeId: o.owner, actorId: o.actor, purpose: 'memory.inspect', correlationId: randomUUID() },
      tx => readPersistedPacket(tx, { ownerScopeId: o.owner, packetId }));

    const before = await ask();
    expect(JSON.stringify(before.statements)).toContain(erasedValue);
    expect(JSON.stringify(before.statements)).toContain(controlValue);
    const beforePacket = (await packetOf(before.packetId)).packet;
    expect(JSON.stringify(beforePacket)).toContain(erasedValue);
    expect(beforePacket.semanticSearch!.matches.map(match => match.objectId))
      .toEqual(expect.arrayContaining([doomed.claimId, control.claimId]));
    const beforeWhy = await why(doomed.propositionId);
    expect(beforeWhy.statusCode, beforeWhy.body).toBe(200);
    expect(beforeWhy.json().statement).toContain(erasedValue);
    const assistantEvidenceId = (await admin.query('SELECT conversation_message_id FROM answer_manifests WHERE id=$1',
      [before.answerManifestId])).rows[0].conversation_message_id as string;
    const historicalAt = new Date().toISOString();

    const deletion = await app.inject({ method: 'POST', url: '/v1/data/deletions', headers: headers(o, 'data.delete'),
      payload: { evidenceIds: [doomed.evidenceId], confirmation: 'DELETE' } });
    expect(deletion.statusCode, deletion.body).toBe(200);
    expect((await admin.query('SELECT packet,request FROM context_packets WHERE id=$1', [before.packetId])).rows[0])
      .toEqual({ packet: { erased: true }, request: { erased: true } });
    // The stored packet reader validates the erased sentinel and refuses it;
    // it must never revive the earlier supplied values from the saved answer.
    await expect(packetOf(before.packetId)).rejects.toMatchObject({ name: 'ZodError' });
    const erasedWhy = await why(doomed.propositionId);
    expect(erasedWhy.statusCode, erasedWhy.body).toBe(404);
    expect(erasedWhy.json().code).toBe('WHY_OBJECT_NOT_FOUND');
    const controlWhy = await why(control.propositionId);
    expect(controlWhy.statusCode, controlWhy.body).toBe(200);
    expect(controlWhy.json().statement).toContain(controlValue);

    // A previous assistant conversation remains separate history. Its quote is
    // deliberately still present, making the non-reconstruction check meaningful.
    const retainedAnswer = (await admin.query(`SELECT a.normalized_text FROM source_anchors a
      JOIN source_items s ON s.owner_scope_id=a.owner_scope_id AND s.id=a.source_item_id
      WHERE s.owner_scope_id=$1 AND s.id=$2 AND s.deleted_at IS NULL`, [o.owner, assistantEvidenceId])).rows;
    expect(retainedAnswer.map(row => row.normalized_text).join('\n')).toContain(erasedValue);
    const rawAnswer = await app.inject({ method: 'GET', url: '/v1/evidence/' + assistantEvidenceId,
      headers: evidenceHeaders(o, 'evidence.read') });
    expect(rawAnswer.statusCode, rawAnswer.body).toBe(200);

    for (const overrides of [{}, { question: 'What did Uai believe at that time about what I owe?',
      worldTime: historicalAt, knowledgeTime: historicalAt }]) {
      const answer = await ask(overrides);
      expect(JSON.stringify(answer)).not.toContain(erasedValue);
      expect(JSON.stringify(answer.statements)).toContain(controlValue);
      expect(answer.sourceLinks.map((link: { evidenceId: string }) => link.evidenceId)).toContain(control.evidenceId);
      expect(answer.sourceLinks.map((link: { evidenceId: string }) => link.evidenceId)).not.toContain(assistantEvidenceId);
      const packet = (await packetOf(answer.packetId)).packet;
      expect(JSON.stringify(packet)).not.toContain(erasedValue);
      expect(packet.currentBeliefs.map(value => value.propositionId)).toContain(control.propositionId);
      expect(packet.currentBeliefs.map(value => value.propositionId)).not.toContain(doomed.propositionId);
      expect(packet.semanticSearch!.matches.map(match => match.objectId)).toContain(control.claimId);
      expect((packet.semanticSearch?.matches ?? []).flatMap(match => match.evidenceIds)).not.toContain(assistantEvidenceId);
    }
  } finally { await app.close(); }
});

it('CRT-NFR-04-A and CRT-SEC-06-A: export carries raw evidence and canonical memory, regeneration restores semantic search, and a deletion leaves nothing retrievable', async () => {
  const app = api();
  const o = data;
  try {
    // Two documents stored through the real upload path: the raw bytes, the
    // anchors and the lexical index are the production ones.
    const upload = async (documentId: string, text: string) => {
      const response = await app.inject({ method: 'POST', url: '/v1/documents', headers: evidenceHeaders(o, 'evidence.ingest'),
        payload: { documentId, title: documentId, pages: [{ page: 1, text }], sensitivity: 'PRIVATE', allowedPurposes: [FINANCE],
          base64: Buffer.from(text).toString('base64') } });
      expect(response.statusCode, response.body).toBe(201);
      const evidenceId = response.json().evidenceId as string;
      const anchorId = (await admin.query("SELECT id FROM source_anchors WHERE source_item_id=$1 AND anchor_kind='DOCUMENT_RANGE'", [evidenceId])).rows[0].id as string;
      return { evidenceId, anchorId };
    };
    const doomed = await upload('loan-note', MARKER + ' note: I borrowed 75 ILS from Dana');
    const kept = await upload('other-note', 'Eli lent me 30 ILS');
    const dana = await entity(o, 'Dana'), eli = await entity(o, 'Eli');
    const eliFrame = await obligation(o, eli);
    // The doomed frame's creditor role is extracted from the doomed claim, as a
    // real extraction records it, so the role goes with the claim.
    const danaFrame = { frame: randomUUID(), slot: randomUUID() };
    await admin.query("INSERT INTO frame_instances(id,owner_scope_id,frame_type_id,context_space_id) VALUES($1,$2,'shared.obligation',$3)",
      [danaFrame.frame, o.owner, o.base]);
    await admin.query(`INSERT INTO belief_slots(id,owner_scope_id,frame_instance_id,predicate_id,context_space_id,modality)
      VALUES($1,$2,$3,'shared.obligation.principal_amount',$4,'ACTUAL')`, [danaFrame.slot, o.owner, danaFrame.frame, o.base]);
    const principal = await belief(o, { slot: danaFrame.slot, value: { amount: '75.00', currency: 'ILS', note: MARKER }, anchorId: doomed.anchorId, assessment: 'ACCEPTED' });
    await admin.query("INSERT INTO frame_instance_roles(id,owner_scope_id,frame_instance_id,role_id,entity_id,claim_id) VALUES($1,$2,$3,'creditor',$4,$5)",
      [randomUUID(), o.owner, danaFrame.frame, dana, principal.claimId]);
    const survivor = await belief(o, { slot: eliFrame.slot, value: { amount: '30.00', currency: 'ILS' }, anchorId: kept.anchorId, assessment: 'ACCEPTED' });
    // A derived belief whose only input is the doomed value.
    const derivedSlot = randomUUID(), derived = randomUUID();
    await admin.query(`INSERT INTO belief_slots(id,owner_scope_id,frame_instance_id,predicate_id,context_space_id,modality)
      VALUES($1,$2,$3,'shared.obligation.description',$4,'ACTUAL')`, [derivedSlot, o.owner, danaFrame.frame, o.base]);
    await admin.query('INSERT INTO propositions(id,owner_scope_id,belief_slot_id,normalized_value) VALUES($1,$2,$3,$4)',
      [derived, o.owner, derivedSlot, JSON.stringify({ text: MARKER + ' derived remainder' })]);
    await admin.query(`INSERT INTO belief_assessments(id,owner_scope_id,proposition_id,assessment_status,policy_version,
      transaction_id,decision_reason,recorded_at) VALUES($1,$2,$3,'ACCEPTED','local-policy-0.1.0',$4,'{"code":"FIXTURE"}',$5)`,
      [randomUUID(), o.owner, derived, o.transaction, RECORDED_AT]);
    await admin.query(`INSERT INTO belief_support(id,owner_scope_id,proposition_id,supporting_proposition_id,support_kind,
      created_by_transaction_id) VALUES($1,$2,$3,$4,'DERIVATION',$5)`, [randomUUID(), o.owner, derived, principal.propositionId, o.transaction]);
    await admin.query(`INSERT INTO derived_proposition_dependencies(id,owner_scope_id,derived_proposition_id,input_claim_ids,
      input_proposition_ids,evaluator_id,model_or_code_version,registry_release_id,calculation_inputs,created_by_transaction_id)
      VALUES($1,$2,$3,'{}',ARRAY[$4::uuid],'finance.obligation_total','obligation-total-0.1.0',$5,'{}',$6)`,
      [randomUUID(), o.owner, derived, principal.propositionId, registryReleaseId, o.transaction]);
    // The other derivatives the cascade must reach.
    await admin.query(`INSERT INTO memory_summaries(id,owner_scope_id,summary_text,source_object_manifest,source_object_ids,model_id,prompt_version)
      VALUES($1,$2,$3,$4,ARRAY[$5::uuid],'fixture-model','summary-0.1.0')`,
      [randomUUID(), o.owner, 'You owe Dana 75 ILS (' + MARKER + ')', JSON.stringify([{ objectType: 'claim', objectId: principal.claimId }]), principal.claimId]);
    const thread = randomUUID();
    await admin.query("INSERT INTO memory_threads(id,owner_scope_id,display_title) VALUES($1,$2,'Dana loan')", [thread, o.owner]);
    await admin.query(`INSERT INTO memory_thread_members(owner_scope_id,memory_thread_id,object_type,object_id,membership_kind)
      VALUES($1,$2,'claim',$3,'SUBJECT')`, [o.owner, thread, principal.claimId]);
    await admin.query(`INSERT INTO obligations_projection(owner_scope_id,obligation_frame_instance_id,debtor_entity_id,
      creditor_entity_id,principal_amount,currency,total_canonical_allocation,remaining_amount_capability_derived,
      outcome_state,conflict_flag,overlay_complete,projection_version,canonical_transaction_watermark,
      owner_overlay_watermark,reducer_version,is_complete,source_manifest,updated_at)
      VALUES($1,$2,$3,$3,75.00,'ILS',0,75.00,'UNRESOLVED',false,true,$4,$5,0,'projection-reducers-0.1.0',true,'{}',$5)`,
      [o.owner, danaFrame.frame, dana, randomUUID(), RECORDED_AT]);
    await admin.query(`INSERT INTO owner_overlay_deltas(id,owner_scope_id,owner_sequence,source_evidence_id,raw_text,delta_kind,lifecycle)
      VALUES($1,$2,1,$3,$4,'USER_ASSERTION','RECEIVED')`, [randomUUID(), o.owner, doomed.evidenceId, 'I owe Dana ' + MARKER]);
    await admin.query(`INSERT INTO entity_aliases(id,owner_scope_id,entity_id,alias_type,alias_value,normalized_value,source_item_id)
      VALUES($1,$2,$3,'DISPLAY_NAME',$4,$5,$6)`, [randomUUID(), o.owner, dana, 'Dana ' + MARKER, 'dana ' + MARKER.toLowerCase(), doomed.evidenceId]);

    // --- Export: raw evidence and canonical memory, for this owner only.
    const exported = await app.inject({ method: 'POST', url: '/v1/export', headers: headers(o, 'data.export', { 'x-maximum-sensitivity': 'RESTRICTED' }),
      payload: { includeRawEvidence: true } });
    expect(exported.statusCode, exported.body).toBe(201);
    const bundle = exportBundleSchema.parse(exported.json().bundle);
    expect(bundle.ownerScopeId).toBe(o.owner);
    const exportedDoomed = bundle.evidence.find(item => item.evidenceId === doomed.evidenceId)!;
    const rawRef = (await admin.query('SELECT raw_object_ref FROM source_items WHERE id=$1', [doomed.evidenceId])).rows[0].raw_object_ref as string;
    expect(Buffer.from(exportedDoomed.rawContentBase64!, 'base64').equals(Buffer.from(stored.get(rawRef)!))).toBe(true);
    expect(exportedDoomed.anchors.some(anchor => (anchor.normalizedText ?? '').includes(MARKER))).toBe(true);
    const ids = (rows: Record<string, unknown>[]) => rows.map(row => row['id']);
    expect(ids(bundle.canonicalMemory.propositions)).toEqual(expect.arrayContaining([principal.propositionId, survivor.propositionId, derived]));
    expect(ids(bundle.canonicalMemory.claims)).toEqual(expect.arrayContaining([principal.claimId, survivor.claimId]));
    expect(ids(bundle.canonicalMemory.entities)).toEqual(expect.arrayContaining([dana, eli]));
    expect(bundle.canonicalMemory.memorySummaries).toHaveLength(1);
    expect(JSON.stringify(bundle)).not.toMatch(/object_store_key|raw\/[0-9a-f]{64}/);
    // The declared ceiling still binds an export.
    const lowered = await app.inject({ method: 'POST', url: '/v1/export', headers: headers(o, 'data.export', { 'x-maximum-sensitivity': 'NORMAL' }),
      payload: { includeRawEvidence: true } });
    expect(lowered.json().bundle.evidence).toEqual([]);

    // --- Semantic index: build it, read it, drop every embedding, regenerate it.
    const search = async () => {
      const response = await app.inject({ method: 'POST', url: '/v1/memory/context', headers: headers(o, 'memory.read'),
        payload: { ownerScopeId: o.owner, requestingActorId: o.actor, purpose: FINANCE, query: 'Dana obligation principal amount ILS',
          worldTime: 'NOW', knowledgeTime: 'LATEST', maximumSensitivity: 'RESTRICTED', actionRisk: 'LOW' } });
      expect(response.statusCode, response.body).toBe(201);
      return response.json();
    };
    const regenerate = async (body: Record<string, unknown>) => {
      const response = await app.inject({ method: 'POST', url: '/v1/memory/embeddings/regenerate', headers: headers(o, 'memory.reindex'), payload: body });
      expect(response.statusCode, response.body).toBe(200);
      return response.json();
    };
    expect((await regenerate({})).indexed).toBeGreaterThanOrEqual(2);
    const original = (await search()).semanticSearch.matches as Array<{ objectId: string; distance: number }>;
    expect(original.map(match => match.objectId)).toEqual(expect.arrayContaining([principal.claimId, survivor.claimId]));
    const dropped = await regenerate({ dropExisting: true, regenerate: false });
    expect(dropped.dropped).toBeGreaterThanOrEqual(2);
    expect(await count('SELECT count(*) AS n FROM memory_embeddings WHERE owner_scope_id=$1', [o.owner])).toBe(0);
    expect((await search()).semanticSearch.matches).toEqual([]);
    await regenerate({ dropExisting: false, regenerate: true });
    const restored = (await search()).semanticSearch.matches as Array<{ objectId: string; distance: number }>;
    expect(restored.map(match => [match.objectId, match.distance])).toEqual(original.map(match => [match.objectId, match.distance]));

    // --- Deletion: the preview says what will go and removes nothing.
    const packet = await search();
    expect(packet.currentBeliefs.map((item: { propositionId: string }) => item.propositionId)).toContain(principal.propositionId);
    // Records other nodes compose from memory (migrations 0022 and 0023): one of
    // each names the doomed item's frame, claim or evidence and must go with it;
    // one of each names nothing deleted and must stay.
    const composed = async (named: string, evidenceId: string) => {
      const edition = randomUUID(), card = randomUUID(), observation = randomUUID(), review = randomUUID();
      await admin.query(`INSERT INTO briefing_editions(id,owner_scope_id,requesting_actor_id,owner_local_date,timezone,utc_offset,
        generated_at,context_packet_id,packet_hash,packet_manifest,ranking_version)
        VALUES($1,$2,$3,'2026-09-19','UTC','+00:00',now(),$4,$5,'{}','briefing-ranking-0.1.0')`,
        [edition, o.owner, o.actor, packet.packetId, 'e'.repeat(64)]);
      await admin.query(`INSERT INTO briefing_items(id,owner_scope_id,briefing_edition_id,item_object_type,item_object_id,domain_section,
        headline,why_surfaced,rank_components,rank_score,priority,certainty_label,past_target,outcome_state,material_fingerprint,rank_position)
        VALUES($1,$2,$3,'frame_instance',$4,'FINANCE','Obligation','Due today',
        '{"consequence":1,"urgency":1,"goalRelevance":0.5,"confidence":1,"effort":0.5,"reversibility":0.2,"attentionBudget":1}',
        0.9,'HIGH','CONFIRMED',false,'UNRESOLVED',$5,1)`, [randomUUID(), o.owner, edition, named, 'd'.repeat(64)]);
      await admin.query(`INSERT INTO clarification_cards(id,owner_scope_id,situation_key,situation_kind,title,facts,why_it_matters,choices,
        grouped_ambiguity_ids,ambiguities,sensitivity_scope,policy_inputs,evidence_ids,context_packet_id)
        VALUES($1,$2,$3,'GENERAL','Unconfirmed details','[]','Answers about it are marked uncertain.','[{},{}]',ARRAY[$4::uuid],'[]',
        'FINANCE/PRIVATE','{}',ARRAY[$5::uuid],$6)`, [card, o.owner, 'frame:' + randomUUID(), randomUUID(), evidenceId, packet.packetId]);
      await admin.query(`INSERT INTO interruption_decisions(id,owner_scope_id,clarification_card_id,candidate_ambiguity_id,ambiguity_kind,
        policy_inputs,decision,reason,owner_local_date,policy_version)
        VALUES($1,$2,$3,$4,'UNCONFIRMED_INTERPRETATION','{"errorProbability":0.4,"consequence":"HIGH","irreversibility":"REVERSIBLE","urgency":"LOW","interruptionCost":"LOW","budget":{}}',
        'ASK','WITHIN_ATTENTION_BUDGET','2026-09-19','interruption-policy-0.1.0')`, [randomUUID(), o.owner, card, randomUUID()]);
      await admin.query(`INSERT INTO behavioral_observations(id,owner_scope_id,pattern_kind,statement,supporting_episode_ids,supporting_episodes,
        counterexample_search,observation_window_start,observation_window_end,confidence,review_or_expiry_date,context_packet_id)
        VALUES($1,$2,'REPEATED_POSTPONEMENT','Due dates were moved later 2 times.',ARRAY[$3::uuid,$4::uuid],'[{},{}]',
        '{"searched":"x","counterexamplesFound":0,"counterexampleIds":[]}','2026-08-01T00:00:00Z','2026-09-01T00:00:00Z',1,'2026-10-01',$5)`,
        [observation, o.owner, named, randomUUID(), packet.packetId]);
      await admin.query(`INSERT INTO weekly_reviews(id,owner_scope_id,week_start,week_end,time_zone,priority_versus_calendar,
        commitments_versus_resolutions,decisions_versus_outcomes,planned_versus_observed_spending,material_changes,repeated_postponement,
        behavioral_observation_ids,context_packet_id,packet_hash,manifest,statement_count,review_version)
        VALUES($1,$2,'2026-09-14','2026-09-20','UTC','{}',$3,'{}','{}','{}','{}',ARRAY[$4::uuid],$5,$6,'{}',0,'weekly-review-0.1.0')`,
        [review, o.owner, JSON.stringify({ claimIds: [named] }), observation, packet.packetId, 'e'.repeat(64)]);
      return { edition, card, observation, review };
    };
    const quoting = await composed(danaFrame.frame, doomed.evidenceId);
    const unrelated = await composed(randomUUID(), kept.evidenceId);
    const composedRows = async (rows: { edition: string; card: string; observation: string; review: string }) => [
      await count('SELECT count(*) AS n FROM briefing_editions WHERE id=$1', [rows.edition]),
      await count('SELECT count(*) AS n FROM briefing_items WHERE briefing_edition_id=$1', [rows.edition]),
      await count('SELECT count(*) AS n FROM clarification_cards WHERE id=$1', [rows.card]),
      await count('SELECT count(*) AS n FROM interruption_decisions WHERE clarification_card_id=$1', [rows.card]),
      await count('SELECT count(*) AS n FROM behavioral_observations WHERE id=$1', [rows.observation]),
      await count('SELECT count(*) AS n FROM weekly_reviews WHERE id=$1', [rows.review])];
    const preview = await app.inject({ method: 'POST', url: '/v1/data/deletions/preview', headers: headers(o, 'data.delete'),
      payload: { evidenceIds: [doomed.evidenceId] } });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json()).toMatchObject({ status: 'PREVIEW', requestId: null,
      cascade: { rawObjects: 1, claims: 1, unsupportedBeliefs: 2, summaries: 1, threadMemberships: 1, aliases: 1 } });
    expect(stored.has(rawRef)).toBe(true);
    expect(await count('SELECT count(*) AS n FROM claims WHERE id=$1', [principal.claimId])).toBe(1);
    // A deletion is confirmed by the owner, never one stray request.
    const unconfirmed = await app.inject({ method: 'POST', url: '/v1/data/deletions', headers: headers(o, 'data.delete'),
      payload: { evidenceIds: [doomed.evidenceId] } });
    expect(unconfirmed.statusCode).toBe(400);

    const deletion = await app.inject({ method: 'POST', url: '/v1/data/deletions', headers: headers(o, 'data.delete'),
      payload: { evidenceIds: [doomed.evidenceId], confirmation: 'DELETE' } });
    expect(deletion.statusCode, deletion.body).toBe(200);
    const receipt = deletion.json();
    expect(receipt).toMatchObject({ status: 'COMPLETED', evidenceIds: [doomed.evidenceId], auditRetainsPayload: false,
      cascade: { rawObjects: 1, claims: 1, unsupportedBeliefs: 2, summaries: 1, threadMemberships: 1, aliases: 1, overlayTextsErased: 1 } });
    for (const key of ['anchors', 'parsedContent', 'embeddings', 'searchIndexEntries', 'projectionRows', 'contextPacketsErased']) {
      expect(receipt.cascade[key], key).toBeGreaterThan(0);
    }
    expect(receipt.projectionsRebuilt).toEqual(['open_commitments_projection', 'obligations_projection', 'schedule_projection']);

    // Not retrievable by any API ...
    expect(stored.has(rawRef)).toBe(false);
    const read = await app.inject({ method: 'GET', url: '/v1/evidence/' + doomed.evidenceId, headers: evidenceHeaders(o, 'evidence.read') });
    expect(read.statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/v1/evidence/' + kept.evidenceId, headers: evidenceHeaders(o, 'evidence.read') })).statusCode).toBe(200);
    for (const propositionId of [principal.propositionId, derived]) {
      const explained = await app.inject({ method: 'GET', url: '/v1/memory/propositions/' + propositionId + '/explain', headers: evidenceHeaders(o, 'memory.inspect') });
      expect(explained.statusCode, propositionId).toBe(404);
    }
    expect((await app.inject({ method: 'GET', url: '/v1/memory/propositions/' + survivor.propositionId + '/explain',
      headers: evidenceHeaders(o, 'memory.inspect') })).statusCode).toBe(200);
    const obligations = await app.inject({ method: 'GET', url: '/v1/projections/obligations', headers: headers(o, 'projection.read') });
    expect(obligations.statusCode, obligations.body).toBe(200);
    // Replay keeps only what canonical memory still supports: no row names the
    // deleted claim, value, creditor or amount.
    const projected = JSON.stringify(obligations.json());
    for (const gone of [principal.claimId, principal.propositionId, dana, MARKER, '"75.00"']) expect(projected, gone).not.toContain(gone);
    expect(projected).toContain(survivor.propositionId);
    const threadView = await app.inject({ method: 'GET', url: '/v1/memory/threads/' + thread, headers: evidenceHeaders(o, 'memory.inspect') });
    expect(JSON.stringify(threadView.json())).not.toContain(principal.claimId);
    const reexported = exportBundleSchema.parse((await app.inject({ method: 'POST', url: '/v1/export',
      headers: headers(o, 'data.export', { 'x-maximum-sensitivity': 'RESTRICTED' }), payload: {} })).json().bundle);
    expect(JSON.stringify(reexported)).not.toContain(MARKER);
    expect(reexported.evidence.map(item => item.evidenceId)).toEqual([kept.evidenceId]);
    // ... nor by any search: the lexical document index and the semantic index.
    const lexical = await app.inject({ method: 'GET', url: '/v1/documents/search?q=' + MARKER, headers: evidenceHeaders(o, 'evidence.read') });
    expect(lexical.statusCode, lexical.body).toBe(200);
    expect(lexical.json().hits).toEqual([]);
    const after = await search();
    expect(JSON.stringify(after)).not.toContain(MARKER);
    expect(after.currentBeliefs.map((item: { propositionId: string }) => item.propositionId)).toEqual([survivor.propositionId]);
    expect(after.semanticSearch.matches.map((match: { objectId: string }) => match.objectId)).toEqual([survivor.claimId]);

    // The rows themselves: tombstone, erasures and deletions.
    const tombstone = (await admin.query('SELECT deleted_at,external_id,deterministic_metadata,actor_ref FROM source_items WHERE id=$1', [doomed.evidenceId])).rows[0];
    expect(tombstone.deleted_at).not.toBeNull();
    expect(tombstone).toMatchObject({ external_id: 'erased:' + doomed.evidenceId, deterministic_metadata: {}, actor_ref: {} });
    for (const [sql, value] of [
      ['SELECT count(*) AS n FROM source_anchors WHERE source_item_id=$1', doomed.evidenceId],
      ['SELECT count(*) AS n FROM triage_decisions WHERE source_item_id=$1', doomed.evidenceId],
      ['SELECT count(*) AS n FROM claims WHERE id=$1', principal.claimId],
      ['SELECT count(*) AS n FROM propositions WHERE id=$1', derived],
      ['SELECT count(*) AS n FROM memory_embeddings WHERE object_id=$1', principal.claimId],
      ['SELECT count(*) AS n FROM memory_summaries WHERE owner_scope_id=$1', o.owner],
      ['SELECT count(*) AS n FROM frame_instance_roles WHERE claim_id=$1', principal.claimId],
      ['SELECT count(*) AS n FROM entity_aliases WHERE source_item_id=$1', doomed.evidenceId],
    ] as const) expect(await count(sql, [value]), sql).toBe(0);
    expect(await count('SELECT count(*) AS n FROM claims WHERE id=$1', [survivor.claimId])).toBe(1);
    // The composed records that named it are gone; the others are untouched.
    expect(await composedRows(quoting)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(await composedRows(unrelated)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(receipt.cascade.derivedRecords).toBe(6);
    expect((await admin.query('SELECT raw_text FROM owner_overlay_deltas WHERE source_evidence_id=$1', [doomed.evidenceId])).rows[0].raw_text).toBe('[erased]');
    expect(await count("SELECT count(*) AS n FROM context_packets WHERE owner_scope_id=$1 AND packet::text LIKE '%'||$2||'%'",
      [o.owner, principal.propositionId])).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM context_packets WHERE owner_scope_id=$1 AND packet='{"erased":true}'`, [o.owner])).toBeGreaterThan(0);

    // Audit records keep identifiers and field names, never the content.
    const audit = (await admin.query('SELECT objects_and_fields_accessed FROM audit_events WHERE owner_scope_id=$1', [o.owner])).rows;
    expect(audit.length).toBeGreaterThan(0);
    expect(JSON.stringify(audit)).not.toContain(MARKER);
    const deletionAudit = (await admin.query(`SELECT objects_and_fields_accessed FROM audit_events WHERE owner_scope_id=$1 AND purpose='data.delete'
      AND result='SUCCESS'`, [o.owner])).rows.map(row => row.objects_and_fields_accessed).flat();
    expect(deletionAudit).toEqual(expect.arrayContaining([{ type: 'source_items', id: doomed.evidenceId, fields: ['deleted_at'] }]));
    const requestRow = (await admin.query("SELECT scope,cascade_receipt FROM retention_and_deletion_requests WHERE owner_scope_id=$1 AND request_kind='DELETE'", [o.owner])).rows;
    expect(JSON.stringify(requestRow)).not.toContain(MARKER);

    // The same content stored again is a new item, not the tombstone.
    const again = await upload('loan-note', MARKER + ' note: I borrowed 75 ILS from Dana');
    expect(again.evidenceId).not.toBe(doomed.evidenceId);
    // Another owner can neither preview nor delete this owner's evidence.
    const foreign = await app.inject({ method: 'POST', url: '/v1/data/deletions', headers: headers(permissions, 'data.delete'),
      payload: { evidenceIds: [kept.evidenceId], confirmation: 'DELETE' } });
    expect(foreign.statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/v1/evidence/' + kept.evidenceId, headers: evidenceHeaders(o, 'evidence.read') })).statusCode).toBe(200);
  } finally { await app.close(); }
});
