import type { CaptureObservation } from '../contracts.js';
import { WhatsAppDomAdapter } from '../adapters/dom-adapter.js';
import { CaptureStateManager } from './capture-state-manager.js';
import { ConversationObserver } from './conversation-observer.js';
import { MessageObserver } from './message-observer.js';

/** Coordinates narrow observers. Existing descendants are never captured at startup. */
export class MonitorObserver {
  private readonly adapter = new WhatsAppDomAdapter();
  private readonly state = new CaptureStateManager();
  private readonly messages: MessageObserver;
  private readonly conversations: ConversationObserver;
  private documentObserver: MutationObserver | undefined;

  constructor(emit: (observation: CaptureObservation) => void, report: (message: string) => void) {
    this.messages = new MessageObserver(emit, report, this.state, this.adapter);
    this.conversations = new ConversationObserver(emit, this.state, this.adapter);
  }

  start(): void {
    if (this.documentObserver) return;
    this.attach(document);
    this.documentObserver = new MutationObserver((records) => {
      for (const record of records) for (const node of record.addedNodes) {
        if (node instanceof Element) this.attach(node);
      }
    });
    this.documentObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  stop(): void {
    this.documentObserver?.disconnect();
    this.documentObserver = undefined;
    this.messages.stop();
    this.conversations.stop();
  }

  private attach(scope: ParentNode): void {
    for (const root of this.adapter.findMessageRoots(scope)) this.messages.attach(root);
    for (const list of this.adapter.findConversationLists(scope)) this.conversations.attach(list);
  }
}
