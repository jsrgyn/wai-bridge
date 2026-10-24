import { z } from 'zod';
import {
  ConversationIdentitySchema,
  normalizeProfilePhone,
  type ConversationIdentity,
} from './conversation-identity.js';

export const SendTargetSchema = z
  .object({
    accountId: z.uuid(),
    type: z.enum(['PHONE', 'GROUP_LOCAL', 'UI_CONTEXT']),
    referenceKey: z.string().min(1).max(256),
  })
  .strict();
export function sendTarget(identity: ConversationIdentity): z.infer<typeof SendTargetSchema> {
  return {
    accountId: identity.accountId,
    type: identity.type,
    referenceKey:
      identity.type === 'PHONE'
        ? identity.phone
        : identity.type === 'UI_CONTEXT'
          ? identity.conversationKey
          : identity.groupId,
  };
}
export const SendTimingSchema = z
  .object({
    autoCountdownMs: z.number().int().min(0).max(30_000),
    executionTimeoutMs: z.number().int().min(20_000).max(180_000),
    queueMaxWaitMs: z.number().int().min(60_000).max(86_400_000).nullable(),
    sendVerifyMs: z.number().int().min(5_000).max(60_000),
  })
  .strict();
export type SendTiming = z.infer<typeof SendTimingSchema>;
export const DEFAULT_SEND_TIMING: SendTiming = {
  autoCountdownMs: 5_000,
  executionTimeoutMs: 60_000,
  queueMaxWaitMs: 1_800_000,
  sendVerifyMs: 15_000,
};
export const SendTimingOverrideSchema = SendTimingSchema.partial();
export type SendTimingOverride = z.infer<typeof SendTimingOverrideSchema>;
export function resolveSendTiming(settings: SendTiming, override?: SendTimingOverride): SendTiming {
  const merged: SendTiming = { ...settings };
  if (override) {
    for (const key of Object.keys(override) as (keyof SendTiming)[]) {
      const value = override[key];
      if (value !== undefined) (merged as Record<string, number | null>)[key] = value;
    }
  }
  return merged;
}
export const ExtensionSendRequestSchema = z
  .object({
    conversationId: z.uuid(),
    text: z.string().trim().min(1).max(10_000),
    mode: z.enum(['AUTO', 'SUPERVISED']).default('SUPERVISED'),
    explicitAuthorization: z.literal(true),
    locateByPhone: z.boolean().optional(),
    timing: SendTimingOverrideSchema.optional(),
  })
  .strict();
export const ExtensionPhoneSendRequestSchema = z
  .object({
    phoneNumber: z
      .string()
      .trim()
      .min(9)
      .max(40)
      .refine(
        (value) => normalizeProfilePhone(value) !== null,
        'Provide an international phone with +DDI',
      ),
    accountId: z.uuid().optional(),
    text: z.string().trim().min(1).max(10_000),
    mode: z.enum(['AUTO', 'SUPERVISED']).default('SUPERVISED'),
    explicitAuthorization: z.literal(true),
    timing: SendTimingOverrideSchema.optional(),
  })
  .strict();
export const ExtensionRecipientSendRequestSchema = ExtensionPhoneSendRequestSchema.omit({
  phoneNumber: true,
})
  .extend({
    recipientName: z.string().trim().min(2).max(256),
  })
  .strict();
export const SendBridgeReasonSchema = z.enum([
  'READY',
  'TAB_HIDDEN',
  'NO_WHATSAPP_TAB',
  'NO_MONITORED_CONTEXT',
  'CONTENT_UNREACHABLE',
  'CONTENT_OUTDATED',
  'AMBIGUOUS_TABS',
  'SEND_DISABLED',
  'EXECUTING',
]);
export const ExtensionSendPollSchema = z
  .object({
    extensionInstanceId: z.uuid(),
    allowClaim: z.boolean().default(true),
    ready: z.boolean().default(true),
    visible: z.boolean().optional(),
    identity: ConversationIdentitySchema.optional(),
    reason: SendBridgeReasonSchema.optional(),
    protocolVersion: z.literal(2).optional(),
    clientBuild: z.string().max(64).optional(),
    activeCommand: z
      .object({ id: z.uuid(), contextId: z.uuid(), leaseToken: z.uuid() })
      .strict()
      .optional(),
    conversationLabel: z.string().trim().max(256).nullable().optional(),
  })
  .strict();
export const ExtensionSendCommandSchema = z
  .object({
    id: z.uuid(),
    traceId: z.uuid().optional(),
    leaseToken: z.uuid(),
    contextId: z.uuid(),
    conversationId: z.uuid().optional(),
    target: SendTargetSchema,
    locateByPhone: z.boolean().optional(),
    recipientPhone: z
      .string()
      .regex(/^\+[1-9]\d{7,14}$/)
      .optional(),
    text: z.string().trim().min(1).max(10_000),
    mode: z.enum(['AUTO', 'SUPERVISED']),
    explicitAuthorization: z.literal(true),
    leaseUntil: z.iso.datetime(),
    timing: SendTimingSchema,
    appendToDraft: z.boolean(),
  })
  .strict()
  .refine(
    (value) => !value.locateByPhone || Boolean(value.recipientPhone),
    'Phone search requires a recipient phone',
  )
  .refine(
    (value) => Boolean(value.conversationId) || value.locateByPhone === true,
    'Unbound commands require phone resolution',
  );
export const ExtensionSendStepSchema = z.enum([
  'WAITING_AUTO_SEND',
  'WAITING_USER',
  'SENDING',
  'DRAFTED',
  'SENT',
  'UNKNOWN',
  'FAILED',
  'CANCELLED',
]);
export const ExtensionSendQueueStatusSchema = z.enum([
  'QUEUED',
  'WAITING_WHATSAPP',
  'CLAIMED',
  'TARGET_VERIFIED',
  'COMPOSED',
  'WAITING_AUTO_SEND',
  'SENDING',
  'DRAFTED',
  'SENT',
  'UNKNOWN',
  'FAILED',
  'CANCELLED',
]);
export const ExtensionSendProgressSchema = z
  .object({
    extensionInstanceId: z.uuid(),
    commandId: z.uuid(),
    traceId: z.uuid().optional(),
    leaseToken: z.uuid(),
    contextId: z.uuid(),
    step: ExtensionSendStepSchema,
    code: z.string().regex(/^[A-Z0-9_]{1,64}$/),
    resolvedIdentity: ConversationIdentitySchema.optional(),
    conversationLabel: z.string().trim().min(1).max(256).optional(),
    evidence: z
      .string()
      .regex(/^visible-outbound:[a-f0-9]{64}$/)
      .optional(),
  })
  .strict()
  .refine(
    (v) => v.step !== 'SENT' || Boolean(v.evidence),
    'SENT requires visible outbound evidence',
  );
export const ExtensionSendPollResultSchema = z
  .object({
    command: ExtensionSendCommandSchema.nullable(),
    pending: z.boolean().optional(),
    activeStatus: ExtensionSendQueueStatusSchema.or(z.literal('REQUESTED'))
      .or(z.literal('WAITING_USER'))
      .optional(),
  })
  .strict();
export const ExtensionSendProgressResultSchema = z
  .object({ ok: z.literal(true), status: z.string() })
  .strict();
export type ExtensionSendCommand = z.infer<typeof ExtensionSendCommandSchema>;
export type ExtensionSendProgress = z.infer<typeof ExtensionSendProgressSchema>;
export const ExtensionSendQueueItemSchema = z
  .object({
    id: z.uuid(),
    status: ExtensionSendQueueStatusSchema,
    mode: z.enum(['AUTO', 'SUPERVISED']),
    priority: z.union([z.literal(0), z.literal(1)]),
    position: z.number().int().nullable(),
    attempts: z.number().int(),
    resultCode: z.string().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export const ExtensionSendQueueSchema = z
  .object({
    paused: z.boolean(),
    pauseReason: z.string().nullable(),
    items: z.array(ExtensionSendQueueItemSchema),
  })
  .strict();
export type ExtensionSendQueueItem = z.infer<typeof ExtensionSendQueueItemSchema>;
export type ExtensionSendQueue = z.infer<typeof ExtensionSendQueueSchema>;
