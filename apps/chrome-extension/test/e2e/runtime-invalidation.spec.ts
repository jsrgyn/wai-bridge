import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';
import { ExtensionSendBridge } from '../../src/background/send-bridge.js';

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

type Listener = (message: unknown, sender: unknown, reply: (value: unknown) => void) => unknown;
declare global {
  interface Window {
    reloadCase: { listener: Listener };
  }
}
test('reload mid-request: bridge drops active, next poll omits activeCommand, then READY (extension side)', async ({
  page,
}) => {
  await page.route('https://web.whatsapp.com/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<meta charset="utf-8"><main id="main" data-wai-conversation-type="INDIVIDUAL"><header><span data-testid="conversation-info-header-chat-title">Synthetic recipient</span></header><footer><div role="textbox" contenteditable="true" style="min-height:24px"></div><button aria-label="Enviar">Synthetic send</button></footer></main>',
    }),
  );
  const loadContent = async () => {
    await page.goto('https://web.whatsapp.com/');
    await page.evaluate(() => {
      window.reloadCase = { listener: () => {} };
      (window as unknown as { chrome: unknown }).chrome = {
        runtime: {
          id: 'abcdefghijklmnopabcdefghijklmnop',
          onMessage: {
            addListener: (listener: Listener) => {
              window.reloadCase.listener = listener;
            },
          },
          sendMessage: async (raw: { kind: string }) =>
            raw.kind === 'GET_MONITOR_BOOT'
              ? { ok: true, monitoring: true, accountId: '11111111-1111-4111-8111-111111111111' }
              : { ok: true },
        },
      };
    });
    await page.addScriptTag({ path: resolve(process.cwd(), 'dist/content-script.js') });
  };
  await loadContent();
  let reloading = false;
  const call = (message: unknown) =>
    page.evaluate(
      (message) =>
        new Promise<unknown>((done) => {
          window.reloadCase.listener(
            message,
            { id: 'abcdefghijklmnopabcdefghijklmnop' },
            done,
          );
        }),
      message,
    );
  const tabs = {
    query: async () => [{ id: 5, windowId: 1, url: 'https://web.whatsapp.com/' }],
    sendMessage: async (_id: number, message: unknown) => {
      // Between unload and the new content script there is no receiving end.
      if (reloading) throw new Error('Could not establish connection. Receiving end does not exist.');
      const reply = (await call(message)) as Record<string, unknown>;
      delete reply.build; // the node bridge plays a development build
      return reply;
    },
  } as unknown as Pick<typeof chrome.tabs, 'query' | 'sendMessage'>;
  const requests: { type: string; input: Record<string, unknown> & { activeCommand?: unknown; ready?: unknown; allowClaim?: unknown } }[] = [];
  let command: Record<string, unknown> | undefined;
  const bridge = new ExtensionSendBridge(
    async () => '22222222-2222-4222-8222-222222222222',
    tabs,
    { get: async () => ({ waiExtensionSendsEnabled: true }) } as Pick<
      typeof chrome.storage.local,
      'get'
    >,
  );
  bridge.connect({
    postMessage: (raw) => {
      const req = raw as { id: string; type: string; input: Record<string, unknown> & { activeCommand?: unknown; ready?: unknown; allowClaim?: unknown } };
      requests.push(req);
      let result: unknown = { command: null };
      if (req.input.activeCommand) result = { command: null, activeStatus: 'WAITING_AUTO_SEND' };
      else if (req.input.ready && command) result = { command };
      else if (req.input.allowClaim && command) result = { command: null, pending: true };
      const delivered = command && req.input.ready && !req.input.activeCommand;
      if (delivered) command = undefined;
      queueMicrotask(() =>
        bridge.receive({ id: req.id, type: 'SEND_POLL_RESULT', result }),
      );
    },
  });
  const context = (await call({ kind: 'SEND_CONTEXT', enabled: true })) as {
    identity: { accountId: string; contextId: string; conversationKey: string };
  };
  command = {
    id: '33333333-3333-4333-8333-333333333333',
    conversationId: '44444444-4444-4444-8444-444444444444',
    contextId: context.identity.contextId,
    leaseToken: '55555555-5555-4555-8555-555555555555',
    target: {
      accountId: context.identity.accountId,
      type: 'UI_CONTEXT',
      referenceKey: context.identity.conversationKey,
    },
    text: 'Synthetic auto message',
    mode: 'AUTO',
    explicitAuthorization: true,
    leaseUntil: new Date(Date.now() + 180000).toISOString(),
    timing: { autoCountdownMs: 30000, executionTimeoutMs: 60000, queueMaxWaitMs: 1800000, sendVerifyMs: 15000 },
    appendToDraft: false,
  };
  await bridge.poll();
  expect(bridge.busy).toBe(true);
  await bridge.poll();
  expect(requests.at(-1)?.input.activeCommand).toMatchObject({ id: '33333333-3333-4333-8333-333333333333' });

  reloading = true;
  await bridge.poll();
  expect(bridge.busy).toBe(false);
  expect(requests.at(-1)?.input.activeCommand).toBeUndefined();

  reloading = false;
  await loadContent();
  await bridge.poll();
  expect(requests.at(-1)?.input).toMatchObject({ reason: 'READY' });
  expect(requests.at(-1)?.input.activeCommand).toBeUndefined();
  bridge.disconnect();
});
