import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { metrics, trace, SpanStatusCode } from '@opentelemetry/api';
import { parseDocument } from 'yaml';
import { lintContractDocuments, type LintIssue } from './lint.js';
import { manifestSchema, migrationManifestSchema, releaseIndexSchema, RELEASE_VERSION, type FrameContract, type MigrationManifest,
  type RegistryManifest, type TransitionContract } from './schema.js';

export class RegistryError extends Error {
  constructor(readonly code: string, readonly issues: readonly LintIssue[] = []) { super(code); this.name = 'RegistryError'; }
}

export interface LoadedRegistryRelease {
  readonly source: 'GIT_TAG' | 'CHECKOUT';
  readonly version: string;
  readonly tag: string;
  /** Null only for CI lint of an untagged checkout; runtime loads always pin a commit. */
  readonly gitCommit: string | null;
  readonly contentHash: string;
  readonly manifest: RegistryManifest;
  readonly files: readonly string[];
  readonly frames: readonly FrameContract[];
  readonly transitions: readonly TransitionContract[];
  /** `migration.yaml` of a release that migrates from an earlier one, else null.
   * Its bytes are part of the release content hash like every other file. */
  readonly migration: MigrationManifest | null;
  /** SHA-256 of the `migration.yaml` bytes, recorded on the published manifest row. */
  readonly migrationContentHash: string | null;
}

/** The one release file that is neither the manifest nor a contract. */
export const MIGRATION_FILE = 'migration.yaml';

interface ReleaseFile { path: string; bytes: Buffer }
interface ReleaseRecord { version: string; tag: string; contentHash: string }

export const RELEASE_INDEX_PATH = 'registry/releases.yaml';
export const RELEASES_DIRECTORY = 'registry/releases';
const MAX_FILE_BYTES = 1024 * 1024;
const FILE_NAME = /^[a-z0-9][a-z0-9_.-]*\.yaml$/;
const tracer = trace.getTracer('unai.registry', '0.1.0');
const operations = metrics.getMeter('unai.registry', '0.1.0').createCounter('unai.registry.operations');

/** SHA-256 over sorted `<path>\n<sha256(bytes)>\n` lines for every release file. */
export function releaseContentHash(files: readonly ReleaseFile[]): string {
  const hash = createHash('sha256');
  for (const file of [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    hash.update(file.path + '\n' + createHash('sha256').update(file.bytes).digest('hex') + '\n');
  }
  return hash.digest('hex');
}

function yaml(bytes: Buffer): unknown {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const document = parseDocument(text, { uniqueKeys: true, prettyErrors: false });
  if (document.errors.length || document.warnings.length) throw new Error('YAML_INVALID');
  return document.toJS({ maxAliasCount: 0 });
}

async function regularFile(path: string): Promise<Buffer> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new RegistryError('REGISTRY_FILE_INVALID');
  return readFile(path);
}

async function recordFor(repository: string, version: string): Promise<ReleaseRecord> {
  if (!RELEASE_VERSION.test(version)) throw new RegistryError('REGISTRY_VERSION_INVALID');
  const index = await readReleaseIndex(repository);
  const record = index.find(entry => entry.version === version);
  if (!record) throw new RegistryError('REGISTRY_RELEASE_NOT_RECORDED');
  return record;
}

/** The recorded version → tag → content hash pins, read from the deployer's checkout. */
export async function readReleaseIndex(repository: string): Promise<ReleaseRecord[]> {
  let raw: unknown;
  try { raw = yaml(await regularFile(resolve(repository, RELEASE_INDEX_PATH))); }
  catch { throw new RegistryError('REGISTRY_INDEX_INVALID'); }
  const parsed = releaseIndexSchema.safeParse(raw);
  if (!parsed.success) throw new RegistryError('REGISTRY_INDEX_INVALID');
  const releases = parsed.data.releases;
  if (new Set(releases.map(entry => entry.version)).size !== releases.length
    || releases.some(entry => entry.tag !== 'registry-v' + entry.version)) throw new RegistryError('REGISTRY_INDEX_INVALID');
  return releases;
}

function assemble(record: ReleaseRecord, files: ReleaseFile[], source: LoadedRegistryRelease['source'], gitCommit: string | null): LoadedRegistryRelease {
  if (files.length === 0) throw new RegistryError('REGISTRY_RELEASE_MISSING');
  if (files.some(file => !FILE_NAME.test(file.path) || file.bytes.length > MAX_FILE_BYTES)) throw new RegistryError('REGISTRY_FILE_INVALID');
  if (releaseContentHash(files) !== record.contentHash) throw new RegistryError('REGISTRY_CONTENT_HASH_MISMATCH');
  const manifestFile = files.find(file => file.path === 'manifest.yaml');
  let manifest: RegistryManifest;
  try { manifest = manifestSchema.parse(yaml(manifestFile!.bytes)); }
  catch { throw new RegistryError('REGISTRY_MANIFEST_INVALID'); }
  const listed = manifest.contracts.map(entry => entry.file);
  const migrationFile = files.find(file => file.path === MIGRATION_FILE);
  const contractFiles = files.filter(file => file !== manifestFile && file !== migrationFile);
  if (manifest.version !== record.version || new Set(listed).size !== listed.length
    || new Set(manifest.contracts.map(entry => entry.id)).size !== listed.length
    || contractFiles.length !== listed.length || contractFiles.some(file => !listed.includes(file.path))) {
    throw new RegistryError('REGISTRY_MANIFEST_INVALID');
  }
  const issues: LintIssue[] = [];
  const documents = manifest.contracts.flatMap(entry => {
    const file = contractFiles.find(candidate => candidate.path === entry.file)!;
    let document: unknown;
    try { document = yaml(file.bytes); }
    catch { issues.push({ code: 'REGISTRY_YAML_INVALID', contract: entry.file, path: '' }); return []; }
    const declared = document && typeof document === 'object' ? document as { id?: unknown; kind?: unknown } : {};
    if (declared.id !== entry.id || declared.kind !== entry.kind) issues.push({ code: 'REGISTRY_MANIFEST_MISMATCH', contract: entry.file, path: 'id' });
    return [{ file: entry.file, document }];
  });
  const result = lintContractDocuments(documents, record.version);
  issues.push(...result.issues);
  let migration: MigrationManifest | null = null;
  if (migrationFile) {
    let document: unknown;
    try { document = yaml(migrationFile.bytes); }
    catch { document = null; }
    const parsed = migrationManifestSchema.safeParse(document);
    if (!parsed.success) issues.push({ code: 'REGISTRY_MIGRATION_MANIFEST_INVALID', contract: MIGRATION_FILE, path: '' });
    else if (parsed.data.to !== record.version || parsed.data.from === record.version) {
      issues.push({ code: 'REGISTRY_MIGRATION_MANIFEST_INVALID', contract: MIGRATION_FILE, path: parsed.data.to !== record.version ? 'to' : 'from' });
    } else migration = parsed.data;
  }
  if (issues.length) throw new RegistryError('REGISTRY_LINT_FAILED', issues);
  return Object.freeze({
    source, version: record.version, tag: record.tag, gitCommit, contentHash: record.contentHash, manifest,
    files: Object.freeze(files.map(file => file.path).sort()), frames: Object.freeze(result.frames), transitions: Object.freeze(result.transitions),
    migration, migrationContentHash: migrationFile ? createHash('sha256').update(migrationFile.bytes).digest('hex') : null,
  });
}

async function observed<T extends LoadedRegistryRelease>(operation: string, version: string, work: () => Promise<T>): Promise<T> {
  return tracer.startActiveSpan('registry.' + operation, async span => {
    span.setAttributes({ 'unai.registry.version': version, 'unai.code_version': '0.1.0' });
    try {
      const release = await work();
      span.setAttributes({ 'unai.result': 'SUCCESS', 'unai.registry.content_hash': release.contentHash, 'unai.registry.source': release.source });
      if (release.gitCommit) span.setAttribute('unai.registry.git_commit', release.gitCommit);
      operations.add(1, { operation, result: 'SUCCESS' });
      return release;
    } catch (error) {
      const code = error instanceof RegistryError ? error.code : 'REGISTRY_LOAD_FAILED';
      span.setAttributes({ 'unai.result': 'REFUSED', 'unai.error_code': code });
      span.setStatus({ code: SpanStatusCode.ERROR });
      operations.add(1, { operation, result: 'REFUSED', code });
      throw error instanceof RegistryError ? error : new RegistryError(code);
    } finally { span.end(); }
  });
}

function git(repository: string, args: string[]): Buffer | null {
  const result = spawnSync('git', ['-c', 'core.quotepath=off', ...args], {
    cwd: repository, maxBuffer: 64 * 1024 * 1024, timeout: 30000, shell: false,
    // Replacement refs and prompts must not alter or block reads of the tagged objects.
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0' },
  });
  return result.status === 0 && !result.error ? result.stdout : null;
}

/** Runtime loader: reads the recorded release from Git objects at its immutable tag. */
export function loadRegistryRelease(options: { repository: string; version: string }): Promise<LoadedRegistryRelease> {
  return observed('load', options.version, async () => {
    const repository = resolve(options.repository);
    const record = await recordFor(repository, options.version);
    const commit = git(repository, ['rev-parse', '--verify', '--quiet', 'refs/tags/' + record.tag + '^{commit}'])?.toString('utf8').trim();
    if (!commit || !/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw new RegistryError('REGISTRY_TAG_MISSING');
    const prefix = RELEASES_DIRECTORY + '/' + record.version + '/';
    const listing = git(repository, ['ls-tree', '-r', '-z', '--full-tree', commit, '--', prefix]);
    if (!listing) throw new RegistryError('REGISTRY_RELEASE_MISSING');
    const files: ReleaseFile[] = [];
    for (const entry of listing.toString('utf8').split('\0').filter(Boolean)) {
      const match = /^(\d{6}) (\w+) ([a-f0-9]+)\t(.+)$/s.exec(entry);
      const path = match?.[4]?.slice(prefix.length) ?? '';
      if (!match || match[1] !== '100644' || match[2] !== 'blob' || !match[4]!.startsWith(prefix) || path.includes('/')) {
        throw new RegistryError('REGISTRY_FILE_INVALID');
      }
      const bytes = git(repository, ['cat-file', 'blob', match[3]!]);
      if (!bytes) throw new RegistryError('REGISTRY_FILE_INVALID');
      files.push({ path, bytes });
    }
    return assemble(record, files, 'GIT_TAG', commit);
  });
}

/** The migration evidence a tagged release names, read from the same immutable
 * commit as the release itself, never from the working tree. Returns the slot
 * and proposition diff summary and the shadow run id, or null when the release
 * carries no migration manifest. */
export function readTaggedMigrationEvidence(repository: string, release: LoadedRegistryRelease)
  : { slotAndPropositionDiff: Record<string, unknown>; shadowRunId: string | null } | null {
  if (!release.migration) return null;
  if (release.source !== 'GIT_TAG' || !release.gitCommit) throw new RegistryError('REGISTRY_TAG_SOURCE_REQUIRED');
  const path = release.migration.shadowDiff;
  const bytes = path ? git(resolve(repository), ['cat-file', 'blob', release.gitCommit + ':' + path]) : null;
  let report: { runId?: unknown; diffs?: { slotCollision?: { compared?: unknown; changed?: unknown }; proposition?: { compared?: unknown; changed?: unknown } } } = {};
  try { report = bytes ? JSON.parse(bytes.toString('utf8')) : {}; } catch { report = {}; }
  const counts = (diff?: { compared?: unknown; changed?: unknown }) =>
    diff && Number.isInteger(diff.compared) && Number.isInteger(diff.changed) ? { compared: diff.compared, changed: diff.changed } : null;
  return {
    slotAndPropositionDiff: { shadowDiff: path ?? null, slotCollision: counts(report.diffs?.slotCollision), proposition: counts(report.diffs?.proposition) },
    shadowRunId: typeof report.runId === 'string' && /^[0-9a-f-]{36}$/.test(report.runId) ? report.runId : null,
  };
}

/** CI lint of the working-tree release against its recorded hash; never a runtime source. */
export function lintRegistryCheckout(options: { repository: string; version: string }): Promise<LoadedRegistryRelease> {
  return observed('lint', options.version, async () => {
    const repository = resolve(options.repository);
    const record = await recordFor(repository, options.version);
    const directory = resolve(repository, RELEASES_DIRECTORY, record.version);
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch { throw new RegistryError('REGISTRY_RELEASE_MISSING'); }
    const files: ReleaseFile[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) throw new RegistryError('REGISTRY_FILE_INVALID');
      files.push({ path: entry.name, bytes: await regularFile(resolve(directory, entry.name)) });
    }
    return assemble(record, files, 'CHECKOUT', null);
  });
}

/** Lints every recorded release and refuses unrecorded release directories. */
export async function lintRegistryRepository(repository: string): Promise<LoadedRegistryRelease[]> {
  const index = await readReleaseIndex(repository);
  let directories: string[] = [];
  try { directories = (await readdir(resolve(repository, RELEASES_DIRECTORY), { withFileTypes: true })).map(entry => entry.name); }
  catch { throw new RegistryError('REGISTRY_RELEASE_MISSING'); }
  if (directories.some(name => !index.some(entry => entry.version === name))) throw new RegistryError('REGISTRY_RELEASE_NOT_RECORDED');
  if (index.length === 0) throw new RegistryError('REGISTRY_RELEASE_MISSING');
  const releases: LoadedRegistryRelease[] = [];
  for (const entry of index) releases.push(await lintRegistryCheckout({ repository, version: entry.version }));
  return releases;
}
