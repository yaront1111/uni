/** `@unai/belief` -- the write governor.
 *
 * Nothing in the system writes an accepted belief except a Belief Transaction
 * that passed through this package (PRD §19.1). It delivers the transaction
 * service (propose, validate, atomic and idempotent commit), the append-only
 * belief assessment engine with its derived-dependency record and UNSUPPORTED
 * transition, the support graph with independence groups and circular-support
 * rejection, the seven admission modes, the three local policy ports with
 * their persisted decisions, and the governed merge and split operations with
 * their lineage (`lineage.ts`, ADR 0025).
 *
 * Every function takes a transaction runner the caller supplied, exactly as
 * `@unai/extraction` does. Nothing here opens a connection, commits on its own
 * behalf, calls a model or reaches the network.
 */
export {
  BELIEF_PURPOSES, VALIDATION_VERSION, RECEIPT_VERSION, BeliefTransactionError,
  proposeBeliefTransaction, validateBeliefTransaction, commitBeliefTransaction, readCommitReceipt,
  type BeliefTransactionStore, type BeliefTransactionRunner, type GovernorRequest,
} from './transactions.js';
export {
  BeliefAssessmentError, recordBeliefAssessment, readCurrentAssessment, readAssessmentHistory,
  recordDerivedDependency, readDerivedDependencies, reassessDerivedPropositions,
  type StoredAssessment, type DerivedDependency,
} from './assessments.js';
export {
  LineageOperationError, applyFrameMerge, applyFrameSplit, applyEntityMerge, applyEntitySplit, lineageErrorCode,
  type LineageOperationContext, type LineageOperationResult,
} from './lineage.js';
export {
  independenceGroupKey, derivedIndependenceGroupKey, independentSourceCount, findSupportCycle,
  type SupportOrigin, type SupportEdge,
} from './support.js';
export {
  selectAdmissionMode, autoAcceptConditionsWithheld, admittedAssessmentStatus,
  type AdmissionCandidate, type AdmissionDecision, type MemoryWorthiness,
} from './admission.js';
export {
  POLICY_VERSION, PolicyError, createLocalPolicyAdapters, recordPolicyDecision, readPolicyDecision,
  type PolicyPorts, type PolicyRequestBase, type MemoryWriteRequest, type MemoryReadRequest,
  type MemoryActionRequest, type Sensitivity,
} from './policy.js';
