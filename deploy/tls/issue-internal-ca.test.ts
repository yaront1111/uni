import {spawnSync} from 'node:child_process';
import {X509Certificate, createPrivateKey} from 'node:crypto';
import {chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {afterAll, describe, expect, it} from 'vitest';

// deploy/tls/issue-internal-ca.sh against a temporary UNAI_DEPLOY_ROOT with the
// host's openssl. chown and getent are stubs; keys exist only under os.tmpdir().
const root = resolve(import.meta.dirname, '../..');
const script = join(root, 'deploy/tls/issue-internal-ca.sh');
const temporary = mkdtempSync(join(tmpdir(), 'unai-internal-ca-'));
afterAll(() => rmSync(temporary, {recursive: true, force: true}));
let scratchCount = 0;
function scratch(name: string): string {
  const directory = join(temporary, `${name}-${scratchCount++}`);
  mkdirSync(directory, {recursive: true});
  return directory;
}
function write(path: string, content: string, mode = 0o644): void {
  mkdirSync(resolve(path, '..'), {recursive: true});
  writeFileSync(path, content, {mode});
}
// A PATH stub: logs `<name> <args>` to $STUB_LOG, then runs body (copied from deploy/scripts.test.ts).
function stub(directory: string, name: string, body = ''): void {
  write(join(directory, name), `#!/usr/bin/env bash\nprintf '%s\\n' "${name} $*" >> "$STUB_LOG"\n${body}\n`, 0o755);
}
// Next.js's global types make NODE_ENV a required ProcessEnv key.
const childEnv = (vars: Record<string, string>): NodeJS.ProcessEnv => ({NODE_ENV: 'test', ...vars});
const logLines = (log: string) => existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];

const getent = [
  '[[ ${1:-} == group && ${2:-} != "${STUB_MISSING_GROUP:-}" ]] || exit 2',
  'case $2 in unai-api) echo unai-api:x:990: ;; postgres) echo postgres:x:991: ;; *) exit 2 ;; esac',
].join('\n');
const files = ['ca/ca.key', 'ca/ca.pem', 'api/cert.pem', 'api/key.pem', 'postgres/cert.pem', 'postgres/key.pem'];
const day = 86_400_000;

function fixture(options: {tls?: boolean} = {}) {
  const base = scratch('ca');
  const R = join(base, 'root');
  const tls = join(R, 'etc/unai/tls');
  const created = options.tls === false ? join(R, 'etc/unai') : tls;
  mkdirSync(created, {recursive: true});
  chmodSync(created, 0o755);
  const stubs = join(base, 'stubs');
  const failing = join(base, 'failing');
  const log = join(base, 'stub.log');
  stub(stubs, 'getent', getent);
  stub(stubs, 'chown');
  stub(failing, 'getent', getent);
  for (const name of ['openssl', 'chmod', 'chown', 'mkdir', 'mv', 'rm', 'flock']) stub(failing, name, 'exit 97');
  const env = (options: {dry?: boolean; deployRoot?: boolean; extra?: Record<string, string>} = {}) => {
    const vars: Record<string, string> = {PATH: `${options.dry ? failing : stubs}:${process.env.PATH ?? ''}`, STUB_LOG: log, ...options.extra};
    if (options.deployRoot !== false) vars.UNAI_DEPLOY_ROOT = R;
    return childEnv(vars);
  };
  const run = (argv: string[] = [], options: Parameters<typeof env>[0] = {}) =>
    spawnSync('bash', [script, ...argv], {encoding: 'utf8', env: env(options)});
  const snapshot = () => Object.fromEntries(files.map(file =>
    [file, {bytes: readFileSync(join(tls, file)), mode: statSync(join(tls, file)).mode & 0o777}]));
  const tree = () => readdirSync(R, {recursive: true, encoding: 'utf8'}).sort();
  return {R, tls, log, env, run, snapshot, tree};
}

const certificate = (path: string) => new X509Certificate(readFileSync(path));
const extensions = (path: string, names: string) =>
  spawnSync('openssl', ['x509', '-in', path, '-noout', '-ext', names], {encoding: 'utf8'}).stdout
    .split('\n').map(line => line.trim()).filter(Boolean);
function expectP256(keyPath: string, cert: X509Certificate): void {
  const key = createPrivateKey(readFileSync(keyPath));
  expect(key.asymmetricKeyType).toBe('ec');
  expect(key.asymmetricKeyDetails).toEqual({namedCurve: 'prime256v1'});
  expect(cert.publicKey.asymmetricKeyDetails).toEqual({namedCurve: 'prime256v1'});
  expect(cert.checkPrivateKey(key)).toBe(true);
}
function expectLeaf(tls: string, name: string, subject: string, san: string): X509Certificate {
  const ca = certificate(join(tls, 'ca/ca.pem'));
  const path = join(tls, name, 'cert.pem');
  const cert = certificate(path);
  expect([cert.subject, cert.issuer, cert.ca, cert.subjectAltName]).toEqual([`CN=${subject}`, 'CN=Uai internal CA', false, san]);
  expect(cert.validToDate.getTime() - cert.validFromDate.getTime()).toBe(365 * day);
  expect(extensions(path, 'basicConstraints,keyUsage,extendedKeyUsage')).toEqual(['X509v3 Basic Constraints: critical', 'CA:FALSE',
    'X509v3 Key Usage: critical', 'Digital Signature', 'X509v3 Extended Key Usage:', 'TLS Web Server Authentication']);
  expectP256(join(tls, name, 'key.pem'), cert);
  expect(cert.checkIssued(ca)).toBe(true);
  expect(cert.verify(ca.publicKey)).toBe(true);
  const verified = spawnSync('openssl', ['verify', '-x509_strict', '-CAfile', join(tls, 'ca/ca.pem'), path], {encoding: 'utf8'});
  expect([verified.status, verified.stdout]).toEqual([0, `${path}: OK\n`]);
  return cert;
}
// `chown root:<group> <path>...` log lines, as owner/path pairs relative to tls, temp names folded.
const owners = (log: string, tls: string) => new Set(logLines(log).filter(line => line.startsWith('chown ')).flatMap(line => {
  const [, owner, ...paths] = line.split(' ');
  return paths.map(path => `${owner} ${path.slice(tls.length + 1).replace(/\.new$/, '')}`);
}));
const d2Owners = new Set(['root:root ca', 'root:root ca/ca.pem', 'root:root ca/ca.key',
  'root:unai-api api', 'root:unai-api api/cert.pem', 'root:unai-api api/key.pem',
  'root:postgres postgres', 'root:postgres postgres/cert.pem', 'root:postgres postgres/key.pem']);
const genpkeys = (stdout: string) => stdout.split('\n').filter(line => line.startsWith('+ openssl genpkey ')).length;

describe.runIf(process.platform === 'linux')('deploy/tls/issue-internal-ca.sh', () => {
  it('issues the D2 CA: P-256, 3650 days, CA:TRUE pathlen:0, certificate and CRL signing only', () => {
    const {tls, run} = fixture();
    const result = run();
    expect([result.status, result.stderr]).toEqual([0, '']);
    const ca = certificate(join(tls, 'ca/ca.pem'));
    expect([ca.ca, ca.subject, ca.issuer]).toEqual([true, 'CN=Uai internal CA', 'CN=Uai internal CA']);
    expect(ca.validToDate.getTime() - ca.validFromDate.getTime()).toBe(3650 * day);
    expectP256(join(tls, 'ca/ca.key'), ca);
    expect(extensions(join(tls, 'ca/ca.pem'), 'basicConstraints,keyUsage')).toEqual(['X509v3 Basic Constraints: critical',
      'CA:TRUE, pathlen:0', 'X509v3 Key Usage: critical', 'Certificate Sign, CRL Sign']);
  });

  it('issues the API and PostgreSQL leaves with exactly their SANs, chained to the CA', () => {
    const {tls, run} = fixture();
    expect(run().status).toBe(0);
    expectLeaf(tls, 'api', 'Uai API', 'IP Address:127.0.0.1');
    expectLeaf(tls, 'postgres', 'Uai PostgreSQL', 'IP Address:127.0.0.1, DNS:localhost');
  });

  it('gives every directory and file its D2 mode and owner, and leaves no temp file', () => {
    const {tls, log, run} = fixture();
    const result = run();
    expect(result.status).toBe(0);
    // Each *.new gets its mode and owner before it moves; certificates move before keys.
    const lines = result.stdout.split('\n');
    const moves = lines.flatMap((line, index) => {
      if (!line.startsWith('+ mv -f -- ')) return [];
      const [source, destination] = line.split(' ').slice(4) as [string, string];
      for (const command of ['+ chmod ', '+ chown ']) {
        expect(lines.slice(0, index).some(earlier => earlier.startsWith(command) && earlier.split(' ').includes(source)), `${command}${source}`).toBe(true);
      }
      return [destination.slice(tls.length + 1)];
    });
    expect(moves).toEqual(['ca/ca.pem', 'ca/ca.key', 'api/cert.pem', 'api/key.pem', 'postgres/cert.pem', 'postgres/key.pem']);
    const modes =Object.fromEntries(['ca', 'ca/ca.pem', 'ca/ca.key', 'api', 'api/cert.pem', 'api/key.pem', 'postgres',
      'postgres/cert.pem', 'postgres/key.pem'].map(path => [path, (statSync(join(tls, path)).mode & 0o777).toString(8)]));
    expect(modes).toEqual({'ca': '755', 'ca/ca.pem': '644', 'ca/ca.key': '400', 'api': '750', 'api/cert.pem': '640',
      'api/key.pem': '640', 'postgres': '750', 'postgres/cert.pem': '640', 'postgres/key.pem': '640'});
    expect(readdirSync(tls).sort()).toEqual(['api', 'ca', 'postgres']);
    expect(readdirSync(join(tls, 'ca')).sort()).toEqual(['ca.key', 'ca.pem']);
    for (const name of ['api', 'postgres']) expect(readdirSync(join(tls, name)).sort()).toEqual(['cert.pem', 'key.pem']);
    expect(owners(log, tls)).toEqual(d2Owners);
  });

  it('converges drifted modes and owners of kept files without re-issuing them', () => {
    const {tls, log, run, snapshot} = fixture();
    expect(run().status).toBe(0);
    const issued = snapshot();
    const drift: Array<[string, number]> = [['ca', 0o700], ['ca/ca.key', 0o600], ['ca/ca.pem', 0o600], ['api', 0o755],
      ['api/key.pem', 0o644], ['postgres/cert.pem', 0o600]];
    for (const [path, mode] of drift) chmodSync(join(tls, path), mode);
    rmSync(log, {force: true});
    const result = run();
    expect([result.status, result.stderr]).toEqual([0, '']);
    expect(genpkeys(result.stdout)).toBe(0);
    expect(snapshot()).toEqual(issued);
    expect(['ca', 'api'].map(path => (statSync(join(tls, path)).mode & 0o777).toString(8))).toEqual(['755', '750']);
    expect(owners(log, tls)).toEqual(d2Owners);
  });

  it('changes no byte and no mode on a second run', () => {
    const {run, snapshot} = fixture();
    expect(run().status).toBe(0);
    const before = snapshot();
    const result = run();
    expect([result.status, result.stderr]).toEqual([0, '']);
    expect(genpkeys(result.stdout)).toBe(0);
    expect(snapshot()).toEqual(before);
  });

  it('re-issues both leaves with --renew-leaves and keeps the CA byte-identical', () => {
    const {tls, run, snapshot} = fixture();
    expect(run().status).toBe(0);
    const before = snapshot();
    const serials = ['api', 'postgres'].map(name => certificate(join(tls, name, 'cert.pem')).serialNumber);
    const result = run(['--renew-leaves']);
    expect([result.status, result.stderr]).toEqual([0, '']);
    const after = snapshot();
    for (const file of ['ca/ca.key', 'ca/ca.pem']) expect(after[file], file).toEqual(before[file]);
    for (const file of ['api/cert.pem', 'api/key.pem', 'postgres/cert.pem', 'postgres/key.pem']) {
      expect(after[file]!.bytes.equals(before[file]!.bytes), file).toBe(false);
      expect(after[file]!.mode, file).toBe(0o640);
    }
    const renewed = [expectLeaf(tls, 'api', 'Uai API', 'IP Address:127.0.0.1'),
      expectLeaf(tls, 'postgres', 'Uai PostgreSQL', 'IP Address:127.0.0.1, DNS:localhost')];
    renewed.forEach((cert, index) => expect(cert.serialNumber).not.toBe(serials[index]));
  });

  it('re-issues kept leaves when it issues a new CA, so they chain to it', () => {
    const {tls, run, snapshot} = fixture();
    expect(run().status).toBe(0);
    const before = snapshot();
    for (const file of ['ca/ca.key', 'ca/ca.pem']) rmSync(join(tls, file));
    const result = run();
    expect([result.status, result.stderr]).toEqual([0, '']);
    expect(genpkeys(result.stdout)).toBe(3);
    const after = snapshot();
    for (const file of files) expect(after[file]!.bytes.equals(before[file]!.bytes), file).toBe(false);
    expectLeaf(tls, 'api', 'Uai API', 'IP Address:127.0.0.1');
    expectLeaf(tls, 'postgres', 'Uai PostgreSQL', 'IP Address:127.0.0.1, DNS:localhost');
  });

  it('executes nothing in --dry-run and plans only what is missing', () => {
    const {tls, log, run, snapshot} = fixture();
    const dry = (argv: string[] = []) => {
      rmSync(log, {force: true});
      const result = run(['--dry-run', ...argv], {dry: true});
      expect([result.status, result.stderr]).toEqual([0, '']);
      expect(logLines(log)).toEqual(['getent group unai-api', 'getent group postgres']);
      return genpkeys(result.stdout);
    };
    expect(dry()).toBe(3);
    expect(readdirSync(tls)).toEqual([]);
    expect(run().status).toBe(0);
    const issued = snapshot();
    expect(dry()).toBe(0);
    expect(dry(['--renew-leaves'])).toBe(2);
    expect(snapshot()).toEqual(issued);
  });

  it.each([
    ['an unknown flag', {argv: ['--force']}, 'INTERNAL_CA_USAGE'],
    ['a missing tls directory', {tls: false}, 'INTERNAL_CA_TLS_DIRECTORY_MISSING'],
    ['a missing postgres group', {extra: {STUB_MISSING_GROUP: 'postgres'}}, 'INTERNAL_CA_POSTGRES_MISSING'],
    ['a missing unai-api group', {extra: {STUB_MISSING_GROUP: 'unai-api'}}, 'INTERNAL_CA_USERS_MISSING'],
  ])('refuses %s and creates nothing', (_, options: {argv?: string[]; tls?: boolean; extra?: Record<string, string>}, code) => {
    const {log, run, tree} = fixture({tls: options.tls ?? true});
    const before = tree();
    const result = run(options.argv ?? [], {extra: options.extra ?? {}});
    expect([result.status, result.stderr, result.stdout]).toEqual([1, `${code}\n`, '']);
    expect(tree()).toEqual(before);
    expect(logLines(log).filter(line => line.startsWith('chown '))).toEqual([]);
  });

  it.each(['ca.pem', 'ca.key'])('refuses a lone %s with INTERNAL_CA_INCOMPLETE and leaves it unchanged', name => {
    const {tls, log, run, tree} = fixture();
    write(join(tls, 'ca', name), 'LONE\n', 0o600);
    const before = tree();
    const result = run();
    expect([result.status, result.stderr, result.stdout]).toEqual([1, 'INTERNAL_CA_INCOMPLETE\n', '']);
    expect(readFileSync(join(tls, 'ca', name), 'utf8')).toBe('LONE\n');
    expect(tree()).toEqual(before);
    expect(logLines(log).filter(line => line.startsWith('chown '))).toEqual([]);
  });

  it('refuses a second run while one holds the lock on the tls directory', () => {
    const {tls, log, env, tree} = fixture();
    const before = tree();
    const result = spawnSync('flock', [tls, 'bash', script], {encoding: 'utf8', env: env()});
    expect([result.status, result.stderr, result.stdout]).toEqual([1, 'INTERNAL_CA_BUSY\n', '']);
    expect(tree()).toEqual(before);
    expect(logLines(log).filter(line => line.startsWith('chown '))).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0)('refuses a real run without root or a deploy root before any probe', () => {
    const {log, run, tree} = fixture();
    const before = tree();
    const result = run([], {deployRoot: false});
    expect([result.status, result.stderr, result.stdout]).toEqual([1, 'INTERNAL_CA_ROOT_REQUIRED\n', '']);
    expect(existsSync(log)).toBe(false);
    expect(tree()).toEqual(before);
  });
});
