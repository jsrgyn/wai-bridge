import { extensionBuild } from '../build-info.js';
import { ContentRuntimeClient } from '../messaging/content-runtime.js';
import { z } from 'zod';
import { ContactDetector } from '../adapters/contact-detector.js';
import { VisibleSendExecutor } from '../commands/visible-send.js';
import { parseContentMessage } from '../messaging/protocol.js';
import { MonitorObserver } from '../observers/monitor-observer.js';
import type { CaptureObservation } from '../contracts.js';
import { AutomaticContext } from '../identity/automatic-context.js';
import { IdentityContext } from '../identity/context.js';

const identityContext = new IdentityContext();
let automaticContext: AutomaticContext | undefined;
const currentIdentity = () =>
  runtimeClient.isValid() ? (identityContext.current() ?? automaticContext?.current()) : undefined;

const retryTimers = new Set<ReturnType<typeof setTimeout>>();
const runtimeClient = new ContentRuntimeClient(
  () => chrome.runtime,
  () => {
    for (const timer of retryTimers) clearTimeout(timer);
    retryTimers.clear();
    setMonitoring(false);
    identityContext.dispose();
    automaticContext = undefined;
    const notice = document.createElement('aside');
    notice.setAttribute('role', 'status');
    notice.id = 'wai-bridge-reload-required';
    notice.style.cssText =
      'position:fixed;bottom:16px;right:16px;z-index:2147483647;background:#fff;color:#111;padding:12px;border:2px solid #b36b00;max-width:340px';
    notice.textContent =
      'WAI Bridge foi recarregado ou desativado. Monitoramento e envios interrompidos. Recarregue esta aba do WhatsApp para reconectar.';
    document.body?.append(notice);
  },
);

const senderExecutor = new VisibleSendExecutor(
  { current: currentIdentity },
  async (command, step) => {
    const reply = await runtimeClient.request({
      kind: 'SEND_PROGRESS',
      input: {
        commandId: command.id,
        contextId: command.contextId,
        leaseToken: command.leaseToken,
        ...step,
      },
    });
    if (!z.object({ ok: z.literal(true) }).safeParse(reply).success)
      throw new Error('PROGRESS_UNAVAILABLE');
  },
);
let observer: MonitorObserver | undefined;
let monitoring = false;
let explicitControl = false;
let executingId: string | undefined;

function reportError(message: string): void {
  runtimeClient.notify({ kind: 'CONTENT_ERROR', message });
}

function publishObservation(observation: CaptureObservation, attempt = 0): void {
  if (!runtimeClient.isValid()) return;
  const retry = () => {
    if (attempt >= 5 || !runtimeClient.isValid()) return;
    const timer = setTimeout(
      () => {
        retryTimers.delete(timer);
        publishObservation(observation, attempt + 1);
      },
      1000 * (attempt + 1),
    );
    retryTimers.add(timer);
  };
  void runtimeClient
    .request(observation)
    .then((reply) => {
      if (!z.object({ ok: z.literal(true) }).safeParse(reply).success) retry();
    })
    .catch(retry);
}

const onMessage: Parameters<typeof chrome.runtime.onMessage.addListener>[0] = (
  raw,
  _sender,
  reply,
) => {
  const respond = (value: unknown) => {
    if (!runtimeClient.isValid()) return;
    try {
      reply(value);
    } catch (error) {
      runtimeClient.handleFailure(error);
    }
  };
  if (!runtimeClient.isValid()) return;
  const parsed = parseContentMessage(raw);
  if (!parsed.success) {
    respond({ ok: false, error: 'INVALID_MESSAGE' });
    return;
  }
  if (runtimeClient.extensionId && _sender.id !== runtimeClient.extensionId) {
    respond({ ok: false, error: 'UNAUTHORIZED_SENDER' });
    return;
  }
  if (parsed.data.kind === 'SEND_CONTEXT') {
    senderExecutor.setEnabled(parsed.data.enabled && monitoring);
    const root = document.querySelector<HTMLElement>('#main');
    const identity = monitoring ? currentIdentity() : undefined;
    respond({
      ok: true,
      ready: monitoring && !document.hidden,
      build: extensionBuild,
      ...(identity
        ? {
            identity,
            conversationLabel: root ? new ContactDetector().conversationLabel(root) : null,
          }
        : {}),
    });
    return;
  }
  if (parsed.data.kind === 'SEND_CANCEL') {
    if (executingId === parsed.data.commandId) senderExecutor.cancel();
    respond({ ok: true });
    return;
  }
  if (parsed.data.kind === 'SEND_EXECUTE') {
    if (!monitoring || executingId) {
      respond({ ok: false });
      return;
    }
    executingId = parsed.data.command.id;
    void senderExecutor
      .execute(parsed.data.command)
      .catch(() => reportError('Extension send execution could not complete.'))
      .finally(() => {
        executingId = undefined;
      });
    respond({ ok: true, accepted: true });
    return;
  }
  if (
    parsed.data.kind === 'IDENTITY_PREVIEW' ||
    parsed.data.kind === 'IDENTITY_BIND' ||
    parsed.data.kind === 'IDENTITY_CLEAR' ||
    parsed.data.kind === 'IDENTITY_STATE'
  ) {
    try {
      if (parsed.data.kind === 'IDENTITY_PREVIEW')
        respond({ ok: true, preview: identityContext.preview() });
      else if (parsed.data.kind === 'IDENTITY_BIND')
        respond({ ok: true, identity: identityContext.bind(parsed.data) });
      else if (parsed.data.kind === 'IDENTITY_STATE')
        respond({ ok: true, identity: currentIdentity() });
      else {
        identityContext.clear();
        respond({ ok: true });
      }
    } catch (error) {
      respond({
        ok: false,
        error: error instanceof Error ? error.message : 'Não foi possível confirmar a conversa.',
      });
    }
    return;
  }
  if (parsed.data.kind === 'GET_CONTENT_STATE') {
    respond({
      ok: true,
      monitoring,
      conversationOpen: Boolean(
        document.querySelector('#main, [data-wai-observation-root][role="log"]'),
      ),
    });
    return;
  }
  explicitControl = true;
  setMonitoring(parsed.data.enabled);
  respond({ ok: true, monitoring });
};
try {
  chrome.runtime.onMessage.addListener(onMessage);
} catch (error) {
  runtimeClient.handleFailure(error);
}

function setMonitoring(enabled: boolean): void {
  monitoring = enabled;
  if (monitoring && !observer) {
    observer = new MonitorObserver(
      (observation, root) =>
        publishObservation(
          identityContext.current()
            ? identityContext.enrich(observation, root)
            : (automaticContext?.enrich(observation, root) ?? observation),
        ),
      reportError,
    );
    observer.start();
  } else if (!monitoring) {
    senderExecutor.setEnabled(false);
    identityContext.clear();
    observer?.stop();
    observer = undefined;
  }
}

// The background owns the persisted intent; page reload does not silently turn ON into OFF.
void runtimeClient
  .request({ kind: 'GET_MONITOR_BOOT' })
  .then((reply) => {
    if (!runtimeClient.isValid()) return;
    const boot = z
      .object({ ok: z.literal(true), accountId: z.uuid(), monitoring: z.boolean() })
      .safeParse(reply);
    if (!boot.success) return;
    automaticContext = new AutomaticContext(boot.data.accountId);
    if (!explicitControl && boot.data.monitoring) setMonitoring(true);
  })
  .catch(() => undefined);

// Wake promptly after the target tab becomes visible, rather than waiting for the next timer.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && runtimeClient.isValid()) runtimeClient.notify({ kind: 'SEND_WAKE' });
});
