import {
  documentReceiptSchema, documentSearchResultSchema, documentUploadSchema,
  type DocumentReceipt, type DocumentSearchResult, type DocumentUpload, type ExtractionPlanReason,
} from '@unai/domain';
import { ConnectorError, manifestFor, storedSensitivity } from './manifests.js';
import { hasCapability, type ConnectorTransaction } from './grants.js';
import type { SourceIngest } from './sync.js';

/**
 * Document upload (design `POST /v1/documents`, PRD §20.5, CRT-CON-05-A).
 *
 * "Store and index immediately. Use lazy full extraction unless the document is
 * user-requested, active-workflow related, deadline-bearing, or classified
 * high-value." Both halves are here and neither is a model's decision:
 *
 *  - *Stored and indexed immediately*: the same transaction that stores the
 *    object writes one `source_anchors` row per page with its normalized text,
 *    which is what `searchDocuments` reads. The document is findable as soon as
 *    the upload is acknowledged, with every extraction worker stopped.
 *  - *Full extraction only on a trigger*: `planExtraction` is a pure function of
 *    the four documented triggers. With no trigger nothing is queued at all, so
 *    "extraction did not run" is checkable as the absence of a job rather than as
 *    a claim about a worker.
 */

export interface ExtractionPlan {
  readonly plan: 'DEFERRED' | 'FULL';
  readonly reason: ExtractionPlanReason;
}

export interface ExtractionTriggers {
  /** The owner asked for it on the upload screen. */
  readonly userRequested: boolean;
  /** The upload names a memory thread that is still open. */
  readonly activeWorkflowRelated: boolean;
  /** Tier-0/Tier-1 triage found a deadline signal in the document's own text. */
  readonly deadlineBearing: boolean;
  /** The owner classified it, or the connector's own high-value rule matched. */
  readonly highValue: boolean;
  /** No page text could be extracted from the format. */
  readonly unsupportedFormat: boolean;
}

/** The four triggers of PRD §20.5, in a fixed order, so the same document always
 * receives the same plan and the reason names which trigger fired. */
export function planExtraction(triggers: ExtractionTriggers): ExtractionPlan {
  // A format whose text could not be read has nothing to extract: it is stored
  // as source-only evidence and stays retrievable, which is the drawn state.
  if (triggers.unsupportedFormat) {
    return { plan: 'DEFERRED', reason: 'UNSUPPORTED_FORMAT_STORED_AS_SOURCE_ONLY' };
  }
  if (triggers.userRequested) return { plan: 'FULL', reason: 'USER_REQUESTED' };
  if (triggers.activeWorkflowRelated) return { plan: 'FULL', reason: 'ACTIVE_WORKFLOW_RELATED' };
  if (triggers.deadlineBearing) return { plan: 'FULL', reason: 'DEADLINE_BEARING' };
  if (triggers.highValue) return { plan: 'FULL', reason: 'HIGH_VALUE' };
  return { plan: 'DEFERRED', reason: 'NO_FULL_EXTRACTION_TRIGGER' };
}

/** The enqueue port. Supplied by the API composition, which owns the durable
 * queue; a DEFERRED plan never calls it, which is the whole point. */
export type ExtractionEnqueue = (input: { readonly evidenceId: string; readonly reason: ExtractionPlanReason })
  => Promise<{ readonly jobId: string }>;

export interface DocumentUploadOptions {
  readonly ingest: SourceIngest;
  readonly enqueueExtraction?: ExtractionEnqueue;
  /** Reads the triage decision recorded for the stored item, so the deadline
   * trigger uses the signals ingestion already derived rather than a second
   * regular expression that could disagree with them. */
  readonly readTriage: (tx: ConnectorTransaction, evidenceId: string)
    => Promise<{ readonly route: string; readonly signals: readonly string[] } | null>;
}

export async function uploadDocument(
  tx: ConnectorTransaction, input: DocumentUpload, options: DocumentUploadOptions,
): Promise<DocumentReceipt> {
  const upload = documentUploadSchema.parse(input);
  if (upload.connectorId !== null && !await hasCapability(tx, upload.connectorId, 'documents.upload')) {
    throw new ConnectorError('CONNECTOR_CAPABILITY_NOT_GRANTED',
      { connectorId: upload.connectorId, capabilityId: 'documents.upload' });
  }
  // The documents manifest's declared default is a floor here too: an upload
  // may be stored more privately than the request asked, never less.
  const sensitivity = storedSensitivity(manifestFor('DOCUMENT'), upload.sensitivity);
  const imported = await options.ingest(tx, {
    sourceType: 'DOCUMENT', connectorId: upload.connectorId,
    payload: {
      documentId: upload.documentId, title: upload.title ?? undefined, mediaType: upload.mediaType,
      pages: upload.pages, ...(upload.base64 === null ? {} : { base64: upload.base64 }),
    },
    sensitivity, allowedPurposes: upload.allowedPurposes,
  });
  const stored = imported[0];
  if (!stored) throw new ConnectorError('DOCUMENT_NOT_STORED', { documentId: upload.documentId });

  // The index is the anchors the parser wrote in this same transaction: one
  // DOCUMENT_RANGE per page, carrying the page's normalized text.
  const indexed = (await tx.query(
    `SELECT count(*)::int AS indexed FROM source_anchors
     WHERE owner_scope_id=$1 AND source_item_id=$2 AND anchor_kind='DOCUMENT_RANGE'`,
    [tx.context.ownerScopeId, stored.evidenceId])).rows[0];
  const triage = await options.readTriage(tx, stored.evidenceId);
  const activeWorkflowRelated = upload.relatedThreadIds.length > 0
    && await hasOpenThread(tx, upload.relatedThreadIds);
  const plan = planExtraction({
    userRequested: upload.requestFullExtraction,
    activeWorkflowRelated,
    deadlineBearing: (triage?.signals ?? []).includes('DEADLINE'),
    highValue: upload.valueClassification === 'HIGH_VALUE',
    unsupportedFormat: upload.pages.length === 0,
  });
  let extractionJobId: string | null = null;
  if (plan.plan === 'FULL') {
    if (!options.enqueueExtraction) throw new ConnectorError('DOCUMENT_EXTRACTION_UNAVAILABLE');
    extractionJobId = (await options.enqueueExtraction({ evidenceId: stored.evidenceId, reason: plan.reason })).jobId;
  }
  return documentReceiptSchema.parse({
    evidenceId: stored.evidenceId, ingestionStatus: 'STORED', indexed: true,
    indexedAnchors: Number(indexed?.['indexed'] ?? 0), searchable: true, storedSensitivity: sensitivity,
    extractionPlan: plan.plan, extractionPlanReason: plan.reason,
    triageRoute: triage?.route ?? 'UNKNOWN', extractionJobId,
  });
}

/** A memory thread that is still open makes an upload workflow-related. A thread
 * the owner closed does not, which is what keeps the trigger from meaning
 * "anything ever mentioned". */
async function hasOpenThread(tx: ConnectorTransaction, threadIds: readonly string[]): Promise<boolean> {
  const rows = (await tx.query(
    `SELECT id FROM memory_threads WHERE owner_scope_id=$1 AND id=ANY($2::uuid[]) AND lifecycle='OPEN'`,
    [tx.context.ownerScopeId, [...threadIds]])).rows;
  return rows.length > 0;
}

/**
 * Lexical search over the stored document index (CRT-CON-05-A: "stored and
 * searchable immediately after upload").
 *
 * It reads `source_anchors.normalized_text` under the owner's own row policies,
 * so the purpose and the sensitivity ceiling of the request decide what is
 * findable, exactly as they do for any other evidence read. It is deliberately
 * lexical: the pgvector semantic index is a later slice's, and a search that
 * needed embeddings would not be available "immediately after upload".
 */
export async function searchDocuments(
  tx: ConnectorTransaction, input: { readonly query: string; readonly limit?: number },
): Promise<DocumentSearchResult> {
  const query = input.query.trim();
  if (query.length === 0 || query.length > 200) throw new ConnectorError('DOCUMENT_QUERY_INVALID');
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);
  const rows = (await tx.query(
    `SELECT s.id,s.content_hash,s.occurred_at,s.observed_at,s.deterministic_metadata,
       a.anchor,a.normalized_text,
       (SELECT t.tier1_route FROM triage_decisions t
         WHERE t.owner_scope_id=s.owner_scope_id AND t.source_item_id=s.id) AS tier1_route
     FROM source_items s
     JOIN source_anchors a ON a.owner_scope_id=s.owner_scope_id AND a.source_item_id=s.id
     WHERE s.owner_scope_id=$1 AND s.source_type='DOCUMENT' AND s.deleted_at IS NULL
       AND a.anchor_kind IN ('DOCUMENT_RANGE','CONNECTOR_JSON_PATH')
       AND a.normalized_text ILIKE '%'||$2||'%'
     ORDER BY s.observed_at DESC,s.id DESC,a.id
     LIMIT $3`,
    [tx.context.ownerScopeId, query, limit])).rows;
  const seen = new Set<string>();
  const hits = [];
  for (const row of rows) {
    const key = (row['id'] as string) + ':' + String(row['anchor']?.['page'] ?? '');
    if (seen.has(key)) continue;
    seen.add(key);
    const text = (row['normalized_text'] as string | null) ?? '';
    const at = text.toLowerCase().indexOf(query.toLowerCase());
    const start = Math.max(0, at - 80);
    const route = (row['tier1_route'] as string | null) ?? null;
    hits.push({
      evidenceId: row['id'] as string,
      documentId: String(row['anchor']?.['documentId'] ?? ''),
      title: null,
      page: typeof row['anchor']?.['page'] === 'number' ? row['anchor']['page'] as number : null,
      excerpt: text.slice(start, start + 320),
      occurredAt: row['occurred_at'] ? (row['occurred_at'] as Date).toISOString() : null,
      observedAt: (row['observed_at'] as Date).toISOString(),
      extractionPlan: route === null ? 'UNKNOWN' : route === 'FULL_EXTRACTION' ? 'FULL' : 'DEFERRED',
    });
  }
  return documentSearchResultSchema.parse({ query, hits });
}
