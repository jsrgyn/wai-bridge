import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const fixture = await readFile(
  resolve(process.cwd(), '../../tests/fixtures/whatsapp-simulator/index.html'),
  'utf8',
);
const contentScript = resolve(process.cwd(), 'dist/content-script.js');

test('starts after activation and captures only newly added semantic messages', async ({
  page,
}) => {
  const delivered: unknown[] = [];
  await page.setContent(fixture);
  await page.exposeFunction('__waiSend', (message: unknown) => {
    if ((message as { kind?: string }).kind === 'CAPTURE_OBSERVATION') delivered.push(message);
  });
  await page.evaluate(() => {
    let sequence = 1;
    Object.defineProperty(window, 'crypto', {
      value: {
        randomUUID: () => `123e4567-e89b-42d3-a456-${(sequence++).toString(16).padStart(12, '0')}`,
      },
    });
    const listeners: Array<
      (message: unknown, sender: unknown, respond: (value: unknown) => void) => boolean | void
    > = [];
    (window as unknown as { chrome: unknown }).chrome = {
      runtime: {
        onMessage: {
          addListener: (listener: (typeof listeners)[number]) => listeners.push(listener),
        },
        sendMessage: (message: unknown) =>
          (window as unknown as { __waiSend: (payload: unknown) => Promise<void> })
            .__waiSend(message)
            .then(() => ({ ok: true })),
      },
    };
    (window as unknown as { __waiListeners: typeof listeners }).__waiListeners = listeners;
  });
  await page.addScriptTag({ path: contentScript });

  await page.evaluate(() => {
    const win = window as unknown as {
      __waiListeners: Array<
        (message: unknown, sender: unknown, respond: (value: unknown) => void) => boolean | void
      >;
    };
    for (const listener of win.__waiListeners)
      listener({ kind: 'MONITOR_CONTROL', enabled: true }, {}, () => undefined);
  });

  await page.evaluate(() => {
    const message = document.createElement('article');
    message.setAttribute('role', 'article');
    message.dataset.waiMessage = '';
    message.dataset.waiSender = 'Synthetic Contact';
    message.dataset.waiDirection = 'INBOUND';
    message.innerHTML =
      '<span data-wai-message-text>New synthetic message</span><span data-wai-media="AUDIO">Audio attachment</span>';
    document.querySelector('#individual')?.append(message);
    const image = document.createElement('article');
    image.setAttribute('role', 'article');
    image.dataset.waiMessage = '';
    image.dataset.waiSender = 'Synthetic Member B';
    image.dataset.waiDirection = 'INBOUND';
    image.innerHTML =
      '<span data-wai-message-text>Image note</span><span data-wai-media="IMAGE">Image attachment</span>';
    document.querySelector('#group')?.append(image);
  });

  await expect.poll(() => delivered.length).toBe(2);
  expect(delivered).toHaveLength(2);
  expect(delivered).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        captureState: 'CAPTURED',
        conversation: { label: 'Synthetic individual', kind: 'INDIVIDUAL' },
        senderLabel: 'Synthetic Contact',
        content: 'New synthetic message',
        media: ['AUDIO'],
      }),
      expect.objectContaining({
        captureState: 'CAPTURED',
        conversation: { label: 'Synthetic group', kind: 'GROUP' },
        senderLabel: 'Synthetic Member B',
        content: 'Image note',
        media: ['IMAGE'],
      }),
    ]),
  );
  expect(delivered).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({ content: 'Existing message before monitoring' }),
    ]),
  );
  await expect(page.locator('#unread-counter')).toHaveText('2');
});

test('records indicators without content, outbound messages, DOM replacement and duplicate nodes', async ({
  page,
}) => {
  const delivered: Array<Record<string, unknown>> = [];
  await page.setContent(fixture);
  await page.exposeFunction('__waiSend', (message: Record<string, unknown>) => {
    if ((message as { kind?: string }).kind === 'CAPTURE_OBSERVATION') delivered.push(message);
  });
  await page.evaluate(() => {
    let sequence = 1;
    Object.defineProperty(window, 'crypto', {
      value: {
        randomUUID: () => `123e4567-e89b-42d3-a456-${(sequence++).toString(16).padStart(12, '0')}`,
      },
    });
    const listeners: Array<
      (message: unknown, sender: unknown, respond: (value: unknown) => void) => void
    > = [];
    (window as unknown as { chrome: unknown }).chrome = {
      runtime: {
        onMessage: {
          addListener: (listener: (typeof listeners)[number]) => listeners.push(listener),
        },
        sendMessage: (message: unknown) =>
          (window as unknown as { __waiSend: (payload: unknown) => Promise<void> })
            .__waiSend(message)
            .then(() => ({ ok: true })),
      },
    };
    (window as unknown as { __waiListeners: typeof listeners }).__waiListeners = listeners;
  });
  await page.addScriptTag({ path: contentScript });
  await page.evaluate(() => {
    const listeners = (
      window as unknown as {
        __waiListeners: Array<
          (message: unknown, sender: unknown, respond: (value: unknown) => void) => void
        >;
      }
    ).__waiListeners;
    for (const listener of listeners)
      listener({ kind: 'MONITOR_CONTROL', enabled: true }, {}, () => undefined);
  });
  expect(delivered).toHaveLength(0);

  await page.evaluate(() => {
    const row = document.createElement('div');
    row.dataset.waiConversationRow = '';
    row.dataset.waiConversationType = 'GROUP';
    row.setAttribute('aria-label', 'New synthetic group');
    row.innerHTML = '<span data-wai-unread-count="3">3</span>';
    document.querySelector('[data-wai-conversation-list]')?.append(row);
    const existing = document.querySelector<HTMLElement>(
      '[aria-label="Existing synthetic conversation"]',
    );
    const indicator = document.createElement('span');
    indicator.dataset.waiUnreadCount = '1';
    indicator.textContent = '1';
    existing?.append(indicator);

    const outgoing = document.createElement('article');
    outgoing.dataset.waiMessage = '';
    outgoing.dataset.waiDirection = 'OUTBOUND';
    outgoing.setAttribute('role', 'article');
    outgoing.dataset.waiTestOutgoing = '';
    document.querySelector('#individual')?.append(outgoing);
    outgoing.remove();
    document.querySelector('#individual')?.append(outgoing);
  });
  await expect.poll(() => delivered.length).toBe(3);
  expect(delivered.filter((item) => item.observationType === 'CONVERSATION_ACTIVITY')).toHaveLength(
    2,
  );
  expect(delivered.filter((item) => item.captureState === 'PENDING')).toHaveLength(1);
  expect(delivered.find((item) => item.direction === 'OUTBOUND')).toMatchObject({
    content: null,
    contentAvailability: 'UNAVAILABLE',
  });

  await page.evaluate(() => {
    const replacement = document.createElement('section');
    replacement.id = 'group';
    replacement.dataset.waiObservationRoot = '';
    replacement.dataset.waiConversationType = 'GROUP';
    replacement.setAttribute('role', 'log');
    replacement.setAttribute('aria-label', 'Replacement group');
    replacement.innerHTML =
      '<article role="article" data-wai-message><span data-wai-message-text>Historical visible item</span></article>';
    document.querySelector('#group')?.replaceWith(replacement);
  });
  await page.waitForTimeout(0);
  await page.evaluate(() => {
    const message = document.createElement('article');
    message.setAttribute('role', 'article');
    message.dataset.waiMessage = '';
    message.dataset.waiSender = 'Synthetic Member C';
    message.innerHTML = '<span data-wai-message-text>Post-navigation item</span>';
    document.querySelector('#group')?.append(message);
  });
  await expect.poll(() => delivered.length).toBe(4);
  expect(delivered).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ content: 'Historical visible item' })]),
  );
  expect(delivered).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        content: 'Post-navigation item',
        conversation: { label: 'Replacement group', kind: 'GROUP' },
      }),
    ]),
  );

  await page.evaluate(() => {
    const broken = document.createElement('article');
    broken.dataset.waiMessage = '';
    broken.setAttribute('role', 'article');
    broken.querySelector = () => {
      throw new Error('Synthetic DOM change');
    };
    document.querySelector('#group')?.append(broken);
  });
  await expect
    .poll(() => delivered.filter((item) => item.captureState === 'FAILED').length)
    .toBe(1);
  expect(delivered.find((item) => item.captureState === 'FAILED')).toMatchObject({
    content: null,
    contentAvailability: 'UNAVAILABLE',
  });
});

test('popup renders state with text nodes and toggles monitoring', async ({ page }) => {
  const popup = await readFile(resolve(process.cwd(), 'dist/popup.html'), 'utf8');
  const script = await readFile(resolve(process.cwd(), 'dist/popup.js'), 'utf8');
  const css = await readFile(resolve(process.cwd(), 'dist/popup.css'), 'utf8');
  await page.setContent(
    popup
      .replace('<link rel="stylesheet" href="popup.css" />', `<style>${css}</style>`)
      .replace('<script src="popup.js"></script>', ''),
  );
  await page.evaluate(() => {
    const state = {
      monitoring: false,
      captureContext: 'NO_CONVERSATION',
      connection: 'UNCONFIGURED',
      activities: [
        { label: 'New accessible message observed', timestamp: new Date().toISOString() },
      ],
      errors: ['The page structure is not supported.'],
      retainActivitySummaries: true,
    };
    (window as unknown as { chrome: unknown }).chrome = {
      runtime: {
        sendMessage: async (request: { command?: string }) => ({
          ok: true,
          state: { ...state, monitoring: request.command === 'MONITOR_START' },
        }),
      },
    };
  });
  await page.addScriptTag({ content: script });
  await expect(page.locator('#monitor-state')).toHaveText('Monitoring: off');
  await expect(page.locator('#capture-context')).toContainText(
    'A lista registra somente avisos de atividade.',
  );
  await expect(page.locator('#activities')).toContainText('New accessible message observed');
  await page.getByRole('button', { name: 'Start monitoring' }).click();
  await expect(page.locator('#monitor-state')).toHaveText('Monitoring: on');
  await expect(page.locator('#errors')).toContainText('The page structure is not supported.');
});

test('captures hydrated current UI bubbles and changes after the initial baseline', async ({
  page,
}) => {
  const delivered: Array<Record<string, unknown>> = [];
  await page.setContent(
    `<main id="main"><header><div title="Profile controls"></div><span data-testid="conversation-info-header-chat-title">Synthetic chat</span></header><div role="row" id="old"><div style="display:flex;flex-direction:column;align-items:flex-start"><div data-testid="msg-container"><span class="selectable-text">Historical synthetic content</span><div data-testid="msg-meta"></div></div></div></div><div id="messages"></div></main>`,
  );
  await page.exposeFunction('__waiSend', (message: Record<string, unknown>) => {
    if ((message as { kind?: string }).kind === 'CAPTURE_OBSERVATION') delivered.push(message);
  });
  await page.evaluate(() => {
    let sequence = 1;
    Object.defineProperty(window, 'crypto', {
      value: {
        randomUUID: () => `123e4567-e89b-42d3-a456-${(sequence++).toString(16).padStart(12, '0')}`,
      },
    });
    const listeners: Array<
      (message: unknown, sender: unknown, respond: (value: unknown) => void) => void
    > = [];
    (window as unknown as { chrome: unknown }).chrome = {
      runtime: {
        onMessage: {
          addListener: (listener: (typeof listeners)[number]) => listeners.push(listener),
        },
        sendMessage: async (message: unknown) => {
          await (window as unknown as { __waiSend: (value: unknown) => Promise<void> }).__waiSend(
            message,
          );
          return { ok: true };
        },
      },
    };
    (window as unknown as { __waiListeners: typeof listeners }).__waiListeners = listeners;
  });
  await page.addScriptTag({ path: contentScript });
  await page.evaluate(() => {
    for (const listener of (
      window as unknown as {
        __waiListeners: Array<
          (message: unknown, sender: unknown, respond: (value: unknown) => void) => void
        >;
      }
    ).__waiListeners)
      listener({ kind: 'MONITOR_CONTROL', enabled: true }, {}, () => undefined);
    document.querySelector('#old .selectable-text')!.textContent = 'Historical synthetic edit';
    for (const [id, align] of [
      ['incoming', 'flex-start'],
      ['outgoing', 'flex-end'],
      ['ambiguous', 'center'],
      ['removed', 'flex-start'],
      ['conflicting', 'flex-end'],
      ['rtl', 'flex-start'],
    ]) {
      const row = document.createElement('div');
      row.setAttribute('role', 'row');
      row.id = id!;
      row.setAttribute('data-testid', `conv-msg-synthetic-${id}`);
      row.innerHTML = `<div style="display:flex;flex-direction:column;align-items:${align}"><div data-testid="msg-container"></div></div>`;
      document.querySelector('#messages')!.append(row);
    }
  });
  // Simulate the separate render that fills a newly inserted shell.
  await page.waitForTimeout(40);
  await page.evaluate(() => {
    for (const id of ['incoming', 'outgoing', 'ambiguous', 'removed', 'conflicting', 'rtl']) {
      const bubble = document.querySelector(`#${id} [data-testid="msg-container"]`)!;
      bubble.innerHTML = `<span class="selectable-text">Synthetic ${id}</span><div data-testid="msg-meta"></div>`;
    }
    document
      .querySelector('#conflicting [data-testid="msg-container"]')!
      .insertAdjacentHTML('beforeend', '<span data-testid="tail-in"></span>');
    (
      document.querySelector('#rtl [data-testid="msg-container"]')!.parentElement as HTMLElement
    ).style.direction = 'rtl';
    document.querySelector('#removed')!.remove();
  });
  await expect.poll(() => delivered.length).toBe(6);
  expect(delivered).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        content: 'Synthetic incoming',
        direction: 'INBOUND',
        captureState: 'CAPTURED',
      }),
      expect.objectContaining({
        content: 'Synthetic outgoing',
        direction: 'OUTBOUND',
        captureState: 'CAPTURED',
      }),
      expect.objectContaining({ content: 'Synthetic ambiguous', direction: 'UNKNOWN' }),
      expect.objectContaining({ content: 'Synthetic conflicting', direction: 'UNKNOWN' }),
      expect.objectContaining({ content: 'Synthetic rtl', direction: 'UNKNOWN' }),
    ]),
  );
  expect(delivered.filter((item) => String(item.content).includes('Historical'))).toEqual([
    expect.objectContaining({
      content: 'Historical synthetic edit',
      messageRef: expect.objectContaining({ revision: 1 }),
    }),
  ]);
  // A later metadata update must not duplicate the captured message.
  await page.evaluate(() => {
    document.querySelector('#incoming [data-testid="msg-meta"]')!.textContent = 'Synthetic status';
  });
  await page.waitForTimeout(200);
  expect(delivered).toHaveLength(6);
  expect(delivered[0]).toMatchObject({ conversation: { label: 'Synthetic chat' } });
  await page.evaluate(() => {
    const row = document.querySelector('#incoming')!;
    row.replaceWith(row.cloneNode(true));
  });
  await page.waitForTimeout(250);
  expect(delivered).toHaveLength(6);
  // A genuinely different row with identical text must still be captured.
  await page.evaluate(() => {
    const row = document.querySelector('#incoming')!.cloneNode(true) as HTMLElement;
    row.id = 'another-incoming';
    row.setAttribute('data-testid', 'conv-msg-synthetic-distinct');
    document.querySelector('#messages')!.append(row);
  });
  await expect.poll(() => delivered.length).toBe(7);
  expect(delivered.filter((item) => item.content === 'Synthetic incoming')).toHaveLength(2);
});

test('detects activity in closed chats when previews change without unread indicators', async ({
  page,
}) => {
  const delivered: Array<Record<string, unknown>> = [];
  await page.setContent(
    `<div id="pane-side"><div role="row"><div data-testid="cell-frame-container"><span data-testid="cell-frame-title">Synthetic closed contact</span><span id="preview-one" data-testid="cell-frame-secondary">Synthetic baseline one</span><span data-testid="chat-list-timestamp">12:00</span></div></div><div role="row"><div data-testid="cell-frame-container"><span data-testid="cell-frame-title">Synthetic closed group</span><span id="preview-two" data-testid="cell-frame-secondary">Synthetic baseline two</span><span data-testid="chat-list-timestamp">12:00</span></div></div></div>`,
  );
  await page.exposeFunction('__activity', (value: Record<string, unknown>) => {
    if (value.kind === 'CAPTURE_OBSERVATION') delivered.push(value);
  });
  await page.evaluate(() => {
    let sequence = 1;
    Object.defineProperty(window, 'crypto', {
      value: {
        randomUUID: () => `123e4567-e89b-42d3-a456-${(sequence++).toString(16).padStart(12, '0')}`,
      },
    });
    const listeners: Array<
      (message: unknown, sender: unknown, respond: (value: unknown) => void) => void
    > = [];
    (window as unknown as { chrome: unknown }).chrome = {
      runtime: {
        onMessage: {
          addListener: (listener: (typeof listeners)[number]) => listeners.push(listener),
        },
        sendMessage: async (message: unknown) => {
          await (window as unknown as { __activity: (value: unknown) => Promise<void> }).__activity(
            message,
          );
          return { ok: true };
        },
      },
    };
    (window as unknown as { __control: (enabled: boolean) => void }).__control = (enabled) =>
      listeners[0]!({ kind: 'MONITOR_CONTROL', enabled }, {}, () => {});
  });
  await page.addScriptTag({ path: contentScript });
  await page.evaluate(() =>
    (window as unknown as { __control: (enabled: boolean) => void }).__control(true),
  );
  expect(delivered).toHaveLength(0);
  // No chat is opened and no unread count exists. Both remote and local activity
  // can produce this UI change; do not invent message direction from the preview.
  await page.locator('#preview-one').evaluate((el) => {
    el.textContent = 'Synthetic phone reply preview';
  });
  await page.locator('#preview-two').evaluate((el) => {
    el.textContent = 'Synthetic new group preview';
  });
  await expect.poll(() => delivered.length).toBe(2);
  for (const value of delivered)
    expect(value).toMatchObject({
      observationType: 'CONVERSATION_ACTIVITY',
      captureState: 'DETECTED',
      direction: 'UNKNOWN',
      content: null,
      contentAvailability: 'UNAVAILABLE',
    });
  expect(delivered.map((value) => (value.conversation as { label: string }).label)).toEqual([
    'Synthetic closed contact',
    'Synthetic closed group',
  ]);
  await page.locator('#preview-one').evaluate((el) => {
    el.textContent = 'Synthetic phone reply preview';
  });
  await page.waitForTimeout(200);
  expect(delivered).toHaveLength(2);
  await page.evaluate(() =>
    (window as unknown as { __control: (enabled: boolean) => void }).__control(false),
  );
  await page.locator('#preview-two').evaluate((el) => {
    el.textContent = 'Synthetic activity after OFF';
  });
  await page.waitForTimeout(200);
  expect(delivered).toHaveLength(2);
});
