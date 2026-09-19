import { expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

it('exposes a real worker process that loads the runtime and refuses missing configuration', async () => {
  const manifest = JSON.parse(await readFile(resolve('package.json'), 'utf8'));
  expect(manifest.scripts['start:worker']).toBe('tsx packages/api/src/processing-worker.ts');
  const result = spawnSync(process.execPath, [resolve('node_modules/tsx/dist/cli.mjs'), resolve('packages/api/src/processing-worker.ts')], {
    cwd: resolve('.'), encoding: 'utf8', timeout: 15000,
    // Intentionally omit every service credential and owner identifier: the
    // startup check must load real dependencies and fail before any service I/O.
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, NODE_ENV: 'test' },
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('PROCESSING_CONFIGURATION_REQUIRED');
  expect(result.stderr).not.toMatch(/ERR_MODULE_NOT_FOUND|Cannot find module/);
  const api = JSON.parse(await readFile(resolve('packages/api/package.json'), 'utf8'));
  expect(api.dependencies['@unai/model']).toBe('workspace:*');
});
