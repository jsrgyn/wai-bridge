import { expect, test } from '@playwright/test';
import { build, stop } from 'esbuild';
import type { CaptureObservation } from '@wai-bridge/shared';
import type { MonitorObserver } from '../../src/observers/monitor-observer.js';
import type { AutomaticContext } from '../../src/identity/automatic-context.js';
import type { MediaDetector } from '../../src/adapters/media-detector.js';
const bundle = await build({
  stdin: {
    contents: `import {MonitorObserver} from './src/observers/monitor-observer.ts';import {AutomaticContext} from './src/identity/automatic-context.ts';import {MediaDetector} from './src/adapters/media-detector.ts';window.liveClasses={MonitorObserver,AutomaticContext,MediaDetector};`,
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
    liveClasses: {
      MonitorObserver: typeof MonitorObserver;
      AutomaticContext: typeof AutomaticContext;
      MediaDetector: typeof MediaDetector;
    };
    liveCapture: { events: CaptureObservation[]; observer: MonitorObserver };
  }
}
async function install(page: import('@playwright/test').Page, initialUnread = false) {
  const html = `<div id="pane-side"><div role="row" id="row-a"><div data-testid="cell-frame-container"><div data-testid="cell-frame-title"><span aria-label="2 mensagens não lidas">2 mensagens não lidas</span><span title="Synthetic remote">Synthetic remote</span></div><span data-testid="cell-frame-secondary">Baseline A</span></div></div><div role="row" id="row-b"><div data-testid="cell-frame-container"><div data-testid="cell-frame-title"><span title="Synthetic remote">Synthetic remote</span></div><span data-testid="cell-frame-secondary">Baseline B</span></div></div><div role="row" id="row-local"><span aria-selected="true"></span></div></div><main id="main" data-wai-conversation-type="INDIVIDUAL"><header><span data-testid="conversation-info-header-chat-title">Synthetic local</span></header><div role="row" data-testid="conv-msg-baseline"><div class="message-in"><div data-pre-plain-text="[12:00, 01/01/2020] Synthetic: "><span class="selectable-text">Synthetic baseline</span></div></div></div><section id="messages"></section></main>`;
  await page.route('https://live-capture.test/**', (route) =>
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }),
  );
  await page.goto('https://live-capture.test/');
  if (!initialUnread) await page.locator('#row-a [aria-label]').evaluate((e) => e.remove());
  await page.addScriptTag({ content: script });
  await page.evaluate(() => {
    const identity = new window.liveClasses.AutomaticContext(
      '11111111-1111-4111-8111-111111111111',
    );
    const events: CaptureObservation[] = [];
    const observer = new window.liveClasses.MonitorObserver(
      (value, root) => events.push(identity.enrich(value, root)),
      () => {
        throw new Error('Synthetic parsing failure');
      },
      () => {
        const current = identity.current();
        return current?.type === 'UI_CONTEXT' ? current.conversationKey : undefined;
      },
    );
    window.liveCapture = { events, observer };
    observer.start();
  });
}

test('updates captured messages and late attachments without duplicate dialogue references or initial history', async ({
  page,
}) => {
  await install(page);
  await page.evaluate(() => {
    const row = document.createElement('div');
    row.setAttribute('role', 'row');
    row.setAttribute('data-testid', 'conv-msg-live');
    row.innerHTML =
      '<div class="message-out"><span class="selectable-text">Synthetic from another device</span></div>';
    document.querySelector('#messages')!.append(row);
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => window.liveCapture.events.filter((e) => e.observationType === 'MESSAGE').length,
      ),
    )
    .toBe(1);
  await page.evaluate(() => {
    document.querySelector('[data-testid="conv-msg-live"] .selectable-text')!.textContent =
      'Synthetic edited from another device';
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => window.liveCapture.events.filter((e) => e.observationType === 'MESSAGE').length,
      ),
    )
    .toBe(2);
  await page.evaluate(() => {
    document
      .querySelector('[data-testid="conv-msg-live"] .message-out')!
      .insertAdjacentHTML(
        'beforeend',
        '<button aria-label="Reproduzir mensagem de voz">Synthetic audio</button>',
      );
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => window.liveCapture.events.filter((e) => e.observationType === 'MESSAGE').length,
      ),
    )
    .toBe(3);
  const messages = await page.evaluate(() =>
    window.liveCapture.events.filter((e) => e.observationType === 'MESSAGE'),
  );
  expect(messages.map((e) => e.messageRef?.revision)).toEqual([1, 2, 3]);
  expect(new Set(messages.map((e) => e.messageRef?.key)).size).toBe(1);
  expect(messages.at(-1)).toMatchObject({
    direction: 'OUTBOUND',
    content: 'Synthetic edited from another device',
    media: ['AUDIO'],
  });
  await page.evaluate(() => {
    for (const selector of ['[data-testid="conv-msg-live"]', '[data-testid="conv-msg-baseline"]']) {
      const row = document.querySelector(selector)!;
      row.replaceWith(row.cloneNode(true));
    }
  });
  await page.waitForTimeout(300);
  expect(
    await page.evaluate(
      () => window.liveCapture.events.filter((e) => e.observationType === 'MESSAGE').length,
    ),
  ).toBe(3);
  await page.evaluate(() => {
    const row = document
      .querySelector('[data-testid="conv-msg-live"]')!
      .cloneNode(true) as HTMLElement;
    row.setAttribute('data-testid', 'conv-msg-distinct');
    document.querySelector('#messages')!.append(row);
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => window.liveCapture.events.filter((e) => e.observationType === 'MESSAGE').length,
      ),
    )
    .toBe(4);
  const all = await page.evaluate(() =>
    window.liveCapture.events.filter((e) => e.observationType === 'MESSAGE'),
  );
  expect(all[3]!.messageRef?.key).not.toBe(all[0]!.messageRef?.key);
});

test('identifies inactive row activity, keeps namesakes separate, links the opened row and stops when OFF', async ({
  page,
}) => {
  await install(page);
  await page.evaluate(() => {
    document.querySelector('#row-a [data-testid="cell-frame-secondary"]')!.textContent =
      'Synthetic incoming update';
  });
  await expect.poll(() => page.evaluate(() => window.liveCapture.events.length)).toBe(1);
  const activity = await page.evaluate(() => window.liveCapture.events[0]!);
  expect(activity).toMatchObject({
    observationType: 'CONVERSATION_ACTIVITY',
    conversation: { label: 'Synthetic remote' },
    identity: { type: 'UI_CONTEXT' },
    content: null,
  });
  await page.evaluate(() => {
    document.querySelector('#row-b [data-testid="cell-frame-secondary"]')!.textContent =
      'Synthetic namesake update';
  });
  await expect.poll(() => page.evaluate(() => window.liveCapture.events.length)).toBe(2);
  const other = await page.evaluate(() => window.liveCapture.events[1]!);
  expect(other.identity?.type === 'UI_CONTEXT' && other.identity.conversationKey).not.toBe(
    activity.identity?.type === 'UI_CONTEXT' && activity.identity.conversationKey,
  );
  await page.evaluate(() => {
    document.querySelector(
      '#main [data-testid="conversation-info-header-chat-title"]',
    )!.textContent = 'Synthetic remote';
    document.querySelector('#row-local [aria-selected]')!.remove();
    document
      .querySelector('#row-a')!
      .insertAdjacentHTML('beforeend', '<span aria-selected="true"></span>');
    document
      .querySelector('#messages')!
      .insertAdjacentHTML(
        'beforeend',
        '<div role="row" data-testid="conv-msg-remote"><div class="message-in"><span class="selectable-text">Synthetic now visible</span></div></div>',
      );
  });
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.liveCapture.events.some((e) => e.content === 'Synthetic now visible'),
      ),
    )
    .toBe(true);
  const message = await page.evaluate(() =>
    window.liveCapture.events.find((e) => e.content === 'Synthetic now visible')!,
  );
  expect(message.identity?.type === 'UI_CONTEXT' && message.identity.conversationKey).toBe(
    activity.identity?.type === 'UI_CONTEXT' && activity.identity.conversationKey,
  );
  const before = await page.evaluate(() => {
    window.liveCapture.observer.stop();
    return window.liveCapture.events.length;
  });
  await page.evaluate(() => {
    document.querySelector('#messages .selectable-text')!.textContent = 'Synthetic after OFF';
    document.querySelector('#row-a [data-testid="cell-frame-secondary"]')!.textContent =
      'Synthetic after OFF';
  });
  await page.waitForTimeout(250);
  expect(await page.evaluate(() => window.liveCapture.events.length)).toBe(before);
});

test('distinguishes emoji from image attachments and recognizes localized media controls', async ({
  page,
}) => {
  await page.setContent(
    '<article><span class="selectable-text">Synthetic <img class="emoji" alt="❤️"/></span><button aria-label="Reproduzir mensagem de voz"></button><button aria-label="Open document"></button><button aria-label="Abrir vídeo"></button></article>',
  );
  await page.addScriptTag({ content: script });
  expect(
    await page.evaluate(() =>
      new window.liveClasses.MediaDetector().detect(document.querySelector('article')!),
    ),
  ).toEqual(['AUDIO', 'DOCUMENT', 'VIDEO']);
});

test('captures changes to baseline text nodes and nested bubbles without importing initial history', async ({
  page,
}) => {
  await install(page);
  await page.waitForTimeout(250);
  expect(await page.evaluate(() => window.liveCapture.events.length)).toBe(0);
  await page.evaluate(() => {
    // Old date remains: this is a change observed now, not a history insertion.
    const bubble = document.querySelector('[data-testid="conv-msg-baseline"] .message-in')!;
    bubble.insertAdjacentHTML(
      'beforeend',
      '<span data-pre-plain-text="[12:00, 01/01/2020] Synthetic: "></span>',
    );
    bubble.querySelector('.selectable-text')!.firstChild!.textContent = 'Synthetic edited after ON';
  });
  await expect.poll(() => page.evaluate(() => window.liveCapture.events.length)).toBe(1);
  await page.evaluate(() => {
    const bubble = document.querySelector('[data-testid="conv-msg-baseline"] .message-in')!;
    // Changing structure alone must not duplicate an unchanged message.
    bubble.innerHTML = '<div data-testid="msg-container">' + bubble.innerHTML + '</div>';
  });
  await page.waitForTimeout(250);
  expect(await page.evaluate(() => window.liveCapture.events.length)).toBe(1);
  await page.evaluate(() => {
    document.querySelector('[data-testid="conv-msg-baseline"] .selectable-text')!.textContent =
      'Synthetic nested edit';
  });
  await expect.poll(() => page.evaluate(() => window.liveCapture.events.length)).toBe(2);
  await page.evaluate(() => {
    const bubble = document.querySelector('[data-testid="conv-msg-baseline"] .message-in')!;
    bubble.insertAdjacentHTML(
      'beforeend',
      '<button id="late-media" aria-label="Synthetic control"></button>',
    );
  });
  await page.waitForTimeout(250);
  expect(await page.evaluate(() => window.liveCapture.events.length)).toBe(2);
  await page.evaluate(() => {
    // Attribute-only change, with no new message node.
    document.querySelector('#late-media')!.setAttribute('aria-label', 'Reproduzir mensagem de voz');
  });
  await expect.poll(() => page.evaluate(() => window.liveCapture.events.length)).toBe(3);
  await page.evaluate(() => {
    const row = document.querySelector('[data-testid="conv-msg-baseline"]')!;
    row.replaceWith(row.cloneNode(true));
  });
  await page.waitForTimeout(250);
  expect(await page.evaluate(() => window.liveCapture.events.length)).toBe(3);
  await page.evaluate(() => {
    document.querySelector('[data-testid="conv-msg-baseline"] .selectable-text')!.textContent =
      'Synthetic edit after remount';
  });
  await expect.poll(() => page.evaluate(() => window.liveCapture.events.length)).toBe(4);
  const events = await page.evaluate(() => window.liveCapture.events);
  expect(events.map((e) => e.messageRef?.revision)).toEqual([1, 2, 3, 4]);
  expect(new Set(events.map((e) => e.messageRef?.key)).size).toBe(1);
  expect(events.at(-1)).toMatchObject({
    direction: 'INBOUND',
    content: 'Synthetic edit after remount',
    media: ['AUDIO'],
  });
  await page.evaluate(() => {
    window.liveCapture.observer.stop();
    document.querySelector('[data-testid="conv-msg-baseline"] .selectable-text')!.textContent =
      'Synthetic after OFF';
  });
  await page.waitForTimeout(250);
  expect(await page.evaluate(() => window.liveCapture.events.length)).toBe(4);
});

test('records status attribute changes as activity without inventing messages', async ({
  page,
}) => {
  await install(page);
  await page.evaluate(() => {
    document
      .querySelector('#row-a [data-testid="cell-frame-container"]')!
      .insertAdjacentHTML(
        'beforeend',
        '<span data-testid="last-msg-status"><span data-icon="msg-check"></span></span>',
      );
  });
  await expect.poll(() => page.evaluate(() => window.liveCapture.events.length)).toBe(1);
  await page.evaluate(() => {
    document.querySelector('#row-a [data-icon]')!.setAttribute('data-icon', 'msg-dblcheck');
  });
  await expect.poll(() => page.evaluate(() => window.liveCapture.events.length)).toBe(2);
  const events = await page.evaluate(() => window.liveCapture.events);
  expect(
    events.every((e) => e.observationType === 'CONVERSATION_ACTIVITY' && e.content === null),
  ).toBe(true);
  await page.evaluate(() => document.querySelector('#row-a')!.setAttribute('style', 'color:red'));
  await page.waitForTimeout(250);
  expect(await page.evaluate(() => window.liveCapture.events.length)).toBe(2);
});

test('captures a current message when WhatsApp replaces the conversation root after ON', async ({
  page,
}) => {
  await install(page);
  await page.evaluate(() => {
    const root = document.querySelector('#main')!;
    const replacement = root.cloneNode(true) as HTMLElement;
    const now = new Date();
    const prefix = `[${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}, ${now.getDate()}/${now.getMonth() + 1}/${now.getFullYear()}] Synthetic: `;
    replacement.querySelector('#messages')!.innerHTML =
      `<div data-testid="conv-msg-after-root-replacement" role="row"><div class="message-out"><div data-pre-plain-text="${prefix}"><span class="selectable-text">Synthetic synced after root replacement</span></div></div></div>`;
    root.replaceWith(replacement);
  });
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.liveCapture.events.some(
          (e) => e.content === 'Synthetic synced after root replacement',
        ),
      ),
    )
    .toBe(true);
});

test('captures the reply body rather than the quoted older message', async ({ page }) => {
  await install(page);
  await page.evaluate(() => {
    document.querySelector('#messages')!.innerHTML =
      '<div data-testid="conv-msg-quoted" role="row"><div class="message-out"><div data-testid="quoted-message"><span class="selectable-text">Synthetic older quoted content</span></div><div class="copyable-text" data-pre-plain-text="Synthetic visible sender"><span class="selectable-text">Synthetic actual new reply</span></div></div></div>';
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => window.liveCapture.events.filter((e) => e.observationType === 'MESSAGE').length,
      ),
    )
    .toBe(1);
  expect(
    await page.evaluate(
      () => window.liveCapture.events.find((e) => e.observationType === 'MESSAGE')!.content,
    ),
  ).toBe('Synthetic actual new reply');
});

test('ON publishes only metadata for existing rendered unread badges, without importing preview/history or opening a chat', async ({
  page,
}) => {
  await install(page, true);
  await expect.poll(() => page.evaluate(() => window.liveCapture.events.length)).toBe(1);
  const initial = await page.evaluate(() => window.liveCapture.events[0]);
  expect(initial).toMatchObject({
    observationType: 'CONVERSATION_ACTIVITY',
    content: null,
    conversation: { label: 'Synthetic remote' },
    activity: { reason: 'INITIAL_UNREAD', unreadCount: 2 },
  });
  expect(await page.locator('#main header').innerText()).toBe('Synthetic local');
  await page.locator('#row-a [aria-label]').evaluate((e) => e.remove());
  await expect.poll(() => page.evaluate(() => window.liveCapture.events.length)).toBe(2);
  expect(await page.evaluate(() => window.liveCapture.events[1])).toMatchObject({
    observationType: 'CONVERSATION_ACTIVITY',
    content: null,
    activity: { reason: 'UNREAD_DECREASED', unreadCount: null },
  });
  expect(await page.locator('#main header').innerText()).toBe('Synthetic local');
  await page.evaluate(() => window.liveCapture.observer.stop());
  await page
    .locator('#row-b [data-testid="cell-frame-secondary"]')
    .evaluate((e) => (e.textContent = 'Synthetic after OFF'));
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.liveCapture.events.length)).toBe(2);
});

test('new sender, returning sender and other-device activity publish distinct references without automatic navigation', async ({
  page,
}) => {
  await install(page);
  await page.evaluate(() => {
    document
      .querySelector('#pane-side')!
      .insertAdjacentHTML(
        'beforeend',
        '<div role="row" id="new-person"><div data-testid="cell-frame-container"><div data-testid="cell-frame-title"><span title="Synthetic new sender">Synthetic new sender</span></div><span data-testid="cell-frame-secondary">Synthetic notification preview</span><span data-wai-unread-count="1">1</span></div></div>',
      );
    document.querySelector('#row-a [data-testid="cell-frame-secondary"]')!.textContent =
      'Synthetic returning sender';
    document.querySelector('#row-b [data-testid="cell-frame-secondary"]')!.textContent =
      'Synthetic another-device activity';
  });
  await expect.poll(() => page.evaluate(() => window.liveCapture.events.length)).toBe(3);
  const events = await page.evaluate(() => window.liveCapture.events);
  expect(
    events.every((e) => e.content === null && e.observationType === 'CONVERSATION_ACTIVITY'),
  ).toBe(true);
  expect(
    new Set(
      events.map((e) => (e.identity?.type === 'UI_CONTEXT' ? e.identity.conversationKey : null)),
    ).size,
  ).toBe(3);
  expect(
    events.find((e) => e.conversation.label === 'Synthetic new sender')?.activity?.unreadCount,
  ).toBe(1);
  expect(await page.locator('#main header').innerText()).toBe('Synthetic local');
});
