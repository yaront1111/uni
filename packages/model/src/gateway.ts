import type { ZodType } from 'zod';
import { modelCallRecordSchema, type ModelCallRecord } from '@unai/domain';
import { uuidV7 } from '../../../src/kernel/identities.js';

/** The provider-independent LLM gateway (PRD §36.3, design component
 * "llm-gateway-provider-independent-schema-validated-and-cost-recorded").
 *
 * Everything a provider differs in lives behind `ModelProvider`. Everything the
 * system needs from a model call — that the output satisfies its schema, what it
 * cost, how long it took, and which request it belonged to — lives here and is
 * identical for every provider. Swapping the configured provider is therefore an
 * environment change plus an adapter in this package, and touches no domain file
 * and no caller (CRT-NFR-06-A).
 *
 * The gateway never accepts output it has not validated, and never returns half
 * of a response that violated its contract: a schema-invalid response is rejected
 * whole (ADR 0016 §6).
 */

export class ModelGatewayError extends Error {
  constructor(code: string) { super(code); this.name = 'ModelGatewayError'; }
}

export interface ModelProviderRequest {
  readonly modelId: string;
  readonly promptVersion: string;
  /** Instructions. Owner content never belongs here: it is untrusted data. */
  readonly system: string;
  /** The untrusted source material the model reads, already bounded by triage. */
  readonly input: string;
  readonly maxOutputTokens: number;
}
export interface ModelProviderResult {
  /** What the provider actually served, which may differ from what was asked. */
  readonly modelId: string;
  readonly outputText: string;
  /** Millionths of the billing unit, from the provider's own usage accounting. */
  readonly costMicrounits: number;
}
/** The whole provider contract. An adapter implements exactly this. */
export interface ModelProvider {
  readonly providerId: string;
  readonly defaultModelId: string;
  complete(request: ModelProviderRequest): Promise<ModelProviderResult>;
}

/** The narrow database capability the gateway asks for, as `@unai/memory` does. */
export interface ModelTransaction {
  query(sql: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
}
/** Opens the gateway's own transaction, under `model.call` and nothing wider.
 * It is separate from the caller's transaction on purpose: a call that failed or
 * was rejected still spent money, and that record must survive the rollback of
 * the work it was serving. */
export type ModelCallRecorder = <T>(run: (tx: ModelTransaction) => Promise<T>) => Promise<T>;

export const MODEL_PURPOSES = Object.freeze({ call: 'model.call' } as const);

export interface ModelInvocation<T> {
  readonly value: T;
  readonly record: ModelCallRecord;
}

export interface ModelInvocationRequest<T> {
  readonly ownerScopeId: string;
  /** The product purpose the call serves; recorded, never widened. */
  readonly purpose: string;
  readonly correlationId: string;
  readonly promptVersion: string;
  readonly system: string;
  readonly input: string;
  /** The contract the response must satisfy before it is anything but text. */
  readonly schema: ZodType<T>;
  readonly maxOutputTokens?: number;
  /** Upper bound on what this call may cost, from the triage decision's budget. */
  readonly maxCostMicrounits: number;
  readonly modelId?: string;
  readonly extractionRunId?: string | null;
}

export interface ModelGateway {
  readonly providerId: string;
  readonly modelId: string;
  invoke<T>(request: ModelInvocationRequest<T>): Promise<ModelInvocation<T>>;
}

export function createModelGateway(options: {
  provider: ModelProvider;
  recordCall: ModelCallRecorder;
  /** Injected so latency is measured, never guessed. */
  clock?: () => number;
}): ModelGateway {
  const clock = options.clock ?? (() => Date.now());
  const provider = options.provider;

  async function record(input: {
    ownerScopeId: string; purpose: string; modelId: string; promptVersion: string;
    costMicrounits: number; latencyMs: number; correlationId: string;
    outcome: ModelCallRecord['outcome']; extractionRunId: string | null;
  }): Promise<ModelCallRecord> {
    const id = uuidV7();
    const parsed = modelCallRecordSchema.parse({
      modelCallRecordId: id, purpose: input.purpose, modelProvider: provider.providerId,
      modelId: input.modelId, promptVersion: input.promptVersion,
      costMicrounits: Math.max(0, Math.round(input.costMicrounits)),
      latencyMs: Math.max(0, Math.round(input.latencyMs)),
      correlationId: input.correlationId, outcome: input.outcome,
      createdAt: new Date().toISOString(),
    });
    await options.recordCall(async tx => tx.query(
      `INSERT INTO model_call_records(id,owner_scope_id,purpose,model_provider,model_id,prompt_version,
        extraction_run_id,cost_microunits,latency_ms,correlation_id,outcome)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, input.ownerScopeId, parsed.purpose, parsed.modelProvider, parsed.modelId, parsed.promptVersion,
        input.extractionRunId, parsed.costMicrounits, parsed.latencyMs, parsed.correlationId, parsed.outcome]));
    return parsed;
  }

  return {
    providerId: provider.providerId,
    modelId: provider.defaultModelId,
    async invoke<T>(request: ModelInvocationRequest<T>): Promise<ModelInvocation<T>> {
      if (!(request.maxCostMicrounits > 0)) throw new ModelGatewayError('MODEL_COST_BUDGET_REQUIRED');
      const modelId = request.modelId ?? provider.defaultModelId;
      const extractionRunId = request.extractionRunId ?? null;
      const started = clock();
      let result: ModelProviderResult;
      try {
        result = await provider.complete({
          modelId, promptVersion: request.promptVersion, system: request.system,
          input: request.input, maxOutputTokens: request.maxOutputTokens ?? 2048,
        });
      } catch {
        // A provider message can carry prompt content back out; only a stable
        // code is kept, and the attempt is still accounted for.
        await record({ ownerScopeId: request.ownerScopeId, purpose: request.purpose, modelId,
          promptVersion: request.promptVersion, costMicrounits: 0, latencyMs: clock() - started,
          correlationId: request.correlationId, outcome: 'PROVIDER_FAILED', extractionRunId });
        throw new ModelGatewayError('MODEL_PROVIDER_FAILED');
      }
      const latencyMs = clock() - started;
      const served = result.modelId || modelId;

      let parsed: unknown;
      try { parsed = JSON.parse(result.outputText); }
      catch { parsed = undefined; }
      const validated = parsed === undefined ? null : request.schema.safeParse(parsed);
      if (validated === null || !validated.success) {
        // Rejected, not stored: schema-invalid output never becomes claims.
        await record({ ownerScopeId: request.ownerScopeId, purpose: request.purpose, modelId: served,
          promptVersion: request.promptVersion, costMicrounits: result.costMicrounits, latencyMs,
          correlationId: request.correlationId, outcome: 'OUTPUT_REJECTED', extractionRunId });
        throw new ModelGatewayError('MODEL_OUTPUT_INVALID');
      }
      const call = await record({ ownerScopeId: request.ownerScopeId, purpose: request.purpose, modelId: served,
        promptVersion: request.promptVersion, costMicrounits: result.costMicrounits, latencyMs,
        correlationId: request.correlationId, outcome: 'SUCCEEDED', extractionRunId });
      // The overspend is recorded before it is refused: the budget bounds what may
      // be built on the answer, not whether the money was spent.
      if (call.costMicrounits > request.maxCostMicrounits) throw new ModelGatewayError('MODEL_COST_BUDGET_EXCEEDED');
      return { value: validated.data, record: call };
    },
  };
}
