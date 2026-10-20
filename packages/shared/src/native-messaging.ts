import { ManagementRequestSchema, ExtensionTelemetrySchema } from './operations.js';
import {
  DialogueSyncPollSchema,
  DialogueSyncPollResultSchema,
  DialogueSyncCompletionBaseSchema,
  DialogueSyncResultSchema,
} from './dialogue-sync.js';
import { FlowLogBatchSchema } from './flow-log.js';
import { z } from 'zod';
import {
  ExtensionSendPollSchema,
  ExtensionSendProgressSchema,
  ExtensionSendPollResultSchema,
  ExtensionSendProgressResultSchema,
} from './extension-send.js';
import { ConversationIdentitySchema } from './conversation-identity.js';

const UtcTimestampSchema = z.iso.datetime().refine((value) => value.endsWith('Z'));
const RequestBase = z.object({ version: z.literal(1), id: z.string().uuid() });

export const CaptureObservationSchema = z
  .object({
    kind: z.literal('CAPTURE_OBSERVATION'),
    observationId: z.string().uuid(),
    observedAt: UtcTimestampSchema,
    observationType: z.enum(['MESSAGE', 'CONVERSATION_ACTIVITY']),
    captureState: z.enum(['DETECTED', 'CAPTURED', 'PENDING', 'FAILED']),
    conversation: z.object({
      label: z.string().trim().max(256).nullable(),
      kind: z.enum(['INDIVIDUAL', 'GROUP', 'UNKNOWN']),
    }),
    senderLabel: z.string().trim().max(256).nullable(),
    direction: z.enum(['INBOUND', 'OUTBOUND', 'UNKNOWN']),
    content: z.string().max(10_000).nullable(),
    contentAvailability: z.enum(['AVAILABLE', 'UNAVAILABLE']),
    media: z.array(z.enum(['IMAGE', 'AUDIO', 'VIDEO', 'DOCUMENT', 'UNKNOWN'])).max(16),
    identity: ConversationIdentitySchema.optional(),
    activity: z
      .object({
        unreadCount: z.number().int().nonnegative().nullable(),
        reason: z.enum(['INITIAL_UNREAD', 'ROW_CHANGED', 'UNREAD_DECREASED']),
      })
      .strict()
      .optional(),
    messageRef: z
      .object({
        key: z.uuid(),
        revision: z.number().int().min(1).max(1000000),
        firstObservedAt: UtcTimestampSchema,
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.activity && value.observationType !== 'CONVERSATION_ACTIVITY')
      ctx.addIssue({
        code: 'custom',
        message: 'Activity metadata requires activity observation',
        path: ['activity'],
      });
    if (
      value.messageRef &&
      (value.observationType !== 'MESSAGE' ||
        Date.parse(value.messageRef.firstObservedAt) > Date.parse(value.observedAt))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Invalid message revision context',
        path: ['messageRef'],
      });
    if (!value.identity) return;
    if (value.observationType === 'CONVERSATION_ACTIVITY' && value.identity.type !== 'UI_CONTEXT')
      ctx.addIssue({
        code: 'custom',
        message: 'Activity requires a local UI reference',
        path: ['identity'],
      });
    if (
      value.conversation.kind !==
      (value.identity.type === 'PHONE'
        ? 'INDIVIDUAL'
        : value.identity.type === 'UI_CONTEXT'
          ? value.identity.conversationKind
          : 'GROUP')
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Identity does not match the message context',
        path: ['identity'],
      });
    }
    if (Date.parse(value.identity.confirmedAt) > Date.parse(value.observedAt))
      ctx.addIssue({
        code: 'custom',
        message: 'Confirmation must precede observation',
        path: ['identity', 'confirmedAt'],
      });
  });

export const DialogueSyncCompletionSchema = DialogueSyncCompletionBaseSchema.extend({
  observations: CaptureObservationSchema.array().max(50),
}).strict();

export const CaptureSubmissionSchema = z
  .object({
    extensionInstanceId: z.string().uuid(),
    observation: CaptureObservationSchema,
  })
  .strict();

export const CaptureResultSchema = z
  .object({
    observationId: z.string().uuid(),
    eventId: z.string().uuid(),
    duplicate: z.boolean(),
  })
  .strict();

export const NativeRequestSchema = z.discriminatedUnion('type', [
  RequestBase.extend({
    type: z.literal('MANAGEMENT'),
    extensionInstanceId: z.uuid(),
    input: ManagementRequestSchema,
  }),
  RequestBase.extend({ type: z.literal('SYNC_POLL'), input: DialogueSyncPollSchema }),
  RequestBase.extend({ type: z.literal('SYNC_COMPLETE'), input: DialogueSyncCompletionSchema }),
  RequestBase.extend({ type: z.literal('HELLO'), extensionInstanceId: z.string().uuid() }),
  RequestBase.extend({
    type: z.literal('HEARTBEAT'),
    extensionInstanceId: z.string().uuid(),
    telemetry: ExtensionTelemetrySchema.optional(),
  }),
  RequestBase.extend({ type: z.literal('STATUS_REQUEST') }),
  RequestBase.extend({
    type: z.literal('FLOW_LOGS'),
    extensionInstanceId: z.uuid(),
    events: FlowLogBatchSchema.shape.events,
  }),
  RequestBase.extend({ type: z.literal('SEND_POLL'), input: ExtensionSendPollSchema }),
  RequestBase.extend({ type: z.literal('SEND_PROGRESS'), input: ExtensionSendProgressSchema }),
  RequestBase.extend({
    type: z.literal('CAPTURE_OBSERVATION'),
    extensionInstanceId: z.string().uuid(),
    observation: CaptureObservationSchema,
  }),
]);

export const NativeResponseSchema = z.discriminatedUnion('type', [
  RequestBase.extend({ type: z.literal('MANAGEMENT_RESULT'), result: z.json() }),
  RequestBase.extend({
    type: z.literal('MANAGEMENT_FAILURE'),
    code: z.string().regex(/^[A-Z_]{1,80}$/),
  }),
  RequestBase.extend({ type: z.literal('SYNC_POLL_RESULT'), result: DialogueSyncPollResultSchema }),
  RequestBase.extend({ type: z.literal('SYNC_COMPLETE_RESULT'), result: DialogueSyncResultSchema }),
  RequestBase.extend({
    type: z.literal('FLOW_LOGS_RESULT'),
    accepted: z.number().int().min(0).max(50),
  }),
  RequestBase.extend({
    type: z.literal('SEND_POLL_RESULT'),
    result: ExtensionSendPollResultSchema,
  }),
  RequestBase.extend({
    type: z.literal('SEND_PROGRESS_RESULT'),
    result: ExtensionSendProgressResultSchema,
  }),
  RequestBase.extend({
    type: z.literal('HOST_STATE'),
    connected: z.boolean(),
    hostInstanceId: z.string().uuid(),
    at: UtcTimestampSchema,
  }),
  RequestBase.extend({
    type: z.literal('STATUS_RESULT'),
    api: z.enum(['AVAILABLE', 'UNAVAILABLE']),
    at: UtcTimestampSchema,
  }),
  RequestBase.extend({
    type: z.literal('ERROR'),
    code: z.enum(['INVALID_REQUEST', 'API_UNAVAILABLE']),
    at: UtcTimestampSchema,
  }),
  RequestBase.extend({
    type: z.literal('CAPTURE_RESULT'),
    observationId: z.string().uuid(),
    eventId: z.string().uuid(),
    duplicate: z.boolean(),
    at: UtcTimestampSchema,
  }),
]);

export const ExtensionStateInputSchema = z.object({
  extensionInstanceId: z.string().uuid(),
  status: z.enum(['CONNECTED', 'DISCONNECTED']),
  lastSeenAt: UtcTimestampSchema,
});

export type NativeRequest = z.infer<typeof NativeRequestSchema>;
export type NativeResponse = z.infer<typeof NativeResponseSchema>;
export type ExtensionStateInput = z.infer<typeof ExtensionStateInputSchema>;
export type CaptureObservation = z.infer<typeof CaptureObservationSchema>;
