import { z } from 'zod';
import type { ExtensionState } from '../contracts.js';

const ContentStateSchema = z.object({
  ok: z.literal(true),
  monitoring: z.boolean(),
  conversationOpen: z.boolean(),
});

/** Report the active content script, never a persisted toggle from an earlier page. */
export async function activeMonitorStatus(
  state: ExtensionState,
  tabs: Pick<typeof chrome.tabs, 'query' | 'sendMessage'>,
): Promise<ExtensionState> {
  try {
    const [tab] = await tabs.query({ active: true, currentWindow: true });
    if (!tab?.url || new URL(tab.url).origin !== 'https://web.whatsapp.com')
      return { ...state, monitoring: false, captureContext: 'NOT_WHATSAPP' };
    if (tab.id === undefined) throw new Error('TAB_UNAVAILABLE');
    const content = ContentStateSchema.parse(
      await tabs.sendMessage(tab.id, { kind: 'GET_CONTENT_STATE' }),
    );
    return {
      ...state,
      monitoring: content.monitoring,
      captureContext: content.conversationOpen ? 'ACTIVE_CONVERSATION' : 'NO_CONVERSATION',
    };
  } catch {
    return { ...state, monitoring: false, captureContext: 'UNAVAILABLE' };
  }
}
