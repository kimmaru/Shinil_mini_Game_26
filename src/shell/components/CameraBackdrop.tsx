// The camera image as a dimmed backdrop behind every screen
// (설정 → 배경에 내 모습 보이기, on by default).
//
// ALIGNMENT. The pose engine maps a landmark to view px as
//     x = (1 - lm.x) · viewW,   y = lm.y · viewH
// (engine/pose/normalize.ts and identity.ts readAnchor), where lm is
// normalized to the WHOLE camera frame, uncropped, and the view is
// window.innerWidth × innerHeight (main.tsx). So the video must cover exactly
// innerWidth × innerHeight (100vw × 100vh), be stretched to it non-uniformly
// (`object-fit: fill` — `cover` would crop and slide every joint off the
// body) and be mirrored (`scaleX(-1)`). Then a joint drawn at px sits on the
// same pixel as that joint in the image. A 16:9 camera on a 16:10 screen is
// stretched ~11 % taller — exactly as much as the skeleton is.
//
// COST. A second sink on the SAME stream (no second getUserMedia), no
// filter, no blend mode: opacity only (.cam-backdrop in base.css).
import { useEffect, useRef } from 'react';

export function CameraBackdrop({ stream }: { stream: MediaStream }): React.ReactElement {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    v.srcObject = stream;
    // Rejects if the stream goes away mid-start; the next render handles it.
    v.play().catch(() => undefined);
    return () => {
      v.srcObject = null;
    };
  }, [stream]);

  return <video ref={ref} className="cam-backdrop" muted playsInline autoPlay aria-hidden="true" />;
}
