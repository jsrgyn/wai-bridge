import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';

type State = {
  mode: string;
  calls: number;
  invalid: boolean;
  listener: (raw: unknown, sender: unknown, reply: (value: unknown) => void) => void;
  control: () => void;
};
declare global {
  interface Window {
    runtimeCase: State;
  }
}
for (const mode of ['sync', 'async', 'id-gone', 'retry-invalidated', 'boot-sync'] as const)
  test(`stale content script stops cleanly after ${mode}`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setContent(
      '<main id="main" data-wai-conversation-type="INDIVIDUAL"><header><span data-testid="conversation-info-header-chat-title">Synthetic contact</span></header><div id="messages"></div><footer><div contenteditable="true">Synthetic preserved draft</div></footer></main>',
    );
    await page.evaluate((mode) => {
      const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
      let sequence = 1;
      Object.defineProperty(window, 'crypto', {
        value: {
          randomUUID: () =>
            `123e4567-e89b-42d3-a456-${(sequence++).toString(16).padStart(12, '0')}`,
        },
      });
      const state: State = (window.runtimeCase = {
        mode,
        calls: 0,
        invalid: mode === 'boot-sync',
        listener: () => {},
        control: () => {},
      });
      const runtime = {
        get id() {
          return mode === 'id-gone' && state.invalid ? undefined : extensionId;
        },
        onMessage: {
          addListener: (listener: State['listener']) => {
            state.listener = listener;
          },
        },
        sendMessage: (message: { kind: string }) => {
          if (message.kind === 'GET_MONITOR_BOOT' && mode !== 'boot-sync')
            return Promise.resolve({
              ok: true,
              accountId: '11111111-1111-4111-8111-111111111111',
              monitoring: true,
            });
          state.calls++;
          if (mode === 'retry-invalidated' && !state.invalid) {
            state.invalid = true;
            return Promise.resolve({ ok: false });
          }
          if (mode === 'async') return Promise.reject(new Error('Extension context invalidated.'));
          throw new Error('Extension context invalidated.');
        },
      };
      (window as unknown as { chrome: unknown }).chrome = { runtime };
      state.control = () =>
        state.listener({ kind: 'GET_CONTENT_STATE' }, { id: extensionId }, () => {});
    }, mode);
    await page.addScriptTag({ path: resolve(process.cwd(), 'dist/content-script.js') });
    if (mode !== 'boot-sync') {
      await page.evaluate((mode) => {
        if (mode === 'id-gone') window.runtimeCase.invalid = true;
        const item = document.createElement('article');
        item.setAttribute('role', 'article');
        item.dataset.waiMessage = '';
        item.dataset.waiDirection = 'INBOUND';
        item.innerHTML = '<span data-wai-message-text>Synthetic observed message</span>';
        document.querySelector('#messages')!.append(item);
      }, mode);
    }
    await expect(page.locator('#wai-bridge-reload-required')).toBeVisible();
    await expect(page.locator('footer [contenteditable]')).toHaveText('Synthetic preserved draft');
    const calls = await page.evaluate(() => window.runtimeCase.calls);
    await page.evaluate(() => {
      const item = document.createElement('article');
      item.setAttribute('role', 'article');
      item.dataset.waiMessage = '';
      item.dataset.waiDirection = 'INBOUND';
      item.innerHTML = '<span data-wai-message-text>Synthetic later message</span>';
      document.querySelector('#messages')!.append(item);
    });
    await page.waitForTimeout(1200);
    expect(await page.evaluate(() => window.runtimeCase.calls)).toBe(calls);
    expect(await page.locator('#wai-bridge-reload-required').count()).toBe(1);
    expect(errors).toEqual([]);
  });
