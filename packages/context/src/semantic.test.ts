import { Pool } from 'pg';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { runMigrations, withOwnerTransaction, type OwnerTransaction } from '@unai/postgres';
import { hashedLexicalEmbedder, indexClaimEmbeddings, searchMemoryEmbeddings, vectorLiteral } from '@unai/memory';
import { uuidV7 } from '../../../src/kernel/identities.js';
import { readContextPacket } from './index.js';

/**
 * CRT-RD-04-A over real PostgreSQL: semantic search never returns an object from
 * another owner, a disallowed purpose or sensitivity, or outside the requested
 * time, source or entity filters -- even when that object is the nearest
 * embedding match (PRD §23.2 step 10, FR-063; ADR 0024 §3).
 *
 * Every object the filters must exclude states the query's own words, identically,
 * so every one of them has the same embedding and sits nearer the query than
 * anything else: each *would* be the nearest match if any filter ran after
 * ranking. The one object the filters admit says something similar in other
 * words, so it is strictly farther away. The test proves both halves: the excluded
 * objects are nearer, and none is returned.
 */

if (!process.env.UNAI_TEST_DATABASE_URL) throw new Error('Run pnpm test for the required PostgreSQL harness');
const admin = new Pool({ connectionString: process.env.UNAI_TEST_DATABASE_URL });
const appUrl = new URL(process.env.UNAI_TEST_DATABASE_URL); appUrl.username = 'semantic_test_app'; appUrl.password = 'test-only';
const appPool = new Pool({ connectionString: appUrl.href });

const FINANCE = 'PERSONAL_FINANCE', HEALTH = 'HEALTH_CARE';
const QUERY = 'Daniel lent me money for the car repair in February';
const NOW = new Date('2026-03-02T09:00:00.000Z');
const WINDOW = { from: '2026-01-01T00:00:00.000Z', to: '2026-06-01T00:00:00.000Z' };

const ownerA = randomUUID(), actorA = randomUUID(), ownerB = randomUUID(), actorB = randomUUID();
let danielA = '', otherDanielA = '', danielB = '';
/** The claims of owner A, by what makes each one excluded (or not). */
const claims: Record<'allowed' | 'restricted' | 'otherPurpose' | 'otherSource' | 'outsideWindow' | 'otherEntity'
  | 'learnedLater', string> = {
  allowed: '', restricted: '', otherPurpose: '', otherSource: '', outsideWindow: '', otherEntity: '', learnedLater: '',
};
let ownerBClaim = '';

async function owner(ownerScopeId: string, actorId: string, label: string) {
  await admin.query('INSERT INTO users(id,display_name) VALUES($1,$2)', [actorId, label]);
  await admin.query("INSERT INTO owner_scopes(id,scope_kind,display_name,created_by_user_id) VALUES($1,'PERSONAL',$2,$3)", [ownerScopeId, label, actorId]);
  await admin.query("INSERT INTO owner_scope_members(owner_scope_id,user_id,role) VALUES($1,$2,'OWNER')", [ownerScopeId, actorId]);
}

/** One claim in its own obligation frame, over one evidence item. The value text
 * is what the embedding is made of, with the frame and the creditor's label. */
async function claim(input: {
  ownerScopeId: string; actorId: string; creditor: string; text: string; sensitivity?: string; purposes?: string[];
  sourceType?: string; validFrom?: Date; validTo?: Date | null; recordedAt?: Date;
}): Promise<string> {
  const { ownerScopeId } = input;
  const connectorId = randomUUID(), sourceItemId = randomUUID(), anchorId = randomUUID();
  const frameId = uuidV7(), slotId = uuidV7(), propositionId = uuidV7(), claimId = uuidV7();
  const context = (await admin.query("SELECT id FROM context_spaces WHERE owner_scope_id=$1 AND context_kind='BASE'", [ownerScopeId])).rows[0].id;
  await admin.query("INSERT INTO connectors(id,owner_scope_id,connector_type,external_account_ref,permission_manifest,status) VALUES($1,$2,'CONVERSATION',$3,'{}','ACTIVE')",
    [connectorId, ownerScopeId, randomUUID()]);
  await admin.query(`INSERT INTO source_items(id,owner_scope_id,connector_id,source_type,external_id,actor_ref,submitted_by_user_id,
    raw_object_ref,content_hash,sensitivity,allowed_purposes,ingestion_version,idempotency_key,occurred_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'evidence-json-v1',$12,$13)`,
    [sourceItemId, ownerScopeId, connectorId, input.sourceType ?? 'CONVERSATION', randomUUID(),
      JSON.stringify({ type: 'USER', id: input.actorId }), input.actorId, randomUUID(),
      randomUUID().replaceAll('-', '').padEnd(64, 'a').slice(0, 64), input.sensitivity ?? 'PRIVATE',
      input.purposes ?? [FINANCE], randomUUID(), input.validFrom ?? new Date('2026-02-01T08:00:00.000Z')]);
  await admin.query("INSERT INTO source_anchors(id,owner_scope_id,source_item_id,anchor_kind,anchor) VALUES($1,$2,$3,'MESSAGE_SPAN','{\"start\":0,\"end\":40}')",
    [anchorId, ownerScopeId, sourceItemId]);
  await admin.query("INSERT INTO frame_instances(id,owner_scope_id,frame_type_id,context_space_id,created_at) VALUES($1,$2,'shared.obligation',$3,'2024-01-01T00:00:00Z')",
    [frameId, ownerScopeId, context]);
  await admin.query(`INSERT INTO belief_slots(id,owner_scope_id,frame_instance_id,predicate_id,context_space_id,modality,created_at)
    VALUES($1,$2,$3,'shared.obligation.description',$4,'ACTUAL','2024-01-01T00:00:00Z')`, [slotId, ownerScopeId, frameId, context]);
  await admin.query("INSERT INTO propositions(id,owner_scope_id,belief_slot_id,normalized_value,created_at) VALUES($1,$2,$3,$4,'2024-01-01T00:00:00Z')",
    [propositionId, ownerScopeId, slotId, JSON.stringify({ text: input.text })]);
  await admin.query(`INSERT INTO claims(id,owner_scope_id,source_anchor_id,proposition_id,claim_origin,lifecycle,valid_from,valid_to,recorded_at)
    VALUES($1,$2,$3,$4,'USER_STATEMENT','PROVISIONAL',$5,$6,$7)`,
    [claimId, ownerScopeId, anchorId, propositionId, input.validFrom ?? new Date('2026-02-01T08:00:00.000Z'),
      input.validTo ?? null, input.recordedAt ?? new Date('2026-02-01T09:00:00.000Z')]);
  await admin.query(`INSERT INTO frame_instance_roles(id,owner_scope_id,frame_instance_id,role_id,entity_id,claim_id,created_at)
    VALUES($1,$2,$3,'creditor',$4,$5,$6)`,
    [randomUUID(), ownerScopeId, frameId, input.creditor, claimId, input.recordedAt ?? new Date('2026-02-01T09:00:00.000Z')]);
  return claimId;
}

async function index(ownerScopeId: string, actorId: string, claimIds: string[]) {
  const result = await withOwnerTransaction(appPool, { actorId, ownerScopeId, purpose: 'memory.govern', correlationId: randomUUID() },
    tx => indexClaimEmbeddings(tx, { ownerScopeId, claimIds }));
  expect(result.skipped).toEqual([]);
  expect([...result.indexed].sort()).toEqual([...claimIds].sort());
}

beforeAll(async () => {
  await runMigrations(admin, resolve('migrations'));
  await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='semantic_test_app') THEN CREATE ROLE semantic_test_app LOGIN PASSWORD 'test-only'; END IF; END $$; GRANT unai_app TO semantic_test_app");
  await owner(ownerA, actorA, 'Semantic A');
  await owner(ownerB, actorB, 'Semantic B');
  danielA = uuidV7(); otherDanielA = uuidV7(); danielB = uuidV7();
  // Two different people called Daniel in owner A's memory: the entity filter has
  // to tell them apart even though their claims read identically.
  await admin.query(`INSERT INTO entities(id,owner_scope_id,entity_kind,canonical_label) VALUES
    ($1,$4,'PERSON','Daniel'),($2,$4,'PERSON','Daniel'),($3,$5,'PERSON','Daniel')`, [danielA, otherDanielA, danielB, ownerA, ownerB]);

  const base = { ownerScopeId: ownerA, actorId: actorA, creditor: danielA };
  // The one object every filter admits -- similar, not identical, to the query.
  claims.allowed = await claim({ ...base, text: 'Daniel gave me a loan to fix the car' });
  // Identical to the query, each excluded by exactly one hard filter.
  claims.restricted = await claim({ ...base, text: QUERY, sensitivity: 'RESTRICTED' });
  claims.otherPurpose = await claim({ ...base, text: QUERY, purposes: [HEALTH] });
  claims.otherSource = await claim({ ...base, text: QUERY, sourceType: 'EMAIL' });
  claims.outsideWindow = await claim({ ...base, text: QUERY, validFrom: new Date('2025-01-10T00:00:00.000Z'),
    validTo: new Date('2025-06-01T00:00:00.000Z'), recordedAt: new Date('2025-01-10T00:00:00.000Z') });
  claims.otherEntity = await claim({ ...base, creditor: otherDanielA, text: QUERY });
  claims.learnedLater = await claim({ ...base, text: QUERY, recordedAt: new Date('2026-03-05T00:00:00.000Z') });
  // And another owner's identical object.
  ownerBClaim = await claim({ ownerScopeId: ownerB, actorId: actorB, creditor: danielB, text: QUERY });

  await index(ownerA, actorA, Object.values(claims));
  await index(ownerB, actorB, [ownerBClaim]);
});
afterAll(async () => { await appPool.end(); await admin.end(); });

const read = <T,>(run: (tx: OwnerTransaction) => Promise<T>) =>
  withOwnerTransaction(appPool, { actorId: actorA, ownerScopeId: ownerA, purpose: 'memory.read', correlationId: randomUUID() }, run);

/** The request every test narrows from: finance purpose, PRIVATE ceiling, one
 * Daniel, one window, conversations only, knowledge at NOW. */
function filters(over: Partial<Parameters<typeof searchMemoryEmbeddings>[1]> = {}): Parameters<typeof searchMemoryEmbeddings>[1] {
  return {
    ownerScopeId: ownerA, query: QUERY, dataPurpose: FINANCE, maximumSensitivity: 'PRIVATE', knowledgeTime: NOW,
    timeWindow: { from: new Date(WINDOW.from), to: new Date(WINDOW.to) }, entityIds: [danielA], sourceTypes: ['CONVERSATION'],
    limit: 50, ...over,
  };
}
async function search(over: Partial<Parameters<typeof searchMemoryEmbeddings>[1]> = {}) {
  const request = filters(over);
  return read(async tx => {
    await tx.query("SELECT set_config('unai.data_purpose',$1,true),set_config('unai.maximum_sensitivity',$2,true)",
      [request.dataPurpose, request.maximumSensitivity]);
    return searchMemoryEmbeddings(tx, request);
  });
}

it('an explicitly empty authorized source set cannot widen semantic retrieval', async () => {
  const result = await search({ sourceItemIds: [] });
  expect(result!.matches).toEqual([]);
  expect(result!.candidatesAfterFilters).toBe(0);
});

it('policy exclusions apply before the semantic candidate budget', async () => {
  const result = await search({ maximumSensitivity: 'RESTRICTED', limit: 1,
    excludedObjectIds: [claims.restricted] } as Partial<Parameters<typeof searchMemoryEmbeddings>[1]>);
  expect(result!.matches.map(match => match.objectId)).toEqual([claims.allowed]);
  expect(result!.candidatesAfterFilters).toBe(1);
});

it('CRT-RD-04-A: the excluded objects are the nearest embeddings, and the search still returns only the admitted one', async () => {
  // The premise: by distance alone every excluded object beats the admitted one.
  const query = hashedLexicalEmbedder.embed(QUERY)!;
  const distances = new Map((await admin.query(
    'SELECT object_id,(vector <=> $1::vector) AS distance FROM memory_embeddings WHERE owner_scope_id=ANY($2::uuid[])',
    [vectorLiteral(query), [ownerA, ownerB]])).rows.map(row => [row.object_id as string, Number(row.distance)]));
  const nearest = distances.get(claims.restricted)!;
  for (const [name, claimId] of [...Object.entries(claims).filter(([name]) => name !== 'allowed'), ['ownerB', ownerBClaim]] as const) {
    // Identical content, identical vector, identical distance...
    expect(distances.get(claimId), name).toBeCloseTo(nearest, 6);
    // ...and nearer the query than the object the filters admit.
    expect(distances.get(claimId)!, name).toBeLessThan(distances.get(claims.allowed)! - 0.05);
  }

  // The result: only the admitted object, although it is the farthest of all.
  const result = await search();
  expect(result!.matches.map(match => match.objectId)).toEqual([claims.allowed]);
  expect(result!.candidatesAfterFilters).toBe(1);
  expect(result!.matches[0]!.distance).toBeGreaterThan(0);
  expect(result!.filters).toMatchObject({ ownerScopeId: ownerA, dataPurpose: FINANCE, maximumSensitivity: 'PRIVATE',
    entityIds: [danielA], sourceTypes: ['CONVERSATION'], timeWindow: WINDOW });
});

it('CRT-RD-04-A: each boundary on its own excludes its nearest match, and lifting it admits that match', async () => {
  // Every case lifts exactly one filter; the object that filter was excluding is
  // then returned -- first, ahead of the admitted one -- which is what makes the
  // exclusion a decision of the filter rather than an accident of the fixture.
  const admitted = (await search())!.matches[0]!.distance;
  const cases: Array<[string, string, Partial<Parameters<typeof searchMemoryEmbeddings>[1]>]> = [
    ['sensitivity', claims.restricted, { maximumSensitivity: 'RESTRICTED' }],
    ['permission', claims.otherPurpose, { dataPurpose: HEALTH }],
    ['source', claims.otherSource, { sourceTypes: null }],
    ['time', claims.outsideWindow, { timeWindow: null }],
    ['entity', claims.otherEntity, { entityIds: null }],
    ['knowledge time', claims.learnedLater, { knowledgeTime: new Date('2026-03-10T00:00:00.000Z') }],
  ];
  for (const [boundary, excluded, lifted] of cases) {
    const narrowed = await search();
    expect(narrowed!.matches.map(match => match.objectId), boundary).not.toContain(excluded);
    const widened = await search(lifted);
    expect(widened!.matches[0]?.objectId, boundary).toBe(excluded);
    expect(widened!.matches[0]!.distance, boundary).toBeLessThan(admitted);
    // Lifting one boundary never lets in what another still excludes.
    const others = Object.values(claims).filter(id => id !== excluded && id !== claims.allowed);
    for (const other of others) expect(widened!.matches.map(match => match.objectId), boundary).not.toContain(other);
  }
  // A time window excludes an object that cannot be shown to be inside it, and a
  // window that does include it admits it.
  const early = await search({ timeWindow: { from: new Date('2025-01-01T00:00:00.000Z'), to: new Date('2025-12-31T00:00:00.000Z') } });
  expect(early!.matches.map(match => match.objectId)).toEqual([claims.outsideWindow]);
});

it('CRT-RD-04-A: another owner\'s identical object is never returned, whatever the other filters say', async () => {
  // Even with every narrowing filter lifted, owner A's search reads owner A's rows.
  const widest = await search({ maximumSensitivity: 'RESTRICTED', timeWindow: null, entityIds: null, sourceTypes: null,
    knowledgeTime: new Date('2026-12-31T00:00:00.000Z') });
  expect(widest!.matches.length).toBeGreaterThan(0);
  expect(widest!.matches.map(match => match.objectId)).not.toContain(ownerBClaim);
  // Naming owner B's scope from owner A's session reads nothing: the row policy
  // decides, not the parameter.
  const forged = await search({ ownerScopeId: ownerB, maximumSensitivity: 'RESTRICTED', timeWindow: null, entityIds: null,
    sourceTypes: null });
  expect(forged!.matches).toEqual([]);
  expect(forged!.candidatesAfterFilters).toBe(0);
  // Naming owner B's entity finds nothing either.
  expect((await search({ entityIds: [danielB], timeWindow: null, sourceTypes: null }))!.matches).toEqual([]);
});

it('CRT-RD-04-A: the Context Broker runs the semantic step under the request\'s own boundaries', async () => {
  const runner = <T,>(run: (tx: OwnerTransaction) => Promise<T>) => read(run);
  const packet = await readContextPacket(runner, {
    ownerScopeId: ownerA, requestingActorId: actorA, purpose: FINANCE, query: QUERY, worldTime: 'NOW', knowledgeTime: 'LATEST',
    maximumSensitivity: 'PRIVATE', actionRisk: 'LOW', entityHints: [danielA], timeWindow: WINDOW, sourceTypes: ['CONVERSATION'],
  }, { correlationId: randomUUID(), now: NOW, registryReleaseId: null });
  expect(packet.semanticSearch?.matches.map(match => match.objectId)).toEqual([claims.allowed]);
  expect(packet.semanticSearch?.filters).toMatchObject({ ownerScopeId: ownerA, dataPurpose: FINANCE, maximumSensitivity: 'PRIVATE',
    knowledgeTime: NOW.toISOString(), entityIds: [danielA], sourceTypes: ['CONVERSATION'] });
  // With no release pinned nothing is authoritative, and the match says so.
  expect(packet.semanticSearch?.matches[0]).toMatchObject({ authority: 'NON_AUTHORITATIVE_UNREGISTERED_PREDICATE' });
  // The evidence behind the match is linked. Evidence the request may not read at
  // all (above the ceiling, another purpose) or that sits under the other Daniel
  // is linked by nothing in the packet.
  const evidenceOf = async (claimId: string) => (await admin.query(
    'SELECT a.source_item_id FROM claims c JOIN source_anchors a ON a.id=c.source_anchor_id WHERE c.id=$1', [claimId])).rows[0].source_item_id;
  const linked = packet.evidenceRefs.map(reference => reference.evidenceId);
  expect(linked).toContain(await evidenceOf(claims.allowed));
  for (const excluded of [claims.restricted, claims.otherPurpose, claims.otherEntity]) {
    expect(linked).not.toContain(await evidenceOf(excluded));
  }
});
