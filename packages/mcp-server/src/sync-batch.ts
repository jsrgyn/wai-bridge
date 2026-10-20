import { DialogueSyncBatchPageSchema } from '@wai-bridge/shared';
import type { LocalApiClient } from './client.js';
import { syncStatusDialogue } from './sync-dialogue.js';
export async function getSyncBatch(
  api: LocalApiClient,
  input: { id: string; cursor?: number | undefined; limit: number; includeDialogues: boolean },
) {
  const params = new URLSearchParams({ limit: String(input.limit) });
  if (input.cursor !== undefined) params.set('cursor', String(input.cursor));
  const result = DialogueSyncBatchPageSchema.parse(
    await api.request(`/api/dialogue-sync-batches/${input.id}?${params}`),
  );
  const items = [];
  for (const item of result.items) {
    let dialogue = null;
    if (input.includeDialogues && item.status === 'SUCCEEDED' && item.syncRequestId)
      dialogue = (await syncStatusDialogue(api, item.syncRequestId, 50)).dialogue;
    items.push({ ...item, dialogue });
  }
  return { ...result, items };
}
