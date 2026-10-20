/** Rendered contact/group name, excluding the unread badge in its container. */
export function conversationRowLabel(row: Element): string | null {
  const title = row.querySelector('[data-testid="cell-frame-title"]');
  const names = title
    ? [...title.querySelectorAll('[title]')].filter((e) => e.getAttribute('title')?.trim())
    : [];
  if (names.length > 1) return null;
  return (
    ((names[0] ?? title)?.textContent ?? row.getAttribute('aria-label'))?.trim().slice(0, 256) ||
    null
  );
}
