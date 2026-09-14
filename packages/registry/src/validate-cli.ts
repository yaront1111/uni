import { loadRegistryRelease } from './index.js';

try {
  const release = await loadRegistryRelease(process.argv[2] ?? 'registry/releases/0.1.0');
  console.log(JSON.stringify({ event: 'registry.structural_validation', version: release.version, contracts: release.contracts.length }));
} catch (error) {
  const code = error instanceof Error && /^REGISTRY_[A-Z_]+$/.test(error.message) ? error.message : 'REGISTRY_VALIDATION_FAILED';
  console.error(code);
  process.exitCode = 1;
}
