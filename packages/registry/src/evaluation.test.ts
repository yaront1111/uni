import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  CANONICAL_NORMALIZATION_VERSION, ENTITY_RESOLVER_VERSION, INSTANCE_MATCHER_VERSION,
} from '@unai/memory';
import { LABEL_CATEGORIES, PRODUCTION_KEYING_RULES, corpusAnnotationSchema, corpusResultsSchema, corpusStatusSchema,
  identityThresholdsSchema, registryLintReportSchema, shadowReportSchema } from '@unai/domain';
import { releaseContentHash, lintRegistryCheckout } from './release.js';
import { classifyRegistryChange } from './migration.js';
import { runShadowEvaluation } from './shadow.js';
import { runContractTests, CONTRACT_TEST_AREAS } from './contract-tests.js';
import {
  KEYING_RULE_VERSIONS, THRESHOLDS_FILE, annotateThread, corpusDir, corpusShadowSample, gmailThreadRef, importGmailThread,
  loadCorpus, loadThresholds, scoreCorpus, verifyRealCorpusResults,
} from './corpus.js';

/** The registry release, migration and evaluation tooling without a database:
 * the four `uai registry` commands' pure halves, the migration gate as CI runs
 * it (through the real CLI, in throwaway repositories), the gold corpus and its
 * pre-commit block. The database halves are in `evaluation-db.test.ts`. */

const cliPath = resolve('packages/registry/src/cli.ts');
const tsx = createRequire(import.meta.url).resolve('tsx/cli');
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

function run(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, [tsx, cliPath, ...args], { cwd, env, encoding: 'utf8', timeout: 120000 });
}
function git(cwd: string, ...args: string[]) {
  return spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=Corpus Test', '-c', 'user.email=corpus@test.invalid', ...args],
    { cwd, encoding: 'utf8' });
}
/** A throwaway repository holding the registry, the corpus and the ignore rules. */
async function repository() {
  const path = await mkdtemp(join(tmpdir(), 'unai-evaluation-'));
  directories.push(path);
  await cp(resolve('registry'), join(path, 'registry'), { recursive: true });
  // Never the owner's private corpus: it stays where it is, and each test starts without one.
  const privateCorpus = resolve('corpus/private-local');
  await cp(resolve('corpus'), join(path, 'corpus'), { recursive: true,
    filter: source => resolve(source) !== privateCorpus && !resolve(source).startsWith(privateCorpus + sep) });
  await cp(resolve('.gitignore'), join(path, '.gitignore'));
  await onlyBaseRelease(path);
  expect(git(path, 'init', '-q').status).toBe(0);
  return path;
}
/** Leaves release 0.1.0 as the throwaway repository's only release, so the
 * fixture below is the release that follows it whatever this checkout records
 * after 0.1.0 (its own 0.2.0 is linted from the checkout itself). */
async function onlyBaseRelease(repo: string) {
  for (const version of await readdir(join(repo, 'registry/releases'))) {
    if (version !== '0.1.0') await rm(join(repo, 'registry/releases', version), { recursive: true, force: true });
  }
  const index = join(repo, 'registry/releases.yaml');
  const text = await readFile(index, 'utf8');
  const next = text.indexOf('  - version: ', text.indexOf('  - version: 0.1.0') + 1);
  if (next >= 0) await writeFile(index, text.slice(0, next));
}
/** Records the release directory's content hash in the index, as a release PR does. */
async function record(repo: string, version: string) {
  const directory = join(repo, 'registry/releases', version);
  const files = await Promise.all((await readdir(directory)).map(async path => ({ path, bytes: await readFile(join(directory, path)) })));
  const index = join(repo, 'registry/releases.yaml');
  const text = await readFile(index, 'utf8');
  const entry = '  - version: ' + version + '\n    tag: registry-v' + version + '\n    contentHash: ' + releaseContentHash(files) + '\n';
  const pattern = new RegExp('  - version: ' + version.replaceAll('.', '\\.') + '\\n    tag: [^\\n]+\\n    contentHash: [a-f0-9]{64}\\n');
  await writeFile(index, pattern.test(text) ? text.replace(pattern, entry) : text + entry);
}
/** Release 0.2.0: 0.1.0 with two identity-affecting changes -- the obligation no
 * longer anchors on its debtor, and an occurrence may hold several times. */
async function identityAffectingRelease(repo: string) {
  const from = join(repo, 'registry/releases/0.1.0'), to = join(repo, 'registry/releases/0.2.0');
  await cp(from, to, { recursive: true });
  for (const name of await readdir(to)) {
    const path = join(to, name);
    let text = (await readFile(path, 'utf8')).replace(/^version: 0\.1\.0$/m, 'version: 0.2.0');
    if (name === 'shared.obligation.yaml') text = text.replace('identityAnchors: [external_reference, debtor, creditor, origin_reference]',
      'identityAnchors: [external_reference, creditor, origin_reference]');
    if (name === 'shared.event_occurrence.yaml') text = text.replace(/(- id: shared\.event_occurrence\.occurrence_time[\s\S]*?cardinality: )FUNCTIONAL/, '$1SET');
    await writeFile(path, text);
  }
  await record(repo, '0.2.0');
}
const MIGRATION = (overrides: Record<string, string | null> = {}) => {
  const fields: Record<string, string | null> = {
    kind: 'MIGRATION', from: '0.1.0', to: '0.2.0', changeClass: 'IDENTITY_AFFECTING',
    description: 'Obligations stop anchoring on the debtor; occurrence time becomes a set.',
    shadowDiff: 'registry/evidence/0.2.0/shadow-diff.json', projectionReplay: 'registry/evidence/0.2.0/projection-replay.json',
    rollbackPlan: 'Pin deployments back to 0.1.0; fingerprints are recomputed under 0.1.0 and no identifier changes.',
    ...overrides,
  };
  return Object.entries(fields).filter(([, value]) => value !== null).map(([key, value]) => key + ': ' + JSON.stringify(value)).join('\n')
    + '\npinnedTests:\n  - packages/registry/src/evaluation.test.ts\n';
};
const replayReport = (registryVersion: string) => JSON.stringify({
  event: 'registry.projection-replay', result: 'PASS', registryVersion, ownerScopeId: randomUUID(), asOf: '2026-09-01T00:00:00.000Z',
  reducerVersion: 'projection-reducers-0.1.0', equalsIncremental: true,
  receipts: [{ projectionName: 'obligations_projection', rowsRebuilt: 2, equalsIncremental: true, projectionVersion: randomUUID(), receiptId: randomUUID() }],
  correlationId: randomUUID(),
});

describe('CRT-REG-05-A: CI fails an identity-affecting registry change that lacks its migration evidence', () => {
  it('refuses a release with no migration manifest, naming the computed change class', async () => {
    const repo = await repository();
    await identityAffectingRelease(repo);
    const reportPath = join(repo, 'lint-report.json');
    const result = run(repo, ['registry', 'lint', '--report', reportPath]);
    expect(result.status).toBe(1);
    const failure = JSON.parse(result.stderr.trim());
    expect(failure).toMatchObject({ event: 'registry.lint', result: 'FAIL', code: 'REGISTRY_MIGRATION_EVIDENCE_REQUIRED' });
    expect(failure.issues).toContainEqual({ code: 'REGISTRY_MIGRATION_MANIFEST_REQUIRED', contract: '0.2.0/migration.yaml', path: '' });
    const report = registryLintReportSchema.parse(JSON.parse(await readFile(reportPath, 'utf8')));
    expect(report.migrations).toEqual([expect.objectContaining({ from: '0.1.0', to: '0.2.0', changeClass: 'IDENTITY_AFFECTING', manifest: 'MISSING' })]);
  }, 180000);

  it('refuses a manifest missing the shadow diff, the projection replay output or the rollback plan, each by name', async () => {
    const repo = await repository();
    await identityAffectingRelease(repo);
    await writeFile(join(repo, 'registry/releases/0.2.0/migration.yaml'), MIGRATION({ shadowDiff: null, projectionReplay: null, rollbackPlan: null }));
    await record(repo, '0.2.0');
    const result = run(repo, ['registry', 'lint']);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr.trim()).issues.map((issue: { code: string }) => issue.code).sort()).toEqual([
      'REGISTRY_MIGRATION_PROJECTION_REPLAY_REQUIRED', 'REGISTRY_MIGRATION_ROLLBACK_PLAN_REQUIRED', 'REGISTRY_MIGRATION_SHADOW_DIFF_REQUIRED']);
    // Naming evidence that does not exist is the same as not naming it.
    await writeFile(join(repo, 'registry/releases/0.2.0/migration.yaml'), MIGRATION());
    await record(repo, '0.2.0');
    const named = run(repo, ['registry', 'lint']);
    expect(named.status).toBe(1);
    expect(JSON.parse(named.stderr.trim()).issues.map((issue: { code: string }) => issue.code).sort())
      .toEqual(['REGISTRY_MIGRATION_PROJECTION_REPLAY_REQUIRED', 'REGISTRY_MIGRATION_SHADOW_DIFF_REQUIRED']);
  }, 180000);

  it('refuses an understated class and a shadow diff of another pair, and lands the change once every piece is present', async () => {
    const repo = await repository();
    await identityAffectingRelease(repo);
    await mkdir(join(repo, 'registry/evidence/0.2.0'), { recursive: true });
    await writeFile(join(repo, 'registry/evidence/0.2.0/projection-replay.json'), replayReport('0.2.0'));
    // The shadow diff is produced by the real command, over the committed corpus.
    const wrongPair = run(repo, ['registry', 'shadow-diff', '--baseline', '0.2.0', '--candidate', '0.1.0',
      '--report', 'registry/evidence/0.2.0/shadow-diff.json']);
    expect(wrongPair.status, wrongPair.stderr).toBe(0);
    await writeFile(join(repo, 'registry/releases/0.2.0/migration.yaml'), MIGRATION({ changeClass: 'ADDITIVE' }));
    await record(repo, '0.2.0');
    const refused = run(repo, ['registry', 'lint']);
    expect(refused.status).toBe(1);
    expect(JSON.parse(refused.stderr.trim()).issues.map((issue: { code: string }) => issue.code).sort())
      .toEqual(['REGISTRY_MIGRATION_CLASS_UNDERSTATED', 'REGISTRY_MIGRATION_SHADOW_DIFF_INVALID']);

    const shadow = run(repo, ['registry', 'shadow-diff', '--baseline', '0.1.0', '--candidate', '0.2.0',
      '--report', 'registry/evidence/0.2.0/shadow-diff.json']);
    expect(shadow.status, shadow.stderr).toBe(0);
    const report = shadowReportSchema.parse(JSON.parse(await readFile(join(repo, 'registry/evidence/0.2.0/shadow-diff.json'), 'utf8')));
    // What the change does, as production would do it: the two Daniels' obligations
    // no longer conflict on an anchor, and the two departure times no longer collide.
    expect(report.diffs.instanceMatch.entries).toContainEqual(expect.objectContaining({ baseline: 'CONFIRMED_DISTINCT', code: 'MATCH_OUTCOME_CHANGED' }));
    expect(report.diffs.slotCollision.entries.map(entry => entry.code)).toContain('COLLISION_RESOLVED');
    expect(report.diffs.beliefStatus.changed).toBeGreaterThan(0);
    await writeFile(join(repo, 'registry/releases/0.2.0/migration.yaml'), MIGRATION());
    await record(repo, '0.2.0');
    const accepted = run(repo, ['registry', 'lint']);
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(JSON.parse(accepted.stdout.trim()).migrations).toEqual([{ from: '0.1.0', to: '0.2.0', changeClass: 'IDENTITY_AFFECTING' }]);
    // A projection replay run for another release does not count.
    await writeFile(join(repo, 'registry/evidence/0.2.0/projection-replay.json'), replayReport('0.1.0'));
    expect(JSON.parse(run(repo, ['registry', 'lint']).stderr.trim()).issues.map((issue: { code: string }) => issue.code))
      .toEqual(['REGISTRY_MIGRATION_PROJECTION_REPLAY_INVALID']);
  }, 240000);

  it('classifies additive, behavioral, identity, transition and breaking changes from the contracts themselves', async () => {
    const base = await lintRegistryCheckout({ repository: resolve('.'), version: '0.1.0' });
    const change = (mutate: (release: { frames: any[]; transitions: any[] }) => void) => {
      const next = structuredClone({ frames: base.frames, transitions: base.transitions }) as { frames: any[]; transitions: any[] };
      mutate(next);
      return classifyRegistryChange(base, next).changeClass;
    };
    expect(classifyRegistryChange(base, base).changeClass).toBeNull();
    expect(change(r => { r.frames[0].predicates.push({ ...r.frames[0].predicates[0], id: r.frames[0].id + '.note_added', required: false }); }))
      .toBe('ADDITIVE');
    expect(change(r => { r.frames[0].description += ' Clarified.'; })).toBe('COMPATIBLE_BEHAVIORAL');
    expect(change(r => { r.frames[0].predicates[0].normalization += ' Rounded.'; })).toBe('IDENTITY_AFFECTING');
    expect(change(r => { r.transitions[0].allowedOutcomes = r.transitions[0].allowedOutcomes.slice(1); })).toBe('TRANSITION_AFFECTING');
    expect(change(r => { r.frames[0].predicates.pop(); })).toBe('BREAKING');
  });
});

describe('CRT-WRT-09-A: the shadow evaluation emits all seven diffs', () => {
  it('reports no change for identical pipelines and every refused resolution for a transition-affecting candidate', async () => {
    const release = await lintRegistryCheckout({ repository: resolve('.'), version: '0.1.0' });
    const sample = corpusShadowSample(await loadCorpus(corpusDir(resolve('.'), 'SYNTHETIC'), 'SYNTHETIC'), 'SYNTHETIC');
    const same = runShadowEvaluation({ runKind: 'REGISTRY', baselineVersion: '0.1.0', candidateVersion: '0.1.0',
      baselineRelease: release, candidateRelease: release, sample });
    for (const name of ['instanceMatch', 'slotCollision', 'proposition', 'beliefStatus', 'resolution', 'projection'] as const) {
      expect(same.diffs[name].changed, name).toBe(0);
      expect(same.diffs[name].compared, name).toBeGreaterThan(0);
    }
    expect(same.diffs.costAndLatency.deltaCostMicrounits).toBe(0);
    expect(same.productionUnchanged).toBeNull();
    // A candidate that no longer allows OCCURRED refuses the labelled occurrence.
    const candidate = structuredClone({ version: '0.2.0', frames: release.frames, transitions: release.transitions }) as any;
    const transition = candidate.transitions.find((entry: { id: string }) => entry.id === 'shared.event_occurrence.resolution');
    transition.allowedOutcomes = transition.allowedOutcomes.filter((code: string) => code !== 'OCCURRED');
    const refused = runShadowEvaluation({ runKind: 'REGISTRY', baselineVersion: '0.1.0', candidateVersion: '0.2.0',
      baselineRelease: release, candidateRelease: candidate, sample });
    expect(refused.diffs.resolution.entries).toEqual([expect.objectContaining({ code: 'RESOLUTION_REFUSED', baseline: 'VALID',
      candidate: 'TRANSITION_OUTCOME_REFUSED' })]);
    // Reports hold references and codes, never a labelled value.
    expect(JSON.stringify(refused)).not.toMatch(/example\.test|taxi|ILS|3600/);
  });
});

describe('CRT-REG-02-A: uai registry test runs every contract through the ten PRD §43.3 areas', () => {
  it('passes release 0.1.0 over every area and the committed corpus', async () => {
    const release = await lintRegistryCheckout({ repository: resolve('.'), version: '0.1.0' });
    const outcome = runContractTests([release], await loadCorpus(corpusDir(resolve('.'), 'SYNTHETIC'), 'SYNTHETIC'));
    expect(outcome.result).toBe('PASS');
    expect(new Set(outcome.results.map(result => result.area))).toEqual(new Set(CONTRACT_TEST_AREAS));
    expect(new Set(outcome.results.map(result => result.contract)).size).toBe(4);
    // Every contract runs every area; an area can be empty for one contract (a
    // frame with no FUNCTIONAL predicate has no conflict case) but not for all.
    for (const contract of new Set(outcome.results.map(result => result.contract))) {
      expect(outcome.results.filter(result => result.contract === contract).map(result => result.area).sort(), contract)
        .toEqual([...CONTRACT_TEST_AREAS].sort());
    }
    for (const area of CONTRACT_TEST_AREAS) {
      expect(outcome.results.filter(result => result.area === area).reduce((total, result) => total + result.cases, 0), area).toBeGreaterThan(0);
    }
  });

  it('fails a contract whose projection contract names a projection it does not feed', async () => {
    const release = await lintRegistryCheckout({ repository: resolve('.'), version: '0.1.0' });
    const broken = structuredClone({ version: '0.1.0', frames: release.frames, transitions: release.transitions }) as any;
    broken.frames[0].predicates[0].projectionContracts = ['schedule_projection.start'];
    const outcome = runContractTests([broken], []);
    expect(outcome.result).toBe('FAIL');
    expect(outcome.results.flatMap(result => result.failures.map(failure => failure.code))).toContain('PROJECTION_NOT_CONSUMER');
  });

  it('exits zero from the CLI for the recorded release and prints only counts', () => {
    const result = run(resolve('.'), ['registry', 'test']);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toMatchObject({ event: 'registry.test', result: 'PASS', releases: ['0.1.0', '0.2.0'], contracts: 5, areas: 10 });
  }, 120000);
});

describe('CRT-QA-02-A and CRT-QA-03-A: the gold corpus, its thresholds and its real-corpus gate', () => {
  it('records identity thresholds for every production keying rule, at the rule versions production runs', async () => {
    const thresholds = identityThresholdsSchema.parse(JSON.parse(await readFile(resolve(THRESHOLDS_FILE), 'utf8')));
    expect(Object.keys(thresholds.rules).sort()).toEqual([...PRODUCTION_KEYING_RULES].sort());
    expect(thresholds.minimumRealThreads).toBeGreaterThanOrEqual(10);
    expect(KEYING_RULE_VERSIONS).toEqual({
      'entity.strong_alias_exact': ENTITY_RESOLVER_VERSION,
      'frame_instance.confirmed_match': INSTANCE_MATCHER_VERSION,
      'belief_slot.descriptor_identity': CANONICAL_NORMALIZATION_VERSION,
      'proposition.normalized_value_identity': CANONICAL_NORMALIZATION_VERSION,
    });
    // No false merge is tolerated by any rule.
    expect(Object.values(thresholds.rules).every(rule => rule.maxFalseMergeRate === 0)).toBe(true);
  });

  it('the committed synthetic equivalents carry every label category and meet the recorded thresholds', async () => {
    const threads = await loadCorpus(corpusDir(resolve('.'), 'SYNTHETIC'), 'SYNTHETIC');
    expect(threads.filter(thread => thread.labelled).length).toBeGreaterThanOrEqual(10);
    const release = await lintRegistryCheckout({ repository: resolve('.'), version: '0.1.0' });
    const results = scoreCorpus({ kind: 'SYNTHETIC', threads, thresholds: await loadThresholds(resolve('.')), release });
    expect(results.failures).toEqual([]);
    expect(results.result).toBe('PASS');
    expect(Object.values(results.coverage).every(count => count > 0)).toBe(true);
    expect(results.rules.map(rule => rule.ruleId)).toEqual([...PRODUCTION_KEYING_RULES]);
    for (const check of Object.values(results.pipelineChecks)) expect(check.failed).toBe(0);
    // The scorer runs the production rules, so the under-merge default shows:
    // a name-only mention is kept apart from the mailbox it belongs to.
    expect(results.rules[0]).toMatchObject({ falseMergeRate: 0 });
    expect(results.rules[0]!.falseSplitRate).toBeGreaterThan(0);
  });

  it('keeps the private corpus path ignored and untracked in this repository', () => {
    expect(git(resolve('.'), 'check-ignore', '-q', '--no-index', 'corpus/private-local/threads/probe.json').status).toBe(0);
    expect(git(resolve('.'), 'ls-files', '--', 'corpus/private-local').stdout.trim()).toBe('');
  });

  it('blocks a commit that adds a file under the private corpus path', async () => {
    const repo = await repository();
    await mkdir(join(repo, '.githooks'), { recursive: true });
    await cp(resolve('.githooks/pre-commit'), join(repo, '.githooks/pre-commit'));
    await chmod(join(repo, '.githooks/pre-commit'), 0o755);
    expect(git(repo, 'config', 'core.hooksPath', '.githooks').status).toBe(0);
    await mkdir(join(repo, 'corpus/private-local/threads'), { recursive: true });
    await writeFile(join(repo, 'corpus/private-local/threads/gmail-0000.json'), '{"id":"private"}\n');
    // Ignored: a plain add refuses it...
    expect(git(repo, 'add', 'corpus/private-local/threads/gmail-0000.json').status).not.toBe(0);
    // ...and a forced add is refused at commit.
    expect(git(repo, 'add', '-f', 'corpus/private-local/threads/gmail-0000.json').status).toBe(0);
    const blocked = git(repo, 'commit', '-q', '-m', 'add private thread');
    expect(blocked.status).not.toBe(0);
    expect(blocked.stderr).toContain('PRIVATE_CORPUS_COMMIT_BLOCKED');
    expect(git(repo, 'log', '--oneline').status).not.toBe(0);
    // Everything else still commits.
    expect(git(repo, 'rm', '-q', '--cached', 'corpus/private-local/threads/gmail-0000.json').status).toBe(0);
    expect(git(repo, 'add', 'registry').status).toBe(0);
    const allowed = git(repo, 'commit', '-q', '-m', 'registry');
    expect(allowed.status, allowed.stderr).toBe(0);
  }, 120000);

  it('imports a raw Gmail thread idempotently, only into an ignored private path', async () => {
    const repo = await repository();
    const source = join(repo, 'export.json');
    await cp(resolve('corpus/synthetic/threads/synthetic-01-daniel-taxi.json'), source);
    const first = await importGmailThread(repo, source);
    expect(first).toMatchObject({ outcome: 'IMPORTED', messages: 3 });
    expect(first.threadRef).toBe(gmailThreadRef('thr-syn-01'));
    expect(await importGmailThread(repo, source)).toMatchObject({ outcome: 'ALREADY_IMPORTED', threadRef: first.threadRef });
    const changed = JSON.parse(await readFile(source, 'utf8'));
    changed.messages.pop();
    await writeFile(source, JSON.stringify(changed));
    await expect(importGmailThread(repo, source)).rejects.toThrow('CORPUS_THREAD_CHANGED');
    expect(await importGmailThread(repo, source, { update: true })).toMatchObject({ outcome: 'UPDATED', messages: 2 });
    // A private corpus pointed at a path Git would track is refused before a byte is written.
    await expect(importGmailThread(repo, source, { env: { ...process.env, UNAI_PRIVATE_CORPUS_DIR: 'corpus/unprotected' } }))
      .rejects.toThrow('CORPUS_PRIVATE_PATH_NOT_IGNORED');
    // The annotation skeleton is the editor's starting point and lists what is missing.
    const skeleton = await annotateThread(repo, 'REAL', first.threadRef);
    expect(skeleton.created).toBe(true);
    expect(skeleton.missing).toEqual(LABEL_CATEGORIES.filter(category => category !== 'sourceSpans'));
    const written = corpusAnnotationSchema.parse(JSON.parse(await readFile(skeleton.path, 'utf8')));
    expect(Object.keys(written)).toEqual(expect.arrayContaining(['labelledSourceSpans', 'expectedEntities', 'expectedFrameInstances',
      'instanceMatchCases', 'expectedSlotsAndPropositions', 'expectedCommitmentsAndResolutions', 'expectedUnknownsAndNonMemoryItems']));
    expect(git(repo, 'status', '--porcelain', '--', 'corpus/private-local').stdout.trim()).toBe('');

    // Without --thread, annotate lists every thread with the categories it lacks;
    // an imported thread not yet annotated lacks all of them.
    const other = join(repo, 'export-2.json');
    await cp(resolve('corpus/synthetic/threads/synthetic-02-kitchen-quote.json'), other);
    const second = await importGmailThread(repo, other);
    const listed = run(repo, ['corpus', 'annotate']);
    expect(listed.status, listed.stderr).toBe(0);
    const threads = JSON.parse(listed.stdout.trim()).threads as Array<{ threadRef: string; annotated: boolean; missing: string[] }>;
    expect(threads).toEqual(expect.arrayContaining([
      expect.objectContaining({ threadRef: first.threadRef, annotated: true, missing: skeleton.missing }),
      expect.objectContaining({ threadRef: second.threadRef, annotated: false, missing: [...LABEL_CATEGORIES] }),
    ]));
    expect(listed.stdout).not.toMatch(/example\.test|taxi|kitchen|Daniel/i);

    // The status report the Corpus and evaluation screen shows: label coverage by
    // category as counts, never a thread reference, span or value.
    const statusPath = join(repo, 'status.json');
    const status = run(repo, ['corpus', 'status', '--report', statusPath]);
    expect(status.status, status.stderr).toBe(0);
    const statusText = await readFile(statusPath, 'utf8');
    const report = corpusStatusSchema.parse(JSON.parse(statusText));
    expect(report.labelCoverage.real).toMatchObject({ threads: 2, items: { entities: 0 },
      threadsMissing: { sourceSpans: 1, entities: 2, nonMemoryItems: 2 } });
    expect(report.labelCoverage.real.items.sourceSpans).toBeGreaterThan(0);
    expect(report.labelCoverage.synthetic).toMatchObject({ threads: 12,
      threadsMissing: Object.fromEntries(LABEL_CATEGORIES.map(category => [category, expect.any(Number)])) });
    expect(statusText).not.toMatch(/example\.test|taxi|kitchen|Daniel|gmail-|thr-syn/i);
  }, 120000);

  it('records real-corpus results as counts only, and verify requires ten threads and every rule at its version', async () => {
    const repo = await repository();
    // Stand-in real threads for this throwaway repository only: the committed
    // synthetic threads, imported and labelled exactly as a real export would be.
    expect((await verifyRealCorpusResults(repo)).failures).toEqual(['REAL_RESULTS_MISSING']);
    const synthetic = resolve('corpus/synthetic');
    await mkdir(join(repo, 'corpus/private-local/annotations'), { recursive: true });
    for (const name of (await readdir(join(synthetic, 'annotations'))).sort()) {
      const annotation = JSON.parse(await readFile(join(synthetic, 'annotations', name), 'utf8'));
      const imported = await importGmailThread(repo, join(synthetic, 'threads', annotation.source.threadFile));
      await writeFile(join(repo, 'corpus/private-local/annotations', imported.threadRef + '.json'), JSON.stringify({ ...annotation,
        corpusKind: 'REAL', threadRef: imported.threadRef, source: { ...annotation.source, threadFile: imported.threadRef + '.json' } }));
    }
    const recorded = run(repo, ['corpus', 'run', '--corpus', 'private', '--record']);
    expect(recorded.status, recorded.stderr).toBe(0);
    const text = await readFile(join(repo, 'corpus/expected/real-corpus-results.json'), 'utf8');
    const results = corpusResultsSchema.parse(JSON.parse(text));
    expect(results).toMatchObject({ corpusKind: 'REAL', threadCount: 12, result: 'PASS' });
    // Nothing from a thread: no address, no quote, no value, no thread reference.
    expect(text).not.toMatch(/example\.test|taxi|Daniel|gmail-|3600|thr-syn/);
    expect(run(repo, ['corpus', 'verify']).status).toBe(0);

    const stale = { ...results, rules: results.rules.map(rule => rule.ruleId === 'frame_instance.confirmed_match' ? { ...rule, ruleVersion: 'instance-matcher-0.0.1' } : rule) };
    await writeFile(join(repo, 'corpus/expected/real-corpus-results.json'), JSON.stringify(stale));
    expect((await verifyRealCorpusResults(repo)).failures).toEqual(['KEYING_RULE_VERSION_STALE']);
    await writeFile(join(repo, 'corpus/expected/real-corpus-results.json'), JSON.stringify({ ...results, threadCount: 9 }));
    expect((await verifyRealCorpusResults(repo)).failures).toEqual(['REAL_THREADS_INSUFFICIENT']);
    await writeFile(join(repo, 'corpus/expected/real-corpus-results.json'), JSON.stringify({ ...results, corpusKind: 'SYNTHETIC' }));
    expect((await verifyRealCorpusResults(repo)).failures).toEqual(['REAL_RESULTS_NOT_REAL']);
    const refused = run(repo, ['corpus', 'verify']);
    expect(refused.status).toBe(1);
    expect(JSON.parse(refused.stderr.trim())).toMatchObject({ code: 'REAL_CORPUS_EVALUATION_REQUIRED' });
  }, 240000);
});
