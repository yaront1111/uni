import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {afterAll, describe, expect, it} from 'vitest';

// Generic checks for every deploy/**/*.sh (sibling scripts are covered by the glob),
// the secret scan over deploy/**, and the behaviour of install.sh and the certbot hook.
const root = resolve(import.meta.dirname, '..');
const deployFiles = readdirSync(join(root, 'deploy'), {recursive: true, encoding: 'utf8'})
  .map(file => `deploy/${file.split('\\').join('/')}`)
  .filter(file => statSync(join(root, file)).isFile())
  .sort();
const scripts = deployFiles.filter(file => file.endsWith('.sh'));
const shellcheck = spawnSync('shellcheck', ['--version']).status === 0;
const read = (file: string) => readFileSync(join(root, file), 'utf8');
const temporary = mkdtempSync(join(tmpdir(), 'unai-deploy-scripts-'));
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
// A PATH stub: logs `<name> <args>` to $STUB_LOG, then runs body.
function stub(directory: string, name: string, body = ''): void {
  write(join(directory, name), `#!/usr/bin/env bash\nprintf '%s\\n' "${name} $*" >> "$STUB_LOG"\n${body}\n`, 0o755);
}
// Next.js's global types make NODE_ENV a required ProcessEnv key.
const childEnv = (vars: Record<string, string>): NodeJS.ProcessEnv => ({NODE_ENV: 'test', ...vars});
const logLines = (log: string) => existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];

const secretPatterns: ReadonlyArray<readonly [string, RegExp]> = [
  ['aws access key id', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['aws secret access key', /aws_secret_access_key\s*=\s*[A-Za-z0-9/+]{20,}/i],
  ['google access token', /ya29\.[0-9A-Za-z_-]{10,}/],
  ['google refresh token', /\b1\/\/[0-9A-Za-z_-]{20,}/],
  ['google client secret', /GOCSPX-[0-9A-Za-z_-]{10,}/],
  ['anthropic api key', /sk-ant-[0-9A-Za-z_-]{10,}/],
  ['sk- api key', /\bsk-[A-Za-z0-9]{20,}/],
  ['private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['github token', /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/],
  ['omi api key', /omi_dev_[A-Za-z0-9]{8,}/],
  ['url with a password', /[a-z][a-z0-9+.-]*:\/\/[^/\s:@<>]+:[^/\s@<>]+@/i],
  ['sql literal password', /\bPASSWORD\s+'[^']*'/i],
  ['credential variable with a literal', /\b[A-Z0-9_]*(SECRET|TOKEN|API_KEY|PASSWORD)[A-Z0-9_]*=(?!secret:\/\/|<|\/|\s|$)\S+/m],
];
const secretHits = (text: string) => secretPatterns.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);

describe.runIf(process.platform === 'linux')('deploy scripts', () => {
  it('finds the install script and the certbot hook, so the glob is not vacuous', () => {
    expect(scripts).toEqual(expect.arrayContaining(['deploy/install.sh', 'deploy/certbot-deploy-hook.sh']));
  });

  describe.each(scripts)('%s', script => {
    const path = join(root, script);
    it('starts with the bash shebang, then set -euo pipefail', () => {
      const [shebang, ...rest] = read(script).split('\n');
      expect(shebang).toBe('#!/usr/bin/env bash');
      expect(rest.find(line => line.trim() !== '' && !line.startsWith('#'))).toBe('set -euo pipefail');
    });
    it('contains no CR byte', () => {
      expect(read(script).includes('\r')).toBe(false);
    });
    it('passes bash -n', () => {
      const result = spawnSync('bash', ['-n', path], {encoding: 'utf8'});
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
    });
    (shellcheck ? it : it.skip)(shellcheck ? 'passes shellcheck' : 'shellcheck not installed', () => {
      const result = spawnSync('shellcheck', ['--shell=bash', path], {encoding: 'utf8'});
      expect(result.stdout + result.stderr).toBe('');
      expect(result.status).toBe(0);
    });
    it('is checked out with LF (git check-attr)', () => {
      const result = spawnSync('git', ['check-attr', 'eol', '--', script], {cwd: root, encoding: 'utf8'});
      expect(result.stdout).toBe(`${script}: eol: lf\n`);
    });
    it('disables shellcheck checks only with a reason on the same line', () => {
      for (const line of read(script).split('\n').filter(line => line.includes('shellcheck disable='))) {
        expect(line, `${script}: ${line}`).toMatch(/shellcheck disable=SC\d+(,SC\d+)*\s+#\s*\S/);
      }
    });
  });
});

describe('deploy secret scan', () => {
  it('finds no secret in any deploy file except the tests', () => {
    const hits = deployFiles
      .filter(file => !file.endsWith('.test.ts'))
      .flatMap(file => read(file).split('\n').flatMap((line, index) =>
        secretHits(line).map(name => `${file}:${index + 1}: ${name}`)));
    expect(hits).toEqual([]);
  });

  it('detects one synthetic sample per pattern', () => {
    // Built at runtime so this file holds no literal credential.
    const samples = [
      'AK' + 'IA' + 'Q'.repeat(16),
      'aws_secret_access_key' + ' = ' + 'A'.repeat(40),
      'ya' + '29.' + 'a'.repeat(20),
      '1/' + '/' + 'a'.repeat(30),
      'GOC' + 'SPX-' + 'a'.repeat(20),
      'sk-' + 'ant-' + 'a'.repeat(20),
      'sk' + '-' + 'A'.repeat(24),
      '-----BEGIN ' + 'EC PRIVATE' + ' KEY-----',
      'gh' + 'p_' + 'a'.repeat(36),
      'omi_' + 'dev_' + 'a'.repeat(12),
      'postgresql://unai_migrator:' + 'p'.repeat(12) + '@127.0.0.1:5432/unai',
      'CREATE ROLE x LOGIN PASS' + "WORD '" + 'p'.repeat(12) + "'",
      'GITHUB_' + 'TOKEN=' + 'x'.repeat(12),
    ];
    expect(samples).toHaveLength(secretPatterns.length);
    samples.forEach((sample, index) => expect(secretPatterns[index]![1].test(sample), secretPatterns[index]![0]).toBe(true));
  });

  it('permits handles, paths, password-free URLs, psql variables, placeholders and the Node checksum', () => {
    for (const text of [
      'secret://mounted/api-database-url',
      'postgresql://unai_migrator@127.0.0.1:5432/unai',
      "PASSWORD :'api_password'",
      'NEXTAUTH_SECRET=secret://mounted/nextauth-secret',
      'UNAI_SECRETS_MOUNT=/etc/unai/secrets/api',
      '# GOOGLE_CLIENT_SECRET=',
      'UNAI_S3_KMS_KEY_ID=arn:aws:kms:<aws-region>:<aws-account-id>:key/<evidence-key-id>',
      'NODE_SHA256=48cc0e21e048790e54c0cf5749c2725005313d652651c40b7a21feb9697aaf75',
      'readonly AWSCLI_SHA256=d641283d37f1a2168457a9f26a20d4e29167652e9ab1719b37114ef1ebe859f4',
      'readonly OTELCOL_SHA256=1995260c54cf5d74964a85e5e7d27834bb9a252c87a2582a4fb6a6c34565a90d',
    ]) expect(secretHits(text), text).toEqual([]);
  });
});

describe.runIf(process.platform === 'linux')('certbot deploy hook', () => {
  const hook = join(root, 'deploy/certbot-deploy-hook.sh');
  function fixture(options: {web?: boolean; privkey?: boolean} = {}) {
    const base = scratch('hook');
    const deployRoot = join(base, 'root');
    const web = join(deployRoot, 'etc/unai/tls/web');
    const lineage = join(base, 'live/uai.example.invalid');
    const stubs = join(base, 'stubs');
    const log = join(base, 'stub.log');
    mkdirSync(deployRoot);
    if (options.web !== false) {
      write(join(web, 'cert.pem'), 'OLD-CHAIN');
      write(join(web, 'key.pem'), 'OLD-KEY');
    }
    write(join(lineage, 'fullchain.pem'), 'NEW-CHAIN');
    if (options.privkey !== false) write(join(lineage, 'privkey.pem'), 'NEW-KEY');
    stub(stubs, 'install', [
      'args=("$@"); source=${args[-2]}; target=${args[-1]}',
      'if [[ ${STUB_FAIL_KEY:-} == 1 && $source == *privkey.pem ]]; then exit 1; fi',
      'cp -- "$source" "$target"',
    ].join('\n'));
    stub(stubs, 'systemctl');
    const run = (env: Record<string, string> = {}, lineageValue: string | null = lineage) => {
      const environment: Record<string, string> = {
        PATH: `${stubs}:${process.env.PATH ?? ''}`, STUB_LOG: log, UNAI_DEPLOY_ROOT: deployRoot, ...env,
      };
      if (lineageValue !== null) environment.RENEWED_LINEAGE = lineageValue;
      return spawnSync('bash', [hook], {encoding: 'utf8', env: childEnv(environment)});
    };
    const pair = () => [readFileSync(join(web, 'cert.pem'), 'utf8'), readFileSync(join(web, 'key.pem'), 'utf8')];
    return {deployRoot, web, log, run, pair};
  }

  it('installs the renewed pair root:unai-web 0640 and restarts unai-web only', () => {
    const {web, log, run, pair} = fixture();
    const result = run();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(pair()).toEqual(['NEW-CHAIN', 'NEW-KEY']);
    const installs = logLines(log).filter(line => line.startsWith('install '));
    expect(installs).toHaveLength(2);
    for (const line of installs) expect(line).toContain('-o root -g unai-web -m 0640');
    expect(logLines(log).filter(line => line.startsWith('systemctl '))).toEqual(['systemctl restart unai-web']);
    expect(readdirSync(web).sort()).toEqual(['cert.pem', 'key.pem']);
  });

  it.each([['an unset', null], ['an empty', '']])('refuses %s RENEWED_LINEAGE and touches nothing', (_, value) => {
    const {log, run, pair} = fixture();
    const result = run({}, value);
    expect(result.stderr).toBe('CERTBOT_HOOK_LINEAGE_REQUIRED\n');
    expect(result.status).toBe(1);
    expect(logLines(log)).toEqual([]);
    expect(pair()).toEqual(['OLD-CHAIN', 'OLD-KEY']);
  });

  it('refuses a lineage without privkey.pem and restarts nothing', () => {
    const {log, run, pair} = fixture({privkey: false});
    const result = run();
    expect(result.stderr).toBe('CERTBOT_HOOK_FILES_MISSING\n');
    expect(result.status).toBe(1);
    expect(logLines(log)).toEqual([]);
    expect(pair()).toEqual(['OLD-CHAIN', 'OLD-KEY']);
  });

  it('refuses a missing destination directory and creates nothing', () => {
    const {deployRoot, log, run} = fixture({web: false});
    const result = run();
    expect(result.stderr).toBe('CERTBOT_HOOK_DESTINATION_MISSING\n');
    expect(result.status).toBe(1);
    expect(logLines(log)).toEqual([]);
    expect(readdirSync(deployRoot)).toEqual([]);
  });

  it('keeps the old pair, leaves no temp file and restarts nothing when a copy fails', () => {
    const {web, log, run, pair} = fixture();
    const result = run({STUB_FAIL_KEY: '1'});
    expect(result.status).not.toBe(0);
    expect(pair()).toEqual(['OLD-CHAIN', 'OLD-KEY']);
    expect(readdirSync(web).sort()).toEqual(['cert.pem', 'key.pem']);
    expect(logLines(log).filter(line => line.startsWith('install '))).toHaveLength(2);
    expect(logLines(log).filter(line => line.startsWith('systemctl '))).toEqual([]);
  });
});

describe.runIf(process.platform === 'linux' && process.arch === 'x64')('install.sh', () => {
  const installer = join(root, 'deploy/install.sh');
  const tag = 'v9.9.9-test';
  const repo = 'https://example.invalid/uai.git';
  const fresh = ['--tag', tag, '--repo', repo, '--dry-run'];
  const mutators = ['apt-get', 'useradd', 'install', 'mkdir', 'chown', 'chmod', 'ln', 'mv', 'cp', 'touch', 'curl', 'tar', 'git',
    'corepack', 'pnpm', 'node', 'npm', 'systemctl', 'timedatectl', 'sha256sum', 'dpkg', 'dpkg-query', 'unzip', 'aws', 'rm'];
  // ADR 0043 D4: the zip whose PGP signature verified against the AWS CLI Team key.
  const awscliSha256 = 'd641283d37f1a2168457a9f26a20d4e29167652e9ab1719b37114ef1ebe859f4';
  const awscliPlan = (R: string) => {
    const zip = `${R}/var/cache/unai/awscli-exe-linux-x86_64-2.36.7.zip`;
    return [
      `+ install -d -m 0755 ${R}/var/cache/unai`,
      `+ curl -fsSL --proto =https --tlsv1.2 --retry 3 -o ${zip} https://awscli.amazonaws.com/awscli-exe-linux-x86_64-2.36.7.zip`,
      `+ put 0644 root:root ${zip}.sha256`,
      `  | ${awscliSha256}  ${zip}`,
      `+ sha256sum --check --status ${zip}.sha256`,
      `+ rm -rf -- ${R}/var/cache/unai/aws`,
      `+ unzip -q -o ${zip} -d ${R}/var/cache/unai`,
      `+ ${R}/var/cache/unai/aws/install --update --install-dir ${R}/usr/local/aws-cli --bin-dir ${R}/usr/local/bin`,
    ];
  };
  const users = ['unai-api', 'unai-web', 'unai-worker', 'unai-backup'];
  // ADR 0043 D8: the release's .sha256 asset and GitHub's asset digest agree.
  const otelcolSha256 = '1995260c54cf5d74964a85e5e7d27834bb9a252c87a2582a4fb6a6c34565a90d';
  const collectorPlan = (R: string) => {
    const deb = `${R}/var/cache/unai/otelcol-contrib_0.164.0_linux_amd64.deb`;
    return [
      `+ curl -fsSL --proto =https --tlsv1.2 --retry 3 -o ${deb} https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v0.164.0/otelcol-contrib_0.164.0_linux_amd64.deb`,
      `+ put 0644 root:root ${deb}.sha256`,
      `  | ${otelcolSha256}  ${deb}`,
      `+ sha256sum --check --status ${deb}.sha256`,
      `+ dpkg --force-confdef --force-confold -i ${deb}`,
    ];
  };
  const collectorRestart = (R: string) => [
    `+ ${R}/usr/bin/otelcol-contrib validate --config=${R}/etc/otelcol-contrib/unai.yaml`,
    '+ systemctl daemon-reload',
    '+ systemctl restart otelcol-contrib.service',
  ];
  const collectorUser = spawnSync('getent', ['passwd', 'otelcol-contrib']).status === 0 ? []
    : ['+ useradd --system --user-group --no-create-home --shell /sbin/nologin otelcol-contrib'];
  const collectorDirectories = (R: string) => [
    `+ install -d -o root -g root -m 0755 ${R}/var/lib/otelcol`,
    `+ install -d -o otelcol-contrib -g otelcol-contrib -m 0750 ${R}/var/lib/otelcol/unai`,
  ];
  const telemetryFiles = ['/etc/systemd/journald.conf.d/unai.conf', '/etc/otelcol-contrib/unai.yaml',
    '/etc/systemd/system/otelcol-contrib.service.d/unai.conf'] as const;
  const telemetryPuts = (output: string[]) =>
    output.filter(line => line.startsWith('+ put ') && telemetryFiles.some(file => line.endsWith(file)));
  // What a plan's `+ put MODE OWNER PATH` block writes, without put's `  | ` prefix.
  function putContent(output: string[], path: string): string {
    const start = output.findIndex(line => line.startsWith('+ put ') && line.endsWith(path));
    expect(start, `no put of ${path}`).toBeGreaterThanOrEqual(0);
    const end = output.findIndex((line, index) => index > start && !line.startsWith('  | '));
    return output.slice(start + 1, end < 0 ? undefined : end).map(line => line.slice(4)).join('\n');
  }

  // A fake host root plus FAILING stubs for every mutator: a dry run must invoke none.
  function host(options: {os?: string; except?: string[]} = {}) {
    const base = scratch('install');
    const R = join(base, 'host');
    write(join(R, 'etc/os-release'), `ID=ubuntu\nVERSION_ID="${options.os ?? '24.04'}"\n`);
    const stubs = join(base, 'stubs');
    for (const name of mutators.filter(name => !options.except?.includes(name))) stub(stubs, name, 'exit 97');
    const log = join(base, 'stub.log');
    const install = (args: string[], env: Record<string, string> = {UNAI_DEPLOY_ROOT: R}) =>
      spawnSync('bash', [installer, ...args], {encoding: 'utf8', env: childEnv({PATH: `${stubs}:${process.env.PATH ?? ''}`, STUB_LOG: log, ...env})});
    return {R, rel: join(R, 'opt/unai/releases', tag), log, install};
  }
  const lines = (stdout: string) => stdout.split('\n');
  function expectInOrder(output: string[], expected: string[]): void {
    let previous = -1;
    for (const line of expected) {
      const index = output.indexOf(line, previous + 1);
      expect(index, `missing or out of order: ${line}`).toBeGreaterThan(previous);
      previous = index;
    }
  }
  const missingUsers = users.filter(user => spawnSync('getent', ['passwd', user]).status !== 0);

  it('plans a fresh install in order and invokes no stub', () => {
    const {R, rel, log, install} = host();
    const result = install(fresh);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(existsSync(log)).toBe(false);
    const output = lines(result.stdout);
    const tarball = `${R}/var/cache/unai/node-v24.22.2-linux-x64.tar.xz`;
    const directories = [
      ['/opt/unai', 'root', '0755'], ['/opt/unai/releases', 'root', '0755'], ['/etc/unai', 'root', '0755'],
      ['/etc/unai/secrets', 'root', '0755'], ['/etc/unai/tls', 'root', '0755'],
      ['/etc/unai/secrets/api', 'unai-api', '0750'], ['/etc/unai/secrets/api/connectors', 'unai-api', '0750'],
      ['/etc/unai/secrets/api/aws', 'unai-api', '0750'], ['/etc/unai/secrets/web', 'unai-web', '0750'],
      ['/etc/unai/secrets/worker', 'unai-worker', '0750'], ['/etc/unai/secrets/worker/connectors', 'unai-worker', '0750'],
      ['/etc/unai/secrets/worker/aws', 'unai-worker', '0750'], ['/etc/unai/tls/web', 'unai-web', '0750'],
      ['/etc/unai/backup', 'unai-backup', '0750'], ['/etc/unai/pgdata', 'root', '0700'],
    ].map(([path, group, mode]) => `+ install -d -o root -g ${group} -m ${mode} ${R}${path}`);
    expect(output.filter(line => line.startsWith('+ install -d -o '))).toEqual([...collectorDirectories(R), ...directories]);
    // The collector's user, directories, config and unit drop-in precede dpkg: its
    // postinst starts the service, which must never run the package default config.
    expectInOrder(output, [
      '+ timedatectl set-timezone Etc/UTC',
      '+ env DEBIAN_FRONTEND=noninteractive apt-get update',
      '+ env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl git openssl xz-utils certbot postgresql-common cryptsetup unzip',
      `+ put 0644 root:root ${R}/etc/apt/apt.conf.d/51unai-unattended-upgrades`,
      '  | Unattended-Upgrade::Package-Blacklist {', '  |     "postgresql-17";', '  |     "postgresql-17-pgvector";', '  | };',
      `+ put 0644 root:root ${R}/etc/apt/preferences.d/unai-pgvector`,
      '  | Package: postgresql-17-pgvector', '  | Pin: version 0.8.*', '  | Pin-Priority: 1001',
      `+ curl -fsSL --proto =https --tlsv1.2 --retry 3 -o ${tarball} https://nodejs.org/dist/v24.22.2/node-v24.22.2-linux-x64.tar.xz`,
      `+ put 0644 root:root ${tarball}.sha256`,
      `  | 48cc0e21e048790e54c0cf5749c2725005313d652651c40b7a21feb9697aaf75  ${tarball}`,
      `+ sha256sum --check --status ${tarball}.sha256`,
      `+ tar --no-same-owner --strip-components=1 -xJf ${tarball} -C ${R}/usr/local`,
      `+ /usr/local/bin/corepack enable --install-directory ${R}/usr/local/bin pnpm`,
      '+ env COREPACK_ENABLE_DOWNLOAD_PROMPT=0 /usr/local/bin/corepack install -g pnpm@11.0.8',
      ...awscliPlan(R),
      `+ install -d -m 0755 ${R}/etc/systemd/journald.conf.d`,
      `+ put 0644 root:root ${R}/etc/systemd/journald.conf.d/unai.conf`,
      '  | [Journal]', '  | Storage=persistent', '  | SystemMaxUse=2G', '  | MaxRetentionSec=30day',
      '+ systemctl restart systemd-journald.service',
      ...collectorUser,
      ...collectorDirectories(R),
      `+ install -d -m 0755 ${R}/etc/otelcol-contrib`,
      `+ put 0644 root:root ${R}/etc/otelcol-contrib/unai.yaml`,
      '  |         endpoint: 127.0.0.1:4318', '  |     path: /var/lib/otelcol/unai/telemetry.jsonl',
      '  |       max_days: 14', '  |       level: none',
      `+ install -d -m 0755 ${R}/etc/systemd/system/otelcol-contrib.service.d`,
      `+ put 0644 root:root ${R}/etc/systemd/system/otelcol-contrib.service.d/unai.conf`,
      '  | EnvironmentFile=', '  | ExecStart=', '  | ExecStart=/usr/bin/otelcol-contrib --config=/etc/otelcol-contrib/unai.yaml',
      `+ install -d -m 0755 ${R}/var/cache/unai`,
      ...collectorPlan(R),
      ...collectorRestart(R),
      ...missingUsers.map(user => `+ useradd --system --user-group --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin ${user}`),
      ...directories,
      `+ git -c advice.detachedHead=false clone --branch ${tag} -- ${repo} ${rel}`,
      `+ env -u NODE_ENV /usr/local/bin/pnpm --dir ${rel} install --frozen-lockfile`,
      `+ env NEXT_TELEMETRY_DISABLED=1 /usr/local/bin/pnpm --dir ${rel} build`,
      `+ touch ${rel}/apps/web/.next/unai-build-complete`,
      `+ ln -s releases/${tag} ${R}/opt/unai/current`,
      `+ install -m 0644 -o root -g root -t ${R}/etc/systemd/system ${rel}/deploy/systemd/unai-*.service ${rel}/deploy/systemd/unai-*.timer`,
      '+ systemctl daemon-reload',
      `+ install -D -m 0755 -o root -g root ${rel}/deploy/certbot-deploy-hook.sh ${R}/etc/letsencrypt/renewal-hooks/deploy/unai-web.sh`,
      `+ put 0600 root:root ${R}/etc/unai/migrate.env`,
      '  | UNAI_MIGRATION_DATABASE_URL=postgresql://unai_migrator@127.0.0.1:5432/unai',
      '  | UNAI_DATABASE_CA_FILE=/etc/unai/tls/ca/ca.pem',
      'Remaining manual steps:',
    ]);
    expect(output.filter(line => line.startsWith('+ systemctl'))).toEqual(['+ systemctl restart systemd-journald.service',
      '+ systemctl daemon-reload', '+ systemctl restart otelcol-contrib.service', '+ systemctl daemon-reload']);
    expect(result.stdout).not.toContain('apt.postgresql.org.sh');
    const manual = result.stdout.split('Remaining manual steps:')[1]!;
    for (const text of ['DNS', '/etc/unai/pgdata/aws-credentials', 'deploy/pgdata/setup.sh', '/var/lib/postgresql',
      'keyslot-1 recovery passphrase', 'unai-pgdata-unlock.service', '/etc/unai/secrets', '/root/.pgpass',
      'backup.key', 'certbot certonly', 'pnpm db:migrate', 'systemctl enable --now']) expect(manual).toContain(text);
  });

  it('prints a byte-identical plan on a second dry run', () => {
    const {install} = host();
    expect(install(fresh).stdout).toBe(install(fresh).stdout);
  });

  it('plans no file write under secrets, backup, pgdata or /root and generates no key material', () => {
    const {R, install} = host();
    const writes = lines(install(fresh).stdout).filter(line => /^\+ (put |install (?!-d )|ln |touch |tar |unzip |curl |git .* clone )/.test(line));
    expect(writes.length).toBeGreaterThan(5);
    for (const line of writes) {
      for (const forbidden of [`${R}/etc/unai/secrets`, `${R}/etc/unai/backup`, `${R}/etc/unai/pgdata`, `${R}/root`]) expect(line).not.toContain(forbidden);
    }
    const text = read('deploy/install.sh');
    for (const material of ['/dev/urandom', 'openssl rand', 'head -c', 'PASSWORD']) expect(text).not.toContain(material);
  });

  // The telemetry files exactly as a fresh dry run writes them, so no test copies the YAML.
  let freshPlan: string[] | undefined;
  const telemetryContent = (path: string) => putContent(freshPlan ??= lines(host().install(fresh).stdout), path);

  function installed(target = `releases/${tag}`, marker = 'unai-build-complete') {
    const fixture = host({except: ['git']});
    const {R, rel} = fixture;
    write(join(rel, 'apps/web/.next', marker), 'fixture');
    write(join(rel, 'deploy/systemd/unai-api.service'), '[Unit]\n');
    write(join(rel, 'deploy/env/api.env.example'), 'UNAI_API_PORT=3443\n');
    write(join(rel, 'deploy/env/web.env.example'), 'UNAI_WEB_BIND=0.0.0.0\n');
    const git = (...args: string[]) => expect(spawnSync('git', ['-C', rel, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid',
      '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], {encoding: 'utf8'}).status).toBe(0);
    git('init', '-q');
    git('commit', '-q', '--allow-empty', '-m', 'fixture');
    git('tag', tag);
    symlinkSync(target, join(R, 'opt/unai/current'));
    write(join(R, 'etc/unai/api.env'), 'UNAI_API_PORT=3443\n');
    write(join(R, 'etc/unai/migrate.env'), 'UNAI_DATABASE_CA_FILE=/etc/unai/tls/ca/ca.pem\n');
    write(join(R, 'usr/local/bin/node'), '#!/bin/sh\necho v24.22.2\n', 0o755);
    write(join(R, 'usr/local/bin/pnpm'), '#!/bin/sh\necho 11.0.8\n', 0o755);
    write(join(R, 'usr/local/bin/aws'), '#!/bin/sh\necho aws-cli/2.36.7 Python/3.13.0 Linux/6.8 exe/x86_64.ubuntu.24\n', 0o755);
    // An already-correct ADR 0043 D8 host: the pinned collector and the files as put writes them.
    write(join(R, 'usr/bin/otelcol-contrib'), '#!/bin/sh\necho otelcol-contrib version 0.164.0\n', 0o755);
    for (const file of telemetryFiles) write(join(R, file), `${telemetryContent(file)}\n`);
    return {...fixture, git};
  }

  it('re-plans an already-correct D8 host without a telemetry write, download, dpkg, validate or restart', () => {
    const {R, log, install} = installed();
    const result = install(['--tag', tag, '--dry-run']);
    expect([result.status, result.stderr]).toEqual([0, '']);
    expect(existsSync(log)).toBe(false);
    const output = lines(result.stdout);
    expect(output.filter(line => /otelcol|journald/.test(line))).toEqual([...collectorUser, ...collectorDirectories(R)]);
    expect(output.filter(line => /^\+ (systemctl|dpkg|curl) /.test(line))).toEqual(['+ systemctl daemon-reload']);
  });

  it.each([
    ['journald drop-in', telemetryFiles[0], false],
    ['collector config', telemetryFiles[1], true],
    ['collector unit drop-in', telemetryFiles[2], true],
  ] as const)('re-plans exactly a stale %s and its own restarts', (_, file, collector) => {
    const {R, log, install} = installed();
    write(join(R, file), 'stale\n');
    const result = install(['--tag', tag, '--dry-run']);
    expect([result.status, result.stderr]).toEqual([0, '']);
    expect(existsSync(log)).toBe(false);
    const output = lines(result.stdout);
    expect(telemetryPuts(output)).toEqual([`+ put 0644 root:root ${R}${file}`]);
    expect(putContent(output, file)).toBe(telemetryContent(file));
    expect(output.filter(line => /^\+ (systemctl|dpkg|curl|\S+\/otelcol-contrib validate) /.test(line))).toEqual([
      ...(collector ? collectorRestart(R) : ['+ systemctl restart systemd-journald.service']),
      '+ systemctl daemon-reload',
    ]);
  });

  it('re-installs the pinned, checksummed collector over an older binary without rewriting its config', () => {
    const {R, log, install} = installed();
    write(join(R, 'usr/bin/otelcol-contrib'), '#!/bin/sh\necho otelcol-contrib version 0.163.0\n', 0o755);
    const result = install(['--tag', tag, '--dry-run']);
    expect([result.status, result.stderr]).toEqual([0, '']);
    expect(existsSync(log)).toBe(false);
    const output = lines(result.stdout);
    expectInOrder(output, [...collectorPlan(R), ...collectorRestart(R)]);
    expect(output.filter(line => /^\+ (curl|dpkg) /.test(line))).toEqual([collectorPlan(R)[0], collectorPlan(R)[4]]);
    expect(telemetryPuts(output)).toEqual([]);
    expect(output.filter(line => line.startsWith('+ systemctl'))).toEqual([...collectorRestart(R).slice(1), '+ systemctl daemon-reload']);
  });

  it('re-plans an installed release without clone, build, link, toolchain or env overwrite', () => {
    const {R, rel, log, install} = installed();
    const result = install(['--tag', tag, '--dry-run']);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(existsSync(log)).toBe(false);
    const output = lines(result.stdout);
    expect(output.filter(line => /^\+ (git |ln |curl |tar |unzip |rm |env -u NODE_ENV|env NEXT_TELEMETRY|touch |\/usr\/local\/bin\/corepack|env COREPACK)/.test(line))).toEqual([]);
    expect(result.stdout).not.toContain('/aws/install');
    expect(result.stdout).not.toContain(`${R}/etc/unai/api.env`);
    expect(result.stdout).not.toContain(`+ put 0600 root:root ${R}/etc/unai/migrate.env`);
    expectInOrder(output, [
      `+ install -m 0644 -o root -g root -t ${R}/etc/systemd/system ${rel}/deploy/systemd/unai-api.service`,
      '+ systemctl daemon-reload',
      `+ install -D -m 0755 -o root -g root ${rel}/deploy/certbot-deploy-hook.sh ${R}/etc/letsencrypt/renewal-hooks/deploy/unai-web.sh`,
      `+ install -m 0600 -o root -g root ${rel}/deploy/env/web.env.example ${R}/etc/unai/web.env`,
    ]);
  });

  it.each(['aws-cli/2.17.0 Python/3.12.6 Linux/6.8 exe/x86_64.ubuntu.24', 'aws-cli/2.36.70 Python/3.13.0 Linux/6.8 exe/x86_64.ubuntu.24'])(
    're-installs the pinned, checksummed AWS CLI over %s', version => {
      const {R, log, install} = installed();
      write(join(R, 'usr/local/bin/aws'), `#!/bin/sh\necho ${version}\n`, 0o755);
      const result = install(['--tag', tag, '--dry-run']);
      expect([result.status, result.stderr]).toEqual([0, '']);
      expect(existsSync(log)).toBe(false);
      const output = lines(result.stdout);
      expectInOrder(output, awscliPlan(R));
      expect(output.filter(line => /^\+ (curl |tar |\/usr\/local\/bin\/corepack)/.test(line))).toEqual([awscliPlan(R)[1]]);
    });

  it('rebuilds a release whose BUILD_ID outlived a failed build', () => {
    const {rel, log, install} = installed(`releases/${tag}`, 'BUILD_ID');
    const result = install(['--tag', tag, '--dry-run']);
    expect(result.status).toBe(0);
    expect(existsSync(log)).toBe(false);
    expectInOrder(lines(result.stdout), [
      `+ env -u NODE_ENV /usr/local/bin/pnpm --dir ${rel} install --frozen-lockfile`,
      `+ env NEXT_TELEMETRY_DISABLED=1 /usr/local/bin/pnpm --dir ${rel} build`,
      `+ touch ${rel}/apps/web/.next/unai-build-complete`,
    ]);
  });

  it('refuses a release directory whose HEAD is not the tag', () => {
    const {install, git} = installed();
    git('commit', '-q', '--allow-empty', '-m', 'moved');
    const result = install(['--tag', tag, '--dry-run']);
    expect([result.status, result.stderr]).toEqual([1, 'INSTALL_RELEASE_MISMATCH\n']);
  });

  it('refuses a host whose current points at another release before any step', () => {
    const {log, install} = installed('releases/v0.0.1');
    const result = install(['--tag', tag, '--dry-run']);
    expect([result.status, result.stderr, result.stdout]).toEqual([1, 'INSTALL_ALREADY_INSTALLED\n', '']);
    expect(existsSync(log)).toBe(false);
  });

  it.each([
    ['an unsupported OS', {os: '22.04'}, fresh, 'INSTALL_UNSUPPORTED_OS'],
    ['a tag with a path', {}, ['--tag', '../x', '--repo', repo, '--dry-run'], 'INSTALL_TAG_INVALID'],
    ['a tag like an option', {}, ['--tag', '-x', '--repo', repo, '--dry-run'], 'INSTALL_TAG_INVALID'],
    ['no tag', {}, ['--repo', repo, '--dry-run'], 'INSTALL_USAGE'],
    ['an unknown flag', {}, [...fresh, '--force'], 'INSTALL_USAGE'],
    ['a fresh host without --repo', {}, ['--tag', tag, '--dry-run'], 'INSTALL_REPO_REQUIRED'],
    ['a deploy root without --dry-run', {}, ['--tag', tag, '--repo', repo], 'INSTALL_DEPLOY_ROOT_DRY_RUN_ONLY'],
  ])('refuses %s before any step', (_, options, args, code) => {
    const {log, install} = host(options);
    const result = install(args);
    expect([result.status, result.stderr, result.stdout]).toEqual([1, `${code}\n`, '']);
    expect(existsSync(log)).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)('refuses a real run as a non-root user', () => {
    const {log, install} = host();
    const result = install(['--tag', tag, '--repo', repo], {});
    expect([result.status, result.stderr, result.stdout]).toEqual([1, 'INSTALL_ROOT_REQUIRED\n', '']);
    expect(existsSync(log)).toBe(false);
  });
});
