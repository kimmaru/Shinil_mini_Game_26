// The frame every non-gameplay screen sits in.
//
// Exists so fifteen screens cannot each invent their own heading size, gutter
// and action-row order. If a screen needs to break out of this, it uses
// `variant="full"` (attract, roulette, play) and owns its own layout.
import type { ReactNode } from 'react';
import { SpriteIcon } from './SpriteIcon';

export interface ScreenProps {
  /** Emoji above the title. Decorative. */
  /** A sprite id (see src/engine/render/sprites*.ts), never an emoji. */
  icon?: string;
  /** Small line above the title — "1단계", "3번째 게임". */
  kickerKo?: string;
  titleKo?: string;
  /** One line under the title, at --fs-body-lg. */
  leadKo?: string;
  children?: ReactNode;
  /** The primary action row. Primary action goes FIRST — children scan left. */
  actions?: ReactNode;
  /** Quiet links: 보호자님께 안내, 설정. */
  footer?: ReactNode;
  variant?: 'default' | 'read' | 'full';
  /**
   * Announce the title ONCE on arrival, through a dedicated off-screen region.
   *
   * Never put aria-live on <main> itself: it turns the entire screen into a
   * live region, so a ticking progress label or a counting score is read out
   * on every change. Default is 'off'; `assertive` is for the countdown and for
   * error states that change what the player has to do.
   */
  live?: 'off' | 'polite' | 'assertive';
  className?: string;
}

export function Screen({
  icon,
  kickerKo,
  titleKo,
  leadKo,
  children,
  actions,
  footer,
  variant = 'default',
  live = 'off',
  className,
}: ScreenProps): React.ReactElement {
  return (
    <main
      className={`screen${variant === 'read' ? ' screen--read' : ''}${
        variant === 'full' ? ' screen--full' : ''
      }${className ? ` ${className}` : ''}`}
    >
      {live !== 'off' ? (
        <p className="sr-only" aria-live={live} aria-atomic="true">
          {[titleKo, leadKo].filter(Boolean).join('. ')}
        </p>
      ) : null}
      {icon ? (
        <div className="screen__icon pop-in">
          <SpriteIcon id={icon} size={92} />
        </div>
      ) : null}
      {kickerKo ? <p className="label dim center">{kickerKo}</p> : null}
      {titleKo ? <h1 className="h1 center">{titleKo}</h1> : null}
      {leadKo ? <p className="body-lg center dim">{leadKo}</p> : null}
      {children}
      {actions ? <div className="actions">{actions}</div> : null}
      {footer ? <div className="screen__footer row">{footer}</div> : null}
    </main>
  );
}
