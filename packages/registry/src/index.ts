/** Git registry library (PRD §36.6). Not a network service in V0. */
export * from './schema.js';
export { lintContractDocuments, isOutcomeStatusPredicate, REQUIRED_FRAME_CONTRACTS, type LintIssue, type LintResult, type ContractDocument } from './lint.js';
export {
  RegistryError, releaseContentHash, readReleaseIndex, loadRegistryRelease, lintRegistryCheckout, lintRegistryRepository,
  RELEASE_INDEX_PATH, RELEASES_DIRECTORY, type LoadedRegistryRelease,
} from './release.js';
export { validatePredicateValue, findPredicate } from './values.js';
export { publishRegistryRelease, canonicalJson } from './snapshot.js';
