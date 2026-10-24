import { afterEach, beforeEach, expect, it, vi } from 'vitest';

type Listener = (...args: unknown[]) => unknown;
function listenerSlot() {
  const listeners: Listener[] = [];
  return { listeners, addListener: (fn: Listener) => listeners.push(fn) };
}
function installChrome(existingAlarm: boolean) {
  const posted: { type: string; input?: Record<string, unknown> }[] = [];
  const ports: { onDisconnect: ReturnType<typeof listenerSlot> }[] = [];
  const alarms = {
    created: [] as { name: string; info: unknown }[],
    onAlarm: listenerSlot(),
    get: vi.fn(async () => (existingAlarm ? { name: 'wai-send-keepalive' } : undefined)),
    create: vi.fn((name: string, info: unknown) => {
      alarms.created.push({ name, info });
    }),
  };
  const store: Record<string, unknown> = {};
  const runtime = {
    id: 'abcdefghijklmnopabcdefghijklmnop',
    getURL: (path: string) => `chrome-extension://abc/${path}`,
    onInstalled: listenerSlot(),
    onStartup: listenerSlot(),
    onConnect: listenerSlot(),
    onMessage: listenerSlot(),
    connectNative: vi.fn(() => {
      const port = {
        onMessage: listenerSlot(),
        onDisconnect: listenerSlot(),
        postMessage: (raw: { type: string; input?: Record<string, unknown> }) => posted.push(raw),
      };
      ports.push(port);
      return port;
    }),
  };
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime,
    alarms,
    storage: {
      local: {
        get: vi.fn(async () => ({ ...store })),
        set: vi.fn(async (value: Record<string, unknown>) => void Object.assign(store, value)),
      },
      onChanged: listenerSlot(),
    },
    tabs: {
      query: vi.fn(async () => []),
      sendMessage: vi.fn(),
      onActivated: listenerSlot(),
      onUpdated: listenerSlot(),
    },
    windows: { onFocusChanged: listenerSlot() },
  };
  return { posted, ports, alarms, runtime };
}
const flush = () => vi.advanceTimersByTimeAsync(0);
beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
});
afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as { chrome?: unknown }).chrome;
});

it('registers the keepalive alarm at startup, onInstalled and onStartup without duplicating it', async () => {
  const env = installChrome(false);
  await import('../../src/background/service-worker.js');
  await flush();
  expect(env.alarms.created).toEqual([
    { name: 'wai-send-keepalive', info: { periodInMinutes: 0.5 } },
  ]);
  const present = installChrome(true);
  vi.resetModules();
  await import('../../src/background/service-worker.js');
  await flush();
  for (const fn of present.runtime.onInstalled.listeners) await fn();
  for (const fn of present.runtime.onStartup.listeners) await fn();
  expect(present.alarms.create).not.toHaveBeenCalled();
  expect(present.alarms.get).toHaveBeenCalledTimes(3);
});

it('alarm tick reconnects port and polls', async () => {
  const env = installChrome(true);
  await import('../../src/background/service-worker.js');
  await flush();
  expect(env.runtime.connectNative).toHaveBeenCalledTimes(1);
  // Native port dropped while the worker was alive.
  for (const fn of env.ports[0]!.onDisconnect.listeners) fn();
  await flush();
  env.posted.length = 0;
  for (const fn of env.alarms.onAlarm.listeners) void fn({ name: 'other-alarm' });
  await flush();
  expect(env.runtime.connectNative).toHaveBeenCalledTimes(1);
  for (const fn of env.alarms.onAlarm.listeners) void fn({ name: 'wai-send-keepalive' });
  await flush();
  await flush();
  expect(env.runtime.connectNative).toHaveBeenCalledTimes(2);
  const poll = env.posted.find((item) => item.type === 'SEND_POLL');
  expect(poll?.input).toMatchObject({ reason: 'NO_WHATSAPP_TAB', ready: false });
});
