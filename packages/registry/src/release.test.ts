import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as registry from './index.js';

const REQUIRED_FRAMES = ['finance.payment_allocation', 'shared.commitment', 'shared.event_occurrence', 'shared.obligation'];
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

function git(repository: string, ...args: string[]) {
  const result = spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=Registry Test', '-c', 'user.email=registry@test.invalid', ...args],
    { cwd: repository, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

/** A real Git repository holding the genuine checked-in release bytes. */
async function taggedRepository() {
  const repository = await mkdtemp(join(tmpdir(), 'unai-registry-git-'));
  directories.push(repository);
  await cp(resolve('registry'), join(repository, 'registry'), { recursive: true });
  git(repository, 'init', '--quiet');
  git(repository, 'add', 'registry');
  git(repository, 'commit', '--quiet', '-m', 'registry release 0.1.0');
  git(repository, 'tag', 'registry-v0.1.0');
  return { repository, commit: git(repository, 'rev-parse', 'HEAD') };
}

describe('genuine release 0.1.0 checked into Git', () => {
  it('is recorded with its tag and content hash and passes lint from the checkout', async () => {
    const release = await registry.lintRegistryCheckout({ repository: resolve('.'), version: '0.1.0' });
    expect(release.version).toBe('0.1.0');
    expect(release.tag).toBe('registry-v0.1.0');
    expect(release.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(release.frames.map(frame => frame.id).sort()).toEqual(REQUIRED_FRAMES);
    expect(release.transitions.length).toBeGreaterThan(0);
  });

  it('contains YAML contract files only, pinned by a manifest', async () => {
    const release = await registry.lintRegistryCheckout({ repository: resolve('.'), version: '0.1.0' });
    expect(release.files.every(file => file.endsWith('.yaml'))).toBe(true);
    expect(release.files).toContain('manifest.yaml');
  });

  it('applies the recorded registry review: obligation description is SET, principal FUNCTIONAL', async () => {
    const release = await registry.lintRegistryCheckout({ repository: resolve('.'), version: '0.1.0' });
    const obligation = release.frames.find(frame => frame.id === 'shared.obligation')!;
    const cardinality = (id: string) => obligation.predicates.find(predicate => predicate.id === id)?.cardinality;
    expect(cardinality('shared.obligation.description')).toBe('SET');
    expect(cardinality('shared.obligation.principal_amount')).toBe('FUNCTIONAL');
  });

  it('defines no outcome status predicate', async () => {
    const release = await registry.lintRegistryCheckout({ repository: resolve('.'), version: '0.1.0' });
    for (const frame of release.frames) for (const predicate of frame.predicates) {
      expect(registry.isOutcomeStatusPredicate(predicate), predicate.id).toBe(false);
    }
  });

  it('accepts only monetary principal values for shared.obligation', async () => {
    const release = await registry.lintRegistryCheckout({ repository: resolve('.'), version: '0.1.0' });
    const principal = 'shared.obligation.principal_amount';
    expect(registry.validatePredicateValue(release, principal, { amount: '50', currency: 'ILS' })).toEqual({ amount: '50', currency: 'ILS' });
    expect(registry.validatePredicateValue(release, principal, { amount: '12.50', currency: 'USD' })).toEqual({ amount: '12.50', currency: 'USD' });
    for (const value of ['return the book', 50, { amount: 50, currency: 'ILS' }, { amount: '50' }, { amount: '50', currency: 'ils' },
      { amount: '0', currency: 'ILS' }, { amount: '-5', currency: 'ILS' }, { item: 'book' }, { amount: '50', currency: 'ILS', note: 'x' }, null]) {
      expect(() => registry.validatePredicateValue(release, principal, value), JSON.stringify(value)).toThrow('REGISTRY_VALUE_INVALID');
    }
    expect(() => registry.validatePredicateValue(release, 'shared.obligation.status', 'OPEN')).toThrow('REGISTRY_PREDICATE_UNKNOWN');
  });

  it('refuses a checkout whose release bytes differ from the recorded hash', async () => {
    const { repository } = await taggedRepository();
    const file = join(repository, 'registry/releases/0.1.0/shared.obligation.yaml');
    await writeFile(file, (await readFile(file, 'utf8')).replace('cardinality: FUNCTIONAL', 'cardinality: SET'));
    await expect(registry.lintRegistryCheckout({ repository, version: '0.1.0' })).rejects.toThrow('REGISTRY_CONTENT_HASH_MISMATCH');
  });
});

describe('loading by immutable Git tag', () => {
  it('loads the genuine release from its tag and records the commit', async () => {
    const { repository, commit } = await taggedRepository();
    const release = await registry.loadRegistryRelease({ repository, version: '0.1.0' });
    expect(release).toMatchObject({ version: '0.1.0', tag: 'registry-v0.1.0', gitCommit: commit, source: 'GIT_TAG' });
    const checkout = await registry.lintRegistryCheckout({ repository: resolve('.'), version: '0.1.0' });
    expect(release.contentHash).toBe(checkout.contentHash);
    expect(release.frames.map(frame => frame.id).sort()).toEqual(REQUIRED_FRAMES);
  });

  it('reads Git objects at the tag, not the working tree', async () => {
    const { repository } = await taggedRepository();
    await writeFile(join(repository, 'registry/releases/0.1.0/shared.obligation.yaml'), 'id: forged');
    const release = await registry.loadRegistryRelease({ repository, version: '0.1.0' });
    expect(release.frames.find(frame => frame.id === 'shared.obligation')).toBeDefined();
  });

  it('refuses a tag whose content hash differs from the recorded hash for that version', async () => {
    const { repository } = await taggedRepository();
    git(repository, 'tag', '-d', 'registry-v0.1.0');
    const file = join(repository, 'registry/releases/0.1.0/shared.commitment.yaml');
    const original = await readFile(file, 'utf8');
    await writeFile(file, original.replace('Represents', 'Records'));
    git(repository, 'commit', '--quiet', '-am', 'edit released contract');
    git(repository, 'tag', 'registry-v0.1.0');
    await writeFile(file, original); // The deployer's recorded index remains unchanged.
    await expect(registry.loadRegistryRelease({ repository, version: '0.1.0' })).rejects.toThrow('REGISTRY_CONTENT_HASH_MISMATCH');
  });

  it('refuses a tag that adds an unlisted file even when listed files are unchanged', async () => {
    const { repository } = await taggedRepository();
    git(repository, 'tag', '-d', 'registry-v0.1.0');
    await writeFile(join(repository, 'registry/releases/0.1.0/extra.yaml'), 'kind: FRAME\n');
    git(repository, 'add', 'registry');
    git(repository, 'commit', '--quiet', '-m', 'add file');
    git(repository, 'tag', 'registry-v0.1.0');
    await expect(registry.loadRegistryRelease({ repository, version: '0.1.0' })).rejects.toThrow('REGISTRY_CONTENT_HASH_MISMATCH');
  });

  it('refuses a missing tag, an unrecorded version and an invalid version', async () => {
    const { repository } = await taggedRepository();
    git(repository, 'tag', '-d', 'registry-v0.1.0');
    await expect(registry.loadRegistryRelease({ repository, version: '0.1.0' })).rejects.toThrow('REGISTRY_TAG_MISSING');
    await expect(registry.loadRegistryRelease({ repository, version: '0.4.0' })).rejects.toThrow('REGISTRY_RELEASE_NOT_RECORDED');
    await expect(registry.loadRegistryRelease({ repository, version: '0.1.0; rm -rf /' })).rejects.toThrow('REGISTRY_VERSION_INVALID');
  });

  it('refuses a recorded hash edited in the index', async () => {
    const { repository } = await taggedRepository();
    const index = join(repository, 'registry/releases.yaml');
    await writeFile(index, (await readFile(index, 'utf8')).replace(/contentHash: [a-f0-9]{64}/, 'contentHash: ' + 'a'.repeat(64)));
    await expect(registry.loadRegistryRelease({ repository, version: '0.1.0' })).rejects.toThrow('REGISTRY_CONTENT_HASH_MISMATCH');
  });
});

describe('content hash', () => {
  it('is order-independent over paths and sensitive to bytes and names', () => {
    const a = { path: 'a.yaml', bytes: Buffer.from('x') }, b = { path: 'b.yaml', bytes: Buffer.from('y') };
    const hash = registry.releaseContentHash([a, b]);
    expect(registry.releaseContentHash([b, a])).toBe(hash);
    expect(registry.releaseContentHash([a, { ...b, bytes: Buffer.from('z') }])).not.toBe(hash);
    expect(registry.releaseContentHash([a, { ...b, path: 'c.yaml' }])).not.toBe(hash);
  });
});

/** Release 0.2.0 (ADR 0029): a complete set carrying every 0.1.0 contract unchanged
 * but for its version, plus the decision frame and its two transitions. */
describe('genuine release 0.2.0 checked into Git', () => {
  it('adds shared.decision and its transitions and leaves release 0.1.0 as recorded', async () => {
    const previous = await registry.lintRegistryCheckout({ repository: resolve('.'), version: '0.1.0' });
    const release = await registry.lintRegistryCheckout({ repository: resolve('.'), version: '0.2.0' });
    expect(release).toMatchObject({ version: '0.2.0', tag: 'registry-v0.2.0' });
    expect(release.contentHash).not.toBe(previous.contentHash);
    expect(release.frames.map(frame => frame.id).sort()).toEqual([...REQUIRED_FRAMES, 'shared.decision'].sort());
    // Every earlier contract is carried whole: only its version moved.
    for (const frame of previous.frames) {
      expect({ ...release.frames.find(candidate => candidate.id === frame.id), version: '0.1.0' }, frame.id).toEqual(frame);
    }
    for (const transition of previous.transitions) {
      expect({ ...release.transitions.find(candidate => candidate.id === transition.id), version: '0.1.0' }, transition.id).toEqual(transition);
    }
    expect(release.transitions.map(transition => transition.id).sort()).toEqual([...previous.transitions.map(transition => transition.id),
      'shared.decision.prediction_review', 'shared.decision.realization'].sort());
  });

  it('reviews a PREDICTED expected result as CONFIRMED, REFUTED or PARTIALLY_CONFIRMED and states no outcome status', async () => {
    const release = await registry.lintRegistryCheckout({ repository: resolve('.'), version: '0.2.0' });
    const decision = release.frames.find(frame => frame.id === 'shared.decision')!;
    const predicate = (id: string) => decision.predicates.find(candidate => candidate.id === 'shared.decision.' + id)!;
    expect(predicate('expected_result').allowedModalities).toEqual(['PREDICTED']);
    expect(predicate('observed_result').allowedModalities).toEqual(['ACTUAL']);
    expect(predicate('recommendation').allowedModalities).toEqual(['RECOMMENDED']);
    expect(predicate('option').cardinality).toBe('SET');
    expect(predicate('assumption').cardinality).toBe('SET');
    for (const each of decision.predicates) expect(registry.isOutcomeStatusPredicate(each), each.id).toBe(false);
    const review = release.transitions.find(transition => transition.id === 'shared.decision.prediction_review')!;
    expect(review).toMatchObject({ linkKind: 'RESOLVES', sourceFrameTypes: ['shared.decision'], targetRequired: false,
      allowedOutcomes: ['CONFIRMED', 'REFUTED', 'PARTIALLY_CONFIRMED'] });
    const realization = release.transitions.find(transition => transition.id === 'shared.decision.realization')!;
    expect(realization).toMatchObject({ linkKind: 'REALIZES', targetRequired: true, allowedOutcomes: [] });
    expect(decision.transitionContracts).toEqual(['shared.decision.prediction_review', 'shared.decision.realization']);
  });
});
