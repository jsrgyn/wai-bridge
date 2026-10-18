/** Experimental visible DOM selectors. These are not a supported WhatsApp API. */
export class WhatsAppDomAdapter {
  private readonly messageSelector =
    '[data-wai-message][role="article"], [data-testid="msg-container"], .message-in, .message-out';
  private readonly rowSelector =
    '[data-wai-conversation-row], [data-testid="cell-frame-container"], [role="row"], [role="listitem"]';
  private readonly unreadSelector =
    '[data-wai-unread-count], [data-testid="icon-unread-count"], [aria-label*="unread" i]';

  findMessageRoots(scope: ParentNode): HTMLElement[] {
    return this.findRoots(scope, '[data-wai-observation-root][role="log"], #main');
  }

  findConversationLists(scope: ParentNode): HTMLElement[] {
    return this.findRoots(scope, '[data-wai-conversation-list], #pane-side');
  }

  findNewMessages(node: Node): HTMLElement[] {
    if (!(node instanceof Element)) return [];
    const found = [
      ...(node.matches(this.messageSelector) ? [node as HTMLElement] : []),
      ...node.querySelectorAll<HTMLElement>(this.messageSelector),
    ];
    return found.filter(
      (element) => !found.some((other) => other !== element && other.contains(element)),
    );
  }

  containingMessage(node: Node): HTMLElement | null {
    const element = node instanceof Element ? node : node.parentElement;
    return element?.closest<HTMLElement>(this.messageSelector) ?? null;
  }

  renderKey(message: HTMLElement): string | undefined {
    // Visible DOM marker only: transient page-local deduplication, never a contact
    // identity or a persistent external message ID. Do not parse its contents.
    const row = message.closest('[data-testid^="conv-msg-"]');
    const marker = row?.getAttribute('data-testid');
    return row?.closest('#main') && marker && marker.length <= 256 ? marker : undefined;
  }

  messageDirection(message: HTMLElement): 'INBOUND' | 'OUTBOUND' | 'UNKNOWN' {
    const explicit = message.closest<HTMLElement>(
      '[data-wai-direction], .message-in, .message-out',
    );
    if (explicit?.dataset.waiDirection === 'INBOUND' || explicit?.classList.contains('message-in'))
      return 'INBOUND';
    if (
      explicit?.dataset.waiDirection === 'OUTBOUND' ||
      explicit?.classList.contains('message-out')
    )
      return 'OUTBOUND';

    // Experimental UI fallback: current bubbles no longer have message-in/out classes.
    // Only recognize the inspected bubble structure and unambiguous LTR alignment.
    const bubble = message.matches('[data-testid="msg-container"]') ? message : null;
    const wrapper = bubble?.parentElement;
    const row = bubble?.closest('[role="row"]');
    if (
      !bubble?.querySelector('[data-testid="msg-meta"]') ||
      !wrapper ||
      !row ||
      !row.closest('#main')
    )
      return 'UNKNOWN';
    const incoming = Boolean(bubble.querySelector('[data-testid="tail-in"]'));
    const outgoing = Boolean(bubble.querySelector('[data-testid="tail-out"]'));
    if (incoming && outgoing) return 'UNKNOWN';
    const style = wrapper.ownerDocument.defaultView?.getComputedStyle(wrapper);
    if (style?.display !== 'flex' || style.flexDirection !== 'column' || style.direction !== 'ltr')
      return 'UNKNOWN';
    if (style.alignItems === 'flex-start' && !outgoing) return 'INBOUND';
    if (style.alignItems === 'flex-end' && !incoming) return 'OUTBOUND';
    return 'UNKNOWN';
  }

  findConversationRow(node: Node): HTMLElement | null {
    const element = node instanceof Element ? node : node.parentElement;
    return element?.closest<HTMLElement>(this.rowSelector) ?? null;
  }

  findNewRows(node: Node): HTMLElement[] {
    if (!(node instanceof Element)) return [];
    return [
      ...(node.matches(this.rowSelector) ? [node as HTMLElement] : []),
      ...node.querySelectorAll<HTMLElement>(this.rowSelector),
    ];
  }

  isRelevantUnreadChange(record: MutationRecord): boolean {
    if (record.type === 'attributes')
      return (
        record.attributeName === 'aria-label' || record.attributeName === 'data-wai-unread-count'
      );
    const target = record.target instanceof Element ? record.target : record.target.parentElement;
    if (target?.matches(this.unreadSelector)) return true;
    return Array.from(record.addedNodes).some(
      (node) =>
        node instanceof Element &&
        (node.matches(this.rowSelector + ', ' + this.unreadSelector) ||
          Boolean(node.querySelector(this.unreadSelector))),
    );
  }

  unreadCount(row: HTMLElement): number | null {
    const indicator = row.querySelector<HTMLElement>(this.unreadSelector);
    if (!indicator) return null;
    const text =
      indicator.getAttribute('data-wai-unread-count') ??
      indicator.getAttribute('aria-label') ??
      indicator.textContent ??
      '';
    const count = Number.parseInt(text.match(/\d+/)?.[0] ?? '1', 10);
    return Number.isFinite(count) && count > 0 ? count : null;
  }

  private findRoots(scope: ParentNode, selector: string): HTMLElement[] {
    const roots = Array.from(scope.querySelectorAll<HTMLElement>(selector));
    if (scope instanceof HTMLElement && scope.matches(selector)) roots.unshift(scope);
    return roots;
  }
}
