/**
 * Rehearses the daemon verifier's database provisioning EXACTLY as
 * apps/daemon/src/orchestrator/verifier-database{,-provisioning}.ts performs it, then runs the
 * two commands the verifier runs in order: `pnpm db:migrate` and then the node's verification
 * command. Local `pnpm test` starts its own plain-TCP container and therefore never exercises
 * the TLS server, the `app` superuser, the `postgres://` scheme or the delivered variable names
 * the verifier actually hands over — the shapes a delivery can only discover in review.
 *
 * Diagnostic only: nothing in the product reads this file, and `pnpm test` does not run it.
 *   node scripts/verifier-rehearsal.mjs
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const IMAGE = process.env.MOE_VERIFIER_DB_IMAGE ?? 'pgvector/pgvector:pg17';
const URL_VARS = (process.env.MOE_VERIFIER_DB_URL_VARS ?? 'DATABASE_URL,UNAI_MIGRATION_DATABASE_URL').split(',');
const CA_VAR = process.env.MOE_VERIFIER_DB_CA_VAR ?? 'UNAI_DATABASE_CA_PATH';
const DATA = '/var/lib/postgresql/data';

const name = 'moe-verifier-rehearsal-' + randomUUID();
const password = randomBytes(18).toString('hex');
let caDirectory;

function docker(args, options = {}) {
  return spawnSync('docker', args, { encoding: 'utf8', timeout: 180000, ...options });
}
function must(step, result) {
  if (result.status !== 0) {
    throw new Error(step + ' failed: ' + (result.stderr || result.stdout || result.error));
  }
  return result.stdout;
}

try {
  console.log('Starting ' + IMAGE + ' the way the verifier starts it...');
  must('docker run', docker(['run', '--detach', '--rm', '--name', name,
    '--publish', '127.0.0.1:0:5432', '--env', 'POSTGRES_PASSWORD=' + password,
    '--env', 'POSTGRES_USER=app', '--env', 'POSTGRES_DB=app', IMAGE]));

  for (let attempt = 0; ; attempt++) {
    if (docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'app', '-d', 'app']).status === 0) break;
    if (attempt > 240) throw new Error('POSTGRES_NOT_READY');
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},250)']);
  }

  console.log('Minting the in-container certificate and enabling TLS by reload...');
  must('tls mint', docker(['exec', '--user', 'root', name, 'sh', '-ec',
    ['cd ' + DATA,
      'openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=moe-verifier'
        + ' -addext subjectAltName=IP:127.0.0.1,DNS:localhost'
        + ' -addext basicConstraints=critical,CA:TRUE'
        + ' -keyout server.key -out server.crt',
      'chown postgres:postgres server.key server.crt',
      'chmod 600 server.key'].join(' && ')]));
  must('tls enable', docker(['exec', '--user', 'postgres', name, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'app', '-d', 'app',
    '-c', "ALTER SYSTEM SET ssl = 'on'", '-c', "ALTER SYSTEM SET ssl_cert_file = 'server.crt'",
    '-c', "ALTER SYSTEM SET ssl_key_file = 'server.key'", '-c', 'SELECT pg_reload_conf()']));
  const certificate = must('tls extract', docker(['exec', name, 'cat', DATA + '/server.crt'])).trim();
  caDirectory = mkdtempSync(join(tmpdir(), 'moe-verifier-ca-'));
  const caPath = join(caDirectory, 'ca.crt');
  writeFileSync(caPath, certificate + '\n', { mode: 0o600 });

  const binding = must('docker port', docker(['port', name, '5432/tcp'])).trim();
  const url = 'postgres://app:' + password + '@' + binding + '/app';
  const delivered = { ...process.env, [CA_VAR]: caPath };
  for (const variable of URL_VARS) delivered[variable.trim()] = url;
  // The verifier delivers ONLY these; a local UNAI_TEST_DATABASE_URL would hide the difference.
  delete delivered.UNAI_TEST_DATABASE_URL;

  const commands = process.argv.slice(2);
  for (const command of commands.length > 0 ? commands : ['pnpm db:migrate', 'pnpm test']) {
    console.log('\n=== ' + command + ' ===');
    const run = spawnSync(command, { cwd: process.cwd(), env: delivered, shell: true, stdio: 'inherit', timeout: 900000 });
    console.log('=== exit ' + run.status + ' ===');
    if (run.status !== 0) { process.exitCode = 1; break; }
  }
} catch (error) {
  console.error('REHEARSAL_FAILED: ' + error.message);
  process.exitCode = 1;
} finally {
  if (caDirectory) rmSync(caDirectory, { force: true, recursive: true });
  docker(['stop', name]);
}
