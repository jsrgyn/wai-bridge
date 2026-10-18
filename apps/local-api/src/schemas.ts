import { z } from 'zod';
import { CaptureSubmissionSchema, ExtensionStateInputSchema } from '@wai-bridge/shared';
const cursor = z.string().max(256).optional();
export const PageQuerySchema = z
  .object({ cursor, limit: z.coerce.number().int().min(1).max(100).default(50) })
  .strict();
export const MessageQuerySchema = PageQuerySchema.extend({
  conversationId: z.uuid().optional(),
  aiState: z.enum(['UNREAD', 'CLAIMED', 'READ', 'FAILED']).optional(),
  direction: z.enum(['INBOUND', 'OUTBOUND']).optional(),
  captureStatus: z.enum(['DETECTED', 'CAPTURED', 'PENDING', 'FAILED']).optional(),
  consumerId: z.string().trim().min(1).max(128).optional(),
});
export const SearchQuerySchema = PageQuerySchema.extend({ q: z.string().trim().min(2).max(100) });
export const IdParamsSchema = z.object({ id: z.uuid() });
export const ExtensionStateSchema = ExtensionStateInputSchema;
export const CaptureBodySchema = CaptureSubmissionSchema;
export const MessageIdParamsSchema = z.object({ messageId: z.uuid() });
export const ClaimBodySchema = z
  .object({ messageId: z.uuid(), consumerId: z.string().min(1).max(128) })
  .strict();
export const AckBodySchema = ClaimBodySchema.extend({ claimToken: z.uuid() }).strict();
export const ConsumerClaimBodySchema = ClaimBodySchema.extend({ leaseMs: z.number().int().min(1000).max(86400000).default(60000) }).strict();
export const ConsumerFailBodySchema = AckBodySchema.extend({ errorCode: z.string().regex(/^[A-Z0-9_]{1,64}$/) }).strict();
export const OutboxBodySchema = z
  .object({
    recipientId: z.uuid(),
    text: z.string().min(1).max(10000),
    mode: z.enum(['AUTO', 'SUPERVISED']).default('SUPERVISED'),
    explicitAuthorization: z.literal(true),
  })
  .strict();
export const OutboxResultSchema=z.object({result:z.enum(['SENT','UNKNOWN','FAILED']),evidenceRef:z.string().trim().min(1).max(256).optional()}).strict().refine((value)=>value.result!=='SENT'||Boolean(value.evidenceRef),'Verified result evidence is required for SENT');
export const CursorSchema = z.string().max(256).optional();
export const IdempotencyKeySchema = z.string().min(16).max(128);
export const ErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), correlationId: z.string() }),
});
