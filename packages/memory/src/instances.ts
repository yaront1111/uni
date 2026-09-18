import { z } from 'zod';
import { uuidV7 } from '../../../src/kernel/identities.js';
import { createFrameInstance, recordFrameInstanceRole } from './claims.js';
import { MemoryStoreError, type MemoryTransaction } from './transaction.js';

/** Frame-instance matching (PRD §13.4; CRT-MEM-11-A, CRT-MEM-11-C).
 *
 * Matching answers one question: is this extraction about a situation memory
 * already holds? The answer is one of five outcomes, and only `CONFIRMED_MATCH`
 * may reuse an existing instance for a material accepted update. Everything else
 * keeps the extraction separate, which is the under-merge default of PRD §13.4:
 * if the kernel cannot safely determine that two extractions describe the same
 * instance, it keeps them apart and records what it declined to join.
 *
 * "Daniel lent me another ILS 50" is the case the word `another` decides. Shared
 * creditor, equal amount and a compatible time would otherwise score high; the
 * explicit distinctness marker overrides all of it, because participants never
 * define instance identity (PRD §11.5) and the registry's obligation contract
 * lists "another" as a new-instance signal.
 *
 * Every decision is recorded in `instance_match_candidates` with its score
 * components and reason, so the Memory inspector can show the instance that was
 * considered and not joined.
 */

export const INSTANCE_MATCHER_VERSION = 'instance-matcher-0.1.0';

export type InstanceMatchOutcome =
  'CONFIRMED_MATCH' | 'PROBABLE_MATCH' | 'POSSIBLE_MATCH' | 'CONFIRMED_DISTINCT' | 'NEW_INSTANCE';

/** The five outcomes of PRD §13.4, in the order the PRD lists them. */
export const INSTANCE_MATCH_OUTCOMES: readonly InstanceMatchOutcome[] = Object.freeze([
  'CONFIRMED_MATCH', 'PROBABLE_MATCH', 'POSSIBLE_MATCH', 'CONFIRMED_DISTINCT', 'NEW_INSTANCE',
]);

/** Whether the update being canonicalized would accept a belief about the
 * instance. PRD §13.4 restricts automatic reuse for exactly this case. */
export type UpdateMateriality = 'MATERIAL_ACCEPTED_UPDATE' | 'NON_MATERIAL';

export type ExplicitReference = 'SAME' | 'THAT_ONE' | 'ANOTHER' | 'DIFFERENT';
export type TemporalCompatibility = 'COMPATIBLE' | 'INCOMPATIBLE' | 'UNKNOWN';
export type AmountCompatibility = 'EQUAL' | 'DIFFERENT' | 'UNKNOWN';

/** The evidence the matcher may use, exactly the list of PRD §13.4. Nothing here
 * is inferred from the candidate's identity; every field is supplied by the
 * caller that read the discourse, the document or the connector payload. */
export interface InstanceMatchSignals {
  readonly externalIdentifierMatch?: boolean;
  readonly sharedResolvedEntityRoles?: readonly string[];
  readonly conflictingEntityRoles?: readonly string[];
  readonly threadContinuity?: boolean;
  readonly explicitReference?: ExplicitReference | null;
  readonly temporalCompatibility?: TemporalCompatibility;
  readonly sharedOriginEvent?: boolean;
  readonly sharedDocumentAnchor?: boolean;
  readonly amountCompatibility?: AmountCompatibility;
  readonly semanticSimilarity?: number;
  /** A capability rule that decides the outcome outright (PRD §13.4, §25.2). */
  readonly capabilityRule?: 'CONFIRMED_MATCH' | 'CONFIRMED_DISTINCT' | null;
}

export interface InstanceMatchScore {
  readonly outcome: InstanceMatchOutcome;
  readonly score: number;
  readonly components: Readonly<Record<string, number>>;
  readonly reason: Readonly<{ code: string; matcherVersion: string; signals: InstanceMatchSignals }>;
}

const PROBABLE_THRESHOLD = 0.75;
const POSSIBLE_THRESHOLD = 0.4;

/** Score one candidate. Pure, so the same signals always reach the same outcome
 * and a stored decision can be recomputed from its recorded components.
 *
 * `NEW_INSTANCE` here means "this candidate gives no reason to join it": the
 * extraction becomes a new instance. A candidate scored that way is noise and is
 * not recorded; the recorded `NEW_INSTANCE` row is the one that names no
 * candidate at all. */
export function scoreInstanceMatch(signals: InstanceMatchSignals): InstanceMatchScore {
  const shared = signals.sharedResolvedEntityRoles ?? [];
  const conflicting = signals.conflictingEntityRoles ?? [];
  const similarity = Math.min(Math.max(signals.semanticSimilarity ?? 0, 0), 1);
  const components: Record<string, number> = {
    sharedResolvedEntities: Math.min(shared.length * 0.25, 0.5),
    threadContinuity: signals.threadContinuity ? 0.1 : 0,
    sharedOriginEvent: signals.sharedOriginEvent ? 0.15 : 0,
    sharedDocumentAnchor: signals.sharedDocumentAnchor ? 0.1 : 0,
    temporalCompatibility: signals.temporalCompatibility === 'COMPATIBLE' ? 0.05
      : signals.temporalCompatibility === 'INCOMPATIBLE' ? -0.3 : 0,
    amountCompatibility: signals.amountCompatibility === 'EQUAL' ? 0.05
      : signals.amountCompatibility === 'DIFFERENT' ? -0.15 : 0,
    semanticSimilarity: similarity * 0.15,
    explicitReference: signals.explicitReference === 'SAME' || signals.explicitReference === 'THAT_ONE' ? 0.2 : 0,
  };
  const score = Math.min(Math.max(Object.values(components).reduce((total, value) => total + value, 0), 0), 1);
  const reason = (code: string) => Object.freeze({ code, matcherVersion: INSTANCE_MATCHER_VERSION, signals });
  const decided = (outcome: InstanceMatchOutcome, code: string): InstanceMatchScore =>
    Object.freeze({ outcome, score, components: Object.freeze(components), reason: reason(code) });

  // A capability rule and an explicit distinctness marker both settle the answer
  // before any score is consulted: "another ILS 50" is a second obligation even
  // though every other signal agrees with the first one (CRT-MEM-11-A).
  if (signals.capabilityRule) return decided(signals.capabilityRule, 'CAPABILITY_RULE');
  if (signals.explicitReference === 'ANOTHER' || signals.explicitReference === 'DIFFERENT') {
    return decided('CONFIRMED_DISTINCT', 'EXPLICIT_DISTINCT_REFERENCE');
  }
  // An identity-anchor role filled by a different entity is a different situation.
  if (conflicting.length > 0) return decided('CONFIRMED_DISTINCT', 'IDENTITY_ANCHOR_CONFLICT');
  if (signals.externalIdentifierMatch) return decided('CONFIRMED_MATCH', 'EXTERNAL_IDENTIFIER_MATCH');
  if ((signals.explicitReference === 'SAME' || signals.explicitReference === 'THAT_ONE') && shared.length > 0) {
    return decided('CONFIRMED_MATCH', 'EXPLICIT_SAME_REFERENCE');
  }
  if (score >= PROBABLE_THRESHOLD) return decided('PROBABLE_MATCH', 'STRONG_CIRCUMSTANTIAL_SIGNALS');
  if (score >= POSSIBLE_THRESHOLD) return decided('POSSIBLE_MATCH', 'WEAK_CIRCUMSTANTIAL_SIGNALS');
  return decided('NEW_INSTANCE', 'NO_SUFFICIENT_SIGNAL');
}

/** PRD §13.4: "Only CONFIRMED_MATCH may automatically reuse an instance for a
 * material accepted update." This service is stricter than the sentence and
 * stricter than the schema check behind it -- it never reuses behind anything but
 * a CONFIRMED_MATCH -- because the under-merge default costs a duplicate instance
 * a person can merge, while a wrong reuse silently rewrites somebody's debt. */
export function mayReuseInstance(outcome: InstanceMatchOutcome, _materiality: UpdateMateriality): boolean {
  return outcome === 'CONFIRMED_MATCH';
}

export interface RoleFiller { readonly roleId: string; readonly entityId?: string | null; readonly typedValue?: unknown }

export interface InstanceMatchRequest {
  readonly ownerScopeId: string;
  readonly frameTypeId: string;
  readonly contextSpaceId: string;
  readonly roles?: readonly RoleFiller[];
  /** Roles the registry contract names as identity anchors: a conflict in one of
   * them makes two instances distinct rather than merely different. */
  readonly identityAnchorRoles?: readonly string[];
  /** Roles whose typed value is a stable external identifier. */
  readonly externalIdentifierRoles?: readonly string[];
  readonly explicitReference?: ExplicitReference | null;
  readonly threadContinuity?: boolean;
  readonly sharedOriginEvent?: boolean;
  readonly sharedDocumentAnchor?: boolean;
  readonly temporalCompatibility?: TemporalCompatibility;
  readonly amountCompatibility?: AmountCompatibility;
  readonly semanticSimilarity?: number;
  readonly capabilityRule?: 'CONFIRMED_MATCH' | 'CONFIRMED_DISTINCT' | null;
  readonly candidateLimit?: number;
}

export interface ScoredCandidate extends InstanceMatchScore { readonly frameInstanceId: string }

export interface InstanceMatch {
  readonly outcome: InstanceMatchOutcome;
  readonly candidates: readonly ScoredCandidate[];
  readonly bestCandidate: ScoredCandidate | null;
}

const registryId = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);

/** Every live instance of the frame type in this context, scored against the
 * signals the caller read. Nothing is written here. */
export async function matchFrameInstance(tx: MemoryTransaction, request: InstanceMatchRequest): Promise<InstanceMatch> {
  const frameTypeId = registryId.parse(request.frameTypeId);
  const roles = request.roles ?? [];
  const anchors = new Set(request.identityAnchorRoles ?? []);
  const externalRoles = new Set(request.externalIdentifierRoles ?? []);
  const rows = (await tx.query(
    `SELECT f.id,r.role_id,r.entity_id,r.typed_value FROM frame_instances f
     LEFT JOIN frame_instance_roles r ON r.owner_scope_id=f.owner_scope_id AND r.frame_instance_id=f.id
     WHERE f.owner_scope_id=$1 AND f.frame_type_id=$2 AND f.context_space_id=$3 AND f.lifecycle='ACTIVE'
     ORDER BY f.created_at DESC,f.id`,
    [request.ownerScopeId, frameTypeId, request.contextSpaceId])).rows;

  const byInstance = new Map<string, { roleId: string; entityId: string | null; typedValue: unknown }[]>();
  for (const row of rows) {
    const id = row['id'] as string;
    const existing = byInstance.get(id) ?? [];
    if (row['role_id']) {
      existing.push({ roleId: row['role_id'] as string, entityId: (row['entity_id'] as string | null) ?? null, typedValue: row['typed_value'] });
    }
    byInstance.set(id, existing);
  }

  const candidates: ScoredCandidate[] = [];
  for (const [frameInstanceId, filled] of [...byInstance.entries()].slice(0, request.candidateLimit ?? 50)) {
    const sharedResolvedEntityRoles: string[] = [];
    const conflictingEntityRoles: string[] = [];
    let externalIdentifierMatch = false;
    for (const role of roles) {
      const theirs = filled.filter(candidate => candidate.roleId === role.roleId);
      if (theirs.length === 0) continue;
      if (role.entityId) {
        if (theirs.some(candidate => candidate.entityId === role.entityId)) sharedResolvedEntityRoles.push(role.roleId);
        else if (anchors.has(role.roleId) && theirs.some(candidate => candidate.entityId !== null)) conflictingEntityRoles.push(role.roleId);
      }
      if (role.typedValue !== undefined && externalRoles.has(role.roleId)
        && theirs.some(candidate => JSON.stringify(candidate.typedValue) === JSON.stringify(role.typedValue))) {
        externalIdentifierMatch = true;
      }
    }
    // A candidate has to be tied to the extraction by something of its own before
    // the discourse-level signals are applied to it. Without this, "another one"
    // would record a CONFIRMED_DISTINCT decision against every unrelated instance
    // of the frame type, and the record would say the matcher considered
    // situations it never looked at.
    // An anchor role filled by somebody else is what makes two *tied* instances
    // distinct; between two instances with nothing in common it says nothing, so
    // a candidate with no shared filler and no external identifier is skipped
    // rather than recorded as a decision the matcher never really made.
    if (roles.length > 0 && sharedResolvedEntityRoles.length === 0 && !externalIdentifierMatch) continue;
    const scored = scoreInstanceMatch({
      externalIdentifierMatch, sharedResolvedEntityRoles, conflictingEntityRoles,
      threadContinuity: request.threadContinuity ?? false,
      explicitReference: request.explicitReference ?? null,
      temporalCompatibility: request.temporalCompatibility ?? 'UNKNOWN',
      sharedOriginEvent: request.sharedOriginEvent ?? false,
      sharedDocumentAnchor: request.sharedDocumentAnchor ?? false,
      amountCompatibility: request.amountCompatibility ?? 'UNKNOWN',
      semanticSimilarity: request.semanticSimilarity ?? 0,
      capabilityRule: request.capabilityRule ?? null,
    });
    if (scored.outcome === 'NEW_INSTANCE') continue;
    candidates.push({ ...scored, frameInstanceId });
  }
  // The strongest tie first, then the strongest score: a CONFIRMED_DISTINCT
  // candidate never outranks a CONFIRMED_MATCH one, and neither is chosen by
  // recency alone.
  const rank: Record<InstanceMatchOutcome, number> = {
    CONFIRMED_MATCH: 0, PROBABLE_MATCH: 1, POSSIBLE_MATCH: 2, CONFIRMED_DISTINCT: 3, NEW_INSTANCE: 4,
  };
  candidates.sort((left, right) => rank[left.outcome] - rank[right.outcome] || right.score - left.score);
  const best = candidates[0] ?? null;
  return Object.freeze({ outcome: best?.outcome ?? 'NEW_INSTANCE', candidates: Object.freeze(candidates), bestCandidate: best });
}

export interface ResolvedFrameInstance {
  readonly frameInstanceId: string;
  readonly created: boolean;
  readonly reusedExistingInstance: boolean;
  readonly outcome: InstanceMatchOutcome;
  readonly match: InstanceMatch;
  readonly recordedCandidateIds: readonly string[];
}

/**
 * Decide the instance an extraction belongs to, record the decision, and return
 * it (PRD §13.4; CRT-MEM-11-A, CRT-MEM-11-C).
 *
 * A reuse happens only behind `CONFIRMED_MATCH`. Every other outcome creates a
 * new instance and keeps the candidate it declined to join on the record, so the
 * PROBABLE and POSSIBLE cases leave two instances and a reviewable candidate row
 * rather than one silently merged situation.
 */
export async function resolveFrameInstance(tx: MemoryTransaction, request: InstanceMatchRequest & {
  readonly materiality: UpdateMateriality;
  readonly extractionRunId?: string | null;
  readonly claimId?: string | null;
}): Promise<ResolvedFrameInstance> {
  const match = await matchFrameInstance(tx, request);
  const applied = await applyInstanceDecision(tx, request, match, request.materiality);
  const recordedCandidateIds = await recordInstanceDecision(tx, request, match, applied, request.materiality, {
    claimId: request.claimId ?? null, extractionRunId: request.extractionRunId ?? null,
  });
  return Object.freeze({
    frameInstanceId: applied.frameInstanceId, created: !applied.reusedExistingInstance,
    reusedExistingInstance: applied.reusedExistingInstance, outcome: match.outcome, match,
    recordedCandidateIds: Object.freeze(recordedCandidateIds),
  });
}

export interface AppliedInstanceDecision { readonly frameInstanceId: string; readonly reusedExistingInstance: boolean }

/** Reuse the confirmed instance, or create a new one with the roles the caller
 * read. Split from the recording step so a canonicalization can name the claim
 * its match decision belongs to, which it only knows after the claim exists. */
export async function applyInstanceDecision(
  tx: MemoryTransaction, request: InstanceMatchRequest, match: InstanceMatch, materiality: UpdateMateriality,
): Promise<AppliedInstanceDecision> {
  const reuse = match.bestCandidate !== null && mayReuseInstance(match.bestCandidate.outcome, materiality);
  if (reuse) return Object.freeze({ frameInstanceId: match.bestCandidate!.frameInstanceId, reusedExistingInstance: true });
  const frameInstanceId = await createFrameInstance(tx, {
    ownerScopeId: request.ownerScopeId, frameTypeId: request.frameTypeId, contextSpaceId: request.contextSpaceId,
  });
  for (const role of request.roles ?? []) {
    if ((role.entityId === undefined || role.entityId === null) && role.typedValue === undefined) continue;
    await recordFrameInstanceRole(tx, {
      ownerScopeId: request.ownerScopeId, frameInstanceId, roleId: role.roleId,
      ...(role.entityId === undefined || role.entityId === null ? {} : { entityId: role.entityId }),
      ...(role.typedValue === undefined ? {} : { typedValue: role.typedValue }),
    });
  }
  return Object.freeze({ frameInstanceId, reusedExistingInstance: false });
}

/** Append the decision: one row per candidate considered, or one `NEW_INSTANCE`
 * row naming no candidate when there was nothing to consider. */
export async function recordInstanceDecision(
  tx: MemoryTransaction, request: InstanceMatchRequest, match: InstanceMatch, applied: AppliedInstanceDecision,
  materiality: UpdateMateriality, links: { claimId?: string | null; extractionRunId?: string | null } = {},
): Promise<string[]> {
  const recorded: string[] = [];
  for (const candidate of match.candidates) {
    recorded.push(await recordInstanceMatchCandidate(tx, {
      ownerScopeId: request.ownerScopeId, frameTypeId: request.frameTypeId,
      extractionRunId: links.extractionRunId ?? null, claimId: links.claimId ?? null,
      candidateFrameInstanceId: candidate.frameInstanceId, resolvedFrameInstanceId: applied.frameInstanceId,
      matchOutcome: candidate.outcome, materiality,
      reusedExistingInstance: applied.reusedExistingInstance && candidate.frameInstanceId === applied.frameInstanceId,
      score: candidate.score, scoreComponents: candidate.components, decisionReason: candidate.reason,
    }));
  }
  if (match.candidates.length === 0) {
    recorded.push(await recordInstanceMatchCandidate(tx, {
      ownerScopeId: request.ownerScopeId, frameTypeId: request.frameTypeId,
      extractionRunId: links.extractionRunId ?? null, claimId: links.claimId ?? null,
      candidateFrameInstanceId: null, resolvedFrameInstanceId: applied.frameInstanceId,
      matchOutcome: 'NEW_INSTANCE', materiality, reusedExistingInstance: false,
      score: 0, scoreComponents: {}, decisionReason: { code: 'NO_CANDIDATE_INSTANCE', matcherVersion: INSTANCE_MATCHER_VERSION },
    }));
  }
  return recorded;
}

/** Append one match decision. The schema refuses a reuse behind anything but a
 * CONFIRMED_MATCH for a material accepted update, so a caller that tries it gets
 * a database refusal rather than a merged obligation. */
export async function recordInstanceMatchCandidate(tx: MemoryTransaction, input: {
  ownerScopeId: string; frameTypeId: string; extractionRunId?: string | null; claimId?: string | null;
  candidateFrameInstanceId: string | null; resolvedFrameInstanceId: string | null;
  matchOutcome: InstanceMatchOutcome; materiality: UpdateMateriality; reusedExistingInstance: boolean;
  score?: number | null; scoreComponents?: Readonly<Record<string, unknown>>; decisionReason?: Readonly<Record<string, unknown>>;
  matcherVersion?: string;
}): Promise<string> {
  if (input.reusedExistingInstance && !mayReuseInstance(input.matchOutcome, input.materiality)) {
    throw new MemoryStoreError('INSTANCE_MATCH_REUSE_REFUSED');
  }
  const id = uuidV7();
  await tx.query(
    `INSERT INTO instance_match_candidates(id,owner_scope_id,extraction_run_id,claim_id,frame_type_id,
      candidate_frame_instance_id,resolved_frame_instance_id,match_outcome,materiality,reused_existing_instance,
      score,score_components,decision_reason,matcher_version)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [id, input.ownerScopeId, input.extractionRunId ?? null, input.claimId ?? null, registryId.parse(input.frameTypeId),
      input.candidateFrameInstanceId, input.resolvedFrameInstanceId, input.matchOutcome, input.materiality,
      input.reusedExistingInstance, input.score ?? null, JSON.stringify(input.scoreComponents ?? {}),
      JSON.stringify(input.decisionReason ?? {}), input.matcherVersion ?? INSTANCE_MATCHER_VERSION]);
  return id;
}

export interface StoredInstanceMatchCandidate {
  readonly id: string;
  readonly frameTypeId: string;
  readonly extractionRunId: string | null;
  readonly claimId: string | null;
  readonly candidateFrameInstanceId: string | null;
  readonly resolvedFrameInstanceId: string | null;
  readonly matchOutcome: InstanceMatchOutcome;
  readonly materiality: UpdateMateriality;
  readonly reusedExistingInstance: boolean;
  readonly score: number | null;
  readonly scoreComponents: Record<string, unknown>;
  readonly decisionReason: Record<string, unknown>;
  readonly matcherVersion: string;
  readonly createdAt: string;
}

/** The decisions that produced or considered one instance, newest last. */
export async function listInstanceMatchCandidates(tx: MemoryTransaction, input: {
  ownerScopeId: string; frameInstanceId: string;
}): Promise<StoredInstanceMatchCandidate[]> {
  const rows = (await tx.query(
    `SELECT * FROM instance_match_candidates
     WHERE owner_scope_id=$1 AND (candidate_frame_instance_id=$2 OR resolved_frame_instance_id=$2)
     ORDER BY created_at,id`, [input.ownerScopeId, input.frameInstanceId])).rows;
  return rows.map(row => Object.freeze({
    id: row['id'] as string,
    frameTypeId: row['frame_type_id'] as string,
    extractionRunId: (row['extraction_run_id'] as string | null) ?? null,
    claimId: (row['claim_id'] as string | null) ?? null,
    candidateFrameInstanceId: (row['candidate_frame_instance_id'] as string | null) ?? null,
    resolvedFrameInstanceId: (row['resolved_frame_instance_id'] as string | null) ?? null,
    matchOutcome: row['match_outcome'] as InstanceMatchOutcome,
    materiality: row['materiality'] as UpdateMateriality,
    reusedExistingInstance: row['reused_existing_instance'] as boolean,
    score: row['score'] === null || row['score'] === undefined ? null : Number(row['score']),
    scoreComponents: (row['score_components'] as Record<string, unknown>) ?? {},
    decisionReason: (row['decision_reason'] as Record<string, unknown>) ?? {},
    matcherVersion: row['matcher_version'] as string,
    createdAt: (row['created_at'] as Date).toISOString(),
  }));
}
