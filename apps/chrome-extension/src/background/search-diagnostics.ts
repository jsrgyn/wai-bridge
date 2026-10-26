import { z } from 'zod';
import {
  SEARCH_DIAGNOSTICS_KEY,
  SearchStructureReportSchema,
  appendSearchDiagnostic,
  type SearchDiagnosticEntry,
  type SearchStructureReport,
} from '@wai-bridge/shared';

const ReplySchema = z.object({ ok: z.literal(true), report: SearchStructureReportSchema }).strict();
type Tabs = Pick<typeof chrome.tabs, 'sendMessage'>;
type Storage = Pick<typeof chrome.storage.local, 'get' | 'set'>;

/** Read-only request: the content script only counts structure, never types or clicks. */
export async function requestSearchStructure(
  tabs: Tabs,
  tabId: number,
  timeoutMs = 2000,
): Promise<SearchStructureReport> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reply = await Promise.race([
      tabs.sendMessage(tabId, { kind: 'SEARCH_STRUCTURE' }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('CONTENT_UNREACHABLE')), timeoutMs);
      }),
    ]);
    return ReplySchema.parse(reply).report;
  } finally {
    clearTimeout(timer);
  }
}

export async function storeSearchDiagnostic(
  storage: Storage,
  entry: SearchDiagnosticEntry,
): Promise<void> {
  const stored = await storage.get(SEARCH_DIAGNOSTICS_KEY);
  await storage.set({
    [SEARCH_DIAGNOSTICS_KEY]: appendSearchDiagnostic(stored[SEARCH_DIAGNOSTICS_KEY], entry),
  });
}

export async function recordSearchDiagnostic(
  tabs: Tabs,
  storage: Storage,
  tabId: number,
  code: SearchDiagnosticEntry['code'],
  now = new Date(),
): Promise<SearchStructureReport> {
  const report = await requestSearchStructure(tabs, tabId);
  await storeSearchDiagnostic(storage, { code, recordedAt: now.toISOString(), report });
  return report;
}
