import {
  decisionRationaleSchema,
  type CertaintyLabel, type ContextPacket, type DecisionRationale, type DecisionRationaleItem, type DecisionSource,
} from '@unai/domain';
import { classifyQuestion } from '@unai/context';

/**
 * Rationale reconstruction: "Why did I make this decision?" (PRD §52 exit
 * criterion "Uai can reconstruct why a decision was made"; ADR 0029 §5;
 * CRT-DEC-02-A).
 *
 * Pure: one Context Broker packet planned as `DECISION_RECONSTRUCTION`, the
 * decision it is about and the sources already read for its statements, in; the
 * sourced answer out. Every sentence is composed by code from a statement the
 * packet supplied about that decision, and every statement lists its sources.
 * Nothing is inferred and no model is called: when the decision records no
 * reason, the answer says exactly that.
 */

export const RATIONALE_COMPOSER_VERSION = 'decision-rationale-0.1.0';
export const WHY_QUESTION = 'Why did I make this decision?';

const KINDS: Readonly<Record<string, DecisionRationaleItem['kind']>> = Object.freeze({
  'shared.decision.question': 'QUESTION',
  'shared.decision.option': 'OPTION',
  'shared.decision.assumption': 'ASSUMPTION',
  'shared.decision.consequence': 'CONSEQUENCE',
  'shared.decision.recommendation': 'RECOMMENDATION',
  'shared.decision.choice': 'CHOICE',
  'shared.decision.rationale': 'RATIONALE',
  'shared.decision.expected_result': 'EXPECTED_RESULT',
});
const ORDER: readonly DecisionRationaleItem['kind'][] = ['QUESTION', 'CHOICE', 'RATIONALE', 'ASSUMPTION', 'OPTION',
  'RECOMMENDATION', 'CONSEQUENCE', 'EXPECTED_RESULT'];

function textOf(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'object' && value !== null) {
    const text = (value as Record<string, unknown>)['text'];
    if (typeof text === 'string' && text.trim()) return text.trim();
  }
  return null;
}

/** How sure the statement is, in the vocabulary every surface labels with. The
 * owner's own recorded words are REPORTED until a governed transaction accepts
 * them; a recommendation is never the owner's intent; a prediction stays one. */
function labelOf(modality: string, certainty: string | null): CertaintyLabel {
  if (certainty === 'CONTESTED') return 'CONFLICTING';
  if (modality === 'RECOMMENDED') return 'RECOMMENDED';
  if (modality === 'PREDICTED') return 'PREDICTED';
  if (modality === 'INTENDED') return 'INTENDED';
  return certainty === 'ACCEPTED' ? 'CONFIRMED' : 'REPORTED';
}

const quote = (text: string) => '"' + text + '"';

export interface RationaleSources {
  /** Per proposition: the anchored words it was stated in, and anything cited for it. */
  readonly byProposition: ReadonlyMap<string, readonly DecisionSource[]>;
}

export function composeDecisionRationale(packet: ContextPacket, input: {
  decisionFrameInstanceId: string; question?: string; sources: RationaleSources;
}): DecisionRationale {
  const question = (input.question ?? WHY_QUESTION).trim() || WHY_QUESTION;
  const classification = classifyQuestion(question);
  const statements = [
    ...packet.currentBeliefs.map(belief => ({ ...belief, certainty: belief.certainty as string | null })),
    ...packet.futureClaims.map(claim => ({ ...claim, certainty: null as string | null })),
  ].filter(item => item.frameInstanceId === input.decisionFrameInstanceId && KINDS[item.predicateId] !== undefined);

  const items: DecisionRationaleItem[] = [];
  for (const statement of statements) {
    const text = textOf(statement.normalizedValue);
    if (text === null) continue;
    // A stated-in source is kept only when the packet itself supplied that
    // evidence for the statement: the answer never cites more than it was given.
    const supplied = new Set(statement.evidenceIds ?? []);
    const sources = (input.sources.byProposition.get(statement.propositionId) ?? [])
      .filter(source => source.relation === 'CITED' || supplied.has(source.evidenceId));
    items.push({ kind: KINDS[statement.predicateId]!, propositionId: statement.propositionId, text,
      label: labelOf(statement.modality, statement.certainty), sources: sources.slice(0, 32) });
  }
  items.sort((left, right) => ORDER.indexOf(left.kind) - ORDER.indexOf(right.kind)
    || left.propositionId.localeCompare(right.propositionId));

  const first = (kind: DecisionRationaleItem['kind']) => items.find(item => item.kind === kind) ?? null;
  const all = (kind: DecisionRationaleItem['kind']) => items.filter(item => item.kind === kind);
  const decided = first('QUESTION'), choice = first('CHOICE'), rationale = first('RATIONALE');
  const assumptions = all('ASSUMPTION');
  const sentences: string[] = [];
  if (choice && decided) sentences.push('You chose ' + quote(choice.text) + ' for ' + quote(decided.text) + '.');
  else if (decided) sentences.push('For ' + quote(decided.text) + ' no choice is recorded yet.');
  if (rationale) sentences.push('Your recorded reason: ' + quote(rationale.text) + '.');
  if (assumptions.length > 0) {
    sentences.push('You assumed ' + assumptions.map(item => quote(item.text)).join('; ') + '.');
  }
  const recommendation = first('RECOMMENDATION');
  if (recommendation) sentences.push('The recommendation you had was ' + quote(recommendation.text) + '.');
  const reasonRecorded = rationale !== null || assumptions.length > 0;
  if (!reasonRecorded) sentences.push('No reason and no assumption were recorded for this decision, so why it was made cannot be reconstructed from memory.');
  if (!decided) sentences.push('This decision is not in the context read for the question.');
  const cited = assumptions.reduce((count, item) => count + item.sources.filter(source => source.relation === 'CITED').length, 0);
  if (cited > 0) sentences.push(cited + (cited === 1 ? ' source was' : ' sources were') + ' cited for the assumptions.');

  return decisionRationaleSchema.parse({
    question, answerType: classification.answerType, queryMode: classification.queryMode,
    answer: sentences.join(' ').slice(0, 4000), reasonRecorded, items: items.slice(0, 128),
    contextPacketId: packet.packetId, packetHash: packet.packetHash, composerVersion: RATIONALE_COMPOSER_VERSION,
  });
}
