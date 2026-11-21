// A ring that fills 0..1, with whatever you put in the middle.
//
// Used for every "this is in progress" state in the shell: the 20MB asset
// prefetch, the 4s calibration, and (as DwellRing) the 0.45s presence probation
// on the attract screen. One shape for "wait" means a child learns it once.
import type { ReactNode } from 'react';

export interface ProgressRingProps {
  /** 0..1. Clamped. */
  value: number;
  /** Outer diameter in px. */
  size?: number;
  thickness?: number;
  color?: string;
  trackColor?: string;
  /** Centre content — a number, an emoji, a label. */
  children?: ReactNode;
  /** Announced to assistive tech. Omit for purely decorative rings. */
  labelKo?: string;
  className?: string;
}

export function ProgressRing({
  value,
  size = 220,
  thickness = 16,
  color = 'var(--c-primary-500)',
  trackColor = 'var(--c-surface-3)',
  children,
  labelKo,
  className,
}: ProgressRingProps): React.ReactElement {
  const v = Math.max(0, Math.min(1, value));
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;

  return (
    <div
      className={`ring${className ? ` ${className}` : ''}`}
      // A custom property, not width/height, so a media query can shrink the
      // ring on a short viewport without the component knowing about viewports.
      style={{ ['--ring-size' as string]: `${size}px` }}
      {...(labelKo
        ? {
            role: 'progressbar',
            'aria-label': labelKo,
            'aria-valuemin': 0,
            'aria-valuemax': 100,
            'aria-valuenow': Math.round(v * 100),
          }
        : { 'aria-hidden': true })}
    >
      <svg className="ring__svg" viewBox={`0 0 ${size} ${size}`} width={size} height={size}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={trackColor}
          strokeWidth={thickness}
        />
        <circle
          className="ring__fill"
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={thickness}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - v)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      {children ? <div className="ring__center">{children}</div> : null}
    </div>
  );
}
