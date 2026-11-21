// 1-2-3 stars. The engine computes them from manifest.scoring.starCuts, so a
// game can never invent its own curve — this just celebrates the number.
//
// Stars land one at a time with a rising chime (star.1/2/3). Staggered arrival
// is the difference between "you got 2" and "you got... TWO!".
import { useEffect, useState } from 'react';
import { useServices } from '../useSession';
import { SpriteIcon } from './SpriteIcon';

export interface StarRowProps {
  stars: 0 | 1 | 2 | 3;
  /** Play star.1/2/3 and pop them in one by one. */
  animate?: boolean;
  size?: 'md' | 'lg';
}

const STEP_MS = 420;

export function StarRow({ stars, animate = true, size = 'lg' }: StarRowProps): React.ReactElement {
  const [shown, setShown] = useState(animate ? 0 : stars);
  const services = useServices();

  useEffect(() => {
    if (!animate) {
      setShown(stars);
      return;
    }
    setShown(0);
    const timers: number[] = [];
    for (const i of [1, 2, 3] as const) {
      if (i > stars) break;
      timers.push(
        window.setTimeout(() => {
          setShown(i);
          services.audio?.play(`star.${i}`);
        }, i * STEP_MS),
      );
    }
    return () => timers.forEach(window.clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stars, animate]);

  return (
    <div className={`stars stars--${size}`} role="img" aria-label={`별 ${stars}개`}>
      {[1, 2, 3].map((i) => (
        <span
          key={i}
          className={`stars__one${i <= shown ? ' is-on' : ''}`}
          aria-hidden="true"
        >
          <SpriteIcon id="star" size={28} />
        </span>
      ))}
    </div>
  );
}
