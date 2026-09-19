import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { assertDatabaseEncryptionAtRest, createDatabasePool } from '@unai/postgres';
import { createDefaultSecretsManager, requireSecret } from '@unai/secrets';
import { resolveConfiguredModelProvider } from '@unai/model';
import { createProcessingRuntime } from './processing-runtime.js';
import { processingConfiguration, processingRequired } from './processing-config.js';
import { createInitiativeRuntime } from './initiative-runtime.js';

async function main() {
  const configuration = processingConfiguration(process.env);
  const secrets = createDefaultSecretsManager();
  const provider = await resolveConfiguredModelProvider({ secrets, env: process.env });
  const ca = readFileSync(processingRequired(process.env, 'UNAI_DATABASE_CA_FILE'), 'utf8');
  const appPool = createDatabasePool(await requireSecret(secrets, 'UNAI_APP_DATABASE_URL'), ca);
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  try {
    await assertDatabaseEncryptionAtRest(appPool);
    const runtime = createProcessingRuntime({ ...configuration, appPool, provider, workerId: 'processor-' + randomUUID() });
    const release = await runtime.validate();
    if (release !== configuration.registryRelease) throw new Error('PROCESSING_RELEASE_MISMATCH');
    if (process.argv.includes('--check')) return;
    const initiative = createInitiativeRuntime({ ...configuration, appPool, workerId: 'initiative-' + randomUUID() });
    while (!abort.signal.aborted) {
      try { await runtime.runOnce(); await initiative.runOnce(); }
      catch { process.stderr.write('PROCESSING_TURN_FAILED\n'); }
      await sleep(configuration.pollMs, undefined, { signal: abort.signal }).catch(() => undefined);
    }
  } finally {
    process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
    await appPool.end();
  }
}
try { await main(); }
catch (error) {
  const code = error instanceof Error && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.message) ? error.message : 'PROCESSING_STARTUP_FAILED';
  process.stderr.write(code + '\n'); process.exitCode = 1;
}
