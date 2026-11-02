import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import {startTelemetry,type Telemetry} from '@unai/observability/telemetry';
// Workspace modules create instruments at evaluation time; metrics has no proxy.
// ESM evaluates static imports before this body, even beside a top-level await.
// Start the SDK first, then load application modules so meters are not permanent no-ops.
let telemetry:Telemetry|undefined;
try { telemetry=await startTelemetry({serviceName:'unai-worker',version:'0.1.0'});await main(); }
catch (error) {
  const code = error instanceof Error && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.message) ? error.message : 'PROCESSING_STARTUP_FAILED';
  process.stderr.write(code + '\n'); process.exitCode = 1;
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
  const configuration = processingConfiguration(process.env);
  const secrets = createDefaultSecretsManager();
  const provider = await resolveConfiguredModelProvider({ secrets, env: process.env });
  const ca = readFileSync(processingRequired(process.env, 'UNAI_DATABASE_CA_FILE'), 'utf8');
  const appPool = createDatabasePool(await requireSecret(secrets, 'UNAI_APP_DATABASE_URL'), ca);
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  let evidenceObjects: Awaited<ReturnType<typeof createEvidenceObjects>> | undefined;
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
    if (process.argv.includes('--check')) return;
    const initiative = createInitiativeRuntime({ ...configuration, appPool, workerId: 'initiative-' + randomUUID() });
    const connectorSync = createConnectorSyncRuntime({ ...configuration, appPool, workerId: 'connector-sync-' + randomUUID(),
      evidenceObjects, connectorClient: createConnectorRuntime(secrets).connectorClient });
    while (!abort.signal.aborted) {
      try { await runtime.runOnce(); await initiative.runOnce(); await connectorSync.runOnce(); }
      catch { process.stderr.write('PROCESSING_TURN_FAILED\n'); }
      await sleep(configuration.pollMs, undefined, { signal: abort.signal }).catch(() => undefined);
    }
  } finally {
    process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
    evidenceObjects?.close();
    await appPool.end();
  }
}
