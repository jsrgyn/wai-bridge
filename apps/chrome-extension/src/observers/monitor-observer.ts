import type { CaptureObservation } from '../contracts.js';
import { WhatsAppDomAdapter } from '../adapters/dom-adapter.js';
import { CaptureStateManager } from './capture-state-manager.js';
import { ConversationObserver } from './conversation-observer.js';
import { MessageObserver } from './message-observer.js';

/** Coordinates narrow observers. Existing descendants are never captured at startup. */
export class MonitorObserver {
  private readonly adapter = new WhatsAppDomAdapter();
  private readonly state: CaptureStateManager;
  private readonly messages: MessageObserver;
  private readonly conversations: ConversationObserver;
  private scanTimer: ReturnType<typeof setInterval> | undefined;
  private documentObserver: MutationObserver | undefined;

  constructor(
    emit: (observation: CaptureObservation, root?: HTMLElement) => void,
    report: (message: string) => void,
    contextKey?: (root: HTMLElement) => string | undefined,
  ) {
    this.state = new CaptureStateManager(contextKey);
    this.messages = new MessageObserver(emit, report, this.state, this.adapter);
    this.conversations = new ConversationObserver(emit, this.state, this.adapter);
  }

  start(): void {
    if (this.documentObserver) return;
    this.attach(document, true);
    this.scanTimer = setInterval(() => {
      this.attach(document, false);
      this.messages.prune();
      this.messages.scan();
    }, 2000);
    this.documentObserver = new MutationObserver((records) => {
      this.messages.prune();
      this.conversations.prune();
      for (const record of records)
        for (const node of record.addedNodes) {
          if (node instanceof Element) this.attach(node);
        }
    });
    this.documentObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  stop(): void {
    this.documentObserver?.disconnect();
    this.documentObserver = undefined;
    if (this.scanTimer) clearInterval(this.scanTimer);
    this.scanTimer = undefined;
    this.messages.stop();
    this.conversations.stop();
  }

  reconcile(root: HTMLElement, limit: number): CaptureObservation[] {
    if (!this.documentObserver) throw new Error('MONITOR_OFF');
    return this.messages.reconcile(root, limit);
  }

  private attach(scope: ParentNode, initial = false): void {
    for (const root of this.adapter.findMessageRoots(scope)) this.messages.attach(root, initial);
    for (const list of this.adapter.findConversationLists(scope)) this.conversations.attach(list);
  }
}
