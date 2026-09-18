/** `@unai/model` — the provider-independent LLM gateway.
 *
 * One entry point for every model call the system makes: it validates the
 * response against the caller's schema before returning it, records model,
 * prompt version, cost, latency and correlation id for the call whether it
 * succeeded, was rejected or failed, and enforces the caller's cost budget.
 *
 * It holds no prompt library, no extraction logic and no database credential of
 * its own: the caller supplies the transaction the accounting row is written in,
 * under `model.call` and nothing wider.
 */
export { createModelGateway, ModelGatewayError, MODEL_PURPOSES,
  type ModelProvider, type ModelProviderRequest, type ModelProviderResult,
  type ModelGateway, type ModelInvocation, type ModelInvocationRequest,
  type ModelCallRecorder, type ModelTransaction } from './gateway.js';
export { createAnthropicMessagesProvider, createOpenAiResponsesProvider, registerModelProvider,
  modelProviderIds, resolveConfiguredModelProvider,
  type ModelPricing, type ModelProviderFactory, type HttpModelProviderConfiguration } from './providers.js';
