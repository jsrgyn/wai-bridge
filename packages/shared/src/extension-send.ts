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
export const ExtensionSendRequestSchema = z
  .object({
    conversationId: z.uuid(),
    text: z.string().trim().min(1).max(10_000),
    mode: z.enum(['AUTO', 'SUPERVISED']).default('SUPERVISED'),
    explicitAuthorization: z.literal(true),
    locateByPhone: z.boolean().optional(),
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
  'SENT',
  'UNKNOWN',
  'FAILED',
  'CANCELLED',
]);
export const ExtensionSendProgressSchema = z
  .object({
    extensionInstanceId: z.uuid(),
    commandId: z.uuid(),
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
    activeStatus: z
      .enum([
        'REQUESTED',
        'CLAIMED',
        'WAITING_USER',
        'WAITING_AUTO_SEND',
        'SENDING',
        'SENT',
        'UNKNOWN',
        'FAILED',
        'CANCELLED',
      ])
      .optional(),
  })
  .strict();
export const ExtensionSendProgressResultSchema = z
  .object({ ok: z.literal(true), status: z.string() })
  .strict();
export type ExtensionSendCommand = z.infer<typeof ExtensionSendCommandSchema>;
export type ExtensionSendProgress = z.infer<typeof ExtensionSendProgressSchema>;
