export class CaptureStateManager {
  private readonly contexts = new Map<string, object>();
  constructor(
    private readonly contextKey: (root: HTMLElement) => string | undefined = () => undefined,
  ) {}
  private scope(root: HTMLElement): object {
    const key = this.contextKey(root);
    if (!key) return root;
    let scope = this.contexts.get(key);
    if (!scope) {
      scope = {};
      this.contexts.set(key, scope);
      if (this.contexts.size > 2000) this.contexts.delete(this.contexts.keys().next().value!);
    }
    return scope;
  }

  baseline(
    message: HTMLElement,
    root: HTMLElement,
    key: string | undefined,
    signature: string,
  ): void {
    // Compare subsequent changes with the initial UI without publishing history.
    // Revision zero is memory-only; the first real change is persisted as revision one.
    const value = {
      signature,
      ref: { key: crypto.randomUUID(), revision: 0, firstObservedAt: '' },
    };
    this.revisions.set(message, value);
    if (key) {
      const keys = this.keyedRevisions.get(this.scope(root)) ?? new Map();
      keys.set(key, value);
      if (keys.size > 2000) keys.delete(keys.keys().next().value!);
      this.keyedRevisions.set(this.scope(root), keys);
    }
  }
  private readonly messages = new WeakSet<HTMLElement>();
  private readonly renderKeys = new WeakMap<HTMLElement, Set<string>>();
  private readonly unreadCounts = new WeakMap<HTMLElement, number>();
  private readonly revisions = new WeakMap<
    HTMLElement,
    { signature: string; ref: { key: string; revision: number; firstObservedAt: string } }
  >();
  private readonly keyedRevisions = new WeakMap<
    object,
    Map<
      string,
      { signature: string; ref: { key: string; revision: number; firstObservedAt: string } }
    >
  >();
  hasObserved(message: HTMLElement, root?: HTMLElement, renderKey?: string): boolean {
    return root && renderKey
      ? Boolean(this.keyedRevisions.get(this.scope(root))?.has(renderKey))
      : this.revisions.has(message);
  }
  revision(
    message: HTMLElement,
    root: HTMLElement,
    renderKey: string | undefined,
    signature: string,
    force = false,
  ) {
    const keys = this.keyedRevisions.get(this.scope(root)) ?? new Map();
    const previous = renderKey ? keys.get(renderKey) : this.revisions.get(message);
    if (!force && previous?.signature === signature) {
      this.revisions.set(message, previous);
      return undefined;
    }
    const ref =
      previous && previous.ref.revision > 0
        ? { ...previous.ref, revision: previous.ref.revision + 1 }
        : { key: crypto.randomUUID(), revision: 1, firstObservedAt: new Date().toISOString() };
    const value = { signature, ref };
    this.revisions.set(message, value);
    if (renderKey) {
      keys.set(renderKey, value);
      if (keys.size > 2000) keys.delete(keys.keys().next().value!);
      this.keyedRevisions.set(this.scope(root), keys);
    }
    return ref;
  }
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
