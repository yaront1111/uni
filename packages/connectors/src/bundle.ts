import { pluginContextBundleSchema, type LifeCategory, type PluginContextBundle } from '@unai/domain';
import { deriveLifeCategories, readContextPacket, type ContextBrokerOptions, type ContextRunner } from '@unai/context';
import { ConnectorError } from './manifests.js';
import { requireCapability, type ConnectorTransaction } from './grants.js';

/**
 * The least-context bundle a plugin operation receives (PRD §27.3,
 * CRT-SEC-03-A).
 *
 * "A plugin receives only the smallest context bundle required for the requested
 * operation. A work-email plugin must not receive private health, family, or full
 * financial context merely because the assistant has access to it."
 *
 * The rule is enforced in three places at once, because one of them alone would
 * be a policy statement rather than a guarantee:
 *
 *  1. The *capability* declares the profile. The caller does not choose the
 *     purpose, the ceiling or the view: `gmail.read_content` carries
 *     `WORK_ASSISTANCE`, the WORK view and the exclusion of health, family and
 *     finance, and a caller cannot widen any of them.
 *  2. The *broker* answers under that profile. The declared data purpose gates
 *     the row policies and `EvaluateMemoryRead`, so evidence that does not admit
 *     `WORK_ASSISTANCE` is never read at all.
 *  3. The *bundle* then drops every object that still carries an excluded
 *     category -- a work frame whose evidence also admits `PERSONAL_FINANCE`, for
 *     instance -- and lists it in `withheld`. An object in two views is stored
 *     once and shown in both (CRT-MEM-02-A); this is where a plugin operation is
 *     told about only one of them.
 */

export interface PluginBundleRequest {
  readonly connectorId: string;
  readonly capabilityId: string;
  readonly ownerScopeId: string;
  readonly requestingActorId: string;
  readonly query: string;
  readonly worldTime?: string;
  readonly knowledgeTime?: string;
}

function categoriesOf(object: Record<string, unknown>): LifeCategory[] {
  const declared = Array.isArray(object['lifeCategories'])
    ? (object['lifeCategories'] as unknown[]).filter((value): value is LifeCategory => typeof value === 'string')
    : [];
  if (declared.length > 0) return declared;
  return deriveLifeCategories({ frameTypeId: typeof object['frameTypeId'] === 'string' ? object['frameTypeId'] : null });
}

export async function buildPluginContextBundle(
  runner: ContextRunner, request: PluginBundleRequest, options: ContextBrokerOptions,
): Promise<PluginContextBundle> {
  // The capability first: an operation with no grant receives no bundle at all,
  // not an empty one (CRT-CON-07-A).
  const capability = await runner(async (tx: unknown) =>
    requireCapability(tx as ConnectorTransaction, request.connectorId, request.capabilityId));
  const profile = capability.contextProfile;
  const excluded = new Set<LifeCategory>(profile.excludedLifeCategories);
  if (profile.lifeCategory !== null && excluded.has(profile.lifeCategory)) {
    throw new ConnectorError('CONNECTOR_CONTEXT_PROFILE_INVALID', { capabilityId: request.capabilityId });
  }
  const packet = await readContextPacket(runner, {
    ownerScopeId: request.ownerScopeId, requestingActorId: request.requestingActorId,
    purpose: profile.purpose, query: request.query,
    lifeCategory: profile.lifeCategory,
    worldTime: request.worldTime ?? 'NOW', knowledgeTime: request.knowledgeTime ?? 'LATEST',
    maximumSensitivity: profile.maximumSensitivity, actionRisk: 'LOW',
    tokenBudget: profile.tokenBudget, includeEvidence: 'WHEN_NEEDED',
  }, options);

  const withheld: Array<{ objectType: string; objectId: string; reason: 'LEAST_CONTEXT_CATEGORY_EXCLUDED'; lifeCategories: LifeCategory[] }> = [];
  const keep = (objectType: string, idField: string) => (object: Record<string, unknown>): boolean => {
    const categories = categoriesOf(object);
    if (!categories.some(category => excluded.has(category))) return true;
    withheld.push({ objectType, objectId: String(object[idField] ?? ''), reason: 'LEAST_CONTEXT_CATEGORY_EXCLUDED', lifeCategories: categories });
    return false;
  };
  const beliefs = (packet.currentBeliefs as unknown as Record<string, unknown>[]).filter(keep('propositions', 'propositionId'));
  const futureClaims = (packet.futureClaims as unknown as Record<string, unknown>[]).filter(keep('propositions', 'propositionId'));
  const keptEvidence = new Set<string>([
    ...beliefs.flatMap(belief => Array.isArray(belief['evidenceIds']) ? belief['evidenceIds'] as string[] : []),
  ]);
  const evidenceRefs = (packet.evidenceRefs as unknown as Record<string, unknown>[]).filter(reference => {
    const categories = categoriesOf(reference);
    const id = String(reference['evidenceId'] ?? '');
    if (categories.some(category => excluded.has(category))) {
      withheld.push({ objectType: 'source_items', objectId: id, reason: 'LEAST_CONTEXT_CATEGORY_EXCLUDED', lifeCategories: categories });
      return false;
    }
    // An evidence reference is supplied only when the bundle still carries a
    // belief it grounds: the smallest bundle the operation needs, not every item
    // the packet happened to cite.
    return keptEvidence.size === 0 || keptEvidence.has(id);
  });

  return pluginContextBundleSchema.parse({
    packetId: packet.packetId, packetHash: packet.packetHash,
    connectorId: request.connectorId, capabilityId: request.capabilityId,
    purpose: profile.purpose, lifeCategory: profile.lifeCategory,
    excludedLifeCategories: [...excluded], maximumSensitivity: profile.maximumSensitivity,
    beliefs, futureClaims, evidenceRefs,
    // A plugin bundle grants no action: V0 refuses every external write but a
    // draft, and creating even that is the drafts slice's decision.
    allowedActions: ['ANSWER_WITH_CITATIONS'],
    withheld,
  });
}
