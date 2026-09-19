import { afterEach, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as registry from './index.js';
// The report artifact is read by the operations screen, so it is checked here
// against that screen's schema rather than a second copy of the shape.
import { registryLintReportSchema } from '../../domain/src/registry.js';

const cliPath = resolve('packages/registry/src/cli.ts');
const tsx = createRequire(import.meta.url).resolve('tsx/cli');
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

function run(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, [tsx, cliPath, ...args], { cwd, env, encoding: 'utf8', timeout: 60000 });
}
async function copy() {
  const repository = await mkdtemp(join(tmpdir(), 'unai-registry-cli-'));
  directories.push(repository);
  await cp(resolve('registry'), join(repository, 'registry'), { recursive: true });
  return repository;
}
async function rerecord(repository: string) {
  const directory = join(repository, 'registry/releases/0.1.0');
  const files = await Promise.all((await readdir(directory)).map(async path => ({ path, bytes: await readFile(join(directory, path)) })));
  const index = join(repository, 'registry/releases.yaml');
  await writeFile(index, (await readFile(index, 'utf8')).replace(/contentHash: [a-f0-9]{64}/, 'contentHash: ' + registry.releaseContentHash(files)));
}

it('uai registry lint passes the checked-in release and prints only bounded metadata', () => {
  const result = run(resolve('.'), ['registry', 'lint']);
  expect(result.status, result.stderr).toBe(0);
  const event = JSON.parse(result.stdout.trim());
  expect(event).toMatchObject({ event: 'registry.lint', result: 'PASS', releases: [{ version: '0.1.0', tag: 'registry-v0.1.0', contracts: 8 }, { version: '0.2.0', tag: 'registry-v0.2.0', contracts: 11 }] });
  expect(event.releases[0].contentHash).toMatch(/^[a-f0-9]{64}$/);
  expect(event.releases[1].contentHash).toMatch(/^[a-f0-9]{64}$/);
  expect(result.stdout).not.toMatch(/monetary|debtor/i);
});

it('uai registry lint exits non-zero when a recorded release is edited', async () => {
  const repository = await copy();
  const file = join(repository, 'registry/releases/0.1.0/shared.commitment.yaml');
  await writeFile(file, (await readFile(file, 'utf8')) + '\n# edited\n');
  const result = run(repository, ['registry', 'lint']);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('REGISTRY_CONTENT_HASH_MISMATCH');
});

it('uai registry lint exits non-zero on a contract missing a required §17.3 field', async () => {
  const repository = await copy();
  const file = join(repository, 'registry/releases/0.1.0/shared.commitment.yaml');
  await writeFile(file, (await readFile(file, 'utf8')).replace(/^mergePolicy: .*$/m, ''));
  await rerecord(repository);
  const result = run(repository, ['registry', 'lint']);
  expect(result.status).toBe(1);
  const failure = JSON.parse(result.stderr.trim());
  expect(failure).toMatchObject({ event: 'registry.lint', result: 'FAIL', code: 'REGISTRY_LINT_FAILED' });
  expect(failure.issues).toContainEqual({ code: 'REGISTRY_FIELD_REQUIRED', contract: 'shared.commitment.yaml', path: 'mergePolicy' });
});

/** The report is the only lint surface outside the CLI: the operations screen
 * renders this artifact and never lints (ADR 0014), so its bytes must satisfy
 * the schema that screen parses. */
it('uai registry lint --report writes the passing release as a schema-valid report', async () => {
  const repository = await copy();
  const path = join(repository, 'lint-report.json');
  const result = run(repository, ['registry', 'lint', '--report', path]);
  expect(result.status, result.stderr).toBe(0);
  const report = registryLintReportSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  expect(report).toMatchObject({ result: 'PASS', code: null, issues: [],
    releases: [{ version: '0.1.0', tag: 'registry-v0.1.0', contracts: 8 }, { version: '0.2.0', tag: 'registry-v0.2.0', contracts: 11 }] });
});

it.each([
  ['a contract missing a required field', (yaml: string) => yaml.replace(/^mergePolicy: .*$/m, ''), 'REGISTRY_FIELD_REQUIRED'],
  ['an outcome status predicate', (yaml: string) => yaml.replace('- id: shared.commitment.due_time', '- id: shared.commitment.status'), 'OUTCOME_STATUS_PREDICATE_FORBIDDEN'],
  ['a cardinality outside FUNCTIONAL, SET and EVENT', (yaml: string) => yaml.replace(/cardinality: FUNCTIONAL/, 'cardinality: MULTI'), 'REGISTRY_CARDINALITY_INVALID'],
])('uai registry lint --report records %s as a lint failure', async (_name, edit, code) => {
  const repository = await copy();
  const file = join(repository, 'registry/releases/0.1.0/shared.commitment.yaml');
  await writeFile(file, edit(await readFile(file, 'utf8')));
  await rerecord(repository);
  const path = join(repository, 'lint-report.json');
  const result = run(repository, ['registry', 'lint', '--report', path]);
  expect(result.status).toBe(1);
  const report = registryLintReportSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  expect(report).toMatchObject({ result: 'FAIL', code: 'REGISTRY_LINT_FAILED' });
  expect(report.issues.map(issue => issue.code)).toContain(code);
  // Codes, contract file names and field paths only: no contract text.
  expect(JSON.stringify(report)).not.toMatch(/monetary|debtor|promisor/i);
});

it('uai registry lint refuses an unrecorded release directory', async () => {
  const repository = await copy();
  await cp(join(repository, 'registry/releases/0.2.0'), join(repository, 'registry/releases/0.3.0'), { recursive: true });
  const result = run(repository, ['registry', 'lint']);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('REGISTRY_RELEASE_NOT_RECORDED');
});

it('uai registry publish requires explicit TLS migration configuration and unknown commands are refused', () => {
  const { UNAI_MIGRATION_DATABASE_URL: _url, UNAI_DATABASE_CA_PATH: _ca, ...env } = process.env;
  const publish = run(resolve('.'), ['registry', 'publish', '--version', '0.1.0'], env);
  expect(publish.status).toBe(1);
  expect(publish.stderr).toContain('REGISTRY_PUBLISH_CONFIGURATION_REQUIRED');
  const unknown = run(resolve('.'), ['registry', 'serve']);
  expect(unknown.status).toBe(1);
  expect(unknown.stderr).toContain('REGISTRY_COMMAND_UNKNOWN');
});
