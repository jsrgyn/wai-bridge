import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { openDatabase } from '../../packages/database/src/index.js';
import { buildApp } from '../../apps/local-api/src/app.js';
import { LocalApiClient } from '../../apps/mac-agent/src/api-client.js';
import { runNativeHost } from '../../apps/mac-agent/src/host.js';

function frame(value: unknown) {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}
function decode(buffer: Buffer): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const n = buffer.readUInt32LE(offset);
    if (offset + 4 + n > buffer.length) break;
    rows.push(JSON.parse(buffer.subarray(offset + 4, offset + 4 + n).toString()));
    offset += 4 + n;
  }
  return rows;
}
it('routes a leased native synchronization through the API and commits before acknowledging', async () => {
  const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
  const extensionInstanceId = randomUUID();
  const accountId = randomUUID();
  const token = 'synthetic-sync-native-token-with-at-least-32-characters';
  const db = openDatabase(':memory:');
  const app = buildApp({ db, apiToken: token, logger: false });
  const request = async (method: 'POST' | 'GET', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload ? { payload } : {}),
    });
  const api = new LocalApiClient(
    { extensionId, apiToken: token, apiOrigin: 'http://127.0.0.1:47831' },
    async (input, init) => {
      const url = new URL(String(input));
      const response = await app.inject({
        method: (init?.method ?? 'GET') as 'POST' | 'GET',
        url: url.pathname,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        ...(init?.body ? { payload: String(init.body) } : {}),
      });
      return new Response(response.statusCode === 204 ? null : response.body, {
        status: response.statusCode,
      });
    },
  );
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on('data', (chunk) => chunks.push(chunk));
  let run: Promise<void> | undefined;
  try {
    const at = new Date().toISOString();
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
    const activityId = randomUUID();
    expect(
      (
        await request('POST', '/api/observations', {
          extensionInstanceId,
          observation: {
            kind: 'CAPTURE_OBSERVATION',
            observationId: activityId,
            observedAt: at,
            observationType: 'CONVERSATION_ACTIVITY',
            captureState: 'DETECTED',
            conversation: { label: 'Synthetic native target', kind: 'INDIVIDUAL' },
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
    const pending = (await request('GET', '/api/conversation-reviews')).json();
    expect(pending).toMatchObject({
      total: 1,
      items: [{ revision: 1, stage: 'WAITING_SYNC', unreadCountObserved: 1 }],
    });
    const reviewId = pending.items[0].conversationId;
    const created = await request('POST', '/api/dialogue-sync', {
      query: 'Synthetic native target',
      conversationId: reviewId,
      idempotencyKey: randomUUID(),
      limit: 50,
    });
    expect(created.statusCode).toBe(202);
    run = runNativeHost({
      input,
      output,
      stderr: new PassThrough(),
      callerOrigin: `chrome-extension://${extensionId}`,
      config: { extensionId, apiToken: token, apiOrigin: 'http://127.0.0.1:47831' },
      api,
    });
    input.write(frame({ version: 1, id: randomUUID(), type: 'HELLO', extensionInstanceId }));
    input.write(
      frame({
        version: 1,
        id: randomUUID(),
        type: 'SYNC_POLL',
        input: { extensionInstanceId: randomUUID(), accountId, ready: true },
      }),
    );
    input.write(
      frame({
        version: 1,
        id: randomUUID(),
        type: 'SYNC_POLL',
        input: { extensionInstanceId, accountId, ready: true },
      }),
    );
    await vi.waitFor(() =>
      expect(decode(Buffer.concat(chunks)).some((m) => m.type === 'SYNC_POLL_RESULT')).toBe(true),
    );
    const messages = decode(Buffer.concat(chunks));
    expect(messages.some((m) => m.type === 'ERROR' && m.code === 'INVALID_REQUEST')).toBe(true);
    const result = messages.find((m) => m.type === 'SYNC_POLL_RESULT')!.result as {
      job: { id: string; leaseToken: string };
    };
    const job = result.job;
    input.end(
      frame({
        version: 1,
        id: randomUUID(),
        type: 'SYNC_COMPLETE',
        input: {
          extensionInstanceId,
          requestId: job.id,
          leaseToken: job.leaseToken,
          identity,
          conversationLabel: 'Synthetic native target',
          code: 'OK',
          truncated: false,
          observations: [
            {
              kind: 'CAPTURE_OBSERVATION',
              observationId: randomUUID(),
              observedAt: at,
              observationType: 'MESSAGE',
              captureState: 'CAPTURED',
              conversation: { label: 'Synthetic native target', kind: 'INDIVIDUAL' },
              senderLabel: null,
              direction: 'OUTBOUND',
              content: 'Synthetic phone sync',
              contentAvailability: 'AVAILABLE',
              media: [],
              identity,
              messageRef: { key: randomUUID(), revision: 1, firstObservedAt: at },
            },
          ],
        },
      }),
    );
    await run;
    const completed = decode(Buffer.concat(chunks)).find((m) => m.type === 'SYNC_COMPLETE_RESULT')!
      .result as { status: string; conversationId: string };
    expect(completed.status).toBe('SUCCEEDED');
    expect(db.prepare('SELECT content FROM wa_messages').get()).toEqual({
      content: 'Synthetic phone sync',
    });
    const snapshot = await request('GET', `/api/dialogue-sync/${job.id}/messages`);
    expect(snapshot.json().items).toHaveLength(1);
    const review = (await request('GET', `/api/conversation-reviews/${reviewId}`)).json();
    expect(review).toMatchObject({
      stage: 'SYNCED_PARTIAL',
      revision: 1,
      verifiedRevision: 1,
      pending: true,
    });
    expect(
      (
        await request('POST', `/api/conversation-reviews/${reviewId}/ack`, {
          syncRequestId: job.id,
          revision: 1,
          explicitConfirmation: true,
        })
      ).json(),
    ).toMatchObject({ stage: 'READ_CONFIRMED', pending: false });
    expect(db.prepare('SELECT DISTINCT state FROM wa_ai_message_state').all()).toEqual([
      { state: 'UNREAD' },
    ]);
    expect(db.prepare('SELECT count(*) n FROM wa_outbox').get()).toEqual({ n: 0 });
  } finally {
    input.end();
    if (run) await run.catch(() => {});
    await app.close();
  }
});
