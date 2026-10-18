import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, CaptureObservationRepository } from '../../packages/database/src/index.js';
import { EventRepository } from '../../packages/events/src/index.js';
import { buildApp } from '../../apps/local-api/src/app.js';
import { LocalApiClient } from '../../apps/mac-agent/src/api-client.js';
import { runNativeHost } from '../../apps/mac-agent/src/host.js';
import type { FastifyInstance } from 'fastify';

const TOKEN = 'integration-test-token-0123456789abcdef';
const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
const extensionInstanceId = '11111111-1111-4111-8111-111111111111';
const apps: FastifyInstance[] = [];

function frame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

describe('synthetic extension-to-SQLite capture flow', () => {
  it.each([false, true])(
    'commits normalization before ACK, including optional group identity: %s',
    async (withIdentity) => {
      const db = openDatabase(':memory:');
      const app = buildApp({ db, apiToken: TOKEN, logger: false });
      apps.push(app);
      const client = new LocalApiClient(
        { extensionId, apiToken: TOKEN, apiOrigin: 'http://127.0.0.1:47831' },
        async (input, init) => {
          const url = new URL(String(input));
          const response = await app.inject({
            method: init?.method ?? 'GET',
            url: url.pathname,
            headers: init?.headers as Record<string, string> | undefined,
            payload: init?.body as string | undefined,
          });
          return new Response(response.statusCode === 204 ? null : response.body, {
            status: response.statusCode,
          });
        },
      );
      const input = new PassThrough();
      const output = new PassThrough();
      const chunks: Buffer[] = [];
      output.on('data', (chunk: Buffer) => chunks.push(chunk));
      const observationId = '22222222-2222-4222-8222-222222222222';
      const observation = {
        kind: 'CAPTURE_OBSERVATION',
        observationId,
        observedAt: '2026-10-17T12:00:00.000Z',
        observationType: 'MESSAGE',
        captureState: 'CAPTURED',
        conversation: { label: 'Synthetic group', kind: 'GROUP' },
        senderLabel: 'Synthetic member',
        direction: 'INBOUND',
        content: 'Synthetic new message',
        contentAvailability: 'AVAILABLE',
        media: ['IMAGE'],
        ...(withIdentity
          ? {
              identity: {
                version: 1,
                accountId: '33333333-3333-4333-8333-333333333333',
                contextId: '44444444-4444-4444-8444-444444444444',
                confirmedAt: '2026-10-17T11:59:00.000Z',
                type: 'GROUP_LOCAL',
                source: 'USER_GROUP',
                groupId: '55555555-5555-4555-8555-555555555555',
                groupLabel: 'Synthetic group',
              },
            }
          : {}),
      };
      const outgoing = {
        ...observation,
        observationId: randomUUID(),
        observedAt: '2026-10-17T12:01:00.000Z',
        direction: 'OUTBOUND',
        senderLabel: null,
        content: 'Synthetic manual reply',
      };
      const capture = {
        version: 1,
        id: randomUUID(),
        type: 'CAPTURE_OBSERVATION',
        extensionInstanceId,
        observation,
      };
      const run = runNativeHost({
        input,
        output,
        stderr: new PassThrough(),
        callerOrigin: `chrome-extension://${extensionId}`,
        config: { extensionId, apiToken: TOKEN, apiOrigin: 'http://127.0.0.1:47831' },
        api: client,
      });
      input.end(
        Buffer.concat([
          frame({ version: 1, id: randomUUID(), type: 'HELLO', extensionInstanceId }),
          frame(capture),
          frame({ ...capture, id: randomUUID() }),
          frame({ ...capture, id: randomUUID(), observation: outgoing }),
        ]),
      );
      await run;
      const responses: Array<{ type: string; duplicate?: boolean }> = [];
      const bytes = Buffer.concat(chunks);
      for (let offset = 0; offset < bytes.length;) {
        const length = bytes.readUInt32LE(offset);
        responses.push(
          JSON.parse(bytes.subarray(offset + 4, offset + 4 + length).toString('utf8')) as {
            type: string;
            duplicate?: boolean;
          },
        );
        offset += length + 4;
      }
      expect(responses.map((item) => item.type)).toEqual([
        'HOST_STATE',
        'CAPTURE_RESULT',
        'CAPTURE_RESULT',
        'CAPTURE_RESULT',
      ]);
      expect(responses[1]?.duplicate).toBe(false);
      expect(responses[2]?.duplicate).toBe(true);
      expect(new CaptureObservationRepository(db).get(observationId)?.content).toBe(
        'Synthetic new message',
      );
      expect(
        new EventRepository(db).listEvents().filter((event) => event.aggregateId === observationId),
      ).toHaveLength(1);
      expect(
        (
          db.prepare('SELECT COUNT(*) count FROM wa_capture_observations').get() as {
            count: number;
          }
        ).count,
      ).toBe(2);
      const messages = await app.inject({
        method: 'GET',
        url: '/api/messages/unread',
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(messages.json().items).toHaveLength(2);
      const inboundMessage = messages
        .json()
        .items.find((message: { direction: string }) => message.direction === 'INBOUND');
      const outboundMessage = messages
        .json()
        .items.find((message: { direction: string }) => message.direction === 'OUTBOUND');
      expect(outboundMessage).toMatchObject({
        content: outgoing.content,
        senderContactId: null,
        captureStatus: 'CAPTURED',
        aiState: 'UNREAD',
      });
      if (withIdentity) {
        expect(outboundMessage.conversationId).toBe(inboundMessage.conversationId);
        expect([inboundMessage.sequence, outboundMessage.sequence]).toEqual([1, 2]);
      } else expect(outboundMessage.conversationId).not.toBe(inboundMessage.conversationId);
      expect(inboundMessage).toMatchObject({
        content: observation.content,
        identityStatus: withIdentity ? 'PARTIAL' : 'UNKNOWN',
        sourceObservationId: observationId,
        aiState: 'UNREAD',
      });
      expect(
        new EventRepository(db)
          .listEvents()
          .filter((event) => event.aggregateType === 'message')
          .map((event) => event.aggregateId)
          .sort(),
      ).toEqual([inboundMessage.id, outboundMessage.id].sort());
    },
  );
});
