import { describe, expect, it } from 'vitest';
import { candidateStatementOf, transcriptSegmentOf } from './why.js';

/**
 * The candidate statement's wording and the transcript segment of a Why excerpt,
 * with no database (ADR 0047 D4, D5). The statement is built by code from the
 * anchor's exact words: only the anchor's speakerRole decides "You", and a label
 * can never make a bystander read as the owner. `packages/api/src/today.test.ts`
 * and `omi-pipeline.test.ts` run the same rules through the routes.
 */

const anchor = (overrides: Record<string, unknown> = {}) => ({
  conversationExternalId: 'conv_2026-11.a', segmentIndex: 2, speakerId: '1', speakerName: 'User', speakerRole: 'OWNER',
  startSeconds: 8.6, endSeconds: 13.1, start: 0, end: 20, ...overrides,
});
const segment = (overrides: Record<string, unknown> = {}) => transcriptSegmentOf('TRANSCRIPT_SEGMENT', anchor(overrides));
const QUOTE = 'pay you the 450 euro deposit by Friday 14 November';

describe('transcriptSegmentOf', () => {
  it('keeps the position, the role and the label of a stored Omi anchor, and nothing else', () => {
    expect(segment()).toEqual({
      conversationExternalId: 'conv_2026-11.a', segmentIndex: 2, speakerLabel: 'User', speakerRole: 'OWNER',
      startSeconds: 8.6, endSeconds: 13.1,
    });
  });

  it('collapses whitespace in the label and caps it at 80 characters', () => {
    expect(segment({ speakerName: '  Dana\n  Levi ', speakerRole: 'OTHER' })?.speakerLabel).toBe('Dana Levi');
    const long = segment({ speakerName: 'N'.repeat(200), speakerRole: 'OTHER' })?.speakerLabel;
    expect(long).toBe('N'.repeat(79) + '…');
    expect(long).toHaveLength(80);
  });

  it('nulls a missing, empty or non-text label and one that reads as the owner', () => {
    expect(segment({ speakerName: null, speakerRole: 'OTHER' })?.speakerLabel).toBeNull();
    expect(segment({ speakerName: '   ', speakerRole: 'OTHER' })?.speakerLabel).toBeNull();
    expect(segment({ speakerName: 7, speakerRole: 'OTHER' })?.speakerLabel).toBeNull();
    expect(segment({ speakerName: ' YOU ', speakerRole: 'OTHER' })).toMatchObject({ speakerLabel: null, speakerRole: 'OTHER' });
    expect(segment({ speakerName: 'you', speakerRole: 'OWNER' })).toMatchObject({ speakerLabel: null, speakerRole: 'OWNER' });
    expect(segment({ speakerName: 'Young', speakerRole: 'OTHER' })?.speakerLabel).toBe('Young');
  });

  it('is null for any other anchor kind', () => {
    expect(transcriptSegmentOf('MESSAGE_SPAN', anchor())).toBeNull();
    expect(transcriptSegmentOf('DOCUMENT_RANGE', anchor())).toBeNull();
  });

  it('degrades a malformed transcript anchor to null and never throws', () => {
    expect(segment({ segmentIndex: '2' })).toBeNull();
    expect(segment({ segmentIndex: 2.5 })).toBeNull();
    expect(segment({ segmentIndex: 2048 })).toBeNull();
    expect(segment({ speakerRole: undefined })).toBeNull();
    expect(segment({ speakerRole: 'ME' })).toBeNull();
    expect(segment({ conversationExternalId: 'conv 1' })).toBeNull();
    expect(segment({ startSeconds: -1 })).toBeNull();
    expect(segment({ endSeconds: null })).toBeNull();
    for (const value of [null, undefined, 'segment', 3, [anchor()]]) {
      expect(transcriptSegmentOf('TRANSCRIPT_SEGMENT', value)).toBeNull();
    }
  });
});

describe('candidateStatementOf', () => {
  const read = (sourceType: string, overrides: Record<string, unknown> | null, quote: string | null = QUOTE) =>
    candidateStatementOf({ sourceType, segment: overrides === null ? null : segment(overrides), quote });

  it('words the owner by role, naming Omi only for an Omi source', () => {
    expect(read('OMI', {})).toBe('You said (as Omi identified the speaker): “' + QUOTE + '”');
    expect(read('DOCUMENT', {})).toBe('You said (as the transcript identified the speaker): “' + QUOTE + '”');
    expect(read('OMI', { speakerName: 'Dana' })).toBe('You said (as Omi identified the speaker): “' + QUOTE + '”');
  });

  it('words another speaker by label, never as "You"', () => {
    expect(read('OMI', { speakerName: 'Dana', speakerRole: 'OTHER' })).toBe('Dana said: “' + QUOTE + '”');
    expect(read('OMI', { speakerName: 'Speaker 2', speakerRole: 'UNKNOWN' })).toBe('Speaker 2 said: “' + QUOTE + '”');
    expect(read('OMI', { speakerName: null, speakerRole: 'OTHER' })).toBe('An unidentified speaker said: “' + QUOTE + '”');
    expect(read('OMI', { speakerName: ' YOU ', speakerRole: 'OTHER' })).toBe('An unidentified speaker said: “' + QUOTE + '”');
    expect(read('OMI', { speakerName: 'you', speakerRole: 'UNKNOWN' })).toBe('An unidentified speaker said: “' + QUOTE + '”');
  });

  it('words any other anchor as the source', () => {
    expect(read('GMAIL', null, 'Maya will bring the signed lease on Monday.'))
      .toBe('The source says: “Maya will bring the signed lease on Monday.”');
    expect(candidateStatementOf({ sourceType: 'GMAIL', segment: transcriptSegmentOf('MESSAGE_SPAN', anchor()), quote: 'x' }))
      .toBe('The source says: “x”');
  });

  it('says so when the anchor holds no words', () => {
    const none = 'This source records a position but no words for this statement.';
    expect(read('OMI', {}, null)).toBe(none);
    expect(read('OMI', { speakerRole: 'OTHER' }, '')).toBe(none);
    expect(read('GMAIL', null, null)).toBe(none);
  });

  it('stays within the panel statement bound', () => {
    const label = segment({ speakerName: 'L'.repeat(200), speakerRole: 'OTHER' });
    const bounded = candidateStatementOf({ sourceType: 'OMI', segment: label, quote: 'q'.repeat(600) });
    expect(bounded).toBe('L'.repeat(79) + '… said: “' + 'q'.repeat(600) + '”');
    const cut = candidateStatementOf({ sourceType: 'OMI', segment: label, quote: 'q'.repeat(2000) });
    expect(cut).toHaveLength(1000);
    expect(cut.endsWith('q…”')).toBe(true);
    expect(cut.startsWith('L'.repeat(79) + '… said: “q')).toBe(true);
  });
});
