import { messageText } from '../adapters/message-text.js';
import { CaptureObservationSchema, type CaptureObservation } from '../contracts.js';
import { ContactDetector } from '../adapters/contact-detector.js';
import { GroupDetector } from '../adapters/group-detector.js';
import { MediaDetector } from '../adapters/media-detector.js';
import { WhatsAppDomAdapter } from '../adapters/dom-adapter.js';
import { CaptureStateManager } from './capture-state-manager.js';

export class MessageObserver {
  private readonly startedAt = Date.now();
  private readonly observers = new Map<HTMLElement, MutationObserver>();
  private readonly pending = new Map<
    HTMLElement,
    { root: HTMLElement; startedAt: number; timer: ReturnType<typeof setTimeout> }
  >();

  constructor(
    private readonly emit: (value: CaptureObservation, root?: HTMLElement) => void,
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
      for (const record of records) {
        for (const node of record.addedNodes) {
          for (const message of this.adapter.findNewMessages(node)) this.schedule(root, message);
        }
        // Hydration of a newly inserted bubble can arrive in later DOM mutations.
        // Existing messages are never enrolled by descendant edits alone.
        const parent = this.adapter.containingMessage(record.target);
        if (parent && this.pending.has(parent)) this.schedule(root, parent);
      }
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    this.observers.set(root, observer);
  }

  stop(): void {
    for (const observer of this.observers.values()) observer.disconnect();
    this.observers.clear();
    for (const item of this.pending.values()) clearTimeout(item.timer);
    this.pending.clear();
  }

  private schedule(root: HTMLElement, message: HTMLElement): void {
    const previous = this.pending.get(message);
    if (previous) clearTimeout(previous.timer);
    const startedAt = previous?.startedAt ?? Date.now();
    const title = root.querySelector('[data-testid="conversation-info-header-chat-title"]')?.textContent;
    const selected = document.querySelector('#pane-side [aria-selected="true"]');
    const timer = setTimeout(
      () => {
        this.pending.delete(message);
        if (root.isConnected && message.isConnected && root.contains(message)
          && root.querySelector('[data-testid="conversation-info-header-chat-title"]')?.textContent === title
          && document.querySelector('#pane-side [aria-selected="true"]') === selected)
          this.capture(root, message);
      },
      Math.min(150, Math.max(0, 1_000 - (Date.now() - startedAt))),
    );
    this.pending.set(message, { root, startedAt, timer });
  }

  private capture(root: HTMLElement, message: HTMLElement): void {
    if (!this.state.claimMessage(message, root, this.adapter.renderKey(message))) return;
    const conversation = {
      label: this.contacts.conversationLabel(root),
      kind: this.groups.kind(root),
    };
    try {
    // A navigation/scroll can insert older history into an existing root. Known
    // old UI dates are excluded; a newly inserted node alone is not proof of recency.
    const prefix = message.querySelector('[data-pre-plain-text]')?.getAttribute('data-pre-plain-text');
    const date = prefix?.match(/^\[(\d{1,2}):(\d{2}), (\d{1,2})\/(\d{1,2})\/(\d{4})\]/);
    if (date) {
      const timestamp = new Date(Number(date[5]), Number(date[4])-1, Number(date[3]), Number(date[1]), Number(date[2])).getTime();
      if (timestamp < Math.floor(this.startedAt / 60000) * 60000) return;
    }
      const textNode = message.querySelector<HTMLElement>(
        '[data-wai-message-text], [data-testid="msg-text"], .selectable-text',
      );
      const content =
        (textNode ? messageText(textNode).slice(0, 10_000) : '') || null;
      const direction = this.adapter.messageDirection(message);
      this.emit(
        CaptureObservationSchema.parse({
          kind: 'CAPTURE_OBSERVATION',
          observationId: crypto.randomUUID(),
          observedAt: new Date().toISOString(),
          observationType: 'MESSAGE',
          captureState: content ? 'CAPTURED' : 'PENDING',
          conversation,
          senderLabel: this.contacts.senderLabel(message),
          direction,
          content,
          contentAvailability: content ? 'AVAILABLE' : 'UNAVAILABLE',
          media: this.media.detect(message),
        }),
        root,
      );
    } catch {
      this.report('A newly added message could not be parsed.');
      this.emit(
        CaptureObservationSchema.parse({
          kind: 'CAPTURE_OBSERVATION',
          observationId: crypto.randomUUID(),
          observedAt: new Date().toISOString(),
          observationType: 'MESSAGE',
          captureState: 'FAILED',
          conversation,
          senderLabel: null,
          direction: 'UNKNOWN',
          content: null,
          contentAvailability: 'UNAVAILABLE',
          media: [],
        }),
        root,
      );
    }
  }
}
