import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { NativeMessageReader, writeNativeMessage } from '../src/framing.js';
import { runNativeHost } from '../src/host.js';
import type { HostConfig } from '../src/config.js';
import type { LocalApiClient } from '../src/api-client.js';

const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
const extensionInstanceId = '11111111-1111-4111-8111-111111111111';
const config: HostConfig = { extensionId, apiToken: '01234567890123456789012345678901', apiOrigin: 'http://127.0.0.1:47831' };

function frame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

function decodeFrames(buffer: Buffer): unknown[] {
  const messages: unknown[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const length = buffer.readUInt32LE(offset);
    messages.push(JSON.parse(buffer.subarray(offset + 4, offset + 4 + length).toString('utf8')) as unknown);
    offset += 4 + length;
  }
  return messages;
}

describe('Native Messaging framing', () => {
  it('reads fragmented and adjacent little-endian JSON frames', async () => {
    const input = new PassThrough();
    const request = { version: 1, id: randomUUID(), type: 'STATUS_REQUEST' };
    const bytes = frame(request);
    input.write(bytes.subarray(0, 3));
    input.end(bytes.subarray(3));
    const values = [];
    for await (const value of new NativeMessageReader(input).readMessages()) values.push(value);
    expect(values).toEqual([request]);
  });

  it('rejects invalid, truncated, and oversized frames', async () => {
    const invalid = new PassThrough();
    invalid.end(frame({ version: 1, type: 'RUN_SHELL', command: 'whoami' }));
    await expect(async () => {
      for await (const _message of new NativeMessageReader(invalid).readMessages()) void _message;
    }).rejects.toThrow('INVALID_REQUEST_SCHEMA');

    const truncated = new PassThrough();
    truncated.end(Buffer.from([8, 0, 0, 0, 123]));
    await expect(async () => {
      for await (const _message of new NativeMessageReader(truncated).readMessages()) void _message;
    }).rejects.toThrow('TRUNCATED_FRAME');

    const oversized = new PassThrough();
    const header = Buffer.alloc(4);
    header.writeUInt32LE(100);
    oversized.end(header);
    await expect(async () => {
      for await (const _message of new NativeMessageReader(oversized, 20).readMessages()) void _message;
    }).rejects.toThrow('INVALID_FRAME_LENGTH');
  });

  it('writes UTF-8 byte count with native little-endian framing', async () => {
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on('data', (chunk: Buffer) => chunks.push(chunk));
    const message = { version: 1, id: randomUUID(), type: 'ERROR', code: 'API_UNAVAILABLE', at: '2026-10-17T12:00:00.000Z' } as const;
    await writeNativeMessage(output, message);
    const bytes = Buffer.concat(chunks);
    expect(bytes.readUInt32LE(0)).toBe(bytes.length - 4);
    expect(JSON.parse(bytes.subarray(4).toString('utf8'))).toEqual(message);
  });
});

describe('native host authorization and lifecycle', () => {
  it('rejects a caller origin that is not the configured extension', async () => {
    const input = new PassThrough();
    input.end();
    await expect(runNativeHost({
      input,
      output: new PassThrough(),
      stderr: new PassThrough(),
      callerOrigin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      config,
      api: { health: vi.fn(), recordExtensionState: vi.fn() } as unknown as LocalApiClient,
    })).rejects.toThrow('UNAUTHORIZED_EXTENSION_ORIGIN');
  });

  it('handshakes, answers allowlisted commands, persists state, and recovers on a new process', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on('data', (chunk: Buffer) => chunks.push(chunk));
    const states: unknown[] = [];
    const api = { health: vi.fn().mockResolvedValue(false), recordExtensionState: vi.fn(async (state: unknown) => { states.push(state); }) } as unknown as LocalApiClient;
    const hello = { version: 1, id: randomUUID(), type: 'HELLO', extensionInstanceId };
    const status = { version: 1, id: randomUUID(), type: 'STATUS_REQUEST' };
    const heartbeat = { version: 1, id: randomUUID(), type: 'HEARTBEAT', extensionInstanceId };
    const run = runNativeHost({ input, output, stderr: new PassThrough(), callerOrigin: `chrome-extension://${extensionId}`, config, api, heartbeatMs: 60_000 });
    input.write(Buffer.concat([frame(hello), frame(status), frame(heartbeat), frame(heartbeat)]));
    input.end();
    await run;
    const replies = decodeFrames(Buffer.concat(chunks)) as Array<{ type: string; id: string; api?: string }>;
    expect(replies.map((item) => item.type)).toEqual(['HOST_STATE', 'STATUS_RESULT', 'HOST_STATE', 'HOST_STATE']);
    expect(replies[1]?.api).toBe('UNAVAILABLE');
    expect(states).toHaveLength(4);
    expect(states.at(-1)).toMatchObject({ extensionInstanceId, status: 'DISCONNECTED' });

    const reconnectInput = new PassThrough();
    const reconnectOutput = new PassThrough();
    const reconnectChunks: Buffer[] = [];
    reconnectOutput.on('data', (chunk: Buffer) => reconnectChunks.push(chunk));
    const reconnect = runNativeHost({ input: reconnectInput, output: reconnectOutput, stderr: new PassThrough(), callerOrigin: `chrome-extension://${extensionId}`, config, api, heartbeatMs: 60_000 });
    reconnectInput.end(frame({ version: 1, id: randomUUID(), type: 'HELLO', extensionInstanceId }));
    await reconnect;
    expect(decodeFrames(Buffer.concat(reconnectChunks))).toHaveLength(1);
  });

  it('forwards a validated observation and only acknowledges API persistence', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on('data', (chunk: Buffer) => chunks.push(chunk));
    const observation = {
      kind: 'CAPTURE_OBSERVATION', observationId: '77777777-7777-4777-8777-777777777777', observedAt: '2026-10-17T12:00:00.000Z',
      observationType: 'CONVERSATION_ACTIVITY', captureState: 'DETECTED',
      conversation: { label: 'Synthetic unopened chat', kind: 'UNKNOWN' }, senderLabel: null,
      direction: 'UNKNOWN', content: null, contentAvailability: 'UNAVAILABLE', media: [],
    };
    const api = {
      health: vi.fn(), recordExtensionState: vi.fn(),
      recordObservation: vi.fn().mockResolvedValue({ observationId: observation.observationId, eventId: '88888888-8888-4888-8888-888888888888', duplicate: false }),
    } as unknown as LocalApiClient;
    const run = runNativeHost({ input, output, stderr: new PassThrough(), callerOrigin: `chrome-extension://${extensionId}`, config, api });
    const capture = { version: 1, id: observation.observationId, type: 'CAPTURE_OBSERVATION', extensionInstanceId, observation };
    input.end(Buffer.concat([frame({ version: 1, id: randomUUID(), type: 'HELLO', extensionInstanceId }), frame(capture)]));
    await run;
    const replies = decodeFrames(Buffer.concat(chunks)) as Array<{ type: string; observationId?: string }>;
    expect(replies.map((item) => item.type)).toEqual(['HOST_STATE', 'CAPTURE_RESULT']);
    expect(replies[1]?.observationId).toBe(observation.observationId);
  });
});
