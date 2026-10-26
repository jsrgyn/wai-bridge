import {
  SEARCH_STRUCTURE_MAX_TESTIDS,
  SEARCH_STRUCTURE_TESTID_MAX_LENGTH,
  SearchStructureReportSchema,
  type SearchStructureReport,
} from '@wai-bridge/shared';

/**
 * Read-only structural snapshot of the search UI. It never reads textContent, labels,
 * titles, links or any attribute other than data-testid, and never types or clicks.
 */
type Root = Pick<ParentNode, 'querySelector'>;
type Scope = Pick<ParentNode, 'querySelectorAll'>;
const SEARCH_INPUT =
  'input[aria-label="Pesquisar ou começar uma nova conversa"],input[aria-label="Search or start a new chat"]';
const NEW_CHAT_BUTTON = 'button[aria-label="Nova conversa"],button[aria-label="New chat"]';
const TESTID_PATTERN = /^[A-Za-z0-9_:.-]+$/;
const defaultVisible = (element: Element) => element.getClientRects().length > 0;

function describeScope(scope: Scope | null, isVisible: (element: Element) => boolean) {
  const count = (selector: string) => (scope ? scope.querySelectorAll(selector).length : 0);
  const testIds: string[] = [];
  if (scope)
    for (const element of scope.querySelectorAll('[data-testid]')) {
      if (testIds.length >= SEARCH_STRUCTURE_MAX_TESTIDS) break;
      const value = (element.getAttribute('data-testid') ?? '').slice(
        0,
        SEARCH_STRUCTURE_TESTID_MAX_LENGTH,
      );
      if (TESTID_PATTERN.test(value) && !testIds.includes(value)) testIds.push(value);
    }
  return {
    containerPresent: Boolean(scope),
    visibleRowCount: scope
      ? [...scope.querySelectorAll('[data-testid="cell-frame-container"]')].filter(isVisible).length
      : 0,
    listitemCount: count('[role="listitem"]'),
    rowCount: count('[role="row"]'),
    gridcellCount: count('[role="gridcell"]'),
    headingCount: count('[role="heading"]'),
    cellFrameTitleCount: count('[data-testid="cell-frame-title"]'),
    ariaBusyCount: count('[aria-busy="true"]'),
    testIds,
  };
}

export function buildSearchStructureReport(
  root: Root,
  isVisible: (element: Element) => boolean = defaultVisible,
  now = new Date(),
): SearchStructureReport {
  return SearchStructureReportSchema.parse({
    version: 1,
    capturedAt: now.toISOString(),
    searchInputPresent: Boolean(root.querySelector(SEARCH_INPUT)),
    newChatButtonPresent: Boolean(root.querySelector(NEW_CHAT_BUTTON)),
    scopes: {
      paneSide: describeScope(root.querySelector('#pane-side'), isVisible),
      newChatDrawer: describeScope(root.querySelector('[data-testid="new-chat-drawer"]'), isVisible),
    },
  });
}
