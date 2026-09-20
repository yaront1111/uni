import { z } from 'zod';

/** Persisted transcripts are owner application data, never evidence or memory. */
export const conversationTitleSchema = z.string().trim().min(1).max(200);
export const persistedConversationSchema = z.strictObject({
  id: z.uuid(), ownerScopeId: z.uuid(), title: conversationTitleSchema,
  createdAt: z.iso.datetime({ offset: true }), lastActivityAt: z.iso.datetime({ offset: true }),
});
export type Conversation = z.infer<typeof persistedConversationSchema>;
export const conversationTurnStatusSchema = z.enum(['pending', 'accepted', 'unable', 'refused', 'failed']);
export const conversationTurnContentSchema = z.strictObject({
  text: z.string().min(1).max(400199).refine(text => text.trim().length > 0).nullable(), status: conversationTurnStatusSchema,
}).refine(t => t.status === 'accepted' ? t.text !== null : t.text === null, { message: 'CONVERSATION_TEXT_STATUS_INVALID' });
export const appendConversationTurnSchema = conversationTurnContentSchema.safeExtend({ speaker: z.enum(['owner', 'assistant']) })
  .refine(t => t.speaker !== 'owner' || t.status === 'accepted', { message: 'OWNER_TURN_MUST_BE_ACCEPTED' });
export const conversationTurnSchema = appendConversationTurnSchema.safeExtend({
  id: z.uuid(), conversationId: z.uuid(), ownerScopeId: z.uuid(), storedOrder: z.number().int().nonnegative(),
  createdAt: z.iso.datetime({ offset: true }),
  answerManifestId: z.uuid().nullable().optional(),
});
export type ConversationTurn = z.infer<typeof conversationTurnSchema>;
export type AppendConversationTurn = z.infer<typeof appendConversationTurnSchema>;
export type ConversationTurnContent = z.infer<typeof conversationTurnContentSchema>;
export const conversationDeletionSchema = z.strictObject({
  conversationId: z.uuid(), turnId: z.uuid().nullable(), conversations: z.number().int().nonnegative(),
  conversationTurns: z.number().int().nonnegative(),
});
export type ConversationDeletion = z.infer<typeof conversationDeletionSchema>;
