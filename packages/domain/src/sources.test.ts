import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {expect, it} from 'vitest';
import {parseSourcePayload, SourcePayloadInvalid} from './sources.js';

async function fixture(name: string) {
  return JSON.parse(await readFile(resolve('fixtures/sources/' + name + '.json'), 'utf8'));
}

it('CRT-EVD-04-A: parses a Gmail thread into one item per message linked to its thread', async () => {
  const raw = await fixture('gmail-thread');
  const items = parseSourcePayload('GMAIL', raw);
  expect(items.map(item => item.externalId)).toEqual(['msg-9a1c04', 'msg-9a1c05', 'msg-9a1c06']);
  // The root anchors to the thread; each reply anchors to the message it answers,
  // which keeps every item connected to the same thread.
  expect(items.map(item => item.parentExternalId)).toEqual(['thread-1f8c2a4b7d', 'msg-9a1c04', 'msg-9a1c05']);
  expect(items.every(item => item.deterministicMetadata.threadExternalId === 'thread-1f8c2a4b7d')).toBe(true);
  expect(items[0]!.occurredAt).toBe('2026-08-31T09:00:00.000Z');
  expect(items[0]!.actorRef).toEqual({type: 'EXTERNAL', id: 'dana@example.test'});
  const span = items[0]!.anchors.find(anchor => anchor.kind === 'MESSAGE_SPAN')!;
  expect(span.anchor).toMatchObject({messageExternalId: 'msg-9a1c04', field: 'body', start: 0});
  expect(span.normalizedText).toBe(raw.messages[0].payload.body.text);
  expect(span.anchor.end).toBe(raw.messages[0].payload.body.text.length);
});

it('CRT-EVD-04-B: parses each Google Calendar occurrence with the payload recurrence id', async () => {
  const items = parseSourcePayload('GOOGLE_CALENDAR', await fixture('google-calendar-recurring-event'));
  expect(items).toHaveLength(3);
  expect(items.every(item => item.deterministicMetadata.recurrenceId === 'evt-weekly-review-7b3')).toBe(true);
  expect(items.every(item => item.parentExternalId === 'evt-weekly-review-7b3')).toBe(true);
  expect(items.map(item => item.externalId)).toEqual([
    'evt-weekly-review-7b3_20260904T130000Z',
    'evt-weekly-review-7b3_20260911T130000Z',
    'evt-weekly-review-7b3_20260918T130000Z',
  ]);
  // A moved occurrence keeps its original start alongside its actual one.
  expect(items[2]!.occurredAt).toBe('2026-09-18T15:00:00.000Z');
  expect(items[2]!.deterministicMetadata.originalStartTime).toBe('2026-09-18T16:00:00+03:00');
  expect(items[0]!.anchors.filter(anchor => anchor.kind === 'CALENDAR_FIELD').map(anchor => anchor.anchor.field))
    .toEqual(['start', 'end', 'recurrence']);
});

it('parses a GitHub thread into an issue item and one item per comment', async () => {
  const items = parseSourcePayload('GITHUB', await fixture('github-issue-thread'));
  expect(items.map(item => item.externalId)).toEqual([
    'example-org/uai-reference#412',
    'example-org/uai-reference#412/comments/9013371',
    'example-org/uai-reference#412/comments/9013372',
  ]);
  expect(items.slice(1).every(item => item.parentExternalId === 'example-org/uai-reference#412')).toBe(true);
  expect(items[1]!.anchors.find(anchor => anchor.kind === 'GITHUB_COMMENT')!.anchor)
    .toEqual({repository: 'example-org/uai-reference', issueNumber: 412, commentId: 9013371, nodeId: 'IC_kwDOA1b2c3d5'});
});

it('CRT-CON-01-A: parses every user and assistant message into its own item with its message id', async () => {
  const raw = await fixture('conversation-thread');
  const items = parseSourcePayload('CONVERSATION', raw);
  expect(items.map(item => item.externalId))
    .toEqual(['msg-conv-0001', 'msg-conv-0002', 'msg-conv-0003', 'msg-conv-0004']);
  expect(items.map(item => item.deterministicMetadata.role)).toEqual(['USER', 'ASSISTANT', 'USER', 'ASSISTANT']);
  // A user message is attributed to the submitting owner by the ingest path; an
  // assistant message names the assistant, so model output never arrives as the
  // owner's own statement (PRD §24.2).
  expect(items[0]!.actorRef).toBeNull();
  expect(items[1]!.actorRef).toEqual({type: 'ASSISTANT', id: 'uai-assistant-0.1.0'});
  expect(items.every(item => item.content.conversationExternalId === 'conv-2026-09-14-a7f2')).toBe(true);
  expect(items.map(item => item.parentExternalId))
    .toEqual(['conv-2026-09-14-a7f2', 'msg-conv-0001', 'msg-conv-0002', 'msg-conv-0003']);
  expect(items[0]!.occurredAt).toBe('2026-09-14T08:02:00.000Z');
  expect(items[0]!.anchors).toHaveLength(1);
  expect(items[0]!.anchors[0]!.normalizedText).toBe(raw.messages[0].text);
});

it('CRT-CON-04-A: folds a burst of commits and CI runs on one pull request into one episode item', async () => {
  const raw = await fixture('github-pull-request-burst');
  const items = parseSourcePayload('GITHUB', raw);
  // Seven commits and five CI events become exactly one additional item, beside
  // the pull request itself and its one comment: twelve provider events, one
  // extraction unit (PRD §20.5).
  const episodes = items.filter(item => item.externalId.endsWith('/episode'));
  expect(episodes).toHaveLength(1);
  expect(items).toHaveLength(3);
  const episode = episodes[0]!;
  expect(episode.parentExternalId).toBe('example-org/uai-reference#517');
  expect(episode.deterministicMetadata).toMatchObject({
    episodeKind: 'COMMIT_AND_CI_BURST', aggregatedCommitCount: 7, aggregatedCheckRunCount: 5,
    aggregatedEventCount: 12, headSha: 'b7c1d90ee2f4a3b5c6d7e8f9012345678abcdef0',
  });
  // Nothing is lost by being aggregated: every commit and every CI run is still
  // an anchor and an entry the episode carries.
  expect(episode.anchors).toHaveLength(12);
  expect((episode.content.commits as unknown[])).toHaveLength(7);
  expect((episode.content.checkRuns as unknown[])).toHaveLength(5);
  expect(episode.occurredAt).toBe('2026-09-10T09:58:00.000Z');
  // The same burst delivered twice parses identically, which is what lets the
  // second delivery deduplicate on content hash instead of creating a row.
  expect(parseSourcePayload('GITHUB', structuredClone(raw))).toEqual(items);
});

it('adds no episode to a thread that carried no commits or CI events', async () => {
  const items = parseSourcePayload('GITHUB', await fixture('github-issue-thread'));
  expect(items.some(item => item.externalId.endsWith('/episode'))).toBe(false);
});

it('parses an uploaded document into one item with a range anchor per page', async () => {
  const raw = await fixture('uploaded-document');
  const items = parseSourcePayload('DOCUMENT', raw);
  expect(items).toHaveLength(1);
  expect(items[0]!.externalId).toBe('document:doc-lease-2026-03');
  // No external author is named, so the submitting owner remains the actor.
  expect(items[0]!.actorRef).toBeNull();
  const ranges = items[0]!.anchors.filter(anchor => anchor.kind === 'DOCUMENT_RANGE');
  expect(ranges.map(anchor => anchor.anchor.page)).toEqual([1, 2]);
  expect(ranges[1]!.anchor.end).toBe(raw.pages[1].text.length);
});

it('parses identically across runs and ignores fields it does not retain', async () => {
  const raw = await fixture('gmail-thread');
  expect(parseSourcePayload('GMAIL', raw)).toEqual(parseSourcePayload('GMAIL', structuredClone(raw)));
  // A provider adding a field must not change an already-ingested content hash.
  const extended = structuredClone(raw);
  extended.messages[0].snippet = 'a new provider field';
  extended.newTopLevelField = {added: true};
  expect(parseSourcePayload('GMAIL', extended)).toEqual(parseSourcePayload('GMAIL', raw));
});

it('refuses an unparseable payload or an unknown source type under one stable code', async () => {
  const gmail = await fixture('gmail-thread');
  expect(() => parseSourcePayload('GMAIL', {id: 'thread', messages: []})).toThrow(SourcePayloadInvalid);
  expect(() => parseSourcePayload('GMAIL', {messages: [{id: 'm'}]})).toThrow('SOURCE_PAYLOAD_INVALID');
  expect(() => parseSourcePayload('TELEPATHY', gmail)).toThrow('SOURCE_PAYLOAD_INVALID');
  // The refusal names the source type and never the payload it rejected.
  try { parseSourcePayload('GITHUB', {repository: {full_name: 'x/y'}, secret: 'do-not-echo'}); }
  catch (error) { expect(JSON.stringify({message: (error as Error).message})).not.toContain('do-not-echo'); }
});
