import { expect, it } from 'vitest';
import { recordSearchDiagnostic, requestSearchStructure } from '../../src/background/search-diagnostics.js';

const scope = {
  containerPresent: true,
  visibleRowCount: 0,
  listitemCount: 0,
  rowCount: 0,
  gridcellCount: 0,
  headingCount: 0,
  cellFrameTitleCount: 0,
  ariaBusyCount: 0,
  testIds: [],
};
const report = {
  version: 1,
  capturedAt: '2026-10-26T12:00:00.000Z',
  searchInputPresent: true,
  newChatButtonPresent: true,
  scopes: { paneSide: scope, newChatDrawer: { ...scope, containerPresent: false } },
};
function fakes(reply: unknown, stored: unknown = undefined) {
  const sent: unknown[] = [];
  const store: Record<string, unknown> = { waiSearchDiagnostics: stored };
  const tabs = {
    sendMessage: async (tabId: number, message: unknown) => {
      sent.push([tabId, message]);
      return reply;
    },
  };
  const storage = {
    get: async (key: string) => ({ [key]: store[key] }),
    set: async (value: Record<string, unknown>) => {
      Object.assign(store, value);
    },
  };
  return { sent, store, tabs, storage };
}
it('requests SEARCH_STRUCTURE and rejects replies with extra content', async () => {
  const ok = fakes({ ok: true, report });
  expect(await requestSearchStructure(ok.tabs as never, 7)).toEqual(report);
  expect(ok.sent).toEqual([[7, { kind: 'SEARCH_STRUCTURE' }]]);
  const leaky = fakes({ ok: true, report: { ...report, title: 'Synthetic leak' } });
  await expect(requestSearchStructure(leaky.tabs as never, 7)).rejects.toThrow();
});
it('stores the newest three failure reports with code and timestamp', async () => {
  const f = fakes({ ok: true, report });
  for (let i = 0; i < 4; i++)
    await recordSearchDiagnostic(
      f.tabs as never,
      f.storage as never,
      7,
      i === 3 ? 'SEARCH_RESULTS_NOT_READY' : 'PHONE_CONTACT_NOT_FOUND',
      new Date(`2026-10-26T12:00:0${i}.000Z`),
    );
  const list = f.store.waiSearchDiagnostics as { code: string; recordedAt: string }[];
  expect(list).toHaveLength(3);
  expect(list[0]).toMatchObject({ code: 'SEARCH_RESULTS_NOT_READY', recordedAt: '2026-10-26T12:00:03.000Z' });
});
