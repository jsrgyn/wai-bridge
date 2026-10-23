import {uiCompatibility} from '../adapters/ui-compatibility.js';
import { DialogueSyncCodeSchema } from '@wai-bridge/shared';
import { VisibleDialogueSync } from '../commands/dialogue-sync.js';
import { WhatsAppDomAdapter } from '../adapters/dom-adapter.js';
import { emitFlow, type FlowLogSink } from '@wai-bridge/shared';
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

const flowSink: FlowLogSink = (event) => {
  console.debug('WAI_FLOW', event);
  runtimeClient.notify({ kind: 'FLOW_LOG', event });
};
const senderExecutor = new VisibleSendExecutor(
  { current: currentIdentity },
  async (command, step) => {
    const reply = await runtimeClient.request({
      kind: 'SEND_PROGRESS',
      input: {
        commandId: command.id,
        traceId: command.traceId ?? command.id,
        contextId: command.contextId,
        leaseToken: command.leaseToken,
        ...step,
      },
    });
    if (!z.object({ ok: z.literal(true) }).safeParse(reply).success)
      throw new Error('PROGRESS_UNAVAILABLE');
  },
  document,
  flowSink,
);
let observer: MonitorObserver | undefined;
let monitoring = false;
let explicitControl = false;
let synchronizing = false;
let activeSync: {requestId:string;cancelled:boolean}|undefined;
let batchSession: {id:string;runToken:string;interfered:boolean}|undefined;
for (const type of ['pointerdown','keydown','input','wheel']) document.addEventListener(type,event=>{
  if(event.isTrusted && batchSession && runtimeClient.isValid()) batchSession.interfered=true;
},true);
let executingId: string | undefined;

function reportError(message: string): void {
  runtimeClient.notify({ kind: 'CONTENT_ERROR', message });
}

function publishObservation(observation: CaptureObservation, attempt = 0): void {
  if (!runtimeClient.isValid()) return;
  if (attempt === 0)
    emitFlow(flowSink, {
      traceId: observation.observationId,
      resourceId: observation.observationId,
      component: 'WHATSAPP_UI',
      phase: 'CAPTURE_OBSERVED',
      outcome: 'SUCCEEDED',
      code: 'OK',
      direction: observation.direction,
      build: extensionBuild,
    });
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
  if(parsed.data.kind==='GET_COMPATIBILITY'){respond({ok:true,compatibility:uiCompatibility(document)});return;}
  if (parsed.data.kind === 'GET_SYNC_CONTEXT') {
    respond({
      ok: true,
      monitoring,
      build: extensionBuild,
      executing: executingId ?? null,
      compatibility:uiCompatibility(document),
      accountId: automaticContext?.localAccountId,
      ready: monitoring && !document.hidden && !executingId && !synchronizing,
    });
    return;
  }
  if (parsed.data.kind === 'SYNC_CANCEL') {
    if(activeSync?.requestId===parsed.data.requestId)activeSync.cancelled=true;
    respond({ok:true});return;
  }
  if (parsed.data.kind === 'SYNC_DIALOGUE') {
    if (!monitoring || !observer || executingId || synchronizing) {
      respond({ code: 'MONITOR_OFF', observations: [], truncated: false });
      return;
    }
    synchronizing = true;
    let syncInterfered = false;
    const syncUserInput = (event: Event) => { if (event.isTrusted) syncInterfered = true; };
    for (const type of ['pointerdown','keydown','input','wheel']) document.addEventListener(type,syncUserInput,true);
    const job = parsed.data.job;
    const cancellation={requestId:job.id,cancelled:false};activeSync=cancellation;
    if(job.batch && batchSession?.runToken!==job.batch.runToken)
      batchSession={id:job.batch.id,runToken:job.batch.runToken,interfered:false};
    const gate = () => {
      if(cancellation.cancelled)throw new Error('CANCELLED');
      if (syncInterfered || (job.batch && batchSession?.interfered)) throw new Error('USER_INTERFERENCE');
      if ([...document.querySelectorAll('#main footer [contenteditable="true"]')].some(e=>e.textContent?.trim())) throw new Error('COMPOSER_HAS_DRAFT');
      if (!runtimeClient.isValid() || !monitoring || !observer) throw new Error('MONITOR_OFF');
      if (document.hidden) throw new Error('TAB_HIDDEN');
      if (Date.now() >= Date.parse(job.expiresAt)) throw new Error('TIMEOUT');
      if (automaticContext?.localAccountId !== job.accountId) throw new Error('ACCOUNT_MISMATCH');
    };
    void (async () => {
      try {
        const root = await new VisibleDialogueSync(document, currentIdentity).locate(job, gate);
        gate();
        const label = new ContactDetector().conversationLabel(root);
        const selected = document.querySelector('#pane-side [aria-selected="true"]');
        // Allow the normal UI hydration to settle without scrolling/importing history.
        await new Promise((resolve) => setTimeout(resolve, 350));
        gate();
        if (
          !root.isConnected ||
          new ContactDetector().conversationLabel(root) !== label ||
          document.querySelector('#pane-side [aria-selected="true"]') !== selected
        )
          throw new Error('CONTEXT_CHANGED');
        if(!uiCompatibility(document).canCapture)throw new Error('UI_UNSUPPORTED');
        const total = new WhatsAppDomAdapter().findNewMessages(root).length;
        const observations = observer!
          .reconcile(root, job.limit)
          .map((observation) =>
            identityContext.current()
              ? identityContext.enrich(observation, root)
              : (automaticContext?.enrich(observation, root) ?? observation),
          );
        const identity = currentIdentity();
        if (!identity || !label || identity.accountId !== job.accountId)
          throw new Error('CONTEXT_CHANGED');
        // Snapshot observations commit exclusively through SYNC_COMPLETE, atomically with the job.
        // Publishing them as live notifications would create artificial unread signals and bypass rollback.
        respond({
          code: 'OK',
          identity,
          conversationLabel: label,
          observations,
          truncated: total > job.limit,
        });
      } catch (error) {
        const parsedCode = DialogueSyncCodeSchema.safeParse(
          error instanceof Error ? error.message : 'SYNC_FAILED',
        );
        respond({
          code: parsedCode.success ? parsedCode.data : 'SYNC_FAILED',
          observations: [],
          truncated: false,
        });
      } finally {
        for (const type of ['pointerdown','keydown','input','wheel']) document.removeEventListener(type,syncUserInput,true);
        activeSync=undefined;
        synchronizing = false;
      }
    })();
    return true;
  }
  if (parsed.data.kind === 'SEND_CONTEXT') {
    senderExecutor.setEnabled(parsed.data.enabled && monitoring);
    const root = document.querySelector<HTMLElement>('#main');
    const identity = monitoring ? currentIdentity() : undefined;
    respond({
      ok: true,
      ready: monitoring && !document.hidden,
      build: extensionBuild,
      compatibility:uiCompatibility(document),
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
    if (!monitoring || executingId || synchronizing) {
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
  if(!enabled && batchSession)batchSession.interfered=true;
  monitoring = enabled;
  if (monitoring && !observer) {
    observer = new MonitorObserver(
      (observation, root) =>
        publishObservation(
          observation.observationType === 'CONVERSATION_ACTIVITY'
            ? (automaticContext?.enrich(observation, root) ?? observation)
            : identityContext.current()
              ? identityContext.enrich(observation, root)
              : (automaticContext?.enrich(observation, root) ?? observation),
        ),
      reportError,
      () => {
        const identity = currentIdentity();
        if (!identity) return undefined;
        const key =
          identity.type === 'PHONE'
            ? identity.phone
            : identity.type === 'UI_CONTEXT'
              ? identity.conversationKey
              : identity.groupId;
        return `${identity.accountId}:${identity.type}:${key}`;
      },
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
