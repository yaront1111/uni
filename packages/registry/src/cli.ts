import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createDatabasePool } from '@unai/postgres';
import { RegistryError, lintRegistryRepository, loadRegistryRelease } from './release.js';
import { publishRegistryRelease } from './snapshot.js';

// CLI only (PRD §35.14): no network registry service exists in V0.
const [group, command, ...rest] = process.argv.slice(2);
const option = (name: string) => { const index = rest.indexOf('--' + name); return index >= 0 ? rest[index + 1] : undefined; };
const event = 'registry.' + (group === 'registry' && command ? command : 'cli');
// Output is a fixed allowlist of identifiers and codes, never contract content.
const fail = (code: string, extra: Record<string, unknown> = {}) => {
  console.error(JSON.stringify({ event, result: 'FAIL', code, ...extra }));
  process.exitCode = 1;
};
const codeOf = (error: unknown) => error instanceof RegistryError ? error.code : 'REGISTRY_COMMAND_FAILED';

/** `--report <path>` keeps the same bounded codes CI prints as a JSON artifact.
 * The operations screen displays that artifact; nothing in the deployment lints
 * (ADR 0014), so the report file is the only lint surface outside the CLI. */
type LintedRelease = { version: string; tag: string; contentHash: string; contracts: number };
async function writeReport(result: 'PASS' | 'FAIL', releases: LintedRelease[], error?: unknown) {
  const path = option('report');
  if (!path) return;
  const issues = error instanceof RegistryError ? error.issues : [];
  await writeFile(path, JSON.stringify({ result, checkedAt: new Date().toISOString(),
    code: result === 'FAIL' ? codeOf(error) : null, releases, issues }, null, 2) + '\n');
}

try {
  if (group === 'registry' && command === 'lint') {
    const version = option('version');
    let releases: LintedRelease[] = [];
    try {
      const linted = (await lintRegistryRepository(process.cwd())).filter(release => !version || release.version === version);
      if (version && linted.length === 0) throw new RegistryError('REGISTRY_RELEASE_NOT_RECORDED');
      releases = linted.map(release => ({ version: release.version, tag: release.tag,
        contentHash: release.contentHash, contracts: release.manifest.contracts.length }));
    } catch (error) {
      await writeReport('FAIL', releases, error);
      throw error;
    }
    await writeReport('PASS', releases);
    console.log(JSON.stringify({ event, result: 'PASS', releases }));
  } else if (group === 'registry' && command === 'publish') {
    const url = process.env.UNAI_MIGRATION_DATABASE_URL, caPath = process.env.UNAI_DATABASE_CA_PATH, version = option('version');
    if (!url || !caPath || !version) throw new RegistryError('REGISTRY_PUBLISH_CONFIGURATION_REQUIRED');
    const correlationId = option('correlation-id') ?? randomUUID();
    const release = await loadRegistryRelease({ repository: process.cwd(), version });
    const pool = createDatabasePool(url, await readFile(caPath, 'utf8'));
    try {
      const published = await publishRegistryRelease(pool, release, correlationId);
      console.log(JSON.stringify({ event, result: 'PASS', ...published, version: release.version, tag: release.tag,
        gitCommit: release.gitCommit, contentHash: release.contentHash, correlationId }));
    } finally { await pool.end(); }
  } else {
    fail('REGISTRY_COMMAND_UNKNOWN');
  }
} catch (error) {
  fail(codeOf(error), error instanceof RegistryError && error.issues.length ? { issues: error.issues } : {});
}
