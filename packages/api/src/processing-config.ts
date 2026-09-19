import { dataPurposeSchema, sensitivitySchema } from '@unai/domain';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function processingRequired(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error('PROCESSING_CONFIGURATION_REQUIRED');
  return value;
}
export function processingRelease(env: NodeJS.ProcessEnv) {
  const registryReleaseId = processingRequired(env, 'UNAI_REGISTRY_RELEASE_ID');
  const registryRelease = processingRequired(env, 'UNAI_REGISTRY_RELEASE');
  if (!UUID.test(registryReleaseId) || !/^\d+\.\d+\.\d+$/.test(registryRelease)) throw new Error('PROCESSING_CONFIGURATION_INVALID');
  return { registryReleaseId, registryRelease };
}
export function processingConfiguration(env: NodeJS.ProcessEnv) {
  const release = processingRelease(env);
  const ownerScopeId = processingRequired(env, 'UNAI_PROCESSING_OWNER_SCOPE_ID');
  const actorId = processingRequired(env, 'UNAI_PROCESSING_ACTOR_ID');
  if (!UUID.test(ownerScopeId) || !UUID.test(actorId)) throw new Error('PROCESSING_CONFIGURATION_INVALID');
  const purpose = dataPurposeSchema.safeParse(processingRequired(env, 'UNAI_PROCESSING_DATA_PURPOSE'));
  const sensitivity = sensitivitySchema.safeParse(processingRequired(env, 'UNAI_PROCESSING_MAXIMUM_SENSITIVITY'));
  const pollMs = Number(env.UNAI_PROCESSING_POLL_MS ?? 1000);
  if (!purpose.success || !sensitivity.success || !Number.isInteger(pollMs) || pollMs < 100 || pollMs > 60000) throw new Error('PROCESSING_CONFIGURATION_INVALID');
  return { ...release, ownerScopeId, actorId, dataPurpose: purpose.data, maximumSensitivity: sensitivity.data, pollMs };
}
