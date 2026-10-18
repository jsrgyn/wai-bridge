import type { CaptureObservation } from '../contracts.js';

type MediaKind = CaptureObservation['media'][number];

export class MediaDetector {
  detect(message: HTMLElement): MediaKind[] {
    const media = new Set<MediaKind>();
    for (const node of message.querySelectorAll<HTMLElement>('[data-wai-media], img, audio, video, [aria-label*="audio" i], [aria-label*="voice message" i]')) {
      const explicit = node.dataset.waiMedia?.toUpperCase();
      if (explicit === 'IMAGE' || explicit === 'AUDIO' || explicit === 'VIDEO' || explicit === 'DOCUMENT') media.add(explicit);
      else if (node.matches('img')) media.add('IMAGE');
      else if (node.matches('audio, [aria-label*="audio" i], [aria-label*="voice message" i]')) media.add('AUDIO');
      else if (node.matches('video')) media.add('VIDEO');
      if (media.size >= 16) break;
    }
    return [...media];
  }
}
