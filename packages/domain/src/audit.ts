import { z } from 'zod';

/**
 * The audit trail (design entity `audit_events`, route `GET /v1/audit-events`,
 * screen "Audit log"; PRD §30.6, CRT-SEC-07-A).
 *
 * Every material read, write, projection rebuild, export, deletion and external
 * action appends one event. The kind is part of the row (migration 0027), so the
 * Audit log can be filtered by it and a test can prove that each of the five
 * operations the criterion names really left its own kind behind.
 */
export const AUDIT_EVENT_KINDS = ['READ', 'WRITE', 'PROJECTION_REBUILD', 'EXPORT', 'DELETION', 'EXTERNAL_ACTION'] as const;
export const auditEventKindSchema = z.enum(AUDIT_EVENT_KINDS);
export type AuditEventKind = z.infer<typeof auditEventKindSchema>;

/** Purposes whose every transaction reads, whatever HTTP method carried it: the
 * Context Broker, Ask and the inspection reads answer a POST without changing
 * memory, and their audit event says so. */
export const AUDIT_READ_PURPOSES: ReadonlySet<string> = new Set(['memory.read', 'memory.inspect', 'evidence.read',
  'connector.read', 'projection.read', 'permissions.read', 'goals.read', 'decisions.read', 'action.read', 'review.weekly',
  'mentor.advise', 'device.list', 'audit.read']);

/**
 * The kind a purpose records. Four purposes name their kind outright -- a
 * rebuild, an export, a deletion and an external action can run under no other
 * purpose -- and the rest read or write. With the HTTP method known, a GET is a
 * read; without it (a SQL function, the CLI), the purpose alone decides.
 *
 * `unai_private.audit_event_kind` (migration 0027) is the same rule without the
 * method, for rows a definer function appends; `packages/api/src/audit.test.ts`
 * asserts that the two agree on every purpose the platform admits.
 */
export function auditEventKindFor(purpose: string, method?: string): AuditEventKind {
  if (purpose === 'memory.project') return 'PROJECTION_REBUILD';
  if (purpose === 'data.export') return 'EXPORT';
  if (purpose === 'data.delete') return 'DELETION';
  if (purpose === 'action.execute') return 'EXTERNAL_ACTION';
  if (method === 'GET' || method === 'HEAD') return 'READ';
  return AUDIT_READ_PURPOSES.has(purpose) || /^ops\.[a-z_.]+\.read$/.test(purpose) ? 'READ' : 'WRITE';
}

const UUID = z.uuid();
const IDENTIFIER = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);

export const auditObjectSchema = z.strictObject({
  type: IDENTIFIER,
  id: UUID,
  fields: z.array(IDENTIFIER).max(64),
});

/** One audit event as the Audit log shows it. Identifiers, field names and
 * versions only: no row of this table has ever held payload content. */
export const publicAuditEventSchema = z.strictObject({
  auditEventId: UUID,
  ownerScopeId: UUID,
  actorId: UUID,
  purpose: z.string().regex(/^[a-z][a-z0-9_.:-]{0,63}$/),
  eventKind: auditEventKindSchema,
  objects: z.array(auditObjectSchema).max(100),
  policyDecision: z.enum(['ALLOW', 'DENY']),
  policyDecisionId: UUID.nullable(),
  codeVersion: z.string().min(1).max(120),
  result: z.enum(['SUCCESS', 'FAILURE', 'REFUSED']),
  correlationId: UUID,
  createdAt: z.iso.datetime(),
});
export type PublicAuditEvent = z.infer<typeof publicAuditEventSchema>;

export const AUDIT_LOG_MAX_LIMIT = 200;

/** The filters `GET /v1/audit-events` accepts: an object, an actor, a purpose, a
 * kind and a time window. An object filter names both its type and its id. */
export const auditLogQuerySchema = z.strictObject({
  objectType: IDENTIFIER.optional(),
  objectId: UUID.optional(),
  actorId: UUID.optional(),
  purpose: z.string().regex(/^[a-z][a-z0-9_.:-]{0,63}$/).optional(),
  eventKind: auditEventKindSchema.optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  /** The `createdAt|auditEventId` of the last event of the previous page. */
  before: z.string().regex(/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z\|[0-9a-f-]{36}$/i).optional(),
  limit: z.coerce.number().int().min(1).max(AUDIT_LOG_MAX_LIMIT).optional(),
}).refine(query => (query.objectType === undefined) === (query.objectId === undefined), { message: 'AUDIT_OBJECT_FILTER_INCOMPLETE' });
export type AuditLogQuery = z.infer<typeof auditLogQuerySchema>;

export const auditLogSchema = z.strictObject({
  events: z.array(publicAuditEventSchema).max(AUDIT_LOG_MAX_LIMIT),
  filters: z.strictObject({
    objectType: IDENTIFIER.nullable(), objectId: UUID.nullable(), actorId: UUID.nullable(),
    purpose: z.string().nullable(), eventKind: auditEventKindSchema.nullable(),
    from: z.iso.datetime().nullable(), to: z.iso.datetime().nullable(),
  }),
  nextCursor: z.string().nullable(),
  /** The log offers no update and no delete: an attempt is refused and is itself
   * appended as a refused event. */
  appendOnly: z.literal(true),
  /** An event keeps identifiers and field names, never the content they named,
   * so an event about since-deleted content retains nothing prohibited. */
  retainsPayload: z.literal(false),
});
export type AuditLog = z.infer<typeof auditLogSchema>;
