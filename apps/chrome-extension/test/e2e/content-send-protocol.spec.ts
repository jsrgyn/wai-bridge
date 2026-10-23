import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';
type Reply = {
  ok?: boolean;
  accepted?: boolean;
  identity?: { accountId: string; contextId: string; conversationKey: string };
};
declare global {
  interface Window {
    protocolCase: {
      steps: string[];
      replies: Reply[];
      listener: (message: unknown, sender: unknown, reply: (value: Reply) => void) => unknown;
      clicks: number;
      logs: { phase: string; traceId: string; resourceId?: string }[];
    };
  }
}
test('content acknowledges acceptance immediately and aborts a supervised wait on cancellation without sending', async ({
  page,
}) => {
  await page.route('https://protocol.test/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<meta charset="utf-8"><main id="main" data-wai-conversation-type="INDIVIDUAL"><header><span data-testid="conversation-info-header-chat-title">Synthetic recipient</span></header><footer><div role="textbox" contenteditable="true" style="min-height:24px"></div><button aria-label="Enviar">Synthetic send</button></footer></main>',
    }),
  );
  await page.goto('https://protocol.test/');
  await page.evaluate(() => {
    window.protocolCase = { steps: [], replies: [], listener: () => {}, clicks: 0, logs: [] };
    (window as unknown as { chrome: unknown }).chrome = {
      runtime: {
        id: 'abcdefghijklmnopabcdefghijklmnop',
        onMessage: {
          addListener: (listener: Window['protocolCase']['listener']) => {
            window.protocolCase.listener = listener;
          },
        },
        sendMessage: async (raw: {
          kind: string;
          input?: { step: string };
          event?: { phase: string; traceId: string; resourceId?: string };
        }) => {
          if (raw.kind === 'GET_MONITOR_BOOT')
            return {
              ok: true,
              monitoring: true,
              accountId: '11111111-1111-4111-8111-111111111111',
            };
          if (raw.kind === 'FLOW_LOG' && raw.event) window.protocolCase.logs.push(raw.event);
          if (raw.kind === 'SEND_PROGRESS') window.protocolCase.steps.push(raw.input!.step);
          return { ok: true };
        },
      },
    };
    document
      .querySelector('footer button')!
      .addEventListener('click', () => window.protocolCase.clicks++);
  });
  await page.addScriptTag({ path: resolve(process.cwd(), 'dist/content-script.js') });
  const id = await page.evaluate(() => {
    const state = window.protocolCase;
    const sender = { id: 'abcdefghijklmnopabcdefghijklmnop' };
    let context: Reply = {};
    state.listener({ kind: 'SEND_CONTEXT', enabled: true }, sender, (reply) => {
      context = reply;
    });
    const identity = context.identity!;
    const id = crypto.randomUUID();
    state.listener(
      {
        kind: 'SEND_EXECUTE',
        command: {
          id,
          conversationId: crypto.randomUUID(),
          contextId: identity.contextId,
          leaseToken: crypto.randomUUID(),
          target: {
            accountId: identity.accountId,
            type: 'UI_CONTEXT',
            referenceKey: identity.conversationKey,
          },
          text: 'Synthetic supervised draft',
          mode: 'SUPERVISED',
          explicitAuthorization: true,
          leaseUntil: new Date(Date.now() + 180000).toISOString(),
          timing: {
            autoCountdownMs: 5000,
            executionTimeoutMs: 60000,
            queueMaxWaitMs: 1800000,
            sendVerifyMs: 15000,
          },
          appendToDraft: false,
        },
      },
      sender,
      (reply) => state.replies.push(reply),
    );
    return id;
  });
  expect(await page.evaluate(() => window.protocolCase.replies)).toEqual([
    { ok: true, accepted: true },
  ]);
  await expect.poll(() => page.evaluate(() => window.protocolCase.steps)).toEqual(['WAITING_USER']);
  await page.evaluate(
    (id) =>
      window.protocolCase.listener(
        { kind: 'SEND_CANCEL', commandId: id },
        { id: 'wrong-extension' },
        () => {},
      ),
    id,
  );
  expect(await page.evaluate(() => window.protocolCase.steps)).toEqual(['WAITING_USER']);
  await page.evaluate(
    (id) =>
      window.protocolCase.listener(
        { kind: 'SEND_CANCEL', commandId: id },
        { id: 'abcdefghijklmnopabcdefghijklmnop' },
        () => {},
      ),
    id,
  );
  await expect
    .poll(() => page.evaluate(() => window.protocolCase.steps))
    .toEqual(['WAITING_USER', 'CANCELLED']);
  expect(await page.evaluate(() => window.protocolCase.clicks)).toBe(0);
  const logs = await page.evaluate(() => window.protocolCase.logs);
  expect(logs).toContainEqual(
    expect.objectContaining({ resourceId: id, traceId: id, phase: 'CANCELLED' }),
  );
  expect(logs).toContainEqual(
    expect.objectContaining({ resourceId: id, phase: 'MESSAGE_COMPOSED' }),
  );
  expect(JSON.stringify(logs)).not.toContain('Synthetic supervised draft');
});
