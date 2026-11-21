// A game's sprite, rendered in the DOM.
//
// The lobby card, the roulette slice and the intro screen all show a game's
// icon. They read it from the SAME sprite definition the game draws with, so a
// child sees the identical artwork on the card and in the round. Drawing those
// with two systems is how a product starts looking like two products.
import { useMemo } from 'react';
import { hasSprite, spriteToSvg } from '@/engine/render/sprite';
import '@/engine/render/sprites';

export interface SpriteIconProps {
  /** A sprite id, e.g. the game's `manifest.icon`. */
  id: string;
  /** Rendered size in px. */
  size?: number;
  /** The game's hue, so the icon matches its card. */
  hue?: number;
  /**
   * Which background it sits on. A lobby card is a white panel, where the
   * white keyline would be invisible, so it flips to a same-hue dark.
   */
  on?: 'dark' | 'light';
  className?: string;
  /** Accessible label. Omit for purely decorative icons. */
  label?: string;
}

export function SpriteIcon({
  id, size = 48, hue, on = 'light', className, label,
}: SpriteIconProps): React.ReactElement | null {
  const svg = useMemo(
    () => (hasSprite(id)
      ? spriteToSvg(id, { size, ...(hue !== undefined ? { hue } : {}), on })
      : ''),
    [id, size, hue, on],
  );

  if (!svg) {
    // An unknown id must never print its raw text into the UI — a card
    // reading "mosquito" is worse than one with a neutral placeholder.
    return (
      <span
        className={className}
        style={{ width: size, height: size, display: 'inline-block' }}
        aria-hidden="true"
      />
    );
  }

  return (
    <span
      className={className}
      style={{ width: size, height: size, display: 'inline-block', lineHeight: 0 }}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
      // The string comes from our own sprite table, never from user input or
      // the network; there is no path by which it could carry markup.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
