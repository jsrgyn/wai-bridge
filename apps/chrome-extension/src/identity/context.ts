import {
  ConversationIdentitySchema,
  normalizeProfilePhone,
  type ConversationIdentity,
  type CaptureObservation,
} from '@wai-bridge/shared';
import { IdentityControlSchema, IdentityPreviewSchema } from '../contracts.js';
import type { z } from 'zod';

type Preview = z.infer<typeof IdentityPreviewSchema>;
type Bind = Extract<z.infer<typeof IdentityControlSchema>, { kind: 'IDENTITY_BIND' }>;

/** Narrow DOM evidence and an ephemeral, conservative user-confirmed context. */
export class IdentityContext {
  private root: HTMLElement | undefined;
  private header: HTMLElement | undefined;
  private title: HTMLElement | undefined;
  private previewValue: Preview | undefined;
  private identity: ConversationIdentity | undefined;
  private readonly observer: MutationObserver;

  constructor(private readonly doc: Document = document) {
    this.observer = new MutationObserver((records) => this.checkMutations(records));
    this.observer.observe(doc.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['aria-label', 'title', 'data-testid', 'data-wai-conversation-type'],
    });
    doc.addEventListener('pointerdown', this.interaction, true);
    doc.addEventListener('keydown', this.interaction, true);
    doc.addEventListener('visibilitychange', this.visibility);
    doc.defaultView?.addEventListener('pagehide', this.navigation);
    doc.defaultView?.addEventListener('popstate', this.navigation);
    doc.defaultView?.addEventListener('hashchange', this.navigation);
  }

  private readonly visibility = () => {
    if (this.doc.hidden) this.clear();
  };
  private readonly navigation = () => this.clear();
  dispose(): void {
    this.clear();
    this.observer.disconnect();
    this.doc.removeEventListener('pointerdown', this.interaction, true);
    this.doc.removeEventListener('keydown', this.interaction, true);
    this.doc.removeEventListener('visibilitychange', this.visibility);
    for (const event of ['pagehide', 'popstate', 'hashchange'])
      this.doc.defaultView?.removeEventListener(event, this.navigation);
  }

  clear(): void {
    this.identity = undefined;
    this.previewValue = undefined;
    this.root = undefined;
    this.header = undefined;
    this.title = undefined;
  }

  private readonly interaction = (event: Event): void => {
    if (!this.previewValue) return;
    const target = event.target instanceof Element ? event.target : null;
    const composer = target?.closest('[contenteditable="true"]');
    const keyboard = event instanceof KeyboardEvent ? event : undefined;
    const sendButton = target?.closest(
      'button[aria-label="Enviar"], button[aria-label="Send"], [role="button"][aria-label="Enviar"], [role="button"][aria-label="Send"]',
    );
    if (!keyboard && sendButton && this.root?.contains(sendButton) && sendButton.closest('footer'))
      return;
    if (
      !composer ||
      !this.root?.contains(composer) ||
      (keyboard &&
        (keyboard.ctrlKey ||
          keyboard.metaKey ||
          keyboard.altKey ||
          ['Escape', 'Tab'].includes(keyboard.key)))
    )
      this.clear();
  };

  private checkMutations(records: MutationRecord[]): void {
    if (!this.previewValue) return;
    if (
      !this.root?.isConnected ||
      !this.header?.isConnected ||
      !this.title?.isConnected ||
      this.doc.querySelectorAll('#main, [data-wai-active-conversation]').length !== 1 ||
      this.doc.querySelector('#main, [data-wai-active-conversation]') !== this.root ||
      records.some((record) => this.title?.contains(record.target) || record.target === this.title)
    )
      this.clear();
  }

  private evidence(): { type: 'PHONE'; phone: string } | { type: 'GROUP_LOCAL' } {
    const drawers = Array.from(
      this.doc.querySelectorAll<HTMLElement>('[data-testid="chat-info-drawer"]'),
    ).filter((el) => this.visible(el));
    if (drawers.length !== 1)
      throw new Error('Abra os dados do contato ou do grupo antes de confirmar.');
    const drawer = drawers[0]!;
    const groupHeader = drawer.querySelector('[data-testid="group-info-header"]');
    const contactHeader = drawer.querySelector('[data-testid="contact-info-header"]');
    if (groupHeader && contactHeader) throw new Error('O painel de identificação está ambíguo.');
    const headings = Array.from((groupHeader ?? drawer).querySelectorAll('h1,h2,h3')).map((el) =>
      el.textContent?.trim(),
    );
    if (
      groupHeader &&
      this.visible(groupHeader) &&
      headings.some((text) => text === 'Dados do grupo' || text === 'Group info')
    )
      return { type: 'GROUP_LOCAL' };
    if (!contactHeader || !this.visible(contactHeader))
      throw new Error('O painel de identificação não foi reconhecido.');
    const phones = new Set(
      Array.from(drawer.querySelectorAll<HTMLElement>('span'))
        .filter((el) => el.children.length === 0 && this.visible(el))
        .map((el) => normalizeProfilePhone(el.textContent ?? ''))
        .filter((phone): phone is string => phone !== null),
    );
    if (phones.size !== 1)
      throw new Error('Não foi possível confirmar um único telefone completo no perfil.');
    return { type: 'PHONE', phone: [...phones][0]! };
  }

  private visible(element: Element): boolean {
    const view = this.doc.defaultView;
    if (!view) return false;
    const rect = element.getBoundingClientRect();
    if (
      rect.width <= 0 ||
      rect.height <= 0 ||
      rect.bottom <= 0 ||
      rect.right <= 0 ||
      rect.top >= view.innerHeight ||
      rect.left >= view.innerWidth
    )
      return false;
    for (let current: Element | null = element; current; current = current.parentElement) {
      const style = view.getComputedStyle(current);
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

  preview(): Preview {
    this.clear();
    const roots = this.doc.querySelectorAll<HTMLElement>('#main, [data-wai-active-conversation]');
    if (roots.length !== 1) throw new Error('Abra uma única conversa para confirmar o vínculo.');
    const root = roots[0]!;
    const header = root.querySelector<HTMLElement>('[data-testid="conversation-header"]');
    if (!header) throw new Error('O cabeçalho da conversa não foi reconhecido.');
    const evidence = this.evidence();
    this.root = root;
    this.header = header;
    this.title =
      header.querySelector<HTMLElement>('[data-testid="conversation-info-header-chat-title"]') ??
      header;
    this.previewValue = IdentityPreviewSchema.parse({
      contextId: crypto.randomUUID(),
      ...evidence,
    });
    return this.previewValue;
  }

  bind(input: Bind): ConversationIdentity {
    this.checkMutations(this.observer.takeRecords());
    if (!this.previewValue || this.previewValue.contextId !== input.contextId)
      throw new Error('A conversa mudou. Confira os dados novamente.');
    const evidence = this.evidence();
    if (
      evidence.type !== this.previewValue.type ||
      (evidence.type === 'PHONE' && evidence.phone !== this.previewValue.phone)
    ) {
      this.clear();
      throw new Error('Os dados de identificação mudaram.');
    }
    this.identity = ConversationIdentitySchema.parse({
      version: 1,
      accountId: input.accountId,
      contextId: input.contextId,
      confirmedAt: new Date().toISOString(),
      ...(evidence.type === 'PHONE'
        ? { type: 'PHONE', source: 'PROFILE_PHONE', phone: evidence.phone }
        : {
            type: 'GROUP_LOCAL',
            source: 'USER_GROUP',
            groupId: input.groupId,
            groupLabel: input.groupLabel,
          }),
    });
    return this.identity;
  }

  current(): ConversationIdentity | undefined {
    this.checkMutations(this.observer.takeRecords());
    if (!this.identity) return undefined;
    try {
      const evidence = this.evidence();
      if (
        evidence.type !== this.identity.type ||
        (evidence.type === 'PHONE' &&
          this.identity.type === 'PHONE' &&
          evidence.phone !== this.identity.phone)
      ) {
        this.clear();
        return undefined;
      }
    } catch {
      this.clear();
      return undefined;
    }
    return this.identity;
  }

  enrich(observation: CaptureObservation, root?: HTMLElement): CaptureObservation {
    const identity = this.current();
    if (!identity || root !== this.root || observation.observationType !== 'MESSAGE')
      return observation;
    return {
      ...observation,
      identity,
      conversation: {
        ...observation.conversation,
        kind: identity.type === 'PHONE' ? 'INDIVIDUAL' : 'GROUP',
      },
    };
  }
}
