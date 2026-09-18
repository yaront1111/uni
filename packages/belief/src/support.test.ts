import { describe, expect, it } from 'vitest';
import { derivedIndependenceGroupKey, findSupportCycle, independenceGroupKey, independentSourceCount, type SupportOrigin } from './support.js';

/** The independence rule of PRD §15.4 and the circular-support rule of §15.4,
 * as pure facts about the key function and the graph walk. The database-backed
 * half of CRT-MEM-12-A and CRT-MEM-12-B is in `governor.test.ts`. */

const daniel = '018f1c00-0000-7000-8000-000000000001';
const alice = '018f1c00-0000-7000-8000-000000000002';
const gmail = '018f1c00-0000-7000-8000-0000000000a1';

function origin(over: Partial<SupportOrigin> = {}): SupportOrigin {
  return { assertedByEntityId: null, sourceActorEntityId: null, sourceActorRef: null,
    connectorId: gmail, sourceType: 'EMAIL', ...over };
}

describe('independence groups (PRD §15.4)', () => {
  it('CRT-MEM-12-A: repeated messages, quoted history and a model summary of one source share one group', () => {
    // Three separate messages Daniel sent.
    const first = independenceGroupKey(origin({ assertedByEntityId: daniel }));
    const second = independenceGroupKey(origin({ assertedByEntityId: daniel }));
    const third = independenceGroupKey(origin({ assertedByEntityId: daniel }));
    // Daniel's earlier words quoted inside a message Alice sent: the anchor sits
    // in Alice's item, but Daniel is still the asserting party.
    const quoted = independenceGroupKey(origin({ assertedByEntityId: daniel, sourceActorEntityId: alice }));
    // A model summary of that same message. The model is not a party.
    const summarised = independenceGroupKey(origin({ assertedByEntityId: daniel, connectorId: null, sourceType: 'CONVERSATION' }));
    const groups = [first, second, third, quoted, summarised];
    expect(new Set(groups).size).toBe(1);
    expect(independentSourceCount(groups)).toBe(1);
  });

  it('CRT-MEM-12-A: a genuinely different asserting party is a second group', () => {
    const groups = [independenceGroupKey(origin({ assertedByEntityId: daniel })), independenceGroupKey(origin({ assertedByEntityId: alice }))];
    expect(new Set(groups).size).toBe(2);
    expect(independentSourceCount(groups)).toBe(2);
  });

  it('falls back to the retained actor reference when no entity is resolved, and keeps channels apart', () => {
    const unresolved = origin({ sourceActorRef: { type: 'EXTERNAL', address: 'daniel@example.invalid' } });
    expect(independenceGroupKey(unresolved)).toBe(independenceGroupKey({ ...unresolved }));
    expect(independenceGroupKey(unresolved)).not.toBe(independenceGroupKey({ ...unresolved, connectorId: null, sourceType: 'DOCUMENT' }));
    // The source item's own actor stands in when the claim names no asserting entity.
    expect(independenceGroupKey(origin({ sourceActorEntityId: daniel }))).toBe(independenceGroupKey(origin({ assertedByEntityId: daniel })));
  });

  it('a derivation is exactly as independent as its own support, never more', () => {
    const one = independenceGroupKey(origin({ assertedByEntityId: daniel }));
    expect(derivedIndependenceGroupKey([one])).toBe(one);
    expect(derivedIndependenceGroupKey([one, one])).toBe(one);
    const two = independenceGroupKey(origin({ assertedByEntityId: alice }));
    const composite = derivedIndependenceGroupKey([one, two]);
    expect(composite).toBe(derivedIndependenceGroupKey([two, one]));
    expect(independentSourceCount([composite])).toBe(1);
  });

  it('every key satisfies the stored column constraint', () => {
    for (const key of [independenceGroupKey(origin({ assertedByEntityId: daniel })), independenceGroupKey(origin()),
      derivedIndependenceGroupKey([]), derivedIndependenceGroupKey(['entity:' + daniel, 'entity:' + alice])]) {
      expect(key).toMatch(/^[a-z0-9][a-z0-9_.:-]{0,127}$/);
    }
  });
});

describe('circular support (PRD §15.4)', () => {
  const a = 'p-a', b = 'p-b', c = 'p-c';
  it('CRT-MEM-12-B: finds a cycle a proposed edge would close', () => {
    const stored = [{ propositionId: a, supportingPropositionId: b }, { propositionId: b, supportingPropositionId: c }];
    expect(findSupportCycle(stored)).toBeNull();
    const cycle = findSupportCycle([...stored, { propositionId: c, supportingPropositionId: a }]);
    expect(cycle).not.toBeNull();
    expect(new Set(cycle!)).toEqual(new Set([a, b, c]));
    expect(cycle![0]).toBe(cycle![cycle!.length - 1]);
  });

  it('CRT-MEM-12-B: finds the two-step cycle and the self cycle', () => {
    expect(findSupportCycle([{ propositionId: a, supportingPropositionId: b }, { propositionId: b, supportingPropositionId: a }])).toEqual([a, b, a]);
    expect(findSupportCycle([{ propositionId: a, supportingPropositionId: a }])).toEqual([a, a]);
  });

  it('accepts a diamond, which shares a supporter without closing a loop', () => {
    expect(findSupportCycle([
      { propositionId: a, supportingPropositionId: b }, { propositionId: a, supportingPropositionId: c },
      { propositionId: b, supportingPropositionId: 'p-d' }, { propositionId: c, supportingPropositionId: 'p-d' },
    ])).toBeNull();
  });
});
