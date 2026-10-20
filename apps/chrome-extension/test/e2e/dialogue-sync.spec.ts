import { test, expect, type Page } from '@playwright/test';
import { build, stop } from 'esbuild';
import type { CaptureObservation, DialogueSyncJob } from '@wai-bridge/shared';
import type { MonitorObserver } from '../../src/observers/monitor-observer.js';
import type { VisibleDialogueSync } from '../../src/commands/dialogue-sync.js';
import type { AutomaticContext } from '../../src/identity/automatic-context.js';
const bundle = await build({
  stdin: {
    contents: `import {MonitorObserver} from './src/observers/monitor-observer.ts';import {AutomaticContext} from './src/identity/automatic-context.ts';import {VisibleDialogueSync} from './src/commands/dialogue-sync.ts';window.syncClasses={MonitorObserver,AutomaticContext,VisibleDialogueSync};`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  target: 'chrome120',
});
const script = bundle.outputFiles[0]!.text;
stop();
declare global {
  interface Window {
    syncClasses: {
      MonitorObserver: typeof MonitorObserver;
      VisibleDialogueSync: typeof VisibleDialogueSync;
      AutomaticContext: typeof AutomaticContext;
    };
    syncFixture: {
      observer: MonitorObserver;
      identity: AutomaticContext;
      events: CaptureObservation[];
      job: DialogueSyncJob;
    };
  }
}
async function install(page: Page) {
  await page.route('https://dialogue-sync.test/**', (route) =>
    route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<input aria-label="Pesquisar ou começar uma nova conversa"/><div id="pane-side"><div role="row"><div role="gridcell" tabindex="0"><div data-testid="cell-frame-container" id="target"><div data-testid="cell-frame-title"><span title="Synthetic target">Synthetic target</span></div><span aria-selected="true"></span></div></div></div></div><main id="main" data-wai-conversation-type="INDIVIDUAL"><header><span data-testid="conversation-info-header-chat-title">Synthetic target</span></header><section id="messages"><div role="row" data-testid="conv-msg-old-a"><div class="message-in"><div data-pre-plain-text="[12:00, 01/01/2020] Synthetic: "><span class="selectable-text">Synthetic displayed old message</span></div></div></div><div role="row" data-testid="conv-msg-old-b"><div class="message-out"><div data-pre-plain-text="[12:01, 01/01/2020] Synthetic: "><span class="selectable-text">Synthetic displayed old message</span></div></div></div></section><footer><div contenteditable="true"></div><button aria-label="Enviar" onclick="throw new Error('must not send')">Send</button></footer></main>`,
    }),
  );
  await page.goto('https://dialogue-sync.test/');
  await page.addScriptTag({ content: script });
  await page.evaluate(() => {
    const identity = new window.syncClasses.AutomaticContext(
      '11111111-1111-4111-8111-111111111111',
    );
    const events: CaptureObservation[] = [];
    const observer = new window.syncClasses.MonitorObserver(
      (v, r) => events.push(identity.enrich(v, r)),
      () => {},
      () => {
        const current = identity.current();
        return current?.type === 'UI_CONTEXT' ? current.conversationKey : undefined;
      },
    );
    observer.start();
    window.syncFixture = {
      identity,
      observer,
      events,
      job: {
        id: crypto.randomUUID(),
        leaseToken: crypto.randomUUID(),
        accountId: '11111111-1111-4111-8111-111111111111',
        query: 'Synthetic target',
        limit: 50,
        expiresAt: new Date(Date.now() + 30000).toISOString(),
      },
    };
  });
}

test('explicit reconciliation captures rendered baseline, preserves equal distinct messages and stable revisions without sending', async ({
  page,
}) => {
  await install(page);
  expect(await page.evaluate(() => window.syncFixture.events.length)).toBe(0);
  const snapshots = await page.evaluate(async () => {
    const f = window.syncFixture;
    const root = await new window.syncClasses.VisibleDialogueSync(document, () =>
      f.identity.current(),
    ).locate(f.job, () => {});
    return [f.observer.reconcile(root, 50), f.observer.reconcile(root, 50)];
  });
  expect(snapshots.map((s) => s.length)).toEqual([2, 2]);
  expect(snapshots[0]!.map((s) => s.direction)).toEqual(['INBOUND', 'OUTBOUND']);
  expect(new Set(snapshots[0]!.map((s) => s.messageRef!.key)).size).toBe(2);
  expect(snapshots[0]!.map((s) => s.messageRef!.key)).toEqual(
    snapshots[1]!.map((s) => s.messageRef!.key),
  );
  expect(snapshots[1]!.map((s) => s.messageRef!.revision)).toEqual([2, 2]);
  expect(await page.locator('footer [contenteditable]').innerText()).toBe('');
});

test('searches and selects one result by an ordinary press gesture, then reconciles the opened chat', async ({
  page,
}) => {
  await install(page);
  await page.evaluate(() => {
    document.querySelector('[data-testid="conversation-info-header-chat-title"]')!.textContent =
      'Synthetic other';
    const target = document.querySelector('#target')!;
    target.addEventListener('mousedown', () => {
      document.querySelector('[data-testid="conversation-info-header-chat-title"]')!.textContent =
        'Synthetic target';
      document.querySelector('#messages')!.innerHTML =
        '<div role="row" data-testid="conv-msg-phone"><div class="message-out"><span class="selectable-text">Synthetic current phone reply</span></div></div>';
    });
  });
  const result = await page.evaluate(async () => {
    const f = window.syncFixture;
    const root = await new window.syncClasses.VisibleDialogueSync(document, () =>
      f.identity.current(),
    ).locate(f.job, () => {});
    return f.observer.reconcile(root, 50);
  });
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({
    content: 'Synthetic current phone reply',
    direction: 'OUTBOUND',
  });
  expect(
    await page
      .getByRole('textbox', { name: 'Pesquisar ou começar uma nova conversa' })
      .inputValue(),
  ).toBe('');
});

test('blocks ambiguous names and drafts without navigating or clearing user input', async ({
  page,
}) => {
  await install(page);
  await page.evaluate(() => {
    const row = document.querySelector('#target')!.closest('[role="row"]')!;
    row.after(row.cloneNode(true));
  });
  expect(
    await page.evaluate(async () => {
      const f = window.syncFixture;
      try {
        await new window.syncClasses.VisibleDialogueSync(document, () =>
          f.identity.current(),
        ).locate(f.job, () => {});
        return 'unexpected';
      } catch (e) {
        return (e as Error).message;
      }
    }),
  ).toBe('AMBIGUOUS_CONTACT');
  await page.locator('footer [contenteditable]').fill('Synthetic unsent draft');
  expect(
    await page.evaluate(async () => {
      const f = window.syncFixture;
      try {
        await new window.syncClasses.VisibleDialogueSync(document, () =>
          f.identity.current(),
        ).locate(f.job, () => {});
        return 'unexpected';
      } catch (e) {
        return (e as Error).message;
      }
    }),
  ).toBe('COMPOSER_HAS_DRAFT');
  expect(await page.locator('footer [contenteditable]').innerText()).toBe('Synthetic unsent draft');
});

test('periodic reconciliation discovers an attribute-only root activation and stops in OFF', async ({
  page,
}) => {
  await install(page);
  await page.evaluate(() => {
    document.querySelector('#main')!.remove();
    const section = document.createElement('section');
    section.id = 'later';
    const now = new Date();
    const prefix = `[${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}, ${now.getDate()}/${now.getMonth() + 1}/${now.getFullYear()}] Synthetic: `;
    section.innerHTML = `<header><span data-testid="conversation-info-header-chat-title">Synthetic target</span></header><div role="row" data-testid="conv-msg-attribute-root"><div class="message-out"><div data-pre-plain-text="${prefix}"><span class="selectable-text">Synthetic found by watchdog</span></div></div></div>`;
    document.body.append(section);
  });
  // Let document childList delivery finish while this element is not a root.
  await page.waitForTimeout(100);
  await page.locator('#later').evaluate((el) => (el.id = 'main'));
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.syncFixture.events.some((e) => e.content === 'Synthetic found by watchdog'),
      ),
    )
    .toBe(true);
  const count = await page.evaluate(() => {
    window.syncFixture.observer.stop();
    return window.syncFixture.events.length;
  });
  await page.locator('#main .selectable-text').evaluate((el) => (el.textContent = 'Synthetic OFF'));
  await page.waitForTimeout(2300);
  expect(await page.evaluate(() => window.syncFixture.events.length)).toBe(count);
});

test('keeps the active dialogue reference across sidebar redraw when rendered message markers prove continuity', async ({
  page,
}) => {
  await install(page);
  const result = await page.evaluate(() => {
    const identity = window.syncFixture.identity;
    const before = identity.current();
    const row = document.querySelector('#target')!.closest('[role="row"]')!;
    row.replaceWith(row.cloneNode(true));
    const after = identity.current();
    return { before, after };
  });
  expect(result.after).toEqual(result.before);
});

test('does not join two connected namesake rows with the same title', async ({ page }) => {
  await install(page);
  const result = await page.evaluate(() => {
    const identity = window.syncFixture.identity;
    const before = identity.current();
    const row = document.querySelector('#target')!.closest('[role="row"]')!;
    const other = row.cloneNode(true) as HTMLElement;
    row.after(other);
    row.querySelector('[aria-selected]')!.remove();
    const after = identity.current();
    return { before, after };
  });
  expect(result.after?.type === 'UI_CONTEXT' && result.after.conversationKey).not.toBe(
    result.before?.type === 'UI_CONTEXT' && result.before.conversationKey,
  );
});
