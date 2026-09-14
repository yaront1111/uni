import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Pool } from 'pg';

/** Trusted Git SQL only. Use a dedicated migration pool, never the application pool. */
export async function runMigrations(pool: Pool, directory: string): Promise<string[]> {
  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.name.endsWith('.sql')).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const sequences = new Set<string>();
  for (const entry of entries) {
    const sequence = entry.name.slice(0, 4);
    if (!entry.isFile() || !/^\d{4}_[a-z0-9_]+\.sql$/.test(entry.name) || sequences.has(sequence)) {
      throw new Error('MIGRATION_NAMES_INVALID');
    }
    sequences.add(sequence);
  }
  const files = await Promise.all(entries.map(async entry => {
    const bytes = await readFile(resolve(directory, entry.name));
    const sql = bytes.toString('utf8').trim();
    // Compatibility with the foundation migration's existing outer transaction.
    // Embedded transaction control is forbidden by the repository migration convention.
    const body = /^BEGIN\s*;/i.test(sql) && /COMMIT\s*;$/i.test(sql)
      ? sql.replace(/^BEGIN\s*;/i, '').replace(/COMMIT\s*;$/i, '') : sql;
    return { name: entry.name, digest: createHash('sha256').update(bytes).digest('hex'), body };
  }));
  const client = await pool.connect();
  let locked = false;
  try {
    await client.query("SET statement_timeout = '30s'");
    await client.query('SELECT pg_advisory_lock(1970170217, 1)');
    locked = true;
    await client.query(`BEGIN;
      CREATE SCHEMA IF NOT EXISTS unai_migrations;
      REVOKE ALL ON SCHEMA unai_migrations FROM PUBLIC;
      CREATE TABLE IF NOT EXISTS unai_migrations.applied (
        name text PRIMARY KEY,
        digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
        applied_at timestamptz NOT NULL DEFAULT now()
      );
      REVOKE ALL ON unai_migrations.applied FROM PUBLIC;
      COMMIT;`);
    const history = (await client.query('SELECT name, digest FROM unai_migrations.applied ORDER BY name')).rows;
    if (history.some((row, i) => row.name !== files[i]?.name || row.digest !== files[i]?.digest)) {
      throw new Error('MIGRATION_HISTORY_MISMATCH');
    }
    const applied: string[] = [];
    for (const file of files.slice(history.length)) {
      try {
        await client.query('BEGIN');
        await client.query(file.body);
        await client.query('INSERT INTO unai_migrations.applied (name, digest) VALUES ($1, $2)', [file.name, file.digest]);
        await client.query('COMMIT');
        applied.push(file.name);
      } catch {
        await client.query('ROLLBACK');
        // PostgreSQL errors can contain private data; expose only the Git filename.
        throw new Error('MIGRATION_FAILED:' + file.name);
      }
    }
    return applied;
  } finally {
    try {
      await client.query('ROLLBACK');
      if (locked) await client.query('SELECT pg_advisory_unlock(1970170217, 1)');
    } finally {
      // Never return privileged session state or a possibly held lock to a pool.
      client.release(true);
    }
  }
}
