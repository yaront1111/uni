/** Bind test evidence to the source state, not just HEAD. Each sorted path adds
 * path + NUL, then: a file's SHA-256 hex (legacy-compatible), SYMLINK: plus the
 * SHA-256 of link text, DIRECTORY, SPECIAL, or DELETED. Never traverse links.
 *
 * Untracked agent tooling is explicitly excluded: agents rewrite memories, usage
 * logs and skill links during tests (17 EISDIR failures and digest churn measured
 * in comment-0afc8efc). Tracked paths are always included. Moe's own state
 * (.moe/, .moe-next/, store.sqlite*) remains excluded by .git/info/exclude.
 */
import {spawnSync} from 'node:child_process';
import {constants} from 'node:fs';
import {lstat, readFile, readlink} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';

export const AGENT_TOOLING_PATHS = Object.freeze(['.claude/', '.codex/', '.mcp.json', '.serena/', 'logs/']);
const sha256 = content => createHash('sha256').update(content).digest('hex');
// Refuse a link swapped in after lstat on platforms supporting O_NOFOLLOW;
// O_NONBLOCK also prevents a racing FIFO replacement from hanging the harness.
const readFlags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const isAgentTooling = path => AGENT_TOOLING_PATHS.some(prefix =>
  path === prefix.replace(/\/$/, '') || path.startsWith(prefix.endsWith('/') ? prefix : prefix + '/'));

async function descriptor(root, path) {
  const absolute = resolve(root, path);
  try {
    const entry = await lstat(absolute);
    if (entry.isSymbolicLink()) return 'SYMLINK:' + sha256(await readlink(absolute, {encoding: 'buffer'}));
    if (entry.isDirectory()) return 'DIRECTORY';
    if (entry.isFile()) return sha256(await readFile(absolute, {flag: readFlags}));
    return 'SPECIAL';
  } catch (error) {
    if (error.code === 'ENOENT') return 'DELETED';
    if (error.code === 'EISDIR') return 'DIRECTORY';
    throw new Error('WORKSPACE_EVIDENCE_UNREADABLE ' + path);
  }
}

export async function workspaceEvidence(root = process.cwd()) {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'});
  const options = {cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024};
  const tracked = spawnSync('git', ['ls-files', '--cached', '-z'], options);
  const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], options);
  if (head.status !== 0 || tracked.status !== 0 || untracked.status !== 0)
    throw new Error('WORKSPACE_EVIDENCE_UNAVAILABLE');
  const paths = [...tracked.stdout.split('\0'), ...untracked.stdout.split('\0').filter(path => !isAgentTooling(path))];
  const hash = createHash('sha256');
  for (const path of [...new Set(paths.filter(Boolean))].sort()) {
    hash.update(path + '\0');
    hash.update(await descriptor(root, path));
  }
  return {sourceCommit: head.stdout.trim(), workspaceDigest: hash.digest('hex'), workspaceExcludes: [...AGENT_TOOLING_PATHS]};
}
