import { Pool } from 'pg';
import { z } from 'zod';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { runMigrations, withOwnerTransaction } from '@unai/postgres';
import type { RequestContext } from '@unai/domain';
import { BELIEF_PURPOSES, recordBeliefAssessment } from '@unai/belief';
import { EXTRACTION_PURPOSES } from '@unai/extraction';
import { createModelGateway, MODEL_PURPOSES, type ModelProvider } from './gateway.js';

/**
 * CRT-WRT-01-A, the runtime half: model output injected straight into the belief
 * store, without a governed belief transaction, fails at the database boundary.
 *
 * `src/boundaries.test.ts` proves no code path from the extraction service or
 * this gateway reaches an assessment writer. This file proves the boundary holds
 * even for code that tries anyway: a real gateway call produces "ACCEPTED" for a
 * real proposition, and every way of writing that verdict without a governed
 * transaction is refused -- under the gateway's and the extraction service's
 * own purposes by the row policies, and under the governor's purpose by the
 * requirement that an assessment name a transaction that exists.
 */

if (!process.env.UNAI_TEST_DATABASE_URL) throw new Error('Run pnpm test for the required PostgreSQL harness');
const admin = new Pool({ connectionString: process.env.UNAI_TEST_DATABASE_URL });
const appUrl = new URL(process.env.UNAI_TEST_DATABASE_URL); appUrl.username = 'assessment_boundary_test_app'; appUrl.password = 'test-only';
const appPool = new Pool({ connectionString: appUrl.href });
const owner = randomUUID(), actor = randomUUID();
let propositionId = '';

beforeAll(async () => {
  await runMigrations(admin, resolve('migrations'));
  await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='assessment_boundary_test_app') THEN CREATE ROLE assessment_boundary_test_app LOGIN PASSWORD 'test-only'; END IF; END $$; GRANT unai_app TO assessment_boundary_test_app");
  await admin.query('INSERT INTO users(id,display_name) VALUES($1,$2)', [actor, 'Boundary owner']);
  await admin.query("INSERT INTO owner_scopes(id,scope_kind,display_name,created_by_user_id) VALUES($1,'PERSONAL','Boundary',$2)", [owner, actor]);
  await admin.query("INSERT INTO owner_scope_members(owner_scope_id,user_id,role) VALUES($1,$2,'OWNER')", [owner, actor]);
  const context = (await admin.query('SELECT id FROM context_spaces WHERE owner_scope_id=$1', [owner])).rows[0].id;
  const instance = randomUUID(), slot = randomUUID();
  propositionId = randomUUID();
  await admin.query("INSERT INTO frame_instances(id,owner_scope_id,frame_type_id,context_space_id) VALUES($1,$2,'shared.obligation',$3)", [instance, owner, context]);
  await admin.query(`INSERT INTO belief_slots(id,owner_scope_id,frame_instance_id,predicate_id,context_space_id,modality)
    VALUES($1,$2,$3,'shared.obligation.principal_amount',$4,'ACTUAL')`, [slot, owner, instance, context]);
  await admin.query(`INSERT INTO propositions(id,owner_scope_id,belief_slot_id,normalized_value) VALUES($1,$2,$3,'{"amount":"50.00","currency":"ILS"}')`,
    [propositionId, owner, slot]);
});
afterAll(async () => { await appPool.end(); await admin.end(); });

const context = (purpose: string): RequestContext => ({ actorId: actor, ownerScopeId: owner, purpose, correlationId: randomUUID() });

/** A model that asserts the belief outright, as a model will. */
function assertingModel(): ModelProvider {
  return {
    providerId: 'anthropic', defaultModelId: 'claude-boundary-test',
    async complete() {
      return { modelId: 'claude-boundary-test', costMicrounits: 900,
        outputText: JSON.stringify({ propositionId, assessmentStatus: 'ACCEPTED' }) };
    },
  };
}

it('CRT-WRT-01-A: model output written into the belief store without a transaction is refused at the boundary', async () => {
  const gateway = createModelGateway({ provider: assertingModel(),
    recordCall: run => withOwnerTransaction(appPool, context(MODEL_PURPOSES.call), run) });
  const output = (await gateway.invoke({ ownerScopeId: owner, purpose: EXTRACTION_PURPOSES.run, correlationId: randomUUID(),
    promptVersion: 'boundary-probe-1', system: 'Assess the proposition.', input: 'ILS 50',
    schema: z.strictObject({ propositionId: z.uuid(), assessmentStatus: z.literal('ACCEPTED') }), maxCostMicrounits: 5000 })).value;
  expect(output).toEqual({ propositionId, assessmentStatus: 'ACCEPTED' });

  // Under the gateway's and the extraction service's own purposes: through the
  // assessment engine, and as raw SQL. The row policy refuses both (42501).
  for (const purpose of [MODEL_PURPOSES.call, EXTRACTION_PURPOSES.run, EXTRACTION_PURPOSES.canonicalize]) {
    await expect(withOwnerTransaction(appPool, context(purpose), tx => recordBeliefAssessment(tx, {
      ownerScopeId: owner, propositionId: output.propositionId, assessmentStatus: output.assessmentStatus, transactionId: randomUUID(),
    })), purpose).rejects.toMatchObject({ code: '42501' });
    await expect(withOwnerTransaction(appPool, context(purpose), tx => tx.query(`INSERT INTO belief_assessments(id,owner_scope_id,
      proposition_id,assessment_status,policy_version,transaction_id) VALUES($1,$2,$3,$4,'model-direct',$5)`,
    [randomUUID(), owner, output.propositionId, output.assessmentStatus, randomUUID()])), purpose).rejects.toMatchObject({ code: '42501' });
  }
  // Under the governor's own purpose, but with no governed transaction behind it:
  // an assessment must name a belief transaction that exists (23503).
  await expect(withOwnerTransaction(appPool, context(BELIEF_PURPOSES.govern), tx => recordBeliefAssessment(tx, {
    ownerScopeId: owner, propositionId: output.propositionId, assessmentStatus: output.assessmentStatus, transactionId: randomUUID(),
  }))).rejects.toMatchObject({ code: '23503' });
  // And not even the privileged principal can record one without a transaction.
  await expect(admin.query(`INSERT INTO belief_assessments(id,owner_scope_id,proposition_id,assessment_status,policy_version,transaction_id)
    VALUES($1,$2,$3,'ACCEPTED','model-direct',$4)`, [randomUUID(), owner, propositionId, randomUUID()])).rejects.toMatchObject({ code: '23503' });

  // Nothing was believed; the call itself was accounted for.
  expect((await admin.query('SELECT count(*)::int AS n FROM belief_assessments WHERE owner_scope_id=$1', [owner])).rows[0].n).toBe(0);
  expect((await admin.query("SELECT count(*)::int AS n FROM model_call_records WHERE owner_scope_id=$1 AND outcome='SUCCEEDED'", [owner])).rows[0].n).toBe(1);
});
