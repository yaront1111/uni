import {traceStage} from '@unai/observability';
import { createHash } from 'node:crypto';
import type { z } from 'zod';
import {
  contextRequestSchema, contextPacketSchema, contextBeliefSchema, contextFutureClaimSchema, contextConflictSchema,
  contextUnknownSchema, contextEvidenceRefSchema, contextResolutionSchema, contextRedactionSchema,
  contextActionDecisionSchema,
  REQUIRED_CONTEXT_FIELDS, REDACTABLE_BELIEF_FIELDS, SELECTION_RULES, answerTypeSchema,
  type AnswerType, type ContextPacket, type ContextRequest, type ContextRedaction, type LifeCategory,
  type RequiredContextField, type PolicyVerdict,
} from '@unai/domain';
import { canonicalJson, readOwnerOverlay, searchMemoryEmbeddings, type MemoryTransaction } from '@unai/memory';
import { createLocalPolicyAdapters, recordPolicyDecision, type PolicyPorts } from '@unai/belief';
import { uuidV7 } from '../../../src/kernel/identities.js';
import { categoryOfPurpose, deriveLifeCategories, inCategoryView } from './categories.js';
import { readProjectionFragments } from './fragments.js';
import { SELECTION_VERSION, modalitiesForAnswerType, selectCurrentStates, selectionsDigest } from './selector.js';
import { listThreadsForObject } from './threads.js';
import { readPropositionAuthority } from './support-authority.js';

/**
 * The Context Broker (PRD §23, §36.11; design POST /v1/memory/context).
 *
 * This is the only path by which a model or a plugin reads memory (FR-060), and
 * it is built around four refusals that happen *before* anything is retrieved or
 * assembled:
 *
 *  1. A request that does not declare purpose, requesting actor, owner scope,
 *     world time, knowledge time, maximum sensitivity and action risk is refused
 *     before the first query runs. `missingContextFields` is a pure function and
 *     the route calls it before it opens a transaction (CRT-RD-02-A).
 *  2. A purpose the evidence does not admit is denied by `EvaluateMemoryRead`,
 *     and the denial is persisted like every other port decision (CRT-SEC-02-A).
 *  3. An object above the declared sensitivity ceiling is never supplied. It is
 *     listed as a redaction instead, so the caller knows something exists and
 *     was withheld rather than believing memory is empty (CRT-SEC-09-A).
 *  4. A REDACT verdict naming fields removes exactly those fields from the packet
 *     and lists them in `redactions` (CRT-WRT-03-B).
 *  5. An action declared on the request is put to `EvaluateMemoryAction` against
 *     the purposes the evidence behind the retrieved memory admits, and a purpose
 *     that evidence never admitted is denied with no packet issued. The broker is
 *     the only memory read path a model or a plugin has (FR-060), so it is the
 *     only place an action founded on memory can be gated (CRT-SEC-02-A).
 *
 * After that the retrieval order of PRD §23.2 runs, and what it produces is a
 * bounded packet whose conflicts, unknowns, owner overlay deltas, projection
 * completeness and watermarks are all present rather than implied (CRT-RD-05-A).
 */

export const BROKER_VERSION = 'context-broker-0.3.0';
export const SELECTOR_VERSION = SELECTION_VERSION;
/** The route purpose the broker runs under. It appears in no INSERT, UPDATE or
 * DELETE policy on any canonical table: this path cannot write memory. */
export const CONTEXT_READ_PURPOSE = 'memory.read';
/** The Memory inspector's read purpose, which the explanation route uses. */
export const MEMORY_INSPECT_PURPOSE = 'memory.inspect';
/** The purpose the memory-thread attach runs under. */
export const MEMORY_THREAD_PURPOSE = 'memory.thread';
/** The port purpose an action founded on a packet is evaluated under. It is the
 * action port's vocabulary, not a route purpose: no route runs under it here, and
 * the broker writes nothing with it. */
export const CONTEXT_ACTION_PURPOSE = 'memory.act';

export class ContextBrokerError extends Error {
  readonly detail: Record<string, unknown>;
  constructor(code: string, detail: Record<string, unknown> = {}) {
    super(code); this.name = 'ContextBrokerError'; this.detail = detail;
  }
}

/**
 * The fields PRD §23.1 requires, checked on the raw request before retrieval.
 *
 * It is deliberately not a Zod refinement: the route has to be able to refuse
 * *before* it opens an owner transaction, and a caller has to be told which
 * declarations were missing rather than that "the body was invalid".
 */
export function missingContextFields(body: unknown): RequiredContextField[] {
  const object = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {};
  return REQUIRED_CONTEXT_FIELDS.filter(field => {
    const value = object[field];
    return value === undefined || value === null || value === '';
  });
}

/** PRD §23.3. A deterministic reading of the question, recorded on the packet, so
 * the plan a packet was built under is auditable and is never the model's own
 * choice of "what kind of question was that". */
export function classifyAnswerType(query: string): AnswerType {
  const text = query.toLowerCase();
  const has = (...words: string[]) => words.some(word => text.includes(word));
  if (has('why', 'because', 'caused', 'led to')) return 'CAUSAL_EXPLANATION';
  if (has('contradict', 'conflict', 'disagree')) return 'CONTRADICTION_DETECTION';
  if (has('did i predict', 'prediction', 'expected versus', 'turn out')) return 'PREDICTION_VERSUS_OUTCOME';
  if (has('decide', 'decision', 'chose', 'choice')) return 'DECISION_RECONSTRUCTION';
  if (has('owe', 'commitment', 'promised', 'promise', 'still owe')) return 'OPEN_COMMITMENTS';
  if (has('schedule', 'calendar', 'next week', 'upcoming', 'plan')) return 'FUTURE_PLANS';
  if (has('total', 'how much in', 'sum', 'average')) return 'AGGREGATION';
  if (has('source', 'where did', 'which email', 'which document')) return 'SOURCE_LOOKUP';
  if (has('used to', 'back then', 'at the time', 'historical')) return 'HISTORICAL_BELIEF_STATE';
  if (has('what did i believe', 'believed')) return 'HISTORICAL_BELIEF_STATE';
  if (has('corrected', 'actually was')) return 'CORRECTED_HISTORICAL_VALUE';
  if (has('remember when', 'that time', 'episode')) return 'EPISODE_RECALL';
  if (has('pattern', 'usually', 'tend to')) return 'PATTERN_REVIEW';
  return 'CURRENT_VALUE';
}

export interface ContextBrokerOptions {
  readonly ports?: PolicyPorts;
  readonly now?: Date;
  readonly registryReleaseId?: string | null;
  readonly registryRelease?: string | null;
  readonly correlationId: string;
  /** Bound on how many frame instances one packet may cover (PRD §23.2 step 12:
   * the packet is bounded, never "everything the owner has"). */
  readonly frameLimit?: number;
  /** A verdict already reached and already recorded, from `readContextPacket`'s
   * first transaction. Supplying it makes assembly run under exactly the
   * authority that was persisted, rather than asking the port a second question
   * whose answer nobody kept. */
  readonly authorization?: ContextAuthorization;
}

/** The decision one context read runs under, and the record of it. It is a value
 * rather than a thrown error so a denial can be committed before it is raised. */
export interface ContextAuthorization {
  readonly verdict: PolicyVerdict;
  readonly policyDecisionId: string;
  readonly labels: readonly EvidenceLabel[];
  readonly admitted: readonly string[];
}

/** A transaction runner the caller supplies, exactly as the belief governor takes
 * one: the broker needs *two* owner transactions, because a refusal that rolled
 * back with the work it refused would leave no record that anything was asked. */
export type ContextRunner = <T>(run: (tx: MemoryTransaction) => Promise<T>) => Promise<T>;

export interface EvidenceLabel {
  readonly evidenceId: string;
  readonly sensitivity: 'NORMAL' | 'PRIVATE' | 'RESTRICTED';
  readonly allowedPurposes: readonly string[];
}

const SENSITIVITY_ORDER = ['NORMAL', 'PRIVATE', 'RESTRICTED'] as const;

/**
 * The classification of the owner's own evidence, above the request ceiling.
 *
 * `unai_private.evidence_labels` answers the item id, its sensitivity and its
 * allowed purposes and nothing else -- no text, no object key, no anchor. The
 * broker needs exactly that much to be able to *list* what it withheld; reading
 * any of the content still goes through the row policies, which apply the
 * ceiling and the data purpose (CRT-SEC-09-A).
 */
async function readEvidenceLabels(tx: MemoryTransaction, ownerScopeId: string): Promise<EvidenceLabel[]> {
  const rows = (await tx.query(
    'SELECT source_item_id,sensitivity,allowed_purposes FROM unai_private.evidence_labels($1) ORDER BY source_item_id',
    [ownerScopeId])).rows;
  return rows.map(row => ({
    evidenceId: row['source_item_id'] as string,
    sensitivity: row['sensitivity'] as EvidenceLabel['sensitivity'],
    allowedPurposes: row['allowed_purposes'] as string[],
  }));
}

/** An object-level redaction hides the object; a field-level one hides named
 * fields of it. Both are listed; neither is silently dropped. */
function redactionIndex(verdict: PolicyVerdict): {
  objects: Set<string>; fields: Map<string, Set<string>>; listed: ContextRedaction[];
} {
  const objects = new Set<string>();
  const fields = new Map<string, Set<string>>();
  const listed: ContextRedaction[] = [];
  for (const entry of verdict.redactions) {
    const record = entry as Record<string, unknown>;
    const objectType = typeof record['objectType'] === 'string' ? record['objectType'] : 'unknown';
    const objectId = typeof record['objectId'] === 'string' ? record['objectId'] : '';
    if (!objectId) continue;
    const named = Array.isArray(record['fields']) ? (record['fields'] as unknown[]).filter((f): f is string => typeof f === 'string') : [];
    const reason = typeof record['reason'] === 'string' ? record['reason'] : 'REDACTED_BY_POLICY';
    // A verdict naming no field withholds the object. One naming a field the
    // packet cannot describe without it does too: the broker never supplies a
    // half-described object and calls it whole.
    if (named.length === 0 || named.some(name => !REDACTABLE_BELIEF_FIELDS.includes(name))) objects.add(objectId);
    else fields.set(objectId, new Set([...(fields.get(objectId) ?? []), ...named]));
    listed.push(contextRedactionSchema.parse({ objectType, objectId, fields: named, reason }));
  }
  return { objects, fields, listed };
}

/** Remove the named fields from one record and report which were actually there,
 * so a redaction can never claim to have removed a field the packet never had. */
function withoutFields<T extends Record<string, unknown>>(record: T, names: Set<string> | undefined): T {
  if (!names || names.size === 0) return record;
  const copy: Record<string, unknown> = { ...record };
  for (const name of names) delete copy[name];
  return copy as T;
}

/** Parse the request, refusing an incomplete or malformed one before anything
 * else happens. Shared by both entry points so neither can skip it. */
function parseContextRequest(raw: unknown): ContextRequest {
  const missing = missingContextFields(raw);
  if (missing.length > 0) throw new ContextBrokerError('CONTEXT_REQUEST_INCOMPLETE', { missing });
  const parsed = contextRequestSchema.safeParse(raw);
  if (!parsed.success) throw new ContextBrokerError('CONTEXT_REQUEST_INVALID');
  return parsed.data;
}

/** The declared data purpose and the ceiling, as transaction-local settings, so
 * the row policies apply the same authority the port evaluated: a later query in
 * this transaction cannot widen what the request declared. */
async function declareReadAuthority(tx: MemoryTransaction, request: ContextRequest): Promise<void> {
  await tx.query("SELECT set_config('unai.data_purpose',$1,true),set_config('unai.maximum_sensitivity',$2,true)",
    [request.purpose, request.maximumSensitivity]);
}

/**
 * Step 1 of PRD §23.2: authorize purpose, actor, owner scope and sensitivity, and
 * record the verdict.
 *
 * It returns the decision rather than raising it, because a denial has to be
 * *kept*: `readContextPacket` commits this transaction before it refuses, so the
 * Audit log can show a read that was asked for and turned down (PRD §29.3,
 * CRT-SEC-02-A). Nothing is retrieved here beyond the evidence classifications
 * the decision is made over.
 */
export async function authorizeContextRead(
  tx: MemoryTransaction, request: ContextRequest, options: ContextBrokerOptions,
): Promise<ContextAuthorization> {
  const ports = options.ports ?? createLocalPolicyAdapters();
  await declareReadAuthority(tx, request);
  const labels = await readEvidenceLabels(tx, request.ownerScopeId);
  const admitted = labels.filter(label => label.allowedPurposes.includes(request.purpose));
  // The port speaks route purposes; the evidence records data purposes. The
  // translation is explicit: the read purpose is admitted exactly when the
  // owner's evidence admits the declared data purpose. An owner with no evidence
  // at all has no evidence that refuses it (CRT-SEC-02-A).
  const purposeAdmitted = labels.length === 0 || admitted.length > 0;
  const verdict = await ports.evaluateMemoryRead({
    actorId: request.requestingActorId, ownerScopeId: request.ownerScopeId, purpose: CONTEXT_READ_PURPOSE,
    sensitivity: request.maximumSensitivity, risk: request.actionRisk,
    evidenceRefs: admitted.map(label => label.evidenceId),
    maximumSensitivity: request.maximumSensitivity,
    allowedPurposes: purposeAdmitted ? [CONTEXT_READ_PURPOSE] : [],
    requestedObjects: admitted.map(label => ({
      objectType: 'source_items', objectId: label.evidenceId, sensitivity: label.sensitivity,
    })),
  });
  const policyDecisionId = await recordPolicyDecision(tx, {
    ownerScopeId: request.ownerScopeId, correlationId: options.correlationId, port: 'EvaluateMemoryRead',
    request: {
      purpose: request.purpose, routePurpose: CONTEXT_READ_PURPOSE,
      answerType: request.answerType ?? classifyAnswerType(request.query),
      maximumSensitivity: request.maximumSensitivity, actionRisk: request.actionRisk,
      lifeCategory: request.lifeCategory ?? categoryOfPurpose(request.purpose),
      evidenceConsidered: labels.length, evidenceAdmittedByPurpose: admitted.length,
    },
    verdict,
  });
  return { verdict, policyDecisionId, labels, admitted: admitted.map(label => label.evidenceId) };
}

/** Whether a recorded verdict lets the retrieval run at all. */
function allowsRetrieval(authorization: ContextAuthorization): boolean {
  return authorization.verdict.outcome === 'ALLOW' || authorization.verdict.outcome === 'REDACT';
}

/**
 * The Context Broker's entry point for a caller that can open transactions
 * (the route, and any service composing it).
 *
 * It uses two, in the order the belief governor uses two: the first authorizes
 * and *commits the decision*, the second retrieves and assembles under exactly
 * the authority that was recorded. A denial is therefore durable before it is
 * raised, and no retrieval ever runs ahead of the verdict that permitted it.
 */
async function readContextPacketImpl(
  runner: ContextRunner, raw: unknown, options: ContextBrokerOptions,
): Promise<ContextPacket> {
  const request = parseContextRequest(raw);
  const authorization = await runner(tx => authorizeContextRead(tx, request, options));
  if (!allowsRetrieval(authorization)) {
    throw new ContextBrokerError('CONTEXT_READ_DENIED', {
      reason: authorization.verdict.reason, policyDecisionId: authorization.policyDecisionId,
    });
  }
  // A refused action comes back as a value, for the same reason a refused read
  // does: the second transaction has to commit the decision it reached before the
  // refusal is raised, and a throw would roll that decision back with it.
  const result = await runner(tx => assemble(tx, request, { ...options, authorization }));
  if ('denial' in result) throw new ContextBrokerError(result.denial.code, result.denial.detail);
  return result.packet;
}

/** The outcome of one assembly. A denial names a decision that is already in
 * `policy_decisions`; no packet exists for it. */
type AssemblyResult =
  | { readonly packet: ContextPacket }
  | { readonly denial: { readonly code: string; readonly detail: Record<string, unknown> } };

/**
 * Assemble one context packet inside a transaction the caller opened.
 *
 * With `options.authorization` it runs under the verdict `readContextPacket`
 * already recorded. Without one it authorizes inline and refuses in place, which
 * is what a caller holding a single transaction can do: the decision then rolls
 * back with the refusal, so the durable record is `readContextPacket`'s. The same
 * is true of a refused action: this entry point raises it, and only the two
 * transactions of `readContextPacket` keep the verdict behind it.
 */
export async function assembleContextPacket(
  tx: MemoryTransaction, raw: unknown, options: ContextBrokerOptions,
): Promise<ContextPacket> {
  const result = await assemble(tx, raw, options);
  if ('denial' in result) throw new ContextBrokerError(result.denial.code, result.denial.detail);
  return result.packet;
}

async function assemble(
  tx: MemoryTransaction, raw: unknown, options: ContextBrokerOptions,
): Promise<AssemblyResult> {
  // Parsing is idempotent, so `readContextPacket` may hand its already-parsed
  // request straight back in without a second shape of this function existing.
  const request: ContextRequest = parseContextRequest(raw);
  const now = options.now ?? new Date();
  const worldTime = request.worldTime === 'NOW' ? now : new Date(request.worldTime);
  const knowledgeTime = request.knowledgeTime === 'LATEST' ? now : new Date(request.knowledgeTime);
  // A caller that already classified the question (the Ask pipeline) declares the
  // mode; otherwise the broker reads it from the query text.
  const answerType = answerTypeSchema.parse(request.answerType ?? classifyAnswerType(request.query));
  const category: LifeCategory | null = request.lifeCategory ?? categoryOfPurpose(request.purpose);
  const frameLimit = Math.min(Math.max(options.frameLimit ?? 100, 1), 500);

  // Step 1 of PRD §23.2, once per transaction: the settings the row policies read
  // are transaction-local, so they are re-declared here even when the verdict
  // itself was reached in the transaction before this one.
  await declareReadAuthority(tx, request);
  const authorization = options.authorization ?? await authorizeContextRead(tx, request, options);
  if (!allowsRetrieval(authorization)) {
    throw new ContextBrokerError('CONTEXT_READ_DENIED', {
      reason: authorization.verdict.reason, policyDecisionId: authorization.policyDecisionId,
    });
  }
  const { verdict, policyDecisionId, labels } = authorization;
  const admitted = labels.filter(label => authorization.admitted.includes(label.evidenceId));
  const redactions = redactionIndex(verdict);
  const withheldEvidence = new Set(labels
    .filter(label => !authorization.admitted.includes(label.evidenceId)
      || SENSITIVITY_ORDER.indexOf(label.sensitivity) > SENSITIVITY_ORDER.indexOf(request.maximumSensitivity)
      || redactions.objects.has(label.evidenceId))
    .map(label => label.evidenceId));
  const readableEvidenceIds = admitted.filter(label => !withheldEvidence.has(label.evidenceId)).map(label => label.evidenceId);
  const historicalRecall = new Set<AnswerType>(['HISTORICAL_BELIEF_STATE', 'CORRECTED_HISTORICAL_VALUE',
    'DECISION_RECONSTRUCTION', 'EPISODE_RECALL', 'CAUSAL_EXPLANATION', 'SOURCE_LOOKUP',
    'PATTERN_REVIEW', 'PREDICTION_VERSUS_OUTCOME']).has(answerType);
  // Removal is present access authority, independent of permission to read the
  // owner's explanation or the historical instant being queried. Read only the
  // control targets here; private correction text still uses the bounded overlay.
  const removalRows = (await tx.query(
    `SELECT target_object_id FROM owner_overlay_deltas WHERE owner_scope_id=$1
       AND (delta_kind IN ('SUPPRESSION','DELETION') OR (delta_kind='ARCHIVE' AND $2))
       AND lifecycle NOT IN ('WITHDRAWN','REJECTED_AS_INTERPRETATION')
       AND target_object_id IS NOT NULL`, [request.ownerScopeId, !historicalRecall])).rows;
  const removedFromRetrieval = new Set(removalRows.map(row => row['target_object_id'] as string));
  if (removedFromRetrieval.size > 0) {
    const removedValues = (await tx.query(
      `SELECT p.id FROM propositions p JOIN belief_slots s ON s.owner_scope_id=p.owner_scope_id AND s.id=p.belief_slot_id
       WHERE p.owner_scope_id=$1 AND (s.id=ANY($2::uuid[]) OR s.frame_instance_id=ANY($2::uuid[]))`,
      [request.ownerScopeId, [...removedFromRetrieval]])).rows;
    for (const row of removedValues) removedFromRetrieval.add(row['id'] as string);
  }

  const unknowns: Array<z.infer<typeof contextUnknownSchema>> = [];
  // An object the owner holds and this request may not see is an unknown *and* a
  // redaction: the answer must be able to say "there is something here I did not
  // read" without saying what it was.
  for (const evidenceId of withheldEvidence) {
    unknowns.push(contextUnknownSchema.parse({
      kind: 'EVIDENCE_WITHHELD', objectType: 'source_items', objectId: evidenceId,
      detail: !authorization.admitted.includes(evidenceId) ? 'SOURCE_PURPOSE_WITHHELD'
        : labels.some(label => label.evidenceId === evidenceId
          && SENSITIVITY_ORDER.indexOf(label.sensitivity) > SENSITIVITY_ORDER.indexOf(request.maximumSensitivity))
          ? 'ABOVE_MAXIMUM_SENSITIVITY' : 'EVIDENCE_REDACTED_BY_POLICY',
    }));
  }

  // Step 2: resolve the query's entities. A hint that resolves to nothing is an
  // unknown, never a silently empty filter.
  const entityIds: string[] = [];
  if (request.entityHints.length > 0) {
    const rows = (await tx.query('SELECT id FROM entities WHERE owner_scope_id=$1 AND id=ANY($2::uuid[])',
      [request.ownerScopeId, [...request.entityHints]])).rows;
    const found = new Set(rows.map(row => row['id'] as string));
    entityIds.push(...found);
    for (const hint of request.entityHints) {
      if (!found.has(hint)) {
        unknowns.push(contextUnknownSchema.parse({
          kind: 'ENTITY_UNRESOLVED', objectType: 'entities', objectId: hint, detail: 'ENTITY_HINT_UNRESOLVED',
        }));
      }
    }
  }

  // The frame instances this request is about: everything the hints intersect,
  // or the owner's most recent frames when the question names none.
  const threadFrames = request.worldlineHints.length === 0 ? [] : (await tx.query(
    `SELECT object_id FROM memory_thread_members WHERE owner_scope_id=$1 AND memory_thread_id=ANY($2::uuid[])
       AND object_type='frame_instance'`, [request.ownerScopeId, [...request.worldlineHints]])).rows
    .map(row => row['object_id'] as string);
  const hinted = entityIds.length > 0 || threadFrames.length > 0 || request.frameTypeHints.length > 0;
  const frameRows = (await tx.query(
    `SELECT f.id,f.frame_type_id,f.created_at FROM frame_instances f
     WHERE f.owner_scope_id=$1 AND f.lifecycle<>'RETIRED'
       AND ($2=false OR f.id=ANY($3::uuid[]) OR f.frame_type_id=ANY($4::text[])
         OR EXISTS(SELECT 1 FROM frame_instance_roles r WHERE r.owner_scope_id=f.owner_scope_id
           AND r.frame_instance_id=f.id AND r.entity_id=ANY($5::uuid[])))
     ORDER BY f.created_at DESC,f.id DESC LIMIT $6`,
    [request.ownerScopeId, hinted, threadFrames, [...request.frameTypeHints], entityIds, frameLimit])).rows;
  // The category view is *not* applied here. A frame's registry namespace is only
  // half of what places it in a view: the other half is the evidence behind each
  // value, which is known one step further down. Filtering frames on the namespace
  // alone would drop the finance-and-family item from the family view even though
  // one evidence row admits both purposes (CRT-MEM-02-A).
  const frames = frameRows
    .filter(row => !removedFromRetrieval.has(row['id'] as string))
    .map(row => ({ frameInstanceId: row['id'] as string, frameTypeId: row['frame_type_id'] as string }));
  const frameIds = frames.map(frame => frame.frameInstanceId);
  const frameTypeById = new Map(frames.map(frame => [frame.frameInstanceId, frame.frameTypeId]));

  // Steps 6 and 7: the propositions in those frames with the assessment that
  // stood over each of them at the knowledge time, the claims behind them and the
  // evidence those claims are anchored in. One query, because "which evidence
  // supports this value" is the question every later step asks. The assessment is
  // the version live at the knowledge time -- recorded by then and not yet
  // superseded then -- which is what "what did Uai believe then" means (PRD
  // §12.3); the live row alone would answer "now" for every knowledge time.
  const beliefRows = frameIds.length === 0 ? [] : (await tx.query(
    `SELECT p.id AS proposition_id,p.belief_slot_id,p.normalized_value,p.polarity,p.lifecycle AS proposition_lifecycle,
       s.frame_instance_id,s.predicate_id,s.modality,
       (SELECT b.assessment_status FROM belief_assessments b WHERE b.owner_scope_id=p.owner_scope_id
          AND b.proposition_id=p.id AND b.recorded_at<=$3
          AND (b.superseded_recorded_at IS NULL OR b.superseded_recorded_at>$3)
          ORDER BY b.recorded_at DESC,b.id DESC LIMIT 1) AS assessment_status,
       (SELECT b.recorded_at FROM belief_assessments b WHERE b.owner_scope_id=p.owner_scope_id
          AND b.proposition_id=p.id AND b.recorded_at<=$3
          AND (b.superseded_recorded_at IS NULL OR b.superseded_recorded_at>$3)
          ORDER BY b.recorded_at DESC,b.id DESC LIMIT 1) AS assessment_recorded_at,
       (SELECT b.valid_from FROM belief_assessments b WHERE b.owner_scope_id=p.owner_scope_id
          AND b.proposition_id=p.id AND b.recorded_at<=$3
          AND (b.superseded_recorded_at IS NULL OR b.superseded_recorded_at>$3)
          ORDER BY b.recorded_at DESC,b.id DESC LIMIT 1) AS assessment_valid_from,
       (SELECT b.valid_to FROM belief_assessments b WHERE b.owner_scope_id=p.owner_scope_id
          AND b.proposition_id=p.id AND b.recorded_at<=$3
          AND (b.superseded_recorded_at IS NULL OR b.superseded_recorded_at>$3)
          ORDER BY b.recorded_at DESC,b.id DESC LIMIT 1) AS assessment_valid_to,
       (SELECT min(c.valid_from) FROM claims c WHERE c.owner_scope_id=p.owner_scope_id AND c.proposition_id=p.id
          AND c.recorded_at<=$3) AS valid_from,
       (SELECT max(c.valid_to) FROM claims c WHERE c.owner_scope_id=p.owner_scope_id AND c.proposition_id=p.id
          AND c.recorded_at<=$3) AS valid_to,
       coalesce((SELECT array_agg(DISTINCT c.id) FROM claims c WHERE c.owner_scope_id=p.owner_scope_id
          AND c.proposition_id=p.id AND c.recorded_at<=$3),'{}') AS claim_ids,
       (SELECT count(*)::int FROM claims c WHERE c.owner_scope_id=p.owner_scope_id AND c.proposition_id=p.id
          AND c.recorded_at<=$3) AS claim_count,
       coalesce((SELECT array_agg(DISTINCT a.source_item_id) FROM claims c
          JOIN source_anchors a ON a.owner_scope_id=c.owner_scope_id AND a.id=c.source_anchor_id
          WHERE c.owner_scope_id=p.owner_scope_id AND c.proposition_id=p.id AND c.recorded_at<=$3),'{}') AS evidence_ids,
       coalesce((SELECT array_agg(DISTINCT c.claim_origin) FROM claims c WHERE c.owner_scope_id=p.owner_scope_id
          AND c.proposition_id=p.id AND c.recorded_at<=$3),'{}') AS claim_origins
     FROM propositions p
     JOIN belief_slots s ON s.owner_scope_id=p.owner_scope_id AND s.id=p.belief_slot_id
     WHERE p.owner_scope_id=$1 AND s.frame_instance_id=ANY($2::uuid[])
       AND (EXISTS(SELECT 1 FROM claims c WHERE c.owner_scope_id=p.owner_scope_id AND c.proposition_id=p.id AND c.recorded_at<=$3)
         OR EXISTS(SELECT 1 FROM belief_assessments b WHERE b.owner_scope_id=p.owner_scope_id
           AND b.proposition_id=p.id AND b.recorded_at<=$3))
     ORDER BY s.frame_instance_id,s.id,p.id`,
    [request.ownerScopeId, frameIds, knowledgeTime])).rows;

  const supportAuthority = await readPropositionAuthority(tx, {
    ownerScopeId: request.ownerScopeId,
    propositionIds: beliefRows.map(row => row['proposition_id'] as string), knowledgeTime, readableEvidenceIds,
    withheldObjectIds: redactions.objects,
    withheldValueIds: new Set([...redactions.fields].filter(([, fields]) => fields.has('normalizedValue')).map(([id]) => id)),
    removedObjectIds: removedFromRetrieval,
  });
  const authorizedClaimIds = new Set([...supportAuthority.values()].flatMap(authority => authority.claimIds));
  const authorizedClaimRows = authorizedClaimIds.size === 0 ? [] : (await tx.query(
    `SELECT id,claim_origin,valid_from,valid_to FROM claims
     WHERE owner_scope_id=$1 AND id=ANY($2::uuid[]) ORDER BY id`,
    [request.ownerScopeId, [...authorizedClaimIds]])).rows;
  const authorizedClaims = new Map(authorizedClaimRows.map(row => [row['id'] as string, row]));
  for (const [id, authority] of supportAuthority) {
    if (authority.claimIds.some(claimId => !authorizedClaims.has(claimId))) {
      supportAuthority.set(id, { readable: false, evidenceIds: [], claimIds: [] });
    }
  }

  const FUTURE_MODALITIES = new Set(['SCHEDULED', 'INTENDED', 'COMMITTED', 'EXPECTED', 'PREDICTED', 'RECOMMENDED', 'CONDITIONAL']);
  const certaintyOf = (status: string | null): 'ACCEPTED' | 'PROVISIONAL' | 'CONTESTED' =>
    status === 'ACCEPTED' ? 'ACCEPTED' : status === 'CONTESTED' ? 'CONTESTED' : 'PROVISIONAL';

  const currentBeliefs: Array<z.infer<typeof contextBeliefSchema>> = [];
  const historicalBeliefs: Array<z.infer<typeof contextBeliefSchema>> = [];
  const futureClaims: Array<z.infer<typeof contextFutureClaimSchema>> = [];
  const evidenceInPacket = new Set<string>();
  const bySlot = new Map<string, Array<Record<string, unknown>>>();
  // What the selector must treat as not a candidate: a proposition the read
  // policy withheld, and one outside the requested life-category view.
  const outOfView = new Set<string>();

  for (const row of beliefRows) {
    const slotId = row['belief_slot_id'] as string;
    bySlot.set(slotId, [...(bySlot.get(slotId) ?? []), row]);
    const propositionId = row['proposition_id'] as string;
    if (removedFromRetrieval.has(propositionId)) { outOfView.add(propositionId); continue; }
    if (redactions.objects.has(propositionId)) continue;
    const frameInstanceId = row['frame_instance_id'] as string;
    const frameTypeId = frameTypeById.get(frameInstanceId) ?? '';
    const authority = supportAuthority.get(propositionId);
    const evidenceIds = authority?.evidenceIds ?? [];
    // Leaf claims of a computation are citations, not direct assertions of its
    // output. Intersect only this proposition's direct claims with its proof;
    // hidden assertions must not supply attribution or widen the valid interval.
    const directClaimIds = ((row['claim_ids'] as string[] | null) ?? [])
      .filter(id => authority?.claimIds.includes(id)).sort();
    const directClaims = directClaimIds.map(id => authorizedClaims.get(id)!);
    row['claim_ids'] = directClaimIds;
    row['claim_origins'] = [...new Set(directClaims.map(claim => claim['claim_origin'] as string))].sort();
    const froms = directClaims.flatMap(claim => claim['valid_from'] ? [claim['valid_from'] as Date] : []);
    const tos = directClaims.flatMap(claim => claim['valid_to'] ? [claim['valid_to'] as Date] : []);
    row['valid_from'] = froms.length === 0 ? null : new Date(Math.min(...froms.map(date => date.getTime())));
    row['valid_to'] = tos.length === 0 ? null : new Date(Math.max(...tos.map(date => date.getTime())));
    // An assessment grants no source authority. A zero-direct-claim derivation
    // needs a complete readable input path just as a direct value needs a source.
    // Store only its authorized proof so conflicts and every temporal surface
    // inherit exactly the same citations.
    row['evidence_ids'] = evidenceIds;
    if (!authority?.readable) {
      redactions.listed.push(contextRedactionSchema.parse({
        objectType: 'propositions', objectId: propositionId, fields: [], reason: 'SUPPORTING_EVIDENCE_WITHHELD',
      }));
      redactions.objects.add(propositionId);
      continue;
    }
    const categories = deriveLifeCategories({
      frameTypeId,
      allowedPurposes: labels.filter(label => evidenceIds.includes(label.evidenceId)).flatMap(label => [...label.allowedPurposes]),
    });
    if (!inCategoryView(category, categories)) { outOfView.add(propositionId); continue; }
    for (const evidenceId of evidenceIds) evidenceInPacket.add(evidenceId);
    const status = (row['assessment_status'] as string | null) ?? null;
    const certainty = certaintyOf(status);
    // The valid interval is the verdict's when it states one -- a change closes
    // the earlier value's period on its assessment, not on its claim -- and the
    // claims' otherwise.
    const validFrom = (row['assessment_valid_from'] as Date | null) ?? (row['valid_from'] as Date | null) ?? null;
    const validTo = (row['assessment_valid_to'] as Date | null) ?? (row['valid_to'] as Date | null) ?? null;
    const modality = row['modality'] as string;
    if (FUTURE_MODALITIES.has(modality)) {
      futureClaims.push(contextFutureClaimSchema.parse(withoutFields({
        propositionId, frameInstanceId, frameTypeId, predicateId: row['predicate_id'], modality,
        normalizedValue: row['normalized_value'],
        validFrom: validFrom ? validFrom.toISOString() : null,
        lifeCategories: categories, evidenceIds,
      }, redactions.fields.get(propositionId))));
      continue;
    }
    // A known actual assertion whose interval has not begun is neither current
    // nor historical at this world time. An explicit query for its applicable
    // future interval may still retrieve it.
    if (validFrom !== null && validFrom.getTime() > worldTime.getTime()) continue;
    // The redaction is applied to the record before it is parsed, so a withheld
    // field is absent from the packet rather than present and emptied.
    const belief = contextBeliefSchema.parse(withoutFields({
      propositionId, beliefSlotId: slotId, frameInstanceId, frameTypeId,
      predicateId: row['predicate_id'], modality, polarity: row['polarity'],
      normalizedValue: row['normalized_value'], assessmentStatus: status,
      assessmentRecordedAt: row['assessment_recorded_at'] ? (row['assessment_recorded_at'] as Date).toISOString() : null,
      validFrom: validFrom ? validFrom.toISOString() : null,
      validTo: validTo ? validTo.toISOString() : null,
      certainty, lifeCategories: categories,
      claimIds: (row['claim_ids'] as string[] | null) ?? [], evidenceIds,
      selectionReason: status === 'SUPERSEDED' ? 'SUPERSEDED_BY_LATER_BELIEF'
        : validTo !== null && validTo.getTime() <= worldTime.getTime() ? 'VALID_PERIOD_CLOSED_BEFORE_WORLD_TIME'
          : 'VALID_AT_WORLD_TIME_AND_KNOWLEDGE_TIME',
    }, redactions.fields.get(propositionId)));
    // Step 1 of PRD §23.4: valid time decides current from historical, and the
    // belief lifecycle decides nothing else about it.
    const historical = (validTo !== null && validTo.getTime() <= worldTime.getTime()) || status === 'SUPERSEDED';
    (historical ? historicalBeliefs : currentBeliefs).push(belief);
  }

  // Step 7: competing beliefs. Two live propositions in one slot are a conflict
  // the packet reports and never resolves (PRD §16.5, CRT-MEM-08-A). "Live" is at
  // the world time as well: a value whose verdict closed its period before then
  // was superseded by a change, which is history, not a disagreement.
  const heldAtWorldTime = (row: Record<string, unknown>) => {
    const from = (row['assessment_valid_from'] as Date | null) ?? (row['valid_from'] as Date | null) ?? null;
    const to = (row['assessment_valid_to'] as Date | null) ?? (row['valid_to'] as Date | null) ?? null;
    return (from === null || from.getTime() <= worldTime.getTime()) && (to === null || to.getTime() > worldTime.getTime());
  };
  const conflicts = [];
  for (const [slotId, rows] of bySlot) {
    const live = rows.filter(row => {
      const status = (row['assessment_status'] as string | null) ?? null;
      return row['proposition_lifecycle'] !== 'RETIRED' && status !== 'REJECTED' && status !== 'SUPERSEDED'
        && heldAtWorldTime(row) && !redactions.objects.has(row['proposition_id'] as string)
        && !removedFromRetrieval.has(row['proposition_id'] as string);
    });
    if (live.length < 2) continue;
    const first = live[0]!;
    if (!inCategoryView(category, deriveLifeCategories({ frameTypeId: frameTypeById.get(first['frame_instance_id'] as string) ?? '' }))) continue;
    conflicts.push(contextConflictSchema.parse({
      beliefSlotId: slotId, frameInstanceId: first['frame_instance_id'], predicateId: first['predicate_id'],
      reason: 'COMPETING_LIVE_PROPOSITIONS_IN_ONE_SLOT',
      // A position is the same value said again, so the same redaction applies:
      // a field removed from a belief is removed here too, or the packet would
      // have supplied through the conflict what the verdict withheld from the
      // belief (CRT-WRT-03-B).
      positions: live.map(row => withoutFields({
        propositionId: row['proposition_id'], normalizedValue: row['normalized_value'],
        assessmentStatus: (row['assessment_status'] as string | null) ?? null,
        claimOrigins: (row['claim_origins'] as string[] | null) ?? [],
        evidenceIds: ((row['evidence_ids'] as string[] | null) ?? []).filter(id => !withheldEvidence.has(id)),
      }, redactions.fields.get(row['proposition_id'] as string))),
    }));
  }

  // A slot with no accepted value is an unknown the answer has to be able to say
  // out loud, rather than presenting the strongest candidate as settled.
  for (const [slotId, rows] of bySlot) {
    if (rows.some(row => row['assessment_status'] === 'ACCEPTED')) continue;
    if (rows.every(row => redactions.objects.has(row['proposition_id'] as string))) continue;
    unknowns.push(contextUnknownSchema.parse({
      kind: 'NO_ACCEPTED_VALUE', objectType: 'belief_slots', objectId: slotId, detail: 'NO_ACCEPTED_ASSESSMENT',
    }));
  }

  // Step 5: the owner's overlay, including the deltas that have no frame yet.
  const overlay = await readOwnerOverlay(tx, { ownerScopeId: request.ownerScopeId, knowledgeTime, readableEvidenceIds });
  const attachedToPacket = new Set(frameIds);
  const relevant = overlay.deltas.filter(delta =>
    (delta.attachedFrameInstanceId !== null && attachedToPacket.has(delta.attachedFrameInstanceId))
    || (delta.target !== null && delta.target.objectType === 'proposition'
      && [...currentBeliefs, ...historicalBeliefs].some(belief => belief.propositionId === delta.target!.objectId)));

  // PRD §21.4 and CRT-RYW-03-A: a delta in AWAITING_INSTANCE_RESOLUTION with no
  // attached frame is retrieved when the query intersects it through *any one* of
  // candidate entity, candidate memory thread, discourse anchor or candidate frame
  // type. Each arm stands alone, so "I paid him back" does not disappear because
  // synchronous canonicalization could not name the obligation.
  const unattachedRows = (await tx.query(
    `SELECT id FROM owner_overlay_deltas
     WHERE owner_scope_id=$1 AND lifecycle='AWAITING_INSTANCE_RESOLUTION' AND attached_frame_instance_id IS NULL
       AND (candidate_entity_refs && $2::uuid[]
         OR candidate_worldline_refs && $3::uuid[]
         OR (discourse_anchor IS NOT NULL AND discourse_anchor=ANY($4::text[]))
         OR candidate_frame_types && $5::text[])
     ORDER BY owner_sequence`,
    [request.ownerScopeId, [...request.entityHints], [...request.worldlineHints],
      [...request.discourseAnchors], [...request.frameTypeHints]])).rows;
  const eligibleOverlayIds = new Set(overlay.deltas.map(delta => delta.overlayDeltaId));
  const unattachedIds = new Set(unattachedRows.map(row => row['id'] as string).filter(id => eligibleOverlayIds.has(id)));
  const ownerOverlayDeltas = [...relevant, ...overlay.deltas.filter(delta => unattachedIds.has(delta.overlayDeltaId))]
    .filter((delta, index, all) => all.findIndex(other => other.overlayDeltaId === delta.overlayDeltaId) === index)
    .filter(delta => !redactions.objects.has(delta.overlayDeltaId));
  for (const id of unattachedIds) {
    unknowns.push(contextUnknownSchema.parse({
      kind: 'UNATTACHED_OWNER_ASSERTION', objectType: 'owner_overlay_deltas', objectId: id,
      detail: 'AWAITING_INSTANCE_RESOLUTION',
    }));
  }

  // PRD §23.4: the deterministic selection over every slot of those frames. It is
  // a pure function of the rows and the request's two instants, so the same
  // memory and the same request select the same state for the same reason on
  // every run -- no model, no clock, no row order decides "the latest"
  // (CRT-RD-03-A). A value under a contract the pinned release does not hold is
  // never selected (CRT-REG-04-A).
  const selections = (await selectCurrentStates(tx, {
    ownerScopeId: request.ownerScopeId, frameInstanceIds: frameIds, registryReleaseId: options.registryReleaseId ?? null,
    parameters: {
      worldTime: worldTime.toISOString(), knowledgeTime: knowledgeTime.toISOString(),
      modalities: modalitiesForAnswerType(answerType), admitProvisional: request.requiredCertainty.includes('PROVISIONAL'),
    },
    withheldPropositionIds: redactions.objects, outOfViewPropositionIds: outOfView, overlayDeltas: ownerOverlayDeltas,
    allowedClaimIds: authorizedClaimIds,
  })).map(selection => {
    // A readable proposition may have both readable and withheld support. Its
    // citations still have to obey the source policy applied to the packet.
    const authorizedSelection = { ...selection,
      ...(selection.evidenceIds === undefined ? {} : {
        evidenceIds: selection.selectedPropositionId
          ? supportAuthority.get(selection.selectedPropositionId)?.evidenceIds ?? []
          : selection.evidenceIds.filter(id => !withheldEvidence.has(id)),
      }) };
    // A field-level redaction over the selected value reaches the selection too,
    // or the selection would state what the belief was not allowed to.
    const fields = selection.selectedPropositionId ? redactions.fields.get(selection.selectedPropositionId) : undefined;
    if (!fields || fields.size === 0) return authorizedSelection;
    const withheldFields = new Set([...fields].map(name => name === 'normalizedValue' ? 'selectedValue' : name));
    return withoutFields(authorizedSelection, withheldFields);
  });
  const registeredBySlot = new Map(selections.map(selection => [selection.beliefSlotId, selection.predicateRegistered]));

  // Step 10: semantic search, only after the hard filters. Owner, permission and
  // sensitivity are the request's own declarations; knowledge time, the time
  // window, source types and the entity hints narrow further. The ranking sees
  // the filtered rows and no others, so the nearest embedding never crosses a
  // boundary the request drew (CRT-RD-04-A).
  const semantic = await searchMemoryEmbeddings(tx, {
    ownerScopeId: request.ownerScopeId, query: request.query, dataPurpose: request.purpose,
    maximumSensitivity: request.maximumSensitivity, knowledgeTime,
    timeWindow: request.timeWindow ? {
      from: request.timeWindow.from ? new Date(request.timeWindow.from) : null,
      to: request.timeWindow.to ? new Date(request.timeWindow.to) : null,
    } : null,
    entityIds: request.entityHints.length > 0 ? request.entityHints : null,
    sourceTypes: request.sourceTypes.length > 0 ? request.sourceTypes : null,
    registryReleaseId: options.registryReleaseId ?? null, limit: 10,
  });
  // What the owner removed from normal retrieval, or a verdict withheld, is not
  // recalled by similarity either. Dropping after ranking only ever narrows.
  const semanticSearch = semantic === null ? null : {
    ...semantic,
    matches: semantic.matches.filter(match => !removedFromRetrieval.has(match.objectId)
      && !redactions.objects.has(match.objectId)
      && !match.evidenceIds.some(id => withheldEvidence.has(id))
      && !(match.propositionId !== null && (removedFromRetrieval.has(match.propositionId) || redactions.objects.has(match.propositionId)))),
  };
  const semanticEvidence = new Set((semanticSearch?.matches ?? []).flatMap(match => match.evidenceIds));

  // Steps 3 and 4: the typed projection state, with its completeness and its
  // watermarks carried rather than implied.
  const suppliedFrameIds = [...new Set([...currentBeliefs, ...historicalBeliefs, ...futureClaims]
    .map(belief => belief.frameInstanceId))];
  const projectionFragments = await readProjectionFragments(tx, {
    ownerScopeId: request.ownerScopeId, asOf: worldTime,
    frameInstanceIds: suppliedFrameIds,
    authorizedOverlayDeltas: ownerOverlayDeltas,
  });
  for (const fragment of projectionFragments) {
    if (fragment.isComplete) continue;
    unknowns.push(contextUnknownSchema.parse({
      kind: 'PROJECTION_INCOMPLETE', objectType: 'projections', objectId: fragment.projectionName,
      detail: 'PROJECTION_READ_INCOMPLETE',
    }));
  }

  // Step 8: the accepted outcome authority over those frames.
  const resolutionRows = frameIds.length === 0 ? [] : (await tx.query(
    `SELECT r.id,r.source_frame_instance_id,r.target_frame_instance_id,r.outcome_code,r.effective_at,r.lifecycle,r.transition_contract_id
     FROM resolution_assertions r JOIN claims c ON c.owner_scope_id=r.owner_scope_id AND c.id=r.claim_id
     JOIN source_anchors a ON a.owner_scope_id=c.owner_scope_id AND a.id=c.source_anchor_id
     WHERE r.owner_scope_id=$1
       AND (r.source_frame_instance_id=ANY($2::uuid[]) OR r.target_frame_instance_id=ANY($2::uuid[]))
       AND r.recorded_at<=$3 AND c.recorded_at<=$3 AND r.effective_at<=$4
       AND a.source_item_id=ANY($5::uuid[])
     ORDER BY r.effective_at,r.id`, [request.ownerScopeId, frameIds, knowledgeTime, worldTime, readableEvidenceIds])).rows;
  const resolutionAssertions = resolutionRows.filter(row => !redactions.objects.has(row['id'] as string)
    && !removedFromRetrieval.has(row['id'] as string)
    && !removedFromRetrieval.has(row['source_frame_instance_id'] as string)
    && !removedFromRetrieval.has(row['target_frame_instance_id'] as string))
    .map(row => contextResolutionSchema.parse({
    resolutionAssertionId: row['id'], sourceFrameInstanceId: row['source_frame_instance_id'],
    targetFrameInstanceId: (row['target_frame_instance_id'] as string | null) ?? null,
    outcomeCode: row['outcome_code'], effectiveAt: (row['effective_at'] as Date).toISOString(),
    lifecycle: row['lifecycle'], transitionContractId: row['transition_contract_id'],
  }));

  // Step 9: the original evidence, when grounding needs it. `NEVER` still leaves
  // the redactions and the unknowns in place: what was withheld is still said.
  const evidenceRefs = [];
  if (request.includeEvidence !== 'NEVER') {
    const wanted = request.includeEvidence === 'ALWAYS'
      ? admitted.filter(label => !withheldEvidence.has(label.evidenceId)).map(label => label.evidenceId)
      : [...new Set([...evidenceInPacket, ...semanticEvidence])];
    if (wanted.length > 0) {
      const rows = (await tx.query(
        `SELECT s.id,s.source_type,s.sensitivity,s.occurred_at,s.allowed_purposes,
           coalesce((SELECT array_agg(a.id ORDER BY a.id) FROM source_anchors a
             WHERE a.owner_scope_id=s.owner_scope_id AND a.source_item_id=s.id),'{}') AS anchor_ids
         FROM source_items s WHERE s.owner_scope_id=$1 AND s.id=ANY($2::uuid[]) ORDER BY s.id`,
        [request.ownerScopeId, wanted])).rows;
      for (const row of rows) {
        evidenceRefs.push(contextEvidenceRefSchema.parse({
          evidenceId: row['id'], sourceType: row['source_type'], sensitivity: row['sensitivity'],
          occurredAt: row['occurred_at'] ? (row['occurred_at'] as Date).toISOString() : null,
          anchorIds: (row['anchor_ids'] as string[] | null) ?? [],
          lifeCategories: deriveLifeCategories({ allowedPurposes: row['allowed_purposes'] as string[] }),
        }));
      }
    }
  }

  // Step 8 again: the memory threads the retrieved frames belong to, so a reader
  // can move from a value to the situation it belongs to.
  const memoryThreads = [];
  const seenThreads = new Set<string>();
  for (const frameInstanceId of suppliedFrameIds) {
    for (const thread of await listThreadsForObject(tx, {
      ownerScopeId: request.ownerScopeId, objectType: 'frame_instance', objectId: frameInstanceId,
    })) {
      if (seenThreads.has(thread.memoryThreadId)) continue;
      seenThreads.add(thread.memoryThreadId);
      memoryThreads.push(thread);
    }
  }

  if (currentBeliefs.length === 0 && historicalBeliefs.length === 0 && futureClaims.length === 0) {
    unknowns.push(contextUnknownSchema.parse({
      kind: 'NO_MATCHING_MEMORY', objectType: 'context_packets', objectId: null, detail: 'NO_BELIEF_MATCHED_THE_QUERY',
    }));
  }

  // What a caller may do with this packet. A draft is the only external action V0
  // offers at all, and it is offered here only when nothing is pending, contested
  // or withheld (PRD §27, §29.3).
  const settled = projectionFragments.every(fragment => fragment.isComplete) && conflicts.length === 0
    && redactions.listed.length === 0;
  const allowedActions = ['ANSWER_WITH_CITATIONS'];

  /**
   * Step 10: the action the request declared, when it declared one.
   *
   * The action's purpose is checked against the purposes admitted by the evidence
   * behind *this packet's* memory -- every one of those items, not any one of
   * them. An action founded on two evidence items is bound by both, so V0 takes
   * the reading that denies under either candidate rule (ADR 0022 §10); which
   * reading the product approves is still open and recorded as a finding.
   *
   * The verdict is recorded whatever it says. A DENY is recorded and then raised
   * with no packet written at all, so an action whose purpose the evidence never
   * admitted receives neither permission nor the memory it wanted to act on
   * (CRT-SEC-02-A).
   */
  const supportingEvidence = labels.filter(label => evidenceInPacket.has(label.evidenceId));
  let actionDecision: z.infer<typeof contextActionDecisionSchema> | null = null;
  const intent = request.intendedAction;
  if (intent !== null) {
    const ports = options.ports ?? createLocalPolicyAdapters();
    const admittingEvidence = supportingEvidence
      .filter(label => label.allowedPurposes.includes(intent.actionPurpose));
    // No supporting evidence at all is no evidence that admits the purpose: an
    // action in V0 is founded on memory or it is not founded.
    const admitsAction = supportingEvidence.length > 0 && admittingEvidence.length === supportingEvidence.length;
    const supportingAssessment = conflicts.length > 0 ? 'CONTESTED' as const
      : currentBeliefs.some(belief => belief.certainty === 'ACCEPTED') ? 'ACCEPTED' as const
        : currentBeliefs.length > 0 ? 'PROVISIONAL' as const : 'NONE' as const;
    const actionVerdict = await ports.evaluateMemoryAction({
      actorId: request.requestingActorId, ownerScopeId: request.ownerScopeId, purpose: CONTEXT_ACTION_PURPOSE,
      sensitivity: request.maximumSensitivity, risk: request.actionRisk,
      evidenceRefs: supportingEvidence.map(label => label.evidenceId),
      // The port speaks route purposes and the evidence records data purposes, so
      // the translation is the same one the read makes: the action purpose is
      // admitted exactly when the evidence behind the memory admits it.
      allowedPurposes: admitsAction ? [CONTEXT_ACTION_PURPOSE] : [],
      actionKind: intent.actionKind, capabilityGranted: intent.capabilityGranted,
      supportingAssessment, projectionComplete: projectionFragments.every(fragment => fragment.isComplete),
      // PRD §17.5: memory under an unregistered contract may be recalled, never
      // the authority for a high-risk action (CRT-REG-04-A).
      unregisteredPredicateSupport: currentBeliefs.some(belief => registeredBySlot.get(belief.beliefSlotId) !== true),
    });
    const actionDecisionId = await recordPolicyDecision(tx, {
      ownerScopeId: request.ownerScopeId, correlationId: options.correlationId, port: 'EvaluateMemoryAction',
      request: {
        actionKind: intent.actionKind, actionPurpose: intent.actionPurpose, portPurpose: CONTEXT_ACTION_PURPOSE,
        readPurpose: request.purpose, actionRisk: request.actionRisk, capabilityGranted: intent.capabilityGranted,
        evidenceConsidered: supportingEvidence.length, evidenceAdmittingActionPurpose: admittingEvidence.length,
        supportingAssessment, answerType,
        unregisteredPredicateSupport: currentBeliefs.some(belief => registeredBySlot.get(belief.beliefSlotId) !== true),
      },
      verdict: actionVerdict,
    });
    if (actionVerdict.outcome === 'DENY') {
      return { denial: { code: 'CONTEXT_ACTION_DENIED', detail: {
        reason: actionVerdict.reason, policyDecisionId: actionDecisionId, actionKind: intent.actionKind,
      } } };
    }
    actionDecision = contextActionDecisionSchema.parse({
      actionKind: intent.actionKind, actionPurpose: intent.actionPurpose,
      outcome: actionVerdict.outcome === 'ALLOW' ? 'ALLOW' : 'REQUIRE_CONFIRMATION',
      reason: actionVerdict.reason, policyVersion: actionVerdict.policyVersion,
      policyDecisionId: actionDecisionId, evidenceConsidered: supportingEvidence.length,
    });
    if (actionVerdict.outcome === 'ALLOW') allowedActions.push(intent.actionKind);
  } else if (settled && request.actionRisk !== 'HIGH') {
    // Nothing was declared, so nothing was decided: this says what the packet's
    // state would permit, and the decision stays `EvaluateMemoryAction`'s.
    allowedActions.push('DRAFT');
  }

  const canonicalWatermark = projectionFragments
    .map(fragment => new Date(fragment.canonicalTransactionWatermark))
    .reduce((latest, time) => time.getTime() > latest.getTime() ? time : latest, new Date(0));

  const body = {
    ownerScopeId: request.ownerScopeId, requestingActorId: request.requestingActorId, purpose: request.purpose,
    answerType, lifeCategory: category, registryRelease: options.registryRelease ?? null,
    worldTime: worldTime.toISOString(), knowledgeTime: knowledgeTime.toISOString(),
    currentBeliefs, historicalBeliefs, futureClaims, resolutionAssertions, conflicts, unknowns,
    ownerOverlayDeltas, projectionFragments, evidenceRefs, memoryThreads, allowedActions, actionDecision,
    redactions: redactions.listed, selections, semanticSearch,
    watermarks: {
      ownerOverlayWatermark: Math.max(overlay.ownerOverlayWatermark,
        ...projectionFragments.map(fragment => fragment.ownerOverlayWatermark), 0),
      canonicalTransactionWatermark: canonicalWatermark.toISOString(),
      projectionVersions: Object.fromEntries(projectionFragments.map(fragment => [fragment.projectionName, fragment.projectionVersion])),
      registryRelease: options.registryRelease ?? null,
      knowledgeTime: knowledgeTime.toISOString(),
      worldTime: worldTime.toISOString(),
    },
    selectionReason: {
      answerType, worldTimeFilter: worldTime.toISOString(), knowledgeTimeFilter: knowledgeTime.toISOString(),
      requiredCertainty: request.requiredCertainty, contextKind: 'BASE',
      appliedRules: [...SELECTION_RULES],
      overlayDeltasApplied: ownerOverlayDeltas.map(delta => delta.overlayDeltaId),
      selectorVersion: SELECTOR_VERSION,
      selectionsDigest: selectionsDigest(selections),
    },
    policy: {
      outcome: verdict.outcome === 'REDACT' ? 'REDACT' as const : 'ALLOW' as const,
      reason: verdict.reason, policyVersion: verdict.policyVersion, policyDecisionId,
    },
    brokerVersion: BROKER_VERSION,
  };

  const packetId = uuidV7();
  const packetHash = createHash('sha256').update(canonicalJson(body)).digest('hex');
  const packet = contextPacketSchema.parse({ ...body, packetId, packetHash, createdAt: now.toISOString() });

  await tx.query(
    `INSERT INTO context_packets(id,owner_scope_id,purpose,requesting_actor_id,answer_type_classification,
       request,packet,packet_hash,registry_release_id,selection_reason)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [packetId, request.ownerScopeId, request.purpose, request.requestingActorId, answerType,
      JSON.stringify({
        query: request.query, worldTime: request.worldTime, knowledgeTime: request.knowledgeTime,
        requiredCertainty: request.requiredCertainty, maximumSensitivity: request.maximumSensitivity,
        actionRisk: request.actionRisk, tokenBudget: request.tokenBudget, includeEvidence: request.includeEvidence,
        lifeCategory: category, entityHints: request.entityHints, worldlineHints: request.worldlineHints,
        discourseAnchors: request.discourseAnchors, frameTypeHints: request.frameTypeHints,
        intendedAction: request.intendedAction, answerType: request.answerType, timeWindow: request.timeWindow,
        sourceTypes: request.sourceTypes,
      }),
      JSON.stringify(packet), packetHash, options.registryReleaseId ?? null,
      JSON.stringify(packet.selectionReason)]);
  return { packet };
}


export function readContextPacket(...args:Parameters<typeof readContextPacketImpl>):ReturnType<typeof readContextPacketImpl>{
  return traceStage('context.assemble',{ownerScopeId:parseContextRequest(args[1]).ownerScopeId,correlationId:args[2].correlationId},()=>readContextPacketImpl(...args),{registryReleaseId:args[2].registryReleaseId,componentVersion:BROKER_VERSION});
}
