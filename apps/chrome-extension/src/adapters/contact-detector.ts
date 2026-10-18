export class ContactDetector {
  conversationLabel(root: HTMLElement): string | null {
    const label = root.getAttribute('aria-label') ??
      root.querySelector<HTMLElement>('header [title]')?.getAttribute('title') ??
      root.querySelector<HTMLElement>('header [aria-label]')?.getAttribute('aria-label');
    return label?.trim().slice(0, 256) || null;
  }

  senderLabel(message: HTMLElement): string | null {
    const label = message.dataset.waiSender ??
      message.querySelector<HTMLElement>('[data-testid="author"], [data-wai-sender-label]')?.textContent;
    return label?.trim().slice(0, 256) || null;
  }
}
