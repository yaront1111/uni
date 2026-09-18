import { admissionModeSchema, type AdmissionMode, type AutoAcceptCondition } from '@unai/domain';

/** Memory admission (PRD §19.2).
 *
 * Pure: no transaction, no clock, no registry read. The caller establishes the
 * facts -- is the predicate in the pinned release, is identity resolved, is the
 * source authoritative for this field, is there a material conflict, what does an
 * error cost, is the operation reversible and audited -- and this module decides
 * which of the seven admission modes those facts earn.
 */

/** How much of the item is worth keeping at all, decided upstream by triage
 * (PRD §20.2). `NONE` keeps the evidence and nothing else; `INDEX` adds search
 * without canonical belief; `DIRECTLY_PROVEN` is what the source itself proves,
 * such as "Daniel sent this message"; `SEMANTIC` is a candidate belief. */
export type MemoryWorthiness = 'NONE' | 'INDEX' | 'DIRECTLY_PROVEN' | 'SEMANTIC';

export interface AdmissionCandidate {
  readonly memoryWorthiness: MemoryWorthiness;
  /** The predicate and frame type are present in the pinned registry release. */
  readonly predicateRegistered: boolean;
  /** Entity and instance identity are resolved well enough to name one object. */
  readonly identityResolved: boolean;
  /** The source is authoritative for this field, not merely present near it. */
  readonly sourceAuthoritative: boolean;
  /** A competing accepted value exists for the same slot. */
  readonly materialConflict: boolean;
  readonly errorConsequence: 'LOW' | 'MEDIUM' | 'HIGH';
  readonly reversible: boolean;
  readonly audited: boolean;
  /** An unresolved ambiguity is blocking the answer or action in front of the owner. */
  readonly blocksCurrentAnswer: boolean;
}

export interface AdmissionDecision {
  readonly mode: AdmissionMode;
  readonly reason: string;
  /** Every `AUTO_ACCEPT` condition this candidate fails. Empty is the only way to
   * reach `AUTO_ACCEPT`; a caller reads this to say which one withheld it. */
  readonly withheldConditions: readonly AutoAcceptCondition[];
}

/** The six conditions of PRD §19.2, evaluated independently so a refusal names
 * every one that failed rather than only the first. */
export function autoAcceptConditionsWithheld(candidate: AdmissionCandidate): AutoAcceptCondition[] {
  const withheld: AutoAcceptCondition[] = [];
  if (!candidate.predicateRegistered) withheld.push('PREDICATE_REGISTERED');
  if (!candidate.identityResolved) withheld.push('IDENTITY_RESOLVED');
  if (!candidate.sourceAuthoritative) withheld.push('SOURCE_AUTHORITATIVE');
  if (candidate.materialConflict) withheld.push('NO_MATERIAL_CONFLICT');
  if (candidate.errorConsequence !== 'LOW') withheld.push('LOW_CONSEQUENCE');
  if (!candidate.reversible || !candidate.audited) withheld.push('REVERSIBLE_AND_AUDITED');
  return withheld;
}

/**
 * The admission mode a candidate earns (CRT-WRT-04-A).
 *
 * `AUTO_ACCEPT` is reachable only with an empty `withheldConditions`; every other
 * branch below is an explicit answer to a specific failure, so no ordering choice
 * can let a candidate that fails a required condition be auto-accepted.
 */
export function selectAdmissionMode(candidate: AdmissionCandidate): AdmissionDecision {
  const withheldConditions = autoAcceptConditionsWithheld(candidate);
  const decide = (mode: AdmissionMode, reason: string): AdmissionDecision =>
    Object.freeze({ mode: admissionModeSchema.parse(mode), reason, withheldConditions: Object.freeze(withheldConditions) });

  if (candidate.memoryWorthiness === 'NONE') return decide('SOURCE_ONLY', 'NOT_MEMORY_WORTHY');
  // A predicate the pinned release does not define has no canonical location to
  // be written to at all, so the item is preserved and indexed instead
  // (CRT-MEM-01-A refuses the accepted assessment for the same reason).
  if (!candidate.predicateRegistered) return decide('INDEX_ONLY', 'PREDICATE_NOT_IN_PINNED_RELEASE');
  if (candidate.memoryWorthiness === 'INDEX') return decide('INDEX_ONLY', 'INDEX_WITHOUT_CANONICAL_BELIEF');
  if (candidate.memoryWorthiness === 'DIRECTLY_PROVEN') return decide('AUTO_CLAIM', 'DIRECTLY_PROVEN_BY_SOURCE');
  if (withheldConditions.length === 0) return decide('AUTO_ACCEPT', 'ALL_AUTO_ACCEPT_CONDITIONS_MET');
  // Asking is permitted only when the ambiguity blocks the work in front of the
  // owner; ingestion uncertainty alone never interrupts (PRD §19.3).
  if (candidate.blocksCurrentAnswer) return decide('JUST_IN_TIME', 'AMBIGUITY_BLOCKS_CURRENT_ANSWER');
  if (candidate.materialConflict || !candidate.identityResolved
    || candidate.errorConsequence !== 'LOW' || !candidate.reversible || !candidate.audited) {
    return decide('BATCH_REVIEW', 'MATERIAL_AMBIGUITY_QUEUED_FOR_REVIEW');
  }
  return decide('AUTO_PROVISIONAL', 'USEFUL_BUT_UNCERTAIN');
}

/** The strongest assessment an admission mode may place on a belief.
 *
 * `AUTO_ACCEPT` is the only mode that reaches `ACCEPTED`, which is the whole
 * point of the mode (PRD §19.1/§19.2). `AUTO_CLAIM` deliberately does not:
 * committing what the source directly proves records the *claim*, and the belief
 * it bears on stays a candidate until a mode that may accept one says otherwise.
 */
export function admittedAssessmentStatus(mode: AdmissionMode): 'ACCEPTED' | 'PROVISIONAL' | 'CANDIDATE' | null {
  switch (mode) {
    case 'AUTO_ACCEPT': return 'ACCEPTED';
    case 'AUTO_PROVISIONAL': return 'PROVISIONAL';
    case 'AUTO_CLAIM': case 'BATCH_REVIEW': case 'JUST_IN_TIME': return 'CANDIDATE';
    case 'SOURCE_ONLY': case 'INDEX_ONLY': return null;
  }
}
