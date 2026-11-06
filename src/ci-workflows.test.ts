import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {describe, expect, it} from 'vitest';

type Mapping = Record<string, unknown>;
interface Step extends Mapping {job: string; name?: string; run?: string; uses?: string}
const {parse} = createRequire(new URL('../packages/registry/package.json', import.meta.url))('yaml') as
  {parse(text: string): unknown};
const mapping = (value: unknown): Mapping => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('WORKFLOW_MAPPING_REQUIRED');
  return value as Mapping;
};
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const foundationText = read('.github/workflows/foundation.yml');
const foundation = mapping(parse(foundationText));
// Missing release workflow is an assertion failure in the initial RED run.
const releaseText = (() => {
  try { return read('.github/workflows/release-gate.yml'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
})();
const release = releaseText ? mapping(parse(releaseText)) : {};
const jobs = (workflow: Mapping) => mapping(workflow.jobs ?? {});
const steps = (workflow: Mapping): Step[] => Object.entries(jobs(workflow)).flatMap(([job, value]) => {
  const entries = mapping(value).steps ?? [];
  if (!Array.isArray(entries)) throw new Error('WORKFLOW_STEPS_REQUIRED');
  return entries.map(entry => ({...mapping(entry), job}) as Step);
});
const inJob = (workflow: Mapping, job: string) => steps(workflow).filter(step => step.job === job);
const command = (workflow: Mapping, run: string) => steps(workflow).find(step => step.run === run);
const actions = (workflow: Mapping) => [
  ...Object.values(jobs(workflow)).map(mapping), ...steps(workflow),
].flatMap(entry => typeof entry.uses === 'string' ? [entry.uses] : []);
function safeReferences(text: string): boolean {
  const workflow = mapping(parse(text));
  const secrets = text.match(/secrets\s*(?:\.\s*[A-Za-z_][\w]*|\[[^\]]*\])/g) ?? [];
  return secrets.every(secret => secret === 'secrets.GITHUB_TOKEN') && actions(workflow).every(action =>
    action.startsWith('./') || /^[\w.-]+\/[\w./-]+@(?:v\d+(?:\.\d+)*(?:[-+][\w.-]+)?|[a-f\d]{40})$/.test(action));
}
function fullCheckout(workflow: Mapping, job: string): void {
  const checkout = inJob(workflow, job).find(step => step.uses === 'actions/checkout@v4');
  expect(checkout?.with).toMatchObject({'fetch-depth': 0, 'fetch-tags': true});
}

describe('CI production and release contracts', () => {
  it('lists the parsed step names for both workflows', () => {
    for (const [name, workflow] of [['V0 pipeline', foundation], ['Release gate', release]] as const) {
      console.info(`${name}: ${JSON.stringify(steps(workflow).map(step => ({job: step.job, name: step.name ?? step.run ?? step.uses})))}`);
    }
    expect(release.name).toBe('Release gate');
  });

  it('keeps push and PR triggers and enables reusable invocation', () => {
    expect(Object.keys(mapping(foundation.on))).toEqual(expect.arrayContaining(['push', 'pull_request', 'workflow_call']));
    expect(mapping(foundation.on).workflow_call ?? {}).toEqual({});
  });

  it('runs the environment contract and all three preflights in one harness', () => {
    expect(command(foundation, 'pnpm check:env-contract')?.job).toBe('production-surface');
    const preflights = inJob(foundation, 'production-surface').filter(step => step.run?.includes('node scripts/with-harness.mjs --'));
    expect(preflights).toHaveLength(1);
    for (const process of ['api', 'worker', 'web']) expect(preflights[0]?.run).toContain(`pnpm start:${process} --check`);
    expect(preflights[0]?.run).toContain('bash -euo pipefail');
    expect(mapping(jobs(foundation)['production-surface'])).toMatchObject({'runs-on': 'ubuntu-latest', 'timeout-minutes': 30});
    fullCheckout(foundation, 'production-surface');
  });

  it('requires validation tools and checks every shell file separately before deploy tests', () => {
    const validation = inJob(foundation, 'production-surface').find(step => step.name === 'Deploy bundle validation');
    for (const required of ['shellcheck --version', 'systemd-analyze --version', 'bash -n', '-n1',
      'pnpm exec vitest run deploy/deploy.test.ts deploy/scripts.test.ts']) expect(validation?.run).toContain(required);
    expect(validation?.run?.indexOf('shellcheck --version')).toBeLessThan(validation?.run?.indexOf('pnpm exec') ?? -1);
    const install = inJob(foundation, 'production-surface').find(step => step.run?.includes('apt-get install'));
    expect(install?.run).toContain('shellcheck');
  });

  it('fails high production advisories and lints both workflows with a pinned image', () => {
    expect(command(foundation, 'pnpm audit --prod --audit-level=high')?.job).toBe('production-surface');
    const lint = inJob(foundation, 'production-surface').find(step => step.name === 'Workflow lint');
    expect(lint?.run).toMatch(/docker run .*rhysd\/actionlint:\d+\.\d+\.\d+(?:@sha256:[a-f\d]{64})? -color/);
    expect(lint?.run).toContain('.github/workflows/foundation.yml .github/workflows/release-gate.yml');
    expect(command(foundation, 'pnpm uai registry tags')?.job).toBe('foundation');
  });

  it('reviews dependencies only on public-repository PRs without weakening audit', () => {
    const job = mapping(jobs(foundation)['dependency-review']);
    expect(job.if).toBe("github.event_name == 'pull_request' && !github.event.repository.private");
    const review = inJob(foundation, 'dependency-review').find(step => step.uses === 'actions/dependency-review-action@v4');
    expect(review?.with).toEqual({'fail-on-severity': 'high'});
  });

  it('preserves the existing foundation job, its run order, artifacts and CSP after build', () => {
    const block = foundationText.slice(foundationText.indexOf('  foundation:')).split(/\n(?=  [\w-]+:\n)/)[0]!.trimEnd();
    // Baseline a7217de: even comments and non-run fields must not change in this slice.
    expect(createHash('sha256').update(block).digest('hex')).toBe('967055d7f7b2ebc041b3804dc837157792c95402781b2373e4074de8286bfba2');
    const original = inJob(foundation, 'foundation');
    expect(original.flatMap(step => step.run ? [step.run] : [])).toEqual([
      'pnpm install --frozen-lockfile', 'pnpm lint', 'node scripts/test.mjs --stage unit',
      'node scripts/test.mjs --stage property', 'node scripts/test.mjs --stage connector-integration',
      'node scripts/test.mjs --stage security', 'node scripts/local-policy-audit.mjs',
      'node scripts/test.mjs --stage end-to-end', 'pnpm test', 'pnpm ops:report', 'pnpm build',
      'pnpm exec vitest run apps/web/server.test.ts', 'pnpm validate:registry --report registry-lint-report.json',
      'pnpm uai registry tags', 'pnpm uai registry test --report registry-test-report.json',
      'pnpm uai registry shadow-diff --sample corpus:synthetic --report shadow-diff-report.json',
      'test -z "$(git ls-files corpus/private-local)"',
      'pnpm uai corpus run --corpus synthetic --report corpus-report.json', 'pnpm uai corpus status --report corpus-status.json',
    ]);
    expect(original.filter(step => step.uses === 'actions/upload-artifact@v4')).toHaveLength(2);
    expect(original.findIndex(step => step.run === 'pnpm exec vitest run apps/web/server.test.ts'))
      .toBeGreaterThan(original.findIndex(step => step.run === 'pnpm build'));
    expect(command(foundation, 'pnpm exec vitest run apps/web/server.test.ts')?.env).toEqual({UNAI_WEB_REQUIRE_BUILD: '1'});
    fullCheckout(foundation, 'foundation');
  });

  it('offers manual and version-tag release runs and reuses the complete V0 pipeline', () => {
    expect(mapping(release.on)).toMatchObject({workflow_dispatch: {}, push: {tags: ['v*']}});
    expect(mapping(jobs(release).pipeline).uses).toBe('./.github/workflows/foundation.yml');
    expect(mapping(jobs(release).release)).not.toHaveProperty('needs');
    fullCheckout(release, 'release');
    for (const run of ['pnpm test', 'pnpm check:phase-exit', 'pnpm uai registry tags --require']) {
      expect(command(release, run)?.job).toBe('release');
    }
  });

  it('reports every release gate after test failure, retains pipefail and uploads both artifacts', () => {
    const entries = inJob(release, 'release');
    const testIndex = entries.findIndex(step => step.run === 'pnpm test');
    expect(testIndex).toBeGreaterThan(0);
    const gates = entries.slice(testIndex + 1).filter(step => step.run);
    expect(gates.map(step => step.run)).toEqual(['pnpm check:phase-exit', 'pnpm uai registry tags --require',
      'pnpm check:v0-release | tee test-results/operations/release-check.json']);
    for (const gate of gates) expect(gate.if).toBe('${{ !cancelled() }}');
    expect(gates[2]?.shell).toBe('bash');
    const artifact = entries.find(step => step.uses === 'actions/upload-artifact@v4');
    expect(artifact?.if).toBe('always()');
    expect(artifact?.with).toMatchObject({name: 'release-gate-evidence', 'if-no-files-found': 'error'});
    expect(mapping(artifact?.with).path).toBe('test-results/operations/status.json\ntest-results/operations/release-check.json\n');
  });

  it('uses read-only permissions, pinned actions and no repository credentials or bypasses', () => {
    for (const text of [foundationText, releaseText]) {
      expect(safeReferences(text)).toBe(true);
      const workflow = mapping(parse(text));
      expect(workflow.permissions).toEqual({contents: 'read'});
      expect(Object.keys(mapping(workflow.on))).not.toContain('pull_request_target');
      for (const entry of [...Object.values(jobs(workflow)).map(mapping), ...steps(workflow)]) {
        expect(entry).not.toHaveProperty('continue-on-error');
      }
      expect(text).not.toMatch(/\|\|\s*true|release-input\.json[^\n]*(?:>|write)/);
      expect(text).not.toMatch(/\r/);
    }
  });

  it('rejects mutable action references and forbidden secrets using the same predicate', () => {
    expect(safeReferences('jobs: {test: {steps: [{uses: actions/checkout@main}]}}')).toBe(false);
    expect(safeReferences('env: {TOKEN: "${{ secrets.FOO }}"}')).toBe(false);
    expect(safeReferences('jobs: {test: {uses: owner/repo/workflow@main}}')).toBe(false);
    expect(safeReferences('env: {TOKEN: "${{ secrets.GITHUB_TOKEN }}"}')).toBe(true);
    expect(safeReferences('jobs: {test: {steps: [{uses: actions/checkout@v4}]}}')).toBe(true);
  });
});
