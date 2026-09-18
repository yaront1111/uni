import { describe, expect, it } from 'vitest';
import { admissionModeSchema, autoAcceptConditionSchema } from '@unai/domain';
import { admittedAssessmentStatus, autoAcceptConditionsWithheld, selectAdmissionMode, type AdmissionCandidate } from './admission.js';

/** CRT-WRT-04-A. The fixture exercises each of the seven admission modes, and
 * then each of the six conditions PRD §19.2 requires of AUTO_ACCEPT, one at a
 * time, against a candidate that would otherwise be auto-accepted. */

/** A candidate that meets every condition. Each case below spoils exactly one
 * field, so nothing but the named condition can explain the change. */
const qualified: AdmissionCandidate = Object.freeze({
  memoryWorthiness: 'SEMANTIC', predicateRegistered: true, identityResolved: true, sourceAuthoritative: true,
  materialConflict: false, errorConsequence: 'LOW', reversible: true, audited: true, blocksCurrentAnswer: false,
});

describe('admission modes (PRD §19.2)', () => {
  it('CRT-WRT-04-A: reaches each of the seven modes', () => {
    const cases: [string, AdmissionCandidate][] = [
      ['SOURCE_ONLY', { ...qualified, memoryWorthiness: 'NONE' }],
      ['INDEX_ONLY', { ...qualified, memoryWorthiness: 'INDEX' }],
      ['AUTO_CLAIM', { ...qualified, memoryWorthiness: 'DIRECTLY_PROVEN' }],
      ['AUTO_ACCEPT', qualified],
      ['AUTO_PROVISIONAL', { ...qualified, sourceAuthoritative: false }],
      ['BATCH_REVIEW', { ...qualified, materialConflict: true }],
      ['JUST_IN_TIME', { ...qualified, identityResolved: false, blocksCurrentAnswer: true }],
    ];
    for (const [expected, candidate] of cases) {
      const decision = selectAdmissionMode(candidate);
      expect(decision.mode, expected).toBe(expected);
      expect(admissionModeSchema.parse(decision.mode)).toBe(expected);
      expect(decision.reason).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
    expect(new Set(cases.map(([mode]) => mode)).size).toBe(admissionModeSchema.options.length);
  });

  it('CRT-WRT-04-A: withholds AUTO_ACCEPT from a candidate failing any single required condition', () => {
    const failures: [string, AdmissionCandidate][] = [
      ['PREDICATE_REGISTERED', { ...qualified, predicateRegistered: false }],
      ['IDENTITY_RESOLVED', { ...qualified, identityResolved: false }],
      ['SOURCE_AUTHORITATIVE', { ...qualified, sourceAuthoritative: false }],
      ['NO_MATERIAL_CONFLICT', { ...qualified, materialConflict: true }],
      ['LOW_CONSEQUENCE', { ...qualified, errorConsequence: 'MEDIUM' }],
      ['REVERSIBLE_AND_AUDITED', { ...qualified, reversible: false }],
    ];
    for (const [condition, candidate] of failures) {
      const decision = selectAdmissionMode(candidate);
      expect(decision.mode, condition).not.toBe('AUTO_ACCEPT');
      expect(decision.withheldConditions, condition).toContain(condition);
      // Nothing but AUTO_ACCEPT may place an accepted belief, so the mode this
      // candidate earned cannot accept one either.
      expect(admittedAssessmentStatus(decision.mode), condition).not.toBe('ACCEPTED');
    }
    // Every named condition is covered, and each of the six is reachable.
    expect(failures.map(([condition]) => condition).sort()).toEqual([...autoAcceptConditionSchema.options].sort());
  });

  it('CRT-WRT-04-A: an audited-but-irreversible candidate fails the same condition as an unaudited one', () => {
    expect(autoAcceptConditionsWithheld({ ...qualified, reversible: false })).toEqual(['REVERSIBLE_AND_AUDITED']);
    expect(autoAcceptConditionsWithheld({ ...qualified, audited: false })).toEqual(['REVERSIBLE_AND_AUDITED']);
    expect(autoAcceptConditionsWithheld({ ...qualified, errorConsequence: 'HIGH' })).toEqual(['LOW_CONSEQUENCE']);
  });

  it('reports every failing condition, not only the first', () => {
    const decision = selectAdmissionMode({
      ...qualified, predicateRegistered: false, identityResolved: false, sourceAuthoritative: false,
      materialConflict: true, errorConsequence: 'HIGH', reversible: false,
    });
    expect([...decision.withheldConditions].sort()).toEqual([...autoAcceptConditionSchema.options].sort());
    expect(decision.mode).toBe('INDEX_ONLY');
  });

  it('AUTO_ACCEPT is the only mode that admits an ACCEPTED belief', () => {
    const accepting = admissionModeSchema.options.filter(mode => admittedAssessmentStatus(mode) === 'ACCEPTED');
    expect(accepting).toEqual(['AUTO_ACCEPT']);
    // Preserving evidence without a canonical belief admits no assessment at all.
    expect(admittedAssessmentStatus('SOURCE_ONLY')).toBeNull();
    expect(admittedAssessmentStatus('INDEX_ONLY')).toBeNull();
  });
});
