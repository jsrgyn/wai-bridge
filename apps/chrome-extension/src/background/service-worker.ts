import { ExtensionStateSchema, type ExtensionState } from '../contracts.js';
import { z } from 'zod';
import { parseCaptureObservation, parsePopupCommand } from '../messaging/protocol.js';
import { NATIVE_HOST_NAME, NativeResponseSchema } from '../platform/native-messaging-adapter.js';
import { EventPublisher } from './event-publisher.js';

const extensionInstanceIdKey = 'waiBridgeExtensionInstanceId';
const publisher = new EventPublisher(chrome.storage.local);
let nativePort: chrome.runtime.Port | undefined;
let reconnectDelay = 1_000;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
const DEFAULT_STATE: ExtensionState = {
  monitoring: false,
  connection: 'UNCONFIGURED',
  activities: [],
  errors: [],
  retainActivitySummaries: true,
};

async function getState(): Promise<ExtensionState> {
  const stored = await chrome.storage.local.get('waiBridgeState');
  const parsed = ExtensionStateSchema.safeParse(stored.waiBridgeState);
  return parsed.success ? parsed.data : DEFAULT_STATE;
}

async function getExtensionInstanceId(): Promise<string> {
  const stored = await chrome.storage.local.get(extensionInstanceIdKey);
  const existing = stored[extensionInstanceIdKey];
  if (typeof existing === 'string' && z.string().uuid().safeParse(existing).success) return existing;
  const created = crypto.randomUUID();
  await chrome.storage.local.set({ [extensionInstanceIdKey]: created });
  return created;
}

async function saveState(state: ExtensionState): Promise<void> {
  await chrome.storage.local.set({ waiBridgeState: state });
}

function withError(state: ExtensionState, message: string): ExtensionState {
  return { ...state, errors: [message.slice(0, 160), ...state.errors].slice(0, 5) };
}

async function applyMonitoring(enabled: boolean): Promise<ExtensionState> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) throw new Error('No active tab is available.');
  const reply: unknown = await chrome.tabs.sendMessage(tab.id, { kind: 'MONITOR_CONTROL', enabled });
  if (!reply || typeof reply !== 'object' || !('ok' in reply) || reply.ok !== true) {
    throw new Error('The selected tab did not accept the monitor command.');
  }
  const current = await getState();
  const updated = { ...current, monitoring: enabled };
  await saveState(updated);
  return updated;
}

async function updateConnection(connection: ExtensionState['connection']): Promise<void> {
  const state = await getState();
  await saveState({ ...state, connection });
}

async function connectNative(): Promise<void> {
  if (nativePort) return;
  try {
    const port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    nativePort = port;
    const extensionInstanceId = await getExtensionInstanceId();
    port.onMessage.addListener((raw: unknown) => {
      const parsed = NativeResponseSchema.safeParse(raw);
      if (!parsed.success) {
        void updateConnection('DISCONNECTED');
        return;
      }
      if (parsed.data.type === 'HOST_STATE') {
        reconnectDelay = 1_000;
        void updateConnection(parsed.data.connected ? 'CONNECTED' : 'DISCONNECTED');
        if (parsed.data.connected) void publisher.connect(port, extensionInstanceId);
      }
      if (parsed.data.type === 'CAPTURE_RESULT') void publisher.acknowledge(parsed.data.observationId, parsed.data.eventId);
      if (parsed.data.type === 'ERROR') {
        if (parsed.data.code === 'API_UNAVAILABLE') publisher.retryLater(parsed.data.id);
        else void updateConnection('DISCONNECTED');
      }
    });
    port.onDisconnect.addListener(() => {
      nativePort = undefined;
      publisher.disconnect();
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
      void updateConnection('DISCONNECTED');
      if (!reconnectTimer) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = undefined;
          reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
          void connectNative();
        }, reconnectDelay);
      }
    });
    port.postMessage({ version: 1, id: crypto.randomUUID(), type: 'HELLO', extensionInstanceId });
    heartbeatTimer = setInterval(() => {
      nativePort?.postMessage({ version: 1, id: crypto.randomUUID(), type: 'HEARTBEAT', extensionInstanceId });
    }, 20_000);
  } catch {
    nativePort = undefined;
    await updateConnection('DISCONNECTED');
    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
        void connectNative();
      }, reconnectDelay);
    }
  }
}

chrome.runtime.onMessage.addListener((raw, sender, respond) => {
  const command = parsePopupCommand(raw);
  if (command.success) {
    if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(`chrome-extension://${chrome.runtime.id}/`)) {
      respond({ ok: false, error: 'UNAUTHORIZED_SENDER' });
      return;
    }
    void (async () => {
      try {
        const result = command.data.command === 'GET_STATE'
          ? await getState()
          : await applyMonitoring(command.data.command === 'MONITOR_START');
        respond({ ok: true, state: result });
      } catch {
        const updated = withError(await getState(), 'Unable to reach the selected page.');
        await saveState(updated);
        respond({ ok: false, state: updated });
      }
    })();
    return true;
  }

  const observation = parseCaptureObservation(raw);
  if (observation.success) {
    if (sender.origin !== 'https://web.whatsapp.com' || sender.tab?.id === undefined) {
      respond({ ok: false, error: 'UNAUTHORIZED_SENDER' });
      return;
    }
    void (async () => {
      try {
        await publisher.enqueue(observation.data);
        const current = await getState();
        const next = {
          ...current,
          activities: current.retainActivitySummaries
            ? [{ label: `${observation.data.captureState.toLowerCase()} observation queued`, timestamp: observation.data.observedAt }, ...current.activities].slice(0, 20)
            : current.activities,
        };
        await saveState(next);
        respond({ ok: true });
      } catch {
        const updated = withError(await getState(), 'Capture queue could not persist an observation.');
        await saveState(updated);
        respond({ ok: false, error: 'CAPTURE_QUEUE_UNAVAILABLE' });
      }
    })();
    return true;
  }

  if (sender.origin === 'https://web.whatsapp.com' && raw && typeof raw === 'object' && 'kind' in raw && raw.kind === 'CONTENT_ERROR') {
    void getState().then((state) => saveState(withError(state, 'The page structure is not supported.'))).then(() => respond({ ok: true }));
    return true;
  }
  respond({ ok: false, error: 'INVALID_MESSAGE' });
});

chrome.runtime.onInstalled.addListener(() => {
  void getState().then((state) => saveState({ ...state, monitoring: false }));
  void connectNative();
});

chrome.runtime.onStartup.addListener(() => void connectNative());
void connectNative();
