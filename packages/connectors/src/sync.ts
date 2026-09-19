import { randomUUID } from 'node:crypto';
import { syncRequestSchema, syncResultSchema, type ConnectorCursor, type SyncRequest, type SyncResult }
  from '@unai/domain';
import { ConnectorError, storedSensitivity } from './manifests.js';
import {
  CONNECTOR_SYNC_PURPOSE, grantedCapabilities, loadConnector, type ConnectorTransaction,
} from './grants.js';
import type { ConnectorClient } from './providers.js';

/**
 * One connector sync run (design `POST /v1/connectors/{id}/sync`).
 *
 * Three properties are the criterion:
 *
 *  1. It resumes. An incremental run starts from the cursor stored on the
 *     connector row and writes the provider's next cursor back, so a second run
 *     asks the provider the question the first one stopped at (CRT-CON-06-A).
 *  2. A redelivered item creates no duplicate. Ingestion is idempotent on
 *     (owner, connector, source type, external id, content hash), so a page the
 *     provider sends twice is counted as suppressed rather than stored again.
 *  3. Only granted capabilities are exercised. A partial grant narrows what is
 *     even requested and what is stored -- Gmail without `gmail.read_content`
 *     ingests thread metadata and no message body -- and a payload whose
 *     capability was never granted is refused by name (CRT-CON-07-A).
 *
 * It writes no belief and imports no belief-transaction code: a connector
 * produces evidence and nothing else (PRD §10.1, CRT-CON-09-A).
 */

/** The durable ingest path, supplied by the caller. Keeping it a port is what
 * keeps this package free of object storage, of the extraction worker and of the
 * canonical write path. */
export type SourceIngest = (tx: ConnectorTransaction, request: {
  readonly sourceType: string;
  readonly connectorId: string | null;
  readonly payload: unknown;
  readonly sensitivity: 'NORMAL' | 'PRIVATE' | 'RESTRICTED';
  readonly allowedPurposes: readonly string[];
}) => Promise<readonly {
  readonly evidenceId: string; readonly stored: boolean;
  readonly externalId: string; readonly parentExternalId: string | null;
}[]>;

interface PreparedPayload {
  readonly sourceType: string;
  readonly payload: unknown;
  readonly externalRef: string;
  /** Provider events this payload folds into one aggregated episode. */
  readonly aggregatedEvents: number;
  readonly capabilityUsed: string;
}
interface Refusal {
  readonly externalRef: string; readonly code: string; readonly capabilityId: string | null;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}
function list(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function reference(value: unknown, fallback: string): string {
  return typeof value === 'string' && value !== '' ? value.slice(0, 512) : fallback;
}

/**
 * Narrow one raw payload to what the granted capabilities permit, or refuse it.
 *
 * The narrowing happens on the *raw* payload, before parsing, so the content
 * hash of what is stored describes exactly what was read: a thread ingested
 * without `gmail.read_content` stores headers and no body, and it is a different
 * evidence row from the same thread ingested later with content granted, which
 * is the honest record of two different reads.
 */
export function prepareForCapabilities(
  connectorType: string, payload: unknown, granted: readonly string[],
): PreparedPayload | Refusal {
  const body = record(payload);
  switch (connectorType) {
    case 'CONVERSATION': {
      const externalRef = reference(body['conversationId'], 'conversation');
      const messages = list(body['messages']).filter(entry => {
        const role = record(entry)['role'];
        return role === 'ASSISTANT'
          ? granted.includes('conversation.read_assistant_messages')
          : granted.includes('conversation.read_user_messages');
      });
      if (messages.length === 0) {
        return { externalRef, code: 'CONNECTOR_CAPABILITY_NOT_GRANTED', capabilityId: 'conversation.read_user_messages' };
      }
      return {
        sourceType: 'CONVERSATION', payload: { ...body, messages }, externalRef, aggregatedEvents: 0,
        capabilityUsed: 'conversation.read_user_messages',
      };
    }
    case 'GMAIL': {
      const externalRef = reference(body['id'], 'thread');
      if (!granted.includes('gmail.read_metadata')) {
        return { externalRef, code: 'CONNECTOR_CAPABILITY_NOT_GRANTED', capabilityId: 'gmail.read_metadata' };
      }
      const content = granted.includes('gmail.read_content');
      const messages = list(body['messages']).map(entry => {
        const message = record(entry);
        const messagePayload = record(message['payload']);
        return {
          ...message,
          payload: {
            ...messagePayload,
            body: content ? record(messagePayload['body']) : { ...record(messagePayload['body']), text: '' },
          },
        };
      });
      return {
        sourceType: 'GMAIL', payload: { ...body, messages }, externalRef, aggregatedEvents: 0,
        capabilityUsed: content ? 'gmail.read_content' : 'gmail.read_metadata',
      };
    }
    case 'GOOGLE_CALENDAR': {
      const externalRef = reference(body['id'], 'event');
      if (!granted.includes('calendar.read')) {
        return { externalRef, code: 'CONNECTOR_CAPABILITY_NOT_GRANTED', capabilityId: 'calendar.read' };
      }
      return { sourceType: 'GOOGLE_CALENDAR', payload, externalRef, aggregatedEvents: 0, capabilityUsed: 'calendar.read' };
    }
    case 'GITHUB': {
      const issue = record(body['issue']);
      const externalRef = reference(record(body['repository'])['full_name'], 'repository')
        + '#' + String(issue['number'] ?? '');
      const pullRequest = issue['pull_request'] !== undefined;
      const capabilityId = pullRequest ? 'github.read_pull_requests' : 'github.read_issues';
      if (!granted.includes(capabilityId)) {
        return { externalRef, code: 'CONNECTOR_CAPABILITY_NOT_GRANTED', capabilityId };
      }
      return {
        sourceType: 'GITHUB', payload, externalRef,
        // Commits and CI runs on this pull request become one episode item.
        aggregatedEvents: list(body['commits']).length + list(body['check_runs']).length,
        capabilityUsed: capabilityId,
      };
    }
    case 'DOCUMENT': {
      const externalRef = reference(body['documentId'], 'document');
      if (!granted.includes('documents.upload')) {
        return { externalRef, code: 'CONNECTOR_CAPABILITY_NOT_GRANTED', capabilityId: 'documents.upload' };
      }
      return { sourceType: 'DOCUMENT', payload, externalRef, aggregatedEvents: 0, capabilityUsed: 'documents.upload' };
    }
    default:
      return { externalRef: connectorType, code: 'CONNECTOR_TYPE_UNSUPPORTED', capabilityId: null };
  }
}

function isRefusal(value: PreparedPayload | Refusal): value is Refusal {
  return (value as Refusal).code !== undefined;
}

export async function runConnectorSync(tx: ConnectorTransaction, input: {
  readonly connectorId: string;
  readonly request: SyncRequest;
  readonly client: ConnectorClient;
  readonly ingest: SourceIngest;
}): Promise<SyncResult> {
  if (tx.context.purpose !== CONNECTOR_SYNC_PURPOSE) {
    throw new ConnectorError('CONNECTOR_PURPOSE_REFUSED', { purpose: tx.context.purpose });
  }
  const request = syncRequestSchema.parse(input.request);
  const connector = await loadConnector(tx, input.connectorId);
  // Disconnect stops ingestion, and so does a revoked token: neither is a
  // connector a sync may read through (CRT-CON-06-A). A *failed* sync is the one
  // state that is retryable -- the owner's consent and the stored cursor both
  // survive a provider outage -- so this run clears the failure and returns the
  // connector to ACTIVE before reading anything. It must happen here rather than
  // at the end: migration 0018's `connector_ingestion_active` trigger refuses an
  // evidence row whose connector is not ACTIVE, so a retry that only cleared the
  // error on success could never store the page that proved it succeeded.
  if (connector.status === 'SYNC_FAILED') {
    await tx.query(
      `UPDATE connectors SET status='ACTIVE',last_sync_error=NULL,updated_at=now()
       WHERE id=$1 AND owner_scope_id=$2 AND status='SYNC_FAILED'`,
      [input.connectorId, tx.context.ownerScopeId]);
  } else if (connector.status !== 'ACTIVE') {
    throw new ConnectorError('CONNECTOR_INGESTION_STOPPED',
      { connectorId: input.connectorId, status: connector.status });
  }
  const granted = await grantedCapabilities(tx, input.connectorId);
  if (granted.length === 0) {
    throw new ConnectorError('CONNECTOR_CAPABILITY_NOT_GRANTED',
      { connectorId: input.connectorId, capabilityId: connector.manifest.minimumSyncCapability });
  }
  // BACKFILL deliberately ignores the stored cursor; INCREMENTAL resumes from it.
  const resumedFromCursor: ConnectorCursor | null = request.mode === 'BACKFILL' ? null : connector.cursor;
  // The manifest's declared default is a floor the request may raise and may not
  // lower, so a caller cannot store Gmail content at NORMAL by asking for it.
  const sensitivity = storedSensitivity(connector.manifest, request.sensitivity);

  let cursor = resumedFromCursor;
  let pagesFetched = 0, itemsIngested = 0, duplicatesSuppressed = 0;
  let episodesAggregated = 0, aggregatedEvents = 0, threadUpdatesApplied = 0, recurrenceUpdatesApplied = 0;
  const evidenceIds: string[] = [];
  const refusals: Refusal[] = [];

  for (let page = 0; page < request.maxPages; page++) {
    const answer = await input.client.fetchPage({
      cursor, capabilities: granted, externalAccountRef: connector.externalAccountRef, limit: 50,
    });
    pagesFetched += 1;
    for (const payload of answer.payloads) {
      const prepared = prepareForCapabilities(connector.connectorType, payload, granted);
      if (isRefusal(prepared)) { refusals.push(prepared); continue; }
      const imported = await input.ingest(tx, {
        sourceType: prepared.sourceType, connectorId: input.connectorId, payload: prepared.payload,
        sensitivity, allowedPurposes: request.allowedPurposes,
      });
      for (const item of imported) {
        if (item.stored) { itemsIngested += 1; evidenceIds.push(item.evidenceId); }
        else duplicatesSuppressed += 1;
        if (prepared.sourceType === 'GMAIL' && item.parentExternalId !== null) threadUpdatesApplied += 1;
        if (prepared.sourceType === 'GOOGLE_CALENDAR' && item.parentExternalId !== null) recurrenceUpdatesApplied += 1;
        if (item.externalId.endsWith('/episode')) {
          episodesAggregated += 1;
          aggregatedEvents += prepared.aggregatedEvents;
        }
      }
    }
    cursor = answer.nextCursor;
    if (answer.nextCursor === null || answer.payloads.length === 0) break;
  }

  if (cursor !== null) {
    await tx.query(
      `UPDATE connectors SET last_cursor=$3::jsonb,cursor_updated_at=now(),last_sync_error=NULL,updated_at=now()
       WHERE id=$1 AND owner_scope_id=$2`,
      [input.connectorId, tx.context.ownerScopeId, JSON.stringify(cursor)]);
  }
  return syncResultSchema.parse({
    syncRunId: randomUUID(), connectorId: input.connectorId, mode: request.mode,
    requestedSensitivity: request.sensitivity, storedSensitivity: sensitivity,
    resumedFromCursor, newCursor: cursor, pagesFetched, itemsIngested, duplicatesSuppressed,
    episodesAggregated, aggregatedEvents, threadUpdatesApplied, recurrenceUpdatesApplied,
    evidenceIds: evidenceIds.slice(0, 2000), refusals: refusals.slice(0, 200),
  });
}

/** Record a failed run on the connector, under the sync's own purpose. The
 * status the screen shows is "sync failed with a named reason"; the consent
 * state and the credential are untouched, because a failure is not a revocation.
 * A connector already in `SYNC_FAILED` is updated too, so the reason shown is
 * the reason of the latest attempt rather than of the first one. */
export async function recordSyncFailure(
  tx: ConnectorTransaction, connectorId: string, code: string,
): Promise<void> {
  if (tx.context.purpose !== CONNECTOR_SYNC_PURPOSE) {
    throw new ConnectorError('CONNECTOR_PURPOSE_REFUSED', { purpose: tx.context.purpose });
  }
  await tx.query(
    `UPDATE connectors SET status='SYNC_FAILED',last_sync_error=$3,updated_at=now()
     WHERE id=$1 AND owner_scope_id=$2 AND status IN ('ACTIVE','SYNC_FAILED')`,
    [connectorId, tx.context.ownerScopeId, /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'CONNECTOR_SYNC_FAILED']);
}
