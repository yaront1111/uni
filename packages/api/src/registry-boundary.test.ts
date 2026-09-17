import { expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { Pool } from 'pg';
import { createPlatformApi } from './platform.js';

// CRT-REG-01-B: the registry is a Git/CLI library only, never a network service.
it('the production API composition exposes no registry route', async () => {
  // Pools connect lazily; route inspection opens no database connection.
  const pool = new Pool({ connectionString: 'postgresql://unused:unused@127.0.0.1:1/unused' });
  const app = createPlatformApi({ authPool: pool, appPool: pool });
  try {
    await app.ready();
    const routes = app.printRoutes({ commonPrefix: false });
    expect(routes).toContain('/v1/devices');
    expect(routes).not.toMatch(/registr|contract|release/i);
  } finally {
    await app.close();
    await pool.end();
  }
});

it('no deployed server or web package imports the registry library or serves a registry path', async () => {
  const offenders: string[] = [];
  for (const root of ['packages/api', 'packages/auth', 'packages/domain', 'packages/storage', 'apps/web']) {
    for (const entry of await readdir(resolve(root), { recursive: true, withFileTypes: true })) {
      const path = relative(resolve('.'), resolve(entry.parentPath, entry.name)).replaceAll('\\', '/');
      if (/node_modules|\/\.next\//.test(path)) continue;
      if (/registr/i.test(path) && !path.endsWith('registry-boundary.test.ts')) offenders.push(path);
      if (!entry.isFile() || !/\.(ts|tsx|json)$/.test(entry.name) || entry.name.endsWith('.test.ts')) continue;
      if (/@unai\/registry|packages\/registry|registry\/releases/.test(await readFile(resolve(entry.parentPath, entry.name), 'utf8'))) offenders.push(path);
    }
  }
  expect(offenders).toEqual([]);
});
