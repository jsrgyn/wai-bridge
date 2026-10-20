import { z } from 'zod';
import { DialogueSyncBatchManifestSchema } from './dialogue-sync-batch.js';
import { ConversationIdentitySchema } from './conversation-identity.js';

export const DialogueSyncRequestSchema = z
  .object({
    query: z.string().trim().min(2).max(100),
    accountId: z.uuid().optional(),
    conversationId: z.uuid().optional(),
    limit: z.number().int().min(1).max(50).default(50),
    idempotencyKey: z.string().min(16).max(128),
  })
  .strict();
export const DialogueSyncJobSchema = DialogueSyncRequestSchema.omit({
  idempotencyKey: true,
  conversationId: true,
})
  .extend({
    batch: DialogueSyncBatchManifestSchema.optional(),
    id: z.uuid(),
    leaseToken: z.uuid(),
    expiresAt: z.iso.datetime(),
  })
  .strict();
export const DialogueSyncPollSchema = z
  .object({
    extensionInstanceId: z.uuid(),
    ready: z.boolean(),
    accountId: z.uuid().optional(),
    activeRequestId: z.uuid().optional(),
    leaseToken: z.uuid().optional(),
  })
  .strict()
  .refine(
    (v) => Boolean(v.activeRequestId) === Boolean(v.leaseToken),
    'Active request requires lease token',
  );
export const DialogueSyncPollResultSchema = z
  .object({
    cancelRequestId: z.uuid().optional(),
    pending: z.boolean(),
    job: DialogueSyncJobSchema.nullable(),
  })
  .strict();
export const DialogueSyncCodeSchema = z.enum([
  'OK',
  'CANCELLED',
  'UI_UNSUPPORTED',
  'MONITOR_OFF',
  'TAB_HIDDEN',
  'CONTENT_UNREACHABLE',
  'CONTENT_OUTDATED',
  'AMBIGUOUS_TABS',
  'CONTACT_NOT_FOUND',
  'AMBIGUOUS_CONTACT',
  'ACCOUNT_MISMATCH',
  'COMPOSER_HAS_DRAFT',
  'SEARCH_PANEL_BUSY',
  'SEARCH_CHANGED',
  'USER_INTERFERENCE',
  'CHAT_UNAVAILABLE',
  'SYNC_PARSE_FAILED',
  'CONTEXT_CHANGED',
  'TIMEOUT',
  'INVALID_RESULT',
  'SYNC_FAILED',
]);
export const DialogueSyncResultSchema = z
  .object({
    id: z.uuid(),
    status: z.enum(['REQUESTED', 'CLAIMED', 'SUCCEEDED', 'FAILED', 'EXPIRED']),
    conversationId: z.uuid().nullable(),
    observedCount: z.number().int().min(0).max(50),
    persistedCount: z.number().int().min(0).max(50),
    truncated: z.boolean(),
    messageIds: z.uuid().array().max(50),
    unknownDirectionCount: z.number().int().min(0).max(50),
    code: DialogueSyncCodeSchema.nullable(),
    createdAt: z.iso.datetime(),
    completedAt: z.iso.datetime().nullable(),
    expiresAt: z.iso.datetime(),
    scope: z.literal('VISIBLE_RENDERED_ONLY'),
    complete: z.literal(false),
  })
  .strict();
export const DialogueSyncCompletionBaseSchema = z
  .object({
    extensionInstanceId: z.uuid(),
    requestId: z.uuid(),
    leaseToken: z.uuid(),
    identity: ConversationIdentitySchema.optional(),
    conversationLabel: z.string().trim().min(1).max(256).optional(),
    code: DialogueSyncCodeSchema,
    truncated: z.boolean(),
  })
  .strict();
export type DialogueSyncJob = z.infer<typeof DialogueSyncJobSchema>;
