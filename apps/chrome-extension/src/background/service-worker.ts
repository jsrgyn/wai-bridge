import { ExtensionSendBridge } from './send-bridge.js';
import { ExtensionStateSchema, IdentityControlSchema, type ExtensionState } from '../contracts.js';
import { z } from 'zod';
import { parseCaptureObservation, parsePopupCommand } from '../messaging/protocol.js';
import { NATIVE_HOST_NAME, NativeResponseSchema } from '../platform/native-messaging-adapter.js';
import { EventPublisher } from './event-publisher.js';
import { activeMonitorStatus } from './monitor-status.js';

const extensionInstanceIdKey = 'waiBridgeExtensionInstanceId';
const publisher = new EventPublisher(chrome.storage.local);
const sendBridge=new ExtensionSendBridge(getExtensionInstanceId,chrome.tabs,chrome.storage.local,chrome.windows);
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
  await chrome.storage.local.set({waiMonitoringIntent:enabled});
  await saveState({...updated, errors: []});
  return activeMonitorStatus({...updated,errors:[]}, chrome.tabs);
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
    sendBridge.connect(port);
    const extensionInstanceId = await getExtensionInstanceId();
    port.onMessage.addListener((raw: unknown) => {
      const parsed = NativeResponseSchema.safeParse(raw);
      if (!parsed.success) {
        void updateConnection('DISCONNECTED');
        return;
      }
      if(sendBridge.receive(parsed.data))return;
      if (parsed.data.type === 'HOST_STATE') {
        reconnectDelay = 1_000;
        void updateConnection(parsed.data.connected ? 'CONNECTED' : 'DISCONNECTED');
        if (parsed.data.connected) {void publisher.connect(port, extensionInstanceId);void sendBridge.poll();}
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
      sendBridge.disconnect();
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


setInterval(()=>void sendBridge.poll(),1000);
chrome.tabs.onActivated?.addListener(()=>void sendBridge.poll());
chrome.tabs.onUpdated?.addListener((_tabId,change)=>{if(change.status==='complete')void sendBridge.poll();});
chrome.windows?.onFocusChanged?.addListener(()=>void sendBridge.poll());
chrome.storage.onChanged?.addListener((changes,area)=>{if(area==='local' && ('waiExtensionSendsEnabled' in changes || 'waiMonitoringIntent' in changes))void sendBridge.poll();});
chrome.runtime.onMessage.addListener((raw, sender, respond) => {
  if(raw?.kind==='SEND_WAKE'){
    if(sender.id===chrome.runtime.id && sender.origin==='https://web.whatsapp.com' && sender.tab?.id!==undefined)void sendBridge.poll();
    respond({ok:true});return;
  }
  if(raw?.kind === 'GET_MONITOR_BOOT') {
    if(sender.id!==chrome.runtime.id || sender.origin!=='https://web.whatsapp.com' || sender.tab?.id===undefined) {respond({ok:false});return;}
    void (async()=>{
      const stored=await chrome.storage.local.get(['waiMonitoringIntent','waiAutomaticAccountId','waiIdentityChoicesV1']);
      let accountId=stored.waiAutomaticAccountId;
      if(!z.uuid().safeParse(accountId).success) {
        accountId=crypto.randomUUID();
        await chrome.storage.local.set({waiAutomaticAccountId:accountId});
      }
      const monitoring=typeof stored.waiMonitoringIntent==='boolean'?stored.waiMonitoringIntent:(await getState()).monitoring;
      respond({ok:true,accountId,monitoring});
    })().catch(()=>respond({ok:false}));return true;
  }
  if(raw&&typeof raw==='object'&&'kind' in raw&&raw.kind==='SEND_PROGRESS') {
    if(sender.origin!=='https://web.whatsapp.com'||sender.tab?.id===undefined){respond({ok:false});return;}
    const tabId=sender.tab.id;
    void getExtensionInstanceId().then(extensionInstanceId=>sendBridge.progress({...raw.input,extensionInstanceId},tabId)).then(()=>respond({ok:true})).catch(()=>respond({ok:false}));return true;
  }

  const identityCommand=IdentityControlSchema.safeParse(raw);
  if(identityCommand.success) {
    if(sender.id!==chrome.runtime.id||!sender.url?.startsWith(`chrome-extension://${chrome.runtime.id}/`)) {respond({ok:false,error:'UNAUTHORIZED_SENDER'});return;}
    void (async()=>{
      try {
        const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
        if(tab?.id===undefined||!tab.url||new URL(tab.url).origin!=='https://web.whatsapp.com')throw new Error('Abra o WhatsApp Web na aba ativa.');
        respond(await chrome.tabs.sendMessage(tab.id,identityCommand.data));
      }catch{respond({ok:false,error:'Não foi possível acessar a conversa. Recarregue a aba do WhatsApp e confira os dados.'});}
    })();return true;
  }
  const command = parsePopupCommand(raw);
  if (command.success) {
    if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(`chrome-extension://${chrome.runtime.id}/`)) {
      respond({ ok: false, error: 'UNAUTHORIZED_SENDER' });
      return;
    }
    void (async () => {
      try {
        const result = command.data.command === 'GET_STATE'
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
        const current = await getState();
        const next = {
          ...current,
          errors:current.errors.filter(error=>error!=='Unable to reach the selected page.'),
          activities: current.retainActivitySummaries
            ? [{ label: observation.data.observationType === 'MESSAGE'
              ? `message ${observation.data.direction.toLowerCase()} ${observation.data.captureState.toLowerCase()} queued`
              : 'conversation activity queued (no message content)', timestamp: observation.data.observedAt }, ...current.activities].slice(0, 20)
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
  // Keep the persisted monitoring intent across extension updates.
  void connectNative();
});

chrome.runtime.onStartup.addListener(() => void connectNative());
void connectNative();
