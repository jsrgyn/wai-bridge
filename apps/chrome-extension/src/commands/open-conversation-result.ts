/** One ordinary DOM gesture on a unique accessible result; never private handlers. */
export function openConversationResult(candidate: HTMLElement): void {
  const view = candidate.ownerDocument.defaultView!;
  const scope = candidate.closest('#pane-side,[data-testid="new-chat-drawer"]');
  if (!scope || !candidate.isConnected) throw new Error('CHAT_UNAVAILABLE');
  const actionable = candidate.closest<HTMLElement>('[role="gridcell"],[role="button"],button');
  const target = actionable && scope.contains(actionable) ? actionable : candidate;
  if (target.querySelectorAll('[data-testid="cell-frame-container"]').length > 1)
    throw new Error('AMBIGUOUS_CONTACT');
  target.focus({ preventScroll: true });
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
    if (!candidate.isConnected || !target.isConnected) return;
    const down = type.endsWith('down');
    candidate.dispatchEvent(
      type.startsWith('pointer')
        ? new view.PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            button: 0,
            buttons: down ? 1 : 0,
            pointerId: 1,
            pointerType: 'mouse',
            isPrimary: true,
          })
        : new view.MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            button: 0,
            buttons: down ? 1 : 0,
          }),
    );
  }
  if (candidate.isConnected && target.isConnected) candidate.click();
}
