import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * CRT-NFR-08-A, second half: the belief engine runs in unit tests with no LLM
 * gateway configured (PRD §32 "The belief engine must be executable in unit
 * tests without an LLM").
 *
 * Every model-gateway variable is removed from the environment *before* the
 * engine is loaded, and the engine is imported only afterwards, so nothing it
 * reads at load time can have seen a configured model. The decisions below --
 * admission, the auto-accept conditions, independence and circular support --
 * are then made with no gateway anywhere in the process. `src/boundaries.test.ts`
 * proves statically that the engine's import closure holds no gateway module.
 */

const saved = new Map<string, string | undefined>();
beforeAll(() => {
  for (const name of Object.keys(process.env)) {
    if (/^(UNAI_MODEL_|ANTHROPIC_|OPENAI_)/.test(name)) { saved.set(name, process.env[name]); delete process.env[name]; }
  }
});
afterAll(() => { for (const [name, value] of saved) if (value !== undefined) process.env[name] = value; });

const daniel = '018f1c00-0000-7000-8000-000000000001';
const alice = '018f1c00-0000-7000-8000-000000000002';

describe('CRT-NFR-08-A: the belief engine with no LLM gateway configured', () => {
  it('decides admission, independence and circular support without a model', async () => {
    expect(Object.keys(process.env).filter(name => /^(UNAI_MODEL_|ANTHROPIC_|OPENAI_)/.test(name))).toEqual([]);
    const engine = await import('./index.js');

    const candidate = { memoryWorthiness: 'SEMANTIC' as const, predicateRegistered: true, identityResolved: true,
      sourceAuthoritative: true, materialConflict: false, errorConsequence: 'LOW' as const, reversible: true, audited: true,
      blocksCurrentAnswer: false };
    const accepted = engine.selectAdmissionMode(candidate);
    expect(accepted.mode).toBe('AUTO_ACCEPT');
    expect(engine.admittedAssessmentStatus(accepted.mode)).toBe('ACCEPTED');
    // An unregistered predicate never becomes a canonical belief.
    expect(engine.selectAdmissionMode({ ...candidate, predicateRegistered: false }).mode).toBe('INDEX_ONLY');
    // A material conflict is never accepted automatically.
    const conflicted = engine.selectAdmissionMode({ ...candidate, materialConflict: true });
    expect(conflicted.mode).toBe('BATCH_REVIEW');
    expect(engine.autoAcceptConditionsWithheld({ ...candidate, materialConflict: true })).toEqual(['NO_MATERIAL_CONFLICT']);

    const origin = (assertedByEntityId: string) => ({ assertedByEntityId, sourceActorEntityId: null, sourceActorRef: null,
      connectorId: null, sourceType: 'EMAIL' });
    const groups = [engine.independenceGroupKey(origin(daniel)), engine.independenceGroupKey(origin(daniel)),
      engine.independenceGroupKey(origin(alice))];
    expect(engine.independentSourceCount(groups)).toBe(2);
    expect(engine.findSupportCycle([{ propositionId: 'a', supportingPropositionId: 'b' }, { propositionId: 'b', supportingPropositionId: 'a' }]))
      .not.toBeNull();
    // The engine's local policy ports decide without any model either.
    expect(typeof engine.createLocalPolicyAdapters).toBe('function');
  });
});
