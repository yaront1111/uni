import { randomUUID } from 'node:crypto';
import {
  dataRequestSummarySchema, domainSensitivityEntrySchema,
  domainSensitivityUpdateSchema, permissionsViewSchema, publicPluginCapabilitySchema, retentionRuleSchema,
  retentionUpdateSchema, setPluginCapabilitiesSchema,
  type AttentionBudget, type PermissionsView, type PublicConnector, type PublicPluginCapability, type RetentionRule,
} from '@unai/domain';
import { CONNECTOR_MANIFESTS } from '@unai/connectors';
import { ControlError, iso, requirePurpose, type ControlTransaction } from './transaction.js';
import { PLUGIN_CAPABILITIES, pluginCapabilityOf } from './catalog.js';

/**
 * The Permissions and integrations surface (PRD §7.8; CRT-UX-09-A).
 *
 * Every setting here is a row the *next* operation reads: a sync or an upload
 * reads the domain sensitivity it stores at, a draft reads its plugin capability
 * grant, a clarification decision reads the attention budget (the memory
 * inbox's setting, ADR 0029, shown here) and a cleanup run
 * reads the retention rule. Nothing is cached, so a saved change takes effect on
 * the operation after it and on no operation before it.
 */

export const PERMISSIONS_READ_PURPOSE = 'permissions.read';
export const PERMISSIONS_MANAGE_PURPOSE = 'permissions.manage';

// ---------------------------------------------------------------------------
// Plugin capabilities

export async function listPluginCapabilities(tx: ControlTransaction): Promise<PublicPluginCapability[]> {
  const rows = new Map((await tx.query(
    'SELECT capability_id,granted,granted_at,revoked_at FROM plugin_capability_grants WHERE owner_scope_id=$1',
    [tx.context.ownerScopeId])).rows.map(row => [row['capability_id'] as string, row]));
  return PLUGIN_CAPABILITIES.map(entry => {
    const row = rows.get(entry.capabilityId);
    return publicPluginCapabilitySchema.parse({
      capabilityId: entry.capabilityId, description: entry.description, access: entry.access,
      riskClass: entry.riskClass, grantable: entry.access === 'DRAFT',
      granted: row?.['granted'] === true && row['revoked_at'] === null,
      grantedAt: iso(row?.['granted_at']), revokedAt: iso(row?.['revoked_at']),
    });
  });
}

/** Whether one plugin capability is granted now. Read by every draft, so a
 * revocation stops the very next one. */
export async function pluginCapabilityGranted(tx: ControlTransaction, capabilityId: string): Promise<boolean> {
  const row = (await tx.query(
    'SELECT granted,revoked_at FROM plugin_capability_grants WHERE owner_scope_id=$1 AND capability_id=$2',
    [tx.context.ownerScopeId, capabilityId])).rows[0];
  return row?.['granted'] === true && row['revoked_at'] === null;
}

/**
 * Grant or withhold discrete plugin capabilities, each on its own.
 *
 * Every entry is validated before any is written, so a request that also names
 * an external write is refused whole, with the capability named, and changes
 * nothing (CRT-CON-08-A). The schema refuses a granted WRITE row as well.
 */
export async function setPluginCapabilities(tx: ControlTransaction, raw: unknown): Promise<PublicPluginCapability[]> {
  requirePurpose(tx, PERMISSIONS_MANAGE_PURPOSE);
  const request = setPluginCapabilitiesSchema.parse(raw);
  for (const item of request.capabilities) {
    const entry = pluginCapabilityOf(item.capabilityId);
    if (!entry) throw new ControlError('PLUGIN_CAPABILITY_UNKNOWN', { capabilityId: item.capabilityId });
    if (item.granted && entry.access !== 'DRAFT') {
      throw new ControlError('PLUGIN_CAPABILITY_WRITE_REFUSED',
        { capabilityId: item.capabilityId, reason: 'V0_REFUSES_EXTERNAL_WRITES' });
    }
  }
  const now = new Date().toISOString();
  for (const item of request.capabilities) {
    const entry = pluginCapabilityOf(item.capabilityId)!;
    await tx.query(
      `INSERT INTO plugin_capability_grants(id,owner_scope_id,capability_id,access_kind,risk_class,granted,granted_at)
       VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $6 THEN $7::timestamptz END)
       ON CONFLICT (owner_scope_id,capability_id) DO UPDATE SET
         granted=EXCLUDED.granted,
         granted_at=CASE WHEN EXCLUDED.granted THEN coalesce(plugin_capability_grants.granted_at,$7::timestamptz)
           ELSE plugin_capability_grants.granted_at END,
         revoked_at=CASE WHEN EXCLUDED.granted THEN NULL
           WHEN plugin_capability_grants.granted THEN $7::timestamptz ELSE plugin_capability_grants.revoked_at END,
         updated_at=now()`,
      [randomUUID(), tx.context.ownerScopeId, entry.capabilityId, entry.access, entry.riskClass, item.granted, now]);
  }
  return listPluginCapabilities(tx);
}

// ---------------------------------------------------------------------------
// Retention

export async function readRetention(tx: ControlTransaction): Promise<RetentionRule[]> {
  return (await tx.query(
    `SELECT source_type,raw_retention_days,derived_retention_days,updated_at FROM retention_settings
     WHERE owner_scope_id=$1 ORDER BY source_type`, [tx.context.ownerScopeId])).rows.map(row => retentionRuleSchema.parse({
    sourceType: row['source_type'], rawRetentionDays: row['raw_retention_days'] ?? null,
    derivedRetentionDays: row['derived_retention_days'] ?? null, updatedAt: iso(row['updated_at']),
  }));
}

/** A rule with neither limit returns its source type to "keep until deleted". */
export async function updateRetention(tx: ControlTransaction, raw: unknown): Promise<RetentionRule[]> {
  requirePurpose(tx, PERMISSIONS_MANAGE_PURPOSE);
  const request = retentionUpdateSchema.parse(raw);
  for (const rule of request.rules) {
    if (rule.rawRetentionDays === null && rule.derivedRetentionDays === null) {
      await tx.query('DELETE FROM retention_settings WHERE owner_scope_id=$1 AND source_type=$2',
        [tx.context.ownerScopeId, rule.sourceType]);
      continue;
    }
    await tx.query(
      `INSERT INTO retention_settings(owner_scope_id,source_type,raw_retention_days,derived_retention_days,updated_at)
       VALUES($1,$2,$3,$4,now()) ON CONFLICT (owner_scope_id,source_type) DO UPDATE SET
         raw_retention_days=EXCLUDED.raw_retention_days,derived_retention_days=EXCLUDED.derived_retention_days,updated_at=now()`,
      [tx.context.ownerScopeId, rule.sourceType, rule.rawRetentionDays, rule.derivedRetentionDays]);
  }
  return readRetention(tx);
}

// ---------------------------------------------------------------------------
// Domain sensitivity

export type Sensitivity = 'NORMAL' | 'PRIVATE' | 'RESTRICTED';

export async function readDomainSensitivity(tx: ControlTransaction) {
  const rows = new Map((await tx.query(
    'SELECT source_type,sensitivity,updated_at FROM domain_sensitivity_settings WHERE owner_scope_id=$1',
    [tx.context.ownerScopeId])).rows.map(row => [row['source_type'] as string, row]));
  return [...CONNECTOR_MANIFESTS.values()].map(manifest => {
    const row = rows.get(manifest.connectorType);
    const owner = (row?.['sensitivity'] as Sensitivity | undefined) ?? null;
    return domainSensitivityEntrySchema.parse({
      sourceType: manifest.connectorType, defaultSensitivity: manifest.sensitivity.default,
      effectiveSensitivity: owner ?? manifest.sensitivity.default, ownerSetting: owner, updatedAt: iso(row?.['updated_at']),
    });
  });
}

/**
 * Record the owner's sensitivity for a connector source type.
 *
 * This is the explicit per-connector consent action ADR 0023 left to this
 * surface: it replaces the manifest's floor for items stored *after* it, in
 * either direction, and never rewrites a stored row (PRD §42).
 */
export async function updateDomainSensitivity(tx: ControlTransaction, raw: unknown) {
  requirePurpose(tx, PERMISSIONS_MANAGE_PURPOSE);
  const request = domainSensitivityUpdateSchema.parse(raw);
  for (const mapping of request.mappings) {
    await tx.query(
      `INSERT INTO domain_sensitivity_settings(owner_scope_id,source_type,sensitivity,updated_at) VALUES($1,$2,$3,now())
       ON CONFLICT (owner_scope_id,source_type) DO UPDATE SET sensitivity=EXCLUDED.sensitivity,updated_at=now()`,
      [tx.context.ownerScopeId, mapping.sourceType, mapping.sensitivity]);
  }
  return readDomainSensitivity(tx);
}

/** The owner's stored-sensitivity setting for one connector type, or null for
 * the manifest default. Read by a sync and by an upload. */
export async function readSensitivityFloor(tx: ControlTransaction, connectorType: string): Promise<Sensitivity | null> {
  const row = (await tx.query(
    'SELECT sensitivity FROM domain_sensitivity_settings WHERE owner_scope_id=$1 AND source_type=$2',
    [tx.context.ownerScopeId, connectorType])).rows[0];
  return (row?.['sensitivity'] as Sensitivity | undefined) ?? null;
}

// ---------------------------------------------------------------------------
// The whole surface

export async function listDataRequests(tx: ControlTransaction) {
  return (await tx.query(
    `SELECT id,request_kind,trigger,status,requested_at,completed_at FROM retention_and_deletion_requests
     WHERE owner_scope_id=$1 ORDER BY requested_at DESC,id LIMIT 20`, [tx.context.ownerScopeId])).rows
    .map(row => dataRequestSummarySchema.parse({
      requestId: row['id'], requestKind: row['request_kind'], trigger: row['trigger'], status: row['status'],
      requestedAt: iso(row['requested_at']), completedAt: iso(row['completed_at']),
    }));
}

/** Compose the Permissions view from what each owner of the data answered. */
export function permissionsView(input: {
  connectors: readonly PublicConnector[];
  domainSensitivity: Awaited<ReturnType<typeof readDomainSensitivity>>;
  pluginCapabilities: readonly PublicPluginCapability[];
  attentionBudget: AttentionBudget;
  retention: readonly RetentionRule[];
  dataRequests: Awaited<ReturnType<typeof listDataRequests>>;
}): PermissionsView {
  return permissionsViewSchema.parse({
    connectedSources: input.connectors.map(connector => ({
      connectorId: connector.connectorId, connectorType: connector.connectorType, displayName: connector.displayName,
      status: connector.status, readScopes: connector.requestedScopes, writeScopes: [],
      grantedCapabilities: connector.grantedCapabilities,
    })),
    domainSensitivity: input.domainSensitivity, pluginCapabilities: input.pluginCapabilities,
    attentionBudget: input.attentionBudget, retention: input.retention, dataRequests: input.dataRequests,
  });
}
