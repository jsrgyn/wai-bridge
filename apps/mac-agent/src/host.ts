import { randomUUID } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import { NativeMessageReader, writeNativeMessage } from './framing.js';
import { LocalApiClient } from './api-client.js';
import type { HostConfig } from './config.js';

export interface HostOptions {
  readonly input: Readable;
  readonly output: Writable;
  readonly stderr: Writable;
  readonly callerOrigin: string;
  readonly config: HostConfig;
  readonly api: LocalApiClient;
  readonly now?: () => Date;
  readonly heartbeatMs?: number;
}

export async function runNativeHost(options: HostOptions): Promise<void> {
  const expectedOrigin = `chrome-extension://${options.config.extensionId}`;
  if (options.callerOrigin !== expectedOrigin) {
    options.stderr.write('Rejected Native Messaging caller origin.\n');
    throw new Error('UNAUTHORIZED_EXTENSION_ORIGIN');
  }

  const hostInstanceId = randomUUID();
  let extensionInstanceId: string | undefined;
  let closed = false;
  const now = options.now ?? (() => new Date());
  const write = (message: Parameters<typeof writeNativeMessage>[1]) => writeNativeMessage(options.output, message);
  const reportState = async (status: 'CONNECTED' | 'DISCONNECTED') => {
    if (!extensionInstanceId) return;
    try {
      await options.api.recordExtensionState({ extensionInstanceId, status, lastSeenAt: now().toISOString() });
    } catch {
      options.stderr.write('Local API state update failed.\n');
    }
  };
  const timer = setInterval(() => {
    if (closed || !extensionInstanceId) return;
    void write({ version: 1, id: randomUUID(), type: 'HOST_STATE', connected: true, hostInstanceId, at: now().toISOString() })
      .catch(() => options.stderr.write('Native host heartbeat write failed.\n'));
  }, options.heartbeatMs ?? 25_000);
  timer.unref();

  try {
    for await (const request of new NativeMessageReader(options.input).readMessages()) {
      if (request.type === 'HELLO') {
        extensionInstanceId = request.extensionInstanceId;
        await reportState('CONNECTED');
        await write({ version: 1, id: request.id, type: 'HOST_STATE', connected: true, hostInstanceId, at: now().toISOString() });
      } else if (request.type === 'HEARTBEAT') {
        if (extensionInstanceId && extensionInstanceId !== request.extensionInstanceId) {
          await write({ version: 1, id: request.id, type: 'ERROR', code: 'INVALID_REQUEST', at: now().toISOString() });
          continue;
        }
        extensionInstanceId = request.extensionInstanceId;
        await reportState('CONNECTED');
        await write({ version: 1, id: request.id, type: 'HOST_STATE', connected: true, hostInstanceId, at: now().toISOString() });
      } else if (request.type === 'STATUS_REQUEST') {
        const available = await options.api.health();
        await write({ version: 1, id: request.id, type: 'STATUS_RESULT', api: available ? 'AVAILABLE' : 'UNAVAILABLE', at: now().toISOString() });
      } else if (request.type === 'CAPTURE_OBSERVATION') {
        if (!extensionInstanceId || request.extensionInstanceId !== extensionInstanceId) {
          await write({ version: 1, id: request.id, type: 'ERROR', code: 'INVALID_REQUEST', at: now().toISOString() });
          continue;
        }
        try {
          const result = await options.api.recordObservation({ extensionInstanceId, observation: request.observation });
          await write({ version: 1, id: request.id, type: 'CAPTURE_RESULT', ...result, at: now().toISOString() });
        } catch {
          options.stderr.write('Capture persistence failed.\n');
          await write({ version: 1, id: request.id, type: 'ERROR', code: 'API_UNAVAILABLE', at: now().toISOString() });
        }
      }
    }
  } finally {
    closed = true;
    clearInterval(timer);
    await reportState('DISCONNECTED');
  }
}
