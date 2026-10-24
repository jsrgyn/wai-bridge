import {uiCompatibility} from '../adapters/ui-compatibility.js';
import {
  normalizeProfilePhone,
  type ConversationIdentity,
  type DialogueSyncJob,
} from '@wai-bridge/shared';
import { conversationRowLabel } from '../adapters/conversation-label.js';
import { isVisible, PhoneSearch } from './phone-search.js';
import { openConversationResult } from './open-conversation-result.js';

const normalize = (s: string) => s.normalize('NFC').trim().toLocaleLowerCase('pt-BR');
export class VisibleDialogueSync {
  constructor(
    private readonly doc: Document,
    private readonly current: () => ConversationIdentity | undefined,
  ) {}
  async locate(job: DialogueSyncJob, gate: () => void): Promise<HTMLElement> {
    let interrupted = false;
    const onInput = (event: Event) => {
      if (event.isTrusted) interrupted = true;
    };
    const check = () => {
      gate();
      if(!uiCompatibility(this.doc).canSync)throw new Error('UI_UNSUPPORTED');
      if (interrupted) throw new Error('USER_INTERFERENCE');
      if (Date.now() >= Date.parse(job.expiresAt)) throw new Error('TIMEOUT');
      if (this.doc.hidden) throw new Error('TAB_HIDDEN');
      const identity = this.current();
      if (identity && identity.accountId !== job.accountId) throw new Error('ACCOUNT_MISMATCH');
    };
    const wait = async (test: () => boolean, ms: number) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        check();
        if (test()) return;
        await new Promise((r) => setTimeout(r, 80));
      }
      throw new Error('CHAT_UNAVAILABLE');
    };
    check();
    if (
      [...this.doc.querySelectorAll('#main footer [contenteditable="true"]')].some((e) =>
        e.textContent?.trim(),
      )
    )
      throw new Error('COMPOSER_HAS_DRAFT');
    this.doc.addEventListener('pointerdown', onInput, true);
    this.doc.addEventListener('keydown', onInput, true);
    let input: HTMLInputElement | undefined;
    let ownsSearch = false;
    try {
      const phone = /^\+?[\d\s()-]+$/.test(job.query)
        ? normalizeProfilePhone('+' + job.query.replace(/\D/g, ''))
        : null;
      if (phone) {
        if (!job.accountId) throw new Error('ACCOUNT_MISMATCH');
        const search = new PhoneSearch(this.doc, { current: this.current });
        const controller = new AbortController();
        try {
          return (await search.resolve(phone, job.accountId, controller.signal, check)).root;
        } finally {
          await search.release(controller.signal);
        }
      }
      const label = () =>
        this.doc
          .querySelector('#main [data-testid="conversation-info-header-chat-title"]')
          ?.textContent?.trim();
      const candidates = () => {
        const list = this.doc.querySelector('#pane-side');
        if (!list) return [];
        let allowed = true;
        const rows: HTMLElement[] = [];
        for (const e of list.querySelectorAll<HTMLElement>(
          '[role="heading"],h1,h2,h3,[data-testid="cell-frame-container"]',
        )) {
          if (e.matches('[data-testid="cell-frame-container"]')) {
            if (allowed && isVisible(e) && !e.closest('[data-testid="search-message-result"]'))
              rows.push(e);
          } else if (!e.closest('[data-testid="cell-frame-container"]') && isVisible(e))
            allowed = ['conversas', 'chats', 'contatos', 'contacts'].includes(
              normalize(e.textContent ?? ''),
            );
        }
        const matches = rows.filter((r) =>
          normalize(conversationRowLabel(r) ?? '').includes(normalize(job.query)),
        );
        const exact = matches.filter(
          (r) => normalize(conversationRowLabel(r) ?? '') === normalize(job.query),
        );
        return exact.length ? exact : matches;
      };
      let matches = candidates();
      if (matches.length > 1) throw new Error('AMBIGUOUS_CONTACT');
      if (normalize(label() ?? '') === normalize(job.query) && matches.length <= 1)
        return this.doc.querySelector<HTMLElement>('#main')!;
      const inputs = [
        ...this.doc.querySelectorAll<HTMLInputElement>(
          'input[aria-label="Pesquisar ou começar uma nova conversa"],input[aria-label="Search or start a new chat"]',
        ),
      ].filter(isVisible);
      if (inputs.length !== 1 || inputs[0]!.value.trim()) throw new Error('SEARCH_PANEL_BUSY');
      input = inputs[0]!;
      const descriptor = Object.getOwnPropertyDescriptor(
        this.doc.defaultView!.HTMLInputElement.prototype,
        'value',
      )!;
      descriptor.set!.call(input, job.query);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      ownsSearch = true;
      const started = Date.now();
      let signature = '';
      let changedAt = started;
      await wait(() => {
        if (!input?.isConnected || input.value !== job.query) throw new Error('SEARCH_CHANGED');
        matches = candidates();
        const next = matches.map((r) => conversationRowLabel(r)).join('\u0000');
        if (next !== signature) {
          signature = next;
          changedAt = Date.now();
        }
        return Date.now() - started >= 800 && Date.now() - changedAt >= 250;
      }, 5000);
      check();
      if (matches.length > 1) throw new Error('AMBIGUOUS_CONTACT');
      if (matches.length === 0) throw new Error('CONTACT_NOT_FOUND');
      const expected = conversationRowLabel(matches[0]!)!;
      openConversationResult(matches[0]!);
      await wait(() => normalize(label() ?? '') === normalize(expected), 6000);
      const root = this.doc.querySelector<HTMLElement>('#main');
      if (!root) throw new Error('CHAT_UNAVAILABLE');
      check();
      return root;
    } finally {
      this.doc.removeEventListener('pointerdown', onInput, true);
      this.doc.removeEventListener('keydown', onInput, true);
      if (ownsSearch && input?.isConnected && input.value === job.query && !interrupted) {
        const descriptor = Object.getOwnPropertyDescriptor(
          this.doc.defaultView!.HTMLInputElement.prototype,
          'value',
        )!;
        descriptor.set!.call(input, '');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
  }
}
