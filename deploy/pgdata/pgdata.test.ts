import {spawnSync} from 'node:child_process';
import {createHash, randomBytes} from 'node:crypto';
import {existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {afterAll, describe, expect, it} from 'vitest';

// deploy/pgdata/setup.sh (ADR 0043 D4), run only against PATH stubs and a fake host
// root: no root, no block device and no AWS. aws, mount, blkid and lsblk may be real
// binaries on this host, so every sandbox first proves each stub shadows them.
const root = resolve(import.meta.dirname, '../..');
const setupScript = join(root, 'deploy/pgdata/setup.sh');
const temporary = mkdtempSync(join(tmpdir(), 'unai-pgdata-'));
afterAll(() => rmSync(temporary, {recursive: true, force: true}));
let scratchCount = 0;
function scratch(name: string): string {
  const directory = join(temporary, `${name}-${scratchCount++}`);
  mkdirSync(directory, {recursive: true});
  return directory;
}
function write(path: string, content: string | Buffer, mode = 0o644): void {
  mkdirSync(resolve(path, '..'), {recursive: true});
  writeFileSync(path, content, {mode});
}
// A PATH stub: logs `<name> <args>` to $STUB_LOG, then runs body (as in deploy/scripts.test.ts).
function stub(directory: string, name: string, body = ''): void {
  write(join(directory, name), `#!/usr/bin/env bash\nprintf '%s\\n' "${name} $*" >> "$STUB_LOG"\n${body}\n`, 0o755);
}
// Next.js's global types make NODE_ENV a required ProcessEnv key.
const childEnv = (vars: Record<string, string>): NodeJS.ProcessEnv => ({NODE_ENV: 'test', ...vars});
const logLines = (log: string) => existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
function filesUnder(directory: string): string[] {
  return readdirSync(directory, {recursive: true, encoding: 'utf8'})
    .filter(file => lstatSync(join(directory, file)).isFile()).map(file => file.split('\\').join('/')).sort();
}

// Random per run, so no file or log can contain them by accident. KMS returns both
// halves base64-encoded; the stubs read them from the environment, never a file.
const plain = randomBytes(64);
const blob = randomBytes(184);
const keyForms = [plain.toString('base64'), plain.toString('hex')];
const stdinHash = createHash('sha256').update(plain.toString('hex')).digest('hex');
const arn = 'arn:aws:kms:eu-central-1:111122223333:key/2345bcde-23bc-45de-67f0-2345678901bc';
const realBase64 = spawnSync('bash', ['-c', 'command -v base64'], {encoding: 'utf8'}).stdout.trim();

const bodies: Record<string, string> = {
  aws: [
    'printf "%s\\n" "aws-env AWS_CONFIG_FILE=${AWS_CONFIG_FILE-unset} AWS_SHARED_CREDENTIALS_FILE=${AWS_SHARED_CREDENTIALS_FILE-unset}' +
      ' AWS_PROFILE=${AWS_PROFILE-unset} AWS_EC2_METADATA_DISABLED=${AWS_EC2_METADATA_DISABLED-unset}" >> "$STUB_LOG"',
    'case "$1 ${2:-}" in',
    '  "--version ") printf "%s\\n" "${FAKE_AWS_VERSION:-aws-cli/2.36.7 Python/3.14.6 Linux/6.8 exe/x86_64.ubuntu.24}" ;;',
    '  "kms generate-data-key" | "kms decrypt")',
    '    if [[ -n ${FAKE_KMS_FAIL:-} ]]; then printf "An error occurred (AccessDeniedException) provider-text\\n" >&2; exit 254; fi',
    '    if [[ $2 == decrypt ]]; then printf "%s\\n" "$FAKE_PLAIN_B64"; else printf "%s\\t%s\\n" "$FAKE_BLOB_B64" "$FAKE_PLAIN_B64"; fi ;;',
    '  *) exit 97 ;;',
    'esac',
  ].join('\n'),
  // Logs a hash and the length of the key it receives on stdin, never the key.
  cryptsetup: [
    'if [[ $1 == status ]]; then exit "${FAKE_STATUS:-4}"; fi',
    'if [[ " $* " == *" --key-file=- "* ]]; then',
    '  hex=$(od -An -v -tx1 | tr -d " \\n")',
    '  printf "cryptsetup-stdin %s %s\\n" "$(printf "%s" "$hex" | sha256sum | cut -c1-64)" "$((${#hex} / 2))" >> "$STUB_LOG"',
    'fi',
    'if [[ $1 == "${FAKE_CRYPTSETUP_FAIL:-}" ]]; then exit 2; fi',
  ].join('\n'),
  lsblk: 'printf "%s" "$FAKE_LSBLK"\nexit "${FAKE_LSBLK_STATUS:-0}"',
  blkid: 'printf "%s" "${FAKE_BLKID:-}"\nexit "${FAKE_BLKID_STATUS:-2}"',
  mountpoint: 'if [[ -n ${FAKE_MOUNTED:-} ]]; then exit 0; fi\nexit 1',
  mount: 'if [[ -n ${FAKE_MOUNT_FAIL:-} ]]; then exit 32; fi',
  'mkfs.ext4': '',
  chown: '',
  udevadm: 'exit "${FAKE_UDEV_STATUS:-0}"',
  // Passes through to the real base64, so its argv is logged too.
  base64: `exec ${realBase64} "$@"`,
};

type Run = {status: number | null; stdout: string; stderr: string};
function sandbox() {
  const base = scratch('pgdata');
  const R = join(base, 'host');
  const stubs = join(base, 'stubs');
  const log = join(base, 'stub.log');
  for (const [name, body] of Object.entries(bodies)) stub(stubs, name, body);
  mkdirSync(join(R, 'etc/unai/pgdata'), {recursive: true, mode: 0o700});
  const device = join(R, 'dev/fake-disk');
  write(device, '');
  const env = (extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => {
    const vars: Record<string, string | undefined> = {
      PATH: `${stubs}:${process.env.PATH ?? ''}`, STUB_LOG: log, HOME: base, UNAI_DEPLOY_ROOT: R,
      AWS_ACCESS_KEY_ID: 'test-access-key-id', AWS_SECRET_ACCESS_KEY: 'test-secret-access-key', AWS_PROFILE: 'operator-profile',
      AWS_CONFIG_FILE: join(base, 'missing/config'), AWS_SHARED_CREDENTIALS_FILE: join(base, 'missing/credentials'),
      AWS_EC2_METADATA_DISABLED: 'true', AWS_ENDPOINT_URL: 'http://127.0.0.1:9',
      FAKE_BLOB_B64: blob.toString('base64'), FAKE_PLAIN_B64: plain.toString('base64'), FAKE_LSBLK: 'disk \n', ...extra,
    };
    return childEnv(Object.fromEntries(Object.entries(vars).filter((entry): entry is [string, string] => entry[1] !== undefined)));
  };
  const resolved = spawnSync('bash', ['-c', `for n in ${Object.keys(bodies).join(' ')}; do command -v "$n"; done`], {encoding: 'utf8', env: env()});
  if (resolved.stdout !== Object.keys(bodies).map(name => `${join(stubs, name)}\n`).join('')) throw new Error('STUB_NOT_FIRST_ON_PATH');
  const run = (script: string, argv: string[], extra: Record<string, string | undefined> = {}, prefix = ''): Run =>
    spawnSync('bash', ['-c', `${prefix}bash "$0" "$@"`, script, ...argv], {encoding: 'utf8', env: env(extra)});
  return {base, R, stubs, log, device, env, run, files: () => filesUnder(R)};
}

// No form of the plaintext key in any file under the sandbox (the stub log holds every
// stub's argv), nor in the output.
function expectNoKey(base: string, result: Run): void {
  for (const file of filesUnder(base)) {
    const bytes = readFileSync(join(base, file));
    expect(bytes.includes(plain), file).toBe(false);
    for (const form of keyForms) expect(bytes.includes(form), file).toBe(false);
  }
  for (const form of keyForms) expect(result.stdout + result.stderr).not.toContain(form);
}
const mutating = /^(aws kms|cryptsetup (luksFormat|open)|mkfs|mount |chown |base64 )/;

describe.runIf(process.platform === 'linux' && process.arch === 'x64')('deploy/pgdata/setup.sh', () => {
  const args = (device: string) => ['--device', device, '--key-arn', arn];

  it('formats, opens, makes ext4 and mounts, with the key only on cryptsetup stdin and only the ciphertext on disk', () => {
    const {base, R, log, device, run, files} = sandbox();
    const result = run(setupScript, args(device));
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const key = `${R}/etc/unai/pgdata/volume-key.enc`, mapped = `${R}/dev/mapper/unai-pgdata`;
    const env = 'aws-env AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null AWS_PROFILE=unset AWS_EC2_METADATA_DISABLED=true';
    expect(logLines(log).filter(line => !line.startsWith('base64 '))).toEqual([
      'aws --version',
      `aws-env AWS_CONFIG_FILE=${base}/missing/config AWS_SHARED_CREDENTIALS_FILE=${base}/missing/credentials AWS_PROFILE=operator-profile AWS_EC2_METADATA_DISABLED=true`,
      `lsblk -nro TYPE,MOUNTPOINT ${device}`,
      `blkid -p -o export ${device}`,
      'cryptsetup status unai-pgdata',
      `mountpoint -q ${R}/var/lib/postgresql`,
      `aws kms generate-data-key --region eu-central-1 --key-id ${arn} --number-of-bytes 64 --query [CiphertextBlob,Plaintext] --output text`,
      env,
      `chown root:root ${key}.new`,
      `cryptsetup luksFormat --batch-mode --type luks2 --cipher aes-xts-plain64 --key-size 512 --pbkdf argon2id --label unai-pgdata --key-file=- ${device}`,
      `cryptsetup-stdin ${stdinHash} 64`,
      `cryptsetup open --type luks2 --key-file=- ${device} unai-pgdata`,
      `cryptsetup-stdin ${stdinHash} 64`,
      `mkfs.ext4 -q ${mapped}`,
      `mount -o nodev,nosuid ${mapped} ${R}/var/lib/postgresql`,
    ]);
    // Ciphertext write, luksFormat and open: base64 only ever decodes stdin.
    expect(logLines(log).filter(line => line.startsWith('base64 '))).toEqual(['base64 -d', 'base64 -d', 'base64 -d']);
    expect(files()).toEqual(['dev/fake-disk', 'etc/unai/pgdata/volume-key.enc']);
    expect(statSync(key).mode & 0o777).toBe(0o400);
    expect(readFileSync(key).equals(blob)).toBe(true);
    expect(statSync(`${R}/var/lib/postgresql`).isDirectory()).toBe(true);
    expectNoKey(base, result);
    expect(result.stdout).toContain('Remaining manual steps');
    for (const text of ['/etc/unai/pgdata/aws-credentials', '/etc/unai/pgdata/aws-config', 'luksAddKey --key-slot 1',
      'systemctl enable unai-pgdata-unlock.service', 'deploy/install.sh']) expect(result.stdout).toContain(text);
  });

  it('plans every step on --dry-run with only read-only probes, no AWS call and no change', () => {
    const {R, log, device, run, files} = sandbox();
    const result = run(setupScript, [...args(device), '--dry-run'], {AWS_ACCESS_KEY_ID: undefined, AWS_SECRET_ACCESS_KEY: undefined});
    expect([result.status, result.stderr]).toEqual([0, '']);
    expect(logLines(log)).toEqual([`lsblk -nro TYPE,MOUNTPOINT ${device}`, `blkid -p -o export ${device}`,
      'cryptsetup status unai-pgdata', `mountpoint -q ${R}/var/lib/postgresql`]);
    expect(files()).toEqual(['dev/fake-disk']);
    expect(existsSync(`${R}/var/lib/postgresql`)).toBe(false);
    const planned = result.stdout.split('\n').filter(line => line.startsWith('+ ')).map(line => line.split(' ')[1]);
    expect(planned).toEqual(['aws', 'base64', 'chmod', 'chown', 'mv', 'cryptsetup', 'cryptsetup', 'mkfs.ext4', 'install', 'mount']);
  });

  const refusals: ReadonlyArray<readonly [string, string, (s: ReturnType<typeof sandbox>) => {argv?: string[]; env?: Record<string, string | undefined>; prefix?: string}]> = [
    ['an unknown flag', 'PGDATA_SETUP_USAGE', s => ({argv: [...args(s.device), '--force']})],
    ['a missing --key-arn', 'PGDATA_SETUP_USAGE', s => ({argv: ['--device', s.device]})],
    ['a key alias', 'PGDATA_SETUP_KEY_ARN_INVALID', s => ({argv: ['--device', s.device, '--key-arn', 'alias/unai-pgdata']})],
    ['a multi-Region key', 'PGDATA_SETUP_KEY_ARN_INVALID', s => ({argv: ['--device', s.device, '--key-arn',
      'arn:aws:kms:eu-central-1:111122223333:key/mrk-1234abcd12ab34cd56ef1234567890ab']})],
    ['a relative device', 'PGDATA_SETUP_DEVICE_INVALID', () => ({argv: args('dev/fake-disk')})],
    ['a device path with ..', 'PGDATA_SETUP_DEVICE_INVALID', s => ({argv: args(`${s.R}/dev/../dev/fake-disk`)})],
    ['a device outside the deploy root', 'PGDATA_SETUP_DEPLOY_ROOT_DEVICE', () => ({argv: args('/dev/sdz')})],
    ['AWS CLI v1', 'PGDATA_SETUP_CLI_V2_REQUIRED', () => ({env: {FAKE_AWS_VERSION: 'aws-cli/1.33.0 Python/3.12.3 Linux/6.8 botocore/1.34.0'}})],
    ['missing credentials', 'PGDATA_SETUP_CREDENTIALS_REQUIRED', () => ({env: {AWS_SECRET_ACCESS_KEY: undefined}})],
    ['a missing /etc/unai/pgdata', 'PGDATA_SETUP_DIRECTORY_MISSING', s => { rmSync(`${s.R}/etc/unai/pgdata`, {recursive: true}); return {}; }],
    ['a concurrent run', 'PGDATA_SETUP_BUSY', s => ({prefix: `exec 8<"${s.R}/etc/unai/pgdata" && flock 8 && `})],
    ['an existing volume key', 'PGDATA_SETUP_KEY_EXISTS', s => { write(`${s.R}/etc/unai/pgdata/volume-key.enc`, 'x', 0o400); return {}; }],
    ['a path that is not a block device', 'PGDATA_SETUP_DEVICE_INVALID', () => ({env: {FAKE_LSBLK: '', FAKE_LSBLK_STATUS: '32'}})],
    ['a loop device', 'PGDATA_SETUP_DEVICE_INVALID', () => ({env: {FAKE_LSBLK: 'loop \n'}})],
    ['a mounted device', 'PGDATA_SETUP_DEVICE_IN_USE', () => ({env: {FAKE_LSBLK: 'disk /srv\n'}})],
    ['a swap device', 'PGDATA_SETUP_DEVICE_IN_USE', () => ({env: {FAKE_LSBLK: 'disk [SWAP]\n'}})],
    ['a device with a mounted partition', 'PGDATA_SETUP_DEVICE_IN_USE', () => ({env: {FAKE_LSBLK: 'disk \npart /boot\n'}})],
    ['a device with a partition', 'PGDATA_SETUP_DEVICE_NOT_EMPTY', () => ({env: {FAKE_LSBLK: 'disk \npart \n'}})],
    ['an ext4 filesystem', 'PGDATA_SETUP_DEVICE_NOT_EMPTY', () => ({env: {FAKE_BLKID: 'TYPE=ext4\nUSAGE=filesystem\n', FAKE_BLKID_STATUS: '0'}})],
    ['a GPT partition table', 'PGDATA_SETUP_DEVICE_NOT_EMPTY', () => ({env: {FAKE_BLKID: 'PTTYPE=gpt\n', FAKE_BLKID_STATUS: '0'}})],
    ['a LUKS header', 'PGDATA_SETUP_DEVICE_NOT_EMPTY', () => ({env: {FAKE_BLKID: 'TYPE=crypto_LUKS\nUSAGE=crypto\n', FAKE_BLKID_STATUS: '0'}})],
    ['ambivalent signatures', 'PGDATA_SETUP_DEVICE_NOT_EMPTY', () => ({env: {FAKE_BLKID_STATUS: '8'}})],
    ['a failed signature probe', 'PGDATA_SETUP_DEVICE_PROBE_FAILED', () => ({env: {FAKE_BLKID_STATUS: '1'}})],
    ['an active mapping', 'PGDATA_SETUP_MAPPING_EXISTS', () => ({env: {FAKE_STATUS: '0'}})],
    ['an existing mapper node', 'PGDATA_SETUP_MAPPING_EXISTS', s => { write(`${s.R}/dev/mapper/unai-pgdata`, ''); return {}; }],
    ['another volume labelled unai-pgdata', 'PGDATA_SETUP_LABEL_EXISTS', s => {
      mkdirSync(`${s.R}/dev/disk/by-label`, {recursive: true});
      symlinkSync('../../sdb', `${s.R}/dev/disk/by-label/unai-pgdata`);
      return {};
    }],
    ['a mounted /var/lib/postgresql', 'PGDATA_SETUP_ALREADY_MOUNTED', () => ({env: {FAKE_MOUNTED: '1'}})],
    ['a non-empty /var/lib/postgresql', 'PGDATA_SETUP_MOUNT_POINT_NOT_EMPTY', s => { write(`${s.R}/var/lib/postgresql/17/main/PG_VERSION`, '17\n'); return {}; }],
  ];

  it.each(refusals)('refuses %s with %s before any AWS call or change', (_, code, prepare) => {
    const s = sandbox();
    const {argv = args(s.device), env = {}, prefix = ''} = prepare(s);
    const before = s.files();
    const result = s.run(setupScript, argv, env, prefix);
    expect([result.status, result.stderr, result.stdout]).toEqual([1, `${code}\n`, '']);
    expect(logLines(s.log).filter(line => mutating.test(line))).toEqual([]);
    expect(s.files()).toEqual(before);
  });

  it('stops at a KMS failure with no file written and no cryptsetup call', () => {
    const {log, device, run, files} = sandbox();
    const result = run(setupScript, args(device), {FAKE_KMS_FAIL: '1'});
    expect(result.status).toBe(1);
    expect(result.stderr.split('\n').filter(Boolean).at(-1)).toBe('PGDATA_SETUP_KMS_FAILED');
    expect(logLines(log).filter(line => /^(cryptsetup (luksFormat|open)|chown |mkfs|mount )/.test(line))).toEqual([]);
    expect(files()).toEqual(['dev/fake-disk']);
  });

  it.each([
    ['a 32-byte key', {FAKE_PLAIN_B64: randomBytes(32).toString('base64')}],
    ['a non-base64 ciphertext', {FAKE_BLOB_B64: 'not base64!'}],
    ['an empty response', {FAKE_BLOB_B64: '', FAKE_PLAIN_B64: ''}],
  ])('refuses %s from KMS before writing anything', (_, env) => {
    const {log, device, run, files} = sandbox();
    const result = run(setupScript, args(device), env);
    expect([result.status, result.stderr]).toEqual([1, 'PGDATA_SETUP_KMS_RESPONSE_INVALID\n']);
    expect(logLines(log).filter(line => /^(cryptsetup (luksFormat|open)|chown |base64 )/.test(line))).toEqual([]);
    expect(files()).toEqual(['dev/fake-disk']);
  });

  it('keeps the written key and stops when luksFormat fails', () => {
    const {base, R, log, device, run, files} = sandbox();
    const result = run(setupScript, args(device), {FAKE_CRYPTSETUP_FAIL: 'luksFormat'});
    expect([result.status, result.stderr]).toEqual([1, 'PGDATA_SETUP_FORMAT_FAILED\n']);
    expect(logLines(log).filter(line => /^(cryptsetup open|mkfs|mount )/.test(line))).toEqual([]);
    expect(files()).toEqual(['dev/fake-disk', 'etc/unai/pgdata/volume-key.enc']);
    expect(readFileSync(`${R}/etc/unai/pgdata/volume-key.enc`).equals(blob)).toBe(true);
    expectNoKey(base, result);
  });
});

// Static guard for both scripts: the key variable only ever feeds a builtin printf pipe.
describe('volume key handling in the pgdata scripts', () => {
  for (const file of ['deploy/pgdata/setup.sh']) {
    it(`${file}: no trace mode, no here-string and no key outside a builtin printf pipe`, () => {
      const text = readFileSync(join(root, file), 'utf8');
      expect(text).not.toMatch(/set -[a-z]*x|xtrace|\/usr\/bin\/printf|command printf|env printf/);
      const uses = text.split('\n').filter(line => !line.trimStart().startsWith('#') && /\$\{?(plain|pair)\b/.test(line));
      expect(uses.length).toBeGreaterThan(0);
      for (const line of uses) {
        expect(line, line).toMatch(/^\s*(printf '%s' "\$plain" \| base64 -d \| "\$@" \|\| fail "\$code"|plain=\$\{pair#\*\$'\\t'\}|blob=\$\{pair%%\$'\\t'\*\}|\[\[ .*\$plain =~ \S+ \]\].*)$/);
        expect(line).not.toContain('<<<');
      }
    });
  }
});

