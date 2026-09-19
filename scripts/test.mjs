import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {mkdir,readFile,writeFile,unlink} from 'node:fs/promises';
import {acceptanceResults} from './acceptance-gate.mjs';
import {deliveredStorage,startStorageHarness} from './storage-harness.mjs';

const {Pool}=createRequire(new URL('../packages/postgres/package.json',import.meta.url))('pg');
const name = 'unai-test-' + randomUUID();
function docker(args) {
  const result = spawnSync('docker', args, { encoding:'utf8', timeout:120000 });
  if (result.error || result.status !== 0) throw new Error(result.stderr || String(result.error));
  return result.stdout.trim();
}
/** Each provisioning step fails under its own name, so a harness that cannot start
 * is never reported as a database, migration or product-code failure. */
class StepError extends Error {
  constructor(step,cause){ super(step+': '+cause); this.step=step; }
}
/** A caller that provisions its own PostgreSQL/pgvector server delivers the URL
 * instead of Docker; the migrations and the suite run against it unchanged. */
const delivered = process.env.UNAI_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
async function connect(url) {
  const pool = new Pool({ connectionString:url, connectionTimeoutMillis:2000, max:1 });
  try {
    for (let attempt=0; attempt<120; attempt++) {
      try { await pool.query('SELECT 1'); return true; } catch { await setTimeout(250); }
    }
    return false;
  } finally { await pool.end().catch(()=>{}); }
}
/** The Git migrations run before any optional harness starts, against the same
 * runner the suite uses. runMigrations is idempotent, so the per-file fixtures
 * that also call it still see their expected schema. */
async function migrate(url) {
  const unregister = (await import('tsx/esm/api')).register();
  try {
    const { runMigrations } = await import('../packages/postgres/src/migrations.ts');
    const pool = new Pool({ connectionString:url, max:1 });
    try { return await runMigrations(pool, fileURLToPath(new URL('../migrations',import.meta.url))); }
    finally { await pool.end().catch(()=>{}); }
  } finally { await unregister(); }
}
/** The suite owns its schema and its rows, so it runs on a database of its own on the
 * delivered server rather than on the delivered database itself: an immutable row a
 * previous run published, such as the registry 0.1.0 snapshot, must never decide
 * whether this run passes. Roles stay cluster-global, which the migrations handle.
 * A server that refuses the database keeps the delivered one. */
async function disposableDatabase(url) {
  const name = 'unai_test_' + randomUUID().replaceAll('-', '');
  const pool = new Pool({ connectionString: url, max: 1 });
  try { await pool.query('CREATE DATABASE ' + name); }
  catch (error) { console.log('Delivered server refused a disposable database (' + error.message + '); using the delivered database.'); return null; }
  finally { await pool.end().catch(() => {}); }
  const scratch = new URL(url); scratch.pathname = '/' + name;
  return { name, url: scratch.href };
}
async function dropDatabase(url, name) {
  const pool = new Pool({ connectionString: url, max: 1 });
  try { await pool.query('DROP DATABASE IF EXISTS ' + name + ' WITH (FORCE)'); }
  catch { await pool.query('DROP DATABASE IF EXISTS ' + name); }
  finally { await pool.end().catch(() => {}); }
}
let created = false;
let storage;
let scratch;
try {
  let databaseUrl = delivered;
  if (delivered) {
    console.log('Using the delivered PostgreSQL/pgvector server for the full suite...');
    scratch = await disposableDatabase(delivered);
    if (scratch) { databaseUrl = scratch.url; console.log('Disposable database for this run: ' + scratch.name + '.'); }
  } else {
    console.log('Starting disposable PostgreSQL/pgvector for the full suite...');
    try {
      docker(['run','--detach','--rm','--name',name,'--publish','127.0.0.1::5432',
        '--env','POSTGRES_PASSWORD=unai-test-only','--env','POSTGRES_DB=unai_test',
        '--tmpfs','/var/lib/postgresql/data','pgvector/pgvector@sha256:cf134a767f474095eeba57e0117be8e568e011a63f33fbf252f14c9b760f8e6f']);
      created = true;
      const binding=JSON.parse(docker(['inspect','--format','{{json .NetworkSettings.Ports}}',name]))['5432/tcp'][0];
      databaseUrl='postgresql://postgres:unai-test-only@127.0.0.1:'+binding.HostPort+'/unai_test';
    } catch(error) { throw new StepError('DATABASE_PROVISIONING_FAILED',error.message); }
  }
  if(!await connect(databaseUrl)) throw new StepError('DATABASE_NOT_READY','test PostgreSQL did not answer SELECT 1');
  console.log('Applying the Git SQL migrations...');
  let applied;
  try { applied = await migrate(databaseUrl); }
  catch(error) { throw new StepError('MIGRATION_FAILED',error.message); }
  console.log('Migrations: '+(applied.length?applied.join(', '):'schema already current')+'.');
  try { storage = deliveredStorage() ?? await startStorageHarness(); }
  catch(error) { throw new StepError('STORAGE_PROVISIONING_FAILED',error.message); }
  console.log('Object storage: '+storage.description+'.');
  // vitest runs as an awaited child, never spawnSync: a harness that serves object
  // storage from this process must keep answering requests while the suite runs.
  await mkdir('test-results/acceptance',{recursive:true});
  const testReport='test-results/acceptance/vitest.json';
  for(const path of [testReport,'test-results/acceptance/scenarios.json','test-results/performance/load.json','test-results/performance/trace.json']){
    await unlink(path).catch(error=>{if(error.code!=='ENOENT')throw error;});
  }
  const test=spawn(process.execPath,['node_modules/vitest/vitest.mjs','run','--silent=passed-only','--reporter=default','--reporter=json','--outputFile.json='+testReport],{
    stdio:'inherit',
    env:{...process.env,...storage.env,UNAI_TEST_DATABASE_URL:databaseUrl},
  });
  process.exitCode=await new Promise((resolve,reject)=>{
    test.once('error',reject);
    test.once('close',code=>resolve(code ?? 1));
  });
  const acceptance=acceptanceResults(JSON.parse(await readFile(testReport,'utf8')));
  await writeFile('test-results/acceptance/scenarios.json',JSON.stringify({format:'unai-acceptance/1',scenarios:acceptance},null,2)+'\n');
  const failed=acceptance.filter(scenario=>!scenario.passed);
  if(failed.length){console.error('ACCEPTANCE_SCENARIOS_FAILED: '+failed.map(row=>row.scenario).join(', '));process.exitCode=1;}
  else console.log('Acceptance scenarios: 20/20 passed.');
} catch(error) {
  console.error(error.step?error.message:'TEST_HARNESS_FAILED: '+error.message); process.exitCode=1;
} finally {
  try{storage?.close();}catch(error){console.error('STORAGE_CLEANUP_FAILED: '+error.message);process.exitCode=1;}
  // A leaked scratch database is an operator cleanup task, never a suite result: name
  // it and keep the exit code the verdict the tests actually reached.
  if(scratch) {
    try { await dropDatabase(delivered,scratch.name); }
    catch(error) { console.error('DATABASE_CLEANUP_WARNING: drop '+scratch.name+' manually: '+error.message); }
  }
  if(created) {
    try { docker(['stop',name]); }
    catch(error) { console.error('DATABASE_CLEANUP_FAILED: '+error.message); process.exitCode=1; }
  }
}
