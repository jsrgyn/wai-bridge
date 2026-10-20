import { expect, test, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import type { CaptureObservation, DialogueSyncJob } from '@wai-bridge/shared';

type SyncReply = { code: string; observations: CaptureObservation[]; truncated: boolean };
declare global {
  interface Window {
    reviewProtocol: {
      listener: (message: unknown, sender: unknown, reply: (value: SyncReply) => void) => unknown;
      captures: unknown[];
      reply: SyncReply | null;
      scrolls: number;
      clicks: number;
    };
  }
}
async function setup(page: Page) {
  const messages = Array.from(
    { length: 60 },
    (_, i) =>
      `<div role="row" data-testid="conv-msg-snapshot-${i}"><div class="message-in"><div data-pre-plain-text="[12:00, 01/01/2020] Synthetic: "><span class="selectable-text">Synthetic snapshot ${i}</span></div></div></div>`,
  ).join('');
  await page.route('https://review-protocol.test/**', (route) =>
    route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<main id="main" data-wai-conversation-type="INDIVIDUAL"><header><span data-testid="conversation-info-header-chat-title">Synthetic recipient</span></header><section>${messages}</section><footer><div role="textbox" contenteditable="true"></div><button aria-label="Enviar">Synthetic send</button></footer></main>`,
    }),
  );
  await page.goto('https://review-protocol.test/');
  await page.evaluate(() => {
    window.reviewProtocol = {
      listener: () => {},
      captures: [],
      reply: null,
      scrolls: 0,
      clicks: 0,
    };
    (window as unknown as { chrome: unknown }).chrome = {
      runtime: {
        id: 'abcdefghijklmnopabcdefghijklmnop',
        onMessage: {
          addListener: (listener: Window['reviewProtocol']['listener']) => {
            window.reviewProtocol.listener = listener;
          },
        },
        sendMessage: async (raw: { kind: string }) => {
          if (raw.kind === 'GET_MONITOR_BOOT')
            return {
              ok: true,
              monitoring: true,
              accountId: '11111111-1111-4111-8111-111111111111',
            };
          if (raw.kind === 'CAPTURE_OBSERVATION') window.reviewProtocol.captures.push(raw);
          return { ok: true };
        },
      },
    };
    document.addEventListener('scroll', () => window.reviewProtocol.scrolls++, true);
    document
      .querySelector('footer button')!
      .addEventListener('click', () => window.reviewProtocol.clicks++);
  });
  await page.addScriptTag({ path: resolve(process.cwd(), 'dist/content-script.js') });
}
async function start(page: Page, batch?: DialogueSyncJob['batch']) {
  return page.evaluate((batch) => {
    const job: DialogueSyncJob = {
      id: crypto.randomUUID(),
      leaseToken: crypto.randomUUID(),
      accountId: '11111111-1111-4111-8111-111111111111',
      query: 'Synthetic recipient',
      limit: 50,
      expiresAt: new Date(Date.now() + 30000).toISOString(),
      ...(batch ? { batch } : {}),
    };
    window.reviewProtocol.listener(
      { kind: 'SYNC_DIALOGUE', job },
      { id: 'abcdefghijklmnopabcdefghijklmnop' },
      (reply) => {
        window.reviewProtocol.reply = reply;
      },
    );
    return job.id;
  }, batch);
}
test('deliberate content sync returns the last50 rendered messages only through completion, without live notifications, scrolling or sending', async ({
  page,
}) => {
  await setup(page);
  await start(page);
  await expect.poll(() => page.evaluate(() => window.reviewProtocol.reply?.code)).toBe('OK');
  const state = await page.evaluate(() => window.reviewProtocol);
  expect(state.reply?.observations).toHaveLength(50);
  expect(state.reply?.observations[0]?.content).toBe('Synthetic snapshot 10');
  expect(state.reply?.observations.at(-1)?.content).toBe('Synthetic snapshot 59');
  expect(state.reply?.truncated).toBe(true);
  expect(state.captures).toEqual([]);
  expect(state.scrolls).toBe(0);
  expect(state.clicks).toBe(0);
  expect(await page.locator('footer [contenteditable]').innerText()).toBe('');
});
test('trusted input during snapshot settling aborts without publishing snapshot observations or changing the user draft', async ({
  page,
}) => {
  await setup(page);
  await page.locator('footer [contenteditable]').focus();
  await start(page);
  await page.keyboard.type('Synthetic user draft');
  await expect
    .poll(() => page.evaluate(() => window.reviewProtocol.reply?.code))
    .toBe('USER_INTERFERENCE');
  const state = await page.evaluate(() => window.reviewProtocol);
  expect(state.reply?.observations).toEqual([]);
  expect(state.captures).toEqual([]);
  expect(state.clicks).toBe(0);
  expect(await page.locator('footer [contenteditable]').innerText()).toBe('Synthetic user draft');
});

test('cancellation is scoped to the active request and authorized extension and aborts before snapshot publication', async ({
  page,
}) => {
  await setup(page);
  const id = await start(page);
  await page.evaluate((id) => {
    const state = window.reviewProtocol;
    state.listener({ kind: 'SYNC_CANCEL', requestId: id }, { id: 'wrong-extension' }, () => {});
    state.listener(
      { kind: 'SYNC_CANCEL', requestId: crypto.randomUUID() },
      { id: 'abcdefghijklmnopabcdefghijklmnop' },
      () => {},
    );
  }, id);
  expect(await page.evaluate(() => window.reviewProtocol.reply)).toBeNull();
  await page.evaluate(
    (id) =>
      window.reviewProtocol.listener(
        { kind: 'SYNC_CANCEL', requestId: id },
        { id: 'abcdefghijklmnopabcdefghijklmnop' },
        () => {},
      ),
    id,
  );
  await expect.poll(() => page.evaluate(() => window.reviewProtocol.reply?.code)).toBe('CANCELLED');
  const state = await page.evaluate(() => window.reviewProtocol);
  expect(state.reply?.observations).toEqual([]);
  expect(state.captures).toEqual([]);
  expect(state.clicks).toBe(0);
});

test('trusted interaction between batch items prevents the next navigation until explicitly resumed with a new run token', async ({
  page,
}) => {
  await setup(page);
  const batch = {
    id: '22222222-2222-4222-8222-222222222222',
    runToken: '33333333-3333-4333-8333-333333333333',
    position: 0,
    total: 2,
    conversationIds: [
      '44444444-4444-4444-8444-444444444444',
      '55555555-5555-4555-8555-555555555555',
    ],
  };
  await start(page, batch);
  await expect.poll(() => page.evaluate(() => window.reviewProtocol.reply?.code)).toBe('OK');
  await page.keyboard.press('ArrowRight');
  await page.evaluate(() => {
    window.reviewProtocol.reply = null;
  });
  await start(page, { ...batch, position: 1 });
  await expect
    .poll(() => page.evaluate(() => window.reviewProtocol.reply?.code))
    .toBe('USER_INTERFERENCE');
  expect(await page.evaluate(() => window.reviewProtocol.reply?.observations)).toEqual([]);
  await page.evaluate(() => {
    window.reviewProtocol.reply = null;
  });
  await start(page, { ...batch, position: 1, runToken: '66666666-6666-4666-8666-666666666666' });
  await expect.poll(() => page.evaluate(() => window.reviewProtocol.reply?.code)).toBe('OK');
  expect(await page.evaluate(() => window.reviewProtocol.captures)).toEqual([]);
});
test('blocks incompatible rendered structure before snapshot or navigation',async({page})=>{await setup(page);await page.locator('#main').evaluate(main=>main.append(document.createElement('header')));await start(page);await expect.poll(()=>page.evaluate(()=>window.reviewProtocol.reply?.code)).toBe('UI_UNSUPPORTED');const state=await page.evaluate(()=>({reply:window.reviewProtocol.reply,scrolls:window.reviewProtocol.scrolls,clicks:window.reviewProtocol.clicks}));expect(state.reply?.observations).toEqual([]);expect(state.scrolls).toBe(0);expect(state.clicks).toBe(0);});
