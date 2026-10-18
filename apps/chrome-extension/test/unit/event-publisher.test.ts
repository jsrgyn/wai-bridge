import { describe, expect, it } from 'vitest';
import { EventPublisher } from '../../src/background/event-publisher.js';

const observation = {
  kind: 'CAPTURE_OBSERVATION' as const,
  observationId: '11111111-1111-4111-8111-111111111111',
  observedAt: '2026-10-17T12:00:00.000Z',
  observationType: 'MESSAGE' as const,
  captureState: 'CAPTURED' as const,
  conversation: { label: 'Synthetic conversation', kind: 'INDIVIDUAL' as const },
  senderLabel: 'Synthetic contact',
  direction: 'INBOUND' as const,
  content: 'New synthetic content',
  contentAvailability: 'AVAILABLE' as const,
  media: [] as [],
};

describe('durable extension publisher', () => {
  it('keeps queued observations across disconnect and removes them only after persisted ACK', async () => {
    const values: Record<string, unknown> = {};
    const storage = {
      get: async (key: string) => ({ [key]: values[key] }),
      set: async (items: Record<string, unknown>) => { Object.assign(values, items); },
    };
    const sent: unknown[] = [];
    const publisher = new EventPublisher(storage);
    await publisher.enqueue(observation);
    expect(values.waiBridgeCaptureQueue).toHaveLength(1);
    await publisher.connect({ postMessage: (message) => sent.push(message) }, '22222222-2222-4222-8222-222222222222');
    expect(sent).toHaveLength(1);
    publisher.disconnect();
    const recovered = new EventPublisher(storage);
    await recovered.connect({ postMessage: (message) => sent.push(message) }, '22222222-2222-4222-8222-222222222222');
    expect(sent).toHaveLength(2);
    await recovered.acknowledge(observation.observationId, '33333333-3333-4333-8333-333333333333');
    expect(values.waiBridgeCaptureQueue).toEqual([]);
  });
});
