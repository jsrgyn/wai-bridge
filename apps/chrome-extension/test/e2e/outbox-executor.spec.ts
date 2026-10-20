import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build, stop } from 'esbuild';
import { expect, test, type Page } from '@playwright/test';
import type {
  AutoSendController,
  CancellationController,
  OutboxCommandExecutor,
  SupervisedSendController,
  SyntheticConversationResolver,
  SyntheticMessageComposer,
  SyntheticRecipientVerifier,
  SyntheticSendResultVerifier,
} from '../../src/commands/outbox-executor.js';

const fixture = await readFile(
  resolve(process.cwd(), '../../tests/fixtures/whatsapp-simulator/index.html'),
  'utf8',
);
const bundle = await build({
  entryPoints: [resolve(process.cwd(), 'src/commands/outbox-executor.ts')],
  bundle: true,
  write: false,
  format: 'iife',
  globalName: 'WaiOutbox',
  platform: 'browser',
  target: 'chrome120',
});
stop();
async function setup(page: Page) {
  await page.setContent(
    fixture +
      `<section data-wai-conversation data-wai-conversation-label="Synthetic individual" data-wai-conversation-kind="INDIVIDUAL" data-wai-recipient-id="contact-1"><output data-wai-countdown></output><button data-wai-cancel-command="123e4567-e89b-42d3-a456-426614174000">Cancel</button><textarea data-wai-composer></textarea><button data-wai-send>Send</button><span data-wai-send-result></span></section><section data-wai-conversation data-wai-conversation-label="Synthetic group" data-wai-conversation-kind="GROUP" data-wai-recipient-id="group-1"><output data-wai-countdown></output><button data-wai-cancel-command="123e4567-e89b-42d3-a456-426614174000">Cancel</button><textarea data-wai-composer></textarea><button data-wai-send>Send</button><span data-wai-send-result></span></section>`,
  );
  await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
}
function command(
  mode: 'AUTO' | 'SUPERVISED' = 'SUPERVISED',
  kind: 'INDIVIDUAL' | 'GROUP' = 'INDIVIDUAL',
) {
  return {
    id: '123e4567-e89b-42d3-a456-426614174000',
    version: 1,
    mode,
    recipientId: kind === 'GROUP' ? 'group-1' : 'contact-1',
    recipientLabel: kind === 'GROUP' ? 'Synthetic group' : 'Synthetic individual',
    conversationKind: kind,
    text: 'Prepared synthetic message',
    explicitAuthorization: true,
    idempotencyKey: 't'.repeat(16),
  };
}
async function run(
  page: Page,
  input: ReturnType<typeof command>,
  opts: {
    enabled?: boolean;
    delayMs?: number;
    mutateOnTick?: boolean;
    claim?: boolean;
    cancelByUi?: boolean;
    disconnect?: boolean;
  } = {},
) {
  return page.evaluate(
    async ({ input, opts }) => {
      const api = (
        window as unknown as {
          WaiOutbox: {
            SyntheticConversationResolver: typeof SyntheticConversationResolver;
            SyntheticRecipientVerifier: typeof SyntheticRecipientVerifier;
            SyntheticMessageComposer: typeof SyntheticMessageComposer;
            SyntheticSendResultVerifier: typeof SyntheticSendResultVerifier;
            CancellationController: typeof CancellationController;
            AutoSendController: typeof AutoSendController;
            SupervisedSendController: typeof SupervisedSendController;
            OutboxCommandExecutor: typeof OutboxCommandExecutor;
          };
        }
      ).WaiOutbox;
      const updates: string[] = [];
      const countdowns: string[] = [];
      const claimed = new Set<string>();
      const persistence = {
        claim: async (id: string, key: string) => {
          if (opts.disconnect) throw new Error('AGENT_DISCONNECTED');
          if (opts.claim === false || claimed.has(`${id}:${key}`)) return false;
          claimed.add(`${id}:${key}`);
          return true;
        },
        update: async (_id: string, state: string) => {
          updates.push(state);
        },
      };
      const resolver = new api.SyntheticConversationResolver();
      const verifier = new api.SyntheticRecipientVerifier();
      const composer = new api.SyntheticMessageComposer();
      const resultVerifier = new api.SyntheticSendResultVerifier();
      const cancellation = new api.CancellationController();
      const settings = {
        autoEnabled: opts.enabled ?? false,
        composerEnabled: true,
        countdownMs: opts.delayMs ?? 0,
        countdownTick: () => {
          const target = document.querySelector<HTMLElement>('[data-wai-countdown]');
          if (target) countdowns.push(target.textContent ?? '');
          if (opts.mutateOnTick) {
            const item = document.querySelector<HTMLElement>(
              '[data-wai-conversation-label="Synthetic individual"]',
            );
            if (item) item.dataset.waiRecipientId = 'changed';
          }
          if (opts.delayMs && opts.delayMs > 500)
            setTimeout(() => {
              if (opts.cancelByUi)
                Array.from(document.querySelectorAll<HTMLElement>('[data-wai-cancel-command]'))
                  .find((button) => button.dataset.waiCancelCommand === input.id)
                  ?.click();
              else cancellation.cancel(input.id);
            }, 20);
        },
        delay: (ms: number, signal: AbortSignal) =>
          new Promise<void>((resolve, reject) => {
            if (signal.aborted) {
              reject(new Error('COMMAND_CANCELLED'));
              return;
            }
            const timer = setTimeout(resolve, ms);
            signal.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                reject(new Error('COMMAND_CANCELLED'));
              },
              { once: true },
            );
          }),
      };
      const auto = new api.AutoSendController(
        resolver,
        verifier,
        composer,
        resultVerifier,
        persistence,
        settings,
        cancellation,
      );
      const supervised = new api.SupervisedSendController(
        resolver,
        verifier,
        composer,
        resultVerifier,
        persistence,
        settings,
      );
      const executor = new api.OutboxCommandExecutor(auto, supervised, persistence);
      const outcome = await executor.execute(input);
      return {
        outcome,
        updates,
        countdowns,
        prepared:
          document.querySelector<HTMLTextAreaElement>(
            `[data-wai-recipient-id="${input.recipientId}"] [data-wai-composer]`,
          )?.value ?? '',
        sent: document.querySelectorAll('[data-wai-send-result="SENT"]').length,
      };
    },
    { input, opts },
  );
}

test('prepares the uniquely verified individual conversation for supervised handoff', async ({
  page,
}) => {
  await setup(page);
  const result = await run(page, command());
  expect(result).toMatchObject({
    outcome: 'WAITING_USER',
    updates: ['CLAIMED', 'COMPOSED', 'WAITING_USER'],
    prepared: 'Prepared synthetic message',
    sent: 0,
  });
});
test('resolves a group independently from an individual conversation', async ({ page }) => {
  await setup(page);
  const result = await run(page, command('SUPERVISED', 'GROUP'));
  expect(result.outcome).toBe('WAITING_USER');
  expect(result.prepared).toBe('Prepared synthetic message');
});
test('rejects an incorrect recipient before preparing text', async ({ page }) => {
  await setup(page);
  const input = command();
  input.recipientId = 'wrong';
  const result = await run(page, input);
  expect(result.outcome).toBe('FAILED');
  expect(result.updates).toContain('FAILED');
  expect(result.prepared).toBe('');
});
test('AUTO counts down visibly and marks sent only when simulator evidence matches command', async ({
  page,
}) => {
  await setup(page);
  await page
    .locator('[data-wai-conversation-label="Synthetic individual"] [data-wai-send]')
    .evaluate((node) =>
      node.addEventListener('click', () => {
        const section = node.closest<HTMLElement>('[data-wai-conversation]')!;
        const marker = section.querySelector<HTMLElement>('[data-wai-send-result]')!;
        marker.dataset.waiSendResult = 'SENT';
        marker.dataset.waiCommandId = '123e4567-e89b-42d3-a456-426614174000';
      }),
    );
  const result = await run(page, command('AUTO'), { enabled: true, delayMs: 120 });
  expect(result.outcome).toBe('SENT');
  expect(result.updates).toContain('SENDING');
  expect(result.countdowns).toContain('1');
  expect(result.sent).toBe(1);
});
test('does not send without AUTO enablement or explicit authorization', async ({ page }) => {
  await setup(page);
  const disabled = await run(page, command('AUTO'));
  expect(disabled.outcome).toBe('FAILED');
  expect(disabled.sent).toBe(0);
  const unauthorized = command('AUTO');
  unauthorized.explicitAuthorization = false;
  const denied = await run(page, unauthorized, { enabled: true });
  expect(denied.outcome).toBe('FAILED');
  expect(denied.sent).toBe(0);
});
test('cancels the countdown before clicking send', async ({ page }) => {
  await setup(page);
  const result = await run(page, command('AUTO'), {
    enabled: true,
    delayMs: 1000,
    cancelByUi: true,
  });
  expect(result.outcome).toBe('CANCELLED');
  expect(result.sent).toBe(0);
});
test('rechecks conversation identity after a conversation change during countdown', async ({
  page,
}) => {
  await setup(page);
  const result = await run(page, command('AUTO'), { enabled: true, mutateOnTick: true });
  expect(result.outcome).toBe('FAILED');
  expect(result.updates).toContain('FAILED');
  expect(result.sent).toBe(0);
});
test('does not execute a duplicate idempotency claim', async ({ page }) => {
  await setup(page);
  const result = await run(page, command(), { claim: false });
  expect(result.outcome).toBe('DUPLICATE');
  expect(result.updates).toEqual([]);
});
test('records UNKNOWN when send lacks verifiable evidence and rejects invalid command version', async ({
  page,
}) => {
  await setup(page);
  await page
    .locator('[data-wai-conversation-label="Synthetic individual"] [data-wai-send]')
    .evaluate((node) =>
      node.addEventListener('click', () => {
        node
          .closest('[data-wai-conversation]')
          ?.querySelector('[data-wai-send-result]')
          ?.setAttribute('data-wai-send-result', 'PENDING');
      }),
    );
  const result = await run(page, command('AUTO'), { enabled: true });
  expect(result.outcome).toBe('UNKNOWN');
  expect(result.sent).toBe(0);
  const invalid = command();
  (invalid as { version: number }).version = 2;
  await expect(run(page, invalid)).rejects.toThrow();
});

test('does not process a command when the agent is disconnected before claim', async ({ page }) => {
  await setup(page);
  await expect(run(page, command(), { disconnect: true })).rejects.toThrow('AGENT_DISCONNECTED');
  expect(await page.locator('[data-wai-composer]').first().inputValue()).toBe('');
});
test('fails safely when the page composer interface has changed', async ({ page }) => {
  await setup(page);
  await page
    .locator('[data-wai-conversation-label="Synthetic individual"] [data-wai-composer]')
    .evaluate((node) => node.remove());
  const result = await run(page, command());
  expect(result.outcome).toBe('FAILED');
  expect(result.sent).toBe(0);
});
