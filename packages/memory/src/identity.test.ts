import { Pool } from 'pg';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { runMigrations, withOwnerTransaction, type OwnerTransaction } from '@unai/postgres';
import type { RequestContext, SlotDescriptor } from '@unai/domain';
import { MEMORY_PURPOSES, CANONICAL_NORMALIZATION_VERSION, createFrameInstance, recordFrameInstanceRole,
  resolveEntity, resolveEntityReference, recordEntityMerge, readEntity, findEntityCandidates,
  resolveBeliefSlot, createBeliefSlot, lookupBeliefSlot, readBeliefSlot, slotFingerprint,
  resolveProposition, readProposition, recomputeCanonicalFingerprints,
  recordClaim, readClaim, listClaimsForProposition, resolveTemporalExpression } from './index.js';

/** Canonical identity storage over real PostgreSQL, through the real owner
 * boundary: every store below runs inside `withOwnerTransaction` under the
 * low-privilege application role, so the row-level security policies of
 * migration 0010 are part of what these tests exercise. */

if (!process.env.UNAI_TEST_DATABASE_URL) throw new Error('Run pnpm test for the required PostgreSQL harness');
const admin = new Pool({ connectionString: process.env.UNAI_TEST_DATABASE_URL });
const appUrl = new URL(process.env.UNAI_TEST_DATABASE_URL); appUrl.username = 'memory_test_app'; appUrl.password = 'test-only';
const appPool = new Pool({ connectionString: appUrl.href });

const owner = randomUUID(), actor = randomUUID();
let contextSpaceId = '', connectorId = '', sourceItemId = '', anchorId = '', secondAnchorId = '';
const uuidV7Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

beforeAll(async () => {
  await runMigrations(admin, resolve('migrations'));
  await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='memory_test_app') THEN CREATE ROLE memory_test_app LOGIN PASSWORD 'test-only'; END IF; END $$; GRANT unai_app TO memory_test_app");
  await admin.query('INSERT INTO users(id,display_name) VALUES($1,$2)', [actor, 'Memory owner']);
  await admin.query("INSERT INTO owner_scopes(id,scope_kind,display_name,created_by_user_id) VALUES($1,'PERSONAL','Memory',$2)", [owner, actor]);
  await admin.query("INSERT INTO owner_scope_members(owner_scope_id,user_id,role) VALUES($1,$2,'OWNER')", [owner, actor]);
  contextSpaceId = (await admin.query('SELECT id FROM context_spaces WHERE owner_scope_id=$1', [owner])).rows[0].id;
  // Evidence the claims below anchor to. Claims point at source anchors; this
  // package never creates evidence of its own.
  connectorId = randomUUID(); sourceItemId = randomUUID();
  await admin.query("INSERT INTO connectors(id,owner_scope_id,connector_type,external_account_ref,permission_manifest,status) VALUES($1,$2,'CONVERSATION',$3,'{}','ACTIVE')", [connectorId, owner, owner]);
  await admin.query(`INSERT INTO source_items(id,owner_scope_id,connector_id,source_type,external_id,actor_ref,submitted_by_user_id,
    raw_object_ref,content_hash,sensitivity,allowed_purposes,ingestion_version,idempotency_key)
    VALUES($1,$2,$3,'CONVERSATION','message-1',$4,$5,$6,$7,'PRIVATE',ARRAY['PERSONAL_ASSISTANCE'],'evidence-json-v1',$8)`,
    [sourceItemId, owner, connectorId, JSON.stringify({ type: 'USER', id: actor }), actor, randomUUID(), 'a'.repeat(64), randomUUID()]);
  anchorId = randomUUID(); secondAnchorId = randomUUID();
  await admin.query(`INSERT INTO source_anchors(id,owner_scope_id,source_item_id,anchor_kind,anchor) VALUES
    ($1,$3,$4,'MESSAGE_SPAN','{"start":0,"end":24}'),($2,$3,$4,'MESSAGE_SPAN','{"start":25,"end":48}')`,
    [anchorId, secondAnchorId, owner, sourceItemId]);
});
afterAll(async () => { await appPool.end(); await admin.end(); });

function context(purpose: string): RequestContext { return { actorId: actor, ownerScopeId: owner, purpose, correlationId: randomUUID() }; }
function as<T>(purpose: string, run: (tx: OwnerTransaction) => Promise<T>) { return withOwnerTransaction(appPool, context(purpose), run); }
const write = <T,>(run: (tx: OwnerTransaction) => Promise<T>) => as(MEMORY_PURPOSES.canonicalize, run);
const read = <T,>(run: (tx: OwnerTransaction) => Promise<T>) => as(MEMORY_PURPOSES.inspect, run);

async function obligationInstance(): Promise<string> {
  return write(tx => createFrameInstance(tx, { ownerScopeId: owner, frameTypeId: 'shared.obligation', contextSpaceId }));
}
function principalAmountDescriptor(frameInstanceId: string): SlotDescriptor {
  return { frameInstanceId, predicateId: 'shared.obligation.principal_amount', contextSpaceId, modality: 'ACTUAL', qualifiers: {} };
}

it('CRT-MEM-11-B: evidence from two different people named Daniel yields two separate entities', async () => {
  const first = await write(tx => resolveEntity(tx, { ownerScopeId: owner, entityKind: 'PERSON', canonicalLabel: 'Daniel',
    aliases: [{ aliasType: 'DISPLAY_NAME', aliasValue: 'Daniel', sourceItemId, confidence: 0.9 }] }));
  expect(first).toMatchObject({ outcome: 'NEW_ENTITY', created: true, identityEstablished: false, candidates: [] });

  // A second Daniel, from other evidence, with nothing but the name in common.
  const second = await write(tx => resolveEntity(tx, { ownerScopeId: owner, entityKind: 'PERSON', canonicalLabel: 'Daniel',
    aliases: [{ aliasType: 'DISPLAY_NAME', aliasValue: 'daniel', sourceItemId, confidence: 0.9 }] }));
  expect(second.entityId).not.toBe(first.entityId);
  expect(second.created).toBe(true);
  // The shared name made the first Daniel a candidate and nothing more: the
  // resolver reports what it declined to merge with, which is the Merge and split
  // review screen's "two same-name people kept separate" state.
  expect(second.outcome).toBe('POSSIBLE_MATCH');
  expect(second.identityEstablished).toBe(false);
  expect(second.candidates.map(candidate => candidate.entityId)).toEqual([first.entityId]);
  expect(second.candidates[0]!.matchedStrongly).toBe(false);
  for (const id of [first.entityId, second.entityId]) {
    expect(id).toMatch(uuidV7Pattern);
    expect(await read(tx => readEntity(tx, { ownerScopeId: owner, entityId: id }))).toMatchObject({ lifecycle: 'ACTIVE', retiredAt: null });
  }

  // Sufficient evidence -- an exact mailbox -- does establish identity. The first
  // Daniel acquires one, and a later mention carrying the same mailbox resolves
  // to him instead of creating a third entity.
  await write(tx => resolveEntity(tx, { ownerScopeId: owner, entityKind: 'PERSON',
    aliases: [{ aliasType: 'EMAIL', aliasValue: 'daniel.levi@example.test' }] }));
  const withMailbox = await write(tx => resolveEntity(tx, { ownerScopeId: owner, entityKind: 'PERSON', canonicalLabel: 'Daniel',
    aliases: [{ aliasType: 'DISPLAY_NAME', aliasValue: 'Daniel' }, { aliasType: 'EMAIL', aliasValue: 'Daniel.Levi@Example.test' }] }));
  expect(withMailbox).toMatchObject({ outcome: 'CONFIRMED_MATCH', created: false, identityEstablished: true });
  expect([first.entityId, second.entityId]).not.toContain(withMailbox.entityId);

  // A user merge is the other way identity is established. Afterwards the merged
  // id still resolves -- to the survivor -- and is never repurposed.
  await write(tx => recordEntityMerge(tx, { ownerScopeId: owner, survivorEntityId: first.entityId,
    mergedEntityId: second.entityId, reason: { statedBy: 'USER' } }));
  expect(await read(tx => resolveEntityReference(tx, { ownerScopeId: owner, entityId: second.entityId }))).toBe(first.entityId);
  expect(await read(tx => resolveEntityReference(tx, { ownerScopeId: owner, entityId: first.entityId }))).toBe(first.entityId);
  expect(await read(tx => readEntity(tx, { ownerScopeId: owner, entityId: second.entityId }))).toMatchObject({ lifecycle: 'MERGED' });
  // The merged entity leaves the candidate pool rather than being deleted.
  const candidates = await read(tx => findEntityCandidates(tx, { ownerScopeId: owner, entityKind: 'PERSON',
    aliases: [{ aliasType: 'DISPLAY_NAME', aliasValue: 'Daniel' }] }));
  expect(candidates.map(candidate => candidate.entityId)).toContain(first.entityId);
  expect(candidates.map(candidate => candidate.entityId)).not.toContain(second.entityId);
});

it('CRT-MEM-05-A: two ILS 50 claims are distinct claims on one proposition, and ILS 60 shares the slot with a different proposition', async () => {
  const frameInstanceId = await obligationInstance();
  const descriptor = principalAmountDescriptor(frameInstanceId);
  const slot = await write(tx => resolveBeliefSlot(tx, { ownerScopeId: owner, descriptor }));
  expect(slot).toMatchObject({ outcome: 'CREATE_NEW_SLOT', created: true });

  const fifty = await write(tx => resolveProposition(tx, { ownerScopeId: owner, beliefSlotId: slot.beliefSlotId,
    normalizedValue: { amount: '50.00', currency: 'ILS' } }));
  expect(fifty).toMatchObject({ outcome: 'CREATE_NEW_PROPOSITION', created: true });

  // A second source asserting the same amount is a second claim, never a second
  // proposition and never an overwrite of the first claim.
  const second = await write(tx => resolveProposition(tx, { ownerScopeId: owner, beliefSlotId: slot.beliefSlotId,
    normalizedValue: { amount: '50.00', currency: 'ILS' } }));
  expect(second).toMatchObject({ outcome: 'MATCH_EXISTING_PROPOSITION', created: false, identityEstablished: true });
  expect(second.propositionId).toBe(fifty.propositionId);

  const claimA = await write(tx => recordClaim(tx, { ownerScopeId: owner, sourceAnchorId: anchorId,
    propositionId: fifty.propositionId, claimOrigin: 'USER_STATEMENT', lifecycle: 'PROVISIONAL', extractionConfidence: 0.98 }));
  const claimB = await write(tx => recordClaim(tx, { ownerScopeId: owner, sourceAnchorId: secondAnchorId,
    propositionId: second.propositionId, claimOrigin: 'EXTERNAL_PERSON_ASSERTION', lifecycle: 'PROVISIONAL', extractionConfidence: 0.81 }));
  expect(claimA).not.toBe(claimB);
  expect(claimA).toMatch(uuidV7Pattern);
  expect(claimB).toMatch(uuidV7Pattern);
  const supporting = await read(tx => listClaimsForProposition(tx, { ownerScopeId: owner, propositionId: fifty.propositionId }));
  expect(supporting.map(claim => claim.claimId).sort()).toEqual([claimA, claimB].sort());
  expect(new Set(supporting.map(claim => claim.propositionId))).toEqual(new Set([fifty.propositionId]));

  // "Actually it is ILS 60" is the same location with a different candidate value:
  // one slot, a second proposition, and the ILS 50 proposition still there.
  const sixtySlot = await write(tx => resolveBeliefSlot(tx, { ownerScopeId: owner, descriptor }));
  expect(sixtySlot).toMatchObject({ outcome: 'MATCH_EXISTING_SLOT', created: false, identityEstablished: true });
  expect(sixtySlot.beliefSlotId).toBe(slot.beliefSlotId);
  const sixty = await write(tx => resolveProposition(tx, { ownerScopeId: owner, beliefSlotId: sixtySlot.beliefSlotId,
    normalizedValue: { amount: '60.00', currency: 'ILS' } }));
  expect(sixty).toMatchObject({ outcome: 'CREATE_NEW_PROPOSITION', created: true });
  expect(sixty.propositionId).not.toBe(fifty.propositionId);
  const stored = await read(async tx => [
    await readProposition(tx, { ownerScopeId: owner, propositionId: fifty.propositionId }),
    await readProposition(tx, { ownerScopeId: owner, propositionId: sixty.propositionId }),
  ]);
  expect(stored.map(proposition => proposition!.beliefSlotId)).toEqual([slot.beliefSlotId, slot.beliefSlotId]);
  expect(stored.map(proposition => proposition!.normalizedValue))
    .toEqual([{ amount: '50.00', currency: 'ILS' }, { amount: '60.00', currency: 'ILS' }]);
  expect(stored.every(proposition => proposition!.lifecycle === 'ACTIVE')).toBe(true);

  // The slot itself never carries a value: that is what makes the two amounts
  // collide in one location instead of overwriting each other (PRD §11.8).
  const columns = (await admin.query(`SELECT attname FROM pg_attribute WHERE attrelid='belief_slots'::regclass AND attnum>0 AND NOT attisdropped`)).rows
    .map(row => row.attname as string);
  expect(columns).not.toContain('normalized_value');
  expect(columns.some(column => /value/.test(column))).toBe(false);
});

it('CRT-MEM-14-A: a stored claim exposes extraction, entity-resolution, temporal-resolution and instance-resolution confidence separately', async () => {
  const frameInstanceId = await obligationInstance();
  const slot = await write(tx => resolveBeliefSlot(tx, { ownerScopeId: owner, descriptor: principalAmountDescriptor(frameInstanceId) }));
  const proposition = await write(tx => resolveProposition(tx, { ownerScopeId: owner, beliefSlotId: slot.beliefSlotId,
    normalizedValue: { amount: '120.00', currency: 'ILS' } }));
  // A bank feed: exact about the amount, weak about which human it names.
  const claimId = await write(tx => recordClaim(tx, { ownerScopeId: owner, sourceAnchorId: anchorId,
    propositionId: proposition.propositionId, claimOrigin: 'STRUCTURED_CONNECTOR_OBSERVATION', lifecycle: 'PROVISIONAL',
    extractionConfidence: 0.99, entityResolutionConfidence: 0.42, temporalResolutionConfidence: 0.6,
    instanceResolutionConfidence: 0.35, metadata: { connector: 'bank' } }));
  const stored = await read(tx => readClaim(tx, { ownerScopeId: owner, claimId }));
  expect(stored).toMatchObject({
    extractionConfidence: 0.99, entityResolutionConfidence: 0.42,
    temporalResolutionConfidence: 0.6, instanceResolutionConfidence: 0.35,
  });
  // Four distinct values, so nothing here is one opaque number reused (PRD §15.3).
  expect(new Set([stored!.extractionConfidence, stored!.entityResolutionConfidence,
    stored!.temporalResolutionConfidence, stored!.instanceResolutionConfidence]).size).toBe(4);
  const columns = (await admin.query(`SELECT attname FROM pg_attribute WHERE attrelid='claims'::regclass AND attnum>0 AND NOT attisdropped`)).rows
    .map(row => row.attname as string);
  for (const column of ['extraction_confidence', 'entity_resolution_confidence', 'temporal_resolution_confidence', 'instance_resolution_confidence']) {
    expect(columns).toContain(column);
  }

  // A claim may wait without a proposition while its instance is unresolved, and
  // it still carries its own confidences (PRD §15.2).
  const awaiting = await write(tx => recordClaim(tx, { ownerScopeId: owner, sourceAnchorId: secondAnchorId,
    claimOrigin: 'MODEL_EXTRACTION', lifecycle: 'AWAITING_INSTANCE_RESOLUTION', candidateFrameTypeId: 'shared.obligation',
    extractionConfidence: 0.7, instanceResolutionConfidence: 0.2 }));
  expect(await read(tx => readClaim(tx, { ownerScopeId: owner, claimId: awaiting })))
    .toMatchObject({ propositionId: null, lifecycle: 'AWAITING_INSTANCE_RESOLUTION', instanceResolutionConfidence: 0.2 });
});

it('CRT-MEM-07-A: a resolved vague phrase reaches storage with its precision, original text, timezone, resolver version and confidence', async () => {
  const interpretation = resolveTemporalExpression({ text: 'last month',
    reference: new Date('2026-03-14T09:30:00Z'), timeZone: 'Asia/Jerusalem', locale: 'he-IL' })!;
  const claimId = await write(tx => recordClaim(tx, { ownerScopeId: owner, sourceAnchorId: anchorId,
    claimOrigin: 'USER_STATEMENT', lifecycle: 'CANDIDATE',
    temporalInterpretation: interpretation, temporalResolutionConfidence: interpretation.confidence }));
  const stored = await read(tx => readClaim(tx, { ownerScopeId: owner, claimId }));
  expect(stored!.temporalInterpretation).toEqual(interpretation);
  expect(stored!.temporalInterpretation!.precision).toBe('MONTH');
  expect(stored!.temporalInterpretation!.precision).not.toBe('EXACT_INSTANT');
  expect(stored!.temporalResolutionConfidence).toBe(interpretation.confidence);

  // The database refuses an interpretation that is missing what PRD §12.5 requires
  // or that claims a precision outside the ladder, so a falsely precise reading is
  // not representable even through raw SQL.
  for (const invalid of [{ originalText: 'last month' }, { ...interpretation, precision: 'EXACT_SECOND' }]) {
    await expect(admin.query(`INSERT INTO claims(id,owner_scope_id,source_anchor_id,claim_origin,temporal_interpretation)
      VALUES($1,$2,$3,'USER_STATEMENT',$4)`, [randomUUID(), owner, anchorId, JSON.stringify(invalid)]))
      .rejects.toMatchObject({ code: '23514' });
  }
});

it('CRT-MEM-04-B: a fingerprint matching two slots returns both candidates and establishes no identity', async () => {
  // Two separate obligations with the same participants are two instances, so
  // their principal-amount slots have different descriptors and cannot collide.
  // A genuine collision is two slots that carry the *same* descriptor, which the
  // schema permits on purpose: identity is surrogate, not keyed by the descriptor.
  const frameInstanceId = await obligationInstance();
  const descriptor = principalAmountDescriptor(frameInstanceId);
  const first = await write(tx => createBeliefSlot(tx, { ownerScopeId: owner, descriptor }));
  const second = await write(tx => createBeliefSlot(tx, { ownerScopeId: owner, descriptor }));
  expect(first).not.toBe(second);

  const lookup = await read(tx => lookupBeliefSlot(tx, { ownerScopeId: owner, descriptor }));
  expect(lookup.fingerprint).toBe(slotFingerprint(descriptor, CANONICAL_NORMALIZATION_VERSION));
  expect(lookup.candidates.map(candidate => candidate.beliefSlotId).sort()).toEqual([first, second].sort());
  expect(lookup.candidates).toHaveLength(2);
  // Both candidates come back, and the lookup refuses to name one of them.
  expect(lookup.outcome).toBe('POSSIBLE_SLOT_MATCH');
  expect(lookup.identityEstablished).toBe(false);
  // Resolving therefore does not silently adopt either: under-merge again.
  const resolved = await write(tx => resolveBeliefSlot(tx, { ownerScopeId: owner, descriptor }));
  expect(resolved.created).toBe(true);
  expect([first, second]).not.toContain(resolved.beliefSlotId);
  expect(resolved.candidates).toHaveLength(2);

  // The index is an index: no unique constraint anywhere keys a row by its
  // fingerprint column, so a collision is representable rather than refused.
  const unique = (await admin.query(`SELECT i.relname FROM pg_index x
    JOIN pg_class i ON i.oid=x.indexrelid JOIN pg_class t ON t.oid=x.indrelid
    WHERE t.relname IN ('slot_fingerprints','proposition_fingerprints') AND x.indisunique
      AND EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=t.oid AND a.attname='fingerprint'
        AND a.attnum = ANY(x.indkey::int2[]))`)).rows;
  expect(unique).toEqual([]);
  for (const id of [first, second, resolved.beliefSlotId]) expect(lookup.fingerprint).not.toContain(id.replaceAll('-', '').slice(0, 8));
});

it('CRT-MEM-04-A: after recomputing fingerprints under a new normalization version every earlier slot and proposition ID resolves to the same object', async () => {
  const frameInstanceId = await obligationInstance();
  const descriptor = principalAmountDescriptor(frameInstanceId);
  const slot = await write(tx => resolveBeliefSlot(tx, { ownerScopeId: owner, descriptor }));
  const proposition = await write(tx => resolveProposition(tx, { ownerScopeId: owner, beliefSlotId: slot.beliefSlotId,
    normalizedValue: { amount: '50.00', currency: 'ILS' } }));
  const claimId = await write(tx => recordClaim(tx, { ownerScopeId: owner, sourceAnchorId: anchorId,
    propositionId: proposition.propositionId, claimOrigin: 'USER_STATEMENT', lifecycle: 'PROVISIONAL' }));
  const before = await read(async tx => ({
    slot: await readBeliefSlot(tx, { ownerScopeId: owner, beliefSlotId: slot.beliefSlotId }),
    proposition: await readProposition(tx, { ownerScopeId: owner, propositionId: proposition.propositionId }),
    claim: await readClaim(tx, { ownerScopeId: owner, claimId }),
  }));
  expect(before.slot).not.toBeNull();

  const next = 'normalization-2';
  const recomputed = await write(tx => recomputeCanonicalFingerprints(tx, { ownerScopeId: owner, toNormalizationVersion: next }));
  expect(recomputed.slots).toBeGreaterThan(0);
  expect(recomputed.propositions).toBeGreaterThan(0);

  // Every id issued before the recomputation resolves to exactly the object it
  // named, field for field. No row moved and nothing was renumbered.
  const after = await read(async tx => ({
    slot: await readBeliefSlot(tx, { ownerScopeId: owner, beliefSlotId: slot.beliefSlotId }),
    proposition: await readProposition(tx, { ownerScopeId: owner, propositionId: proposition.propositionId }),
    claim: await readClaim(tx, { ownerScopeId: owner, claimId }),
  }));
  expect(after).toEqual(before);
  expect(after.claim!.propositionId).toBe(proposition.propositionId);

  // The fingerprints themselves did change, which is what makes the check mean
  // something: the new version indexes the same objects under new bytes.
  const fingerprints = (await admin.query(`SELECT normalization_version,fingerprint,valid_to_recorded_at FROM slot_fingerprints
    WHERE owner_scope_id=$1 AND belief_slot_id=$2 ORDER BY valid_from_recorded_at,id`, [owner, slot.beliefSlotId])).rows;
  expect(fingerprints).toHaveLength(2);
  expect(fingerprints[0]).toMatchObject({ normalization_version: CANONICAL_NORMALIZATION_VERSION });
  expect(fingerprints[0].valid_to_recorded_at).toBeInstanceOf(Date);
  expect(fingerprints[1]).toMatchObject({ normalization_version: next, valid_to_recorded_at: null });
  expect(fingerprints[1].fingerprint).not.toBe(fingerprints[0].fingerprint);
  expect(fingerprints[1].fingerprint).toBe(slotFingerprint(descriptor, next));

  // And the new index finds the same slot, so lookup keeps working after the
  // migration rather than only the identifiers surviving it.
  const lookup = await read(tx => lookupBeliefSlot(tx, { ownerScopeId: owner, descriptor, normalizationVersion: next }));
  expect(lookup.candidates.map(candidate => candidate.beliefSlotId)).toContain(slot.beliefSlotId);
  // The superseded version is closed, not deleted: the old index row remains
  // inspectable history.
  const stale = await read(tx => lookupBeliefSlot(tx, { ownerScopeId: owner, descriptor,
    normalizationVersion: CANONICAL_NORMALIZATION_VERSION }));
  expect(stale.outcome).toBe('CREATE_NEW_SLOT');
});

it('records frame instances, roles and claims with UUIDv7 identifiers and owner-composite references', async () => {
  const entity = await write(tx => resolveEntity(tx, { ownerScopeId: owner, entityKind: 'PERSON', canonicalLabel: 'Creditor',
    aliases: [{ aliasType: 'EXTERNAL_ID', aliasValue: 'crm:4711' }] }));
  const frameInstanceId = await obligationInstance();
  const claimId = await write(tx => recordClaim(tx, { ownerScopeId: owner, sourceAnchorId: anchorId,
    assertedByEntityId: entity.entityId, claimOrigin: 'USER_STATEMENT', lifecycle: 'CANDIDATE' }));
  const roleId = await write(tx => recordFrameInstanceRole(tx, { ownerScopeId: owner, frameInstanceId,
    roleId: 'creditor', entityId: entity.entityId, claimId }));
  for (const id of [entity.entityId, frameInstanceId, claimId, roleId]) expect(id).toMatch(uuidV7Pattern);

  // A role is filled by an entity or by a typed value, never by both and never by
  // neither: participants describe an instance, they do not key it.
  await expect(write(tx => recordFrameInstanceRole(tx, { ownerScopeId: owner, frameInstanceId, roleId: 'debtor' })))
    .rejects.toThrow('FRAME_ROLE_FILLER_REQUIRED');
  await expect(admin.query(`INSERT INTO frame_instance_roles(id,owner_scope_id,frame_instance_id,role_id,entity_id,typed_value)
    VALUES($1,$2,$3,'debtor',$4,'{"name":"also"}')`, [randomUUID(), owner, frameInstanceId, entity.entityId]))
    .rejects.toMatchObject({ code: '23514' });

  // Cross-owner references are impossible, not merely unused.
  const stranger = randomUUID(), strangerUser = randomUUID();
  await admin.query('INSERT INTO users(id,display_name) VALUES($1,$2)', [strangerUser, 'Stranger']);
  await admin.query("INSERT INTO owner_scopes(id,scope_kind,display_name,created_by_user_id) VALUES($1,'PERSONAL','Other',$2)", [stranger, strangerUser]);
  const strangerContext = (await admin.query('SELECT id FROM context_spaces WHERE owner_scope_id=$1', [stranger])).rows[0].id;
  await expect(admin.query("INSERT INTO frame_instances(id,owner_scope_id,frame_type_id,context_space_id) VALUES($1,$2,'shared.obligation',$3)",
    [randomUUID(), owner, strangerContext])).rejects.toMatchObject({ code: '23503' });
  await expect(admin.query("INSERT INTO claims(id,owner_scope_id,source_anchor_id,claim_origin) VALUES($1,$2,$3,'USER_STATEMENT')",
    [randomUUID(), stranger, anchorId])).rejects.toMatchObject({ code: '23503' });
});

it('binds the evidence actor to a canonical entity instead of the delivered placeholder check', async () => {
  // The evidence node left source_items.actor_entity_id constrained null until
  // entities existed. It is now a composite owner foreign key: an owner's item may
  // name that owner's entity, and nothing else.
  const entity = await write(tx => resolveEntity(tx, { ownerScopeId: owner, entityKind: 'PERSON',
    aliases: [{ aliasType: 'EMAIL', aliasValue: 'actor@example.test' }] }));
  const checks = (await admin.query(`SELECT conname FROM pg_constraint WHERE conrelid='source_items'::regclass
    AND contype='c' AND conname='source_items_actor_entity_id_check'`)).rows;
  expect(checks).toEqual([]);
  const foreignKey = (await admin.query(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
    WHERE conrelid='source_items'::regclass AND conname='source_items_actor_entity'`)).rows[0];
  expect(foreignKey.definition).toMatch(/FOREIGN KEY \(owner_scope_id, actor_entity_id\) REFERENCES entities\(owner_scope_id, id\)/);

  // Evidence rows stay immutable, so the binding is proved on ingestion rather
  // than by rewriting a delivered item: an unknown entity is refused, this
  // owner's entity is accepted, and actor_ref and content_hash are unaffected.
  const insert = (actorEntityId: string) => admin.query(
    `INSERT INTO source_items(id,owner_scope_id,connector_id,source_type,external_id,actor_entity_id,actor_ref,
      submitted_by_user_id,raw_object_ref,content_hash,sensitivity,allowed_purposes,ingestion_version,idempotency_key)
     VALUES($1,$2,$3,'CONVERSATION',$4,$5,$6,$7,$8,$9,'PRIVATE',ARRAY['PERSONAL_ASSISTANCE'],'evidence-json-v1',$10)`,
    [randomUUID(), owner, connectorId, randomUUID(), actorEntityId, JSON.stringify({ type: 'USER', id: actor }),
      actor, randomUUID(), 'e'.repeat(64), randomUUID()]);
  await expect(insert(randomUUID())).rejects.toMatchObject({ code: '23503' });
  await insert(entity.entityId);
  const row = (await admin.query('SELECT actor_ref,content_hash FROM source_items WHERE owner_scope_id=$1 AND actor_entity_id=$2',
    [owner, entity.entityId])).rows[0];
  expect(row).toMatchObject({ actor_ref: { type: 'USER', id: actor }, content_hash: 'e'.repeat(64) });
});
