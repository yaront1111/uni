import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { runMigrations } from '@unai/postgres';
import { proactiveItemsToday } from '@unai/mentor';
import { readInbox } from '@unai/review';

if (!process.env.UNAI_TEST_DATABASE_URL) throw new Error('Run pnpm test for the required PostgreSQL harness');
const pool = new Pool({ connectionString: process.env.UNAI_TEST_DATABASE_URL });
beforeAll(async () => { await runMigrations(pool, resolve('migrations')); });
afterAll(async () => { await pool.end(); });
const DAY = '2026-09-19', BEFORE = '2026-09-18';
type Owner = { owner: string; actor: string };
async function seed(client: PoolClient): Promise<Owner> {
  await client.query('RESET ROLE');
  const owner = randomUUID(), actor = randomUUID(), source = randomUUID(), anchor = randomUUID();
  const frame = randomUUID(), prerequisite = randomUUID(), packet = randomUUID(), watch = randomUUID(), goal = randomUUID(), history = randomUUID();
  await client.query("INSERT INTO users(id,display_name) VALUES($1,'Attention counts')", [actor]);
  await client.query("INSERT INTO owner_scopes(id,scope_kind,display_name,created_by_user_id) VALUES($1,'PERSONAL','Attention',$2)", [owner, actor]);
  await client.query("INSERT INTO owner_scope_members(owner_scope_id,user_id,role) VALUES($1,$2,'OWNER')", [owner, actor]);
  const context = (await client.query('SELECT id FROM context_spaces WHERE owner_scope_id=$1', [owner])).rows[0].id;
  await client.query(`INSERT INTO source_items(id,owner_scope_id,source_type,external_id,actor_ref,submitted_by_user_id,
    raw_object_ref,content_hash,sensitivity,allowed_purposes,ingestion_version,idempotency_key)
    VALUES($1,$2,'DOCUMENT',($1::uuid)::text,$3,$4,$5,$6,'RESTRICTED',ARRAY['HEALTH_ADMINISTRATION'],'evidence-json-v1',($1::uuid)::text)`,
  [source, owner, JSON.stringify({ type: 'USER', id: actor }), actor, randomUUID(), 'a'.repeat(64)]);
  await client.query(`INSERT INTO source_anchors(id,owner_scope_id,source_item_id,anchor_kind,anchor,normalized_text)
    VALUES($1,$2,$3,'MESSAGE_SPAN','{}','ATTENTION_PRIVATE_BODY')`, [anchor, owner, source]);
  await client.query(`INSERT INTO frame_instances(id,owner_scope_id,frame_type_id,context_space_id)
    VALUES($1,$2,'shared.commitment',$3),($4,$2,'shared.commitment',$3)`, [frame, owner, context, prerequisite]);
  await client.query(`INSERT INTO context_packets(id,owner_scope_id,purpose,requesting_actor_id,answer_type_classification,request,packet,packet_hash)
    VALUES($1,$2,'HEALTH_ADMINISTRATION',$3,'CURRENT_VALUE','{}','{}',$4)`, [packet, owner, actor, 'b'.repeat(64)]);
  await client.query(`INSERT INTO initiative_watches(id,owner_scope_id,source_item_id,source_anchor_id,scheduled_frame_id,prerequisite_frame_id)
    VALUES($1,$2,$3,$4,$5,$6)`, [watch, owner, source, anchor, frame, prerequisite]);
  for (const [decision, day] of [['ASK', DAY], ['BATCH', DAY], ['SUPPRESS', DAY], ['ASK', BEFORE]]) {
    await client.query(`INSERT INTO initiative_receipts(id,owner_scope_id,watch_id,state_digest,threshold,owner_local_date,
      source_evidence_ids,packet_id,attention_decision,attention_reason,attention_inputs,preparation)
      VALUES($1,$2,$3,$4,'UPCOMING',$5,ARRAY[$6::uuid],$7,$8,'FIXTURE',$9,'NOT_REQUESTED')`,
    [randomUUID(), owner, watch, randomBytes(32).toString('hex'), day, source, packet, decision,
      JSON.stringify({ sensitivityScope: 'PERSONAL/PRIVATE', privateBody: 'ATTENTION_PRIVATE_BODY' })]);
  }
  await client.query(`INSERT INTO clarification_cards(id,owner_scope_id,situation_key,situation_kind,title,facts,why_it_matters,
    choices,grouped_ambiguity_ids,ambiguities,sensitivity_scope,policy_inputs,status,asked_at,asked_on)
    VALUES($1,$2,$3,'GENERAL','ATTENTION_PRIVATE_BODY','[]','A private matter','[{},{}]',ARRAY[$4::uuid],'[]',
      'FAMILY/NORMAL','{}','CLEARED',$5,$6)`, [randomUUID(), owner, 'frame:' + frame, randomUUID(), DAY + 'T09:00:00Z', DAY]);
  await client.query(`WITH g AS (INSERT INTO goals(id,owner_scope_id,title,domain,current_priority,created_by_user_id)
      VALUES($1,$2,'ATTENTION_PRIVATE_BODY','WORK','HIGH',$3) RETURNING id)
    INSERT INTO goal_priority_history(id,owner_scope_id,goal_id,change_kind,priority,valid_from,reason,recorded_by_user_id)
      SELECT $4,$2,g.id,'INITIAL','HIGH',now(),'ATTENTION_PRIVATE_BODY',$3 FROM g`, [goal, owner, actor, history]);
  for (const decision of ['ASK', 'BATCH']) {
    await client.query(`INSERT INTO mentor_cards(id,owner_scope_id,card_kind,goal_id,goal_priority_history_id,evidence,inference,
      recommendation,observation_window_start,observation_window_end,confidence,sensitivity_scope,decision,reason,policy_inputs,
      owner_local_date,policy_version,composer_version,context_packet_id,packet_hash)
      VALUES($1,$2,'GOAL_CALENDAR_CONTRADICTION',$3,$4,'[{}]',
      '{"text":"ATTENTION_PRIVATE_BODY","confidence":0.6,"counterexampleSearch":{}}','{"text":"Private recommendation"}',
      '2026-09-01T00:00:00Z','2026-09-19T00:00:00Z',0.6,'WORK/PRIVATE',$5,'FIXTURE',
      '{"errorProbability":0.6,"consequence":"HIGH","irreversibility":"COSTLY_TO_REVERSE","urgency":"MEDIUM","interruptionCost":"LOW","budget":{}}',
      $6,'interruption-policy-0.1.0','mentor-contradictions-0.1.0',$7,$8)`,
    [randomUUID(), owner, goal, history, decision, DAY, packet, 'c'.repeat(64)]);
  }
  await client.query('INSERT INTO attention_budgets(owner_scope_id,max_cards_per_day,updated_by_user_id) VALUES($1,3,$2)', [owner, actor]);
  return { owner, actor };
}
async function gate(client: PoolClient, o: Owner, purpose: string) {
  await client.query('SET LOCAL ROLE unai_app');
  await client.query(`SELECT set_config('unai.owner_scope_id',$1,true),set_config('unai.actor_id',$2,true),
    set_config('unai.purpose',$3,true),set_config('unai.data_purpose','PERSONAL_ASSISTANCE',true),
    set_config('unai.maximum_sensitivity','NORMAL',true)`, [o.owner, o.actor, purpose]);
}
async function fixture(run: (client: PoolClient, o: Owner) => Promise<void>) {
  const client = await pool.connect();
  try { await client.query('BEGIN'); await run(client, await seed(client)); }
  finally { await client.query('ROLLBACK'); client.release(); }
}
const expected = new Map([['FAMILY/NORMAL', 1], ['PERSONAL/PRIVATE', 1], ['WORK/PRIVATE', 1]]);

it('counts initiative ASK in the mentor budget even when its receipt body and source are unreadable', async () => {
  await fixture(async (client, o) => {
    await gate(client, o, 'mentor.advise');
    expect((await client.query('SELECT * FROM initiative_receipts')).rows).toEqual([]);
    expect((await client.query('SELECT * FROM source_items')).rows).toEqual([]);
    expect(await proactiveItemsToday(client, { ownerScopeId: o.owner, ownerLocalDate: DAY })).toEqual(expected);
  });
});

it('deducts clarification, mentor and initiative ASK from the same inbox budget without exposing receipt content', async () => {
  await fixture(async (client, o) => {
    await gate(client, o, 'memory.inbox');
    const view = await readInbox(client, { ownerScopeId: o.owner, now: new Date(DAY + 'T12:00:00Z'), timeZone: 'UTC', contextPacketId: null });
    expect(view.remainingToday).toBe(0);
    expect(view.remainingByScope.map(value => value.sensitivityScope)).toEqual([...expected.keys()]);
    expect(JSON.stringify(view)).not.toContain('ATTENTION_PRIVATE_BODY');
  });
});

it('returns only content-free owner/day counts under the two attention purposes', async () => {
  await fixture(async (client, o) => {
    const other = await seed(client);
    const read = async (ownerId = o.owner, day: string | null = DAY) => (await client.query(
      'SELECT * FROM unai_private.proactive_attention_counts($1,$2::date)', [ownerId, day])).rows;
    await gate(client, o, 'memory.inbox');
    expect(await read()).toEqual([...expected].map(([sensitivity_scope, n]) => ({ sensitivity_scope, n: String(n) })));
    expect(await read(o.owner, BEFORE)).toEqual([{ sensitivity_scope: 'PERSONAL/PRIVATE', n: '1' }]);
    expect(await read(other.owner)).toEqual([]);
    expect(await read(o.owner, null)).toEqual([]);
    await gate(client, o, 'memory.read'); expect(await read()).toEqual([]);
    await gate(client, { owner: o.owner, actor: other.actor }, 'memory.inbox'); expect(await read()).toEqual([]);
  });
});
