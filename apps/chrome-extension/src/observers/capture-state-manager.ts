export class CaptureStateManager {
  private readonly messages = new WeakSet<HTMLElement>();
  private readonly renderKeys = new WeakMap<HTMLElement, Set<string>>();
  private readonly unreadCounts = new WeakMap<HTMLElement, number>();
  private readonly rows = new WeakSet<HTMLElement>();

  claimMessage(message: HTMLElement, root?: HTMLElement, renderKey?: string): boolean {
    if (this.messages.has(message)) return false;
    this.messages.add(message);
    if (root && renderKey) {
      const keys = this.renderKeys.get(root) ?? new Set<string>();
      if (keys.has(renderKey)) return false;
      keys.add(renderKey);
      // Bounded, memory-only cache. Equal text is never a duplicate criterion.
      if (keys.size > 2_000) keys.delete(keys.values().next().value!);
      this.renderKeys.set(root, keys);
    }
    return true;
  }

  claimUnreadChange(row: HTMLElement, count: number): boolean {
    const previous = this.unreadCounts.get(row) ?? 0;
    this.unreadCounts.set(row, count);
    return count > previous;
  }

  claimNewRow(row: HTMLElement): boolean {
    if (this.rows.has(row)) return false;
    this.rows.add(row);
    return true;
  }
}
