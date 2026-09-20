import { z } from 'zod';
import { dataPurposeSchema, sensitivitySchema } from './evidence.js';
import { answerTypeSchema, knowledgeTimeSchema, lifeCategorySchema, worldTimeSchema } from './context.js';
import { certaintyLabelSchema } from './labels.js';
import { groundingResultSchema } from './answers.js';

export { certaintyLabelSchema, type CertaintyLabel } from './labels.js';

/** Question answering (PRD §7.2, §8.2, §24.5; design POST /v1/ask).
 *
 * Schemas only. `@unai/context` classifies the question, asks the Context Broker
 * for a packet and composes the answer; this file only says what the request and
 * the answer look like.
 */

const reasonCode = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);
const version = z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/);
const registryId = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);

/** PRD §8.2 step 1: the eight answer types a question is classified into. They are
 * coarser than the thirteen query modes of §23.3 the broker plans under; each one
 * maps onto a mode, and the answer reports both. */
export const questionTypeSchema = z.enum(['CURRENT_STATE', 'HISTORICAL_STATE', 'EPISODE_RECALL', 'CAUSAL_EXPLANATION',
  'FUTURE_COMMITMENT', 'PREDICTION_REVIEW', 'AGGREGATION', 'CONTRADICTION_CHECK']);
export type QuestionType = z.infer<typeof questionTypeSchema>;

/** PRD §12.3: which of the two historical questions was asked. */
export const historicalModeSchema = z.enum(['CORRECTED_HISTORICAL_STATE', 'HISTORICAL_BELIEF_STATE']);
export type HistoricalMode = z.infer<typeof historicalModeSchema>;

/** The declarations an Ask request must carry. As with a context request, none of
 * them has a default: a default would answer a question the caller never asked. */
export const REQUIRED_ASK_FIELDS = Object.freeze([
  'ownerScopeId', 'question', 'purpose', 'worldTime', 'knowledgeTime', 'maximumSensitivity',
] as const);
export type RequiredAskField = (typeof REQUIRED_ASK_FIELDS)[number];

export const askRequestSchema = z.strictObject({
  ownerScopeId: z.uuid(),
  question: z.string().trim().min(1).max(2000),
  /** The data purpose the answer is for. The evidence's allowed purposes decide
   * whether it may be read at all (CRT-SEC-02-A). */
  purpose: dataPurposeSchema,
  worldTime: worldTimeSchema,
  knowledgeTime: knowledgeTimeSchema,
  maximumSensitivity: sensitivitySchema,
  entityHints: z.array(z.uuid()).max(64).default([]),
  worldlineHints: z.array(z.uuid()).max(64).default([]),
  discourseAnchors: z.array(z.string().min(1).max(512)).max(32).default([]),
  frameTypeHints: z.array(registryId).max(32).default([]),
  lifeCategory: lifeCategorySchema.nullable().default(null),
  timeWindow: z.strictObject({
    from: z.iso.datetime({ offset: true }).nullable().default(null),
    to: z.iso.datetime({ offset: true }).nullable().default(null),
  }).nullable().default(null),
  sourceTypes: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/)).max(32).default([]),
});
export type AskRequest = z.infer<typeof askRequestSchema>;

/** A link from an answer to the evidence it rests on (PRD §8.2 step 5). The href
 * is the evidence route, never an object-store key. */
export const askSourceLinkSchema = z.strictObject({
  evidenceId: z.uuid(),
  sourceType: z.string().max(64),
  occurredAt: z.iso.datetime().nullable(),
  anchorIds: z.array(z.uuid()).max(64),
  href: z.string().regex(/^\/v1\/evidence\/[0-9a-f-]{36}$/),
});
export type AskSourceLink = z.infer<typeof askSourceLinkSchema>;

export const askStatementKindSchema = z.enum(['SELECTED_STATE', 'CONTESTED_STATE', 'NO_CURRENT_VALUE',
  'HISTORICAL_VALUE', 'FUTURE_CLAIM', 'RESOLUTION', 'CONFLICT', 'NO_CONFLICT_FOUND', 'SEMANTIC_RECALL',
  'AGGREGATE_COUNT', 'OWNER_ASSERTION_PENDING', 'WITHHELD', 'NOTHING_FOUND', 'HISTORICAL_INSTANT_MISSING',
  'RECORDED_CHANGE', 'CAPABILITY_SUMMARY', 'FOCUS_SUMMARY', 'MEMORY_INCOMPLETE',
  // A statement phrased by a model. Its kind is not the composer's to know; the
  // grounding validator has checked its label, objects and citations instead.
  'MODEL_PHRASED',
  // The only statement of an answer the grounding validator blocked.
  'GROUNDING_BLOCKED']);

export const askStatementSchema = z.strictObject({
  statementId: z.string().regex(/^S[0-9]{1,4}$/),
  kind: askStatementKindSchema,
  label: certaintyLabelSchema,
  text: z.string().min(1).max(2000),
  /** The packet objects the statement rests on. A statement naming none is a
   * statement about the absence of memory, and says so. */
  objectRefs: z.array(z.strictObject({
    objectType: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    objectId: z.uuid(),
  })).max(64),
  /** Evidence ids, each of them present in the answer's `sourceLinks`. */
  sourceEvidenceIds: z.array(z.uuid()).max(64),
  /** Where the Why? panel reads the belief behind the statement, when it has one. */
  explainPath: z.string().regex(/^\/v1\/memory\/propositions\/[0-9a-f-]{36}\/explain$/).nullable(),
});
export type AskStatement = z.infer<typeof askStatementSchema>;

export const askAnswerSchema = z.strictObject({
  question: z.string(),
  answerType: questionTypeSchema,
  /** The broker query mode the question was planned under (PRD §23.3). */
  queryMode: answerTypeSchema,
  historicalMode: historicalModeSchema.nullable(),
  classification: z.strictObject({ matchedRule: reasonCode, classifierVersion: version }),
  worldTime: z.iso.datetime(),
  knowledgeTime: z.iso.datetime(),
  statements: z.array(askStatementSchema).min(1).max(200),
  sourceLinks: z.array(askSourceLinkSchema).max(500),
  /** True when nothing in the answer is settled enough to assert: every statement
   * is unknown, contested or withheld, and the answer declines to assert. */
  declinesToAssert: z.boolean(),
  packetId: z.uuid(),
  packetHash: z.string().regex(/^[a-f0-9]{64}$/),
  selectionsDigest: z.string().regex(/^[a-f0-9]{64}$/),
  /** Who phrased the presented statements. With no phrasing model configured, or
   * when the grounding validator regenerated a model's candidate, the answer is
   * composed from the packet by code, so the same memory and the same question
   * give the same statements. `modelCalled` says whether a model was supplied the
   * packet at all, which the manifest then records. */
  composer: z.strictObject({
    kind: z.enum(['DETERMINISTIC_COMPOSER', 'MODEL_PHRASED']),
    version,
    modelCalled: z.boolean(),
    modelId: z.string().min(1).max(128).nullable(),
    promptVersion: version.nullable(),
  }),
  /** The grounding validator's verdict over what is presented (PRD §24.6). */
  grounding: groundingResultSchema,
  /** The manifest of the context supplied for this answer. Null only when the
   * answer was composed without being recorded (a library caller); the route
   * always records one (FR-065). */
  answerManifestId: z.uuid().nullable(),
  conversationId: z.uuid().optional(),
  turnId: z.uuid().optional(),
});
export type AskAnswer = z.infer<typeof askAnswerSchema>;
