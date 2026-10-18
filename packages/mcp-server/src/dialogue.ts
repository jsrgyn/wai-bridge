import { z } from 'zod';
import type { LocalApiClient } from './client.js';

const ConversationSchema = z.object({ id: z.uuid() }).passthrough();
const MessageSchema = z
  .object({
    id: z.uuid(),
    conversationId: z.uuid(),
    direction: z.enum(['INBOUND', 'OUTBOUND']),
    sequence: z.number().int().positive(),
    content: z.string().nullable(),
    contentAvailability: z.enum(['AVAILABLE', 'UNAVAILABLE']),
    observedAt: z.iso.datetime(),
  })
  .passthrough();

/** Reads only the selected persisted conversation. Never scans WhatsApp history. */
export async function getDialogue(
  api: LocalApiClient,
  input: { conversationId: string; limit: number; cursor?: string | undefined },
) {
  const conversation = ConversationSchema.parse(
    await api.request(`/api/conversations/${input.conversationId}`),
  );
  if (conversation.id !== input.conversationId) throw new Error('Dialogue conversation mismatch');
  const params = new URLSearchParams({ limit: String(input.limit) });
  if (input.cursor) params.set('cursor', input.cursor);
  const page = await api.page(`/api/conversations/${input.conversationId}/messages?${params}`);
  const messages = z.array(MessageSchema).parse(page.items);
  if (messages.some((message) => message.conversationId !== input.conversationId))
    throw new Error('Dialogue message conversation mismatch');
  messages.sort((a, b) => a.sequence - b.sequence);
  return {
    conversation,
    messages: messages.map((message) => ({
      ...message,
      speaker: message.direction === 'OUTBOUND' ? 'LOCAL_USER' : 'REMOTE_PARTICIPANT',
    })),
    order: 'ASC',
    nextCursor: page.nextCursor,
    cursorDirection: 'OLDER',
    coverage: 'OBSERVED_MESSAGES_ONLY',
    accountWideCoverage: false,
    previousHistoryImported: false,
    identityContinuity: conversation.identitySource === 'VISIBLE_UI' ? 'CURRENT_UI_REFERENCE' : 'REGISTERED_REFERENCE',
  };
}
