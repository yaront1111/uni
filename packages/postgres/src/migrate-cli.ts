import { readFile } from 'node:fs/promises';
import { createDatabasePool, runMigrations, assertOwnershipCoverage } from './index.js';

const url = process.env.UNAI_MIGRATION_DATABASE_URL;
const caPath = process.env.UNAI_DATABASE_CA_PATH;
if (!url || !caPath) throw new Error('MIGRATION_TLS_CONFIGURATION_REQUIRED');
const pool = createDatabasePool(url, await readFile(caPath, 'utf8'));
try {
  const applied = await runMigrations(pool, 'migrations');
  await assertOwnershipCoverage(pool);
  console.log(JSON.stringify({ event: 'database.migrated', applied, ownershipCoverage: 'verified' }));
} catch {
  console.error('MIGRATION_OR_OWNERSHIP_VALIDATION_FAILED');
  process.exitCode = 1;
} finally {
  await pool.end();
}
