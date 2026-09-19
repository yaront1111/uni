import { createHash } from 'node:crypto';
import { PROJECTION_NAMES, type ShadowReport } from '@unai/domain';
import { computeProjectionRows, projectionRowContent, readProjectionRows } from '@unai/capabilities';
import type { ContextKind, ShadowClaim, ShadowCost, ShadowSample } from './shadow.js';

/** Reading an owner's shadow sample and recording the run (CRT-WRT-09-A).
 *
 * Production state is never touched: the sample is read in READ ONLY
 * transactions (PostgreSQL itself refuses any write in them), the projection
 * comparison uses the reducer's compute path that writes nothing, and the only
 * write is the run's own `shadow_evaluation_runs` row under `evaluation.shadow`,
 * a purpose no production table admits. The production digest taken before the
 * read and after it is the computed evidence, recorded on the run.
 */

export interface ShadowTransaction {
  query(sql: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
}
/** Opens one owner transaction under `purpose`; `readOnly` makes it READ ONLY
 * before the callback's first statement. */
export type ShadowRunner = <T>(purpose: string, readOnly: boolean, run: (tx: ShadowTransaction) => Promise<T>) => Promise<T>;

export const SHADOW_READ_PURPOSE = 'memory.inspect';
export const SHADOW_PROJECTION_PURPOSE = 'memory.project';
export const SHADOW_RECORD_PURPOSE = 'evaluation.shadow';

/** The canonical tables a shadow sample is read from. */
const DIGEST_TABLES = ['frame_instances', 'frame_instance_roles', 'belief_slots', 'propositions', 'claims', 'belief_assessments',
  'resolution_assertions'] as const;

/** A digest of every row of the sampled tables this owner's read purpose sees. */
export async function productionDigest(tx: ShadowTransaction, ownerScopeId: string): Promise<string> {
  const hash = createHash('sha256');
  for (const table of DIGEST_TABLES) {
    const row = (await tx.query(`SELECT count(*)::text AS n,
      coalesce(md5(string_agg(md5(t::text),'' ORDER BY md5(t::text))),'') AS h FROM ${table} t WHERE owner_scope_id=$1`, [ownerScopeId])).rows[0]!;
    hash.update(table + ':' + String(row['n']) + ':' + String(row['h']) + '\n');
  }
  return hash.digest('hex');
}

const AUTHORITATIVE_ORIGINS = new Set(['USER_STATEMENT', 'USER_CONFIRMATION', 'USER_CORRECTION', 'STRUCTURED_CONNECTOR_OBSERVATION',
  'TOOL_EXECUTION_RECEIPT']);

export interface OwnerSampleRequest {
  readonly ownerScopeId: string;
  readonly limit: number;
  readonly runKind: 'REGISTRY' | 'EXTRACTOR';
  /** `<model id>@<prompt version>` of each side, for an EXTRACTOR run. */
  readonly extractor?: { readonly baseline: string; readonly candidate: string };
  readonly asOf: Date;
}

export async function readOwnerShadowSample(runner: ShadowRunner, request: OwnerSampleRequest)
  : Promise<{ sample: ShadowSample; digestBefore: string }> {
  const owner = request.ownerScopeId;
  const read = await runner(SHADOW_READ_PURPOSE, true, async tx => {
    const digestBefore = await productionDigest(tx, owner);
    const instances = (await tx.query(`SELECT id,frame_type_id FROM frame_instances
      WHERE owner_scope_id=$1 AND lifecycle='ACTIVE' ORDER BY id LIMIT $2`, [owner, request.limit])).rows;
    const ids = instances.map(row => row['id'] as string);
    const roles = (await tx.query(`SELECT frame_instance_id,role_id,entity_id FROM frame_instance_roles
      WHERE owner_scope_id=$1 AND frame_instance_id=ANY($2::uuid[]) ORDER BY frame_instance_id,role_id,id`, [owner, ids])).rows;
    const claims = (await tx.query(`SELECT c.id,c.source_anchor_id,c.claim_origin,p.normalized_value,p.polarity,s.frame_instance_id,
        s.predicate_id,s.modality,s.qualifiers,cs.context_kind,r.model_id,r.prompt_version,
        (SELECT a.assessment_status FROM belief_assessments a WHERE a.owner_scope_id=p.owner_scope_id AND a.proposition_id=p.id
          AND a.superseded_recorded_at IS NULL ORDER BY a.recorded_at DESC,a.id DESC LIMIT 1) AS status
      FROM claims c
      JOIN propositions p ON p.owner_scope_id=c.owner_scope_id AND p.id=c.proposition_id
      JOIN belief_slots s ON s.owner_scope_id=p.owner_scope_id AND s.id=p.belief_slot_id
      JOIN context_spaces cs ON cs.owner_scope_id=s.owner_scope_id AND cs.id=s.context_space_id
      LEFT JOIN extraction_runs r ON r.owner_scope_id=c.owner_scope_id AND r.id=c.extraction_run_id
      WHERE c.owner_scope_id=$1 AND s.frame_instance_id=ANY($2::uuid[]) ORDER BY c.id`, [owner, ids])).rows;
    const resolutions = (await tx.query(`SELECT r.id,r.source_frame_instance_id,r.transition_contract_id,r.outcome_code,
        t.frame_type_id AS target_frame_type
      FROM resolution_assertions r
      LEFT JOIN frame_instances t ON t.owner_scope_id=r.owner_scope_id AND t.id=r.target_frame_instance_id
      WHERE r.owner_scope_id=$1 AND r.source_frame_instance_id=ANY($2::uuid[]) ORDER BY r.id`, [owner, ids])).rows;
    let costs: Record<string, ShadowCost> = {};
    if (request.runKind === 'EXTRACTOR' && request.extractor) {
      const rows = (await tx.query(`SELECT model_id||'@'||prompt_version AS version,count(*)::int AS items,
          coalesce(sum(cost_microunits),0)::bigint AS cost,coalesce(avg(latency_ms),0)::float8 AS latency
        FROM extraction_runs WHERE owner_scope_id=$1 AND model_id IS NOT NULL AND prompt_version IS NOT NULL
          AND model_id||'@'||prompt_version=ANY($2::text[]) GROUP BY 1`,
        [owner, [request.extractor.baseline, request.extractor.candidate]])).rows;
      costs = Object.fromEntries(rows.map(row => [row['version'] as string,
        { items: Number(row['items']), costMicrounits: Number(row['cost']), latencyMs: Number(Number(row['latency']).toFixed(3)) }]));
    }
    return { digestBefore, instances, roles, claims, resolutions, costs };
  });

  // The stored projection rows against what the reducer computes now: the
  // replay comparison, made without writing a row or a receipt.
  const storedProjection = await runner(SHADOW_PROJECTION_PURPOSE, true, async tx => {
    let storedRows = 0, equal = true;
    for (const projectionName of PROJECTION_NAMES) {
      const stored = await readProjectionRows(tx, { ownerScopeId: owner, projectionName });
      const computed = await computeProjectionRows(tx, { ownerScopeId: owner, projectionName, asOf: request.asOf });
      storedRows += stored.length;
      const left = stored.map(projectionRowContent).sort(), right = computed.map(projectionRowContent).sort();
      if (left.length !== right.length || left.some((row, index) => row !== right[index])) equal = false;
    }
    return { storedRows, replayEqualsStored: equal };
  });

  const toClaim = (row: Record<string, unknown>, matchKey: string): ShadowClaim => ({
    ref: row['id'] as string, matchKey, instanceRef: row['frame_instance_id'] as string, predicateId: row['predicate_id'] as string,
    contextKind: row['context_kind'] as ContextKind, modality: row['modality'] as string,
    qualifiers: (row['qualifiers'] ?? {}) as Record<string, string | number | boolean>, value: row['normalized_value'],
    polarity: row['polarity'] as 'POSITIVE' | 'NEGATIVE', recordedStatus: (row['status'] as string | null) ?? null,
    sourceAuthoritative: AUTHORITATIVE_ORIGINS.has(row['claim_origin'] as string),
  });
  const versionOf = (row: Record<string, unknown>) => row['model_id'] ? row['model_id'] + '@' + row['prompt_version'] : null;
  let baseline: ShadowClaim[], candidate: ShadowClaim[];
  if (request.runKind === 'EXTRACTOR' && request.extractor) {
    // Two extractors produced different claims about the same anchors, so the
    // diff is keyed on the anchor and the predicate rather than a claim id.
    const side = (version: string) => read.claims.filter(row => versionOf(row) === version)
      .map(row => toClaim(row, (row['source_anchor_id'] as string) + '|' + (row['predicate_id'] as string)));
    baseline = side(request.extractor.baseline);
    candidate = side(request.extractor.candidate);
  } else {
    baseline = candidate = read.claims.map(row => toClaim(row, row['id'] as string));
  }
  const byInstance = new Map<string, { roleId: string; entityRef: string | null }[]>();
  for (const role of read.roles) {
    const id = role['frame_instance_id'] as string;
    byInstance.set(id, [...(byInstance.get(id) ?? []), { roleId: role['role_id'] as string, entityRef: (role['entity_id'] as string | null) ?? null }]);
  }
  const sample: ShadowSample = {
    kind: 'OWNER_SAMPLE', corpus: null, limit: request.limit,
    instances: read.instances.map(row => ({ ref: row['id'] as string, frameType: row['frame_type_id'] as string,
      roles: byInstance.get(row['id'] as string) ?? [] })),
    resolutions: read.resolutions.map(row => ({ ref: row['id'] as string, instanceRef: row['source_frame_instance_id'] as string,
      transitionContractId: row['transition_contract_id'] as string, linkKind: 'RESOLVES' as const,
      outcomeCode: (row['outcome_code'] as string | null) ?? null,
      targetFrameType: (row['target_frame_type'] as string | null) ?? null })),
    baseline: { claims: baseline, cost: request.extractor ? read.costs[request.extractor.baseline] ?? { items: 0, costMicrounits: 0, latencyMs: 0 } : null },
    candidate: { claims: candidate, cost: request.extractor ? read.costs[request.extractor.candidate] ?? { items: 0, costMicrounits: 0, latencyMs: 0 } : null },
    storedProjection,
  };
  return { sample, digestBefore: read.digestBefore };
}

/** The run's one write. The diffs are stored as the report computed them. */
export async function recordShadowRun(tx: ShadowTransaction, input: {
  ownerScopeId: string; actorId: string; correlationId: string; report: ShadowReport;
}): Promise<string> {
  const { report } = input;
  await tx.query(`INSERT INTO shadow_evaluation_runs(id,owner_scope_id,run_kind,sample_ref,baseline_version,candidate_version,
      evaluation_versions,instance_match_diff,slot_collision_diff,proposition_diff,belief_status_diff,resolution_diff,
      projection_diff,cost_and_latency_diff,production_unchanged,requested_by_actor_id,correlation_id,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
  [report.runId, input.ownerScopeId, report.runKind, JSON.stringify(report.sampleRef), report.baselineVersion, report.candidateVersion,
    JSON.stringify(report.evaluationVersions), JSON.stringify(report.diffs.instanceMatch), JSON.stringify(report.diffs.slotCollision),
    JSON.stringify(report.diffs.proposition), JSON.stringify(report.diffs.beliefStatus), JSON.stringify(report.diffs.resolution),
    JSON.stringify(report.diffs.projection), JSON.stringify(report.diffs.costAndLatency), report.productionUnchanged,
    input.actorId, input.correlationId, report.createdAt]);
  return report.runId;
}
