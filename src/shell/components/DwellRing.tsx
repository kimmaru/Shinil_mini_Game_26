// The presence-probation ring on the attract screen.
//
// A person has to be present and upright for ~0.45s before 시작 arms. Without
// the ring the wait is indistinguishable from the app being broken; with it,
// the child understands "it is seeing me" and a passing teacher or an empty
// chair cannot launch a game.
import type { ReactNode } from 'react';
import { ProgressRing } from './ProgressRing';

export const DWELL_MS = 450;

export interface DwellRingProps {
  /** 0..1 toward DWELL_MS. */
  value: number;
  armed: boolean;
  size?: number;
  children?: ReactNode;
}

export function DwellRing({
  value,
  armed,
  size = 300,
  children,
}: DwellRingProps): React.ReactElement {
  return (
    <ProgressRing
      className={`dwell${armed ? ' is-armed' : ''}`}
      value={armed ? 1 : value}
      size={size}
      thickness={12}
      color={armed ? 'var(--c-success-500)' : 'var(--c-accent-500)'}
      trackColor="var(--c-surface-3)"
    >
      {children}
    </ProgressRing>
  );
}
