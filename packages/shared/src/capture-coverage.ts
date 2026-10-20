import { z } from 'zod';
export const CaptureMediaSummarySchema = z
  .object({
    id: z.uuid(),
    kind: z.enum(['IMAGE', 'AUDIO', 'VIDEO', 'PDF', 'DOCUMENT', 'OTHER']).nullable(),
    availability: z.enum(['AVAILABLE', 'PARTIAL', 'UNAVAILABLE']),
    processingStatus: z.enum([
      'DETECTED',
      'AVAILABLE',
      'CACHING',
      'CACHED',
      'UNAVAILABLE',
      'FAILED',
      'REMOVED',
    ]),
  })
  .strict();
export const CaptureCoverageSchema = z
  .object({
    conversationId: z.uuid(),
    scope: z.literal('OBSERVED_UI_ONLY'),
    complete: z.literal(false),
    messageCount: z.number().int().nonnegative(),
    unavailableMessageCount: z.number().int().nonnegative(),
    unavailableMediaCount: z.number().int().nonnegative(),
    activitySignalCount: z.number().int().nonnegative(),
    unknownDirectionObservationCount: z.number().int().nonnegative(),
    lastActivityAt: z.iso.datetime().nullable(),
    lastMessageAt: z.iso.datetime().nullable(),
    recentActivity: z
      .array(z.object({ observationId: z.uuid(), observedAt: z.iso.datetime() }).strict())
      .max(20),
    recentActivityTruncated: z.boolean(),
    activitySignalsAreNotMessages: z.literal(true),
  })
  .strict();
