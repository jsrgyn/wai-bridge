import { z } from 'zod';
import { CaptureObservationSchema } from '@wai-bridge/shared';

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
  z.object({ kind: z.literal('GET_CONTENT_STATE') }),
]);

export const ExtensionStateSchema = z.object({
  monitoring: z.boolean(),
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
