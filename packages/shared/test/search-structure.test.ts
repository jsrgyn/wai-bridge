import { describe, expect, it } from 'vitest';
import {
  SearchStructureReportSchema,
  appendSearchDiagnostic,
  type SearchStructureReport,
} from '../src/search-structure.js';

const scope = {
  containerPresent: true,
  visibleRowCount: 1,
  listitemCount: 0,
  rowCount: 1,
  gridcellCount: 0,
  headingCount: 0,
  cellFrameTitleCount: 1,
  ariaBusyCount: 0,
  testIds: ['cell-frame-container'],
};
const report: SearchStructureReport = {
  version: 1,
  capturedAt: '2026-10-26T12:00:00.000Z',
  searchInputPresent: true,
  newChatButtonPresent: false,
  scopes: { paneSide: scope, newChatDrawer: { ...scope, containerPresent: false } },
};
describe('search structure report', () => {
  it('accepts a structural report and rejects extra fields or text-like testids', () => {
    expect(SearchStructureReportSchema.safeParse(report).success).toBe(true);
    expect(SearchStructureReportSchema.safeParse({ ...report, text: 'x' }).success).toBe(false);
    expect(
      SearchStructureReportSchema.safeParse({
        ...report,
        scopes: { ...report.scopes, paneSide: { ...scope, testIds: ['has space'] } },
      }).success,
    ).toBe(false);
    expect(
      SearchStructureReportSchema.safeParse({
        ...report,
        scopes: { ...report.scopes, paneSide: { ...scope, testIds: Array(41).fill('a') } },
      }).success,
    ).toBe(false);
  });
  it('keeps the newest three entries and discards invalid stored data', () => {
    let list = appendSearchDiagnostic('garbage', {
      code: 'PHONE_CONTACT_NOT_FOUND',
      recordedAt: report.capturedAt,
      report,
    });
    for (let i = 0; i < 4; i++)
      list = appendSearchDiagnostic(list, {
        code: i % 2 ? 'PHONE_CONTACT_NOT_FOUND' : 'SEARCH_RESULTS_NOT_READY',
        recordedAt: `2026-10-26T12:00:0${i + 1}.000Z`,
        report,
      });
    expect(list).toHaveLength(3);
    expect(list[0]!.recordedAt).toBe('2026-10-26T12:00:04.000Z');
  });
});
