import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalApiClient } from '../src/client.js';
import { createMcpServer } from '../src/server.js';
import { InMemoryTransport as ServerMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';

const TOKEN = 'test-token-at-least-thirty-two-characters';
const names = ['whatsapp_status','whatsapp_search_contacts','whatsapp_list_conversations','whatsapp_list_groups','whatsapp_get_conversation','whatsapp_get_messages','whatsapp_get_dialogue','whatsapp_get_unread','whatsapp_get_recent','whatsapp_get_media','whatsapp_get_pending_tasks','whatsapp_prepare_message','whatsapp_request_send','whatsapp_get_outbox_status','whatsapp_cancel_send','whatsapp_send_message','whatsapp_send_to_number','whatsapp_send_to_contact','whatsapp_cancel_extension_send'];
const closeFns: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closeFns.splice(0)) await close(); vi.restoreAllMocks(); });

function harness(fetchImpl: typeof fetch = vi.fn(async () => Response.json({ items: [], nextCursor: null })) as typeof fetch, allowWrites = false) {
  const api = new LocalApiClient({ baseUrl: 'http://127.0.0.1:47831', token: TOKEN, fetchImpl });
  const server = createMcpServer({ api, allowWrites });
  return { api, server, fetchImpl };
}
async function connect(server: ReturnType<typeof createMcpServer>) {
  const [clientTransport, serverTransport] = ServerMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([server.server.connect(serverTransport), client.connect(clientTransport)]);
  closeFns.push(async () => { await client.close(); await server.close(); });
  return client;
}

describe('MCP server', () => {
  it('registers all requested tools with separate read and write annotations', () => {
    const { server } = harness();
    const registered = (server as unknown as { _registeredTools: Record<string, { annotations?: Record<string, unknown> }> })._registeredTools;
    expect(Object.keys(registered).sort()).toEqual([...names].sort());
    expect(registered.whatsapp_get_unread?.annotations?.readOnlyHint).toBe(true);
    expect(registered.whatsapp_request_send?.annotations?.readOnlyHint).not.toBe(true);
  });

  it('enforces localhost URL, bounded page size and token length', () => {
    expect(() => new LocalApiClient({ baseUrl: 'http://example.com', token: TOKEN })).toThrow(/localhost/);
    expect(() => new LocalApiClient({ baseUrl: 'http://127.0.0.1:1', token: 'short' })).toThrow(/32 characters/);
    const { server } = harness();
    expect(server).toBeTruthy();
  });

  it('sends bearer auth and cursor query with bounded pagination', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(new URL(String(input)).searchParams.get('cursor')).toBe('cursor-1');
      expect(new URL(String(input)).searchParams.get('limit')).toBe('10');
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
      return Response.json({ items: [{ id: 'synthetic' }], nextCursor: 'cursor-2' });
    }) as typeof fetch;
    const { api } = harness(fetchImpl);
    await expect(api.page('/api/conversations?limit=10&cursor=cursor-1')).resolves.toEqual({ items: [{ id: 'synthetic' }], nextCursor: 'cursor-2' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('supports protocol discovery, validated reads, pagination output, and returned API errors', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/messages/unread') return Response.json({ items: [{ id: 'synthetic' }], nextCursor: 'next-page' });
      return Response.json({ error: { code: 'NOT_FOUND', message: 'Conversation not found', correlationId: 'synthetic' } }, { status: 404 });
    }) as typeof fetch;
    const { server } = harness(fetchImpl);
    const client = await connect(server);
    const discovered = await client.listTools();
    expect(discovered.tools.map((entry) => entry.name).sort()).toEqual([...names].sort());
    const page = await client.callTool({ name: 'whatsapp_get_unread', arguments: { limit: 1 } });
    expect(page.isError).not.toBe(true);
    expect(page.content[0]?.type === 'text' && page.content[0].text).toContain('next-page');
    const invalid = await client.callTool({ name: 'whatsapp_get_unread', arguments: { limit: 1000 } });
    expect(invalid.isError).toBe(true);
    const missing = await client.callTool({ name: 'whatsapp_get_conversation', arguments: { id: '11111111-1111-4111-8111-111111111111' } });
    expect(missing.isError).toBe(true);
    expect(missing.content[0]?.type === 'text' && missing.content[0].text).toContain('NOT_FOUND');
  });

  it('maps API errors, rejects malformed output contracts, and handles timeouts', async () => {
    const { api } = harness(vi.fn(async () => Response.json({ error: { code: 'NOT_FOUND', message: 'Missing' } }, { status: 404 })) as typeof fetch);
    await expect(api.request('/api/status')).rejects.toThrow('NOT_FOUND: Missing');
    const malformed = new LocalApiClient({ baseUrl: 'http://127.0.0.1:47831', token: TOKEN, fetchImpl: vi.fn(async () => Response.json({ items: 'bad', nextCursor: null })) as typeof fetch });
    await expect(malformed.page('/api/conversations')).rejects.toThrow(/contract/);
    const slow = new LocalApiClient({ baseUrl: 'http://127.0.0.1:47831', token: TOKEN, timeoutMs: 100, fetchImpl: ((_input: RequestInfo | URL, init?: RequestInit) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))))) as typeof fetch });
    await expect(slow.request('/api/status')).rejects.toThrow(/timed out/);
  });

  it('gates extension sends separately and forwards explicit intent without claiming delivery', async () => {
    const fetchImpl=vi.fn(async (input: RequestInfo|URL,init?:RequestInit)=>{
      expect(new URL(String(input)).pathname).toBe('/api/extension/outbox');
      expect(new Headers(init?.headers).get('idempotency-key')).toBe('synthetic-extension-key');
      expect(JSON.parse(String(init?.body))).toMatchObject({mode:'AUTO',explicitAuthorization:true,locateByPhone:true});
      return Response.json({id:'synthetic-command',status:'REQUESTED'},{status:202});
    }) as typeof fetch;
    const api=new LocalApiClient({baseUrl:'http://127.0.0.1:47831',token:TOKEN,fetchImpl});
    const args={conversationId:'11111111-1111-4111-8111-111111111111',text:'Synthetic reply',mode:'AUTO',explicitAuthorization:true,locateByPhone:true,idempotencyKey:'synthetic-extension-key'};
    const disabled=await connect(createMcpServer({api,allowWrites:true}));
    expect((await disabled.callTool({name:'whatsapp_send_message',arguments:args})).isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
    const client=await connect(createMcpServer({api,allowExtensionSends:true}));
    expect((await client.callTool({name:'whatsapp_send_message',arguments:{...args,explicitAuthorization:false}})).isError).toBe(true);
    const response=await client.callTool({name:'whatsapp_send_message',arguments:args});
    expect(response.isError).not.toBe(true);expect(JSON.stringify(response.content)).toContain('REQUESTED');expect(JSON.stringify(response.content)).not.toContain('SENT');
  });

  it('blocks writes unless enabled, preserves idempotency and never reports a send as executed', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('idempotency-key')).toBe('idempotency-key-123456');
      expect(JSON.parse(String(init?.body))).toMatchObject({ explicitAuthorization: true });
      return Response.json({ id: 'command', status: 'REQUESTED' }, { status: 202 });
    }) as typeof fetch;
    const disabled = harness(fetchImpl, false);
    const disabledClient = await connect(disabled.server);
    const denied = await disabledClient.callTool({ name: 'whatsapp_request_send', arguments: { recipientId: '11111111-1111-4111-8111-111111111111', text: 'synthetic', authorization: true, idempotencyKey: 'idempotency-key-123456' } });
    expect(denied.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
    const enabled = harness(fetchImpl, true);
    const enabledClient = await connect(enabled.server);
    const result = await enabledClient.callTool({ name: 'whatsapp_request_send', arguments: { recipientId: '11111111-1111-4111-8111-111111111111', text: 'synthetic', authorization: true, idempotencyKey: 'idempotency-key-123456' } });
    const responseText = result.content[0]?.type === 'text' ? result.content[0].text : '';
    expect(responseText).toContain('REQUESTED');
    expect(responseText).not.toContain('SENT');
  });
});
