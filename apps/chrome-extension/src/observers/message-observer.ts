import { CaptureObservationSchema, type CaptureObservation } from '../contracts.js';
import { ContactDetector } from '../adapters/contact-detector.js';
import { GroupDetector } from '../adapters/group-detector.js';
import { MediaDetector } from '../adapters/media-detector.js';
import { WhatsAppDomAdapter } from '../adapters/dom-adapter.js';
import { CaptureStateManager } from './capture-state-manager.js';

export class MessageObserver {
  private readonly observers = new Map<HTMLElement, MutationObserver>();

  constructor(
    private readonly emit: (value: CaptureObservation) => void,
    private readonly report: (message: string) => void,
    private readonly state: CaptureStateManager,
    private readonly adapter = new WhatsAppDomAdapter(),
    private readonly contacts = new ContactDetector(),
    private readonly groups = new GroupDetector(),
    private readonly media = new MediaDetector(),
  ) {}

  attach(root: HTMLElement): void {
    if (this.observers.has(root)) return;
    const observer = new MutationObserver((records) => {
      for (const record of records) for (const node of record.addedNodes) {
        for (const message of this.adapter.findNewMessages(node)) this.capture(root, message);
      }
    });
    observer.observe(root, { childList: true, subtree: true });
    this.observers.set(root, observer);
  }

  stop(): void {
    for (const observer of this.observers.values()) observer.disconnect();
    this.observers.clear();
  }

  private capture(root: HTMLElement, message: HTMLElement): void {
    if (!this.state.claimMessage(message)) return;
    const conversation = { label: this.contacts.conversationLabel(root), kind: this.groups.kind(root) };
    try {
      const textNode = message.querySelector<HTMLElement>('[data-wai-message-text], [data-testid="msg-text"], .selectable-text');
      const content = (textNode?.innerText ?? textNode?.textContent ?? '').trim().slice(0, 10_000) || null;
      const direction = message.dataset.waiDirection === 'INBOUND' || message.classList.contains('message-in') ? 'INBOUND'
        : message.dataset.waiDirection === 'OUTBOUND' || message.classList.contains('message-out') ? 'OUTBOUND' : 'UNKNOWN';
      this.emit(CaptureObservationSchema.parse({
        kind: 'CAPTURE_OBSERVATION', observationId: crypto.randomUUID(), observedAt: new Date().toISOString(),
        observationType: 'MESSAGE', captureState: content ? 'CAPTURED' : 'PENDING', conversation,
        senderLabel: this.contacts.senderLabel(message), direction, content,
        contentAvailability: content ? 'AVAILABLE' : 'UNAVAILABLE', media: this.media.detect(message),
      }));
    } catch {
      this.report('A newly added message could not be parsed.');
      this.emit(CaptureObservationSchema.parse({
        kind: 'CAPTURE_OBSERVATION', observationId: crypto.randomUUID(), observedAt: new Date().toISOString(),
        observationType: 'MESSAGE', captureState: 'FAILED', conversation, senderLabel: null,
        direction: 'UNKNOWN', content: null, contentAvailability: 'UNAVAILABLE', media: [],
      }));
    }
  }
}
