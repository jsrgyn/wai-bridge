import { z } from 'zod';

/**
 * Read-only structural report of WhatsApp Web search results. It carries only counts,
 * booleans and data-testid values: never text, labels, titles, links or other attributes.
 */
export const SEARCH_STRUCTURE_MAX_TESTIDS = 40;
export const SEARCH_STRUCTURE_TESTID_MAX_LENGTH = 64;
const count = z.number().int().min(0).max(100_000);
export const SearchStructureScopeSchema = z
  .object({
    containerPresent: z.boolean(),
    visibleRowCount: count,
    listitemCount: count,
    rowCount: count,
    gridcellCount: count,
    headingCount: count,
    cellFrameTitleCount: count,
    ariaBusyCount: count,
    testIds: z
      .array(
        z
          .string()
          .min(1)
          .max(SEARCH_STRUCTURE_TESTID_MAX_LENGTH)
          .regex(/^[A-Za-z0-9_:.-]+$/),
      )
      .max(SEARCH_STRUCTURE_MAX_TESTIDS),
  })
  .strict();
export const SearchStructureReportSchema = z
  .object({
    version: z.literal(1),
    capturedAt: z.iso.datetime({ offset: true }),
    searchInputPresent: z.boolean(),
    newChatButtonPresent: z.boolean(),
    scopes: z
      .object({
        paneSide: SearchStructureScopeSchema,
        newChatDrawer: SearchStructureScopeSchema,
      })
      .strict(),
  })
  .strict();
export type SearchStructureReport = z.infer<typeof SearchStructureReportSchema>;
export const SEARCH_DIAGNOSTIC_CODES = ['PHONE_CONTACT_NOT_FOUND', 'SEARCH_RESULTS_NOT_READY'] as const;
export const SearchDiagnosticEntrySchema = z
  .object({
    code: z.enum(SEARCH_DIAGNOSTIC_CODES),
    recordedAt: z.iso.datetime({ offset: true }),
    report: SearchStructureReportSchema,
  })
  .strict();
export type SearchDiagnosticEntry = z.infer<typeof SearchDiagnosticEntrySchema>;
export const SEARCH_DIAGNOSTICS_KEY = 'waiSearchDiagnostics';
export const SEARCH_DIAGNOSTICS_LIMIT = 3;
export const SearchDiagnosticListSchema = z
  .array(SearchDiagnosticEntrySchema)
  .max(SEARCH_DIAGNOSTICS_LIMIT);
/** Newest first, bounded; invalid stored values are discarded rather than trusted. */
export function appendSearchDiagnostic(
  stored: unknown,
  entry: SearchDiagnosticEntry,
): SearchDiagnosticEntry[] {
  const previous = SearchDiagnosticListSchema.safeParse(stored);
  return [entry, ...(previous.success ? previous.data : [])].slice(0, SEARCH_DIAGNOSTICS_LIMIT);
}
