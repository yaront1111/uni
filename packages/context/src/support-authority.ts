import type { MemoryTransaction } from '@unai/memory';

/** Read authority follows a complete provenance path, not an assessment alone.
 * The helper reads only identities and source bindings, never operand values or
 * calculation inputs. Alternative complete paths are independent authority;
 * every input within one recorded computation is required. */
export interface PropositionAuthority {
  readonly readable: boolean;
  readonly evidenceIds: string[];
  /** Exact readable leaf claims; these ground citations without pretending the
   * output itself has a direct assertion or exposing unrelated source spans. */
  readonly claimIds: string[];
  /** A traversal ceiling is missing knowledge, never proof of an empty graph. */
  readonly incomplete?: true;
}

interface ClaimSource {
  readonly propositionId: string | null;
  readonly evidenceId: string | null;
  readonly readable: boolean;
}
interface SupportPath {
  readonly claimIds: string[];
  readonly propositionIds: string[];
}
interface ProvenanceNode {
  readonly directClaimIds: string[];
  readonly paths: SupportPath[];
}

const MAX_GRAPH_NODES = 4096;
const MAX_GRAPH_ROWS = 16384;
const MAX_GRAPH_DEPTH = 64;
const MAX_EVIDENCE_REFS = 256;

export async function readPropositionAuthority(tx: MemoryTransaction, input: {
  ownerScopeId: string;
  propositionIds: readonly string[];
  knowledgeTime: Date;
  /** Omission uses the caller's source RLS; an explicit empty list denies all. */
  readableEvidenceIds?: readonly string[];
  withheldObjectIds?: ReadonlySet<string>;
  /** A field-redacted value can still have readable provenance itself, but may
   * not be consumed as an operand through a derived output. */
  withheldValueIds?: ReadonlySet<string>;
  removedObjectIds?: ReadonlySet<string>;
}): Promise<Map<string, PropositionAuthority>> {
  const roots = [...new Set(input.propositionIds)];
  // Exhausting a read budget denies this batch as a whole; a truncated graph
  // must never become a supposedly complete authority proof.
  const denied = () => new Map(roots.map(id => [id, { readable: false, evidenceIds: [], claimIds: [], incomplete: true as const }]));
  if (roots.length === 0 || roots.length > MAX_GRAPH_NODES) return denied();
  const blocked = (id: string | null | undefined) => id != null
    && (input.withheldObjectIds?.has(id) === true || input.removedObjectIds?.has(id) === true);
  const allowedSources = input.readableEvidenceIds === undefined ? null : new Set(input.readableEvidenceIds);
  const nodes = new Map<string, ProvenanceNode>();
  const claims = new Map<string, ClaimSource>();
  const visited = new Set<string>();
  let nextProps = roots, nextClaims: string[] = [], remainingRows = MAX_GRAPH_ROWS, depth = 0;

  while (nextProps.length > 0 || nextClaims.length > 0) {
    if (++depth > MAX_GRAPH_DEPTH) return denied();
    const propIds = [...new Set(nextProps)].filter(id => !visited.has(id));
    const claimIds = [...new Set(nextClaims)].filter(id => !claims.has(id));
    nextProps = []; nextClaims = [];
    for (const id of propIds) visited.add(id);
    if (visited.size + claims.size > MAX_GRAPH_NODES) return denied();

    const propositionRows = propIds.length === 0 ? [] : (await tx.query(
      `SELECT p.id,p.belief_slot_id,s.frame_instance_id FROM propositions p
       JOIN belief_slots s ON s.owner_scope_id=p.owner_scope_id AND s.id=p.belief_slot_id
       WHERE p.owner_scope_id=$1 AND p.id=ANY($2::uuid[])
         AND unai_private.object_state_at(p.owner_scope_id,'propositions',p.id,$3) IS NOT NULL
         AND unai_private.object_state_at(s.owner_scope_id,'belief_slots',s.id,$3) IS NOT NULL
         AND unai_private.object_state_at(s.owner_scope_id,'frame_instances',s.frame_instance_id,$3) IS NOT NULL
       ORDER BY p.id`, [input.ownerScopeId, propIds, input.knowledgeTime])).rows;
    for (const row of propositionRows) {
      const id = row['id'] as string;
      if (!blocked(id) && !blocked(row['belief_slot_id'] as string) && !blocked(row['frame_instance_id'] as string)) {
        nodes.set(id, { directClaimIds: [], paths: [] });
      }
    }
    const sourceRows = propIds.length === 0 && claimIds.length === 0 ? [] : (await tx.query(
      `SELECT c.id,(history.state->>'proposition_id')::uuid AS proposition_id,p.belief_slot_id,b.frame_instance_id,s.id AS evidence_id
       FROM claims c LEFT JOIN source_anchors a ON a.owner_scope_id=c.owner_scope_id AND a.id=c.source_anchor_id
       CROSS JOIN LATERAL (SELECT unai_private.object_state_at(c.owner_scope_id,'claims',c.id,$4) AS state) history
       LEFT JOIN source_items s ON s.owner_scope_id=a.owner_scope_id AND s.id=a.source_item_id
       LEFT JOIN propositions p ON p.owner_scope_id=c.owner_scope_id AND p.id=(history.state->>'proposition_id')::uuid
       LEFT JOIN belief_slots b ON b.owner_scope_id=p.owner_scope_id AND b.id=p.belief_slot_id
       WHERE c.owner_scope_id=$1 AND (c.proposition_id=ANY($2::uuid[]) OR c.id=ANY($3::uuid[]))
         AND ((history.state->>'proposition_id')::uuid=ANY($2::uuid[]) OR c.id=ANY($3::uuid[]))
         AND c.recorded_at<=$4 AND history.state IS NOT NULL ORDER BY c.id LIMIT $5`,
      [input.ownerScopeId, propIds, claimIds, input.knowledgeTime, remainingRows + 1])).rows;
    remainingRows -= sourceRows.length;
    if (remainingRows < 0) return denied();
    for (const row of sourceRows) {
      const id = row['id'] as string, propositionId = (row['proposition_id'] as string | null) ?? null;
      const evidenceId = (row['evidence_id'] as string | null) ?? null;
      claims.set(id, { propositionId, evidenceId, readable: evidenceId !== null
        && (allowedSources === null || allowedSources.has(evidenceId)) && !blocked(evidenceId)
        && !blocked(id) && !blocked(propositionId) && !blocked(row['belief_slot_id'] as string | null)
        && !blocked(row['frame_instance_id'] as string | null) });
      if (propositionId !== null) nodes.get(propositionId)?.directClaimIds.push(id);
    }
    if (visited.size + claims.size > MAX_GRAPH_NODES) return denied();
    const knownProps = propIds.filter(id => nodes.has(id));
    if (knownProps.length === 0) continue;
    const dependencies = (await tx.query(
      `SELECT id,derived_proposition_id,input_claim_ids,input_proposition_ids FROM derived_proposition_dependencies
       WHERE owner_scope_id=$1 AND derived_proposition_id=ANY($2::uuid[]) AND created_at<=$3
       ORDER BY id LIMIT $4`, [input.ownerScopeId, knownProps, input.knowledgeTime, remainingRows + 1])).rows;
    remainingRows -= dependencies.length;
    if (remainingRows < 0) return denied();
    // A direct assertion can be bound through belief_support without a direct
    // claim on the output. A DERIVATION edge alone is not a whole computation.
    const directSupports = (await tx.query(
      `SELECT id,proposition_id,claim_id,supporting_proposition_id FROM belief_support
       WHERE owner_scope_id=$1 AND proposition_id=ANY($2::uuid[]) AND support_kind='DIRECT_ASSERTION'
         AND created_at<=$3 ORDER BY id LIMIT $4`,
      [input.ownerScopeId, knownProps, input.knowledgeTime, remainingRows + 1])).rows;
    remainingRows -= directSupports.length;
    if (remainingRows < 0) return denied();
    const addPath = (propositionId: string, path: SupportPath) => {
      if (path.claimIds.length + path.propositionIds.length === 0) return;
      nodes.get(propositionId)!.paths.push(path);
      nextProps.push(...path.propositionIds.filter(id => !visited.has(id)));
      nextClaims.push(...path.claimIds.filter(id => !claims.has(id)));
    };
    for (const row of dependencies) {
      if (blocked(row['id'] as string)) continue;
      const path = { claimIds: row['input_claim_ids'] as string[], propositionIds: row['input_proposition_ids'] as string[] };
      remainingRows -= path.claimIds.length + path.propositionIds.length;
      if (remainingRows < 0) return denied();
      addPath(row['derived_proposition_id'] as string, path);
    }
    for (const row of directSupports) {
      if (blocked(row['id'] as string)) continue;
      addPath(row['proposition_id'] as string, {
        claimIds: row['claim_id'] ? [row['claim_id'] as string] : [],
        propositionIds: row['supporting_proposition_id'] ? [row['supporting_proposition_id'] as string] : [],
      });
    }
  }

  const proof = new Map<string, { evidenceIds: string[]; claimIds: string[] }>();
  const excessiveReferences = new Set<string>();
  const cited = (ids: Iterable<string>) => [...new Set(ids)].sort();
  for (const [id, node] of nodes) {
    const claimIds = cited(node.directClaimIds.filter(claimId => claims.get(claimId)?.readable));
    const evidenceIds = cited(claimIds.flatMap(claimId => {
      const claim = claims.get(claimId);
      return claim?.readable && claim.evidenceId ? [claim.evidenceId] : [];
    }));
    if (evidenceIds.length > 0 && evidenceIds.length <= MAX_EVIDENCE_REFS && claimIds.length <= MAX_EVIDENCE_REFS) {
      proof.set(id, { evidenceIds, claimIds });
    }
    if (evidenceIds.length > MAX_EVIDENCE_REFS || claimIds.length > MAX_EVIDENCE_REFS) excessiveReferences.add(id);
  }
  // Least fixed point: an ungrounded cycle grants nothing; a complete grounded
  // alternative can unlock every dependent node irrespective of traversal order.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, node] of nodes) {
      if (proof.has(id)) continue;
      for (const path of node.paths) {
        if (!path.claimIds.every(claimId => {
          const claim = claims.get(claimId);
          return claim?.readable === true && (claim.propositionId === null || !input.withheldValueIds?.has(claim.propositionId));
        }) || !path.propositionIds.every(propositionId => proof.has(propositionId)
          && !input.withheldValueIds?.has(propositionId))) continue;
        const evidenceIds = cited([
          ...path.claimIds.flatMap(claimId => claims.get(claimId)!.evidenceId ? [claims.get(claimId)!.evidenceId!] : []),
          ...path.propositionIds.flatMap(propositionId => proof.get(propositionId)!.evidenceIds),
        ]);
        const claimIds = cited([...path.claimIds, ...path.propositionIds.flatMap(propositionId => proof.get(propositionId)!.claimIds)]);
        if (evidenceIds.length > MAX_EVIDENCE_REFS || claimIds.length > MAX_EVIDENCE_REFS) { excessiveReferences.add(id); continue; }
        if (evidenceIds.length === 0) continue;
        proof.set(id, { evidenceIds, claimIds }); changed = true; break;
      }
    }
  }
  // A reference cap on an operand can also prevent its dependent roots from
  // being proved. Independent admitted alternatives remain complete.
  const referenceBudgetReached = excessiveReferences.size > 0;
  return new Map(roots.map(id => [id, { readable: proof.has(id),
    evidenceIds: proof.get(id)?.evidenceIds ?? [], claimIds: proof.get(id)?.claimIds ?? [],
    ...(!proof.has(id) && referenceBudgetReached ? { incomplete: true as const } : {}) }]));
}
