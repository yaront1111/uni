import {createHash} from 'node:crypto';
import {readdir, readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {expect, it} from 'vitest';
import {parseSourcePayload, SourcePayloadInvalid} from './sources.js';

async function fixture(name: string) {
  return JSON.parse(await readFile(resolve('fixtures/sources/' + name + '.json'), 'utf8'));
}

/** Verbatim copy of `canonical` in packages/api/src/evidence.ts: sha256 of
 * `canonical(item.content)` IS the stored content hash, so this is the function
 * that decides whether a parser change moves an already-ingested identity. */
function canonical(value:unknown):string{
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value!==null&&typeof value==='object')return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical((value as Record<string,unknown>)[key])).join(',')+'}';
  return JSON.stringify(value);
}

/** sha256 of `canonical(parseSourcePayload('GMAIL', payload))` for every Gmail
 * payload that carries the decoded `payload.body.text` shape, computed on
 * master@4eaa1fb with the parser that predates Gmail API body decoding. The digest
 * covers the whole item list (content, anchors, metadata, parent, actor), so it
 * freezes content identity and anchor identity together. Never re-capture these. */
const LEGACY_GMAIL_ITEMS: Record<string, string> = {
  'corpus/synthetic/threads/synthetic-01-daniel-taxi.json': '91fc52980802ed727ed536c8c76c9e69b1559fbec03b4b611a96c932c015944e',
  'corpus/synthetic/threads/synthetic-02-kitchen-quote.json': 'e1f144eab4c3da378f92a34d3c25461c16572210e398b0ed5277d672985556f3',
  'corpus/synthetic/threads/synthetic-03-newsletter.json': '5c41156a0a7640a2555bf5c2f1e6b18c1d1a577c95cc8dda13e774c75704d719',
  'corpus/synthetic/threads/synthetic-04-dentist.json': 'c30260104d95563ef74e5beed4d4c3521a637220c0af08e232b7d2ef847bfb6c',
  'corpus/synthetic/threads/synthetic-05-q3-report.json': '45924078c6dd8b77e9899e3e7636c13a84e0806a64dbc61297d6864a26821528',
  'corpus/synthetic/threads/synthetic-06-daniel-levi-lunch.json': 'b1cc8767d78bc407b80d4ce8d8849fb942528ec32ac4c53bfa559971e1886bd8',
  'corpus/synthetic/threads/synthetic-07-invitation.json': 'f05a929f6144503e559419bb1f3839945547e78b605a29703a41b7f7b1e0d55a',
  'corpus/synthetic/threads/synthetic-08-rent.json': '058f66a24f8cb52ce2e57647a4f3b6ba1ca4aa72bd77240859559eb80a722f55',
  'corpus/synthetic/threads/synthetic-09-planning.json': 'd35fc958902465a8ce4611d1c58e438becb6dcb09faae006068e89efe4e16b96',
  'corpus/synthetic/threads/synthetic-10-book.json': '60cc5c4c789562287882dbef34608891839c0894b40cc24bec2ecd9b456dfe48',
  'corpus/synthetic/threads/synthetic-11-flight.json': '2d8411c03adb350df91ab511bd3a9f798cc64bbea05975fa52bcfdbaf7508eaa',
  'corpus/synthetic/threads/synthetic-12-parcel.json': '507cbe8ff2c64802d78560ae3fddd9ceb735dd3f515f3d8e033c54c98a423b1d',
  'fixtures/sources/gmail-newsletter.json': '51ff079735ed1fc1590c08c1afb71b2fbade2de006d670f5aca195f825b83fdd',
  'fixtures/sources/gmail-thread-update.json': '2b2664e414878ed9cb83cee72aca6c583cefe680d55a8c028e59c13f1a862be9',
  'fixtures/sources/gmail-thread.json': 'cee455bcbd56e1668780bbaf48f8f2468e001690021e75be2ddfdcac90d96f04',
};

it('keeps every payload.body.text Gmail payload byte-identical (content identity is frozen)', async () => {
  const files = [
    ...(await readdir(resolve('fixtures/sources'))).filter(name => /^gmail-.*\.json$/.test(name))
      .map(name => 'fixtures/sources/' + name),
    ...(await readdir(resolve('corpus/synthetic/threads'))).filter(name => name.endsWith('.json'))
      .map(name => 'corpus/synthetic/threads/' + name),
  ].sort();
  const digests: Record<string, string> = {};
  for (const file of files) {
    const payload = JSON.parse(await readFile(resolve(file), 'utf8'));
    const legacy = (payload.messages as {payload?: {body?: {text?: unknown}}}[])
      .every(message => typeof message.payload?.body?.text === 'string');
    if (!legacy) continue;
    digests[file] = createHash('sha256').update(canonical(parseSourcePayload('GMAIL', payload))).digest('hex');
  }
  expect(digests).toEqual(LEGACY_GMAIL_ITEMS);
});

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

/** The decoded bodies of fixtures/sources/gmail-api-thread.json, a thread in the
 * shape users.threads.get returns with format=full: single-part text/plain,
 * multipart/alternative, nested multipart/mixed with attachments, HTML only, and
 * an ISO-8859-1 body. */
const API_BODIES = [
  'Hi,\r\nThe plumber can come on Thursday at 09:30 — does that work?\r\n-- Maya',
  'Thursday 09:30 works. I will leave the side gate open.\r\n',
  'The invoice for the boiler repair is attached: 1,240 due by 15 November.\r\n',
  'Dinner at 8 & bring dessert <RSVP> by — Friday ☺',
  'Réunion confirmée à 10h, café offert.',
];

function dataStrings(part: {body?: {data?: string}; parts?: unknown[]}): string[] {
  return [...(part.body?.data ? [part.body.data] : []),
    ...(part.parts ?? []).flatMap(child => dataStrings(child as {body?: {data?: string}; parts?: unknown[]}))];
}

it('decodes Gmail API message bodies: plain, alternative, mixed with attachments, HTML only and a non-UTF-8 charset', async () => {
  const raw = await fixture('gmail-api-thread');
  const items = parseSourcePayload('GMAIL', raw);
  expect(items.map(item => item.externalId))
    .toEqual(['msg-api-0001', 'msg-api-0002', 'msg-api-0003', 'msg-api-0004', 'msg-api-0005']);
  expect(items.map(item => item.parentExternalId))
    .toEqual(['thread-api-5d2e9c', 'msg-api-0001', 'msg-api-0002', 'msg-api-0003', 'msg-api-0004']);
  expect(items.map(item => item.content.body)).toEqual(API_BODIES);
  expect(items[0]!.content).toEqual({
    messageExternalId: 'msg-api-0001', threadExternalId: 'thread-api-5d2e9c',
    from: 'Maya Cohen <maya@example.test>', to: 'Owner Example <owner@example.test>', cc: null,
    subject: 'House jobs this week', body: API_BODIES[0],
  });
  expect(items[0]!.occurredAt).toBe('2026-10-05T07:12:00.000Z');
  for (const [index, item] of items.entries()) {
    const span = item.anchors.find(anchor => anchor.kind === 'MESSAGE_SPAN')!;
    expect(span.anchor).toEqual({messageExternalId: item.externalId, field: 'body', start: 0, end: API_BODIES[index]!.length});
    expect(span.normalizedText).toBe(API_BODIES[index]);
  }
  expect(items.map(item => 'bodyTruncated' in item.deterministicMetadata)).toEqual([false, false, false, false, false]);
  // The fixture exercises the url-safe alphabet and both padded and unpadded data.
  const data = (raw.messages as {payload: {body?: {data?: string}; parts?: unknown[]}}[]).flatMap(message => dataStrings(message.payload));
  expect([data.some(value => value.includes('-')), data.some(value => value.includes('_')),
    data.some(value => value.endsWith('=')), data.some(value => value.length % 4 !== 0)]).toEqual([true, true, true, true]);
});

const b64url = (text: string, encoding: BufferEncoding = 'utf8') => Buffer.from(text, encoding).toString('base64url');
type Part = Record<string, unknown>;
const leaf = (mimeType: string, text: string, extra: Part = {}): Part =>
  ({mimeType, filename: '', headers: [], body: {size: text.length, data: b64url(text)}, ...extra});
const multipart = (parts: Part[], mimeType = 'multipart/mixed'): Part => ({mimeType, filename: '', headers: [], body: {size: 0}, parts});
const attachment = (name: string): Part => ({mimeType: 'application/octet-stream', filename: name, headers: [], body: {size: 9, attachmentId: 'att-' + name}});
const apiThread = (payload: Part) =>
  ({id: 'thread-inline', messages: [{id: 'msg-inline', threadId: 'thread-inline', payload: {headers: [], ...payload}}]});
const parsedBody = (payload: Part) => parseSourcePayload('GMAIL', apiThread(payload))[0]!.content.body;

it('selects the first non-attachment text/plain part, else the first text/html part, else nothing', () => {
  expect(parsedBody(multipart([leaf('text/html', '<p>html first</p>'), leaf('text/plain', 'plain wins')], 'multipart/alternative')))
    .toBe('plain wins');
  expect(parsedBody(multipart([{mimeType: 'text/plain', filename: '', headers: [], body: {size: 0, data: ''}},
    leaf('text/html', '<p>from <b>html</b></p>')], 'multipart/alternative'))).toBe('from html');
  expect(parsedBody(multipart([leaf('text/plain', 'fetched separately', {body: {size: 18, attachmentId: 'att-1', data: b64url('fetched separately')}}),
    leaf('text/plain', 'the body')]))).toBe('the body');
  // An attachment is skipped with its whole subtree: a forwarded message's own body is not this message's body.
  expect(parsedBody(multipart([{...multipart([leaf('text/plain', 'forwarded body')], 'message/rfc822'), filename: 'forwarded.eml'},
    leaf('text/plain', 'own body')]))).toBe('own body');
  expect(parsedBody(multipart([leaf('TEXT/PLAIN', 'case-insensitive mime type')]))).toBe('case-insensitive mime type');
  expect(parsedBody(multipart([leaf('text/html', '<p>first html</p>'), leaf('text/html', '<p>second html</p>')]))).toBe('first html');
  expect(parsedBody(multipart([leaf('text/plain', 'first plain'), leaf('text/plain', 'second plain')]))).toBe('first plain');
  const onlyAttachments = parseSourcePayload('GMAIL', apiThread(multipart([attachment('a.pdf'),
    leaf('text/plain', 'notes', {filename: 'notes.txt'})])))[0]!;
  expect(onlyAttachments.content.body).toBe('');
  expect(onlyAttachments.anchors.find(anchor => anchor.kind === 'MESSAGE_SPAN')!.anchor.end).toBe(0);
  expect(parsedBody({mimeType: 'multipart/mixed'})).toBe('');
});

it('decodes with the selected part\'s own charset and falls back to UTF-8 for an unknown label', () => {
  expect(parsedBody(leaf('text/plain', 'café ☺', {headers: [{name: 'content-type', value: 'text/plain; charset=x-unknown-label'}]})))
    .toBe('café ☺');
  expect(parsedBody(multipart([{...leaf('text/plain', ''), body: {size: 6, data: b64url('Grüße', 'latin1')},
    headers: [{name: 'CONTENT-TYPE', value: 'text/plain;charset=iso-8859-1'}]}]))).toBe('Grüße');
  // The parent's charset does not apply to a child part.
  expect(parsedBody({...multipart([leaf('text/plain', 'naïve')]), headers: [{name: 'Content-Type', value: 'multipart/mixed; charset=iso-8859-1'}]}))
    .toBe('naïve');
});

it('keeps a present payload.body.text over any data or parts (the metadata-only narrowing writes text \'\')', () => {
  expect(parsedBody({mimeType: 'text/plain', body: {text: '', size: 4, data: b64url('data')}, parts: [leaf('text/plain', 'part')]})).toBe('');
  expect(parsedBody({mimeType: 'text/plain', body: {text: 'legacy', size: 4, data: b64url('data')}, parts: [leaf('text/plain', 'part')]}))
    .toBe('legacy');
});

it('reduces HTML to text deterministically', () => {
  expect(parsedBody(leaf('text/html',
    '<html><head><title>Hidden title</title><meta charset="utf-8"></head><body><noscript>no script</noscript>'
    + '<template><p>template</p></template><TITLE>loose title</TITLE><p>Seen</p><SCRIPT type="x">bad()</SCRIPT></body></html>')))
    .toBe('Seen');
  // `</head>` is optional in HTML, so a head that is never closed must not swallow the body.
  expect(parsedBody(leaf('text/html', '<html><head><meta charset="utf-8"><title>T</title><body><p>Hello there</p></body></html>')))
    .toBe('Hello there');
  expect(parsedBody(leaf('text/html', '<head><meta charset="utf-8"><body>Visible</body>'))).toBe('Visible');
  expect(parsedBody(leaf('text/html', '<p>1 < 2 &amp;lt; 3 &AMP; &Quot;q&quot; &apos;a&apos;</p>'))).toBe('1 < 2 &lt; 3 & "q" \'a\'');
  expect(parsedBody(leaf('text/html', '&#65;&#x42;&#X43; &#0; &#xD800; &#x110000; &#9999999; &#12345678; &bogus;')))
    .toBe('ABC \uFFFD \uFFFD \uFFFD \uFFFD &#12345678; &bogus;');
  expect(parsedBody(leaf('text/html', 'before<script>never closed'))).toBe('before');
  expect(parsedBody(leaf('text/html', 'kept<!-- never closed'))).toBe('kept');
});

function nested(depth: number): Part {
  let part = leaf('text/plain', 'deep body');
  for (let level = 0; level < depth; level += 1) part = multipart([part]);
  return part;
}

it('walks at most 256 parts and no deeper than depth 16, and never refuses for it', () => {
  expect(parsedBody(nested(16))).toBe('deep body');
  expect(parsedBody(nested(17))).toBe('');
  const fillers = (count: number) => Array.from({length: count}, (_, index) => attachment('f' + index));
  // The root is the first visited part, so the body is the 256th with 254 fillers before it.
  expect(parsedBody(multipart([...fillers(254), leaf('text/plain', 'last visited')]))).toBe('last visited');
  expect(parsedBody(multipart([...fillers(255), leaf('text/plain', 'not visited')]))).toBe('');
});

const parsedItem = (payload: Part) => parseSourcePayload('GMAIL', apiThread(payload))[0]!;

it('cuts a decoded body over 200,000 code units, never splitting a surrogate pair, and records the cut', () => {
  const over = parsedItem(leaf('text/plain', 'a'.repeat(200_001)));
  expect(over.content.body === 'a'.repeat(200_000)).toBe(true);
  expect(over.deterministicMetadata.bodyTruncated).toBe(true);
  expect(over.anchors.find(anchor => anchor.kind === 'MESSAGE_SPAN')!.anchor.end).toBe(200_000);
  const exact = parsedItem(leaf('text/plain', 'a'.repeat(200_000)));
  expect(exact.content.body === 'a'.repeat(200_000)).toBe(true);
  expect('bodyTruncated' in exact.deterministicMetadata).toBe(false);
  const pair = parsedItem(leaf('text/plain', 'a'.repeat(199_999) + '\u{1F600}' + 'b'));
  expect(pair.content.body === 'a'.repeat(199_999)).toBe(true);
  expect(pair.deterministicMetadata.bodyTruncated).toBe(true);
});

it('decodes at most 1,048,576 base64url characters of a part and drops a sequence the cut splits', () => {
  // 786,432 bytes encode to exactly 1,048,576 characters: the whole part is decoded.
  const whole = 'head' + ' '.repeat(786_432 - 8) + 'tail';
  expect(b64url(whole).length).toBe(1_048_576);
  const exact = parsedItem(leaf('text/html', whole));
  expect(exact.content.body).toBe('head tail');
  expect('bodyTruncated' in exact.deterministicMetadata).toBe(false);
  const beyond = parsedItem(leaf('text/html', whole + 'Z'));
  expect(beyond.content.body).toBe('head tail');
  expect(beyond.deterministicMetadata.bodyTruncated).toBe(true);
  // The euro sign's three bytes straddle the cut: its first two are dropped, not turned into U+FFFD.
  const split = parsedItem(leaf('text/html', 'head' + ' '.repeat(786_430 - 4) + '€tail'));
  expect(split.content.body).toBe('head');
  expect(split.deterministicMetadata.bodyTruncated).toBe(true);
  const html = '<p>head</p>' + '<i></i>'.repeat(120_000) + '<p>tail</p>';
  expect(b64url(html).length).toBeGreaterThan(1_048_576);
  const cut = parsedItem(leaf('text/html', html));
  expect((cut.content.body as string).startsWith('head')).toBe(true);
  expect((cut.content.body as string).includes('tail')).toBe(false);
  expect(cut.content.body).toBe('head </i');
  expect(cut.deterministicMetadata.bodyTruncated).toBe(true);
});

it('replaces U+0000 in a decoded body, which a PostgreSQL text column refuses', () => {
  expect(parsedBody(leaf('text/plain', 'a\u0000b'))).toBe('a\uFFFDb');
  expect(parsedBody(leaf('text/html', '<p>a\u0000b</p>'))).toBe('a\uFFFDb');
});

it('refuses undecodable base64url in the selected part only, echoing nothing', async () => {
  const raw = await fixture('gmail-api-thread');
  for (const data of ['do-not-echo!', 'SGVsb', 'SGVs+G8/', 'SGVs bG8', 'SGVsbG8===']) {
    const bad = structuredClone(raw);
    bad.messages[0].payload.body.data = data;
    let message = '';
    try { parseSourcePayload('GMAIL', bad); }
    catch (error) {
      expect(error).toBeInstanceOf(SourcePayloadInvalid);
      message = (error as Error).message;
    }
    expect(message).toBe('SOURCE_PAYLOAD_INVALID');
    expect(JSON.stringify({message})).not.toContain('do-not-echo');
    // Data in parts that are not selected is never decoded or validated.
    const attachment = structuredClone(raw);
    attachment.messages[2].payload.parts[0].body.data = data;
    attachment.messages[1].payload.parts[1].body.data = data;
    expect(parseSourcePayload('GMAIL', attachment).map(item => item.content.body)).toEqual(API_BODIES);
  }
});

it('reduces pathological HTML in linear time', () => {
  const script = parsedItem(leaf('text/html', '<script'.repeat(100_000)));
  expect(script.content.body === '<script'.repeat(100_000).slice(0, 200_000)).toBe(true);
  expect(script.deterministicMetadata.bodyTruncated).toBe(true);
  const open = parsedItem(leaf('text/html', '<'.repeat(700_000)));
  expect(open.content.body === '<'.repeat(200_000)).toBe(true);
  expect(open.deterministicMetadata.bodyTruncated).toBe(true);
  const comments = parsedItem(leaf('text/html', '<!--'.repeat(150_000)));
  expect(comments.content.body).toBe('');
  expect('bodyTruncated' in comments.deterministicMetadata).toBe(false);
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
  const api = await fixture('gmail-api-thread');
  expect(parseSourcePayload('GMAIL', api)).toEqual(parseSourcePayload('GMAIL', structuredClone(api)));
  const apiExtended = structuredClone(api);
  apiExtended.messages[0].snippet = 'a changed snippet';
  apiExtended.messages[2].payload.parts[1].parts[0].newPartField = {added: true};
  apiExtended.messages[2].payload.parts[1].parts[0].body.size = 1;
  expect(parseSourcePayload('GMAIL', apiExtended)).toEqual(parseSourcePayload('GMAIL', api));
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
