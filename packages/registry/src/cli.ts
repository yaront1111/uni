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
  } else if (group === 'registry' && command === 'projection-replay') {
    // The projection rebuild runbook (PRD §25.4, §35.14, §49). It runs under the
    // low-privilege application role and the reducer purpose, so RLS decides what
    // it may touch: `memory.project` writes projection rows and is admitted by no
    // policy on any canonical table. The capability package is loaded here and not
    // at the top of the file, so `uai registry lint` still runs with no database
    // driver and no memory package in the process.
    const url = process.env.UNAI_DATABASE_URL, caPath = process.env.UNAI_DATABASE_CA_PATH;
    const ownerScopeId = option('owner-scope'), actorId = option('actor');
    if (!url || !caPath || !ownerScopeId || !actorId) throw new RegistryError('PROJECTION_REPLAY_CONFIGURATION_REQUIRED');
    const asOfText = option('as-of');
    const asOf = asOfText ? new Date(asOfText) : new Date();
    if (Number.isNaN(asOf.getTime())) throw new RegistryError('PROJECTION_REPLAY_AS_OF_INVALID');
    const named = option('projection');
    const projections = !named || named === 'all' ? undefined
      : [named as 'open_commitments_projection' | 'obligations_projection' | 'schedule_projection'];
    const { runProjectionReplay } = await import('@unai/capabilities');
    const { withOwnerTransaction } = await import('@unai/postgres');
    const correlationId = option('correlation-id') ?? randomUUID();
    const pool = createDatabasePool(url, await readFile(caPath, 'utf8'));
    try {
      const result = await withOwnerTransaction(pool,
        { ownerScopeId, actorId, purpose: 'memory.project', correlationId },
        async tx => {
          const replayed = await runProjectionReplay(tx, { ownerScopeId, asOf, ...(projections ? { projections } : {}) });
          await tx.audit({ policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS',
            objects: replayed.receipts.map(receipt => ({ type: 'projection_rebuild_receipts',
              id: receipt.projectionRebuildReceiptId,
              fields: ['projection_name', 'trigger', 'rows_rebuilt', 'equals_incremental'] })) });
          return replayed;
        });
      const report = option('report');
      const summary = { event, result: result.equalsIncremental === false ? 'FAIL' : 'PASS',
        ownerScopeId, asOf: result.asOf, reducerVersion: result.reducerVersion,
        equalsIncremental: result.equalsIncremental,
        receipts: result.receipts.map(receipt => ({ projectionName: receipt.projectionName,
          rowsRebuilt: receipt.rowsRebuilt, equalsIncremental: receipt.equalsIncremental,
          projectionVersion: receipt.projectionVersion, receiptId: receipt.projectionRebuildReceiptId })),
        correlationId };
      if (report) await writeFile(report, JSON.stringify(summary, null, 2) + '\n');
      // A replay that did not reproduce the incremental state is a finding, and CI
      // has to see it as one rather than as a successful rebuild.
      if (result.equalsIncremental === false) { fail('PROJECTION_REPLAY_DIVERGED', { receipts: summary.receipts }); }
      else console.log(JSON.stringify(summary));
    } finally { await pool.end(); }
  } else {
    fail('REGISTRY_COMMAND_UNKNOWN');
  }
} catch (error) {
  fail(codeOf(error), error instanceof RegistryError && error.issues.length ? { issues: error.issues } : {});
}
