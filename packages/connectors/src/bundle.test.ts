import { Pool } from 'pg';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { runMigrations, withOwnerTransaction, type OwnerTransaction } from '@unai/postgres';
import { uuidV7 } from '../../../src/kernel/identities.js';
import { buildPluginContextBundle } from './bundle.js';
import { createConnector } from './grants.js';

/**
 * The least-context rule over real PostgreSQL (PRD §27.3, CRT-SEC-03-A).
 *
 * The owner in this fixture has health, family and financial memory, all of it
 * readable by the assistant. A work-email plugin operation then asks for context
 * through the capability it was granted, and receives none of it: not the health
 * appointment, not the family arrangement, not the obligation amount -- and not
 * the work item whose evidence also admits a financial purpose, which is the case
 * a purpose filter alone would let through.
 */

if (!process.env.UNAI_TEST_DATABASE_URL) throw new Error('Run pnpm test for the required PostgreSQL harness');
const admin = new Pool({ connectionString: process.env.UNAI_TEST_DATABASE_URL });
const appUrl = new URL(process.env.UNAI_TEST_DATABASE_URL); appUrl.username = 'bundle_test_app'; appUrl.password = 'test-only';
const appPool = new Pool({ connectionString: appUrl.href });

const owner = randomUUID(), actor = randomUUID();
const NOW = new Date('2026-03-02T09:00:00.000Z');
const RECORDED_AT = new Date('2026-02-01T09:00:00.000Z');
let baseContext = '', transactionId = '', registryReleaseId = '', connectorId = '';
const propositions: Record<string, string> = {};

const as = <T,>(purpose: string, run: (tx: OwnerTransaction) => Promise<T>) =>
  withOwnerTransaction(appPool, { actorId: actor, ownerScopeId: owner, purpose, correlationId: randomUUID() }, run);
const readRunner = <T,>(run: (tx: OwnerTransaction) => Promise<T>) => as('memory.read', run);

async function evidenceRow(input: { externalId: string; allowedPurposes: string[]; sensitivity?: string }): Promise<{ evidenceId: string; anchorId: string }> {
  const evidenceId = randomUUID(), anchorId = randomUUID();
  await admin.query(`INSERT INTO source_items(id,owner_scope_id,connector_id,source_type,external_id,actor_ref,
    submitted_by_user_id,raw_object_ref,content_hash,sensitivity,allowed_purposes,ingestion_version,idempotency_key,occurred_at)
    VALUES($1,$2,NULL,'CONVERSATION',$3,$4,$5,$6,$7,$8,$9,'evidence-json-v1',$10,$11)`,
    [evidenceId, owner, input.externalId, JSON.stringify({ type: 'USER', id: actor }), actor, randomUUID(),
      randomUUID().replaceAll('-', '').padEnd(64, 'a').slice(0, 64), input.sensitivity ?? 'NORMAL',
      input.allowedPurposes, randomUUID(), new Date('2026-02-01T08:00:00.000Z')]);
  await admin.query(`INSERT INTO source_anchors(id,owner_scope_id,source_item_id,anchor_kind,anchor,normalized_text)
    VALUES($1,$2,$3,'MESSAGE_SPAN','{"start":0,"end":10}',$4)`, [anchorId, owner, evidenceId, input.externalId]);
  return { evidenceId, anchorId };
}

/** One accepted belief in one frame, grounded in one evidence item. */
async function belief(input: { frameTypeId: string; predicateId: string; value: unknown; allowedPurposes: string[] }): Promise<string> {
  const frameInstanceId = uuidV7(), slotId = uuidV7(), propositionId = uuidV7(), claimId = uuidV7();
  const { anchorId } = await evidenceRow({ externalId: input.predicateId, allowedPurposes: input.allowedPurposes });
  await admin.query('INSERT INTO frame_instances(id,owner_scope_id,frame_type_id,context_space_id) VALUES($1,$2,$3,$4)',
    [frameInstanceId, owner, input.frameTypeId, baseContext]);
  await admin.query(`INSERT INTO belief_slots(id,owner_scope_id,frame_instance_id,predicate_id,context_space_id,modality)
    VALUES($1,$2,$3,$4,$5,'ACTUAL')`, [slotId, owner, frameInstanceId, input.predicateId, baseContext]);
  await admin.query('INSERT INTO propositions(id,owner_scope_id,belief_slot_id,normalized_value) VALUES($1,$2,$3,$4)',
    [propositionId, owner, slotId, JSON.stringify(input.value)]);
  await admin.query(`INSERT INTO claims(id,owner_scope_id,source_anchor_id,proposition_id,claim_origin,lifecycle,
    valid_from,recorded_at) VALUES($1,$2,$3,$4,'USER_STATEMENT','PROVISIONAL',$5,$6)`,
    [claimId, owner, anchorId, propositionId, new Date('2026-02-01T08:00:00.000Z'), RECORDED_AT]);
  await admin.query(`INSERT INTO belief_assessments(id,owner_scope_id,proposition_id,assessment_status,policy_version,
    transaction_id,decision_reason,recorded_at) VALUES($1,$2,$3,'ACCEPTED','local-policy-0.1.0',$4,'{"code":"FIXTURE"}',$5)`,
    [randomUUID(), owner, propositionId, transactionId, RECORDED_AT]);
  await admin.query(`INSERT INTO belief_support(id,owner_scope_id,proposition_id,claim_id,support_kind,
    independence_group,created_by_transaction_id) VALUES($1,$2,$3,$4,'DIRECT_ASSERTION',$5,$6)`,
    [randomUUID(), owner, propositionId, claimId, 'source:' + anchorId.slice(0, 8), transactionId]);
  return propositionId;
}

beforeAll(async () => {
  await runMigrations(admin, resolve('migrations'));
  await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='bundle_test_app') THEN CREATE ROLE bundle_test_app LOGIN PASSWORD 'test-only'; END IF; END $$; GRANT unai_app TO bundle_test_app");
  await admin.query('INSERT INTO users(id,display_name) VALUES($1,$2)', [actor, 'Bundle owner']);
  await admin.query("INSERT INTO owner_scopes(id,scope_kind,display_name,created_by_user_id) VALUES($1,'PERSONAL','Bundle',$2)", [owner, actor]);
  await admin.query("INSERT INTO owner_scope_members(owner_scope_id,user_id,role) VALUES($1,$2,'OWNER')", [owner, actor]);
  baseContext = (await admin.query('SELECT id FROM context_spaces WHERE owner_scope_id=$1', [owner])).rows[0].id;
  registryReleaseId = randomUUID();
  transactionId = randomUUID();
  await admin.query(`INSERT INTO belief_transactions(id,owner_scope_id,transaction_kind,requested_by_actor_id,
    source_evidence_ids,registry_release_id,status,risk,idempotency_key,commit_receipt,committed_at)
    VALUES($1,$2,'CANONICALIZE',$3,'{}',$4,'COMMITTED','LOW',$5,'{}',$6)`,
    [transactionId, owner, actor, registryReleaseId, randomUUID().replaceAll('-', ''), RECORDED_AT]);

  // The owner's memory, across four life categories. Every one of them is
  // readable by the assistant; the question is what one plugin operation gets.
  propositions.work = await belief({
    frameTypeId: 'work.project_task', predicateId: 'work.project_task.status',
    value: { status: 'IN_REVIEW' }, allowedPurposes: ['WORK_ASSISTANCE'],
  });
  propositions.health = await belief({
    frameTypeId: 'health.appointment', predicateId: 'health.appointment.time',
    value: { time: '2026-03-04T10:00:00.000Z' }, allowedPurposes: ['HEALTH_ADMINISTRATION', 'WORK_ASSISTANCE'],
  });
  propositions.family = await belief({
    frameTypeId: 'family.arrangement', predicateId: 'family.arrangement.pickup',
    value: { who: 'Noa' }, allowedPurposes: ['FAMILY_COORDINATION', 'WORK_ASSISTANCE'],
  });
  propositions.finance = await belief({
    frameTypeId: 'shared.obligation', predicateId: 'shared.obligation.principal_amount',
    value: { amount: '4200.00', currency: 'ILS' }, allowedPurposes: ['PERSONAL_FINANCE', 'WORK_ASSISTANCE'],
  });
  // The hard case: a work frame whose evidence also admits a financial purpose.
  // A purpose filter alone would supply it to the work-email operation.
  propositions.workFinance = await belief({
    frameTypeId: 'work.expense_claim', predicateId: 'work.expense_claim.amount',
    value: { amount: '380.00', currency: 'ILS' }, allowedPurposes: ['WORK_ASSISTANCE', 'PERSONAL_FINANCE'],
  });

  connectorId = (await as('connector.manage', tx => createConnector(tx, {
    connectorType: 'GMAIL', externalAccountRef: 'work@example.test', secretRef: 'secret://mounted/gmail#refresh',
    requestedCapabilities: [{ capabilityId: 'gmail.read_metadata', granted: true },
      { capabilityId: 'gmail.read_content', granted: true }],
  }))).connectorId;
});
afterAll(async () => { await appPool.end(); await admin.end(); });

const options = () => ({ correlationId: randomUUID(), now: NOW, registryReleaseId, registryRelease: '0.1.0' });

it('CRT-SEC-03-A: a work-email operation receives no health, family or full financial object', async () => {
  const bundle = await buildPluginContextBundle(readRunner, {
    connectorId, capabilityId: 'gmail.read_content', ownerScopeId: owner, requestingActorId: actor,
    query: 'What is the status of the review thread I am replying to?',
  }, options());

  expect(bundle.purpose).toBe('WORK_ASSISTANCE');
  expect(bundle.lifeCategory).toBe('WORK');
  expect([...bundle.excludedLifeCategories].sort()).toEqual(['FAMILY', 'FINANCE', 'HEALTH']);
  const supplied = bundle.beliefs.map(belief => (belief as { propositionId: string }).propositionId);
  expect(supplied).toContain(propositions.work);
  for (const excluded of ['health', 'family', 'finance', 'workFinance'] as const) {
    expect(supplied, excluded).not.toContain(propositions[excluded]);
  }
  // Nothing of the excluded objects is in the bundle at all, not even a value.
  const serialized = JSON.stringify(bundle.beliefs) + JSON.stringify(bundle.futureClaims) + JSON.stringify(bundle.evidenceRefs);
  expect(serialized).not.toContain('4200.00');
  expect(serialized).not.toContain('380.00');
  expect(serialized).not.toContain('Noa');
  expect(serialized).not.toContain('health.appointment');
  expect(serialized).not.toContain('family.arrangement');
  // What was withheld is named rather than silently missing.
  const withheldIds = bundle.withheld.map(entry => entry.objectId);
  expect(withheldIds).toContain(propositions.workFinance);
  expect(bundle.withheld.every(entry => entry.reason === 'LEAST_CONTEXT_CATEGORY_EXCLUDED')).toBe(true);
  // A bundle grants no action.
  expect(bundle.allowedActions).toEqual(['ANSWER_WITH_CITATIONS']);

  // The same owner memory *is* reachable by a capability whose profile admits it,
  // so the absence above is a decision about this operation and not an empty
  // owner: the finance object exists and this operation did not receive it.
  expect((await admin.query('SELECT count(*)::int AS n FROM propositions WHERE owner_scope_id=$1', [owner])).rows[0].n).toBe(5);
});

it('CRT-CON-07-A: an operation whose capability was not granted receives no bundle at all', async () => {
  const denied = (await as('connector.manage', async tx => {
    await tx.query(
      `UPDATE connector_capability_grants SET granted=false,revoked_at=now()
       WHERE owner_scope_id=$1 AND connector_id=$2 AND capability_id='gmail.read_content'`, [owner, connectorId]);
    return true;
  }));
  expect(denied).toBe(true);
  await expect(buildPluginContextBundle(readRunner, {
    connectorId, capabilityId: 'gmail.read_content', ownerScopeId: owner, requestingActorId: actor,
    query: 'What is the status of the review thread?',
  }, options())).rejects.toThrow('CONNECTOR_CAPABILITY_NOT_GRANTED');
  // ...and no packet was written for the refused operation.
  const packets = (await admin.query(
    `SELECT count(*)::int AS n FROM context_packets WHERE owner_scope_id=$1`, [owner])).rows[0].n;
  const stillGranted = await buildPluginContextBundle(readRunner, {
    connectorId, capabilityId: 'gmail.read_metadata', ownerScopeId: owner, requestingActorId: actor,
    query: 'What is the status of the review thread?',
  }, options());
  expect(stillGranted.capabilityId).toBe('gmail.read_metadata');
  expect((await admin.query(`SELECT count(*)::int AS n FROM context_packets WHERE owner_scope_id=$1`, [owner])).rows[0].n)
    .toBe(packets + 1);
});
