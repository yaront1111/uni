import { z } from 'zod';
import { requireSecret, type SecretsManager } from '@unai/secrets';
import { ModelGatewayError, type ModelProvider, type ModelProviderRequest, type ModelProviderResult } from './gateway.js';

/** Provider adapters, and the configuration that picks one.
 *
 * Every provider-shaped decision is here: the endpoint, the request body, where
 * the response text sits, and how usage becomes cost. The gateway, the extraction
 * service and `@unai/domain` know none of it, so a deployment that changes
 * provider changes `UNAI_MODEL_PROVIDER` and its credential handle and nothing
 * else (CRT-NFR-06-A).
 *
 * A deployment on a provider with no adapter here registers its own with
 * `registerModelProvider` at startup; that is also the seam an adapter for a
 * self-hosted model uses.
 */

/** Price is configuration, never a number this code invents. Both values are
 * millionths of the billing unit per 1000 tokens. */
export interface ModelPricing {
  readonly inputMicrounitsPer1k: number;
  readonly outputMicrounitsPer1k: number;
}
export interface HttpModelProviderConfiguration {
  readonly endpoint: string;
  readonly modelId: string;
  readonly apiKey: string;
  readonly pricing: ModelPricing;
  readonly apiVersion?: string;
  /** Injected for testing the adapter's request and response handling without a
   * network; a deployment uses the runtime's own fetch. */
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

function cost(pricing: ModelPricing, inputTokens: number, outputTokens: number): number {
  return Math.round((inputTokens * pricing.inputMicrounitsPer1k + outputTokens * pricing.outputMicrounitsPer1k) / 1000);
}
/** An endpoint that is not HTTPS is refused: a prompt carries owner content. */
function endpointUrl(endpoint: string): URL {
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new ModelGatewayError('MODEL_ENDPOINT_INVALID'); }
  if (url.protocol !== 'https:') throw new ModelGatewayError('MODEL_ENDPOINT_INSECURE');
  return url;
}
async function postJson(config: HttpModelProviderConfiguration, url: URL, headers: Record<string, string>, body: unknown): Promise<unknown> {
  const call = config.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 60000);
  try {
    const response = await call(url, {
      method: 'POST', signal: controller.signal,
      headers: { ...headers, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });
    // Provider error bodies quote the prompt back; the status never leaves here
    // as anything but a stable code.
    if (!response.ok) throw new ModelGatewayError('MODEL_PROVIDER_REFUSED');
    return await response.json();
  } catch (error) {
    throw error instanceof ModelGatewayError ? error : new ModelGatewayError('MODEL_PROVIDER_UNREACHABLE');
  } finally { clearTimeout(timeout); }
}

const anthropicResponseSchema = z.object({
  model: z.string().min(1).max(128).optional(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })).min(1),
  usage: z.object({ input_tokens: z.number().int().min(0), output_tokens: z.number().int().min(0) }),
});

/** Anthropic Messages API. JSON is requested through the system instruction and
 * verified by the gateway's schema; the adapter asserts nothing about content. */
export function createAnthropicMessagesProvider(config: HttpModelProviderConfiguration): ModelProvider {
  const url = endpointUrl(config.endpoint);
  return {
    providerId: 'anthropic',
    defaultModelId: config.modelId,
    async complete(request: ModelProviderRequest): Promise<ModelProviderResult> {
      const body = await postJson(config, url, {
        'x-api-key': config.apiKey, 'anthropic-version': config.apiVersion ?? '2023-06-01',
      }, {
        model: request.modelId, max_tokens: request.maxOutputTokens, system: request.system,
        messages: [{ role: 'user', content: request.input }],
      });
      const parsed = anthropicResponseSchema.safeParse(body);
      if (!parsed.success) throw new ModelGatewayError('MODEL_PROVIDER_RESPONSE_INVALID');
      return {
        modelId: parsed.data.model ?? request.modelId,
        outputText: parsed.data.content.map(block => block.text ?? '').join(''),
        costMicrounits: cost(config.pricing, parsed.data.usage.input_tokens, parsed.data.usage.output_tokens),
      };
    },
  };
}

const openAiResponseSchema = z.object({
  model: z.string().min(1).max(128).optional(),
  output: z.array(z.object({
    content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
  })).min(1),
  usage: z.object({ input_tokens: z.number().int().min(0), output_tokens: z.number().int().min(0) }),
});

/** OpenAI Responses API. Same contract, different body and different place to
 * find the text — which is the whole of what a provider swap changes. */
export function createOpenAiResponsesProvider(config: HttpModelProviderConfiguration): ModelProvider {
  const url = endpointUrl(config.endpoint);
  return {
    providerId: 'openai',
    defaultModelId: config.modelId,
    async complete(request: ModelProviderRequest): Promise<ModelProviderResult> {
      const body = await postJson(config, url, { authorization: 'Bearer ' + config.apiKey }, {
        model: request.modelId, max_output_tokens: request.maxOutputTokens,
        instructions: request.system, input: request.input,
      });
      const parsed = openAiResponseSchema.safeParse(body);
      if (!parsed.success) throw new ModelGatewayError('MODEL_PROVIDER_RESPONSE_INVALID');
      return {
        modelId: parsed.data.model ?? request.modelId,
        outputText: parsed.data.output.flatMap(item => item.content ?? []).map(block => block.text ?? '').join(''),
        costMicrounits: cost(config.pricing, parsed.data.usage.input_tokens, parsed.data.usage.output_tokens),
      };
    },
  };
}

export type ModelProviderFactory = (config: HttpModelProviderConfiguration) => ModelProvider;
const factories = new Map<string, ModelProviderFactory>([
  ['anthropic', createAnthropicMessagesProvider],
  ['openai', createOpenAiResponsesProvider],
]);

/** Adds a provider a deployment brings itself. Registering never replaces a
 * delivered adapter: an id that already exists is refused rather than shadowed. */
export function registerModelProvider(providerId: string, factory: ModelProviderFactory): void {
  if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(providerId)) throw new ModelGatewayError('MODEL_PROVIDER_ID_INVALID');
  if (factories.has(providerId)) throw new ModelGatewayError('MODEL_PROVIDER_ALREADY_REGISTERED');
  factories.set(providerId, factory);
}
export function modelProviderIds(): readonly string[] { return Object.freeze([...factories.keys()]); }

function requiredNumber(env: Readonly<Record<string, string | undefined>>, name: string): number {
  const raw = env[name];
  const value = raw === undefined ? Number.NaN : Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new ModelGatewayError('MODEL_CONFIG_REQUIRED');
  return value;
}

/** Builds the configured provider. The credential arrives as a `secret://`
 * handle (ADR 0013): a literal key in the environment is refused, not used. */
export async function resolveConfiguredModelProvider(options: {
  secrets: SecretsManager;
  env?: Readonly<Record<string, string | undefined>>;
  fetch?: typeof globalThis.fetch;
}): Promise<ModelProvider> {
  const env = options.env ?? process.env;
  const providerId = env.UNAI_MODEL_PROVIDER;
  if (!providerId) throw new ModelGatewayError('MODEL_CONFIG_REQUIRED');
  const factory = factories.get(providerId);
  if (!factory) throw new ModelGatewayError('MODEL_PROVIDER_UNKNOWN');
  const endpoint = env.UNAI_MODEL_ENDPOINT, modelId = env.UNAI_MODEL_ID;
  if (!endpoint || !modelId) throw new ModelGatewayError('MODEL_CONFIG_REQUIRED');
  const apiKey = await requireSecret(options.secrets, 'UNAI_MODEL_API_KEY', env);
  return factory({
    endpoint, modelId, apiKey,
    pricing: {
      inputMicrounitsPer1k: requiredNumber(env, 'UNAI_MODEL_INPUT_MICROUNITS_PER_1K'),
      outputMicrounitsPer1k: requiredNumber(env, 'UNAI_MODEL_OUTPUT_MICROUNITS_PER_1K'),
    },
    ...(env.UNAI_MODEL_API_VERSION ? { apiVersion: env.UNAI_MODEL_API_VERSION } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}
