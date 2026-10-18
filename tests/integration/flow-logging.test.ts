import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { openDatabase, FlowLogRepository } from '../../packages/database/src/index.js';
import { buildApp } from '../../apps/local-api/src/app.js';
import { LocalApiClient } from '../../apps/mac-agent/src/api-client.js';
import { runNativeHost } from '../../apps/mac-agent/src/host.js';
import { makeFlowLog } from '../../packages/shared/src/index.js';
function frame(value: unknown) {
  const body = Buffer.from(JSON.stringify(value));
  const size = Buffer.alloc(4);
  size.writeUInt32LE(body.length);
  return Buffer.concat([size, body]);
}
it('persists extension diagnostic batches through the real native/API boundary without message content', async () => {
  const db = openDatabase(':memory:');
  const token = 'synthetic-flow-native-token-0123456789';
  const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
  const extensionInstanceId = randomUUID();
  const app = buildApp({ db, apiToken: token, logger: false });
  const api = new LocalApiClient(
    { extensionId, apiToken: token, apiOrigin: 'http://127.0.0.1:47831' },
    async (input, init) => {
      const url = new URL(String(input));
      const response = await app.inject({
        method: init?.method ?? 'GET',
        url: url.pathname,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        payload: init?.body as string | undefined,
      });
      return new Response(response.statusCode === 204 ? null : response.body, {
        status: response.statusCode,
      });
    },
  );
  const input = new PassThrough();
  const output = new PassThrough();
  const frames: Buffer[] = [];
  output.on('data', (chunk: Buffer) => frames.push(chunk));
  const traceId = randomUUID();
  const events = [
    makeFlowLog({
      traceId,
      resourceId: traceId,
      component: 'WHATSAPP_UI',
      phase: 'CAPTURE_OBSERVED',
      outcome: 'SUCCEEDED',
      code: 'OK',
    }),
    makeFlowLog({
      traceId,
      resourceId: traceId,
      component: 'EXTENSION_BACKGROUND',
      phase: 'CAPTURE_QUEUED',
      outcome: 'SUCCEEDED',
      code: 'QUEUED',
    }),
  ];
  try {
    const run = runNativeHost({
      input,
      output,
      stderr: new PassThrough(),
      callerOrigin: `chrome-extension://${extensionId}/`,
      config: { extensionId, apiToken: token, apiOrigin: 'http://127.0.0.1:47831' },
      api,
    });
    input.end(
      Buffer.concat([
        frame({ version: 1, id: randomUUID(), type: 'HELLO', extensionInstanceId }),
        frame({ version: 1, id: randomUUID(), type: 'FLOW_LOGS', extensionInstanceId, events }),
      ]),
    );
    await run;
    const page = new FlowLogRepository(db).list({ traceId });
    expect(page.items.map((e) => e.component)).toEqual(['WHATSAPP_UI', 'EXTENSION_BACKGROUND']);
    expect(Buffer.concat(frames).toString('utf8')).toContain('FLOW_LOGS_RESULT');
    expect(JSON.stringify(page)).not.toContain(token);
  } finally {
    await app.close();
  }
});
