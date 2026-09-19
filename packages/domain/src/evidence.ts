import {z} from 'zod';
import {parsedSourceAnchorSchema} from './sources.js';
import {publicTriageSchema} from './extraction.js';

export const dataPurposeSchema=z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);
export const sensitivitySchema=z.enum(['NORMAL','PRIVATE','RESTRICTED']);
export const evidenceInputSchema=z.strictObject({
  ownerScopeId:z.uuid(),connectorId:z.uuid().nullable().default(null),
  sourceType:z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),externalId:z.string().min(1).max(512),
  parentExternalId:z.string().min(1).max(512).nullable().default(null),
  actorRef:z.strictObject({type:z.enum(['USER','ASSISTANT','EXTERNAL']),id:z.string().min(1).max(512)}),
  occurredAt:z.iso.datetime({offset:true}).nullable(),
  content:z.record(z.string(),z.json()),deterministicMetadata:z.record(z.string(),z.json()).default({}),
  sensitivity:sensitivitySchema,allowedPurposes:z.array(dataPurposeSchema).min(1).max(32),
  idempotencyKey:z.string().regex(/^[a-zA-Z0-9_-]{16,128}$/),
});
export type EvidenceInput=z.infer<typeof evidenceInputSchema>;
export const publicEvidenceSchema=z.strictObject({
  evidenceId:z.uuid(),ownerScopeId:z.uuid(),connectorId:z.uuid().nullable(),sourceType:z.string(),externalId:z.string(),
  parentExternalId:z.string().nullable(),actorRef:evidenceInputSchema.shape.actorRef,
  occurredAt:z.iso.datetime().nullable(),observedAt:z.iso.datetime(),rawObjectRef:z.uuid(),
  contentHash:z.string().regex(/^[a-f0-9]{64}$/),sensitivity:sensitivitySchema,
  allowedPurposes:z.array(dataPurposeSchema),ingestionVersion:z.literal('evidence-json-v1'),
  deterministicMetadata:z.record(z.string(),z.json()),ingestionStatus:z.literal('STORED'),
  // The deterministic anchors this item carries. Present on a single-item read;
  // omitted from list responses, which return metadata only.
  anchors:z.array(parsedSourceAnchorSchema).optional(),
  // The Tier-1 route and its reason, once triage has decided one. Null rather
  // than absent when the item has no triage row: evidence must stay readable
  // when later processing has not run or has failed (PRD §11.1, §35.1).
  triage:publicTriageSchema.nullable().optional(),
  processing:z.strictObject({
    status:z.enum(['PENDING','EXTRACTED','CANONICALIZED','GOVERNED','SUCCEEDED','NEEDS_REVIEW']),
    unresolvedClaims:z.number().int().nonnegative(),
    lastError:z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).nullable(),
    completedAt:z.iso.datetime().nullable(),
  }).nullable().optional(),
});
export type PublicEvidence=z.infer<typeof publicEvidenceSchema>;
