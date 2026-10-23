import { expect, test, type Page } from '@playwright/test';
import { build, stop } from 'esbuild';
import type { VisibleSendExecutor } from '../../src/commands/visible-send.js';
import type { IdentityContext } from '../../src/identity/context.js';
import type { ExtensionSendCommand } from '@wai-bridge/shared';
type TestState = { clicks: number; steps: string[]; codes: string[]; beforeSending: boolean };
declare global {
  interface Window {
    __waiClasses: {
      VisibleSendExecutor: typeof VisibleSendExecutor;
      IdentityContext: typeof IdentityContext;
    };
    __state: TestState;
    __start: () => void;
    __startNext: (text: string, appendToDraft: boolean) => void;
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
  options: {
    enabled?: boolean;
    failSending?: boolean;
    pending?: boolean;
    draft?: string;
    autoCountdownMs?: number;
    sendVerifyMs?: number;
    appendToDraft?: boolean;
    text?: string;
    otherChatDraft?: string;
  } = {},
) {
  await page.route('https://wai.test/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<main id="main"><header data-testid="conversation-header"><span data-testid="conversation-info-header-chat-title">Synthetic person</span></header><section id="messages"></section><footer><div role="textbox" contenteditable="true" style="min-height:24px">${options.draft ?? ''}</div><button type="button" aria-label="Enviar">Enviar</button></footer></main><aside data-testid="chat-info-drawer"><div data-testid="contact-info-header"><h2>Dados do contato</h2></div><span>+1 (202) 555-0123</span></aside>${options.otherChatDraft === undefined ? '' : `<section id="other-chat"><footer><div id="other-composer" contenteditable="true" style="min-height:24px">${options.otherChatDraft}</div></footer></section>`}`,
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
        text: options.text ?? 'Synthetic good night ❤️',
        mode,
        explicitAuthorization: true,
        leaseUntil: new Date(Date.now() + 180_000).toISOString(),
        timing: {
          autoCountdownMs: options.autoCountdownMs ?? 5000,
          executionTimeoutMs: 60000,
          queueMaxWaitMs: 1800000,
          sendVerifyMs: options.sendVerifyMs ?? 15000,
        },
        appendToDraft: options.appendToDraft ?? false,
      };
      win.__state = { clicks: 0, steps: [], codes: [], beforeSending: false };
      const executor = new win.__waiClasses.VisibleSendExecutor(
        identity,
        async (_command: unknown, step: { step: string; code: string }) => {
          win.__state.steps.push(step.step);
          win.__state.codes.push(step.code);
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
      win.__startNext = (text: string, appendToDraft: boolean) => {
        win.__result = executor.execute({
          ...command,
          id: '55555555-5555-4555-8555-555555555555',
          leaseToken: '66666666-6666-4666-8666-666666666666',
          text,
          appendToDraft,
        });
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
test('supervised leaves text in composer, target chat open, reports DRAFTED without user click', async ({
  page,
}) => {
  await setup(page, 'SUPERVISED');
  await start(page);
  expect(await result(page)).toMatchObject({ clicks: 0, steps: ['DRAFTED'] });
  await expect(page.getByRole('textbox')).toHaveText('Synthetic good night ❤️');
  await expect(page.locator('[data-testid="conversation-info-header-chat-title"]')).toHaveText(
    'Synthetic person',
  );
  await expect(page.getByRole('status')).toHaveCount(0);
});
test('supervised replaces an existing draft, including its own earlier text, without duplicating', async ({
  page,
}) => {
  for (const draft of ['Existing synthetic draft', 'Synthetic good night ❤️']) {
    await setup(page, 'SUPERVISED', { draft });
    await start(page);
    expect(await result(page)).toMatchObject({ clicks: 0, steps: ['DRAFTED'] });
    await expect(page.getByRole('textbox')).toHaveText('Synthetic good night ❤️');
  }
});
test('auto with countdown 0 sends immediately and reports SENT', async ({ page }) => {
  await setup(page, 'AUTO', { autoCountdownMs: 0 });
  const startAt = Date.now();
  await start(page);
  const state = await result(page);
  expect(Date.now() - startAt).toBeLessThan(4000);
  expect(state).toMatchObject({ clicks: 1, steps: ['WAITING_AUTO_SEND', 'SENDING', 'SENT'] });
});
test('auto uses configured verify timeout', async ({ page }) => {
  await setup(page, 'AUTO', { autoCountdownMs: 0, sendVerifyMs: 5000, pending: true });
  const startAt = Date.now();
  await start(page);
  const state = await result(page);
  expect(Date.now() - startAt).toBeLessThan(9000);
  expect(state).toMatchObject({ clicks: 1, steps: ['WAITING_AUTO_SEND', 'SENDING', 'UNKNOWN'] });
});
test('fails closed if durable SENDING reply is lost', async ({ page }) => {
  await setup(page, 'AUTO', { autoCountdownMs: 0, failSending: true });
  await start(page);
  expect(await result(page)).toMatchObject({
    clicks: 0,
    steps: ['WAITING_AUTO_SEND', 'SENDING', 'UNKNOWN'],
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
test('rejects disabled gate without editing or sending', async ({ page }) => {
  await setup(page, 'AUTO', { enabled: false, draft: 'Existing synthetic draft' });
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
    const state = await result(page);
    expect(state).toMatchObject({ clicks: 0, steps: ['DRAFTED'] });
  });
}

async function composerText(page: Page) {
  return page.getByRole('textbox').evaluate((e) => (e as HTMLElement).innerText.trim());
}
test('second supervised request to same target appends on new line', async ({ page }) => {
  await setup(page, 'SUPERVISED', { text: 'Synthetic first note' });
  await start(page);
  expect(await result(page)).toMatchObject({ clicks: 0, steps: ['DRAFTED'] });
  await page.evaluate(() => window.__startNext('Synthetic second note', true));
  expect(await result(page)).toMatchObject({ clicks: 0, steps: ['DRAFTED', 'DRAFTED'] });
  expect(await composerText(page)).toBe('Synthetic first note\nSynthetic second note');
});
test('user-edited draft is preserved and new text appended at end', async ({ page }) => {
  await setup(page, 'SUPERVISED', {
    draft: 'Synthetic first note, edited by user',
    text: 'Synthetic second note',
    appendToDraft: true,
  });
  await start(page);
  expect(await result(page)).toMatchObject({ clicks: 0, steps: ['DRAFTED'] });
  expect(await composerText(page)).toBe(
    'Synthetic first note, edited by user\nSynthetic second note',
  );
});
test('foreign text in target composer is erased when no earlier DRAFTED', async ({ page }) => {
  await setup(page, 'SUPERVISED', { draft: 'Foreign synthetic text', appendToDraft: false });
  await start(page);
  expect(await result(page)).toMatchObject({ clicks: 0, steps: ['DRAFTED'] });
  expect(await composerText(page)).toBe('Synthetic good night ❤️');
});
test('requeued append does not duplicate text', async ({ page }) => {
  await setup(page, 'SUPERVISED', {
    draft: 'Synthetic first note<br>Synthetic second note',
    text: 'Synthetic second note',
    appendToDraft: true,
  });
  await start(page);
  expect(await result(page)).toMatchObject({ clicks: 0, steps: ['DRAFTED'] });
  expect(await composerText(page)).toBe('Synthetic first note\nSynthetic second note');
});
test('composer of a different chat is never touched', async ({ page }) => {
  for (const appendToDraft of [false, true]) {
    await setup(page, 'SUPERVISED', {
      draft: 'Synthetic first note',
      text: 'Synthetic second note',
      appendToDraft,
      otherChatDraft: 'Other synthetic chat draft',
    });
    await start(page);
    expect(await result(page)).toMatchObject({ clicks: 0, steps: ['DRAFTED'] });
    await expect(page.locator('#other-composer')).toHaveText('Other synthetic chat draft');
    expect(await composerText(page)).toBe(
      appendToDraft ? 'Synthetic first note\nSynthetic second note' : 'Synthetic second note',
    );
  }
});
test('AUTO with appendToDraft fails without touching the pending draft', async ({ page }) => {
  await setup(page, 'AUTO', {
    draft: 'Synthetic first note',
    text: 'Synthetic second note',
    appendToDraft: true,
    autoCountdownMs: 0,
  });
  await start(page);
  await result(page);
  const state = await page.evaluate(() => window.__state);
  expect(state).toMatchObject({
    clicks: 0,
    steps: ['FAILED'],
    codes: ['DRAFT_PENDING_ON_TARGET'],
  });
  expect(state.steps).not.toContain('SENDING');
  expect(await composerText(page)).toBe('Synthetic first note');
});
