export class GroupDetector {
  kind(root: HTMLElement): 'INDIVIDUAL' | 'GROUP' | 'UNKNOWN' {
    const explicit = root.dataset.waiConversationType;
    if (explicit === 'GROUP' || explicit === 'INDIVIDUAL') return explicit;
    const group = root.querySelector('header [aria-label="Dados do grupo"], header [aria-label="Group info"]');
    if (group) return 'GROUP';
    return root.querySelector('header [data-wai-group-indicator], header [aria-label*="participants" i]') ? 'GROUP' : 'UNKNOWN';
  }
}
