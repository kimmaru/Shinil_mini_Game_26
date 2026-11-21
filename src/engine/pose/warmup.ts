// Shader-compile warmup — the 20-second stall nobody expects.
//
// MediaPipe compiles its GPU shaders LAZILY, per subgraph. The detector
// subgraph compiles on the first frame you hand it. The LANDMARK subgraph only
// compiles the first time a body actually appears. On a cold browser cache that
// pass has been measured at ~20 seconds (RESEARCH-POSE §4.7). If that happens
// when the first child steps in front of the camera, the round is over before
// the skeleton appears.
//
// So warming up with a blank frame is worse than useless: it compiles the
// detector and not the landmarker, which is exactly the stall you were trying
// to avoid. The frame has to contain something the detector will call a person.
//
// There is deliberately no image file in this project (see AGENTS.md "No
// assets"), so we draw one: a high-contrast human figure at plausible
// proportions, built from the same parametric skeleton the test clips use, on
// an OffscreenCanvas, at runtime.
//
// Whether a synthetic figure actually trips BlazePose's detector is a property
// of the model, not of this code, and it is not something we can promise. So
// the result says honestly whether a pose was found, and the caller falls back
// to absorbing the compile behind the calibration screen — where a real body IS
// in frame and the player is being asked to stand still anyway.
import { body, type BodyParams } from '../testing/synth';
import { L, LANDMARK_COUNT } from './landmarks';

/** The part of PoseLandmarker warmup needs. Structural, so this file stays
 *  testable in Node and never imports 31MB of wasm bindings. */
export interface WarmupTarget {
  detect?: (image: unknown, ...rest: never[]) => { landmarks: unknown[] } | void;
  detectForVideo?: (image: unknown, timestampMs: number, ...rest: never[]) =>
    | { landmarks: unknown[] }
    | void;
}

export interface WarmupOpts {
  /** How many times to run the figure through. 3 covers detector + landmarker
   *  + the first tracking-mode pass. */
  attempts?: number;
  /** Generous on purpose: Google's own sample allows 60s for boot frames
   *  against 5s steady-state. */
  timeoutMs?: number;
  size?: number;
  /** Starting timestamp for detectForVideo. Timestamps must be strictly
   *  monotonically increasing across the whole session, so the caller passes
   *  the same counter it uses for real frames. */
  startTimestampMs?: number;
  now?: () => number;
  /** Override the figure, e.g. to warm up with a squatting body too. */
  pose?: Partial<BodyParams>;
}

export interface WarmupResult {
  /** The warmup ran without throwing. */
  ok: boolean;
  /** A pose was actually detected — i.e. the LANDMARK subgraph compiled, which
   *  is the whole point. False means the stall has NOT been paid for yet. */
  poseFound: boolean;
  attempts: number;
  ms: number;
  /** Last timestamp used, so the caller can keep its counter monotonic. */
  lastTimestampMs: number;
  message: string;
}

const clock = (): number => (typeof performance !== 'undefined' ? performance.now() : 0);

/** Figure framing, in the square canvas's own 0..1 coords.
 *
 *  Chosen so the WHOLE body is inside the canvas: at shoulderW 0.185 the
 *  skeleton is 4.16 shoulder widths tall, so the hips have to sit at 0.47 to
 *  keep the nose at 0.10 and the ankles at 0.87. A figure with its feet off
 *  the bottom edge is a figure the detector has a worse chance of finding, and
 *  the entire point of this file is maximising that chance. */
const FIGURE = {
  hipX: 0.5,
  hipY: 0.47,
  shoulderW: 0.185,
  armL: -40,
  armR: -140,
  elbowL: 18,
  elbowR: 18,
} as const;

/**
 * Draw a human figure for the detector to find.
 *
 * Dark silhouette on a light ground: BlazePose's detector keys on a
 * person-shaped blob with a head, and contrast is the one thing we can be
 * certain helps. Proportions come from testing/synth.ts, so the figure is the
 * same 8-to-11-year-old build the rest of the engine assumes.
 */
export function drawWarmupFigure(size = 256, pose?: Partial<BodyParams>): OffscreenCanvas {
  if (typeof OffscreenCanvas === 'undefined') {
    throw new Error('[warmup] OffscreenCanvas unavailable');
  }
  const cv = new OffscreenCanvas(size, size);
  const ctx = cv.getContext('2d');
  if (!ctx) throw new Error('[warmup] no 2d context on OffscreenCanvas');

  // aspect 1: the canvas is square, so the skeleton must be built in square
  // space or the figure comes out stretched and stops looking like a person.
  const lm = body({ ...FIGURE, ...pose }, 1);
  const X = (j: number): number => lm[j * 2]! * size;
  const Y = (j: number): number => lm[j * 2 + 1]! * size;

  ctx.fillStyle = '#e6e9ee';
  ctx.fillRect(0, 0, size, size);

  const S = FIGURE.shoulderW * size;
  ctx.strokeStyle = '#15181d';
  ctx.fillStyle = '#15181d';
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // Torso as a filled quad, so the figure reads as a body and not a stickman.
  ctx.beginPath();
  ctx.moveTo(X(L.LEFT_SHOULDER), Y(L.LEFT_SHOULDER));
  ctx.lineTo(X(L.RIGHT_SHOULDER), Y(L.RIGHT_SHOULDER));
  ctx.lineTo(X(L.RIGHT_HIP), Y(L.RIGHT_HIP));
  ctx.lineTo(X(L.LEFT_HIP), Y(L.LEFT_HIP));
  ctx.closePath();
  ctx.fill();

  const limb = (a: number, b: number, width: number): void => {
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(X(a), Y(a));
    ctx.lineTo(X(b), Y(b));
    ctx.stroke();
  };
  limb(L.LEFT_SHOULDER, L.LEFT_ELBOW, S * 0.3);
  limb(L.LEFT_ELBOW, L.LEFT_WRIST, S * 0.24);
  limb(L.RIGHT_SHOULDER, L.RIGHT_ELBOW, S * 0.3);
  limb(L.RIGHT_ELBOW, L.RIGHT_WRIST, S * 0.24);
  limb(L.LEFT_HIP, L.LEFT_KNEE, S * 0.38);
  limb(L.LEFT_KNEE, L.LEFT_ANKLE, S * 0.3);
  limb(L.RIGHT_HIP, L.RIGHT_KNEE, S * 0.38);
  limb(L.RIGHT_KNEE, L.RIGHT_ANKLE, S * 0.3);
  limb(L.LEFT_ANKLE, L.LEFT_FOOT_INDEX, S * 0.2);
  limb(L.RIGHT_ANKLE, L.RIGHT_FOOT_INDEX, S * 0.2);

  // Neck + head.
  const headCx = X(L.NOSE);
  const headCy = Y(L.NOSE);
  const shCx = (X(L.LEFT_SHOULDER) + X(L.RIGHT_SHOULDER)) / 2;
  const shCy = (Y(L.LEFT_SHOULDER) + Y(L.RIGHT_SHOULDER)) / 2;
  ctx.lineWidth = S * 0.26;
  ctx.beginPath();
  ctx.moveTo(shCx, shCy);
  ctx.lineTo(headCx, headCy);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(headCx, headCy, S * 0.34, 0, Math.PI * 2);
  ctx.fill();
  // Face marks: a flat oval reads as a ball, and the detector wants a face.
  ctx.fillStyle = '#e6e9ee';
  for (const j of [L.LEFT_EYE, L.RIGHT_EYE]) {
    ctx.beginPath();
    ctx.arc(X(j), Y(j), S * 0.055, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillRect(X(L.MOUTH_RIGHT), Y(L.MOUTH_RIGHT) - S * 0.02, X(L.MOUTH_LEFT) - X(L.MOUTH_RIGHT), S * 0.045);
  return cv;
}

/**
 * Run the figure through the landmarker a few times and report honestly.
 *
 * Note the timeout can only be enforced BETWEEN attempts: `detectForVideo` is
 * synchronous and blocks the calling thread for the whole inference, so
 * nothing — not a timer, not an abort signal — can interrupt one. That is also
 * the entire argument for running this in a Worker.
 */
export async function warmupLandmarker(
  target: WarmupTarget,
  opts: WarmupOpts = {},
): Promise<WarmupResult> {
  const attempts = opts.attempts ?? 3;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const now = opts.now ?? clock;
  const t0 = now();
  let ts = opts.startTimestampMs ?? 1;
  let poseFound = false;
  let ran = 0;

  let figure: OffscreenCanvas;
  try {
    figure = drawWarmupFigure(opts.size ?? 256, opts.pose);
  } catch (e) {
    return {
      ok: false,
      poseFound: false,
      attempts: 0,
      ms: now() - t0,
      lastTimestampMs: ts,
      message: `could not build the warmup figure: ${String((e as Error).message ?? e)}`,
    };
  }

  for (let i = 0; i < attempts; i++) {
    if (now() - t0 > timeoutMs) {
      return {
        ok: false,
        poseFound,
        attempts: ran,
        ms: now() - t0,
        lastTimestampMs: ts,
        message: `warmup timed out after ${Math.round(now() - t0)}ms on attempt ${ran}`,
      };
    }
    try {
      let res: { landmarks: unknown[] } | void;
      if (target.detectForVideo) {
        res = target.detectForVideo(figure, ts);
        ts += 40; // strictly increasing, ~25Hz apart
      } else if (target.detect) {
        res = target.detect(figure);
      } else {
        return {
          ok: false,
          poseFound: false,
          attempts: 0,
          ms: now() - t0,
          lastTimestampMs: ts,
          message: 'landmarker exposes neither detect() nor detectForVideo()',
        };
      }
      ran++;
      if (res && Array.isArray(res.landmarks) && res.landmarks.length > 0) poseFound = true;
    } catch (e) {
      return {
        ok: false,
        poseFound,
        attempts: ran,
        ms: now() - t0,
        lastTimestampMs: ts,
        message: `warmup threw on attempt ${ran + 1}: ${String((e as Error).message ?? e)}`,
      };
    }
    // Yield so the loading screen can animate between blocking inferences.
    await new Promise<void>((r) => setTimeout(r, 0));
  }

  const ms = now() - t0;
  return {
    ok: true,
    poseFound,
    attempts: ran,
    ms,
    lastTimestampMs: ts,
    message: poseFound
      ? `warm: landmark graph compiled in ${Math.round(ms)}ms over ${ran} frames`
      : `ran ${ran} frames in ${Math.round(ms)}ms but the synthetic figure did not trigger detection — ` +
        'the landmark subgraph is still uncompiled, so absorb that compile behind the calibration screen',
  };
}

/** Sanity check for the figure itself, used by the unit test: a figure whose
 *  own landmarks are off-canvas cannot possibly be detected. */
export function figureBounds(pose?: Partial<BodyParams>): { min: number; max: number } {
  const lm = body({ ...FIGURE, ...pose }, 1);
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < LANDMARK_COUNT * 2; i++) {
    const v = lm[i]!;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}
