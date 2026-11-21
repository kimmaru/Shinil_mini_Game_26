// ════════════════════════════════════════════════════════════════════════════
// THE ATTRACT REEL — "배경은 게임 화면 영상들이 3초마다 전환".
//
// There are no video files in this project, by design (no assets, nothing
// leaves the machine). So the reel runs the REAL games: `runRound` from the
// engine, driven by a synthetic pose clip instead of the camera, with a silent
// audio runtime, a no-op HUD and its own fx instance. Every REEL_SWITCH_SEC
// the round is aborted and the next game starts. A new game added to the
// catalogue is in the reel the day it is enabled, at zero bytes.
//
// The clip is the game's own `manifest.dev.clip` — the clip its smoke test
// guarantees scores > 0 — so the preview shows the game being PLAYED, not a
// body standing still in front of it.
//
// Cost guard for the 2015 MacBook: the frame is small, nothing runs unless
// the attract screen is mounted AND the page is visible, and reduced motion or
// any failure falls back to a parade of game icons (pure CSS).
// ════════════════════════════════════════════════════════════════════════════
import { useEffect, useRef, useState } from 'react';
import { ALL } from '@/engine/registry';
import { runRound } from '@/engine/host';
import { REEL_SWITCH_SEC } from '@/engine/session';
import { ReplayPoseSource } from '@/engine/pose/replay';
import { CLIP_NAMES, clip, type ClipName } from '@/engine/testing/clips';
import { stubBeats } from '@/engine/testing/stubs';
import { createFxService, type FxRuntime } from '@/engine/fx/service';
import type { AudioRuntime } from '@/engine/audio/service';
import type { GameId, GestureKind, HudService } from '@/engine/types';
import type { GameInfo } from '../useSession';
import { SpriteIcon } from './SpriteIcon';

/** Consecutive failed games before the reel gives up and shows the parade. */
const MAX_FAILS = 3;

/** Fallback clip by first gesture, for a game whose manifest names none. */
const CLIP_BY_GESTURE: Partial<Record<GestureKind, ClipName>> = {
  jump: 'jump-x8',
  squat: 'squat-x8',
  clap: 'clap-x12',
  swing: 'swing-wide',
  step: 'step-lr',
  zone: 'step-lr',
  lean: 'step-lr',
  rep: 'knee-run',
  holdPose: 'hold-poses',
  stillness: 'hold-poses',
  balance: 'hold-poses',
  poseMatch: 'hold-poses',
};

function clipFor(id: GameId): ClipName {
  const m = ALL.get(id);
  const named = m?.dev?.clip;
  if (named && (CLIP_NAMES as readonly string[]).includes(named)) return named as ClipName;
  return (m && CLIP_BY_GESTURE[m.gestures[0]!]) ?? 'reach-grid';
}

// ─── Silent services, shared by every reel round ────────────────────────────

const NO_HUD: HudService = {
  setGoal() {}, setScore() {}, setCombo() {}, setBar() {}, clearBar() {},
  toast() {}, announce() {}, beatRing() {}, setLives() {}, setTime() {},
};

const clockSec = (): number => performance.now() / 1000;

/** The whole AudioRuntime surface, doing nothing. A muted real runtime would
 *  still build a second AudioContext and synthesize every voice into a zero
 *  gain — real CPU on the machine this has to be cheap on. */
const SILENT: AudioRuntime = {
  get now() { return clockSec(); },
  latencyMs: 0,
  muted: true,
  play() {}, playLadder() {}, music() {}, stopMusic() {}, speak() {},
  beat: (bpm: number) => stubBeats(bpm, clockSec),
  unlock() {}, setMuted() {}, setMasterGain() {}, setLatencyMs() {},
  setSpeechEnabled() {}, speechEnabled: false,
  setMusicIntensity() {}, resetCombo() {}, endRound() {},
  available: false,
  dispose() {},
};

let reelFx: FxRuntime | null = null;
const fxOnce = (): FxRuntime => (reelFx ??= createFxService({ reducedMotion: false }));

// ─── Component ──────────────────────────────────────────────────────────────

export interface GameReelProps {
  games: GameInfo[];
  reducedMotion: boolean;
}

export function GameReel({ games, reducedMotion }: GameReelProps): React.ReactElement | null {
  /** Counts switches since mount. A counter rather than an index so a
   *  one-game catalogue still restarts its round every switch. */
  const [slot, setSlot] = useState(0);
  const [visible, setVisible] = useState(() => !document.hidden);
  const [failed, setFailed] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);
  const fails = useRef(0);
  const n = games.length;
  const live = !reducedMotion && !failed && visible && n > 0;

  // Nothing runs behind a hidden tab: the switch timer and the round both stop.
  useEffect(() => {
    const on = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);

  // The switch clock. Runs for the parade too, so both modes advance together.
  useEffect(() => {
    if (!visible || n === 0) return;
    const id = window.setTimeout(() => setSlot((s) => s + 1), REEL_SWITCH_SEC * 1000);
    return () => window.clearTimeout(id);
  }, [slot, visible, n]);

  // One real round per slot, aborted at the switch (or on unmount).
  useEffect(() => {
    const host = hostRef.current;
    const g = games[slot % Math.max(1, n)];
    if (!live || !host || !g) return;
    const ac = new AbortController();
    try {
      const r = host.getBoundingClientRect();
      const view = { w: Math.max(320, Math.round(r.width)), h: Math.max(240, Math.round(r.height)) };
      const pose = new ReplayPoseSource(clip(clipFor(g.id)), {
        view, maxPlayers: 1, probationSec: 0,
      });
      void pose.start();
      runRound(
        { gameId: g.id, host, hud: NO_HUD, seed: 0x5eed + slot, signal: ac.signal },
        { pose, audio: SILENT, fx: fxOnce(), reducedMotion: false, maxFps: 30 },
      )
        .then(() => { fails.current = 0; })
        .catch(() => {
          if (ac.signal.aborted) return;
          // One broken game skips its slot; a run of them means the reel
          // itself is broken, and the parade is better than a dead frame.
          fails.current += 1;
          if (fails.current >= MAX_FAILS) setFailed(true);
          else setSlot((s) => s + 1);
        });
    } catch {
      setFailed(true);
    }
    return () => ac.abort();
    // `games` is memoised by App.
  }, [live, slot, games, n]);

  if (n === 0) return null;
  const cur = games[slot % n]!;

  return (
    <figure className="reel" aria-label={`게임 미리보기: ${cur.nameKo}`}>
      <div className="reel__screen">
        {live ? (
          <>
            <div ref={hostRef} className="reel__host" aria-hidden="true" />
            {/* Covers the frame or two between one game's teardown and the
                next one's first render, as a quick channel-change wipe. */}
            <div key={slot} className="reel__wipe" aria-hidden="true" />
          </>
        ) : (
          <Parade games={games} current={slot % n} moving={!reducedMotion} />
        )}
      </div>
      <figcaption className="reel__tag pop-in" key={slot}>
        <SpriteIcon id={cur.icon} size={40} hue={cur.hue} />
        <span>{cur.nameKo}</span>
      </figcaption>
    </figure>
  );
}

/** The fallback. With motion allowed (the reel failed), every game's icon
 *  scrolls past as a marquee. Under reduced motion nothing travels: the
 *  featured game's icon sits in the middle and crossfades on the same 3 s
 *  clock. */
function Parade({ games, current, moving }: {
  games: GameInfo[];
  current: number;
  moving: boolean;
}): React.ReactElement {
  if (!moving) {
    const g = games[current]!;
    return (
      <div className="parade" aria-hidden="true">
        <span key={g.id} className="parade__hero rm-fade" style={{ ['--hue' as string]: g.hue }}>
          <SpriteIcon id={g.icon} size={168} hue={g.hue} />
        </span>
      </div>
    );
  }
  // Doubled so the strip loops seamlessly by translating -50%.
  const strip = [...games, ...games];
  return (
    <div className="parade is-moving" aria-hidden="true">
      <div className="parade__strip">
        {strip.map((g, i) => (
          <span key={`${g.id}-${i}`} className="parade__tile" style={{ ['--hue' as string]: g.hue }}>
            <SpriteIcon id={g.icon} size={84} hue={g.hue} />
          </span>
        ))}
      </div>
    </div>
  );
}
