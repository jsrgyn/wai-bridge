import type { CaptureObservation } from '../contracts.js';
type MediaKind = CaptureObservation['media'][number];
export class MediaDetector {
  detect(message: HTMLElement): MediaKind[] {
    const media = new Set<MediaKind>();
    for (const node of message.querySelectorAll<HTMLElement>(
      '[data-wai-media],img,audio,video,[aria-label],[data-testid="document-message"],a[download]',
    )) {
      if (node.closest('[data-testid^="quoted"], [data-wai-quoted]')) continue;
      const explicit = node.dataset.waiMedia?.toUpperCase();
      const label = node.getAttribute('aria-label')?.toLowerCase() ?? '';
      if (['IMAGE', 'AUDIO', 'VIDEO', 'DOCUMENT'].includes(explicit ?? ''))
        media.add(explicit as MediaKind);
      else if (
        node.matches('audio') ||
        /reproduzir mensagem de voz|play voice message|voice message|mensagem de voz/.test(label)
      )
        media.add('AUDIO');
      else if (
        node.matches('video') ||
        /abrir vídeo|open video|reproduzir vídeo|play video/.test(label)
      )
        media.add('VIDEO');
      else if (
        node.matches('[data-testid="document-message"],a[download]') ||
        /abrir documento|open document|baixar documento|download document/.test(label)
      )
        media.add('DOCUMENT');
      else if (/abrir imagem|open image/.test(label)) media.add('IMAGE');
      else if (
        node.matches('img') &&
        !node.matches('.emoji,[data-emoji],[data-plain-text]') &&
        !node.closest('[data-testid="avatar"],[data-testid="quoted-message"]')
      ) {
        const alt = node.getAttribute('alt') ?? '';
        if (!alt || !/^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\u200d|\ufe0f)+$/u.test(alt))
          media.add('IMAGE');
      }
      if (media.size >= 16) break;
    }
    return [...media].sort();
  }
}
