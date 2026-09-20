import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { OwnerTransaction } from '@unai/postgres';
import {
  PROJECTION_NAMES, createDraftSchema, createRecommendationSchema, DRAFT_CAPABILITY,
  deletionPreviewRequestSchema, deletionReceiptSchema, deletionRequestSchema, domainSensitivityUpdateSchema,
  draftDecisionSchema, executeActionSchema, exportRequestSchema, observedActionSchema, regenerateEmbeddingsSchema,
  regenerationReceiptSchema, respondRecommendationSchema, retentionCleanupSchema, retentionUpdateSchema,
  sensitivitySchema, setPluginCapabilitiesSchema, toolReceiptSchema, type DeletionReceipt, type ConversationDeletion,
} from '@unai/domain';
import type { PolicyPorts } from '@unai/belief';
import { CONTEXT_READ_PURPOSE } from '@unai/context';
import { PROJECTION_PURPOSE, REDUCER_VERSION, replayProjection } from '@unai/capabilities';
import { CONNECTOR_READ_PURPOSE, listConnectors } from '@unai/connectors';
import { EMBEDDING_MODEL, EMBEDDING_VERSION } from '@unai/memory';
import {
  ACTION_DRAFT_PURPOSE, ACTION_EXECUTE_PURPOSE, ACTION_POLICY_PURPOSE, ACTION_READ_PURPOSE, ACTION_RECEIPT_PURPOSE,
  ACTION_RECOMMEND_PURPOSE, ControlError, DATA_DELETE_PURPOSE, DATA_EXPORT_PURPOSE, MEMORY_GOVERN_PURPOSE,
  MEMORY_REINDEX_PURPOSE, PERMISSIONS_MANAGE_PURPOSE, PERMISSIONS_READ_PURPOSE,
  buildExportBundle, cascadeCounts, decideDraft, dropSemanticIndex, eraseEvidence, evaluateActionBasis,
  evaluateExternalAction, expireDerivedData, insertDraft, insertRecommendation, listActionHistory, listDataRequests,
  listDrafts, listExpiredEvidence, listPluginCapabilities, listRecommendations, permissionsView,
  pluginCapabilityGranted, readDomainSensitivity, readRecommendation, readRetention,
  recordDataRequest, recordObservedAction, recordReceiptEntry, regenerateSemanticIndex, respondToRecommendation,
  setPluginCapabilities, updateDomainSensitivity, updateRetention, ConversationService,
  type ErasedEvidence,
} from '@unai/control';
import { ATTENTION_SETTINGS_PURPOSE, readAttentionBudget } from '@unai/review';
import { ingestOwnerStatement, ingestToolReceipt, type EvidenceObjects } from './evidence.js';

/**
 * Governed action and the data-control surface (ADR 0030; design routes
 * `GET /v1/permissions`, `PATCH /v1/settings/*`, `POST /v1/drafts`,
 * `POST /v1/actions/execute`, `GET /v1/action-history`, `POST /v1/export` and the
 * deletion workflow).
 *
 * Each route runs under its own purpose, and where a step needs another
 * authority -- the Context Broker's `memory.read`, the port's `memory.act`,
 * evidence ingest, the projection reducer -- the purpose is chosen here, by
 * server code, and never by a header. Refusals are audited in their own
 * transaction, because the work they refused has been rolled back.
 */

export {
  ACTION_DRAFT_PURPOSE, ACTION_EXECUTE_PURPOSE, ACTION_READ_PURPOSE, ACTION_RECEIPT_PURPOSE, ACTION_RECOMMEND_PURPOSE,
  DATA_DELETE_PURPOSE, DATA_EXPORT_PURPOSE, MEMORY_REINDEX_PURPOSE, PERMISSIONS_MANAGE_PURPOSE, PERMISSIONS_READ_PURPOSE,
};

type Work = (request: FastifyRequest, run: (tx: OwnerTransaction, sessionId: string) => Promise<unknown>,
  purpose?: string) => Promise<unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The route-to-purpose map `createPlatformApi` enforces for this module. */
export function controlPurposeFor(method: string, url: string | undefined): string | null {
  switch (url) {
    case '/v1/permissions': return PERMISSIONS_READ_PURPOSE;
    case '/v1/plugin-capabilities':
    case '/v1/settings/retention':
    case '/v1/settings/domain-sensitivity': return PERMISSIONS_MANAGE_PURPOSE;
    case '/v1/drafts': return method === 'GET' ? ACTION_READ_PURPOSE : ACTION_DRAFT_PURPOSE;
    case '/v1/drafts/:id/decision': return ACTION_DRAFT_PURPOSE;
    case '/v1/actions/execute': return ACTION_EXECUTE_PURPOSE;
    case '/v1/action-history': return ACTION_READ_PURPOSE;
    case '/v1/recommendations': return method === 'GET' ? ACTION_READ_PURPOSE : ACTION_RECOMMEND_PURPOSE;
    case '/v1/recommendations/:id': return ACTION_READ_PURPOSE;
    case '/v1/recommendations/:id/respond': return ACTION_RECOMMEND_PURPOSE;
    case '/v1/actions/receipts':
    case '/v1/action-history/observations': return ACTION_RECEIPT_PURPOSE;
    case '/v1/export': return DATA_EXPORT_PURPOSE;
    case '/v1/data/deletions':
    case '/v1/data/deletions/preview':
    case '/v1/data/retention/cleanup': return DATA_DELETE_PURPOSE;
    case '/v1/memory/embeddings/regenerate': return MEMORY_REINDEX_PURPOSE;
    default: return null;
  }
}
export const CONTROL_PURPOSES: readonly string[] = Object.freeze([PERMISSIONS_READ_PURPOSE, PERMISSIONS_MANAGE_PURPOSE,
  ACTION_READ_PURPOSE, ACTION_DRAFT_PURPOSE, ACTION_EXECUTE_PURPOSE, ACTION_RECOMMEND_PURPOSE, ACTION_RECEIPT_PURPOSE,
  DATA_EXPORT_PURPOSE, DATA_DELETE_PURPOSE, MEMORY_REINDEX_PURPOSE]);

const REFUSAL_STATUS = new Map<string, number>([
  ['CONVERSATION_NOT_FOUND', 404], ['CONVERSATION_TURN_NOT_FOUND', 404],
  ['CONTROL_REQUEST_INVALID', 400], ['PLUGIN_CAPABILITY_UNKNOWN', 400], ['PLUGIN_CAPABILITY_WRITE_REFUSED', 403],
['DRAFT_CAPABILITY_INVALID', 400], ['DRAFT_CAPABILITY_NOT_GRANTED', 403],
  ['DRAFT_POLICY_DENIED', 403], ['DRAFT_CONFIRMATION_REQUIRED', 409], ['DRAFT_NOT_FOUND', 404],
  ['DRAFT_TRANSITION_REFUSED', 409], ['EXTERNAL_ACTION_REFUSED', 403], ['RECOMMENDATION_NOT_FOUND', 404],
  ['RECOMMENDATION_BLOCKED', 409], ['RECOMMENDATION_ALREADY_ANSWERED', 409], ['EVIDENCE_NOT_FOUND', 404],
  ['EVIDENCE_CONTEXT_REQUIRED', 400], ['DELETION_STORAGE_UNAVAILABLE', 503], ['EXPORT_STORAGE_UNAVAILABLE', 503],
  ['ACTION_SUBJECT_NOT_FOUND', 404], ['ACTION_RECEIPT_NOT_AUTHORITATIVE', 409], ['RECEIPT_STORAGE_UNAVAILABLE', 503],
]);

export interface ControlRouteOptions {
  readonly policyPorts?: PolicyPorts;
  readonly registryReleaseId?: string | null;
  readonly registryRelease?: string | null;
  readonly evidenceObjects?: EvidenceObjects | undefined;
}

/** Thrown inside a deletion preview so its transaction rolls back after the
 * cascade has counted what it would remove. */
class PreviewRollback extends Error {
  constructor(readonly erased: ErasedEvidence[], readonly conversations: ConversationDeletion[]) { super('DELETION_PREVIEW'); }
}

export function registerControlRoutes(app: FastifyInstance, work: Work, options: ControlRouteOptions = {}): void {
  const correlation = (request: FastifyRequest) => request.ownerContext!.correlationId;
  async function refuse(request: FastifyRequest, reply: FastifyReply, code: string, extra: Record<string, unknown> = {}) {
    // A refusal a policy port decided names that recorded decision.
    const decided = typeof extra['policyDecisionId'] === 'string' ? { policyDecisionId: extra['policyDecisionId'] } : {};
    await work(request, tx => tx.audit({ ...decided, policyDecision: 'DENY', codeVersion: '0.1.0', result: 'REFUSED', objects: [] }));
    return reply.code(REFUSAL_STATUS.get(code) ?? 400).send({ code, correlationId: correlation(request), ...extra });
  }
  async function guarded(request: FastifyRequest, reply: FastifyReply, run: () => Promise<unknown>) {
    try { return await run(); }
    catch (error) {
      if (error instanceof ControlError) return refuse(request, reply, error.message, error.detail);
      // The schema's own refusals carry stable messages and no value.
      const message = error instanceof Error ? error.message : '';
      if (message === 'ACTION_SUBJECT_NOT_FOUND' || message === 'ACTION_RECEIPT_NOT_AUTHORITATIVE') {
        return refuse(request, reply, message);
      }
      throw error;
    }
  }
  /** The Context Broker's runner: every transaction under `memory.read`. */
  const brokerRunner = (request: FastifyRequest) => <T,>(run: (tx: OwnerTransaction) => Promise<T>) =>
    work(request, tx => run(tx), CONTEXT_READ_PURPOSE) as Promise<T>;
  const brokerOptions = (request: FastifyRequest) => ({
    ...(options.policyPorts ? { ports: options.policyPorts } : {}), correlationId: correlation(request),
    registryReleaseId: options.registryReleaseId ?? null, registryRelease: options.registryRelease ?? null,
  });
  const ownerId = (request: FastifyRequest) => request.ownerContext!.ownerScopeId;
  const idempotencyKey = (request: FastifyRequest) => String(request.headers['idempotency-key']);

  // -------------------------------------------------------------------------
  // Permissions and integrations

  app.get('/v1/permissions', async (request, reply) => guarded(request, reply, async () => {
    const connectors = await work(request, tx => listConnectors(tx), CONNECTOR_READ_PURPOSE) as Awaited<ReturnType<typeof listConnectors>>;
    // The attention budget is the memory inbox's setting (ADR 0029 §5), read here
    // under its own purpose and changed through its own PATCH route.
    const attentionBudget = await work(request, tx => readAttentionBudget(tx, { ownerScopeId: tx.context.ownerScopeId }),
      ATTENTION_SETTINGS_PURPOSE) as Awaited<ReturnType<typeof readAttentionBudget>>;
    return work(request, async tx => {
      const view = permissionsView({
        connectors, domainSensitivity: await readDomainSensitivity(tx), pluginCapabilities: await listPluginCapabilities(tx),
        attentionBudget, retention: await readRetention(tx),
        dataRequests: await listDataRequests(tx),
      });
      await tx.audit({ policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS', objects: [
        { type: 'owner_scopes', id: tx.context.ownerScopeId, fields: ['plugin_capability_grants', 'attention_budgets',
          'retention_settings', 'domain_sensitivity_settings'] },
        ...connectors.slice(0, 99).map(connector => ({ type: 'connectors', id: connector.connectorId, fields: ['status', 'permission_manifest'] }))] });
      return view;
    });
  }));

  function settingsRoute(url: string, schema: { safeParse(value: unknown): { success: boolean } },
    run: (tx: OwnerTransaction, body: unknown) => Promise<unknown>, table: string, fields: string[], method: 'POST' | 'PATCH') {
    app.route({ method, url, handler: async (request, reply) => {
      if (!schema.safeParse(request.body).success) return refuse(request, reply, 'CONTROL_REQUEST_INVALID');
      return guarded(request, reply, () => work(request, async tx => {
        const result = await run(tx, request.body);
        await tx.audit({ policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS',
          objects: [{ type: table, id: tx.context.ownerScopeId, fields }] });
        return result;
      }));
    } });
  }
  settingsRoute('/v1/plugin-capabilities', setPluginCapabilitiesSchema,
    async (tx, body) => ({ pluginCapabilities: await setPluginCapabilities(tx, body) }),
    'plugin_capability_grants', ['capability_id', 'granted', 'granted_at', 'revoked_at'], 'POST');
  settingsRoute('/v1/settings/retention', retentionUpdateSchema,
    async (tx, body) => ({ retention: await updateRetention(tx, body) }),
    'retention_settings', ['source_type', 'raw_retention_days', 'derived_retention_days'], 'PATCH');
  settingsRoute('/v1/settings/domain-sensitivity', domainSensitivityUpdateSchema,
    async (tx, body) => ({ domainSensitivity: await updateDomainSensitivity(tx, body) }),
    'domain_sensitivity_settings', ['source_type', 'sensitivity'], 'PATCH');

  // -------------------------------------------------------------------------
  // Drafts

  /**
   * A draft is created only when its capability is explicitly granted *and*
   * `EvaluateMemoryAction` allows it (CRT-CON-08-A). The grant is read first and
   * a missing one is refused by name; then the broker assembles the memory the
   * draft rests on with the draft declared, and records the port's verdict. Only
   * ALLOW writes the row, which names that verdict.
   */
  app.post('/v1/drafts', async (request, reply) => {
    const parsed = createDraftSchema.safeParse(request.body);
    if (!parsed.success) return refuse(request, reply, 'CONTROL_REQUEST_INVALID');
    const input = parsed.data;
    if (DRAFT_CAPABILITY[input.draftKind] !== input.capabilityId) {
      return refuse(request, reply, 'DRAFT_CAPABILITY_INVALID', { capabilityId: input.capabilityId, draftKind: input.draftKind });
    }
    return guarded(request, reply, async () => {
      const granted = await work(request, async tx => {
        if (input.recommendationId !== null) {
          const recommendation = await readRecommendation(tx, input.recommendationId);
          if (recommendation.status === 'BLOCKED') {
            throw new ControlError('RECOMMENDATION_BLOCKED', { recommendationId: input.recommendationId, reason: recommendation.blockedReason });
          }
        }
        return pluginCapabilityGranted(tx, input.capabilityId);
      }) as boolean;
      if (!granted) return refuse(request, reply, 'DRAFT_CAPABILITY_NOT_GRANTED', { capabilityId: input.capabilityId });
      const verdict = await evaluateActionBasis(brokerRunner(request), {
        ownerScopeId: ownerId(request), actorId: request.ownerContext!.actorId, purpose: input.purpose, basis: input.basis,
        maximumSensitivity: input.maximumSensitivity, actionRisk: input.actionRisk, capabilityGranted: true,
      }, brokerOptions(request));
      if (verdict.outcome === 'DENY') {
        return refuse(request, reply, 'DRAFT_POLICY_DENIED', { reason: verdict.reason, policyDecisionId: verdict.policyDecisionId });
      }
      if (verdict.outcome === 'REQUIRE_CONFIRMATION' || verdict.packetId === null || verdict.policyDecisionId === null) {
        return refuse(request, reply, 'DRAFT_CONFIRMATION_REQUIRED', { reason: verdict.reason, policyDecisionId: verdict.policyDecisionId });
      }
      const created = await work(request, async tx => {
        const stored = await insertDraft(tx, {
          draftKind: input.draftKind, capabilityId: input.capabilityId, content: input.content,
          recommendationId: input.recommendationId, supportingPacketId: verdict.packetId!, policyDecisionId: verdict.policyDecisionId!,
        });
        await tx.audit({ policyDecisionId: verdict.policyDecisionId!, policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS', objects: [
          { type: 'drafts', id: stored.draft.draftId, fields: ['draft_kind', 'capability_id', 'content', 'policy_decision_id'] },
          { type: 'action_history', id: stored.entry.entryId, fields: ['stage'] }] });
        return stored;
      });
      return reply.code(201).send(created);
    });
  });

  app.get('/v1/drafts', async (request, reply) => guarded(request, reply, () => work(request, async tx => {
    const drafts = await listDrafts(tx);
    await tx.audit({ policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS',
      objects: drafts.slice(0, 100).map(draft => ({ type: 'drafts', id: draft.draftId, fields: ['content', 'status'] })) });
    return { drafts };
  })));

  app.post<{ Params: { id: string } }>('/v1/drafts/:id/decision', async (request, reply) => {
    const parsed = draftDecisionSchema.safeParse(request.body);
    if (!UUID.test(request.params.id) || !parsed.success) return refuse(request, reply, 'CONTROL_REQUEST_INVALID');
    return guarded(request, reply, () => work(request, async tx => {
      const decided = await decideDraft(tx, request.params.id, parsed.data.decision);
      await tx.audit({ policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS',
        objects: [{ type: 'drafts', id: request.params.id, fields: ['status'] }] });
      return decided;
    }));
  });

  // -------------------------------------------------------------------------
  // External actions: refused in V0, every one, with a recorded decision.

  app.post('/v1/actions/execute', async (request, reply) => {
    const parsed = executeActionSchema.safeParse(request.body);
    if (!parsed.success) return refuse(request, reply, 'CONTROL_REQUEST_INVALID');
    return guarded(request, reply, async () => {
      const verdict = await work(request, tx => evaluateExternalAction(tx, {
        actionKind: parsed.data.actionKind, purpose: parsed.data.purpose, actionRisk: parsed.data.actionRisk,
        subjectRef: parsed.data.subjectRef,
      }, options.policyPorts), ACTION_POLICY_PURPOSE) as Awaited<ReturnType<typeof evaluateExternalAction>>;
      // V0 has no executor at all: whatever a port answers, nothing is sent,
      // written, moved or traded. Execution facts come only from receipts.
      return refuse(request, reply, 'EXTERNAL_ACTION_REFUSED', {
        actionKind: parsed.data.actionKind, outcome: verdict.outcome, reason: verdict.reason,
        policyDecisionId: verdict.policyDecisionId, capabilityId: verdict.capabilityId, executed: false,
      });
    });
  });

  app.get('/v1/action-history', async (request, reply) => guarded(request, reply, () => work(request, async tx => {
    const entries = await listActionHistory(tx);
    await tx.audit({ policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS',
      objects: entries.slice(0, 100).map(entry => ({ type: 'action_history', id: entry.entryId, fields: ['stage', 'action_kind'] })) });
    return { entries };
  })));

  // -------------------------------------------------------------------------
  // Recommendations

  /**
   * Store a recommendation with RECOMMENDED semantics. The broker is asked
   * whether the memory it rests on could be acted on -- preparing, the one step
   * V0 has -- so a HIGH-risk recommendation on provisional, contested or
   * incomplete memory is stored BLOCKED with the recorded decision
   * (CRT-SEC-11-A). The capability question is not this one's: a recommendation
   * asks nothing of a plugin.
   */
  app.post('/v1/recommendations', async (request, reply) => {
    const parsed = createRecommendationSchema.safeParse(request.body);
    if (!parsed.success) return refuse(request, reply, 'CONTROL_REQUEST_INVALID');
    const input = parsed.data;
    return guarded(request, reply, async () => {
      const verdict = await evaluateActionBasis(brokerRunner(request), {
        ownerScopeId: ownerId(request), actorId: request.ownerContext!.actorId, purpose: input.purpose, basis: input.basis,
        maximumSensitivity: input.maximumSensitivity, actionRisk: input.actionRisk, capabilityGranted: true,
      }, brokerOptions(request));
      const stored = await work(request, async tx => {
        const result = await insertRecommendation(tx, {
          recommendationText: input.recommendationText, recommendedActionKind: input.recommendedActionKind,
          actionRisk: input.actionRisk, recommendedPropositionId: input.recommendedPropositionId, verdict,
        });
        await tx.audit({ policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS', objects: [
          { type: 'recommendation_artifacts', id: result.recommendation.recommendationId,
            fields: ['recommendation_text', 'status', 'semantics'] }] });
        return result;
      });
      return reply.code(201).send(stored);
    });
  });

  app.get('/v1/recommendations', async (request, reply) => guarded(request, reply, () => work(request, async tx => {
    const recommendations = await listRecommendations(tx);
    await tx.audit({ policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS',
      objects: recommendations.slice(0, 100).map(item => ({ type: 'recommendation_artifacts', id: item.recommendationId, fields: ['status'] })) });
    return { recommendations };
  })));

  app.get<{ Params: { id: string } }>('/v1/recommendations/:id', async (request, reply) => {
    if (!UUID.test(request.params.id)) return refuse(request, reply, 'CONTROL_REQUEST_INVALID');
    return guarded(request, reply, () => work(request, async tx => {
      const recommendation = await readRecommendation(tx, request.params.id);
      await tx.audit({ policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS',
        objects: [{ type: 'recommendation_artifacts', id: request.params.id, fields: ['recommendation_text', 'status', 'user_response'] }] });
      return recommendation;
    }));
  });

  /**
   * The owner's answer. Their words are evidence first, stored through the
   * owner-statement ingest; the recommendation then records the response. An
   * acceptance is intent to prepare: no EXECUTED entry, no claim and no
   * executed-order fact follow from it (PRD §60, CRT-AI-04-A).
   */
  app.post<{ Params: { id: string } }>('/v1/recommendations/:id/respond', async (request, reply) => {
    const parsed = respondRecommendationSchema.safeParse(request.body);
    if (!UUID.test(request.params.id) || !parsed.success) return refuse(request, reply, 'CONTROL_REQUEST_INVALID');
    const input = parsed.data;
    return guarded(request, reply, async () => {
      await work(request, tx => readRecommendation(tx, request.params.id));
      let responseEvidenceId: string | null = null;
      if (input.rawText !== null) {
        if (!options.evidenceObjects) return refuse(request, reply, 'RECEIPT_STORAGE_UNAVAILABLE');
        const objects = options.evidenceObjects;
        responseEvidenceId = (await work(request, async tx => {
          await tx.query("SELECT set_config('unai.data_purpose',$1,true),set_config('unai.maximum_sensitivity',$2,true)",
            [input.dataPurpose, input.sensitivity]);
          return ingestOwnerStatement(tx, objects, {
            text: input.rawText!, externalId: 'recommendation-response:' + request.params.id + ':' + idempotencyKey(request),
            idempotencyKey: idempotencyKey(request), sensitivity: input.sensitivity, allowedPurposes: [input.dataPurpose],
            deterministicMetadata: { recommendationId: request.params.id, response: input.response },
          });
        }, 'evidence.ingest') as { evidenceId: string }).evidenceId;
      }
      const recommendation = await work(request, async tx => {
        const answered = await respondToRecommendation(tx, request.params.id, { response: input.response, responseEvidenceId });
        await tx.audit({ policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS',
          objects: [{ type: 'recommendation_artifacts', id: request.params.id, fields: ['user_response', 'response_evidence_id'] }] });
        return answered;
      });
      return { recommendation, intent: input.response === 'ACCEPTED_AS_INTENT_TO_PREPARE' ? 'PREPARE_ONLY' : null };
    });
  });

  // -------------------------------------------------------------------------
  // Receipts and observations

  /** An authoritative tool receipt: stored as TOOL_RECEIPT evidence, then the
   * execution fact it establishes appended against it. */
  app.post('/v1/actions/receipts', async (request, reply) => {
    const parsed = toolReceiptSchema.safeParse(request.body);
    if (!parsed.success) return refuse(request, reply, 'CONTROL_REQUEST_INVALID');
    if (!options.evidenceObjects) return refuse(request, reply, 'RECEIPT_STORAGE_UNAVAILABLE');
    const input = parsed.data, objects = options.evidenceObjects;
    return guarded(request, reply, async () => {
      const stored = await work(request, async tx => {
        await tx.query("SELECT set_config('unai.data_purpose',$1,true),set_config('unai.maximum_sensitivity',$2,true)",
          [input.dataPurpose, input.sensitivity]);
        return ingestToolReceipt(tx, objects, {
          receipt: input.receipt, toolId: input.toolId, externalActionRef: input.externalActionRef,
          occurredAt: input.occurredAt, idempotencyKey: idempotencyKey(request), sensitivity: input.sensitivity,
          allowedPurposes: [input.dataPurpose],
        });
      }, 'evidence.ingest') as { evidenceId: string };
      const entry = await work(request, async tx => {
        const recorded = await recordReceiptEntry(tx, { stage: input.stage, actionKind: input.actionKind,
          receiptEvidenceId: stored.evidenceId, recommendationId: input.recommendationId });
        await tx.audit({ policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS', objects: [
          { type: 'action_history', id: recorded.entryId, fields: ['stage', 'receipt_evidence_id'] },
          { type: 'source_items', id: stored.evidenceId, fields: ['source_type'] }] });
        return recorded;
      });
      return reply.code(201).send({ receiptEvidenceId: stored.evidenceId, entry });
    });
  });

  app.post('/v1/action-history/observations', async (request, reply) => {
    const parsed = observedActionSchema.safeParse(request.body);
    if (!parsed.success) return refuse(request, reply, 'CONTROL_REQUEST_INVALID');
    return guarded(request, reply, async () => {
      const entry = await work(request, async tx => {
        const recorded = await recordObservedAction(tx, parsed.data);
        await tx.audit({ policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS',
          objects: [{ type: 'action_history', id: recorded.entryId, fields: ['stage'] }] });
        return recorded;
      });
      return reply.code(201).send({ entry });
    });
  });

  // -------------------------------------------------------------------------
  // Export

  app.post('/v1/export', async (request, reply) => {
    const parsed = exportRequestSchema.safeParse(request.body ?? {});
    const ceiling = sensitivitySchema.safeParse(request.headers['x-maximum-sensitivity']);
    if (!parsed.success) return refuse(request, reply, 'CONTROL_REQUEST_INVALID');
    if (!ceiling.success) return refuse(request, reply, 'EVIDENCE_CONTEXT_REQUIRED');
    if (parsed.data.includeRawEvidence && !options.evidenceObjects) return refuse(request, reply, 'EXPORT_STORAGE_UNAVAILABLE');
    const objects = options.evidenceObjects;
    return guarded(request, reply, async () => {
      const exported = await work(request, async tx => {
        await tx.query("SELECT set_config('unai.maximum_sensitivity',$1,true)", [ceiling.data]);
        const requestedAt = new Date();
        const bundle = await buildExportBundle(tx, {
          includeRawEvidence: parsed.data.includeRawEvidence,
          readRaw: rawObjectRef => objects!.get(tx, rawObjectRef),
        });
        const requestId = await recordDataRequest(tx, {
          requestKind: 'EXPORT', trigger: 'OWNER_REQUEST', requestedAt,
          scope: { scope: parsed.data.scope, includeRawEvidence: parsed.data.includeRawEvidence, maximumSensitivity: ceiling.data },
          receipt: { exportId: bundle.exportId, counts: bundle.counts },
        });
        await tx.audit({ policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS', objects: [
          { type: 'retention_and_deletion_requests', id: requestId, fields: ['request_kind', 'cascade_receipt'] },
          ...bundle.evidence.slice(0, 99).map(item => ({ type: 'source_items', id: item.evidenceId,
            fields: ['raw_object_ref', 'deterministic_metadata', 'anchors'] }))] });
        return { requestId, status: 'COMPLETED', bundle };
      });
      // A successful response promises a durable export and audit receipt.
      // Sending inside the callback can race COMMIT or hide its failure.
      return reply.code(201).send(exported);
    });
  });

  // -------------------------------------------------------------------------
  // Deletion and retention

  /** Erase each item, delete its raw object, record the request, then replay
   * every typed projection from what canonical memory still supports. */
  async function deleteEvidence(request: FastifyRequest, evidenceIds: readonly string[],
    trigger: 'OWNER_REQUEST' | 'RETENTION_POLICY', conversationIds: readonly string[] = []): Promise<DeletionReceipt> {
    const objects = options.evidenceObjects;
    if (evidenceIds.length && !objects?.delete) throw new ControlError('DELETION_STORAGE_UNAVAILABLE');
    const requestedAt = new Date();
    const committed = await work(request, async tx => {
      const erased: ErasedEvidence[] = [];
      const conversations: ConversationDeletion[] = [];
      for (const id of [...new Set(conversationIds)].sort()) conversations.push(await new ConversationService(tx).delete(id));
      for (const evidenceId of [...new Set(evidenceIds)]) erased.push(await eraseEvidence(tx, evidenceId));
      // After the database erasure and inside its transaction: a storage failure
      // rolls the erasure back instead of leaving a row that promises gone bytes.
      for (const item of erased) await objects!.delete!(tx, item.rawObjectRef);
      const cascade = cascadeCounts(erased, erased.length);
      cascade.conversations = conversations.reduce((n, receipt) => n + receipt.conversations, 0);
      cascade.conversationTurns = conversations.reduce((n, receipt) => n + receipt.conversationTurns, 0);
      const requestId = await recordDataRequest(tx, {
        requestKind: 'DELETE', trigger, requestedAt, scope: { evidenceIds: erased.map(item => item.evidenceId), conversationIds: conversations.map(item => item.conversationId) },
        receipt: { cascade, propositionIds: erased.flatMap(item => item.propositionIds).slice(0, 500) },
      });
      // Identifiers and field names only: the audit keeps no payload content.
      await tx.audit({ policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS', objects: [
        { type: 'retention_and_deletion_requests', id: requestId, fields: ['request_kind', 'cascade_receipt'] },
        ...erased.slice(0, 99).map(item => ({ type: 'source_items', id: item.evidenceId, fields: ['deleted_at'] }))] });
      return { requestId, erased, cascade };
    }) as { requestId: string; erased: ErasedEvidence[]; cascade: ReturnType<typeof cascadeCounts> };
    const rebuilt: string[] = [];
    await work(request, async tx => {
      const receipts: string[] = [];
      for (const projectionName of committed.erased.length ? PROJECTION_NAMES : []) {
        const receipt = await replayProjection(tx, { ownerScopeId: tx.context.ownerScopeId, projectionName, asOf: new Date(),
          trigger: 'MANUAL_REPLAY', compareWithStored: false,
          detail: { cause: 'DELETION', retentionAndDeletionRequestId: committed.requestId } });
        receipts.push(receipt.projectionRebuildReceiptId);
        rebuilt.push(projectionName);
      }
      // The rebuild is its own audited event (CRT-SEC-07-A), beside the deletion's.
      await tx.audit({ policyDecision: 'ALLOW', codeVersion: REDUCER_VERSION, result: 'SUCCESS', objects: [
        { type: 'retention_and_deletion_requests', id: committed.requestId, fields: ['cascade_receipt'] },
        ...receipts.map(id => ({ type: 'projection_rebuild_receipts', id, fields: ['projection_name', 'trigger', 'rows_rebuilt'] }))] });
    }, PROJECTION_PURPOSE);
    return deletionReceiptSchema.parse({
      requestId: committed.requestId, status: 'COMPLETED', trigger,
      evidenceIds: committed.erased.map(item => item.evidenceId), cascade: committed.cascade,
      conversationIds: [...new Set(conversationIds)],
      projectionsRebuilt: rebuilt, auditRetainsPayload: false,
    });
  }

  app.post('/v1/data/deletions/preview', async (request, reply) => {
    const parsed = deletionPreviewRequestSchema.safeParse(request.body);
    if (!parsed.success) return refuse(request, reply, 'CONTROL_REQUEST_INVALID');
    return guarded(request, reply, async () => {
      try {
        await work(request, async tx => {
          const erased: ErasedEvidence[] = [];
          const conversations: ConversationDeletion[] = [];
          for (const id of [...new Set(parsed.data.conversationIds)].sort()) conversations.push(await new ConversationService(tx).delete(id));
          for (const evidenceId of [...new Set(parsed.data.evidenceIds)]) erased.push(await eraseEvidence(tx, evidenceId));
          throw new PreviewRollback(erased, conversations);
        });
      } catch (error) {
        if (!(error instanceof PreviewRollback)) throw error;
        // A preview reads what a deletion would remove and removes nothing.
        await work(request, tx => tx.audit({ eventKind: 'READ', policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS',
          objects: [...error.erased.map(item => ({ type: 'source_items', id: item.evidenceId, fields: ['deleted_at'] })),
            ...error.conversations.map(item => ({ type: 'conversations', id: item.conversationId, fields: ['id'] }))].slice(0,100) }));
        return deletionReceiptSchema.parse({
          requestId: null, status: 'PREVIEW', trigger: 'OWNER_REQUEST', evidenceIds: error.erased.map(item => item.evidenceId),
          conversationIds: error.conversations.map(item => item.conversationId),
          cascade: { ...cascadeCounts(error.erased, error.erased.length),
            conversations: error.conversations.reduce((n, item) => n + item.conversations, 0),
            conversationTurns: error.conversations.reduce((n, item) => n + item.conversationTurns, 0) }, projectionsRebuilt: [], auditRetainsPayload: false,
        });
      }
      throw new ControlError('DELETION_PREVIEW_NOT_ROLLED_BACK');
    });
  });

  app.post('/v1/data/deletions', async (request, reply) => {
    const parsed = deletionRequestSchema.safeParse(request.body);
    if (!parsed.success) return refuse(request, reply, 'CONTROL_REQUEST_INVALID');
    return guarded(request, reply, () => deleteEvidence(request, parsed.data.evidenceIds, 'OWNER_REQUEST', parsed.data.conversationIds));
  });

  /** Apply the saved retention rules now: raw evidence past its source type's
   * raw retention is erased through the same cascade, and the regenerable
   * derivatives past the derived retention expire. */
  app.post('/v1/data/retention/cleanup', async (request, reply) => {
    const parsed = retentionCleanupSchema.safeParse(request.body ?? {});
    if (!parsed.success) return refuse(request, reply, 'CONTROL_REQUEST_INVALID');
    const asOf = parsed.data.asOf === null ? new Date() : new Date(parsed.data.asOf);
    return guarded(request, reply, async () => {
      const expired = await work(request, tx => listExpiredEvidence(tx, asOf)) as string[];
      const deletion = expired.length === 0 ? null : await deleteEvidence(request, expired, 'RETENTION_POLICY');
      const conversationsDeleted = await work(request, tx => new ConversationService(tx).applyRetention(asOf));
      const derived = await work(request, async tx => {
        const result = await expireDerivedData(tx, asOf);
        await tx.audit({ policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS',
          objects: [{ type: 'retention_settings', id: tx.context.ownerScopeId, fields: ['raw_retention_days', 'derived_retention_days'] }] });
        return result;
      });
      return { asOf: asOf.toISOString(), deletion, conversationsDeleted, derivedExpired: derived };
    });
  });

  // -------------------------------------------------------------------------
  // Semantic index regeneration

  app.post('/v1/memory/embeddings/regenerate', async (request, reply) => {
    const parsed = regenerateEmbeddingsSchema.safeParse(request.body ?? {});
    if (!parsed.success) return refuse(request, reply, 'CONTROL_REQUEST_INVALID');
    return guarded(request, reply, async () => {
      const dropped = parsed.data.dropExisting ? await work(request, tx => dropSemanticIndex(tx)) as number : 0;
      const regenerated = parsed.data.regenerate
        ? await work(request, tx => regenerateSemanticIndex(tx), MEMORY_GOVERN_PURPOSE) as Awaited<ReturnType<typeof regenerateSemanticIndex>>
        : { indexed: 0, skipped: 0, embeddingModel: EMBEDDING_MODEL, embeddingVersion: EMBEDDING_VERSION };
      await work(request, tx => tx.audit({ policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS',
        objects: [{ type: 'memory_embeddings', id: tx.context.ownerScopeId, fields: ['vector', 'embedding_version'] }] }));
      return regenerationReceiptSchema.parse({ dropped, ...regenerated });
    });
  });
}
