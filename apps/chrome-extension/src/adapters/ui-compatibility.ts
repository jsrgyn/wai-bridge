import { UiCompatibilitySchema } from '@wai-bridge/shared';
/** Structural checks on public rendered DOM only; no protocol, script state or session access. */
export function uiCompatibility(doc: Document) {
  const roots = doc.querySelectorAll('#main');
  const headers = doc.querySelectorAll('#main header');
  const titles = doc.querySelectorAll('#main [data-testid="conversation-info-header-chat-title"]');
  const composers = doc.querySelectorAll('#main footer [contenteditable="true"]');
  const sidebar = Boolean(doc.querySelector('#pane-side'));
  const reasons: string[] = [];
  if (roots.length > 1 || headers.length > 1 || titles.length > 1 || composers.length > 1)
    reasons.push('AMBIGUOUS_STRUCTURE');
  if (roots.length === 1 && headers.length === 0) reasons.push('HEADER_UNRECOGNIZED');
  if (!roots.length && !sidebar) reasons.push('ROOT_UNRECOGNIZED');
  const unsupported = reasons.length > 0;
  const capture = !unsupported && roots.length === 1 && headers.length === 1;
  const sync = !unsupported && (sidebar || capture);
  const send = capture && composers.length === 1;
  if (capture && !send) reasons.push('COMPOSER_UNAVAILABLE');
  return UiCompatibilitySchema.parse({
    status: unsupported
      ? 'UNSUPPORTED'
      : !roots.length
        ? 'NO_CONVERSATION'
        : send
          ? 'READY'
          : 'PARTIAL',
    canCapture: capture,
    canSync: sync,
    canSend: send,
    reasons,
    checkedAt: new Date().toISOString(),
  });
}
