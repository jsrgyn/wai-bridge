import { z } from 'zod';

export const ConversationReviewStageSchema = z.enum([
  'WAITING_SYNC',
  'SYNC_REQUESTED',
  'SYNCING',
  'SYNC_FAILED',
  'SYNC_EXPIRED',
  'SYNCED_PARTIAL',
  'READ_CONFIRMED',
]);
export const ConversationReviewQuerySchema = z
  .object({
    accountId: z.uuid().optional(),
    query: z.string().trim().min(1).max(100).optional(),
    pendingOnly: z.enum(['true', 'false']).default('true'),
    stage: ConversationReviewStageSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.uuid().optional(),
  })
  .strict();
export const ConversationReviewAckSchema = z
  .object({
    syncRequestId: z.uuid(),
    revision: z.number().int().positive(),
    explicitConfirmation: z.literal(true),
  })
  .strict();
export const ConversationReviewLinkSchema = z
  .object({
    relatedConversationId: z.uuid(),
    explicitConfirmation: z.literal(true),
  })
  .strict();
export const ConversationReviewItemSchema = z
  .object({
    conversationId: z.uuid(),
    accountId: z.uuid().nullable(),
    title: z.string().nullable(),
    kind: z.enum(['DIRECT', 'GROUP', 'UNKNOWN']),
    phone: z.string().nullable(),
    identityContinuity: z.literal('REFERENCE_ONLY'),
    relatedConversationIds: z.uuid().array(),
    stage: ConversationReviewStageSchema,
    pending: z.boolean(),
    revision: z.number().int().nonnegative(),
    verifiedRevision: z.number().int().nonnegative(),
    acknowledgedRevision: z.number().int().nonnegative(),
    signalCount: z.number().int().nonnegative(),
    unreadCountObserved: z.number().int().nonnegative().nullable(),
    unreadObservedAt: z.iso.datetime().nullable(),
    lastActivityAt: z.iso.datetime(),
    lastSyncRequestId: z.uuid().nullable(),
    lastSyncAt: z.iso.datetime().nullable(),
    lastError: z.string().nullable(),
    lastReadConfirmedAt: z.iso.datetime().nullable(),
    complete: z.literal(false),
    signalsAreNotMessageCounts: z.literal(true),
  })
  .strict();
export const ConversationReviewPageSchema = z
  .object({
    items: ConversationReviewItemSchema.array().max(100),
    total: z.number().int().nonnegative(),
    nextCursor: z.uuid().nullable(),
    scope: z.literal('OBSERVED_UI_ONLY'),
    complete: z.literal(false),
  })
  .strict();
