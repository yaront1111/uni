import { policyVerdictSchema, type PolicyVerdict } from '@unai/domain';
import type { MemoryTransaction } from '@unai/memory';
import { uuidV7 } from '../../../src/kernel/identities.js';

/** The three local policy ports (PRD §29.3).
 *
 * V0 ships local adapters behind stable interfaces and no Cordum or CAP
 * dependency. Every adapter is a pure decision over the request it was handed;
 * persisting the decision is `recordPolicyDecision`'s work, and it happens for
 * every evaluation, allowed or refused, because the audit trail is the point
 * (CRT-WRT-03-A).
 */

export const POLICY_VERSION = 'local-policy-0.1.0';

export class PolicyError extends Error {
  constructor(code: string) { super(code); this.name = 'PolicyError'; }
}

const SENSITIVITY_ORDER = ['NORMAL', 'PRIVATE', 'RESTRICTED'] as const;
export type Sensitivity = (typeof SENSITIVITY_ORDER)[number];

/** Every port request carries the same authority preamble (PRD §29.3). */
export interface PolicyRequestBase {
  readonly actorId: string;
  readonly ownerScopeId: string;
  readonly purpose: string;
  readonly sensitivity: Sensitivity;
  readonly evidenceRefs: readonly string[];
  readonly risk: 'LOW' | 'MEDIUM' | 'HIGH';
}

export interface MemoryWriteRequest extends PolicyRequestBase {
  readonly proposedChanges: {
    readonly transactionKind: string;
    readonly operationKinds: readonly string[];
    /** True when the transaction would place an ACCEPTED assessment. */
    readonly setsAcceptedAssessment: boolean;
    /** True when every claim the transaction records comes from a model or a
     * connector rather than the owner or an authoritative receipt. */
    readonly modelOrConnectorAuthored: boolean;
    readonly identityResolved: boolean;
  };
}

export interface MemoryReadRequest extends PolicyRequestBase {
  readonly requestedObjects: readonly { readonly objectType: string; readonly objectId: string; readonly sensitivity: Sensitivity }[];
  readonly maximumSensitivity: Sensitivity;
  readonly allowedPurposes: readonly string[];
}

export interface MemoryActionRequest extends PolicyRequestBase {
  readonly actionKind: 'DRAFT' | 'EMAIL_SEND' | 'CALENDAR_WRITE' | 'MONEY_MOVEMENT' | 'TRADE';
  /** The purposes the evidence behind the memory this action rests on admits,
   * in the port's own purpose vocabulary -- the same field, and the same meaning,
   * as on a read. An action is founded on memory, so it is bound by what that
   * memory's evidence was allowed to be used for, and not only by whether the
   * actor may act at all (CRT-SEC-02-A). */
  readonly allowedPurposes: readonly string[];
  readonly capabilityGranted: boolean;
  /** The strongest assessment behind the memory this action rests on. */
  readonly supportingAssessment: 'ACCEPTED' | 'PROVISIONAL' | 'CONTESTED' | 'UNSUPPORTED' | 'NONE';
  readonly projectionComplete: boolean;
}

export interface PolicyPorts {
  evaluateMemoryWrite(request: MemoryWriteRequest): Promise<PolicyVerdict>;
  evaluateMemoryRead(request: MemoryReadRequest): Promise<PolicyVerdict>;
  evaluateMemoryAction(request: MemoryActionRequest): Promise<PolicyVerdict>;
}

function verdict(outcome: PolicyVerdict['outcome'], reason: string, extra: Partial<PolicyVerdict> = {}): PolicyVerdict {
  return Object.freeze(policyVerdictSchema.parse({
    outcome, reason, policyVersion: POLICY_VERSION,
    requiredConfirmation: outcome === 'REQUIRE_CONFIRMATION',
    redactions: [], obligations: [], expiry: null, ...extra,
  }));
}

/** The write purposes a governed memory write may declare. A purpose outside this
 * set never reaches a commit, whatever the row-level policies would have said. */
const WRITE_PURPOSES = new Set(['memory.govern']);
const READ_PURPOSES = new Set(['memory.read', 'memory.inspect', 'memory.govern']);
const ACTION_PURPOSES = new Set(['memory.act']);

/**
 * The V0 local adapters.
 *
 * Every rule below is a PRD rule, not a placeholder: a model or connector path may
 * never write an accepted belief (§19.1), a high-risk write needs confirmation
 * (§29.3/§25), a read never returns an object above its declared ceiling (§26),
 * and every external action kind except a draft is refused in V0 (§27).
 */
export function createLocalPolicyAdapters(): PolicyPorts {
  return Object.freeze({
    async evaluateMemoryWrite(request: MemoryWriteRequest): Promise<PolicyVerdict> {
      if (!WRITE_PURPOSES.has(request.purpose)) return verdict('DENY', 'PURPOSE_NOT_PERMITTED_FOR_WRITE');
      // PRD §19.1: a model may propose a semantic update; it may not accept one.
      if (request.proposedChanges.setsAcceptedAssessment && request.proposedChanges.modelOrConnectorAuthored) {
        return verdict('DENY', 'MODEL_PATH_MAY_NOT_ACCEPT_BELIEF');
      }
      if (request.proposedChanges.setsAcceptedAssessment && request.evidenceRefs.length === 0) {
        return verdict('DENY', 'ACCEPTED_BELIEF_REQUIRES_EVIDENCE');
      }
      if (request.risk === 'HIGH') return verdict('REQUIRE_CONFIRMATION', 'HIGH_RISK_WRITE_NEEDS_CONFIRMATION');
      if (!request.proposedChanges.identityResolved) return verdict('STAGE', 'IDENTITY_UNRESOLVED');
      return verdict('ALLOW', 'WRITE_WITHIN_LOCAL_POLICY');
    },

    async evaluateMemoryRead(request: MemoryReadRequest): Promise<PolicyVerdict> {
      if (!READ_PURPOSES.has(request.purpose)) return verdict('DENY', 'PURPOSE_NOT_PERMITTED_FOR_READ');
      if (!request.allowedPurposes.includes(request.purpose)) return verdict('DENY', 'PURPOSE_NOT_IN_ALLOWED_PURPOSES');
      const ceiling = SENSITIVITY_ORDER.indexOf(request.maximumSensitivity);
      // A withheld object is listed as a redaction and never silently dropped.
      const redactions = request.requestedObjects
        .filter(object => SENSITIVITY_ORDER.indexOf(object.sensitivity) > ceiling)
        .map(object => ({ objectType: object.objectType, objectId: object.objectId, reason: 'ABOVE_MAXIMUM_SENSITIVITY' }));
      if (redactions.length === request.requestedObjects.length && redactions.length > 0) {
        return verdict('DENY', 'EVERY_OBJECT_ABOVE_MAXIMUM_SENSITIVITY', { redactions });
      }
      if (redactions.length > 0) return verdict('REDACT', 'OBJECTS_ABOVE_MAXIMUM_SENSITIVITY', { redactions });
      return verdict('ALLOW', 'READ_WITHIN_LOCAL_POLICY');
    },

    async evaluateMemoryAction(request: MemoryActionRequest): Promise<PolicyVerdict> {
      if (!ACTION_PURPOSES.has(request.purpose)) return verdict('DENY', 'PURPOSE_NOT_PERMITTED_FOR_ACTION');
      // The same rule a read is held to: an action whose purpose the supporting
      // evidence never admitted is denied before anything else about the action is
      // considered -- its kind, its capability and its support do not arise
      // (CRT-SEC-02-A).
      if (!request.allowedPurposes.includes(request.purpose)) return verdict('DENY', 'PURPOSE_NOT_IN_ALLOWED_PURPOSES');
      // PRD §27: in V0 the only external write is a draft, and even that needs its
      // discrete capability. Execution facts arrive as ingested tool receipts.
      if (request.actionKind !== 'DRAFT') return verdict('DENY', 'EXTERNAL_ACTION_REFUSED_IN_V0');
      if (!request.capabilityGranted) return verdict('DENY', 'CAPABILITY_NOT_GRANTED');
      if (request.supportingAssessment !== 'ACCEPTED' || !request.projectionComplete) {
        return request.risk === 'HIGH'
          ? verdict('DENY', 'HIGH_RISK_ACTION_ON_UNSETTLED_MEMORY')
          : verdict('REQUIRE_CONFIRMATION', 'ACTION_ON_UNSETTLED_MEMORY');
      }
      return verdict('ALLOW', 'ACTION_WITHIN_LOCAL_POLICY');
    },
  });
}

/**
 * Persist one port decision (design entity `policy_decisions`).
 *
 * The row records outcome, reason and policy version for every evaluation, which
 * is what CRT-WRT-03-A reads back after a denied write. The request is stored as
 * the port received it minus anything private: object ids and classifications,
 * never payload text, never a source excerpt.
 */
export async function recordPolicyDecision(
  tx: MemoryTransaction,
  input: {
    ownerScopeId: string; correlationId: string;
    port: 'EvaluateMemoryWrite' | 'EvaluateMemoryRead' | 'EvaluateMemoryAction';
    request: Record<string, unknown>; verdict: PolicyVerdict; subjectTransactionId?: string | null;
  },
): Promise<string> {
  const decision = policyVerdictSchema.parse(input.verdict);
  const id = uuidV7();
  await tx.query(
    `INSERT INTO policy_decisions(id,owner_scope_id,port,request,outcome,required_confirmation,redactions,obligations,
      expiry,reason,policy_version,subject_transaction_id,correlation_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [id, input.ownerScopeId, input.port, JSON.stringify(input.request), decision.outcome, decision.requiredConfirmation,
      JSON.stringify(decision.redactions), JSON.stringify(decision.obligations), decision.expiry, decision.reason,
      decision.policyVersion, input.subjectTransactionId ?? null, input.correlationId],
  );
  return id;
}

/** Read one persisted decision back, for audit and for the transaction receipt. */
export async function readPolicyDecision(tx: MemoryTransaction, ownerScopeId: string, id: string): Promise<{
  id: string; port: string; outcome: string; reason: string; policyVersion: string; requiredConfirmation: boolean;
  subjectTransactionId: string | null; createdAt: string;
} | null> {
  const row = (await tx.query(
    `SELECT id,port,outcome,reason,policy_version,required_confirmation,subject_transaction_id,created_at
     FROM policy_decisions WHERE owner_scope_id=$1 AND id=$2`, [ownerScopeId, id])).rows[0];
  if (!row) return null;
  return {
    id: row['id'] as string, port: row['port'] as string, outcome: row['outcome'] as string,
    reason: row['reason'] as string, policyVersion: row['policy_version'] as string,
    requiredConfirmation: row['required_confirmation'] as boolean,
    subjectTransactionId: (row['subject_transaction_id'] as string | null) ?? null,
    createdAt: (row['created_at'] as Date).toISOString(),
  };
}
