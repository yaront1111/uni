import { z } from 'zod';
import { dataPurposeSchema, sensitivitySchema } from './evidence.js';

export const initiativeSettingsInputSchema = z.strictObject({
  enabled:z.boolean(),timeZone:z.string().min(1).max(64),localTime:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  dataPurpose:dataPurposeSchema,maximumSensitivity:sensitivitySchema,prepareDrafts:z.boolean(),
});
export const initiativeSettingsSchema = initiativeSettingsInputSchema.extend({nextDueAt:z.iso.datetime().nullable(),revision:z.number().int().nonnegative()});
export type InitiativeSettings = z.infer<typeof initiativeSettingsSchema>;
export const initiativeWatchInputSchema = z.strictObject({scheduledFrameId:z.uuid(),prerequisiteFrameId:z.uuid(),requestText:z.string().trim().min(1).max(2000)})
  .refine(input=>input.scheduledFrameId!==input.prerequisiteFrameId);
export const initiativeWatchPatchSchema = z.strictObject({enabled:z.boolean().optional(),snoozedUntil:z.iso.datetime().nullable().optional()})
  .refine(input=>Object.keys(input).length>0);
export const initiativeWatchSchema = z.strictObject({watchId:z.uuid(),sourceEvidenceId:z.uuid(),scheduledFrameId:z.uuid(),prerequisiteFrameId:z.uuid(),
  enabled:z.boolean(),snoozedUntil:z.iso.datetime().nullable(),createdAt:z.iso.datetime()});
export type InitiativeWatch = z.infer<typeof initiativeWatchSchema>;
export const initiativeNoticeSchema = z.strictObject({noticeId:z.uuid(),watchId:z.uuid(),threshold:z.enum(['UPCOMING','IMMINENT','OVERDUE']),
  message:z.literal('A scheduled item is approaching or overdue, and its linked prerequisite remains unresolved.'),
  sourceEvidenceIds:z.array(z.uuid()).min(1).max(200),draftId:z.uuid().nullable(),
  preparation:z.enum(['NOT_REQUESTED','CAPABILITY_NOT_GRANTED','CONFIRMATION_REQUIRED','POLICY_DENIED','DRAFTED']),
  ownerLocalDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),createdAt:z.iso.datetime()});
