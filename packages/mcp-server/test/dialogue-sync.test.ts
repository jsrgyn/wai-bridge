import { randomUUID, createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import {
  openDatabase,
  DialogueSyncRepository,
  OutboxRepository,
  CommandRepository,
} from '../../database/src/index.js';
import { buildApp } from '../../../apps/local-api/src/app.js';
import { createMcpServer } from '../src/server.js';
import { LocalApiClient } from '../src/client.js';
import type { CaptureObservation, DialogueSyncJob } from '@wai-bridge/shared';

const token = 'synthetic-sync-token-with-at-least-32-characters';
const closeFns: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closeFns.splice(0)) await close();
});
async function setup(worker = false) {
  const db = openDatabase(':memory:');
  const app = buildApp({ db, apiToken: token, logger: false });
  const accountId = randomUUID();
  const extensionInstanceId = randomUUID();
  const identity = {
    version: 1 as const,
    type: 'UI_CONTEXT' as const,
    source: 'VISIBLE_UI' as const,
    accountId,
    contextId: randomUUID(),
    conversationKey: randomUUID(),
    conversationKind: 'INDIVIDUAL' as const,
    confirmedAt: new Date().toISOString(),
  };
  const request = async (method: string, url: string, payload?: unknown) =>
    app.inject({
      method: method as 'GET' | 'POST',
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload ? { payload } : {}),
    });
  const observation = (
    key = randomUUID(),
    revision = 1,
    direction: 'INBOUND' | 'OUTBOUND' = 'OUTBOUND',
  ): CaptureObservation => ({
    kind: 'CAPTURE_OBSERVATION',
    observationId: randomUUID(),
    observedAt: new Date().toISOString(),
    observationType: 'MESSAGE',
    captureState: 'CAPTURED',
    conversation: { label: 'Synthetic target', kind: 'INDIVIDUAL' },
    senderLabel: null,
    direction,
    content: 'Synthetic current message from phone',
    contentAvailability: 'AVAILABLE',
    media: [],
    identity,
    messageRef: { key, revision, firstObservedAt: identity.confirmedAt },
  });
  const completion = (job: DialogueSyncJob, observations = [observation()]) => ({
    extensionInstanceId,
    requestId: job.id,
    leaseToken: job.leaseToken,
    identity,
    conversationLabel: 'Synthetic target',
    code: 'OK',
    observations,
    truncated: false,
  });
  const api = new LocalApiClient({
    baseUrl: 'http://127.0.0.1:47831',
    token,
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      const response = await request(
        init?.method ?? 'GET',
        url.pathname + url.search,
        init?.body ? JSON.parse(String(init.body)) : undefined,
      );
      if (worker && url.pathname === '/api/dialogue-sync' && init?.method === 'POST') {
        const poll = await request('POST', '/api/extension/dialogue-sync/poll', {
          extensionInstanceId,
          accountId,
          ready: true,
        });
        const job = poll.json().job as DialogueSyncJob;
        if (job)
          expect(
            (
              await request(
                'POST',
                '/api/extension/dialogue-sync/complete',
                completion(job, [observation(), observation(randomUUID(), 1, 'INBOUND')]),
              )
            ).statusCode,
          ).toBe(200);
      }
      return new Response(response.body, { status: response.statusCode });
    },
  });
  const server = createMcpServer({ api });
  const client = new Client({ name: 'synthetic-sync-client', version: '1.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.server.connect(st)]);
  closeFns.push(async () => {
    api.closeLogs();
    await client.close();
    await server.close();
    await app.close();
  });
  const tool = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    expect(r.isError).not.toBe(true);
    return JSON.parse((r.content as Array<{ text: string }>)[0]!.text);
  };
  const create = async () => {
    const r = await request('POST', '/api/dialogue-sync', {
      query: 'Synthetic target',
      limit: 50,
      idempotencyKey: randomUUID(),
    });
    expect(r.statusCode).toBe(202);
    return r.json();
  };
  const claim = async () => {
    const r = await request('POST', '/api/extension/dialogue-sync/poll', {
      extensionInstanceId,
      accountId,
      ready: true,
    });
    expect(r.statusCode).toBe(200);
    return r.json().job as DialogueSyncJob;
  };
  return {
    db,
    app,
    api,
    request,
    accountId,
    extensionInstanceId,
    identity,
    observation,
    completion,
    tool,
    create,
    claim,
  };
}

describe('explicit rendered dialogue synchronization', () => {
  it('MCP reconciles through API and returns committed SQLite dialogue, without send opt-in or AI read ACK', async () => {
    const h = await setup(true);
    const result = await h.tool('whatsapp_sync_dialogue', { query: 'Synthetic target' });
    expect(result).toMatchObject({
      synchronized: true,
      sync: {
        status: 'SUCCEEDED',
        observedCount: 2,
        persistedCount: 2,
        scope: 'VISIBLE_RENDERED_ONLY',
        complete: false,
      },
    });
    expect(result.dialogue.messages.map((m: { direction: string }) => m.direction)).toEqual([
      'OUTBOUND',
      'INBOUND',
    ]);
    expect(result.dialogue.messages.every((m: { aiState: string }) => m.aiState === 'UNREAD')).toBe(
      true,
    );
    expect(h.db.prepare('SELECT count(*) n FROM wa_outbox').get()).toEqual({ n: 0 });
    expect(h.db.prepare('SELECT count(*) n FROM wa_messages').get()).toEqual({ n: 2 });
  });
  it('keeps pending explicit and never labels old cached dialogue as fresh', async () => {
    const h = await setup();
    const created = await h.create();
    const status = await h.tool('whatsapp_get_sync_status', { id: created.id });
    expect(status).toMatchObject({
      synchronized: false,
      dialogue: null,
      sync: { status: 'REQUESTED' },
    });
    const poll = await h.request('POST', '/api/extension/dialogue-sync/poll', {
      extensionInstanceId: h.extensionInstanceId,
      ready: false,
    });
    expect(poll.json()).toEqual({ pending: true, job: null });
  });
  it('validates leases/account/context, commits atomically and treats repeated completion idempotently', async () => {
    const h = await setup();
    await h.create();
    const job = await h.claim();
    const input = h.completion(job);
    expect(
      (
        await h.request('POST', '/api/extension/dialogue-sync/complete', {
          ...input,
          leaseToken: randomUUID(),
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await h.request('POST', '/api/extension/dialogue-sync/complete', {
          ...input,
          identity: { ...h.identity, accountId: randomUUID() },
        })
      ).statusCode,
    ).toBe(409);
    expect(h.db.prepare('SELECT count(*) n FROM wa_messages').get()).toEqual({ n: 0 });
    const foreign = h.observation();
    foreign.identity = { ...h.identity, conversationKey: randomUUID() };
    expect(
      (
        await h.request('POST', '/api/extension/dialogue-sync/complete', {
          ...input,
          observations: [h.observation(), foreign],
        })
      ).statusCode,
    ).toBe(409);
    expect(h.db.prepare('SELECT count(*) n FROM wa_capture_observations').get()).toEqual({ n: 0 });
    const success = await h.request('POST', '/api/extension/dialogue-sync/complete', input);
    expect(success.json()).toMatchObject({ status: 'SUCCEEDED', persistedCount: 1 });
    const again = await h.request('POST', '/api/extension/dialogue-sync/complete', input);
    expect(again.json()).toEqual(success.json());
    expect(h.db.prepare('SELECT count(*) n FROM wa_messages').get()).toEqual({ n: 1 });
    await h.create();
    const next = await h.claim();
    const updated = h.observation(input.observations[0]!.messageRef!.key, 2);
    updated.content = 'Synthetic edited current message';
    expect(
      (
        await h.request(
          'POST',
          '/api/extension/dialogue-sync/complete',
          h.completion(next, [updated]),
        )
      ).statusCode,
    ).toBe(200);
    expect(h.db.prepare('SELECT count(*) n FROM wa_messages').get()).toEqual({ n: 1 });
    expect(h.db.prepare('SELECT content FROM wa_messages').get()).toEqual({
      content: 'Synthetic edited current message',
    });
  });
  it('expires claimed jobs without replay and separates accounts/idempotency', async () => {
    const h = await setup();
    let now = Date.now();
    const repository = new DialogueSyncRepository(h.db, () => new Date(now).toISOString());
    const key = randomUUID();
    const input = { query: 'Synthetic target', accountId: h.accountId, idempotencyKey: key };
    const created = repository.create(input);
    expect(repository.create(input).id).toBe(created.id);
    expect(() => repository.create({ ...input, query: 'Synthetic other' })).toThrow(
      'IDEMPOTENCY_CONFLICT',
    );
    expect(
      repository.poll({
        extensionInstanceId: h.extensionInstanceId,
        accountId: randomUUID(),
        ready: true,
      }),
    ).toEqual({ pending: false, job: null });
    const job = repository.poll({
      extensionInstanceId: h.extensionInstanceId,
      accountId: h.accountId,
      ready: true,
    }).job!;
    now += 31000;
    expect(repository.get(created.id).status).toBe('EXPIRED');
    expect(() =>
      repository.complete(h.completion(job), () => {
        throw new Error('must not persist');
      }),
    ).toThrow('SYNC_EXPIRED');
  });
});

it('returns the persisted snapshot in UI order even when older rendered turns are imported after recent live captures', async () => {
  const h = await setup();
  const newer = h.observation();
  newer.content = 'Synthetic newer turn';
  expect(
    (
      await h.request('POST', '/api/observations', {
        extensionInstanceId: h.extensionInstanceId,
        observation: newer,
      })
    ).statusCode,
  ).toBe(202);
  await h.create();
  const job = await h.claim();
  const older = h.observation();
  older.content = 'Synthetic older rendered turn';
  const repeated = h.observation(newer.messageRef!.key, 2);
  repeated.content = newer.content;
  const result = await h.request(
    'POST',
    '/api/extension/dialogue-sync/complete',
    h.completion(job, [older, repeated]),
  );
  expect(result.statusCode).toBe(200);
  const response = await h.tool('whatsapp_get_sync_status', { id: job.id });
  expect(response.dialogue.orderBasis).toBe('VISIBLE_UI');
  expect(response.dialogue.messages.map((m: { content: string }) => m.content)).toEqual([
    older.content,
    newer.content,
  ]);
  expect(response.dialogue.messages.map((m: { sequence: number }) => m.sequence)).toEqual([2, 1]);
  expect(h.db.prepare('SELECT count(*) n FROM wa_messages').get()).toEqual({ n: 2 });
});

it('rolls back the entire snapshot when a later reference conflicts with a different persisted conversation', async () => {
  const h = await setup();
  const foreign = h.observation();
  foreign.identity = { ...h.identity, conversationKey: randomUUID() };
  expect(
    (
      await h.request('POST', '/api/observations', {
        extensionInstanceId: h.extensionInstanceId,
        observation: foreign,
      })
    ).statusCode,
  ).toBe(202);
  await h.create();
  const job = await h.claim();
  const colliding = h.observation(foreign.messageRef!.key, 2);
  const fresh = h.observation();
  expect(
    (
      await h.request(
        'POST',
        '/api/extension/dialogue-sync/complete',
        h.completion(job, [fresh, colliding]),
      )
    ).statusCode,
  ).toBe(409);
  expect(h.db.prepare('SELECT count(*) n FROM wa_messages').get()).toEqual({ n: 1 });
  expect(h.db.prepare('SELECT count(*) n FROM wa_capture_observations').get()).toEqual({ n: 1 });
  expect((await h.request('GET', `/api/dialogue-sync/${job.id}`)).json().status).toBe('CLAIMED');
});

it('serializes visible sync and sender interface leases in both directions', async () => {
  const h = await setup();
  await h.create();
  const job = await h.claim();
  const now = new Date().toISOString();
  const id = randomUUID();
  const payload = {
    recipientId: randomUUID(),
    text: 'Synthetic unsent',
    mode: 'SUPERVISED',
    explicitAuthorization: true,
  };
  new CommandRepository(h.db).create({
    id,
    kind: 'send',
    idempotencyScope: 'synthetic-sync-test',
    idempotencyKey: randomUUID(),
    status: 'QUEUED',
    payload,
    requestHash: createHash('sha256')
      .update(JSON.stringify({ kind: 'send', payload: JSON.stringify(payload) }))
      .digest('hex'),
    createdAt: now,
  });
  const outbox = new OutboxRepository(h.db);
  expect(outbox.acquireInterfaceLease('synthetic-worker', id, now, 30000)).toBe(false);
  const failure = await h.request('POST', '/api/extension/dialogue-sync/complete', {
    extensionInstanceId: h.extensionInstanceId,
    requestId: job.id,
    leaseToken: job.leaseToken,
    code: 'MONITOR_OFF',
    observations: [],
    truncated: false,
  });
  expect(failure.statusCode).toBe(200);
  expect(outbox.acquireInterfaceLease('synthetic-worker', id, now, 30000)).toBe(true);
  await h.create();
  expect(await h.claim()).toBe(null);
  outbox.releaseInterfaceLease('synthetic-worker', id);
  expect(await h.claim()).not.toBe(null);
});
