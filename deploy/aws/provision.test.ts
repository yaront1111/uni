import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

// deploy/aws/provision.sh, run only with --dry-run or against a fake aws first on
// PATH. A real aws CLI may be installed on the host, so every spawn also gets
// missing AWS config files, a closed endpoint and no instance metadata.
const root = resolve(import.meta.dirname, '../..');
const script = join(root, 'deploy/aws/provision.sh');
const temporary = mkdtempSync(join(tmpdir(), 'unai-aws-provision-'));
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

// An answering fake for the real-run control flow; never the real CLI.
const answeringAws = [
  'if [[ ${1:-} == --version ]]; then printf \'%s\\n\' "${FAKE_VERSION:-aws-cli/2.17.0 Python/3.12.6 Linux/6.8.0 exe/x86_64.ubuntu.24}"; exit 0; fi',
  'if [[ ${1:-} == sts ]]; then [[ -z ${FAKE_STS_FAIL:-} ]] || exit 255; printf \'%s\\n\' "${FAKE_ACCOUNT:-111122223333}"; exit 0; fi',
  'if [[ "${1:-} ${2:-}" == "s3api head-bucket" || "${1:-} ${2:-}" == "iam get-user" ]]; then exit "${FAKE_PROBE:-254}"; fi',
  'if [[ -n ${FAKE_FAIL:-} && " $* " == *" $FAKE_FAIL "* ]]; then printf \'An error occurred (FakeError)\\n\' >&2; exit 254; fi',
].join('\n');

function sandbox(fake: 'failing' | 'answering' = 'failing') {
  const base = scratch('aws');
  const stubs = join(base, 'stubs');
  const log = join(base, 'stub.log');
  stub(stubs, 'aws', fake === 'failing' ? 'exit 97' : answeringAws);
  const env = (extra: Record<string, string> = {}) => childEnv({
    PATH: `${stubs}:${process.env.PATH ?? ''}`, STUB_LOG: log, HOME: base,
    AWS_CONFIG_FILE: join(base, 'missing/config'), AWS_SHARED_CREDENTIALS_FILE: join(base, 'missing/credentials'),
    AWS_EC2_METADATA_DISABLED: 'true', AWS_ENDPOINT_URL: 'http://127.0.0.1:9', ...extra,
  });
  // Every sandbox proves its stub shadows any installed aws before it is used.
  const resolved = spawnSync('bash', ['-c', 'command -v aws'], {encoding: 'utf8', env: env()});
  if (resolved.stdout !== `${join(stubs, 'aws')}\n`) throw new Error('AWS_STUB_NOT_FIRST_ON_PATH');
  const run = (argv: string[], extra: Record<string, string> = {}) =>
    spawnSync('bash', [script, ...argv], {encoding: 'utf8', env: env(extra)});
  return {stubs, log, env, run};
}

// Placeholders only: AWS's documentation account and a TEST-NET-3 address.
const evidenceArn = 'arn:aws:kms:eu-central-1:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab';
const pgdataArn = 'arn:aws:kms:eu-central-1:111122223333:key/2345bcde-23bc-45de-67f0-2345678901bc';
const backupArn = 'arn:aws:kms:eu-west-1:111122223333:key/3456cdef-34cd-56ef-7801-3456789012cd';
const inputs = {region: 'eu-central-1', backupRegion: 'eu-west-1', prefix: 'example', evidence: evidenceArn,
  backup: backupArn, pgdata: pgdataArn, ip: '203.0.113.10'};
const args = (overrides: Partial<typeof inputs> = {}): string[] => {
  const v = {...inputs, ...overrides};
  return ['--region', v.region, '--backup-region', v.backupRegion, '--bucket-prefix', v.prefix, '--evidence-key-arn', v.evidence,
    '--backup-key-arn', v.backup, '--pgdata-key-arn', v.pgdata, '--host-ipv4', v.ip];
};
const dry = [...args(), '--dry-run'];
const [evidence, backup, drill] = ['example-uai-evidence', 'example-uai-backup', 'example-uai-restore-drill'];
const [E, B, D] = [evidence, backup, drill].map(name => `arn:aws:s3:::${name}`) as [string, string, string];
const users = ['unai-api', 'unai-worker', 'unai-backup', 'unai-host-unlock', 'unai-restore-drill'];

// One planned command per `+ aws ` line; single-quoted tokens are the JSON documents.
type Argv = string[];
const commands = (stdout: string): Argv[] => stdout.split('\n').filter(line => line.startsWith('+ aws ')).map(line =>
  [...line.slice('+ aws '.length).matchAll(/'([^']*)'|(\S+)/g)].map(match => match[1] ?? match[2] ?? ''));
function option(argv: Argv, flag: string): string {
  const value = argv[argv.indexOf(flag) + 1];
  if (!argv.includes(flag) || value === undefined) throw new Error(`${argv.join(' ')}: no ${flag}`);
  return value;
}
const document = (argv: Argv, flag: string): unknown => JSON.parse(option(argv, flag));
const target = (argv: Argv) => option(argv, argv[0] === 's3api' ? '--bucket' : '--user-name');

describe.runIf(process.platform === 'linux')('deploy/aws/provision.sh', () => {
  // The plan under test: one dry run with a failing aws stub.
  let planned = '';
  let plan: Argv[] = [];
  beforeAll(() => {
    planned = sandbox().run(dry).stdout;
    plan = commands(planned);
  });
  const only = (service: string, subcommand: string, name: string): Argv => {
    const matches = plan.filter(argv => argv[0] === service && argv[1] === subcommand && target(argv) === name);
    expect(matches, `${service} ${subcommand} ${name}`).toHaveLength(1);
    return matches[0]!;
  };

  it('resolves aws to the stub, never a real CLI', () => {
    const {stubs, env} = sandbox();
    const result = spawnSync('bash', ['-c', 'command -v aws'], {encoding: 'utf8', env: env()});
    expect(result.stdout).toBe(`${join(stubs, 'aws')}\n`);
  });

  it('plans the three buckets in order and invokes no aws in --dry-run', () => {
    const {log, run: dryRun} = sandbox();
    const result = dryRun(dry);
    expect([result.status, result.stderr]).toEqual([0, '']);
    expect(existsSync(log)).toBe(false);
    const base = ['create-bucket', 'put-public-access-block', 'put-bucket-ownership-controls', 'put-bucket-encryption'];
    const s3 = plan.filter(argv => argv[0] === 's3api').map(argv => `${argv[1]} ${target(argv)}`);
    expect(s3).toEqual([
      ...[...base, 'put-bucket-versioning', 'put-bucket-lifecycle-configuration', 'put-bucket-policy'].map(sub => `${sub} ${evidence}`),
      ...[...base, 'put-bucket-versioning', 'put-bucket-lifecycle-configuration'].map(sub => `${sub} ${backup}`),
      ...[...base, 'put-bucket-lifecycle-configuration'].map(sub => `${sub} ${drill}`),
    ]);
    for (const argv of plan.filter(argv => argv[0] === 's3api')) {
      expect(option(argv, '--region'), argv.join(' ')).toBe(target(argv) === backup ? 'eu-west-1' : 'eu-central-1');
    }
  });

  it.each([
    [evidence, 'eu-central-1', evidenceArn],
    [backup, 'eu-west-1', backupArn],
    [drill, 'eu-central-1', evidenceArn],
  ])('gives %s its region, Block Public Access, BucketOwnerEnforced and exactly one aws:kms rule', (name, region, keyArn) => {
    expect(document(only('s3api', 'create-bucket', name), '--create-bucket-configuration')).toEqual({LocationConstraint: region});
    expect(document(only('s3api', 'put-public-access-block', name), '--public-access-block-configuration'))
      .toEqual({BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true});
    expect(document(only('s3api', 'put-bucket-ownership-controls', name), '--ownership-controls'))
      .toEqual({Rules: [{ObjectOwnership: 'BucketOwnerEnforced'}]});
    expect(document(only('s3api', 'put-bucket-encryption', name), '--server-side-encryption-configuration'))
      .toEqual({Rules: [{ApplyServerSideEncryptionByDefault: {SSEAlgorithm: 'aws:kms', KMSMasterKeyID: keyArn}, BucketKeyEnabled: true}]});
  });

  it('versions the evidence and backup buckets and gives each bucket its lifecycle', () => {
    for (const name of [evidence, backup]) {
      expect(document(only('s3api', 'put-bucket-versioning', name), '--versioning-configuration')).toEqual({Status: 'Enabled'});
    }
    const lifecycle = (name: string) => document(only('s3api', 'put-bucket-lifecycle-configuration', name), '--lifecycle-configuration');
    expect(lifecycle(evidence)).toEqual({Rules: [{ID: 'uai-evidence-noncurrent', Status: 'Enabled', Filter: {},
      NoncurrentVersionExpiration: {NoncurrentDays: 30}, Expiration: {ExpiredObjectDeleteMarker: true}}]});
    expect(lifecycle(backup)).toEqual({Rules: [{ID: 'uai-backup-retention', Status: 'Enabled', Filter: {}, Expiration: {Days: 30},
      NoncurrentVersionExpiration: {NoncurrentDays: 5}, AbortIncompleteMultipartUpload: {DaysAfterInitiation: 1}}]});
    expect(lifecycle(drill)).toEqual({Rules: [{ID: 'uai-restore-drill-expiry', Status: 'Enabled', Filter: {}, Expiration: {Days: 2}}]});
  });

  it('denies plain HTTP and any evidence put not under the evidence key', () => {
    expect(document(only('s3api', 'put-bucket-policy', evidence), '--policy')).toEqual({Version: '2012-10-17', Statement: [
      {Sid: 'DenyInsecureTransport', Effect: 'Deny', Principal: '*', Action: 's3:*', Resource: [E, `${E}/*`],
        Condition: {Bool: {'aws:SecureTransport': 'false'}}},
      {Sid: 'DenyPutWithoutKms', Effect: 'Deny', Principal: '*', Action: 's3:PutObject', Resource: `${E}/*`,
        Condition: {StringNotEquals: {'s3:x-amz-server-side-encryption': 'aws:kms'}}},
      {Sid: 'DenyPutUnderAnotherKey', Effect: 'Deny', Principal: '*', Action: 's3:PutObject', Resource: `${E}/*`,
        Condition: {StringNotEquals: {'s3:x-amz-server-side-encryption-aws-kms-key-id': evidenceArn}}},
    ]});
  });

  it('names the credential files in the manual steps', () => {
    const manual = planned.split('Remaining manual steps:')[1] ?? '';
    for (const path of ['/etc/unai/secrets/api/aws/credentials', '/etc/unai/secrets/worker/aws/credentials',
      '/etc/unai/backup/aws-credentials', '/etc/unai/pgdata/aws-credentials']) expect(manual).toContain(path);
    expect(manual).toContain('default key policy');
  });

  describe('IAM', () => {
    // Each statement as `<action> <resource>[ <condition JSON>]`, sorted.
    function grants(user: string): string[] {
      const argv = only('iam', 'put-user-policy', user);
      expect(option(argv, '--policy-name')).toBe(user);
      const policy = document(argv, '--policy-document') as {Version: unknown; Statement: Array<Record<string, unknown>>};
      expect(Object.keys(policy).sort()).toEqual(['Statement', 'Version']);
      expect(policy.Version).toBe('2012-10-17');
      return policy.Statement.flatMap(statement => {
        const keys = ['Action', 'Effect', 'Resource', ...(statement.Condition === undefined ? [] : ['Condition'])];
        expect(Object.keys(statement).sort()).toEqual(keys.sort());
        expect(statement.Effect).toBe('Allow');
        const condition = statement.Condition === undefined ? '' : ` ${JSON.stringify(statement.Condition)}`;
        return (statement.Action as string[]).flatMap(action => (statement.Resource as string[]).map(resource => `${action} ${resource}${condition}`));
      }).sort();
    }
    const runtime = [`s3:GetEncryptionConfiguration ${E}`, `s3:PutObject ${E}/*`, `s3:GetObject ${E}/*`, `s3:DeleteObject ${E}/*`,
      `kms:GenerateDataKey ${evidenceArn}`, `kms:Decrypt ${evidenceArn}`];
    const expected: Record<string, string[]> = {
      'unai-api': runtime,
      'unai-worker': runtime,
      'unai-backup': [`s3:GetEncryptionConfiguration ${E}`, `s3:GetObject ${E}/*`, `kms:Decrypt ${evidenceArn}`, `s3:ListBucket ${B}`,
        `s3:PutObject ${B}/*`, `s3:GetObject ${B}/*`, `s3:AbortMultipartUpload ${B}/*`, `kms:GenerateDataKey ${backupArn}`, `kms:Decrypt ${backupArn}`],
      'unai-host-unlock': [`kms:Decrypt ${pgdataArn} {"IpAddress":{"aws:SourceIp":"203.0.113.10/32"}}`],
      'unai-restore-drill': [`s3:ListBucket ${B}`, `s3:GetObject ${B}/*`, `kms:Decrypt ${backupArn}`, `s3:GetEncryptionConfiguration ${D}`,
        `s3:ListBucket ${D}`, `s3:PutObject ${D}/*`, `s3:GetObject ${D}/*`, `s3:DeleteObject ${D}/*`,
        `kms:GenerateDataKey ${evidenceArn}`, `kms:Decrypt ${evidenceArn}`],
    };

    it('creates the five users in order, each with one inline policy named after it', () => {
      expect(plan.filter(argv => argv[0] === 'iam').map(argv => `${argv[1]} ${target(argv)}`)).toEqual(users.flatMap(user => [`create-user ${user}`, `put-user-policy ${user}`]));
    });

    it.each(users)('gives %s exactly the ADR 0043 action and resource set', user => {
      expect(grants(user)).toEqual([...expected[user]!].sort());
    });

    it('grants no destructive, key-management or wildcard action, and deletes evidence only through api and worker', () => {
      const all = users.flatMap(user => grants(user).map(grant => [user, ...grant.split(' ')] as [string, string, string, string?]));
      for (const [user, action, resource, condition] of all) {
        expect(['s3:DeleteObjectVersion', 'kms:ScheduleKeyDeletion', 'kms:DisableKey', 'kms:PutKeyPolicy'], user).not.toContain(action);
        expect(action, user).not.toContain('*');
        expect(resource, user).not.toBe('*');
        if (action === 's3:ListBucket') expect(resource, user).not.toBe(E);
        if (user === 'unai-backup') expect(action.startsWith('s3:DeleteObject'), action).toBe(false);
        if (condition !== undefined) expect(user).toBe('unai-host-unlock');
      }
      expect(new Set(all.filter(([, action, resource]) => action === 's3:DeleteObject' && resource === `${E}/*`).map(([user]) => user)))
        .toEqual(new Set(['unai-api', 'unai-worker']));
    });
  });

  it('plans only allowlisted subcommands, and neither script names a key, access-key, login or lock command', () => {
    const allowed = new Set(['s3api create-bucket', 's3api put-public-access-block', 's3api put-bucket-ownership-controls',
      's3api put-bucket-encryption', 's3api put-bucket-versioning', 's3api put-bucket-lifecycle-configuration',
      's3api put-bucket-policy', 'iam create-user', 'iam put-user-policy']);
    expect(plan.length).toBeGreaterThan(20);
    for (const argv of plan) {
      expect(allowed.has(`${argv[0]} ${argv[1]}`), argv.join(' ')).toBe(true);
      expect(argv).not.toContain('--object-lock-enabled-for-bucket');
    }
    for (const file of ['deploy/aws/provision.sh', 'deploy/tls/issue-internal-ca.sh']) {
      const source = readFileSync(join(root, file), 'utf8').toLowerCase();
      for (const word of ['create-access-key', 'create-key', 'create-login-profile', 'put-key-policy', 'schedule-key-deletion',
        'disable-key', 'object-lock']) expect(source.includes(word), `${file}: ${word}`).toBe(false);
    }
  });

  it('prints a byte-identical plan twice, with no blank inside any argument', () => {
    expect(sandbox().run(dry).stdout).toBe(planned);
    for (const argv of plan) for (const token of argv) expect(token).not.toMatch(/\s/);
  });

  it('omits the LocationConstraint for a us-east-1 bucket only', () => {
    const east = (arn: string) => arn.replace('eu-central-1', 'us-east-1');
    const result = sandbox().run([...args({region: 'us-east-1', evidence: east(evidenceArn), pgdata: east(pgdataArn)}), '--dry-run']);
    expect([result.status, result.stderr]).toEqual([0, '']);
    const creates = commands(result.stdout).filter(argv => argv[1] === 'create-bucket');
    expect(creates.map(argv => [target(argv), option(argv, '--region')])).toEqual([
      [evidence, 'us-east-1'], [backup, 'eu-west-1'], [drill, 'us-east-1']]);
    expect(creates.map(argv => argv.includes('--create-bucket-configuration'))).toEqual([false, true, false]);
    expect(document(creates[1]!, '--create-bucket-configuration')).toEqual({LocationConstraint: 'eu-west-1'});
  });

  const without = (flag: string) => {
    const argv = args();
    argv.splice(argv.indexOf(flag), 2);
    return [...argv, '--dry-run'];
  };
  const mrk = (region: string) => `arn:aws:kms:${region}:111122223333:key/mrk-${'0123456789abcdef'.repeat(2)}`;
  it.each([
    ['no arguments', [], 'AWS_PROVISION_USAGE'],
    ['an unknown flag', [...dry, '--force'], 'AWS_PROVISION_USAGE'],
    ['a missing --host-ipv4', without('--host-ipv4'), 'AWS_PROVISION_USAGE'],
    ['a trailing flag without a value', [...dry, '--region'], 'AWS_PROVISION_USAGE'],
    ['a flag as a value', [...without('--host-ipv4'), '--host-ipv4', '--dry-run'], 'AWS_PROVISION_USAGE'],
    ['an invalid region', [...args({region: 'eu_central_1'}), '--dry-run'], 'AWS_PROVISION_REGION_INVALID'],
    ['equal regions', [...args({backupRegion: 'eu-central-1'}), '--dry-run'], 'AWS_PROVISION_BACKUP_REGION_SAME'],
    ['a prefix with a dot', [...args({prefix: 'my.prefix'}), '--dry-run'], 'AWS_PROVISION_BUCKET_PREFIX_INVALID'],
    ['an uppercase prefix', [...args({prefix: 'Example'}), '--dry-run'], 'AWS_PROVISION_BUCKET_PREFIX_INVALID'],
    ['a 46-character prefix', [...args({prefix: 'a'.repeat(46)}), '--dry-run'], 'AWS_PROVISION_BUCKET_PREFIX_INVALID'],
    ['a reserved prefix', [...args({prefix: 'xn--example'}), '--dry-run'], 'AWS_PROVISION_BUCKET_PREFIX_INVALID'],
    ['an alias ARN', [...args({evidence: 'arn:aws:kms:eu-central-1:111122223333:alias/unai-evidence'}), '--dry-run'], 'AWS_PROVISION_KEY_ARN_INVALID'],
    ['an evidence key in another region', [...args({evidence: evidenceArn.replace('eu-central-1', 'eu-west-1')}), '--dry-run'], 'AWS_PROVISION_KEY_ARN_INVALID'],
    ['a backup key in the evidence region', [...args({backup: backupArn.replace('eu-west-1', 'eu-central-1')}), '--dry-run'], 'AWS_PROVISION_KEY_ARN_INVALID'],
    ['the evidence key as pgdata key', [...args({pgdata: evidenceArn}), '--dry-run'], 'AWS_PROVISION_KEY_ARN_INVALID'],
    ['a key from another account', [...args({backup: backupArn.replace('111122223333', '444455556666')}), '--dry-run'], 'AWS_PROVISION_KEY_ARN_INVALID'],
    ['a backup key replicating the evidence key', [...args({evidence: mrk('eu-central-1'), backup: mrk('eu-west-1')}), '--dry-run'], 'AWS_PROVISION_KEY_ARN_INVALID'],
    ['an octet above 255', [...args({ip: '203.0.113.256'}), '--dry-run'], 'AWS_PROVISION_HOST_IPV4_INVALID'],
    ['a CIDR suffix', [...args({ip: '203.0.113.10/32'}), '--dry-run'], 'AWS_PROVISION_HOST_IPV4_INVALID'],
    ['an IPv6 address', [...args({ip: '::1'}), '--dry-run'], 'AWS_PROVISION_HOST_IPV4_INVALID'],
  ])('refuses %s before any aws call', (_, argv, code) => {
    const {log, run: refuse} = sandbox();
    const result = refuse(argv);
    expect([result.status, result.stderr, result.stdout]).toEqual([1, `${code}\n`, '']);
    expect(existsSync(log)).toBe(false);
  });

  describe('real run against a fake aws', () => {
    const strip = (lines: string[]) => lines.map(line => line.replace(/^aws /, ''));
    const probe = /^(--version$|sts |s3api head-bucket |iam get-user )/;

    it('probes, then issues exactly the planned commands in order', () => {
      const {log, run: real} = sandbox('answering');
      const result = real(args());
      expect([result.status, result.stderr]).toEqual([0, '']);
      expect(result.stdout).toBe(planned);
      const logged = strip(logLines(log));
      expect(logged.slice(0, 2)).toEqual(['--version', 'sts get-caller-identity --region eu-central-1 --query Account --output text']);
      expect(logged.filter(line => !probe.test(line))).toEqual(plan.map(argv => argv.join(' ')));
      expect(logged.filter(line => line.startsWith('s3api head-bucket '))).toHaveLength(3);
      expect(logged.filter(line => line.startsWith('iam get-user '))).toHaveLength(5);
    });

    it('creates no bucket or user that the probes find, and still applies every setting', () => {
      const {log, run: real} = sandbox('answering');
      const result = real(args(), {FAKE_PROBE: '0'});
      expect([result.status, result.stderr]).toEqual([0, '']);
      const logged = strip(logLines(log)).filter(line => !probe.test(line));
      expect(logged).toEqual(plan.filter(argv => !argv[1]!.startsWith('create-')).map(argv => argv.join(' ')));
    });

    it('stops at the first failing call with AWS_PROVISION_FAILED', () => {
      const {log, run: real} = sandbox('answering');
      const result = real(args(), {FAKE_FAIL: 'put-bucket-versioning'});
      expect(result.status).toBe(1);
      expect(result.stderr).toBe('An error occurred (FakeError)\nAWS_PROVISION_FAILED\n');
      expect(strip(logLines(log)).at(-1)).toMatch(/^s3api put-bucket-versioning --bucket example-uai-evidence /);
    });

    it.each([
      ['an account mismatch', {FAKE_ACCOUNT: '444455556666'}, 'AWS_PROVISION_ACCOUNT_MISMATCH', 2],
      ['missing credentials', {FAKE_STS_FAIL: '1'}, 'AWS_PROVISION_CREDENTIALS_UNAVAILABLE', 2],
      ['AWS CLI v1', {FAKE_VERSION: 'aws-cli/1.33.9 Python/3.12.6 Linux/6.8.0 botocore/1.35.0'}, 'AWS_PROVISION_CLI_V2_REQUIRED', 1],
    ])('refuses %s before any mutation', (_, extra, code, calls) => {
      const {log, run: real} = sandbox('answering');
      const result = real(args(), extra);
      expect([result.status, result.stderr, result.stdout]).toEqual([1, `${code}\n`, '']);
      expect(strip(logLines(log))).toEqual(['--version', 'sts get-caller-identity --region eu-central-1 --query Account --output text'].slice(0, calls));
    });
  });
});
