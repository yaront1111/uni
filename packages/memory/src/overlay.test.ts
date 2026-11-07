import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { runMigrations, withOwnerTransaction } from '@unai/postgres';
import type { MemoryOperationKind } from '@unai/domain';
import {
  allocateOwnerSequence, attachOverlayDelta, contestOverlayDelta, isOverlayRemoved, listMemoryOperations, readOwnerOverlay,
  recordMemoryOperation, recordOverlayDelta, type OverlayRelevance,
} from './overlay.js';
import { recordClaim } from './claims.js';
import { MEMORY_PURPOSES } from './transaction.js';

/** Owner read-your-writes over the real policies.
 *
 * Every write here runs through `withOwnerTransaction` under the low-privilege
 * application role, so migration 0014's policies and triggers are part of what
 * these tests prove rather than something they assume.
 */

if (!process.env.UNAI_TEST_DATABASE_URL) throw new Error('Run pnpm test for the required PostgreSQL harness');
const admin = new Pool({ connectionString: process.env.UNAI_TEST_DATABASE_URL });
const appUrl = new URL(process.env.UNAI_TEST_DATABASE_URL); appUrl.username = 'overlay_test_app'; appUrl.password = 'test-only';
const appPool = new Pool({ connectionString: appUrl.href });

let owner = '', actor = '', evidenceId = '', anchorId = '', propositionId = '', frameInstanceId = '', assistantClaimId = '';

/** One owner transaction under a named purpose. A "device" is nothing but a
 * separate transaction for the same owner: the overlay is owner-wide, which is
 * exactly the property CRT-RYW-02-A turns on. */
function device<T>(purpose: string, run: (tx: import('@unai/postgres').OwnerTransaction) => Promise<T>,
  as: { owner: string; actor: string } = { owner, actor }): Promise<T> {
  return withOwnerTransaction(appPool, { actorId: as.actor, ownerScopeId: as.owner, purpose, correlationId: randomUUID() },
    async tx => {
      await tx.query("SELECT set_config('unai.data_purpose','PERSONAL_ASSISTANCE',true),set_config('unai.maximum_sensitivity','RESTRICTED',true)");
      return run(tx);
    });
}

beforeAll(async () => {
  await runMigrations(admin, resolve('migrations'));
  await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='overlay_test_app') THEN CREATE ROLE overlay_test_app LOGIN PASSWORD 'test-only'; END IF; END $$; GRANT unai_app TO overlay_test_app");
  actor = randomUUID(); owner = randomUUID();
  await admin.query('INSERT INTO users(id,display_name) VALUES($1,$2)', [actor, 'Overlay owner']);
  await admin.query("INSERT INTO owner_scopes(id,scope_kind,display_name,created_by_user_id) VALUES($1,'PERSONAL','Overlay',$2)", [owner, actor]);
  await admin.query("INSERT INTO owner_scope_members(owner_scope_id,user_id,role) VALUES($1,$2,'OWNER')", [owner, actor]);

  evidenceId = randomUUID(); anchorId = randomUUID();
  await admin.query(`INSERT INTO source_items(id,owner_scope_id,source_type,external_id,actor_ref,submitted_by_user_id,
    raw_object_ref,content_hash,sensitivity,allowed_purposes,ingestion_version,idempotency_key)
    VALUES($1,$2,'CONVERSATION',$3,$4,$5,$6,$7,'PRIVATE',ARRAY['PERSONAL_ASSISTANCE'],'evidence-json-v1',$8)`,
    [evidenceId, owner, 'overlay:' + evidenceId, JSON.stringify({ type: 'USER', id: actor }), actor, randomUUID(), 'e'.repeat(64), randomUUID()]);
  await admin.query(`INSERT INTO source_anchors(id,owner_scope_id,source_item_id,anchor_kind,anchor)
    VALUES($1,$2,$3,'MESSAGE_SPAN','{"start":0,"end":16}')`, [anchorId, owner, evidenceId]);

  const contextSpaceId = (await admin.query("SELECT id FROM context_spaces WHERE owner_scope_id=$1 AND context_kind='BASE'", [owner])).rows[0].id;
  frameInstanceId = randomUUID(); const slotId = randomUUID(); propositionId = randomUUID(); assistantClaimId = randomUUID();
  await admin.query("INSERT INTO frame_instances(id,owner_scope_id,frame_type_id,context_space_id) VALUES($1,$2,'shared.obligation',$3)",
    [frameInstanceId, owner, contextSpaceId]);
  await admin.query(`INSERT INTO belief_slots(id,owner_scope_id,frame_instance_id,predicate_id,context_space_id,modality)
    VALUES($1,$2,$3,'shared.obligation.principal_amount',$4,'ACTUAL')`, [slotId, owner, frameInstanceId, contextSpaceId]);
  await admin.query(`INSERT INTO propositions(id,owner_scope_id,belief_slot_id,normalized_value)
    VALUES($1,$2,$3,'{"amount":"50.00","currency":"ILS"}')`, [propositionId, owner, slotId]);
  await admin.query(`INSERT INTO claims(id,owner_scope_id,source_anchor_id,proposition_id,claim_origin,lifecycle)
    VALUES($1,$2,$3,$4,'MODEL_EXTRACTION','PROVISIONAL')`, [assistantClaimId, owner, anchorId, propositionId]);
});
afterAll(async () => { await appPool.end(); await admin.end(); });

it('CRT-RYW-01-A: gives two concurrent devices distinct owner sequences that increase in commit order', async () => {
  const before = await device(MEMORY_PURPOSES.correct, tx => allocateOwnerSequence(tx, owner));

  // Two transactions that overlap in time. The first holds the owner_sequences
  // row until it commits, so the second cannot be handed a number before it: the
  // order of the numbers is the order of the commits, not of the starts.
  const order: number[] = [];
  let releaseFirst: () => void = () => {};
  const firstReachedAllocation = new Promise<void>(resolve => { releaseFirst = resolve; });
  let allowFirstToCommit: () => void = () => {};
  const firstMayCommit = new Promise<void>(resolve => { allowFirstToCommit = resolve; });

  const phone = device(MEMORY_PURPOSES.correct, async tx => {
    const sequence = await allocateOwnerSequence(tx, owner);
    releaseFirst();
    await firstMayCommit;
    order.push(sequence);
    return sequence;
  });
  await firstReachedAllocation;
  const desktop = device(MEMORY_PURPOSES.correct, async tx => {
    const sequence = await allocateOwnerSequence(tx, owner);
    order.push(sequence);
    return sequence;
  });
  // The desktop is now blocked on the phone's row lock. Nothing it does can
  // produce a number until the phone's transaction ends.
  await new Promise(resolve => setTimeout(resolve, 150));
  expect(order).toEqual([]);
  allowFirstToCommit();
  const [phoneSequence, desktopSequence] = await Promise.all([phone, desktop]);

  expect(phoneSequence).toBe(before + 1);
  expect(desktopSequence).toBe(before + 2);
  expect(new Set([phoneSequence, desktopSequence]).size).toBe(2);
  expect(order).toEqual([phoneSequence, desktopSequence]);

  // Inserting the pair a second time is rejected, so a caller that chooses a
  // number instead of allocating one cannot make two writes share a position.
  await expect(admin.query(`INSERT INTO owner_overlay_deltas(id,owner_scope_id,owner_sequence,source_evidence_id,raw_text,delta_kind)
    VALUES($1,$2,$3,$4,'duplicate','USER_ASSERTION'),($5,$2,$3,$4,'duplicate','USER_ASSERTION')`,
    [randomUUID(), owner, phoneSequence + 1000, evidenceId, randomUUID()])).rejects.toMatchObject({ code: '23505' });
});

it('CRT-RYW-02-A: the desktop\'s next read sees the phone\'s write and tells the assertion from independent verification', async () => {
  const written = await device(MEMORY_PURPOSES.correct, tx => recordOverlayDelta(tx, {
    ownerScopeId: owner, deltaKind: 'USER_ASSERTION', rawText: 'I paid him back',
    sourceEvidenceId: evidenceId, lifecycle: 'USER_ASSERTED',
    target: { objectType: 'proposition', objectId: propositionId },
    sourceDeviceId: randomUUID(),
  }));

  // A different transaction for the same owner: the desktop, asking next.
  const desktop = await device(MEMORY_PURPOSES.correct, tx => readOwnerOverlay(tx, { ownerScopeId: owner }));
  const delta = desktop.deltas.find(candidate => candidate.overlayDeltaId === written.overlayDeltaId);
  expect(delta, 'the phone write is in the desktop read').toBeDefined();
  expect(delta!.rawText).toBe('I paid him back');
  expect(desktop.ownerOverlayWatermark).toBeGreaterThanOrEqual(written.ownerSequence);

  // The two things the answer has to keep apart. The owner asserted it; nothing
  // outside the owner's own words verifies it yet, and the model's reading of
  // that same evidence is not verification of it.
  expect(delta!.assertionKind).toBe('USER_ASSERTION');
  expect(delta!.independentVerification).toEqual({ verified: false, independentEvidenceIds: [], independentClaimOrigins: [] });

  // A document asserting the same proposition is independent, and the very next
  // read says so without changing what the owner asserted.
  const documentEvidence = randomUUID(), documentAnchor = randomUUID();
  await admin.query(`INSERT INTO source_items(id,owner_scope_id,source_type,external_id,actor_ref,submitted_by_user_id,
    raw_object_ref,content_hash,sensitivity,allowed_purposes,ingestion_version,idempotency_key)
    VALUES($1,$2,'DOCUMENT',$3,$4,$5,$6,$7,'PRIVATE',ARRAY['PERSONAL_ASSISTANCE'],'evidence-json-v1',$8)`,
    [documentEvidence, owner, 'receipt:' + documentEvidence, JSON.stringify({ type: 'EXTERNAL', id: 'bank' }), actor,
      randomUUID(), 'f'.repeat(64), randomUUID()]);
  await admin.query(`INSERT INTO source_anchors(id,owner_scope_id,source_item_id,anchor_kind,anchor)
    VALUES($1,$2,$3,'DOCUMENT_RANGE','{"page":1}')`, [documentAnchor, owner, documentEvidence]);
  await device(MEMORY_PURPOSES.canonicalize, tx => recordClaim(tx, {
    ownerScopeId: owner, sourceAnchorId: documentAnchor, propositionId, claimOrigin: 'DOCUMENT_ASSERTION', lifecycle: 'PROVISIONAL',
  }));

  const verified = await device(MEMORY_PURPOSES.correct, tx => readOwnerOverlay(tx, { ownerScopeId: owner }));
  const again = verified.deltas.find(candidate => candidate.overlayDeltaId === written.overlayDeltaId)!;
  expect(again.assertionKind).toBe('USER_ASSERTION');
  expect(again.independentVerification.verified).toBe(true);
  expect(again.independentVerification.independentEvidenceIds).toEqual([documentEvidence]);
  expect(again.independentVerification.independentClaimOrigins).toEqual(['DOCUMENT_ASSERTION']);

  // Reading from the watermark returns only what came after it, which is how a
  // device catches up rather than re-reading the whole overlay.
  const caughtUp = await device(MEMORY_PURPOSES.correct, tx =>
    readOwnerOverlay(tx, { ownerScopeId: owner, sinceSequence: verified.ownerOverlayWatermark }));
  expect(caughtUp.deltas).toEqual([]);
});

it('CRT-RYW-02-B: a suppression and a deletion from one device are honoured by the next read from another', async () => {
  const suppressed = { objectType: 'proposition', objectId: propositionId } as const;
  const deleted = { objectType: 'frame_instance', objectId: frameInstanceId } as const;
  await device(MEMORY_PURPOSES.correct, async tx => {
    await recordOverlayDelta(tx, { ownerScopeId: owner, deltaKind: 'SUPPRESSION', rawText: 'Stop showing this',
      sourceEvidenceId: evidenceId, lifecycle: 'USER_ASSERTED', target: suppressed, sourceDeviceId: randomUUID() });
    await recordOverlayDelta(tx, { ownerScopeId: owner, deltaKind: 'DELETION', rawText: 'Delete this situation',
      sourceEvidenceId: evidenceId, lifecycle: 'USER_ASSERTED', target: deleted, sourceDeviceId: randomUUID() });
  });

  const otherDevice = await device(MEMORY_PURPOSES.correct, tx => readOwnerOverlay(tx, { ownerScopeId: owner }));
  expect(otherDevice.suppressedTargets).toContainEqual(suppressed);
  expect(otherDevice.deletedTargets).toContainEqual(deleted);
  expect(isOverlayRemoved(otherDevice, suppressed)).toBe(true);
  expect(isOverlayRemoved(otherDevice, deleted)).toBe(true);
  // An object nobody suppressed stays visible: the filter honours the owner's
  // requests and invents none.
  expect(isOverlayRemoved(otherDevice, { objectType: 'claim', objectId: assistantClaimId })).toBe(false);
});

it('CRT-MEM-15-A: re-extraction contrary to a user-confirmed correction marks it CONTESTED at most', async () => {
  const correction = await device(MEMORY_PURPOSES.correct, tx => recordOverlayDelta(tx, {
    ownerScopeId: owner, deltaKind: 'USER_CORRECTION', rawText: 'Actually it was ILS 60',
    sourceEvidenceId: evidenceId, lifecycle: 'USER_ASSERTED',
    target: { objectType: 'proposition', objectId: propositionId },
  }));

  // The re-extraction path: it runs under the canonicalization purpose and the
  // only verdict it can reach is CONTESTED.
  const contested = await device(MEMORY_PURPOSES.canonicalize, tx => contestOverlayDelta(tx, {
    ownerScopeId: owner, overlayDeltaId: correction.overlayDeltaId,
    reason: { failureReason: 'RE_EXTRACTION_CONTRADICTS_USER_CORRECTION', conflictingEvidenceIds: [evidenceId],
      affectedProjections: ['obligations_projection'], containingManifestIds: [] },
  }));
  expect(contested.lifecycle).toBe('CONTESTED');

  const row = (await admin.query('SELECT lifecycle,raw_text,contested_reason FROM owner_overlay_deltas WHERE id=$1',
    [correction.overlayDeltaId])).rows[0];
  // The row still exists and still says what the owner said.
  expect(row.lifecycle).toBe('CONTESTED');
  expect(row.raw_text).toBe('Actually it was ILS 60');
  expect(row.contested_reason).toMatchObject({ failureReason: 'RE_EXTRACTION_CONTRADICTS_USER_CORRECTION',
    conflictingEvidenceIds: [evidenceId], affectedProjections: ['obligations_projection'] });

  // Neither REJECTED nor SUPERSEDED is reachable without a user action, for the
  // extraction purpose or for the privileged principal.
  for (const lifecycle of ['REJECTED_AS_INTERPRETATION', 'SUPERSEDED', 'WITHDRAWN']) {
    await expect(device(MEMORY_PURPOSES.canonicalize, tx =>
      tx.query('UPDATE owner_overlay_deltas SET lifecycle=$2 WHERE id=$1', [correction.overlayDeltaId, lifecycle])),
    lifecycle).rejects.toThrow('OVERLAY_DELTA_NEEDS_USER_ACTION');
    await expect(admin.query('UPDATE owner_overlay_deltas SET lifecycle=$2 WHERE id=$1', [correction.overlayDeltaId, lifecycle]),
      lifecycle).rejects.toThrow('OVERLAY_DELTA_NEEDS_USER_ACTION');
  }
  // Contesting twice is not an escalation either.
  const secondPass = await device(MEMORY_PURPOSES.canonicalize, tx => contestOverlayDelta(tx, {
    ownerScopeId: owner, overlayDeltaId: correction.overlayDeltaId, reason: { failureReason: 'RE_EXTRACTION_CONTRADICTS_USER_CORRECTION' },
  }));
  expect(secondPass.lifecycle).toBe('CONTESTED');

  // The owner's own correction purpose does settle it, which is the only way.
  await device(MEMORY_PURPOSES.correct, tx =>
    tx.query(`UPDATE owner_overlay_deltas SET lifecycle='WITHDRAWN' WHERE id=$1`, [correction.overlayDeltaId]));
  expect((await admin.query('SELECT lifecycle FROM owner_overlay_deltas WHERE id=$1', [correction.overlayDeltaId])).rows[0].lifecycle)
    .toBe('WITHDRAWN');
});

it('persists all ten correction control kinds as distinct memory operations', async () => {
  const kinds: MemoryOperationKind[] = ['CORRECT','CHANGED','CONFIRM','REJECT','KEEP_UNCERTAIN','SUPPRESS','ARCHIVE','DELETE','MERGE','SPLIT'];
  const target = { objectType: 'proposition', objectId: propositionId } as const;
  await device(MEMORY_PURPOSES.correct, async tx => {
    for (const operationKind of kinds) {
      await recordMemoryOperation(tx, { ownerScopeId: owner, operationKind, target, evidenceId, requestedByActorId: actor });
    }
    const recorded = await listMemoryOperations(tx, { ownerScopeId: owner, target });
    expect(recorded.map(operation => operation.operationKind).sort()).toEqual([...kinds].sort());
    expect(new Set(recorded.map(operation => operation.memoryOperationId)).size).toBe(kinds.length);
  });
  // There is no generic edit kind to fall back to.
  await expect(admin.query(`INSERT INTO memory_operations(id,owner_scope_id,operation_kind,target_object_type,
    target_object_id,evidence_id,requested_by_actor_id) VALUES($1,$2,'EDIT','proposition',$3,$4,$5)`,
    [randomUUID(), owner, propositionId, evidenceId, actor])).rejects.toMatchObject({ code: '23514' });
});

// PRD §21.2: every later read sees every acknowledged owner write. These cases
// each use a fresh owner, so their bulk fixtures change nothing the cases above
// read.
interface Scope { owner: string; actor: string; evidenceId: string; frameA: string; frameB: string }
const HOUR = 3_600_000;

async function freshOwner(): Promise<Scope> {
  const scope = { owner: randomUUID(), actor: randomUUID(), evidenceId: randomUUID(), frameA: randomUUID(), frameB: randomUUID() };
  await admin.query('INSERT INTO users(id,display_name) VALUES($1,$2)', [scope.actor, 'Overlay paging owner']);
  await admin.query("INSERT INTO owner_scopes(id,scope_kind,display_name,created_by_user_id) VALUES($1,'PERSONAL','Overlay paging',$2)",
    [scope.owner, scope.actor]);
  await admin.query("INSERT INTO owner_scope_members(owner_scope_id,user_id,role) VALUES($1,$2,'OWNER')", [scope.owner, scope.actor]);
  await admin.query(`INSERT INTO source_items(id,owner_scope_id,source_type,external_id,actor_ref,submitted_by_user_id,
    raw_object_ref,content_hash,sensitivity,allowed_purposes,ingestion_version,idempotency_key)
    VALUES($1,$2,'CONVERSATION',$3,$4,$5,$6,$7,'PRIVATE',ARRAY['PERSONAL_ASSISTANCE'],'evidence-json-v1',$8)`,
    [scope.evidenceId, scope.owner, 'overlay-paging:' + scope.evidenceId, JSON.stringify({ type: 'USER', id: scope.actor }), scope.actor,
      randomUUID(), 'd'.repeat(64), randomUUID()]);
  const contextSpaceId = (await admin.query("SELECT id FROM context_spaces WHERE owner_scope_id=$1 AND context_kind='BASE'",
    [scope.owner])).rows[0].id;
  for (const frame of [scope.frameA, scope.frameB]) {
    await admin.query("INSERT INTO frame_instances(id,owner_scope_id,frame_type_id,context_space_id) VALUES($1,$2,'shared.obligation',$3)",
      [frame, scope.owner, contextSpaceId]);
  }
  return scope;
}

/** Deltas `from`..`to` in one statement, each with its owner sequence as given. */
async function insertDeltas(scope: Scope, from: number, to: number, shape: {
  targetId?: string; attachedFrame?: string; createdAt?: Date } = {}): Promise<string[]> {
  return (await admin.query(`INSERT INTO owner_overlay_deltas(id,owner_scope_id,owner_sequence,source_evidence_id,raw_text,
      delta_kind,lifecycle,target_object_type,target_object_id,attached_frame_instance_id,created_at)
    SELECT gen_random_uuid(),$1,n,$2,'delta '||n,'USER_ASSERTION','USER_ASSERTED',
      CASE WHEN $5::uuid IS NULL THEN NULL ELSE 'proposition' END,$5,$6,$7
    FROM generate_series($3::int,$4::int) AS n ORDER BY n RETURNING id`,
    [scope.owner, scope.evidenceId, from, to, shape.targetId ?? null, shape.attachedFrame ?? null,
      shape.createdAt ?? new Date(Date.now() - HOUR)])).rows.map(row => row.id as string);
}

const sequences = (overlay: { deltas: Array<{ ownerSequence: number }> }) => overlay.deltas.map(delta => delta.ownerSequence);
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => from + index);

it('PRD §21.2: a full page says it is incomplete, and the watermark continues to the newest delta', async () => {
  const scope = await freshOwner();
  await insertDeltas(scope, 1, 501);
  const read = (input: { sinceSequence?: number; limit?: number }) =>
    device(MEMORY_PURPOSES.correct, tx => readOwnerOverlay(tx, { ownerScopeId: scope.owner, ...input }), scope);

  const first = await read({ limit: 500 });
  expect(sequences(first)).toEqual(range(1, 500));
  expect(first.isComplete).toBe(false);
  expect(first.ownerOverlayWatermark).toBe(500);
  const rest = await read({ sinceSequence: first.ownerOverlayWatermark, limit: 500 });
  expect(sequences(rest)).toEqual([501]);
  expect(rest.isComplete).toBe(true);
  expect(rest.ownerOverlayWatermark).toBe(501);

  // A page exactly as large as what is left is complete; the default is still 500.
  const exact = await read({ limit: 501 });
  expect([exact.deltas.length, exact.isComplete]).toEqual([501, true]);
  const byDefault = await read({});
  expect([byDefault.deltas.length, byDefault.isComplete]).toEqual([500, false]);
});

it('PRD §21.2: a relevant read selects by delta id, by target and by attached frame, and nothing else', async () => {
  const scope = await freshOwner();
  const target = randomUUID();
  const [loose] = await insertDeltas(scope, 1, 1);
  const [targeted] = await insertDeltas(scope, 2, 2, { targetId: target });
  const [onA] = await insertDeltas(scope, 3, 3, { attachedFrame: scope.frameA });
  await insertDeltas(scope, 4, 4, { attachedFrame: scope.frameB });
  await insertDeltas(scope, 5, 5, { targetId: randomUUID() });
  const read = (relevantTo?: OverlayRelevance) => device(MEMORY_PURPOSES.correct, tx =>
    readOwnerOverlay(tx, { ownerScopeId: scope.owner, limit: 10, ...(relevantTo ? { relevantTo } : {}) }), scope);
  const ids = (overlay: { deltas: Array<{ overlayDeltaId: string }> }) => overlay.deltas.map(delta => delta.overlayDeltaId);

  expect(ids(await read({ overlayDeltaIds: [loose!] }))).toEqual([loose]);
  expect(ids(await read({ targetObjectIds: [target] }))).toEqual([targeted]);
  expect(ids(await read({ attachedFrameInstanceIds: [scope.frameA] }))).toEqual([onA]);
  expect(ids(await read({ overlayDeltaIds: [loose!], targetObjectIds: [target], attachedFrameInstanceIds: [scope.frameA] })))
    .toEqual([loose, targeted, onA]);
  // Empty lists match nothing, and neither does an id this owner does not hold.
  const none = await read({});
  expect([none.deltas, none.isComplete, none.ownerOverlayWatermark]).toEqual([[], true, 0]);
  const [foreign] = await insertDeltas(await freshOwner(), 1, 1, { targetId: target });
  expect(ids(await read({ overlayDeltaIds: [foreign!, randomUUID()] }))).toEqual([]);
  expect(ids(await read({ targetObjectIds: [target] }))).toEqual([targeted]);
  // A page read with no relevance still sees all five.
  expect(sequences(await read())).toEqual([1, 2, 3, 4, 5]);
});

it('PRD §21.2: a truncated relevant read keeps the newest relevant deltas and says it left older ones out', async () => {
  const scope = await freshOwner();
  await insertDeltas(scope, 1, 3, { attachedFrame: scope.frameA });
  await insertDeltas(scope, 4, 6); // newer, but not relevant
  const read = (limit: number) => device(MEMORY_PURPOSES.correct, tx => readOwnerOverlay(tx, {
    ownerScopeId: scope.owner, limit, relevantTo: { attachedFrameInstanceIds: [scope.frameA] } }), scope);

  const truncated = await read(2);
  expect(sequences(truncated)).toEqual([2, 3]);
  expect(truncated.isComplete).toBe(false);
  expect(truncated.ownerOverlayWatermark).toBe(3);
  const whole = await read(3);
  expect(sequences(whole)).toEqual([1, 2, 3]);
  expect(whole.isComplete).toBe(true);
});

it('PRD §21.2: a historical relevant read follows each delta\'s attachment as of the knowledge time', async () => {
  const scope = await freshOwner();
  const before = new Date(Date.now() - HOUR);
  const knowledgeTime = new Date(before.getTime() + 60_000);
  const [moved] = await insertDeltas(scope, 1, 1, { attachedFrame: scope.frameA, createdAt: before });
  const [late] = await insertDeltas(scope, 2, 2, { createdAt: before });
  // attachOverlayDelta coalesces, so a later call re-attaches a delta. The
  // journal records both moves at database wall time, after `knowledgeTime`.
  await device(MEMORY_PURPOSES.canonicalize, async tx => {
    await attachOverlayDelta(tx, { ownerScopeId: scope.owner, overlayDeltaId: moved!, attachedFrameInstanceId: scope.frameB });
    await attachOverlayDelta(tx, { ownerScopeId: scope.owner, overlayDeltaId: late!, attachedFrameInstanceId: scope.frameA });
  }, scope);
  // Written after the knowledge time: never part of that read.
  await insertDeltas(scope, 3, 3, { attachedFrame: scope.frameA, createdAt: new Date() });
  const read = (frame: string, at?: Date) => device(MEMORY_PURPOSES.correct, tx => readOwnerOverlay(tx, {
    ownerScopeId: scope.owner, limit: 10, relevantTo: { attachedFrameInstanceIds: [frame] }, ...(at ? { knowledgeTime: at } : {}) }), scope);

  const thenOnA = await read(scope.frameA, knowledgeTime);
  expect(thenOnA.deltas.map(delta => [delta.overlayDeltaId, delta.attachedFrameInstanceId])).toEqual([[moved, scope.frameA]]);
  expect(sequences(await read(scope.frameB, knowledgeTime))).toEqual([]);
  expect(sequences(await read(scope.frameA))).toEqual([2, 3]);
  expect(sequences(await read(scope.frameB))).toEqual([1]);
});
