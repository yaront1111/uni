import { dataPurposeSchema, sensitivitySchema } from '@unai/domain';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function processingRequired(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error('PROCESSING_CONFIGURATION_REQUIRED:'+name);
  return value;
}
export function processingRelease(env: NodeJS.ProcessEnv) {
  const registryReleaseId = processingRequired(env, 'UNAI_REGISTRY_RELEASE_ID');
  const registryRelease = processingRequired(env, 'UNAI_REGISTRY_RELEASE');
  if (!UUID.test(registryReleaseId) || !/^\d+\.\d+\.\d+$/.test(registryRelease)) throw new Error('PROCESSING_CONFIGURATION_INVALID');
  return { registryReleaseId, registryRelease };
}
export function processingConfiguration(env: NodeJS.ProcessEnv) {
  const connectorSyncIntervalMs = connectorSyncInterval(env), retentionCleanupIntervalMs = retentionCleanupInterval(env);
  const release = processingRelease(env);
  const ownerScopeId = processingRequired(env, 'UNAI_PROCESSING_OWNER_SCOPE_ID');
  const actorId = processingRequired(env, 'UNAI_PROCESSING_ACTOR_ID');
  if (!UUID.test(ownerScopeId) || !UUID.test(actorId)) throw new Error('PROCESSING_CONFIGURATION_INVALID');
  const purpose = dataPurposeSchema.safeParse(processingRequired(env, 'UNAI_PROCESSING_DATA_PURPOSE'));
  const sensitivity = sensitivitySchema.safeParse(processingRequired(env, 'UNAI_PROCESSING_MAXIMUM_SENSITIVITY'));
  const pollMs = Number(env.UNAI_PROCESSING_POLL_MS ?? 1000);
  if (!purpose.success || !sensitivity.success || !Number.isInteger(pollMs) || pollMs < 100 || pollMs > 60000) throw new Error('PROCESSING_CONFIGURATION_INVALID');
  return { ...release, ownerScopeId, actorId, dataPurpose: purpose.data, maximumSensitivity: sensitivity.data, pollMs, connectorSyncIntervalMs, retentionCleanupIntervalMs };
}
/** Connector-sync scheduling interval in ms: 900000 when unset or empty, 0 to
 * disable, else an integer 60000 to 86400000. Empty never means 0, so scheduling
 * is only ever switched off explicitly; the one-day cap keeps windows moving. */
export function connectorSyncInterval(env: NodeJS.ProcessEnv): number {
  const raw = env.UNAI_CONNECTOR_SYNC_INTERVAL_MS;
  if (raw === undefined || raw === '') return 900000;
  const value = /^[0-9]{1,8}$/.test(raw) ? Number(raw) : NaN;
  if (value === 0 || (value >= 60000 && value <= 86400000)) return value;
  throw new Error('CONFIG_INVALID:UNAI_CONNECTOR_SYNC_INTERVAL_MS');
}
/** Retention cleanup interval in ms: 86400000 (daily) when unset or empty, 0 to
 * disable, else an integer 3600000 (hourly) to 86400000. Empty never means 0, so
 * the scheduled cleanup is only ever switched off explicitly. */
export function retentionCleanupInterval(env: NodeJS.ProcessEnv): number {
  const raw = env.UNAI_RETENTION_CLEANUP_INTERVAL_MS;
  if (raw === undefined || raw === '') return 86400000;
  const value = /^[0-9]{1,8}$/.test(raw) ? Number(raw) : NaN;
  if (value === 0 || (value >= 3600000 && value <= 86400000)) return value;
  throw new Error('CONFIG_INVALID:UNAI_RETENTION_CLEANUP_INTERVAL_MS');
}
