// ════════════════════════════════════════════════════════════════════════════
// "카메라가 보는 건 이것뿐이에요."
//
// The single most load-bearing component on the attract screen, and it is not
// about gameplay: it is the demonstration that makes the privacy copy credible
// to the guardian standing behind the child. Points and lines, drawn from the
// landmark arrays, at low alpha — no video frame is ever painted, and the face
// mesh points are deliberately absent (POSE_EDGES omits them: eleven dots on a
// child's face looks like surveillance).
//
// Drawn on a canvas in a rAF loop outside React, so 30fps of skeleton costs
// zero re-renders.
// ════════════════════════════════════════════════════════════════════════════
import { useEffect, useRef } from 'react';
import { POSE_EDGES, MIN_VIS } from '@/engine/pose/landmarks';
import type { PlayerPose } from '@/engine/types';
import type { PoseSource } from '@/engine/pose/source';

export interface SkeletonPreviewProps {
  pose: PoseSource | null | undefined;
  /** 0..1. Low by design: this is an honesty demo, not a mirror. */
  alpha?: number;
  color?: string;
  className?: string;
  /** DEV only: animate a synthetic body so the screen can be reviewed before
   *  the camera path exists. Never true in a production build. */
  fake?: boolean;
  /** Fraction of the canvas the body should occupy. 0.88 fills the frame
   *  (calibration); the attract screen wants a backdrop, not a mirror. */
  fill?: number;
  /** 0..1 vertical anchor. 0.56 sits the body slightly low, so the head does
   *  not collide with a title sitting at the top of the same box. */
  anchorY?: number;
}

/** Box smoothing per DRAW. 0.26 at 30 Hz is the same time constant 0.14 was
 *  at 60 Hz. */
const SMOOTH = 0.26;
/** Backing-store cap. This is a thick-lined overlay: at 2x on a Retina Mac
 *  it cost four times the fill for nothing anyone can see from 2 m. */
const MAX_DPR = 1;
/** ~30 Hz. Pose arrives at ~25 Hz; drawing it at 60 only repaints the same
 *  skeleton twice. */
const FRAME_MS = 32;

export function SkeletonPreview({
  pose,
  alpha = 0.32,
  color = 'var(--c-primary-400)',
  className,
  fake = false,
  fill = 0.88,
  anchorY = 0.5,
}: SkeletonPreviewProps): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const stroke = getComputedStyle(canvas).getPropertyValue('color').trim() || '#6b8aff';
    let raf = 0;
    let t0 = performance.now();
    let lastDraw = -Infinity;
    // Smoothed source bounding box, so the body does not jitter in scale.
    const box = { x: 0, y: 0, w: 0, h: 0, init: false };

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const now = performance.now();
      if (now - lastDraw < FRAME_MS) return;
      lastDraw = now;
      const tSec = (now - t0) / 1000;
      const p: PlayerPose | undefined = fake
        ? fakePose(tSec)
        : pose?.sample(tSec).p1;

      const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      if (!p || !p.present || w === 0) return;

      // Fit the body's own bounding box into the canvas: the pose source's view
      // dimensions are its business, not the shell's.
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let j = 11; j < 33; j++) {
        if (p.vis[j]! < MIN_VIS) continue;
        const x = p.px[j * 2]!;
        const y = p.px[j * 2 + 1]!;
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      if (!Number.isFinite(minX) || maxX - minX < 1e-3) return;

      const target = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
      if (!box.init) {
        Object.assign(box, target, { init: true });
      } else {
        box.x += (target.x - box.x) * SMOOTH;
        box.y += (target.y - box.y) * SMOOTH;
        box.w += (target.w - box.w) * SMOOTH;
        box.h += (target.h - box.h) * SMOOTH;
      }

      const k = Math.min((w * fill) / box.w, (h * fill) / box.h);
      const ox = w / 2 - (box.x + box.w / 2) * k;
      const oy = h * anchorY - (box.y + box.h / 2) * k;
      const X = (j: number) => p.px[j * 2]! * k + ox;
      const Y = (j: number) => p.px[j * 2 + 1]! * k + oy;

      ctx.globalAlpha = alpha;
      ctx.lineCap = 'round';
      ctx.strokeStyle = stroke;
      ctx.fillStyle = stroke;
      ctx.lineWidth = Math.max(3, Math.min(w, h) * 0.014);
      for (const [a, b] of POSE_EDGES) {
        if (p.vis[a]! < MIN_VIS || p.vis[b]! < MIN_VIS) continue;
        ctx.beginPath();
        ctx.moveTo(X(a), Y(a));
        ctx.lineTo(X(b), Y(b));
        ctx.stroke();
      }
      const r = Math.max(3, Math.min(w, h) * 0.012);
      for (let j = 11; j < 33; j++) {
        if (p.vis[j]! < MIN_VIS) continue;
        ctx.beginPath();
        ctx.arc(X(j), Y(j), r, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      t0 = 0;
    };
  }, [pose, alpha, fake, fill, anchorY]);

  return (
    <canvas
      ref={canvasRef}
      className={`skelprev${className ? ` ${className}` : ''}`}
      style={{ color }}
      aria-hidden="true"
    />
  );
}

// ─── DEV-ONLY synthetic body ────────────────────────────────────────────────
// shortcut: exists only so the attract screen can be reviewed before
// MediaPipePoseSource lands. Delete once `?pose=virtual` produces real frames.
let fakeBuf: PlayerPose | null = null;

function fakePose(t: number): PlayerPose | undefined {
  if (!import.meta.env.DEV) return undefined;
  if (!fakeBuf) {
    fakeBuf = {
      id: 0,
      slot: 0,
      present: true,
      conf: 1,
      n: new Float32Array(66),
      v: new Float32Array(66),
      px: new Float32Array(66),
      vis: new Float32Array(33).fill(1),
      box: { x: 0.3, y: 0.1, w: 0.4, h: 0.8 },
      rollDeg: 0,
      scalePx: 170,
      calib: {
        shoulderW: 170,
        armSpan: 2.1,
        armLen: 1.6,
        standHipY: 0.62,
        squatHipY: 0.74,
        reachUpY: 0.18,
        floorY: 0.98,
        idleEnergy: 0.35,
        lowerBodyVisible: true,
        mirrored: true,
        capturedAt: 0,
      },
    };
    for (let j = 0; j < 11; j++) fakeBuf.vis[j] = 0.2; // face points: not drawn
  }
  const px = fakeBuf.px;
  const sw = 170;
  const cx = 640;
  const bob = Math.sin(t * 1.9) * 10;
  const swing = Math.sin(t * 1.9) * 0.55;
  const hipY = 430 + bob;
  const put = (j: number, x: number, y: number) => {
    px[j * 2] = x;
    px[j * 2 + 1] = y;
  };
  put(11, cx - sw / 2, hipY - 190);
  put(12, cx + sw / 2, hipY - 190);
  put(13, cx - sw / 2 - 20, hipY - 90 + swing * 50);
  put(14, cx + sw / 2 + 20, hipY - 90 - swing * 50);
  put(15, cx - sw / 2 - 30, hipY + 10 + swing * 110);
  put(16, cx + sw / 2 + 30, hipY + 10 - swing * 110);
  put(17, px[15 * 2]! - 8, px[15 * 2 + 1]! + 14);
  put(18, px[16 * 2]! + 8, px[16 * 2 + 1]! + 14);
  put(19, px[15 * 2]! + 4, px[15 * 2 + 1]! + 18);
  put(20, px[16 * 2]! - 4, px[16 * 2 + 1]! + 18);
  put(21, px[15 * 2]! - 2, px[15 * 2 + 1]! + 10);
  put(22, px[16 * 2]! + 2, px[16 * 2 + 1]! + 10);
  put(23, cx - sw * 0.3, hipY);
  put(24, cx + sw * 0.3, hipY);
  put(25, cx - sw * 0.32, hipY + 120 - swing * 20);
  put(26, cx + sw * 0.32, hipY + 120 + swing * 20);
  put(27, cx - sw * 0.34, hipY + 250 - swing * 40);
  put(28, cx + sw * 0.34, hipY + 250 + swing * 40);
  put(29, px[27 * 2]! - 6, px[27 * 2 + 1]! + 12);
  put(30, px[28 * 2]! + 6, px[28 * 2 + 1]! + 12);
  put(31, px[27 * 2]! + 18, px[27 * 2 + 1]! + 20);
  put(32, px[28 * 2]! - 18, px[28 * 2 + 1]! + 20);
  return fakeBuf;
}
