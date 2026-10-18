import { CaptureObservationSchema, type CaptureObservation } from '../contracts.js';
import { WhatsAppDomAdapter } from '../adapters/dom-adapter.js';
import { GroupDetector } from '../adapters/group-detector.js';
import { CaptureStateManager } from './capture-state-manager.js';

export class ConversationObserver {
  private readonly observers = new Map<HTMLElement, MutationObserver>();

  constructor(
    private readonly emit: (value: CaptureObservation) => void,
    private readonly state: CaptureStateManager,
    private readonly adapter = new WhatsAppDomAdapter(),
    private readonly groups = new GroupDetector(),
  ) {}

  attach(list: HTMLElement): void {
    if (this.observers.has(list)) return;
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        const newRows = new Set<HTMLElement>();
        for (const node of record.addedNodes) for (const row of this.adapter.findNewRows(node)) {
          if (!this.state.claimNewRow(row)) continue;
          newRows.add(row);
          const count = this.adapter.unreadCount(row);
          if (count !== null) this.state.claimUnreadChange(row, count);
          this.emit(this.detected(row));
        }
        if (!this.adapter.isRelevantUnreadChange(record)) continue;
        const nodes = record.type === 'childList' ? [...record.addedNodes, record.target] : [record.target];
        for (const node of nodes) {
          const row = this.adapter.findConversationRow(node);
          if (!row || newRows.has(row)) continue;
          const count = this.adapter.unreadCount(row);
          if (count === null || !this.state.claimUnreadChange(row, count)) continue;
          this.emit(this.detected(row));
        }
      }
    });
    observer.observe(list, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-label', 'data-wai-unread-count'], characterData: true });
    this.observers.set(list, observer);
  }

  stop(): void {
    for (const observer of this.observers.values()) observer.disconnect();
    this.observers.clear();
  }

  private detected(row: HTMLElement): CaptureObservation {
    return CaptureObservationSchema.parse({
      kind: 'CAPTURE_OBSERVATION', observationId: crypto.randomUUID(), observedAt: new Date().toISOString(),
      observationType: 'CONVERSATION_ACTIVITY', captureState: 'DETECTED',
      conversation: { label: row.getAttribute('aria-label')?.trim().slice(0, 256) || null, kind: this.groups.kind(row) },
      senderLabel: null, direction: 'UNKNOWN', content: null, contentAvailability: 'UNAVAILABLE', media: [],
    });
  }
}
