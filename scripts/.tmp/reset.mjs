import { createRequire } from 'node:module';
const require = createRequire(new URL('../../packages/postgres/package.json', import.meta.url));
const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgresql://postgres:unai-test-only@127.0.0.1:55432/postgres', max: 1 });
try {
  await pool.query('DROP DATABASE IF EXISTS unai_test WITH (FORCE)');
  await pool.query('CREATE DATABASE unai_test');
  console.log('reset');
} finally { await pool.end(); }
