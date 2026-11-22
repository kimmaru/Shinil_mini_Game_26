// 전체 게임 — every playable game as a tile, for choosing one directly instead
// of spinning the roulette. Opened from the top-left button on attract; it is
// an overlay like 설정, so Esc closes it (App) and START is blocked meanwhile.
import { useEffect, useRef } from 'react';
import { Button } from '../components/Button';
import { SpriteIcon } from '../components/SpriteIcon';
import type { GameInfo } from '../useSession';

export interface GamePickerProps {
  games: GameInfo[];
  onPick: (game: GameInfo) => void;
  onClose: () => void;
}

export function GamePicker({ games, onPick, onClose }: GamePickerProps): React.ReactElement {
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => panelRef.current?.focus({ preventScroll: true }), []);

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="picker-h">
      <div className="overlay__panel picker" ref={panelRef} tabIndex={-1}>
        <header className="overlay__head">
          <SpriteIcon id="ui-party" size={64} />
          <h1 id="picker-h" className="h1">전체 게임</h1>
        </header>

        <ul className="picker__grid">
          {games.map((g) => (
            <li key={g.id}>
              <Button
                variant="ghost"
                sfx="ui.confirm"
                className="picker__tile"
                style={{ ['--hue' as string]: g.hue }}
                onClick={() => onPick(g)}
              >
                <SpriteIcon id={g.icon} size={52} hue={g.hue} />
                <span className="picker__name">{g.nameKo}</span>
              </Button>
            </li>
          ))}
        </ul>

        <div className="actions">
          <Button variant="go" size="huge" icon="ui-close" sfx="ui.back" onClick={onClose}>
            닫기
          </Button>
        </div>
      </div>
    </div>
  );
}
