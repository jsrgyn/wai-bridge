import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const html = await readFile(resolve('dist/dashboard.html'), 'utf8');
const id = '11111111-1111-4111-8111-111111111111';
async function setup(page: Page, outdated = false) {
  await page.route('https://dashboard.test/**', (route) => {
    const name = new URL(route.request().url()).pathname.slice(1) || 'dashboard.html';
    return name === 'dashboard.html'
      ? route.fulfill({ body: html, contentType: 'text/html' })
      : route.fulfill({
          path: resolve('dist', name),
          contentType: name.endsWith('.js') ? 'application/javascript' : 'text/css',
        });
  });
  await page.addInitScript((outdated) => {
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
    const sendState = {
      timing: {
        autoCountdownMs: 5000,
        executionTimeoutMs: 60000,
        queueMaxWaitMs: 1800000 as number | null,
        sendVerifyMs: 15000,
      },
      items: [
        ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'CLAIMED', 'AUTO', 1, null, 0],
        ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', 'QUEUED', 'SUPERVISED', 2, null, 0],
        ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3', 'SENDING', 'AUTO', null, null, 1],
        ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4', 'FAILED', 'AUTO', null, 'TARGET_MISMATCH', 1],
      ].map(([itemId, status, mode, position, resultCode, attempts]) => ({
        id: itemId,
        status,
        mode,
        priority: 0,
        position,
        attempts,
        resultCode,
        createdAt: '2026-10-19T12:00:00.000Z',
        updatedAt: '2026-10-19T12:00:00.000Z',
      })),
    };
    const listeners: Array<(value: unknown) => void> = [];
    const port = {
      postMessage: (message: { requestId: string; input: Record<string, unknown> }) => {
        calls.push(message.input);
        const input = message.input;
        if (outdated && String(input.operation).startsWith('SEND_')) {
          listeners.forEach((listener) =>
            listener({ requestId: message.requestId, error: 'NOT_FOUND' }),
          );
          return;
        }
        let result: unknown;
        switch (input.operation) {
          case 'SUMMARY':
            result = {
              data: {
                batches: [{ id, status: 'PAUSED' }],
                coverageComplete: false,
                runtime: outdated
                  ? {
                      status: 'ok',
                      schemaVersion: 17,
                      extension: { bridge: 'API_OUTDATED', build: 'synthetic-build-1' },
                    }
                  : {
                      status: 'ok',
                      schemaVersion: 18,
                      sendProtocolVersion: 3,
                      extension: { bridge: 'READY', build: 'synthetic-build-1', compatible: true },
                    },
              },
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
          case 'SEND_SETTINGS_GET':
            result = sendState.timing;
            break;
          case 'SEND_SETTINGS_UPDATE':
            Object.assign(sendState.timing, input.input);
            result = sendState.timing;
            break;
          case 'SEND_QUEUE':
            result = {
              paused: true,
              pauseReason: 'WHATSAPP_NOT_READY',
              items: sendState.items,
            };
            break;
          case 'SEND_CANCEL': {
            const item = sendState.items.find((entry) => entry.id === input.id);
            if (item) {
              item.status = 'CANCELLED';
              item.position = null;
            }
            result = { status: 'CANCELLED' };
            break;
          }
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
    const scope = {
      containerPresent: true,
      visibleRowCount: 0,
      listitemCount: 0,
      rowCount: 4,
      gridcellCount: 0,
      headingCount: 0,
      cellFrameTitleCount: 0,
      ariaBusyCount: 1,
      testIds: ['synthetic-row'],
    };
    const report = {
      version: 1,
      capturedAt: '2026-10-26T12:00:00.000Z',
      searchInputPresent: true,
      newChatButtonPresent: false,
      scopes: { paneSide: scope, newChatDrawer: { ...scope, containerPresent: false } },
    };
    Object.assign(globalThis, {
      chrome: {
        runtime: {
          connect: () => port,
          sendMessage: async (raw: { kind: string }) => {
            calls.push(raw);
            return raw.kind === 'SEARCH_DIAGNOSE'
              ? { ok: true, report: { ...report, scopes: { ...report.scopes, paneSide: { ...scope, visibleRowCount: 7 } } } }
              : { ok: false };
          },
        },
        storage: {
          local: {
            get: async () => ({
              waiSearchDiagnostics: [
                { code: 'PHONE_CONTACT_NOT_FOUND', recordedAt: '2026-10-26T12:00:01.000Z', report },
              ],
            }),
          },
        },
      },
    });
  }, outdated);
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
type Calls = Array<Record<string, unknown>>;
const callsOf = (page: Page) =>
  page.evaluate(() => (globalThis as unknown as { dashboardCalls: Calls }).dashboardCalls);
test('saves timing and reloads persisted values', async ({ page }) => {
  await setup(page);
  await expect(page.locator('#send-timing [name=autoCountdownS]')).toHaveValue('5');
  await expect(page.locator('#send-timing [name=executionTimeoutS]')).toHaveValue('60');
  await expect(page.locator('#send-timing [name=queueMaxWaitMin]')).toHaveValue('30');
  await expect(page.locator('#send-timing [name=sendVerifyS]')).toHaveValue('15');
  await page.locator('#send-timing [name=autoCountdownS]').fill('0');
  await page.locator('#send-timing [name=executionTimeoutS]').fill('90');
  await page.locator('#send-timing [name=queueMaxWaitMin]').fill('45');
  await page.locator('#send-timing [name=sendVerifyS]').fill('20');
  await page.getByRole('button', { name: 'Salvar tempos' }).click();
  await expect(page.locator('#status')).toHaveText('Operação concluída.');
  expect((await callsOf(page)).filter((c) => c.operation === 'SEND_SETTINGS_UPDATE')).toEqual([
    {
      operation: 'SEND_SETTINGS_UPDATE',
      input: {
        autoCountdownMs: 0,
        executionTimeoutMs: 90000,
        queueMaxWaitMs: 2700000,
        sendVerifyMs: 20000,
      },
    },
  ]);
  await page.locator('#send-timing [name=queueUnlimited]').check();
  await expect(page.locator('#send-timing [name=queueMaxWaitMin]')).toBeDisabled();
  await page.getByRole('button', { name: 'Salvar tempos' }).click();
  await expect(page.locator('#status')).toHaveText('Operação concluída.');
  await page.getByRole('button', { name: 'Atualizar diagnóstico' }).click();
  await expect(page.locator('#status')).toHaveText('Operação concluída.');
  await expect(page.locator('#send-timing [name=autoCountdownS]')).toHaveValue('0');
  await expect(page.locator('#send-timing [name=executionTimeoutS]')).toHaveValue('90');
  await expect(page.locator('#send-timing [name=queueUnlimited]')).toBeChecked();
  await expect(page.locator('#send-timing [name=sendVerifyS]')).toHaveValue('20');
  const updates = (await callsOf(page)).filter((c) => c.operation === 'SEND_SETTINGS_UPDATE');
  expect(updates[1]).toMatchObject({ input: { queueMaxWaitMs: null } });
  await page.getByRole('button', { name: 'Restaurar padrão' }).click();
  await expect(page.locator('#send-timing [name=autoCountdownS]')).toHaveValue('5');
  await expect(page.locator('#send-timing [name=queueUnlimited]')).not.toBeChecked();
  await expect(page.locator('#send-timing [name=queueMaxWaitMin]')).toHaveValue('30');
});
test('rejects out-of-range input without request', async ({ page }) => {
  await setup(page);
  await page.locator('#send-timing [name=autoCountdownS]').fill('31');
  await page.locator('#send-timing [name=executionTimeoutS]').fill('19');
  await page.locator('#send-timing [name=queueMaxWaitMin]').fill('0');
  await page.locator('#send-timing [name=sendVerifyS]').fill('61');
  await page.getByRole('button', { name: 'Salvar tempos' }).click();
  for (const key of ['autoCountdownS', 'executionTimeoutS', 'queueMaxWaitMin', 'sendVerifyS'])
    await expect(page.locator(`[data-error-for=${key}]`)).not.toBeEmpty();
  await expect(page.locator('[data-error-for=autoCountdownS]')).toContainText('0 e 30');
  await expect(page.locator('#status')).toContainText('Verifique os campos');
  expect((await callsOf(page)).filter((c) => c.operation === 'SEND_SETTINGS_UPDATE')).toHaveLength(
    0,
  );
});
test('shows queue positions, paused banner and cancels a queued item', async ({ page }) => {
  await setup(page);
  await expect(page.locator('#send-paused')).toContainText('Fila pausada');
  await expect(page.locator('#send-paused')).toContainText('WHATSAPP_NOT_READY');
  const rows = page.locator('#send-queue .card');
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(1)).toContainText('#2');
  await expect(rows.nth(1)).toContainText('Supervisionado');
  await expect(rows.nth(1)).toContainText('Na fila');
  await expect(rows.nth(2)).toContainText('Em execução');
  await expect(rows.nth(3)).toContainText('Falhou');
  await expect(rows.nth(3)).toContainText('TARGET_MISMATCH');
  await expect(rows.nth(3)).toContainText('1 tentativa');
  await expect(rows.locator('button')).toHaveCount(2);
  await expect(rows.nth(2).locator('button')).toHaveCount(0);
  await rows.nth(1).getByRole('button', { name: 'Cancelar' }).click();
  await expect(rows.nth(1)).toContainText('Cancelado');
  await expect(rows.locator('button')).toHaveCount(1);
  expect((await callsOf(page)).filter((c) => c.operation === 'SEND_CANCEL')).toEqual([
    { operation: 'SEND_CANCEL', id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2' },
  ]);
});
test('404 on send ops shows outdated API banner and keeps other sections', async ({ page }) => {
  await setup(page, true);
  await expect(page.locator('#api-outdated')).toBeVisible();
  await expect(page.locator('#api-outdated')).toHaveText(
    'API local desatualizada: reinicie o serviço (scripts/restart-local-services.sh)',
  );
  await expect(page.locator('#diagnostics')).toContainText('Schema: 17');
  await expect(page.locator('#diagnostics')).toContainText(
    'Protocolo de envio da API: desconhecido',
  );
  await expect(page.locator('#diagnostics')).toContainText('Build da extensão: synthetic-build-1');
  await expect(page.locator('#diagnostics')).toContainText('API local desatualizada');
  await expect(page.locator('#batches button')).toHaveCount(1);
  await expect(page.locator('#maintenance')).toBeAttached();
  expect((await callsOf(page)).some((c) => c.operation === 'MAINTENANCE_GET')).toBe(true);
});
test('shows schema, send protocol and build when API is current', async ({ page }) => {
  await setup(page);
  await expect(page.locator('#api-outdated')).toBeHidden();
  await expect(page.locator('#diagnostics')).toContainText('Schema: 18');
  await expect(page.locator('#diagnostics')).toContainText('Protocolo de envio da API: 3');
  await expect(page.locator('#diagnostics')).toContainText('Compatível: sim');
});

test('shows stored search failure reports and runs a read-only structural diagnostic', async ({
  page,
}) => {
  await setup(page);
  const stored = page.locator('#search-diagnostics-list');
  await expect(stored).toContainText('PHONE_CONTACT_NOT_FOUND');
  await expect(stored).toContainText('"rowCount": 4');
  await page.click('#search-diagnose');
  await expect(page.locator('#search-diagnostics-result')).toContainText('"visibleRowCount": 7');
  const calls = await page.evaluate(
    () => (globalThis as unknown as { dashboardCalls: { kind?: string }[] }).dashboardCalls,
  );
  expect(calls.filter((call) => call.kind === 'SEARCH_DIAGNOSE')).toHaveLength(1);
});
