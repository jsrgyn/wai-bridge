import { CaptureObservationSchema, ContentMessageSchema, MonitorCommandSchema } from '../contracts.js';

export function parsePopupCommand(input: unknown) {
  return MonitorCommandSchema.safeParse(input);
}

export function parseContentMessage(input: unknown) {
  return ContentMessageSchema.safeParse(input);
}

export function parseCaptureObservation(input: unknown) {
  return CaptureObservationSchema.safeParse(input);
}
