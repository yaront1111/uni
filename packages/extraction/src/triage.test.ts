import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { parseSourcePayload, tier1RouteSchema, routingReasonSchema } from '@unai/domain';
import { parseTier0, routeTier1, splitQuotedHistory, triage, ROUTE_COST_BUDGET_MICROUNITS,
  TIER1_ROUTER_VERSION, type TriageInput } from './triage.js';

/** Tier 0 and Tier 1 over the committed corpus fixtures, with no database, no
 * model and no clock anywhere in the path: triage is a pure function of bytes,
 * which is what lets it run for every ingested item (ADR 0016 §1). */

async function fixture(name: string) {
  return JSON.parse(await readFile(resolve('fixtures/sources/' + name + '.json'), 'utf8'));
}
/** The triage input as the ingest path builds it, from the parsed item. */
function inputsFor(sourceType: string, payload: unknown, actorIsOwner = false): TriageInput[] {
  return parseSourcePayload(sourceType, payload).map(item => ({
    sourceType: item.sourceType, externalId: item.externalId, parentExternalId: item.parentExternalId,
    actorRef: actorIsOwner || item.actorRef === null ? { type: 'USER', id: 'owner' } : item.actorRef,
    occurredAt: item.occurredAt, content: item.content, deterministicMetadata: item.deterministicMetadata,
  }));
}

it('CRT-WRT-07-A: every fixture item is routed to one of the five values with a reason', async () => {
  const corpus: Array<[string, unknown]> = [
    ['GMAIL', await fixture('gmail-thread')],
    ['GMAIL', await fixture('gmail-thread-update')],
    ['GMAIL', await fixture('gmail-newsletter')],
    ['GITHUB', await fixture('github-issue-thread')],
    ['GITHUB', await fixture('github-ci-notification')],
    ['GOOGLE_CALENDAR', await fixture('google-calendar-recurring-event')],
    ['DOCUMENT', await fixture('uploaded-document')],
  ];
  let items = 0;
  for (const [sourceType, payload] of corpus) {
    for (const input of inputsFor(sourceType, payload)) {
      items += 1;
      const result = triage(input);
      // A route outside the five, or one without a reason, is unrepresentable.
      expect(tier1RouteSchema.parse(result.route)).toBe(result.route);
      expect(routingReasonSchema.parse(result.reason).routerVersion).toBe(TIER1_ROUTER_VERSION);
      expect(result.reason.code.length).toBeGreaterThan(0);
      expect(result.costBudgetMicrounits).toBe(ROUTE_COST_BUDGET_MICROUNITS[result.route]);
      // Identical bytes decide identically: triage has no clock and no randomness.
      expect(triage(input)).toEqual(result);
    }
  }
  expect(items).toBeGreaterThan(10);
});

it('CRT-WRT-07-A: a newsletter and a routine CI notification are never routed to FULL_EXTRACTION', async () => {
  const [newsletter] = inputsFor('GMAIL', await fixture('gmail-newsletter'));
  const routed = triage(newsletter!);
  expect(routed.route).toBe('INDEX_ONLY');
  expect(routed.reason.code).toBe('NEWSLETTER');
  expect(routed.reason.negativeSignals).toContain('NEWSLETTER');
  // The newsletter quotes an amount and a deadline; a positive signal inside a
  // bulk mailing does not buy it a deep extraction.
  expect(routed.reason.positiveSignals).toContain('AMOUNT');
  expect(routed.costBudgetMicrounits).toBe(0);

  const ci = inputsFor('GITHUB', await fixture('github-ci-notification'));
  const botComments = ci.filter(item => /github-actions/.test(item.actorRef.id));
  expect(botComments).toHaveLength(2);
  for (const comment of botComments) {
    const decision = triage(comment);
    expect(decision.route).toBe('INDEX_ONLY');
    expect(decision.reason.code).toBe('ROUTINE_CI_NOTIFICATION');
    expect(decision.costBudgetMicrounits).toBe(0);
  }
  // The human pull request in the same payload is still worth reading.
  const authored = ci.find(item => item.actorRef.id === 'dana-eng');
  expect(triage(authored!).route).not.toBe('INDEX_ONLY');
});

it('CRT-WRT-07-B: quoted history is cut once, so a thread update routes on its new content alone', async () => {
  const update = inputsFor('GMAIL', await fixture('gmail-thread-update'));
  const newest = update.find(item => item.externalId === 'msg-9a1c07');
  const tier0 = parseTier0(newest!);
  expect(tier0.newText).toBe('Booked: the tiling crew starts on 14 September and I will pay the 4,200 deposit by Friday.');
  expect(tier0.quotedTextLength).toBeGreaterThan(tier0.newText.length);
  // Three earlier messages are quoted inside this one body and none of them is
  // read again: the update is one unit of new content.
  expect(tier0.newText).not.toContain('18,400');
  expect(tier0.newText).not.toContain('Tiling split out');
  const routed = routeTier1(tier0);
  expect(routed.route).toBe('FULL_EXTRACTION');
  expect(routed.reason.negativeSignals).toContain('REPEATED_QUOTED_HISTORY');
  expect(routed.reason.newContentLength).toBe(tier0.newText.length);
});

it('routes a message that is only quoted history or a signature to SOURCE_ONLY', () => {
  const quotedOnly = splitQuotedHistory('> The contractor quoted 18,400.\n> I will confirm by Friday.');
  expect(quotedOnly.newText).toBe('');
  const decision = triage({
    sourceType: 'GMAIL', externalId: 'msg-quoted', parentExternalId: 'thread-1',
    actorRef: { type: 'EXTERNAL', id: 'dana@example.test' }, occurredAt: null,
    content: { from: 'dana@example.test', subject: 'Re: quote', body: '> I will pay 4,200 by Friday.\n>\n> Thanks' },
    deterministicMetadata: {},
  });
  expect(decision.route).toBe('SOURCE_ONLY');
  expect(decision.reason.code).toBe('REPEATED_QUOTED_HISTORY');
  // An amount inside quoted history is not new content and buys no extraction.
  expect(decision.costBudgetMicrounits).toBe(0);

  const signature = splitQuotedHistory('Thanks!\n\n-- \nDana Levi\nSenior Architect\n+972 50 000 0000');
  expect(signature.newText).toBe('Thanks!');
});

it('defers a stored document with no material signal and extracts one that carries a deadline', async () => {
  const [document] = inputsFor('DOCUMENT', await fixture('uploaded-document'), true);
  const deferred = triage(document!);
  expect(deferred.route).toBe('DEFER_UNTIL_RELEVANT');
  expect(deferred.reason.code).toBe('LAZY_DOCUMENT_EXTRACTION');

  const deadlineBearing = triage({
    ...document!, externalId: 'document:invoice-1',
    content: { ...document!.content as Record<string, unknown>, title: 'Contractor invoice',
      pages: [{ page: 1, text: 'Balance of 4,200 ILS is due by Friday 11 September.' }] },
  });
  expect(deadlineBearing.route).toBe('FULL_EXTRACTION');
  expect(deadlineBearing.reason.positiveSignals).toEqual(expect.arrayContaining(['AMOUNT', 'DEADLINE']));
});

it('routes a calendar occurrence to entity extraction and reaches all five routes over the corpus', async () => {
  const [occurrence] = inputsFor('GOOGLE_CALENDAR', await fixture('google-calendar-recurring-event'));
  const calendar = triage(occurrence!);
  expect(calendar.route).toBe('ENTITY_EXTRACTION');
  expect(calendar.reason.code).toBe('STRUCTURED_SOURCE_FIELDS');

  const routes = new Set<string>();
  for (const [sourceType, payload] of [
    ['GMAIL', await fixture('gmail-thread-update')], ['GMAIL', await fixture('gmail-newsletter')],
    ['GOOGLE_CALENDAR', await fixture('google-calendar-recurring-event')],
    ['DOCUMENT', await fixture('uploaded-document')],
  ] as Array<[string, unknown]>) {
    for (const input of inputsFor(sourceType, payload)) routes.add(triage(input).route);
  }
  routes.add(triage({
    sourceType: 'GMAIL', externalId: 'msg-quoted-2', parentExternalId: 'thread-1',
    actorRef: { type: 'EXTERNAL', id: 'dana@example.test' }, occurredAt: null,
    content: { from: 'dana@example.test', body: '> nothing new here' }, deterministicMetadata: {},
  }).route);
  expect([...routes].sort()).toEqual(['DEFER_UNTIL_RELEVANT', 'ENTITY_EXTRACTION', 'FULL_EXTRACTION', 'INDEX_ONLY', 'SOURCE_ONLY']);
});

it('degrades to SOURCE_ONLY rather than failing when the router cannot decide', () => {
  // An item the parser cannot read must still be ingestable: evidence durability
  // never depends on classification (PRD §0 rule 5, ADR 0016 §2). Here the
  // recorded instant is not a time at all, which Tier 0 refuses to parse.
  const broken = triage({
    sourceType: 'GMAIL', externalId: 'msg-broken', parentExternalId: null,
    actorRef: { type: 'EXTERNAL', id: 'dana@example.test' }, occurredAt: 'the day before yesterday',
    content: { body: 'I will pay 4,200 ILS by Friday.' }, deterministicMetadata: {},
  });
  expect(broken.route).toBe('SOURCE_ONLY');
  expect(broken.reason.code).toBe('TIER1_ROUTER_UNAVAILABLE');
  expect(broken.costBudgetMicrounits).toBe(0);
});
