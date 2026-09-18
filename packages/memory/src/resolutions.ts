import { z } from 'zod';
import { claimOriginSchema, claimLifecycleSchema, memoryLinkKindSchema, memoryLinkObjectTypeSchema,
  memoryLinkLifecycleSchema, outcomeCodeSchema, outcomeProjectionSchema, resolutionLifecycleSchema,
  storedMemoryLinkSchema, storedResolutionAssertionSchema, transitionContractSchema,
  PARTIAL_OUTCOME_CODES,
  type MemoryLinkKind, type OutcomeCode, type OutcomeProjection, type StoredMemoryLink,
  type StoredResolutionAssertion, type TransitionContract } from '@unai/domain';
import { uuidV7 } from '../../../src/kernel/identities.js';
import { recordClaim } from './claims.js';
import { MemoryStoreError, type MemoryTransaction } from './transaction.js';

/** Resolution assertions and protocol links: the sole canonical outcome authority
 * (PRD §11.12, §11.13, §16.2-§16.6, §34.5 rule 5; CRT-OUT-01-B, CRT-OUT-02-A,
 * CRT-OUT-03-A, CRT-OUT-04-A, CRT-OUT-05-A, CRT-OUT-08-A).
 *
 * The rule this module exists to enforce is that an outcome is a *separate
 * record*, never an edit. "It is settled" does not set a field on the obligation;
 * it records a resolution assertion beside it, carrying the claim that asserted
 * it and the registry transition contract that permitted the code. The obligation
 * -- its frame, its slots, its propositions and its claims -- is not touched by
 * any write in this file, and neither is a scheduled event, a commitment or a
 * prediction. Every function here only inserts.
 *
 * That is also why no frame contract defines a `status` predicate (CRT-OUT-01-A,
 * enforced by registry lint): were there one, "settled" could be written in two
 * places and the two could disagree. `canonicalizeResolutionStatement` is the
 * path the extractor and the correction controls take for such a sentence, and it
 * creates no belief slot at all.
 *
 * Link direction reads as the English does: `from` REALIZES `to`, `from` RESOLVES
 * `to`. The actual occurrence realizes and resolves the scheduled event; a
 * target-less settlement has no realizing object, so the assertion itself is the
 * `from` endpoint.
 */

export const RESOLUTION_VERSION = 'resolutions-0.1.0';
export const OUTCOME_PROJECTION_VERSION = 'outcome-projection-0.1.0';
export const RESOLUTION_CLASSIFIER_VERSION = 'resolution-statement-0.1.0';

const registryId = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);

// ---------------------------------------------------------------------------
// Transition-contract validation (PRD §34.5 rule 5, FR-034; CRT-OUT-04-A)
// ---------------------------------------------------------------------------

/** What a caller must supply about the release it pinned. The registry library
 * loads and lints the YAML; nothing here reads a file, so the contracts arrive as
 * validated data and an empty set refuses every transition rather than waving one
 * through. */
export interface TransitionValidationRequest {
  readonly transitionContractId: string | null | undefined;
  readonly transitionContracts: readonly TransitionContract[];
  readonly linkKind: Extract<MemoryLinkKind, 'REALIZES' | 'RESOLVES'>;
  readonly sourceFrameTypeId: string;
  readonly targetFrameTypeId?: string | null;
  readonly outcomeCode?: OutcomeCode | null;
}

export interface ValidatedTransition {
  readonly contract: TransitionContract;
  readonly linkKind: Extract<MemoryLinkKind, 'REALIZES' | 'RESOLVES'>;
  readonly outcomeCode: OutcomeCode | null;
  readonly validationVersion: string;
}

/** Refuse anything the pinned contract does not allow.
 *
 * Each refusal names the clause that refused it, because "it is not allowed" is
 * useless to the reviewer deciding whether the contract or the caller is wrong.
 * A missing contract reference is refused first and for its own reason: an
 * assertion with no transition contract is not a resolution at all (CRT-OUT-04-A
 * covers both halves).
 */
export function validateTransition(request: TransitionValidationRequest): ValidatedTransition {
  const id = request.transitionContractId;
  if (id === null || id === undefined || id.trim() === '') throw new MemoryStoreError('TRANSITION_CONTRACT_REQUIRED');
  const contracts = request.transitionContracts.map(contract => transitionContractSchema.parse(contract));
  const contract = contracts.find(candidate => candidate.id === id);
  if (!contract) throw new MemoryStoreError('TRANSITION_CONTRACT_UNKNOWN');
  if (contract.linkKind !== request.linkKind) throw new MemoryStoreError('TRANSITION_LINK_KIND_REFUSED');
  if (!contract.sourceFrameTypes.includes(registryId.parse(request.sourceFrameTypeId))) {
    throw new MemoryStoreError('TRANSITION_SOURCE_FRAME_TYPE_REFUSED');
  }
  const targetFrameTypeId = request.targetFrameTypeId ?? null;
  if (contract.targetRequired && targetFrameTypeId === null) throw new MemoryStoreError('TRANSITION_TARGET_REQUIRED');
  if (targetFrameTypeId !== null && !contract.targetFrameTypes.includes(registryId.parse(targetFrameTypeId))) {
    throw new MemoryStoreError('TRANSITION_TARGET_FRAME_TYPE_REFUSED');
  }
  const outcomeCode = request.outcomeCode ?? null;
  if (request.linkKind === 'RESOLVES') {
    if (outcomeCode === null) throw new MemoryStoreError('RESOLUTION_OUTCOME_REQUIRED');
    if (!contract.allowedOutcomes.includes(outcomeCode)) throw new MemoryStoreError('TRANSITION_OUTCOME_REFUSED');
  } else if (outcomeCode !== null) {
    // REALIZES carries no outcome: the outcome is a separate RESOLVES assertion
    // (PRD §16.3), and release 0.1.0 declares its allowedOutcomes empty.
    throw new MemoryStoreError('REALIZATION_CARRIES_NO_OUTCOME');
  }
  return Object.freeze({ contract, linkKind: request.linkKind, outcomeCode, validationVersion: RESOLUTION_VERSION });
}

// ---------------------------------------------------------------------------
// Protocol links (PRD §11.13, §16.3, §16.4; FR-033)
// ---------------------------------------------------------------------------

const linkEndpointSchema = z.strictObject({ objectType: memoryLinkObjectTypeSchema, objectId: z.uuid() });
export type MemoryLinkEndpoint = z.infer<typeof linkEndpointSchema>;

const memoryLinkInputSchema = z.strictObject({
  ownerScopeId: z.uuid(),
  from: linkEndpointSchema,
  to: linkEndpointSchema,
  linkKind: memoryLinkKindSchema,
  lifecycle: memoryLinkLifecycleSchema.default('PROPOSED'),
  transitionContractId: registryId.nullable().default(null),
  transactionId: z.uuid().nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type MemoryLinkInput = z.input<typeof memoryLinkInputSchema>;

/** Record one protocol link. REALIZES and RESOLVES must name the transition
 * contract that permits them; the other eight kinds need none, and the schema
 * check holds that line for every principal. */
export async function recordMemoryLink(tx: MemoryTransaction, input: MemoryLinkInput): Promise<string> {
  const link = memoryLinkInputSchema.parse(input);
  if ((link.linkKind === 'REALIZES' || link.linkKind === 'RESOLVES') && link.transitionContractId === null) {
    throw new MemoryStoreError('TRANSITION_CONTRACT_REQUIRED');
  }
  if (link.from.objectType === link.to.objectType && link.from.objectId === link.to.objectId) {
    throw new MemoryStoreError('MEMORY_LINK_ENDPOINTS_IDENTICAL');
  }
  const id = uuidV7();
  await tx.query(`INSERT INTO memory_links(id,owner_scope_id,from_object_type,from_object_id,to_object_type,to_object_id,
    link_kind,lifecycle,transition_contract_id,transaction_id,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [id, link.ownerScopeId, link.from.objectType, link.from.objectId, link.to.objectType, link.to.objectId,
      link.linkKind, link.lifecycle, link.transitionContractId, link.transactionId, JSON.stringify(link.metadata)]);
  return id;
}

function toStoredLink(row: Record<string, unknown>): StoredMemoryLink {
  return storedMemoryLinkSchema.parse({
    memoryLinkId: row.id, fromObjectType: row.from_object_type, fromObjectId: row.from_object_id,
    toObjectType: row.to_object_type, toObjectId: row.to_object_id, linkKind: row.link_kind,
    lifecycle: row.lifecycle, transitionContractId: row.transition_contract_id ?? null,
    transactionId: row.transaction_id ?? null, createdAt: (row.created_at as Date).toISOString(),
    metadata: row.metadata,
  });
}

/** Links touching one object, in either direction. `direction` narrows it to the
 * links the object is the subject or the object of. */
export async function listMemoryLinks(tx: MemoryTransaction, input: {
  ownerScopeId: string; object: MemoryLinkEndpoint; linkKind?: MemoryLinkKind;
  direction?: 'FROM' | 'TO' | 'EITHER';
}): Promise<StoredMemoryLink[]> {
  const endpoint = linkEndpointSchema.parse(input.object);
  const direction = input.direction ?? 'EITHER';
  const matches = direction === 'FROM' ? '(from_object_type=$2 AND from_object_id=$3)'
    : direction === 'TO' ? '(to_object_type=$2 AND to_object_id=$3)'
      : '((from_object_type=$2 AND from_object_id=$3) OR (to_object_type=$2 AND to_object_id=$3))';
  const kind = input.linkKind ? memoryLinkKindSchema.parse(input.linkKind) : null;
  const rows = (await tx.query(
    `SELECT * FROM memory_links WHERE owner_scope_id=$1 AND ${matches} AND ($4::text IS NULL OR link_kind=$4)
     ORDER BY created_at,id`,
    [input.ownerScopeId, endpoint.objectType, endpoint.objectId, kind])).rows;
  return rows.map(toStoredLink);
}

// ---------------------------------------------------------------------------
// Resolution assertions (PRD §16.2, §33.8)
// ---------------------------------------------------------------------------

const resolutionAssertionInputSchema = z.strictObject({
  ownerScopeId: z.uuid(),
  /** The frame whose outcome this asserts. Required: an outcome is always about
   * something (PRD §33.8 "Source frame required"). */
  sourceFrameInstanceId: z.uuid(),
  sourceFrameTypeId: registryId,
  sourcePropositionId: z.uuid().nullable().default(null),
  /** What brought the outcome about, when there is such a thing. Null for the
   * ordinary owner settlement (CRT-OUT-02-A). */
  targetFrameInstanceId: z.uuid().nullable().default(null),
  targetFrameTypeId: registryId.nullable().default(null),
  targetPropositionId: z.uuid().nullable().default(null),
  outcomeCode: outcomeCodeSchema,
  effectiveAt: z.date(),
  assertedByEntityId: z.uuid(),
  /** Required (PRD §33.8 "Claim required"): an outcome nobody asserted is not a
   * memory, it is an assumption. */
  claimId: z.uuid(),
  transitionContractId: registryId,
  lifecycle: resolutionLifecycleSchema.default('PROPOSED'),
  advisoryCoverage: z.number().min(0).max(1).nullable().default(null),
  creationTransactionId: z.uuid().nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type ResolutionAssertionInput = z.input<typeof resolutionAssertionInputSchema> & {
  readonly transitionContracts: readonly TransitionContract[];
};

export interface RecordedResolutionAssertion {
  readonly resolutionAssertionId: string;
  readonly resolutionLinkId: string;
  readonly transition: ValidatedTransition;
  readonly outcomeCode: OutcomeCode;
  readonly targetFrameInstanceId: string | null;
}

/**
 * Record one resolution assertion and the RESOLVES link that carries it.
 *
 * Validation happens before either insert, so a refused outcome leaves no link
 * and no half-written assertion. Nothing about the source is read for update and
 * nothing about it is written: the obligation, commitment, schedule or prediction
 * this resolves is exactly as it was afterwards (FR-035, CRT-OUT-05-A).
 */
export async function recordResolutionAssertion(tx: MemoryTransaction, input: ResolutionAssertionInput): Promise<RecordedResolutionAssertion> {
  const { transitionContracts, ...rest } = input;
  const assertion = resolutionAssertionInputSchema.parse(rest);
  if ((assertion.targetFrameInstanceId === null) !== (assertion.targetFrameTypeId === null)) {
    throw new MemoryStoreError('RESOLUTION_TARGET_FRAME_TYPE_REQUIRED');
  }
  if (assertion.targetPropositionId !== null && assertion.targetFrameInstanceId === null) {
    throw new MemoryStoreError('RESOLUTION_TARGET_FRAME_REQUIRED');
  }
  if (assertion.targetFrameInstanceId !== null && assertion.targetFrameInstanceId === assertion.sourceFrameInstanceId) {
    throw new MemoryStoreError('RESOLUTION_TARGET_IS_SOURCE');
  }
  // An accepted outcome is a governed decision, never a side effect of reading a
  // sentence (PRD §19.1, FR-040): it must name the transaction that accepted it.
  if (assertion.lifecycle === 'ACCEPTED' && assertion.creationTransactionId === null) {
    throw new MemoryStoreError('RESOLUTION_ACCEPTANCE_REQUIRES_TRANSACTION');
  }
  const transition = validateTransition({
    transitionContractId: assertion.transitionContractId, transitionContracts, linkKind: 'RESOLVES',
    sourceFrameTypeId: assertion.sourceFrameTypeId, targetFrameTypeId: assertion.targetFrameTypeId,
    outcomeCode: assertion.outcomeCode,
  });

  const resolutionAssertionId = uuidV7();
  // The realizing object resolves the source when there is one, so the attendance
  // case reads "actual occurrence RESOLVES scheduled event" (CRT-OUT-03-A). With
  // no target the assertion itself is the subject of the link.
  const from: MemoryLinkEndpoint = assertion.targetFrameInstanceId === null
    ? { objectType: 'resolution_assertion', objectId: resolutionAssertionId }
    : { objectType: 'frame_instance', objectId: assertion.targetFrameInstanceId };
  const resolutionLinkId = await recordMemoryLink(tx, {
    ownerScopeId: assertion.ownerScopeId, from,
    to: { objectType: 'frame_instance', objectId: assertion.sourceFrameInstanceId },
    linkKind: 'RESOLVES', lifecycle: assertion.lifecycle === 'ACCEPTED' ? 'ACTIVE' : 'PROPOSED',
    transitionContractId: transition.contract.id, transactionId: assertion.creationTransactionId,
    metadata: { outcomeCode: assertion.outcomeCode, resolutionAssertionId, resolutionVersion: RESOLUTION_VERSION },
  });

  await tx.query(`INSERT INTO resolution_assertions(id,owner_scope_id,source_frame_instance_id,source_proposition_id,
    target_frame_instance_id,target_proposition_id,outcome_code,effective_at,asserted_by_entity_id,claim_id,
    transition_contract_id,lifecycle,advisory_coverage,resolution_link_id,creation_transaction_id,metadata)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [resolutionAssertionId, assertion.ownerScopeId, assertion.sourceFrameInstanceId, assertion.sourcePropositionId,
      assertion.targetFrameInstanceId, assertion.targetPropositionId, assertion.outcomeCode, assertion.effectiveAt,
      assertion.assertedByEntityId, assertion.claimId, transition.contract.id, assertion.lifecycle,
      assertion.advisoryCoverage, resolutionLinkId, assertion.creationTransactionId,
      JSON.stringify({ ...assertion.metadata, sourceFrameTypeId: assertion.sourceFrameTypeId, resolutionVersion: RESOLUTION_VERSION })]);

  return Object.freeze({
    resolutionAssertionId, resolutionLinkId, transition, outcomeCode: assertion.outcomeCode,
    targetFrameInstanceId: assertion.targetFrameInstanceId,
  });
}

function toStoredResolution(row: Record<string, unknown>): StoredResolutionAssertion {
  return storedResolutionAssertionSchema.parse({
    resolutionAssertionId: row.id,
    sourceFrameInstanceId: row.source_frame_instance_id,
    sourcePropositionId: row.source_proposition_id ?? null,
    targetFrameInstanceId: row.target_frame_instance_id ?? null,
    targetPropositionId: row.target_proposition_id ?? null,
    outcomeCode: row.outcome_code,
    effectiveAt: (row.effective_at as Date).toISOString(),
    assertedByEntityId: row.asserted_by_entity_id,
    claimId: row.claim_id,
    transitionContractId: row.transition_contract_id,
    lifecycle: row.lifecycle,
    // numeric arrives as a string from pg; it stays a displayed cache and is
    // never summed here (PRD §16.7, CRT-OUT-06-A).
    advisoryCoverage: row.advisory_coverage === null || row.advisory_coverage === undefined ? null : Number(row.advisory_coverage),
    resolutionLinkId: row.resolution_link_id ?? null,
    creationTransactionId: row.creation_transaction_id ?? null,
    recordedAt: (row.recorded_at as Date).toISOString(),
    metadata: row.metadata,
  });
}

export async function readResolutionAssertion(tx: MemoryTransaction, input: {
  ownerScopeId: string; resolutionAssertionId: string;
}): Promise<StoredResolutionAssertion | null> {
  const row = (await tx.query('SELECT * FROM resolution_assertions WHERE owner_scope_id=$1 AND id=$2',
    [input.ownerScopeId, input.resolutionAssertionId])).rows[0];
  return row ? toStoredResolution(row) : null;
}

/** Every resolution asserted about one frame, oldest effective first. */
export async function listResolutionAssertions(tx: MemoryTransaction, input: {
  ownerScopeId: string; sourceFrameInstanceId: string; lifecycle?: StoredResolutionAssertion['lifecycle'];
}): Promise<StoredResolutionAssertion[]> {
  const lifecycle = input.lifecycle ? resolutionLifecycleSchema.parse(input.lifecycle) : null;
  const rows = (await tx.query(
    `SELECT * FROM resolution_assertions WHERE owner_scope_id=$1 AND source_frame_instance_id=$2
     AND ($3::text IS NULL OR lifecycle=$3) ORDER BY effective_at,recorded_at,id`,
    [input.ownerScopeId, input.sourceFrameInstanceId, lifecycle])).rows;
  return rows.map(toStoredResolution);
}

/** Move a recorded resolution to another lifecycle. The trigger of migration 0015
 * refuses every other column, so this can never become a way to restate what the
 * resolution said; accepting one names the governed transaction that did it. */
export async function setResolutionLifecycle(tx: MemoryTransaction, input: {
  ownerScopeId: string; resolutionAssertionId: string;
  lifecycle: StoredResolutionAssertion['lifecycle']; transactionId?: string | null;
}): Promise<StoredResolutionAssertion> {
  const lifecycle = resolutionLifecycleSchema.parse(input.lifecycle);
  if (lifecycle === 'ACCEPTED' && !input.transactionId) throw new MemoryStoreError('RESOLUTION_ACCEPTANCE_REQUIRES_TRANSACTION');
  const row = (await tx.query(
    'UPDATE resolution_assertions SET lifecycle=$3 WHERE owner_scope_id=$1 AND id=$2 RETURNING *',
    [input.ownerScopeId, input.resolutionAssertionId, lifecycle])).rows[0];
  if (!row) throw new MemoryStoreError('RESOLUTION_ASSERTION_NOT_FOUND');
  const stored = toStoredResolution(row);
  if (stored.resolutionLinkId) {
    await tx.query('UPDATE memory_links SET lifecycle=$3 WHERE owner_scope_id=$1 AND id=$2',
      [input.ownerScopeId, stored.resolutionLinkId,
        lifecycle === 'ACCEPTED' ? 'ACTIVE' : lifecycle === 'CONTESTED' ? 'CONTESTED'
          : lifecycle === 'REJECTED' || lifecycle === 'WITHDRAWN' ? 'RETRACTED'
            : lifecycle === 'SUPERSEDED' ? 'SUPERSEDED' : 'PROPOSED']);
  }
  return stored;
}

// ---------------------------------------------------------------------------
// Realization (PRD §16.3, §44.7; CRT-OUT-03-A)
// ---------------------------------------------------------------------------

export interface RealizationInput {
  readonly ownerScopeId: string;
  /** The prior scheduled event, commitment or plan. The transition contract calls
   * it the source, and it is never rewritten. */
  readonly sourceFrameInstanceId: string;
  readonly sourceFrameTypeId: string;
  /** The actual occurrence that manifests it -- a separate instance, always. */
  readonly actualFrameInstanceId: string;
  readonly actualFrameTypeId: string;
  readonly transitionContractId: string;
  readonly transitionContracts: readonly TransitionContract[];
  readonly transactionId?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Link an actual occurrence to what it realizes. It carries no outcome: the
 * outcome is a separate RESOLVES assertion, which is why release 0.1.0 declares
 * the realization contract's `allowedOutcomes` empty (PRD §16.3). */
export async function recordRealization(tx: MemoryTransaction, input: RealizationInput): Promise<{
  readonly memoryLinkId: string; readonly transition: ValidatedTransition;
}> {
  if (input.actualFrameInstanceId === input.sourceFrameInstanceId) throw new MemoryStoreError('REALIZATION_TARGET_IS_SOURCE');
  const transition = validateTransition({
    transitionContractId: input.transitionContractId, transitionContracts: input.transitionContracts,
    linkKind: 'REALIZES', sourceFrameTypeId: input.sourceFrameTypeId, targetFrameTypeId: input.actualFrameTypeId,
    outcomeCode: null,
  });
  const memoryLinkId = await recordMemoryLink(tx, {
    ownerScopeId: input.ownerScopeId,
    from: { objectType: 'frame_instance', objectId: input.actualFrameInstanceId },
    to: { objectType: 'frame_instance', objectId: input.sourceFrameInstanceId },
    linkKind: 'REALIZES', lifecycle: 'PROPOSED', transitionContractId: transition.contract.id,
    transactionId: input.transactionId ?? null,
    metadata: { ...(input.metadata ?? {}), resolutionVersion: RESOLUTION_VERSION },
  });
  return Object.freeze({ memoryLinkId, transition });
}

// ---------------------------------------------------------------------------
// Resolution statements (PRD §11.12, §44.4, §44.8; CRT-OUT-01-B, CRT-OUT-02-A)
// ---------------------------------------------------------------------------

export interface ResolutionStatementReading {
  readonly outcomeCode: OutcomeCode;
  readonly matchedText: string;
  readonly statement: string;
  /** The clause that says how, when the speaker gave one: "I paid him in cash".
   * It supports the assertion; it is not a second assertion. */
  readonly supportingDetail: string | null;
  readonly classifierVersion: string;
}

/** Ordered because the first match wins and the partial readings must be tried
 * before the whole ones: "partly paid" is not "paid". */
const RESOLUTION_PHRASES: ReadonlyArray<{ pattern: RegExp; outcomeCode: OutcomeCode }> = Object.freeze([
  { pattern: /\b(?:partly|partially|part of it)\b[^.;]*\b(?:settled|paid|repaid|done|completed|fulfilled)\b/i, outcomeCode: 'PARTIALLY_FULFILLED' },
  { pattern: /\b(?:partly|partially)\b[^.;]*\b(?:confirmed|right|correct|came true)\b/i, outcomeCode: 'PARTIALLY_CONFIRMED' },
  { pattern: /\b(?:cancell?ed|called off)\b/i, outcomeCode: 'CANCELLED' },
  { pattern: /\b(?:waived|wrote it off|written off|forgave|forgiven)\b/i, outcomeCode: 'WAIVED' },
  { pattern: /\b(?:withdrew|withdrawn|took it back|retracted)\b/i, outcomeCode: 'WITHDRAWN' },
  { pattern: /\b(?:missed|did not attend|didn't attend|no[- ]showed)\b/i, outcomeCode: 'MISSED' },
  { pattern: /\b(?:fell through|failed|could not do it|couldn't do it)\b/i, outcomeCode: 'FAILED' },
  { pattern: /\b(?:refuted|turned out wrong|was wrong|did not happen|didn't happen)\b/i, outcomeCode: 'REFUTED' },
  { pattern: /\b(?:confirmed|came true|turned out right)\b/i, outcomeCode: 'CONFIRMED' },
  { pattern: /\b(?:attended|it happened|took place|went ahead|showed up)\b/i, outcomeCode: 'OCCURRED' },
  { pattern: /\b(?:settled|paid (?:him|her|them|it) (?:back|off)?|repaid|squared up)\b/i, outcomeCode: 'FULFILLED' },
  { pattern: /\b(?:completed|finished|done|sent it|delivered it)\b/i, outcomeCode: 'FULFILLED' },
]);

/** A negated or hypothetical phrase is not a resolution. "It is not settled" and
 * "I will complete it" say something about the commitment, not about its outcome,
 * and reading either as FULFILLED would invent an outcome from a sentence that
 * denied or deferred one (PRD §12.6, §58). */
const NEGATION = /\b(?:not|never|no longer|isn't|isnt|wasn't|wasnt|hasn't|hasnt|haven't|havent|don't|dont|didn't|didnt)\b/i;
const NOT_YET_ACTUAL = /\b(?:will|going to|plan to|planning to|intend to|intending to|should|would|might|may|considering|hope to|about to)\b/i;

/**
 * Read a sentence as a resolution assertion, or answer null.
 *
 * Null is the honest answer for anything this classifier does not recognise:
 * guessing an outcome code is exactly the failure this whole module exists to
 * prevent. The reading it returns is still a *proposal* -- the outcome code is
 * checked against the transition contract before anything is stored.
 */
export function classifyResolutionStatement(statement?: string | null): ResolutionStatementReading | null {
  const text = (statement ?? '').trim();
  if (text === '') return null;
  for (const { pattern, outcomeCode } of RESOLUTION_PHRASES) {
    const match = pattern.exec(text);
    if (!match) continue;
    const before = text.slice(0, match.index);
    if (NEGATION.test(before) || NOT_YET_ACTUAL.test(before)) return null;
    const clauses = text.split(/\s*[;,]\s*/).filter(clause => clause !== '');
    const matchedClause = clauses.find(clause => pattern.test(clause)) ?? text;
    const detail = clauses.filter(clause => clause !== matchedClause).join('; ');
    return Object.freeze({
      outcomeCode, matchedText: match[0], statement: text,
      supportingDetail: detail === '' ? null : detail,
      classifierVersion: RESOLUTION_CLASSIFIER_VERSION,
    });
  }
  return null;
}

export interface ResolutionStatementRequest {
  readonly ownerScopeId: string;
  readonly sourceFrameInstanceId: string;
  readonly sourceFrameTypeId: string;
  readonly sourcePropositionId?: string | null;
  readonly statement: string;
  readonly sourceAnchorId: string;
  readonly claimOrigin: z.input<typeof claimOriginSchema>;
  readonly claimLifecycle?: z.input<typeof claimLifecycleSchema>;
  readonly assertedByEntityId: string;
  readonly effectiveAt: Date;
  readonly transitionContractId: string;
  readonly transitionContracts: readonly TransitionContract[];
  /** Only for a caller that already knows the code (a capability evaluator, or
   * the owner choosing it in the correction controls). The statement classifier
   * decides otherwise, and a mismatch is refused rather than silently preferred. */
  readonly outcomeCode?: OutcomeCode;
  readonly targetFrameInstanceId?: string | null;
  readonly targetFrameTypeId?: string | null;
  readonly targetPropositionId?: string | null;
  readonly lifecycle?: StoredResolutionAssertion['lifecycle'];
  readonly advisoryCoverage?: number | null;
  readonly creationTransactionId?: string | null;
  readonly extractionRunId?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface CanonicalizedResolution extends RecordedResolutionAssertion {
  readonly reading: ResolutionStatementReading | null;
  readonly claimId: string;
  /** Always false, and returned so a caller can assert it: a resolution statement
   * creates no belief slot and therefore no status value (CRT-OUT-01-B). */
  readonly createdStatusSlot: false;
}

/**
 * Canonicalize "It is settled", "I completed it" or "The meeting was cancelled".
 *
 * This is the whole path such a sentence takes, and it deliberately shares none
 * of `canonicalizeClaim`'s: no slot is resolved, no proposition is created, no
 * value is written anywhere. The claim it records carries no proposition at all
 * -- it is the assertion that the outcome happened -- and the outcome itself is
 * the resolution assertion row (CRT-OUT-01-B, CRT-OUT-02-A).
 */
export async function canonicalizeResolutionStatement(tx: MemoryTransaction, request: ResolutionStatementRequest): Promise<CanonicalizedResolution> {
  const reading = classifyResolutionStatement(request.statement);
  if (reading === null && request.outcomeCode === undefined) throw new MemoryStoreError('RESOLUTION_STATEMENT_UNRECOGNIZED');
  if (reading !== null && request.outcomeCode !== undefined && reading.outcomeCode !== request.outcomeCode) {
    throw new MemoryStoreError('RESOLUTION_OUTCOME_DISAGREES_WITH_STATEMENT');
  }
  const outcomeCode = request.outcomeCode ?? reading!.outcomeCode;

  const claimId = await recordClaim(tx, {
    ownerScopeId: request.ownerScopeId, sourceAnchorId: request.sourceAnchorId,
    claimOrigin: request.claimOrigin, lifecycle: request.claimLifecycle ?? 'CANDIDATE',
    // No proposition: an outcome is not a value in a slot (PRD §16.1).
    propositionId: null,
    candidateFrameTypeId: request.sourceFrameTypeId,
    assertedByEntityId: request.assertedByEntityId,
    extractionRunId: request.extractionRunId ?? null,
    validFrom: request.effectiveAt,
    metadata: {
      ...(request.metadata ?? {}),
      resolutionStatement: {
        statement: reading?.statement ?? request.statement,
        matchedText: reading?.matchedText ?? null,
        supportingDetail: reading?.supportingDetail ?? null,
        outcomeCode,
        classifierVersion: RESOLUTION_CLASSIFIER_VERSION,
      },
    },
  });

  const recorded = await recordResolutionAssertion(tx, {
    ownerScopeId: request.ownerScopeId,
    sourceFrameInstanceId: request.sourceFrameInstanceId, sourceFrameTypeId: request.sourceFrameTypeId,
    sourcePropositionId: request.sourcePropositionId ?? null,
    targetFrameInstanceId: request.targetFrameInstanceId ?? null,
    targetFrameTypeId: request.targetFrameTypeId ?? null,
    targetPropositionId: request.targetPropositionId ?? null,
    outcomeCode, effectiveAt: request.effectiveAt, assertedByEntityId: request.assertedByEntityId, claimId,
    transitionContractId: request.transitionContractId, transitionContracts: request.transitionContracts,
    lifecycle: request.lifecycle ?? 'PROPOSED',
    advisoryCoverage: request.advisoryCoverage ?? null,
    creationTransactionId: request.creationTransactionId ?? null,
    metadata: { statementClassifierVersion: RESOLUTION_CLASSIFIER_VERSION },
  });

  return Object.freeze({ ...recorded, reading, claimId, createdStatusSlot: false as const });
}

// ---------------------------------------------------------------------------
// The derived outcome projection (PRD §16.6; CRT-OUT-08-A)
// ---------------------------------------------------------------------------

const isPartial = (code: OutcomeCode) => PARTIAL_OUTCOME_CODES.includes(code);

/**
 * A frame's outcome, read from its accepted resolution assertions.
 *
 * Derived on every read and stored nowhere, which is what keeps it from becoming
 * the parallel status field PRD §16.1 forbids. Two *different* settling codes
 * accepted at once is a contradiction the owner has to see -- an event both
 * OCCURRED and CANCELLED is not a progression -- while a partial followed by a
 * settling code is one, so only the settling codes are compared for conflict.
 */
export async function frameOutcomeProjection(tx: MemoryTransaction, input: {
  ownerScopeId: string; frameInstanceId: string;
}): Promise<OutcomeProjection> {
  const rows = (await tx.query(
    `SELECT id,outcome_code FROM resolution_assertions
     WHERE owner_scope_id=$1 AND source_frame_instance_id=$2 AND lifecycle='ACCEPTED'
     ORDER BY effective_at,recorded_at,id`, [input.ownerScopeId, input.frameInstanceId])).rows;
  const accepted = rows.map(row => outcomeCodeSchema.parse(row.outcome_code));
  const settling = [...new Set(accepted.filter(code => !isPartial(code)))].sort();
  const state = accepted.length === 0 ? 'UNRESOLVED'
    : settling.length > 1 ? 'CONTESTED'
      : settling.length === 1 ? 'RESOLVED' : 'PARTIALLY_RESOLVED';
  return outcomeProjectionSchema.parse({
    frameInstanceId: input.frameInstanceId,
    state,
    acceptedOutcomes: accepted,
    conflictingOutcomes: state === 'CONTESTED' ? settling : [],
    acceptedResolutionIds: rows.map(row => row.id as string),
    projectionVersion: OUTCOME_PROJECTION_VERSION,
  });
}

// ---------------------------------------------------------------------------
// Elapsed schedules (PRD §12.6, §44.7; CRT-OUT-03-A)
// ---------------------------------------------------------------------------

export interface ElapsedSchedule {
  readonly frameInstanceId: string;
  readonly frameTypeId: string;
  readonly scheduledFor: string;
  readonly realizingFrameInstanceIds: readonly string[];
  readonly outcome: OutcomeProjection;
}

export interface ElapsedScheduleSweep {
  readonly asOf: string;
  readonly elapsed: readonly ElapsedSchedule[];
  /** Zero, structurally: this function contains no INSERT. */
  readonly occurrencesCreated: 0;
  readonly resolutionsCreated: 0;
  readonly sweepVersion: string;
}

/**
 * Report the scheduled frames whose time has passed -- and create nothing.
 *
 * An event left on the calendar past its date proves only that nobody edited the
 * calendar. This function exists so that "time passage creates no occurrence and
 * no resolution" is executable rather than an absence someone has to notice:
 * callers get the elapsed schedules to *ask* about, and the two counters they get
 * back are constants (PRD §12.6, CRT-OUT-03-A, CRT-OUT-07-A).
 */
export async function sweepElapsedSchedules(tx: MemoryTransaction, input: {
  ownerScopeId: string; asOf: Date; frameTypeId?: string;
}): Promise<ElapsedScheduleSweep> {
  const frameTypeId = input.frameTypeId ? registryId.parse(input.frameTypeId) : null;
  const rows = (await tx.query(
    `SELECT f.id AS frame_instance_id, f.frame_type_id, max(c.valid_from) AS scheduled_for
     FROM frame_instances f
     JOIN belief_slots s ON s.owner_scope_id=f.owner_scope_id AND s.frame_instance_id=f.id AND s.modality='SCHEDULED'
     JOIN propositions p ON p.owner_scope_id=s.owner_scope_id AND p.belief_slot_id=s.id
     JOIN claims c ON c.owner_scope_id=p.owner_scope_id AND c.proposition_id=p.id
     WHERE f.owner_scope_id=$1 AND c.valid_from IS NOT NULL AND c.valid_from < $2
     AND ($3::text IS NULL OR f.frame_type_id=$3)
     GROUP BY f.id, f.frame_type_id ORDER BY 3, 1`,
    [input.ownerScopeId, input.asOf, frameTypeId])).rows;

  const elapsed: ElapsedSchedule[] = [];
  for (const row of rows) {
    const frameInstanceId = row.frame_instance_id as string;
    const realizing = await listMemoryLinks(tx, {
      ownerScopeId: input.ownerScopeId, object: { objectType: 'frame_instance', objectId: frameInstanceId },
      linkKind: 'REALIZES', direction: 'TO',
    });
    elapsed.push(Object.freeze({
      frameInstanceId, frameTypeId: row.frame_type_id as string,
      scheduledFor: (row.scheduled_for as Date).toISOString(),
      realizingFrameInstanceIds: Object.freeze(realizing.map(link => link.fromObjectId)),
      outcome: await frameOutcomeProjection(tx, { ownerScopeId: input.ownerScopeId, frameInstanceId }),
    }));
  }
  return Object.freeze({
    asOf: input.asOf.toISOString(), elapsed: Object.freeze(elapsed),
    occurrencesCreated: 0, resolutionsCreated: 0, sweepVersion: RESOLUTION_VERSION,
  });
}
