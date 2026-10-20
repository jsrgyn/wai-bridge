import { describe, expect, it } from 'vitest';
import { normalizeProfilePhone, CaptureObservationSchema } from '../src/index.js';

describe('visible phone reference', () => {
  it('normalizes only explicitly international standalone phones without adding digits', () => {
    expect(normalizeProfilePhone(' +1 (202) 555-0123 ')).toBe('+12025550123');
    expect(normalizeProfilePhone('+1\u00a0(202)\u202f555-0123')).toBe('+12025550123');
    expect(normalizeProfilePhone('+1\t(202) 555-0123')).toBe('+12025550123');
    expect(normalizeProfilePhone('+55 62 8122-0000')).toBe('+556281220000');
    for (const value of [
      '2025550123',
      'Name +12025550123',
      '+12025550123 extra',
      '+0012025550123',
      '+1-2',
      '+12025550123/+12025550124',
    ])
      expect(normalizeProfilePhone(value)).toBeNull();
  });
  it('validates identity as a versioned message-only contract', () => {
    const observation = {
      kind: 'CAPTURE_OBSERVATION',
      observationId: '11111111-1111-4111-8111-111111111111',
      observedAt: '2026-10-18T12:00:00.000Z',
      observationType: 'MESSAGE',
      captureState: 'CAPTURED',
      conversation: { label: null, kind: 'INDIVIDUAL' },
      senderLabel: null,
      direction: 'INBOUND',
      content: 'Synthetic',
      contentAvailability: 'AVAILABLE',
      media: [],
      identity: {
        version: 1,
        type: 'PHONE',
        source: 'PROFILE_PHONE',
        accountId: '22222222-2222-4222-8222-222222222222',
        contextId: '33333333-3333-4333-8333-333333333333',
        confirmedAt: '2026-10-18T12:00:00Z',
        phone: '+12025550123',
      },
    };
    expect(CaptureObservationSchema.safeParse(observation).success).toBe(true);
    expect(
      CaptureObservationSchema.safeParse({
        ...observation,
        observationType: 'CONVERSATION_ACTIVITY',
      }).success,
    ).toBe(false);
    expect(
      CaptureObservationSchema.safeParse({
        ...observation,
        identity: { ...observation.identity, version: 2 },
      }).success,
    ).toBe(false);
  });
});
