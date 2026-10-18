import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { makeFlowLog, BufferedFlowReporter, emitFlow } from '@wai-bridge/shared';
import { FlowLogPublisher } from '../../src/background/flow-log-publisher.js';
afterEach(() => vi.useRealTimers());
const event = () =>
  makeFlowLog({
    traceId: randomUUID(),
    component: 'EXTENSION_BACKGROUND',
    phase: 'SEND_ACCEPTED',
    outcome: 'SUCCEEDED',
    code: 'ACCEPTED',
  });
it('buffers separately, retries the same log IDs and removes only an authenticated matching ACK batch', async () => {
  vi.useFakeTimers();
  const values: Record<string, unknown> = {};
  const storage = {
    get: async () => ({ ...values }),
    set: async (items: Record<string, unknown>) => {
      Object.assign(values, items);
    },
  };
  const frames: { id: string; events: { id: string }[] }[] = [];
  const logs = new FlowLogPublisher(storage);
  const first = event();
  await logs.enqueue(first);
  logs.connect({ postMessage: (raw) => frames.push(raw as (typeof frames)[number]) }, randomUUID());
  await vi.advanceTimersByTimeAsync(201);
  expect(frames).toHaveLength(1);
  expect(logs.receive({ id: randomUUID(), type: 'FLOW_LOGS_RESULT', accepted: 1 })).toBe(false);
  await vi.advanceTimersByTimeAsync(4001);
  expect(frames).toHaveLength(2);
  expect(frames[1]!.events.map((e) => e.id)).toEqual([first.id]);
  logs.receive({ id: frames[1]!.id, type: 'FLOW_LOGS_RESULT', accepted: 1 });
  await vi.advanceTimersByTimeAsync(201);
  expect(values.waiBridgeFlowLogQueue).toEqual([]);
  logs.disconnect();
});
it('caps diagnostic queues and never throws log-sink errors into execution', async () => {
  const values: Record<string, unknown> = {};
  const logs = new FlowLogPublisher({
    get: async () => ({ ...values }),
    set: async (items) => {
      Object.assign(values, items);
    },
  });
  for (let i = 0; i < 205; i++) await logs.enqueue(event());
  expect(values.waiBridgeFlowLogQueue as unknown[]).toHaveLength(200);
  expect(() =>
    emitFlow(
      () => {
        throw new Error('SYNTHETIC_LOG_FAILURE');
      },
      {
        traceId: randomUUID(),
        component: 'WHATSAPP_UI',
        phase: 'SENDING',
        outcome: 'STARTED',
        code: 'OK',
      },
    ),
  ).not.toThrow();
  logs.disconnect();
});
it('node/universal reporting retries only telemetry with bounded buffering', async () => {
  vi.useFakeTimers();
  let fail = true;
  const batches: unknown[][] = [];
  const reporter = new BufferedFlowReporter(async (batch) => {
    batches.push(batch);
    if (fail) throw new Error('SYNTHETIC_UNAVAILABLE');
  });
  reporter.emit(event());
  await reporter.flush();
  expect(batches).toHaveLength(1);
  fail = false;
  await vi.advanceTimersByTimeAsync(1001);
  expect(batches.length).toBeGreaterThan(1);
  reporter.dispose();
});
