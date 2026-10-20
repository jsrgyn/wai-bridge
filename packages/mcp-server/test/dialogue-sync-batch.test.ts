import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { openDatabase, DialogueSyncBatchRepository } from '../../database/src/index.js';
import { buildApp } from '../../../apps/local-api/src/app.js';
import { LocalApiClient } from '../src/client.js';
import { createMcpServer } from '../src/server.js';
import type { CaptureObservation, DialogueSyncJob } from '@wai-bridge/shared';
const token = 'synthetic-batch-token-at-least-thirty-two-characters';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
async function setup() {
  const db = openDatabase(':memory:'),
    app = buildApp({ db, apiToken: token, logger: false }),
    accountId = randomUUID(),
    extensionInstanceId = randomUUID();
  const request = (method: 'GET' | 'POST', url: string, payload?: unknown, auth = true) =>
    app.inject({
      method,
      url,
      headers: auth ? { authorization: `Bearer ${token}` } : {},
      ...(payload ? { payload } : {}),
    });
  const identities = new Map<string, NonNullable<CaptureObservation['identity']>>();
  const seed = async (label: string, account = accountId) => {
    const identity = {
      version: 1 as const,
      type: 'UI_CONTEXT' as const,
      source: 'VISIBLE_UI' as const,
      accountId: account,
      contextId: randomUUID(),
      conversationKey: randomUUID(),
      conversationKind: 'INDIVIDUAL' as const,
      confirmedAt: '2026-10-19T12:00:00.000Z',
    };
    const id = randomUUID();
    expect(
      (
        await request('POST', '/api/observations', {
          extensionInstanceId,
          observation: {
            kind: 'CAPTURE_OBSERVATION',
            observationId: id,
            observedAt: '2026-10-19T12:01:00.000Z',
            observationType: 'CONVERSATION_ACTIVITY',
            captureState: 'DETECTED',
            conversation: { label, kind: 'INDIVIDUAL' },
            senderLabel: null,
            direction: 'UNKNOWN',
            content: null,
            contentAvailability: 'UNAVAILABLE',
            media: [],
            identity,
            activity: { unreadCount: 1, reason: 'ROW_CHANGED' },
          },
        })
      ).statusCode,
    ).toBe(202);
    const conversation = (
      db
        .prepare('SELECT conversation_id id FROM wa_capture_normalizations WHERE observation_id=?')
        .get(id) as { id: string }
    ).id;
    identities.set(conversation, identity);
    return conversation;
  };
  const create = async (ids?: string[], extra: Record<string, unknown> = {}) => {
    const result = await request('POST', '/api/dialogue-sync-batches', {
      scope: ids ? 'SELECTED' : 'ALL_PENDING',
      ...(ids ? { conversationIds: ids } : {}),
      explicitAuthorization: true,
      idempotencyKey: randomUUID(),
      ...extra,
    });
    expect(result.statusCode).toBe(202);
    return result.json();
  };
  const poll = async (active?: DialogueSyncJob) => {
    const result = await request('POST', '/api/extension/dialogue-sync/poll', {
      extensionInstanceId,
      accountId,
      ready: !active,
      ...(active ? { activeRequestId: active.id, leaseToken: active.leaseToken } : {}),
    });
    expect(result.statusCode).toBe(200);
    return result.json();
  };
  const complete = async (job: DialogueSyncJob, code = 'OK') => {
    const row = db
      .prepare('SELECT review_conversation_id id FROM wa_dialogue_sync_requests WHERE id=?')
      .get(job.id) as { id: string };
    const identity = identities.get(row.id)!;
    const observation: CaptureObservation = {
      kind: 'CAPTURE_OBSERVATION',
      observationId: randomUUID(),
      observedAt: '2026-10-19T12:01:00.000Z',
      observationType: 'MESSAGE',
      captureState: 'CAPTURED',
      conversation: { label: job.query, kind: 'INDIVIDUAL' },
      senderLabel: null,
      direction: 'INBOUND',
      content: 'Synthetic batch content',
      contentAvailability: 'AVAILABLE',
      media: [],
      identity,
      messageRef: { key: randomUUID(), revision: 1, firstObservedAt: '2026-10-19T12:01:00.000Z' },
    };
    return request('POST', '/api/extension/dialogue-sync/complete', {
      extensionInstanceId,
      requestId: job.id,
      leaseToken: job.leaseToken,
      code,
      truncated: false,
      ...(code === 'OK' ? { identity, conversationLabel: job.query } : {}),
      observations: code === 'OK' ? [observation] : [],
    });
  };
  const page = async (id: string, query = '') =>
    (await request('GET', `/api/dialogue-sync-batches/${id}${query}`)).json();
  const api = new LocalApiClient({
    baseUrl: 'http://127.0.0.1:47831',
    token,
    fetchImpl: async (input, init) => {
      const url = new URL(String(input)),
        result = await request(
          init?.method === 'POST' ? 'POST' : 'GET',
          url.pathname + url.search,
          init?.body ? JSON.parse(String(init.body)) : undefined,
        );
      return new Response(result.body, { status: result.statusCode });
    },
  });
  const server = createMcpServer({ api }),
    client = new Client({ name: 'synthetic-batch-client', version: '1' }),
    [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.server.connect(st)]);
  const tool = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    expect(r.isError).not.toBe(true);
    return JSON.parse((r.content as Array<{ text: string }>)[0]!.text);
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
    accountId,
    extensionInstanceId,
    identities,
    seed,
    create,
    poll,
    complete,
    page,
    request,
    tool,
  };
}
describe('explicit sequential pending dialogue batches', () => {
  it('requires explicit authorization and snapshots an ordered array, creating only one child at a time', async () => {
    const h = await setup(),
      a = await h.seed('Synthetic A'),
      b = await h.seed('Synthetic B');
    const batch = await h.create([b, a]);
    expect(batch).toMatchObject({ status: 'RUNNING', total: 2, active: 1, waiting: 1 });
    expect(h.db.prepare('SELECT COUNT(*) n FROM wa_dialogue_sync_requests').get()).toEqual({
      n: 1,
    });
    const first = (await h.poll()).job as DialogueSyncJob;
    expect(first.query).toBe('Synthetic B');
    expect(first.batch).toMatchObject({
      id: batch.id,
      position: 0,
      total: 2,
      conversationIds: [b, a],
    });
    expect((await h.poll()).job).toBe(null);
    expect((await h.complete(first)).statusCode).toBe(200);
    const partial = await h.page(batch.id);
    expect(partial.batch).toMatchObject({ succeeded: 1, waiting: 1, active: 0 });
    expect(h.db.prepare('SELECT COUNT(*) n FROM wa_dialogue_sync_requests').get()).toEqual({
      n: 1,
    }); // status read doesn't schedule navigation
    const second = (await h.poll()).job as DialogueSyncJob;
    expect(second.query).toBe('Synthetic A');
    expect(second.batch?.position).toBe(1);
    expect((await h.complete(second)).statusCode).toBe(200);
    expect((await h.page(batch.id)).batch).toMatchObject({
      status: 'COMPLETED',
      succeeded: 2,
      waiting: 0,
    });
    expect(h.db.prepare('SELECT DISTINCT state FROM wa_ai_message_state').all()).toEqual([
      { state: 'UNREAD' },
    ]);
    expect(h.db.prepare('SELECT COUNT(*) n FROM wa_outbox').get()).toEqual({ n: 0 });
  });
  it('ALL_PENDING never expands with new notifications, and idempotent replay never creates another array or child', async () => {
    const h = await setup();
    await h.seed('Synthetic A');
    const key = randomUUID();
    const args = { scope: 'ALL_PENDING', explicitAuthorization: true, idempotencyKey: key };
    const first = await h.tool('whatsapp_sync_pending_conversations', args);
    await h.seed('Synthetic later');
    const replay = await h.tool('whatsapp_sync_pending_conversations', args);
    expect(replay.id).toBe(first.id);
    expect(replay.total).toBe(1);
    expect(h.db.prepare('SELECT COUNT(*) n FROM wa_dialogue_sync_requests').get()).toEqual({
      n: 1,
    });
    const conflict = await h.request('POST', '/api/dialogue-sync-batches', {
      ...args,
      limitPerConversation: 20,
    });
    expect(conflict.statusCode).toBe(409);
  });
  it('pauses on user interference, explicitly resumes without repeating success, and can retry only when requested', async () => {
    const h = await setup(),
      a = await h.seed('Synthetic A'),
      b = await h.seed('Synthetic B'),
      c = await h.seed('Synthetic C');
    const batch = await h.create([a, b, c]);
    const first = (await h.poll()).job;
    await h.complete(first);
    const second = (await h.poll()).job;
    await h.complete(second, 'USER_INTERFERENCE');
    expect((await h.page(batch.id)).batch).toMatchObject({
      status: 'PAUSED',
      succeeded: 1,
      failed: 1,
      waiting: 1,
      reason: 'USER_INTERFERENCE',
    });
    expect((await h.poll()).job).toBe(null);
    const resumed = await h.tool('whatsapp_resume_sync_batch', {
      id: batch.id,
      explicitAuthorization: true,
      retryFailedItem: true,
    });
    expect(resumed.status).toBe('RUNNING');
    const retry = (await h.poll()).job;
    expect(retry.query).toBe('Synthetic B');
    expect(retry.id).not.toBe(second.id);
    expect(retry.batch.runToken).not.toBe(second.batch.runToken);
    await h.complete(retry);
    await h.complete((await h.poll()).job);
    expect((await h.page(batch.id)).batch).toMatchObject({ status: 'COMPLETED', succeeded: 3 });
    expect(
      h.db
        .prepare('SELECT COUNT(*) n FROM wa_dialogue_sync_requests WHERE review_conversation_id=?')
        .get(a),
    ).toEqual({ n: 1 });
  });
  it('retries exactly the interrupted item even when the frozen plan contains a later invalid target', async () => {
    const h = await setup(),
      a = await h.seed('Synthetic A'),
      invalid = await h.seed('Synthetic '.repeat(15)),
      c = await h.seed('Synthetic C');
    const batch = await h.create([a, invalid, c]);
    await h.complete((await h.poll()).job, 'USER_INTERFERENCE');
    expect((await h.page(batch.id)).batch).toMatchObject({
      status: 'PAUSED',
      currentPosition: 0,
      failed: 2,
    });
    expect(
      (
        await h.request('POST', `/api/dialogue-sync-batches/${batch.id}/resume`, {
          explicitAuthorization: true,
          retryFailedItem: true,
        })
      ).statusCode,
    ).toBe(200);
    const retry = (await h.poll()).job;
    expect(retry.query).toBe('Synthetic A');
    await h.complete(retry);
    await h.complete((await h.poll()).job);
    expect((await h.page(batch.id)).batch).toMatchObject({
      status: 'COMPLETED_WITH_ERRORS',
      succeeded: 2,
      failed: 1,
    });
  });
  it('continues after per-contact failure and reports partial completion with item errors', async () => {
    const h = await setup(),
      a = await h.seed('Synthetic A'),
      b = await h.seed('Synthetic B');
    const batch = await h.create([a, b]);
    await h.complete((await h.poll()).job, 'CONTACT_NOT_FOUND');
    const second = (await h.poll()).job;
    expect(second.query).toBe('Synthetic B');
    await h.complete(second);
    const page = await h.page(batch.id);
    expect(page.batch).toMatchObject({ status: 'COMPLETED_WITH_ERRORS', succeeded: 1, failed: 1 });
    expect(page.items[0].code).toBe('CONTACT_NOT_FOUND');
  });
  it('cancels an active leased reader, blocks the next item and refuses late snapshot persistence', async () => {
    const h = await setup(),
      a = await h.seed('Synthetic A'),
      b = await h.seed('Synthetic B');
    const batch = await h.create([a, b]),
      job = (await h.poll()).job;
    const cancelled = await h.tool('whatsapp_cancel_sync_batch', {
      id: batch.id,
      explicitAuthorization: true,
    });
    expect(cancelled).toMatchObject({ status: 'CANCELLED', cancelled: 2 });
    expect(await h.poll(job)).toMatchObject({ job: null, cancelRequestId: job.id });
    expect((await h.complete(job)).json()).toMatchObject({ status: 'FAILED', code: 'CANCELLED' });
    expect(h.db.prepare('SELECT COUNT(*) n FROM wa_messages').get()).toEqual({ n: 0 });
    expect((await h.poll()).job).toBe(null);
    expect(
      (
        await h.request('POST', `/api/dialogue-sync-batches/${batch.id}/resume`, {
          explicitAuthorization: true,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await h.tool('whatsapp_cancel_sync_batch', { id: batch.id, explicitAuthorization: true }))
        .status,
    ).toBe('CANCELLED');
  });
  it('preserves committed successes when cancelled, and paginates persisted dialogues without more navigation', async () => {
    const h = await setup(),
      a = await h.seed('Synthetic A'),
      b = await h.seed('Synthetic B');
    const batch = await h.create([a, b]);
    await h.complete((await h.poll()).job);
    await h.tool('whatsapp_cancel_sync_batch', { id: batch.id, explicitAuthorization: true });
    const first = await h.tool('whatsapp_get_sync_batch', { id: batch.id, limit: 1 });
    expect(first.nextCursor).toBe(1);
    expect(first.items[0].dialogue.messages[0].content).toBe('Synthetic batch content');
    const second = await h.tool('whatsapp_get_sync_batch', {
      id: batch.id,
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(second.nextCursor).toBe(null);
    expect(second.items[0].dialogue).toBe(null);
    expect(first.batch).toMatchObject({ status: 'CANCELLED', succeeded: 1, cancelled: 1 });
  });
  it('handles empty pending lists, account ambiguity and missing identities explicitly', async () => {
    const h = await setup();
    expect(await h.create()).toMatchObject({ status: 'COMPLETED', total: 0 });
    await h.seed('Synthetic A');
    await h.seed('Synthetic foreign', randomUUID());
    const args = {
      scope: 'ALL_PENDING',
      explicitAuthorization: true,
      idempotencyKey: randomUUID(),
    };
    expect((await h.request('POST', '/api/dialogue-sync-batches', args)).statusCode).toBe(409);
    expect(await h.create(undefined, { accountId: h.accountId })).toMatchObject({ total: 1 });
  });
  it('expires uncertain child requests into PAUSED rather than replaying after a restart or lost completion', async () => {
    const h = await setup(),
      a = await h.seed('Synthetic A'),
      b = await h.seed('Synthetic B');
    const batch = await h.create([a, b]),
      job = (await h.poll()).job;
    h.db
      .prepare("UPDATE wa_dialogue_sync_requests SET expires_at='2020-01-01T00:00:00Z' WHERE id=?")
      .run(job.id);
    const fresh = new DialogueSyncBatchRepository(h.db);
    expect(fresh.get(batch.id)).toMatchObject({
      status: 'PAUSED',
      reason: 'TIMEOUT',
      failed: 1,
      waiting: 1,
    });
    expect((await h.poll()).job).toBe(null);
    expect(
      (
        await h.request('POST', `/api/dialogue-sync-batches/${batch.id}/resume`, {
          explicitAuthorization: true,
          retryFailedItem: false,
        })
      ).statusCode,
    ).toBe(200);
    expect((await h.poll()).job.query).toBe('Synthetic B');
  });
  it('global expiry cancels active/remaining work and cannot be resumed implicitly', async () => {
    const h = await setup(),
      id = await h.seed('Synthetic A');
    const batch = await h.create([id]);
    const job = (await h.poll()).job;
    h.db
      .prepare("UPDATE wa_dialogue_sync_batches SET expires_at='2020-01-01T00:00:00Z' WHERE id=?")
      .run(batch.id);
    expect((await h.page(batch.id)).batch.status).toBe('EXPIRED');
    expect((await h.poll(job)).cancelRequestId).toBe(job.id);
    expect((await h.poll()).job).toBe(null);
  });
  it('does not allow an unrelated reader to query or cancel another lease', async () => {
    const h = await setup(),
      id = await h.seed('Synthetic A');
    await h.create([id]);
    const job = (await h.poll()).job;
    expect(
      (
        await h.request('POST', '/api/extension/dialogue-sync/poll', {
          extensionInstanceId: randomUUID(),
          accountId: h.accountId,
          ready: false,
          activeRequestId: job.id,
          leaseToken: job.leaseToken,
        })
      ).statusCode,
    ).toBe(409);
  });
  it('skips an already confirmed pending reference before its turn without navigating it', async () => {
    const h = await setup(),
      a = await h.seed('Synthetic A'),
      b = await h.seed('Synthetic B'),
      c = await h.seed('Synthetic C');
    const batch = await h.create([a, b, c]);
    await h.complete((await h.poll()).job);
    h.db
      .prepare(
        'UPDATE wa_conversation_reviews SET verified_revision=revision,acknowledged_revision=revision WHERE conversation_id=?',
      )
      .run(b);
    const next = (await h.poll()).job;
    expect(next.query).toBe('Synthetic C');
    expect(next.batch.position).toBe(2);
    await h.complete(next);
    const result = await h.page(batch.id);
    expect(result.batch).toMatchObject({ status: 'COMPLETED', succeeded: 2, skipped: 1 });
    expect(result.items[1]).toMatchObject({
      status: 'SKIPPED',
      code: 'NO_LONGER_PENDING',
      syncRequestId: null,
    });
  });
  it('rejects more than5000 pending references instead of silently truncating the plan', async () => {
    const h = await setup();
    h.db
      .exec(`WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n<5001)
      INSERT INTO wa_conversations(id,connector,account_scope,kind,title,created_at,updated_at)
      SELECT '00000000-0000-4000-8000-'||printf('%012d',n),'synthetic','synthetic','UNKNOWN','Synthetic cap','2026-10-19T12:00:00Z','2026-10-19T12:00:00Z' FROM numbers;
      INSERT INTO wa_conversation_reviews(conversation_id,revision,signal_count,last_activity_at)
      SELECT id,1,1,'2026-10-19T12:00:00Z' FROM wa_conversations;`);
    const result = await h.request('POST', '/api/dialogue-sync-batches', {
      scope: 'ALL_PENDING',
      explicitAuthorization: true,
      idempotencyKey: randomUUID(),
    });
    expect(result.statusCode).toBe(409);
    expect(result.json().error.code).toBe('BATCH_TOO_LARGE');
    expect(h.db.prepare('SELECT COUNT(*) n FROM wa_dialogue_sync_batches').get()).toEqual({ n: 0 });
  });
  it('preserves ordered progress across a consistent backup/reopen without creating another child on status lookup', async () => {
    const h = await setup(),
      a = await h.seed('Synthetic A'),
      b = await h.seed('Synthetic B'),
      batch = await h.create([a, b]);
    const dir = mkdtempSync(join(tmpdir(), 'wai-batch-persist-'));
    try {
      const path = join(dir, 'batch.sqlite');
      await h.db.backup(path);
      const restored = openDatabase(path);
      try {
        const result = new DialogueSyncBatchRepository(restored).page(batch.id, {});
        expect(result.items.map((item) => item.conversationId)).toEqual([a, b]);
        expect(result.batch).toMatchObject({ status: 'RUNNING', active: 1, waiting: 1 });
        expect(restored.prepare('SELECT COUNT(*) n FROM wa_dialogue_sync_requests').get()).toEqual({
          n: 1,
        });
        expect(restored.pragma('foreign_key_check')).toEqual([]);
      } finally {
        restored.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('validates auth, explicit authorization, arrays, pagination and only one running batch', async () => {
    const h = await setup(),
      id = await h.seed('Synthetic A'),
      args = {
        scope: 'SELECTED',
        conversationIds: [id],
        explicitAuthorization: true,
        idempotencyKey: randomUUID(),
      };
    expect((await h.request('POST', '/api/dialogue-sync-batches', args, false)).statusCode).toBe(
      401,
    );
    for (const body of [
      { ...args, explicitAuthorization: false },
      { ...args, conversationIds: [id, id] },
      { ...args, conversationIds: [] },
      { ...args, scope: 'ALL_PENDING' },
    ])
      expect((await h.request('POST', '/api/dialogue-sync-batches', body)).statusCode).toBe(400);
    const batch = await h.create([id]);
    expect(
      (
        await h.request('POST', '/api/dialogue-sync-batches', {
          ...args,
          idempotencyKey: randomUUID(),
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await h.request('GET', `/api/dialogue-sync-batches/${batch.id}?limit=101`)).statusCode,
    ).toBe(400);
  });
  it('contact MCP route reads SQLite aliases and combined filters without creating new commands', async () => {
    const h = await setup();
    const id = await h.seed('Synthetic local');
    h.db
      .prepare(
        "UPDATE wa_contacts SET display_name='João',nickname='Esposa',full_name='João Maria Silva' WHERE id=(SELECT peer_contact_id FROM wa_conversation_identities WHERE conversation_id=?)",
      )
      .run(id);
    const result = await h.tool('whatsapp_list_contacts', { query: 'esposa' });
    expect(result).toMatchObject({
      total: 1,
      source: 'SQLITE_ONLY',
      items: [{ name: 'João', nickname: 'Esposa', fullName: 'João Maria Silva' }],
    });
    expect(
      (
        await h.request(
          'GET',
          '/api/contacts/directory?query=j&match=STARTS_WITH&registeredOn=2026-10-19',
        )
      ).json().total,
    ).toBe(1);
    expect((await h.request('GET', '/api/contacts/directory', undefined, false)).statusCode).toBe(
      401,
    );
    expect(h.db.prepare('SELECT COUNT(*) n FROM wa_dialogue_sync_requests').get()).toEqual({
      n: 0,
    });
  });
});
it('applies priority, exclusion and policy changes before each batch turn',async()=>{const h=await setup();const a=await h.seed('Synthetic A'),b=await h.seed('Synthetic B'),c=await h.seed('Synthetic C');for(const [id,input] of [[b,{favorite:true,priority:10,batchMode:'INCLUDE'}],[c,{favorite:false,priority:0,batchMode:'INDIVIDUAL_ONLY'}]] as const)expect((await h.request('POST',`/api/conversation-policies/${id}`,{...input,explicitConfirmation:true})).statusCode).toBe(200);const batch=await h.create();const first=(await h.poll()).job;expect(first.query).toBe('Synthetic B');await h.request('POST',`/api/conversation-policies/${a}`,{favorite:false,priority:0,batchMode:'EXCLUDE',explicitConfirmation:true});await h.complete(first);expect((await h.poll()).job).toBeNull();const report=(await h.request('GET',`/api/dialogue-sync-batches/${batch.id}/report`)).json();expect(report.batch).toMatchObject({succeeded:1,skipped:2,status:'COMPLETED'});expect(report.pendingRemaining).toBe(3);});
it('explicitly retries only failed items in a new idempotent batch and reports outcomes',async()=>{const h=await setup();const a=await h.seed('Synthetic A'),b=await h.seed('Synthetic B');const batch=await h.create([a,b]);await h.complete((await h.poll()).job,'CONTACT_NOT_FOUND');await h.complete((await h.poll()).job);const input={explicitAuthorization:true,idempotencyKey:randomUUID()};const retry=await h.request('POST',`/api/dialogue-sync-batches/${batch.id}/retry-failed`,input);expect(retry.statusCode).toBe(202);expect(retry.json()).toMatchObject({total:1});expect((await h.request('POST',`/api/dialogue-sync-batches/${batch.id}/retry-failed`,input)).json().id).toBe(retry.json().id);expect((await h.poll()).job.query).toBe('Synthetic A');});
it('requires review before linking same-name references without merging histories',async()=>{const h=await setup();const a=await h.seed('Synthetic duplicate'),b=await h.seed('Synthetic duplicate');const candidates=(await h.request('GET','/api/reference-candidates')).json();expect(candidates.items).toHaveLength(1);expect((await h.request('POST','/api/reference-candidates/decisions',{leftId:a,rightId:b,decision:'LINK',explicitConfirmation:false})).statusCode).toBe(400);const decision=await h.request('POST','/api/reference-candidates/decisions',{leftId:a,rightId:b,decision:'LINK',explicitConfirmation:true});expect(decision.statusCode).toBe(200);expect(decision.json().historiesMerged).toBe(false);expect((await h.request('GET','/api/reference-candidates')).json().items).toHaveLength(0);expect((await h.request('GET','/api/conversations')).json().items).toHaveLength(2);});
