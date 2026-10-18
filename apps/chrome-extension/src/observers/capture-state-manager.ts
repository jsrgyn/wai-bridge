export class CaptureStateManager {
  private readonly messages = new WeakSet<HTMLElement>();
  private readonly unreadCounts = new WeakMap<HTMLElement, number>();
  private readonly rows = new WeakSet<HTMLElement>();

  claimMessage(message: HTMLElement): boolean {
    if (this.messages.has(message)) return false;
    this.messages.add(message);
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
