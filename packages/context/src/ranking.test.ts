import { expect, it } from 'vitest';
import {
  MAX_ITEMS_PER_SECTION, MAX_ITEMS_SHOWN, MAX_RECOMMENDATIONS, headlineOf, isCurrentOrImminent, materialFingerprintOf,
  ownerLocalDate, rankBriefing, utcOffset, formatLocal, type BriefingCandidate,
} from './ranking.js';

/**
 * The briefing's pure rules, with no database (ADR 0026): the owner-local date,
 * the material filter, the order, repeat suppression, the attention budget and
 * the recommendation cap. `packages/api/src/today.test.ts` runs the same rules
 * end to end over the Context Broker.
 */

const NOW = new Date('2026-09-21T22:30:00.000Z');
const id = (n: number) => '0192f3a0-0000-7000-8000-' + String(n).padStart(12, '0');
const hours = (n: number) => new Date(NOW.getTime() + n * 3_600_000);
function candidate(n: number, over: Partial<BriefingCandidate> = {}): BriefingCandidate {
  return {
    itemObjectType: 'frame_instance', itemObjectId: id(n), kind: 'COMMITMENT', domainSection: 'PERSONAL', label: 'CONFIRMED',
    outcomeState: 'UNRESOLVED', targetTime: hours(12), subject: 'item ' + n, counterpart: '', amount: null, statedPriority: null,
    decisionAffectingConflict: false, ownerAssertionPending: false, projectionComplete: true, supportAccepted: true,
    sourceRefs: [{ objectType: 'propositions', objectId: id(100 + n) }], evidenceIds: [], materialValues: [], ...over,
  };
}
const rank = (candidates: BriefingCandidate[], shownBefore: Parameters<typeof rankBriefing>[1]['shownBefore'] = []) =>
  rankBriefing(candidates, { now: NOW, timeZone: 'Asia/Jerusalem', localDate: ownerLocalDate(NOW, 'Asia/Jerusalem'), shownBefore });

it('uses the owner-local date and offset, not the UTC date', () => {
  expect(NOW.toISOString().slice(0, 10)).toBe('2026-09-21');
  expect(ownerLocalDate(NOW, 'Asia/Jerusalem')).toBe('2026-09-22');
  expect(utcOffset(NOW, 'Asia/Jerusalem')).toBe('+03:00');
  expect(ownerLocalDate(NOW, 'America/New_York')).toBe('2026-09-21');
  expect(utcOffset(NOW, 'America/New_York')).toBe('-04:00');
  expect(utcOffset(NOW, 'Asia/Kolkata')).toBe('+05:30');
  expect(utcOffset(NOW, 'UTC')).toBe('+00:00');
  expect(formatLocal(hours(10), 'Asia/Jerusalem')).toBe('Tue 22 Sep, 11:30');
});

it('keeps only current or imminent material items', () => {
  expect(isCurrentOrImminent(candidate(1, { targetTime: hours(47) }), NOW)).toBe(true);
  expect(isCurrentOrImminent(candidate(1, { targetTime: hours(49) }), NOW)).toBe(false);
  expect(isCurrentOrImminent(candidate(1, { targetTime: hours(-24 * 13) }), NOW)).toBe(true);
  expect(isCurrentOrImminent(candidate(1, { targetTime: hours(-24 * 15) }), NOW)).toBe(false);
  expect(isCurrentOrImminent(candidate(1, { outcomeState: 'RESOLVED' }), NOW)).toBe(false);
  expect(isCurrentOrImminent(candidate(1, { targetTime: null }), NOW)).toBe(false);
  expect(isCurrentOrImminent(candidate(1, { targetTime: null, decisionAffectingConflict: true }), NOW)).toBe(true);
});

it('CRT-UX-02-A: ranks an older urgent high-consequence item above a newer low-consequence one, whatever the input order', () => {
  // The candidate carries no recording time at all; "older" and "newer" are the
  // identifiers' order, which is creation order for UUIDv7.
  const older = candidate(1, { statedPriority: 'high', targetTime: hours(5) });
  const newer = candidate(9, { statedPriority: 'low', targetTime: hours(30) });
  for (const input of [[older, newer], [newer, older]]) {
    const ranked = rank(input);
    expect(ranked.items.map(item => item.candidate.itemObjectId)).toEqual([older.itemObjectId, newer.itemObjectId]);
    expect(ranked.items[0]!.components.consequence).toBeGreaterThan(ranked.items[1]!.components.consequence);
  }
  expect(Object.keys(rank([older]).items[0]!.components).sort()).toEqual(['attentionBudget', 'confidence', 'consequence', 'effort',
    'goalRelevance', 'reversibility', 'urgency']);
});

it('CRT-UX-01-B: suppresses an unchanged low-priority item shown yesterday, and only that', () => {
  const low = candidate(2, { statedPriority: 'low', targetTime: hours(20) });
  const today = ownerLocalDate(NOW, 'Asia/Jerusalem');
  const yesterday = '2026-09-21';
  const shown = { itemObjectType: 'frame_instance', itemObjectId: low.itemObjectId, materialFingerprint: materialFingerprintOf(low, false), ownerLocalDate: yesterday };
  const ranked = rank([low], [shown]);
  expect(ranked.items[0]).toMatchObject({ priority: 'LOW', presentation: 'SUPPRESSED_UNCHANGED', rankPosition: null, lastShownOn: yesterday });
  // A change to its material state brings it back.
  expect(rank([{ ...low, targetTime: hours(21) }], [shown]).items[0]!.presentation).toBe('SHOWN');
  // So does being shown only earlier the same day, or more than a week ago.
  expect(rank([low], [{ ...shown, ownerLocalDate: today }]).items[0]!.presentation).toBe('SHOWN');
  expect(rank([low], [{ ...shown, ownerLocalDate: '2026-09-10' }]).items[0]!.presentation).toBe('SHOWN');
  // A high-consequence item shown yesterday is still shown.
  const high = candidate(3, { statedPriority: 'high' });
  expect(rank([high], [{ ...shown, itemObjectId: high.itemObjectId, materialFingerprint: materialFingerprintOf(high, false) }]).items[0]!.presentation).toBe('SHOWN');
});

it('CRT-UX-01-B: never words a scheduled event as having happened', () => {
  const event = candidate(4, { kind: 'SCHEDULED_EVENT', label: 'SCHEDULED', subject: 'Board meeting' });
  expect(headlineOf(event, false, 'Tue 22 Sep, 09:00')).toBe('Scheduled, not yet happened: Board meeting at Tue 22 Sep, 09:00.');
  const past = headlineOf(event, true, 'Mon 21 Sep, 09:00');
  expect(past).toBe('Planned for Mon 21 Sep, 09:00: Board meeting. Nothing recorded says whether it took place.');
  expect(past.replace('Nothing recorded says whether it took place', '')).not.toMatch(/happened|took place|occurred/);
});

it('CRT-UX-01-A: holds a small set and at most a few recommendations', () => {
  const many = Array.from({ length: 12 }, (_, index) => candidate(10 + index, {
    domainSection: (['PERSONAL', 'WORK', 'FINANCE'] as const)[index % 3]!, targetTime: hours(-1 - index), statedPriority: 'high' }));
  const ranked = rank(many);
  const shown = ranked.items.filter(item => item.presentation === 'SHOWN');
  expect(shown.length).toBe(MAX_ITEMS_SHOWN);
  for (const section of ['PERSONAL', 'WORK', 'FINANCE']) {
    expect(shown.filter(item => item.candidate.domainSection === section).length).toBeLessThanOrEqual(MAX_ITEMS_PER_SECTION);
  }
  expect(ranked.items.filter(item => item.presentation === 'DEFERRED_BY_ATTENTION_BUDGET').length).toBe(12 - MAX_ITEMS_SHOWN);
  expect(ranked.recommendations.length).toBe(MAX_RECOMMENDATIONS);
  expect(shown.map(item => item.rankPosition)).toEqual([1, 2, 3, 4, 5, 6, 7]);
});

it('withholds a high-risk recommendation whose support is provisional, contested or incomplete', () => {
  const obligation = (n: number, over: Partial<BriefingCandidate>) => candidate(n, { kind: 'OBLIGATION', domainSection: 'FINANCE', ...over });
  const ranked = rank([
    obligation(30, { label: 'CONTESTED', decisionAffectingConflict: true }),
    obligation(31, { label: 'REPORTED', supportAccepted: false }),
    obligation(32, { projectionComplete: false }),
  ]);
  expect(ranked.recommendations).toEqual([]);
  expect(ranked.withheldRecommendations.map(entry => entry.reason).sort())
    .toEqual(['PROJECTION_INCOMPLETE', 'SUPPORT_CONTESTED', 'SUPPORT_PROVISIONAL']);
  const settled = rank([obligation(33, {})]);
  expect(settled.recommendations).toMatchObject([{ risk: 'HIGH', basedOnItemId: id(33) }]);
});
