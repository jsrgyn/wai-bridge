import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SEND_TIMING,
  ExtensionSendCommandSchema,
  ExtensionSendStepSchema,
  SendTimingSchema,
  resolveSendTiming,
} from '../src/index.js';

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('send timing contracts', () => {
  it('resolveSendTiming merges override over settings', () => {
    const resolved = resolveSendTiming(DEFAULT_SEND_TIMING, { autoCountdownMs: 0 });
    expect(resolved).toEqual({ ...DEFAULT_SEND_TIMING, autoCountdownMs: 0 });
    expect(resolveSendTiming(DEFAULT_SEND_TIMING)).toEqual(DEFAULT_SEND_TIMING);
  });

  it('rejects autoCountdownMs 30001 and executionTimeoutMs 19999', () => {
    expect(
      SendTimingSchema.safeParse({ ...DEFAULT_SEND_TIMING, autoCountdownMs: 30001 }).success,
    ).toBe(false);
    expect(
      SendTimingSchema.safeParse({ ...DEFAULT_SEND_TIMING, executionTimeoutMs: 19999 }).success,
    ).toBe(false);
    expect(SendTimingSchema.safeParse(DEFAULT_SEND_TIMING).success).toBe(true);
  });

  it('accepts queueMaxWaitMs null', () => {
    expect(
      SendTimingSchema.safeParse({ ...DEFAULT_SEND_TIMING, queueMaxWaitMs: null }).success,
    ).toBe(true);
  });

  it('ExtensionSendStepSchema accepts DRAFTED', () => {
    expect(ExtensionSendStepSchema.safeParse('DRAFTED').success).toBe(true);
  });

  it('command requires timing and appendToDraft', () => {
    const base = {
      id: uuid(1),
      leaseToken: uuid(2),
      contextId: uuid(3),
      conversationId: uuid(4),
      target: { accountId: uuid(5), type: 'PHONE', referenceKey: '+550000000001' },
      text: 'synthetic',
      mode: 'AUTO',
      explicitAuthorization: true,
      leaseUntil: '2026-01-01T00:00:00.000Z',
    };
    expect(ExtensionSendCommandSchema.safeParse(base).success).toBe(false);
    expect(
      ExtensionSendCommandSchema.safeParse({
        ...base,
        timing: DEFAULT_SEND_TIMING,
        appendToDraft: false,
      }).success,
    ).toBe(true);
  });
});
