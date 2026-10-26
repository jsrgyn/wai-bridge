import { describe, expect, it } from 'vitest';
import { SearchStructureReportSchema } from '@wai-bridge/shared';
import { buildSearchStructureReport } from '../../src/content/search-structure.js';

type FakeElement = {
  visible: boolean;
  testId: string | undefined;
  text: string;
  label?: string;
  getAttribute(name: string): string | null;
};
function el(testId?: string, visible = true): FakeElement {
  return {
    visible,
    testId,
    text: 'Synthetic Person +1 202 555 0199',
    label: 'Synthetic label',
    getAttribute: (name) => (name === 'data-testid' ? (testId ?? null) : 'Synthetic leak'),
  };
}
function scope(map: Record<string, FakeElement[]>) {
  return {
    querySelectorAll: (selector: string) => map[selector] ?? [],
    querySelector: () => null,
  };
}
describe('search structure report builder', () => {
  it('reports only counts and bounded testids from a synthetic DOM', () => {
    const rows = [el('cell-frame-container'), el('cell-frame-container'), el('cell-frame-container', false)];
    const testIds = [
      ...rows,
      el('cell-frame-title'),
      el('x'.repeat(100)),
      el('bad value'),
      ...Array.from({ length: 50 }, (_, i) => el(`synthetic-id-${i}`)),
    ];
    const pane = scope({
      '[data-testid="cell-frame-container"]': rows,
      '[role="listitem"]': [el()],
      '[role="row"]': [el(), el(), el()],
      '[role="gridcell"]': [],
      '[role="heading"]': [el()],
      '[data-testid="cell-frame-title"]': [el(), el()],
      '[aria-busy="true"]': [el()],
      '[data-testid]': testIds,
    });
    const root = {
      querySelector: (selector: string) =>
        selector === '#pane-side'
          ? pane
          : selector.includes('new-chat') || selector.includes('Nova conversa')
            ? null
            : selector.includes('input') || selector.includes('textbox')
              ? el()
              : null,
    };
    const report = buildSearchStructureReport(
      root as never,
      (element) => (element as unknown as FakeElement).visible,
      new Date('2026-10-26T12:00:00.000Z'),
    );
    expect(SearchStructureReportSchema.parse(report)).toEqual(report);
    expect(report.searchInputPresent).toBe(true);
    expect(report.newChatButtonPresent).toBe(false);
    expect(report.scopes.newChatDrawer.containerPresent).toBe(false);
    const side = report.scopes.paneSide;
    expect(side).toMatchObject({
      containerPresent: true,
      visibleRowCount: 2,
      listitemCount: 1,
      rowCount: 3,
      gridcellCount: 0,
      headingCount: 1,
      cellFrameTitleCount: 2,
      ariaBusyCount: 1,
    });
    expect(side.testIds).toHaveLength(40);
    expect(side.testIds[0]).toBe('cell-frame-container');
    expect(side.testIds).toContain('x'.repeat(64));
    expect(side.testIds).not.toContain('bad value');
    const serialized = JSON.stringify({ ...report, capturedAt: undefined });
    expect(serialized).not.toMatch(/Synthetic|\d{4}/);
  });
});
