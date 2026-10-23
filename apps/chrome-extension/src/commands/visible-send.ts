import {uiCompatibility} from '../adapters/ui-compatibility.js';
import { emitFlow, flowCode, normalizeProfilePhone, type FlowLogSink } from '@wai-bridge/shared';
import {
  ExtensionSendCommandSchema,
  sendTarget,
  type ExtensionSendCommand,
  type ExtensionSendProgress,
} from '@wai-bridge/shared';
import type { ConversationIdentity } from '@wai-bridge/shared';
import { WhatsAppDomAdapter } from '../adapters/dom-adapter.js';
import { PhoneSearch, isVisible, type ResolvedPhoneRecipient } from './phone-search.js';
import { visiblePeerDetails } from '../identity/visible-peer-details.js';
import { messageText } from '../adapters/message-text.js';

type Step = Omit<
  ExtensionSendProgress,
  'extensionInstanceId' | 'commandId' | 'contextId' | 'leaseToken'
>;
export class VisibleSendExecutor {
  private enabled = false;
  private resolved: ResolvedPhoneRecipient | undefined;
  private active: AbortController | undefined;
  private readonly attempted = new Set<string>();
  constructor(
    private readonly identity: { current(): ConversationIdentity | undefined },
    private readonly progress: (command: ExtensionSendCommand, step: Step) => Promise<void>,
    private readonly doc: Document = document,
    private readonly logs?: FlowLogSink,
  ) {}
  cancel(): void {
    this.active?.abort();
  }
  setEnabled(value: boolean): void {
    this.enabled = value;
    if (!value) this.active?.abort();
  }
  async execute(raw: unknown): Promise<void> {
    const command = ExtensionSendCommandSchema.parse(raw);
    if (this.active || this.attempted.has(command.id)) throw new Error('COMMAND_ALREADY_ATTEMPTED');
    this.attempted.add(command.id);
    const controller = new AbortController();
    this.active = controller;
    let sending = false;
    let search: PhoneSearch | undefined;
    const box = this.doc.createElement('aside');
    box.setAttribute('role', 'status');
    box.style.cssText =
      'position:fixed;right:20px;top:80px;z-index:2147483647;background:#fff;color:#111;padding:16px;border:2px solid #188859;max-width:360px';
    const label = this.doc.createElement('p');
    const cancel = this.doc.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancelar envio WAI Bridge';
    cancel.addEventListener('click', () => controller.abort());
    box.append(label, cancel);
    try {
      emitFlow(this.logs, {
        traceId: command.traceId ?? command.id,
        resourceId: command.id,
        component: 'EXTENSION_CONTENT',
        phase: 'SEND_ACCEPTED',
        outcome: 'STARTED',
        code: 'ACCEPTED',
        mode: command.mode,
      });
      if (this.doc.hidden) {
        label.textContent =
          'WAI Bridge: abra a aba do WhatsApp para preparar a mensagem. Nenhum envio iniciado.';
        this.doc.body.append(box);
        while (this.doc.hidden) {
          if (!this.enabled) throw new Error('EXTENSION_SENDS_DISABLED');
          if (Date.parse(command.leaseUntil) <= Date.now()) throw new Error('SEND_LEASE_EXPIRED');
          await delay(100, controller.signal);
        }
      }
      if (command.locateByPhone) {
        emitFlow(this.logs, {
          traceId: command.traceId ?? command.id,
          resourceId: command.id,
          component: 'WHATSAPP_UI',
          phase: 'RECIPIENT_LOOKUP',
          outcome: 'STARTED',
          code: 'STARTED',
        });
        label.textContent = 'WAI Bridge: pesquisando e conferindo o telefone do contato.';
        this.doc.body.append(box);
        search = new PhoneSearch(this.doc, this.identity, (phase) =>
          emitFlow(this.logs, {
            traceId: command.traceId ?? command.id,
            resourceId: command.id,
            component: 'WHATSAPP_UI',
            phase,
            outcome: phase === 'CHAT_OPENED' ? 'SUCCEEDED' : 'STARTED',
            code: phase === 'CHAT_OPENED' ? 'OK' : 'STARTED',
          }),
        );
        this.resolved = await search.resolve(
          command.recipientPhone!,
          command.target.accountId,
          controller.signal,
          () => this.gate(command),
        );
      }
      const root = this.validate(command);
      emitFlow(this.logs, {
        traceId: command.traceId ?? command.id,
        resourceId: command.id,
        component: 'WHATSAPP_UI',
        phase: 'RECIPIENT_VERIFIED',
        outcome: 'SUCCEEDED',
        code: 'OK',
      });
      // Leave the search empty and drawers closed while the verified chat stays open.
      await search?.resetAfterVerify();
      this.check(command, controller.signal);
      const baseline = new Set(
        root.querySelectorAll<HTMLElement>('[data-testid="msg-container"], .message-out'),
      );
      const baselineKeys = new Set(
        Array.from(baseline)
          .map((e) => new WhatsAppDomAdapter().renderKey(e))
          .filter(Boolean),
      );
      const composer = await this.prepareComposer(
        command,
        root,
        command.appendToDraft,
        controller.signal,
      );
      // Post-compose revalidation: contact, visibility and opt-in must still hold.
      this.check(command, controller.signal);
      this.doc.body.append(box);
      emitFlow(this.logs, {
        traceId: command.traceId ?? command.id,
        resourceId: command.id,
        component: 'WHATSAPP_UI',
        phase: 'MESSAGE_COMPOSED',
        outcome: 'SUCCEEDED',
        code: 'OK',
      });
      if (command.mode === 'SUPERVISED') {
        // Supervised never sends: the verified draft is handed to the user and the queue moves on.
        await this.reportTerminal(command, {
          step: 'DRAFTED',
          code: 'DRAFT_READY',
          ...this.recipientProof(command),
        });
        return;
      }
      await this.progress(command, {
        step: 'WAITING_AUTO_SEND',
        code: 'AUTO_COUNTDOWN_STARTED',
        ...this.recipientProof(command),
      });
      const due = Date.now() + command.timing.autoCountdownMs;
      while (Date.now() < due) {
        this.check(command, controller.signal);
        label.textContent = `WAI Bridge: envio em ${Math.ceil((due - Date.now()) / 1000)} s. ${command.text}`;
        await delay(100, controller.signal);
      }
      this.check(command, controller.signal);
      if (messageText(composer) !== command.text.normalize('NFC'))
        throw new Error('COMPOSER_CHANGED');
      const buttons = Array.from(
        root.querySelectorAll<HTMLElement>(
          'footer button[aria-label="Enviar"], footer button[aria-label="Send"], footer [role="button"][aria-label="Enviar"], footer [role="button"][aria-label="Send"]',
        ),
      ).filter((e) => visible(e));
      if (
        buttons.length !== 1 ||
        buttons[0]!.getAttribute('aria-disabled') === 'true' ||
        (buttons[0] instanceof HTMLButtonElement && buttons[0].disabled)
      )
        throw new Error('SEND_CONTROL_UNAVAILABLE');
      // A successful durable SENDING response is mandatory BEFORE the external effect.
      await this.progress(command, { step: 'SENDING', code: 'SEND_CLICK_AUTHORIZED' });
      sending = true;
      this.check(command, controller.signal);
      if (messageText(composer) !== command.text.normalize('NFC') || !buttons[0]!.isConnected)
        throw new Error('COMPOSER_CHANGED');
      label.textContent = 'WAI Bridge: aguardando confirmação visível do envio.';
      cancel.disabled = true;
      buttons[0]!.click();
      emitFlow(this.logs, {
        traceId: command.traceId ?? command.id,
        resourceId: command.id,
        component: 'WHATSAPP_UI',
        phase: 'SENDING',
        outcome: 'STARTED',
        code: 'SEND_CLICK_AUTHORIZED',
      });
      const result = await this.verify(root, command, baseline, baselineKeys, controller.signal);
      await this.reportTerminal(command, result);
    } catch (error) {
      // A lost SENDING response may already have committed; use UNKNOWN conservatively.
      const code =
        error instanceof Error && /^[A-Z0-9_]{1,64}$/.test(error.message)
          ? error.message
          : 'EXECUTION_UNCERTAIN';
      await this.reportTerminal(command, {
        step:
          sending || code === 'PROGRESS_UNAVAILABLE'
            ? 'UNKNOWN'
            : controller.signal.aborted
              ? 'CANCELLED'
              : 'FAILED',
        code,
      });
    } finally {
      try {
        await search?.release(controller.signal);
      } finally {
        this.resolved = undefined;
        box.remove();
        this.active = undefined;
      }
    }
  }
  private validate(command: ExtensionSendCommand, allowHidden = false): HTMLElement {
    this.gate(command, allowHidden);
    const current = this.identity.current();
    if (command.locateByPhone) {
      const label = this.resolved?.root
        .querySelector('[data-testid="conversation-info-header-chat-title"]')
        ?.textContent?.trim();
      const details =
        label && label === this.resolved?.label ? visiblePeerDetails(this.doc, label) : undefined;
      if (details?.kind === 'GROUP' || (details?.phone && details.phone !== this.resolved?.phone))
        throw new Error('RECIPIENT_PHONE_MISMATCH');
      if (
        !current ||
        current.accountId !== command.target.accountId ||
        current.contextId !== this.resolved?.contextId ||
        !label ||
        label !== this.resolved?.label ||
        this.resolved?.phone !== normalizeProfilePhone(command.recipientPhone!) ||
        this.doc.querySelector('#main') !== this.resolved.root
      )
        throw new Error('RECIPIENT_CONTEXT_MISMATCH');
      const verifiedDetails = details!;
      if (
        verifiedDetails.kind === 'GROUP' ||
        (verifiedDetails.phone && verifiedDetails.phone !== this.resolved.phone) ||
        ('phone' in current &&
          current.phone &&
          normalizeProfilePhone(current.phone) !== this.resolved.phone)
      )
        throw new Error('RECIPIENT_PHONE_MISMATCH');
      // Absence of a closed profile is not a changed number. An open but
      // unreadable profile must still block; never silently reuse stale proof.
      if (
        [...this.doc.querySelectorAll('[data-testid="chat-info-drawer"]')].some(isVisible) &&
        !verifiedDetails.phone
      )
        throw new Error('PHONE_PROFILE_UNAVAILABLE');
    } else if (
      !current ||
      current.contextId !== command.contextId ||
      JSON.stringify(sendTarget(current)) !== JSON.stringify(command.target)
    )
      throw new Error('RECIPIENT_CONTEXT_MISMATCH');
    if(uiCompatibility(this.doc).reasons.includes('AMBIGUOUS_STRUCTURE'))throw new Error('CONVERSATION_UNAVAILABLE');
    const roots = this.doc.querySelectorAll<HTMLElement>('#main');
    if (roots.length !== 1) throw new Error('CONVERSATION_UNAVAILABLE');
    return roots[0]!;
  }
  private recipientProof(command: ExtensionSendCommand) {
    // Callers must revalidate first; the post-compose check is the single gate.
    if (!command.locateByPhone) return {};
    return {
      resolvedIdentity: this.resolved!.identity,
      conversationLabel: this.resolved!.root.querySelector(
        '[data-testid="conversation-info-header-chat-title"]',
      )!.textContent!.trim(),
    };
  }
  private gate(command: ExtensionSendCommand, allowHidden = false): void {
    if (!this.enabled) throw new Error('EXTENSION_SENDS_DISABLED');
    if (Date.parse(command.leaseUntil) <= Date.now()) throw new Error('SEND_LEASE_EXPIRED');
    if (this.doc.hidden && !allowHidden) throw new Error('WHATSAPP_TAB_NOT_VISIBLE');
  }
  private check(command: ExtensionSendCommand, signal: AbortSignal): void {
    if (signal.aborted) throw new Error('USER_CANCELLED');
    this.validate(command);
  }
  private composer(root: HTMLElement): HTMLElement {
    const fields = root.querySelectorAll<HTMLElement>(
      'footer [contenteditable="true"][role="textbox"], [data-wai-test-composer][contenteditable="true"]',
    );
    if (fields.length !== 1) throw new Error('COMPOSER_UNAVAILABLE');
    return fields[0]!;
  }
  /**
   * Prepare the target composer (only after the target chat is open and validated).
   * - appendToDraft with non-empty composer: keep everything already there (including the
   *   user's edits), move the caret to the end and insert a line break plus the text.
   *   If the composer already ends with the text (requeue), insert nothing.
   * - Otherwise: select everything, delete it and insert the text once.
   * The line break uses `insertLineBreak`; no Enter key is ever dispatched, so it cannot send.
   */
  private async prepareComposer(
    command: ExtensionSendCommand,
    root: HTMLElement,
    appendToDraft: boolean,
    signal: AbortSignal,
  ): Promise<HTMLElement> {
    const composer = this.composer(root);
    const text = command.text.normalize('NFC').trim();
    const stable = () => {
      this.check(command, signal);
      if (!composer.isConnected || this.composer(this.validate(command)) !== composer)
        throw new Error('COMPOSE_FAILED');
    };
    const waitFor = async (done: () => boolean) => {
      const deadline = Date.now() + 1000;
      while (!done()) {
        stable();
        if (Date.now() >= deadline) throw new Error('COMPOSE_FAILED');
        await delay(50, signal);
      }
    };
    composer.focus();
    const prior = messageText(composer);
    const append = appendToDraft && prior !== '';
    if (append && prior.endsWith(text)) {
      stable();
      return composer;
    }
    const selection = this.doc.getSelection();
    const range = this.doc.createRange();
    range.selectNodeContents(composer);
    if (append) range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);
    if (append) {
      stable();
      this.doc.execCommand('insertLineBreak', false);
    } else if (prior) {
      this.doc.execCommand('delete', false);
      await waitFor(() => !messageText(composer));
    }
    stable();
    // Chromium/editor handlers may insert successfully while returning false.
    // Observe the rendered editor instead of treating that boolean as evidence.
    // Insert exactly once: never retry, so text is never duplicated.
    this.doc.execCommand('insertText', false, command.text);
    await waitFor(() => {
      const current = messageText(composer);
      return append
        ? current.startsWith(prior) && current.endsWith(text) && current.length > prior.length
        : current === text;
    });
    return composer;
  }
  private async verify(
    root: HTMLElement,
    command: ExtensionSendCommand,
    baseline: Set<HTMLElement>,
    keys: Set<string | undefined>,
    signal: AbortSignal,
  ): Promise<Step> {
    const until = Date.now() + command.timing.sendVerifyMs;
    const adapter = new WhatsAppDomAdapter();
    while (Date.now() < until) {
      this.check(command, signal);
      const candidates = Array.from(
        root.querySelectorAll<HTMLElement>('[data-testid="msg-container"], .message-out'),
      )
        .filter(
          (e) =>
            !baseline.has(e) &&
            (!adapter.renderKey(e) || !keys.has(adapter.renderKey(e))) &&
            adapter.messageDirection(e) === 'OUTBOUND',
        )
        .filter((e) => {
          const text = e.querySelector(
            '[data-wai-message-text], [data-testid="msg-text"], .selectable-text',
          );
          return text && messageText(text) === command.text.normalize('NFC');
        });
      if (candidates.length > 1) return { step: 'UNKNOWN', code: 'AMBIGUOUS_SEND_EVIDENCE' };
      const candidate = candidates[0];
      if (candidate && visible(candidate)) {
        const markers = Array.from(candidate.querySelectorAll('[aria-label]')).map((e) =>
          e.getAttribute('aria-label')?.trim(),
        );
        if (
          markers.some(
            (v) =>
              v &&
              [
                'Enviada',
                'Enviado',
                'Entregue',
                'Lida',
                'Lido',
                'Sent',
                'Delivered',
                'Read',
              ].includes(v),
          )
        ) {
          const bytes = new TextEncoder().encode(
            `${command.id}:${adapter.renderKey(candidate) ?? 'new-visible-bubble'}:${command.text}`,
          );
          const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
            .map((v) => v.toString(16).padStart(2, '0'))
            .join('');
          return {
            step: 'SENT',
            code: 'VISIBLE_OUTBOUND_CONFIRMED',
            evidence: `visible-outbound:${hash}`,
          };
        }
      }
      await delay(150, signal);
    }
    return { step: 'UNKNOWN', code: 'SEND_CONFIRMATION_TIMEOUT' };
  }
  private async reportTerminal(command: ExtensionSendCommand, result: Step): Promise<void> {
    emitFlow(this.logs, {
      traceId: command.traceId ?? command.id,
      resourceId: command.id,
      component: 'WHATSAPP_UI',
      phase: result.step,
      outcome:
        result.step === 'FAILED'
          ? 'FAILED'
          : result.step === 'UNKNOWN'
            ? 'UNKNOWN'
            : result.step === 'CANCELLED'
              ? 'CANCELLED'
              : 'SUCCEEDED',
      code: flowCode(result.code),
    });
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.progress(command, result);
        return;
      } catch (error) {
        if (error instanceof Error && error.message === 'EXTENSION_CONTEXT_INVALIDATED')
          throw error;
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    throw new Error('RESULT_NOT_PERSISTED');
  }
}
function visible(element: HTMLElement): boolean {
  const view = element.ownerDocument.defaultView;
  if (!view) return false;
  const r = element.getBoundingClientRect();
  if (
    r.width <= 0 ||
    r.height <= 0 ||
    r.bottom <= 0 ||
    r.right <= 0 ||
    r.top >= view.innerHeight ||
    r.left >= view.innerWidth
  )
    return false;
  for (let el: Element | null = element; el; el = el.parentElement) {
    const style = view.getComputedStyle(el);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.visibility === 'collapse' ||
      Number(style.opacity) === 0
    )
      return false;
  }
  return true;
}
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('USER_CANCELLED'));
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(new Error('USER_CANCELLED'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
