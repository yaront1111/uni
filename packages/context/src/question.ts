import type { AnswerType, HistoricalMode, QuestionType } from '@unai/domain';

/**
 * The question classifier (PRD §8.2 step 1, §23.3; CRT-RD-12-A). ADR 0024 §5.
 *
 * An ordered list of word-boundary rules over the question text; the first rule
 * that matches decides, and its name is returned so the classification can be
 * audited. No model is involved: the same question is always the same type.
 *
 * The order is the contract. A question about a contradiction is a contradiction
 * check even when it asks "why"; one about how a prediction turned out is a
 * prediction review even when it names a plan; one that sums or counts is an
 * aggregation even when it names a past period; and the historical rules run
 * before the commitment rules, so a commitment question that names a past time
 * ("what was due as of March 1") is answered as of that time.
 */

export const QUESTION_CLASSIFIER_VERSION = 'question-classifier-0.2.0';

export interface QuestionClassification {
  readonly answerType: QuestionType;
  /** The §23.3 query mode the broker plans the packet under. */
  readonly queryMode: AnswerType;
  readonly historicalMode: HistoricalMode | null;
  readonly matchedRule: string;
  readonly classifierVersion: string;
}

interface Rule {
  readonly name: string;
  readonly answerType: QuestionType;
  readonly test: (text: string) => boolean;
  readonly queryMode: (text: string) => AnswerType;
}

const matches = (...patterns: RegExp[]) => (text: string) => patterns.some(pattern => pattern.test(text));

const DECISION = /\b(decision|decid(e|ed|ing)|chose|choose|chosen|choice)\b/;
const SCHEDULE = /\b(schedul\w*|calendar|upcoming|next (week|month|meeting|appointment)|appointment|plan(s|ned)?)\b/;

const RULES: readonly Rule[] = [
  { name: 'LIFE_CHANGES', answerType: 'EPISODE_RECALL',
    test: matches(/\bwhat (has |have )?changed\b/), queryMode: () => 'PATTERN_REVIEW' },
  { name: 'ASSISTANT_CAPABILITIES', answerType: 'FUTURE_COMMITMENT',
    test: matches(/\bwhat can you (handle|do|prepare)\b/), queryMode: () => 'OPEN_COMMITMENTS' },
  { name: 'FOCUS_PRIORITIES', answerType: 'FUTURE_COMMITMENT',
    test: matches(/\bwhat should i (focus on|prioriti[sz]e)\b/), queryMode: () => 'OPEN_COMMITMENTS' },
  {
    name: 'CONTRADICTION_TERMS', answerType: 'CONTRADICTION_CHECK',
    test: matches(/\b(contradict\w*|conflict\w*|disagree\w*|inconsisten\w*|at odds|clash\w*)\b/),
    queryMode: () => 'CONTRADICTION_DETECTION',
  },
  {
    name: 'PREDICTION_OUTCOME_TERMS', answerType: 'PREDICTION_REVIEW',
    test: matches(/\b(predict\w*|forecast\w*|came true|come true|turn(ed)? out|as expected|expected (result|outcome))\b/,
      /\bno (confirmed |recorded |known )?outcome\b/, /\b(plan|prediction|expectation)s? versus\b/),
    queryMode: () => 'PREDICTION_VERSUS_OUTCOME',
  },
  {
    name: 'CAUSAL_TERMS', answerType: 'CAUSAL_EXPLANATION',
    test: matches(/^why\b/, /\bwhy (did|do|does|was|is|am|are|were|have|has|had)\b/,
      /\bwhat (caused|led to|made me|was the reason)\b/, /\b(reason|reasons|rationale) (for|why|behind)\b/),
    queryMode: text => DECISION.test(text) ? 'DECISION_RECONSTRUCTION' : 'CAUSAL_EXPLANATION',
  },
  {
    name: 'AGGREGATION_TERMS', answerType: 'AGGREGATION',
    test: matches(/\b(total|in total|altogether|sum of|summed|average|how many|how often|repeatedly|per (day|week|month|year))\b/,
      /\bhow much\b.*\b(spen[dt]|spending|earn\w*|paid|pay|cost)\b/),
    queryMode: () => 'AGGREGATION',
  },
  {
    name: 'HISTORICAL_BELIEF_TERMS', answerType: 'HISTORICAL_STATE',
    test: matches(/\bwhat did (uai|you) (believe|think|know)\b/, /\b(uai|you) (believed|thought|knew)\b/),
    queryMode: () => 'HISTORICAL_BELIEF_STATE',
  },
  {
    name: 'HISTORICAL_STATE_TERMS', answerType: 'HISTORICAL_STATE',
    test: matches(/\b(at that time|at the time|back then|used to|was true|were true|as of|historically)\b/,
      /\b(on|in|during) (january|february|march|april|may|june|july|august|september|october|november|december)\b/,
      /\bin (19|20)\d\d\b/),
    queryMode: () => 'CORRECTED_HISTORICAL_VALUE',
  },
  {
    name: 'COMMITMENT_TERMS', answerType: 'FUTURE_COMMITMENT',
    test: matches(/\b(promis\w*|commit\w*|agreed to|supposed to|have to|need to|due|deadlines?|coming up|forgetting|forgot|to-?do)\b/,
      SCHEDULE, /\bwill i\b/),
    queryMode: text => SCHEDULE.test(text) ? 'FUTURE_PLANS' : 'OPEN_COMMITMENTS',
  },
  {
    name: 'EPISODE_TERMS', answerType: 'EPISODE_RECALL',
    test: matches(/\b(what happened|remember when|do you remember|recall|last time|that time)\b/,
      /\bwhen did\b/, /\bwhat did \w+ say\b/, /\btell me about (the|that|our)\b/),
    queryMode: () => 'EPISODE_RECALL',
  },
];

/**
 * Classify one question into the eight answer types of PRD §8.2.
 *
 * A question no rule recognizes is a current-state question: "what is", "do I
 * still", "how much do I owe" all ask what is true now, which is also the mode
 * whose answer is safest to give -- the deterministic selector's.
 */
export function classifyQuestion(question: string): QuestionClassification {
  const text = question.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  for (const rule of RULES) {
    if (!rule.test(text)) continue;
    const queryMode = rule.queryMode(text);
    return Object.freeze({
      answerType: rule.answerType, queryMode,
      historicalMode: queryMode === 'HISTORICAL_BELIEF_STATE' ? 'HISTORICAL_BELIEF_STATE' as const
        : queryMode === 'CORRECTED_HISTORICAL_VALUE' ? 'CORRECTED_HISTORICAL_STATE' as const : null,
      matchedRule: rule.name, classifierVersion: QUESTION_CLASSIFIER_VERSION,
    });
  }
  return Object.freeze({
    answerType: 'CURRENT_STATE' as const, queryMode: 'CURRENT_VALUE' as const, historicalMode: null,
    matchedRule: 'DEFAULT_CURRENT_STATE', classifierVersion: QUESTION_CLASSIFIER_VERSION,
  });
}
