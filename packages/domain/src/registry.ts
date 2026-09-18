import { z } from 'zod';

/** Read-only views of the registry runtime snapshot and of the CLI lint report.
 *
 * These are display schemas for the operations console (design screen "Registry
 * release and migration"). They carry release identity and bounded issue codes
 * only: contract bodies stay in Git, and nothing here loads, hashes, lints or
 * publishes a release — that is the registry CLI library, which no deployed
 * package imports (CRT-REG-01-B).
 */
export const registryVersionSchema = z.string().regex(/^(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})$/);
export const registryContentHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const registryContractKindSchema = z.enum(['FRAME', 'PREDICATE', 'TRANSITION']);

export const publicRegistryContractSchema = z.strictObject({
  contractId: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/),
  contractKind: registryContractKindSchema,
  contractVersion: registryVersionSchema,
  contentHash: registryContentHashSchema,
});
export type PublicRegistryContract = z.infer<typeof publicRegistryContractSchema>;

export const loadedRegistryReleaseSchema = z.strictObject({
  id: z.uuid(),
  semanticVersion: registryVersionSchema,
  gitTag: z.string().regex(/^registry-v(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})$/),
  gitCommit: z.string().regex(/^([a-f0-9]{40}|[a-f0-9]{64})$/),
  contentHash: registryContentHashSchema,
  lifecycle: z.literal('RELEASED'),
  releasedAt: z.iso.datetime(),
});
export type LoadedRegistryRelease = z.infer<typeof loadedRegistryReleaseSchema>;

export const registrySnapshotViewSchema = z.strictObject({
  release: loadedRegistryReleaseSchema.nullable(),
  contracts: z.array(publicRegistryContractSchema).max(1000),
});
export type RegistrySnapshotView = z.infer<typeof registrySnapshotViewSchema>;

/** One lint violation: a stable code, the contract file and the field path.
 * Never contract text, because a contract can quote private wording. */
export const registryLintIssueSchema = z.strictObject({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
  contract: z.string().min(1).max(200),
  path: z.string().max(200),
});
export const registryLintedReleaseSchema = z.strictObject({
  version: registryVersionSchema,
  tag: z.string().min(1).max(64),
  contentHash: registryContentHashSchema,
  contracts: z.int().min(0).max(1000),
});
/** Written by `uai registry lint --report <path>`; read by the operations
 * screen when a deployment configures the CI artifact. */
export const registryLintReportSchema = z.strictObject({
  result: z.enum(['PASS', 'FAIL']),
  checkedAt: z.iso.datetime(),
  code: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).nullable(),
  releases: z.array(registryLintedReleaseSchema).max(100),
  issues: z.array(registryLintIssueSchema).max(500),
});
export type RegistryLintReport = z.infer<typeof registryLintReportSchema>;
