/** Read rendered text/emoji nodes, without reading WhatsApp application state. */
export function messageText(element: Element): string {
  const visit = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
    if (!(node instanceof Element)) return '';
    if (node.tagName === 'IMG') return node.getAttribute('alt') ?? '';
    if (node.tagName === 'BR') return '\n';
    const text = Array.from(node.childNodes).map(visit).join('');
    return text + (node.tagName === 'DIV' ? '\n' : '');
  };
  return visit(element)
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n/g, '\n')
    .trim()
    .normalize('NFC');
}
