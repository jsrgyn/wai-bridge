import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { DialogueSyncBridge } from '../../src/background/dialogue-sync-bridge.js';
import { extensionBuild } from '../../src/build-info.js';
function setup(
  options: {
    monitor?: boolean;
    tabs?: number;
    invalidResult?: boolean;
    delayedVisibility?: boolean;
  } = {},
) {
  const instance = randomUUID();
  const accountId = randomUUID();
  const job = {
    id: randomUUID(),
    query: 'Synthetic target',
    accountId,
    limit: 50,
    leaseToken: randomUUID(),
    expiresAt: new Date(Date.now() + 30000).toISOString(),
  };
  let probes = 0;
  const frames: Array<{ type: string; input: Record<string, unknown> }> = [];
  const tabs = {
    query: vi.fn(async () =>
      Array.from({ length: options.tabs ?? 1 }, (_, i) => ({ id: i + 1, windowId: 1 })),
    ),
    update: vi.fn(async () => ({})),
    sendMessage: vi.fn(async (_id: number, message: { kind: string }) =>
      message.kind === 'GET_SYNC_CONTEXT'
        ? {
            ok: true,
            monitoring: options.monitor ?? true,
            accountId,
            build: extensionBuild,
            ready: !options.delayedVisibility || ++probes >= 2,
          }
        : options.invalidResult
          ? { arbitrary: 'invalid' }
          : { code: 'OK', observations: [], truncated: false },
    ),
  } as unknown as Pick<typeof chrome.tabs, 'query' | 'update' | 'sendMessage'>;
  const windows = { update: vi.fn(async () => ({})) } as unknown as Pick<
    typeof chrome.windows,
    'update'
  >;
  const bridge = new DialogueSyncBridge(async () => instance, tabs, windows);
  bridge.connect({
    postMessage(raw) {
      const req = raw as { id: string; type: string; input: Record<string, unknown> };
      frames.push(req);
      queueMicrotask(() =>
        bridge.receive({
          id: req.id,
          type: req.type + '_RESULT',
          result:
            req.type === 'SYNC_POLL' ? { pending: true, job: req.input.ready ? job : null } : {},
        }),
      );
    },
  });
  return { bridge, tabs, frames };
}
it('reconciles independently of send opt-in and forwards a single completion', async () => {
  const h = setup();
  await h.bridge.poll();
  expect(h.frames.map((f) => f.type)).toEqual(['SYNC_POLL', 'SYNC_POLL', 'SYNC_COMPLETE']);
  expect(h.frames[2]!.input.code).toBe('OK');
  expect(h.tabs.sendMessage).toHaveBeenCalledWith(
    1,
    expect.objectContaining({ kind: 'SYNC_DIALOGUE' }),
  );
  expect(h.bridge.busy).toBe(false);
});
it.each([{ monitor: false }, { tabs: 2 }])(
  'does not claim or navigate when the monitored tab is unavailable %j',
  async (options) => {
    const h = setup(options);
    await h.bridge.poll();
    expect(h.frames).toHaveLength(1);
    expect(h.tabs.update).not.toHaveBeenCalled();
  },
);
it('turns invalid content output into an explicit failed completion', async () => {
  const h = setup({ invalidResult: true });
  await h.bridge.poll();
  expect(h.frames.at(-1)!.input).toMatchObject({ code: 'INVALID_RESULT', observations: [] });
});

it('waits for a hidden tab to become ready before claiming the synchronization', async () => {
  const h = setup({ delayedVisibility: true });
  await h.bridge.poll();
  expect(h.tabs.sendMessage).toHaveBeenCalledTimes(3);
  expect(h.frames.map((f) => f.type)).toEqual(['SYNC_POLL', 'SYNC_POLL', 'SYNC_COMPLETE']);
});

it('receives the persisted array and executes items in order only after each completion', async () => {
  const accountId = randomUUID(),
    instance = randomUUID(),
    ids = [randomUUID(), randomUUID()],
    batchId = randomUUID(),
    runToken = randomUUID();
  let position = 0;
  const events: string[] = [];
  const jobs = ids.map((_, index) => ({
    id: randomUUID(),
    leaseToken: randomUUID(),
    accountId,
    query: `Synthetic ${index}`,
    limit: 50,
    expiresAt: new Date(Date.now() + 30000).toISOString(),
    batch: { id: batchId, runToken, position: index, total: 2, conversationIds: ids },
  }));
  const tabs = {
    query: vi.fn(async () => [{ id: 1, windowId: 1 }]),
    update: vi.fn(async () => ({})),
    sendMessage: vi.fn(
      async (_id: number, message: { kind: string; job?: (typeof jobs)[number] }) => {
        if (message.kind === 'GET_SYNC_CONTEXT')
          return { ok: true, monitoring: true, accountId, build: extensionBuild, ready: true };
        events.push(`execute:${message.job!.batch.position}`);
        return { code: 'OK', observations: [], truncated: false };
      },
    ),
  } as unknown as Pick<typeof chrome.tabs, 'query' | 'update' | 'sendMessage'>;
  const bridge = new DialogueSyncBridge(async () => instance, tabs, {
    update: vi.fn(async () => ({})),
  } as unknown as Pick<typeof chrome.windows, 'update'>);
  bridge.connect({
    postMessage(raw) {
      const req = raw as {
        id: string;
        type: string;
        input: { ready?: boolean; activeRequestId?: string };
      };
      queueMicrotask(() => {
        if (req.type === 'SYNC_COMPLETE') {
          events.push(`commit:${position}`);
          position++;
        }
        bridge.receive({
          id: req.id,
          type: req.type + '_RESULT',
          result:
            req.type === 'SYNC_POLL'
              ? { pending: position < 2, job: req.input.ready ? (jobs[position] ?? null) : null }
              : {},
        });
      });
    },
  });
  await bridge.poll();
  expect(position).toBe(1);
  await bridge.poll();
  expect(position).toBe(2);
  await bridge.poll();
  expect(events).toEqual(['execute:0', 'commit:0', 'execute:1', 'commit:1']);
  expect(bridge.busy).toBe(false);
});

it('polls the active batch lease and forwards cancellation to the reader without another execution', async () => {
  const accountId = randomUUID(),
    instance = randomUUID(),
    id = randomUUID();
  let finish: ((value: unknown) => void) | undefined;
  const job = {
    id,
    leaseToken: randomUUID(),
    accountId,
    query: 'Synthetic target',
    limit: 50,
    expiresAt: new Date(Date.now() + 30000).toISOString(),
    batch: {
      id: randomUUID(),
      runToken: randomUUID(),
      position: 0,
      total: 1,
      conversationIds: [randomUUID()],
    },
  };
  const frames: Array<{ type: string; input: Record<string, unknown> }> = [];
  const tabs = {
    query: vi.fn(async () => [{ id: 1, windowId: 1 }]),
    update: vi.fn(async () => ({})),
    sendMessage: vi.fn(async (_id: number, message: { kind: string }) => {
      if (message.kind === 'GET_SYNC_CONTEXT')
        return { ok: true, monitoring: true, accountId, build: extensionBuild, ready: true };
      if (message.kind === 'SYNC_CANCEL') {
        finish?.({ code: 'CANCELLED', observations: [], truncated: false });
        return { ok: true };
      }
      return new Promise((resolve) => {
        finish = resolve;
      });
    }),
  } as unknown as Pick<typeof chrome.tabs, 'query' | 'update' | 'sendMessage'>;
  const bridge = new DialogueSyncBridge(async () => instance, tabs, {
    update: vi.fn(async () => ({})),
  } as unknown as Pick<typeof chrome.windows, 'update'>);
  bridge.connect({
    postMessage(raw) {
      const req = raw as { id: string; type: string; input: Record<string, unknown> };
      frames.push(req);
      queueMicrotask(() =>
        bridge.receive({
          id: req.id,
          type: req.type + '_RESULT',
          result:
            req.type === 'SYNC_POLL'
              ? req.input.activeRequestId
                ? { pending: false, job: null, cancelRequestId: id }
                : { pending: true, job: req.input.ready ? job : null }
              : {},
        }),
      );
    },
  });
  await bridge.poll();
  expect(frames.find((f) => f.input.activeRequestId)).toMatchObject({
    input: { activeRequestId: id, leaseToken: job.leaseToken, extensionInstanceId: instance },
  });
  expect(tabs.sendMessage).toHaveBeenCalledWith(1, { kind: 'SYNC_CANCEL', requestId: id });
  expect(frames.at(-1)).toMatchObject({ type: 'SYNC_COMPLETE', input: { code: 'CANCELLED' } });
  expect(bridge.busy).toBe(false);
});
