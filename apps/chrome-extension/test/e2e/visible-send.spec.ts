import { expect, test, type Page } from '@playwright/test';
import { build, stop } from 'esbuild';
import type { VisibleSendExecutor } from '../../src/commands/visible-send.js';
import type { IdentityContext } from '../../src/identity/context.js';
import type { ExtensionSendCommand } from '@wai-bridge/shared';
type TestState = { clicks: number; steps: string[]; beforeSending: boolean };
declare global {
  interface Window {
    __waiClasses: {
      VisibleSendExecutor: typeof VisibleSendExecutor;
      IdentityContext: typeof IdentityContext;
    };
    __state: TestState;
    __start: () => void;
    __result: Promise<void>;
    __executor: VisibleSendExecutor;
    __identity: IdentityContext;
  }
}

const bundled = await build({
  stdin: {
    contents: `import {VisibleSendExecutor} from './src/commands/visible-send.ts';import {IdentityContext} from './src/identity/context.ts';window.__waiClasses={VisibleSendExecutor,IdentityContext};`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  target: 'chrome120',
});
const script = bundled.outputFiles[0]!.text;
stop();
async function setup(
  page: Page,
  mode: 'AUTO' | 'SUPERVISED' = 'AUTO',
  options: { enabled?: boolean; failSending?: boolean; pending?: boolean; draft?: boolean } = {},
) {
  await page.route('https://wai.test/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<main id="main"><header data-testid="conversation-header"><span data-testid="conversation-info-header-chat-title">Synthetic person</span></header><section id="messages"></section><footer><div role="textbox" contenteditable="true" style="min-height:24px">${options.draft ? 'Existing synthetic draft' : ''}</div><button type="button" aria-label="Enviar">Enviar</button></footer></main><aside data-testid="chat-info-drawer"><div data-testid="contact-info-header"><h2>Dados do contato</h2></div><span>+1 (202) 555-0123</span></aside>`,
    }),
  );
  await page.goto('https://wai.test/');
  await page.addScriptTag({ content: script });
  await page.evaluate(
    ({ mode, options }) => {
      const win = window;
      const identity = new win.__waiClasses.IdentityContext();
      const preview = identity.preview();
      const bound = identity.bind({
        kind: 'IDENTITY_BIND',
        contextId: preview.contextId,
        accountId: '11111111-1111-4111-8111-111111111111',
        confirmed: true,
      });
      if (bound.type !== 'PHONE') throw new Error('Synthetic phone required');
      const command: ExtensionSendCommand = {
        id: '22222222-2222-4222-8222-222222222222',
        conversationId: '33333333-3333-4333-8333-333333333333',
        leaseToken: '44444444-4444-4444-8444-444444444444',
        contextId: bound.contextId,
        target: { accountId: bound.accountId, type: 'PHONE', referenceKey: bound.phone },
        text: 'Synthetic good night ❤️',
        mode,
        explicitAuthorization: true,
        leaseUntil: new Date(Date.now() + 180_000).toISOString(),
      };
      win.__state = { clicks: 0, steps: [], beforeSending: false };
      const executor = new win.__waiClasses.VisibleSendExecutor(
        identity,
        async (_command: unknown, step: { step: string }) => {
          win.__state.steps.push(step.step);
          if (step.step === 'SENDING') {
            if (options.failSending) throw new Error('PROGRESS_UNAVAILABLE');
            win.__state.beforeSending = true;
          }
        },
      );
      executor.setEnabled(options.enabled ?? true);
      win.__executor = executor;
      win.__identity = identity;
      document.querySelector('footer button')!.addEventListener('click', () => {
        win.__state.clicks++;
        if (!win.__state.beforeSending) throw new Error('Clicked before durable SENDING');
        const row = document.createElement('div');
        row.setAttribute('role', 'row');
        row.setAttribute('data-testid', 'conv-msg-synthetic-new');
        row.innerHTML =
          '<div style="display:flex;flex-direction:column;align-items:flex-end"><div data-testid="msg-container"><span class="selectable-text"></span><span data-testid="tail-out"></span><span data-testid="msg-meta" aria-label="Entregue">12:00</span></div></div>';
        row.querySelector('.selectable-text')!.textContent = command.text;
        if (options.pending)
          row.querySelector('[aria-label]')!.setAttribute('aria-label', 'Pendente');
        document.querySelector('#messages')!.append(row);
        document.querySelector('[contenteditable]')!.textContent = '';
      });
      win.__start = () => {
        win.__result = executor.execute(command);
      };
    },
    { mode, options },
  );
}
async function start(page: Page) {
  await page.evaluate(() => {
    window.__start();
  });
}
async function result(page: Page) {
  await page.evaluate(async () => {
    await window.__result;
  });
  return page.evaluate(() => window.__state as { clicks: number; steps: string[] });
}

test('AUTO sends once after five seconds and durable acknowledgement, with visible evidence', async ({
  page,
}) => {
  await setup(page);
  const startAt = Date.now();
  await start(page);
  await expect(page.getByRole('button', { name: 'Cancelar envio WAI Bridge' })).toBeVisible();
  const state = await result(page);
  expect(Date.now() - startAt).toBeGreaterThanOrEqual(5000);
  expect(state).toMatchObject({ clicks: 1, steps: ['WAITING_AUTO_SEND', 'SENDING', 'SENT'] });
  await expect(
    page.evaluate(() => {
      window.__start();
      return window.__result;
    }),
  ).rejects.toThrow('COMMAND_ALREADY_ATTEMPTED');
  expect((await page.evaluate(() => window.__state)).clicks).toBe(1);
});
test('SUPERVISED waits for manual click and records SENDING before the synthetic send', async ({
  page,
}) => {
  await setup(page, 'SUPERVISED');
  await start(page);
  await expect(page.getByRole('status')).toContainText('confira');
  expect((await page.evaluate(() => window.__state)).clicks).toBe(0);
  await page.getByRole('button', { name: 'Enviar', exact: true }).click();
  expect(await result(page)).toMatchObject({
    clicks: 1,
    steps: ['WAITING_USER', 'SENDING', 'SENT'],
  });
});
test('fails closed if durable SENDING reply is lost', async ({ page }) => {
  await setup(page, 'SUPERVISED', { failSending: true });
  await start(page);
  await expect(page.getByRole('status')).toContainText('confira');
  await page.getByRole('button', { name: 'Enviar', exact: true }).click();
  expect(await result(page)).toMatchObject({
    clicks: 0,
    steps: ['WAITING_USER', 'SENDING', 'UNKNOWN'],
  });
});
test('cancels during countdown without clicking send', async ({ page }) => {
  await setup(page);
  await start(page);
  await page.getByRole('button', { name: 'Cancelar envio WAI Bridge' }).click();
  expect(await result(page)).toMatchObject({
    clicks: 0,
    steps: ['WAITING_AUTO_SEND', 'CANCELLED'],
  });
});
test('rejects disabled gate and existing drafts without editing or sending', async ({ page }) => {
  await setup(page, 'AUTO', { enabled: false });
  await start(page);
  expect(await result(page)).toMatchObject({ clicks: 0, steps: ['FAILED'] });
  await setup(page, 'AUTO', { draft: true });
  await start(page);
  expect(await result(page)).toMatchObject({ clicks: 0, steps: ['FAILED'] });
  await expect(page.getByRole('textbox')).toHaveText('Existing synthetic draft');
});
test('rejects changed context during countdown and revoked opt-in', async ({ page }) => {
  await setup(page);
  await start(page);
  await expect(page.getByRole('status')).toBeVisible();
  await page.locator('[data-testid="conversation-info-header-chat-title"]').evaluate((e) => {
    e.textContent = 'Different synthetic recipient';
  });
  expect(await result(page)).toMatchObject({ clicks: 0, steps: ['WAITING_AUTO_SEND', 'FAILED'] });
  await setup(page);
  await start(page);
  await expect(page.getByRole('status')).toBeVisible();
  await page.evaluate(() => window.__executor.setEnabled(false));
  expect((await result(page)).clicks).toBe(0);
});
test('pending bubble is UNKNOWN and never clicked twice', async ({ page }) => {
  await setup(page, 'SUPERVISED', { pending: true });
  await start(page);
  await expect(page.getByRole('status')).toContainText('confira');
  await page.getByRole('button', { name: 'Enviar', exact: true }).click();
  expect(await result(page)).toMatchObject({
    clicks: 1,
    steps: ['WAITING_USER', 'SENDING', 'UNKNOWN'],
  });
});

for (const behavior of [
  'false-after-insert',
  'delayed-insert',
  'no-insert',
  'wrong-insert',
] as const) {
  test(`composition verifies rendered text when insert command is ${behavior}`, async ({
    page,
  }) => {
    await setup(page, 'SUPERVISED');
    await page.evaluate((behavior) => {
      const original = document.execCommand.bind(document);
      document.execCommand = (name, ui, value) => {
        if (name !== 'insertText') return original(name, ui, value);
        if (behavior === 'false-after-insert') {
          original(name, ui, value);
          return false;
        }
        if (behavior === 'delayed-insert') {
          setTimeout(() => original(name, ui, value), 100);
          return false;
        }
        if (behavior === 'wrong-insert') original(name, ui, 'Different synthetic draft');
        return false;
      };
    }, behavior);
    await start(page);
    if (behavior === 'no-insert' || behavior === 'wrong-insert') {
      const state = await result(page);
      expect(state.steps).toContain('FAILED');
      expect(state.clicks).toBe(0);
      expect(state.steps).not.toContain('SENDING');
      return;
    }
    await expect
      .poll(() => page.evaluate(() => window.__state.steps.includes('WAITING_USER')))
      .toBe(true);
    expect(await page.evaluate(() => window.__state.clicks)).toBe(0);
    await page.evaluate(() => window.__executor.cancel());
    const state = await result(page);
    expect(state.steps).toContain('CANCELLED');
    expect(state.clicks).toBe(0);
  });
}
