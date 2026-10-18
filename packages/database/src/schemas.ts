import { z } from 'zod';
export const IdSchema = z.uuid();
export const UtcTimestampSchema = z.iso
  .datetime({ offset: false })
  .refine((value) => value.endsWith('Z'), 'Timestamp must be UTC');
export const DirectionSchema = z.enum(['INBOUND', 'OUTBOUND']);
export const CaptureStatusSchema = z.enum(['DETECTED', 'CAPTURED', 'PENDING', 'FAILED']);
export const AIMessageStateSchema = z.enum(['UNREAD', 'CLAIMED', 'READ', 'FAILED']);
export const MessageInsertSchema = z
  .object({
    id: IdSchema,
    conversationId: IdSchema,
    senderContactId: IdSchema.nullable().optional(),
    externalId: z.string().min(1).nullable().optional(),
    direction: DirectionSchema,
    captureStatus: CaptureStatusSchema,
    content: z.string().nullable().optional(),
    contentAvailability: z.enum(['AVAILABLE', 'PARTIAL', 'UNAVAILABLE']),
    observedAt: UtcTimestampSchema,
    capturedAt: UtcTimestampSchema.nullable().optional(),
    sequence: z.number().int().positive(),
    idempotencyScope: z.string().min(1).optional(),
    idempotencyKey: z.string().min(16).max(128).optional(),
  })
  .strict();
export type MessageInsert = z.infer<typeof MessageInsertSchema>;
export const CommandInsertSchema = z
  .object({
    id: IdSchema,
    kind: z.string().min(1),
    idempotencyScope: z.string().min(1),
    idempotencyKey: z.string().min(16).max(128),
    requestHash: z.string().min(1),
    status: z.string().min(1),
    payload: z.unknown(),
    createdAt: UtcTimestampSchema,
  })
  .strict();
export type CommandInsert = z.infer<typeof CommandInsertSchema>;
