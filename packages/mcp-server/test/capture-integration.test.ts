import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import {
  CaptureObservationRepository,
  OutboxRepository,
  openDatabase,
} from '../../database/src/index.js';
import { DatabaseRecipientResolver } from '../../outbox-engine/src/dispatcher.js';
import { EventService } from '../../events/src/index.js';
import { buildApp } from '../../../apps/local-api/src/app.js';
import { LocalApiClient } from '../src/client.js';
import { createMcpServer } from '../src/server.js';
import type { CaptureObservation } from '@wai-bridge/shared';

const token = 'synthetic-capture-mcp-token-0123456789';
const extensionInstanceId = '11111111-1111-4111-8111-111111111111';
const closeFns: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closeFns.splice(0)) await close();
});

function observation(overrides: Partial<CaptureObservation> = {}): CaptureObservation {
  return {
    kind: 'CAPTURE_OBSERVATION',
    observationId: randomUUID(),
    observedAt: '2026-10-18T12:00:00.000Z',
    observationType: 'MESSAGE',
    captureState: 'CAPTURED',
    conversation: { label: 'Synthetic namesake', kind: 'GROUP' },
    senderLabel: 'Synthetic member',
    direction: 'INBOUND',
    content: 'Synthetic new message',
    contentAvailability: 'AVAILABLE',
    media: ['IMAGE'],
    ...overrides,
  };
}

async function setup(allowExtensionSends=false,enableFlowLogs=false) {
  const db = openDatabase(':memory:');
  const app = buildApp({ db, apiToken: token, logger: false });
  closeFns.push(() => app.close());
  const api = new LocalApiClient({enableFlowLogs,flowSink:()=>{},
    baseUrl: 'http://127.0.0.1:47831',
    token,
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      const response = await app.inject({
        method: init?.method ?? 'GET',
        url: url.pathname + url.search,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        payload: init?.body as string | undefined,
      });
      return new Response(response.statusCode === 204 ? null : response.body, {
        status: response.statusCode,
      });
    },
  });
  const server = createMcpServer({ api,allowExtensionSends });
  const client = new Client({ name: 'synthetic-capture-check', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.server.connect(serverTransport), client.connect(clientTransport)]);
  closeFns.unshift(async () => {
    await api.flushLogs();api.closeLogs();
    await client.close();
    await server.close();
  });
  const capture = (value: CaptureObservation, instanceId = extensionInstanceId) =>
    app.inject({
      method: 'POST',
      url: '/api/observations',
      headers: { authorization: `Bearer ${token}` },
      payload: { extensionInstanceId: instanceId, observation: value },
    });
  async function tool(name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    const content = result.content as { type: string; text: string }[];
    return JSON.parse(content[0]!.text);
  }
  return { db, app, capture, tool,api };
}

describe('capture normalization through API and MCP', () => {
  it.each(['PHONE', 'GROUP_LOCAL', 'UI_CONTEXT'] as const)(
    'returns a persisted bidirectional %s dialogue with older-page pagination',
    async (type) => {
      const { db, capture, tool } = await setup();
      const base = {
        version: 1 as const,
        accountId: randomUUID(),
        contextId: randomUUID(),
        confirmedAt: '2026-10-18T11:59:00.000Z',
      };
      const identity =
        type === 'PHONE'
          ? { ...base, type, source: 'PROFILE_PHONE' as const, phone: '+12025550123' }
          : type === 'UI_CONTEXT' ? {...base,type,source:'VISIBLE_UI' as const,conversationKey:randomUUID(),conversationKind:'GROUP' as const} : {
              ...base,
              type,
              source: 'USER_GROUP' as const,
              groupId: randomUUID(),
              groupLabel: 'Synthetic group',
            };
      const observations = (['INBOUND', 'OUTBOUND', 'INBOUND'] as const).map((direction, index) =>
        observation({
          identity,
          direction,
          media: [],
          content: `Synthetic turn ${index + 1}`,
          observedAt: `2026-10-18T12:0${index}:00.000Z`,
          conversation: {
            label: 'Synthetic dialogue',
            kind: type === 'PHONE' ? 'INDIVIDUAL' : 'GROUP',
          },
        }),
      );
      for (const item of observations) expect((await capture(item)).statusCode).toBe(202);
      expect((await capture(observations[1]!)).json().duplicate).toBe(true);
      const conversationId = (await tool('whatsapp_list_conversations')).items[0].id;
      // A different account with the same display name must never enter this dialogue.
      expect(
        (
          await capture(
            observation({
              ...observations[0]!,
              observationId: randomUUID(),
              identity: { ...identity, accountId: randomUUID() },
            }),
          )
        ).statusCode,
      ).toBe(202);
      const recent = await tool('whatsapp_get_dialogue', { conversationId, limit: 2 });
      expect(recent).toMatchObject({
        order: 'ASC',
        cursorDirection: 'OLDER',
        coverage: 'OBSERVED_MESSAGES_ONLY',
        conversation: { id: conversationId },
      });
      expect(recent.messages.map((item: { sequence: number }) => item.sequence)).toEqual([2, 3]);
      expect(recent.messages.map((item: { speaker: string }) => item.speaker)).toEqual([
        'LOCAL_USER',
        'REMOTE_PARTICIPANT',
      ]);
      expect(recent.messages[0]).toMatchObject({
        direction: 'OUTBOUND',
        content: 'Synthetic turn 2',
        senderContactId: null,
        aiState: 'UNREAD',
        conversationId,
      });
      if(type!=='PHONE')expect(recent.conversation).toMatchObject({groupName:'Synthetic dialogue',contactPhone:null});
      const older = await tool('whatsapp_get_dialogue', {
        conversationId,
        limit: 2,
        cursor: recent.nextCursor,
      });
      expect(older.messages.map((item: { sequence: number }) => item.sequence)).toEqual([1]);
      expect(older.nextCursor).toBeNull();
      const complete = [...older.messages, ...recent.messages];
      expect(complete.map((item) => item.direction)).toEqual(['INBOUND', 'OUTBOUND', 'INBOUND']);
      expect(
        complete.every(
          (item) => item.conversationId === conversationId && item.aiState === 'UNREAD',
        ),
      ).toBe(true);
      expect(db.prepare('SELECT COUNT(*) n FROM wa_messages').get()).toEqual({ n: 4 });
      expect(db.prepare('SELECT COUNT(*) n FROM wa_outbox').get()).toEqual({ n: 0 });
    },
  );

  it('reuses a confirmed phone within one local account across observations and extension instances', async () => {
    const { db, capture, tool } = await setup();
    const identity = {
      version: 1 as const,
      accountId: randomUUID(),
      contextId: randomUUID(),
      confirmedAt: '2026-10-18T11:59:00.000Z',
      type: 'PHONE' as const,
      source: 'PROFILE_PHONE' as const,
      phone: '+12025550123',
    };
    const first = observation({
      identity,
      conversation: { label: 'Synthetic initial name', kind: 'INDIVIDUAL' },
    });
    const second = observation({
      identity,
      observedAt: '2026-10-18T12:01:00.000Z',
      conversation: { label: 'Synthetic renamed', kind: 'INDIVIDUAL' },
    });
    expect((await capture(first)).statusCode).toBe(202);
    expect((await capture(second, randomUUID())).statusCode).toBe(202);
    const conversations = (await tool('whatsapp_list_conversations', { limit: 1 })).items;
    expect(conversations).toHaveLength(1);
    expect(conversations[0]).toMatchObject({
      title: 'Synthetic renamed',
      identityStatus: 'PARTIAL',
      identitySource: 'PROFILE_PHONE',
      localAccountId: identity.accountId,
    });
    const messages = (await tool('whatsapp_get_messages', { conversationId: conversations[0].id }))
      .items;
    expect(messages.map((item: { sequence: number }) => item.sequence)).toEqual([2, 1]);
    expect(messages[0].senderContactId).toBe(messages[1].senderContactId);
    expect((await tool('whatsapp_search_contacts', { query: 'Synthetic' })).items).toHaveLength(1);
    expect(db.prepare('SELECT identity_status FROM wa_contacts').get()).toEqual({
      identity_status: 'PARTIAL',
    });
    expect(
      await new DatabaseRecipientResolver(new OutboxRepository(db)).resolve(
        messages[0].senderContactId,
      ),
    ).toEqual({ status: 'AMBIGUOUS' });
    const outbound = observation({
      identity,
      direction: 'OUTBOUND',
      observedAt: '2026-10-18T12:02:00.000Z',
      conversation: { label: 'Synthetic renamed', kind: 'INDIVIDUAL' },
    });
    expect((await capture(outbound)).statusCode).toBe(202);
    const outgoing = (
      await tool('whatsapp_get_messages', {
        conversationId: conversations[0].id,
        direction: 'OUTBOUND',
      })
    ).items;
    expect(outgoing).toHaveLength(1);
    expect(outgoing[0]).toMatchObject({ sequence: 3, senderContactId: null });
    const audit = db
      .prepare(
        "SELECT metadata_json FROM wa_audit_log WHERE action='conversation.reference-confirmed'",
      )
      .all() as { metadata_json: string }[];
    expect(audit).toHaveLength(1);
    expect(audit[0]!.metadata_json).not.toContain(identity.phone);
    const other = observation({
      identity: { ...identity, accountId: randomUUID() },
      conversation: { label: 'Synthetic renamed', kind: 'INDIVIDUAL' },
    });
    expect((await capture(other)).statusCode).toBe(202);
    expect((await tool('whatsapp_list_conversations')).items).toHaveLength(2);
    expect(
      (await capture({ ...first, identity: { ...identity, phone: '+12025550124' } })).statusCode,
    ).toBe(409);
  });
  it('keeps a local group UUID through rename while separating namesakes and unidentified members', async () => {
    const { db, capture, tool } = await setup();
    const identity = {
      version: 1 as const,
      accountId: randomUUID(),
      contextId: randomUUID(),
      confirmedAt: '2026-10-18T11:59:00.000Z',
      type: 'GROUP_LOCAL' as const,
      source: 'USER_GROUP' as const,
      groupId: randomUUID(),
      groupLabel: 'Synthetic group',
    };
    const first = observation({ identity });
    expect((await capture(first)).statusCode).toBe(202);
    expect(
      (
        await capture(
          observation({
            identity: { ...identity, groupLabel: 'Synthetic renamed group' },
            conversation:{label:'Synthetic renamed group',kind:'GROUP'},
            observedAt: '2026-10-18T12:01:00.000Z',
          }),
        )
      ).statusCode,
    ).toBe(202);
    const groups = (await tool('whatsapp_list_groups')).items;
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      title: 'Synthetic renamed group',
      identityStatus: 'PARTIAL',
      identitySource: 'USER_GROUP',
    });
    const messages = (await tool('whatsapp_get_messages', { conversationId: groups[0].id })).items;
    expect(messages).toHaveLength(2);
    expect(messages[0].senderContactId).not.toBe(messages[1].senderContactId);
    expect(db.prepare('SELECT DISTINCT identity_status FROM wa_contacts').all()).toEqual([
      { identity_status: 'UNKNOWN' },
    ]);
    expect(
      (
        await capture(
          observation({
            identity: { ...identity, groupId: randomUUID(), groupLabel: 'Synthetic renamed group' },
          }),
        )
      ).statusCode,
    ).toBe(202);
    expect((await tool('whatsapp_list_groups')).items).toHaveLength(2);
    expect(db.prepare('SELECT COUNT(*) n FROM wa_outbox').get()).toEqual({ n: 0 });
  });
  it('rejects incompatible, unnormalized and future-dated identity evidence', async () => {
    const { capture } = await setup();
    const identity = {
      version: 1 as const,
      accountId: randomUUID(),
      contextId: randomUUID(),
      confirmedAt: '2026-10-18T11:59:00.000Z',
      type: 'PHONE' as const,
      source: 'PROFILE_PHONE' as const,
      phone: '+12025550123',
    };
    expect((await capture(observation({ identity }))).statusCode).toBe(400);
    expect(
      (
        await capture(
          observation({
            identity: { ...identity, phone: '2025550123' },
            conversation: { label: null, kind: 'INDIVIDUAL' },
          }),
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await capture(
          observation({
            identity: { ...identity, confirmedAt: '2026-10-18T12:01:00.000Z' },
            conversation: { label: null, kind: 'INDIVIDUAL' },
          }),
        )
      ).statusCode,
    ).toBe(400);
  });
  it('normalizes an explicitly retransmitted staging-only observation once', async () => {
    const { db, capture, tool } = await setup();
    const value = observation();
    new CaptureObservationRepository(db).record(
      extensionInstanceId,
      value,
      () =>
        new EventService(db).publish({
          id: randomUUID(),
          type: 'message.captured',
          aggregateType: 'capture-observation',
          aggregateId: value.observationId,
          occurredAt: value.observedAt,
          payloadVersion: 1,
          payload: { observationId: value.observationId },
        }).event.id,
    );
    expect((await tool('whatsapp_get_unread')).items).toHaveLength(0);
    expect((await capture(value)).json().duplicate).toBe(true);
    expect((await capture(value)).json().duplicate).toBe(true);
    expect((await tool('whatsapp_get_unread')).items).toHaveLength(1);
    expect(
      db.prepare("SELECT COUNT(*) n FROM wa_events WHERE aggregate_type='message'").get(),
    ).toEqual({ n: 1 });
  });
  it('makes an inbound observation queryable with provenance, UNKNOWN identity and UNREAD state', async () => {
    const { db, capture, tool } = await setup();
    const value = observation();
    const first = await capture(value);
    expect(first.statusCode).toBe(202);
    const duplicate = await capture(value);
    expect(duplicate.json()).toMatchObject({ ...first.json(), duplicate: true });
    const page = await tool('whatsapp_get_unread');
    expect(page.items).toHaveLength(1);
    const message = page.items[0];
    expect(message).toMatchObject({
      content: value.content,
      direction: 'INBOUND',
      captureStatus: 'CAPTURED',
      aiState: 'UNREAD',
      identityStatus: 'UNKNOWN',
      sourceObservationId: value.observationId,
    });
    expect(
      (await tool('whatsapp_get_messages', { conversationId: message.conversationId })).items,
    ).toHaveLength(1);
    expect((await tool('whatsapp_get_recent')).items).toHaveLength(1);
    expect((await tool('whatsapp_list_groups')).items).toHaveLength(1);
    const conversation = await tool('whatsapp_get_conversation', { id: message.conversationId });
    expect(conversation).toMatchObject({
      title: value.conversation.label,
      identityStatus: 'UNKNOWN',
      sourceObservationId: value.observationId,
    });
    const contacts = await tool('whatsapp_search_contacts', { query: 'Synthetic' });
    expect(contacts.items).toHaveLength(1);
    expect(contacts.items[0]).toMatchObject({
      id: message.senderContactId,
      identityStatus: 'UNKNOWN',
      externalId: null,
    });
    const media = db.prepare('SELECT id FROM wa_media WHERE message_id=?').get(message.id) as {
      id: string;
    };
    expect(await tool('whatsapp_get_media', { id: media.id })).toMatchObject({
      availability: 'UNAVAILABLE',
      mediaType: 'IMAGE',
      sizeBytes: null,
    });
    const events = db
      .prepare(`SELECT aggregate_id, payload_json FROM wa_events WHERE aggregate_type='message'`)
      .all() as { aggregate_id: string; payload_json: string }[];
    expect(events).toHaveLength(1);
    expect(events[0]!.aggregate_id).toBe(message.id);
    expect(events[0]!.payload_json).not.toContain(value.content);
    expect((await tool('whatsapp_get_unread')).items[0].aiState).toBe('UNREAD');
    expect(db.prepare('SELECT COUNT(*) n FROM wa_outbox').get()).toEqual({ n: 0 });
  });

  it('does not merge namesakes, equal text, or extension instances', async () => {
    const { capture, tool } = await setup();
    const first = observation();
    const second = { ...first, observationId: randomUUID() };
    expect((await capture(first)).statusCode).toBe(202);
    expect((await capture(second, randomUUID())).statusCode).toBe(202);
    const messages = (await tool('whatsapp_get_messages')).items;
    expect(messages).toHaveLength(2);
    expect(
      new Set(messages.map((item: { conversationId: string }) => item.conversationId)).size,
    ).toBe(2);
    expect((await tool('whatsapp_search_contacts', { query: 'Synthetic' })).items).toHaveLength(2);
    expect((await capture(first, randomUUID())).statusCode).toBe(409);
    expect((await capture({ ...first, content: 'Conflicting synthetic body' })).statusCode).toBe(
      409,
    );
    expect((await tool('whatsapp_get_messages')).items).toHaveLength(2);
  });

  it('keeps unknown direction and activity staged without manufacturing messages', async () => {
    const { db, capture, tool } = await setup();
    expect((await capture(observation({ direction: 'UNKNOWN' }))).statusCode).toBe(202);
    expect(
      (
        await capture(
          observation({
            observationType: 'CONVERSATION_ACTIVITY',
            direction: 'UNKNOWN',
            captureState: 'DETECTED',
            content: null,
            contentAvailability: 'UNAVAILABLE',
            senderLabel: null,
            media: [],
          }),
        )
      ).statusCode,
    ).toBe(202);
    expect((await tool('whatsapp_get_unread')).items).toHaveLength(0);
    expect((await tool('whatsapp_list_conversations')).items).toHaveLength(2);
    expect((await tool('whatsapp_search_contacts', { query: 'Synthetic' })).items).toHaveLength(0);
    expect(
      db.prepare('SELECT status FROM wa_capture_normalizations ORDER BY status').all(),
    ).toEqual([{ status: 'CONVERSATION_ONLY' }, { status: 'DIRECTION_UNKNOWN' }]);
    expect(
      db.prepare("SELECT COUNT(*) n FROM wa_events WHERE aggregate_type='message'").get(),
    ).toEqual({ n: 0 });
  });

  it('preserves outbound pending content without inventing sender or media bytes', async () => {
    const { db, capture, tool } = await setup();
    expect(
      (
        await capture(
          observation({
            direction: 'OUTBOUND',
            captureState: 'PENDING',
            content: null,
            contentAvailability: 'UNAVAILABLE',
          }),
        )
      ).statusCode,
    ).toBe(202);
    const message = (await tool('whatsapp_get_messages', { direction: 'OUTBOUND' })).items[0];
    expect(message).toMatchObject({
      senderContactId: null,
      content: null,
      captureStatus: 'PENDING',
      contentAvailability: 'UNAVAILABLE',
    });
    expect(db.prepare('SELECT COUNT(*) n FROM wa_contacts').get()).toEqual({ n: 0 });
  });

  it('rolls back staging, normalization and both events if publication fails', async () => {
    const { db, capture, tool } = await setup();
    db.exec(`CREATE TRIGGER synthetic_failure BEFORE INSERT ON wa_events WHEN NEW.aggregate_type='message'
      BEGIN SELECT RAISE(ABORT,'SYNTHETIC_EVENT_FAILURE'); END;`);
    const value = observation();
    expect((await capture(value)).statusCode).toBe(500);
    for (const table of [
      'wa_capture_observations',
      'wa_capture_normalizations',
      'wa_contacts',
      'wa_conversations',
      'wa_messages',
      'wa_ai_message_state',
      'wa_media',
      'wa_events',
    ]) {
      expect(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()).toEqual({ n: 0 });
    }
    db.exec('DROP TRIGGER synthetic_failure');
    expect((await capture(value)).statusCode).toBe(202);
    expect((await tool('whatsapp_get_unread')).items).toHaveLength(1);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
});

it('returns automatic contact name and phone for inbound and outbound messages through MCP',async()=>{
  const {capture,tool}=await setup();
  const identity={version:1 as const,type:'UI_CONTEXT' as const,source:'VISIBLE_UI' as const,accountId:randomUUID(),contextId:randomUUID(),conversationKey:randomUUID(),conversationKind:'INDIVIDUAL' as const,phone:'+12025550123',confirmedAt:'2026-10-18T11:59:00.000Z'};
  for(const direction of ['INBOUND','OUTBOUND'] as const)expect((await capture(observation({identity,direction,conversation:{label:'Synthetic named contact',kind:'INDIVIDUAL'},media:[]}))).statusCode).toBe(202);
  const search=await tool('whatsapp_search_contacts',{query:'12025550123'});
  expect(search.items).toHaveLength(1);
  expect(search.items[0]).toMatchObject({displayName:'Synthetic named contact',phoneNumber:'+12025550123'});
  const conversations=await tool('whatsapp_list_conversations');
  expect(conversations.items[0]).toMatchObject({contactName:'Synthetic named contact',contactPhone:'+12025550123',groupName:null});
  const dialogue=await tool('whatsapp_get_dialogue',{conversationId:conversations.items[0].id});
  expect(dialogue.messages).toHaveLength(2);
  for(const message of dialogue.messages)expect(message).toMatchObject({contactName:'Synthetic named contact',contactPhone:'+12025550123',groupName:null});
});

it('accepts a direct-number MCP intent without an existing recipient conversation',async()=>{
  const {db,app,tool}=await setup(true);
  const identity={version:1 as const,type:'UI_CONTEXT' as const,source:'VISIBLE_UI' as const,accountId:randomUUID(),contextId:randomUUID(),conversationKey:randomUUID(),conversationKind:'INDIVIDUAL' as const,confirmedAt:new Date().toISOString()};
  expect((await app.inject({method:'POST',url:'/api/extension/outbox/poll',headers:{authorization:`Bearer ${token}`},payload:{extensionInstanceId,identity,allowClaim:true}})).statusCode).toBe(200);
  const created=await tool('whatsapp_send_to_number',{phoneNumber:'+1 (202) 555-0199',text:'Synthetic direct-number message',mode:'AUTO',explicitAuthorization:true,idempotencyKey:'synthetic-sdk-direct-number'});
  expect(created).toMatchObject({status:'REQUESTED',inserted:true});
  expect(db.prepare('SELECT count(*) n FROM wa_conversations').get()).toEqual({n:1});
  const status=await tool('whatsapp_get_outbox_status',{id:created.id});
  expect(JSON.parse(status.command.payload_json)).toMatchObject({recipientPhone:'+12025550199',locateByPhone:true,target:{accountId:identity.accountId}});
});

it('resolves a named MCP request through SQLite and persists only a phone-search intent',async()=>{
  const {app,tool}=await setup(true);
  const identity={version:1 as const,type:'UI_CONTEXT' as const,source:'VISIBLE_UI' as const,accountId:randomUUID(),contextId:randomUUID(),conversationKey:randomUUID(),conversationKind:'INDIVIDUAL' as const,phone:'+12025550199',confirmedAt:new Date().toISOString()};
  expect((await app.inject({method:'POST',url:'/api/extension/outbox/poll',headers:{authorization:`Bearer ${token}`},payload:{extensionInstanceId,identity,conversationLabel:'Synthetic Esposa',allowClaim:true,ready:false}})).statusCode).toBe(200);
  const created=await tool('whatsapp_send_to_contact',{recipientName:'esposa',text:'Synthetic named request',mode:'SUPERVISED',explicitAuthorization:true,idempotencyKey:'synthetic-sdk-named-contact'});
  const status=await tool('whatsapp_get_outbox_status',{id:created.id});
  expect(status.command.status).toBe('REQUESTED');
  expect(JSON.parse(status.command.payload_json)).toMatchObject({recipientPhone:'+12025550199',locateByPhone:true,nameRequest:{recipientName:'esposa'}});
});

it('correlates MCP/API/SQLite sends and capture reads without retaining private payload in logs',async()=>{
 const {db,app,tool,capture,api}=await setup(true,true);
 const identity={version:1 as const,type:'UI_CONTEXT' as const,source:'VISIBLE_UI' as const,accountId:randomUUID(),contextId:randomUUID(),conversationKey:randomUUID(),conversationKind:'INDIVIDUAL' as const,phone:'+12025550199',confirmedAt:new Date().toISOString()};
 await app.inject({method:'POST',url:'/api/extension/outbox/poll',headers:{authorization:`Bearer ${token}`},payload:{extensionInstanceId,identity,conversationLabel:'SYNTHETIC_PRIVATE_NAME'}});
 const created=await tool('whatsapp_send_to_number',{phoneNumber:identity.phone,text:'SYNTHETIC_PRIVATE_TEXT',mode:'SUPERVISED',explicitAuthorization:true,idempotencyKey:'synthetic-flow-command-key'});await api.flushLogs();
 const logs=await tool('whatsapp_get_flow_logs',{resourceId:created.id});expect(logs.commandStatus).toBe('REQUESTED');expect(logs.resolvedTraceId).toBe(created.traceId);expect(new Set(logs.items.map((e:{component:string})=>e.component))).toEqual(new Set(['MCP','API','SQLITE']));
 const text=JSON.stringify(logs);for(const secret of ['SYNTHETIC_PRIVATE_TEXT','SYNTHETIC_PRIVATE_NAME',identity.phone,token])expect(text).not.toContain(secret);
 const value=observation({identity,conversation:{label:'SYNTHETIC_PRIVATE_NAME',kind:'INDIVIDUAL'},content:'SYNTHETIC_PRIVATE_CAPTURE',media:[],observedAt:new Date(Date.now()+1000).toISOString()});expect((await capture(value)).statusCode).toBe(202);
 await tool('whatsapp_get_messages');await api.flushLogs();const captureLogs=await tool('whatsapp_get_flow_logs',{resourceId:value.observationId});expect(captureLogs.items).toContainEqual(expect.objectContaining({component:'MCP',phase:'CAPTURE_READ'}));expect(JSON.stringify(captureLogs)).not.toContain(value.content!);
 const denied=await app.inject({method:'POST',url:'/api/diagnostics/logs',payload:{events:[]}});expect(denied.statusCode).toBe(401);
 const before=db.prepare('SELECT count(*) n FROM wa_flow_logs').get();const invalid=await app.inject({method:'POST',url:'/api/diagnostics/logs',headers:{authorization:`Bearer ${token}`},payload:{events:[{text:'SYNTHETIC_PRIVATE_INPUT'}]}});expect(invalid.statusCode).toBe(400);expect(db.prepare('SELECT count(*) n FROM wa_flow_logs').get()).toEqual(before);
});

it('persists revisions and late attachments once, retains originals and does not mark messages read',async()=>{
 const {db,capture,tool}=await setup();
 const identity={version:1 as const,type:'UI_CONTEXT' as const,source:'VISIBLE_UI' as const,accountId:randomUUID(),contextId:randomUUID(),conversationKey:randomUUID(),conversationKind:'INDIVIDUAL' as const,confirmedAt:'2026-10-18T12:00:00.000Z'};
 const first=observation({identity,conversation:{label:'Synthetic revision contact',kind:'INDIVIDUAL'},media:[],messageRef:{key:randomUUID(),revision:1,firstObservedAt:'2026-10-18T12:00:00.000Z'}});
 expect((await capture(first)).statusCode).toBe(202);
 const edited=observation({...first,observationId:randomUUID(),observedAt:'2026-10-18T12:01:00.000Z',content:'Synthetic edited content',media:['AUDIO'],messageRef:{...first.messageRef!,revision:2}});
 expect((await capture(edited)).statusCode).toBe(202);
 expect((await capture(edited)).json().duplicate).toBe(true);
 const id=(db.prepare('SELECT id FROM wa_conversations').get() as {id:string}).id;
 const result=await tool('whatsapp_get_dialogue',{conversationId:id,limit:20});
 expect(result.messages).toHaveLength(1);expect(result.messages[0]).toMatchObject({content:edited.content,sequence:1,sourceObservationId:edited.observationId});
 expect(result.captureCoverage).toMatchObject({messageCount:1,complete:false,scope:'OBSERVED_UI_ONLY'});
 expect(JSON.parse((db.prepare('SELECT payload_json FROM wa_capture_observations WHERE id=?').get(first.observationId) as {payload_json:string}).payload_json).content).toBe(first.content);
 expect(result.messages[0].media).toEqual([expect.objectContaining({kind:'AUDIO',availability:'UNAVAILABLE'})]);
 expect(db.prepare('SELECT count(*) n FROM wa_media').get()).toEqual({n:1});
 expect(db.prepare('SELECT state FROM wa_ai_message_state').get()).toMatchObject({state:'UNREAD'});
 expect(db.prepare("SELECT count(*) n FROM wa_events WHERE event_type='message.updated' AND aggregate_type='message'").get()).toEqual({n:1});
 const bad=await capture({...edited,observationId:randomUUID(),messageRef:{...edited.messageRef!,revision:3},direction:'OUTBOUND'});
 expect(bad.statusCode).toBe(409);expect(db.prepare('SELECT count(*) n FROM wa_messages').get()).toEqual({n:1});
});

it('keeps the latest revision when arrivals are out of order and rejects a foreign conversation reference',async()=>{
 const {db,capture}=await setup();
 const identity={version:1 as const,type:'UI_CONTEXT' as const,source:'VISIBLE_UI' as const,accountId:randomUUID(),contextId:randomUUID(),conversationKey:randomUUID(),conversationKind:'INDIVIDUAL' as const,confirmedAt:'2026-10-18T12:00:00.000Z'};
 const latest=observation({identity,conversation:{label:'Synthetic order',kind:'INDIVIDUAL'},media:[],observedAt:'2026-10-18T12:03:00.000Z',content:'Synthetic latest',messageRef:{key:randomUUID(),revision:3,firstObservedAt:'2026-10-18T12:00:00.000Z'}});
 expect((await capture(latest)).statusCode).toBe(202);
 expect((await capture({...latest,observationId:randomUUID(),content:'Synthetic older',observedAt:'2026-10-18T12:01:00.000Z',messageRef:{...latest.messageRef!,revision:1}})).statusCode).toBe(202);
 expect(db.prepare('SELECT content FROM wa_messages').all()).toEqual([{content:'Synthetic latest'}]);
 const foreign={...latest,observationId:randomUUID(),messageRef:{...latest.messageRef!,revision:4},identity:{...identity,conversationKey:randomUUID()}};
 expect((await capture(foreign)).statusCode).toBe(409);
 expect(db.prepare('SELECT count(*) n FROM wa_conversations').get()).toEqual({n:1});
});

it('links closed-row activity to its later dialogue and reports unavailable coverage through MCP',async()=>{
 const {db,capture,tool}=await setup();
 const identity={version:1 as const,type:'UI_CONTEXT' as const,source:'VISIBLE_UI' as const,accountId:randomUUID(),contextId:randomUUID(),conversationKey:randomUUID(),conversationKind:'UNKNOWN' as const,confirmedAt:'2026-10-18T12:00:00.000Z'};
 const activity=observation({identity,conversation:{label:'Synthetic closed contact',kind:'UNKNOWN'},observationType:'CONVERSATION_ACTIVITY',captureState:'DETECTED',direction:'UNKNOWN',content:null,contentAvailability:'UNAVAILABLE',media:[]});
 expect((await capture(activity)).statusCode).toBe(202);
 const conversationId=(db.prepare('SELECT id FROM wa_conversations').get() as {id:string}).id;
 const found=await tool('whatsapp_list_conversations',{query:'closed contact',limit:20});expect(found.items).toHaveLength(1);expect(found.items[0].id).toBe(conversationId);
 const before=await tool('whatsapp_get_dialogue',{conversationId,limit:20});
 expect(before.messages).toEqual([]);expect(before.captureCoverage).toMatchObject({activitySignalCount:1,messageCount:0,complete:false,recentActivity:[{observationId:activity.observationId,observedAt:activity.observedAt}]});
 const msg=observation({identity:{...identity,conversationKind:'INDIVIDUAL'},conversation:{label:'Synthetic closed contact',kind:'INDIVIDUAL'},media:['DOCUMENT'],content:null,contentAvailability:'UNAVAILABLE',captureState:'PENDING'});
 expect((await capture(msg)).statusCode).toBe(202);
 const after=await tool('whatsapp_get_dialogue',{conversationId,limit:20});
 expect(after.messages).toHaveLength(1);expect(after.captureCoverage).toMatchObject({activitySignalCount:1,messageCount:1,unavailableMessageCount:1,complete:false});
 expect(db.prepare('SELECT count(*) n FROM wa_conversations').get()).toEqual({n:1});
});

it('promotes a direction-unknown shell to one available message after later DOM hydration',async()=>{
 const {db,capture,tool}=await setup();
 const shell=observation({conversation:{label:'Synthetic shell',kind:'INDIVIDUAL'},direction:'UNKNOWN',content:null,contentAvailability:'UNAVAILABLE',captureState:'PENDING',media:[],messageRef:{key:randomUUID(),revision:1,firstObservedAt:'2026-10-18T12:00:00.000Z'}});
 expect((await capture(shell)).statusCode).toBe(202);
 expect(db.prepare('SELECT count(*) n FROM wa_messages').get()).toEqual({n:0});
 const hydrated={...shell,observationId:randomUUID(),observedAt:'2026-10-18T12:01:00.000Z',direction:'OUTBOUND' as const,content:'Synthetic synchronized phone message',contentAvailability:'AVAILABLE' as const,captureState:'CAPTURED' as const,messageRef:{...shell.messageRef!,revision:2}};
 expect((await capture(hydrated)).statusCode).toBe(202);
 const conversationId=(db.prepare('SELECT id FROM wa_conversations').get() as {id:string}).id;
 const dialogue=await tool('whatsapp_get_dialogue',{conversationId,limit:20});expect(dialogue.messages).toHaveLength(1);expect(dialogue.messages[0]).toMatchObject({direction:'OUTBOUND',content:hydrated.content,sequence:1});
});
