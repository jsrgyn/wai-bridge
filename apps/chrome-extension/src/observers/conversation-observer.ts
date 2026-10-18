import { CaptureObservationSchema, type CaptureObservation } from '../contracts.js';
import { WhatsAppDomAdapter } from '../adapters/dom-adapter.js';
import { GroupDetector } from '../adapters/group-detector.js';
import { CaptureStateManager } from './capture-state-manager.js';

export class ConversationObserver {
  private readonly observers = new Map<HTMLElement, MutationObserver>();
  // Memory only: previews are change signals, never persisted as full messages.
  private previews = new WeakMap<HTMLElement, string | null>();

  constructor(
    private readonly emit: (value: CaptureObservation) => void,
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
      this.state.claimUnreadChange(row, this.adapter.unreadCount(row) ?? 0);
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
        const fresh = this.state.claimNewRow(row);
        const unread = this.state.claimUnreadChange(row, this.adapter.unreadCount(row) ?? 0);
        const preview = this.preview(row);
        const previous = this.previews.get(row);
        const updatedPreview = previous !== undefined && preview !== null && preview !== previous;
        this.previews.set(row, preview);
        // A phone/browser outgoing message may change the preview without unread.
        // Neither a preview nor a UI change proves direction or complete content.
        if (fresh || unread || updatedPreview) this.emit(this.detected(row));
      }
    });
    observer.observe(list, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-label', 'data-wai-unread-count'],
      characterData: true,
    });
    this.observers.set(list, observer);
  }

  stop(): void {
    for (const observer of this.observers.values()) observer.disconnect();
    this.observers.clear();
    this.previews = new WeakMap();
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
      content?.textContent?.slice(0, 1024) ?? null,
      timestamp?.textContent?.slice(0, 80) ?? null,
    ]);
  }

  private detected(row: HTMLElement): CaptureObservation {
    const title = row.querySelector('[data-testid="cell-frame-title"]')?.textContent;
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
    });
  }
}
