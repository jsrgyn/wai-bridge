import { describe, expect, it, vi } from 'vitest';
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
      set: async (items: Record<string, unknown>) => {
        Object.assign(values, items);
      },
    };
    const sent: unknown[] = [];
    const publisher = new EventPublisher(storage);
    await publisher.enqueue(observation);
    expect(values.waiBridgeCaptureQueue).toHaveLength(1);
    await publisher.connect(
      { postMessage: (message) => sent.push(message) },
      '22222222-2222-4222-8222-222222222222',
    );
    expect(sent).toHaveLength(1);
    publisher.disconnect();
    const recovered = new EventPublisher(storage);
    await recovered.connect(
      { postMessage: (message) => sent.push(message) },
      '22222222-2222-4222-8222-222222222222',
    );
    expect(sent).toHaveLength(2);
    await recovered.acknowledge(observation.observationId, '33333333-3333-4333-8333-333333333333');
    expect(values.waiBridgeCaptureQueue).toEqual([]);
  });
});

it('retries a lost capture ACK without changing the observation ID and unblocks later events', async () => {
  vi.useFakeTimers();
  const values: Record<string, unknown> = {};
  const sent: Array<{ id: string }> = [];
  const publisher = new EventPublisher({
    get: async (key) => ({ [key]: values[key] }),
    set: async (data) => {
      Object.assign(values, data);
    },
  });
  try {
    await publisher.enqueue(observation);
    await publisher.enqueue({
      ...observation,
      observationId: '44444444-4444-4444-8444-444444444444',
    });
    await publisher.connect(
      {
        postMessage: (m) => {
          sent.push(m as { id: string });
        },
      },
      '22222222-2222-4222-8222-222222222222',
    );
    await vi.advanceTimersByTimeAsync(5001);
    expect(sent.map((e) => e.id)).toEqual([observation.observationId, observation.observationId]);
    expect(values.waiBridgeCaptureQueue).toHaveLength(2);
    await publisher.acknowledge(observation.observationId, '33333333-3333-4333-8333-333333333333');
    expect(sent.at(-1)?.id).toBe('44444444-4444-4444-8444-444444444444');
    await publisher.acknowledge(
      '44444444-4444-4444-8444-444444444444',
      '55555555-5555-4555-8555-555555555555',
    );
    expect(values.waiBridgeCaptureQueue).toEqual([]);
  } finally {
    publisher.disconnect();
    vi.useRealTimers();
  }
});
it('quarantines invalid entries and exposes durable diagnostics across restart',async()=>{const values:Record<string,unknown>={waiBridgeCaptureQueue:[{broken:true},observation]};const storage={get:async(key:string)=>({[key]:values[key]}),set:async(data:Record<string,unknown>)=>{Object.assign(values,data);}};const publisher=new EventPublisher(storage);const info=await publisher.diagnostics();expect(info).toMatchObject({pending:1,quarantined:1,possibleGaps:true,complete:false});expect(values.waiBridgeCaptureQueue).toHaveLength(1);expect((await new EventPublisher(storage).diagnostics()).quarantined).toBe(1);});
it('bounds durable capacity and preserves already accepted observations on overflow',async()=>{const values:Record<string,unknown>={};const storage={get:async(key:string)=>({[key]:values[key]}),set:async(data:Record<string,unknown>)=>{Object.assign(values,data);}};const publisher=new EventPublisher(storage,{maxItems:100,maxBytes:65536});for(let i=0;i<100;i++)await publisher.enqueue({...observation,observationId:crypto.randomUUID()});await expect(publisher.enqueue({...observation,observationId:crypto.randomUUID()})).rejects.toThrow('CAPTURE_QUEUE_FULL');expect((await publisher.diagnostics())).toMatchObject({pending:100,overflowCount:1,possibleGaps:true});});
it('keeps the ACK watchdog alive after a transient storage failure and recovers without losing data',async()=>{vi.useFakeTimers();const values:Record<string,unknown>={};let fail=false;const sent:unknown[]=[];const publisher=new EventPublisher({get:async key=>({[key]:values[key]}),set:async data=>{if(fail)throw Error('synthetic storage outage');Object.assign(values,data);}});try{await publisher.enqueue(observation);await publisher.connect({postMessage:frame=>sent.push(frame)},crypto.randomUUID());fail=true;await expect(publisher.acknowledge(observation.observationId,crypto.randomUUID())).rejects.toThrow();expect(values.waiBridgeCaptureQueue).toHaveLength(1);fail=false;await vi.advanceTimersByTimeAsync(5001);expect(sent).toHaveLength(2);await publisher.acknowledge(observation.observationId,crypto.randomUUID());expect(await publisher.diagnostics()).toMatchObject({pending:0,storageErrorCount:1,possibleGaps:true});}finally{publisher.disconnect();vi.useRealTimers();}});
