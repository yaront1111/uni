import { expect, it } from 'vitest';
import { createAnthropicMessagesProvider, createOpenAiResponsesProvider } from './providers.js';

const pricing = { inputMicrounitsPer1k: 2000, outputMicrounitsPer1k: 10000 };
const request = { promptVersion: 'p', system: 's', input: 'i', maxOutputTokens: 4096 };
const response = {
  content: [{ type: 'text', text: '{"ok":true}' }],
  usage: { input_tokens: 1000, output_tokens: 200 },
};

function captureFetch(body: unknown) {
  const calls: string[] = [];
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    calls.push(String(init?.body));
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return { calls, fetch };
}

it('sends explicit thinking and effort for the requested pinned model, not the configured default', async () => {
  const { calls, fetch } = captureFetch(response);
  const provider = createAnthropicMessagesProvider({
    endpoint: 'https://api.anthropic.test/v1/messages', modelId: 'claude-test-1',
    apiKey: 'placeholder-key', pricing, fetch,
  });
  await provider.complete({ ...request, modelId: 'claude-sonnet-5-5' });
  expect(calls).toHaveLength(1);
  expect(JSON.parse(calls[0]!)).toEqual({
    model: 'claude-sonnet-5-5', max_tokens: 4096, system: 's', messages: [{ role: 'user', content: 'i' }],
    thinking: { type: 'between_tools' }, output_config: { effort: 'high' },
  });
  expect(calls[0]).not.toMatch(/budget_tokens|disabled|display|temperature|top_p|top_k|fallbacks/);
});

it('leaves an unlisted requested model at its defaults even when the configured model is pinned', async () => {
  const { calls, fetch } = captureFetch(response);
  const provider = createAnthropicMessagesProvider({
    endpoint: 'https://api.anthropic.test/v1/messages', modelId: 'claude-sonnet-5-5',
    apiKey: 'placeholder-key', pricing, fetch,
  });
  await provider.complete({ ...request, modelId: 'claude-test-1' });
  expect(JSON.parse(calls[0]!)).toEqual({
    model: 'claude-test-1', max_tokens: 4096, system: 's', messages: [{ role: 'user', content: 'i' }],
  });
});

it('ignores thinking blocks in output text while accounting for all billed tokens', async () => {
  const { fetch } = captureFetch({
    ...response, content: [{ type: 'thinking', thinking: '', signature: 'sig' }, ...response.content],
  });
  const provider = createAnthropicMessagesProvider({
    endpoint: 'https://api.anthropic.test/v1/messages', modelId: 'claude-sonnet-5-5',
    apiKey: 'placeholder-key', pricing, fetch,
  });
  expect(await provider.complete({ ...request, modelId: 'claude-sonnet-5-5' })).toEqual({
    modelId: 'claude-sonnet-5-5', outputText: '{"ok":true}', costMicrounits: 4000,
  });
});

it('preserves the OpenAI request body', async () => {
  const { calls, fetch } = captureFetch({
    output: [{ content: [{ type: 'output_text', text: '{"ok":true}' }] }], usage: response.usage,
  });
  const provider = createOpenAiResponsesProvider({
    endpoint: 'https://api.openai.test/v1/responses', modelId: 'gpt-test-1',
    apiKey: 'placeholder-key', pricing, fetch,
  });
  await provider.complete({ ...request, modelId: 'gpt-test-1' });
  expect(JSON.parse(calls[0]!)).toEqual({ model: 'gpt-test-1', max_output_tokens: 4096, instructions: 's', input: 'i' });
});
