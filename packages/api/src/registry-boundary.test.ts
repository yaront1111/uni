import { expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { Pool } from 'pg';
import { createPlatformApi } from './platform.js';

/** CRT-REG-01-B: the registry is a Git/CLI library. The deployment holds exactly
 * one registry-shaped path — the read-only snapshot view the design draws — and
 * no way to load, hash, lint, publish or edit a release over the network. */
async function routes() {
  // Pools connect lazily; route inspection opens no database connection.
  const pool = new Pool({ connectionString: 'postgresql://unused:unused@127.0.0.1:1/unused' });
  const app = createPlatformApi({ authPool: pool, appPool: pool });
  try {
    await app.ready();
    return app.printRoutes({ commonPrefix: false });
  } finally {
    await app.close();
    await pool.end();
  }
}

it('exposes no registry service route beyond the read-only snapshot view', async () => {
  const printed = await routes();
  expect(printed).toContain('/v1/devices');
  // Every registry-shaped line in the route tree, with the verbs Fastify prints for it.
  const lines = printed.split('\n').filter(line => /registr|contract|release/i.test(line));
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain('registry-snapshot');
  expect(lines[0]).toContain('(GET, HEAD)');
  expect(lines[0]).not.toMatch(/POST|PUT|PATCH|DELETE/);
  expect(printed).not.toMatch(/lint|publish|snapshot\/|contracts|releases/i);
});

it('serves the snapshot view only under its own read purpose', async () => {
  const platform = await readFile(resolve('packages/api/src/platform.ts'), 'utf8');
  expect(platform).toContain("'/v1/ops/registry-snapshot'?'ops.registry.read'");
  // A read purpose only: no registry write purpose exists to be requested.
  expect(platform).not.toMatch(/registry\.(publish|lint|write|load)/);
});

it('no deployed server or web package imports the registry library or reads a release file', async () => {
  // The read-only view renders rows the CLI already materialized. These files may
  // be *named* for the registry; none of them may contain registry logic.
  const viewOnly = new Set(['packages/domain/src/registry.ts', 'packages/api/src/registry-boundary.test.ts',
    'apps/web/components/Registry.tsx', 'apps/web/components/Registry.test.ts', 'apps/web/pages/ops/registry.tsx']);
  const offenders: string[] = [];
  for (const root of ['packages/api', 'packages/auth', 'packages/domain', 'packages/storage', 'apps/web']) {
    for (const entry of await readdir(resolve(root), { recursive: true, withFileTypes: true })) {
      const path = relative(resolve('.'), resolve(entry.parentPath, entry.name)).replaceAll('\\', '/');
      if (/node_modules|\/\.next\//.test(path)) continue;
      if (/registr/i.test(path) && !viewOnly.has(path)) offenders.push(path);
      if (!entry.isFile() || !/\.(ts|tsx|json)$/.test(entry.name) || entry.name.endsWith('.test.ts')) continue;
      if (/@unai\/registry|packages\/registry|registry\/releases/.test(await readFile(resolve(entry.parentPath, entry.name), 'utf8'))) offenders.push(path);
    }
  }
  expect(offenders).toEqual([]);
});

it('keeps the registry package out of every deployed package manifest', async () => {
  for (const manifest of ['packages/api/package.json', 'packages/auth/package.json', 'packages/domain/package.json',
    'packages/storage/package.json', 'apps/web/package.json']) {
    expect(JSON.parse(await readFile(resolve(manifest), 'utf8'))).not.toHaveProperty('dependencies.@unai/registry');
  }
});
