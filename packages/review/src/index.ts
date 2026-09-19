/** `@unai/review` -- proactive clarification and the weekly review (PRD §7.5,
 * §7.7, §19.3-§19.5, §37.4, §39; ADR 0029).
 *
 * Every function takes a transaction the caller opened inside the owner
 * boundary, as `@unai/memory` and `@unai/context` do. Nothing here opens a
 * connection, commits, audits, calls a model or reads memory other than through
 * a Context Broker packet the caller supplies: the inbox and the review are
 * product surfaces, and a product surface reads memory only through the broker.
 * Writing memory in answer to a card is the correction path's job, which the
 * API composes around these functions.
 */
export { ReviewTimeError, assertTimeZone, ownerLocalDate, startOfLocalDate, addLocalDays } from './time.js';
export { CARD_COMPOSER_VERSION, collectAmbiguities, composeCards, describeValue, describeContract,
  type CardDraft, type CardRisk, type RuleBasis, type Situation } from './ambiguities.js';
export { INTERRUPTION_POLICY_VERSION, decideInterruption, expectedValueOf, interruptionCostOf,
  type InterruptionState, type InterruptionOutcome } from './interruption.js';
export { readAttentionBudget, updateAttentionBudget } from './budgets.js';
export { RULES_VERSION, REPEATED_CONFIRMATIONS_FOR_PROPOSAL, LearnedRuleError, cardRuleSignature, ruleSignature,
  listLearnedRules, readLearnedRule, approveLearnedRule, revokeLearnedRule, approvedRuleFor, proposeRuleIfRepeated } from './rules.js';
export { INBOX_PURPOSE, InboxError, readSituations, evaluateInbox, readInbox, readCard, askingDecision, recordCardAnswer,
  type RuleApplication, type InboxEvaluation } from './inbox.js';
export { OBSERVATION_WINDOW_DAYS, OBSERVATION_REVIEW_AFTER_DAYS, MINIMUM_SUPPORTING_EPISODES, postponementEpisodes,
  postponementCounterexamples, repeatedPostponementObservation, type ObservationDraft } from './observations.js';
export { WEEKLY_REVIEW_VERSION, composeWeeklyReview, reviewManifestOf, ungroundedStatements, statementsOf,
  type ReviewWeek, type ComposedWeeklyReview } from './weekly.js';
export { WEEKLY_REVIEW_PURPOSE, WeeklyReviewError, recordWeeklyReview } from './weekly-store.js';

/** The purposes of the two settings surfaces this package serves. */
export const APPROVAL_RULES_PURPOSE = 'approval.rules';
export const ATTENTION_SETTINGS_PURPOSE = 'settings.attention';
