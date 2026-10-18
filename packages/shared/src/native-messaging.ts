import { z } from 'zod';

const UtcTimestampSchema = z.iso.datetime().refine((value) => value.endsWith('Z'));
const RequestBase = z.object({ version: z.literal(1), id: z.string().uuid() });

export const CaptureObservationSchema = z.object({
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
}).strict();

export const CaptureSubmissionSchema = z.object({
  extensionInstanceId: z.string().uuid(),
  observation: CaptureObservationSchema,
}).strict();

export const CaptureResultSchema = z.object({
  observationId: z.string().uuid(),
  eventId: z.string().uuid(),
  duplicate: z.boolean(),
}).strict();

export const NativeRequestSchema = z.discriminatedUnion('type', [
  RequestBase.extend({ type: z.literal('HELLO'), extensionInstanceId: z.string().uuid() }),
  RequestBase.extend({ type: z.literal('HEARTBEAT'), extensionInstanceId: z.string().uuid() }),
  RequestBase.extend({ type: z.literal('STATUS_REQUEST') }),
  RequestBase.extend({ type: z.literal('CAPTURE_OBSERVATION'), extensionInstanceId: z.string().uuid(), observation: CaptureObservationSchema }),
]);

export const NativeResponseSchema = z.discriminatedUnion('type', [
  RequestBase.extend({ type: z.literal('HOST_STATE'), connected: z.boolean(), hostInstanceId: z.string().uuid(), at: UtcTimestampSchema }),
  RequestBase.extend({ type: z.literal('STATUS_RESULT'), api: z.enum(['AVAILABLE', 'UNAVAILABLE']), at: UtcTimestampSchema }),
  RequestBase.extend({ type: z.literal('ERROR'), code: z.enum(['INVALID_REQUEST', 'API_UNAVAILABLE']), at: UtcTimestampSchema }),
  RequestBase.extend({ type: z.literal('CAPTURE_RESULT'), observationId: z.string().uuid(), eventId: z.string().uuid(), duplicate: z.boolean(), at: UtcTimestampSchema }),
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
