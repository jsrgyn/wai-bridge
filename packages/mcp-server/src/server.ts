import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { LocalApiClient } from './client.js';

const PageInput = z.object({ cursor: z.string().max(256).optional(), limit: z.number().int().min(1).max(50).default(20) }).strict();
const UuidInput = z.object({ id: z.uuid() }).strict();
const MessageInput = PageInput.extend({ conversationId: z.uuid().optional(), direction: z.enum(['INBOUND', 'OUTBOUND']).optional(), captureStatus: z.enum(['DETECTED', 'CAPTURED', 'PENDING', 'FAILED']).optional(), aiState: z.enum(['UNREAD', 'CLAIMED', 'READ', 'FAILED']).optional() }).strict();
const SearchInput = PageInput.extend({ query: z.string().trim().min(2).max(100) }).strict();
const PrepareInput = z.object({ recipientId: z.uuid(), text: z.string().trim().min(1).max(10000), mode: z.enum(['AUTO', 'SUPERVISED']).default('SUPERVISED') }).strict();
const RequestSendInput = PrepareInput.extend({ authorization: z.literal(true), idempotencyKey: z.string().min(16).max(128) }).strict();

function pageQuery(input: z.infer<typeof PageInput>): string {
  const params = new URLSearchParams({ limit: String(input.limit) });
  if (input.cursor) params.set('cursor', input.cursor);
  return params.toString();
}
function safeResult(value: unknown): { content: { type: 'text'; text: string }[]; isError?: boolean } {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}
function tool<S extends z.ZodRawShape>(server: McpServer, name: string, description: string, shape: S, handler: (input: z.output<z.ZodObject<S>>) => Promise<unknown>, annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean }) {
  server.registerTool(name, { description, inputSchema: z.object(shape), ...(annotations ? { annotations } : {}) }, async (input) => {
    try { return safeResult(await handler(input as z.output<z.ZodObject<S>>)); }
    catch (error) {
      const message = error instanceof Error ? error.message : 'Unexpected MCP tool error';
      return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
    }
  });
}

export interface McpOptions { readonly api: LocalApiClient; readonly allowWrites?: boolean; }

export function createMcpServer({ api, allowWrites = false }: McpOptions): McpServer {
  const server = new McpServer({ name: 'wai-bridge', version: '0.1.0' });
  tool(server, 'whatsapp_status', 'Get Local API and database status.', {}, () => api.request('/api/status'), { readOnlyHint: true });
  tool(server, 'whatsapp_search_contacts', 'Search contacts. Returns a bounded page; pass nextCursor to continue.', SearchInput.shape, (i) => api.page(`/api/contacts/search?${new URLSearchParams({ q: i.query, limit: String(i.limit), ...(i.cursor ? { cursor: i.cursor } : {}) })}`), { readOnlyHint: true });
  tool(server, 'whatsapp_list_conversations', 'List conversations with cursor pagination.', PageInput.shape, (i) => api.page(`/api/conversations?${pageQuery(i)}`), { readOnlyHint: true });
  tool(server, 'whatsapp_list_groups', 'List group conversations from the bounded conversations page.', PageInput.shape, async (i) => { const result = await api.page(`/api/conversations?${pageQuery(i)}`); return { ...result, items: result.items.filter((x) => (x as { kind?: unknown }).kind === 'GROUP') }; }, { readOnlyHint: true });
  tool(server, 'whatsapp_get_conversation', 'Get one conversation by UUID.', UuidInput.shape, (i) => api.request(`/api/conversations/${i.id}`), { readOnlyHint: true });
  tool(server, 'whatsapp_get_messages', 'Get messages with filters and cursor pagination.', MessageInput.shape, (i) => { const { cursor, limit, ...filters } = i; const params = new URLSearchParams({ limit: String(limit) }); if (cursor) params.set('cursor', cursor); for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value); return api.page(`/api/messages?${params}`); }, { readOnlyHint: true });
  tool(server, 'whatsapp_get_unread', 'Get AI-unread messages, without changing their state.', PageInput.shape, (i) => api.page(`/api/messages/unread?${pageQuery(i)}`), { readOnlyHint: true });
  tool(server, 'whatsapp_get_recent', 'Get recent messages with cursor pagination.', PageInput.shape, (i) => api.page(`/api/messages/recent?${pageQuery(i)}`), { readOnlyHint: true });
  tool(server, 'whatsapp_get_media', 'Get media metadata only; filesystem paths and media bytes are never exposed.', UuidInput.shape, (i) => api.request(`/api/media/${i.id}`), { readOnlyHint: true });
  tool(server, 'whatsapp_get_pending_tasks', 'List pending persisted events. Notifications do not guarantee AI execution.', PageInput.shape, (i) => api.page(`/api/events/pending?${pageQuery(i)}`), { readOnlyHint: true });

  tool(server, 'whatsapp_prepare_message', 'Validate and preview a message request without persisting or sending it. Recipient existence is verified only when submitting the request.', PrepareInput.shape, async (i) => ({ recipientId: i.recipientId, text: i.text, mode: i.mode, persisted: false, sent: false, recipientVerified: false }), { readOnlyHint: true });
  tool(server, 'whatsapp_request_send', 'Persist an explicitly authorized send request. This does not execute a WhatsApp send.', RequestSendInput.shape, async (i) => {
    if (!allowWrites) throw new Error('Write tools are disabled by MCP server configuration');
    const body = { recipientId: i.recipientId, text: i.text, mode: i.mode, explicitAuthorization: true };
    return api.request('/api/outbox', z.unknown(), { method: 'POST', headers: { 'idempotency-key': i.idempotencyKey }, body: JSON.stringify(body) });
  }, { destructiveHint: false, idempotentHint: true });
  tool(server, 'whatsapp_get_outbox_status', 'Get a page of persisted outbox commands, or one command by UUID.', { id: z.uuid().optional(), ...PageInput.shape }, (i) => i.id ? api.request(`/api/outbox/${i.id}`) : api.page(`/api/outbox?${pageQuery(i)}`), { readOnlyHint: true });
  tool(server, 'whatsapp_cancel_send', 'Cancel a persisted outbox command. Requires write tools enabled.', { id: z.uuid(), idempotencyKey: z.string().min(16).max(128) }, async (i) => {
    if (!allowWrites) throw new Error('Write tools are disabled by MCP server configuration');
    return api.request(`/api/outbox/${i.id}/cancel`, z.unknown(), { method: 'POST', headers: { 'idempotency-key': i.idempotencyKey }, body: '{}' });
  }, { destructiveHint: false, idempotentHint: true });
  return server;
}

