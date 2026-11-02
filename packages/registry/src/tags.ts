import { resolve } from 'node:path';
import { RegistryError, RELEASES_DIRECTORY, git, readCommittedReleaseFiles, readReleaseIndex, releaseContentHash } from './release.js';

/** PRESENT: the tag's commit holds bytes that hash to the recorded value (what
 * publish verifies). MISSING: no such tag. MISMATCH: the tag names something else. */
export type ReleaseTagStatus = 'PRESENT' | 'MISSING' | 'MISMATCH';

export interface ReleaseTagReport {
  version: string;
  tag: string;
  status: ReleaseTagStatus;
  /** The commit the tag peels to, or null when there is no tag or it names no commit. */
  taggedCommit: string | null;
  /** The newest commit that changed the release directory to the recorded bytes. */
  matchingCommit: string | null;
  /** The `git tag -a` command to run, printed and never executed; null when PRESENT or nothing matches. */
  command: string | null;
}

const COMMIT = /^([a-f0-9]{40}|[a-f0-9]{64})$/;
const NO_MATCH = 'no commit holds the recorded content hash';

const output = (repository: string, args: string[]) => git(repository, args)?.toString('utf8').trim() ?? null;

function holdsRecordedBytes(repository: string, commit: string, version: string, contentHash: string): boolean {
  try {
    const files = readCommittedReleaseFiles(repository, commit, version);
    return files.length > 0 && releaseContentHash(files) === contentHash;
  } catch (error) {
    if (error instanceof RegistryError) return false;
    throw error;
  }
}

/** Newest first, over only the commits that changed the directory, so the answer
 * stays the release's own commit as HEAD moves on. */
function newestMatchingCommit(repository: string, version: string, contentHash: string): string | null {
  const log = output(repository, ['log', '--format=%H', '--', RELEASES_DIRECTORY + '/' + version + '/']) ?? '';
  const candidates = log.split('\n').map(line => line.trim()).filter(line => COMMIT.test(line));
  return candidates.find(commit => holdsRecordedBytes(repository, commit, version, contentHash)) ?? null;
}

/** Read-only: runs only rev-parse, log, ls-tree and cat-file, never a Git write. */
export async function inspectReleaseTags(repository: string): Promise<ReleaseTagReport[]> {
  const root = resolve(repository);
  if (output(root, ['rev-parse', '--git-dir']) === null) throw new RegistryError('REGISTRY_GIT_UNAVAILABLE');
  // A shallow clone would suggest its own tip instead of the release's commit.
  if (output(root, ['rev-parse', '--is-shallow-repository']) === 'true') throw new RegistryError('REGISTRY_HISTORY_SHALLOW');
  const records = await readReleaseIndex(root);
  return records.map(record => {
    const ref = 'refs/tags/' + record.tag;
    const matchingCommit = newestMatchingCommit(root, record.version, record.contentHash);
    let status: ReleaseTagStatus = 'MISSING';
    let taggedCommit: string | null = null;
    if (output(root, ['rev-parse', '--verify', '--quiet', ref]) !== null) {
      const peeled = output(root, ['rev-parse', '--verify', '--quiet', ref + '^{commit}']);
      taggedCommit = peeled && COMMIT.test(peeled) ? peeled : null;
      status = taggedCommit && holdsRecordedBytes(root, taggedCommit, record.version, record.contentHash) ? 'PRESENT' : 'MISMATCH';
    }
    const command = status === 'PRESENT' || !matchingCommit ? null
      : `git tag -a ${status === 'MISMATCH' ? '-f ' : ''}${record.tag} ${matchingCommit} -m "registry ${record.version}"`;
    return { version: record.version, tag: record.tag, status, taggedCommit, matchingCommit, command };
  });
}

/** One line per version, then by-name push lines (never `--tags`, which would push
 * every other local tag too). A MISMATCH tag gets only its own forced line: if
 * origin holds the wrong tag, a plain push of it is rejected, and since a push is
 * not atomic a combined line would push the others and still fail. */
export function formatReleaseTagReport(reports: readonly ReleaseTagReport[]): string[] {
  const lines = reports.map(report => report.status === 'PRESENT'
    ? `${report.tag} PRESENT ${report.taggedCommit}`
    : `${report.tag} ${report.status} ${report.command ?? NO_MATCH}`);
  const missing = reports.filter(report => report.status === 'MISSING' && report.command);
  if (missing.length) lines.push('git push origin ' + missing.map(report => 'refs/tags/' + report.tag).join(' '));
  for (const report of reports) {
    if (report.status === 'MISMATCH' && report.command) lines.push('git push --force origin refs/tags/' + report.tag);
  }
  return lines;
}
