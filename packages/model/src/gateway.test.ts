import { Pool } from 'pg';
import { z } from 'zod';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { runMigrations, withOwnerTransaction } from '@unai/postgres';
import { extractionOutputSchema, type RequestContext } from '@unai/domain';
import { createModelGateway, ModelGatewayError, MODEL_PURPOSES, type ModelProvider } from './gateway.js';
import { createAnthropicMessagesProvider, createOpenAiResponsesProvider, resolveConfiguredModelProvider,
  modelProviderIds, registerModelProvider } from './providers.js';

/** The gateway over real PostgreSQL, through the real owner boundary.
 *
 * What these tests are about: that a model call is accounted for whatever
 * happens to it, that output which violates its schema is rejected instead of
 * returned, and that changing the configured provider changes configuration and
 * an adapter — and nothing in the domain package (CRT-NFR-06-A).
 */

if (!process.env.UNAI_TEST_DATABASE_URL) throw new Error('Run pnpm test for the required PostgreSQL harness');
const admin = new Pool({ connectionString: process.env.UNAI_TEST_DATABASE_URL });
const appUrl = new URL(process.env.UNAI_TEST_DATABASE_URL); appUrl.username = 'model_test_app'; appUrl.password = 'test-only';
const appPool = new Pool({ connectionString: appUrl.href });
const owner = randomUUID(), actor = randomUUID();

beforeAll(async () => {
  await runMigrations(admin, resolve('migrations'));
  await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='model_test_app') THEN CREATE ROLE model_test_app LOGIN PASSWORD 'test-only'; END IF; END $$; GRANT unai_app TO model_test_app");
  await admin.query('INSERT INTO users(id,display_name) VALUES($1,$2)', [actor, 'Model owner']);
  await admin.query("INSERT INTO owner_scopes(id,scope_kind,display_name,created_by_user_id) VALUES($1,'PERSONAL','Model',$2)", [owner, actor]);
  await admin.query("INSERT INTO owner_scope_members(owner_scope_id,user_id,role) VALUES($1,$2,'OWNER')", [owner, actor]);
});
afterAll(async () => { await appPool.end(); await admin.end(); });

function context(purpose: string, correlationId: string): RequestContext {
  return { actorId: actor, ownerScopeId: owner, purpose, correlationId };
}
/** The gateway's accounting transaction, opened under `model.call` only. */
function recorder(correlationId: string) {
  return <T,>(run: (tx: { query(sql: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }> }) => Promise<T>) =>
    withOwnerTransaction(appPool, context(MODEL_PURPOSES.call, correlationId), run);
}
/** A provider double. Real adapters talk to a network this suite has none of;
 * what is under test here is the gateway's behaviour, which is identical for
 * every provider by construction. */
function provider(providerId: string, modelId: string, answer: () => { outputText: string; costMicrounits?: number }): ModelProvider {
  return {
    providerId, defaultModelId: modelId,
    async complete() {
      const served = answer();
      return { modelId, outputText: served.outputText, costMicrounits: served.costMicrounits ?? 1200 };
    },
  };
}
async function callRecords(correlationId: string) {
  return (await admin.query('SELECT * FROM model_call_records WHERE owner_scope_id=$1 AND correlation_id=$2 ORDER BY created_at,id',
    [owner, correlationId])).rows;
}
const validOutput = JSON.stringify({
  claims: [{
    frameTypeId: 'shared.commitment', statement: 'Dana will pay the deposit by Friday',
    span: { anchorKind: 'MESSAGE_SPAN', parentAnchor: { messageExternalId: 'msg-1', field: 'body' }, start: 0, end: 7, quote: 'Booked:' },
    extractionConfidence: 0.8, temporalExpression: 'Friday', participants: ['dana@example.test'],
  }],
  unknowns: [],
});

it('CRT-NFR-06-A: every model call records model, prompt version, cost, latency and correlation id', async () => {
  const correlationId = randomUUID();
  let ticks = 0;
  const gateway = createModelGateway({
    provider: provider('anthropic', 'claude-test-1', () => ({ outputText: validOutput, costMicrounits: 4321 })),
    recordCall: recorder(correlationId),
    clock: () => (ticks += 17),
  });
  const invocation = await gateway.invoke({
    ownerScopeId: owner, purpose: 'memory.canonicalize', correlationId, promptVersion: 'surface-frames-0.1.0',
    system: 'extract', input: '{}', schema: extractionOutputSchema, maxCostMicrounits: 20000,
  });
  expect(invocation.value.claims).toHaveLength(1);
  const [record] = await callRecords(correlationId);
  expect(record).toMatchObject({
    owner_scope_id: owner, purpose: 'memory.canonicalize', model_provider: 'anthropic',
    model_id: 'claude-test-1', prompt_version: 'surface-frames-0.1.0', correlation_id: correlationId,
    outcome: 'SUCCEEDED', latency_ms: 17,
  });
  expect(Number(record!.cost_microunits)).toBe(4321);
  // The row carries accounting and nothing else: no prompt, no response, no key.
  expect(Object.keys(record!).sort()).toEqual(['correlation_id', 'cost_microunits', 'created_at', 'extraction_run_id',
    'id', 'latency_ms', 'model_id', 'model_provider', 'outcome', 'owner_scope_id', 'prompt_version', 'purpose'].sort());
});

it('CRT-NFR-06-A: schema-invalid output is rejected rather than returned, and the call is still accounted for', async () => {
  for (const [label, outputText] of [
    ['a claim missing its span', JSON.stringify({ claims: [{ frameTypeId: 'shared.commitment', statement: 'x', extractionConfidence: 0.5 }] })],
    ['an unknown key', JSON.stringify({ claims: [], unknowns: [], invented: true })],
    ['a confidence outside its range', JSON.stringify({ claims: [{ ...JSON.parse(validOutput).claims[0], extractionConfidence: 4 }] })],
    ['prose instead of JSON', 'Certainly! Here is the extraction you asked for.'],
  ] as const) {
    const correlationId = randomUUID();
    const gateway = createModelGateway({
      provider: provider('anthropic', 'claude-test-1', () => ({ outputText, costMicrounits: 900 })),
      recordCall: recorder(correlationId),
    });
    await expect(gateway.invoke({
      ownerScopeId: owner, purpose: 'memory.canonicalize', correlationId, promptVersion: 'surface-frames-0.1.0',
      system: 'extract', input: '{}', schema: extractionOutputSchema, maxCostMicrounits: 20000,
    }), label).rejects.toThrow('MODEL_OUTPUT_INVALID');
    const [record] = await callRecords(correlationId);
    // Rejected, and the money it cost is still on the books.
    expect(record!.outcome, label).toBe('OUTPUT_REJECTED');
    expect(Number(record!.cost_microunits), label).toBe(900);
  }
});

it('CRT-EVD-05-A: a forced gateway failure is recorded and surfaces one stable code', async () => {
  const correlationId = randomUUID();
  const gateway = createModelGateway({
    provider: {
      providerId: 'anthropic', defaultModelId: 'claude-test-1',
      async complete() { throw new Error('provider said: rate limited for account acct_9f21 with prompt "Booked: the tiling crew"'); },
    },
    recordCall: recorder(correlationId),
  });
  const failure = await gateway.invoke({
    ownerScopeId: owner, purpose: 'memory.canonicalize', correlationId, promptVersion: 'surface-frames-0.1.0',
    system: 'extract', input: '{}', schema: extractionOutputSchema, maxCostMicrounits: 20000,
  }).catch((error: Error) => error);
  expect(failure).toBeInstanceOf(ModelGatewayError);
  // The provider's message could carry the prompt and an account id back out.
  expect((failure as Error).message).toBe('MODEL_PROVIDER_FAILED');
  const [record] = await callRecords(correlationId);
  expect(record!.outcome).toBe('PROVIDER_FAILED');
  expect(Number(record!.cost_microunits)).toBe(0);
});

it('refuses a call that exceeds its cost budget, after recording what it spent', async () => {
  const correlationId = randomUUID();
  const gateway = createModelGateway({
    provider: provider('anthropic', 'claude-test-1', () => ({ outputText: validOutput, costMicrounits: 50000 })),
    recordCall: recorder(correlationId),
  });
  await expect(gateway.invoke({
    ownerScopeId: owner, purpose: 'memory.canonicalize', correlationId, promptVersion: 'surface-frames-0.1.0',
    system: 'extract', input: '{}', schema: extractionOutputSchema, maxCostMicrounits: 4000,
  })).rejects.toThrow('MODEL_COST_BUDGET_EXCEEDED');
  expect(Number((await callRecords(correlationId))[0]!.cost_microunits)).toBe(50000);
  // A call with no budget at all is refused before the provider is reached.
  const unbudgeted = randomUUID();
  await expect(createModelGateway({ provider: provider('anthropic', 'claude-test-1', () => ({ outputText: validOutput })), recordCall: recorder(unbudgeted) })
    .invoke({ ownerScopeId: owner, purpose: 'memory.canonicalize', correlationId: unbudgeted, promptVersion: 'surface-frames-0.1.0',
      system: 'extract', input: '{}', schema: extractionOutputSchema, maxCostMicrounits: 0 })).rejects.toThrow('MODEL_COST_BUDGET_REQUIRED');
  expect(await callRecords(unbudgeted)).toEqual([]);
});

it('CRT-NFR-06-A: swapping the configured provider changes no caller and no domain file', async () => {
  // The same caller, the same schema, the same request: only configuration moves.
  const schema = z.strictObject({ claims: z.array(z.strictObject({ frameTypeId: z.string() })).max(4) });
  const answers = { anthropic: '{"claims":[{"frameTypeId":"shared.commitment"}]}', openai: '{"claims":[{"frameTypeId":"shared.obligation"}]}' };
  const seen: Array<{ provider: string; model: string; frameTypeId: string }> = [];
  for (const [providerId, modelId] of [['anthropic', 'claude-test-1'], ['openai', 'gpt-test-1']] as const) {
    const correlationId = randomUUID();
    const gateway = createModelGateway({
      provider: provider(providerId, modelId, () => ({ outputText: answers[providerId] })),
      recordCall: recorder(correlationId),
    });
    const result = await gateway.invoke({
      ownerScopeId: owner, purpose: 'memory.canonicalize', correlationId, promptVersion: 'surface-frames-0.1.0',
      system: 'extract', input: '{}', schema, maxCostMicrounits: 20000,
    });
    const [record] = await callRecords(correlationId);
    seen.push({ provider: record!.model_provider as string, model: record!.model_id as string, frameTypeId: result.value.claims[0]!.frameTypeId });
  }
  expect(seen).toEqual([
    { provider: 'anthropic', model: 'claude-test-1', frameTypeId: 'shared.commitment' },
    { provider: 'openai', model: 'gpt-test-1', frameTypeId: 'shared.obligation' },
  ]);

  // And the structural half of the same claim: no file in the domain package
  // names a provider, a model or a provider SDK, so no provider swap can reach
  // one. The gateway and its adapters are the only place any of that lives.
  const forbidden = /\b(anthropic|openai|claude|gpt-4|gpt-5|azure|bedrock|vertex|ollama|x-api-key)\b/i;
  const directory = resolve('packages/domain/src');
  let inspected = 0;
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    inspected += 1;
    const source = await readFile(resolve(entry.parentPath, entry.name), 'utf8');
    expect(forbidden.test(source), entry.name + ' must not name a model provider').toBe(false);
  }
  expect(inspected).toBeGreaterThan(5);
});

it('builds each delivered adapter from configuration and refuses an insecure endpoint or a literal key', async () => {
  expect(modelProviderIds()).toEqual(expect.arrayContaining(['anthropic', 'openai']));
  const calls: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
  const respond = (body: unknown): typeof globalThis.fetch => (async (url: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init!.body)), headers: init!.headers as Record<string, string> });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  const pricing = { inputMicrounitsPer1k: 3000, outputMicrounitsPer1k: 15000 };

  const anthropic = createAnthropicMessagesProvider({
    endpoint: 'https://api.anthropic.test/v1/messages', modelId: 'claude-test-1', apiKey: 'resolved-key', pricing,
    fetch: respond({ model: 'claude-test-1', content: [{ type: 'text', text: '{"ok":true}' }], usage: { input_tokens: 1000, output_tokens: 200 } }),
  });
  const fromAnthropic = await anthropic.complete({ modelId: 'claude-test-1', promptVersion: 'p', system: 's', input: 'i', maxOutputTokens: 512 });
  expect(fromAnthropic.outputText).toBe('{"ok":true}');
  expect(fromAnthropic.costMicrounits).toBe(6000);
  expect(calls[0]!.headers['x-api-key']).toBe('resolved-key');
  expect(calls[0]!.body).toMatchObject({ model: 'claude-test-1', max_tokens: 512, system: 's' });

  const openai = createOpenAiResponsesProvider({
    endpoint: 'https://api.openai.test/v1/responses', modelId: 'gpt-test-1', apiKey: 'resolved-key', pricing,
    fetch: respond({ model: 'gpt-test-1', output: [{ content: [{ type: 'output_text', text: '{"ok":true}' }] }], usage: { input_tokens: 1000, output_tokens: 200 } }),
  });
  const fromOpenAi = await openai.complete({ modelId: 'gpt-test-1', promptVersion: 'p', system: 's', input: 'i', maxOutputTokens: 512 });
  expect(fromOpenAi).toMatchObject({ outputText: '{"ok":true}', costMicrounits: 6000 });
  expect(calls[1]!.headers.authorization).toBe('Bearer resolved-key');

  // A prompt carries owner content, so a plaintext endpoint is refused outright.
  expect(() => createAnthropicMessagesProvider({ endpoint: 'http://api.anthropic.test/v1/messages', modelId: 'm', apiKey: 'k', pricing }))
    .toThrow('MODEL_ENDPOINT_INSECURE');
  // A provider error body can quote the prompt back; only a code escapes.
  const refusing = createOpenAiResponsesProvider({ endpoint: 'https://api.openai.test/v1/responses', modelId: 'm', apiKey: 'k', pricing,
    fetch: (async () => new Response('{"error":{"message":"rate limit for acct_9f21"}}', { status: 429 })) as typeof globalThis.fetch });
  await expect(refusing.complete({ modelId: 'm', promptVersion: 'p', system: 's', input: 'i', maxOutputTokens: 8 }))
    .rejects.toThrow('MODEL_PROVIDER_REFUSED');

  // Configuration selects the provider; a literal credential is refused (ADR 0013).
  const secrets = { async resolve(handle: string) { return handle === 'secret://mounted/model-key' ? 'resolved-key' : Promise.reject(new Error('SECRET_UNAVAILABLE')); } };
  const env = {
    UNAI_MODEL_PROVIDER: 'openai', UNAI_MODEL_ENDPOINT: 'https://api.openai.test/v1/responses', UNAI_MODEL_ID: 'gpt-test-1',
    UNAI_MODEL_API_KEY: 'secret://mounted/model-key',
    UNAI_MODEL_INPUT_MICROUNITS_PER_1K: '3000', UNAI_MODEL_OUTPUT_MICROUNITS_PER_1K: '15000',
  };
  expect((await resolveConfiguredModelProvider({ secrets, env })).providerId).toBe('openai');
  expect((await resolveConfiguredModelProvider({ secrets, env: { ...env, UNAI_MODEL_PROVIDER: 'anthropic', UNAI_MODEL_ENDPOINT: 'https://api.anthropic.test/v1/messages' } })).providerId)
    .toBe('anthropic');
  await expect(resolveConfiguredModelProvider({ secrets, env: { ...env, UNAI_MODEL_API_KEY: 'sk-live-literal-key' } }))
    .rejects.toThrow('SECRET_HANDLE_REQUIRED:UNAI_MODEL_API_KEY');
  await expect(resolveConfiguredModelProvider({ secrets, env: { ...env, UNAI_MODEL_PROVIDER: 'not-delivered' } })).rejects.toThrow('MODEL_PROVIDER_UNKNOWN');

  // A deployment may add its own adapter; it may never shadow a delivered one.
  registerModelProvider('deployment-local', config => createOpenAiResponsesProvider(config));
  expect(modelProviderIds()).toContain('deployment-local');
  expect(() => registerModelProvider('anthropic', config => createOpenAiResponsesProvider(config))).toThrow('MODEL_PROVIDER_ALREADY_REGISTERED');
});

it('writes accounting only under the model.call purpose and only for its own owner', async () => {
  const correlationId = randomUUID();
  const gateway = createModelGateway({
    provider: provider('anthropic', 'claude-test-1', () => ({ outputText: validOutput })),
    // A recorder that opens the transaction under a product purpose instead.
    recordCall: run => withOwnerTransaction(appPool, context('memory.canonicalize', correlationId), run),
  });
  await expect(gateway.invoke({
    ownerScopeId: owner, purpose: 'memory.canonicalize', correlationId, promptVersion: 'surface-frames-0.1.0',
    system: 'extract', input: '{}', schema: extractionOutputSchema, maxCostMicrounits: 20000,
  })).rejects.toMatchObject({ code: '42501' });
  expect(await callRecords(correlationId)).toEqual([]);
});
