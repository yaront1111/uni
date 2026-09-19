/** Git registry library (PRD §36.6). Not a network service in V0. */
export * from './schema.js';
export { lintContractDocuments, isOutcomeStatusPredicate, REQUIRED_FRAME_CONTRACTS, type LintIssue, type LintResult, type ContractDocument } from './lint.js';
export {
  RegistryError, releaseContentHash, readReleaseIndex, loadRegistryRelease, lintRegistryCheckout, lintRegistryRepository,
  readTaggedMigrationEvidence, RELEASE_INDEX_PATH, RELEASES_DIRECTORY, MIGRATION_FILE, type LoadedRegistryRelease,
} from './release.js';
export { classifyRegistryChange, checkMigrationEvidence, type RegistryChange, type RegistryChangeSet, type MigrationStatus,
  type EvidenceState } from './migration.js';
export { validatePredicateValue, findPredicate } from './values.js';
export { publishRegistryRelease, canonicalJson } from './snapshot.js';
