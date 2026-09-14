import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { Pool } from 'pg';
import { beforeEach, afterEach, expect, it } from 'vitest';
import * as postgres from './index.js';

if (!process.env.UNAI_TEST_DATABASE_URL) throw new Error('Run pnpm test for the required PostgreSQL harness');
let admin: Pool, pool: Pool, directory: string, database: string;
beforeEach(async () => {
  admin = new Pool({ connectionString: process.env.UNAI_TEST_DATABASE_URL });
  database = 'migration_' + randomUUID().replaceAll('-', '');
  await admin.query('CREATE DATABASE ' + database);
  const url = new URL(process.env.UNAI_TEST_DATABASE_URL!);
  url.pathname = '/' + database;
  pool = new Pool({ connectionString: url.href });
  directory = await mkdtemp(join(tmpdir(), 'unai-migration-'));
  await writeFile(join(directory, '0001_widgets.sql'), 'BEGIN;\nCREATE TABLE widgets (id integer PRIMARY KEY);\nCOMMIT;\n');
});
afterEach(async () => {
  await pool?.end();
  if (database) await admin.query('DROP DATABASE ' + database);
  await admin?.end();
  if (directory) await rm(directory, { recursive: true });
});

function runner() {
  const run = (postgres as Record<string, unknown>).runMigrations;
  expect(run, 'production migration runner must exist').toBeTypeOf('function');
  return run as (pool: Pool, directory: string) => Promise<string[]>;
}

it('applies Git SQL once and persists its digest', async () => {
  const run = runner();
  expect(await run(pool, directory)).toEqual(['0001_widgets.sql']);
  expect(await run(pool, directory)).toEqual([]);
  expect((await pool.query('SELECT name, digest FROM unai_migrations.applied')).rows).toEqual([
    { name: '0001_widgets.sql', digest: expect.stringMatching(/^[a-f0-9]{64}$/) },
  ]);
});

it('refuses edited applied history', async () => {
  const run = runner();
  await run(pool, directory);
  await writeFile(join(directory, '0001_widgets.sql'), 'CREATE TABLE changed (id integer);');
  await expect(run(pool, directory)).rejects.toThrow('MIGRATION_HISTORY_MISMATCH');
});

it('refuses missing or reordered applied history', async () => {
  const run = runner();
  await run(pool, directory);
  await writeFile(join(directory, '0000_earlier.sql'), 'SELECT 1;');
  await expect(run(pool, directory)).rejects.toThrow('MIGRATION_HISTORY_MISMATCH');
  await rm(join(directory, '0000_earlier.sql'));
  await rm(join(directory, '0001_widgets.sql'));
  await expect(run(pool, directory)).rejects.toThrow('MIGRATION_HISTORY_MISMATCH');
});

it('rolls back failed DDL and its ledger entry, then permits a corrected retry', async () => {
  const run = runner();
  await run(pool, directory);
  const path = join(directory, '0002_broken.sql');
  await writeFile(path, 'CREATE TABLE rolled_back (id integer); SELECT missing_column FROM widgets;');
  await expect(run(pool, directory)).rejects.toThrow('MIGRATION_FAILED:0002_broken.sql');
  expect((await pool.query("SELECT to_regclass('rolled_back') AS name")).rows[0].name).toBeNull();
  expect((await pool.query('SELECT name FROM unai_migrations.applied')).rows).toEqual([{ name: '0001_widgets.sql' }]);
  await writeFile(path, 'CREATE TABLE rolled_back (id integer);');
  expect(await run(pool, directory)).toEqual(['0002_broken.sql']);
});

it('serializes concurrent migration runners', async () => {
  const run = runner();
  const outcomes = await Promise.all([run(pool, directory), run(pool, directory)]);
  expect(outcomes.flat()).toEqual(['0001_widgets.sql']);
});

it('refuses duplicate migration sequence numbers before applying any SQL', async () => {
  const run = runner();
  await writeFile(join(directory, '0001_duplicate.sql'), 'SELECT 1;');
  await expect(run(pool, directory)).rejects.toThrow('MIGRATION_NAMES_INVALID');
  expect((await pool.query("SELECT to_regclass('widgets') AS name")).rows[0].name).toBeNull();
});

it('the migration CLI refuses to run without explicit deployment configuration', () => {
  const { UNAI_MIGRATION_DATABASE_URL: _url, UNAI_DATABASE_CA_PATH: _ca, ...env } = process.env;
  const cli = createRequire(import.meta.url).resolve('tsx/cli');
  const result = spawnSync(process.execPath, [cli, 'packages/postgres/src/migrate-cli.ts'], { env, encoding: 'utf8' });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('MIGRATION_TLS_CONFIGURATION_REQUIRED');
  expect(result.stderr).not.toContain('ERR_MODULE_NOT_FOUND');
});
