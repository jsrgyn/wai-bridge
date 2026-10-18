import { describe, expect, it } from 'vitest';
import { activeMonitorStatus } from '../../src/background/monitor-status.js';
import type { ExtensionState } from '../../src/contracts.js';

const persisted: ExtensionState = {
  monitoring: true,
  connection: 'CONNECTED',
  activities: [],
  errors: [],
  retainActivitySummaries: true,
};
function tabs(reply: unknown, url = 'https://web.whatsapp.com/') {
  return {
    query: async () => [{ id: 1, url }],
    sendMessage: async () => {
      if (reply instanceof Error) throw reply;
      return reply;
    },
  } as unknown as Pick<typeof chrome.tabs, 'query' | 'sendMessage'>;
}

describe('active page monitor status', () => {
  it('reports off after page reload despite a persisted on toggle', async () => {
    expect(
      await activeMonitorStatus(
        persisted,
        tabs({ ok: true, monitoring: false, conversationOpen: true }),
      ),
    ).toMatchObject({ monitoring: false, captureContext: 'ACTIVE_CONVERSATION' });
    expect(persisted.monitoring).toBe(true);
  });
  it('distinguishes sidebar activity from message observation', async () => {
    expect(
      await activeMonitorStatus(
        persisted,
        tabs({ ok: true, monitoring: true, conversationOpen: false }),
      ),
    ).toMatchObject({ monitoring: true, captureContext: 'NO_CONVERSATION' });
  });
  it('reports unavailable content scripts and other sites as off', async () => {
    expect(await activeMonitorStatus(persisted, tabs(new Error('No receiver')))).toMatchObject({
      monitoring: false,
      captureContext: 'UNAVAILABLE',
    });
    expect(await activeMonitorStatus(persisted, tabs({}, 'https://example.com'))).toMatchObject({
      monitoring: false,
      captureContext: 'NOT_WHATSAPP',
    });
  });
});
