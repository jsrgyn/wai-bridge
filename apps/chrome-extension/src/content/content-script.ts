import { parseContentMessage } from '../messaging/protocol.js';
import { MonitorObserver } from '../observers/monitor-observer.js';
import type { CaptureObservation } from '../contracts.js';

let observer: MonitorObserver | undefined;
let monitoring = false;

function sendToBackground(message: unknown): void {
  try {
    const runtime = chrome.runtime as typeof chrome.runtime & {
      sendMessage: (payload: unknown, callback?: () => void) => Promise<unknown> | void;
    };
    const isExtensionRuntime = typeof chrome.runtime.id === 'string' && chrome.runtime.id.length > 0;
    const result = isExtensionRuntime
      ? runtime.sendMessage(message, () => void chrome.runtime.lastError)
      : runtime.sendMessage(message);
    if (result && typeof result === 'object' && 'catch' in result) {
      void (result as Promise<unknown>).catch(() => undefined);
    }
  } catch {
    // The extension may be reloaded while a content script is still active.
  }
}

function reportError(message: string): void {
  sendToBackground({ kind: 'CONTENT_ERROR', message });
}

function publishObservation(observation: CaptureObservation, attempt = 0): void {
  const runtime = chrome.runtime as typeof chrome.runtime & {
    sendMessage: (payload: unknown) => Promise<{ ok?: boolean }>;
  };
  void runtime.sendMessage(observation).then((response) => {
    if (!response?.ok && attempt < 5) setTimeout(() => publishObservation(observation, attempt + 1), 1000 * (attempt + 1));
  }).catch(() => {
    if (attempt < 5) setTimeout(() => publishObservation(observation, attempt + 1), 1000 * (attempt + 1));
  });
}

chrome.runtime.onMessage.addListener((raw, _sender, respond) => {
  const parsed = parseContentMessage(raw);
  if (!parsed.success) {
    respond({ ok: false, error: 'INVALID_MESSAGE' });
    return;
  }
  if (parsed.data.kind === 'GET_CONTENT_STATE') {
    respond({ ok: true, monitoring });
    return;
  }
  monitoring = parsed.data.enabled;
  if (monitoring) {
    if (!observer) {
      observer = new MonitorObserver(
        publishObservation,
        reportError,
      );
      observer.start();
    }
  } else {
    observer?.stop();
    observer = undefined;
  }
  respond({ ok: true, monitoring });
});
