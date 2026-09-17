import { afterEach, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as registry from './index.js';

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
  expect(event).toMatchObject({ event: 'registry.lint', result: 'PASS', releases: [{ version: '0.1.0', tag: 'registry-v0.1.0', contracts: 8 }] });
  expect(event.releases[0].contentHash).toMatch(/^[a-f0-9]{64}$/);
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

it('uai registry lint refuses an unrecorded release directory', async () => {
  const repository = await copy();
  await cp(join(repository, 'registry/releases/0.1.0'), join(repository, 'registry/releases/0.2.0'), { recursive: true });
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
