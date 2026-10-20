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

  attach(root: HTMLElement, initial = true): void {
    if (this.observers.has(root)) return;
    for (const message of this.adapter.findNewMessages(root)) {
      if (
        !initial &&
        (this.state.hasObserved(message, root, this.adapter.renderKey(message)) ||
          (this.messageTimestamp(message) ?? -Infinity) >=
            Math.floor(this.startedAt / 60000) * 60000)
      ) {
        this.schedule(root, message);
        continue;
      }
      try {
        this.state.baseline(
          message,
          root,
          this.adapter.renderKey(message),
          this.snapshot(message).signature,
        );
      } catch {
        this.report('An initial message could not be compared for later changes.');
      }
    }
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          for (const message of this.adapter.findNewMessages(node)) this.schedule(root, message);
        }
        if (record.type === 'attributes')
          for (const message of this.adapter.findNewMessages(record.target)) {
            if (
              this.state.hasObserved(message, root, this.adapter.renderKey(message)) ||
              this.pending.has(message)
            )
              this.schedule(root, message);
          }
        // Both hydration and changes to messages already present at ON matter.
        // Their semantic snapshots prevent unchanged redraws becoming captures.
        const parent = this.adapter.containingMessage(record.target);
        if (
          parent &&
          (this.pending.has(parent) ||
            this.state.hasObserved(parent, root, this.adapter.renderKey(parent)))
        )
          this.schedule(root, parent);
      }
    });
    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    });
    this.observers.set(root, observer);
  }

  scan(): void {
    for (const root of this.observers.keys())
      if (root.isConnected)
        for (const message of this.adapter.findNewMessages(root)) this.schedule(root, message);
  }

  reconcile(root: HTMLElement, limit: number): CaptureObservation[] {
    if (!this.observers.has(root)) this.attach(root, false);
    const observations: CaptureObservation[] = [];
    for (const message of this.adapter.findNewMessages(root).slice(-limit)) {
      const pending = this.pending.get(message);
      if (pending) clearTimeout(pending.timer);
      this.pending.delete(message);
      const observation = this.capture(root, message, true);
      if (observation) observations.push(observation);
    }
    return observations;
  }

  prune(): void {
    for (const [root, observer] of this.observers)
      if (!root.isConnected) {
        observer.disconnect();
        this.observers.delete(root);
      }
    for (const [message, item] of this.pending)
      if (!item.root.isConnected) {
        clearTimeout(item.timer);
        this.pending.delete(message);
      }
  }
  stop(): void {
    for (const observer of this.observers.values()) observer.disconnect();
    this.observers.clear();
    for (const item of this.pending.values()) clearTimeout(item.timer);
    this.pending.clear();
  }

  private schedule(root: HTMLElement, message: HTMLElement): void {
    // Attribute/child records may target an inner msg-container. Observe the
    // same outer bubble as initial discovery, never two revisions for wrappers.
    message = this.adapter.containingMessage(message) ?? message;
    const previous = this.pending.get(message);
    if (previous) clearTimeout(previous.timer);
    const startedAt = previous?.startedAt ?? Date.now();
    const title = root.querySelector(
      '[data-testid="conversation-info-header-chat-title"]',
    )?.textContent;
    const selected = document.querySelector('#pane-side [aria-selected="true"]');
    const timer = setTimeout(
      () => {
        this.pending.delete(message);
        if (
          root.isConnected &&
          message.isConnected &&
          root.contains(message) &&
          root.querySelector('[data-testid="conversation-info-header-chat-title"]')?.textContent ===
            title &&
          document.querySelector('#pane-side [aria-selected="true"]') === selected
        )
          this.capture(root, message);
      },
      Math.min(150, Math.max(0, 1_000 - (Date.now() - startedAt))),
    );
    this.pending.set(message, { root, startedAt, timer });
  }

  private messageTimestamp(message: HTMLElement): number | undefined {
    const prefix = [...message.querySelectorAll('[data-pre-plain-text]')]
      .find((node) => !node.closest('[data-testid^="quoted"], [data-wai-quoted]'))
      ?.getAttribute('data-pre-plain-text');
    const date = prefix?.match(/^\[(\d{1,2}):(\d{2}), (\d{1,2})\/(\d{1,2})\/(\d{4})\]/);
    return date
      ? new Date(
          Number(date[5]),
          Number(date[4]) - 1,
          Number(date[3]),
          Number(date[1]),
          Number(date[2]),
        ).getTime()
      : undefined;
  }

  private snapshot(message: HTMLElement) {
    const textNode = [
      ...message.querySelectorAll<HTMLElement>(
        '[data-wai-message-text], [data-testid="msg-text"], .selectable-text',
      ),
    ].find(
      (node) =>
        !node.closest('[data-testid^="quoted"], [data-testid="quoted-message"], [data-wai-quoted]'),
    );

    const content = (textNode ? messageText(textNode).slice(0, 10_000) : '') || null;
    const direction = this.adapter.messageDirection(message);
    const media = this.media.detect(message);
    const senderLabel = this.contacts.senderLabel(message);
    return {
      content,
      direction,
      media,
      senderLabel,
      signature: JSON.stringify([content, direction, media, senderLabel]),
    };
  }

  private capture(
    root: HTMLElement,
    message: HTMLElement,
    explicit = false,
  ): CaptureObservation | undefined {
    const conversation = {
      label: this.contacts.conversationLabel(root),
      kind: this.groups.kind(root),
    };
    try {
      // A navigation/scroll can insert older history into an existing root. Known
      // old UI dates are excluded; a newly inserted node alone is not proof of recency.
      const timestamp = this.messageTimestamp(message);
      if (
        !explicit &&
        timestamp !== undefined &&
        timestamp < Math.floor(this.startedAt / 60000) * 60000 &&
        !this.state.hasObserved(message, root, this.adapter.renderKey(message))
      )
        return;
      const { content, direction, media, senderLabel, signature } = this.snapshot(message);
      const messageRef = this.state.revision(
        message,
        root,
        this.adapter.renderKey(message),
        signature,
        explicit,
      );
      if (!messageRef) return;
      const observation = CaptureObservationSchema.parse({
        kind: 'CAPTURE_OBSERVATION',
        observationId: crypto.randomUUID(),
        observedAt: new Date().toISOString(),
        observationType: 'MESSAGE',
        messageRef,
        captureState: content ? 'CAPTURED' : 'PENDING',
        conversation,
        senderLabel,
        direction,
        content,
        contentAvailability: content ? 'AVAILABLE' : 'UNAVAILABLE',
        media,
      });
      if (!explicit) this.emit(observation, root);
      return observation;
    } catch {
      this.report('A changed message could not be parsed.');
      if (explicit) throw new Error('SYNC_PARSE_FAILED');
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
