// Points Git at the repository's own hooks (.githooks/), so a commit adding a
// file under the private corpus path is refused (CRT-QA-02-A). Run by `pnpm
// install` through the root `prepare` script and by `pnpm hooks:install`.
//
// It never fails an install: outside a Git work tree, without git on PATH, or
// when core.hooksPath already names another directory, it says so and leaves
// the configuration alone rather than overriding a developer's own hooks.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const git = args => spawnSync('git', args, { encoding: 'utf8', shell: false });
try {
  const inside = git(['rev-parse', '--is-inside-work-tree']);
  if (inside.status !== 0 || inside.stdout.trim() !== 'true' || !existsSync('.githooks/pre-commit')) {
    console.log('hooks: not a Git work tree with .githooks/, nothing installed.');
  } else {
    const current = git(['config', '--get', 'core.hooksPath']).stdout.trim();
    if (current && current !== '.githooks') {
      console.log('hooks: core.hooksPath is already ' + current + '; chain .githooks/pre-commit from it to block private corpus commits.');
    } else if (!current) {
      const set = git(['config', 'core.hooksPath', '.githooks']);
      console.log(set.status === 0 ? 'hooks: core.hooksPath set to .githooks.' : 'hooks: could not set core.hooksPath.');
    }
  }
} catch {
  console.log('hooks: git unavailable, nothing installed.');
}
