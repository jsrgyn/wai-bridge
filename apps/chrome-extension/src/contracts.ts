import { z } from 'zod';
import { CaptureObservationSchema, ConversationIdentitySchema, ExtensionSendCommandSchema } from '@wai-bridge/shared';

export const IdentityControlSchema = z.discriminatedUnion('kind', [
  z.object({kind:z.literal('IDENTITY_PREVIEW')}).strict(),
  z.object({kind:z.literal('IDENTITY_BIND'),contextId:z.uuid(),accountId:z.uuid(),confirmed:z.literal(true),groupId:z.uuid().optional(),groupLabel:z.string().trim().min(1).max(256).optional()}).strict(),
  z.object({kind:z.literal('IDENTITY_CLEAR')}).strict(),
  z.object({kind:z.literal('IDENTITY_STATE')}).strict(),
]);
export const IdentityPreviewSchema = z.object({contextId:z.uuid(),type:z.enum(['PHONE','GROUP_LOCAL']),phone:z.string().optional()}).strict();
export const IdentityReplySchema = z.object({ok:z.boolean(),preview:IdentityPreviewSchema.optional(),identity:ConversationIdentitySchema.optional(),error:z.string().optional()});

export const MonitorCommandSchema = z.object({
  kind: z.literal('COMMAND'),
  command: z.enum(['MONITOR_START', 'MONITOR_STOP', 'GET_STATE']),
});

export const MonitorControlSchema = z.object({
  kind: z.literal('MONITOR_CONTROL'),
  enabled: z.boolean(),
});

export { CaptureObservationSchema };

export const ContentMessageSchema = z.discriminatedUnion('kind', [
  MonitorControlSchema,
  z.object({kind:z.literal('SEND_CONTEXT'),enabled:z.boolean()}).strict(),
  z.object({kind:z.literal('SEND_EXECUTE'),command:ExtensionSendCommandSchema}).strict(),
  z.object({kind:z.literal('SEND_CANCEL'),commandId:z.uuid()}).strict(),
  z.object({ kind: z.literal('GET_CONTENT_STATE') }),
  ...IdentityControlSchema.options,
]);

export const ExtensionStateSchema = z.object({
  monitoring: z.boolean(),
  captureContext: z.enum(['ACTIVE_CONVERSATION', 'NO_CONVERSATION', 'UNAVAILABLE', 'NOT_WHATSAPP']).optional(),
  connection: z.enum(['CONNECTED', 'DISCONNECTED', 'UNCONFIGURED']),
  activities: z.array(z.object({
    label: z.string().max(80),
    timestamp: z.string().datetime({ offset: true }),
  })).max(20),
  errors: z.array(z.string().max(160)).max(5),
  retainActivitySummaries: z.boolean(),
});

export type CaptureObservation = z.infer<typeof CaptureObservationSchema>;
export type ExtensionState = z.infer<typeof ExtensionStateSchema>;
