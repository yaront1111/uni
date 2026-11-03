import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import {startTelemetry,startupFailureCode,type Telemetry} from '@unai/observability/telemetry';
// One extraction (processing-runtime, 300s), initiative (initiative-runtime, 300s) and
// connector sync (connector-sync-job, 600s) attempt per turn, plus 600s for a retention
// drain; beyond that a busy turn is wedged. While idle the limit is 3 * pollMs.
const PROCESSING_TURN_LIMIT_MS = (300 + 300 + 600 + 600) * 1000;
// Workspace modules create instruments at evaluation time; metrics has no proxy.
// ESM evaluates static imports before this body, even beside a top-level await.
// Start the SDK first, then load application modules so meters are not permanent no-ops.
let telemetry:Telemetry|undefined;
try { telemetry=await startTelemetry({serviceName:'unai-worker',version:'0.1.0'});await main(); }
catch (error) {
  const failure = startupFailureCode(error);
  process.stderr.write(JSON.stringify({event:'startup_failed',code:failure?.code??'PROCESSING_STARTUP_FAILED',variable:failure?.variable??null})+'\n');
  process.exitCode = 1;
}
finally { await telemetry?.shutdown(); }

async function main() {
  const { assertDatabaseEncryptionAtRest, createDatabasePool }=await import('@unai/postgres');
  const { createDefaultSecretsManager, requireSecret }=await import('@unai/secrets');
  const { resolveConfiguredModelProvider }=await import('@unai/model');
  const { createProcessingRuntime }=await import('./processing-runtime.js');
  const { processingConfiguration, processingRequired }=await import('./processing-config.js');
  const { createInitiativeRuntime }=await import('./initiative-runtime.js');
  const { createEvidenceObjects }=await import('./evidence.js');
  const { createConnectorRuntime }=await import('./connectors.js');
  const { createConnectorSyncRuntime }=await import('./connector-sync-job.js');
  const { probeConfiguration, createProbeServer, databaseCheck, registryReleaseCheck, createLoopHeartbeat }=await import('./probes.js');
  const { createConnectorSyncScheduler, connectorSyncSchedulerPorts }=await import('./connector-sync-scheduler.js');
  const configuration = processingConfiguration(process.env);
  const probeConfig = probeConfiguration(process.env);
  const secrets = createDefaultSecretsManager();
  const provider = await resolveConfiguredModelProvider({ secrets, env: process.env });
  const ca = readFileSync(processingRequired(process.env, 'UNAI_DATABASE_CA_FILE'), 'utf8');
  const appPool = createDatabasePool(await requireSecret(secrets, 'UNAI_APP_DATABASE_URL'), ca);
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  let evidenceObjects: Awaited<ReturnType<typeof createEvidenceObjects>> | undefined;
  let probes: Awaited<ReturnType<typeof createProbeServer>> | null = null;
  try {
    await assertDatabaseEncryptionAtRest(appPool);
    const runtime = createProcessingRuntime({ ...configuration, appPool, provider, workerId: 'processor-' + randomUUID() });
    const release = await runtime.validate();
    if (release !== configuration.registryRelease) throw new Error('PROCESSING_RELEASE_MISMATCH');
    // connector.sync jobs store evidence objects, so --check proves the bucket too.
    evidenceObjects = await createEvidenceObjects({
      endpoint: processingRequired(process.env, 'UNAI_S3_ENDPOINT'), region: processingRequired(process.env, 'UNAI_S3_REGION'),
      bucket: processingRequired(process.env, 'UNAI_S3_BUCKET'), kmsKeyId: processingRequired(process.env, 'UNAI_S3_KMS_KEY_ID'),
    });
    const scheduler = createConnectorSyncScheduler({ clock: Date.now, intervalMs: configuration.connectorSyncIntervalMs,
      ...connectorSyncSchedulerPorts({ ...configuration, appPool }) });
    const { createRetentionScheduler, retentionSchedulerPorts }=await import('./retention-scheduler.js');
    const retention = createRetentionScheduler({ clock: Date.now, intervalMs: configuration.retentionCleanupIntervalMs,
      ...retentionSchedulerPorts({ ...configuration, appPool, evidenceObjects }) });
    if (process.argv.includes('--check')) return;
    // Timer-driven deployments: one retention cleanup tick and one connector-sync scheduling pass,
    // no probes and no job turns. As in the loop, a failed cleanup never stops the sync pass.
    if (process.argv.includes('--once')) await retention.tick().catch(() => { process.stderr.write('RETENTION_SCHEDULER_TICK_FAILED\n'); process.exitCode = 1; });
    if (process.argv.includes('--once')) { await scheduler.tick(); return; }
    const heartbeat = createLoopHeartbeat({ pollMs: configuration.pollMs, busyLimitMs: PROCESSING_TURN_LIMIT_MS });
    probes = probeConfig && await createProbeServer({ ...probeConfig, checks: {
      database: databaseCheck(appPool), registry_release: registryReleaseCheck(appPool, configuration.registryReleaseId), loop: heartbeat.check,
    } });
    const initiative = createInitiativeRuntime({ ...configuration, appPool, workerId: 'initiative-' + randomUUID() });
    const connectorSync = createConnectorSyncRuntime({ ...configuration, appPool, workerId: 'connector-sync-' + randomUUID(),
      evidenceObjects, connectorClient: createConnectorRuntime(secrets).connectorClient });
    while (!abort.signal.aborted) {
      heartbeat.beat(true);
      try { await runtime.runOnce(); await initiative.runOnce(); await connectorSync.runOnce(); }
      catch { process.stderr.write('PROCESSING_TURN_FAILED\n'); }
      await retention.tickIfDue().catch(() => { process.stderr.write('RETENTION_SCHEDULER_TICK_FAILED\n'); });
      await scheduler.tickIfDue().catch(() => { process.stderr.write('CONNECTOR_SCHEDULER_TICK_FAILED\n'); });
      heartbeat.beat(false);
      await sleep(configuration.pollMs, undefined, { signal: abort.signal }).catch(() => undefined);
    }
  } finally {
    await probes?.close();
    process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
    evidenceObjects?.close();
    await appPool.end();
  }
}
