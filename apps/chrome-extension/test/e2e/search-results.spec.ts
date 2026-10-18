import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
const bundle = await build({
  stdin: {
    contents: `import {PhoneSearch} from './src/commands/phone-search.ts';import {AutomaticContext} from './src/identity/automatic-context.ts';window.resultClasses={PhoneSearch,AutomaticContext};`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  target: 'chrome120',
});
import type { PhoneSearch } from '../../src/commands/phone-search.js';
import type { AutomaticContext } from '../../src/identity/automatic-context.js';
declare global {
  interface Window {
    resultClasses: { PhoneSearch: typeof PhoneSearch; AutomaticContext: typeof AutomaticContext };
    resultCase: Promise<{ code: string; opened: string[]; profileClicks: number; elapsed: number }>;
  }
}
for (const scenario of [
  'mixed',
  'current-profile',
  'english',
  'delayed',
  'busy',
  'only-common-groups',
  'two-direct',
  'same-name',
  'stale',
  'wrong-phone',
] as const)
  test(`search sections ${scenario} never treats common groups or message hits as recipients`, async ({
    page,
  }) => {
    await page.route('https://results.test/**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<meta charset="utf-8"><input aria-label="Pesquisar ou começar uma nova conversa"><div id="pane-side"></div><main id="main" data-wai-conversation-type="INDIVIDUAL"><header><span data-testid="conversation-info-header-chat-title">Synthetic initial</span><div role="button" aria-label="Dados do perfil">Profile</div></header><footer><div contenteditable="true"></div></footer></main>',
      }),
    );
    await page.goto('https://results.test/');
    await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
    await page.evaluate((scenario) => {
      const list = document.querySelector<HTMLElement>('#pane-side')!;
      const opened: string[] = [];
      let profileClicks = 0;
      const heading = (title: string) => {
        const row = document.createElement('div');
        row.setAttribute('role', 'row');
        const h = document.createElement('h2');
        h.textContent = title;
        row.append(h);
        list.append(row);
      };
      const row = (title: string) => {
        const outer = document.createElement('div');
        outer.setAttribute('role', 'row');
        outer.innerHTML =
          '<div data-testid="cell-frame-container"><span data-testid="cell-frame-title"></span></div>';
        outer.querySelector('span')!.textContent = title;
        outer.querySelector('div')!.addEventListener('click', () => {
          opened.push(title);
          document.querySelector(
            '[data-testid="conversation-info-header-chat-title"]',
          )!.textContent = title;
        });
        list.append(outer);
      };
      for (const title of ['Synthetic initial', 'Synthetic stale second', 'Synthetic stale third'])
        row(title);
      document.querySelector('[aria-label="Dados do perfil"]')!.addEventListener('click', () => {
        profileClicks++;
        const drawer = document.createElement('aside');
        drawer.setAttribute('data-testid', 'chat-info-drawer');
        drawer.innerHTML =
          '<div data-testid="contact-info-header">Info</div><span>Synthetic recipient</span><span></span>';
        drawer.lastElementChild!.textContent =
          scenario === 'wrong-phone' ? '+12025550198' : '+12025550199';
        document.body.append(drawer);
      });
      document.querySelector('input')!.addEventListener('input', (event) => {
        if (!(event.target as HTMLInputElement).value || scenario === 'stale') return;
        const render = () => {
          list.replaceChildren();
          list.removeAttribute('aria-busy');
          heading(scenario === 'english' ? 'Chats' : 'Conversas');
          if (scenario !== 'only-common-groups') row('Synthetic recipient');
          if (scenario === 'two-direct') row('Synthetic second recipient');
          if (scenario === 'same-name') row('Synthetic recipient');
          heading(scenario === 'english' ? 'Groups in common' : 'Grupos em comum');
          for (let i = 0; i < 3; i++) row(`Synthetic common group ${i}`);
          heading(scenario === 'english' ? 'Messages' : 'Mensagens');
          row('Synthetic message match');
        };
        if (scenario === 'busy') {
          list.setAttribute('aria-busy', 'true');
          list.replaceChildren();
          heading('Conversas');
          row('Synthetic partial first');
          row('Synthetic partial second');
        }
        setTimeout(render, ['delayed', 'busy'].includes(scenario) ? 1500 : 50);
      });
      const identity = new window.resultClasses.AutomaticContext(
        '11111111-1111-4111-8111-111111111111',
      );
      if (scenario === 'current-profile') {
        document.querySelector('[data-testid="conversation-info-header-chat-title"]')!.textContent =
          'Synthetic recipient';
        (document.querySelector('[aria-label="Dados do perfil"]') as HTMLElement).click();
      }
      const search = new window.resultClasses.PhoneSearch(document, identity);
      const controller = new AbortController();
      const start = Date.now();
      window.resultCase = (async () => {
        let code = 'RESOLVED';
        try {
          await search.resolve(
            '+12025550199',
            identity.current()!.accountId,
            controller.signal,
            () => {},
          );
        } catch (error) {
          code = error instanceof Error ? error.message : 'FAILED';
        } finally {
          search.release(controller.signal);
        }
        return { code, opened, profileClicks, elapsed: Date.now() - start };
      })();
    }, scenario);
    const result = await page.evaluate(() => window.resultCase);
    if (scenario === 'current-profile') {
      expect(result.code).toBe('RESOLVED');
      expect(result.opened).toEqual([]);
      expect(result.profileClicks).toBe(1);
      expect(result.elapsed).toBeLessThan(500);
    } else if (['mixed', 'english', 'delayed', 'busy'].includes(scenario)) {
      expect(result.code).toBe('RESOLVED');
      expect(result.opened).toEqual(['Synthetic recipient']);
      expect(result.profileClicks).toBe(1);
      if (['delayed', 'busy'].includes(scenario))
        expect(result.elapsed).toBeGreaterThanOrEqual(1500);
    } else if (scenario === 'wrong-phone') {
      expect(result.code).toBe('RECIPIENT_PHONE_MISMATCH');
      expect(result.opened).toEqual(['Synthetic recipient']);
    } else {
      expect(result.code).toBe(
        scenario === 'stale'
          ? 'SEARCH_RESULTS_NOT_READY'
          : scenario === 'only-common-groups'
            ? 'PHONE_CONTACT_NOT_FOUND'
            : 'AMBIGUOUS_PHONE_RESULTS',
      );
      expect(result.opened).toEqual([]);
      expect(result.profileClicks).toBe(0);
    }
  });
