import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { runMigrations } from '@unai/postgres';

if (!process.env.UNAI_TEST_DATABASE_URL) throw new Error('Run pnpm test for the required PostgreSQL harness');
const pool = new Pool({ connectionString: process.env.UNAI_TEST_DATABASE_URL });
beforeAll(async () => { await runMigrations(pool, resolve('migrations')); });
afterAll(async () => { await pool.end(); });
const SOURCE = '2025-09-15T09:00:00.000Z', IMPORT = '2026-09-19T09:00:00.000Z', NOW = '2026-10-19T09:00:00.000Z';
interface ClaimOptions { origin?: string; sourceTime?: string | null; recordedAt?: string; sensitivity?: string;
  purposes?: string[]; metadata?: Record<string, unknown>; actorType?: string; propositionId?: string | null;
  temporalInterpretation?: Record<string, unknown> }
type Belief = { propositionId: string; frameTypeId: string; predicateId: string; validFrom: null; validTo: null;
  claimIds: string[]; evidenceIds: string[] };
async function fixture(run: (input: { client: PoolClient; owner: string; actor: string; releaseId: string; belief: Belief;
  addClaim: (options?: ClaimOptions) => Promise<{ claimId: string; evidenceId: string }>;
  read: (beliefs?: Belief[], knowledgeTime?: string) => Promise<Awaited<ReturnType<(typeof import('./freshness.js'))['readContextFreshness']>>> }) => Promise<void>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const owner = randomUUID(), actor = randomUUID(), releaseId = randomUUID(), frameId = randomUUID(), slotId = randomUUID();
    const propositionId = randomUUID();
    await client.query("INSERT INTO users(id,display_name) VALUES($1,'Freshness clock')", [actor]);
    await client.query("INSERT INTO owner_scopes(id,scope_kind,display_name,created_by_user_id) VALUES($1,'PERSONAL','Clock',$2)", [owner, actor]);
    await client.query("INSERT INTO owner_scope_members(owner_scope_id,user_id,role) VALUES($1,$2,'OWNER')", [owner, actor]);
    const contextId = (await client.query('SELECT id FROM context_spaces WHERE owner_scope_id=$1', [owner])).rows[0].id as string;
    await client.query(`INSERT INTO frame_instances(id,owner_scope_id,frame_type_id,context_space_id,created_at)
      VALUES($1,$2,'shared.commitment',$3,$4)`, [frameId, owner, contextId, SOURCE]);
    await client.query(`INSERT INTO belief_slots(id,owner_scope_id,frame_instance_id,predicate_id,context_space_id,modality,created_at)
      VALUES($1,$2,$3,'shared.commitment.priority',$4,'COMMITTED',$5)`, [slotId, owner, frameId, contextId, SOURCE]);
    await client.query(`INSERT INTO propositions(id,owner_scope_id,belief_slot_id,normalized_value,created_at)
      VALUES($1,$2,$3,'"HIGH"',$4)`, [propositionId, owner, slotId, SOURCE]);
    const policy = { policyId: 'aging.shared.commitment.priority', policyVersion: '9998.0.2', kind: 'LAST_KNOWN',
      frameTypeId: 'shared.commitment', predicateId: 'shared.commitment.priority', reviewAfterDays: 30,
      verificationTrigger: 'WHEN_RELEVANT', explanation: 'Old priority is last known and needs verification when relevant.' };
    await client.query(`INSERT INTO registry_releases(id,semantic_version,git_tag,git_commit,content_hash,lifecycle,released_at,manifest,correlation_id)
      VALUES($1,'9998.0.2','registry-v9998.0.2',$2,$3,'RELEASED',now(),'{}',$4)`, [releaseId, 'a'.repeat(40), 'b'.repeat(64), randomUUID()]);
    await client.query(`INSERT INTO registry_contracts(id,registry_release_id,contract_id,contract_version,contract_kind,content,content_hash)
      VALUES($1,$2,$3,'9998.0.2','PREDICATE',$4,$5)`, [randomUUID(), releaseId, policy.predicateId, JSON.stringify({ agingPolicy: policy }), 'c'.repeat(64)]);
    const belief: Belief = { propositionId, frameTypeId: policy.frameTypeId, predicateId: policy.predicateId,
      validFrom: null, validTo: null, claimIds: [], evidenceIds: [] };
    const addClaim = async (options: ClaimOptions = {}) => {
      await client.query('RESET ROLE');
      const evidenceId = randomUUID(), anchorId = randomUUID(), claimId = randomUUID();
      await client.query(`INSERT INTO source_items(id,owner_scope_id,source_type,external_id,actor_ref,submitted_by_user_id,
        occurred_at,observed_at,raw_object_ref,content_hash,sensitivity,allowed_purposes,ingestion_version,idempotency_key)
        VALUES($1,$2,'CONVERSATION',($1::uuid)::text,$3,$4,$5,$6,$7,$8,$9,$10,'evidence-json-v1',($1::uuid)::text)`,
      [evidenceId, owner, JSON.stringify({ type: options.actorType ?? 'USER', id: actor }), actor,
        options.sourceTime === undefined ? SOURCE : options.sourceTime, IMPORT, randomUUID(), 'd'.repeat(64),
        options.sensitivity ?? 'PRIVATE', options.purposes ?? ['PERSONAL_ASSISTANCE']]);
      await client.query(`INSERT INTO source_anchors(id,owner_scope_id,source_item_id,anchor_kind,anchor,normalized_text)
        VALUES($1,$2,$3,'MESSAGE_SPAN','{}','Priority is high')`, [anchorId, owner, evidenceId]);
      await client.query(`INSERT INTO claims(id,owner_scope_id,source_anchor_id,proposition_id,claim_origin,lifecycle,recorded_at,metadata,temporal_interpretation)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [claimId, owner, anchorId, options.propositionId === undefined ? propositionId : options.propositionId,
        options.origin ?? 'USER_STATEMENT', options.propositionId === null ? 'CANDIDATE' : 'PROVISIONAL',
        options.recordedAt ?? IMPORT, JSON.stringify(options.metadata ?? {}), options.temporalInterpretation ?? null]);
      belief.claimIds.push(claimId); belief.evidenceIds.push(evidenceId);
      return { claimId, evidenceId };
    };
    const read = async (beliefs = [belief], knowledgeTime = NOW) => {
      await client.query('SET LOCAL ROLE unai_app');
      await client.query(`SELECT set_config('unai.owner_scope_id',$1,true),set_config('unai.actor_id',$2,true),
        set_config('unai.purpose','memory.read',true),set_config('unai.data_purpose','PERSONAL_ASSISTANCE',true),
        set_config('unai.maximum_sensitivity','PRIVATE',true)`, [owner, actor]);
      const { readContextFreshness } = await import('./freshness.js');
      return readContextFreshness(client, { ownerScopeId: owner, registryReleaseId: releaseId, worldTime: NOW,
        knowledgeTime, evaluatedAt: NOW, beliefs, decisionRelevant: true });
    };
    await run({ client, owner, actor, releaseId, belief, addClaim, read });
  } finally { await client.query('ROLLBACK'); client.release(); }
}

it('uses the original source clock for late imports and repeated extraction, not import or processing dates', async () => {
  await fixture(async ({ addClaim, read }) => {
    const original = await addClaim();
    const extracted = await addClaim({ origin: 'MODEL_EXTRACTION', metadata: { assertionReferenceInstant: SOURCE } });
    const result = (await read())[0]!.assessment;
    expect(result).toMatchObject({ state: 'VERIFY', basisAt: SOURCE, verificationRequired: true });
    expect(result.evidenceIds).toEqual([original.evidenceId, extracted.evidenceId].sort());
    expect(result.claimIds).toEqual([original.claimId, extracted.claimId].sort());
    expect((await read())[0]!.assessment).toEqual(result);
  });
});

it('preserves unknown source times and rejects extraction reference times that disagree with the source', async () => {
  await fixture(async ({ addClaim, read }) => {
    await addClaim({ sourceTime: null });
    await addClaim({ origin: 'MODEL_EXTRACTION', metadata: { assertionReferenceInstant: NOW } });
    expect((await read())[0]!.assessment).toMatchObject({ state: 'UNKNOWN', basisAt: null });
  });
});

it('does not use model summaries, inferred outputs or transitive input assertions as renewed output evidence', async () => {
  await fixture(async ({ addClaim, belief, read }) => {
    await addClaim({ origin: 'MODEL_INFERENCE', sourceTime: NOW });
    await addClaim({ origin: 'MODEL_EXTRACTION', sourceTime: NOW });
    await addClaim({ actorType: 'ASSISTANT', sourceTime: NOW });
    expect((await read())[0]!.assessment).toMatchObject({ state: 'UNKNOWN', basisAt: null });
    const leaf = await addClaim({ sourceTime: NOW });
    const derived = { ...belief, propositionId: randomUUID(), claimIds: [leaf.claimId], evidenceIds: [leaf.evidenceId] };
    expect((await read([derived]))[0]!.assessment).toMatchObject({ state: 'UNKNOWN', basisAt: null });
  });
});

it('requires each belief claim and evidence pair to be authorized, including purpose and sensitivity', async () => {
  await fixture(async ({ addClaim, belief, read }) => {
    const visible = await addClaim();
    const hidden = await addClaim({ sourceTime: NOW, sensitivity: 'RESTRICTED' });
    await addClaim({ sourceTime: NOW, purposes: ['PERSONAL_FINANCE'] });
    const result = (await read())[0]!.assessment;
    expect(result).toMatchObject({ basisAt: SOURCE, state: 'VERIFY', evidenceIds: [visible.evidenceId], claimIds: [visible.claimId] });
    const excluded = { ...belief, claimIds: [visible.claimId], evidenceIds: [hidden.evidenceId] };
    expect((await read([excluded]))[0]!.assessment).toMatchObject({ basisAt: null, state: 'UNKNOWN', evidenceIds: [] });
  });
});

it('admits a new original confirmation only once its claim is known and never mutates earlier assessment provenance', async () => {
  await fixture(async ({ addClaim, read }) => {
    const old = await addClaim();
    const fresh = await addClaim({ origin: 'USER_CONFIRMATION', sourceTime: NOW, recordedAt: NOW });
    const historical = (await read(undefined, IMPORT))[0]!.assessment;
    const serialized = JSON.stringify(historical);
    expect(historical).toMatchObject({ basisAt: SOURCE, state: 'VERIFY', claimIds: [old.claimId] });
    expect((await read())[0]!.assessment).toMatchObject({ basisAt: NOW, state: 'CURRENT', claimIds: [fresh.claimId] });
    expect(JSON.stringify(historical)).toBe(serialized);
  });
});

it('does not refresh a historical extraction from the clock of a new retrospective message', async () => {
  await fixture(async ({ addClaim, read }) => {
    await addClaim({ origin: 'MODEL_EXTRACTION', sourceTime: NOW, metadata: { assertionReferenceInstant: NOW, temporalExpression: 'last year' },
      temporalInterpretation: { originalText: 'last year', normalizedTime: { start: '2025-01-01T00:00:00.000Z', end: '2026-01-01T00:00:00.000Z' },
        timeZone: 'UTC', precision: 'DAY', resolverVersion: 'fixture-0.1.0', confidence: 1 } });
    expect((await read())[0]!.assessment).toMatchObject({ state: 'UNKNOWN', basisAt: null });
  });
});

it('admits independently sourced direct support without converting the support creation time into a fresh assertion', async () => {
  await fixture(async ({ client, owner, actor, releaseId, belief, addClaim, read }) => {
    const leaf = await addClaim({ origin: 'USER_CONFIRMATION', propositionId: null });
    expect((await read())[0]!.assessment).toMatchObject({ state: 'UNKNOWN', basisAt: null });
    await client.query('RESET ROLE');
    const transactionId = randomUUID();
    await client.query(`INSERT INTO belief_transactions(id,owner_scope_id,transaction_kind,requested_by_actor_id,
      registry_release_id,status,risk,idempotency_key,committed_at,commit_receipt)
      VALUES($1,$2,'CONFIRM',$3,$4,'COMMITTED','LOW',$5,$6,'{}')`, [transactionId, owner, actor, releaseId, randomUUID(), NOW]);
    await client.query(`INSERT INTO belief_support(id,owner_scope_id,proposition_id,claim_id,support_kind,created_by_transaction_id,created_at)
      VALUES($1,$2,$3,$4,'DIRECT_ASSERTION',$5,$6)`, [randomUUID(), owner, belief.propositionId, leaf.claimId, transactionId, NOW]);
    expect((await read())[0]!.assessment).toMatchObject({ state: 'VERIFY', basisAt: SOURCE,
      evidenceIds: [leaf.evidenceId], claimIds: [leaf.claimId] });
  });
});

it('withholds a superseded claim from freshness while a query before supersession keeps its original source basis', async () => {
  await fixture(async ({ client, owner, addClaim, read }) => {
    const leaf = await addClaim();
    expect((await read())[0]!.assessment.basisAt).toBe(SOURCE);
    await client.query('RESET ROLE');
    await client.query("UPDATE claims SET lifecycle='SUPERSEDED' WHERE owner_scope_id=$1 AND id=$2", [owner, leaf.claimId]);
    expect((await read())[0]!.assessment).toMatchObject({ state: 'UNKNOWN', basisAt: null });
    expect((await read(undefined, IMPORT))[0]!.assessment).toMatchObject({ state: 'VERIFY', basisAt: SOURCE });
  });
});
