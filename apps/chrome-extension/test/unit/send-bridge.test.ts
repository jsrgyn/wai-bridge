import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { ExtensionSendBridge } from '../../src/background/send-bridge.js';
afterEach(() => vi.useRealTimers());
function setup() {
  const extensionInstanceId = randomUUID();
  const identity = {
    version: 1 as const,
    type: 'PHONE' as const,
    source: 'PROFILE_PHONE' as const,
    phone: '+12025550199',
    accountId: randomUUID(),
    contextId: randomUUID(),
    confirmedAt: new Date().toISOString(),
  };
  const command = {
    id: randomUUID(),
    conversationId: randomUUID(),
    leaseToken: randomUUID(),
    contextId: identity.contextId,
    target: { accountId: identity.accountId, type: 'PHONE', referenceKey: identity.phone },
    text: 'Synthetic reply',
    mode: 'SUPERVISED',
    explicitAuthorization: true,
    leaseUntil: new Date(Date.now() + 180000).toISOString(),
    timing: {
      autoCountdownMs: 5000,
      executionTimeoutMs: 60000,
      queueMaxWaitMs: 1800000,
      sendVerifyMs: 15000,
    },
    appendToDraft: false,
  };
  const state = {
    enabled: true,
    ready: true,
    queued: true,
    phase: 'CLAIMED',
    executions: 0,
    cancels: 0,
    activations: 0,
    focus: 0,
    contextHung: false,
    contextGone: false,
    executing: undefined as string | null | undefined,
    acceptanceHung: false,
    tabs: [{ id: 5, windowId: 1, url: 'https://web.whatsapp.com/' }],
    requests: [] as { type: string; input: Record<string, unknown> }[],
  };
  const tabs = {
    query: vi.fn(async (query: unknown) => {
      expect(query).toEqual({ url: 'https://web.whatsapp.com/*' });
      return state.tabs;
    }),
    update: vi.fn(async () => {
      state.activations++;
    }),
    sendMessage: vi.fn(async (_id: number, message: { kind: string }) => {
      if (message.kind === 'SEND_CONTEXT') {
        if (state.contextHung) return new Promise(() => {});
        if (state.contextGone) throw new Error('Could not establish connection.');
        return {
          ok: true,
          identity,
          ready: state.ready,
          ...(state.executing !== undefined ? { executing: state.executing } : {}),
        };
      }
      if (message.kind === 'SEND_CANCEL') {
        state.cancels++;
        return { ok: true };
      }
      expect(message.kind).toBe('SEND_EXECUTE');
      state.executions++;
      if (state.acceptanceHung) return new Promise(() => {});
      return { ok: true, accepted: true };
    }),
  } as unknown as Pick<typeof chrome.tabs, 'query' | 'sendMessage' | 'update'>;
  const bridge = new ExtensionSendBridge(
    async () => extensionInstanceId,
    tabs,
    { get: async () => ({ waiExtensionSendsEnabled: state.enabled }) } as Pick<
      typeof chrome.storage.local,
      'get'
    >,
    {
      update: async () => {
        state.focus++;
        state.ready = true;
      },
    } as unknown as Pick<typeof chrome.windows, 'update'>,
  );
  bridge.connect({
    postMessage: (raw) => {
      const req = raw as { id: string; type: string; input: Record<string, unknown> };
      state.requests.push(req);
      let result: unknown;
      if (req.type === 'SEND_PROGRESS') {
        state.phase = String(req.input.step);
        if (['CANCELLED', 'FAILED', 'SENT', 'UNKNOWN', 'DRAFTED'].includes(state.phase)) state.queued = false;
        result = { ok: true, status: state.phase };
      } else if (req.input.activeCommand) result = { command: null, activeStatus: state.phase };
      else if (!req.input.identity || !req.input.allowClaim || !state.queued)
        result = { command: null };
      else result = req.input.ready ? { command } : { command: null, pending: true };
      queueMicrotask(() =>
        bridge.receive({
          id: req.id,
          type: req.type === 'SEND_POLL' ? 'SEND_POLL_RESULT' : 'SEND_PROGRESS_RESULT',
          result,
        }),
      );
    },
  });
  return { bridge, state, identity, command, extensionInstanceId };
}
it('bridge releases active job on DRAFTED and polls next', async () => {
  const { bridge, state, command, extensionInstanceId } = setup();
  await bridge.poll();
  expect(state.executions).toBe(1);
  const result = await bridge.progress(
    {
      extensionInstanceId,
      commandId: command.id,
      contextId: command.contextId,
      leaseToken: command.leaseToken,
      step: 'DRAFTED',
      code: 'DRAFT_READY',
    },
    5,
  );
  expect(result.status).toBe('DRAFTED');
  expect(bridge.busy).toBe(false);
  state.queued = true;
  await bridge.poll();
  expect(state.executions).toBe(2);
  expect(state.requests.at(-1)?.input.activeCommand).toBeUndefined();
  bridge.disconnect();
});
it('acknowledges acceptance immediately and keeps polling authoritative cancellation while active', async () => {
  const { bridge, state, command, extensionInstanceId } = setup();
  await bridge.poll();
  expect(state.executions).toBe(1);
  const progress = {
    extensionInstanceId,
    commandId: command.id,
    contextId: command.contextId,
    leaseToken: command.leaseToken,
    step: 'WAITING_AUTO_SEND',
    code: 'SYNTHETIC_WAIT',
  };
  await expect(bridge.progress(progress, 6)).rejects.toThrow('SEND_NOT_ACTIVE');
  await bridge.progress(progress, 5);
  await bridge.poll();
  expect(state.executions).toBe(1);
  expect(state.requests.at(-1)?.input.activeCommand).toMatchObject({ id: command.id });
  state.phase = 'CANCELLED';
  state.queued = false;
  await bridge.poll();
  expect(state.cancels).toBe(1);
  await bridge.progress({ ...progress, step: 'CANCELLED' }, 5); // retry remains authorized after terminal ACK
  await bridge.poll();
  expect(state.executions).toBe(1);
  bridge.disconnect();
});
it('finds a hidden existing WhatsApp tab and activates it only for one authorized pending intent', async () => {
  const { bridge, state } = setup();
  state.ready = false;
  state.queued = false;
  await bridge.poll();
  expect(state.focus).toBe(0);
  state.queued = true;
  await bridge.poll();
  expect(state.focus).toBe(1);
  expect(state.activations).toBe(1);
  expect(state.executions).toBe(0);
  await bridge.poll();
  expect(state.executions).toBe(1);
  await bridge.poll();
  expect(state.executions).toBe(1);
  bridge.disconnect();
});
it('does not focus or deliver with opt-out or ambiguous matching tabs', async () => {
  const { bridge, state } = setup();
  state.enabled = false;
  state.ready = false;
  await bridge.poll();
  expect(state.focus).toBe(0);
  expect(state.executions).toBe(0);
  state.enabled = true;
  state.tabs.push({ id: 6, windowId: 2, url: 'https://web.whatsapp.com/' });
  await bridge.poll();
  expect(state.focus).toBe(0);
  expect(state.executions).toBe(0);
  expect(state.requests.at(-1)?.input.reason).toBe('AMBIGUOUS_TABS');
  bridge.disconnect();
});
it('bounds an unresponsive content script and recovers polling without restarting the worker', async () => {
  vi.useFakeTimers();
  const { bridge, state } = setup();
  state.contextHung = true;
  const first = bridge.poll();
  await vi.advanceTimersByTimeAsync(1600);
  await first;
  expect(state.requests.at(-1)?.input.reason).toBe('CONTENT_UNREACHABLE');
  state.contextHung = false;
  await bridge.poll();
  expect(state.executions).toBe(1);
  bridge.disconnect();
});
it('never redelivers after a lost acceptance ACK and still polls the claimed command', async () => {
  vi.useFakeTimers();
  const { bridge, state } = setup();
  state.acceptanceHung = true;
  const first = bridge.poll();
  await vi.advanceTimersByTimeAsync(1600);
  await first;
  await bridge.poll();
  expect(state.executions).toBe(1);
  expect(state.requests.at(-1)?.input.activeCommand).toBeTruthy();
  bridge.disconnect();
});
it('tab reload during COMPOSED (WAITING_USER) drops active and next poll omits activeCommand', async () => {
  const { bridge, state, command, extensionInstanceId } = setup();
  await bridge.poll();
  await bridge.progress(
    {
      extensionInstanceId,
      commandId: command.id,
      contextId: command.contextId,
      leaseToken: command.leaseToken,
      step: 'WAITING_USER',
      code: 'SYNTHETIC_WAIT',
    },
    5,
  );
  expect(bridge.busy).toBe(true);
  state.contextGone = true; // reloading tab: no receiving end
  state.queued = false;
  await bridge.poll();
  expect(state.requests.at(-1)?.input.activeCommand).toBeUndefined();
  expect(bridge.busy).toBe(false);
  state.contextGone = false;
  state.executing = null; // reloaded page has no job
  await bridge.poll();
  expect(state.requests.at(-1)?.input).toMatchObject({ reason: 'READY', visible: true });
  expect(state.requests.at(-1)?.input.activeCommand).toBeUndefined();
  bridge.disconnect();
});
it('a reloaded content script that reports no job also drops active', async () => {
  const { bridge, state } = setup();
  await bridge.poll();
  state.executing = null;
  state.queued = false;
  await bridge.poll();
  expect(state.requests.at(-1)?.input.activeCommand).toBeUndefined();
  expect(bridge.busy).toBe(false);
  bridge.disconnect();
});
it('keeps active when the content script merely times out (never risks a double send)', async () => {
  vi.useFakeTimers();
  const { bridge, state } = setup();
  await bridge.poll();
  state.contextHung = true;
  const next = bridge.poll();
  await vi.advanceTimersByTimeAsync(1600);
  await next;
  expect(state.requests.at(-1)?.input.activeCommand).toBeTruthy();
  expect(bridge.busy).toBe(true);
  expect(state.executions).toBe(1);
  bridge.disconnect();
});
it('reports NO_WHATSAPP_TAB even when no tab exists', async () => {
  const { bridge, state } = setup();
  state.tabs.length = 0;
  await bridge.poll();
  expect(state.requests.at(-1)?.input).toMatchObject({ reason: 'NO_WHATSAPP_TAB', ready: false });
  bridge.disconnect();
});
