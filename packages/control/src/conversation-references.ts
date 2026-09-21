import type { ConversationTurn, ReferenceQuery } from '@unai/domain';

export interface ConversationReference {
  question: string;
  status: 'standalone' | 'resolved' | 'unresolved';
}

// Deliberately bounded grammar. Unrecognized/ambiguous references stay unresolved;
// arbitrary transcript prose is never appended to an engine question or prompt.
const WEEK_FOLLOWUP = /^(?:and|what about) (this|next|last) week\??$/i;
const WEEK = /\b(?:this|next|last) week\b/i;
const PRONOUN = /\b(?:him|her|them)\b/i;
const NAME = String.raw`\p{Lu}[\p{Ll}\p{M}]+(?:[-']\p{Lu}?[\p{Ll}\p{M}]+)*(?: \p{Lu}[\p{Ll}\p{M}]+){0,3}`;
const OWED_NAME = new RegExp(String.raw`\bowe (${NAME})(?![\p{L}\p{M}])`, 'gu');

function owedName(text: string): string | null {
  const matches = [...text.matchAll(OWED_NAME)];
  // A coordinated subject is ambiguous even if only its first name matched.
  if (matches.some(match => /^\s+(?:and|or)\b/i.test(text.slice(match.index! + match[0].length)))) return null;
  const names = [...new Set(matches.map(match => match[1]!))];
  return names.length === 1 ? names[0]! : null;
}

function resolve(question: string, ownerQuestion: string | null, mention: string | null): ConversationReference {
  const week = WEEK_FOLLOWUP.exec(question);
  if (week) {
    // Carry only a complete owner question with one referent and an explicit
    // period. An assistant cannot establish either the obligation or its period.
    if (ownerQuestion && /^(?:what|how much|do)\b/i.test(ownerQuestion) && owedName(ownerQuestion) && WEEK.test(ownerQuestion)) {
      return { question: ownerQuestion.replace(WEEK, week[1]!.toLowerCase() + ' week'), status: 'resolved' };
    }
    return { question, status: 'unresolved' };
  }
  if (PRONOUN.test(question)) {
    // A name is a search referent, never an assertion that anything about it is true.
    return mention ? { question: question.replace(new RegExp(PRONOUN.source, 'gi'), mention), status: 'resolved' }
      : { question, status: 'unresolved' };
  }
  return { question, status: 'standalone' };
}

/** Input must be the authorized, stored-order transcript of one conversation.
 * Output has no source ids, claims, assertions, confidence, or provenance. */
export function resolveConversationReference(question: string, turns: readonly ConversationTurn[]): ConversationReference {
  let ownerQuestion: string | null = null;
  let mention: string | null = null;
  let ownerMention: string | null = null;
  for (const turn of turns) {
    if (turn.status !== 'accepted' || turn.text === null) continue;
    if (turn.speaker === 'owner') {
      const resolved = resolve(turn.text, ownerQuestion, ownerMention);
      ownerQuestion = resolved.status === 'unresolved' ? null : resolved.question;
      ownerMention = ownerQuestion ? owedName(ownerQuestion) : null;
      mention = ownerMention;
    } else if (!ownerMention && [...turn.text.matchAll(OWED_NAME)].length > 0) {
      mention = owedName(turn.text);
    }
  }
  return resolve(question, ownerQuestion, mention);
}

/** Only grammatical identity and the owner's requested week cross this boundary.
 * No assistant amount, date, certainty or assertion is transmitted. */
export function conversationReferenceQuery(reference: ConversationReference, at: Date): ReferenceQuery | undefined {
  if (reference.status === 'unresolved') return { kind: 'UNRESOLVED' };
  const name = owedName(reference.question);
  if (!name || !/^(?:what|how much|do)\b/i.test(reference.question)) return undefined;
  const week = WEEK.exec(reference.question)?.[0].toLowerCase();
  if (!week) return reference.status === 'resolved'
    ? { kind: 'OBLIGATION', creditor: { canonicalLabel: name } } : undefined;
  const day = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
  const from = day - ((at.getUTCDay() + 6) % 7) * 86400000
    + (week === 'next week' ? 7 : week === 'last week' ? -7 : 0) * 86400000;
  return { kind: 'OBLIGATION', creditor: { canonicalLabel: name },
    due: { from: new Date(from).toISOString(), to: new Date(from + 7 * 86400000).toISOString() } };
}
