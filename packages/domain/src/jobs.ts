import {z} from 'zod';

export const jobStatusSchema=z.enum(['PENDING','RUNNING','SUCCEEDED','FAILED','DEAD_LETTER']);
export type JobStatus=z.infer<typeof jobStatusSchema>;
export const jobKindSchema=z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/);
export const workerIdSchema=z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/);
/** Stable code only: provider and database error text can carry private values. */
export const jobErrorCodeSchema=z.string().regex(/^[A-Z][A-Z0-9_:.-]{0,199}$/);

export const enqueueJobSchema=z.strictObject({
  jobKind:jobKindSchema,
  payload:z.record(z.string(),z.json()).default({}),
  idempotencyKey:z.string().regex(/^[a-zA-Z0-9_-]{16,128}$/),
  maxAttempts:z.int().min(1).max(10).default(3),
});
export type EnqueueJob=z.input<typeof enqueueJobSchema>;

/** Operations DTO: lease state and attempts without the job payload, which may
 * hold owner content that the jobs console never needs. */
export const publicJobSchema=z.strictObject({
  jobId:z.uuid(),ownerScopeId:z.uuid(),jobKind:jobKindSchema,status:jobStatusSchema,
  attemptCount:z.int().min(0),maxAttempts:z.int().min(1),
  leaseOwner:workerIdSchema.nullable(),leaseExpiresAt:z.iso.datetime().nullable(),
  lastError:jobErrorCodeSchema.nullable(),createdAt:z.iso.datetime(),updatedAt:z.iso.datetime(),
});
export type PublicJob=z.infer<typeof publicJobSchema>;

export const claimedJobSchema=publicJobSchema.extend({payload:z.record(z.string(),z.json())});
export type ClaimedJob=z.infer<typeof claimedJobSchema>;

export const queueDepthSchema=z.strictObject({
  PENDING:z.int().min(0),RUNNING:z.int().min(0),SUCCEEDED:z.int().min(0),
  FAILED:z.int().min(0),DEAD_LETTER:z.int().min(0),expiredLeases:z.int().min(0),
});
export type QueueDepth=z.infer<typeof queueDepthSchema>;
export const jobsViewSchema=z.strictObject({queueDepth:queueDepthSchema,jobs:z.array(publicJobSchema)});
export type JobsView=z.infer<typeof jobsViewSchema>;
export const deadLetterViewSchema=z.strictObject({jobs:z.array(publicJobSchema)});
export const retryResultSchema=z.strictObject({retried:z.literal(true),job:publicJobSchema});
