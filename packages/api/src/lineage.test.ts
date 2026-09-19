import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { runMigrations, withOwnerTransaction, type OwnerTransaction } from '@unai/postgres';
import { postgresAdapter, SESSION_COOKIE } from '@unai/auth';
import {
  createFrameInstance, lookupBeliefSlot, recordClaim, recordFrameInstanceLineage, recordFrameInstanceRole,
  recordInstanceMatchCandidate, recordOverlayDelta, resolveBeliefSlot, resolveEntity, resolveEntityReference,
  resolveProposition,
} from '@unai/memory';
import { applyProjectionDelta, readProjectionRows } from '@unai/capabilities';
import type { ObligationProjectionRow } from '@unai/domain';
import { createPlatformApi } from './platform.js';

/**
 * Governed merge and split over the real boundary (PRD §14, §35.11, §44.13,
 * §44.14; CRT-MEM-10-A, CRT-MEM-10-B, CRT-MEM-10-C).
 *
 * Everything runs through `createPlatformApi` under the low-privilege
 * application role: TLS, session, owner scope, purpose, correlation id,
 * idempotency key, the write governor's propose and commit, the lineage and
 * retirement triggers of migration 0018, and the projection rebuild under
 * `memory.project`. Fixtures are written through the `@unai/memory` stores so
 * every slot and proposition carries the lookup fingerprint a real one has.
 */

if (!process.env.UNAI_TEST_DATABASE_URL) throw new Error('Run pnpm test for the required PostgreSQL harness');
const admin = new Pool({ connectionString: process.env.UNAI_TEST_DATABASE_URL });
const url = new URL(process.env.UNAI_TEST_DATABASE_URL); url.username = 'lineage_test_app'; url.password = 'test-only';
const appPool = new Pool({ connectionString: url.href });

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PRINCIPAL = 'shared.obligation.principal_amount';
const DUE = 'shared.obligation.due_time';
const registryReleaseId = randomUUID();
let owner = '', token = '', userId = '', contextSpaceId = '', sourceItemId = '', acceptingTransactionId = '';
let ownerEntityId = '', danielEntityId = '';
const anchors: string[] = [];
const anchor = () => anchors.shift()!;

beforeAll(async () => {
  await runMigrations(admin, resolve('migrations'));
  await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='lineage_test_app') THEN CREATE ROLE lineage_test_app LOGIN PASSWORD 'test-only'; END IF; END $$; GRANT unai_app TO lineage_test_app");
  const adapter = postgresAdapter(admin);
  const user = await adapter.createUser!({ name: 'Lineage', email: 'lineage@example.test', emailVerified: null });
  userId = user.id;
  owner = (user as unknown as { ownerScopeId: string }).ownerScopeId;
  token = randomBytes(32).toString('base64url');
  await adapter.createSession!({ userId: user.id, sessionToken: token, expires: new Date(Date.now() + 604800000) });
  contextSpaceId = (await admin.query("SELECT id FROM context_spaces WHERE owner_scope_id=$1 AND context_kind='BASE'", [owner])).rows[0].id;

  const connectorId = randomUUID(); sourceItemId = randomUUID();
  await admin.query("INSERT INTO connectors(id,owner_scope_id,connector_type,external_account_ref,permission_manifest,status) VALUES($1,$2,'CONVERSATION',$3,'{}','ACTIVE')", [connectorId, owner, owner]);
  await admin.query(`INSERT INTO source_items(id,owner_scope_id,connector_id,source_type,external_id,actor_ref,submitted_by_user_id,
    raw_object_ref,content_hash,sensitivity,allowed_purposes,ingestion_version,idempotency_key)
    VALUES($1,$2,$3,'CONVERSATION','lineage-message-1',$4,$5,$6,$7,'PRIVATE',ARRAY['PERSONAL_ASSISTANCE'],'evidence-json-v1',$8)`,
    [sourceItemId, owner, connectorId, JSON.stringify({ type: 'USER', id: user.id }), user.id, randomUUID(), 'c'.repeat(64), randomUUID()]);
  for (let index = 0; index < 80; index += 1) {
    const id = randomUUID(); anchors.push(id);
    await admin.query(`INSERT INTO source_anchors(id,owner_scope_id,source_item_id,anchor_kind,anchor) VALUES($1,$2,$3,'MESSAGE_SPAN',$4)`,
      [id, owner, sourceItemId, JSON.stringify({ start: index * 10, end: index * 10 + 9 })]);
  }
  // The earlier governed transaction whose verdicts the fixtures carry.
  acceptingTransactionId = randomUUID();
  await admin.query(`INSERT INTO belief_transactions(id,owner_scope_id,transaction_kind,requested_by_actor_id,registry_release_id,
    status,risk,idempotency_key,commit_receipt,committed_at) VALUES($1,$2,'CANONICALIZE',$3,$4,'COMMITTED','LOW',$5,'{}',now())`,
    [acceptingTransactionId, owner, user.id, registryReleaseId, randomUUID().replaceAll('-', '')]);
  ownerEntityId = await person('Lineage Owner', 'owner.lineage@example.test');
  danielEntityId = await person('Daniel Lineage', 'daniel.lineage@example.test');
});
afterAll(async () => { await appPool.end(); await admin.end(); });

function context(purpose: string) { return { actorId: userId, ownerScopeId: owner, purpose, correlationId: randomUUID() }; }
const as = <T,>(purpose: string, run: (tx: OwnerTransaction) => Promise<T>) => withOwnerTransaction(appPool, context(purpose), run);
const write = <T,>(run: (tx: OwnerTransaction) => Promise<T>) => as('memory.canonicalize', run);

async function person(label: string, mailbox: string): Promise<string> {
  return (await write(tx => resolveEntity(tx, { ownerScopeId: owner, entityKind: 'PERSON', canonicalLabel: label,
    aliases: [{ aliasType: 'EMAIL', aliasValue: mailbox }, { aliasType: 'DISPLAY_NAME', aliasValue: label }] }))).entityId;
}

/** One stated value in one slot of a frame, with the claim that stated it. */
async function stated(frameInstanceId: string, predicateId: string, value: unknown): Promise<{ beliefSlotId: string; propositionId: string; claimId: string }> {
  return write(async tx => {
    const slot = await resolveBeliefSlot(tx, { ownerScopeId: owner, descriptor: { frameInstanceId, predicateId,
      contextSpaceId, modality: 'ACTUAL', qualifiers: {} } });
    const proposition = await resolveProposition(tx, { ownerScopeId: owner, beliefSlotId: slot.beliefSlotId, normalizedValue: value });
    const claimId = await recordClaim(tx, { ownerScopeId: owner, sourceAnchorId: anchor(), claimOrigin: 'USER_STATEMENT',
      lifecycle: 'PROVISIONAL', propositionId: proposition.propositionId, assertedByEntityId: ownerEntityId });
    return { beliefSlotId: slot.beliefSlotId, propositionId: proposition.propositionId, claimId };
  });
}

/** One obligation: the owner owes the creditor an amount. */
async function obligation(amount: string, creditor = danielEntityId) {
  const frameInstanceId = await write(tx => createFrameInstance(tx, { ownerScopeId: owner, frameTypeId: 'shared.obligation', contextSpaceId }));
  const principal = await stated(frameInstanceId, PRINCIPAL, { amount, currency: 'ILS' });
  await write(async tx => {
    await recordFrameInstanceRole(tx, { ownerScopeId: owner, frameInstanceId, roleId: 'debtor', entityId: ownerEntityId, claimId: principal.claimId });
    await recordFrameInstanceRole(tx, { ownerScopeId: owner, frameInstanceId, roleId: 'creditor', entityId: creditor, claimId: principal.claimId });
  });
  return { frameInstanceId, ...principal };
}

async function accept(propositionId: string) {
  await admin.query(`INSERT INTO belief_assessments(id,owner_scope_id,proposition_id,assessment_status,policy_version,transaction_id)
    VALUES($1,$2,$3,'ACCEPTED','local-policy-0.1.0',$4)`, [randomUUID(), owner, propositionId, acceptingTransactionId]);
}

const project = () => as('memory.project', tx => applyProjectionDelta(tx, { ownerScopeId: owner, projectionName: 'obligations_projection', asOf: new Date() }));
const obligationRows = () => as('memory.project', async tx =>
  await readProjectionRows(tx, { ownerScopeId: owner, projectionName: 'obligations_projection' }) as ObligationProjectionRow[]);

function api() {
  const app = createPlatformApi({ authPool: admin, appPool, registryReleaseId });
  app.addHook('onRequest', async request => { Object.defineProperty(request.raw.socket, 'encrypted', { value: true }); });
  return app;
}
function headers(extra: Record<string, string> = {}) {
  return {
    cookie: SESSION_COOKIE + '=' + token, 'x-owner-scope-id': owner, 'x-purpose': 'memory.govern',
    'x-correlation-id': randomUUID(), 'idempotency-key': randomUUID().replaceAll('-', ''),
    'x-data-purpose': 'PERSONAL_ASSISTANCE', 'x-maximum-sensitivity': 'RESTRICTED', ...extra,
  };
}

/** Every row of every public table whose `id` is one of these. An id that names
 * one object names exactly one row, anywhere. */
async function rowsNamed(ids: readonly string[]): Promise<Array<{ table: string; id: string }>> {
  const tables = (await admin.query(`SELECT c.table_name FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_schema=c.table_schema AND t.table_name=c.table_name AND t.table_type='BASE TABLE'
    WHERE c.table_schema='public' AND c.column_name='id' AND c.data_type='uuid' ORDER BY c.table_name`)).rows
    .map((row: { table_name: string }) => row.table_name);
  const found: Array<{ table: string; id: string }> = [];
  for (const table of tables) {
    for (const row of (await admin.query(`SELECT id FROM ${table} WHERE id=ANY($1::uuid[])`, [[...ids]])).rows) {
      found.push({ table, id: row.id });
    }
  }
  return found.sort((left, right) => left.id.localeCompare(right.id) || left.table.localeCompare(right.table));
}

it('CRT-MEM-10-A: merging two obligation instances keeps both old ids resolvable to the survivor, reuses neither, and produces rebuild receipts', async () => {
  const app = api();
  try {
    // PRD §44.13: the owner says two obligations were one.
    const first = await obligation('50.00');
    const second = await obligation('50.00');
    await accept(first.propositionId); await accept(second.propositionId);
    await project();
    const beforeRows = (await obligationRows()).map(row => row.obligationFrameInstanceId);
    expect(beforeRows).toEqual(expect.arrayContaining([first.frameInstanceId, second.frameInstanceId]));

    const request = headers();
    const merged = await app.inject({ method: 'POST', url: '/v1/memory/frame-instances/merge', headers: request,
      payload: { instanceIds: [first.frameInstanceId, second.frameInstanceId], reason: 'It was one loan, mentioned twice' } });
    expect(merged.statusCode, merged.body).toBe(200);
    const body = merged.json();
    // Without a hint the oldest instance survives; the other is merged into it.
    expect(body.survivorFrameInstanceId).toBe(first.frameInstanceId);
    expect(body.mergedFrameInstanceIds).toEqual([second.frameInstanceId]);
    expect(body.survivorCreated).toBe(false);

    // Lineage from the merged instance, naming the governed transaction.
    expect(body.lineage).toEqual([expect.objectContaining({ objectType: 'frame_instance', fromId: second.frameInstanceId,
      toId: first.frameInstanceId, lineageKind: 'MERGED_INTO', transactionId: body.transactionId })]);
    const transaction = (await admin.query('SELECT transaction_kind,status,commit_receipt FROM belief_transactions WHERE id=$1', [body.transactionId])).rows[0];
    expect(transaction).toMatchObject({ transaction_kind: 'MERGE', status: 'COMMITTED' });
    expect((await admin.query("SELECT outcome FROM policy_decisions WHERE subject_transaction_id=$1 AND port='EvaluateMemoryWrite'", [body.transactionId])).rows)
      .toContainEqual({ outcome: 'ALLOW' });

    // PRD §14.1 items 3-6: the merged slot is rehomed with a recomputed
    // fingerprint, collides with the survivor's, and its equivalent proposition
    // is merged into the survivor's by lineage.
    const merge = body.merges[0];
    expect(merge.rehomedSlots).toEqual([expect.objectContaining({ beliefSlotId: second.beliefSlotId, predicateId: PRINCIPAL })]);
    expect(merge.rehomedSlots[0].fingerprint).not.toBe(merge.rehomedSlots[0].previousFingerprint);
    expect(merge.collidingSlots).toEqual([{ beliefSlotId: second.beliefSlotId, survivorBeliefSlotId: first.beliefSlotId, predicateId: PRINCIPAL }]);
    expect(merge.mergedPropositions).toEqual([{ fromPropositionId: second.propositionId, toPropositionId: first.propositionId, createdTarget: false }]);
    expect(merge.conflicts).toEqual([]);
    expect(body.propositionLineage).toEqual([expect.objectContaining({ fromId: second.propositionId, toId: first.propositionId,
      lineageKind: 'MERGED_INTO', transactionId: body.transactionId })]);

    // A projection-rebuild receipt per projection, each naming this merge.
    expect(body.projectionRebuildReceipts).toHaveLength(3);
    for (const receipt of body.projectionRebuildReceipts) {
      expect(receipt).toMatchObject({ trigger: 'MERGE', transactionId: body.transactionId, equalsIncremental: true });
      expect(receipt.projectionVersion).toMatch(UUID_V7);
    }
    expect((await admin.query("SELECT count(*)::int n FROM projection_rebuild_receipts WHERE transaction_id=$1 AND trigger='MERGE'", [body.transactionId])).rows[0].n).toBe(3);

    // Both old ids stay resolvable, and resolve to the survivor.
    const resolved = Object.fromEntries(body.resolution.map((entry: { id: string }) => [entry.id, entry]));
    expect(resolved[second.frameInstanceId]).toMatchObject({ objectType: 'frame_instance', lifecycle: 'MERGED', resolvesTo: [first.frameInstanceId] });
    expect(resolved[first.frameInstanceId]).toMatchObject({ lifecycle: 'ACTIVE', resolvesTo: [first.frameInstanceId] });
    expect(resolved[second.propositionId]).toMatchObject({ objectType: 'proposition', lifecycle: 'MERGED', resolvesTo: [first.propositionId] });
    expect((await admin.query('SELECT id,lifecycle,frame_type_id FROM frame_instances WHERE id=$1', [second.frameInstanceId])).rows)
      .toEqual([{ id: second.frameInstanceId, lifecycle: 'MERGED', frame_type_id: 'shared.obligation' }]);
    // A lookup for the survivor now finds the survivor's slot as the one identity.
    const lookup = await as('memory.govern', tx => lookupBeliefSlot(tx, { ownerScopeId: owner, descriptor: {
      frameInstanceId: first.frameInstanceId, predicateId: PRINCIPAL, contextSpaceId, modality: 'ACTUAL', qualifiers: {} } }));
    expect(lookup).toMatchObject({ outcome: 'MATCH_EXISTING_SLOT', identityEstablished: true });
    expect(lookup.candidates.map(candidate => candidate.beliefSlotId)).toEqual([first.beliefSlotId]);

    // Neither id is reused: each names exactly one row in the whole schema, and
    // the merged id can never be merged again or come back.
    expect(await rowsNamed([first.frameInstanceId, second.frameInstanceId])).toEqual([
      { table: 'frame_instances', id: first.frameInstanceId }, { table: 'frame_instances', id: second.frameInstanceId },
    ].sort((left, right) => left.id.localeCompare(right.id)));
    const third = await obligation('50.00');
    const again = await app.inject({ method: 'POST', url: '/v1/memory/frame-instances/merge', headers: headers(),
      payload: { instanceIds: [second.frameInstanceId, third.frameInstanceId] } });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: 'FRAME_INSTANCE_NOT_ACTIVE' });

    // The rebuilt projection projects the situation once, under the survivor,
    // carrying the claims of both statements.
    const rows = await obligationRows();
    expect(rows.map(row => row.obligationFrameInstanceId)).not.toContain(second.frameInstanceId);
    const survivor = rows.find(row => row.obligationFrameInstanceId === first.frameInstanceId)!;
    expect(survivor).toMatchObject({ principalAmount: '50.00', currency: 'ILS', conflictFlag: false, creditorEntityId: danielEntityId });
    expect(survivor.sourceManifest['claimIds']).toEqual(expect.arrayContaining([first.claimId, second.claimId]));
    expect(survivor.projectionVersion).toBe(body.projectionRebuildReceipts.find((receipt: { projectionName: string }) =>
      receipt.projectionName === 'obligations_projection').projectionVersion);

    // Retrying the same request is answered from the committed transaction.
    const retry = await app.inject({ method: 'POST', url: '/v1/memory/frame-instances/merge', headers: { ...request, 'x-correlation-id': randomUUID() },
      payload: { instanceIds: [first.frameInstanceId, second.frameInstanceId], reason: 'It was one loan, mentioned twice' } });
    expect(retry.statusCode, retry.body).toBe(200);
    expect(retry.json()).toEqual(body);
    expect((await admin.query("SELECT count(*)::int n FROM frame_instance_lineage WHERE from_frame_instance_id=$1", [second.frameInstanceId])).rows[0].n).toBe(1);
  } finally { await app.close(); }
});

it('CRT-MEM-10-A: a merge carries every fact of the merged instance to the survivor and exposes a value conflict instead of choosing', async () => {
  const app = api();
  try {
    const kept = await obligation('50.00');
    const absorbed = await obligation('60.00');
    await accept(kept.propositionId); await accept(absorbed.propositionId);
    // A due time only the absorbed instance knows, and a payment allocated to it.
    const due = await stated(absorbed.frameInstanceId, DUE, { time: '2026-10-01T00:00:00.000Z' });
    const allocationFrame = await write(tx => createFrameInstance(tx, { ownerScopeId: owner, frameTypeId: 'finance.payment_allocation', contextSpaceId }));
    const allocated = await stated(allocationFrame, 'finance.payment_allocation.allocated_amount', { amount: '20.00', currency: 'ILS' });
    await write(tx => recordFrameInstanceRole(tx, { ownerScopeId: owner, frameInstanceId: allocationFrame, roleId: 'obligation',
      typedValue: { frameInstanceId: absorbed.frameInstanceId }, claimId: allocated.claimId }));
    await project();

    const response = await app.inject({ method: 'POST', url: '/v1/memory/frame-instances/merge', headers: headers(),
      payload: { instanceIds: [absorbed.frameInstanceId, kept.frameInstanceId], survivorHint: kept.frameInstanceId } });
    expect(response.statusCode, response.body).toBe(200);
    const merge = response.json().merges[0];
    // The due slot did not collide: it is rehomed and keeps its id.
    expect(merge.rehomedSlots.map((slot: { beliefSlotId: string }) => slot.beliefSlotId).sort())
      .toEqual([absorbed.beliefSlotId, due.beliefSlotId].sort());
    // ILS 60 moved into the survivor's principal slot as a new proposition, and
    // the two accepted values are now a visible conflict, both contested.
    const moved = merge.mergedPropositions[0];
    expect(moved).toMatchObject({ fromPropositionId: absorbed.propositionId, createdTarget: true });
    expect(moved.toPropositionId).toMatch(UUID_V7);
    expect(merge.conflicts).toEqual([{ beliefSlotId: kept.beliefSlotId, propositionIds: [kept.propositionId, moved.toPropositionId] }]);
    expect(merge.assessments).toEqual(expect.arrayContaining([
      expect.objectContaining({ propositionId: absorbed.propositionId, assessmentStatus: 'SUPERSEDED', reason: 'MERGED_INTO' }),
      expect.objectContaining({ propositionId: kept.propositionId, assessmentStatus: 'CONTESTED', reason: 'MERGE_COLLISION' }),
      expect.objectContaining({ propositionId: moved.toPropositionId, assessmentStatus: 'CONTESTED', reason: 'MERGE_COLLISION' }),
    ]));

    const row = (await obligationRows()).find(candidate => candidate.obligationFrameInstanceId === kept.frameInstanceId)!;
    expect(row.conflictFlag).toBe(true);
    expect(row.dueTime).toBe('2026-10-01T00:00:00.000Z');
    // Postgres keeps the scale it was given; compare the amount, not its spelling.
    expect(row.totalCanonicalAllocation).toMatch(/^20(\.0+)?$/);
    expect(row.sourceManifest['allocationFrameInstanceIds']).toEqual([allocationFrame]);
    expect(row.sourceManifest['claimIds']).toEqual(expect.arrayContaining([kept.claimId, absorbed.claimId, due.claimId]));
  } finally { await app.close(); }
});

it('CRT-MEM-10-A: a merge may survive into a new canonical instance', async () => {
  const app = api();
  try {
    const left = await obligation('10.00'), right = await obligation('10.00');
    const response = await app.inject({ method: 'POST', url: '/v1/memory/frame-instances/merge', headers: headers(),
      payload: { instanceIds: [left.frameInstanceId, right.frameInstanceId], survivorHint: 'NEW_INSTANCE' } });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.survivorCreated).toBe(true);
    expect(body.survivorFrameInstanceId).toMatch(UUID_V7);
    expect([left.frameInstanceId, right.frameInstanceId]).not.toContain(body.survivorFrameInstanceId);
    expect(body.lineage.map((record: { fromId: string; toId: string }) => [record.fromId, record.toId]))
      .toEqual([[left.frameInstanceId, body.survivorFrameInstanceId], [right.frameInstanceId, body.survivorFrameInstanceId]]);
    expect((await admin.query('SELECT created_by_transaction_id FROM frame_instances WHERE id=$1', [body.survivorFrameInstanceId])).rows[0])
      .toEqual({ created_by_transaction_id: body.transactionId });
    const row = (await obligationRows()).find(candidate => candidate.obligationFrameInstanceId === body.survivorFrameInstanceId)!;
    expect(row).toMatchObject({ principalAmount: '10.00', currency: 'ILS' });
  } finally { await app.close(); }
});

it('CRT-MEM-10-B: splitting one combined obligation contests the claims that cannot be safely assigned, keeps them on the retired parent, and rebuilds projections', async () => {
  const app = api();
  try {
    // PRD §44.14: the owner says one combined obligation was actually two.
    const combined = await obligation('50.00');
    const concert = combined.claimId;
    const dinner = (await stated(combined.frameInstanceId, PRINCIPAL, { amount: '50.00', currency: 'ILS' })).claimId;
    const ambiguous = (await stated(combined.frameInstanceId, PRINCIPAL, { amount: '50.00', currency: 'ILS' })).claimId;
    const due = await stated(combined.frameInstanceId, DUE, { time: '2026-11-01T00:00:00.000Z' });
    await accept(combined.propositionId);
    // The owner said something about the combined obligation before splitting it.
    const pendingDelta = (await as('memory.correct', tx => recordOverlayDelta(tx, { ownerScopeId: owner, deltaKind: 'USER_ASSERTION',
      rawText: 'I still owe Daniel for both', sourceEvidenceId: sourceItemId,
      target: { objectType: 'frame_instance', objectId: combined.frameInstanceId } }))).overlayDeltaId;
    await project();

    const response = await app.inject({ method: 'POST', url: '/v1/memory/frame-instances/' + combined.frameInstanceId + '/split', headers: headers(),
      payload: { targetPartitions: [{ partitionKey: 'concert' }, { partitionKey: 'dinner' }],
        claimAssignments: [{ claimId: concert, partitionKey: 'concert' }, { claimId: dinner, partitionKey: 'dinner' }],
        reason: 'Two loans: the concert and the dinner' } });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    const split = body.split;
    expect(split.parentFrameInstanceId).toBe(combined.frameInstanceId);
    const children = Object.fromEntries(split.newFrameInstances.map((child: { partitionKey: string; frameInstanceId: string }) =>
      [child.partitionKey, child.frameInstanceId]));
    for (const id of Object.values(children)) expect(id).toMatch(UUID_V7);

    // Only the assigned claims were reassigned, each to its own new instance.
    expect(split.reassignedClaims.map((claim: { claimId: string; frameInstanceId: string }) => [claim.claimId, claim.frameInstanceId]).sort())
      .toEqual([[concert, children['concert']], [dinner, children['dinner']]].sort());
    // The claims nobody could place are CONTESTED and still attached to the
    // retired parent's propositions: nothing was arbitrarily assigned.
    expect(split.contestedClaims.map((claim: { claimId: string }) => claim.claimId).sort()).toEqual([ambiguous, due.claimId].sort());
    const claims = (await admin.query('SELECT id,lifecycle,proposition_id FROM claims WHERE id=ANY($1::uuid[]) ORDER BY id',
      [[concert, dinner, ambiguous, due.claimId]])).rows;
    const byId = Object.fromEntries(claims.map((claim: { id: string }) => [claim.id, claim]));
    expect(byId[ambiguous]).toEqual({ id: ambiguous, lifecycle: 'CONTESTED', proposition_id: combined.propositionId });
    expect(byId[due.claimId]).toEqual({ id: due.claimId, lifecycle: 'CONTESTED', proposition_id: due.propositionId });
    // Assigned claims were never re-pointed: the reassignment is a support row.
    expect(byId[concert]).toEqual({ id: concert, lifecycle: 'PROVISIONAL', proposition_id: combined.propositionId });
    const parentOfAmbiguous = (await admin.query(`SELECT f.id,f.lifecycle FROM propositions p JOIN belief_slots s ON s.id=p.belief_slot_id
      JOIN frame_instances f ON f.id=s.frame_instance_id WHERE p.id=$1`, [combined.propositionId])).rows[0];
    expect(parentOfAmbiguous).toEqual({ id: combined.frameInstanceId, lifecycle: 'SPLIT' });

    // One old slot mixed two situations: each partition received a slot of its own.
    expect(split.newSlots).toHaveLength(2);
    expect(split.newSlots.every((slot: { fromBeliefSlotId: string; mixedSituations: boolean }) =>
      slot.fromBeliefSlotId === combined.beliefSlotId && slot.mixedSituations)).toBe(true);
    // The old instance is preserved as lineage history and resolves to both halves.
    expect(body.lineage.map((record: { fromId: string; toId: string; lineageKind: string }) => [record.fromId, record.lineageKind]))
      .toEqual([[combined.frameInstanceId, 'SPLIT_INTO'], [combined.frameInstanceId, 'SPLIT_INTO']]);
    expect(body.propositionLineage.every((record: { fromId: string; lineageKind: string }) =>
      record.fromId === combined.propositionId && record.lineageKind === 'SPLIT_INTO')).toBe(true);
    const parent = body.resolution.find((entry: { id: string }) => entry.id === combined.frameInstanceId);
    expect(parent).toMatchObject({ lifecycle: 'SPLIT', resolvesTo: Object.values(children).sort() });
    expect((await admin.query('SELECT count(*)::int n FROM belief_slots WHERE frame_instance_id=$1', [combined.frameInstanceId])).rows[0].n).toBe(2);
    // Verdicts: each half inherits the accepted value; the parent's is contested.
    expect(split.assessments).toEqual(expect.arrayContaining([
      expect.objectContaining({ propositionId: combined.propositionId, assessmentStatus: 'CONTESTED', reason: 'SPLIT_UNASSIGNED_CLAIMS' }),
    ]));
    expect(split.assessments.filter((entry: { reason: string; assessmentStatus: string }) =>
      entry.reason === 'SPLIT_REHOMED' && entry.assessmentStatus === 'ACCEPTED')).toHaveLength(2);

    // Projections were rebuilt: the parent's row is gone, each half has its own,
    // with its own claim and the parent's parties.
    expect(body.projectionRebuildReceipts).toHaveLength(3);
    for (const receipt of body.projectionRebuildReceipts) expect(receipt).toMatchObject({ trigger: 'SPLIT', transactionId: body.transactionId });
    const rows = await obligationRows();
    expect(rows.map(row => row.obligationFrameInstanceId)).not.toContain(combined.frameInstanceId);
    const concertRow = rows.find(row => row.obligationFrameInstanceId === children['concert'])!;
    const dinnerRow = rows.find(row => row.obligationFrameInstanceId === children['dinner'])!;
    expect(concertRow).toMatchObject({ principalAmount: '50.00', currency: 'ILS', debtorEntityId: ownerEntityId, creditorEntityId: danielEntityId });
    expect(concertRow.sourceManifest['claimIds']).toEqual([concert]);
    expect(dinnerRow.sourceManifest['claimIds']).toEqual([dinner]);
    // The due time went to neither half: its only claim could not be placed.
    expect(concertRow.dueTime).toBeNull();
    // The owner's words about the combined obligation belong to neither half
    // either: the projection read reports them as unattached rather than losing
    // them with the retired row (CRT-RYW-04-A holds across a split).
    const read = await app.inject({ method: 'GET', url: '/v1/projections/obligations', headers: headers({ 'x-purpose': 'projection.read' }) });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json().pendingAssertions).toContainEqual(expect.objectContaining({ overlayDeltaId: pendingDelta,
      reason: 'DELTA_NOT_ATTACHED', targetFrameInstanceId: null }));
    expect(read.json().isComplete).toBe(false);

    // A claim of some other instance cannot be assigned by a split of this one.
    const other = await obligation('5.00'), stranger = await obligation('6.00');
    const refused = await app.inject({ method: 'POST', url: '/v1/memory/frame-instances/' + other.frameInstanceId + '/split', headers: headers(),
      payload: { targetPartitions: [{ partitionKey: 'a' }, { partitionKey: 'b' }], claimAssignments: [{ claimId: stranger.claimId, partitionKey: 'a' }] } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'SPLIT_CLAIM_NOT_IN_TARGET' });
    expect((await admin.query('SELECT lifecycle FROM frame_instances WHERE id=$1', [other.frameInstanceId])).rows[0].lifecycle).toBe('ACTIVE');
  } finally { await app.close(); }
});

it('CRT-MEM-10-C: entity merge and entity split return lineage and rebuild receipts, and a merged entity id stays resolvable', async () => {
  const app = api();
  try {
    // Two people named Daniel stay two entities absent sufficient evidence (PRD §44.12).
    const first = await person('Daniel', 'daniel.one@example.test');
    const second = await person('Daniel', 'daniel.two@example.test');
    expect(first).not.toBe(second);
    const owed = await obligation('30.00', second);
    await project();
    const review = await app.inject({ method: 'GET', url: '/v1/memory/merge-split/review', headers: headers({ 'x-purpose': 'memory.inspect' }) });
    expect(review.statusCode, review.body).toBe(200);
    expect(review.json().entityCandidates).toContainEqual({ entityKind: 'PERSON', sharedAlias: 'daniel',
      entityIds: [first, second].sort(), keptSeparate: true });

    // The owner says they are the same Daniel.
    const merged = await app.inject({ method: 'POST', url: '/v1/memory/entities/merge', headers: headers(),
      payload: { entityIds: [first, second], survivorHint: first, evidenceRef: sourceItemId } });
    expect(merged.statusCode, merged.body).toBe(200);
    const body = merged.json();
    expect(body).toMatchObject({ survivorEntityId: first, mergedEntityIds: [second] });
    expect(body.lineage).toEqual([expect.objectContaining({ objectType: 'entity', fromId: second, toId: first,
      lineageKind: 'MERGED_INTO', transactionId: body.transactionId })]);
    expect(body.projectionRebuildReceipts).toHaveLength(3);
    for (const receipt of body.projectionRebuildReceipts) expect(receipt).toMatchObject({ trigger: 'MERGE', transactionId: body.transactionId });
    expect(body.merges[0].aliases.map((alias: { aliasValue: string }) => alias.aliasValue)).toEqual(['daniel.two@example.test']);
    expect(body.merges[0].affectedFrameInstanceIds).toEqual([owed.frameInstanceId]);
    expect((await admin.query('SELECT source_evidence_ids FROM belief_transactions WHERE id=$1', [body.transactionId])).rows[0].source_evidence_ids)
      .toEqual([sourceItemId]);
    // The merged id still resolves -- to the survivor -- and is never reused.
    expect(body.resolution.find((entry: { id: string }) => entry.id === second)).toMatchObject({ lifecycle: 'MERGED', resolvesTo: [first] });
    expect(await write(tx => resolveEntityReference(tx, { ownerScopeId: owner, entityId: second }))).toBe(first);
    expect(await rowsNamed([second])).toEqual([{ table: 'entities', id: second }]);
    // The merged Daniel's own mailbox now finds the survivor.
    const again = await write(tx => resolveEntity(tx, { ownerScopeId: owner, entityKind: 'PERSON',
      aliases: [{ aliasType: 'EMAIL', aliasValue: 'daniel.two@example.test' }] }));
    expect(again).toMatchObject({ outcome: 'CONFIRMED_MATCH', entityId: first, created: false });
    // The beliefs that named the merged Daniel were recalculated for the survivor.
    const row = (await obligationRows()).find(candidate => candidate.obligationFrameInstanceId === owed.frameInstanceId)!;
    expect(row.creditorEntityId).toBe(first);

    // One "Sam" who was really two people: a work contact and a neighbour.
    const sam = await write(tx => resolveEntity(tx, { ownerScopeId: owner, entityKind: 'PERSON', canonicalLabel: 'Sam', aliases: [
      { aliasType: 'EMAIL', aliasValue: 'sam@work.example.test' }, { aliasType: 'EMAIL', aliasValue: 'sam@home.example.test' },
      { aliasType: 'DISPLAY_NAME', aliasValue: 'Sam' }] }));
    const aliases = (await admin.query('SELECT id,alias_value FROM entity_aliases WHERE entity_id=$1', [sam.entityId])).rows;
    const aliasId = (value: string) => aliases.find((alias: { alias_value: string }) => alias.alias_value === value).id;
    const split = await app.inject({ method: 'POST', url: '/v1/memory/entities/' + sam.entityId + '/split', headers: headers(),
      payload: { partitions: [{ partitionKey: 'work', canonicalLabel: 'Sam (work)' }, { partitionKey: 'home', canonicalLabel: 'Sam (neighbour)' }],
        aliasAssignments: [{ aliasId: aliasId('sam@work.example.test'), partitionKey: 'work' },
          { aliasId: aliasId('sam@home.example.test'), partitionKey: 'home' }] } });
    expect(split.statusCode, split.body).toBe(200);
    const result = split.json();
    expect(result.lineage.map((record: { fromId: string; lineageKind: string }) => [record.fromId, record.lineageKind]))
      .toEqual([[sam.entityId, 'SPLIT_INTO'], [sam.entityId, 'SPLIT_INTO']]);
    expect(result.projectionRebuildReceipts).toHaveLength(3);
    for (const receipt of result.projectionRebuildReceipts) expect(receipt).toMatchObject({ trigger: 'SPLIT', transactionId: result.transactionId });
    // The bare name could be either: it stays on the retired parent.
    expect(result.split.ambiguousAliases).toEqual([expect.objectContaining({ aliasValue: 'Sam', handling: 'RETAINED_ON_RETIRED_PARENT' })]);
    const children = result.split.newEntities.map((child: { entityId: string }) => child.entityId).sort();
    expect(result.resolution.find((entry: { id: string }) => entry.id === sam.entityId)).toMatchObject({ lifecycle: 'SPLIT', resolvesTo: children });
    const work = result.split.newEntities.find((child: { partitionKey: string }) => child.partitionKey === 'work').entityId;
    expect((await admin.query('SELECT canonical_label,lifecycle FROM entities WHERE id=$1', [work])).rows[0]).toEqual({ canonical_label: 'Sam (work)', lifecycle: 'ACTIVE' });
    const found = await write(tx => resolveEntity(tx, { ownerScopeId: owner, entityKind: 'PERSON',
      aliases: [{ aliasType: 'EMAIL', aliasValue: 'sam@work.example.test' }] }));
    expect(found).toMatchObject({ outcome: 'CONFIRMED_MATCH', entityId: work });
  } finally { await app.close(); }
});

it('keeps merge and split governed: refusals are named, audited, and write no lineage', async () => {
  const app = api();
  try {
    const left = await obligation('1.00');
    const commitment = await write(tx => createFrameInstance(tx, { ownerScopeId: owner, frameTypeId: 'shared.commitment', contextSpaceId }));
    const cases: Array<[Record<string, string>, Record<string, unknown>, number, string | null]> = [
      [{ 'x-purpose': 'memory.correct' }, { instanceIds: [left.frameInstanceId, commitment] }, 403, null],
      [{ 'x-data-purpose': '' }, { instanceIds: [left.frameInstanceId, commitment] }, 400, 'MEMORY_CONTEXT_REQUIRED'],
      [{}, { instanceIds: [left.frameInstanceId] }, 400, 'LINEAGE_INPUT_INVALID'],
      [{}, { instanceIds: [left.frameInstanceId, randomUUID()] }, 404, 'FRAME_INSTANCE_NOT_FOUND'],
      [{}, { instanceIds: [left.frameInstanceId, commitment] }, 409, 'FRAME_MERGE_TYPE_MISMATCH'],
    ];
    for (const [extra, payload, status, code] of cases) {
      const request = headers(extra);
      const response = await app.inject({ method: 'POST', url: '/v1/memory/frame-instances/merge', headers: request, payload });
      expect(response.statusCode, JSON.stringify(extra)).toBe(status);
      if (code) expect(response.json()).toMatchObject({ code });
      // A request that got as far as the governed write has its refusal audited;
      // one refused at the boundary never reached it.
      if (code && code !== 'MEMORY_CONTEXT_REQUIRED') {
        expect((await admin.query('SELECT result FROM audit_events WHERE correlation_id=$1', [request['x-correlation-id']])).rows)
          .toContainEqual({ result: 'REFUSED' });
      }
    }
    expect((await admin.query('SELECT count(*)::int n FROM frame_instance_lineage WHERE from_frame_instance_id=$1 OR to_frame_instance_id=$1',
      [left.frameInstanceId])).rows[0].n).toBe(0);
    // An idempotency key names one intent: reusing a merge's key for a split is refused.
    const right = await obligation('1.00');
    const key = randomUUID().replaceAll('-', '');
    expect((await app.inject({ method: 'POST', url: '/v1/memory/frame-instances/merge', headers: headers({ 'idempotency-key': key }),
      payload: { instanceIds: [left.frameInstanceId, right.frameInstanceId] } })).statusCode).toBe(200);
    const reused = await app.inject({ method: 'POST', url: '/v1/memory/frame-instances/' + left.frameInstanceId + '/split',
      headers: headers({ 'idempotency-key': key }), payload: { targetPartitions: [{ partitionKey: 'a' }, { partitionKey: 'b' }], claimAssignments: [] } });
    expect(reused.statusCode).toBe(409);
    expect(reused.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    // Not a database shortcut: outside a committing MERGE or SPLIT the lineage
    // store refuses, whatever purpose asks.
    await expect(as('memory.govern', tx => recordFrameInstanceLineage(tx, { ownerScopeId: owner, fromFrameInstanceId: right.frameInstanceId,
      toFrameInstanceId: commitment, lineageKind: 'MERGED_INTO', transactionId: acceptingTransactionId })))
      .rejects.toThrow('LINEAGE_REQUIRES_GOVERNED_TRANSACTION');
  } finally { await app.close(); }
});

it('serves the Merge and split review: candidate pairs with outcome and score components, kept separate unless confirmed, and recent lineage', async () => {
  const app = api();
  try {
    const existing = await obligation('70.00');
    const another = await obligation('70.00');
    // "Daniel lent me another ILS 70": the matcher found a probable match and,
    // under-merging, kept the second instance separate.
    await write(tx => recordInstanceMatchCandidate(tx, { ownerScopeId: owner, frameTypeId: 'shared.obligation',
      claimId: another.claimId, candidateFrameInstanceId: existing.frameInstanceId, resolvedFrameInstanceId: another.frameInstanceId,
      matchOutcome: 'PROBABLE_MATCH', materiality: 'MATERIAL_ACCEPTED_UPDATE', reusedExistingInstance: false,
      score: 0.72, scoreComponents: { sharedEntities: 1, amountCompatibility: 1, explicitReference: 0 },
      decisionReason: { code: 'UNDER_MERGE_DEFAULT' } }));
    const response = await app.inject({ method: 'GET', url: '/v1/memory/merge-split/review', headers: headers({ 'x-purpose': 'memory.inspect' }) });
    expect(response.statusCode, response.body).toBe(200);
    const review = response.json();
    expect(review.frameCandidates).toContainEqual(expect.objectContaining({ candidateFrameInstanceId: existing.frameInstanceId,
      resolvedFrameInstanceId: another.frameInstanceId, matchOutcome: 'PROBABLE_MATCH', score: 0.72, keptSeparate: true,
      reusedExistingInstance: false, scoreComponents: { sharedEntities: 1, amountCompatibility: 1, explicitReference: 0 } }));
    expect(review.recentLineage.length).toBeGreaterThan(0);
    expect(review.recentLineage.every((record: { lineageKind: string }) => ['MERGED_INTO', 'SPLIT_INTO'].includes(record.lineageKind))).toBe(true);
    // A review is a read: under the governing purpose it is refused.
    expect((await app.inject({ method: 'GET', url: '/v1/memory/merge-split/review', headers: headers() })).statusCode).toBe(403);
  } finally { await app.close(); }
});
