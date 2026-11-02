import {afterEach, describe, expect, it} from 'vitest';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {chmod, mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
// @ts-expect-error JavaScript harness helper.
import {AGENT_TOOLING_PATHS, workspaceEvidence} from '../scripts/workspace-evidence.mjs';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, {recursive: true, force: true})));
});

function git(root: string, ...args: string[]): string {
  const run = spawnSync('git', args, {cwd: root, encoding: 'utf8'});
  expect(run.status, run.stderr).toBe(0);
  return run.stdout;
}

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'unai-evidence-'));
  directories.push(root);
  return root;
}

function commit(root: string): void {
  git(root, 'add', '-A');
  git(root, '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'init');
}

async function repo(): Promise<string> {
  const root = await temporaryDirectory();
  git(root, 'init', '-q');
  git(root, 'config', 'core.autocrlf', 'false');
  await writeFile(join(root, 'a.txt'), 'initial\n');
  commit(root);
  return root;
}

const sha256 = (content: string | Buffer): string => createHash('sha256').update(content).digest('hex');

describe('workspace evidence', () => {
  it.skipIf(process.platform === 'win32')('hashes directory symlink text without reading the target', async () => {
    const root = await repo();
    const target = await temporaryDirectory(), replacement = await temporaryDirectory();
    await writeFile(join(target, 'outside.txt'), 'outside');
    await mkdir(join(root, 'skills'));
    const link = join(root, 'skills/link');
    await symlink(target, link, 'dir');
    const moduleUrl = new URL('../scripts/workspace-evidence.mjs', import.meta.url).href;
    const run = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import {workspaceEvidence} from ${JSON.stringify(moduleUrl)}; await workspaceEvidence(process.cwd());`],
    {cwd: root, encoding: 'utf8'});
    expect(run.status, run.stderr).toBe(0);
    const before = await workspaceEvidence(root);
    await writeFile(join(target, 'outside.txt'), 'changed outside');
    expect((await workspaceEvidence(root)).workspaceDigest).toBe(before.workspaceDigest);
    await unlink(link);
    await symlink(replacement, link, 'dir');
    expect((await workspaceEvidence(root)).workspaceDigest).not.toBe(before.workspaceDigest);
  });

  it.skipIf(process.platform === 'win32')('hashes file symlink text, including a dangling target', async () => {
    const root = await repo(), outside = await temporaryDirectory();
    const target = join(outside, 'target.txt'), replacement = join(outside, 'missing.txt');
    await writeFile(target, 'outside');
    const link = join(root, 'note');
    await symlink(target, link, 'file');
    const before = await workspaceEvidence(root);
    await writeFile(target, 'changed outside');
    expect((await workspaceEvidence(root)).workspaceDigest).toBe(before.workspaceDigest);
    await unlink(link);
    await symlink(replacement, link, 'file');
    const expected = sha256('a.txt\0' + sha256('initial\n') + 'note\0SYMLINK:' + sha256(replacement));
    expect((await workspaceEvidence(root)).workspaceDigest).toBe(expected);
    expect(expected).not.toBe(before.workspaceDigest);
    commit(root);
    expect((await workspaceEvidence(root)).workspaceDigest).toBe(expected);
  });

  it('detects tracked edits, untracked additions and tracked deletions', async () => {
    const root = await repo();
    const initial = await workspaceEvidence(root);
    await writeFile(join(root, 'a.txt'), 'edited\n');
    const edited = await workspaceEvidence(root);
    expect(edited.workspaceDigest).not.toBe(initial.workspaceDigest);
    await writeFile(join(root, 'b.txt'), 'added\n');
    const added = await workspaceEvidence(root);
    expect(added.workspaceDigest).not.toBe(edited.workspaceDigest);
    await unlink(join(root, 'a.txt'));
    const deleted = await workspaceEvidence(root);
    expect(deleted.workspaceDigest).not.toBe(added.workspaceDigest);
    expect(deleted.workspaceDigest).toBe(sha256('a.txt\0DELETEDb.txt\0' + sha256('added\n')));
  });

  it('explicitly excludes untracked tooling but still hashes tracked tooling files', async () => {
    const root = await repo();
    const before = await workspaceEvidence(root);
    for (const directory of ['.claude', '.codex', '.serena', 'logs']) {
      await mkdir(join(root, directory));
      await writeFile(join(root, directory, 'state.txt'), 'agent state');
    }
    await writeFile(join(root, '.mcp.json'), '{}');
    const excluded = await workspaceEvidence(root);
    expect(excluded.workspaceDigest).toBe(before.workspaceDigest);
    expect(excluded.workspaceExcludes).toEqual(['.claude/', '.codex/', '.mcp.json', '.serena/', 'logs/']);
    expect(AGENT_TOOLING_PATHS).toEqual(excluded.workspaceExcludes);
    expect(Object.isFrozen(AGENT_TOOLING_PATHS)).toBe(true);
    git(root, 'add', 'logs/state.txt');
    git(root, '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'tracked log');
    const tracked = await workspaceEvidence(root);
    expect(tracked.workspaceDigest).not.toBe(excluded.workspaceDigest);
    await writeFile(join(root, 'logs/state.txt'), 'changed tracked state');
    expect((await workspaceEvidence(root)).workspaceDigest).not.toBe(tracked.workspaceDigest);
  });

  it.each(['.claudex/state', 'x/.claude/state', '.mcp.json.extra', 'x/.mcp.json'])
    ('does not exclude a similarly named untracked path: %s', async path => {
      const root = await repo();
      const before = await workspaceEvidence(root);
      await mkdir(join(root, path, '..'), {recursive: true});
      await writeFile(join(root, path), 'product file');
      expect((await workspaceEvidence(root)).workspaceDigest).not.toBe(before.workspaceDigest);
    });

  it('is deterministic and preserves the legacy digest for regular files', async () => {
    const root = await repo();
    await writeFile(join(root, 'z.txt'), 'untracked\n');
    await writeFile(join(root, 'a.txt'), 'edited\n');
    const paths = git(root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z');
    const legacy = createHash('sha256');
    for (const path of [...new Set(paths.split('\0').filter(Boolean))].sort()) {
      legacy.update(path + '\0');
      legacy.update(sha256(await readFile(join(root, path))));
    }
    const first = await workspaceEvidence(root), second = await workspaceEvidence(root);
    expect(first).toEqual(second);
    expect(first.sourceCommit).toBe(git(root, 'rev-parse', 'HEAD').trim());
    expect(first.workspaceDigest).toBe(legacy.digest('hex'));
  });

  it('marks nested repositories as directories without traversing them', async () => {
    const root = await repo(), nested = join(root, 'nested');
    await mkdir(nested);
    git(nested, 'init', '-q');
    expect(git(root, 'ls-files', '--others', '--exclude-standard', '-z')).toContain('nested/\0');
    const before = await workspaceEvidence(root);
    expect(before.workspaceDigest).toBe(sha256('a.txt\0' + sha256('initial\n') + 'nested/\0DIRECTORY'));
    await writeFile(join(nested, 'inside.txt'), 'inside');
    expect((await workspaceEvidence(root)).workspaceDigest).toBe(before.workspaceDigest);
  });

  it.skipIf(process.platform === 'win32')('does not read a file replaced by a symlink after lstat', async () => {
    const root = await repo(), outside = await temporaryDirectory();
    const target = join(outside, 'private.txt');
    await writeFile(target, 'outside content must not be read');
    const moduleUrl = new URL('../scripts/workspace-evidence.mjs', import.meta.url).href;
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs/promises';
      import {syncBuiltinESMExports} from 'node:module';
      const original = fs.lstat;
      fs.lstat = async path => {
        const entry = await original(path);
        if (path === ${JSON.stringify(join(root, 'a.txt'))}) {
          await fs.unlink(path);
          await fs.symlink(${JSON.stringify(target)}, path);
        }
        return entry;
      };
      syncBuiltinESMExports();
      const {workspaceEvidence} = await import(${JSON.stringify(moduleUrl)});
      let message;
      try { await workspaceEvidence(process.cwd()); } catch (error) { message = error.message; }
      if (message !== 'WORKSPACE_EVIDENCE_UNREADABLE a.txt') process.exit(1);
    `], {cwd: root, encoding: 'utf8'});
    expect(run.status, run.stderr).toBe(0);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)
    ('reports unreadable paths without exposing OS error text', async () => {
      const root = await repo(), path = join(root, 'a.txt');
      await chmod(path, 0);
      try {
        await expect(workspaceEvidence(root)).rejects.toThrow(/^WORKSPACE_EVIDENCE_UNREADABLE a\.txt$/);
      } finally { await chmod(path, 0o600); }
    });

  it.skipIf(process.platform === 'win32')('marks special files without attempting to read them', async () => {
    const root = await repo(), path = join(root, 'a.txt');
    await unlink(path);
    const run = spawnSync('mkfifo', [path], {encoding: 'utf8'});
    expect(run.status, run.stderr).toBe(0);
    expect((await workspaceEvidence(root)).workspaceDigest).toBe(sha256('a.txt\0SPECIAL'));
  });
});
