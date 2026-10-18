/** Experimental visible DOM selectors. These are not a supported WhatsApp API. */
export class WhatsAppDomAdapter {
  private readonly messageSelector = '[data-wai-message][role="article"], [data-testid="msg-container"], .message-in, .message-out';
  private readonly rowSelector = '[data-wai-conversation-row], [data-testid="cell-frame-container"], [role="row"], [role="listitem"]';
  private readonly unreadSelector = '[data-wai-unread-count], [data-testid="icon-unread-count"], [aria-label*="unread" i]';

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
    return found.filter((element) => !found.some((other) => other !== element && other.contains(element)));
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
    if (record.type === 'attributes') return record.attributeName === 'aria-label' || record.attributeName === 'data-wai-unread-count';
    const target = record.target instanceof Element ? record.target : record.target.parentElement;
    if (target?.matches(this.unreadSelector)) return true;
    return Array.from(record.addedNodes).some((node) => node instanceof Element && (
      node.matches(this.rowSelector + ', ' + this.unreadSelector) || Boolean(node.querySelector(this.unreadSelector))
    ));
  }

  unreadCount(row: HTMLElement): number | null {
    const indicator = row.querySelector<HTMLElement>(this.unreadSelector);
    if (!indicator) return null;
    const text = indicator.getAttribute('data-wai-unread-count') ?? indicator.getAttribute('aria-label') ?? indicator.textContent ?? '';
    const count = Number.parseInt(text.match(/\d+/)?.[0] ?? '1', 10);
    return Number.isFinite(count) && count > 0 ? count : null;
  }

  private findRoots(scope: ParentNode, selector: string): HTMLElement[] {
    const roots = Array.from(scope.querySelectorAll<HTMLElement>(selector));
    if (scope instanceof HTMLElement && scope.matches(selector)) roots.unshift(scope);
    return roots;
  }
}
