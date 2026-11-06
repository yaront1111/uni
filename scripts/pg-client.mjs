import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { POSTGRES_IMAGE } from './postgres-harness.mjs';

/** PostgreSQL client tools for the tests that dump, restore or provision through a verified-TLS terminator on this
 * host's 127.0.0.1 (src/backup.test.ts, src/restore.test.ts, deploy/postgres/provision.test.ts). Test infrastructure
 * only: no start script, deploy file or package references it.
 *
 * Why never `docker run --network host pg_dump`: under Docker Desktop (WSL included) the engine runs in its own VM, so
 * a host-network container shares that VM's loopback, not this host's. It gets "Connection refused" from the tests'
 * 127.0.0.1 terminator and from a published port alike. So the pinned image's own binaries run HERE as host processes:
 * one `--network none` container copies each tool with its shared-library closure into a directory the caller owns, and
 * the image's own dynamic loader starts them with `--library-path`, so neither the host's glibc nor its libpq matters.
 * No container runs at test time, and libpq's PGSSLMODE, PGSSLROOTCERT and pgpass reach the binary unchanged.
 *
 * This module reads no environment member. */

const TOOLS = ['pg_dump', 'pg_restore', 'psql'];
/** `major + NUL + directory` to the extracted loader and library directory. Only successes are kept. */
const extracted = new Map();
/** Five lines, run as `bash -c COPY bash <directory> <major>`. ldd runs per file: several files print `<file>:` headers. */
const COPY = [
  'set -euo pipefail',
  'out=$1; bin=/usr/lib/postgresql/$2/bin',
  'mkdir -p "$out/lib"',
  'cp -L "$bin/pg_dump" "$bin/pg_restore" "$bin/psql" "$out/"',
  'for tool in pg_dump pg_restore psql; do ldd "$bin/$tool"; done | grep -o "/[^ ]*" | sort -u | xargs cp -L -t "$out/lib/"',
].join('\n');

function extract(dir, major, fail) {
  // A native daemon creates a missing bind source as root, and the container user could then not write to it.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const copy = spawnSync('docker', ['run', '--rm', '--network', 'none', '--user', `${process.getuid()}:${process.getgid()}`,
    '--volume', `${dir}:${dir}`, '--entrypoint', 'bash', POSTGRES_IMAGE, '-c', COPY, 'bash', dir, String(major)],
  { encoding: 'utf8', timeout: 120000 });
  // The container gets no --env, so no credential can be in what it says.
  if (copy.error) throw fail(copy.error.message);
  if (copy.status !== 0) throw fail(copy.stderr.trim() || `docker exited ${copy.status}`);
  const lib = join(dir, 'lib');
  const loaderName = existsSync(lib) ? readdirSync(lib).find(name => name.startsWith('ld-linux')) : undefined;
  if (!loaderName) throw fail('the image has no dynamic loader for its clients');
  const loader = join(lib, loaderName);
  for (const name of TOOLS) {
    const probe = spawnSync(loader, ['--inhibit-cache', '--library-path', lib, join(dir, name), '--version'], { encoding: 'utf8', timeout: 30000 });
    if (probe.error || probe.status !== 0 || !probe.stdout.includes(`(PostgreSQL) ${major}.`)) {
      throw fail(`${name} --version does not report PostgreSQL ${major} on this host`);
    }
  }
  return { loader, lib };
}

/** The pinned image's own `tool` of PostgreSQL `major`, as an argv prefix of absolute paths that runs on this Linux host.
 * Extracted once per major and directory; `directory` belongs to the caller, who removes it. */
export function imagePgClient(tool, major, directory) {
  if (!TOOLS.includes(tool) || !Number.isInteger(major) || major < 1) throw new Error('PG_CLIENT_TOOL_INVALID');
  const fail = cause => new Error(`PG_CLIENT_IMAGE_FAILED: ${tool} ${major}: ${cause}`);
  if (process.platform !== 'linux') throw fail('the image clients run only on Linux');
  const dir = resolve(directory);
  // The directory is bind-mounted as `<dir>:<dir>`, where these two characters are volume syntax.
  if (/[:,]/.test(dir)) throw fail('the directory name cannot be bind-mounted');
  const key = `${major}\0${dir}`;
  let found = extracted.get(key);
  if (!found) {
    found = extract(dir, major, fail);
    extracted.set(key, found);
  }
  return [found.loader, '--inhibit-cache', '--library-path', found.lib, join(dir, tool)];
}

/** An argv prefix for `tool` of PostgreSQL `major`: a host binary of that major, else the image's own on Linux. */
export function pgClient(tool, major, directory) {
  const host = `/usr/lib/postgresql/${major}/bin/${tool}`;
  if (existsSync(host)) return [host];
  // A spawn error (WSL's EACCES from inherited Windows PATH entries, for one) means absent.
  const onPath = spawnSync(tool, ['--version'], { encoding: 'utf8' });
  if (!onPath.error && onPath.status === 0 && onPath.stdout.includes(`(PostgreSQL) ${major}.`)) return [tool];
  if (process.platform === 'linux') return imagePgClient(tool, major, directory);
  throw new Error(`PG_CLIENT_REQUIRED: ${tool} ${major}: put PostgreSQL ${major}'s ${tool} on PATH (scripts/CLAUDE.md, PostgreSQL client tools for the tests)`);
}
