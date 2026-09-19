import {
  proposeBeliefTransactionSchema, validationReportSchema, commitReceiptSchema, admissionModeSchema,
  type AdmissionMode, type BeliefOperation, type CommitReceipt, type ObjectRef, type PolicyVerdict,
  type ProposeBeliefTransaction, type ValidationReport,
} from '@unai/domain';
import { createBeliefSlot, createProposition, indexClaimEmbeddings, recordClaim, recordFrameInstanceRole } from '@unai/memory';
import { contestDeltasConflictingWithClaims } from './delta-conflicts.js';
import { uuidV7 } from '../../../src/kernel/identities.js';
import { admittedAssessmentStatus, selectAdmissionMode, type AdmissionCandidate } from './admission.js';
import { recordBeliefAssessment, recordDerivedDependency, reassessDerivedPropositions, type StoredAssessment } from './assessments.js';
import { applyEntityMerge, applyEntitySplit, applyFrameMerge, applyFrameSplit, lineageErrorCode } from './lineage.js';
import { createLocalPolicyAdapters, recordPolicyDecision, type PolicyPorts, type Sensitivity } from './policy.js';
import { derivedIndependenceGroupKey, findSupportCycle, independenceGroupKey, independentSourceCount, type SupportEdge, type SupportOrigin } from './support.js';

/** The belief transaction service (PRD §19.1, §33.9, §36.7).
 *
 * Nothing writes an accepted belief except a commit that passed through here. The
 * service proposes a change set, validates it against the pinned registry release,
 * the support graph and the three policy ports, and commits it atomically: one
 * database transaction for every operation, so a failure at the last one leaves
 * none of the earlier ones visible (CRT-WRT-02-A), and one stored receipt, so a
 * second commit under the same idempotency key answers with the first commit's
 * bytes rather than a second commit (CRT-WRT-02-B).
 */

export const BELIEF_PURPOSES = Object.freeze({
  /** Proposing, validating and committing a belief transaction. */
  govern: 'memory.govern',
  /** Reading assessments, support and receipts back, as the Memory inspector does. */
  inspect: 'memory.inspect',
} as const);

export const VALIDATION_VERSION = 'belief-validation-0.1.0';
export const RECEIPT_VERSION = 'belief-receipt-0.1.0';

export class BeliefTransactionError extends Error {
  constructor(code: string, readonly detail?: Readonly<Record<string, unknown>>) {
    super(code);
    this.name = 'BeliefTransactionError';
  }
}

export interface BeliefTransactionStore {
  query(sql: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
}
/** Opens one transaction under the given purpose, exactly as the extraction
 * service asks for its own (ADR 0016 §7). The governor needs separate ones: the
 * policy decision and a refusal must survive the rollback of the work they
 * refused (CRT-WRT-03-A), and the material operations must commit or vanish
 * together (CRT-WRT-02-A). */
export type BeliefTransactionRunner =
  <T>(purpose: string, run: (tx: BeliefTransactionStore) => Promise<T>) => Promise<T>;

export interface GovernorRequest {
  readonly ownerScopeId: string;
  readonly actorId: string;
  readonly correlationId: string;
  /** The data purpose the governor reads evidence under. Independence is a
   * property of the source a claim came from, so the governor passes the
   * evidence gate like any other reader rather than around it. */
  readonly dataPurpose: string;
  readonly maximumSensitivity: Sensitivity;
}

interface StoredTransaction {
  id: string; ownerScopeId: string; transactionKind: string; requestedByActorId: string;
  sourceEvidenceIds: string[]; registryReleaseId: string; status: string; risk: 'LOW' | 'MEDIUM' | 'HIGH';
  admissionMode: AdmissionMode | null; idempotencyKey: string; commitReceipt: CommitReceipt | null;
  policyDecisionId: string | null;
}

interface StoredOperation { id: string; order: number; kind: string; payload: Record<string, unknown> }

const MODEL_ORIGINS = new Set(['MODEL_EXTRACTION', 'MODEL_INFERENCE', 'MODEL_RECOMMENDATION', 'MODEL_PREDICTION']);
/** Operation kinds another node of the sealed plan owns. The governor refuses them
 * by name rather than half-implementing somebody else's deliverable. */
const NOT_DELIVERED_HERE = new Set(['ARCHIVE', 'DELETE']);
/** Merge and split write lineage, and migration 0018 accepts lineage only from a
 * transaction of the same kind. Refusing the mismatch at propose names it before
 * the database would. */
const KIND_BOUND_OPERATIONS = new Set(['MERGE', 'SPLIT']);

/** Both settings the evidence policies read, set transaction-local so nothing
 * survives on a pooled connection. */
async function enterEvidenceGate(tx: BeliefTransactionStore, request: GovernorRequest): Promise<void> {
  await tx.query(`SELECT set_config('unai.data_purpose',$1,true),set_config('unai.maximum_sensitivity',$2,true)`,
    [request.dataPurpose, request.maximumSensitivity]);
}

function isPendingRef(ref: ObjectRef): boolean { return ref.startsWith('#'); }

async function readTransaction(tx: BeliefTransactionStore, ownerScopeId: string, id: string, lock: boolean): Promise<StoredTransaction> {
  const row = (await tx.query(
    `SELECT id,owner_scope_id,transaction_kind,requested_by_actor_id,source_evidence_ids,registry_release_id,status,
      risk,admission_mode,idempotency_key,commit_receipt,policy_decision_id
     FROM belief_transactions WHERE owner_scope_id=$1 AND id=$2` + (lock ? ' FOR UPDATE' : ''),
    [ownerScopeId, id])).rows[0];
  if (!row) throw new BeliefTransactionError('BELIEF_TRANSACTION_NOT_FOUND');
  return {
    id: row['id'] as string, ownerScopeId: row['owner_scope_id'] as string,
    transactionKind: row['transaction_kind'] as string, requestedByActorId: row['requested_by_actor_id'] as string,
    sourceEvidenceIds: [...(row['source_evidence_ids'] as string[])],
    registryReleaseId: row['registry_release_id'] as string, status: row['status'] as string,
    risk: row['risk'] as 'LOW' | 'MEDIUM' | 'HIGH',
    admissionMode: (row['admission_mode'] as AdmissionMode | null) ?? null,
    idempotencyKey: row['idempotency_key'] as string,
    commitReceipt: (row['commit_receipt'] as CommitReceipt | null) ?? null,
    policyDecisionId: (row['policy_decision_id'] as string | null) ?? null,
  };
}

async function readOperations(tx: BeliefTransactionStore, ownerScopeId: string, id: string): Promise<StoredOperation[]> {
  const rows = (await tx.query(
    `SELECT id,operation_order,operation_kind,payload FROM belief_transaction_operations
     WHERE owner_scope_id=$1 AND belief_transaction_id=$2 ORDER BY operation_order`, [ownerScopeId, id])).rows;
  return rows.map(row => ({
    id: row['id'] as string, order: row['operation_order'] as number,
    kind: row['operation_kind'] as string, payload: row['payload'] as Record<string, unknown>,
  }));
}

/**
 * Record a proposed change set (POST /v1/memory/transactions/propose).
 *
 * A caller may propose only. Nothing here writes a canonical row, and the
 * idempotency key is unique per owner scope, so a retried proposal finds the
 * first transaction rather than opening a second one over the same intent.
 */
export async function proposeBeliefTransaction(
  runner: BeliefTransactionRunner, request: GovernorRequest, input: ProposeBeliefTransaction,
): Promise<{ transactionId: string; status: string; alreadyProposed: boolean }> {
  const proposal = proposeBeliefTransactionSchema.parse(input);
  for (const operation of proposal.operations) {
    if (NOT_DELIVERED_HERE.has(operation.kind)) {
      throw new BeliefTransactionError('BELIEF_OPERATION_NOT_DELIVERED', { operationKind: operation.kind });
    }
    if (KIND_BOUND_OPERATIONS.has(operation.kind) && operation.kind !== proposal.transactionKind) {
      throw new BeliefTransactionError('BELIEF_OPERATION_KIND_MISMATCH', { operationKind: operation.kind });
    }
  }
  // Every `#ref` an operation consumes has to be produced by an earlier operation:
  // a forward reference would make the ordered list meaningless.
  const produced = new Set<string>();
  for (const operation of proposal.operations) {
    for (const ref of operationReferences(operation)) {
      if (isPendingRef(ref) && !produced.has(ref)) throw new BeliefTransactionError('BELIEF_OPERATION_REF_UNRESOLVED', { ref });
    }
    if ('operationRef' in operation) {
      if (produced.has(operation.operationRef)) throw new BeliefTransactionError('BELIEF_OPERATION_REF_DUPLICATE', { ref: operation.operationRef });
      produced.add(operation.operationRef);
    }
  }
  return runner(BELIEF_PURPOSES.govern, async tx => {
    const existing = (await tx.query(
      'SELECT id,status FROM belief_transactions WHERE owner_scope_id=$1 AND idempotency_key=$2',
      [request.ownerScopeId, proposal.idempotencyKey])).rows[0];
    if (existing) return { transactionId: existing['id'] as string, status: existing['status'] as string, alreadyProposed: true };
    const transactionId = uuidV7();
    await tx.query(
      `INSERT INTO belief_transactions(id,owner_scope_id,transaction_kind,requested_by_actor_id,source_evidence_ids,
        registry_release_id,status,risk,idempotency_key)
       VALUES($1,$2,$3,$4,$5,$6,'PROPOSED',$7,$8)`,
      [transactionId, request.ownerScopeId, proposal.transactionKind, request.actorId,
        [...(proposal.sourceEvidenceIds ?? [])], proposal.registryReleaseId, proposal.risk, proposal.idempotencyKey]);
    for (const [index, operation] of proposal.operations.entries()) {
      await tx.query(
        `INSERT INTO belief_transaction_operations(id,owner_scope_id,belief_transaction_id,operation_order,operation_kind,payload)
         VALUES($1,$2,$3,$4,$5,$6)`,
        [uuidV7(), request.ownerScopeId, transactionId, index, operation.kind, JSON.stringify(operation)]);
    }
    return { transactionId, status: 'PROPOSED', alreadyProposed: false };
  });
}

function operationReferences(operation: BeliefOperation): ObjectRef[] {
  switch (operation.kind) {
    case 'CREATE_SLOT': return [operation.frameInstance];
    case 'CREATE_PROPOSITION': return [operation.beliefSlot];
    case 'ADD_CLAIM': return operation.proposition ? [operation.proposition] : [];
    case 'ADD_SUPPORT': return [operation.proposition, ...(operation.claim ? [operation.claim] : []),
      ...(operation.supportingProposition ? [operation.supportingProposition] : [])];
    case 'SET_BELIEF_ASSESSMENT': return [operation.proposition];
    case 'DERIVE': return [operation.derivedProposition];
    case 'QUALIFY': return [operation.beliefSlot];
    case 'SUPPRESS': case 'ARCHIVE': case 'DELETE': return [operation.target];
    case 'MERGE': return [operation.target, operation.survivor];
    case 'SPLIT': return [operation.target];
    case 'CREATE_FRAME_INSTANCE': return [];
  }
}

/** The predicate and frame type a proposition sits under, resolved either from
 * the operations that create it or from the rows that already hold it. */
interface PropositionContracts { predicateId: string | null; frameTypeId: string | null; beliefSlotRef: ObjectRef | null }

async function resolvePropositionContracts(
  tx: BeliefTransactionStore, ownerScopeId: string, operations: readonly BeliefOperation[], proposition: ObjectRef,
): Promise<PropositionContracts> {
  const slotOf = (ref: ObjectRef): ObjectRef | null => {
    for (const operation of operations) {
      if (operation.kind === 'CREATE_PROPOSITION' && operation.operationRef === ref) return operation.beliefSlot;
    }
    return null;
  };
  const pendingSlot = isPendingRef(proposition) ? slotOf(proposition) : null;
  const slotRef = pendingSlot ?? (isPendingRef(proposition) ? null : proposition);

  if (pendingSlot && isPendingRef(pendingSlot)) {
    const slot = operations.find(op => op.kind === 'CREATE_SLOT' && op.operationRef === pendingSlot);
    if (slot && slot.kind === 'CREATE_SLOT') {
      const instance = isPendingRef(slot.frameInstance)
        ? operations.find(op => op.kind === 'CREATE_FRAME_INSTANCE' && op.operationRef === slot.frameInstance)
        : null;
      const frameTypeId = instance && instance.kind === 'CREATE_FRAME_INSTANCE' ? instance.frameTypeId
        : (await tx.query('SELECT frame_type_id FROM frame_instances WHERE owner_scope_id=$1 AND id=$2',
          [ownerScopeId, slot.frameInstance])).rows[0]?.['frame_type_id'] as string | undefined ?? null;
      return { predicateId: slot.predicateId, frameTypeId, beliefSlotRef: pendingSlot };
    }
  }
  if (pendingSlot && !isPendingRef(pendingSlot)) {
    const row = (await tx.query(
      `SELECT s.predicate_id,f.frame_type_id FROM belief_slots s
       JOIN frame_instances f ON f.owner_scope_id=s.owner_scope_id AND f.id=s.frame_instance_id
       WHERE s.owner_scope_id=$1 AND s.id=$2`, [ownerScopeId, pendingSlot])).rows[0];
    return { predicateId: (row?.['predicate_id'] as string) ?? null, frameTypeId: (row?.['frame_type_id'] as string) ?? null, beliefSlotRef: pendingSlot };
  }
  if (slotRef && !isPendingRef(slotRef)) {
    const row = (await tx.query(
      `SELECT s.id AS slot_id,s.predicate_id,f.frame_type_id FROM propositions p
       JOIN belief_slots s ON s.owner_scope_id=p.owner_scope_id AND s.id=p.belief_slot_id
       JOIN frame_instances f ON f.owner_scope_id=s.owner_scope_id AND f.id=s.frame_instance_id
       WHERE p.owner_scope_id=$1 AND p.id=$2`, [ownerScopeId, slotRef])).rows[0];
    return { predicateId: (row?.['predicate_id'] as string) ?? null, frameTypeId: (row?.['frame_type_id'] as string) ?? null,
      beliefSlotRef: (row?.['slot_id'] as string) ?? null };
  }
  return { predicateId: null, frameTypeId: null, beliefSlotRef: null };
}

async function contractPresent(tx: BeliefTransactionStore, releaseId: string, contractId: string, kind: 'FRAME' | 'PREDICATE'): Promise<boolean> {
  const row = (await tx.query('SELECT unai_private.registry_contract_present($1,$2,$3) AS present', [releaseId, contractId, kind])).rows[0];
  return row?.['present'] === true;
}

/** The contracts one proposition, slot or instance reference sits under that the
 * pinned release does not hold. */
type UnregisteredContracts = string[];

/**
 * Which of this transaction's operations touch a predicate or frame type absent
 * from the pinned release (PRD §17.5; ADR 0024 §4).
 *
 * "Touch" is any operation over a slot, a proposition, a claim, a support row, an
 * assessment or a derivation whose contracts are unregistered -- including a
 * support row whose *supporting* proposition is. Storing such a claim is allowed;
 * what the caller decides next is whether the same transaction also uses it for
 * something PRD §17.5 forbids.
 */
async function unregisteredTouches(
  tx: BeliefTransactionStore, ownerScopeId: string, releaseId: string, operations: readonly BeliefOperation[],
): Promise<Map<number, { propositionRef: string | null; contracts: UnregisteredContracts }>> {
  const presence = new Map<string, boolean>();
  const absent = async (contractId: string | null, kind: 'FRAME' | 'PREDICATE'): Promise<string[]> => {
    if (contractId === null) return [];
    const key = kind + ':' + contractId;
    if (!presence.has(key)) presence.set(key, await contractPresent(tx, releaseId, contractId, kind));
    return presence.get(key) ? [] : [contractId];
  };
  const ofProposition = async (ref: ObjectRef): Promise<string[]> => {
    const contracts = await resolvePropositionContracts(tx, ownerScopeId, operations, ref);
    return [...await absent(contracts.predicateId, 'PREDICATE'), ...await absent(contracts.frameTypeId, 'FRAME')];
  };
  const touches = new Map<number, { propositionRef: string | null; contracts: UnregisteredContracts }>();
  for (const [order, operation] of operations.entries()) {
    let propositionRef: string | null = null;
    let contracts: string[] = [];
    switch (operation.kind) {
      case 'CREATE_FRAME_INSTANCE': contracts = await absent(operation.frameTypeId, 'FRAME'); break;
      case 'CREATE_SLOT': {
        const instance = isPendingRef(operation.frameInstance)
          ? operations.find(op => op.kind === 'CREATE_FRAME_INSTANCE' && op.operationRef === operation.frameInstance)
          : null;
        const frameTypeId = instance && instance.kind === 'CREATE_FRAME_INSTANCE' ? instance.frameTypeId
          : isPendingRef(operation.frameInstance) ? null
            : (await tx.query('SELECT frame_type_id FROM frame_instances WHERE owner_scope_id=$1 AND id=$2',
              [ownerScopeId, operation.frameInstance])).rows[0]?.['frame_type_id'] as string | undefined ?? null;
        contracts = [...await absent(operation.predicateId, 'PREDICATE'), ...await absent(frameTypeId, 'FRAME')];
        break;
      }
      case 'CREATE_PROPOSITION': propositionRef = operation.operationRef; contracts = await ofProposition(operation.operationRef); break;
      case 'ADD_CLAIM':
        if (operation.proposition) { propositionRef = operation.proposition; contracts = await ofProposition(operation.proposition); }
        break;
      case 'ADD_SUPPORT':
        propositionRef = operation.proposition;
        contracts = [...await ofProposition(operation.proposition),
          ...(operation.supportingProposition ? await ofProposition(operation.supportingProposition) : [])];
        break;
      case 'SET_BELIEF_ASSESSMENT': propositionRef = operation.proposition; contracts = await ofProposition(operation.proposition); break;
      case 'DERIVE': propositionRef = operation.derivedProposition; contracts = await ofProposition(operation.derivedProposition); break;
      case 'SUPPRESS': case 'ARCHIVE': case 'DELETE':
        if (operation.targetObjectType === 'proposition') { propositionRef = operation.target; contracts = await ofProposition(operation.target); }
        break;
      case 'QUALIFY': case 'MERGE': case 'SPLIT': break;
    }
    if (contracts.length > 0) touches.set(order, { propositionRef, contracts: [...new Set(contracts)].sort() });
  }
  return touches;
}

/** The live verdict over an existing proposition, and whether its slot holds a
 * second live value -- the two facts that make a verdict change a supersession or
 * a conflict resolution. */
async function liveVerdict(tx: BeliefTransactionStore, ownerScopeId: string, propositionId: string): Promise<{
  status: string | null; competingLive: number;
}> {
  const row = (await tx.query(
    `SELECT (SELECT a.assessment_status FROM belief_assessments a WHERE a.owner_scope_id=p.owner_scope_id
         AND a.proposition_id=p.id AND a.superseded_recorded_at IS NULL) AS status,
       (SELECT count(*)::int FROM propositions q
         JOIN belief_assessments b ON b.owner_scope_id=q.owner_scope_id AND b.proposition_id=q.id
           AND b.superseded_recorded_at IS NULL
         WHERE q.owner_scope_id=p.owner_scope_id AND q.belief_slot_id=p.belief_slot_id AND q.id<>p.id
           AND q.lifecycle<>'RETIRED'
           AND b.assessment_status NOT IN ('REJECTED','SUPERSEDED','UNSUPPORTED','SUPPRESSED','CANDIDATE')) AS competing
     FROM propositions p WHERE p.owner_scope_id=$1 AND p.id=$2`, [ownerScopeId, propositionId])).rows[0];
  return { status: (row?.['status'] as string | null) ?? null, competingLive: (row?.['competing'] as number | null) ?? 0 };
}

/**
 * The uses PRD §17.5 forbids an unregistered surface predicate, found in one
 * transaction (CRT-REG-04-A; ADR 0024 §4).
 *
 * Nothing here refuses *storing* the claim or indexing it. A transaction that
 * touches an unregistered contract is refused when it also supersedes or rejects
 * an accepted belief, changes the verdict of a contested one or of one with a live
 * competitor, accepts the unregistered value as current, or is declared HIGH risk.
 */
async function unregisteredPredicateUses(
  tx: BeliefTransactionStore, ownerScopeId: string, transaction: StoredTransaction, operations: readonly BeliefOperation[],
): Promise<{ touched: string[]; uses: ValidationReport['unregisteredPredicateUses'] }> {
  const touches = await unregisteredTouches(tx, ownerScopeId, transaction.registryReleaseId, operations);
  if (touches.size === 0) return { touched: [], uses: [] };
  const touched = [...new Set([...touches.values()].flatMap(touch => touch.contracts))].sort();
  const uses: ValidationReport['unregisteredPredicateUses'] = [];
  for (const [order, operation] of operations.entries()) {
    if (operation.kind !== 'SET_BELIEF_ASSESSMENT') continue;
    // Accepting a value in a transaction that also carries an unregistered one is
    // refused whichever of the two the verdict names: the unregistered claim could
    // otherwise become current by standing as the support of a registered slot.
    // A caller that means two unrelated things splits them into two transactions.
    if (operation.assessmentStatus === 'ACCEPTED') {
      uses.push({ use: 'SET_CURRENT_VALUE', operationOrder: order, propositionRef: operation.proposition,
        contractIds: touches.get(order)?.contracts ?? touched });
    }
    if (isPendingRef(operation.proposition)) continue;
    const live = await liveVerdict(tx, ownerScopeId, operation.proposition);
    if (live.status === 'ACCEPTED' && (operation.assessmentStatus === 'SUPERSEDED' || operation.assessmentStatus === 'REJECTED')) {
      uses.push({ use: 'SUPERSEDE_ACCEPTED_BELIEF', operationOrder: order, propositionRef: operation.proposition, contractIds: touched });
    }
    if (operation.assessmentStatus !== live.status && (live.status === 'CONTESTED' || live.competingLive > 0)) {
      uses.push({ use: 'RESOLVE_CONFLICT', operationOrder: order, propositionRef: operation.proposition, contractIds: touched });
    }
  }
  if (transaction.risk === 'HIGH') {
    uses.push({ use: 'AUTHORIZE_HIGH_RISK_ACTION', operationOrder: null, propositionRef: null, contractIds: touched });
  }
  return { touched, uses };
}

async function originForAnchor(
  tx: BeliefTransactionStore, ownerScopeId: string, sourceAnchorId: string, assertedByEntityId: string | null,
): Promise<SupportOrigin> {
  const row = (await tx.query(
    `SELECT s.connector_id,s.source_type,s.actor_ref,s.actor_entity_id
     FROM source_anchors a JOIN source_items s ON s.owner_scope_id=a.owner_scope_id AND s.id=a.source_item_id
     WHERE a.owner_scope_id=$1 AND a.id=$2`, [ownerScopeId, sourceAnchorId])).rows[0];
  if (!row) throw new BeliefTransactionError('BELIEF_SUPPORT_ORIGIN_UNREADABLE', { sourceAnchorId });
  return {
    assertedByEntityId, sourceActorEntityId: (row['actor_entity_id'] as string | null) ?? null,
    sourceActorRef: row['actor_ref'] ?? null, connectorId: (row['connector_id'] as string | null) ?? null,
    sourceType: row['source_type'] as string,
  };
}

async function originForClaim(tx: BeliefTransactionStore, ownerScopeId: string, claimId: string): Promise<SupportOrigin> {
  const row = (await tx.query(
    `SELECT c.asserted_by_entity_id,s.connector_id,s.source_type,s.actor_ref,s.actor_entity_id
     FROM claims c
     JOIN source_anchors a ON a.owner_scope_id=c.owner_scope_id AND a.id=c.source_anchor_id
     JOIN source_items s ON s.owner_scope_id=a.owner_scope_id AND s.id=a.source_item_id
     WHERE c.owner_scope_id=$1 AND c.id=$2`, [ownerScopeId, claimId])).rows[0];
  if (!row) throw new BeliefTransactionError('BELIEF_SUPPORT_ORIGIN_UNREADABLE', { claimId });
  return {
    assertedByEntityId: (row['asserted_by_entity_id'] as string | null) ?? null,
    sourceActorEntityId: (row['actor_entity_id'] as string | null) ?? null,
    sourceActorRef: row['actor_ref'] ?? null, connectorId: (row['connector_id'] as string | null) ?? null,
    sourceType: row['source_type'] as string,
  };
}

/** How a claim anchored in assistant conversation evidence is counted by
 * admission: as a model's reading, which may be proposed and never accepted. */
const ASSISTANT_EVIDENCE_ORIGIN = 'MODEL_INFERENCE';

/** Whether an anchor, or a stored claim's anchor, lies in an assistant-authored
 * evidence item. A row the gate does not show answers false: the origin check that
 * decides support already refuses an unreadable anchor. */
async function anchoredInAssistantEvidence(
  tx: BeliefTransactionStore, ownerScopeId: string, ref: { sourceAnchorId: string } | { claimId: string },
): Promise<boolean> {
  const row = 'claimId' in ref
    ? (await tx.query(
      `SELECT s.actor_ref->>'type' AS actor_type FROM claims c
       JOIN source_anchors a ON a.owner_scope_id=c.owner_scope_id AND a.id=c.source_anchor_id
       JOIN source_items s ON s.owner_scope_id=a.owner_scope_id AND s.id=a.source_item_id
       WHERE c.owner_scope_id=$1 AND c.id=$2`, [ownerScopeId, ref.claimId])).rows[0]
    : (await tx.query(
      `SELECT s.actor_ref->>'type' AS actor_type FROM source_anchors a
       JOIN source_items s ON s.owner_scope_id=a.owner_scope_id AND s.id=a.source_item_id
       WHERE a.owner_scope_id=$1 AND a.id=$2`, [ownerScopeId, ref.sourceAnchorId])).rows[0];
  return row?.['actor_type'] === 'ASSISTANT';
}

/** The independence groups a proposition already rests on. A derivation is as
 * independent as its own support and never more (PRD §15.4). */
async function storedGroups(tx: BeliefTransactionStore, ownerScopeId: string, propositionId: string): Promise<string[]> {
  const rows = (await tx.query(
    'SELECT DISTINCT independence_group FROM belief_support WHERE owner_scope_id=$1 AND proposition_id=$2 AND independence_group IS NOT NULL',
    [ownerScopeId, propositionId])).rows;
  return rows.map(row => row['independence_group'] as string);
}

/** The group one proposed support row would carry, resolved for both a claim
 * that already exists and one this very transaction records. */
async function groupForSupport(
  tx: BeliefTransactionStore, ownerScopeId: string, operations: readonly BeliefOperation[], operation: Extract<BeliefOperation, { kind: 'ADD_SUPPORT' }>,
): Promise<string> {
  if (operation.claim) {
    if (isPendingRef(operation.claim)) {
      const pending = operations.find(op => op.kind === 'ADD_CLAIM' && op.operationRef === operation.claim);
      if (!pending || pending.kind !== 'ADD_CLAIM') throw new BeliefTransactionError('BELIEF_OPERATION_REF_UNRESOLVED', { ref: operation.claim });
      return independenceGroupKey(await originForAnchor(tx, ownerScopeId, pending.sourceAnchorId, pending.assertedByEntityId ?? null));
    }
    return independenceGroupKey(await originForClaim(tx, ownerScopeId, operation.claim));
  }
  const supporting = operation.supportingProposition!;
  if (isPendingRef(supporting)) return derivedIndependenceGroupKey([]);
  return derivedIndependenceGroupKey(await storedGroups(tx, ownerScopeId, supporting));
}

async function buildValidationReport(
  tx: BeliefTransactionStore, request: GovernorRequest, transaction: StoredTransaction,
  operations: readonly BeliefOperation[], ports: PolicyPorts,
): Promise<{ report: ValidationReport; policy: PolicyVerdict; policyRequest: Record<string, unknown> }> {
  const warnings: string[] = [];

  // 1. The pinned release. Only an ACCEPTED assessment is refused for an absent
  //    contract: a candidate or provisional belief over an unregistered predicate
  //    is still evidence the owner may inspect (CRT-MEM-01-A).
  const unregistered: { contractId: string; contractKind: 'FRAME' | 'PREDICATE' }[] = [];
  const accepted = operations.filter((op): op is Extract<BeliefOperation, { kind: 'SET_BELIEF_ASSESSMENT' }> =>
    op.kind === 'SET_BELIEF_ASSESSMENT' && op.assessmentStatus === 'ACCEPTED');
  let predicateRegistered = true;
  let materialConflict = false;
  for (const operation of accepted) {
    const contracts = await resolvePropositionContracts(tx, request.ownerScopeId, operations, operation.proposition);
    for (const [contractId, contractKind] of [[contracts.predicateId, 'PREDICATE'], [contracts.frameTypeId, 'FRAME']] as const) {
      if (contractId === null) { predicateRegistered = false; warnings.push('CONTRACT_UNRESOLVABLE'); continue; }
      if (!await contractPresent(tx, transaction.registryReleaseId, contractId, contractKind)) {
        unregistered.push({ contractId, contractKind });
        predicateRegistered = false;
      }
    }
    if (contracts.beliefSlotRef && !isPendingRef(contracts.beliefSlotRef)) {
      const competing = (await tx.query(
        `SELECT 1 FROM propositions p
         JOIN belief_assessments a ON a.owner_scope_id=p.owner_scope_id AND a.proposition_id=p.id
           AND a.superseded_recorded_at IS NULL AND a.assessment_status='ACCEPTED'
         WHERE p.owner_scope_id=$1 AND p.belief_slot_id=$2 AND p.id IS DISTINCT FROM $3`,
        [request.ownerScopeId, contracts.beliefSlotRef, isPendingRef(operation.proposition) ? null : operation.proposition])).rowCount;
      if ((competing ?? 0) > 0) materialConflict = true;
    }
  }

  // 1b. What the transaction would *use* an unregistered contract for. Storing a
  //     claim under one is permitted; superseding, resolving, becoming current and
  //     authorizing a high-risk action are not (PRD §17.5, CRT-REG-04-A).
  const { touched: touchedUnregistered, uses: unregisteredUses } =
    await unregisteredPredicateUses(tx, request.ownerScopeId, transaction, operations);
  if (touchedUnregistered.length > 0) predicateRegistered = false;

  // 2. Circular support over the graph the commit would leave behind.
  const edges: SupportEdge[] = (await tx.query(
    'SELECT proposition_id,supporting_proposition_id FROM belief_support WHERE owner_scope_id=$1 AND supporting_proposition_id IS NOT NULL',
    [request.ownerScopeId])).rows.map(row => ({
      propositionId: row['proposition_id'] as string, supportingPropositionId: row['supporting_proposition_id'] as string,
    }));
  for (const operation of operations) {
    if (operation.kind === 'ADD_SUPPORT' && operation.supportingProposition) {
      edges.push({ propositionId: operation.proposition, supportingPropositionId: operation.supportingProposition });
    }
  }
  const cycle = findSupportCycle(edges);
  const circularSupport = cycle ? [{ propositionRef: cycle[0]!, cycle }] : [];

  // 3. Independence. Counting support rows would be the mistake PRD §15.4 names;
  //    the answer is how many distinct groups the rows collapse into.
  const groupsByProposition = new Map<string, string[]>();
  const claimOrigins: string[] = [];
  // PRD §24.1: an assistant's own message is never independent evidence for what
  // it says. A claim anchored in one counts as model-authored whatever origin it
  // declares, so the write policy refuses to accept a belief on it alone; and it
  // is never support for anything (CRT-AI-01-A, ADR 0026 §4).
  const assistantClaimRefs = new Set<string>();
  let assistantSupport = false;
  for (const operation of operations) {
    if (operation.kind === 'ADD_CLAIM') {
      const assistant = await anchoredInAssistantEvidence(tx, request.ownerScopeId, { sourceAnchorId: operation.sourceAnchorId });
      if (assistant) assistantClaimRefs.add(operation.operationRef);
      claimOrigins.push(assistant ? ASSISTANT_EVIDENCE_ORIGIN : operation.claimOrigin);
    }
    if (operation.kind !== 'ADD_SUPPORT') continue;
    if (operation.claim && isPendingRef(operation.claim) && assistantClaimRefs.has(operation.claim)) assistantSupport = true;
    if (operation.claim && !isPendingRef(operation.claim)) {
      const origin = (await tx.query('SELECT claim_origin FROM claims WHERE owner_scope_id=$1 AND id=$2',
        [request.ownerScopeId, operation.claim])).rows[0]?.['claim_origin'];
      if (typeof origin === 'string') {
        const assistant = await anchoredInAssistantEvidence(tx, request.ownerScopeId, { claimId: operation.claim });
        if (assistant) assistantSupport = true;
        claimOrigins.push(assistant ? ASSISTANT_EVIDENCE_ORIGIN : origin);
      }
    }
    const group = await groupForSupport(tx, request.ownerScopeId, operations, operation);
    const key = operation.proposition;
    const existing = groupsByProposition.get(key);
    if (existing) existing.push(group); else groupsByProposition.set(key, [group]);
  }
  // Support already stored for a proposition this transaction touches counts too.
  for (const key of [...groupsByProposition.keys()]) {
    if (!isPendingRef(key)) groupsByProposition.set(key, [...groupsByProposition.get(key)!, ...await storedGroups(tx, request.ownerScopeId, key)]);
  }
  const independenceGroups = [...groupsByProposition.entries()].map(([propositionRef, groups]) => ({
    propositionRef, groups: [...new Set(groups)].sort(), independentSourceCount: independentSourceCount(groups),
  }));

  // 4. Admission (PRD §19.2). The governor decides the mode; a proposal may name
  //    one, and a proposal that names a different one is recorded as overridden
  //    rather than obeyed.
  const identityResolved = !operations.some(op => op.kind === 'ADD_CLAIM' && op.lifecycle === 'AWAITING_INSTANCE_RESOLUTION');
  const modelOrConnectorAuthored = claimOrigins.length > 0 && claimOrigins.every(origin => MODEL_ORIGINS.has(origin));
  const candidate: AdmissionCandidate = {
    memoryWorthiness: 'SEMANTIC', predicateRegistered, identityResolved,
    sourceAuthoritative: !modelOrConnectorAuthored, materialConflict,
    errorConsequence: transaction.risk, reversible: true, audited: true, blocksCurrentAnswer: false,
  };
  const admission = selectAdmissionMode(candidate);
  if (transaction.admissionMode && transaction.admissionMode !== admission.mode) warnings.push('ADMISSION_MODE_OVERRIDDEN');

  // 5. The write port, evaluated before the commit and persisted by the caller.
  const policyRequest = {
    actorId: request.actorId, ownerScopeId: request.ownerScopeId, purpose: BELIEF_PURPOSES.govern,
    sensitivity: request.maximumSensitivity, evidenceRefs: transaction.sourceEvidenceIds, risk: transaction.risk,
    proposedChanges: {
      transactionKind: transaction.transactionKind, operationKinds: operations.map(op => op.kind),
      setsAcceptedAssessment: accepted.length > 0, modelOrConnectorAuthored, identityResolved,
    },
  };
  const policy = await ports.evaluateMemoryWrite(policyRequest);

  const admitted = admittedAssessmentStatus(admission.mode);
  if (assistantSupport) warnings.push('ASSISTANT_EVIDENCE_IS_NOT_SUPPORT');
  const decision: ValidationReport['decision'] =
    unregistered.length > 0 || unregisteredUses.length > 0 || warnings.includes('CONTRACT_UNRESOLVABLE') ? 'REJECTED'
      : assistantSupport ? 'REJECTED'
      : circularSupport.length > 0 ? 'REJECTED'
        : policy.outcome === 'DENY' ? 'REJECTED'
          : accepted.length > 0 && admitted !== 'ACCEPTED'
            ? (materialConflict ? 'CONTESTED'
              : admission.mode === 'SOURCE_ONLY' || admission.mode === 'INDEX_ONLY' ? 'SOURCE_ONLY' : 'REQUIRES_CONFIRMATION')
            : policy.outcome === 'REQUIRE_CONFIRMATION' || policy.outcome === 'STAGE' ? 'REQUIRES_CONFIRMATION'
              : 'COMMITTABLE';

  const report = validationReportSchema.parse({
    transactionId: transaction.id, decision, policy, admissionMode: admission.mode,
    withheldAutoAcceptConditions: [...admission.withheldConditions], unregisteredContracts: unregistered,
    unregisteredPredicateUses: unregisteredUses, circularSupport, independenceGroups, conflicts: materialConflict ? [{ code: 'COMPETING_ACCEPTED_PROPOSITION_IN_SLOT' }] : [],
    warnings: [...new Set(warnings)], validationVersion: VALIDATION_VERSION,
  });
  return { report, policy, policyRequest: policyRequest as unknown as Record<string, unknown> };
}

/**
 * Validate a proposed transaction (POST /v1/memory/transactions/{id}/validate).
 *
 * The report is persisted on the transaction together with the policy decision it
 * reached, so a refusal is readable afterwards whether or not anyone asked for a
 * commit (CRT-WRT-03-A).
 */
export async function validateBeliefTransaction(
  runner: BeliefTransactionRunner, request: GovernorRequest, transactionId: string,
  ports: PolicyPorts = createLocalPolicyAdapters(),
): Promise<ValidationReport> {
  return runner(BELIEF_PURPOSES.govern, async tx => {
    await enterEvidenceGate(tx, request);
    const transaction = await readTransaction(tx, request.ownerScopeId, transactionId, false);
    if (transaction.status === 'COMMITTED') throw new BeliefTransactionError('BELIEF_TRANSACTION_ALREADY_COMMITTED');
    const operations = (await readOperations(tx, request.ownerScopeId, transactionId)).map(op => op.payload as unknown as BeliefOperation);
    const { report, policy, policyRequest } = await buildValidationReport(tx, request, transaction, operations, ports);
    const decisionId = await recordPolicyDecision(tx, {
      ownerScopeId: request.ownerScopeId, correlationId: request.correlationId, port: 'EvaluateMemoryWrite',
      request: policyRequest, verdict: policy, subjectTransactionId: transaction.id,
    });
    await tx.query(
      `UPDATE belief_transactions SET status=$3,admission_mode=$4,validation=$5,policy_decision=$6,policy_decision_id=$7
       WHERE owner_scope_id=$1 AND id=$2`,
      [request.ownerScopeId, transaction.id, report.decision === 'REJECTED' ? 'PROPOSED' : 'VALIDATED',
        admissionModeSchema.parse(report.admissionMode), JSON.stringify(report), JSON.stringify(policy), decisionId]);
    return report;
  });
}

interface CommitContext {
  tx: BeliefTransactionStore;
  request: GovernorRequest;
  transaction: StoredTransaction;
  refs: Map<string, string>;
  createdObjects: { operationOrder: number; objectType: string; objectId: string }[];
  assessments: StoredAssessment[];
  touchedPropositions: Set<string>;
}

function resolveRef(context: CommitContext, ref: ObjectRef): string {
  if (!isPendingRef(ref)) return ref;
  const resolved = context.refs.get(ref);
  if (!resolved) throw new BeliefTransactionError('BELIEF_OPERATION_REF_UNRESOLVED', { ref });
  return resolved;
}

async function baseContextSpace(context: CommitContext): Promise<string> {
  const row = (await context.tx.query(
    `SELECT id FROM context_spaces WHERE owner_scope_id=$1 AND context_kind='BASE' AND lifecycle='ACTIVE'`,
    [context.request.ownerScopeId])).rows[0];
  if (!row) throw new BeliefTransactionError('BASE_CONTEXT_SPACE_MISSING');
  return row['id'] as string;
}

async function applyOperation(context: CommitContext, order: number, operation: BeliefOperation): Promise<Record<string, unknown>> {
  const owner = context.request.ownerScopeId;
  const record = (objectType: string, objectId: string) => {
    context.createdObjects.push({ operationOrder: order, objectType, objectId });
    return { objectType, objectId };
  };
  switch (operation.kind) {
    case 'CREATE_FRAME_INSTANCE': {
      const id = uuidV7();
      await context.tx.query(
        `INSERT INTO frame_instances(id,owner_scope_id,frame_type_id,context_space_id,created_by_transaction_id)
         VALUES($1,$2,$3,$4,$5)`,
        [id, owner, operation.frameTypeId, operation.contextSpaceId ?? await baseContextSpace(context), context.transaction.id]);
      for (const role of operation.roles ?? []) {
        await recordFrameInstanceRole(context.tx, {
          ownerScopeId: owner, frameInstanceId: id, roleId: role.roleId,
          ...(role.entityId === undefined ? {} : { entityId: role.entityId }),
          ...(role.typedValue === undefined ? {} : { typedValue: role.typedValue }),
        });
      }
      context.refs.set(operation.operationRef, id);
      return record('frame_instances', id);
    }
    // The slot, proposition and claim stores are `@unai/memory`'s, called here
    // rather than reimplemented: a slot the governor creates therefore carries the
    // same versioned lookup fingerprint one canonicalization created, and is found
    // by the same resolver (CRT-MEM-04-A's index stays complete).
    case 'CREATE_SLOT': {
      const id = await createBeliefSlot(context.tx, {
        ownerScopeId: owner,
        descriptor: {
          frameInstanceId: resolveRef(context, operation.frameInstance), predicateId: operation.predicateId,
          contextSpaceId: operation.contextSpaceId ?? await baseContextSpace(context),
          modality: operation.modality, qualifiers: operation.qualifiers ?? {},
        },
        registryReleaseId: context.transaction.registryReleaseId,
      });
      context.refs.set(operation.operationRef, id);
      return record('belief_slots', id);
    }
    case 'CREATE_PROPOSITION': {
      const id = await createProposition(context.tx, {
        ownerScopeId: owner, beliefSlotId: resolveRef(context, operation.beliefSlot),
        normalizedValue: operation.normalizedValue ?? null, polarity: operation.polarity ?? 'POSITIVE',
        registryReleaseId: context.transaction.registryReleaseId,
      });
      context.refs.set(operation.operationRef, id);
      context.touchedPropositions.add(id);
      return record('propositions', id);
    }
    case 'ADD_CLAIM': {
      const id = await recordClaim(context.tx, {
        ownerScopeId: owner, sourceAnchorId: operation.sourceAnchorId,
        extractionRunId: operation.extractionRunId ?? null,
        assertedByEntityId: operation.assertedByEntityId ?? null,
        propositionId: operation.proposition ? resolveRef(context, operation.proposition) : null,
        claimOrigin: operation.claimOrigin, lifecycle: operation.lifecycle ?? 'PROVISIONAL',
        validFrom: operation.validFrom ? new Date(operation.validFrom) : null,
        validTo: operation.validTo ? new Date(operation.validTo) : null,
        extractionConfidence: operation.extractionConfidence ?? null,
        entityResolutionConfidence: operation.entityResolutionConfidence ?? null,
        temporalResolutionConfidence: operation.temporalResolutionConfidence ?? null,
        instanceResolutionConfidence: operation.instanceResolutionConfidence ?? null,
      });
      context.refs.set(operation.operationRef, id);
      return record('claims', id);
    }
    case 'ADD_SUPPORT': {
      const propositionId = resolveRef(context, operation.proposition);
      const claimId = operation.claim ? resolveRef(context, operation.claim) : null;
      const supportingPropositionId = operation.supportingProposition ? resolveRef(context, operation.supportingProposition) : null;
      if ((claimId === null) === (supportingPropositionId === null)) {
        throw new BeliefTransactionError('BELIEF_SUPPORT_NAMES_ONE_SUPPORTER');
      }
      const group = claimId !== null
        ? independenceGroupKey(await originForClaim(context.tx, owner, claimId))
        : derivedIndependenceGroupKey(await storedGroups(context.tx, owner, supportingPropositionId!));
      const id = uuidV7();
      await context.tx.query(
        `INSERT INTO belief_support(id,owner_scope_id,proposition_id,claim_id,supporting_proposition_id,support_kind,
          independence_group,created_by_transaction_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, owner, propositionId, claimId, supportingPropositionId, operation.supportKind, group, context.transaction.id]);
      context.touchedPropositions.add(propositionId);
      return record('belief_support', id);
    }
    case 'SET_BELIEF_ASSESSMENT': {
      const propositionId = resolveRef(context, operation.proposition);
      const assessment = await recordBeliefAssessment(context.tx, {
        ownerScopeId: owner, propositionId, assessmentStatus: operation.assessmentStatus,
        transactionId: context.transaction.id, validFrom: operation.validFrom ?? null, validTo: operation.validTo ?? null,
        decisionReason: operation.decisionReason ?? { code: 'GOVERNED_TRANSACTION' },
      });
      context.assessments.push(assessment);
      context.touchedPropositions.add(propositionId);
      return record('belief_assessments', assessment.id);
    }
    case 'DERIVE': {
      const derivedPropositionId = resolveRef(context, operation.derivedProposition);
      const dependency = await recordDerivedDependency(context.tx, {
        ownerScopeId: owner, derivedPropositionId, inputClaimIds: operation.inputClaimIds ?? [],
        inputPropositionIds: operation.inputPropositionIds ?? [], evaluatorId: operation.evaluatorId,
        modelOrCodeVersion: operation.modelOrCodeVersion, registryReleaseId: context.transaction.registryReleaseId,
        calculationInputs: operation.calculationInputs, createdByTransactionId: context.transaction.id,
      });
      context.touchedPropositions.add(derivedPropositionId);
      return record('derived_proposition_dependencies', dependency.id);
    }
    case 'QUALIFY': {
      // CRT-REG-06-B: this is the only governed path that moves a proposition
      // between context spaces, and the database refuses it outside a committing
      // transaction whatever role attempts it.
      const beliefSlotId = resolveRef(context, operation.beliefSlot);
      const changed = await context.tx.query(
        `UPDATE belief_slots SET context_space_id=coalesce($3,context_space_id),qualifiers=coalesce($4,qualifiers)
         WHERE owner_scope_id=$1 AND id=$2 RETURNING id`,
        [owner, beliefSlotId, operation.contextSpaceId ?? null,
          operation.qualifiers === undefined ? null : JSON.stringify(operation.qualifiers)]);
      if (changed.rowCount !== 1) throw new BeliefTransactionError('BELIEF_SLOT_NOT_FOUND', { beliefSlotId });
      return { objectType: 'belief_slots', objectId: beliefSlotId };
    }
    case 'SUPPRESS': {
      const targetId = resolveRef(context, operation.target);
      if (operation.targetObjectType === 'claim') {
        const changed = await context.tx.query(
          `UPDATE claims SET lifecycle='SUPPRESSED' WHERE owner_scope_id=$1 AND id=$2 RETURNING id`, [owner, targetId]);
        if (changed.rowCount !== 1) throw new BeliefTransactionError('CLAIM_NOT_FOUND', { claimId: targetId });
        return { objectType: 'claims', objectId: targetId };
      }
      const assessment = await recordBeliefAssessment(context.tx, {
        ownerScopeId: owner, propositionId: targetId, assessmentStatus: 'SUPPRESSED',
        transactionId: context.transaction.id, decisionReason: { code: 'OWNER_SUPPRESSION' },
      });
      context.assessments.push(assessment);
      context.touchedPropositions.add(targetId);
      return record('belief_assessments', assessment.id);
    }
    case 'MERGE': case 'SPLIT':
      return applyLineageOperation(context, order, operation);
    case 'ARCHIVE': case 'DELETE':
      throw new BeliefTransactionError('BELIEF_OPERATION_NOT_DELIVERED', { operationKind: operation.kind });
  }
}

/**
 * A governed merge or split (PRD §14, ADR 0025). The operation body lives in
 * `lineage.ts`; here it is bound to the committing transaction, its created rows
 * join the receipt, and its detail is what the operation's `result_object_refs`
 * records, so the endpoint can answer a retried request from the stored commit
 * rather than from a second run.
 */
async function applyLineageOperation(
  context: CommitContext, order: number, operation: Extract<BeliefOperation, { kind: 'MERGE' | 'SPLIT' }>,
): Promise<Record<string, unknown>> {
  const bound = {
    ownerScopeId: context.request.ownerScopeId, transactionId: context.transaction.id,
    registryReleaseId: context.transaction.registryReleaseId,
  };
  const targetObjectType = operation.targetObjectType ?? 'frame_instance';
  const target = resolveRef(context, operation.target);
  let result;
  try {
    if (operation.kind === 'MERGE') {
      const survivor = resolveRef(context, operation.survivor);
      result = targetObjectType === 'entity'
        ? await applyEntityMerge(context.tx, bound, { mergedEntityId: target, survivorEntityId: survivor, reason: operation.reason })
        : await applyFrameMerge(context.tx, bound, { mergedFrameInstanceId: target, survivorFrameInstanceId: survivor, reason: operation.reason });
    } else {
      result = targetObjectType === 'entity'
        ? await applyEntitySplit(context.tx, bound, { parentEntityId: target, partitions: operation.partitions,
          partitionSpecs: operation.partitionSpecs, reason: operation.reason,
          aliasAssignments: operation.aliasAssignments?.map(assignment => ({ aliasId: assignment.aliasId, partition: assignment.partition })) })
        : await applyFrameSplit(context.tx, bound, { parentFrameInstanceId: target, partitions: operation.partitions,
          partitionSpecs: operation.partitionSpecs, reason: operation.reason,
          claimAssignments: operation.claimAssignments?.map(assignment => ({ claimId: assignment.claimId, partition: assignment.partition })) });
    }
  } catch (error) {
    const code = lineageErrorCode(error);
    if (code !== null) throw new BeliefTransactionError(code, { operationKind: operation.kind });
    throw error;
  }
  for (const object of result.created) context.createdObjects.push({ operationOrder: order, ...object });
  context.assessments.push(...result.assessments);
  for (const propositionId of result.touchedPropositions) context.touchedPropositions.add(propositionId);
  return { objectType: targetObjectType === 'entity' ? 'entities' : 'frame_instances', objectId: target,
    targetObjectType, [operation.kind === 'MERGE' ? 'merge' : 'split']: result.detail };
}

/**
 * Commit a validated transaction (POST /v1/memory/transactions/{id}/commit).
 *
 * Two database transactions, for two different reasons. The first re-validates
 * and persists the policy decision, so a DENY is recorded and the transaction is
 * marked rejected even though nothing is committed (CRT-WRT-03-A). The second
 * applies every operation in order and stores the receipt; a failure anywhere in
 * it rolls the whole thing back, so no earlier operation is visible in any table
 * (CRT-WRT-02-A). A transaction that is already committed short-circuits in the
 * first and answers with the stored receipt (CRT-WRT-02-B).
 */
export async function commitBeliefTransaction(
  runner: BeliefTransactionRunner, request: GovernorRequest,
  input: { transactionId: string; idempotencyKey: string },
  ports: PolicyPorts = createLocalPolicyAdapters(),
): Promise<CommitReceipt> {
  const settled = await runner(BELIEF_PURPOSES.govern, async tx => {
    await enterEvidenceGate(tx, request);
    const transaction = await readTransaction(tx, request.ownerScopeId, input.transactionId, true);
    if (transaction.idempotencyKey !== input.idempotencyKey) {
      return { kind: 'REFUSED' as const, code: 'BELIEF_TRANSACTION_IDEMPOTENCY_KEY_MISMATCH', detail: {} };
    }
    if (transaction.status === 'COMMITTED') {
      if (!transaction.commitReceipt) return { kind: 'REFUSED' as const, code: 'BELIEF_TRANSACTION_RECEIPT_MISSING', detail: {} };
      return { kind: 'COMMITTED' as const, receipt: commitReceiptSchema.parse(transaction.commitReceipt) };
    }
    if (transaction.status === 'REJECTED') return { kind: 'REFUSED' as const, code: 'BELIEF_TRANSACTION_REJECTED', detail: {} };

    const operations = (await readOperations(tx, request.ownerScopeId, input.transactionId)).map(op => op.payload as unknown as BeliefOperation);
    const { report, policy, policyRequest } = await buildValidationReport(tx, request, transaction, operations, ports);
    const decisionId = await recordPolicyDecision(tx, {
      ownerScopeId: request.ownerScopeId, correlationId: request.correlationId, port: 'EvaluateMemoryWrite',
      request: policyRequest, verdict: policy, subjectTransactionId: transaction.id,
    });
    if (report.decision !== 'COMMITTABLE') {
      await tx.query(
        `UPDATE belief_transactions SET status='REJECTED',rejected_at=now(),admission_mode=$3,validation=$4,
          policy_decision=$5,policy_decision_id=$6,rejection_reason=$7 WHERE owner_scope_id=$1 AND id=$2`,
        [request.ownerScopeId, transaction.id, report.admissionMode, JSON.stringify(report), JSON.stringify(policy),
          decisionId, JSON.stringify({ decision: report.decision, reason: policy.reason })]);
      return { kind: 'REFUSED' as const, code: 'BELIEF_TRANSACTION_REFUSED',
        detail: { decision: report.decision, reason: policy.reason, policyDecisionId: decisionId, report } };
    }
    await tx.query(
      `UPDATE belief_transactions SET status='VALIDATED',admission_mode=$3,validation=$4,policy_decision=$5,policy_decision_id=$6
       WHERE owner_scope_id=$1 AND id=$2`,
      [request.ownerScopeId, transaction.id, report.admissionMode, JSON.stringify(report), JSON.stringify(policy), decisionId]);
    return { kind: 'VALIDATED' as const, report, policyDecisionId: decisionId };
  });

  if (settled.kind === 'COMMITTED') return settled.receipt;
  if (settled.kind === 'REFUSED') throw new BeliefTransactionError(settled.code, settled.detail);

  return runner(BELIEF_PURPOSES.govern, async tx => {
    await enterEvidenceGate(tx, request);
    const transaction = await readTransaction(tx, request.ownerScopeId, input.transactionId, true);
    if (transaction.status === 'COMMITTED') return commitReceiptSchema.parse(transaction.commitReceipt);
    // The governing-transaction marker the belief_slots trigger reads. It is
    // transaction-local and rolls back with everything else, so no context move
    // can outlive the commit that authorised it.
    await tx.query(`UPDATE belief_transactions SET status='COMMITTING' WHERE owner_scope_id=$1 AND id=$2`,
      [request.ownerScopeId, transaction.id]);
    await tx.query(`SELECT set_config('unai.belief_transaction_id',$1,true)`, [transaction.id]);

    const context: CommitContext = {
      tx, request, transaction, refs: new Map(), createdObjects: [], assessments: [], touchedPropositions: new Set(),
    };
    for (const stored of await readOperations(tx, request.ownerScopeId, input.transactionId)) {
      const result = await applyOperation(context, stored.order, stored.payload as unknown as BeliefOperation);
      await tx.query('UPDATE belief_transaction_operations SET result_object_refs=$3 WHERE owner_scope_id=$1 AND id=$2',
        [request.ownerScopeId, stored.id, JSON.stringify(result)]);
    }
    // A derivation whose inputs this very transaction invalidated moves to
    // UNSUPPORTED inside the same commit (CRT-AI-02-A).
    context.assessments.push(...await reassessDerivedPropositions(tx, {
      ownerScopeId: request.ownerScopeId, transactionId: transaction.id,
    }));
    // Every claim this commit created is indexed in the same transaction, so it is
    // semantically searchable the moment it is visible -- an unregistered surface
    // predicate included, which PRD §17.5 allows to be indexed -- and a rolled-back
    // commit leaves no index row behind (ADR 0024 §3). The index is not a belief
    // object, so the receipt does not list it.
    const createdClaimIds = context.createdObjects.filter(object => object.objectType === 'claims').map(object => object.objectId);
    await indexClaimEmbeddings(tx, { ownerScopeId: request.ownerScopeId, claimIds: createdClaimIds });
    // Evidence this commit brought in may contradict what the owner said and
    // nothing has verified yet. Such a delta becomes CONTESTED here, with its
    // record, and never disappears (PRD §21.7, CRT-RYW-05-A, ADR 0026 §6).
    await contestDeltasConflictingWithClaims(tx, { ownerScopeId: request.ownerScopeId, claimIds: createdClaimIds });

    const committedAt = (await tx.query('SELECT now() AS at')).rows[0]!['at'] as Date;
    const receipt = commitReceiptSchema.parse({
      transactionId: transaction.id, idempotencyKey: transaction.idempotencyKey,
      registryReleaseId: transaction.registryReleaseId, committedAt: committedAt.toISOString(),
      policyDecisionId: settled.policyDecisionId, admissionMode: settled.report.admissionMode,
      createdObjects: context.createdObjects,
      beliefAssessments: context.assessments.map(assessment => ({
        propositionId: assessment.propositionId, assessmentId: assessment.id,
        assessmentStatus: assessment.assessmentStatus, recordedAt: assessment.recordedAt,
      })),
      // Projection reducers are the typed-projection node's deliverable; this
      // receipt names the projections a commit affects and claims no rebuild it
      // did not perform.
      affectedProjections: [], projectionRebuildReceipts: [], receiptVersion: RECEIPT_VERSION,
    });
    await tx.query(
      `UPDATE belief_transactions SET status='COMMITTED',committed_at=$3,commit_receipt=$4 WHERE owner_scope_id=$1 AND id=$2`,
      [request.ownerScopeId, transaction.id, committedAt, JSON.stringify(receipt)]);
    return receipt;
  });
}

/** Read a stored receipt back without committing anything. */
export async function readCommitReceipt(
  runner: BeliefTransactionRunner, request: GovernorRequest, transactionId: string,
): Promise<CommitReceipt | null> {
  return runner(BELIEF_PURPOSES.inspect, async tx => {
    const row = (await tx.query('SELECT commit_receipt FROM belief_transactions WHERE owner_scope_id=$1 AND id=$2',
      [request.ownerScopeId, transactionId])).rows[0];
    const receipt = row?.['commit_receipt'];
    return receipt ? commitReceiptSchema.parse(receipt) : null;
  });
}
