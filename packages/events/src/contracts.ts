import { z } from 'zod';

export const EventTypeSchema = z.enum([
  'message.detected',
  'message.captured',
  'message.received',
  'message.sent',
  'contact.detected',
  'conversation.detected',
  'media.available',
  'media.cached',
  'ai.message.read',
  'outbox.requested',
  'outbox.updated',
  'extension.connected',
  'extension.disconnected',
]);
export const EventEnvelopeSchema = z.object({
  id: z.uuid(),
  type: EventTypeSchema,
  aggregateType: z.string().min(1),
  aggregateId: z.string().min(1),
  sequence: z.number().int().positive(),
  occurredAt: z.iso.datetime().refine((value) => value.endsWith('Z')),
  payloadVersion: z.number().int().positive(),
  payload: z.record(z.string(), z.unknown()),
  idempotencyScope: z.string().min(1).optional(),
  idempotencyKey: z.string().min(16).max(128).optional(),
});
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;
export const EventInputSchema = EventEnvelopeSchema.omit({ sequence: true });
export type EventInput = z.infer<typeof EventInputSchema>;
export interface Clock {
  now(): string;
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
}
export const systemClock: Clock = {
  now: () => new Date().toISOString(),
  sleep: (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new Error('SLEEP_ABORTED'));
        },
        { once: true },
      );
    }),
};
export interface Notifier {
  notify(event: EventEnvelope, signal?: AbortSignal): Promise<boolean>;
}
export interface PublishResult {
  readonly event: EventEnvelope;
  readonly duplicate: boolean;
}
