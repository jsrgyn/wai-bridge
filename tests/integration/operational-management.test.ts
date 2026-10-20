import { it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase, MaintenanceService } from '../../packages/database/src/index.js';
import { buildApp } from '../../apps/local-api/src/app.js';
import { LocalApiClient } from '../../apps/mac-agent/src/api-client.js';
import { runNativeHost } from '../../apps/mac-agent/src/host.js';
it('carries confirmed management through Native→API→SQLite and verifies backup without direct extension database access', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wai-ops-integration-'));
  const db = openDatabase(join(dir, 'source.sqlite'));
  const maintenance = new MaintenanceService(db, join(dir, 'backups'));
  const token = 'synthetic-management-token-at-least-thirty-two-characters';
  const app = buildApp({ db, apiToken: token, logger: false, maintenance });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
  const config = { apiOrigin: address, apiToken: token, extensionId };
  const api = new LocalApiClient(config);
  const input = new PassThrough(),
    output = new PassThrough(),
    chunks: Buffer[] = [];
  output.on('data', (chunk: Buffer) => chunks.push(chunk));
  const instance = randomUUID(),
    accountId = randomUUID();
  const frame = (value: unknown) => {
    const body = Buffer.from(JSON.stringify(value)),
      header = Buffer.alloc(4);
    header.writeUInt32LE(body.length);
    return Buffer.concat([header, body]);
  };
  try {
    const run = runNativeHost({
      input,
      output,
      stderr: new PassThrough(),
      callerOrigin: `chrome-extension://${extensionId}`,
      config,
      api,
    });
    input.end(
      Buffer.concat([
        frame({ version: 1, id: randomUUID(), type: 'HELLO', extensionInstanceId: instance }),
        frame({
          version: 1,
          id: randomUUID(),
          type: 'MANAGEMENT',
          extensionInstanceId: instance,
          input: {
            operation: 'CONTACT_CREATE',
            input: {
              accountId,
              name: 'Synthetic person',
              nickname: 'Esposa',
              fullName: null,
              phone: '+5511999990001',
              relationships: ['esposa'],
              explicitConfirmation: true,
              idempotencyKey: randomUUID(),
            },
          },
        }),
        frame({
          version: 1,
          id: randomUUID(),
          type: 'MANAGEMENT',
          extensionInstanceId: instance,
          input: { operation: 'BACKUP_RUN', explicitConfirmation: true },
        }),
      ]),
    );
    await run;
    const buffer = Buffer.concat(chunks),
      replies: Array<{ type: string; result?: Record<string, unknown> }> = [];
    for (let offset = 0; offset < buffer.length;) {
      const length = buffer.readUInt32LE(offset);
      replies.push(JSON.parse(buffer.subarray(offset + 4, offset + 4 + length).toString()));
      offset += 4 + length;
    }
    expect(replies.filter((r) => r.type === 'MANAGEMENT_RESULT')).toHaveLength(2);
    expect(replies.some((r) => r.result?.status === 'VERIFIED')).toBe(true);
    expect(db.prepare('SELECT COUNT(*) n FROM wa_contact_catalog').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT phone_number FROM wa_contacts').get()).toEqual({
      phone_number: null,
    });
    expect(db.prepare('SELECT COUNT(*) n FROM wa_dialogue_sync_requests').get()).toEqual({ n: 0 });
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
