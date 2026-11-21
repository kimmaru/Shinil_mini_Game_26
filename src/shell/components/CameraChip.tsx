// 🔴 카메라 켜짐 · [끄기]
//
// Always visible whenever a MediaStream track is live, on every screen, with a
// one-press off switch. This is not decoration: it is the part of the privacy
// promise a guardian standing behind the child can verify with their eyes, and
// a camera indicator you cannot find is a camera indicator that does not count.
import { Button } from './Button';

export interface CameraChipProps {
  live: boolean;
  onOff: () => void;
}

export function CameraChip({ live, onOff }: CameraChipProps): React.ReactElement | null {
  if (!live) return null;
  return (
    <div className="camchip">
      <span className="chip chip--live">
        <span className="dot" aria-hidden="true" />
        카메라 켜짐
      </span>
      <Button variant="ghost" size="sm" sfx="ui.back" onClick={onOff}>
        끄기
      </Button>
    </div>
  );
}
