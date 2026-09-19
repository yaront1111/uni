import { beforeAll, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { classifyRegistryChange, lintContractDocuments, lintRegistryCheckout } from './index.js';
import type { FrameContract } from './schema.js';

type Document = Record<string, unknown> & { predicates?: Record<string, unknown>[] };
let genuine: { file: string; document: Document }[];
beforeAll(async () => {
  const directory = resolve('registry/releases/0.2.0');
  genuine = await Promise.all((await readdir(directory)).filter(file => file !== 'manifest.yaml').sort()
    .map(async file => ({ file, document: parse(await readFile(resolve(directory, file), 'utf8')) as Document })));
});
const policy = () => ({ policyId: 'aging.shared.obligation.principal_amount', policyVersion: '0.2.0', kind: 'UNRESOLVED',
  frameTypeId: 'shared.obligation', predicateId: 'shared.obligation.principal_amount', reviewAfterDays: 30,
  verificationTrigger: 'WHEN_RELEVANT', explanation: 'Elapsed time calls for review; it never settles an unpaid obligation.' });
function withPolicy(change?: (value: Record<string, unknown>) => void) {
  const copy = structuredClone(genuine);
  const frame = copy.find(entry => entry.document.id === 'shared.obligation')!;
  const predicate = frame.document.predicates!.find(entry => entry.id === 'shared.obligation.principal_amount')!;
  const value = policy(); change?.(value); predicate.agingPolicy = value;
  return lintContractDocuments(copy, '0.2.0');
}

it('accepts explicit contextual policy metadata while old releases require no fabricated policy', () => {
  expect(lintContractDocuments(genuine, '0.2.0').issues).toEqual([]);
  expect(withPolicy().issues).toEqual([]);
  expect(withPolicy().frames.find(frame => frame.id === 'shared.obligation')!.predicates
    .find(predicate => predicate.id === policy().predicateId)).toHaveProperty('agingPolicy', policy());
});

it.each(['frameTypeId', 'predicateId'])('rejects a policy assigned to a different %s', field => {
  expect(withPolicy(value => { value[field] = 'shared.commitment.action'; }).issues)
    .toContainEqual(expect.objectContaining({ code: 'REGISTRY_AGING_APPLICABILITY_MISMATCH' }));
});

it('requires policy version to match its immutable release and coherent review semantics', () => {
  expect(withPolicy(value => { value.policyVersion = '0.3.0'; }).issues)
    .toContainEqual(expect.objectContaining({ code: 'REGISTRY_AGING_VERSION_MISMATCH' }));
  expect(withPolicy(value => { value.kind = 'STABLE'; }).issues)
    .toContainEqual(expect.objectContaining({ code: 'REGISTRY_FIELD_INVALID' }));
});

it('classifies policy revisions as behavior changes so they cannot disappear from a release diff', () => {
  const before = lintContractDocuments(genuine, '0.2.0');
  // Deliberately use the raw typed copy as input: schema rejection must not make
  // the classifier pass by treating the whole existing frame as removed.
  const frames = structuredClone(before.frames) as FrameContract[];
  Object.assign(frames.find(frame => frame.id === 'shared.obligation')!.predicates
    .find(predicate => predicate.id === policy().predicateId)!, { agingPolicy: policy() });
  const diff = classifyRegistryChange(before, { frames, transitions: before.transitions });
  expect(diff.changeClass).toBe('COMPATIBLE_BEHAVIORAL');
  expect(diff.changes).toContainEqual({ code: 'PREDICATE_FIELD_CHANGED', contract: 'shared.obligation',
    path: 'predicates.shared.obligation.principal_amount.agingPolicy', changeClass: 'COMPATIBLE_BEHAVIORAL' });
});

it('pins policies in the new release without adding unsupported canonical frame types', async () => {
  const before = await lintRegistryCheckout({ repository: resolve('.'), version: '0.2.0' });
  const after = await lintRegistryCheckout({ repository: resolve('.'), version: '0.3.0' });
  expect(after.frames.map(frame => frame.id).sort()).toEqual(before.frames.map(frame => frame.id).sort());
  const policies = after.frames.flatMap(frame => frame.predicates.map(predicate =>
    (predicate as unknown as { agingPolicy: ReturnType<typeof policy> }).agingPolicy));
  expect(policies.length).toBeGreaterThan(10);
  expect(policies.every(entry => entry?.policyVersion === '0.3.0')).toBe(true);
  expect(new Set(policies.map(entry => entry.kind))).toEqual(new Set(['STABLE', 'BOUNDED', 'UNRESOLVED', 'DECISION_HISTORY', 'LAST_KNOWN']));
  expect(classifyRegistryChange(before, after).changeClass).toBe('COMPATIBLE_BEHAVIORAL');
});
