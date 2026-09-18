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
