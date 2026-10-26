import { normalizeProfilePhone, type ConversationIdentity } from '@wai-bridge/shared';
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
/** Contact rows and the account's own chat row, which WhatsApp renders without a cell frame. */
const RESULT_ROW = '[data-testid="cell-frame-container"],[data-testid="message-yourself-row"]';
const SELF_ROW = '[data-testid="message-yourself-row"]';
export type ResolvedPhoneRecipient = {
  root: HTMLElement;
  contextId: string;
  phone: string;
  label: string;
  identity: ConversationIdentity;
};
export class PhoneSearch {
  private input: HTMLInputElement | undefined;
  private phone: string | undefined;
  private interrupted = false;
  private unrecognized = false;
  constructor(
    private readonly doc: Document,
    private readonly identity: { current(): ConversationIdentity | undefined },
    private readonly onOpenStage?: (phase: 'CHAT_OPEN_STARTED' | 'CHAT_OPENED') => void,
  ) {}
  private readonly interrupt = (event: Event) => {
    if (event.isTrusted) this.interrupted = true;
  };
  async resolve(
    phone: string,
    accountId: string,
    signal: AbortSignal,
    gate: () => void,
  ): Promise<ResolvedPhoneRecipient> {
    const normalizedPhone = normalizeProfilePhone(phone);
    if (!normalizedPhone) throw new Error('RECIPIENT_PHONE_MISMATCH');
    phone = normalizedPhone;
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
    if (this.identity.current()?.accountId !== accountId)
      throw new Error('RECIPIENT_ACCOUNT_MISMATCH');
    // Leftover search text or an open new-chat drawer is normalized, not a failure.
    await this.normalizeSearch();
    const openRoot = this.doc.querySelector<HTMLElement>('#main');
    const openLabel = openRoot
      ?.querySelector('[data-testid="conversation-info-header-chat-title"]')
      ?.textContent?.trim();
    if (openRoot && openLabel && visiblePeerDetails(this.doc, openLabel).phone === phone) {
      check();
      const current = this.identity.current();
      if (current?.accountId === accountId)
        return this.confirmAndClose(openRoot, phone, accountId, check);
    }
    const searchInputs = () =>
      [
        ...this.doc.querySelectorAll<HTMLInputElement>(
          'input[aria-label="Pesquisar ou começar uma nova conversa"],input[aria-label="Search or start a new chat"]',
        ),
      ].filter(isVisible);
    let inputs = searchInputs();
    if (inputs.length !== 1) throw new Error('SEARCH_CONTROL_UNAVAILABLE');
    if (inputs[0]!.value.trim()) throw new Error('SEARCH_CHANGED');
    this.doc.addEventListener('pointerdown', this.interrupt, true);
    this.doc.addEventListener('keydown', this.interrupt, true);
    this.doc.addEventListener('input', this.interrupt, true);
    const drawers = [
      ...this.doc.querySelectorAll<HTMLElement>('[data-testid="chat-info-drawer"]'),
    ].filter(isVisible);
    if (drawers.length) {
      await this.closeProfile(check);
      inputs = searchInputs();
      if (inputs.length !== 1 || inputs[0]!.value.trim()) throw new Error('SEARCH_CHANGED');
    }
    this.input = inputs[0];
    this.phone = phone;
    const baseline = this.resultLabels('#pane-side');
    this.write(phone);
    check();
    this.unrecognized = false;
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
      if (buttons.length !== 1 || buttons[0]!.disabled) throw new Error(this.notFoundCode());
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
      if (input.value.trim()) this.setField(input, '');
      this.input = input;
      this.write(phone);
      candidate = await this.findCandidate('[data-testid="new-chat-drawer"]', check);
    }
    if (!candidate) throw new Error(this.notFoundCode());
    check();
    const expectedLabel = this.resultLabel(candidate);
    if (!expectedLabel) throw new Error('PHONE_RESULT_LABEL_UNAVAILABLE');
    const directoryInput = this.input?.closest('[data-testid="new-chat-drawer"]');
    this.openCandidate(candidate);
    if (directoryInput) this.input = undefined;
    await this.until(
      () =>
        this.doc
          .querySelector('#main [data-testid="conversation-info-header-chat-title"]')
          ?.textContent?.trim()
          .normalize('NFC') === expectedLabel
          ? true
          : undefined,
      check,
      'PHONE_CHAT_UNAVAILABLE',
    );
    this.traceOpen('CHAT_OPENED');
    // Opening an already visible profile can toggle it closed. Reuse only a
    // verified matching profile; never accept a result based on its name alone.
    const existingDetails = visiblePeerDetails(this.doc, expectedLabel);
    if (existingDetails.kind === 'GROUP') throw new Error('RECIPIENT_IS_GROUP');
    if (existingDetails.phone && existingDetails.phone !== phone)
      throw new Error('RECIPIENT_PHONE_MISMATCH');
    if (existingDetails.phone !== phone) {
      const control = await this.until(
        () => {
          const controls = [
            ...this.doc.querySelectorAll<HTMLElement>(
              '#main header button[aria-label="Dados do perfil"],#main header button[aria-label="Profile details"],#main header [role="button"][aria-label="Dados do perfil"],#main header [role="button"][aria-label="Profile details"]',
            ),
          ].filter(isVisible);
          return controls.length === 1 ? controls[0] : undefined;
        },
        check,
        'PHONE_PROFILE_CONTROL_UNAVAILABLE',
      );
      check();
      control.click();
    }
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
    return this.confirmAndClose(root, phone, accountId, check);
  }
  private async confirmAndClose(
    root: HTMLElement,
    phone: string,
    accountId: string,
    check: () => void,
  ): Promise<ResolvedPhoneRecipient> {
    check();
    const label = root
      .querySelector('[data-testid="conversation-info-header-chat-title"]')
      ?.textContent?.trim();
    if (!label || visiblePeerDetails(this.doc, label).phone !== phone)
      throw new Error('RECIPIENT_PHONE_MISMATCH');
    // Close only after capturing exact visible evidence. The proof is scoped to
    // this execution, DOM root and context, never a reusable authorization by name.
    await this.closeProfile(check);
    check();
    const current = this.identity.current();
    if (!current || current.accountId !== accountId) throw new Error('RECIPIENT_ACCOUNT_MISMATCH');
    // Search box empty and drawers closed; the target chat stays open.
    await this.resetAfterVerify();
    if (
      this.doc.querySelector('#main') !== root ||
      root
        .querySelector('[data-testid="conversation-info-header-chat-title"]')
        ?.textContent?.trim() !== label
    )
      throw new Error('RECIPIENT_CONTEXT_MISMATCH');
    const identity: ConversationIdentity =
      current.type === 'UI_CONTEXT'
        ? { ...current, conversationKind: 'INDIVIDUAL', phone }
        : current;
    if (identity.type !== 'UI_CONTEXT' && (identity.type !== 'PHONE' || identity.phone !== phone))
      throw new Error('RECIPIENT_PHONE_MISMATCH');
    this.removeListeners();
    return { root, contextId: current.contextId, phone, label, identity };
  }
  private async closeProfile(check: () => void): Promise<void> {
    const drawers = [
      ...this.doc.querySelectorAll<HTMLElement>('[data-testid="chat-info-drawer"]'),
    ].filter(isVisible);
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
    const controls = [
      ...drawers[0]!.querySelectorAll<HTMLElement>(
        'button[aria-label="Fechar"],button[aria-label="Close"],[role="button"][aria-label="Fechar"],[role="button"][aria-label="Close"]',
      ),
    ].filter(isVisible);
    if (
      controls.length !== 1 ||
      controls[0]!.getAttribute('aria-disabled') === 'true' ||
      (controls[0] instanceof HTMLButtonElement && controls[0].disabled)
    )
      throw new Error('PROFILE_CLOSE_UNAVAILABLE');
    check();
    controls[0]!.click();
    await this.until(
      () =>
        [...this.doc.querySelectorAll('[data-testid="chat-info-drawer"]')].some(isVisible)
          ? undefined
          : true,
      check,
      'PROFILE_CLOSE_UNAVAILABLE',
    );
  }
  private traceOpen(phase: 'CHAT_OPEN_STARTED' | 'CHAT_OPENED'): void {
    try {
      this.onOpenStage?.(phase);
    } catch {
      /* Diagnostics never change execution. */
    }
  }
  private notFoundCode(): string {
    // Visible rows of an unknown shape are a structure change, not a missing contact.
    return this.unrecognized ? 'SEARCH_ROWS_UNRECOGNIZED' : 'PHONE_CONTACT_NOT_FOUND';
  }
  private resultLabel(candidate: HTMLElement): string | undefined {
    const label = this.rawResultLabel(candidate);
    // The own-chat row appends a suffix the chat header omits. The phone is
    // still proven afterwards from the opened profile, never from this name.
    return candidate.matches(SELF_ROW) ? label?.replace(/\s+\((você|you)\)$/iu, '') : label;
  }
  private rawResultLabel(candidate: HTMLElement): string | undefined {
    const title = candidate.querySelector('[data-testid="cell-frame-title"]');
    if (!title) return undefined;
    // The title container also contains the unread badge. Read the named span
    // when available; highlights remain part of its rendered text.
    const named = [...title.querySelectorAll('[title]')].filter((e) =>
      e.getAttribute('title')?.trim(),
    );
    if (named.length > 1) throw new Error('PHONE_RESULT_LABEL_UNAVAILABLE');
    return (named[0] ?? title).textContent?.trim().normalize('NFC');
  }
  private openCandidate(candidate: HTMLElement): void {
    const scope = candidate.closest('#pane-side,[data-testid="new-chat-drawer"]');
    if (!scope || !candidate.isConnected || !isVisible(candidate))
      throw new Error('SEARCH_RESULTS_NOT_READY');
    const row = candidate.closest('[role="row"]');
    const actionable = candidate.closest<HTMLElement>('[role="gridcell"],[role="button"],button');
    const target =
      actionable && scope.contains(actionable) && (!row || row.contains(actionable))
        ? actionable
        : candidate;
    if (target.querySelectorAll(RESULT_ROW).length > 1)
      throw new Error('AMBIGUOUS_PHONE_RESULTS');
    this.traceOpen('CHAT_OPEN_STARTED');
    target.focus({ preventScroll: true });
    // HTMLElement.click alone omits the press events used by list selection.
    // Use one ordinary DOM gesture on the uniquely resolved row, never a global
    // first-result click, private application handlers or a repeated send.
    const view = this.doc.defaultView!;
    const dispatch = (event: Event) => {
      if (candidate.isConnected && target.isConnected) candidate.dispatchEvent(event);
    };
    dispatch(
      new view.PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons: 1,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
      }),
    );
    dispatch(
      new view.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, buttons: 1 }),
    );
    dispatch(
      new view.PointerEvent('pointerup', {
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons: 0,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
      }),
    );
    dispatch(
      new view.MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0, buttons: 0 }),
    );
    if (candidate.isConnected && target.isConnected) candidate.click();
  }
  /** Search also returns groups in common and message matches; neither is a direct recipient. */
  private candidateRows(scope: string): HTMLElement[] {
    const container = this.doc.querySelector(scope);
    if (!container) return [];
    let section: boolean | undefined;
    const candidates: HTMLElement[] = [];
    for (const element of container.querySelectorAll<HTMLElement>(
      `[role="heading"],h1,h2,h3,${RESULT_ROW}`,
    )) {
      if (element.matches(RESULT_ROW)) {
        if (!isVisible(element) || section === false) continue;
        if (scope !== '#pane-side' && !element.closest('[role="button"]')) continue;
        candidates.push(element);
      } else if (
        scope === '#pane-side' &&
        !element.closest(RESULT_ROW) &&
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
  /** Visible list rows with text that hold no recognized result container or heading. */
  private hasUnrecognizedRows(scope: string): boolean {
    const container = this.doc.querySelector(scope);
    if (!container) return false;
    return [...container.querySelectorAll<HTMLElement>('[role="row"],[role="listitem"]')].some(
      (row) =>
        isVisible(row) &&
        Boolean(row.textContent?.trim()) &&
        !row.querySelector(`${RESULT_ROW},[role="heading"],h1,h2,h3`) &&
        !row.closest(RESULT_ROW),
    );
  }
  private resultLabels(scope: string): string[] {
    return [...this.doc.querySelectorAll(`${scope} :is(${RESULT_ROW})`)]
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
    if (this.hasUnrecognizedRows(scope)) this.unrecognized = true;
    return undefined;
  }
  /** Cleans the sidebar search, closes the new-chat and profile drawers. Idempotent. */
  async normalize(): Promise<void> {
    this.removeListeners();
    await this.normalizeSearch();
    if (this.interrupted) return;
    if (this.visibleProfileDrawers().length) await this.closeProfile(() => {});
  }
  /** Normalizes right after verification while the target chat remains open. */
  async resetAfterVerify(): Promise<void> {
    await this.normalize();
  }
  /** Best-effort cleanup used in finally blocks; never throws. */
  async release(signal?: AbortSignal): Promise<void> {
    void signal; // Kept for caller compatibility; cleanup ignores cancellation.
    try {
      await this.normalize();
    } catch {
      /* Cleanup never changes the execution outcome. */
    }
  }
  private visibleProfileDrawers(): HTMLElement[] {
    return [...this.doc.querySelectorAll<HTMLElement>('[data-testid="chat-info-drawer"]')].filter(
      isVisible,
    );
  }
  private async normalizeSearch(): Promise<void> {
    // Never touch what the user typed or opened during this execution.
    if (this.interrupted) return;
    const drawerSelector = '[data-testid="new-chat-drawer"],[data-testid="dialer-pad-drawer"]';
    const drawers = [...this.doc.querySelectorAll<HTMLElement>(drawerSelector)].filter(isVisible);
    for (const drawer of drawers) {
      for (const field of drawer.querySelectorAll<HTMLInputElement>('input'))
        if (field.value) this.setField(field, '');
      const controls = [
        ...drawer.querySelectorAll<HTMLElement>(
          'button[aria-label="Voltar"],button[aria-label="Back"],[role="button"][aria-label="Voltar"],[role="button"][aria-label="Back"],button[aria-label="Fechar"],button[aria-label="Close"],[role="button"][aria-label="Fechar"],[role="button"][aria-label="Close"]',
        ),
      ].filter(isVisible);
      if (
        controls.length !== 1 ||
        controls[0]!.getAttribute('aria-disabled') === 'true' ||
        (controls[0] instanceof HTMLButtonElement && controls[0].disabled)
      )
        throw new Error('NEW_CHAT_CLOSE_UNAVAILABLE');
      controls[0]!.click();
    }
    if (drawers.length)
      await this.until(
        () => ([...this.doc.querySelectorAll(drawerSelector)].some(isVisible) ? undefined : true),
        () => {},
        'NEW_CHAT_CLOSE_UNAVAILABLE',
      );
    const inputs = [
      ...this.doc.querySelectorAll<HTMLInputElement>(
        'input[aria-label="Pesquisar ou começar uma nova conversa"],input[aria-label="Search or start a new chat"]',
      ),
    ].filter(isVisible);
    if (inputs.length === 1 && inputs[0]!.value) this.setField(inputs[0]!, '');
    this.input = undefined;
  }
  private removeListeners(): void {
    for (const event of ['pointerdown', 'keydown', 'input'])
      this.doc.removeEventListener(event, this.interrupt, true);
  }
  private write(value: string): void {
    if (!this.input) return;
    this.phone = value;
    this.setField(this.input, value);
  }
  private setField(field: HTMLInputElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setter) throw new Error('SEARCH_CONTROL_UNAVAILABLE');
    setter.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  }
  private async until<T>(
    read: () => T | undefined,
    check: () => void,
    code = 'PHONE_PROFILE_UNAVAILABLE',
  ): Promise<T> {
    const due = Date.now() + 5000;
    while (Date.now() < due) {
      check();
      const value = read();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(code);
  }
}
