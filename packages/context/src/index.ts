/** `@unai/context` -- the Context Broker, the belief explanation and the memory
 * thread service (PRD §23, §35.7, §35.8, §36.11, §50).
 *
 * This package is the only memory read path for models and plugins (FR-060).
 * Everything it does is a read: its route purpose `memory.read` appears in no
 * INSERT, UPDATE or DELETE policy on any canonical table, and the one row it
 * writes is the `context_packets` record of what it answered.
 *
 * Every function takes a transaction the caller opened inside the owner boundary,
 * exactly as `@unai/memory`, `@unai/belief` and `@unai/capabilities` do. Nothing
 * here opens a connection, commits, audits, calls a model or reaches the network.
 */
export { CATEGORY_CATALOG_VERSION, CATEGORY_RULES, LIFE_CATEGORIES, deriveLifeCategories, categoryOfPurpose,
  inCategoryView } from './categories.js';
export { readProjectionFragments, type ContextProjectionFragment } from './fragments.js';
export { BROKER_VERSION, SELECTOR_VERSION, CONTEXT_READ_PURPOSE, CONTEXT_ACTION_PURPOSE, MEMORY_INSPECT_PURPOSE,
  MEMORY_THREAD_PURPOSE,
  ContextBrokerError, missingContextFields, classifyAnswerType, authorizeContextRead, readContextPacket,
  assembleContextPacket,
  type ContextAuthorization, type ContextBrokerOptions, type ContextRunner, type EvidenceLabel } from './broker.js';
export { EXPLANATION_VERSION, explainProposition } from './explain.js';
export { INSPECTOR_VERSION, inspectMemory, readRelatedFrames } from './inspector.js';
export { THREAD_SERVICE_VERSION, MemoryThreadError, createMemoryThread, addThreadMember, listThreadsForObject,
  readMemoryThread } from './threads.js';
export { SELECTION_VERSION, modalitiesForAnswerType, selectSlotState, selectCurrentStates, selectionsDigest,
  type SelectorSlot, type SelectorProposition, type SelectorAssessment, type SelectorClaim, type SelectorRelation,
  type SelectorOverlayDelta, type SlotSelectionInput, type SelectionParameters } from './selector.js';
export { QUESTION_CLASSIFIER_VERSION, classifyQuestion, type QuestionClassification } from './question.js';
export { ASK_COMPOSER_VERSION, MAX_PHRASING_ATTEMPTS, DETERMINISTIC_COMPOSER_PROVIDER, DETERMINISTIC_PROMPT_VERSION,
  GROUNDING_BLOCKED_TEXT, missingAskFields, composeStatements, answerQuestion,
  type AskOptions, type AnswerPhraser, type AnswerPhrasingRequest, type AnswerRecorder, type AnswerRecording,
  type ModelCandidateRecord } from './ask.js';
export { GROUNDING_VALIDATOR_VERSION, ASSISTANT_CONVERSATION_SOURCE_TYPE, indexPacket, validateGrounding,
  type ValidatableStatement, type GroundingValidation, type PacketIndex } from './grounding.js';
export { RANKING_VERSION, IMMINENT_HOURS, PAST_TARGET_DAYS, REPEAT_SUPPRESSION_DAYS, MAX_ITEMS_PER_SECTION,
  MAX_ITEMS_SHOWN, MAX_RECOMMENDATIONS, RANK_WEIGHTS, GOAL_RELEVANCE_WITHOUT_GOALS, BriefingTimeError, assertTimeZone,
  ownerLocalDate, utcOffset, formatLocal, dayDifference, shiftLocalDate, headlineOf, rankComponentsOf, scoreOf,
  priorityOf, materialFingerprintOf, isCurrentOrImminent, rankBriefing,
  type BriefingCandidate, type ShownBefore, type RankedItem, type RankedBriefing } from './ranking.js';
export { TODAY_FRAME_TYPES, PENDING_ASSERTION_DAYS, frameLabel, buildTodayBriefing,
  type TodayInput, type TodayOptions } from './today.js';
export { WHY_PANEL_VERSION, readWhySources } from './why.js';
export { MANIFEST_VERSION, ANSWER_RECORD_PURPOSE, suppliedContextOf, readPersistedPacket, recordAnswerManifest,
  readAnswerManifest, listReconsiderationCandidates, type RecordAnswerManifestInput } from './manifests.js';
