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
  'MESSAGE_SPAN', 'DOCUMENT_RANGE', 'CALENDAR_FIELD', 'CONNECTOR_JSON_PATH', 'GITHUB_COMMENT',
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

export const parsedSourceTypeSchema = z.enum(['CONVERSATION', 'GMAIL', 'GOOGLE_CALENDAR', 'GITHUB', 'DOCUMENT']);
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
    body: z.object({text}),
  }),
});
export const gmailThreadSchema = z.object({
  id: externalId,
  messages: z.array(gmailMessageSchema).min(1).max(512),
});

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
    const body = message.payload.body.text;
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

const parsers: Record<ParsedSourceType, (payload: unknown) => ParsedSourceItem[]> = {
  CONVERSATION: parseConversation,
  GMAIL: parseGmailThread,
  GOOGLE_CALENDAR: parseGoogleCalendarEvent,
  GITHUB: parseGithubIssueThread,
  DOCUMENT: parseUploadedDocument,
};

export function parseSourcePayload(sourceType: string, payload: unknown): ParsedSourceItem[] {
  const type = parsedSourceTypeSchema.safeParse(sourceType);
  if (!type.success) throw new SourcePayloadInvalid(sourceType);
  try { return parsers[type.data](payload); }
  catch { throw new SourcePayloadInvalid(type.data); }
}
