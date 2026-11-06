import {createHash} from 'node:crypto';
import {existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {afterEach, describe, expect, it} from 'vitest';

const script = resolve('deploy/upgrade.sh'), tag = 'v9.9.9', version = '0.4.0';
const id = '019a1234-1234-7123-8123-123456789abc', repo = 'https://example.invalid/uai.git';
const roots: string[] = [];
const childEnv = (vars: Record<string, string>): NodeJS.ProcessEnv => ({NODE_ENV: 'test', ...vars});
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true}); });
function write(path: string, text: string, mode = 0o644) {
  mkdirSync(dirname(path), {recursive: true}); writeFileSync(path, text, {mode});
}
function snapshot(root: string): string[] {
  return readdirSync(root).sort().flatMap(name => {
    const path = join(root, name), stat = lstatSync(path);
    const content = stat.isSymbolicLink() ? readlinkSync(path) : stat.isDirectory() ? snapshot(path).join('\n') :
      createHash('sha256').update(readFileSync(path)).digest('hex');
    return [`${name}:${stat.mode}:${content}`];
  });
}
function host() {
  const base = mkdtempSync(join(tmpdir(), 'unai-upgrade-')); roots.push(base);
  const R = join(base, 'host'), stubs = join(base, 'stubs'), log = join(base, 'stub.log');
  mkdirSync(join(R, 'opt/unai/releases/v1.0.0'), {recursive: true});
  symlinkSync('releases/v1.0.0', join(R, 'opt/unai/current'));
  for (const [name, port] of [['api', '9101'], ['worker', '9102']]) {
    write(join(R, `etc/unai/${name}.env`), `# retained comment\nUNAI_PROBE_PORT=${port}\nUNAI_PROBE_BIND=127.0.0.1\nUNAI_REGISTRY_RELEASE=0.3.0\nUNAI_REGISTRY_RELEASE_ID=${id}\n`);
  }
  write(join(R, 'etc/unai/web.env'), 'NEXTAUTH_URL=https://uai.example.test\n');
  write(join(R, 'etc/unai/migrate.env'), 'UNAI_DATABASE_CA_FILE=/etc/unai/tls/ca/ca.pem\n');
  write(join(R, 'etc/unai/backup.env'), 'PGPASSFILE=/etc/unai/backup/pgpass\n');
  for (const name of ['systemctl', 'systemd-run', 'pnpm', 'git', 'curl', 'node', 'flock', 'ln', 'mv', 'rm', 'install', 'touch', 'cp', 'chmod', 'chown', 'sleep', 'mktemp']) {
    write(join(stubs, name), `#!/bin/sh\nprintf '%s\\n' '${name}' >> "$STUB_LOG"\nexit 97\n`, 0o755);
  }
  const run = (args: string[], vars: Record<string, string> = {}) => spawnSync('bash', [script, ...args], {
    encoding: 'utf8', env: childEnv({PATH: `${stubs}:${process.env.PATH ?? ''}`, STUB_LOG: log, UNAI_DEPLOY_ROOT: R, ...vars}),
  });
  return {R, log, run, env: (name: string) => join(R, `etc/unai/${name}.env`)};
}
function sourced(fn: string, ...args: string[]) {
  return spawnSync('bash', ['-c', 'source "$1"; shift; "$@"', 'upgrade', script, fn, ...args], {encoding: 'utf8'});
}
function helper(code: string, h: ReturnType<typeof host>, ...args: string[]) {
  return spawnSync('bash', ['-c', `source "$1"; shift; ${code}`, 'upgrade', script, ...args], {
    encoding: 'utf8', env: childEnv({PATH: process.env.PATH ?? '', UNAI_DEPLOY_ROOT: h.R}),
  });
}
const fresh = [tag, '--repo', repo, '--registry-version', version, '--dry-run'];
const S = '+ systemd-run --wait --pipe --quiet --collect';
function expectInOrder(output: string, expected: string[]) {
  let previous = -1; const lines = output.split('\n');
  for (const line of expected) {
    const index = lines.indexOf(line, previous + 1);
    expect(index, `missing or out of order: ${line}`).toBeGreaterThan(previous); previous = index;
  }
}
function unitLine(name: string, R: string) {
  const lines = readFileSync(`deploy/systemd/unai-${name}.service`, 'utf8').replace(/\r/g, '').split('\n');
  const field = (key: string) => lines.filter(line => line.startsWith(`${key}=`)).map(line => line.slice(key.length + 1));
  const path = (value: string) => R + (name === 'backup' ? value : value.replace('/opt/unai/current', `/opt/unai/releases/${tag}`));
  return [S, ...(name === 'backup' ? ['--unit=unai-upgrade-backup'] : []), `--uid=${field('User')[0]}`, `--gid=${field('Group')[0]}`,
    `--working-directory=${path(field('WorkingDirectory')[0]!)}`, `--property=EnvironmentFile=${R}${field('EnvironmentFile')[0]}`,
    ...field('Environment').map(value => `--setenv=${value.replace(/=\//, `=${R}/`)}`),
    field(name === 'backup' ? 'ExecStart' : 'ExecStartPre')[0]!.replace(/^node /, '/usr/local/bin/node ')].join(' ');
}
function untouched(h: ReturnType<typeof host>, before: string[]) {
  expect(existsSync(h.log)).toBe(false); expect(snapshot(h.R)).toEqual(before);
}

describe.runIf(process.platform === 'linux')('upgrade helpers and preconditions', () => {
  it('reads a single active assignment, never comments or duplicates', () => {
    const h = host(), file = h.env('api');
    expect(sourced('env_value', file, 'UNAI_REGISTRY_RELEASE').stdout).toBe('0.3.0\n');
    for (const text of ['# NAME=comment\n', 'NAME=one\nNAME=two\n']) {
      write(file, text); expect(sourced('env_value', file, 'NAME').status).toBe(1);
    }
    write(file, 'NAME="quoted"\n'); expect(sourced('env_value', file, 'NAME').stdout).toBe('"quoted"\n');
  });
  it('lists only missing required names', () => {
    const h = host();
    write(h.env('example'), '# A: required; first\n# B: optional; second\n# C: required; third\nA=x\nB=y\nC=z\n');
    write(h.env('actual'), '# C=comment\nA=value\n');
    expect(sourced('missing_required', h.env('example'), h.env('actual')).stdout).toBe('C\n');
  });
  it.each(['\n', ''])('repins exactly two lines, preserving bytes including final newline %j', ending => {
    const h = host();
    const original = '# UNAI_REGISTRY_RELEASE=comment\nOTHER="keep spaces"\nUNAI_REGISTRY_RELEASE=0.3.0\nUNAI_REGISTRY_RELEASE_ID=old' + ending;
    write(h.env('api'), original);
    expect(sourced('repinned', h.env('api'), version, id).stdout).toBe(original.replace('RELEASE=0.3.0', `RELEASE=${version}`).replace('ID=old', `ID=${id}`));
  });
  it('extracts only a PASS UUID from publish output', () => {
    expect(sourced('release_id_of', JSON.stringify({result: 'PASS', releaseId: id})).stdout).toBe(`${id}\n`);
    for (const text of ['', JSON.stringify({result: 'FAIL', releaseId: id}), '{"result":"PASS","releaseId":"bad"}',
      JSON.stringify({nested: {result: 'PASS', releaseId: id}}), `noise {"result":"PASS","releaseId":"${id}"}`]) {
      expect(sourced('release_id_of', text).status).toBe(1);
    }
  });
  const cases: Array<[string[], string, (h: ReturnType<typeof host>) => void, Record<string, string>?]> = [
    [[], 'USAGE', () => {}], [['one', 'two', '--dry-run'], 'USAGE', () => {}],
    [[tag, '--unknown', '--dry-run'], 'USAGE', () => {}], [[tag, '--repo'], 'USAGE', () => {}],
    ...['../x', '-x'].map(value => [[value, '--dry-run'], 'TAG_INVALID', () => {}] as [string[], string, () => void]),
    [[tag], 'DEPLOY_ROOT_DRY_RUN_ONLY', () => {}],
    [[tag], 'FAIL_AT_DRY_RUN_ONLY', () => {}, {UNAI_DEPLOY_ROOT: '', UNAI_UPGRADE_DRY_RUN_FAIL_AT: '4'}],
    [fresh, 'FAIL_AT_INVALID', () => {}, {UNAI_UPGRADE_DRY_RUN_FAIL_AT: '10'}],
    [fresh, 'NOT_INSTALLED', h => rmSync(join(h.R, 'opt/unai/current'))],
    [['v1.0.0', '--dry-run'], 'ALREADY_CURRENT', () => {}],
    [fresh, 'RELEASE_EXISTS', h => mkdirSync(join(h.R, 'opt/unai/releases', tag))],
    [fresh, 'CURRENT_TMP_INVALID', h => write(join(h.R, 'opt/unai/current.tmp'), 'occupied')],
    [[tag, '--repo', 'https://' + 'user' + '@example.invalid/repo', '--dry-run'], 'REPO_URL_CREDENTIALS', () => {}],
    [fresh, 'ENV_FILE_MISSING', h => rmSync(h.env('backup'))],
    [fresh, 'WEB_ORIGIN_INVALID', h => write(h.env('web'), 'NEXTAUTH_URL=https://example.test/path\n')],
    [fresh, 'PROBE_PORT_REQUIRED', h => write(h.env('worker'), '# UNAI_PROBE_PORT=9102\n')],
    [[tag, '--registry-version', '0.4', '--dry-run'], 'REGISTRY_VERSION_INVALID', () => {}],
    [fresh, 'REGISTRY_PIN_MISMATCH', h => write(h.env('worker'), readFileSync(h.env('worker'), 'utf8').replace('0.3.0', '0.2.0'))],
    [fresh, 'ENV_COPY_EXISTS', h => write(`${h.env('api')}.pre-${tag}`, 'preserve')],
  ];
  it.each(cases)('refuses %j with UPGRADE_%s before commands', (args, code, change, vars) => {
    const h = host(); change(h); const before = snapshot(h.R), result = h.run(args, vars);
    expect([result.status, result.stderr, result.stdout]).toEqual([1, `UPGRADE_${code}\n`, '']); untouched(h, before);
  });
  it.skipIf(process.getuid?.() === 0)('refuses an unprivileged real run before reading host state', () => {
    const h = host(), before = snapshot(h.R), result = h.run([tag], {UNAI_DEPLOY_ROOT: ''});
    expect([result.status, result.stderr, result.stdout]).toEqual([1, 'UPGRADE_ROOT_REQUIRED\n', '']); untouched(h, before);
  });
});

describe.runIf(process.platform === 'linux')('upgrade D12 plan', () => {
  it('prints the complete ordered plan without invoking a mutator or changing any byte', () => {
    const h = host(), before = snapshot(h.R), result = h.run(fresh), rel = `${h.R}/opt/unai/releases/${tag}`, cur = `${h.R}/opt/unai/current`;
    expect([result.status, result.stderr]).toEqual([0, '']); untouched(h, before);
    expectInOrder(result.stdout, [
      '== D12 step 0: timers', '+ systemctl stop unai-backup.timer unai-restore-drill.timer',
      '== D12 step 1: fetch', `+ git -c advice.detachedHead=false clone --branch ${tag} -- ${repo} ${rel}`,
      '== D12 step 2: build', `+ env -u NODE_ENV /usr/local/bin/pnpm --dir ${rel} install --frozen-lockfile`,
      `+ env NEXT_TELEMETRY_DISABLED=1 /usr/local/bin/pnpm --dir ${rel} build`, `+ touch ${rel}/apps/web/.next/unai-build-complete`,
      '== D12 step 3: maintenance', '+ systemctl stop unai-worker.service', '+ systemctl stop unai-api.service',
      '== D12 step 4: backup', unitLine('backup', h.R), '== D12 step 5: migrate',
      `${S} --working-directory=${rel} --property=EnvironmentFile=${h.R}/etc/unai/migrate.env --setenv=PGPASSFILE=${h.R}/root/.pgpass --setenv=HOME=${h.R}/root /usr/local/bin/pnpm db:migrate`,
      '== D12 step 6: registry',
      `${S} --working-directory=${rel} --property=EnvironmentFile=${h.R}/etc/unai/migrate.env --setenv=PGPASSFILE=${h.R}/root/.pgpass --setenv=HOME=${h.R}/root /usr/local/bin/pnpm uai registry publish --version ${version}`,
      ...['api', 'worker'].flatMap(name => [`+ install -m 0600 -o root -g root ${h.env(name)} ${h.env(name)}.pre-${tag}`, `+ repin ${h.env(name)} ${version} <releaseId>`]),
      '== D12 step 7: preflight', ...['api', 'web', 'worker'].map(name => unitLine(name, h.R)),
      '== D12 step 8: swap', `+ ln -sfn releases/${tag} ${cur}.tmp`, `+ mv -T ${cur}.tmp ${cur}`,
      `+ install -m 0644 -o root -g root -t ${h.R}/etc/systemd/system ${rel}/deploy/systemd/unai-*.service ${rel}/deploy/systemd/unai-*.timer`,
      '+ systemctl daemon-reload', `+ install -D -m 0755 -o root -g root ${rel}/deploy/certbot-deploy-hook.sh ${h.R}/etc/letsencrypt/renewal-hooks/deploy/unai-web.sh`,
      '== D12 step 9: start', '+ systemctl start unai-api.service', '+ retry 120 curl -fsS --max-time 5 -o /dev/null http://127.0.0.1:9101/readyz',
      '+ systemctl restart unai-web.service', '+ retry 120 curl -fsS --max-time 10 -o /dev/null --resolve uai.example.test:443:127.0.0.1 https://uai.example.test/signin',
      '+ systemctl start unai-worker.service', '+ retry 120 curl -fsS --max-time 5 -o /dev/null http://127.0.0.1:9102/readyz',
      '+ systemctl start unai-backup.timer unai-restore-drill.timer', 'dry run: nothing was executed',
    ]);
    expect(h.run(fresh).stdout).toBe(result.stdout); untouched(h, before);
    for (const name of ['api', 'web', 'worker', 'backup']) expect(result.stdout.split('\n').filter(line => line === unitLine(name, h.R))).toHaveLength(1);
  });
  it.each([[], ['--registry-version', '0.3.0']])('does not publish or repin with flags %j', (...flags) => {
    const h = host(), before = snapshot(h.R), result = h.run([tag, ...flags, '--dry-run']);
    expect([result.status, result.stderr]).toEqual([0, '']); untouched(h, before);
    expect(result.stdout).toContain('registry: no publish, pin unchanged\n');
    expect(result.stdout).not.toMatch(/registry publish|\.pre-|\+ repin/);
    expect(result.stdout).toContain(' -- \\<origin-url\\> ');
  });
  it('never invokes the backup service or bypasses quiescence', () => {
    const source = readFileSync(script, 'utf8');
    expect(source).not.toMatch(/systemctl\s+(re)?start\b[^\n]*unai-backup\.service/);
    expect(source).not.toContain('--assume-quiescent');
  });
});

describe.runIf(process.platform === 'linux')('upgrade rollback', () => {
  it.each([0, 1, 2, 3, 4])('undoes only the pre-migration work at step %i', step => {
    const h = host(), before = snapshot(h.R), result = h.run(fresh, {UNAI_UPGRADE_DRY_RUN_FAIL_AT: String(step)});
    const code = ['TIMERS', 'FETCH', 'BUILD', 'MAINTENANCE', 'BACKUP'][step];
    expect([result.status, result.stderr]).toEqual([1, `UPGRADE_${code}_FAILED\n`]); untouched(h, before);
    const rollback = result.stdout.slice(result.stdout.indexOf('ROLLBACK ('));
    expectInOrder(rollback, [
      `ROLLBACK (ADR 0043 D12): step ${step} failed before migrate; no data changed.`,
      ...(step === 4 ? ['+ systemctl stop unai-upgrade-backup.service'] : []),
      `+ ln -sfn releases/v1.0.0 ${h.R}/opt/unai/current.tmp`, `+ mv -T ${h.R}/opt/unai/current.tmp ${h.R}/opt/unai/current`,
      ...(step >= 3 ? ['+ systemctl start unai-api.service', '+ systemctl start unai-worker.service'] : []),
      '+ systemctl start unai-backup.timer unai-restore-drill.timer',
      ...(step >= 1 ? [`+ rm -rf -- ${h.R}/opt/unai/releases/${tag}`] : []),
    ]);
    expect(result.stdout).not.toContain('db:migrate');
    if (step < 3) expect(rollback).not.toMatch(/start unai-(api|worker)/);
    if (step === 0) expect(rollback).not.toContain('rm -rf');
  });
  it.each([5, 6, 7, 8, 9])('never rolls back after migrate at step %i', step => {
    const h = host(), before = snapshot(h.R), result = h.run(fresh, {UNAI_UPGRADE_DRY_RUN_FAIL_AT: String(step)});
    expect([result.status, result.stderr]).toEqual([1, `UPGRADE_${['MIGRATE', 'PUBLISH', 'CHECK', 'SWAP', 'START'][step - 5]}_FAILED\n`]); untouched(h, before);
    const stopped = result.stdout.slice(result.stdout.indexOf('STOPPED ('));
    expect(stopped).toContain(`STOPPED (ADR 0043 D12): step ${step} failed after migrations began; current was not swapped back.`);
    expect(stopped).toContain('restore the step-4 backup into an empty database and an empty store');
    expect(stopped).toContain('or fix forward'); expect(stopped).not.toMatch(/^\+ /m);
    expect(stopped).toContain(`current -> releases/${step >= 8 ? tag : 'v1.0.0'}; unai-backup.timer and unai-restore-drill.timer stay stopped.`);
    expect(result.stdout).not.toContain('+ ln -sfn releases/v1.0.0');
    expect(result.stdout).not.toContain('+ systemctl start unai-backup.timer');
    if (step >= 6) for (const file of ['api', 'worker']) expect(stopped).toContain(`${h.env(file)}.pre-${tag}`);
  });
});

describe.runIf(process.platform === 'linux')('upgrade adversarial helper cases', () => {
  it('preserves child failure status under OR lists without leaking raw output', () => {
    const h = host(), r = helper('DRY_RUN=0; noisy(){ echo PRIVATE; echo PRIVATE >&2; return 23; }; run noisy || exit "$?"', h);
    expect([r.status, r.stdout, r.stderr]).toEqual([23, '+ noisy\n', '']);
  });
  it('bounds retries and retains their failure status', () => {
    const h = host();
    const r = helper('DRY_RUN=0; sleep(){ SECONDS=$((SECONDS+3)); }; retry 1 false || exit "$?"', h);
    expect([r.status, r.stdout, r.stderr]).toEqual([1, '+ retry 1 false\n', '']);
    expect(helper('DRY_RUN=0; retry 1 true', h).status).toBe(0);
  });
  it('does not mistake a failed write in repinned for successful output', () => {
    const h = host(), r = helper('repinned "$1" 0.4.0 "$2" > /dev/full 2>/dev/null || exit "$?"', h, h.env('api'), id);
    expect(r.status).toBe(1);
  });
  it.each(['activating', 'active', 'deactivating', 'unknown', ''])('refuses busy/unknown backup state %j', state => {
    const h = host(), r = helper('DRY_RUN=0; step=0; systemctl(){ if [[ $1 == is-active && $2 == --quiet ]]; then return 1; fi; echo "$STATE"; return 3; }; failed(){ fail "$2"; }; STATE=$1; timers', h, state);
    expect([r.status, r.stderr]).toEqual([1, 'UPGRADE_BACKUP_OR_DRILL_RUNNING\n']);
  });
  it.each(['inactive', 'failed'])('accepts the stopped backup state %s', state => {
    const h = host(), r = helper('DRY_RUN=0; step=0; systemctl(){ if [[ $2 == --quiet ]]; then return 1; fi; echo "$STATE"; return 3; }; STATE=$1; timers', h, state);
    expect([r.status, r.stdout, r.stderr]).toEqual([0, '', '']);
  });
  it('revalidates installed state after acquiring the lock', () => {
    const h = host(), before = snapshot(h.R);
    const setup = `cur="$R/opt/unai/current"; rel="$R/opt/unai/releases/${tag}"; old=v0.0.1; registry='';`;
    const r = helper(`${setup} locked_state`, h);
    expect([r.status, r.stdout, r.stderr]).toEqual([1, '', 'UPGRADE_HOST_CHANGED\n']); untouched(h, before);
  });
  it('refuses a release directory created between precheck and lock', () => {
    const h = host(); mkdirSync(join(h.R, 'opt/unai/releases', tag));
    const r = helper(`cur="$R/opt/unai/current"; rel="$R/opt/unai/releases/${tag}"; old=v1.0.0; registry=''; locked_state`, h);
    expect([r.status, r.stdout, r.stderr]).toEqual([1, '', 'UPGRADE_RELEASE_EXISTS\n']);
  });
  it('preserves env and removes the private temp on atomic-rename failure', () => {
    const h = host(), before = snapshot(h.R);
    const r = helper('DRY_RUN=0; chown(){ [[ $1 == root:root ]]; }; mv(){ echo PRIVATE >&2; return 8; }; repin "$1" 0.4.0 "$2" || exit "$?"', h, h.env('api'), id);
    expect([r.status, r.stderr]).toEqual([1, '']); untouched(h, before);
  });
  it('writes the re-pin atomically with 0600 permissions', () => {
    const h = host(), before = readFileSync(h.env('api'), 'utf8');
    const r = helper('DRY_RUN=0; chown(){ [[ $1 == root:root ]]; }; repin "$1" 0.4.0 "$2"', h, h.env('api'), id);
    expect([r.status, r.stderr]).toEqual([0, '']);
    expect(readFileSync(h.env('api'), 'utf8')).toBe(before.replace('0.3.0', '0.4.0'));
    expect(lstatSync(h.env('api')).mode & 0o777).toBe(0o600);
    expect(readdirSync(dirname(h.env('api'))).some(name => name.startsWith('.unai-repin'))).toBe(false);
  });
  it('keeps plus/dot tags and safely quotes argument-shaped input', () => {
    const h = host(), before = snapshot(h.R), r = h.run(['v1.2.3+build.4', '--dry-run']);
    expect(r.status).toBe(0); expect(r.stdout).toContain('releases/v1.2.3+build.4'); untouched(h, before);
  });
  it('reports uncertain timers after a failed final timer restore instead of claiming they are stopped', () => {
    const h = host(), r = helper('DRY_RUN=0; stopped_timers=(unai-backup.timer); run(){ return 1; }; finish_upgrade', h);
    expect([r.status, r.stderr]).toEqual([1, 'UPGRADE_TIMERS_FAILED\n']);
    expect(r.stdout).toContain('timer state is unknown'); expect(r.stdout).not.toContain('stay stopped');
  });
  it('names missing required variables before maintenance, never their values', () => {
    const h = host(), rel = join(h.R, 'opt/unai/releases/new');
    write(join(rel, 'deploy/systemd/unai-api.service'), '[Unit]\n');
    write(join(rel, 'deploy/env/api.env.example'), '# NEW_NAME: required; demo\nNEW_NAME=private-example\n');
    const r = helper('rel=$1; step=2; failed(){ fail "$2"; }; release_files', h, rel);
    expect([r.status, r.stdout, r.stderr]).toEqual([1, 'missing: api.env NEW_NAME\n', 'UPGRADE_ENV_REQUIRED_MISSING\n']);
    write(h.env('api'), 'NEW_NAME=set\n');
    expect(helper('rel=$1; step=2; failed(){ fail "$2"; }; release_files', h, rel).status).toBe(0);
    rmSync(join(rel, 'deploy/systemd/unai-api.service'));
    expect(helper('rel=$1; step=2; failed(){ fail "$2"; }; release_files', h, rel).stderr).toBe('UPGRADE_UNITS_MISSING\n');
  });
  it.each(['mismatch', 'no-registry', 'ok'])('checks the fetched tag and registry tag: %s', mode => {
    const h = host();
    const r = helper('DRY_RUN=0; step=1; tag=v2; repo=fixture; rel="$R/release"; publish=1; registry=0.4.0; mode=$1; act(){ :; }; failed(){ fail "$2"; }; git(){ case "$*" in *registry-v*) [[ $mode != no-registry ]];; *HEAD) echo first;; *) if [[ $mode == mismatch ]]; then echo second; else echo first; fi;; esac; }; fetch_release', h, mode);
    expect([r.status, r.stderr]).toEqual(mode === 'ok' ? [0, ''] : [1, mode === 'mismatch' ? 'UPGRADE_RELEASE_MISMATCH\n' : 'UPGRADE_REGISTRY_TAG_MISSING\n']);
  });
  it('captures publish JSON without printing its unallowlisted fields, before making both copies', () => {
    const h = host();
    const r = helper('DRY_RUN=0; step=6; publish=1; registry=0.4.0; tag=v2; repinned_files=(); migration_command(){ captured_output=$PAYLOAD; }; run(){ printf "%s\\n" "$*"; }; repin(){ printf "repin %s\\n" "$1"; }; PAYLOAD=$1; publish_release', h, JSON.stringify({result: 'PASS', releaseId: id, private: 'PRIVATE'}));
    expect(r.status).toBe(0); expect(r.stdout).not.toContain('PRIVATE');
    expectInOrder(r.stdout, [`{"result":"PASS","releaseId":"${id}"}`, ...['api', 'worker'].flatMap(name => [
      `install -m 0600 -o root -g root ${h.env(name)} ${h.env(name)}.pre-v2`, `repin ${h.env(name)}`])]);
  });
  it('records incomplete rollback yet still tries the later cleanup', () => {
    const h = host(), r = helper('DRY_RUN=0; old=v1.0.0; cur="$R/opt/unai/current"; rel="$R/new"; maintenance=1; created=1; stopped_timers=(); run(){ printf "%s\\n" "$*"; return 1; }; failed 3 UPGRADE_MAINTENANCE_FAILED', h);
    expect([r.status, r.stderr]).toEqual([1, 'UPGRADE_MAINTENANCE_FAILED\n']);
    expect(r.stdout).toContain('rollback incomplete: inspect'); expect(r.stdout).toContain(`rm -rf -- ${h.R}/new`);
  });
});
