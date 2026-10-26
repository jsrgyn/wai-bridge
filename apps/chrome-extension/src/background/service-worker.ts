import { ManagementBridge } from './management-bridge.js';
import { ManagementRequestSchema, UiCompatibilitySchema } from '@wai-bridge/shared';
declare const __WAI_BUILD_ID__: string;
import { DialogueSyncBridge } from './dialogue-sync-bridge.js';
import { FlowLogPublisher } from './flow-log-publisher.js';
import { FlowLogSchema, emitFlow, flowCode, type FlowLogSink } from '@wai-bridge/shared';
import type { SearchDiagnosticEntry } from '@wai-bridge/shared';
import { recordSearchDiagnostic, requestSearchStructure } from './search-diagnostics.js';
import { ExtensionSendBridge } from './send-bridge.js';
import { ExtensionStateSchema, IdentityControlSchema, type ExtensionState } from '../contracts.js';
import { z } from 'zod';
import { parseCaptureObservation, parsePopupCommand } from '../messaging/protocol.js';
import { NATIVE_HOST_NAME, NativeResponseSchema } from '../platform/native-messaging-adapter.js';
import { EventPublisher } from './event-publisher.js';
import { activeMonitorStatus } from './monitor-status.js';

const extensionInstanceIdKey = 'waiBridgeExtensionInstanceId';
const managementBridge = new ManagementBridge();
const publisher = new EventPublisher(chrome.storage.local);
const flowPublisher = new FlowLogPublisher(chrome.storage.local);
const flowSink: FlowLogSink = (event) => {
  void flowPublisher.enqueue(event).catch(() => console.warn('WAI_FLOW_LOG_QUEUE_UNAVAILABLE'));
};
const sendBridge = new ExtensionSendBridge(
  getExtensionInstanceId,
  chrome.tabs,
  chrome.storage.local,
  chrome.windows,
  flowSink,
  async (tabId, code) => {
    try {
      await recordSearchDiagnostic(
        chrome.tabs,
        chrome.storage.local,
        tabId,
        code as SearchDiagnosticEntry['code'],
      );
    } catch {
      console.warn('WAI_SEARCH_DIAGNOSTIC_UNAVAILABLE');
    }
  },
);
const syncBridge = new DialogueSyncBridge(getExtensionInstanceId, chrome.tabs, chrome.windows);
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
  if (typeof existing === 'string' && z.string().uuid().safeParse(existing).success)
    return existing;
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
  const reply: unknown = await chrome.tabs.sendMessage(tab.id, {
    kind: 'MONITOR_CONTROL',
    enabled,
  });
  if (!reply || typeof reply !== 'object' || !('ok' in reply) || reply.ok !== true) {
    throw new Error('The selected tab did not accept the monitor command.');
  }
  const current = await getState();
  const updated = { ...current, monitoring: enabled };
  await chrome.storage.local.set({ waiMonitoringIntent: enabled });
  await saveState({ ...updated, errors: [] });
  return activeMonitorStatus({ ...updated, errors: [] }, chrome.tabs);
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
    managementBridge.connect(port);
    sendBridge.connect(port);
    syncBridge.connect(port);
    const extensionInstanceId = await getExtensionInstanceId();
    port.onMessage.addListener((raw: unknown) => {
      const parsed = NativeResponseSchema.safeParse(raw);
      if (!parsed.success) {
        void updateConnection('DISCONNECTED');
        return;
      }
      if (managementBridge.receive(parsed.data)) return;
      if (flowPublisher.receive(parsed.data)) return;
      if (sendBridge.receive(parsed.data)) return;
      if (syncBridge.receive(parsed.data)) return;
      if (parsed.data.type === 'HOST_STATE') {
        reconnectDelay = 1_000;
        void updateConnection(parsed.data.connected ? 'CONNECTED' : 'DISCONNECTED');
        if (parsed.data.connected) {
          flowPublisher.connect(port, extensionInstanceId);
          void publisher.connect(port, extensionInstanceId);
          if (!syncBridge.busy) void sendBridge.poll();
        }
      }
      if (parsed.data.type === 'CAPTURE_RESULT')
        void publisher.acknowledge(parsed.data.observationId, parsed.data.eventId);
      if (parsed.data.type === 'ERROR') {
        if (parsed.data.code === 'API_UNAVAILABLE') publisher.retryLater(parsed.data.id);
        else void updateConnection('DISCONNECTED');
      }
    });
    port.onDisconnect.addListener(() => {
      nativePort = undefined;
      managementBridge.disconnect();
      publisher.disconnect();
      flowPublisher.disconnect();
      sendBridge.disconnect();
      syncBridge.disconnect();
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
      void extensionTelemetry()
        .then((telemetry) =>
          nativePort?.postMessage({
            version: 1,
            id: crypto.randomUUID(),
            type: 'HEARTBEAT',
            extensionInstanceId,
            telemetry,
          }),
        )
        .catch(() => undefined);
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

setInterval(() => {
  if (syncBridge.busy) return;
  void (async () => {
    await sendBridge.poll();
    if (!sendBridge.busy) await syncBridge.poll();
  })();
}, 1000);
chrome.tabs.onActivated?.addListener(() => {
  if (!syncBridge.busy) void sendBridge.poll();
});
chrome.tabs.onUpdated?.addListener((_tabId, change) => {
  if (change.status === 'complete') if (!syncBridge.busy) void sendBridge.poll();
});
chrome.windows?.onFocusChanged?.addListener(() => {
  if (!syncBridge.busy) void sendBridge.poll();
});
chrome.storage.onChanged?.addListener((changes, area) => {
  if (
    area === 'local' &&
    ('waiExtensionSendsEnabled' in changes || 'waiMonitoringIntent' in changes)
  )
    if (!syncBridge.busy) void sendBridge.poll();
});
async function extensionTelemetry() {
  const queue = await publisher.diagnostics();
  const tabs = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });
  let compatibility;
  const tab = tabs.length === 1 ? tabs[0] : undefined;
  if (tab?.id !== undefined) {
    try {
      const reply = await chrome.tabs.sendMessage(tab.id, { kind: 'GET_COMPATIBILITY' });
      const parsed = UiCompatibilitySchema.safeParse(reply?.compatibility);
      if (parsed.success) compatibility = parsed.data;
    } catch {
      /* Old or unloaded content scripts are displayed as unavailable. */
    }
  }
  return {
    queue,
    ...(compatibility ? { compatibility } : {}),
    build: typeof __WAI_BUILD_ID__ === 'string' ? __WAI_BUILD_ID__ : 'unknown',
  };
}
const DashboardPortRequestSchema = z
  .object({ requestId: z.uuid(), input: ManagementRequestSchema })
  .strict();
chrome.runtime.onConnect.addListener((port) => {
  if (
    port.name !== 'wai-dashboard-v1' ||
    port.sender?.id !== chrome.runtime.id ||
    port.sender.url !== chrome.runtime.getURL('dashboard.html')
  ) {
    port.disconnect();
    return;
  }
  port.onMessage.addListener((raw: unknown) => {
    const parsed = DashboardPortRequestSchema.safeParse(raw);
    if (!parsed.success) {
      port.postMessage({ requestId: crypto.randomUUID(), error: 'INVALID_REQUEST' });
      return;
    }
    void (async () => {
      try {
        const result = await managementBridge.request(
          parsed.data.input,
          await getExtensionInstanceId(),
        );
        const value =
          parsed.data.input.operation === 'SUMMARY'
            ? { data: result, extension: await extensionTelemetry() }
            : result;
        port.postMessage({ requestId: parsed.data.requestId, result: value });
      } catch (error) {
        port.postMessage({
          requestId: parsed.data.requestId,
          error: error instanceof Error ? error.message : 'MANAGEMENT_FAILED',
        });
      }
    })();
  });
});
chrome.runtime.onMessage.addListener((raw, sender, respond) => {
  if (raw?.kind === 'MANAGEMENT') {
    if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('dashboard.html')) {
      respond({ ok: false, error: 'UNAUTHORIZED_SENDER' });
      return;
    }
    const parsed = ManagementRequestSchema.safeParse(raw.input);
    if (!parsed.success) {
      respond({ ok: false, error: 'INVALID_REQUEST' });
      return;
    }
    void (async () => {
      const result = await managementBridge.request(parsed.data, await getExtensionInstanceId());
      return parsed.data.operation === 'SUMMARY'
        ? { data: result, extension: await extensionTelemetry() }
        : result;
    })()
      .then((result) => respond({ ok: true, result }))
      .catch((error) =>
        respond({ ok: false, error: error instanceof Error ? error.message : 'MANAGEMENT_FAILED' }),
      );
    return true;
  }

  if (raw?.kind === 'SEARCH_DIAGNOSE') {
    if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('dashboard.html')) {
      respond({ ok: false, error: 'UNAUTHORIZED_SENDER' });
      return;
    }
    void (async () => {
      const tabs = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });
      if (tabs.length !== 1 || tabs[0]!.id === undefined) throw new Error('NO_SINGLE_WHATSAPP_TAB');
      return requestSearchStructure(chrome.tabs, tabs[0]!.id);
    })()
      .then((report) => respond({ ok: true, report }))
      .catch((error) =>
        respond({
          ok: false,
          error:
            error instanceof Error && /^[A-Z_]{1,64}$/.test(error.message)
              ? error.message
              : 'SEARCH_DIAGNOSTIC_FAILED',
        }),
      );
    return true;
  }
  if (raw?.kind === 'FLOW_LOG') {
    const event = FlowLogSchema.safeParse(raw.event);
    if (
      sender.id !== chrome.runtime.id ||
      sender.origin !== 'https://web.whatsapp.com' ||
      sender.tab?.id === undefined ||
      !event.success ||
      !['EXTENSION_CONTENT', 'WHATSAPP_UI'].includes(event.data.component)
    ) {
      respond({ ok: false });
      return;
    }
    void flowPublisher
      .enqueue(event.data)
      .then(() => respond({ ok: true }))
      .catch(() => respond({ ok: false }));
    return true;
  }
  if (raw?.kind === 'SEND_WAKE') {
    if (
      sender.id === chrome.runtime.id &&
      sender.origin === 'https://web.whatsapp.com' &&
      sender.tab?.id !== undefined
    )
      if (!syncBridge.busy) void sendBridge.poll();
    respond({ ok: true });
    return;
  }
  if (raw?.kind === 'GET_MONITOR_BOOT') {
    if (
      sender.id !== chrome.runtime.id ||
      sender.origin !== 'https://web.whatsapp.com' ||
      sender.tab?.id === undefined
    ) {
      respond({ ok: false });
      return;
    }
    void (async () => {
      const stored = await chrome.storage.local.get([
        'waiMonitoringIntent',
        'waiAutomaticAccountId',
        'waiIdentityChoicesV1',
      ]);
      let accountId = stored.waiAutomaticAccountId;
      if (!z.uuid().safeParse(accountId).success) {
        accountId = crypto.randomUUID();
        await chrome.storage.local.set({ waiAutomaticAccountId: accountId });
      }
      const monitoring =
        typeof stored.waiMonitoringIntent === 'boolean'
          ? stored.waiMonitoringIntent
          : (await getState()).monitoring;
      respond({ ok: true, accountId, monitoring });
    })().catch(() => respond({ ok: false }));
    return true;
  }
  if (raw && typeof raw === 'object' && 'kind' in raw && raw.kind === 'SEND_PROGRESS') {
    if (sender.origin !== 'https://web.whatsapp.com' || sender.tab?.id === undefined) {
      respond({ ok: false });
      return;
    }
    const tabId = sender.tab.id;
    void getExtensionInstanceId()
      .then((extensionInstanceId) =>
        sendBridge.progress({ ...raw.input, extensionInstanceId }, tabId),
      )
      .then(() => respond({ ok: true }))
      .catch(() => respond({ ok: false }));
    return true;
  }

  const identityCommand = IdentityControlSchema.safeParse(raw);
  if (identityCommand.success) {
    if (
      sender.id !== chrome.runtime.id ||
      !sender.url?.startsWith(`chrome-extension://${chrome.runtime.id}/`)
    ) {
      respond({ ok: false, error: 'UNAUTHORIZED_SENDER' });
      return;
    }
    void (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (
          tab?.id === undefined ||
          !tab.url ||
          new URL(tab.url).origin !== 'https://web.whatsapp.com'
        )
          throw new Error('Abra o WhatsApp Web na aba ativa.');
        respond(await chrome.tabs.sendMessage(tab.id, identityCommand.data));
      } catch {
        respond({
          ok: false,
          error:
            'Não foi possível acessar a conversa. Recarregue a aba do WhatsApp e confira os dados.',
        });
      }
    })();
    return true;
  }
  const command = parsePopupCommand(raw);
  if (command.success) {
    if (
      sender.id !== chrome.runtime.id ||
      !sender.url?.startsWith(`chrome-extension://${chrome.runtime.id}/`)
    ) {
      respond({ ok: false, error: 'UNAUTHORIZED_SENDER' });
      return;
    }
    void (async () => {
      try {
        const result =
          command.data.command === 'GET_STATE'
            ? await activeMonitorStatus(await getState(), chrome.tabs)
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
        emitFlow(flowSink, {
          traceId: observation.data.observationId,
          resourceId: observation.data.observationId,
          component: 'EXTENSION_BACKGROUND',
          phase: 'CAPTURE_QUEUED',
          outcome: 'SUCCEEDED',
          code: 'QUEUED',
        });
        const current = await getState();
        const next = {
          ...current,
          errors: current.errors.filter((error) => error !== 'Unable to reach the selected page.'),
          activities: current.retainActivitySummaries
            ? [
                {
                  label:
                    observation.data.observationType === 'MESSAGE'
                      ? `message ${observation.data.direction.toLowerCase()} ${observation.data.captureState.toLowerCase()} queued`
                      : 'conversation activity queued (no message content)',
                  timestamp: observation.data.observedAt,
                },
                ...current.activities,
              ].slice(0, 20)
            : current.activities,
        };
        await saveState(next);
        respond({ ok: true });
      } catch (error) {
        emitFlow(flowSink, {
          traceId: observation.data.observationId,
          resourceId: observation.data.observationId,
          component: 'EXTENSION_BACKGROUND',
          phase: 'CAPTURE_QUEUED',
          outcome: 'FAILED',
          code: flowCode(error),
        });
        const updated = withError(
          await getState(),
          'Capture queue could not persist an observation.',
        );
        await saveState(updated);
        respond({ ok: false, error: 'CAPTURE_QUEUE_UNAVAILABLE' });
      }
    })();
    return true;
  }

  if (
    sender.origin === 'https://web.whatsapp.com' &&
    raw &&
    typeof raw === 'object' &&
    'kind' in raw &&
    raw.kind === 'CONTENT_ERROR'
  ) {
    void getState()
      .then((state) => saveState(withError(state, 'The page structure is not supported.')))
      .then(() => respond({ ok: true }));
    return true;
  }
  respond({ ok: false, error: 'INVALID_MESSAGE' });
});

const KEEPALIVE_ALARM = 'wai-send-keepalive';
async function ensureKeepAlive(): Promise<void> {
  // Idempotent: MV3 workers restart, so every entry point re-checks the alarm.
  if (!(await chrome.alarms.get(KEEPALIVE_ALARM)))
    chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
}
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  void (async () => {
    await connectNative();
    if (!syncBridge.busy) await sendBridge.poll();
  })().catch((error) =>
    emitFlow(flowSink, {
      traceId: crypto.randomUUID(),
      component: 'EXTENSION_BACKGROUND',
      phase: 'FAILED',
      outcome: 'FAILED',
      code: flowCode(error),
    }),
  );
});

chrome.runtime.onInstalled.addListener(() => {
  // Keep the persisted monitoring intent across extension updates.
  void ensureKeepAlive();
  void connectNative();
});

chrome.runtime.onStartup.addListener(() => {
  void ensureKeepAlive();
  void connectNative();
});
void ensureKeepAlive();
void connectNative();
