// scripts/.tmp/ is ignored scratch that never enters Git.
// The disposable test database's password stays in the harness and tests.
// Both checks select files from Git's index, including staged additions.
import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

it('ignores scripts/.tmp/ and tracks nothing under it', () => {
  const tracked = spawnSync('git', ['ls-files', '--', 'scripts/.tmp'], { cwd: root, encoding: 'utf8' });
  expect(tracked.status).toBe(0);
  expect(tracked.stdout).toBe('');
  const ignored = spawnSync('git', ['check-ignore', '-q', '--no-index', 'scripts/.tmp/scratch.mjs'],
    { cwd: root, encoding: 'utf8' });
  expect(ignored.status).toBe(0);
});

it('keeps the harness-only database password out of every tracked file but the harness and tests', () => {
  const matches = spawnSync('git', ['grep', '-l', '-F', 'unai-test-only@', '--',
    ':!*.test.*', ':!scripts/test.mjs', ':!scripts/*harness*'], { cwd: root, encoding: 'utf8' });
  expect(matches.stdout).toBe('');
  // git grep exits 1 for no match, 0 for a match and 128 for an error: errors fail too.
  expect(matches.status).toBe(1);
});
