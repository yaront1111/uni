import { randomUUID } from 'node:crypto';
import {
  connectorCursorSchema, createConnectorSchema, disconnectResultSchema, publicConnectorSchema,
  type ConnectorCursor, type ConnectorManifest, type CreateConnector, type DisconnectResult,
  type ManifestCapability, type PublicCapabilityGrant, type PublicConnector,
} from '@unai/domain';
import { ConnectorError, capabilityOf, isWriteScope, manifestFor, requestedScopes, WRITE_CAPABILITIES }
  from './manifests.js';

/**
 * Connector records and their capability grants.
 *
 * The rule the whole file exists for: authority is per capability. Every grant is
 * its own row, `requireCapability` asks for one capability by name, and no code
 * path anywhere widens a grant to a sibling capability of the same connector
 * (CRT-CON-07-A). Disconnect is the same rule read backwards: it revokes every
 * grant, destroys the credential handle and sets the status that the schema's
 * own trigger uses to refuse further ingestion (CRT-CON-06-A).
 */

export const CONNECTOR_READ_PURPOSE = 'connector.read';
export const CONNECTOR_MANAGE_PURPOSE = 'connector.manage';
export const CONNECTOR_SYNC_PURPOSE = 'connector.sync';

/** The transaction shape this package needs: the owner transaction the caller
 * opened, and nothing of the pool behind it. */
export interface ConnectorTransaction {
  readonly context: { readonly ownerScopeId: string; readonly actorId: string; readonly purpose: string; readonly correlationId: string };
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Record<string, any>[]; rowCount: number | null }>;
}

const CONNECTOR_COLUMNS = `id,owner_scope_id,connector_type,external_account_ref,permission_manifest,status,
  created_at,last_cursor,secret_ref,manifest_version,cursor_updated_at,disconnected_at,last_sync_error,updated_at`;

function requirePurpose(tx: ConnectorTransaction, ...allowed: string[]): void {
  if (!allowed.includes(tx.context.purpose)) {
    throw new ConnectorError('CONNECTOR_PURPOSE_REFUSED', { purpose: tx.context.purpose });
  }
}

/**
 * Create one connector and record its manifest's capabilities, each as its own
 * row, granted or not exactly as the request asked.
 *
 * A request naming a write capability is refused before anything is written: V0
 * requests read-only scopes for Gmail, Calendar and GitHub, so a write scope is
 * never part of a consent handoff at all (CRT-CON-02-A/03-A/04-A).
 */
export async function createConnector(tx: ConnectorTransaction, input: CreateConnector): Promise<PublicConnector> {
  requirePurpose(tx, CONNECTOR_MANAGE_PURPOSE);
  const request = createConnectorSchema.parse(input);
  const manifest = manifestFor(request.connectorType);
  for (const requested of request.requestedCapabilities) capabilityOf(manifest, requested.capabilityId);
  assertReadOnly(manifest);
  const granted = new Map(request.requestedCapabilities.map(entry => [entry.capabilityId, entry.granted]));
  const existing = (await tx.query(
    `SELECT ${CONNECTOR_COLUMNS} FROM connectors WHERE owner_scope_id=$1 AND connector_type=$2 AND external_account_ref=$3`,
    [tx.context.ownerScopeId, request.connectorType, request.externalAccountRef])).rows[0];
  if (existing) throw new ConnectorError('CONNECTOR_ALREADY_CONNECTED', { connectorId: existing['id'] as string });
  const id = randomUUID();
  // A connector with no granted capability is not yet usable: it is awaiting the
  // owner's consent, which is exactly the first state the Connected sources
  // screen draws.
  const status = [...granted.values()].some(Boolean) ? 'ACTIVE' : 'PENDING_AUTHORIZATION';
  const inserted = (await tx.query(
    `INSERT INTO connectors(id,owner_scope_id,connector_type,external_account_ref,permission_manifest,status,
       secret_ref,manifest_version)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${CONNECTOR_COLUMNS}`,
    [id, tx.context.ownerScopeId, request.connectorType, request.externalAccountRef,
      JSON.stringify(publicManifest(manifest)), status, request.secretRef, manifest.version])).rows[0];
  if (!inserted) throw new ConnectorError('CONNECTOR_NOT_STORED');
  for (const entry of manifest.capabilities) {
    const isGranted = granted.get(entry.capabilityId) === true;
    await tx.query(
      `INSERT INTO connector_capability_grants(id,owner_scope_id,connector_id,capability_id,risk_class,access_kind,
         granted,granted_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [randomUUID(), tx.context.ownerScopeId, id, entry.capabilityId, entry.riskClass, entry.access,
        isGranted, isGranted ? new Date().toISOString() : null]);
  }
  await tx.query(
    `UPDATE connectors SET updated_at=now() WHERE id=$1 AND owner_scope_id=$2`, [id, tx.context.ownerScopeId]);
  return readConnector(tx, id);
}

/** A manifest may not offer a write capability at all in V0, and every scope of
 * every capability it offers must be a read-only provider scope. This is
 * asserted at every provisioning, not only in a unit test, so a manifest edited
 * later cannot quietly widen an existing deployment. */
export function assertReadOnly(manifest: ConnectorManifest): void {
  for (const entry of manifest.capabilities) {
    if (entry.access === 'WRITE' || WRITE_CAPABILITIES.includes(entry.capabilityId)) {
      throw new ConnectorError('CONNECTOR_WRITE_SCOPE_REFUSED',
        { capabilityId: entry.capabilityId, reason: 'V0_IS_READ_ONLY' });
    }
    const write = entry.scopes.find(isWriteScope);
    if (write !== undefined) {
      throw new ConnectorError('CONNECTOR_WRITE_SCOPE_REFUSED',
        { capabilityId: entry.capabilityId, scope: write, reason: 'WRITE_SCOPE_NOT_REQUESTED_IN_V0' });
    }
  }
}

function publicManifest(manifest: ConnectorManifest): Record<string, unknown> {
  return {
    id: manifest.id, version: manifest.version, connectorType: manifest.connectorType,
    capabilities: manifest.capabilities.map(entry => ({
      capabilityId: entry.capabilityId, access: entry.access, riskClass: entry.riskClass, scopes: entry.scopes,
    })),
    sources: manifest.sources, emits: manifest.emits, sensitivity: manifest.sensitivity,
    retention: manifest.retention, requiredSecrets: manifest.requiredSecrets,
    promptInjectionRisk: manifest.promptInjectionRisk,
  };
}

interface ConnectorRow {
  readonly id: string; readonly connectorType: string; readonly externalAccountRef: string;
  readonly status: string; readonly secretRef: string | null; readonly cursor: ConnectorCursor | null;
  readonly manifest: ConnectorManifest;
}

/** The stored row plus the manifest it was provisioned against. */
export async function loadConnector(tx: ConnectorTransaction, connectorId: string): Promise<ConnectorRow> {
  const row = (await tx.query(
    `SELECT ${CONNECTOR_COLUMNS} FROM connectors WHERE id=$1 AND owner_scope_id=$2`,
    [connectorId, tx.context.ownerScopeId])).rows[0];
  if (!row) throw new ConnectorError('CONNECTOR_NOT_FOUND', { connectorId });
  return {
    id: row['id'] as string, connectorType: row['connector_type'] as string,
    externalAccountRef: row['external_account_ref'] as string, status: row['status'] as string,
    secretRef: (row['secret_ref'] as string | null) ?? null,
    cursor: row['last_cursor'] === null || row['last_cursor'] === undefined
      ? null : connectorCursorSchema.parse(row['last_cursor']),
    manifest: manifestFor(row['connector_type'] as string),
  };
}

export async function listGrants(tx: ConnectorTransaction, connectorId: string): Promise<PublicCapabilityGrant[]> {
  const manifest = (await loadConnector(tx, connectorId)).manifest;
  const rows = (await tx.query(
    `SELECT capability_id,risk_class,access_kind,granted,granted_at,revoked_at FROM connector_capability_grants
     WHERE owner_scope_id=$1 AND connector_id=$2 ORDER BY capability_id`,
    [tx.context.ownerScopeId, connectorId])).rows;
  return rows.map(row => {
    const entry = manifest.capabilities.find(item => item.capabilityId === row['capability_id']);
    return {
      capabilityId: row['capability_id'] as string,
      description: entry?.description ?? 'Capability withdrawn from the manifest.',
      access: row['access_kind'] as 'READ' | 'WRITE',
      riskClass: row['risk_class'] as 'LOW' | 'MEDIUM' | 'HIGH',
      scopes: entry ? [...entry.scopes] : [],
      granted: row['granted'] as boolean,
      grantedAt: row['granted_at'] ? (row['granted_at'] as Date).toISOString() : null,
      revokedAt: row['revoked_at'] ? (row['revoked_at'] as Date).toISOString() : null,
    };
  });
}

/** The capability ids currently granted and not revoked. */
export async function grantedCapabilities(tx: ConnectorTransaction, connectorId: string): Promise<string[]> {
  const rows = (await tx.query(
    `SELECT capability_id FROM connector_capability_grants
     WHERE owner_scope_id=$1 AND connector_id=$2 AND granted AND revoked_at IS NULL ORDER BY capability_id`,
    [tx.context.ownerScopeId, connectorId])).rows;
  return rows.map(row => row['capability_id'] as string);
}

/**
 * The single enforcement point: an operation may proceed only when *this*
 * capability is granted.
 *
 * It answers the grant it found, so a caller can record which authority it acted
 * under. It never looks at another capability of the same connector, which is
 * what makes "granting gmail.read_metadata does not permit gmail.read_content"
 * a property of the code rather than of a convention (CRT-CON-07-A).
 */
export async function requireCapability(
  tx: ConnectorTransaction, connectorId: string, capabilityId: string,
): Promise<ManifestCapability> {
  const connector = await loadConnector(tx, connectorId);
  const entry = capabilityOf(connector.manifest, capabilityId);
  if (entry.access !== 'READ') {
    throw new ConnectorError('CONNECTOR_WRITE_SCOPE_REFUSED', { capabilityId, reason: 'V0_IS_READ_ONLY' });
  }
  if (connector.status === 'DISCONNECTED' || connector.status === 'TOKEN_REVOKED') {
    throw new ConnectorError('CONNECTOR_INGESTION_STOPPED', { connectorId, status: connector.status });
  }
  const row = (await tx.query(
    `SELECT granted,revoked_at FROM connector_capability_grants
     WHERE owner_scope_id=$1 AND connector_id=$2 AND capability_id=$3`,
    [tx.context.ownerScopeId, connectorId, capabilityId])).rows[0];
  if (!row || row['granted'] !== true || row['revoked_at'] !== null) {
    throw new ConnectorError('CONNECTOR_CAPABILITY_NOT_GRANTED', { connectorId, capabilityId });
  }
  return entry;
}

/** Whether one capability is granted, without raising. Used where a partial
 * grant narrows what is ingested rather than refusing the operation. */
export async function hasCapability(
  tx: ConnectorTransaction, connectorId: string, capabilityId: string,
): Promise<boolean> {
  try { await requireCapability(tx, connectorId, capabilityId); return true; }
  catch (error) {
    if (error instanceof ConnectorError && error.message === 'CONNECTOR_CAPABILITY_NOT_GRANTED') return false;
    throw error;
  }
}

/**
 * Set the grant flag of one or more discrete capabilities.
 *
 * Each capability moves on its own. Granting `gmail.read_metadata` in a request
 * that says nothing about `gmail.read_content` leaves the second row exactly as
 * it was, and a request naming a write capability is refused with the reason
 * rather than partially applied.
 */
export async function setCapabilityGrants(
  tx: ConnectorTransaction, connectorId: string,
  requested: readonly { readonly capabilityId: string; readonly granted: boolean }[],
): Promise<PublicCapabilityGrant[]> {
  requirePurpose(tx, CONNECTOR_MANAGE_PURPOSE);
  const connector = await loadConnector(tx, connectorId);
  if (connector.status === 'DISCONNECTED') {
    throw new ConnectorError('CONNECTOR_DISCONNECTED', { connectorId });
  }
  // Validate every entry before writing any of them: a refused write capability
  // must not leave half a consent decision behind.
  const entries = requested.map(item => ({ item, capability: capabilityOf(connector.manifest, item.capabilityId) }));
  for (const { item, capability } of entries) {
    if (item.granted && capability.access !== 'READ') {
      throw new ConnectorError('CONNECTOR_WRITE_SCOPE_REFUSED',
        { capabilityId: item.capabilityId, reason: 'V0_IS_READ_ONLY' });
    }
  }
  const now = new Date().toISOString();
  for (const { item } of entries) {
    const changed = await tx.query(
      `UPDATE connector_capability_grants
       SET granted=$4,granted_at=CASE WHEN $4 THEN coalesce(granted_at,$5::timestamptz) ELSE granted_at END,
           revoked_at=CASE WHEN $4 THEN NULL WHEN granted THEN $5::timestamptz ELSE revoked_at END
       WHERE owner_scope_id=$1 AND connector_id=$2 AND capability_id=$3 RETURNING id`,
      [tx.context.ownerScopeId, connectorId, item.capabilityId, item.granted, now]);
    if (changed.rowCount !== 1) throw new ConnectorError('CONNECTOR_CAPABILITY_UNKNOWN', { capabilityId: item.capabilityId });
  }
  const granted = await grantedCapabilities(tx, connectorId);
  const status = granted.length > 0 ? 'ACTIVE' : 'PENDING_AUTHORIZATION';
  if (connector.status !== status && (connector.status === 'ACTIVE' || connector.status === 'PENDING_AUTHORIZATION')) {
    await tx.query('UPDATE connectors SET status=$3,updated_at=now() WHERE id=$1 AND owner_scope_id=$2',
      [connectorId, tx.context.ownerScopeId, status]);
  }
  return listGrants(tx, connectorId);
}

export async function readConnector(tx: ConnectorTransaction, connectorId: string): Promise<PublicConnector> {
  const row = (await tx.query(
    `SELECT ${CONNECTOR_COLUMNS} FROM connectors WHERE id=$1 AND owner_scope_id=$2`,
    [connectorId, tx.context.ownerScopeId])).rows[0];
  if (!row) throw new ConnectorError('CONNECTOR_NOT_FOUND', { connectorId });
  const manifest = manifestFor(row['connector_type'] as string);
  const capabilities = await listGrants(tx, connectorId);
  const granted = capabilities.filter(entry => entry.granted && entry.revokedAt === null)
    .map(entry => entry.capabilityId);
  // The secret handle is never in a public DTO. `credentialHeld` is the only
  // thing a screen needs to know about it (PRD §30.5).
  return publicConnectorSchema.parse({
    connectorId: row['id'], connectorType: row['connector_type'], manifestId: manifest.id,
    manifestVersion: (row['manifest_version'] as string | null) ?? manifest.version,
    displayName: manifest.displayName, externalAccountRef: row['external_account_ref'],
    status: row['status'], promptInjectionRisk: manifest.promptInjectionRisk,
    capabilities, grantedCapabilities: granted, requestedScopes: requestedScopes(manifest, granted),
    cursor: row['last_cursor'] === null || row['last_cursor'] === undefined
      ? null : connectorCursorSchema.parse(row['last_cursor']),
    cursorUpdatedAt: row['cursor_updated_at'] ? (row['cursor_updated_at'] as Date).toISOString() : null,
    lastSyncError: (row['last_sync_error'] as string | null) ?? null,
    credentialHeld: row['secret_ref'] !== null && row['secret_ref'] !== undefined,
    createdAt: (row['created_at'] as Date).toISOString(),
    disconnectedAt: row['disconnected_at'] ? (row['disconnected_at'] as Date).toISOString() : null,
  });
}

export async function listConnectors(tx: ConnectorTransaction): Promise<PublicConnector[]> {
  const rows = (await tx.query(
    'SELECT id FROM connectors WHERE owner_scope_id=$1 ORDER BY created_at,id', [tx.context.ownerScopeId])).rows;
  const connectors: PublicConnector[] = [];
  for (const row of rows) connectors.push(await readConnector(tx, row['id'] as string));
  return connectors;
}

/** A provider-side revocation: the connector needs reauthorization and ingests
 * nothing until it has it. The evidence already stored is untouched.
 *
 * It runs under `connector.manage` and not under `connector.sync`, because
 * clearing the credential handle is a change of authority and migration 0018's
 * trigger refuses one from a sync. A sync that meets a revoked token records
 * `SYNC_FAILED` with the reason and leaves the consent state to the owner. */
export async function markTokenRevoked(tx: ConnectorTransaction, connectorId: string): Promise<PublicConnector> {
  requirePurpose(tx, CONNECTOR_MANAGE_PURPOSE);
  const connector = await loadConnector(tx, connectorId);
  if (connector.status === 'DISCONNECTED') throw new ConnectorError('CONNECTOR_DISCONNECTED', { connectorId });
  await tx.query(
    `UPDATE connectors SET status='TOKEN_REVOKED',secret_ref=NULL,last_sync_error='CONNECTOR_TOKEN_REVOKED',
       updated_at=now() WHERE id=$1 AND owner_scope_id=$2`,
    [connectorId, tx.context.ownerScopeId]);
  return readConnector(tx, connectorId);
}

/** What a disconnect asks the provider to do. The default adapter is a real
 * HTTPS revocation call; a connector with no credential has nothing to revoke. */
export type TokenRevoker = (input: { readonly connectorType: string; readonly secretRef: string })
  => Promise<{ readonly revoked: boolean }>;

/**
 * Disconnect: revoke the tokens at the provider, destroy the credential handle,
 * revoke every capability, and stop ingestion (CRT-CON-06-A).
 *
 * The order matters. The provider call happens first, because a failed
 * revocation must not be recorded as a completed one; then the row moves to
 * DISCONNECTED with `secret_ref` NULL, which is the state migration 0018's
 * trigger reads to refuse any further evidence row naming this connector. The
 * evidence already stored stays exactly where it is, and the owner is offered
 * the deletion path rather than having it taken.
 */
export async function disconnectConnector(
  tx: ConnectorTransaction, connectorId: string, revoke?: TokenRevoker,
): Promise<DisconnectResult> {
  requirePurpose(tx, CONNECTOR_MANAGE_PURPOSE);
  const connector = await loadConnector(tx, connectorId);
  if (connector.status === 'DISCONNECTED') throw new ConnectorError('CONNECTOR_DISCONNECTED', { connectorId });
  let revoked = false;
  if (connector.secretRef !== null) {
    if (!revoke) throw new ConnectorError('CONNECTOR_REVOCATION_UNAVAILABLE', { connectorId });
    const answer = await revoke({ connectorType: connector.connectorType, secretRef: connector.secretRef });
    if (!answer.revoked) throw new ConnectorError('CONNECTOR_REVOCATION_FAILED', { connectorId });
    revoked = true;
  }
  const capabilities = await grantedCapabilities(tx, connectorId);
  const now = new Date().toISOString();
  await tx.query(
    `UPDATE connector_capability_grants SET granted=false,revoked_at=coalesce(revoked_at,$3::timestamptz)
     WHERE owner_scope_id=$1 AND connector_id=$2 AND granted`,
    [tx.context.ownerScopeId, connectorId, now]);
  await tx.query(
    `UPDATE connectors SET status='DISCONNECTED',disconnected_at=now(),secret_ref=NULL,last_cursor=NULL,
       last_sync_error=NULL,updated_at=now() WHERE id=$1 AND owner_scope_id=$2`,
    [connectorId, tx.context.ownerScopeId]);
  return disconnectResultSchema.parse({
    connectorId, status: 'DISCONNECTED', tokensRevokedAtProvider: revoked, secretReferenceDestroyed: true,
    ingestionStopped: true, capabilitiesRevoked: capabilities,
    retainedEvidence: 'RETAINED', retainedEvidenceOptions: ['KEEP_EVIDENCE', 'REQUEST_DELETION'],
  });
}
