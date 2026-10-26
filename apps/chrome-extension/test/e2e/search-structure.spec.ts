import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';
declare global {
  interface Window {
    structureCase: { listener: (message: unknown, sender: unknown, reply: (value: unknown) => void) => unknown };
  }
}
const row = (title: string, label: string) =>
  `<div role="row"><div role="gridcell"><div data-testid="cell-frame-container" aria-label="${label}"><span data-testid="cell-frame-title" title="${title}">${title}</span></div></div></div>`;
const fixture = `<meta charset="utf-8">
<input aria-label="Pesquisar ou começar uma nova conversa">
<button aria-label="Nova conversa">Synthetic new</button>
<div id="pane-side" data-testid="chat-list"><div role="heading">Synthetic Heading Text</div>
${row('Synthetic Contact Alpha', 'Synthetic Label One')}${row('+1 202 555 0199', 'Synthetic Label Two')}
<div role="row" style="display:none"><div data-testid="cell-frame-container"></div></div>
<div role="listitem" aria-busy="true"><a href="https://synthetic.test/x">Synthetic link</a></div></div>`;

test('SEARCH_STRUCTURE reports counts only and leaks no fixture text', async ({ page }) => {
  await page.route('https://structure.test/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: fixture }),
  );
  await page.goto('https://structure.test/');
  await page.evaluate(() => {
    window.structureCase = { listener: () => {} };
    (window as unknown as { chrome: unknown }).chrome = {
      runtime: {
        id: 'abcdefghijklmnopabcdefghijklmnop',
        onMessage: {
          addListener: (listener: Window['structureCase']['listener']) => {
            window.structureCase.listener = listener;
          },
        },
        sendMessage: async (raw: { kind: string }) =>
          raw.kind === 'GET_MONITOR_BOOT'
            ? { ok: true, monitoring: false, accountId: '11111111-1111-4111-8111-111111111111' }
            : { ok: true },
      },
    };
  });
  await page.addScriptTag({ path: resolve(process.cwd(), 'dist/content-script.js') });
  const reply = await page.evaluate(
    () =>
      new Promise((done) =>
        window.structureCase.listener(
          { kind: 'SEARCH_STRUCTURE' },
          { id: 'abcdefghijklmnopabcdefghijklmnop' },
          done,
        ),
      ),
  );
  const { report } = reply as { report: { scopes: Record<string, unknown> } & Record<string, unknown> };
  expect(reply).toMatchObject({ ok: true });
  expect(report).toMatchObject({ searchInputPresent: true, newChatButtonPresent: true });
  expect(report.scopes.paneSide).toEqual({
    containerPresent: true,
    visibleRowCount: 2,
    listitemCount: 1,
    rowCount: 3,
    gridcellCount: 2,
    headingCount: 1,
    cellFrameTitleCount: 2,
    ariaBusyCount: 1,
    testIds: ['cell-frame-container', 'cell-frame-title'],
  });
  expect(report.scopes.newChatDrawer).toMatchObject({ containerPresent: false, testIds: [] });
  const serialized = JSON.stringify({ ...report, capturedAt: undefined });
  expect(serialized).not.toMatch(/Synthetic|synthetic\.test|Label|Heading/);
  expect(serialized).not.toMatch(/\+?\d[\d\s-]{6,}\d/);
});
