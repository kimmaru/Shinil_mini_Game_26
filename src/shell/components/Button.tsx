// The one pressable thing in the product. Everything else is a variant.
//
// The 3D slab (a solid-colour bottom shadow plus `:active { translateY }`)
// lives in base.css; this component exists to guarantee two things no CSS can:
// a 40ms click sound on every press (feedback inside 100ms is the whole brief)
// and that nobody ships a button under 56px.
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import type { SfxId } from '@/engine/types';
import { useServices } from '../useSession';
import { SpriteIcon } from './SpriteIcon';

export type ButtonVariant = 'primary' | 'accent' | 'success' | 'danger' | 'ghost' | 'link';
export type ButtonSize = 'sm' | 'md' | 'huge';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Emoji, shown before the label. Decorative: always aria-hidden. */
  /** A sprite id (see src/engine/render/sprites*.ts), never an emoji. */
  icon?: string;
  block?: boolean;
  /** Override the press sound. 'ui.back' for a 뒤로, 'ui.confirm' for a commit. */
  sfx?: SfxId;
  children?: ReactNode;
}

export function Button({
  variant = 'ghost',
  size = 'md',
  icon,
  block,
  sfx = 'ui.click',
  className,
  onClick,
  children,
  ...rest
}: ButtonProps): React.ReactElement {
  const services = useServices();
  const cls = [
    'btn',
    `btn--${variant}`,
    size === 'huge' ? 'btn--huge' : size === 'sm' ? 'btn--sm' : '',
    block ? 'btn--block' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type="button"
      className={cls}
      onClick={(e) => {
        services.audio?.play(sfx);
        onClick?.(e);
      }}
      {...rest}
    >
      {icon ? (
        <SpriteIcon
          id={icon}
          size={size === 'huge' ? 34 : size === 'sm' ? 20 : 26}
          on="dark"
          className="btn__icon"
        />
      ) : null}
      {children}
    </button>
  );
}
