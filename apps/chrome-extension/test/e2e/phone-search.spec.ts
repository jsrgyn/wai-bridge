import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
const bundle = await build({
  stdin: {
    contents: `import {VisibleSendExecutor} from './src/commands/visible-send.ts';import {AutomaticContext} from './src/identity/automatic-context.ts';window.phoneClasses={VisibleSendExecutor,AutomaticContext};`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  target: 'chrome120',
});
const script = bundle.outputFiles[0]!.text;
import type { VisibleSendExecutor } from '../../src/commands/visible-send.js';
import type { AutomaticContext } from '../../src/identity/automatic-context.js';
declare global {
  interface Window {
    phoneClasses: {
      VisibleSendExecutor: typeof VisibleSendExecutor;
      AutomaticContext: typeof AutomaticContext;
    };
    phoneCase: {
      steps: string[];
      codes: string[];
      clicks: number;
      profileClicks: number;
      hiddenWrites: boolean;
      searches: string[];
      done: Promise<void>;
      run: () => void;
    };
  }
}

for (const scenario of [
  'match',
  'direct-number',
  'directory',
  'supervised',
  'supervised-hidden',
  'not-found',
  'profile-open',
  'profile-controls',
  'profile-edit',
  'hidden-start',
  'wrong-phone',
  'ambiguous',
  'draft',
  'wrong-account',
  'search-busy',
  'profile-change',
  'group',
  'user-interference',
] as const)
  test(`phone search ${scenario} verifies recipient before any synthetic send`, async ({
    page,
  }) => {
    await page.route('https://phone.test/**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<meta charset="utf-8"><input aria-label="Pesquisar ou começar uma nova conversa"/><div id="pane-side"><div role="row"><div data-testid="cell-frame-container"><span data-testid="cell-frame-title">Synthetic initial contact</span><span aria-selected="true"></span></div></div></div><main id="main" data-wai-conversation-type="INDIVIDUAL"><header><span data-testid="conversation-info-header-chat-title">Synthetic initial contact</span></header><section id="messages"></section><footer><div contenteditable="true" role="textbox" style="min-height:24px"></div><button aria-label="Enviar">Send synthetic</button></footer></main>`,
      }),
    );
    await page.goto('https://phone.test/');
    await page.addScriptTag({ content: script });
    await page.evaluate((scenario) => {
      const accountId = '11111111-1111-4111-8111-111111111111';
      const identity = new window.phoneClasses.AutomaticContext(accountId);
      const initial = identity.current()!;
      const state = (window.phoneCase = {
        steps: [] as string[],
        codes: [] as string[],
        clicks: 0,
        profileClicks: 0,
        hiddenWrites: false as boolean,
        searches: [] as string[],
        done: Promise.resolve(),
        run: () => {},
      });
      const input = document.querySelector('input')!;
      if (['profile-open', 'profile-controls', 'profile-edit'].includes(scenario)) {
        const drawer = document.createElement('aside');
        drawer.setAttribute('data-testid', 'chat-info-drawer');
        drawer.innerHTML =
          '<button aria-label="Fechar">Close synthetic</button><div data-testid="contact-info-header">Info</div><span>Synthetic initial contact</span><span>+12025550124</span>';
        if (scenario === 'profile-controls')
          drawer.insertAdjacentHTML(
            'beforeend',
            '<input type="checkbox" role="switch"/><input style="display:none"/><input type="search"/>',
          );
        if (scenario === 'profile-edit')
          drawer.insertAdjacentHTML(
            'beforeend',
            '<input aria-label="Edit name" value="Synthetic unsaved edit"/>',
          );
        drawer.querySelector('button')!.addEventListener('click', () => drawer.remove());
        document.body.append(drawer);
      }
      if (scenario === 'search-busy') input.value = 'Synthetic user search';
      if (scenario === 'draft')
        document.querySelector('[contenteditable]')!.textContent = 'Synthetic draft';
      const onSearch = (field: HTMLInputElement) => {
        const input = field;
        if (document.hidden) state.hiddenWrites = true;
        state.searches.push(input.value);
        if (!input.value) return;
        const list =
          input.closest('[data-testid="new-chat-drawer"]')?.querySelector('section') ??
          document.querySelector('#pane-side')!;
        list.replaceChildren();
        if (
          scenario === 'not-found' ||
          (scenario === 'directory' && !input.closest('[data-testid="new-chat-drawer"]'))
        )
          return;
        for (let i = 0; i < (scenario === 'ambiguous' ? 2 : 1); i++) {
          const row = document.createElement('div');
          row.setAttribute(
            'role',
            input.closest('[data-testid="new-chat-drawer"]') ? 'button' : 'row',
          );
          row.innerHTML =
            '<div data-testid="cell-frame-container"><span data-testid="cell-frame-title">Synthetic result</span><span aria-selected="false"></span></div>';
          row.querySelector('div')!.addEventListener('click', () => {
            input.closest('[data-testid="new-chat-drawer"]')?.remove();
            row.querySelector('[aria-selected]')!.setAttribute('aria-selected', 'true');
            document.querySelector(
              '[data-testid="conversation-info-header-chat-title"]',
            )!.textContent = 'Synthetic result';
            const profile = document.createElement('div');
            profile.setAttribute('role', 'button');
            profile.setAttribute('aria-label', 'Dados do perfil');
            profile.textContent = 'Synthetic profile';
            profile.addEventListener('click', () => {
              state.profileClicks++;
              const drawer = document.createElement('aside');
              drawer.setAttribute('data-testid', 'chat-info-drawer');
              drawer.innerHTML = `<div data-testid="${scenario === 'group' ? 'group-info-header' : 'contact-info-header'}">Info</div><span>Synthetic result</span><span id="resolved-phone"></span>`;
              drawer.querySelector('#resolved-phone')!.textContent =
                scenario === 'wrong-phone' ? '+12025550124' : '+1 (202) 555-0123';
              document.body.append(drawer);
            });
            document.querySelector('header')!.append(profile);
          });
          list.append(row);
        }
      };
      input.addEventListener('input', () => onSearch(input));
      if (scenario === 'directory' || scenario === 'not-found') {
        const newChat = document.createElement('button');
        newChat.setAttribute('aria-label', 'Nova conversa');
        newChat.textContent = 'New synthetic chat';
        newChat.addEventListener('click', () => {
          const drawer = document.createElement('aside');
          drawer.setAttribute('data-testid', 'new-chat-drawer');
          drawer.innerHTML =
            '<h2>Nova conversa</h2><input aria-label="Pesquisar nome, número ou @nomedeusuário"/><section></section>';
          document.body.append(drawer);
          const directoryInput = drawer.querySelector('input')!;
          directoryInput.addEventListener('input', () => onSearch(directoryInput));
        });
        document.body.append(newChat);
      }
      const executor = new window.phoneClasses.VisibleSendExecutor(
        identity,
        async (_command, step) => {
          if (
            ['WAITING_USER', 'WAITING_AUTO_SEND'].includes(step.step) &&
            (step.resolvedIdentity?.type !== 'UI_CONTEXT' ||
              step.resolvedIdentity.phone !== '+12025550123' ||
              step.conversationLabel !== 'Synthetic result')
          )
            throw new Error('SYNTHETIC_MISSING_PROFILE_PROOF');
          if (scenario === 'supervised-hidden' && step.step === 'WAITING_USER') {
            let hidden = true;
            Object.defineProperty(document, 'hidden', { get: () => hidden });
            setTimeout(() => {
              hidden = false;
            }, 400);
          }
          state.steps.push(step.step);
          state.codes.push(step.code);
          if (scenario === 'profile-change' && step.step === 'WAITING_AUTO_SEND')
            document.querySelector('#resolved-phone')!.textContent = '+12025550124';
        },
      );
      executor.setEnabled(true);
      document.querySelector('footer button')!.addEventListener('click', () => {
        if (!state.steps.includes('SENDING'))
          throw new Error('SYNTHETIC_SEND_BEFORE_DURABLE_SENDING');
        state.clicks++;
        const row = document.createElement('div');
        row.setAttribute('role', 'row');
        row.setAttribute('data-testid', 'conv-msg-phone-test');
        row.innerHTML =
          '<div style="display:flex;flex-direction:column;align-items:flex-end"><div data-testid="msg-container"><span class="selectable-text">Synthetic reply</span><span data-testid="msg-meta" aria-label="Entregue">12:00</span></div></div>';
        document.querySelector('#messages')!.append(row);
        document.querySelector('[contenteditable]')!.textContent = '';
      });
      state.run = () => {
        state.done = executor.execute({
          id: crypto.randomUUID(),
          ...(scenario === 'direct-number' ? {} : { conversationId: crypto.randomUUID() }),
          leaseToken: crypto.randomUUID(),
          contextId: initial.contextId,
          target: {
            accountId:
              scenario === 'wrong-account' ? '22222222-2222-4222-8222-222222222222' : accountId,
            type: 'UI_CONTEXT',
            referenceKey: '33333333-3333-4333-8333-333333333333',
          },
          locateByPhone: true,
          recipientPhone: '+12025550123',
          text: 'Synthetic reply',
          mode: scenario.startsWith('supervised') ? 'SUPERVISED' : 'AUTO',
          explicitAuthorization: true,
          leaseUntil: new Date(Date.now() + 180000).toISOString(),
        });
      };
      if (scenario === 'hidden-start') {
        let hidden = true;
        Object.defineProperty(document, 'hidden', { get: () => hidden });
        setTimeout(() => {
          hidden = false;
        }, 300);
      }
      state.run();
    }, scenario);
    if (scenario === 'user-interference')
      await page
        .getByRole('textbox', { name: 'Pesquisar ou começar uma nova conversa' })
        .fill('Synthetic user input');
    if (scenario.startsWith('supervised')) {
      await expect
        .poll(() => page.evaluate(() => window.phoneCase.steps))
        .toEqual(['WAITING_USER']);
      if (scenario === 'supervised-hidden')
        await expect.poll(() => page.evaluate(() => document.hidden)).toBe(false);
      expect(await page.evaluate(() => window.phoneCase.clicks)).toBe(0);
      await page.getByRole('button', { name: 'Enviar', exact: true }).click();
    }
    await page.evaluate(() => window.phoneCase.done);
    const state = await page.evaluate(() => ({
      steps: window.phoneCase.steps,
      codes: window.phoneCase.codes,
      clicks: window.phoneCase.clicks,
      searches: window.phoneCase.searches,
      profileClicks: window.phoneCase.profileClicks,
      hiddenWrites: window.phoneCase.hiddenWrites,
    }));
    if (
      [
        'match',
        'direct-number',
        'profile-open',
        'profile-controls',
        'hidden-start',
        'directory',
        'supervised',
        'supervised-hidden',
      ].includes(scenario)
    ) {
      expect(state.steps).toEqual([
        scenario.startsWith('supervised') ? 'WAITING_USER' : 'WAITING_AUTO_SEND',
        'SENDING',
        'SENT',
      ]);
      expect(state.hiddenWrites).toBe(false);
      expect(state.clicks).toBe(1);
      expect(state.profileClicks).toBe(1);
      expect(state.searches).toEqual(
        scenario === 'directory' ? ['+12025550123', '', '+12025550123'] : ['+12025550123', ''],
      );
    } else {
      expect(state.clicks).toBe(0);
      expect(state.steps).not.toContain('SENDING');
      expect(state.steps.at(-1)).toBe('FAILED');
      if (scenario === 'user-interference')
        await expect(
          page.getByRole('textbox', { name: 'Pesquisar ou começar uma nova conversa' }),
        ).toHaveValue('Synthetic user input');
      expect(state.codes.at(-1)).toBe(
        {
          'not-found': 'PHONE_CONTACT_NOT_FOUND',
          'profile-edit': 'PROFILE_HAS_INPUT',
          'wrong-phone': 'RECIPIENT_PHONE_MISMATCH',
          ambiguous: 'AMBIGUOUS_PHONE_RESULTS',
          draft: 'COMPOSER_HAS_DRAFT',
          'wrong-account': 'RECIPIENT_ACCOUNT_MISMATCH',
          'search-busy': 'SEARCH_HAS_INPUT',
          'profile-change': 'RECIPIENT_PHONE_MISMATCH',
          group: 'RECIPIENT_IS_GROUP',
          'user-interference': 'USER_INTERFERENCE',
        }[
          scenario as Exclude<
            typeof scenario,
            | 'match'
            | 'direct-number'
            | 'profile-open'
            | 'profile-controls'
            | 'hidden-start'
            | 'directory'
            | 'supervised'
            | 'supervised-hidden'
          >
        ],
      );
    }
  });
