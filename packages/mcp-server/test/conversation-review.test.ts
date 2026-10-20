import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import {
  openDatabase,
  ConversationReviewRepository,
  applyMigrations,
  migrations,
} from '../../database/src/index.js';
import { buildApp } from '../../../apps/local-api/src/app.js';
import { LocalApiClient } from '../src/client.js';
import { createMcpServer } from '../src/server.js';
import type { CaptureObservation, DialogueSyncJob } from '@wai-bridge/shared';

const token = 'synthetic-review-token-at-least-32-characters';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
async function setup() {
  const db = openDatabase(':memory:');
  const app = buildApp({ db, apiToken: token, logger: false });
  const accountId = randomUUID(),
    extensionInstanceId = randomUUID();
  const identity = {
    version: 1 as const,
    type: 'UI_CONTEXT' as const,
    source: 'VISIBLE_UI' as const,
    accountId,
    contextId: randomUUID(),
    conversationKey: randomUUID(),
    conversationKind: 'INDIVIDUAL' as const,
    confirmedAt: '2026-10-19T12:00:00.000Z',
  };
  const request = (method: 'GET' | 'POST', url: string, payload?: unknown, authorized = true) =>
    app.inject({
      method,
      url,
      headers: authorized ? { authorization: `Bearer ${token}` } : {},
      ...(payload ? { payload } : {}),
    });
  const observation = (
    type: 'MESSAGE' | 'CONVERSATION_ACTIVITY' = 'CONVERSATION_ACTIVITY',
  ): CaptureObservation => ({
    kind: 'CAPTURE_OBSERVATION',
    observationId: randomUUID(),
    observedAt: '2026-10-19T12:01:00.000Z',
    observationType: type,
    captureState: type === 'MESSAGE' ? 'CAPTURED' : 'DETECTED',
    conversation: { label: 'Synthetic person', kind: 'INDIVIDUAL' },
    senderLabel: null,
    direction: type === 'MESSAGE' ? 'INBOUND' : 'UNKNOWN',
    content: type === 'MESSAGE' ? 'Synthetic body' : null,
    contentAvailability: type === 'MESSAGE' ? 'AVAILABLE' : 'UNAVAILABLE',
    media: [],
    identity,
    ...(type === 'MESSAGE'
      ? {
          messageRef: {
            key: randomUUID(),
            revision: 1,
            firstObservedAt: '2026-10-19T12:01:00.000Z',
          },
        }
      : { activity: { unreadCount: 2, reason: 'ROW_CHANGED' as const } }),
  });
  const record = async (o = observation()) => {
    const response = await request('POST', '/api/observations', {
      extensionInstanceId,
      observation: o,
    });
    expect(response.statusCode).toBe(202);
    return (
      db
        .prepare('SELECT conversation_id id FROM wa_capture_normalizations WHERE observation_id=?')
        .get(o.observationId) as { id: string }
    ).id;
  };
  const reviews = new ConversationReviewRepository(db);
  const create = async (id: string) => {
    const result = await request('POST', '/api/dialogue-sync', {
      query: 'Synthetic person',
      conversationId: id,
      idempotencyKey: randomUUID(),
    });
    expect(result.statusCode).toBe(202);
    return result.json();
  };
  const claim = async () => {
    const r = await request('POST', '/api/extension/dialogue-sync/poll', {
      accountId,
      extensionInstanceId,
      ready: true,
    });
    expect(r.statusCode).toBe(200);
    return r.json().job as DialogueSyncJob;
  };
  const complete = (job: DialogueSyncJob, extra: Record<string, unknown> = {}) =>
    request('POST', '/api/extension/dialogue-sync/complete', {
      extensionInstanceId,
      requestId: job.id,
      leaseToken: job.leaseToken,
      identity,
      conversationLabel: 'Synthetic person',
      code: 'OK',
      truncated: false,
      observations: [observation('MESSAGE')],
      ...extra,
    });
  const api = new LocalApiClient({
    baseUrl: 'http://127.0.0.1:47831',
    token,
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      const r = await request(
        init?.method === 'POST' ? 'POST' : 'GET',
        url.pathname + url.search,
        init?.body ? JSON.parse(String(init.body)) : undefined,
      );
      return new Response(r.body, { status: r.statusCode });
    },
  });
  const server = createMcpServer({ api });
  const client = new Client({ name: 'synthetic-review-client', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.server.connect(st)]);
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).not.toBe(true);
    return JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
  };
  cleanup.push(async () => {
    api.closeLogs();
    await client.close();
    await server.close();
    await app.close();
  });
  return {
    db,
    app,
    request,
    identity,
    accountId,
    extensionInstanceId,
    observation,
    record,
    reviews,
    create,
    claim,
    complete,
    tool,
    client,
  };
}

describe('persistent review queue and deliberate reading', () => {
  it('lists metadata without navigation/jobs/read ACK and deduplicates transport replay', async () => {
    const h = await setup();
    const o = h.observation();
    const id = await h.record(o);
    await h.record(o);
    const result = await h.tool('whatsapp_list_pending_conversations');
    expect(result).toMatchObject({
      total: 1,
      nextCursor: null,
      complete: false,
      items: [
        {
          conversationId: id,
          stage: 'WAITING_SYNC',
          signalCount: 1,
          revision: 1,
          unreadCountObserved: 2,
          pending: true,
        },
      ],
    });
    expect(h.db.prepare('SELECT count(*) n FROM wa_messages').get()).toEqual({ n: 0 });
    expect(h.db.prepare('SELECT count(*) n FROM wa_dialogue_sync_requests').get()).toEqual({
      n: 0,
    });
    expect(h.db.prepare('SELECT count(*) n FROM wa_outbox').get()).toEqual({ n: 0 });
  });
  it('tracks all stages and requires explicit current snapshot ACK, independently of message AI state', async () => {
    const h = await setup();
    const id = await h.record();
    const created = await h.create(id);
    expect(h.reviews.get(id).stage).toBe('SYNC_REQUESTED');
    const job = await h.claim();
    expect(h.reviews.get(id).stage).toBe('SYNCING');
    const completion = await h.complete(job);
    expect(completion.statusCode).toBe(200);
    expect(h.reviews.get(id)).toMatchObject({
      stage: 'SYNCED_PARTIAL',
      pending: true,
      revision: 1,
      verifiedRevision: 1,
    });
    const args = {
      conversationId: id,
      syncRequestId: created.id,
      revision: 1,
      explicitConfirmation: true,
    };
    const ack = await h.tool('whatsapp_confirm_conversation_read', args);
    expect(ack).toMatchObject({ stage: 'READ_CONFIRMED', pending: false, acknowledgedRevision: 1 });
    const stableAck = { ...ack };
    delete stableAck.requestTraceId;
    expect(await h.tool('whatsapp_confirm_conversation_read', args)).toMatchObject(stableAck);
    expect((await h.tool('whatsapp_list_pending_conversations')).total).toBe(0);
    expect(h.db.prepare('SELECT DISTINCT state FROM wa_ai_message_state').all()).toEqual([
      { state: 'UNREAD' },
    ]);
    await h.record();
    expect(h.reviews.get(id)).toMatchObject({ stage: 'WAITING_SYNC', pending: true, revision: 2 });
    expect((await h.request('POST', `/api/conversation-reviews/${id}/ack`, args)).statusCode).toBe(
      400,
    ); // body must not include routing UUID
    expect(
      (
        await h.request('POST', `/api/conversation-reviews/${id}/ack`, {
          syncRequestId: created.id,
          revision: 1,
          explicitConfirmation: true,
        })
      ).statusCode,
    ).toBe(409);
  });
  it('does not clear signals arriving after claim, including same timestamps', async () => {
    const h = await setup();
    const id = await h.record();
    await h.create(id);
    const job = await h.claim();
    await h.record();
    expect((await h.complete(job)).statusCode).toBe(200);
    expect(h.reviews.get(id)).toMatchObject({
      stage: 'WAITING_SYNC',
      revision: 2,
      verifiedRevision: 1,
      pending: true,
    });
    expect(
      (
        await h.request('POST', `/api/conversation-reviews/${id}/ack`, {
          syncRequestId: job.id,
          revision: 2,
          explicitConfirmation: true,
        })
      ).statusCode,
    ).toBe(409);
  });
  it('includes signals before claim in the snapshot watermark and rejects concurrent target jobs', async () => {
    const h = await setup();
    const id = await h.record();
    await h.create(id);
    await h.record();
    const duplicate = await h.request('POST', '/api/dialogue-sync', {
      query: 'Synthetic person',
      conversationId: id,
      idempotencyKey: randomUUID(),
    });
    expect(duplicate.statusCode).toBe(409);
    const job = await h.claim();
    await h.complete(job);
    expect(h.reviews.get(id)).toMatchObject({
      stage: 'SYNCED_PARTIAL',
      revision: 2,
      verifiedRevision: 2,
    });
  });
  it('preserves failures and expirations without automatically repeating navigation', async () => {
    const h = await setup();
    const id = await h.record();
    await h.create(id);
    let job = await h.claim();
    expect(
      (
        await h.complete(job, {
          code: 'COMPOSER_HAS_DRAFT',
          observations: [],
          identity: undefined,
          conversationLabel: undefined,
        })
      ).statusCode,
    ).toBe(200);
    expect(h.reviews.get(id)).toMatchObject({
      stage: 'SYNC_FAILED',
      lastError: 'COMPOSER_HAS_DRAFT',
      pending: true,
    });
    await h.create(id);
    job = await h.claim();
    h.db
      .prepare(
        "UPDATE wa_dialogue_sync_requests SET expires_at='2020-01-01T00:00:00.000Z' WHERE id=?",
      )
      .run(job.id);
    expect(h.reviews.get(id)).toMatchObject({
      stage: 'SYNC_EXPIRED',
      lastError: 'TIMEOUT',
      pending: true,
    });
    expect(await h.claim()).toBe(null);
  });
  it('blocks target/account mismatch and rolls back incompatible homonym snapshots', async () => {
    const h = await setup();
    const id = await h.record();
    expect(
      (
        await h.request('POST', '/api/dialogue-sync', {
          query: 'Other name',
          conversationId: id,
          idempotencyKey: randomUUID(),
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await h.request('POST', '/api/dialogue-sync', {
          query: 'Synthetic person',
          conversationId: id,
          accountId: randomUUID(),
          idempotencyKey: randomUUID(),
        })
      ).statusCode,
    ).toBe(409);
    await h.create(id);
    const job = await h.claim();
    const foreign = { ...h.identity, conversationKey: randomUUID() };
    const observation = { ...h.observation('MESSAGE'), identity: foreign };
    expect(
      (await h.complete(job, { identity: foreign, observations: [observation] })).statusCode,
    ).toBe(409);
    expect(h.db.prepare('SELECT count(*) n FROM wa_conversations').get()).toEqual({ n: 1 });
    expect(h.db.prepare('SELECT count(*) n FROM wa_messages').get()).toEqual({ n: 0 });
    expect(h.reviews.get(id).stage).toBe('SYNCING');
  });
  it('isolates homonyms and supports explicit compatible links without merging histories or granting sends', async () => {
    const h = await setup();
    const left = await h.record();
    const other = h.observation();
    other.identity = { ...h.identity, conversationKey: randomUUID() };
    const right = await h.record(other);
    expect(h.reviews.get(left).relatedConversationIds).toEqual([]);
    const link = await h.tool('whatsapp_link_conversation_references', {
      conversationId: left,
      relatedConversationId: right,
      explicitConfirmation: true,
    });
    expect(link).toMatchObject({ linked: true, historiesMerged: false });
    expect(h.reviews.get(left).relatedConversationIds).toEqual([right]);
    expect(h.reviews.get(right).relatedConversationIds).toEqual([left]);
    expect(h.reviews.list({}).total).toBe(2);
    expect(h.db.prepare('SELECT count(*) n FROM wa_conversations').get()).toEqual({ n: 2 });
    await h.create(left);
    const job = await h.claim();
    expect(
      (
        await h.complete(job, {
          identity: other.identity,
          observations: [{ ...h.observation('MESSAGE'), identity: other.identity }],
        })
      ).statusCode,
    ).toBe(200);
    expect(h.reviews.get(left).stage).toBe('SYNCED_PARTIAL');
    expect(h.reviews.get(right).stage).toBe('WAITING_SYNC');
    const foreign = h.observation();
    foreign.identity = { ...h.identity, accountId: randomUUID() };
    const foreignId = await h.record(foreign);
    expect(
      (
        await h.request('POST', `/api/conversation-reviews/${left}/links`, {
          relatedConversationId: foreignId,
          explicitConfirmation: true,
        })
      ).statusCode,
    ).toBe(409);
    expect(h.db.prepare('SELECT count(*) n FROM wa_outbox').get()).toEqual({ n: 0 });
  });
  it('relates identical proven phones, rejects contradictory identity and permits bound sync across references with proof', async () => {
    const h = await setup();
    const a = h.observation();
    a.identity = { ...h.identity, phone: '+5511999990001' };
    const id = await h.record(a);
    const b = h.observation();
    b.identity = { ...h.identity, conversationKey: randomUUID(), phone: '+5511999990001' };
    const other = await h.record(b);
    expect(h.reviews.get(id).relatedConversationIds).toEqual([other]);
    await h.create(id);
    const job = await h.claim();
    const message = { ...h.observation('MESSAGE'), identity: b.identity };
    expect(
      (await h.complete(job, { identity: b.identity, observations: [message] })).statusCode,
    ).toBe(200);
    expect(h.reviews.get(id).stage).toBe('SYNCED_PARTIAL');
    expect(h.reviews.get(other).stage).toBe('WAITING_SYNC');
    const c = h.observation();
    c.identity = { ...h.identity, conversationKey: randomUUID(), phone: '+5511999990002' };
    const conflict = await h.record(c);
    expect(
      (
        await h.request('POST', `/api/conversation-reviews/${id}/links`, {
          relatedConversationId: conflict,
          explicitConfirmation: true,
        })
      ).statusCode,
    ).toBe(409);
  });
  it('binds a deliberate unique named request to the queue and preserves idempotent routing after a rename', async () => {
    const h = await setup();
    const id = await h.record();
    const key = randomUUID();
    const payload = { query: 'Synthetic person', idempotencyKey: key };
    const created = await h.request('POST', '/api/dialogue-sync', payload);
    expect(created.statusCode).toBe(202);
    expect(h.reviews.get(id).stage).toBe('SYNC_REQUESTED');
    h.db.prepare('UPDATE wa_conversations SET title=? WHERE id=?').run('Synthetic renamed', id);
    expect((await h.request('POST', '/api/dialogue-sync', payload)).json().id).toBe(
      created.json().id,
    );
    const job = await h.claim();
    expect((await h.complete(job)).statusCode).toBe(200);
    expect(h.reviews.get(id)).toMatchObject({
      stage: 'SYNCED_PARTIAL',
      verifiedRevision: 1,
      pending: true,
    });
  });

  it('paginates every pending reference with exact total and filters without removing rows', async () => {
    const h = await setup();
    for (let i = 0; i < 4; i++) {
      const o = h.observation();
      o.identity = { ...h.identity, conversationKey: randomUUID() };
      await h.record(o);
    }
    const first = await h.tool('whatsapp_list_pending_conversations', { limit: 2 });
    expect(first.total).toBe(4);
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await h.tool('whatsapp_list_pending_conversations', {
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(second.total).toBe(4);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((i) => i.conversationId)).size).toBe(4);
    expect(h.reviews.list({ accountId: randomUUID() }).total).toBe(0);
    expect(h.reviews.list({ stage: 'SYNCED_PARTIAL' }).total).toBe(0);
    expect(h.reviews.list({ query: 'not present' }).total).toBe(0);
    expect(h.reviews.list({ query: '%' }).total).toBe(0);
  });
  it('keeps unread UI metadata independent of review confirmation and does not reopen on a decrease alone', async () => {
    const h = await setup();
    const id = await h.record();
    await h.create(id);
    const job = await h.claim();
    await h.complete(job);
    h.reviews.acknowledge(id, { syncRequestId: job.id, revision: 1, explicitConfirmation: true });
    const decreased = h.observation();
    decreased.activity = { unreadCount: null, reason: 'UNREAD_DECREASED' };
    await h.record(decreased);
    expect(h.reviews.get(id)).toMatchObject({
      stage: 'READ_CONFIRMED',
      revision: 1,
      unreadCountObserved: null,
      pending: false,
    });
  });
  it('queues incoming messages and semantic updates but not own outgoing messages or old revision replay', async () => {
    const h = await setup();
    const out = h.observation('MESSAGE');
    out.direction = 'OUTBOUND';
    await h.record(out);
    expect(h.reviews.list({}).total).toBe(0);
    const incoming = h.observation('MESSAGE');
    const id = await h.record(incoming);
    const edit = {
      ...incoming,
      observationId: randomUUID(),
      content: 'Synthetic edited',
      messageRef: { ...incoming.messageRef!, revision: 2 },
    };
    await h.record(edit);
    await h.record(incoming);
    expect(h.reviews.get(id)).toMatchObject({ revision: 2, signalCount: 2 });
  });
  it('enforces authentication, strict contracts, explicit confirmations and UUIDs', async () => {
    const h = await setup();
    const id = await h.record();
    expect((await h.request('GET', '/api/conversation-reviews', undefined, false)).statusCode).toBe(
      401,
    );
    expect((await h.request('GET', '/api/conversation-reviews?limit=101')).statusCode).toBe(400);
    expect((await h.request('GET', '/api/conversation-reviews?pendingOnly=maybe')).statusCode).toBe(
      400,
    );
    expect((await h.request('GET', '/api/conversation-reviews/not-a-uuid')).statusCode).toBe(400);
    expect((await h.request('GET', `/api/conversation-reviews/${randomUUID()}`)).statusCode).toBe(
      404,
    );
    expect(
      (
        await h.request('POST', `/api/conversation-reviews/${id}/ack`, {
          syncRequestId: randomUUID(),
          revision: 1,
          explicitConfirmation: false,
        })
      ).statusCode,
    ).toBe(400);
    const invalid = h.observation('MESSAGE');
    invalid.activity = { unreadCount: 2, reason: 'ROW_CHANGED' };
    expect(
      (
        await h.request('POST', '/api/observations', {
          extensionInstanceId: h.extensionInstanceId,
          observation: invalid,
        })
      ).statusCode,
    ).toBe(400);
  });
});

it('migration14 preserves checksums/data and reconstructs only conservative review signals, persistent across reopen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wai-review-'));
  const path = join(dir, 'synthetic.sqlite');
  try {
    let db = openDatabase(path, { migrate: false });
    applyMigrations(db, migrations.slice(0, 13));
    const before = db
      .prepare('SELECT version,checksum FROM wa_schema_migrations ORDER BY version')
      .all();
    const id = randomUUID(),
      obs = randomUUID();
    db.prepare(
      "INSERT INTO wa_conversations(id,connector,account_scope,kind,title,created_at,updated_at) VALUES(?,'synthetic','synthetic','UNKNOWN','Synthetic person',?,?)",
    ).run(id, '2026-10-19T12:00:00.000Z', '2026-10-19T12:00:00.000Z');
    db.prepare(
      "INSERT INTO wa_capture_observations(id,extension_instance_id,observation_type,capture_state,observed_at,payload_json) VALUES(?,?,'CONVERSATION_ACTIVITY','DETECTED',?,'{}')",
    ).run(obs, randomUUID(), '2026-10-19T12:00:00.000Z');
    db.prepare(
      "INSERT INTO wa_capture_normalizations(observation_id,conversation_id,status) VALUES(?,?,'CONVERSATION_ONLY')",
    ).run(obs, id);
    applyMigrations(db);
    expect(
      db
        .prepare(
          'SELECT version,checksum FROM wa_schema_migrations WHERE version<=13 ORDER BY version',
        )
        .all(),
    ).toEqual(before);
    expect(new ConversationReviewRepository(db).get(id)).toMatchObject({
      revision: 1,
      pending: true,
      stage: 'WAITING_SYNC',
      unreadCountObserved: null,
    });
    db.close();
    db = openDatabase(path);
    expect(new ConversationReviewRepository(db).list({}).total).toBe(1);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
