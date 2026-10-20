import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const html = await readFile(resolve('dist/dashboard.html'), 'utf8');
const id = '11111111-1111-4111-8111-111111111111';
async function setup(page: Page) {
  await page.route('https://dashboard.test/**', (route) => {
    const name = new URL(route.request().url()).pathname.slice(1) || 'dashboard.html';
    return name === 'dashboard.html'
      ? route.fulfill({ body: html, contentType: 'text/html' })
      : route.fulfill({
          path: resolve('dist', name),
          contentType: name.endsWith('.js') ? 'application/javascript' : 'text/css',
        });
  });
  await page.addInitScript(() => {
    const calls: unknown[] = [];
    (globalThis as unknown as { dashboardCalls: unknown[] }).dashboardCalls = calls;
    const id = '11111111-1111-4111-8111-111111111111';
    const policy = {
      backupEnabled: true,
      intervalHours: 24,
      retentionDays: 30,
      maxBackupBytes: 536870912,
      minBackups: 3,
      pruneBackups: false,
      logRetentionDays: 7,
      pruneLogs: false,
    };
    const contact = {
      id,
      accountScope: `local-account:${id}`,
      name: '<img src=x onerror=alert(1)>',
      nickname: 'Synthetic alias',
      fullName: null,
      phone: null,
      relationships: ['esposa'],
      version: 1,
      phoneSource: 'UNKNOWN',
      registeredAt: '2026-10-19T12:00:00.000Z',
    };
    const listeners: Array<(value: unknown) => void> = [];
    const port = {
      postMessage: (message: { requestId: string; input: Record<string, unknown> }) => {
        calls.push(message.input);
        const input = message.input;
        let result: unknown;
        switch (input.operation) {
          case 'SUMMARY':
            result = {
              data: { batches: [{ id, status: 'PAUSED' }], coverageComplete: false },
              extension: { queue: { pending: 2 } },
            };
            break;
          case 'MAINTENANCE_GET':
            result = { policy, runs: [] };
            break;
          case 'CONTACTS':
            result = {
              items: [contact],
              total: 2,
              nextCursor: (input.query as Record<string, string>).cursor ? null : id,
            };
            break;
          case 'CONTACT_GET':
            result = contact;
            break;
          case 'CONTACT_UPDATE':
            result = { ...contact, ...(input.input as object), version: 2 };
            break;
          case 'CANDIDATES':
            result = {
              items: [
                {
                  leftId: id,
                  rightId: '22222222-2222-4222-8222-222222222222',
                  leftTitle: 'Synthetic A',
                  rightTitle: 'Synthetic B',
                  reason: 'NAME_MATCH',
                },
              ],
              nextCursor: null,
            };
            break;
          case 'BATCH_REPORT':
            result = { batch: { id, status: 'PAUSED' }, items: [], nextCursor: null };
            break;
          default:
            result = { status: 'accepted' };
        }
        listeners.forEach((listener) => listener({ requestId: message.requestId, result }));
      },
      onMessage: { addListener: (listener: (value: unknown) => void) => listeners.push(listener) },
      onDisconnect: { addListener: () => {} },
    };
    Object.assign(globalThis, { chrome: { runtime: { connect: () => port } } });
  });
  await page.goto('https://dashboard.test/');
  await expect(page.locator('#status')).toHaveText('Operação concluída.');
}
test('renders untrusted contact names as text, paginates SQLite results and requires review before linking', async ({
  page,
}) => {
  await setup(page);
  await page.locator('#search [name=query]').fill('Synthetic');
  await page.locator('#search button').click();
  await expect(page.locator('#contacts')).toContainText('<img src=x onerror=alert(1)>');
  expect(await page.locator('#contacts img').count()).toBe(0);
  await page.locator('#contacts-next').click();
  await expect(page.locator('#contacts-next')).toBeDisabled();
  await page.locator('#contacts button').click();
  await expect(page.locator('#contact [name=version]')).toHaveValue('1');
  await page.locator('#candidates-refresh').click();
  await page.getByRole('button', { name: 'Vincular referências' }).click();
  await expect(page.locator('#status')).toContainText('Confirme a revisão');
  await page.locator('#candidates input[type=checkbox]').check();
  await page.getByRole('button', { name: 'Vincular referências' }).click();
  const calls = await page.evaluate(
    () =>
      (globalThis as unknown as { dashboardCalls: Array<Record<string, unknown>> }).dashboardCalls,
  );
  expect(calls.filter((c) => c.operation === 'REFERENCE_DECIDE')).toHaveLength(1);
  expect(calls.filter((c) => c.operation === 'CONTACTS')[1]).toMatchObject({
    query: { cursor: id, query: 'Synthetic' },
  });
});
test('requires explicit batch and backup requests and rejects pruning without specific authorization', async ({
  page,
}) => {
  await setup(page);
  await page.locator('#batch-id').fill(id);
  await page.locator('#batch-cancel').click();
  await expect(page.locator('#status')).toContainText('Confirme o pedido');
  await page.locator('#batch-confirm').check();
  await page.locator('#batch-cancel').click();
  await expect(page.locator('#batch-confirm')).not.toBeChecked();
  await page.locator('#maintenance [name=pruneBackups]').check();
  await page.locator('#maintenance [name=confirmed]').check();
  await page.locator('#maintenance button').click();
  await expect(page.locator('#status')).toContainText('Verifique os campos');
  await page.locator('#backup-run').click();
  await expect(page.locator('#status')).toContainText('Confirme o pedido');
  await page.locator('#backup-confirm').check();
  await page.locator('#backup-run').click();
  await expect(page.locator('#status')).toHaveText('Operação concluída.');
  const calls = await page.evaluate(
    () =>
      (globalThis as unknown as { dashboardCalls: Array<Record<string, unknown>> }).dashboardCalls,
  );
  expect(calls.filter((c) => c.operation === 'BATCH_CANCEL')).toHaveLength(1);
  expect(calls.filter((c) => c.operation === 'MAINTENANCE_UPDATE')).toHaveLength(0);
  expect(calls.filter((c) => c.operation === 'BACKUP_RUN')).toHaveLength(1);
});
