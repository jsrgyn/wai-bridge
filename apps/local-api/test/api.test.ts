import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { CaptureObservationRepository, openDatabase } from '@wai-bridge/database';
import { OutboxRepository } from '@wai-bridge/database';
import { OutboxService } from '@wai-bridge/outbox-engine';
import { EventService } from '@wai-bridge/events';
import { buildApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';
const TOKEN = 'local-api-test-token-0123456789abcdef';
const NOW = '2026-10-17T12:00:00.000Z';
const directories: string[] = [];
const apps: FastifyInstance[] = [];
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'wai-api-'));
  directories.push(dir);
  const db = openDatabase(join(dir, 'api.sqlite'));
  db.prepare(
    'INSERT INTO wa_contacts(id,connector,account_scope,external_id,display_name,identity_status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
  ).run(
    '11111111-1111-4111-8111-111111111111',
    'fixture',
    'local',
    'external-a',
    'Synthetic Contact',
    'KNOWN',
    NOW,
    NOW,
  );
  db.prepare(
    'INSERT INTO wa_contacts(id,connector,account_scope,external_id,display_name,identity_status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
  ).run(
    '22222222-2222-4222-8222-222222222222',
    'fixture',
    'local',
    'external-b',
    'Another Contact',
    'KNOWN',
    NOW,
    NOW,
  );
  db.prepare(
    'INSERT INTO wa_conversations(id,connector,account_scope,external_id,kind,title,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
  ).run(
    '33333333-3333-4333-8333-333333333333',
    'fixture',
    'local',
    'conversation-a',
    'DIRECT',
    'Synthetic chat',
    NOW,
    NOW,
  );
  const msgId = '44444444-4444-4444-8444-444444444444';
  db.prepare(
    "INSERT INTO wa_messages(id,conversation_id,sender_contact_id,direction,capture_status,content,content_availability,observed_at,captured_at,sequence,created_at) VALUES(?,?,?,'INBOUND','CAPTURED','hello synthetic','AVAILABLE',?,?,1,?)",
  ).run(
    msgId,
    '33333333-3333-4333-8333-333333333333',
    '11111111-1111-4111-8111-111111111111',
    NOW,
    NOW,
    NOW,
  );
  db.prepare(
    "INSERT INTO wa_ai_message_state(message_id,state,updated_at) VALUES(?,'UNREAD',?)",
  ).run(msgId, NOW);
  db.prepare(
    'INSERT INTO wa_media(id,message_id,mime_type,size_bytes,storage_key,availability,created_at) VALUES(?,?,?,?,?,?,?)',
  ).run(
    '55555555-5555-4555-8555-555555555555',
    msgId,
    'image/png',
    123,
    'private/secret/path.png',
    'AVAILABLE',
    NOW,
  );
  const eventService = new EventService(db);
  eventService.publish({
    type: 'message.received',
    aggregateType: 'message',
    aggregateId: msgId,
    occurredAt: NOW,
    payloadVersion: 1,
    payload: { messageId: msgId },
  });
  const app = buildApp({ db, apiToken: TOKEN, logger: false });
  apps.push(app);
  return { db, app, msgId };
}
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function auth() {
  return { authorization: `Bearer ${TOKEN}` };
}
describe('local REST API', () => {
  it('keeps health public and protects API routes', async () => {
    const { app } = setup();
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/status' })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/ai/claims',
          payload: { messageId: '44444444-4444-4444-8444-444444444444', consumerId: 'ai' },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/status',
          headers: { authorization: 'Bearer wrong' },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ method: 'GET', url: '/api/status', headers: auth() })).json().database,
    ).toBe('connected');
  });
  it('authenticates and persists macOS extension connection state', async () => {
    const { app, db } = setup();
    const extensionInstanceId = '66666666-6666-4666-8666-666666666666';
    const payload = { extensionInstanceId, status: 'CONNECTED', lastSeenAt: NOW };
    expect((await app.inject({ method: 'POST', url: '/api/extension/state', payload })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/extension/state', headers: auth(), payload })).statusCode).toBe(204);
    expect((await app.inject({ method: 'POST', url: '/api/extension/state', headers: auth(), payload: { ...payload, lastSeenAt: '2026-10-17T12:00:01.000Z' } })).statusCode).toBe(204);
    const repo = new (await import('@wai-bridge/database')).ExtensionStateRepository(db);
    expect(repo.get(extensionInstanceId)).toEqual({ status: 'CONNECTED', lastSeenAt: '2026-10-17T12:00:01.000Z' });
    expect((db.prepare('SELECT COUNT(*) count FROM wa_extension_state WHERE extension_instance_id=?').get(extensionInstanceId) as { count: number }).count).toBe(1);
    expect((await app.inject({ method: 'POST', url: '/api/extension/state', headers: auth(), payload: { ...payload, status: 'connected' } })).statusCode).toBe(400);
  });
  it('persists an observation and event atomically and deduplicates retries', async () => {
    const { app, db } = setup();
    const observation = {
      kind: 'CAPTURE_OBSERVATION', observationId: '77777777-7777-4777-8777-777777777777', observedAt: NOW,
      observationType: 'MESSAGE', captureState: 'CAPTURED',
      conversation: { label: 'Synthetic conversation', kind: 'INDIVIDUAL' },
      senderLabel: 'Synthetic sender', direction: 'INBOUND', content: 'Synthetic new text',
      contentAvailability: 'AVAILABLE', media: [],
    };
    const payload = { extensionInstanceId: '66666666-6666-4666-8666-666666666666', observation };
    expect((await app.inject({ method: 'POST', url: '/api/observations', payload })).statusCode).toBe(401);
    const before = (db.prepare('SELECT count(*) count FROM wa_events').get() as { count: number }).count;
    const first = await app.inject({ method: 'POST', url: '/api/observations', headers: auth(), payload });
    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({ observationId: observation.observationId, duplicate: false });
    expect(new CaptureObservationRepository(db).get(observation.observationId)?.content).toBe('Synthetic new text');
    expect((await app.inject({ method: 'GET', url: `/api/observations/${observation.observationId}`, headers: auth() })).json().content).toBe('Synthetic new text');
    expect((db.prepare('SELECT count(*) count FROM wa_events').get() as { count: number }).count).toBe(before + 2);
    const retry = await app.inject({ method: 'POST', url: '/api/observations', headers: auth(), payload });
    expect(retry.json()).toEqual({ ...first.json(), duplicate: true });
    expect((db.prepare('SELECT count(*) count FROM wa_events').get() as { count: number }).count).toBe(before + 2);
    const conflict = await app.inject({ method: 'POST', url: '/api/observations', headers: auth(), payload: { ...payload, observation: { ...observation, content: 'Changed' } } });
    expect(conflict.statusCode).toBe(409);
  });
  it('filters and cursor-paginates contacts and conversations', async () => {
    const { app } = setup();
    const first = await app.inject({
      method: 'GET',
      url: '/api/contacts?limit=1',
      headers: auth(),
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().items).toHaveLength(1);
    const next = first.json().nextCursor;
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/contacts?limit=1&cursor=${next}`,
          headers: auth(),
        })
      ).json().items,
    ).toHaveLength(1);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/contacts/search?q=Synthetic',
          headers: auth(),
        })
      ).json().items,
    ).toHaveLength(1);
    expect(
      (await app.inject({ method: 'GET', url: '/api/conversations', headers: auth() })).json()
        .items,
    ).toHaveLength(1);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/conversations/33333333-3333-4333-8333-333333333333',
          headers: auth(),
        })
      ).statusCode,
    ).toBe(200);
  });
  it('filters message queries and keeps GET read-only', async () => {
    const { app, db, msgId } = setup();
    for (const url of [
      '/api/messages',
      '/api/messages/unread',
      '/api/messages/recent',
      '/api/conversations/33333333-3333-4333-8333-333333333333/messages',
      '/api/messages?direction=INBOUND&captureStatus=CAPTURED',
    ]) {
      const res = await app.inject({ method: 'GET', url, headers: auth() });
      expect(res.statusCode).toBe(200);
      expect(res.json().items[0].id).toBe(msgId);
    }
    expect(
      db.prepare('SELECT state FROM wa_ai_message_state WHERE message_id=?').get(msgId),
    ).toEqual({ state: 'UNREAD' });
  });
  it('paginates recent messages by timestamp and ID across conversations', async () => {
    const { app, db } = setup();
    db.prepare(
      "INSERT INTO wa_messages(id,conversation_id,sender_contact_id,direction,capture_status,content,content_availability,observed_at,captured_at,sequence,created_at) VALUES(?,?,?,'INBOUND','CAPTURED','later synthetic','AVAILABLE',?,?,2,?)",
    ).run(
      '66666666-6666-4666-8666-666666666666',
      '33333333-3333-4333-8333-333333333333',
      '11111111-1111-4111-8111-111111111111',
      '2026-10-17T12:01:00.000Z',
      '2026-10-17T12:01:00.000Z',
      '2026-10-17T12:01:00.000Z',
    );
    db.prepare(
      "INSERT INTO wa_ai_message_state(message_id,state,updated_at) VALUES(?,'UNREAD',?)",
    ).run('66666666-6666-4666-8666-666666666666', '2026-10-17T12:01:00.000Z');
    const first = await app.inject({
      method: 'GET',
      url: '/api/messages?limit=1',
      headers: auth(),
    });
    expect(first.json().items[0].id).toBe('66666666-6666-4666-8666-666666666666');
    const second = await app.inject({
      method: 'GET',
      url: `/api/messages?limit=1&cursor=${first.json().nextCursor}`,
      headers: auth(),
    });
    expect(second.json().items[0].id).toBe('44444444-4444-4444-8444-444444444444');
  });

  it('validates filters and cursor input', async () => {
    const { app } = setup();
    expect(
      (await app.inject({ method: 'GET', url: '/api/messages?limit=999', headers: auth() }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/messages?cursor=not-base64-sequence',
          headers: auth(),
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: 'GET', url: '/api/contacts/search?q=x', headers: auth() }))
        .statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: 'GET', url: '/api/conversations/not-an-id', headers: auth() }))
        .statusCode,
    ).toBe(400);
  });
  it('returns media metadata without revealing local storage paths', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'GET',
      url: '/api/media/55555555-5555-4555-8555-555555555555',
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('private/secret/path');
  });
  it('lists persisted and pending events', async () => {
    const { app } = setup();
    expect(
      (await app.inject({ method: 'GET', url: '/api/events', headers: auth() })).json().items,
    ).toHaveLength(1);
    expect(
      (await app.inject({ method: 'GET', url: '/api/events/pending', headers: auth() })).json()
        .items,
    ).toHaveLength(1);
  });
  it('claims and explicitly ACKs a message idempotently', async () => {
    const { app, db, msgId } = setup();
    const headers = { ...auth(), 'idempotency-key': 'claim-key-0123456789' };
    const claim = await app.inject({
      method: 'POST',
      url: '/api/ai/claims',
      headers,
      payload: { messageId: msgId, consumerId: 'ai-test' },
    });
    expect(claim.statusCode).toBe(200);
    const token = claim.json().claimToken;
    const ack = await app.inject({
      method: 'POST',
      url: '/api/ai/ack',
      headers: { ...auth(), 'idempotency-key': 'ack-key-0123456789' },
      payload: { messageId: msgId, consumerId: 'ai-test', claimToken: token },
    });
    expect(ack.statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/ai/ack',
          headers: { ...auth(), 'idempotency-key': 'ack-key-0123456789' },
          payload: { messageId: msgId, consumerId: 'ai-test', claimToken: token },
        })
      ).json().state,
    ).toBe('READ');
    expect(
      db.prepare('SELECT state FROM wa_ai_message_state WHERE message_id=?').get(msgId),
    ).toEqual({ state: 'READ' });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/ai/ack',
          headers: { ...auth(), 'idempotency-key': 'ack-other-01234567' },
          payload: { messageId: msgId, consumerId: 'other', claimToken: randomUUID() },
        })
      ).statusCode,
    ).toBe(409);
  });
  it('supports consumer-scoped leases and independent explicit acknowledgements', async () => {
    const { app, db, msgId }=setup();
    const claimA=await app.inject({method:'POST',url:'/api/ai/consumer-claims',headers:{...auth(),'idempotency-key':'consumer-claim-key-123'},payload:{messageId:msgId,consumerId:'consumer-a',leaseMs:1000}});
    expect(claimA.statusCode).toBe(200);
    expect(claimA.json().attempts).toBe(1);
    const claimB=await app.inject({method:'POST',url:'/api/ai/consumer-claims',headers:{...auth(),'idempotency-key':'consumer-claim-key-456'},payload:{messageId:msgId,consumerId:'consumer-b',leaseMs:1000}});
    expect(claimB.statusCode).toBe(200);
    const ack=await app.inject({method:'POST',url:'/api/ai/consumer-ack',headers:{...auth(),'idempotency-key':'consumer-ack-key-123'},payload:{messageId:msgId,consumerId:'consumer-a',claimToken:claimA.json().claimToken}});
    expect(ack.json().state).toBe('READ');
    expect(db.prepare('SELECT consumer_id AS consumerId,state FROM wa_ai_consumer_message_state WHERE message_id=? ORDER BY consumer_id').all(msgId)).toEqual([{consumerId:'consumer-a',state:'READ'},{consumerId:'consumer-b',state:'CLAIMED'}]);
    expect((await app.inject({method:'GET',url:'/api/messages?consumerId=consumer-a&aiState=READ',headers:auth()})).json().items).toHaveLength(1);
    expect((await app.inject({method:'GET',url:'/api/messages?consumerId=consumer-b&aiState=UNREAD',headers:auth()})).json().items).toHaveLength(0);
    expect((await app.inject({method:'GET',url:`/api/ai/messages/${msgId}/state?consumerId=consumer-b`,headers:auth()})).json()).toMatchObject({state:'CLAIMED',version:1});
  });
  it('validates and persists idempotent outbox commands without sending', async () => {
    const { app, db } = setup();
    const headers = { ...auth(), 'idempotency-key': 'send-key-0123456789' };
    const body = {
      recipientId: '11111111-1111-4111-8111-111111111111',
      text: 'synthetic test only',
      explicitAuthorization: true,
    };
    const first = await app.inject({ method: 'POST', url: '/api/outbox', headers, payload: body });
    expect(first.statusCode).toBe(202);
    const second = await app.inject({ method: 'POST', url: '/api/outbox', headers, payload: body });
    expect(second.json().id).toBe(first.json().id);
    const id = first.json().id;
    expect((await app.inject({method:'GET',url:`/api/outbox/${id}`,headers:auth()})).json().command.payload_json).toContain('SUPERVISED');
    expect(
      (await app.inject({ method: 'GET', url: `/api/outbox/${id}`, headers: auth() })).json()
        .command.status,
    ).toBe('REQUESTED');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/outbox/${id}/cancel`,
          headers: { ...auth(), 'idempotency-key': 'cancel-key-0123456789' },
        })
      ).json().command.status,
    ).toBe('CANCELLED');
    expect(db.prepare('SELECT count(*) n FROM wa_outbox').get()).toEqual({ n: 1 });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/outbox',
          headers,
          payload: { ...body, text: 'changed content' },
        })
      ).statusCode,
    ).toBe(409);
  });
  it('records supervised results only after the command reaches WAITING_USER and SENT includes evidence',async()=>{
    const{app,db}=setup();const created=await app.inject({method:'POST',url:'/api/outbox',headers:{...auth(),'idempotency-key':'manual-result-key-12345'},payload:{recipientId:'11111111-1111-4111-8111-111111111111',text:'synthetic',explicitAuthorization:true}});const id=created.json().id;
    expect((await app.inject({method:'POST',url:`/api/outbox/${id}/result`,headers:{...auth(),'idempotency-key':'manual-result-key-54321'},payload:{result:'SENT',evidenceRef:'manual-observation:synthetic'}})).statusCode).toBe(409);
    const outbox=new OutboxService(new OutboxRepository(db));outbox.transition(id,'QUEUED','fixture','QUEUE');outbox.transition(id,'CLAIMED','fixture','CLAIM');outbox.transition(id,'TARGET_VERIFIED','fixture','TARGET');outbox.transition(id,'COMPOSED','fixture','COMPOSE');outbox.transition(id,'WAITING_USER','fixture','SUPERVISED');
    const noEvidence=await app.inject({method:'POST',url:`/api/outbox/${id}/result`,headers:{...auth(),'idempotency-key':'manual-result-key-54321'},payload:{result:'SENT'}});expect(noEvidence.statusCode).toBe(400);
    const sent=await app.inject({method:'POST',url:`/api/outbox/${id}/result`,headers:{...auth(),'idempotency-key':'manual-result-key-54321'},payload:{result:'SENT',evidenceRef:'manual-observation:synthetic'}});expect(sent.statusCode).toBe(200);expect(sent.json().status).toBe('SENT');
  });
  it('returns structured errors for invalid bodies and missing records', async () => {
    const { app } = setup();
    const bad = await app.inject({
      method: 'POST',
      url: '/api/outbox',
      headers: { ...auth(), 'idempotency-key': 'valid-key-0123456789' },
      payload: { recipientId: 'bad', text: '', explicitAuthorization: false },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('VALIDATION_ERROR');
    expect(
      (await app.inject({ method: 'GET', url: `/api/media/${randomUUID()}`, headers: auth() }))
        .statusCode,
    ).toBe(404);
  });
});
