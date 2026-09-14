import { afterEach, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import * as registry from './index.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true }))); });
// Synthetic contract is test data, never a released canonical contract.
const fixture = {
  id: 'test.obligation', version: '0.1.0', description: 'Synthetic monetary obligation',
  contextPolicy: ['BASE'], identityStrategy: 'SURROGATE', identityAnchors: ['external_reference'],
  roles: [{ id: 'debtor', valueType: 'ENTITY' }],
  predicates: [{ id: 'test.amount', valueType: 'MONEY', cardinality: 'FUNCTIONAL', normalization: 'currency_minor_units',
    allowedModalities: ['ACTUAL'], slotQualifiers: [], temporalBehavior: 'valid_time', conflictBehavior: 'contest',
    supersessionBehavior: 'retain_history', sourceAuthorityPolicy: 'fixture_only', projectionConsumers: ['test.obligations'] }],
  allowedModalities: ['ACTUAL'], slotQualifiers: [], authorityRules: ['fixture_only'], mergePolicy: 'explicit',
  splitPolicy: 'explicit', transitionContracts: [], projectionConsumers: ['test.obligations'],
  invariants: ['surrogate_identity'], acceptanceTests: ['test.unfiltered-owner-isolation'],
};

function loader() {
  const load = (registry as Record<string, unknown>).loadRegistryRelease;
  expect(load, 'registry loader must exist').toBeTypeOf('function');
  return load as typeof import('./index.js').loadRegistryRelease;
}
async function release(contract: unknown = fixture, filename = 'contract.yaml') {
  const directory = await mkdtemp(join(tmpdir(), 'unai-registry-'));
  directories.push(directory);
  const bytes = JSON.stringify(contract); // JSON is also valid YAML.
  await writeFile(join(directory, 'contract.yaml'), bytes);
  const manifest = { version: '0.1.0', contracts: [{ id: 'test.obligation', file: filename,
    sha256: createHash('sha256').update(bytes).digest('hex') }] };
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  return directory;
}

it('loads a content-pinned structurally complete release', async () => {
  const result = await loader()(await release());
  expect(result.version).toBe('0.1.0');
  expect(result.contracts[0]?.id).toBe('test.obligation');
});
it('rejects content changes under the same manifest digest', async () => {
  const directory = await release();
  await writeFile(join(directory, 'contract.yaml'), 'id: forged');
  await expect(loader()(directory)).rejects.toThrow('REGISTRY_DIGEST_MISMATCH');
});
it('rejects paths outside the release', async () => {
  await expect(loader()(await release(fixture, '../contract.yaml'))).rejects.toThrow('REGISTRY_MANIFEST_INVALID');
});
it('rejects unknown modalities and missing invariant definitions', async () => {
  await expect(loader()(await release({ ...fixture, allowedModalities: ['HAPPENED'] }))).rejects.toThrow('REGISTRY_CONTRACT_INVALID');
  await expect(loader()(await release({ ...fixture, invariants: [] }))).rejects.toThrow('REGISTRY_CONTRACT_INVALID');
});
it('rejects duplicate predicate IDs', async () => {
  await expect(loader()(await release({ ...fixture, predicates: [fixture.predicates[0], fixture.predicates[0]] }))).rejects.toThrow('REGISTRY_CONTRACT_INVALID');
});
it('rejects an absent production release', async () => {
  await expect(loader()('registry/nonexistent-release')).rejects.toThrow('REGISTRY_RELEASE_MISSING');
});
