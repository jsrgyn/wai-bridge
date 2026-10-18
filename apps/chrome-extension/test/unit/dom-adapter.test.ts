import { describe, expect, it } from 'vitest';
import { CaptureObservationSchema } from '../../src/contracts.js';
import { NativeRequestSchema, NATIVE_HOST_NAME } from '../../src/platform/native-messaging-adapter.js';

describe('extension contracts', () => {
  it('rejects malformed capture payloads', () => {
    expect(CaptureObservationSchema.safeParse({ kind: 'CAPTURE_OBSERVATION' }).success).toBe(false);
  });

  it('accepts only the allowlisted versioned Native Messaging request types', () => {
    expect(NATIVE_HOST_NAME).toBe('com.wai_bridge.mac_agent');
    expect(NativeRequestSchema.safeParse({ version: 1, id: crypto.randomUUID(), type: 'STATUS_REQUEST' }).success).toBe(true);
    expect(NativeRequestSchema.safeParse({ version: 1, id: crypto.randomUUID(), type: 'RUN_SHELL', command: 'id' }).success).toBe(false);
  });
});
