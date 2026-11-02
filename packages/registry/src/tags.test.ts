import { afterEach, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { releaseContentHash } from './release.js';

// `uai registry tags` against throwaway Git repositories only: every tag below is
// created inside a temp fixture, never in the checkout (task rail).
const cliPath = resolve('packages/registry/src/cli.ts');
const tsx = createRequire(import.meta.url).resolve('tsx/cli');
// Two tsx cold starts per case can exceed a minute on a loaded host.
const TIMEOUT = 120_000;
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

const RELEASES: Record<string, Record<string, string>> = {
  '0.1.0': { 'manifest.yaml': 'version: 0.1.0\n', 'notes.yaml': 'note: first\n' },
  '0.2.0': { 'manifest.yaml': 'version: 0.2.0\n' },
};
const hashOf = (files: Record<string, string>) =>
  releaseContentHash(Object.entries(files).map(([path, text]) => ({ path, bytes: Buffer.from(text) })));
const RECORDS = Object.entries(RELEASES).map(([version, files]) => ({ version, contentHash: hashOf(files) }));
const indexText = (records: { version: string; contentHash: string }[]) => 'releases:\n'
  + records.map(record => `  - version: ${record.version}\n    tag: registry-v${record.version}\n    contentHash: ${record.contentHash}\n`).join('');

function git(repository: string, ...args: string[]) {
  const result = spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=Registry Test', '-c', 'user.email=registry@test.invalid', ...args],
    { cwd: repository, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
async function temporary() {
  const directory = await mkdtemp(join(tmpdir(), 'unai-registry-tags-'));
  directories.push(directory);
  return directory;
}

/** Commit A: two synthetic releases recorded in the real index format. */
async function fixture() {
  const repository = await temporary();
  for (const [version, files] of Object.entries(RELEASES)) {
    await mkdir(join(repository, 'registry/releases', version), { recursive: true });
    for (const [name, text] of Object.entries(files)) await writeFile(join(repository, 'registry/releases', version, name), text);
  }
  await writeFile(join(repository, 'registry/releases.yaml'), indexText(RECORDS));
  git(repository, 'init', '--quiet');
  git(repository, 'add', 'registry');
  git(repository, 'commit', '--quiet', '-m', 'A: releases 0.1.0 and 0.2.0');
  return { repository, A: git(repository, 'rev-parse', 'HEAD') };
}

/** B changes the 0.2.0 bytes and C restores them, as the real 0.2.0 history did. */
async function changeAndRestore(repository: string) {
  const manifest = join(repository, 'registry/releases/0.2.0/manifest.yaml');
  await writeFile(manifest, 'version: 0.2.0\nedited: true\n');
  git(repository, 'commit', '--quiet', '-am', 'B: edit 0.2.0');
  const B = git(repository, 'rev-parse', 'HEAD');
  await writeFile(manifest, RELEASES['0.2.0']!['manifest.yaml']!);
  git(repository, 'commit', '--quiet', '-am', 'C: restore 0.2.0');
  return { B, C: git(repository, 'rev-parse', 'HEAD') };
}

function gitState(cwd: string, env: NodeJS.ProcessEnv) {
  const read = (...args: string[]) => { const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' }); return [result.status, result.stdout]; };
  return { tags: read('for-each-ref', '--format=%(refname) %(objectname)', 'refs/tags'), status: read('status', '--porcelain') };
}

/** Runs the real CLI and proves it wrote nothing to Git and printed no `--tags`. */
function run(cwd: string, args: string[] = [], env: NodeJS.ProcessEnv = process.env) {
  const before = gitState(cwd, env);
  const result = spawnSync(process.execPath, [tsx, cliPath, 'registry', 'tags', ...args], { cwd, env, encoding: 'utf8', timeout: 60000 });
  expect(gitState(cwd, env), 'the command changed refs/tags or the working tree').toEqual(before);
  const lines = result.stdout.split('\n').filter(Boolean);
  expect(lines.filter(line => line.includes('--tags'))).toEqual([]);
  return { status: result.status, lines, stderr: result.stderr };
}
const failure = (stderr: string) => JSON.parse(stderr.trim()) as { code: string; versions?: string[] };
const tagCommand = (version: string, commit: string, force = false) =>
  `git tag -a ${force ? '-f ' : ''}registry-v${version} ${commit} -m "registry ${version}"`;

it('reports every untagged version as MISSING with its command and one by-name push line', async () => {
  const { repository, A } = await fixture();
  const result = run(repository);
  expect(result.status, result.stderr).toBe(0);
  expect(result.lines).toEqual([
    'registry-v0.1.0 MISSING ' + tagCommand('0.1.0', A),
    'registry-v0.2.0 MISSING ' + tagCommand('0.2.0', A),
    'git push origin refs/tags/registry-v0.1.0 refs/tags/registry-v0.2.0',
  ]);
}, TIMEOUT);

it('reports a tag on the matching commit as PRESENT and pushes only the missing tag', async () => {
  const { repository, A } = await fixture();
  git(repository, 'tag', '-a', 'registry-v0.1.0', A, '-m', 'x');
  const result = run(repository);
  expect(result.status, result.stderr).toBe(0);
  expect(result.lines).toEqual([
    'registry-v0.1.0 PRESENT ' + A,
    'registry-v0.2.0 MISSING ' + tagCommand('0.2.0', A),
    'git push origin refs/tags/registry-v0.2.0',
  ]);
}, TIMEOUT);

it('--require exits 1 with REGISTRY_TAGS_INCOMPLETE until every version is PRESENT, then 0', async () => {
  const { repository, A } = await fixture();
  git(repository, 'tag', '-a', 'registry-v0.1.0', A, '-m', 'x');
  const incomplete = run(repository, ['--require']);
  expect(incomplete.status).toBe(1);
  expect(incomplete.lines).toEqual([
    'registry-v0.1.0 PRESENT ' + A,
    'registry-v0.2.0 MISSING ' + tagCommand('0.2.0', A),
    'git push origin refs/tags/registry-v0.2.0',
  ]);
  expect(failure(incomplete.stderr)).toMatchObject({ code: 'REGISTRY_TAGS_INCOMPLETE', versions: ['0.2.0'] });
  git(repository, 'tag', 'registry-v0.2.0', A); // lightweight tags count as well
  const complete = run(repository, ['--require']);
  expect(complete.status, complete.stderr).toBe(0);
  expect(complete.lines).toEqual(['registry-v0.1.0 PRESENT ' + A, 'registry-v0.2.0 PRESENT ' + A]);
}, TIMEOUT);

it('suggests the newest commit that changed the release directory to the recorded bytes', async () => {
  const { repository, A } = await fixture();
  const { B, C } = await changeAndRestore(repository);
  expect(new Set([A, B, C]).size).toBe(3);
  const result = run(repository);
  expect(result.status, result.stderr).toBe(0);
  expect(result.lines).toEqual([
    'registry-v0.1.0 MISSING ' + tagCommand('0.1.0', A),
    'registry-v0.2.0 MISSING ' + tagCommand('0.2.0', C),
    'git push origin refs/tags/registry-v0.1.0 refs/tags/registry-v0.2.0',
  ]);
}, TIMEOUT);

it('reports a tag on a commit with other bytes as MISMATCH with a forced re-tag and its own forced push', async () => {
  const { repository, A } = await fixture();
  const { B, C } = await changeAndRestore(repository);
  git(repository, 'tag', '-a', 'registry-v0.2.0', B, '-m', 'x');
  const expected = [
    'registry-v0.1.0 MISSING ' + tagCommand('0.1.0', A),
    'registry-v0.2.0 MISMATCH ' + tagCommand('0.2.0', C, true),
    'git push origin refs/tags/registry-v0.1.0',
    'git push --force origin refs/tags/registry-v0.2.0',
  ];
  const result = run(repository);
  expect(result.status, result.stderr).toBe(0);
  expect(result.lines).toEqual(expected);
  const required = run(repository, ['--require']);
  expect(required.status).toBe(1);
  expect(required.lines).toEqual(expected);
  expect(failure(required.stderr)).toMatchObject({ code: 'REGISTRY_TAGS_INCOMPLETE', versions: ['0.1.0', '0.2.0'] });
  expect(git(repository, 'rev-parse', 'refs/tags/registry-v0.2.0^{commit}')).toBe(B);
}, TIMEOUT);

it('prints no command and no push line for a version whose recorded hash no commit holds', async () => {
  const { repository, A } = await fixture();
  git(repository, 'tag', '-a', 'registry-v0.1.0', A, '-m', 'x');
  await writeFile(join(repository, 'registry/releases.yaml'), indexText([...RECORDS, { version: '0.3.0', contentHash: 'a'.repeat(64) }]));
  git(repository, 'commit', '--quiet', '-am', 'D: record 0.3.0 without its directory');
  const missing = run(repository);
  expect(missing.status, missing.stderr).toBe(0);
  expect(missing.lines).toEqual([
    'registry-v0.1.0 PRESENT ' + A,
    'registry-v0.2.0 MISSING ' + tagCommand('0.2.0', A),
    'registry-v0.3.0 MISSING no commit holds the recorded content hash',
    'git push origin refs/tags/registry-v0.2.0',
  ]);
  git(repository, 'tag', '-a', 'registry-v0.3.0', A, '-m', 'x'); // A has no 0.3.0 directory
  const mismatched = run(repository);
  expect(mismatched.status, mismatched.stderr).toBe(0);
  expect(mismatched.lines).toEqual([
    'registry-v0.1.0 PRESENT ' + A,
    'registry-v0.2.0 MISSING ' + tagCommand('0.2.0', A),
    'registry-v0.3.0 MISMATCH no commit holds the recorded content hash',
    'git push origin refs/tags/registry-v0.2.0',
  ]);
}, TIMEOUT);

it('refuses a shallow clone with REGISTRY_HISTORY_SHALLOW', async () => {
  const { repository } = await fixture();
  await changeAndRestore(repository);
  const parent = await temporary();
  git(parent, 'clone', '--quiet', '--depth', '1', pathToFileURL(repository).href, 'clone');
  const clone = join(parent, 'clone');
  expect(git(clone, 'rev-parse', '--is-shallow-repository')).toBe('true');
  const result = run(clone);
  expect(result.status).toBe(1);
  expect(result.lines).toEqual([]);
  expect(failure(result.stderr).code).toBe('REGISTRY_HISTORY_SHALLOW');
}, TIMEOUT);

it('refuses a directory outside Git with REGISTRY_GIT_UNAVAILABLE', async () => {
  const directory = await temporary();
  await mkdir(join(directory, 'registry'));
  await writeFile(join(directory, 'registry/releases.yaml'), indexText(RECORDS));
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: await realpath(dirname(directory)) };
  const result = run(directory, [], env);
  expect(result.status).toBe(1);
  expect(result.lines).toEqual([]);
  expect(failure(result.stderr).code).toBe('REGISTRY_GIT_UNAVAILABLE');
}, TIMEOUT);
