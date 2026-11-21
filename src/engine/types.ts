// ══════════════════════════════════════════════════════════════════════════════
// FROZEN CONTRACT — imported by 58 game modules.
// Changing anything here requires lead approval + `npm run freeze` + a full
// replay re-run. See docs/GAME_AUTHORING.md.
// ══════════════════════════════════════════════════════════════════════════════

import type { Renderer, Paint, TextOpts, SkeletonOpts } from './render/renderer';
import type { GestureService, Detector, GestureOpts, SignalOf } from './gestures/index';
import type { FxService } from './fx/index';
import type { HudService } from './hud/index';
import type { AudioService, BeatScheduler, PlayOpts, SfxId } from './audio/index';

export type GameId = string; // kebab-case, ALWAYS === the folder name
export type PlayerId = number; // stable across frames within a round
export type Slot = 0 | 1 | 2 | 3;

export interface Pt {
  x: number;
  y: number;
}

// ─── Manifest ────────────────────────────────────────────────────────────────

/** Which body regions a game needs visible. Drives the "small room" filter. */
export type LandmarkGroup = 'head' | 'arms' | 'hands' | 'torso' | 'legs' | 'feet' | 'fullBody';

/** Every gesture the engine can detect. A game declares what it uses so the
 *  intro screen can auto-generate a demo and the lobby can filter. */
export type GestureKind =
  | 'jump'
  | 'squat'
  | 'clap'
  | 'swing'
  | 'raise'
  | 'lean'
  | 'step'
  | 'reach'
  | 'limbAngle'
  | 'zone'
  | 'holdPose'
  | 'rep'
  | 'stillness'
  | 'balance'
  | 'stroke'
  | 'poseMatch'
  | 'jointTargets';

export type SpaceNeed =
  /** Playable sitting in a chair; upper body only. Used as a "rest" game. */
  | 'seated'
  /** Standing in place; needs roughly an arm span. */
  | 'standing'
  /** Needs ~2m of clear floor — gated behind the safety screen. */
  | 'room';

export type PlayMode = 'solo' | 'coop' | 'versus' | 'hotseat';

export type ScoringKind = 'count' | 'time' | 'accuracy' | 'survival';

export interface MiniGameManifest {
  /** MUST equal the folder name. The registry throws on mismatch. */
  id: GameId;
  nameKo: string;
  /** One line on the card. Keep to 18 characters or it wraps badly. */
  taglineKo: string;
  /** 1-3 imperative lines, shown on the intro screen and read aloud. */
  howToKo: string[];
  /**
   * A sprite id from `src/engine/render/sprites.ts`.
   *
   * NOT an emoji: emoji render as a different artwork on every OS and cannot
   * be recoloured, so a lobby of 58 emoji icons can never look like one
   * product. The same id is drawn on the canvas and in the DOM.
   */
  icon: string;
  /** 0-360. Tints the card and the in-game accents. This is how 58 games feel
   *  distinct without 58 palettes. */
  theme?: { hue: number };

  /** 1 = anyone can do it, 3 = needs timing or coordination. */
  difficulty: 1 | 2 | 3;
  /** Physical exertion. The scheduler refuses to serve three 3s in a row. */
  intensity: 1 | 2 | 3;
  space: SpaceNeed;
  players: { min: 1 | 2 | 3 | 4; max: 1 | 2 | 3 | 4; mode: PlayMode };

  requiredLandmarks: LandmarkGroup[];
  gestures: GestureKind[];

  /** 30_000 .. 60_000. The engine ends the round; the game does not. */
  durationMs: number;
  scoring: {
    kind: ScoringKind;
    /** Score a strong player should reach. Used to normalize to 0..1. */
    maxScore: number;
    /** Normalized thresholds for 1/2/3 stars. The ENGINE computes stars from
     *  these, so 58 authors cannot invent 58 star curves. Validated to sane
     *  bands by the manifest test. */
    starCuts: [number, number, number];
  };

  a11y: {
    /** True if VirtualPoseSource (keyboard) makes the game genuinely playable. */
    keyboardFallback: boolean;
    noFlashing: boolean;
    colorBlindSafe: boolean;
    /** False => the engine renders a visual beat ring, because the game would
     *  otherwise be unplayable with sound off. */
    audioOptional: boolean;
  };
  tags: string[];
  version: number;
  author?: string;
  /** false = authored but kept out of the roulette pool. This is the quality
   *  valve: agent-authored games ship false, the lead flips them after playing. */
  enabled?: boolean;
  /** Dev-only metadata. `clip` names the synthetic clip that MUST produce a
   *  score > 0 — the anti-dead-game test. */
  dev?: { clip?: string; notes?: string };
}

// ─── Pose ────────────────────────────────────────────────────────────────────

export interface CalibrationProfile {
  /** Shoulder width in view px. The unit for every normalized coordinate. */
  shoulderW: number;
  /** Wrist-to-wrist span with arms out, in normalized units (~2.0, but measure). */
  armSpan: number;
  /** Shoulder-to-wrist length, normalized units. Sizes "max reach" targets. */
  armLen: number;
  /** Hip-centre y while standing, as a 0..1 fraction of view height. */
  standHipY: number;
  /** Hip-centre y at the bottom of a squat. Falls back to standHipY + 0.12. */
  squatHipY: number;
  /** Highest wrist y with both hands raised. Sizes "jump and touch" targets. */
  reachUpY: number;
  /** Ankle y. 1.0 means feet were never visible. */
  floorY: number;
  /** Baseline motion energy when "standing still" — children cannot hold
   *  still, so freeze games threshold against THIS, not a global constant. */
  idleEnergy: number;
  /** False when the lower body was never visible: legs/feet games are hidden. */
  lowerBodyVisible: boolean;
  /** Selfie view. Default true; mirroring is non-negotiable UX. */
  mirrored: boolean;
  capturedAt: number;
}

/** One tracked person for one frame.
 *
 *  COORDINATE SYSTEMS — read this once, it prevents most bugs:
 *   - `n`  normalized: origin = hip centre, 1 unit = shoulder width, +y DOWN.
 *          ALL gameplay thresholds use this. Camera-distance and height independent.
 *   - `px` view pixels, already mirrored. Use for drawing and for hit tests
 *          against on-screen objects.
 *   - `v`  filtered velocity in normalized units per second.
 */
export interface PlayerPose {
  id: PlayerId;
  slot: Slot;
  present: boolean;
  /** Mean visibility of the torso anchors, 0..1. */
  conf: number;
  n: Float32Array; // 33 * 2
  v: Float32Array; // 33 * 2
  px: Float32Array; // 33 * 2
  vis: Float32Array; // 33
  /** Body bounding box as 0..1 fractions of the view. */
  box: { x: number; y: number; w: number; h: number };
  /** Shoulder-line tilt in degrees. Exposed, deliberately NOT corrected for. */
  rollDeg: number;
  /** Scale used for px <-> n conversion: shoulder width in view px. */
  scalePx: number;
  calib: CalibrationProfile;
}

export interface PoseFrame {
  /** Seconds since the round started. */
  t: number;
  /** How stale the underlying inference is. > 0 means positions were
   *  extrapolated. Rhythm games MUST subtract this from motion timestamps. */
  inferenceAgeMs: number;
  /** Inference fps (not render fps), for the debug overlay and quality ladder. */
  fps: number;
  players: PlayerPose[];
  byId: ReadonlyMap<PlayerId, PlayerPose>;
  /** Convenience: players[0] or undefined. Most games are solo. */
  p1: PlayerPose | undefined;
}

// ─── Services the engine hands to every game ────────────────────────────────

export type GameEvent =
  | { kind: 'scored'; by?: PlayerId; points: number }
  | { kind: 'combo'; by?: PlayerId; count: number }
  | { kind: 'miss'; by?: PlayerId }
  | { kind: 'fail'; by?: PlayerId }
  | { kind: 'clearEarly' };

export interface GameContext {
  readonly manifest: MiniGameManifest;
  /** Logical CSS px. Already accounts for devicePixelRatio. */
  readonly view: { w: number; h: number; dpr: number };
  /** Seeded. Same seed => same round, which is what makes replays testable.
   *  Math.random() is banned in games. */
  readonly rng: () => number;
  readonly audio: AudioService;
  readonly gestures: GestureService;
  readonly fx: FxService;
  readonly hud: HudService;
  /** This game's own locale.ts. Never a shared i18n file. */
  readonly t: (k: string) => string;
  readonly profiles: ReadonlyMap<PlayerId, CalibrationProfile>;
  emit(ev: GameEvent): void;
}

export type EndReason = 'timeUp' | 'cleared' | 'failed' | 'aborted' | 'noPlayers';

export interface MiniGame {
  /** Allocate everything here. Called once. May be async. */
  init(ctx: GameContext): void | Promise<void>;
  /** The countdown finished; the clock starts now. Never allocate here. */
  start(): void;
  /** Fixed timestep: dt is ALWAYS 1/60. Never allocate here. */
  update(dt: number, frame: PoseFrame): void;
  /** `interp` is 0..1 into the next fixed step, so 60fps render stays smooth
   *  even though pose inference arrives at ~25Hz. */
  render(g: Renderer, interp: number): void;
  /** Synchronous and pure-ish. The engine owns the results screen. */
  end(reason: EndReason): GameResult;
  dispose?(): void;
  onPause?(): void;
  onResume?(): void;
  onResize?(w: number, h: number): void;
}

/** The default export of every `src/games/<id>/index.ts`. */
export type MiniGameFactory = () => MiniGame;

export interface GameResult {
  gameId: GameId;
  cleared: boolean;
  rawScore: number;
  maxScore: number;
  /** 0..1. The engine clamps. */
  normalized: number;
  /** The ENGINE computes this from manifest.scoring.starCuts. A game returning
   *  its own stars is overwritten. */
  stars: 0 | 1 | 2 | 3;
  durationMs: number;
  perPlayer: Array<{
    playerId: PlayerId;
    slot: Slot;
    score: number;
    hits: number;
    misses: number;
    bestCombo: number;
    mvp?: boolean;
  }>;
  /** "콤보 12연속!" — shown on the results card. */
  highlightsKo?: string[];
  /** Local only. Never transmitted; there is no network path out of this app. */
  telemetry?: Record<string, number>;
}

// Re-exported so a game needs exactly one import for its type annotations.
export type {
  Renderer, Paint, TextOpts, SkeletonOpts,
  GestureService, Detector, GestureOpts, SignalOf,
  FxService, HudService, AudioService, BeatScheduler, PlayOpts, SfxId,
};
