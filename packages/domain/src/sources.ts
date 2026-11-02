import {z} from 'zod';

/** Deterministic source parsing.
 *
 * A parser turns one raw connector payload into the source items and anchors that
 * payload determines, and nothing else: no model, no clock, no random value, no
 * network. Re-running a parser over identical bytes therefore yields identical
 * items, which is what lets a repeated import deduplicate on content hash instead
 * of on a caller-supplied key.
 *
 * Raw schemas are non-strict on purpose. A connector payload carries far more
 * fields than Uai retains, and unknown fields are stripped rather than refused, so
 * a provider adding a field can never change an already-ingested content hash.
 */

export const sourceAnchorKindSchema = z.enum([
  'MESSAGE_SPAN', 'DOCUMENT_RANGE', 'CALENDAR_FIELD', 'CONNECTOR_JSON_PATH', 'GITHUB_COMMENT', 'TRANSCRIPT_SEGMENT',
]);
export type SourceAnchorKind = z.infer<typeof sourceAnchorKindSchema>;

export const parsedSourceAnchorSchema = z.strictObject({
  kind: sourceAnchorKindSchema,
  anchor: z.record(z.string(), z.json()),
  normalizedText: z.string().max(8192).nullable(),
});
export type ParsedSourceAnchor = z.infer<typeof parsedSourceAnchorSchema>;

export const parsedSourceItemSchema = z.strictObject({
  sourceType: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
  externalId: z.string().min(1).max(512),
  /** The message this item replies to, or the thread/recurring event it belongs to. */
  parentExternalId: z.string().min(1).max(512).nullable(),
  /** Null where the payload names no external author: the submitting owner is the actor. */
  actorRef: z.strictObject({type: z.enum(['USER', 'ASSISTANT', 'EXTERNAL']), id: z.string().min(1).max(512)}).nullable(),
  occurredAt: z.iso.datetime({offset: true}).nullable(),
  content: z.record(z.string(), z.json()),
  deterministicMetadata: z.record(z.string(), z.json()),
  anchors: z.array(parsedSourceAnchorSchema).max(2048),
});
export type ParsedSourceItem = z.infer<typeof parsedSourceItemSchema>;

export const parsedSourceTypeSchema = z.enum(['CONVERSATION', 'GMAIL', 'GOOGLE_CALENDAR', 'GITHUB', 'DOCUMENT', 'OMI']);
export type ParsedSourceType = z.infer<typeof parsedSourceTypeSchema>;

const externalId = z.string().min(1).max(512);
const text = z.string().max(200000);

// --- Gmail -----------------------------------------------------------------
const gmailHeaderSchema = z.object({name: z.string().min(1).max(128), value: z.string().max(8192)});
const gmailMessageSchema = z.object({
  id: externalId,
  threadId: externalId,
  /** Gmail's own receipt time in epoch milliseconds, preferred over the Date header. */
  internalDate: z.string().regex(/^\d{1,16}$/).optional(),
  labelIds: z.array(z.string().max(128)).max(64).optional(),
  payload: z.object({
    headers: z.array(gmailHeaderSchema).max(256),
    /** `text` is the decoded body that fixtures, the synthetic corpus and the
     * metadata-only narrowing carry. The Gmail API never sends it: its
     * users.threads.get format=full resource carries base64url `data` here or in
     * nested `parts` instead. */
    body: z.object({text: text.optional(), data: z.unknown().optional(), attachmentId: z.unknown().optional()}).optional(),
    mimeType: z.unknown().optional(),
    filename: z.unknown().optional(),
    // Read by a bounded walk, never by a recursive schema, so no sender-controlled
    // part field (filename, mimeType, part headers, nesting) can refuse a thread.
    parts: z.unknown().optional(),
  }),
});
export const gmailThreadSchema = z.object({
  id: externalId,
  messages: z.array(gmailMessageSchema).min(1).max(512),
});

// --- Omi recorded conversation (ADR 0041 D3) -------------------------------
const omiSpeakerIdSchema = z.union([z.number().int(), z.string().max(64)]).nullish();
export const omiConversationSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9._-]{1,256}$/),
  created_at: z.string().min(1).max(64),
  started_at: z.string().max(64).nullish(),
  finished_at: z.string().max(64).nullish(),
  language: z.string().max(32).nullish(),
  source: z.string().max(64).nullish(),
  structured: z.object({
    title: z.string().max(4096).nullish(),
    overview: z.string().max(20000).nullish(),
    category: z.string().max(64).nullish(),
    action_items: z.array(z.object({
      description: z.string().max(4096), due_at: z.string().max(64).nullish(),
    })).max(256).nullish(),
    events: z.array(z.object({
      title: z.string().max(4096), start: z.string().max(64).nullish(), duration: z.number().int().nullish(),
    })).max(64).nullish(),
  }).nullish(),
  transcript_segments: z.array(z.object({
    id: z.string().max(256).nullish(),
    text: z.string().max(8192),
    original_text: z.string().max(8192).nullish(),
    speaker_id: omiSpeakerIdSchema,
    speaker_name: z.string().max(256).nullish(),
    start: z.number().min(0), end: z.number().min(0),
  })).max(2048).nullish(),
  participants: z.array(z.object({
    speaker_id: omiSpeakerIdSchema, person_id: z.string().max(256).nullish(), is_user: z.boolean().optional(),
  })).max(64).optional(),
  participants_included: z.boolean().optional(),
});
export type OmiConversation = z.infer<typeof omiConversationSchema>;

// --- First-party conversation ----------------------------------------------
/** Every message of a conversation, whoever said it. PRD §27.5 makes first-party
 * conversation ingestion a required connector, and §24.2 makes the assistant's
 * own words evidence rather than belief: both roles are stored, each as its own
 * item carrying its own external message id (CRT-CON-01-A). */
const conversationMessageSchema = z.object({
  messageId: externalId,
  role: z.enum(['USER', 'ASSISTANT']),
  text,
  createdAt: z.string().max(64).optional(),
  /** The assistant build that produced the message, when the payload names one. */
  authorRef: z.string().max(512).optional(),
});
export const conversationSchema = z.object({
  conversationId: externalId,
  title: z.string().max(4096).optional(),
  messages: z.array(conversationMessageSchema).min(1).max(2048),
});

// --- Google Calendar -------------------------------------------------------
const calendarTimeSchema = z.object({
  dateTime: z.string().max(64).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  timeZone: z.string().max(64).optional(),
});
const calendarOccurrenceSchema = z.object({
  id: externalId,
  recurringEventId: externalId.optional(),
  originalStartTime: calendarTimeSchema.optional(),
  status: z.string().max(64).optional(),
  summary: z.string().max(4096).optional(),
  location: z.string().max(4096).optional(),
  start: calendarTimeSchema,
  end: calendarTimeSchema,
  attendees: z.array(z.object({
    email: z.string().max(320), responseStatus: z.string().max(64).optional(),
  })).max(256).optional(),
});
export const googleCalendarEventSchema = z.object({
  id: externalId,
  summary: z.string().max(4096).optional(),
  organizer: z.object({email: z.string().max(320)}).optional(),
  recurrence: z.array(z.string().max(512)).max(32).optional(),
  timeZone: z.string().max(64).optional(),
  instances: z.array(calendarOccurrenceSchema).min(1).max(512),
});

// --- GitHub ----------------------------------------------------------------
const githubUserSchema = z.object({login: z.string().min(1).max(256)});
export const githubIssueThreadSchema = z.object({
  repository: z.object({full_name: z.string().min(1).max(256)}),
  issue: z.object({
    node_id: externalId,
    number: z.number().int().min(1),
    title: z.string().max(4096),
    body: text.nullable().optional(),
    user: githubUserSchema,
    created_at: z.string().max(64),
    pull_request: z.object({}).optional(),
  }),
  comments: z.array(z.object({
    node_id: externalId,
    id: z.number().int().min(1),
    body: text,
    user: githubUserSchema,
    created_at: z.string().max(64),
  })).max(512).optional(),
  /** A burst of commits pushed to one pull request. PRD §20.5: aggregate around
   * the pull request; do not semantically process every commit independently. */
  commits: z.array(z.object({
    sha: z.string().min(7).max(64),
    message: z.string().max(8192),
    author: githubUserSchema.optional(),
    committed_at: z.string().max(64).optional(),
  })).max(512).optional(),
  /** CI webhooks on the same pull request, aggregated with the commits. */
  check_runs: z.array(z.object({
    id: z.number().int().min(1),
    name: z.string().max(256),
    status: z.string().max(64),
    conclusion: z.string().max(64).nullable().optional(),
    head_sha: z.string().min(7).max(64).optional(),
    completed_at: z.string().max(64).optional(),
  })).max(512).optional(),
});

// --- Uploaded document -----------------------------------------------------
export const uploadedDocumentSchema = z.object({
  documentId: externalId,
  title: z.string().max(4096).optional(),
  mediaType: z.string().max(128).optional(),
  /** The original bytes, kept verbatim so the stored object is the document the
   * owner uploaded. Optional: a payload that carries only extracted page text
   * stores exactly the content it always stored, hash included. */
  base64: z.string().max(1_400_000).optional(),
  /** Empty for a format whose text could not be extracted: the document is still
   * stored, as source-only evidence (PRD §20.5). */
  pages: z.array(z.object({page: z.number().int().min(1), text})).max(2048),
});

/** A payload that does not parse is refused under one stable code: connector bytes
 * are untrusted data and their shape must never reach a caller through an error. */
export class SourcePayloadInvalid extends Error {
  constructor(readonly sourceType: string) { super('SOURCE_PAYLOAD_INVALID'); }
}

function header(headers: readonly {name: string; value: string}[], name: string): string | null {
  const wanted = name.toLowerCase();
  return headers.find(entry => entry.name.toLowerCase() === wanted)?.value ?? null;
}
/** Epoch milliseconds or a parseable date string, else null. Never the current clock. */
function instant(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = /^\d{1,16}$/.test(value) ? Number(value) : Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}
function span(kind: SourceAnchorKind, anchor: Record<string, unknown>, body: string | null): ParsedSourceAnchor {
  return parsedSourceAnchorSchema.parse({kind, anchor, normalizedText: body === null ? null : body.slice(0, 8192)});
}

// --- Gmail message bodies ----------------------------------------------------
/** One Gmail API message part, read leniently: nothing in it can refuse a thread. */
type GmailPart = Record<string, unknown>;
const MAX_PART_DEPTH = 16;
const MAX_PARTS = 256;
const MAX_PART_HEADERS = 256;
/** Base64url characters decoded per part: a multiple of 4, so 786,432 bytes. */
const MAX_PART_DATA = 1_048_576;
/** The `text` bound, in UTF-16 code units, that a decoded body is cut to. */
const MAX_BODY = 200_000;
const BASE64URL = /^[A-Za-z0-9_-]*={0,2}$/;

function partRecord(value: unknown): GmailPart | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as GmailPart : null;
}
function filled(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

/** The first non-attachment text/plain and text/html parts that carry data, found
 * depth-first in pre-order from the payload (depth 0, the first visited part).
 * An attachment (a non-empty filename or attachmentId) is skipped with its whole
 * subtree. At most MAX_PARTS parts are visited, attachments included, and none
 * deeper than MAX_PART_DEPTH: parts beyond either bound are not read, never refused. */
function gmailBodyParts(root: GmailPart): {plain: GmailPart | null; html: GmailPart | null} {
  let plain: GmailPart | null = null, html: GmailPart | null = null, visited = 0;
  const pending: [GmailPart, number][] = [[root, 0]];
  while (pending.length > 0 && visited < MAX_PARTS && plain === null) {
    const [part, depth] = pending.pop()!;
    visited += 1;
    const body = partRecord(part.body);
    if (filled(part.filename) || filled(body?.attachmentId)) continue;
    const mimeType = typeof part.mimeType === 'string' ? part.mimeType.toLowerCase() : '';
    if (filled(body?.data) && mimeType === 'text/plain') plain = part;
    else if (filled(body?.data) && mimeType === 'text/html' && html === null) html = part;
    const children = depth < MAX_PART_DEPTH && Array.isArray(part.parts) ? part.parts.slice(0, MAX_PARTS) : [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = partRecord(children[index]);
      if (child) pending.push([child, depth + 1]);
    }
  }
  return {plain, html};
}

/** A decoder for the charset of the part's own Content-Type header, else UTF-8
 * (`new TextDecoder` throws RangeError for a label it does not support). */
function partDecoder(part: GmailPart): TextDecoder {
  const headers = Array.isArray(part.headers) ? part.headers.slice(0, MAX_PART_HEADERS) : [];
  const contentType = headers.map(partRecord)
    .find(entry => typeof entry?.name === 'string' && entry.name.toLowerCase() === 'content-type');
  const value = contentType?.value;
  const label = typeof value === 'string' ? /;\s*charset\s*=\s*"?([^";\s]+)/i.exec(value)?.[1] : undefined;
  try { return new TextDecoder(label ?? 'utf-8'); }
  catch { return new TextDecoder('utf-8'); }
}

/** The part's base64url `data` decoded to text. Only the url-safe alphabet with
 * optional trailing padding is accepted (`atob` alone would also accept
 * whitespace and the standard alphabet); anything else refuses the payload.
 * Data beyond MAX_PART_DATA is not decoded, and a multibyte sequence the cut
 * splits is dropped (`stream: true` withholds it) rather than turned into U+FFFD. */
function decodeGmailPart(part: GmailPart): {text: string; truncated: boolean} {
  const data = partRecord(part.body)?.data;
  if (typeof data !== 'string' || !BASE64URL.test(data)) throw new SourcePayloadInvalid('GMAIL');
  const length = data.length - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
  if (length % 4 === 1) throw new SourcePayloadInvalid('GMAIL');
  const truncated = length > MAX_PART_DATA;
  const binary = atob(data.slice(0, truncated ? MAX_PART_DATA : length).replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  return {text: partDecoder(part).decode(bytes, {stream: truncated}), truncated};
}

const HTML_ENTITIES: Readonly<Record<string, string>> = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00A0'};
function htmlCodePoint(value: number): string {
  return value === 0 || (value >= 0xD800 && value <= 0xDFFF) || value > 0x10FFFF ? '\uFFFD' : String.fromCodePoint(value);
}

/** HTML reduced to text by a fixed rule: drop script, style, title, noscript and
 * template elements (an unclosed one runs to the end) and comments, strip tags,
 * decode the basic entities in one pass, collapse whitespace. `head` is not in the
 * list: its end tag is optional, so an unclosed head would swallow the body, and
 * its title, style and script children are dropped by their own entries. Every
 * pattern is linear on sender-controlled input: `[^<>]` keeps a run of '<' from backtracking. */
function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|title|noscript|template)\b[^<>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ')
    .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
    .replace(/<[^<>]*>/g, ' ')
    .replace(/&(?:(amp|lt|gt|quot|apos|nbsp)|#(\d{1,7})|#x([\da-f]{1,6}));/gi,
      (entity: string, name: string | undefined, decimal: string | undefined, hex: string | undefined) =>
        name !== undefined ? HTML_ENTITIES[name.toLowerCase()] ?? entity
          : htmlCodePoint(decimal !== undefined ? Number(decimal) : parseInt(hex ?? '', 16)))
    .replace(/\s+/g, ' ')
    .trim();
}

/** A decoded body made storable: U+0000 (which a PostgreSQL text column refuses)
 * becomes U+FFFD, and a body over MAX_BODY is cut, one unit earlier when the cut
 * would split a surrogate pair. Size never refuses a thread. */
function boundedBody(text: string, truncated: boolean): {body: string; truncated: boolean} {
  const body = text.replace(/\u0000/g, '\uFFFD');
  if (body.length <= MAX_BODY) return {body, truncated};
  const last = body.charCodeAt(MAX_BODY - 1);
  return {body: body.slice(0, last >= 0xD800 && last <= 0xDBFF ? MAX_BODY - 1 : MAX_BODY), truncated: true};
}

/** A message's body: a present `payload.body.text` unchanged (the decoded shape,
 * whose stored content hashes must not move), else the decoded first text/plain
 * part, else the first text/html part reduced to text, else ''. */
function gmailBody(payload: GmailPart & {body?: {text?: string | undefined} | undefined}): {body: string; truncated: boolean} {
  if (typeof payload.body?.text === 'string') return {body: payload.body.text, truncated: false};
  const {plain, html} = gmailBodyParts(payload);
  const selected = plain ?? html;
  if (!selected) return {body: '', truncated: false};
  const decoded = decodeGmailPart(selected);
  return boundedBody(plain ? decoded.text : htmlToText(decoded.text), decoded.truncated);
}

function parseGmailThread(payload: unknown): ParsedSourceItem[] {
  const thread = gmailThreadSchema.parse(payload);
  // RFC 5322 Message-Id to Gmail message id, so a reply anchors to the message it
  // answers; a message whose parent is absent from the payload anchors to the thread.
  const byMessageId = new Map<string, string>();
  for (const message of thread.messages) {
    const id = header(message.payload.headers, 'Message-Id');
    if (id) byMessageId.set(id.toLowerCase(), message.id);
  }
  return thread.messages.map((message, index) => {
    const headers = message.payload.headers;
    const inReplyTo = header(headers, 'In-Reply-To');
    const parent = inReplyTo ? byMessageId.get(inReplyTo.toLowerCase()) : undefined;
    const subject = header(headers, 'Subject');
    const from = header(headers, 'From');
    const {body, truncated} = gmailBody(message.payload);
    return parsedSourceItemSchema.parse({
      sourceType: 'GMAIL',
      externalId: message.id,
      parentExternalId: parent && parent !== message.id ? parent : thread.id,
      actorRef: from ? {type: 'EXTERNAL', id: from.slice(0, 512)} : null,
      occurredAt: instant(message.internalDate) ?? instant(header(headers, 'Date')),
      content: {
        messageExternalId: message.id, threadExternalId: thread.id,
        from, to: header(headers, 'To'), cc: header(headers, 'Cc'), subject, body,
      },
      deterministicMetadata: {
        threadExternalId: thread.id, threadPosition: index,
        inReplyTo: inReplyTo ?? null, labelIds: message.labelIds ?? [],
        ...(truncated ? {bodyTruncated: true} : {}),
      },
      anchors: [
        span('MESSAGE_SPAN', {messageExternalId: message.id, field: 'body', start: 0, end: body.length}, body),
        span('CONNECTOR_JSON_PATH', {path: '$.messages[' + index + '].payload.headers[name=Subject].value'}, subject),
      ],
    });
  });
}

function parseConversation(payload: unknown): ParsedSourceItem[] {
  const conversation = conversationSchema.parse(payload);
  return conversation.messages.map((message, index) => {
    const previous = index === 0 ? null : conversation.messages[index - 1]!.messageId;
    return parsedSourceItemSchema.parse({
      sourceType: 'CONVERSATION',
      // The message's own external id, which is what makes one message one
      // evidence row and a redelivered message the same row (CRT-CON-01-A).
      externalId: message.messageId,
      parentExternalId: previous ?? conversation.conversationId,
      // A user message is attributed to the submitting owner, so the ingest path
      // binds it to the authenticated actor rather than to a name in the payload.
      // An assistant message names the assistant: PRD §24.2 keeps model output as
      // evidence with its own origin, never as the owner's own statement.
      actorRef: message.role === 'ASSISTANT'
        ? { type: 'ASSISTANT', id: (message.authorRef ?? 'assistant').slice(0, 512) } : null,
      occurredAt: instant(message.createdAt),
      content: {
        messageExternalId: message.messageId, conversationExternalId: conversation.conversationId,
        role: message.role, title: conversation.title ?? null, body: message.text,
      },
      deterministicMetadata: {
        conversationExternalId: conversation.conversationId, role: message.role,
        messagePosition: index, repliesTo: previous,
      },
      anchors: [
        span('MESSAGE_SPAN', { messageExternalId: message.messageId, field: 'body', start: 0, end: message.text.length }, message.text),
      ],
    });
  });
}

function parseGoogleCalendarEvent(payload: unknown): ParsedSourceItem[] {
  const event = googleCalendarEventSchema.parse(payload);
  const recurrence = event.recurrence ?? [];
  return event.instances.map((occurrence, index) => {
    // The recurrence id comes from the payload's own recurringEventId; a series
    // without one is identified by the event the occurrences were expanded from.
    const recurrenceId = occurrence.recurringEventId ?? event.id;
    const startsAt = occurrence.start.dateTime ?? (occurrence.start.date ? occurrence.start.date + 'T00:00:00Z' : null);
    const endsAt = occurrence.end.dateTime ?? (occurrence.end.date ? occurrence.end.date + 'T00:00:00Z' : null);
    const originalStart = occurrence.originalStartTime?.dateTime
      ?? (occurrence.originalStartTime?.date ? occurrence.originalStartTime.date + 'T00:00:00Z' : null);
    return parsedSourceItemSchema.parse({
      sourceType: 'GOOGLE_CALENDAR',
      externalId: occurrence.id,
      parentExternalId: recurrenceId,
      actorRef: event.organizer ? {type: 'EXTERNAL', id: event.organizer.email.slice(0, 512)} : null,
      occurredAt: instant(startsAt),
      content: {
        occurrenceExternalId: occurrence.id, recurrenceId,
        summary: occurrence.summary ?? event.summary ?? null, location: occurrence.location ?? null,
        status: occurrence.status ?? null, start: startsAt, end: endsAt,
        timeZone: occurrence.start.timeZone ?? event.timeZone ?? null,
        attendees: (occurrence.attendees ?? []).map(attendee => ({
          email: attendee.email, responseStatus: attendee.responseStatus ?? null,
        })),
      },
      deterministicMetadata: {
        recurrenceId, recurrence, occurrencePosition: index, originalStartTime: originalStart,
      },
      anchors: [
        span('CALENDAR_FIELD', {occurrenceExternalId: occurrence.id, field: 'start'}, startsAt),
        span('CALENDAR_FIELD', {occurrenceExternalId: occurrence.id, field: 'end'}, endsAt),
        span('CALENDAR_FIELD', {occurrenceExternalId: occurrence.id, field: 'recurrence', recurrenceId}, recurrence.join('\n') || null),
        span('CONNECTOR_JSON_PATH', {path: '$.instances[' + index + '].recurringEventId'}, recurrenceId),
      ],
    });
  });
}

function parseGithubIssueThread(payload: unknown): ParsedSourceItem[] {
  const thread = githubIssueThreadSchema.parse(payload);
  const repository = thread.repository.full_name;
  const issueExternalId = repository + '#' + thread.issue.number;
  const issueBody = thread.issue.body ?? '';
  const items: ParsedSourceItem[] = [parsedSourceItemSchema.parse({
    sourceType: 'GITHUB',
    externalId: issueExternalId,
    parentExternalId: repository,
    actorRef: {type: 'EXTERNAL', id: thread.issue.user.login},
    occurredAt: instant(thread.issue.created_at),
    content: {
      repository, number: thread.issue.number, nodeId: thread.issue.node_id,
      kind: thread.issue.pull_request ? 'PULL_REQUEST' : 'ISSUE',
      title: thread.issue.title, body: issueBody, author: thread.issue.user.login,
    },
    deterministicMetadata: {repository, issueNumber: thread.issue.number, nodeId: thread.issue.node_id},
    anchors: [
      span('MESSAGE_SPAN', {externalId: issueExternalId, field: 'body', start: 0, end: issueBody.length}, issueBody),
      span('CONNECTOR_JSON_PATH', {path: '$.issue.title'}, thread.issue.title),
    ],
  })];
  for (const [index, comment] of (thread.comments ?? []).entries()) {
    const commentExternalId = issueExternalId + '/comments/' + comment.id;
    items.push(parsedSourceItemSchema.parse({
      sourceType: 'GITHUB',
      externalId: commentExternalId,
      parentExternalId: issueExternalId,
      actorRef: {type: 'EXTERNAL', id: comment.user.login},
      occurredAt: instant(comment.created_at),
      content: {
        repository, number: thread.issue.number, commentId: comment.id, nodeId: comment.node_id,
        kind: 'COMMENT', body: comment.body, author: comment.user.login,
      },
      deterministicMetadata: {repository, issueNumber: thread.issue.number, nodeId: comment.node_id, commentPosition: index},
      anchors: [
        span('GITHUB_COMMENT', {repository, issueNumber: thread.issue.number, commentId: comment.id, nodeId: comment.node_id}, comment.body),
        span('MESSAGE_SPAN', {externalId: commentExternalId, field: 'body', start: 0, end: comment.body.length}, comment.body),
      ],
    }));
  }
  const commits = thread.commits ?? [], checkRuns = thread.check_runs ?? [];
  if (commits.length > 0 || checkRuns.length > 0) items.push(githubEpisode(thread, issueExternalId, repository));
  return items;
}

/**
 * One aggregated episode for a burst of commits and CI webhooks on one pull
 * request (PRD §20.5, CRT-CON-04-A).
 *
 * The aggregation happens here, in the deterministic parser, and not in a worker:
 * the burst becomes *one* source item, so it receives one triage decision and at
 * most one semantic extraction, however many commits and check runs it carried.
 * The events themselves are not lost -- each one is an anchor and a content
 * entry on the episode -- and the episode's identity is the pull request, so a
 * redelivery of the identical burst re-derives the identical content hash and
 * creates no second row.
 */
function githubEpisode(
  thread: z.infer<typeof githubIssueThreadSchema>, issueExternalId: string, repository: string,
): ParsedSourceItem {
  const commits = thread.commits ?? [], checkRuns = thread.check_runs ?? [];
  const commitEntries = commits.map(commit => ({
    sha: commit.sha, message: commit.message,
    author: commit.author?.login ?? null, committedAt: instant(commit.committed_at),
  }));
  const checkEntries = checkRuns.map(run => ({
    checkRunId: run.id, name: run.name, status: run.status,
    conclusion: run.conclusion ?? null, headSha: run.head_sha ?? null, completedAt: instant(run.completed_at),
  }));
  const times = [...commitEntries.map(entry => entry.committedAt), ...checkEntries.map(entry => entry.completedAt)]
    .filter((value): value is string => value !== null).sort();
  const anchors: ParsedSourceAnchor[] = [];
  for (const [index, commit] of commits.entries()) {
    anchors.push(span('CONNECTOR_JSON_PATH', { path: '$.commits[' + index + '].sha', sha: commit.sha }, commit.message));
  }
  for (const [index, run] of checkRuns.entries()) {
    anchors.push(span('CONNECTOR_JSON_PATH',
      { path: '$.check_runs[' + index + '].conclusion', checkRunId: run.id },
      run.name + ' ' + run.status + (run.conclusion ? ' ' + run.conclusion : '')));
  }
  return parsedSourceItemSchema.parse({
    sourceType: 'GITHUB',
    externalId: issueExternalId + '/episode',
    parentExternalId: issueExternalId,
    // The repository is the actor of an aggregated episode: no single person
    // authored it, and attributing it to the submitting owner would be false.
    actorRef: { type: 'EXTERNAL', id: repository.slice(0, 512) },
    occurredAt: times.at(-1) ?? null,
    content: {
      repository, number: thread.issue.number, kind: 'PULL_REQUEST_EPISODE',
      title: thread.issue.title, commits: commitEntries, checkRuns: checkEntries,
      body: [
        commitEntries.length + ' commit(s) and ' + checkEntries.length + ' CI event(s) on '
        + (thread.issue.pull_request ? 'pull request ' : 'issue ') + issueExternalId,
        ...commitEntries.map(entry => entry.sha.slice(0, 7) + ' ' + entry.message.split('\n')[0]),
        ...checkEntries.map(entry => entry.name + ': ' + (entry.conclusion ?? entry.status)),
      ].join('\n'),
    },
    deterministicMetadata: {
      repository, issueNumber: thread.issue.number, episodeKind: 'COMMIT_AND_CI_BURST',
      aggregatedCommitCount: commitEntries.length, aggregatedCheckRunCount: checkEntries.length,
      aggregatedEventCount: commitEntries.length + checkEntries.length,
      headSha: commitEntries.at(-1)?.sha ?? null,
    },
    anchors,
  });
}

function parseUploadedDocument(payload: unknown): ParsedSourceItem[] {
  const document = uploadedDocumentSchema.parse(payload);
  const anchors: ParsedSourceAnchor[] = document.pages.map(page =>
    span('DOCUMENT_RANGE', {documentId: document.documentId, page: page.page, start: 0, end: page.text.length}, page.text));
  anchors.push(span('CONNECTOR_JSON_PATH', {path: '$.title'}, document.title ?? null));
  return [parsedSourceItemSchema.parse({
    sourceType: 'DOCUMENT',
    externalId: 'document:' + document.documentId,
    parentExternalId: null,
    actorRef: null,
    occurredAt: null,
    content: {
      documentId: document.documentId, title: document.title ?? null,
      mediaType: document.mediaType ?? 'text/plain',
      pages: document.pages.map(page => ({page: page.page, text: page.text})),
      ...(document.base64 === undefined ? {} : {base64: document.base64}),
    },
    deterministicMetadata: {
      pageCount: document.pages.length, mediaType: document.mediaType ?? 'text/plain',
      textExtracted: document.pages.length > 0,
    },
    anchors,
  })];
}

/** ADR 0041 D3: require an offset; never infer the machine's local time zone. */
function offsetInstant(value: string | null | undefined): string | null {
  if (value == null || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function omiSpeakerRole(conversation: OmiConversation, speakerId: string | null): 'OWNER' | 'OTHER' | 'UNKNOWN' {
  if (conversation.participants_included !== true || speakerId === null) return 'UNKNOWN';
  const matches = (conversation.participants ?? []).filter(participant =>
    participant.speaker_id != null && String(participant.speaker_id) === speakerId);
  if (matches.length === 0) return 'UNKNOWN';
  if (matches.every(participant => participant.is_user === true)) return 'OWNER';
  return matches.every(participant => participant.is_user !== true) ? 'OTHER' : 'UNKNOWN';
}

// ADR 0041 D3-D5: EXTERNAL speech and ASSISTANT summaries have distinct actors.
// Derived roles live in metadata/anchors, never content identity. Anchor start/end
// are character offsets; startSeconds/endSeconds retain the recording offsets.
function omiTranscriptItem(conversation: OmiConversation): ParsedSourceItem {
  const participantsIncluded = conversation.participants_included === true;
  const segments = (conversation.transcript_segments ?? []).map((segment, index) => ({
    index, segmentId: segment.id ?? null, speakerId: segment.speaker_id == null ? null : String(segment.speaker_id),
    speakerName: segment.speaker_name ?? null, startSeconds: segment.start, endSeconds: segment.end,
    text: segment.text, originalText: segment.original_text ?? null,
  }));
  const roles = segments.map(segment => omiSpeakerRole(conversation, segment.speakerId));
  return parsedSourceItemSchema.parse({
    sourceType: 'OMI', externalId: 'omi:conversation:' + conversation.id, parentExternalId: null,
    actorRef: {type: 'EXTERNAL', id: 'omi:transcript'}, occurredAt: offsetInstant(conversation.started_at),
    content: {
      kind: 'OMI_TRANSCRIPT', conversationExternalId: conversation.id,
      startedAt: offsetInstant(conversation.started_at), finishedAt: offsetInstant(conversation.finished_at),
      language: conversation.language ?? null, participantsIncluded,
      participants: participantsIncluded ? (conversation.participants ?? []).map(participant => ({
        speakerId: participant.speaker_id == null ? null : String(participant.speaker_id),
        personId: participant.person_id ?? null, isUser: participant.is_user === true,
      })) : [],
      segments,
    },
    deterministicMetadata: {
      conversationExternalId: conversation.id, threadExternalId: 'omi:conversation:' + conversation.id,
      createdAt: conversation.created_at, captureSource: conversation.source ?? null, providerApi: 'omi-developer-api-v1',
      segmentCount: segments.length, segmentSpeakerRoles: roles,
      ownerSegmentCount: roles.filter(role => role === 'OWNER').length,
      otherSegmentCount: roles.filter(role => role === 'OTHER').length,
      unknownSegmentCount: roles.filter(role => role === 'UNKNOWN').length,
      speakerRoleBasis: participantsIncluded ? 'PARTICIPANTS' : 'UNAVAILABLE',
      durationSeconds: segments.length === 0 ? null
        : Math.max(...segments.map(segment => segment.endSeconds)) - Math.min(...segments.map(segment => segment.startSeconds)),
    },
    anchors: segments.map((segment, index) => span('TRANSCRIPT_SEGMENT', {
      conversationExternalId: conversation.id, segmentIndex: index,
      speakerId: segment.speakerId, speakerName: segment.speakerName, speakerRole: roles[index],
      startSeconds: segment.startSeconds, endSeconds: segment.endSeconds, start: 0, end: segment.text.length,
    }, segment.text)),
  });
}

function omiStructuredItem(conversation: OmiConversation, structured: NonNullable<OmiConversation['structured']>): ParsedSourceItem {
  const actionItems = (structured.action_items ?? []).map(item => ({description: item.description, dueAt: offsetInstant(item.due_at)}));
  const events = (structured.events ?? []).map(event => ({
    title: event.title, start: offsetInstant(event.start), durationMinutes: event.duration ?? null,
  }));
  return parsedSourceItemSchema.parse({
    sourceType: 'OMI', externalId: 'omi:conversation:' + conversation.id + ':structured',
    parentExternalId: 'omi:conversation:' + conversation.id, actorRef: {type: 'ASSISTANT', id: 'omi:structured'}, occurredAt: null,
    content: {
      kind: 'OMI_STRUCTURED_SUMMARY', conversationExternalId: conversation.id,
      title: structured.title ?? null, overview: structured.overview ?? null, category: structured.category ?? null,
      actionItems, events,
    },
    deterministicMetadata: {
      conversationExternalId: conversation.id, threadExternalId: 'omi:conversation:' + conversation.id,
      providerApi: 'omi-developer-api-v1', actionItemCount: actionItems.length, eventCount: events.length,
    },
    anchors: [
      span('CONNECTOR_JSON_PATH', {path: '$.structured.title'}, structured.title ?? null),
      span('CONNECTOR_JSON_PATH', {path: '$.structured.overview'}, structured.overview ?? null),
      ...actionItems.map((item, index) => span('CONNECTOR_JSON_PATH', {path: '$.structured.action_items[' + index + '].description'}, item.description)),
    ],
  });
}

function parseOmiConversation(payload: unknown): ParsedSourceItem[] {
  const conversation = omiConversationSchema.parse(payload);
  const items = [omiTranscriptItem(conversation)];
  if (conversation.structured != null) items.push(omiStructuredItem(conversation, conversation.structured));
  return items;
}

const parsers: Record<ParsedSourceType, (payload: unknown) => ParsedSourceItem[]> = {
  CONVERSATION: parseConversation,
  GMAIL: parseGmailThread,
  GOOGLE_CALENDAR: parseGoogleCalendarEvent,
  GITHUB: parseGithubIssueThread,
  DOCUMENT: parseUploadedDocument,
  OMI: parseOmiConversation,
};

export function parseSourcePayload(sourceType: string, payload: unknown): ParsedSourceItem[] {
  const type = parsedSourceTypeSchema.safeParse(sourceType);
  if (!type.success) throw new SourcePayloadInvalid(sourceType);
  try { return parsers[type.data](payload); }
  catch { throw new SourcePayloadInvalid(type.data); }
}
