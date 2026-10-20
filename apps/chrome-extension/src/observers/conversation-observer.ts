import { messageText } from '../adapters/message-text.js';
import { conversationRowLabel } from '../adapters/conversation-label.js';
import { CaptureObservationSchema, type CaptureObservation } from '../contracts.js';
import { WhatsAppDomAdapter } from '../adapters/dom-adapter.js';
import { GroupDetector } from '../adapters/group-detector.js';
import { CaptureStateManager } from './capture-state-manager.js';

export class ConversationObserver {
  private readonly observers = new Map<HTMLElement, MutationObserver>();
  // Memory only: previews are change signals, never persisted as full messages.
  private unread = new WeakMap<HTMLElement, number | null>();
  private previews = new WeakMap<HTMLElement, string | null>();

  constructor(
    private readonly emit: (value: CaptureObservation, root?: HTMLElement) => void,
    private readonly state: CaptureStateManager,
    private readonly adapter = new WhatsAppDomAdapter(),
    private readonly groups = new GroupDetector(),
  ) {}

  attach(list: HTMLElement): void {
    if (this.observers.has(list)) return;
    // Establish a baseline without importing initial previews or unread history.
    for (const row of this.rows(list)) {
      this.previews.set(row, this.preview(row));
      this.state.claimNewRow(row);
      const count = this.adapter.unreadCount(row);
      this.unread.set(row, count ?? null);
      this.state.claimUnreadChange(row, count ?? 0);
      if (count && count > 0) this.emit(this.detected(row, 'INITIAL_UNREAD'), row);
    }
    const observer = new MutationObserver((records) => {
      const changed = new Set<HTMLElement>();
      for (const record of records) {
        const row = this.adapter.findConversationRow(record.target);
        if (row) changed.add(this.canonical(row));
        for (const node of record.addedNodes) {
          if (node instanceof Element) for (const added of this.rows(node)) changed.add(added);
        }
      }
      for (const row of changed) {
        if (!row.isConnected || !list.contains(row)) continue;
        const count = this.adapter.unreadCount(row) ?? null;
        const previousCount = this.unread.get(row);
        this.unread.set(row, count);
        const decreased =
          previousCount !== undefined && previousCount !== null && (count ?? 0) < previousCount;
        const fresh = this.state.claimNewRow(row);
        const unread = this.state.claimUnreadChange(row, this.adapter.unreadCount(row) ?? 0);
        const preview = this.preview(row);
        const previous = this.previews.get(row);
        const updatedPreview = previous !== undefined && preview !== null && preview !== previous;
        this.previews.set(row, preview);
        // A phone/browser outgoing message may change the preview without unread.
        // Neither a preview nor a UI change proves direction or complete content.
        if (fresh || unread || updatedPreview) this.emit(this.detected(row, 'ROW_CHANGED'), row);
        else if (decreased) this.emit(this.detected(row, 'UNREAD_DECREASED'), row);
      }
    });
    observer.observe(list, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
    this.observers.set(list, observer);
  }

  prune(): void {
    for (const [root, observer] of this.observers)
      if (!root.isConnected) {
        observer.disconnect();
        this.observers.delete(root);
      }
  }
  stop(): void {
    for (const observer of this.observers.values()) observer.disconnect();
    this.observers.clear();
    this.previews = new WeakMap();
    this.unread = new WeakMap();
  }

  private canonical(row: HTMLElement): HTMLElement {
    return row.querySelector<HTMLElement>('[data-testid="cell-frame-container"]') ?? row;
  }

  private rows(scope: Element): HTMLElement[] {
    return [...new Set(this.adapter.findNewRows(scope).map((row) => this.canonical(row)))];
  }

  private preview(row: HTMLElement): string | null {
    const content = row.querySelector('[data-testid="cell-frame-secondary"]');
    const timestamp = row.querySelector('[data-testid="chat-list-timestamp"]');
    if (!content && !timestamp) return null;
    // Bounded transient comparison, not message or conversation identity.
    return JSON.stringify([
      content ? messageText(content).slice(0, 1024) : null,
      timestamp?.textContent?.slice(0, 80) ?? null,
      [
        ...row.querySelectorAll(
          '[data-testid="last-msg-status"] [aria-label],[data-testid="last-msg-status"] [data-icon]',
        ),
      ]
        .slice(0, 8)
        .map((e) => [
          e.getAttribute('aria-label')?.slice(0, 80),
          e.getAttribute('data-icon')?.slice(0, 80),
        ]),
    ]);
  }

  private detected(
    row: HTMLElement,
    reason: 'INITIAL_UNREAD' | 'ROW_CHANGED' | 'UNREAD_DECREASED',
  ): CaptureObservation {
    const title = conversationRowLabel(row);
    return CaptureObservationSchema.parse({
      kind: 'CAPTURE_OBSERVATION',
      observationId: crypto.randomUUID(),
      observedAt: new Date().toISOString(),
      observationType: 'CONVERSATION_ACTIVITY',
      captureState: 'DETECTED',
      conversation: {
        label: (title ?? row.getAttribute('aria-label'))?.trim().slice(0, 256) || null,
        kind: this.groups.kind(row),
      },
      senderLabel: null,
      direction: 'UNKNOWN',
      content: null,
      contentAvailability: 'UNAVAILABLE',
      media: [],
      activity: { unreadCount: this.adapter.unreadCount(row) ?? null, reason },
    });
  }
}
