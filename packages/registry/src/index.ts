import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { z } from 'zod';

const id = z.string().regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/);
const version = z.string().regex(/^\d+\.\d+\.\d+$/);
const text = z.string().trim().min(1).max(4000);
const strings = z.array(text).max(100);
const modalities = z.array(z.enum(['ACTUAL', 'SCHEDULED', 'INTENDED', 'COMMITTED', 'EXPECTED', 'PREDICTED', 'RECOMMENDED', 'CONDITIONAL'])).min(1).max(8);
const predicate = z.strictObject({
  id, valueType: text, cardinality: z.enum(['FUNCTIONAL', 'SET', 'EVENT']), normalization: text,
  allowedModalities: modalities, slotQualifiers: strings, temporalBehavior: text, conflictBehavior: text,
  supersessionBehavior: text, sourceAuthorityPolicy: text, projectionConsumers: strings,
});
const contractSchema = z.strictObject({
  id, version, description: text, contextPolicy: z.array(z.enum(['BASE', 'QUOTED', 'TEST'])).min(1).max(3),
  identityStrategy: z.literal('SURROGATE'), identityAnchors: strings,
  roles: z.array(z.strictObject({ id, valueType: text })).min(1).max(100),
  predicates: z.array(predicate).min(1).max(100), allowedModalities: modalities, slotQualifiers: strings,
  authorityRules: strings.min(1), mergePolicy: text, splitPolicy: text, transitionContracts: strings,
  projectionConsumers: strings, invariants: strings.min(1), acceptanceTests: strings.min(1),
}).refine(contract => new Set(contract.predicates.map(item => item.id)).size === contract.predicates.length
  && new Set(contract.roles.map(item => item.id)).size === contract.roles.length
  && contract.predicates.every(item => item.allowedModalities.every(modality => contract.allowedModalities.includes(modality))));
const manifestSchema = z.strictObject({ version, contracts: z.array(z.strictObject({
  id, file: z.string().regex(/^[a-z0-9][a-z0-9_.-]*\.yaml$/), sha256: z.string().regex(/^[a-f0-9]{64}$/),
})).min(1).max(100) }).refine(manifest => new Set(manifest.contracts.map(item => item.id)).size === manifest.contracts.length
  && new Set(manifest.contracts.map(item => item.file)).size === manifest.contracts.length);

async function bytes(path: string): Promise<Buffer> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('REGISTRY_FILE_INVALID');
  return readFile(path);
}

/** Structural validation only: promotion also requires corpus, identity and projection gates.
 * Runtime callers must pin the release directory to an immutable Git commit/tag checkout.
 */
export async function loadRegistryRelease(directory: string) {
  let raw: unknown;
  try { raw = JSON.parse((await bytes(resolve(directory, 'manifest.json'))).toString('utf8')); }
  catch { throw new Error('REGISTRY_RELEASE_MISSING'); }
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) throw new Error('REGISTRY_MANIFEST_INVALID');
  const manifest = parsed.data;
  const contracts: z.infer<typeof contractSchema>[] = [];
  for (const entry of manifest.contracts) {
    let content: Buffer;
    try { content = await bytes(resolve(directory, entry.file)); }
    catch { throw new Error('REGISTRY_FILE_INVALID'); }
    if (createHash('sha256').update(content).digest('hex') !== entry.sha256) throw new Error('REGISTRY_DIGEST_MISMATCH');
    try {
      const document = parseDocument(content.toString('utf8'), { uniqueKeys: true });
      if (document.errors.length || document.warnings.length) throw new Error('YAML_INVALID');
      const contract = contractSchema.parse(document.toJS({ maxAliasCount: 0 }));
      if (contract.id !== entry.id || contract.version !== manifest.version) throw new Error('IDENTITY_MISMATCH');
      contracts.push(contract);
    } catch { throw new Error('REGISTRY_CONTRACT_INVALID'); }
  }
  return { version: manifest.version, contracts };
}
