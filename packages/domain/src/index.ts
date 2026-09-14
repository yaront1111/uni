import { z } from 'zod';

export const requestContextSchema = z.strictObject({
  actorId: z.uuid(),
  ownerScopeId: z.uuid(),
  purpose: z.string().regex(/^[a-z][a-z0-9_.:-]{0,63}$/),
  correlationId: z.uuid(),
});
export type RequestContext = Readonly<z.infer<typeof requestContextSchema>>;

export const auditEventSchema = z.strictObject({
  policyDecision: z.enum(['ALLOW','DENY']),
  codeVersion: z.string().regex(/^[a-zA-Z0-9_.:@/-]{1,120}$/),
  result: z.enum(['SUCCESS','FAILURE','REFUSED']),
  objects: z.array(z.strictObject({
    type: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    id: z.uuid(),
    fields: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)).max(64),
  })).max(100),
});
export type AuditEvent = Readonly<z.infer<typeof auditEventSchema>>;

