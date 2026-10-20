import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { openDatabase } from '../../packages/database/src/index.js';
import { buildApp } from '../../apps/local-api/src/app.js';
import { LocalApiClient } from '../../apps/mac-agent/src/api-client.js';
import { runNativeHost } from '../../apps/mac-agent/src/host.js';
import type { DialogueSyncJob } from '@wai-bridge/shared';
function frame(value: unknown) {
  const body = Buffer.from(JSON.stringify(value)),
    head = Buffer.alloc(4);
  head.writeUInt32LE(body.length);
  return Buffer.concat([head, body]);
}
function decode(buffer: Buffer) {
  const out: Array<{ id: string; type: string; result?: unknown }> = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const length = buffer.readUInt32LE(offset);
    if (offset + 4 + length > buffer.length) break;
    out.push(JSON.parse(buffer.subarray(offset + 4, offset + 4 + length).toString()));
    offset += 4 + length;
  }
  return out;
}
it('native protocol delivers ordered batch manifests, commits each snapshot then advances and signals cancellation under the same lease', async () => {
  const token = 'synthetic-batch-native-token-at-least-thirty-two-characters',
    extensionId = 'abcdefghijklmnopabcdefghijklmnop';
  const db = openDatabase(':memory:'),
    app = buildApp({ db, apiToken: token, logger: false }),
    accountId = randomUUID(),
    extensionInstanceId = randomUUID();
  const request = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload ? { payload } : {}),
    });
  const input = new PassThrough(),
    output = new PassThrough(),
    chunks: Buffer[] = [];
  output.on('data', (chunk) => chunks.push(chunk));
  let run: Promise<void> | undefined;
  try {
    const at = new Date().toISOString(),
      references = [];
    for (let i = 0; i < 3; i++) {
      const identity = {
        version: 1,
        type: 'UI_CONTEXT',
        source: 'VISIBLE_UI',
        accountId,
        contextId: randomUUID(),
        conversationKey: randomUUID(),
        conversationKind: 'INDIVIDUAL',
        confirmedAt: at,
      };
      const observationId = randomUUID(),
        label = `Synthetic batch ${i}`;
      expect(
        (
          await request('POST', '/api/observations', {
            extensionInstanceId,
            observation: {
              kind: 'CAPTURE_OBSERVATION',
              observationId,
              observedAt: at,
              observationType: 'CONVERSATION_ACTIVITY',
              captureState: 'DETECTED',
              conversation: { label, kind: 'INDIVIDUAL' },
              senderLabel: null,
              direction: 'UNKNOWN',
              content: null,
              contentAvailability: 'UNAVAILABLE',
              media: [],
              identity,
              activity: { unreadCount: 1, reason: 'INITIAL_UNREAD' },
            },
          })
        ).statusCode,
      ).toBe(202);
      const id = (
        db
          .prepare(
            'SELECT conversation_id id FROM wa_capture_normalizations WHERE observation_id=?',
          )
          .get(observationId) as { id: string }
      ).id;
      references.push({ id, label, identity });
    }
    const ids = references.map((r) => r.id),
      created = await request('POST', '/api/dialogue-sync-batches', {
        scope: 'SELECTED',
        conversationIds: ids,
        explicitAuthorization: true,
        idempotencyKey: randomUUID(),
      });
    expect(created.statusCode).toBe(202);
    const batchId = created.json().id;
    const api = new LocalApiClient(
      { extensionId, apiToken: token, apiOrigin: 'http://127.0.0.1:47831' },
      async (raw, init) => {
        const url = new URL(String(raw)),
          r = await app.inject({
            method: (init?.method ?? 'GET') as 'GET' | 'POST',
            url: url.pathname + url.search,
            headers: Object.fromEntries(new Headers(init?.headers).entries()),
            ...(init?.body ? { payload: String(init.body) } : {}),
          });
        return new Response(r.statusCode === 204 ? null : r.body, { status: r.statusCode });
      },
    );
    run = runNativeHost({
      input,
      output,
      stderr: new PassThrough(),
      callerOrigin: `chrome-extension://${extensionId}`,
      config: { extensionId, apiToken: token, apiOrigin: 'http://127.0.0.1:47831' },
      api,
    });
    input.write(frame({ version: 1, id: randomUUID(), type: 'HELLO', extensionInstanceId }));
    const exchange = async (type: string, payload: unknown) => {
      const id = randomUUID();
      input.write(frame({ version: 1, id, type, input: payload }));
      await vi.waitFor(() =>
        expect(decode(Buffer.concat(chunks)).some((r) => r.id === id)).toBe(true),
      );
      const response = decode(Buffer.concat(chunks)).find((r) => r.id === id)!;
      expect(response.type).toBe(type + '_RESULT');
      return response.result;
    };
    for (let i = 0; i < 2; i++) {
      const result = (await exchange('SYNC_POLL', {
        extensionInstanceId,
        accountId,
        ready: true,
      })) as { job: DialogueSyncJob };
      const job = result.job;
      expect(job.batch).toMatchObject({ id: batchId, position: i, total: 3, conversationIds: ids });
      const ref = references[i]!;
      const done = await exchange('SYNC_COMPLETE', {
        extensionInstanceId,
        requestId: job.id,
        leaseToken: job.leaseToken,
        identity: ref.identity,
        conversationLabel: ref.label,
        code: 'OK',
        truncated: false,
        observations: [
          {
            kind: 'CAPTURE_OBSERVATION',
            observationId: randomUUID(),
            observedAt: at,
            observationType: 'MESSAGE',
            captureState: 'CAPTURED',
            conversation: { label: ref.label, kind: 'INDIVIDUAL' },
            senderLabel: null,
            direction: 'INBOUND',
            content: `Synthetic item ${i}`,
            contentAvailability: 'AVAILABLE',
            media: [],
            identity: ref.identity,
            messageRef: { key: randomUUID(), revision: 1, firstObservedAt: at },
          },
        ],
      });
      expect(done).toMatchObject({ status: 'SUCCEEDED', persistedCount: 1 });
      expect(db.prepare('SELECT COUNT(*) n FROM wa_messages').get()).toEqual({ n: i + 1 });
    }
    const third = (
      (await exchange('SYNC_POLL', { extensionInstanceId, accountId, ready: true })) as {
        job: DialogueSyncJob;
      }
    ).job;
    expect(third.batch?.position).toBe(2);
    expect(
      (
        await request('POST', `/api/dialogue-sync-batches/${batchId}/cancel`, {
          explicitAuthorization: true,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      await exchange('SYNC_POLL', {
        extensionInstanceId,
        accountId,
        ready: false,
        activeRequestId: third.id,
        leaseToken: third.leaseToken,
      }),
    ).toMatchObject({ cancelRequestId: third.id, job: null });
    expect(
      (await request('GET', `/api/dialogue-sync-batches/${batchId}`)).json().batch,
    ).toMatchObject({ status: 'CANCELLED', succeeded: 2, cancelled: 1 });
    expect(db.prepare('SELECT COUNT(*) n FROM wa_outbox').get()).toEqual({ n: 0 });
  } finally {
    input.end();
    if (run) await run.catch(() => {});
    await app.close();
  }
});
