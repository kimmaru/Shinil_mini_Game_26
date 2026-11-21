// ════════════════════════════════════════════════════════════════════════════
// ?debug=1 — not optional.
//
// Nobody can tune a gesture threshold without seeing the signal next to its
// enter/exit lines, and a teacher diagnosing a classroom PC needs the fps and
// the tier on screen rather than in a console they will never open. Two numbers
// here decide real design questions: `inferenceAgeMs` sets the rhythm games'
// default offset, and the tier string explains a 10fps Chromebook in one glance.
//
// The engine pushes what only it can know (detector internals, renderer op
// count) through `window.__mg.pushDebug`. Everything else the shell measures
// itself, so the overlay is useful even with no engine attached.
// ════════════════════════════════════════════════════════════════════════════
import { useEffect, useRef, useState } from 'react';
import type { CalibrationProfile } from '@/engine/types';
import type { PoseSource } from '@/engine/pose/source';
import type { Phase } from '../useSession';

/** One gesture detector's live state. The enter/exit lines are the point. */
export interface DebugDetectorBar {
  kind: string;
  /** Current signal value, in the detector's own units. */
  value: number;
  enter: number;
  exit: number;
  /** True for the frame it fired; the overlay flashes. */
  fired: boolean;
  /** False when the landmarks it needs are not visible — it is GATED, not 0. */
  ok: boolean;
}

export interface DebugPush {
  detectors?: DebugDetectorBar[];
  /** Draw calls last frame. A game drawing 4000 ops is a bug, not a style. */
  rendererOps?: number;
  /** Fixed steps run last frame (should be 1, occasionally 2). */
  steps?: number;
}

export interface MgDevApi {
  pushDebug: (d: DebugPush) => void;
  setState: (phase: Phase) => void;
  debug: () => Record<string, unknown>;
}

declare global {
  interface Window {
    __mg?: MgDevApi;
  }
}

export interface DebugOverlayProps {
  phase: Phase;
  seed: number;
  players: number;
  pose: PoseSource | null | undefined;
  calib: CalibrationProfile | null;
  /** Registered by App; the overlay only reads it. */
  getPush: () => DebugPush;
}

const HISTORY = 96;
const SAMPLE_MS = 250;

export function DebugOverlay({
  phase,
  seed,
  players,
  pose,
  calib,
  getPush,
}: DebugOverlayProps): React.ReactElement {
  const graphRef = useRef<HTMLCanvasElement>(null);
  const [open, setOpen] = useState(true);
  const [snap, setSnap] = useState({
    renderFps: 0,
    worstMs: 0,
    inferFps: 0,
    ageMs: 0,
    tier: '-',
    warning: '',
    push: {} as DebugPush,
  });

  useEffect(() => {
    const frames: number[] = [];
    let last = performance.now();
    let raf = 0;
    let acc = 0;
    let count = 0;
    let worst = 0;
    let since = last;

    const loop = () => {
      raf = requestAnimationFrame(loop);
      const now = performance.now();
      const dt = now - last;
      last = now;
      frames.push(dt);
      if (frames.length > HISTORY) frames.shift();
      acc += dt;
      count++;
      if (dt > worst) worst = dt;

      // Draw the frame-time graph every frame (it is 96 lines on a 96px canvas)
      // but only re-render React four times a second.
      const c = graphRef.current;
      const ctx = c?.getContext('2d');
      if (c && ctx) {
        const w = (c.width = c.clientWidth);
        const h = (c.height = c.clientHeight);
        ctx.clearRect(0, 0, w, h);
        // 16.7ms budget line
        ctx.strokeStyle = 'rgba(255,255,255,.25)';
        ctx.beginPath();
        ctx.moveTo(0, h - (16.7 / 50) * h);
        ctx.lineTo(w, h - (16.7 / 50) * h);
        ctx.stroke();
        const bw = w / HISTORY;
        for (let i = 0; i < frames.length; i++) {
          const ms = frames[i]!;
          const bh = Math.min(h, (ms / 50) * h);
          ctx.fillStyle = ms > 33 ? '#FF4D4D' : ms > 20 ? '#FF9F1C' : '#16C47F';
          ctx.fillRect(i * bw, h - bh, Math.max(1, bw - 1), bh);
        }
      }

      if (now - since >= SAMPLE_MS) {
        const frame = pose?.sample(now / 1000);
        setSnap({
          renderFps: Math.round((count / (now - since)) * 1000),
          worstMs: Math.round(worst * 10) / 10,
          inferFps: Math.round(pose?.info.fps ?? frame?.fps ?? 0),
          ageMs: Math.round(frame?.inferenceAgeMs ?? 0),
          tier: pose?.info.tier ?? '-',
          warning: pose?.info.warning ?? '',
          push: getPush(),
        });
        acc = 0;
        count = 0;
        worst = 0;
        since = now;
        void acc;
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [pose, getPush]);

  // `d` toggles the panel so a screenshot can be taken without it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'd' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!open) {
    return (
      <button type="button" className="dbg dbg--mini" onClick={() => setOpen(true)}>
        debug
      </button>
    );
  }

  const dets = snap.push.detectors ?? [];

  return (
    <aside className="dbg" aria-hidden="true">
      <header className="dbg__head">
        <strong>debug</strong>
        <button type="button" onClick={() => setOpen(false)}>
          ✕
        </button>
      </header>

      <dl className="dbg__grid">
        <dt>phase</dt>
        <dd>{phase}</dd>
        <dt>seed</dt>
        <dd>{seed}</dd>
        <dt>players</dt>
        <dd>{players}</dd>
        <dt>render fps</dt>
        <dd className={snap.renderFps < 50 ? 'is-bad' : ''}>{snap.renderFps}</dd>
        <dt>worst frame</dt>
        <dd className={snap.worstMs > 33 ? 'is-bad' : ''}>{snap.worstMs}ms</dd>
        <dt>inference fps</dt>
        <dd className={snap.inferFps > 0 && snap.inferFps < 15 ? 'is-bad' : ''}>
          {snap.inferFps}
        </dd>
        <dt>inferenceAge</dt>
        <dd className={snap.ageMs > 90 ? 'is-bad' : ''}>{snap.ageMs}ms</dd>
        <dt>tier</dt>
        <dd>{snap.tier}</dd>
        <dt>pose src</dt>
        <dd>{pose?.info.kind ?? 'none'}</dd>
        <dt>renderer ops</dt>
        <dd>{snap.push.rendererOps ?? '-'}</dd>
        <dt>steps/frame</dt>
        <dd>{snap.push.steps ?? '-'}</dd>
      </dl>

      <canvas ref={graphRef} className="dbg__graph" />
      {snap.warning ? <p className="dbg__warn">⚠ {snap.warning}</p> : null}

      <section className="dbg__sec">
        <h3>detectors</h3>
        {dets.length === 0 ? (
          <p className="dbg__empty">엔진이 아직 detector를 보내지 않았어요</p>
        ) : (
          dets.map((d) => <DetBar key={d.kind} d={d} />)
        )}
      </section>

      <section className="dbg__sec">
        <h3>calibration</h3>
        {calib ? (
          <dl className="dbg__grid">
            {(
              [
                ['shoulderW', calib.shoulderW.toFixed(1)],
                ['armSpan', calib.armSpan.toFixed(2)],
                ['armLen', calib.armLen.toFixed(2)],
                ['standHipY', calib.standHipY.toFixed(3)],
                ['squatHipY', calib.squatHipY.toFixed(3)],
                ['reachUpY', calib.reachUpY.toFixed(3)],
                ['floorY', calib.floorY.toFixed(3)],
                ['idleEnergy', calib.idleEnergy.toFixed(2)],
                ['lowerBody', String(calib.lowerBodyVisible)],
                ['mirrored', String(calib.mirrored)],
              ] as const
            ).map(([k, v]) => (
              <div key={k} className="dbg__pair">
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="dbg__empty">보정 안 됨 (기본값 사용)</p>
        )}
      </section>
    </aside>
  );
}

/** Signal value with its enter/exit lines drawn in, flashing on fire.
 *  Without the lines the number is unactionable; with them, tuning a threshold
 *  takes one round instead of ten. */
function DetBar({ d }: { d: DebugDetectorBar }): React.ReactElement {
  const span = Math.max(Math.abs(d.enter), Math.abs(d.exit), Math.abs(d.value), 1) * 1.15;
  const pct = (v: number) => `${Math.max(0, Math.min(100, (Math.abs(v) / span) * 100))}%`;
  return (
    <div className={`dbg__det${d.fired ? ' is-fired' : ''}${d.ok ? '' : ' is-gated'}`}>
      <span className="dbg__detName">{d.kind}</span>
      <span className="dbg__detTrack">
        <span className="dbg__detFill" style={{ width: pct(d.value) }} />
        <span className="dbg__detLine dbg__detLine--enter" style={{ left: pct(d.enter) }} />
        <span className="dbg__detLine dbg__detLine--exit" style={{ left: pct(d.exit) }} />
      </span>
      <span className="dbg__detVal num">{d.value.toFixed(2)}</span>
    </div>
  );
}
