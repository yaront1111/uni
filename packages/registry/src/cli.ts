import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createDatabasePool } from '@unai/postgres';
import { RegistryError, lintRegistryRepository, loadRegistryRelease, readTaggedMigrationEvidence, type LoadedRegistryRelease } from './release.js';
import { checkMigrationEvidence, type MigrationStatus } from './migration.js';
import { publishRegistryRelease } from './snapshot.js';

// CLI only (PRD §35.14): no network registry service exists in V0. The commands:
//   uai registry lint | test | shadow-diff | projection-replay | publish
//   uai corpus import | annotate | run | verify | status
const [group, command, ...rest] = process.argv.slice(2);
const option = (name: string) => { const index = rest.indexOf('--' + name); return index >= 0 ? rest[index + 1] : undefined; };
const flag = (name: string) => rest.includes('--' + name);
const event = (group === 'registry' || group === 'corpus') && command ? group + '.' + command : 'registry.cli';
// Output is a fixed allowlist of identifiers, codes and counts, never contract,
// corpus or memory content.
const fail = (code: string, extra: Record<string, unknown> = {}) => {
  console.error(JSON.stringify({ event, result: 'FAIL', code, ...extra }));
  process.exitCode = 1;
};
const codeOf = (error: unknown) => error instanceof RegistryError ? error.code : 'REGISTRY_COMMAND_FAILED';
const report = async (value: unknown) => { const path = option('report'); if (path) await writeFile(path, JSON.stringify(value, null, 2) + '\n'); };

/** `--report <path>` keeps the same bounded codes CI prints as a JSON artifact.
 * The operations screen displays that artifact; nothing in the deployment lints
 * (ADR 0014), so the report file is the only lint surface outside the CLI. */
type LintedRelease = { version: string; tag: string; contentHash: string; contracts: number };
async function writeLintReport(result: 'PASS' | 'FAIL', releases: LintedRelease[], migrations: MigrationStatus[], error?: unknown) {
  const issues = error instanceof RegistryError ? error.issues : [];
  await report({ result, checkedAt: new Date().toISOString(), code: result === 'FAIL' ? codeOf(error) : null, releases, issues, migrations });
}

async function recordedRelease(releases: readonly LoadedRegistryRelease[], version: string | undefined) {
  const release = releases.find(entry => entry.version === version);
  if (!release) throw new RegistryError('REGISTRY_RELEASE_NOT_RECORDED');
  return release;
}
async function latestRelease() {
  const releases = await lintRegistryRepository(process.cwd());
  return releases.reduce((latest, release) => {
    const [a, b] = [latest.version.split('.').map(Number), release.version.split('.').map(Number)];
    return (b[0]! - a[0]! || b[1]! - a[1]! || b[2]! - a[2]!) > 0 ? release : latest;
  });
}
function databasePool(variable: 'UNAI_DATABASE_URL' | 'UNAI_MIGRATION_DATABASE_URL', missing: string) {
  const url = process.env[variable], caPath = process.env.UNAI_DATABASE_CA_PATH;
  if (!url || !caPath) throw new RegistryError(missing);
  return readFile(caPath, 'utf8').then(ca => createDatabasePool(url, ca));
}

try {
  if (group === 'registry' && command === 'lint') {
    const version = option('version');
    let releases: LintedRelease[] = [];
    let migrations: MigrationStatus[] = [];
    try {
      const all = await lintRegistryRepository(process.cwd());
      const linted = all.filter(release => !version || release.version === version);
      if (version && linted.length === 0) throw new RegistryError('REGISTRY_RELEASE_NOT_RECORDED');
      releases = linted.map(release => ({ version: release.version, tag: release.tag,
        contentHash: release.contentHash, contracts: release.manifest.contracts.length }));
      // PRD §17.7 / CRT-REG-05-A: an identity-, transition-affecting or breaking
      // release lands only with its migration manifest and the evidence it names.
      const gate = await checkMigrationEvidence(process.cwd(), all);
      migrations = gate.migrations;
      if (gate.issues.length) throw new RegistryError('REGISTRY_MIGRATION_EVIDENCE_REQUIRED', gate.issues);
    } catch (error) {
      await writeLintReport('FAIL', releases, migrations, error);
      throw error;
    }
    await writeLintReport('PASS', releases, migrations);
    console.log(JSON.stringify({ event, result: 'PASS', releases,
      ...(migrations.length ? { migrations: migrations.map(entry => ({ from: entry.from, to: entry.to, changeClass: entry.changeClass })) } : {}) }));
  } else if (group === 'registry' && command === 'test') {
    const { runContractTests } = await import('./contract-tests.js');
    const { corpusDir, loadCorpus } = await import('./corpus.js');
    const releases = await lintRegistryRepository(process.cwd());
    const outcome = runContractTests(releases, await loadCorpus(corpusDir(process.cwd(), 'SYNTHETIC'), 'SYNTHETIC'));
    const failures = outcome.results.flatMap(result => result.failures.map(failure =>
      ({ release: result.release, contract: result.contract, area: result.area, ...failure })));
    await report({ event, result: outcome.result, checkedAt: new Date().toISOString(), results: outcome.results });
    const summary = { releases: releases.map(release => release.version), contracts: new Set(outcome.results.map(result => result.contract)).size,
      areas: new Set(outcome.results.map(result => result.area)).size, cases: outcome.results.reduce((total, result) => total + result.cases, 0) };
    if (outcome.result === 'FAIL') fail('REGISTRY_CONTRACT_TEST_FAILED', { ...summary, failures: failures.slice(0, 100) });
    else console.log(JSON.stringify({ event, result: 'PASS', ...summary }));
  } else if (group === 'registry' && command === 'shadow-diff') {
    // PRD §22.2 Shadow, §43.5 (CRT-WRT-09-A). The sample is a corpus, which
    // touches no database, or an owner's canonical memory, read READ ONLY.
    const { runShadowEvaluation } = await import('./shadow.js');
    const releases = await lintRegistryRepository(process.cwd());
    const baselineRelease = await recordedRelease(releases, option('baseline') ?? releases[0]?.version);
    const candidateRelease = await recordedRelease(releases, option('candidate') ?? baselineRelease.version);
    const runKind = (option('run-kind') ?? 'registry').toUpperCase();
    if (runKind !== 'REGISTRY' && runKind !== 'EXTRACTOR') throw new RegistryError('SHADOW_RUN_KIND_INVALID');
    const sampleOption = option('sample') ?? 'corpus:synthetic';
    const limit = Number(option('limit') ?? '500');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100000) throw new RegistryError('SHADOW_LIMIT_INVALID');
    const correlationId = option('correlation-id') ?? randomUUID();
    let shadow;
    if (sampleOption === 'corpus:synthetic' || sampleOption === 'corpus:private') {
      if (runKind !== 'REGISTRY') throw new RegistryError('SHADOW_EXTRACTOR_NEEDS_OWNER_SAMPLE');
      const { corpusDir, corpusShadowSample, loadCorpus } = await import('./corpus.js');
      const kind = sampleOption === 'corpus:private' ? 'REAL' as const : 'SYNTHETIC' as const;
      const sample = corpusShadowSample(await loadCorpus(corpusDir(process.cwd(), kind), kind), kind);
      shadow = runShadowEvaluation({ runKind: 'REGISTRY', baselineVersion: baselineRelease.version, candidateVersion: candidateRelease.version,
        baselineRelease, candidateRelease, sample });
      await report(shadow);
      console.log(JSON.stringify({ event, result: 'PASS', runId: shadow.runId, runKind: shadow.runKind, sample: sampleOption,
        baselineVersion: shadow.baselineVersion, candidateVersion: shadow.candidateVersion,
        changed: Object.fromEntries(Object.entries(shadow.diffs).filter(([name]) => name !== 'costAndLatency')
          .map(([name, value]) => [name, (value as { changed: number }).changed])), productionUnchanged: null }));
    } else if (sampleOption === 'owner') {
      const ownerScopeId = option('owner-scope'), actorId = option('actor');
      if (!ownerScopeId || !actorId) throw new RegistryError('SHADOW_OWNER_SAMPLE_CONFIGURATION_REQUIRED');
      const extractor = runKind === 'EXTRACTOR' ? { baseline: option('baseline-extractor') ?? '', candidate: option('candidate-extractor') ?? '' } : undefined;
      if (extractor && (!extractor.baseline || !extractor.candidate)) throw new RegistryError('SHADOW_EXTRACTOR_VERSIONS_REQUIRED');
      const pool = await databasePool('UNAI_DATABASE_URL', 'SHADOW_OWNER_SAMPLE_CONFIGURATION_REQUIRED');
      const { withOwnerTransaction } = await import('@unai/postgres');
      const { productionDigest, readOwnerShadowSample, recordShadowRun, SHADOW_READ_PURPOSE, SHADOW_RECORD_PURPOSE } = await import('./shadow-store.js');
      try {
        const context = (purpose: string) => ({ ownerScopeId, actorId, purpose, correlationId });
        const runner = <T,>(purpose: string, readOnly: boolean, run: (tx: import('@unai/postgres').OwnerTransaction) => Promise<T>) =>
          withOwnerTransaction(pool, context(purpose), async tx => {
            // Before any statement of the callback: PostgreSQL then refuses every
            // write in this transaction, whoever attempts it.
            if (readOnly) await tx.query('SET TRANSACTION READ ONLY');
            return run(tx);
          });
        const asOfText = option('as-of');
        const asOf = asOfText ? new Date(asOfText) : new Date();
        if (Number.isNaN(asOf.getTime())) throw new RegistryError('SHADOW_AS_OF_INVALID');
        const { sample, digestBefore } = await readOwnerShadowSample(runner, { ownerScopeId, limit, runKind, asOf,
          ...(extractor ? { extractor } : {}) });
        const draft = runShadowEvaluation({ runKind, baselineVersion: extractor ? extractor.baseline : baselineRelease.version,
          candidateVersion: extractor ? extractor.candidate : candidateRelease.version, baselineRelease, candidateRelease, sample,
          ...(extractor ? { extractor } : {}) });
        const digestAfter = await runner(SHADOW_READ_PURPOSE, true, tx => productionDigest(tx, ownerScopeId));
        shadow = { ...draft, productionUnchanged: digestBefore === digestAfter };
        const recorded = shadow;
        await runner(SHADOW_RECORD_PURPOSE, false, async tx => {
          await recordShadowRun(tx, { ownerScopeId, actorId, correlationId, report: recorded });
          await tx.audit({ policyDecision: 'ALLOW', codeVersion: '0.1.0', result: 'SUCCESS',
            objects: [{ type: 'shadow_evaluation_runs', id: recorded.runId, fields: ['run_kind', 'baseline_version', 'candidate_version',
              'production_unchanged'] }] });
        });
      } finally { await pool.end(); }
      await report(shadow);
      const summary = { runId: shadow.runId, runKind: shadow.runKind, sample: sampleOption, baselineVersion: shadow.baselineVersion,
        candidateVersion: shadow.candidateVersion, productionUnchanged: shadow.productionUnchanged,
        changed: Object.fromEntries(Object.entries(shadow.diffs).filter(([name]) => name !== 'costAndLatency')
          .map(([name, value]) => [name, (value as { changed: number }).changed])), correlationId };
      // A run that changed production state is a failure of the run itself.
      if (shadow.productionUnchanged === false) fail('SHADOW_PRODUCTION_CHANGED', summary);
      else console.log(JSON.stringify({ event, result: 'PASS', ...summary }));
    } else throw new RegistryError('SHADOW_SAMPLE_INVALID');
  } else if (group === 'registry' && command === 'publish') {
    const url = process.env.UNAI_MIGRATION_DATABASE_URL, caPath = process.env.UNAI_DATABASE_CA_PATH, version = option('version');
    if (!url || !caPath || !version) throw new RegistryError('REGISTRY_PUBLISH_CONFIGURATION_REQUIRED');
    const correlationId = option('correlation-id') ?? randomUUID();
    const release = await loadRegistryRelease({ repository: process.cwd(), version });
    const pool = createDatabasePool(url, await readFile(caPath, 'utf8'));
    try {
      const published = await publishRegistryRelease(pool, release, correlationId, readTaggedMigrationEvidence(process.cwd(), release));
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
    // `--registry-version` pins the report to the release a migration manifest
    // names, so the CI gate can tell which release this replay was run for.
    const registryVersion = option('registry-version') ?? null;
    if (registryVersion !== null) await recordedRelease(await lintRegistryRepository(process.cwd()), registryVersion);
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
      const summary = { event, result: result.equalsIncremental === false ? 'FAIL' : 'PASS', registryVersion,
        ownerScopeId, asOf: result.asOf, reducerVersion: result.reducerVersion,
        equalsIncremental: result.equalsIncremental,
        receipts: result.receipts.map(receipt => ({ projectionName: receipt.projectionName,
          rowsRebuilt: receipt.rowsRebuilt, equalsIncremental: receipt.equalsIncremental,
          projectionVersion: receipt.projectionVersion, receiptId: receipt.projectionRebuildReceiptId })),
        correlationId };
      await report(summary);
      // A replay that did not reproduce the incremental state is a finding, and CI
      // has to see it as one rather than as a successful rebuild.
      if (result.equalsIncremental === false) { fail('PROJECTION_REPLAY_DIVERGED', { receipts: summary.receipts }); }
      else console.log(JSON.stringify(summary));
    } finally { await pool.end(); }
  } else if (group === 'corpus') {
    const corpus = await import('./corpus.js');
    const kind = (option('corpus') ?? (command === 'import' || command === 'annotate' ? 'private' : 'synthetic')) === 'private'
      ? 'REAL' as const : 'SYNTHETIC' as const;
    if (command === 'import') {
      const source = option('source');
      if (!source) throw new RegistryError('CORPUS_SOURCE_REQUIRED');
      const imported = await corpus.importGmailThread(process.cwd(), source, { update: flag('update') });
      console.log(JSON.stringify({ event, result: 'PASS', ...imported }));
    } else if (command === 'annotate') {
      const threadRef = option('thread');
      if (!threadRef) {
        // Without --thread: every thread with the categories it still lacks.
        const threads = await corpus.annotationProgress(process.cwd(), kind);
        console.log(JSON.stringify({ event, result: 'PASS', corpus: kind, threads }));
      } else {
        const annotated = await corpus.annotateThread(process.cwd(), kind, threadRef);
        // The path is the owner's own file; no thread content is printed.
        console.log(JSON.stringify({ event, result: 'PASS', threadRef, created: annotated.created, missing: annotated.missing }));
      }
    } else if (command === 'run') {
      const release = await latestRelease();
      const results = corpus.scoreCorpus({ kind, threads: await corpus.loadCorpus(corpus.corpusDir(process.cwd(), kind), kind),
        thresholds: await corpus.loadThresholds(process.cwd()), release });
      await report(results);
      // Recording writes aggregate counts and rates only, so the real-corpus
      // results can be committed while the corpus itself never is.
      if (flag('record')) {
        if (kind !== 'REAL') throw new RegistryError('CORPUS_RECORD_REQUIRES_REAL_CORPUS');
        await writeFile(corpus.REAL_RESULTS_FILE, JSON.stringify(results, null, 2) + '\n');
      }
      const summary = { corpus: kind, threads: results.threadCount, thresholdsVersion: results.thresholdsVersion,
        rules: results.rules.map(rule => ({ ruleId: rule.ruleId, observations: rule.observations, falseMergeRate: rule.falseMergeRate,
          falseSplitRate: rule.falseSplitRate, meetsThresholds: rule.meetsThresholds })) };
      if (results.result === 'FAIL') fail('CORPUS_THRESHOLDS_NOT_MET', { ...summary, failures: results.failures });
      else console.log(JSON.stringify({ event, result: 'PASS', ...summary }));
    } else if (command === 'verify') {
      const verified = await corpus.verifyRealCorpusResults(process.cwd());
      if (verified.result === 'FAIL') fail('REAL_CORPUS_EVALUATION_REQUIRED', { failures: verified.failures });
      else console.log(JSON.stringify({ event, result: 'PASS', threads: verified.results!.threadCount }));
    } else if (command === 'status') {
      const status = await corpus.corpusStatus(process.cwd(), await latestRelease());
      await report(status);
      console.log(JSON.stringify({ event, result: 'PASS', privatePath: status.privatePath, realThreads: status.realThreads,
        syntheticThreads: status.syntheticThreads, verification: status.verification }));
    } else fail('REGISTRY_COMMAND_UNKNOWN');
  } else {
    fail('REGISTRY_COMMAND_UNKNOWN');
  }
} catch (error) {
  fail(codeOf(error), error instanceof RegistryError && error.issues.length ? { issues: error.issues } : {});
}
