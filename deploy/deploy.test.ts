import {spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {describe, expect, it} from 'vitest';

const root = resolve(import.meta.dirname, '..');
const read = (file: string) => readFileSync(resolve(root, file), 'utf8').replace(/\r\n/g, '\n');
const processes = [
  {name: 'api', heading: 'API', directory: '', entry: 'packages/api/src/server.ts', memory: '1G'},
  {name: 'web', heading: 'Web', directory: '/apps/web', entry: 'server.ts', memory: '1536M'},
  {name: 'worker', heading: 'Processing worker', directory: '', entry: 'packages/api/src/processing-worker.ts', memory: '1G'},
] as const;
const environment = 'docs/operations/environment.md';
const unitFile = (name: string) => `deploy/systemd/unai-${name}.service`;
const exampleFile = (name: string) => `deploy/env/${name}.env.example`;
const timerFile = (name: string) => `deploy/systemd/unai-${name}.timer`;
type Assignment = {name: string; active: boolean; value: string; comment: string};

function contract(heading: string): Map<string, boolean> {
  const section = read(environment).split(`## ${heading}`)[1]?.split('\n## ')[0];
  expect(section, `missing contract section: ${heading}`).toBeDefined();
  const variables = new Map<string, boolean>();
  for (const line of section!.split('\n').filter(line => line.startsWith('| `'))) {
    const cells = line.split('|');
    for (const match of cells[1]!.matchAll(/`([A-Z][A-Z0-9_]*)`/g)) {
      const name = match[1]!;
      // Multiple consumer rows (NEXTAUTH_URL) describe one required variable.
      variables.set(name, variables.get(name) === true || cells[2]!.trim().startsWith('required'));
    }
  }
  expect(variables.size).toBeGreaterThan(0);
  return variables;
}

function example(file: string): Assignment[] {
  const lines = read(file).split('\n');
  return lines.flatMap((line, index) => {
    const match = /^(#\s*)?([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match) {
      expect(line === '' || line.startsWith('#'), `${file}:${index + 1}: malformed assignment`).toBe(true);
      return [];
    }
    return [{name: match[2]!, active: !match[1], value: match[3]!, comment: lines[index - 1] ?? ''}];
  });
}

function unit(file: string): Map<string, Map<string, string[]>> {
  const sections = new Map<string, Map<string, string[]>>();
  let section: Map<string, string[]> | undefined;
  for (const line of read(file).split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      section = sections.get(header[1]!) ?? new Map<string, string[]>();
      sections.set(header[1]!, section);
      continue;
    }
    const assignment = /^([A-Za-z]+)=(.*)$/.exec(line);
    if (!section || !assignment) throw new Error(`Invalid unit line in ${file}: ${line}`);
    const key = assignment[1]!;
    section.set(key, [...(section.get(key) ?? []), assignment[2]!]);
  }
  return sections;
}

const secretPatterns = [
  /(AKIA|ASIA)[0-9A-Z]{16}/, /ya29\./, /^1\/\//, /GOCSPX-/, /sk-ant-/,
  /\bsk-[A-Za-z0-9]{20,}/, /-----BEGIN/, /gh[pousr]_|github_pat_/, /omi_dev_/,
  /:\/\/[^/\s@]+:[^/\s@]+@/,
];
function looksSecret(value: string): boolean {
  if (secretPatterns.some(pattern => pattern.test(value))) return true;
  // Paths/handles are metadata: count their components, not separators, so the
  // mandated /etc/unai/secrets/worker/aws/credentials is not mistaken for a key.
  const components = value.startsWith('/') || /^secret:\/\/[a-z][a-z0-9-]*\//.test(value)
    ? value.split('/').join('.') : value;
  return /[A-Za-z0-9+/=_-]{32,}/.test(components);
}

function activeValue(name: string, variable: string): string {
  const assignment = example(exampleFile(name)).find(row => row.name === variable && row.active);
  if (!assignment) throw new Error(`Missing active ${variable} in ${name}`);
  return assignment.value;
}

describe('deployment bundle', () => {
  for (const process of processes) {
    const {name, heading, directory, entry, memory} = process;
    it(`${name}: exact contract variables, active required values and kind comments`, () => {
      const expected = contract(heading), actual = example(exampleFile(name));
      expect(actual.map(row => row.name).sort()).toEqual([...expected.keys()].sort());
      for (const row of actual) {
        expect(row.comment, row.name).toMatch(/^#.*\b(required|optional)\b/);
        expect(row.comment, row.name).toMatch(/\b(handle|path|literal|url)\b/i);
        if (expected.get(row.name)) expect(row.active, row.name).toBe(true);
        if (row.active) expect(row.value, row.name).not.toBe('');
      }
    });

    it(`${name}: examples and unit environment contain no secret-looking values`, () => {
      const values = [
        ...example(exampleFile(name)).map(row => row.value),
        ...(unit(unitFile(name)).get('Service')?.get('Environment') ?? []).map(line => line.slice(line.indexOf('=') + 1)),
      ];
      for (const value of values) expect(looksSecret(value), `${name}: secret-looking configuration`).toBe(false);
    });

    it(`${name}: exact supervised command and hardening without write grants`, () => {
      const parsed = unit(unitFile(name)), service = parsed.get('Service')!;
      const command = `node --import tsx ${entry}`;
      const expected: Record<string, string[]> = {
        Type: ['exec'], User: [`unai-${name}`], Group: [`unai-${name}`],
        WorkingDirectory: [`/opt/unai/current${directory}`], EnvironmentFile: [`/etc/unai/${name}.env`],
        ExecStart: [command], ExecStartPre: [command + ' --check'],
        Restart: ['on-failure'], RestartSec: ['5'], TimeoutStartSec: ['180'], TimeoutStopSec: ['30'], KillSignal: ['SIGTERM'],
        NoNewPrivileges: ['yes'], ProtectSystem: ['strict'], ProtectHome: ['yes'], PrivateTmp: ['yes'],
        ReadOnlyPaths: ['/etc/unai/secrets'], MemoryMax: [memory],
        CapabilityBoundingSet: [name === 'web' ? 'CAP_NET_BIND_SERVICE' : ''],
        Environment: ['NODE_ENV=production'],
      };
      if (name === 'web') expected.AmbientCapabilities = ['CAP_NET_BIND_SERVICE'];
      else expected.Environment!.push(
        `AWS_SHARED_CREDENTIALS_FILE=${activeValue(name, 'UNAI_SECRETS_MOUNT')}/aws/credentials`,
        'AWS_EC2_METADATA_DISABLED=true',
      );
      expect(service.has('ReadWritePaths')).toBe(false);
      expect(service.has('MemoryDenyWriteExecute')).toBe(false);
      expect(Object.fromEntries(service)).toEqual(expected);
      expect(existsSync(resolve(root, `.${directory}`, entry))).toBe(true);
      expect([...parsed.keys()].sort()).toEqual(['Install', 'Service', 'Unit']);
      expect(Object.fromEntries(parsed.get('Unit')!)).toEqual({
        Description: [name === 'api' ? 'Uai API' : name === 'web' ? 'Uai web' : 'Uai processing worker'],
        Wants: ['network-online.target'],
        After: [name === 'web' ? 'network-online.target' : 'network-online.target postgresql.service'],
      });
      expect(Object.fromEntries(parsed.get('Install')!)).toEqual({WantedBy: ['multi-user.target']});
    });

    it(`${name}: unit environment names are documented`, () => {
      for (const assignment of unit(unitFile(name)).get('Service')!.get('Environment')!) {
        expect(read(environment)).toContain('`' + assignment.split('=')[0] + '`');
      }
    });
  }

  it('only web binds a privileged port', () => {
    // URL forbids placeholder brackets in hostnames; replace metadata for parsing only.
    const origin = new URL(activeValue('web', 'NEXTAUTH_URL').replace('<owner-domain>', 'example.invalid'));
    expect(origin.protocol).toBe('https:');
    expect(Number(origin.port || 443)).toBe(443);
    for (const [name, variable] of [['api', 'UNAI_API_PORT'], ['api', 'UNAI_PROBE_PORT'], ['worker', 'UNAI_PROBE_PORT']] as const) {
      const port = Number(activeValue(name, variable));
      expect(Number.isInteger(port)).toBe(true);
      expect(port).toBeGreaterThanOrEqual(1024);
      expect(port).toBeLessThanOrEqual(65535);
    }
  });

  it('secret detector rejects every synthetic token pattern', () => {
    const samples = ['AKIA' + 'A'.repeat(16), 'ASIA' + 'B'.repeat(16), 'ya29.synthetic', '1//synthetic',
      'GOCSPX-synthetic', 'sk-ant-synthetic', 'sk-' + 'C'.repeat(20), '-----BEGIN SYNTHETIC KEY-----',
      ...['p', 'o', 'u', 's', 'r'].map(kind => `gh${kind}_synthetic`), 'github_pat_synthetic', 'omi_dev_synthetic',
      'https://user:synthetic@example.invalid', 'D'.repeat(32), 'abc+/=_-'.repeat(4),
      '/etc/unai/' + 'E'.repeat(32), 'secret://mounted/' + 'F'.repeat(32),
      'https://example.invalid/' + 'G'.repeat(32), 'secret://mounted/sk-ant-synthetic'];
    for (const sample of samples) expect(looksSecret(sample)).toBe(true);
  });

  it('secret detector permits handles, paths, URLs, literals and KMS placeholders', () => {
    for (const value of ['secret://mounted/api-database-url', 'secret://mounted/google-signin-client-secret',
      '/etc/unai/secrets/worker/aws/credentials', 'https://api.anthropic.com/v1/messages', 'production', '3443',
      '<registry-release-uuid>', 'arn:aws:kms:<aws-region>:<aws-account-id>:key/<evidence-key-id>']) {
      expect(looksSecret(value)).toBe(false);
    }
  });

  const available = spawnSync('systemd-analyze', ['--version'], {encoding: 'utf8'}).status === 0;
  for (const {name} of processes) {
    it.skipIf(!available)(`${name}: ${available ? 'systemd-analyze verify' : 'skipped: systemd-analyze not installed'}`, () => {
      const temporary = mkdtempSync(join(tmpdir(), 'unai-deploy-'));
      const basename = `unai-${name}.service`, copy = join(temporary, basename);
      try {
        writeFileSync(copy, read(unitFile(name)).replace(/^(ExecStart(?:Pre)?=)node\b/gm, `$1${process.execPath}`));
        const result = spawnSync('systemd-analyze', ['verify', copy], {encoding: 'utf8'});
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        // Unknown keys only warn (exit 0); ignore unrelated host-unit warnings.
        expect(result.stderr.split('\n').filter(line => line.includes(basename))).toEqual([]);
      } finally {
        rmSync(temporary, {recursive: true, force: true});
      }
    });
  }
});

type Sections = ReadonlyArray<readonly [string, readonly string[]]>;
const README_SECTIONS: Sections = [
  ['Before you start', ['Ubuntu Server 24.04', 'uai.<owner-domain>', '0 issue "letsencrypt.org"', 'ufw', 'Desktop app']],
  ['AWS buckets and IAM users', ['deploy/aws/provision.sh', '--dry-run']],
  ['Install the release', ['deploy/install.sh', '--tag', 'INSTALL_RELEASE_MISMATCH']],
  ['Encrypted data volume', ['cryptsetup', '/etc/unai/pgdata/volume-key.enc', '/var/lib/postgresql/unai-restore-drill-staging',
    'deploy/pgdata/setup.sh', 'systemctl enable --now unai-pgdata-unlock.service', 'PGDATA_UNLOCK_KMS_FAILED']],
  ['Internal CA and PostgreSQL', ['deploy/tls/issue-internal-ca.sh', 'deploy/postgres/unai.conf', 'deploy/postgres/pg_hba.conf',
    'deploy/postgres/provision.sql', '/root/unai-provision.psql']],
  ['Secrets', ['pnpm secret:put', '/root/.pgpass', '/etc/unai/backup/backup.key', '/etc/unai/restore-drill/pgpass', 'google-connector-client']],
  ['Environment files', ['/etc/unai/backup.env', '/etc/unai/restore-drill.env', '/etc/unai/migrate.env']],
  ['Web certificate', ['certbot certonly', 'RENEWED_LINEAGE']],
  ['Migrate and publish the registry release', ['pnpm db:migrate', 'pnpm uai registry tags --require',
    'pnpm uai registry publish --version', 'UNAI_REGISTRY_RELEASE_ID']],
  ['Preflight checks', ['systemd-run', '--check', 'API_UNREACHABLE']],
  ['Start the API and the web', ['systemctl enable --now unai-api.service', 'systemctl enable --now unai-web.service']],
  ['Health and readiness', ['/healthz', '/readyz', '127.0.0.1:9101', '/signin']],
  ['First sign-in, the worker and the timers', ['owner_scope_members', 'UNAI_PROCESSING_OWNER_SCOPE_ID',
    'systemctl enable --now unai-worker.service', '127.0.0.1:9102', 'systemctl enable --now unai-backup.timer unai-restore-drill.timer']],
  ['Connectors', ['pnpm connect:google', 'ssh -L', 'secret://mounted/connectors/google', 'GitHub', 'Omi']],
  ['Upgrade', ['D12', 'unai-backup.timer', 'deploy/upgrade.sh', '--registry-version']],
  ['Backup and restore', ['systemctl start unai-backup.service', 'pnpm backup', 'pnpm restore', 'pnpm restore:drill',
    'restore.drill.completed', 'journalctl -u unai-restore-drill.service']],
  ['Runbooks', ['../docs/operations/backup.md', '../docs/operations/restore.md', '../docs/operations/deletion.md',
    '../docs/operations/registry-migration.md', '../docs/operations/projection-rebuild.md', '../docs/operations/connector-revocation.md',
    '../docs/operations/real-data-gates.md', 'rotate.md']],
];
const ROTATE_SECTIONS: Sections = ([
  ['unai_api_login database password', ['api-database-url']],
  ['unai_worker_login database password', ['worker-database-url']],
  ['unai_auth_login database password', ['/etc/unai/secrets/web/auth-database-url']],
  ['unai_migrator database password', ['/root/.pgpass', '/etc/unai/restore-drill/pgpass']],
  ['unai_backup database password', ['/etc/unai/backup/pgpass']],
  ['NEXTAUTH_SECRET', ['nextauth-secret']],
  ['Google sign-in client secret', ['google-signin-client-secret']],
  ['Google connector client', ['google-connector-client']],
  ['Connector tokens', ['pnpm connect:google', '--replace', 'pnpm secret:put']],
  ['Model API key', ['anthropic-api-key']],
  ['AWS access keys', ['unai-host-unlock', 'unai-restore-drill']],
  ['Backup key', ['/etc/unai/backup/backup.key', 'systemctl start unai-backup.service']],
  ['TLS certificates', ['deploy/tls/issue-internal-ca.sh', '--renew-leaves', 'certbot']],
  ['Data volume recovery passphrase', ['luksChangeKey']],
] as const).map(([heading, snippets]) => [heading, [...snippets, '**Change.**', '**Restart.**', '**Invalidated.**']] as const);

function headingsOf(text: string): Array<{level: number; title: string; index: number}> {
  let fenced = false;
  return text.split('\n').flatMap((line, index) => {
    if (line.startsWith('```')) { fenced = !fenced; return []; }
    const match = !fenced && /^(#{1,6}) (.+)$/.exec(line);
    return match ? [{level: match[1]!.length, title: match[2]!, index}] : [];
  });
}

function structureProblems(text: string, expected: Sections): string[] {
  const sections = headingsOf(text).filter(heading => heading.level === 2), lines = text.split('\n');
  const problems = JSON.stringify(sections.map(section => section.title)) === JSON.stringify(expected.map(([title]) => title))
    ? [] : ['section order'];
  for (const [title, snippets] of expected) {
    const index = sections.findIndex(section => section.title === title), section = sections[index];
    const body = section ? lines.slice(section.index + 1, sections[index + 1]?.index).join('\n') : '';
    for (const snippet of snippets) if (!body.includes(snippet)) problems.push(`${title}: missing ${snippet}`);
  }
  return problems;
}

const pnpmPattern = /\bpnpm ([a-z][a-z0-9:-]*)/g;
const pathPattern = /\b(?:deploy|scripts|docs|packages)\/[A-Za-z0-9_.\/-]*[A-Za-z0-9_]\.(?:sh|sql|conf|service|timer|example|md|mjs|ts|json)\b/g;
const linkPattern = /\[[^\]]*\]\(([^)]+)\)/g;
function commandProblems(text: string): string[] {
  const manifest: {scripts: Record<string, string>} = JSON.parse(read('package.json'));
  const source = read('packages/registry/src/cli.ts'), problems: string[] = [];
  // D12 requires install: it is a pnpm builtin, not a package.json script.
  for (const [, name] of text.matchAll(pnpmPattern)) if (name !== 'install' && !Object.hasOwn(manifest.scripts, name!)) problems.push(`script: ${name}`);
  for (const [, group, command] of text.matchAll(/\bpnpm uai ([a-z]+) ([a-z][a-z-]*)/g)) {
    const exists = group === 'registry' ? source.includes(`group === 'registry' && command === '${command}'`)
      : group === 'corpus' && (source.split("group === 'corpus'")[1]?.includes(`command === '${command}'`) ?? false);
    if (!exists) problems.push(`uai: ${group} ${command}`);
  }
  const capabilities = read('packages/connectors/src/manifests.ts');
  for (const [, ids] of text.matchAll(/--capabilities ([a-z_.]+(?:,[a-z_.]+)*)/g)) {
    for (const id of ids!.split(',')) if (!capabilities.includes(`capabilityId: '${id}'`)) problems.push(`capability: ${id}`);
  }
  return problems;
}
const pathProblems = (text: string): string[] => [...text.matchAll(pathPattern)]
  // The installed certbot hook contains /deploy/ but is not a repository path.
  .filter(match => !text.slice(0, match.index).match(/\/[A-Za-z0-9_.\/-]*$/))
  .map(match => match[0]).filter(path => !existsSync(resolve(root, path)));
const slug = (title: string) => title.trim().toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-');
function linkProblems(text: string, document: string): string[] {
  const problems: string[] = [];
  for (const [, target] of text.matchAll(linkPattern)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target!)) continue;
    const [path, fragment] = target!.split('#'), file = path ? resolve(root, document, '..', path) : resolve(root, document);
    if (!existsSync(file)) { problems.push(`file: ${target}`); continue; }
    if (fragment && !headingsOf(path ? readFileSync(file, 'utf8') : text).some(heading => slug(heading.title) === fragment)) {
      problems.push(`anchor: ${target}`);
    }
  }
  return problems;
}

describe('operator documents', () => {
  for (const [file, sections] of [['deploy/README.md', README_SECTIONS], ['deploy/rotate.md', ROTATE_SECTIONS]] as const) {
    it(`${file}: exact ordered sections and required operational details`, () => expect(structureProblems(read(file), sections)).toEqual([]));
    it(`${file}: commands and repository paths exist`, () => {
      expect(commandProblems(read(file))).toEqual([]);
      expect(pathProblems(read(file))).toEqual([]);
    });
    it(`${file}: relative links and anchors resolve`, () => expect(linkProblems(read(file), file)).toEqual([]));
  }
  it('document checkers reject broken structure, commands, paths and links', () => {
    expect(structureProblems('## Wrong\nbody', [['Right', ['required']]])).toEqual(['section order', 'Right: missing required']);
    expect(structureProblems('## Right\nrequired\n```\n## Not a section\n```', [['Right', ['required']]])).toEqual([]);
    expect(commandProblems('pnpm nonexistent')).toEqual(['script: nonexistent']);
    expect(commandProblems('pnpm install --frozen-lockfile')).toEqual([]);
    expect(commandProblems('pnpm connect:google --capabilities calendar.nonexistent')).toEqual(['capability: calendar.nonexistent']);
    expect(commandProblems('pnpm uai registry nonexistent')).toEqual(['uai: registry nonexistent']);
    expect(commandProblems('pnpm uai corpus nonexistent')).toEqual(['uai: corpus nonexistent']);
    expect(commandProblems('pnpm uai unknown test')).toEqual(['uai: unknown test']);
    expect(pathProblems('deploy/nonexistent.sh')).toEqual(['deploy/nonexistent.sh']);
    expect(pathProblems('/etc/letsencrypt/renewal-hooks/deploy/unai-web.sh')).toEqual([]);
    expect(linkProblems('[bad](nonexistent.md)', 'deploy/README.md')).toEqual(['file: nonexistent.md']);
    expect(linkProblems('[bad](../docs/operations/backup.md#no-such-anchor)', 'deploy/README.md')).toEqual(['anchor: ../docs/operations/backup.md#no-such-anchor']);
    expect(linkProblems('[good](https://example.invalid)', 'deploy/README.md')).toEqual([]);
  });
  it('document checks cannot pass vacuously', () => {
    const text = read('deploy/README.md') + read('deploy/rotate.md');
    expect([...text.matchAll(pnpmPattern)].length).toBeGreaterThanOrEqual(10);
    expect([...text.matchAll(linkPattern)].length).toBeGreaterThanOrEqual(5);
    expect([...text.matchAll(pathPattern)].length).toBeGreaterThanOrEqual(5);
  });
  // Formatting lives only in deploy/pgdata/setup.sh, whose refusals pgdata.test.ts proves.
  it('volume setup is setup.sh and the unlock unit, never a hand-run luksFormat or mkfs', () => {
    expect(read('deploy/README.md') + read('deploy/rotate.md')).not.toMatch(/luksFormat|mkfs/);
  });
  it.skipIf(spawnSync('bash', ['--version']).status !== 0)('all documented shell blocks pass bash -n without executing them', () => {
    for (const file of ['deploy/README.md', 'deploy/rotate.md']) {
      const blocks = [...read(file).matchAll(/```(?:sh|bash)\n([\s\S]*?)\n```/g)];
      expect(blocks.length).toBeGreaterThan(0);
      for (const [index, block] of blocks.entries()) {
        const result = spawnSync('bash', ['-n'], {input: block[1]!, encoding: 'utf8'});
        expect(result.error).toBeUndefined();
        expect(result.status, `${file} block ${index + 1}: ${result.stderr}`).toBe(0);
      }
    }
  });
});

type CommandVariable = {optional: boolean; refused: boolean};
function commandContract(heading: string): Map<string, CommandVariable> {
  const lines = read(environment).split('\n');
  const start = lines.findIndex(line => line === `### ${heading}`);
  expect(start, `missing command contract: ${heading}`).toBeGreaterThanOrEqual(0);
  const end = lines.findIndex((line, index) => index > start && /^#{1,3} /.test(line));
  const result = new Map<string, CommandVariable>();
  for (const line of lines.slice(start + 1, end < 0 ? undefined : end).filter(line => line.startsWith('| `'))) {
    const cells = line.split('|'), requirement = cells[2]!.trim();
    for (const match of cells[1]!.matchAll(/`([A-Z][A-Z0-9_]*)`/g)) {
      result.set(match[1]!, {optional: /^optional\b/i.test(requirement), refused: /^(?:refused\b|must be unset\b)/i.test(requirement)});
    }
  }
  expect(result.size).toBeGreaterThan(0);
  return result;
}

function scriptExample(name: string, headings: string[]): void {
  const expected = new Map<string, CommandVariable>();
  for (const heading of headings) for (const [name, rule] of commandContract(heading)) {
    const previous = expected.get(name);
    expected.set(name, {optional: rule.optional && (previous?.optional ?? true), refused: rule.refused || !!previous?.refused});
  }
  const rows = example(exampleFile(name));
  expect(rows.map(row => row.name).sort()).toEqual([...expected].filter(([, rule]) => !rule.refused).map(([name]) => name).sort());
  for (const row of rows) {
    expect(row.comment, row.name).toMatch(/^#.*\b(required|optional)\b/);
    expect(row.comment, row.name).toMatch(/\b(handle|path|literal|url)\b/i);
    if (!expected.get(row.name)?.optional) expect(row.active, row.name).toBe(true);
    if (row.active) expect(row.value, row.name).not.toBe('');
    expect(looksSecret(row.value), row.name).toBe(false);
  }
}

const schedules = [
  {name: 'backup', description: 'Daily Uai backup', calendar: '*-*-* 03:30:00 UTC', hour: 3, minute: 30},
  {name: 'restore-drill', description: 'Monthly Uai restore drill', calendar: 'Sun *-*-01..07 05:00:00 UTC', hour: 5, minute: 0},
] as const;
const drillHidden = '-/etc/unai/secrets -/etc/unai/pgdata -/etc/unai/backup/pgpass -/etc/unai/backup/aws-credentials '
  + '-/etc/unai/tls/ca/ca.key -/etc/unai/tls/api -/etc/unai/tls/web -/etc/unai/tls/postgres -/etc/letsencrypt';

describe('backup and restore drill deployment', () => {
  it('backup: contract-derived example and consistent evidence/archive settings', () => {
    scriptExample('backup', ['pnpm backup']);
    const value = (key: string) => activeValue('backup', key);
    expect(value('UNAI_BACKUP_DESTINATION')).toMatch(/^s3:\/\/.+\/$/);
    expect(example(exampleFile('backup')).find(row => row.name === 'UNAI_BACKUP_RETENTION_DAYS')?.active).toBe(false);
    const url = new URL(value('UNAI_BACKUP_DATABASE_URL'));
    expect([url.username, url.password, url.hostname, url.pathname]).toEqual(['unai_backup', '', '127.0.0.1', '/unai']);
    expect(unit(unitFile('backup')).get('Service')!.get('ReadWritePaths')).toEqual([value('UNAI_BACKUP_STAGING_DIR')]);
    for (const key of ['UNAI_S3_ENDPOINT', 'UNAI_S3_REGION', 'UNAI_S3_BUCKET', 'UNAI_S3_KMS_KEY_ID', 'UNAI_DATABASE_CA_FILE']) {
      expect(value(key), key).toBe(activeValue('api', key));
    }
  });

  it('restore-drill: contract-derived example excludes every refused row and agrees with backup', () => {
    scriptExample('restore-drill', ['pnpm restore:drill', 'pnpm restore']);
    const value = (key: string) => activeValue('restore-drill', key);
    for (const [restore, backup] of [
      ['UNAI_RESTORE_ARCHIVE', 'UNAI_BACKUP_DESTINATION'], ['UNAI_RESTORE_KEY_FILE', 'UNAI_BACKUP_KEY_FILE'],
      ['UNAI_RESTORE_ARCHIVE_S3_ENDPOINT', 'UNAI_BACKUP_S3_ENDPOINT'], ['UNAI_RESTORE_ARCHIVE_S3_REGION', 'UNAI_BACKUP_S3_REGION'],
    ] as const) expect(value(restore), restore).toBe(activeValue('backup', backup));
    for (const [restore, api] of [
      ['UNAI_RESTORE_S3_KMS_KEY_ID', 'UNAI_S3_KMS_KEY_ID'], ['UNAI_RESTORE_S3_ENDPOINT', 'UNAI_S3_ENDPOINT'],
      ['UNAI_RESTORE_S3_REGION', 'UNAI_S3_REGION'], ['UNAI_DATABASE_CA_FILE', 'UNAI_DATABASE_CA_FILE'],
    ] as const) expect(value(restore), restore).toBe(activeValue('api', api));
    expect(value('UNAI_RESTORE_S3_BUCKET')).toMatch(/-uai-restore-drill$/);
    expect(value('UNAI_RESTORE_S3_BUCKET')).not.toBe(activeValue('api', 'UNAI_S3_BUCKET'));
    const url = new URL(value('UNAI_RESTORE_DRILL_SERVER_URL'));
    expect([url.username, url.password, url.hostname, url.pathname]).toEqual(['unai_migrator', '', '127.0.0.1', '/unai']);
    expect(unit(unitFile('restore-drill')).get('Service')!.get('ReadWritePaths')).toEqual([value('UNAI_RESTORE_STAGING_DIR')]);
  });

  it('command contract matches headings exactly and preserves optional/refused markers', () => {
    expect(commandContract('pnpm restore').has('UNAI_RESTORE_DRILL_SERVER_URL')).toBe(false);
    expect(commandContract('pnpm restore:drill').get('UNAI_RESTORE_DATABASE_URL')?.refused).toBe(true);
    expect(commandContract('pnpm backup').get('UNAI_BACKUP_PG_DUMP')).toEqual({optional: true, refused: false});
    expect(commandContract('pnpm backup').get('PGPASSWORD')?.refused).toBe(true);
  });

  it('backup: exact least-privilege command, D11 stop/start ordering and bounded downtime', () => {
    expect(Object.fromEntries(unit(unitFile('backup')).get('Service')!)).toEqual({
      Type: ['oneshot'], User: ['unai-backup'], Group: ['unai-backup'], WorkingDirectory: ['/opt/unai/current'],
      EnvironmentFile: ['/etc/unai/backup.env'], Environment: ['PGPASSFILE=/etc/unai/backup/pgpass',
        'AWS_SHARED_CREDENTIALS_FILE=/etc/unai/backup/aws-credentials', 'AWS_EC2_METADATA_DISABLED=true'],
      ExecStartPre: ['+/usr/bin/systemctl stop unai-worker.service', '+/usr/bin/systemctl stop unai-api.service'],
      ExecStart: ['node scripts/backup.mjs'], ExecStopPost: ['-+/usr/bin/systemctl start unai-api.service', '-+/usr/bin/systemctl start unai-worker.service'],
      TimeoutStartSec: ['4h'], TimeoutStopSec: ['7min'], NoNewPrivileges: ['yes'], ProtectSystem: ['strict'],
      ProtectHome: ['yes'], PrivateTmp: ['yes'], ReadWritePaths: ['/var/lib/postgresql/unai-backup-staging'],
      CapabilityBoundingSet: [''], MemoryMax: ['1G'],
    });
  });

  it('restore-drill: exact sandboxed root command without keep or maintenance mode', () => {
    expect(Object.fromEntries(unit(unitFile('restore-drill')).get('Service')!)).toEqual({
      Type: ['oneshot'], WorkingDirectory: ['/opt/unai/current'], EnvironmentFile: ['/etc/unai/restore-drill.env'],
      Environment: ['PGPASSFILE=/etc/unai/restore-drill/pgpass', 'AWS_SHARED_CREDENTIALS_FILE=/etc/unai/restore-drill/aws-credentials',
        'AWS_EC2_METADATA_DISABLED=true'], ExecStart: ['node scripts/restore-drill.mjs'],
      TimeoutStartSec: ['6h'], TimeoutStopSec: ['10min'], NoNewPrivileges: ['yes'], ProtectSystem: ['strict'],
      ProtectHome: ['yes'], PrivateTmp: ['yes'], ReadWritePaths: ['/var/lib/postgresql/unai-restore-drill-staging'],
      InaccessiblePaths: [drillHidden], CapabilityBoundingSet: ['CAP_DAC_READ_SEARCH'], MemoryMax: ['2G'],
    });
  });

  const available = spawnSync('systemd-analyze', ['--version'], {encoding: 'utf8'}).status === 0;
  for (const {name, description, calendar, hour, minute} of schedules) {
    it(`${name}: exact sections, timer, environment contract and secret-free values`, () => {
      const service = unit(unitFile(name)), timer = unit(timerFile(name));
      expect([...service.keys()].sort()).toEqual(['Service', 'Unit']);
      expect(Object.fromEntries(service.get('Unit')!)).toEqual({Description: [name === 'backup' ? 'Uai backup' : 'Uai restore drill'],
        Wants: ['network-online.target'], After: ['network-online.target postgresql.service']});
      expect([...timer.keys()].sort()).toEqual(['Install', 'Timer', 'Unit']);
      expect(Object.fromEntries(timer.get('Unit')!)).toEqual({Description: [description]});
      expect(Object.fromEntries(timer.get('Timer')!)).toEqual({OnCalendar: [calendar], Persistent: ['true'],
        RandomizedDelaySec: ['10min'], FixedRandomDelay: ['true']});
      expect(Object.fromEntries(timer.get('Install')!)).toEqual({WantedBy: ['timers.target']});
      expect(existsSync(resolve(root, `scripts/${name}.mjs`))).toBe(true);
      for (const assignment of service.get('Service')!.get('Environment')!) {
        expect(read(environment)).toContain('`' + assignment.split('=')[0] + '`');
      }
      for (const parsed of [service, timer]) for (const section of parsed.values()) for (const [key, values] of section) {
        for (const value of values) {
          const candidates = key === 'InaccessiblePaths' ? value.split(' ').map(path => path.replace(/^-/, ''))
            : [key === 'Environment' ? value.slice(value.indexOf('=') + 1) : value];
          for (const candidate of candidates) expect(looksSecret(candidate), candidate).toBe(false);
        }
      }
    });

    it.skipIf(!available)(`${name}: ${available ? 'systemd-analyze verify pair' : 'skipped: systemd-analyze not installed'}`, () => {
      const temporary = mkdtempSync(join(tmpdir(), 'unai-timers-'));
      const basenames = [`unai-${name}.service`, `unai-${name}.timer`];
      try {
        for (const basename of basenames) writeFileSync(join(temporary, basename), read(`deploy/systemd/${basename}`)
          .replace(/^(ExecStart(?:Pre)?=)node\b/gm, `$1${process.execPath}`));
        const result = spawnSync('systemd-analyze', ['verify', ...basenames.map(file => join(temporary, file))], {encoding: 'utf8'});
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr.split('\n').filter(line => basenames.some(name => line.includes(name)))).toEqual([]);
      } finally { rmSync(temporary, {recursive: true, force: true}); }
    });

    it.skipIf(!available)(`${name}: ${available ? 'systemd-analyze calendar UTC schedule' : 'skipped: calendar not installed'}`, () => {
      const expression = unit(timerFile(name)).get('Timer')!.get('OnCalendar')![0]!;
      const result = spawnSync('systemd-analyze', ['calendar', '--iterations=6', expression], {encoding: 'utf8'});
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      const timestamps = [...result.stdout.matchAll(/(\w{3}) (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) UTC/g)];
      expect(new Set(timestamps.map(match => match[0])).size).toBeGreaterThanOrEqual(6);
      for (const match of timestamps) {
        const [, , year, month, day, h, m, s] = match;
        expect([Number(h), Number(m), Number(s)]).toEqual([hour, minute, 0]);
        if (name === 'restore-drill') {
          expect(Number(day)).toBeLessThanOrEqual(7);
          expect(new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))).getUTCDay()).toBe(0);
        }
      }
    });
  }
});
