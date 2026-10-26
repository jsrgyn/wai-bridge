import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { openDatabase } from '../../packages/database/src/index.js';
import { buildApp } from '../../apps/local-api/src/app.js';
import { LocalApiClient } from '../../apps/mac-agent/src/api-client.js';
import { runNativeHost } from '../../apps/mac-agent/src/host.js';
import {
  NativeResponseSchema,
  type NativeRequest,
  type NativeResponse,
} from '../../packages/shared/src/index.js';

const scenarios = ['current', 'search', 'number'] as const;
it.each(
  scenarios.flatMap((scenario) => (['AUTO', 'SUPERVISED'] as const).map((mode) => [scenario, mode] as const)),
)('native host delivers a scoped command (%s, %s) and persists execution/result', async (scenario, mode) => {
  const auto = mode === 'AUTO';
  const locateByPhone=scenario!=='current';
  const direct=scenario==='number';
  const token = 'synthetic-native-send-token-0123456789';
  const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
  const db = openDatabase(':memory:');
  const app = buildApp({ db, apiToken: token, logger: false });
  const extensionInstanceId = randomUUID();
  const identity = {
    version: 1 as const,
    accountId: randomUUID(),
    contextId: randomUUID(),
    confirmedAt: new Date().toISOString(),
    type: 'PHONE' as const,
    source: 'PROFILE_PHONE' as const,
    phone: '+12025550123',
  };
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const observedAt = new Date().toISOString();
  await app.inject({
    method: 'POST',
    url: '/api/observations',
    headers,
    payload: {
      extensionInstanceId,
      observation: {
        kind: 'CAPTURE_OBSERVATION',
        observationId: randomUUID(),
        observationType: 'MESSAGE',
        observedAt,
        captureState: 'CAPTURED',
        conversation: { label: 'Synthetic contact', kind: 'INDIVIDUAL' },
        senderLabel: null,
        direction: 'INBOUND',
        content: 'Synthetic hello',
        contentAvailability: 'AVAILABLE',
        media: [],
        identity,
      },
    },
  });
  const list = await app.inject({ method: 'GET', url: '/api/conversations', headers });
  const conversationId = list.json().items[0].id;
  if(direct)await app.inject({method:'POST',url:'/api/extension/outbox/poll',headers,payload:{extensionInstanceId,identity,allowClaim:true,protocolVersion:3}});
  const created = await app.inject({
    method: 'POST',
    url: direct?'/api/extension/outbox/phone':'/api/extension/outbox',
    headers: { ...headers, 'idempotency-key': 'synthetic-send-key-0001' },
    payload: {
      ...(direct?{phoneNumber:'+12025550199'}:{conversationId}),
      text: 'Synthetic manual reply',
      mode,
      explicitAuthorization: true,
      ...(auto ? { timing: { autoCountdownMs: 0 } } : {}),
      ...(!direct&&locateByPhone?{locateByPhone:true}:{}),
    },
  });
  expect(created.statusCode).toBe(202);
  const api = new LocalApiClient(
    { extensionId, apiToken: token, apiOrigin: 'http://127.0.0.1:47831' },
    async (input, init) => {
      const url = new URL(String(input));
      const response = await app.inject({
        method: init?.method ?? 'GET',
        url: url.pathname + url.search,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        payload: init?.body as string | undefined,
      });
      return new Response(response.body, { status: response.statusCode });
    },
  );
  const input = new PassThrough();
  const output = new PassThrough();
  let bytes = Buffer.alloc(0);
  const responses = new Map<string, (response: NativeResponse) => void>();
  output.on('data', (chunk: Buffer) => {
    bytes = Buffer.concat([bytes, chunk]);
    while (bytes.length >= 4) {
      const length = bytes.readUInt32LE(0);
      if (bytes.length < length + 4) break;
      const response = NativeResponseSchema.parse(
        JSON.parse(bytes.subarray(4, 4 + length).toString()),
      );
      bytes = bytes.subarray(4 + length);
      responses.get(response.id)?.(response);
      responses.delete(response.id);
    }
  });
  const running = runNativeHost({
    input,
    output,
    stderr: new PassThrough(),
    callerOrigin: `chrome-extension://${extensionId}/`,
    config: { extensionId, apiToken: token, apiOrigin: 'http://127.0.0.1:47831' },
    api,
  });
  const send = (raw: Omit<NativeRequest, 'version' | 'id'>): Promise<NativeResponse> =>
    new Promise((resolve) => {
      const id = randomUUID();
      responses.set(id, resolve);
      const body = Buffer.from(JSON.stringify({ ...raw, version: 1, id }));
      const header = Buffer.alloc(4);
      header.writeUInt32LE(body.length);
      input.write(Buffer.concat([header, body]));
    });
  try {
    await send({ type: 'HELLO', extensionInstanceId } as Omit<NativeRequest, 'version' | 'id'>);
    const wrong = await send({
      type: 'SEND_POLL',
      input: { extensionInstanceId: randomUUID(), identity },
    } as Omit<NativeRequest, 'version' | 'id'>);
    expect(wrong.type).toBe('ERROR');
    const pollIdentity=locateByPhone?{...identity,phone:'+12025550124',contextId:randomUUID()}:identity;
    const response = await send({
      type: 'SEND_POLL',
      input: { extensionInstanceId, identity:pollIdentity, protocolVersion: 3 },
    } as Omit<NativeRequest, 'version' | 'id'>);
    expect(response.type).toBe('SEND_POLL_RESULT');
    if (response.type !== 'SEND_POLL_RESULT' || !response.result.command)
      throw new Error('No command');
    const command = response.result.command;
    if(direct)expect(command.conversationId).toBeUndefined();
    if(locateByPhone)expect(command).toMatchObject({locateByPhone:true,recipientPhone:direct?'+12025550199':identity.phone});
    expect(command).toMatchObject({
      id: created.json().id,
      contextId: pollIdentity.contextId,
      mode,
      appendToDraft: false,
    });
    if (auto) expect(command.timing.autoCountdownMs).toBe(0);
    const progress = (step: 'WAITING_USER' | 'WAITING_AUTO_SEND' | 'SENDING' | 'SENT' | 'DRAFTED') =>
      send({
        type: 'SEND_PROGRESS',
        input: {
          extensionInstanceId,
          commandId: command.id,
          contextId: command.contextId,
          leaseToken: command.leaseToken,
          step,
          code: 'SYNTHETIC_NATIVE_STEP',
          ...(locateByPhone && step !== 'SENDING' && step !== 'SENT' ? {resolvedIdentity:{...identity,phone:command.recipientPhone!,contextId:randomUUID()},conversationLabel:'Synthetic resolved contact'} : {}),
          ...(step === 'SENT' ? { evidence: `visible-outbound:${'b'.repeat(64)}` } : {}),
        },
      } as Omit<NativeRequest, 'version' | 'id'>);
    // The legacy supervised hand-off is no longer accepted for new requests.
    expect((await progress('WAITING_USER')).type).toBe('ERROR');
    expect(
      db.prepare('SELECT status FROM wa_outbox WHERE id=?').get(command.id),
    ).toEqual({ status: 'CLAIMED' });
    for (const step of auto ? (['WAITING_AUTO_SEND', 'SENDING', 'SENT'] as const) : (['DRAFTED'] as const)) {
      const result = await progress(step);
      expect(result).toMatchObject({
        type: 'SEND_PROGRESS_RESULT',
        result: { ok: true, status: step },
      });
    }
    const persisted = await app.inject({
      method: 'GET',
      url: `/api/outbox/${command.id}`,
      headers,
    });
    expect(persisted.json().command.status).toBe(auto ? 'SENT' : 'DRAFTED');
    // Terminal steps release the single interface lease so the next request can run.
    expect(db.prepare('SELECT COUNT(*) n FROM wa_outbox_interface_lease').get()).toEqual({ n: 0 });
    expect(persisted.json().command.lease_owner).toBeUndefined();
    expect(JSON.stringify(persisted.json().history)).not.toContain(command.leaseToken);
    const replay = await send({
      type: 'SEND_POLL',
      input: { extensionInstanceId, identity },
    } as Omit<NativeRequest, 'version' | 'id'>);
    expect(replay).toMatchObject({ type: 'SEND_POLL_RESULT', result: { command: null } });
    expect(db.prepare('SELECT COUNT(*) n FROM wa_outbox').get()).toEqual({ n: 1 });
  } finally {
    input.end();
    await running;
    await app.close();
  }
});
