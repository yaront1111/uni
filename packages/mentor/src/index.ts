/** `@unai/mentor` -- goals and their retained priority history, the decision
 * rationale reconstruction and the mentor's goal-versus-calendar contradictions
 * (PRD §4.9, §7.4, §36.13, §37.7, §52; ADR 0029).
 *
 * Every function takes a transaction the caller opened inside the owner
 * boundary, as `@unai/review` does. Nothing here opens a connection, commits,
 * audits or calls a model, and canonical memory is read only through a Context
 * Broker packet the caller supplies: goals are product records, not beliefs,
 * and the mentor's evidence is what the broker returned.
 */
export { GOALS_READ_PURPOSE, GOALS_MANAGE_PURPOSE, GoalError, effectivePriorityOf, standingStatement, listGoals, readGoal,
  createGoal, changeGoalPriority } from './goals.js';
export { RATIONALE_COMPOSER_VERSION, WHY_QUESTION, composeDecisionRationale, type RationaleSources } from './rationale.js';
export { MENTOR_PURPOSE, MENTOR_COMPOSER_VERSION, MENTOR_OBSERVATION_DAYS, MENTOR_SHARE_THRESHOLD, MENTOR_MINIMUM_EVENTS,
  calendarEvents, composeContradictions, proactiveItemsToday, evaluateMentor, readMentorView, observationWindow,
  type CalendarEvent, type MentorDraft, type ComposedContradictions, type MentorEvaluation } from './mentor.js';
