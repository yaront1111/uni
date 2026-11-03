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
