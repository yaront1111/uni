import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { OwnerTransaction } from '@unai/postgres';
import {
  createConnectorSchema, grantCapabilitiesSchema, syncRequestSchema, documentUploadSchema,
  dataPurposeSchema, sensitivitySchema,
} from '@unai/domain';
import {
  CONNECTOR_MANAGE_PURPOSE, CONNECTOR_READ_PURPOSE, CONNECTOR_SYNC_PURPOSE, ConnectorError,
  ceilingAdmits, createConnector, createConnectorClient, createTokenRevoker, disconnectConnector,
  listConnectors, listGrants, manifestFor, readConnector, recordSyncFailure, runConnectorSync,
  searchDocuments, setCapabilityGrants, storedSensitivity, uploadDocument,
  type ConnectorClient, type SourceIngest, type StoredSensitivity, type TokenRevoker,
} from '@unai/connectors';
import type { SecretsManager } from '@unai/secrets';
import { readTriageDecision } from '@unai/extraction';
import { importSource, type EvidenceObjects } from './evidence.js';
import { readSensitivityFloor } from '@unai/control';
import { requestDocumentProcessing } from './processing-store.js';

/**
 * Connected sources, capability grants, sync, disconnect and document upload
 * (design `GET|POST /v1/connectors`, `POST /v1/connectors/{id}/capabilities`,
 * `POST /v1/connectors/{id}/sync`, `POST /v1/connectors/{id}/disconnect`,
 * `POST /v1/documents`).
 *
 * Every route here is a *read* of the provider and a *write* of evidence: no
 * route creates a belief, and none of them can, because the purposes they run
 * under appear in no canonical write policy. The three connector purposes are
 * separate on purpose: `connector.read` inspects, `connector.manage` changes
 * consent, and `connector.sync` may move a cursor and store evidence but may not
 * touch a credential -- migration 0018's trigger refuses it.
 */

export { CONNECTOR_READ_PURPOSE, CONNECTOR_MANAGE_PURPOSE, CONNECTOR_SYNC_PURPOSE };
export const DOCUMENT_UPLOAD_PURPOSE = 'evidence.ingest';
export const DOCUMENT_SEARCH_PURPOSE = 'evidence.read';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Work = (request: FastifyRequest, run: (tx: OwnerTransaction, sessionId: string) => Promise<unknown>) => Promise<unknown>;

const REFUSAL_STATUS = new Map<string, number>([
  ['CONNECTOR_NOT_FOUND', 404],
  ['CONNECTOR_TYPE_UNSUPPORTED', 400],
  ['CONNECTOR_CAPABILITY_UNKNOWN', 400],
  ['CONNECTOR_WRITE_SCOPE_REFUSED', 403],
  ['CONNECTOR_CAPABILITY_NOT_GRANTED', 403],
  ['CONNECTOR_INGESTION_STOPPED', 409],
  ['CONNECTOR_DISCONNECTED', 409],
  ['CONNECTOR_ALREADY_CONNECTED', 409],
  ['CONNECTOR_PURPOSE_REFUSED', 403],
  ['CONNECTOR_CREDENTIAL_MISSING', 409],
  ['CONNECTOR_CLIENT_UNSUPPORTED', 400],
  ['CONNECTOR_REVOCATION_UNAVAILABLE', 503],
  ['CONNECTOR_REVOCATION_FAILED', 502],
  ['CONNECTOR_TOKEN_REVOKED', 409],
  ['CONNECTOR_PROVIDER_UNAVAILABLE', 502],
  ['CONNECTOR_PROVIDER_RESPONSE_INVALID', 502],
  ['CONNECTOR_CONTEXT_PROFILE_INVALID', 500],
  ['CONNECTOR_SENSITIVITY_CEILING_TOO_LOW', 403],
  ['DOCUMENT_QUERY_INVALID', 400],
  ['DOCUMENT_NOT_STORED', 503],
  ['DOCUMENT_EXTRACTION_UNAVAILABLE', 503],
  ['CONNECTOR_REQUEST_INVALID', 400],
]);

export interface ConnectorRouteOptions {
  readonly evidenceObjects?: EvidenceObjects;
  /** Builds the read-only provider client for one connector. The production
   * composition builds a real HTTPS client from the connector's secret handle. */
  readonly connectorClient?: (input: { readonly connectorType: string; readonly secretRef: string | null })
    => Promise<ConnectorClient> | ConnectorClient;
  readonly revokeTokens?: TokenRevoker;
  /** Enqueues `evidence.extract` for a FULL document plan, in its own owner
   * transaction under `jobs.enqueue`: an upload route may store evidence, and
   * queueing work is a different authority. */
  readonly enqueueExtraction?: (input: {
    readonly context: OwnerTransaction['context']; readonly evidenceId: string; readonly reason: string;
    readonly dataPurpose: string; readonly maximumSensitivity: 'NORMAL' | 'PRIVATE' | 'RESTRICTED';
  }) => Promise<{ readonly jobId: string }>;
}

/**
 * The production connector runtime: the read-only provider clients and the real
 * token revocation call, both built from the deployment's secrets manager.
 *
 * It exists as its own function so the entry point wires one object and so the
 * wiring is testable without starting a listener. Constructing a client resolves
 * no secret and makes no request — the handle is resolved per fetch inside
 * `@unai/connectors`, and the bearer token never leaves that file — so this is
 * safe to call for a connector whose provider is unreachable.
 *
 * A connector type with no provider to poll (CONVERSATION, DOCUMENT) has no
 * client: first-party messages and uploads arrive through `POST /v1/evidence`
 * and `POST /v1/documents`, and a sync of one is refused
 * `CONNECTOR_CLIENT_UNSUPPORTED` rather than silently answering nothing.
 */
export function createConnectorRuntime(secrets: SecretsManager): {
  readonly connectorClient: (input: { readonly connectorType: string; readonly secretRef: string | null })
    => ConnectorClient;
  readonly revokeTokens: TokenRevoker;
} {
  return {
    connectorClient: input => createConnectorClient(input.connectorType, secrets, input.secretRef),
    revokeTokens: createTokenRevoker(secrets),
  };
}

export function registerConnectorRoutes(app: FastifyInstance, work: Work, options: ConnectorRouteOptions = {}): void {
  async function refuse(request: FastifyRequest, reply: FastifyReply, code: string,
    extra: Record<string, unknown> = {}): Promise<unknown> {
    const status = REFUSAL_STATUS.get(code) ?? 400;
    await work(request, tx => tx.audit({ policyDecision: 'DENY', codeVersion: '0.1.0', result: 'REFUSED', objects: [] }));
    return reply.code(status).send({ code, correlationId: request.ownerContext!.correlationId, ...extra });
  }
  async function guarded(request: FastifyRequest, reply: FastifyReply, run: () => Promise<unknown>): Promise<unknown> {
    try { return await run(); }
    catch (error) {
      if (error instanceof ConnectorError) return refuse(request, reply, error.message, error.detail);
      throw error;
    }
  }
  /** The evidence context an ingesting route needs. Declared by the caller the
   * same way the evidence routes declare it, so the row policies apply the same
   * purpose and ceiling to a connector sync as to a direct upload. */
  async function declareEvidenceAuthority(tx: OwnerTransaction, request: FastifyRequest): Promise<{ purpose: string; maximum: 'NORMAL' | 'PRIVATE' | 'RESTRICTED' }> {
    const purpose = dataPurposeSchema.safeParse(request.headers['x-data-purpose']);
    const maximum = sensitivitySchema.safeParse(request.headers['x-maximum-sensitivity']);
    if (!purpose.success || !maximum.success) throw new ConnectorError('EVIDENCE_CONTEXT_REQUIRED');
    await tx.query("SELECT set_config('unai.data_purpose',$1,true),set_config('unai.maximum_sensitivity',$2,true)",
      [purpose.data, maximum.data]);
    return { purpose: purpose.data, maximum: maximum.data };
  }
  /** A request may not ask to store a connector's evidence under a ceiling below
   * that connector's own sensitivity floor. Refusing it by name is the honest
   * answer: the alternative is lowering the floor to fit the ceiling, which is
   * exactly what the floor exists to prevent, or letting the row policy fail with
   * a message about a purpose rather than about sensitivity. */
  function assertCeilingAdmitsFloor(connectorType: string, ceiling: StoredSensitivity, requested: StoredSensitivity,
    ownerFloor: StoredSensitivity | null): void {
    const manifest = manifestFor(connectorType);
    const stored = storedSensitivity(manifest, requested, ownerFloor);
    if (!ceilingAdmits(ceiling, stored)) {
      throw new ConnectorError('CONNECTOR_SENSITIVITY_CEILING_TOO_LOW',
        { connectorType, maximumSensitivity: ceiling, storedSensitivity: stored });
    }
  }
  const ingest: SourceIngest = async (tx, request) => {
    if (!options.evidenceObjects) throw new ConnectorError('DOCUMENT_NOT_STORED');
    return importSource(tx as unknown as OwnerTransaction, options.evidenceObjects, {
      sourceType: request.sourceType, connectorId: request.connectorId, payload: request.payload,
      sensitivity: request.sensitivity, allowedPurposes: request.allowedPurposes,
    });
  };

  app.get('/v1/connectors', async request => work(request, async tx => {
    const connectors = await listConnectors(tx);
    await tx.audit({
      policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS',
      objects: connectors.slice(0, 100).map(connector => ({
        type: 'connectors', id: connector.connectorId, fields: ['connector_type', 'status', 'last_cursor'] })),
    });
    return { connectors };
  }));

  app.post('/v1/connectors', async (request, reply) => {
    const parsed = createConnectorSchema.safeParse(request.body);
    if (!parsed.success) return refuse(request, reply, 'CONNECTOR_REQUEST_INVALID');
    return guarded(request, reply, async () => {
      const connector = await work(request, async tx => {
        const created = await createConnector(tx, parsed.data);
        await tx.audit({
          policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS',
          objects: [{ type: 'connectors', id: created.connectorId,
            fields: ['connector_type', 'external_account_ref', 'permission_manifest', 'status'] }],
        });
        return created;
      });
      return reply.code(201).send(connector);
    });
  });

  app.get<{ Params: { id: string } }>('/v1/connectors/:id/capabilities', async (request, reply) => {
    if (!UUID.test(request.params.id)) return refuse(request, reply, 'CONNECTOR_REQUEST_INVALID');
    return guarded(request, reply, async () => work(request, async tx => {
      const capabilities = await listGrants(tx, request.params.id);
      await tx.audit({
        policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS',
        objects: [{ type: 'connectors', id: request.params.id, fields: ['permission_manifest'] }],
      });
      return { connectorId: request.params.id, capabilities };
    }));
  });

  /** One toggle per discrete capability. A request needing a write scope is
   * refused with the reason, which is the state the consent screen draws. */
  app.post<{ Params: { id: string } }>('/v1/connectors/:id/capabilities', async (request, reply) => {
    if (!UUID.test(request.params.id)) return refuse(request, reply, 'CONNECTOR_REQUEST_INVALID');
    const parsed = grantCapabilitiesSchema.safeParse(request.body);
    if (!parsed.success) return refuse(request, reply, 'CONNECTOR_REQUEST_INVALID');
    return guarded(request, reply, async () => work(request, async tx => {
      const capabilities = await setCapabilityGrants(tx, request.params.id, parsed.data.capabilities);
      const connector = await readConnector(tx, request.params.id);
      await tx.audit({
        policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS',
        objects: [{ type: 'connector_capability_grants', id: connector.connectorId,
          fields: ['capability_id', 'granted', 'granted_at', 'revoked_at'] }],
      });
      return { connectorId: connector.connectorId, status: connector.status, capabilities,
        grantedCapabilities: connector.grantedCapabilities, requestedScopes: connector.requestedScopes };
    }));
  });

  app.post<{ Params: { id: string } }>('/v1/connectors/:id/sync', async (request, reply) => {
    if (!UUID.test(request.params.id)) return refuse(request, reply, 'CONNECTOR_REQUEST_INVALID');
    const parsed = syncRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) return refuse(request, reply, 'CONNECTOR_REQUEST_INVALID');
    if (!options.connectorClient) return refuse(request, reply, 'CONNECTOR_CLIENT_UNSUPPORTED');
    try {
      return await work(request, async tx => {
        const authority = await declareEvidenceAuthority(tx, request);
        const connector = (await tx.query(
          'SELECT connector_type,secret_ref FROM connectors WHERE id=$1 AND owner_scope_id=$2',
          [request.params.id, tx.context.ownerScopeId])).rows[0];
        if (!connector) throw new ConnectorError('CONNECTOR_NOT_FOUND', { connectorId: request.params.id });
        // The owner's stored-sensitivity setting is read here, at the sync, so a
        // change saved on the Permissions surface applies to this run (ADR 0030 §7).
        const sensitivityFloor = await readSensitivityFloor(tx, connector.connector_type as string);
        assertCeilingAdmitsFloor(connector.connector_type as string, authority.maximum, parsed.data.sensitivity, sensitivityFloor);
        const client = await options.connectorClient!({
          connectorType: connector.connector_type as string,
          secretRef: (connector.secret_ref as string | null) ?? null,
        });
        const result = await runConnectorSync(tx, {
          connectorId: request.params.id, request: parsed.data, client, ingest, sensitivityFloor,
        });
        await tx.audit({
          policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS',
          objects: [{ type: 'connectors', id: request.params.id, fields: ['last_cursor', 'cursor_updated_at'] },
            ...result.evidenceIds.slice(0, 99).map(id => ({
              type: 'source_items', id, fields: ['source_type', 'external_id', 'content_hash'] }))],
        });
        return result;
      });
    } catch (error) {
      if (!(error instanceof ConnectorError)) throw error;
      // The failed run is recorded on the connector in its own transaction: the
      // work it refused has been rolled back, and "sync failed with a named
      // reason" is a state the Connected sources screen has to be able to show.
      await work(request, tx => recordSyncFailure(tx, request.params.id, error.message)).catch(() => undefined);
      return refuse(request, reply, error.message, error.detail);
    }
  });

  app.post<{ Params: { id: string } }>('/v1/connectors/:id/disconnect', async (request, reply) => {
    if (!UUID.test(request.params.id)) return refuse(request, reply, 'CONNECTOR_REQUEST_INVALID');
    return guarded(request, reply, async () => work(request, async tx => {
      const result = await disconnectConnector(tx, request.params.id, options.revokeTokens);
      await tx.audit({
        policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS',
        objects: [{ type: 'connectors', id: request.params.id,
          fields: ['status', 'secret_ref', 'disconnected_at', 'last_cursor'] }],
      });
      return result;
    }));
  });

  /**
   * Upload a document. Stored and indexed in one transaction, with full
   * extraction queued only when one of the four triggers fires (CRT-CON-05-A).
   */
  app.post('/v1/documents', async (request, reply) => {
    const parsed = documentUploadSchema.safeParse(request.body);
    if (!parsed.success) return refuse(request, reply, 'CONNECTOR_REQUEST_INVALID');
    return guarded(request, reply, async () => {
      const queued: { plan: { evidenceId: string; reason: string } | null } = { plan: null };
      const declared: { authority: { purpose: string; maximum: 'NORMAL' | 'PRIVATE' | 'RESTRICTED' } | null } = { authority: null };
      const receipt = await work(request, async tx => {
        declared.authority = await declareEvidenceAuthority(tx, request);
        const sensitivityFloor = await readSensitivityFloor(tx, 'DOCUMENT');
        assertCeilingAdmitsFloor('DOCUMENT', declared.authority.maximum, parsed.data.sensitivity, sensitivityFloor);
        const stored = await uploadDocument(tx, parsed.data, {
          ingest, sensitivityFloor,
          readTriage: async (transaction, evidenceId) => {
            const decision = await readTriageDecision(transaction as unknown as OwnerTransaction, {
              ownerScopeId: transaction.context.ownerScopeId, sourceItemId: evidenceId,
            });
            return decision === null ? null
              : { route: decision.tier1Route, signals: decision.routingReason.positiveSignals };
          },
          // Queueing is a separate authority, so the plan is decided here and the
          // job is enqueued after this transaction commits. A DEFERRED plan never
          // reaches either branch, which is how "extraction did not run" is
          // observable as an empty queue.
          enqueueExtraction: async input => {
            await requestDocumentProcessing(tx, input.evidenceId);
            queued.plan = { evidenceId: input.evidenceId, reason: input.reason };
            return { jobId: PLACEHOLDER_JOB_ID };
          },
        });
        await tx.audit({
          policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS',
          objects: [{ type: 'source_items', id: stored.evidenceId,
            fields: ['source_type', 'external_id', 'content_hash', 'sensitivity', 'allowed_purposes'] }],
        });
        return stored;
      }) as Awaited<ReturnType<typeof uploadDocument>>;
      const plan = queued.plan, authority = declared.authority;
      if (plan !== null) {
        // The document is already stored, indexed and searchable at this point.
        // A deployment that cannot queue the run answers 503 for the *queueing*
        // and keeps the stored document: evidence durability never depends on
        // later processing (PRD §0 rule 5, §35.1).
        if (!options.enqueueExtraction || authority === null) throw new ConnectorError('DOCUMENT_EXTRACTION_UNAVAILABLE');
        const enqueued = await options.enqueueExtraction({
          context: request.ownerContext!, evidenceId: plan.evidenceId, reason: plan.reason,
          dataPurpose: authority.purpose, maximumSensitivity: authority.maximum,
        });
        return reply.code(201).send({ ...receipt, extractionJobId: enqueued.jobId });
      }
      return reply.code(201).send({ ...receipt, extractionJobId: null });
    });
  });

  /** Search the documents the owner has stored. Lexical and immediate: it reads
   * the anchors written by the upload transaction, so a document is findable
   * before any extraction has run (CRT-CON-05-A). */
  app.get<{ Querystring: { q?: string } }>('/v1/documents/search', async (request, reply) =>
    guarded(request, reply, async () => work(request, async tx => {
      await declareEvidenceAuthority(tx, request);
      const result = await searchDocuments(tx, { query: String(request.query.q ?? '') });
      await tx.audit({
        policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS',
        objects: result.hits.slice(0, 99).map(hit => ({
          type: 'source_items', id: hit.evidenceId, fields: ['source_type', 'external_id'] })),
      });
      return result;
    })));
}

/** The receipt's job id is replaced with the real one after the enqueue commits;
 * it never reaches a response. */
const PLACEHOLDER_JOB_ID = '00000000-0000-4000-8000-000000000000';
