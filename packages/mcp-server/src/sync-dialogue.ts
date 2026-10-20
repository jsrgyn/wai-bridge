import { DialogueSyncRequestSchema, DialogueSyncResultSchema } from '@wai-bridge/shared';
import type { LocalApiClient } from './client.js';
import { getDialogue } from './dialogue.js';

export async function syncDialogue(
  api: LocalApiClient,
  input: {
    query: string;
    conversationId?: string | undefined;
    accountId?: string | undefined;
    limit: number;
    idempotencyKey?: string | undefined;
  },
) {
  const request = DialogueSyncRequestSchema.parse({
    query: input.query,
    limit: input.limit,
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    ...(input.accountId ? { accountId: input.accountId } : {}),
    idempotencyKey: input.idempotencyKey ?? crypto.randomUUID(),
  });
  let sync = DialogueSyncResultSchema.parse(
    await api.request('/api/dialogue-sync', undefined, {
      method: 'POST',
      body: JSON.stringify(request),
    }),
  );
  const deadline = Date.now() + 18000;
  while (['REQUESTED', 'CLAIMED'].includes(sync.status) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    sync = DialogueSyncResultSchema.parse(await api.request(`/api/dialogue-sync/${sync.id}`));
  }
  return syncStatusDialogue(api, sync.id, input.limit);
}
export async function syncStatusDialogue(api: LocalApiClient, id: string, limit: number) {
  const sync = DialogueSyncResultSchema.parse(await api.request(`/api/dialogue-sync/${id}`));
  return {
    sync,
    synchronized: sync.status === 'SUCCEEDED',
    dialogue:
      sync.status === 'SUCCEEDED' && sync.conversationId
        ? await getDialogue(api, {
            conversationId: sync.conversationId,
            limit,
            syncRequestId: sync.id,
          })
        : null,
  };
}
