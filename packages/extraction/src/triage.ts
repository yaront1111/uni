import { tier0ParseSchema, routingReasonSchema, tier1RouteSchema,
  type Tier0Parse, type Tier1Route, type Tier1Signal, type RoutingReason } from '@unai/domain';

/** The triage service: Tier-0 deterministic parsing and Tier-1 routing
 * (PRD §20.1, §20.2, §36.2).
 *
 * Both tiers are pure functions of bytes already in hand — no model call, no
 * clock, no network, no random value — which is what lets triage run for *every*
 * ingested item inside the ingest transaction rather than for a sampled subset
 * (ADR 0016 §1, §2). Identical bytes always produce the identical route and the
 * identical reason, so a re-import re-derives the decision it already has.
 *
 * Tier 1 answers one of exactly five routes and always says why. A newsletter or
 * a routine CI notification is preserved and indexed, never fully extracted
 * (CRT-WRT-07-A), and a message that is only quoted history is preserved without
 * extraction at all, so a thread update costs one deep extraction rather than one
 * per quoted message (CRT-WRT-07-B).
 */

export const TIER0_PARSER_VERSION = 'tier0-deterministic-0.1.0';
export const TIER1_ROUTER_VERSION = 'tier1-rules-0.1.0';

/** What a route is allowed to spend, in millionths of the billing unit. The
 * budget is the gateway's ceiling for the run, not an estimate. */
export const ROUTE_COST_BUDGET_MICROUNITS: Readonly<Record<Tier1Route, number>> = Object.freeze({
  SOURCE_ONLY: 0, INDEX_ONLY: 0, DEFER_UNTIL_RELEVANT: 0,
  ENTITY_EXTRACTION: 4000, FULL_EXTRACTION: 20000,
});

export interface TriageInput {
  readonly sourceType: string;
  readonly externalId: string;
  readonly parentExternalId: string | null;
  readonly actorRef: { readonly type: string; readonly id: string };
  readonly occurredAt: string | null;
  readonly content: Readonly<Record<string, unknown>>;
  readonly deterministicMetadata: Readonly<Record<string, unknown>>;
}
export interface TriageResult {
  readonly tier0: Tier0Parse;
  readonly route: Tier1Route;
  readonly reason: RoutingReason;
  readonly costBudgetMicrounits: number;
}

function text(value: unknown): string { return typeof value === 'string' ? value : ''; }
function optionalText(value: unknown): string | null { return typeof value === 'string' && value !== '' ? value : null; }

/** Quoted history and signature blocks, removed exactly as written.
 *
 * A Gmail thread update repeats every earlier message inside the newest one. The
 * unit of memory is the *new* content (PRD §20.5), so the quoted part is cut
 * here, once, deterministically: `>`-prefixed lines, an "On ... wrote:"
 * attribution and everything after it, a forwarded-message marker, and a `-- `
 * signature. What remains is what a model would ever be asked to read.
 */
export function splitQuotedHistory(body: string): { newText: string; quotedText: string } {
  const lines = body.split(/\r?\n/);
  const kept: string[] = [], quoted: string[] = [];
  let quoting = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!quoting && (/^on\b.*\bwrote:\s*$/i.test(trimmed)
      || /^-{2,}\s*(original message|forwarded message)\s*-{2,}$/i.test(trimmed)
      || /^_{5,}$/.test(trimmed) || trimmed === '--')) quoting = true;
    if (quoting || trimmed.startsWith('>')) { quoted.push(line); continue; }
    kept.push(line);
  }
  return { newText: kept.join('\n').trim(), quotedText: quoted.join('\n') };
}

const AUTOMATED_SENDER = /(^|[<\s])(no-?reply|do-?not-?reply|notifications?|mailer-daemon|bounce|newsletter|digest)@/i;
const BOT_ACTOR = /(\[bot\]$|^dependabot|^github-actions|^renovate)/i;
const NEWSLETTER_TEXT = /\b(unsubscribe|manage your preferences|view (this|it) in your browser|you are receiving this (email|message) because)\b/i;
const CI_TEXT = /\b(build|pipeline|workflow|job|check|test suite|deployment)\b[^.\n]{0,80}\b(passed|failed|succeeded|completed|is green|was cancelled|queued|started)\b/i;
const AMOUNT = /(?:[$€£₪]\s?\d[\d,.]*)|(?:\b(?:ils|usd|eur|gbp|nis)\s?\d[\d,.]*)|(?:\b\d[\d,.]*\s?(?:ils|usd|eur|gbp|shekels?|dollars?|euros?)\b)/i;
const DEADLINE = /\b(by|before|due|deadline|no later than|until)\b[^.\n]{0,40}\b(today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next week|next month|end of (the )?(day|week|month)|\d{1,2}(st|nd|rd|th)?|\d{4}-\d{2}-\d{2})\b/i;
const COMMITMENT = /\b(i'?ll|i will|we'?ll|we will|i'?m going to|i promise|i'?ll make sure|will send|will pay|will confirm|will call|will review)\b/i;
const DECISION = /\b(we (decided|agreed|chose)|i (decided|chose)|let'?s go with|the decision is|going with|approved)\b/i;
const CORRECTION = /\b(actually|correction|i was wrong|that'?s not right|scratch that|to correct|i meant)\b/i;
const PREFERENCE = /\b(i (prefer|like|hate|don'?t like|would rather)|we (prefer|usually))\b/i;
const STATE_TRANSITION = /\b(has (moved|changed|shipped|arrived)|is now|no longer|cancelled|postponed|rescheduled|resolved|closed)\b/i;

/** Tier 0: the structure the source itself provides, and nothing inferred. */
export function parseTier0(input: TriageInput): Tier0Parse {
  const content = input.content, metadata = input.deterministicMetadata;
  const participants = new Set<string>();
  let subject: string | null = null, body = '', automated = false;
  const structuredFields: Record<string, unknown> = {};

  if (input.sourceType === 'GMAIL') {
    subject = optionalText(content.subject);
    body = text(content.body);
    for (const field of ['from', 'to', 'cc'] as const) {
      for (const address of text(content[field]).split(',')) {
        const value = address.trim();
        if (value !== '') participants.add(value);
      }
    }
    const labels = Array.isArray(metadata.labelIds) ? metadata.labelIds.filter((label): label is string => typeof label === 'string') : [];
    structuredFields.labelIds = labels;
    structuredFields.threadPosition = typeof metadata.threadPosition === 'number' ? metadata.threadPosition : null;
    automated = AUTOMATED_SENDER.test(text(content.from))
      || labels.some(label => label === 'CATEGORY_PROMOTIONS' || label === 'CATEGORY_UPDATES' || label === 'CATEGORY_FORUMS');
  } else if (input.sourceType === 'GOOGLE_CALENDAR') {
    subject = optionalText(content.summary);
    body = [optionalText(content.summary), optionalText(content.location)].filter(value => value !== null).join('\n');
    for (const attendee of Array.isArray(content.attendees) ? content.attendees : []) {
      const email = attendee && typeof attendee === 'object' ? (attendee as Record<string, unknown>).email : null;
      if (typeof email === 'string' && email !== '') participants.add(email);
    }
    structuredFields.start = optionalText(content.start);
    structuredFields.end = optionalText(content.end);
    structuredFields.recurrenceId = optionalText(content.recurrenceId);
    structuredFields.status = optionalText(content.status);
  } else if (input.sourceType === 'GITHUB') {
    subject = optionalText(content.title);
    body = text(content.body);
    const author = optionalText(content.author);
    if (author !== null) participants.add(author);
    structuredFields.repository = optionalText(content.repository);
    structuredFields.kind = optionalText(content.kind);
    structuredFields.number = typeof content.number === 'number' ? content.number : null;
    automated = author !== null && BOT_ACTOR.test(author);
  } else if (input.sourceType === 'DOCUMENT') {
    subject = optionalText(content.title);
    const pages = Array.isArray(content.pages) ? content.pages : [];
    body = pages.map(page => page && typeof page === 'object' ? text((page as Record<string, unknown>).text) : '').join('\n');
    structuredFields.pageCount = pages.length;
    structuredFields.mediaType = optionalText(content.mediaType);
  } else {
    // An unknown source type is parsed for whatever text it carries and nothing
    // is assumed about its shape: Tier 0 never guesses structure.
    subject = optionalText(content.subject) ?? optionalText(content.title);
    body = text(content.body) ?? '';
  }
  if (input.actorRef.type !== 'USER') participants.add(input.actorRef.id);

  const split = splitQuotedHistory(body);
  return tier0ParseSchema.parse({
    parserVersion: TIER0_PARSER_VERSION,
    sourceType: input.sourceType,
    externalId: input.externalId,
    parentExternalId: input.parentExternalId,
    threadExternalId: optionalText(metadata.threadExternalId) ?? optionalText(metadata.recurrenceId) ?? input.parentExternalId,
    occurredAt: input.occurredAt,
    participants: [...participants].slice(0, 64),
    subject,
    newText: split.newText.slice(0, 200000),
    quotedTextLength: split.quotedText.length,
    automated,
    structuredFields: JSON.parse(JSON.stringify(structuredFields)) as Record<string, unknown>,
  });
}

/** Tier 1: one of five routes, with the signals that decided it (PRD §20.2).
 *
 * The order matters and is the policy: a negative signal that makes an item not
 * worth extracting is checked before the positive signals, so a newsletter that
 * happens to quote a price is still a newsletter. */
export function routeTier1(tier0: Tier0Parse, options?: { userAuthored?: boolean; assistantAuthored?: boolean }): { route: Tier1Route; reason: RoutingReason } {
  const scanned = [tier0.subject ?? '', tier0.newText].join('\n');
  const positive: Tier1Signal[] = [], negative: Tier1Signal[] = [];
  const userAuthored = options?.userAuthored === true;

  // PRD §24.1: an AI statement cannot serve as evidence that its own content is
  // true. An assistant's message is kept as conversation evidence and never
  // extracted, whatever amounts or deadlines it mentions (CRT-AI-01-A).
  if (options?.assistantAuthored === true) {
    return {
      route: tier1RouteSchema.parse('SOURCE_ONLY'),
      reason: routingReasonSchema.parse({
        code: 'ASSISTANT_AUTHORED', routerVersion: TIER1_ROUTER_VERSION,
        positiveSignals: [], negativeSignals: [], newContentLength: tier0.newText.length,
      }),
    };
  }

  if (userAuthored) positive.push('USER_AUTHORED');
  if (AMOUNT.test(scanned)) positive.push('AMOUNT');
  if (DEADLINE.test(scanned)) positive.push('DEADLINE');
  if (COMMITMENT.test(scanned)) positive.push('COMMITMENT');
  if (DECISION.test(scanned)) positive.push('DECISION');
  if (CORRECTION.test(scanned)) positive.push('CORRECTION');
  if (PREFERENCE.test(scanned)) positive.push('PREFERENCE');
  if (STATE_TRANSITION.test(scanned)) positive.push('STATE_TRANSITION');
  if (tier0.participants.length > 0) positive.push('KNOWN_PARTICIPANT');
  if (tier0.sourceType === 'GOOGLE_CALENDAR') positive.push('SCHEDULED_EVENT');

  const newsletter = tier0.automated && NEWSLETTER_TEXT.test(scanned);
  const ciNotification = tier0.automated && (CI_TEXT.test(scanned) || tier0.sourceType === 'GITHUB');
  if (newsletter) negative.push('NEWSLETTER');
  if (ciNotification) negative.push(tier0.sourceType === 'GITHUB' ? 'LOW_VALUE_CI_NOISE' : 'ROUTINE_AUTOMATED_NOTIFICATION');
  if (tier0.quotedTextLength > 0) negative.push('REPEATED_QUOTED_HISTORY');
  if (tier0.newText.trim() === '') negative.push(tier0.quotedTextLength > 0 ? 'SIGNATURE_ONLY' : 'NO_EXTRACTABLE_TEXT');

  const decide = (route: Tier1Route, code: RoutingReason['code']) => ({
    route: tier1RouteSchema.parse(route),
    reason: routingReasonSchema.parse({
      code, routerVersion: TIER1_ROUTER_VERSION,
      positiveSignals: positive, negativeSignals: negative, newContentLength: tier0.newText.length,
    }),
  });

  // Nothing new to read. A message that is only quoted history or only a
  // signature is kept as evidence and never extracted again -- this is what
  // bounds a thread update to one deep extraction (CRT-WRT-07-B).
  if (tier0.newText.trim() === '') {
    return decide('SOURCE_ONLY', tier0.quotedTextLength > 0 ? 'REPEATED_QUOTED_HISTORY' : 'NO_NEW_CONTENT');
  }
  // Preserved and searchable, with no canonical belief taken from it (PRD §19.2).
  if (newsletter) return decide('INDEX_ONLY', 'NEWSLETTER');
  if (ciNotification) return decide('INDEX_ONLY', 'ROUTINE_CI_NOTIFICATION');

  // A stored document is indexed immediately and extracted lazily unless it
  // carries a signal that makes it worth the cost now (PRD §20.5).
  if (tier0.sourceType === 'DOCUMENT') {
    const worthwhile = positive.some(signal => signal === 'AMOUNT' || signal === 'DEADLINE' || signal === 'COMMITMENT' || signal === 'DECISION');
    if (!worthwhile) { negative.push('LAZY_DOCUMENT'); return decide('DEFER_UNTIL_RELEVANT', 'LAZY_DOCUMENT_EXTRACTION'); }
    return decide('FULL_EXTRACTION', 'MEMORY_WORTHY_SIGNALS');
  }

  const material = positive.some(signal => signal !== 'KNOWN_PARTICIPANT' && signal !== 'SCHEDULED_EVENT' && signal !== 'USER_AUTHORED');
  if (material) return decide('FULL_EXTRACTION', 'MEMORY_WORTHY_SIGNALS');
  // Structured connector fields are used directly; the model is reserved for
  // meaning, so identity resolution is all that is bought here (PRD §20.5).
  if (tier0.sourceType === 'GOOGLE_CALENDAR') return decide('ENTITY_EXTRACTION', 'STRUCTURED_SOURCE_FIELDS');
  if (positive.includes('KNOWN_PARTICIPANT')) return decide('ENTITY_EXTRACTION', 'PARTICIPANTS_ONLY');
  return decide('INDEX_ONLY', 'NO_NEW_CONTENT');
}

/** Tier 0 then Tier 1, with the route's cost budget attached. A defect in either
 * tier degrades to SOURCE_ONLY rather than failing its caller: evidence
 * durability never depends on classification (ADR 0016 §2, PRD §0 rule 5). */
export function triage(input: TriageInput): TriageResult {
  try {
    const tier0 = parseTier0(input);
    const { route, reason } = routeTier1(tier0, {
      userAuthored: input.actorRef.type === 'USER', assistantAuthored: input.actorRef.type === 'ASSISTANT',
    });
    return { tier0, route, reason, costBudgetMicrounits: ROUTE_COST_BUDGET_MICROUNITS[route] };
  } catch {
    // The fallback records what it can still vouch for and nothing else: no
    // participants, no text, no time. It must not depend on the same values that
    // just failed, or the degraded path would fail with them.
    const tier0 = tier0ParseSchema.parse({
      parserVersion: TIER0_PARSER_VERSION,
      sourceType: /^[A-Z][A-Z0-9_]{0,63}$/.test(input.sourceType) ? input.sourceType : 'UNKNOWN',
      externalId: input.externalId.slice(0, 512) || 'unknown',
      parentExternalId: null, threadExternalId: null, occurredAt: null,
      participants: [], subject: null, newText: '', quotedTextLength: 0, automated: false, structuredFields: {},
    });
    return {
      tier0, route: 'SOURCE_ONLY',
      reason: routingReasonSchema.parse({
        code: 'TIER1_ROUTER_UNAVAILABLE', routerVersion: TIER1_ROUTER_VERSION,
        positiveSignals: [], negativeSignals: [], newContentLength: 0,
      }),
      costBudgetMicrounits: 0,
    };
  }
}
