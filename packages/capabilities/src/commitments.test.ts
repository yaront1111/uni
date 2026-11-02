import { commitmentReadingSchema } from '@unai/domain';
import { describe, expect, it } from 'vitest';
import { classifyCommitmentLanguage } from './commitments.js';

const VERSION = 'commitment-language-0.1.0';
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const a = (n: number): string => 'a'.repeat(n);

/** Parses under the unchanged schema and holds no lone surrogate in any field. */
function expectWellFormed(reading: ReturnType<typeof classifyCommitmentLanguage>): void {
  expect(() => commitmentReadingSchema.parse(reading)).not.toThrow();
  for (const value of Object.values(reading)) {
    if (typeof value === 'string') expect(LONE_SURROGATE.test(value)).toBe(false);
  }
}

function read(input: string | null) {
  const reading = classifyCommitmentLanguage(input);
  expectWellFormed(reading);
  return reading;
}

describe('classifyCommitmentLanguage answers for every input', () => {
  it('pins the answers that existed before (projections.test.ts)', () => {
    expect(read('I will send Daniel the report by Friday')).toEqual({
      language: 'COMMITMENT', matchedText: 'I will', actionDescription: 'send Daniel the report', dueTimeText: 'Friday',
      classifierVersion: VERSION,
    });
    expect(read('I am considering sending it Friday')).toEqual({
      language: 'CONSIDERATION', matchedText: 'considering', actionDescription: null, dueTimeText: null, classifierVersion: VERSION,
    });
    const none = { language: 'NONE', matchedText: null, actionDescription: null, dueTimeText: null, classifierVersion: VERSION };
    expect(read('The weather is fine')).toEqual(none);
    expect(read('')).toEqual(none);
    expect(read(null)).toEqual(none);
  });

  it('treats a due phrase over 512 units as no due phrase', () => {
    const long = read('I will send it by ' + a(600));
    expect(long.language).toBe('COMMITMENT');
    expect(long.matchedText).toBe('I will');
    expect(long.dueTimeText).toBeNull();
    expect(long.actionDescription === 'send it by ' + a(600)).toBe(true);
  });

  it('keeps a due phrase of exactly 512 units and drops one of 513', () => {
    const at = read('I will send it by ' + a(512));
    expect(at.actionDescription).toBe('send it');
    expect(at.dueTimeText === a(512)).toBe(true);
    const over = read('I will send it by ' + a(513));
    expect(over.dueTimeText).toBeNull();
    expect(over.actionDescription === 'send it by ' + a(513)).toBe(true);
  });

  it('cuts an action over 4096 units and keeps one of 4096 or less', () => {
    const over = read('I will ' + a(4100));
    expect(over.language).toBe('COMMITMENT');
    expect(over.dueTimeText).toBeNull();
    expect(over.actionDescription === a(4096)).toBe(true);
    expect(read('I will ' + a(4096)).actionDescription === a(4096)).toBe(true);
    expect(read('I will ' + a(3993)).actionDescription === a(3993)).toBe(true);
  });

  it('never splits a surrogate pair at the cut', () => {
    const split = read('I will ' + a(4095) + '\u{1F600}' + 'b');
    expect(split.actionDescription === a(4095)).toBe(true);
    // A pair that ends exactly at the bound is kept whole.
    const whole = read('I will ' + a(4094) + '\u{1F600}' + 'b');
    expect(whole.actionDescription === a(4094) + '\u{1F600}').toBe(true);
  });

  it('keeps an empty due capture as before', () => {
    expect(read('I will send it by  .').dueTimeText).toBe('');
  });
});
