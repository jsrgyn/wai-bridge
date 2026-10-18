import type { CaptureObservation, ConversationIdentity } from '@wai-bridge/shared';
import { visiblePeerDetails } from './visible-peer-details.js';
import { GroupDetector } from '../adapters/group-detector.js';

/** References visible UI objects, never a display name or a positional row index. */
export class AutomaticContext {
  private readonly rows = new WeakMap<Element, { label: string; key: string }>();
  private active:
    | { root: HTMLElement; row: Element | null; label: string; identity: ConversationIdentity }
    | undefined;
  constructor(
    private readonly accountId: string,
    private readonly doc: Document = document,
  ) {}

  current(): ConversationIdentity | undefined {
    const roots = this.doc.querySelectorAll<HTMLElement>('#main, [data-wai-active-conversation]');
    if (roots.length !== 1) {
      this.active = undefined;
      return undefined;
    }
    const root = roots[0]!;
    const label = root
      .querySelector('[data-testid="conversation-info-header-chat-title"]')
      ?.textContent?.trim();
    if (!label) {
      this.active = undefined;
      return undefined;
    }
    const selected = this.doc.querySelector('#pane-side [aria-selected="true"]');
    const row = selected?.closest('[role="row"]') ?? selected;
    const details = visiblePeerDetails(this.doc, label);
    const kind = details.kind === 'UNKNOWN' ? new GroupDetector().kind(root) : details.kind;
    const previous = this.active;
    if (
      previous?.root === root &&
      previous.row === row &&
      previous.label === label &&
      previous.identity.type === 'UI_CONTEXT'
    ) {
      const prior = previous.identity;
      if (
        (prior.phone && details.phone && prior.phone !== details.phone) ||
        (prior.conversationKind !== 'UNKNOWN' &&
          kind !== 'UNKNOWN' &&
          prior.conversationKind !== kind)
      ) {
        if (row) this.rows.delete(row);
      } else {
        previous.identity = {
          ...prior,
          conversationKind: prior.conversationKind === 'UNKNOWN' ? kind : prior.conversationKind,
          ...(details.phone ? { phone: details.phone } : {}),
        };
        return previous.identity;
      }
    }
    let reference = row ? this.rows.get(row) : undefined;
    if (!reference || reference.label !== label) {
      reference = { label, key: crypto.randomUUID() };
      if (row) this.rows.set(row, reference);
    }
    const identity: ConversationIdentity = {
      version: 1,
      type: 'UI_CONTEXT',
      source: 'VISIBLE_UI',
      accountId: this.accountId,
      conversationKey: reference.key,
      conversationKind: kind,
      ...(details.phone ? { phone: details.phone } : {}),
      contextId: crypto.randomUUID(),
      confirmedAt: new Date().toISOString(),
    };
    this.active = { root, row, label, identity };
    return identity;
  }

  enrich(observation: CaptureObservation, root?: HTMLElement): CaptureObservation {
    let identity = this.current();
    if (
      identity?.type !== 'UI_CONTEXT' ||
      root !== this.active?.root ||
      observation.observationType !== 'MESSAGE'
    )
      return observation;
    // Observation construction precedes enrichment; avoid a future identity time
    // that would cause the shared boundary to reject the first captured message.
    if (Date.parse(identity.confirmedAt) > Date.parse(observation.observedAt)) {
      identity = { ...identity, confirmedAt: observation.observedAt };
      if (this.active) this.active.identity = identity;
    }
    return {
      ...observation,
      identity,
      conversation: { ...observation.conversation, kind: identity.conversationKind },
    };
  }
}
