import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(new URL('../../packages/postgres/package.json', import.meta.url));
const { Pool } = require('pg');
const url = process.env.DEV_DB_URL;
const unregister = (await import('tsx/esm/api')).register();
const { runMigrations } = await import('../../packages/postgres/src/migrations.ts');
const pool = new Pool({ connectionString: url, max: 1 });
try {
  for (let i=0;i<120;i++){ try { await pool.query('SELECT 1'); break; } catch { await new Promise(r=>setTimeout(r,250)); } }
  const applied = await runMigrations(pool, fileURLToPath(new URL('../../migrations', import.meta.url)));
  console.log('APPLIED:', applied.join(', ') || '(current)');
  const { assertOwnershipCoverage } = await import('../../packages/postgres/src/ownership.ts');
  try { await assertOwnershipCoverage(pool); console.log('COVERAGE OK'); } catch(e){ console.log('COVERAGE:', e.message); }
  const n = await pool.query("SELECT count(*)::int n FROM pg_class c JOIN pg_namespace ns ON c.relnamespace=ns.oid WHERE ns.nspname='public' AND c.relkind='r'");
  console.log('public tables:', n.rows[0].n);
} finally { await pool.end(); await unregister(); }
