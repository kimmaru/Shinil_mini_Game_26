// A game's sprite, rendered in the DOM.
//
// The lobby card, the roulette slice and the intro screen all show a game's
// icon. They read it from the SAME sprite definition the game draws with, so a
// child sees the identical artwork on the card and in the round. Drawing those
// with two systems is how a product starts looking like two products.
import { useMemo } from 'react';
import { hasSprite, spriteToSvg } from '@/engine/render/sprite';
// BOTH sprite tables. Importing only the first made every ui-* and g-* id
// unknown, and SpriteIcon renders a blank placeholder for an unknown id — so
// the icons silently vanished rather than erroring.
import '@/engine/render/sprites';
import '@/engine/render/sprites-ui';

export interface SpriteIconProps {
  /** A sprite id, e.g. the game's `manifest.icon`. */
  id: string;
  /** Rendered size in px. */
  size?: number;
  /** The game's hue, so the icon matches its card. */
  hue?: number;
  /**
   * Which background it sits on. Light is the default: the product is
   * light-only, and the sprite keyline is near-black ink. Pass `'dark'` only
   * for the few surfaces that are still dark, such as the debug overlay.
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
