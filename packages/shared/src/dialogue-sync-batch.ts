import { z } from 'zod';
export const DialogueSyncBatchRequestSchema = z
  .object({
    scope: z.enum(['ALL_PENDING', 'SELECTED']),
    conversationIds: z.uuid().array().min(1).max(5000).optional(),
    accountId: z.uuid().optional(),
    explicitAuthorization: z.literal(true),
    idempotencyKey: z.string().min(16).max(128),
    limitPerConversation: z.number().int().min(1).max(50).default(50),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (
      (v.scope === 'SELECTED') !== Boolean(v.conversationIds) ||
      (v.conversationIds && new Set(v.conversationIds).size !== v.conversationIds.length)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'SELECTED requires unique conversationIds; ALL_PENDING forbids them',
        path: ['conversationIds'],
      });
  });
export const DialogueSyncBatchManifestSchema = z
  .object({
    id: z.uuid(),
    runToken: z.uuid(),
    position: z.number().int().min(0).max(4999),
    total: z.number().int().min(1).max(5000),
    conversationIds: z.uuid().array().min(1).max(5000),
  })
  .strict()
  .refine(
    (v) => v.conversationIds.length === v.total && v.position < v.total,
    'Invalid batch manifest',
  );
export const DialogueSyncBatchActionSchema = z
  .object({ explicitAuthorization: z.literal(true) })
  .strict();
export const DialogueSyncBatchResumeSchema = DialogueSyncBatchActionSchema.extend({
  retryFailedItem: z.boolean().default(false),
}).strict();
export const DialogueSyncBatchPageQuerySchema = z
  .object({
    cursor: z.coerce.number().int().min(0).max(4999).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
export const DialogueSyncBatchStatusSchema = z
  .object({
    id: z.uuid(),
    accountId: z.uuid().nullable(),
    status: z.enum([
      'RUNNING',
      'PAUSED',
      'COMPLETED',
      'COMPLETED_WITH_ERRORS',
      'CANCELLED',
      'EXPIRED',
    ]),
    total: z.number().int().min(0).max(5000),
    waiting: z.number().int().nonnegative(),
    active: z.number().int().min(0).max(1),
    succeeded: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    cancelled: z.number().int().nonnegative(),
    currentPosition: z.number().int().nonnegative().nullable(),
    reason: z.string().nullable(),
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    completedAt: z.iso.datetime().nullable(),
    scope: z.literal('VISIBLE_RENDERED_ONLY'),
    complete: z.literal(false),
  })
  .strict();
export const DialogueSyncBatchItemSchema = z
  .object({
    position: z.number().int().nonnegative(),
    conversationId: z.uuid(),
    query: z.string().nullable(),
    status: z.enum(['WAITING', 'ACTIVE', 'SUCCEEDED', 'FAILED', 'SKIPPED', 'CANCELLED']),
    syncRequestId: z.uuid().nullable(),
    attempts: z.number().int().nonnegative(),
    code: z.string().nullable(),
  })
  .strict();
export const DialogueSyncBatchPageSchema = z
  .object({
    batch: DialogueSyncBatchStatusSchema,
    items: DialogueSyncBatchItemSchema.array().max(100),
    nextCursor: z.number().int().nonnegative().nullable(),
  })
  .strict();
export const DialogueSyncBatchReportSchema = DialogueSyncBatchPageSchema.extend({
  pendingRemaining: z.number().int().nonnegative(),
  readConfirmed: z.literal(false),
}).strict();
