import type { ConversationIdentity } from '@wai-bridge/shared';
import { visiblePeerDetails } from '../identity/visible-peer-details.js';

export function isVisible(element: Element): boolean {
  const view = element.ownerDocument.defaultView;
  const rect = element.getBoundingClientRect();
  if (
    !view ||
    rect.width <= 0 ||
    rect.height <= 0 ||
    rect.bottom <= 0 ||
    rect.right <= 0 ||
    rect.top >= view.innerHeight ||
    rect.left >= view.innerWidth
  )
    return false;
  for (let parent: Element | null = element; parent; parent = parent.parentElement) {
    const style = view.getComputedStyle(parent);
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
export class PhoneSearch {
  private input: HTMLInputElement | undefined;
  private phone: string | undefined;
  private interrupted = false;
  constructor(
    private readonly doc: Document,
    private readonly identity: { current(): ConversationIdentity | undefined },
  ) {}
  private readonly interrupt = (event: Event) => {
    if (event.isTrusted) this.interrupted = true;
  };
  async resolve(
    phone: string,
    accountId: string,
    signal: AbortSignal,
    gate: () => void,
  ): Promise<{ root: HTMLElement; contextId: string }> {
    const check = () => {
      gate();
      if (signal.aborted) throw new Error('USER_CANCELLED');
      if (this.interrupted) throw new Error('USER_INTERFERENCE');
      const current = this.identity.current();
      if (current && current.accountId !== accountId) throw new Error('RECIPIENT_ACCOUNT_MISMATCH');
      if (this.input && (!this.input.isConnected || this.input.value !== this.phone))
        throw new Error('SEARCH_CHANGED');
    };
    gate();
    if (
      [
        ...this.doc.querySelectorAll(
          '[data-testid="new-chat-drawer"],[data-testid="dialer-pad-drawer"]',
        ),
      ].some(isVisible)
    )
      throw new Error('SEARCH_PANEL_BUSY');
    if (this.identity.current()?.accountId !== accountId)
      throw new Error('RECIPIENT_ACCOUNT_MISMATCH');
    if (
      [...this.doc.querySelectorAll('#main footer [contenteditable="true"]')].some((e) =>
        e.textContent?.trim(),
      )
    )
      throw new Error('COMPOSER_HAS_DRAFT');
    const openRoot = this.doc.querySelector<HTMLElement>('#main');
    const openLabel = openRoot
      ?.querySelector('[data-testid="conversation-info-header-chat-title"]')
      ?.textContent?.trim();
    if (openRoot && openLabel && visiblePeerDetails(this.doc, openLabel).phone === phone) {
      check();
      const current = this.identity.current();
      if (current?.accountId === accountId) return { root: openRoot, contextId: current.contextId };
    }
    const searchInputs = () =>
      [
        ...this.doc.querySelectorAll<HTMLInputElement>(
          'input[aria-label="Pesquisar ou começar uma nova conversa"],input[aria-label="Search or start a new chat"]',
        ),
      ].filter(isVisible);
    let inputs = searchInputs();
    if (inputs.length !== 1) throw new Error('SEARCH_CONTROL_UNAVAILABLE');
    if (inputs[0]!.value.trim()) throw new Error('SEARCH_HAS_INPUT');
    this.doc.addEventListener('pointerdown', this.interrupt, true);
    this.doc.addEventListener('keydown', this.interrupt, true);
    this.doc.addEventListener('input', this.interrupt, true);
    const drawers = [
      ...this.doc.querySelectorAll<HTMLElement>('[data-testid="chat-info-drawer"]'),
    ].filter(isVisible);
    if (drawers.length) {
      if (
        drawers.length !== 1 ||
        [...drawers[0]!.querySelectorAll('input,textarea,[contenteditable="true"]')].some(
          (field) =>
            isVisible(field) &&
            !field.matches(
              'input[type="search"],input[type="checkbox"],input[type="radio"],input[readonly],input[disabled],textarea[readonly],textarea[disabled]',
            ),
        )
      )
        throw new Error('PROFILE_HAS_INPUT');
      const close = [
        ...drawers[0]!.querySelectorAll<HTMLButtonElement>(
          'button[aria-label="Fechar"],button[aria-label="Close"]',
        ),
      ].filter(isVisible);
      if (close.length !== 1 || close[0]!.disabled) throw new Error('PROFILE_CLOSE_UNAVAILABLE');
      check();
      close[0]!.click();
      await this.until(
        () =>
          [...this.doc.querySelectorAll('[data-testid="chat-info-drawer"]')].some(isVisible)
            ? undefined
            : true,
        check,
      );
      inputs = searchInputs();
      if (inputs.length !== 1 || inputs[0]!.value.trim()) throw new Error('SEARCH_CHANGED');
    }
    this.input = inputs[0];
    this.phone = phone;
    const baseline = this.resultLabels('#pane-side');
    this.write(phone);
    check();
    let candidate = await this.findCandidate('#pane-side', check, baseline);
    if (!candidate) {
      // Search the visible contact directory as well, including contacts without a prior chat.
      this.write('');
      check();
      const buttons = [
        ...this.doc.querySelectorAll<HTMLButtonElement>(
          'button[aria-label="Nova conversa"],button[aria-label="New chat"]',
        ),
      ].filter(isVisible);
      if (buttons.length !== 1 || buttons[0]!.disabled) throw new Error('PHONE_CONTACT_NOT_FOUND');
      buttons[0]!.click();
      this.input = undefined;
      const input = await this.until(() => {
        const fields = [
          ...this.doc.querySelectorAll<HTMLInputElement>(
            '[data-testid="new-chat-drawer"] input[aria-label="Pesquisar nome, número ou @nomedeusuário"],[data-testid="new-chat-drawer"] input[aria-label="Search name, number or @username"]',
          ),
        ].filter(isVisible);
        return fields.length === 1 ? fields[0] : undefined;
      }, check);
      if (input.value.trim()) throw new Error('SEARCH_HAS_INPUT');
      this.input = input;
      this.write(phone);
      candidate = await this.findCandidate('[data-testid="new-chat-drawer"]', check);
    }
    if (!candidate) throw new Error('PHONE_CONTACT_NOT_FOUND');
    check();
    const expectedLabel = candidate
      .querySelector('[data-testid="cell-frame-title"]')
      ?.textContent?.trim();
    if (!expectedLabel) throw new Error('PHONE_RESULT_LABEL_UNAVAILABLE');
    const directoryInput = this.input?.closest('[data-testid="new-chat-drawer"]');
    candidate.click();
    if (directoryInput) this.input = undefined;
    await this.until(() => {
      if (
        this.doc
          .querySelector('#main [data-testid="conversation-info-header-chat-title"]')
          ?.textContent?.trim() !== expectedLabel
      )
        return undefined;
      const controls = [
        ...this.doc.querySelectorAll<HTMLElement>(
          '#main header [role="button"][aria-label="Dados do perfil"],#main header [role="button"][aria-label="Profile details"]',
        ),
      ].filter(isVisible);
      return controls.length === 1 ? controls[0] : undefined;
    }, check).then((control) => control.click());
    const root = await this.until(() => {
      const roots = this.doc.querySelectorAll<HTMLElement>('#main');
      if (roots.length !== 1) return undefined;
      const root = roots[0]!;
      const label = root
        .querySelector('[data-testid="conversation-info-header-chat-title"]')
        ?.textContent?.trim();
      if (!label) return undefined;
      const details = visiblePeerDetails(this.doc, label);
      if (details.kind === 'GROUP') throw new Error('RECIPIENT_IS_GROUP');
      if (details.phone && details.phone !== phone) throw new Error('RECIPIENT_PHONE_MISMATCH');
      return details.kind === 'INDIVIDUAL' && details.phone === phone ? root : undefined;
    }, check);
    check();
    const current = this.identity.current();
    if (!current || current.accountId !== accountId) throw new Error('RECIPIENT_ACCOUNT_MISMATCH');
    this.removeListeners();
    return { root, contextId: current.contextId };
  }
  /** Search also returns groups in common and message matches; neither is a direct recipient. */
  private candidateRows(scope: string): HTMLElement[] {
    const container = this.doc.querySelector(scope);
    if (!container) return [];
    let section: boolean | undefined;
    const candidates: HTMLElement[] = [];
    for (const element of container.querySelectorAll<HTMLElement>(
      '[role="heading"],h1,h2,h3,[data-testid="cell-frame-container"]',
    )) {
      if (element.matches('[data-testid="cell-frame-container"]')) {
        if (!isVisible(element) || section === false) continue;
        if (scope !== '#pane-side' && !element.closest('[role="button"]')) continue;
        candidates.push(element);
      } else if (
        scope === '#pane-side' &&
        !element.closest('[data-testid="cell-frame-container"]') &&
        isVisible(element)
      ) {
        const title = element.textContent
          ?.normalize('NFD')
          .replace(/\p{M}/gu, '')
          .trim()
          .toLowerCase();
        section = ['conversas', 'chats', 'contatos', 'contacts'].includes(title ?? '');
      }
    }
    return candidates;
  }
  private resultLabels(scope: string): string[] {
    return [...this.doc.querySelectorAll(`${scope} [data-testid="cell-frame-container"]`)]
      .filter(isVisible)
      .map((row) => row.querySelector('[data-testid="cell-frame-title"]')?.textContent ?? '');
  }
  private async findCandidate(
    scope: string,
    check: () => void,
    baseline?: string[],
  ): Promise<HTMLElement | undefined> {
    let signature = '';
    let stableAt = Date.now();
    const startedAt = Date.now();
    const due = startedAt + 8000;
    let updated = !baseline || baseline.length <= 1;
    while (Date.now() < due) {
      check();
      // React can update the textbox/results heading before replacing the old chat rows.
      // Do not classify those stale rows as an ambiguous search response.
      if (baseline && JSON.stringify(this.resultLabels(scope)) !== JSON.stringify(baseline))
        updated = true;
      const rows = this.candidateRows(scope);
      if (
        baseline &&
        JSON.stringify(
          rows.map(
            (row) => row.querySelector('[data-testid="cell-frame-title"]')?.textContent ?? '',
          ),
        ) !== JSON.stringify(baseline)
      )
        updated = true;
      const next = rows
        .map((row) => row.querySelector('[data-testid="cell-frame-title"]')?.textContent ?? '')
        .join('\u0000');
      if (next !== signature) {
        signature = next;
        stableAt = Date.now();
      }
      const container = this.doc.querySelector(scope);
      const busy =
        Boolean(container?.matches('[aria-busy="true"]') && isVisible(container)) ||
        [
          ...this.doc.querySelectorAll(`${scope} [aria-busy="true"],${scope} [role="progressbar"]`),
        ].some(isVisible);
      if (
        updated &&
        !busy &&
        rows.length &&
        Date.now() - stableAt >= 800 &&
        Date.now() - startedAt >= 800
      ) {
        if (rows.length !== 1) throw new Error('AMBIGUOUS_PHONE_RESULTS');
        return rows[0];
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!updated) throw new Error('SEARCH_RESULTS_NOT_READY');
    return undefined;
  }
  release(signal: AbortSignal): void {
    this.removeListeners();
    if (
      !this.interrupted &&
      !signal.aborted &&
      this.input?.isConnected &&
      this.input.value === this.phone
    )
      this.write('');
  }
  private removeListeners(): void {
    for (const event of ['pointerdown', 'keydown', 'input'])
      this.doc.removeEventListener(event, this.interrupt, true);
  }
  private write(value: string): void {
    if (!this.input) return;
    this.phone = value;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setter) throw new Error('SEARCH_CONTROL_UNAVAILABLE');
    setter.call(this.input, value);
    this.input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  private async until<T>(read: () => T | undefined, check: () => void): Promise<T> {
    const due = Date.now() + 5000;
    while (Date.now() < due) {
      check();
      const value = read();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('PHONE_PROFILE_UNAVAILABLE');
  }
}
