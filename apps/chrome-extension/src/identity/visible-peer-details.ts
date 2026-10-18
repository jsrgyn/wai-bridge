import { normalizeProfilePhone } from '@wai-bridge/shared';

/** Read only the displayed profile whose name matches the active chat. */
export function visiblePeerDetails(
  doc: Document,
  label: string,
): {
  kind: 'INDIVIDUAL' | 'GROUP' | 'UNKNOWN';
  phone?: string;
} {
  const visible = (element: Element) => {
    const rect = element.getBoundingClientRect();
    if (
      rect.width <= 0 ||
      rect.height <= 0 ||
      rect.bottom <= 0 ||
      rect.right <= 0 ||
      rect.top >= (doc.defaultView?.innerHeight ?? 0) ||
      rect.left >= (doc.defaultView?.innerWidth ?? 0)
    )
      return false;
    for (let current: Element | null = element; current; current = current.parentElement) {
      const style = doc.defaultView?.getComputedStyle(current);
      if (
        !style ||
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.visibility === 'collapse' ||
        Number(style.opacity) === 0
      )
        return false;
    }
    return true;
  };
  const drawers = [...doc.querySelectorAll('[data-testid="chat-info-drawer"]')].filter(visible);
  if (drawers.length !== 1) return { kind: 'UNKNOWN' };
  const drawer = drawers[0]!;
  const leaves = [...drawer.querySelectorAll('span,div,h1,h2,h3')].filter(
    (element) => element.children.length === 0,
  );
  if (!leaves.some((element) => element.textContent?.trim() === label && visible(element)))
    return { kind: 'UNKNOWN' };
  const group = drawer.querySelector('[data-testid="group-info-header"]');
  const contact = drawer.querySelector('[data-testid="contact-info-header"]');
  if (group && !contact && visible(group)) return { kind: 'GROUP' };
  if (!contact || group || !visible(contact)) return { kind: 'UNKNOWN' };
  const phones = new Set(
    leaves
      .map((element) => ({ element, phone: normalizeProfilePhone(element.textContent ?? '') }))
      .filter(({ element, phone }) => phone !== null && visible(element))
      .map(({ phone }) => phone)
      .filter((phone): phone is string => phone !== null),
  );
  return { kind: 'INDIVIDUAL', ...(phones.size === 1 ? { phone: [...phones][0]! } : {}) };
}
