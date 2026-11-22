// MediaPipePoseSource — the real camera.
//
// @mediapipe/tasks-vision@1.2.3 PoseLandmarker, wasm self-hosted from /wasm and
// the model from /models/pose_landmarker_lite.task. Nothing here touches the
// network: 14.7MB of wasm over a flaky school wifi is the worst load-time risk
// in the project, and a third-party request would break the privacy promise the
// 개인정보 안내 page makes.
//
// The decisions that matter, each one paid for by a documented failure:
//
//  * Inference runs in a module WORKER (pose.worker.ts), one ImageBitmap in
//    flight at a time. detectForVideo is synchronous; on the main thread it
//    blocks a rendered frame 20-30 times a second, which on a 2015 MacBook is
//    the difference between 60fps and a stutter. If the worker cannot start,
//    we fall back to the main thread at a lower rate rather than fail.
//  * The wasm LOADER must match the thread: classic on the main thread, module
//    in the worker. See visionWasmPaths() — getting this wrong was the
//    "카메라는 켜졌는데 준비에 실패했어요" start failure.
//  * ONE landmarker, reused, closed on every teardown path. Browsers cap live
//    WebGL contexts at ~16 per domain; a landmarker per mini-game loses the
//    context somewhere around game nine.
//  * rVFC drives detection, with the `video.currentTime` dedupe, so a camera
//    frame is never inferred twice. rAF drives the render loop elsewhere.
//  * Timestamps STRICTLY monotonically increase. A repeated or decreasing
//    timestamp makes detectForVideo throw or silently return garbage.
//  * sample() EXTRAPOLATES from the last inference using filtered velocity and
//    reports inferenceAgeMs. Decoupling 25Hz inference from the 60Hz game loop
//    is the highest-value decision in the engine.
//  * Every failure says something a person can act on. "The game stopped
//    responding" is the worst possible failure mode in a room full of children.
//
// The library is imported dynamically so that merely importing this module
// costs the lobby nothing (and so this file stays importable in Node).
import type { PoseLandmarker, PoseLandmarkerResult } from '@mediapipe/tasks-vision';
import type { CalibrationProfile, PoseFrame } from '../types';
import type { PersonFrame } from '../testing/synth';
import { LANDMARK_COUNT } from './landmarks';
import { AutoCalibrator, CalibrationCapture } from './calibration';
import { FpsMeter, MAX_EXTRAPOLATE_SEC } from './frame';
import { PoseIdentity } from './identity';
import { detectCapability, diagnoseGpuFailure, type PoseTierConfig } from './capability';
import { warmupLandmarker, type WarmupResult } from './warmup';
import type { OneEuroConfig } from './oneEuro';
import { defaultCalibration, type PoseSource, type PoseSourceInfo } from './source';
import {
  flattenPoses, LM_STRIDE, nextTimestamp, visionWasmPaths, type FromWorker, type ToWorker,
} from './poseWorkerProtocol';

export interface MediaPipeOpts {
  /** The <video> the camera stream is attached to. Owned by the shell: this
   *  source never creates DOM. */
  video: HTMLVideoElement;
  /** The rect the video is displayed into, in logical px. Read every
   *  inference, so a resize needs no notification. */
  view: () => { w: number; h: number };
  config?: PoseTierConfig;
  maxPlayers?: 1 | 2 | 3 | 4;
  wasmPath?: string;
  modelPath?: string;
  filter?: OneEuroConfig;
  calib?: CalibrationProfile;
  /** Run the shader-compile warmup before the first real frame. */
  warmup?: boolean;
  /** Infer in a Web Worker (default true). `false` forces the main thread —
   *  the `?worker=off` escape hatch. */
  worker?: boolean;
  /** Acquire (or re-acquire) the camera stream. Defaults to getUserMedia with
   *  the constraints from the tier. */
  getStream?: (cfg: PoseTierConfig) => Promise<MediaStream>;
  /** ms clock, injectable for tests. */
  now?: () => number;
  onWarning?: (msg: string) => void;
}

const MODEL_PATHS: Record<'lite' | 'full', string> = {
  lite: '/models/pose_landmarker_lite.task',
  full: '/models/pose_landmarker_full.task',
};

/** wasm compile + model parse + GPU context. Seconds on a 2015 laptop, never
 *  this long unless the worker is broken — then the main thread takes over. */
const WORKER_INIT_TIMEOUT_MS = 20_000;
/** The landmark-subgraph shader compile has been measured at ~20s cold. Past
 *  this we stop waiting; the compile finishes in the worker on its own. */
const WORKER_WARMUP_TIMEOUT_MS = 25_000;
/** Main-thread fallback rate. Every inference there blocks a rendered frame,
 *  so trade a little tracking rate for a game that still animates. */
const MAIN_THREAD_MAX_HZ = 20;
/** play() can stay pending forever on a stream that delivers no frames. */
const PLAY_TIMEOUT_MS = 3000;
/** A worker reply never takes this long (~50–100 ms normally). Past it the
 *  worker is wedged — e.g. its GPU context was lost across a laptop sleep —
 *  and the main thread takes over rather than leave the body frozen. */
const WORKER_STALL_MS = 3000;
/** Likewise for a worker that answers, but only with errors. */
const WORKER_MAX_ERRORS = 10;
/**
 * Shorter side of the frame copied to the worker, px.
 *
 * The model never sees more than 256x256: the detector letterboxes the whole
 * frame to 224, the landmark model crops the body to 256. A standing body's
 * crop spans at least ~3/4 of the frame height even at 4m, so 360 rows still
 * feed that crop >= 256 rows and nothing is upsampled — while a 960x540
 * capture copies, transfers and uploads 2.25x fewer pixels per inference.
 * Aspect is kept, so normalised landmarks are unchanged.
 */
export const INFER_SHORT_SIDE = 360;

/** createImageBitmap resize for a `vw` x `vh` frame, or null when the frame
 *  is already that small. Written into `out` so the per-frame path does not
 *  allocate. */
export function inferResize(
  vw: number,
  vh: number,
  out: { resizeWidth: number; resizeHeight: number },
): typeof out | null {
  const short = Math.min(vw, vh);
  if (!(short > INFER_SHORT_SIDE)) return null;
  const k = INFER_SHORT_SIDE / short;
  out.resizeWidth = Math.round(vw * k);
  out.resizeHeight = Math.round(vh * k);
  return out;
}

const clock = (): number => (typeof performance !== 'undefined' ? performance.now() : 0);
const errText = (e: unknown): string => String((e as Error | undefined)?.message ?? e);

/** getUserMedia constraints. Every value is `ideal`: `exact` throws
 *  OverconstrainedError on Chromebook webcams that only offer odd modes, and
 *  `frameRate max 30` stops a 60fps webcam doubling the frame budget for
 *  nothing. `playsInline` + `muted` are set by the caller on the element, or
 *  iOS hijacks the video fullscreen and blocks autoplay. */
export function cameraConstraints(cfg: PoseTierConfig): MediaStreamConstraints {
  return {
    audio: false,
    video: {
      facingMode: 'user',
      width: { ideal: cfg.width },
      height: { ideal: cfg.height },
      frameRate: { ideal: 30, max: 30 },
      resizeMode: 'crop-and-scale',
    } as MediaTrackConstraints,
  };
}

/** Can this browser run the worker path at all? Checked up front so the
 *  common "no" costs nothing. */
export function workerSupported(): boolean {
  return (
    typeof Worker !== 'undefined' &&
    typeof OffscreenCanvas !== 'undefined' &&
    typeof createImageBitmap === 'function'
  );
}

export class MediaPipePoseSource implements PoseSource {
  readonly info: PoseSourceInfo;
  readonly config: PoseTierConfig;
  /** Continuous, screenless calibration, fed at inference rate. Nothing here
   *  applies it: the shell freezes it into `setCalibration()` at round start
   *  (see calibration.ts "FREEZE IS THE CALLER'S CALL"). */
  readonly autoCalibration: AutoCalibrator;
  /** Set once warmup has run, so the shell can decide whether to absorb the
   *  shader compile behind the calibration screen instead. */
  warmupResult: WarmupResult | undefined;

  private o: MediaPipeOpts;
  private identity: PoseIdentity;
  private calib: CalibrationProfile;
  private landmarker: PoseLandmarker | undefined;
  private worker: Worker | undefined;
  private delegate: 'GPU' | 'CPU';
  private stream: MediaStream | undefined;
  private fpsMeter = new FpsMeter();
  private now: () => number;

  private lastVideoTime = -1;
  private lastTimestampMs = 0;
  /** Wall-clock ms of the last frame SENT to inference. */
  private lastSubmitMs = 0;
  /** Wall-clock ms the rate throttle next lets a frame through. */
  private nextDueMs = 0;
  /** Wall-clock seconds of the last inference, for the fps meter only. */
  private lastInferT = -1;
  /** Wall-clock ms the last inferred frame was captured, for `inferenceAgeMs`. */
  private lastInferMs = 0;
  private running = false;
  private paused = false;
  private rvfcHandle = 0;
  private rafHandle = 0;
  private disposed = false;
  private capture: CalibrationCapture | undefined;
  private captureResolve: ((p: CalibrationProfile) => void) | undefined;
  private captureReject: ((e: Error) => void) | undefined;
  private reacquiring = false;
  private stalled = false;

  // Worker bookkeeping: one frame in flight, and at most one pending request.
  private inFlight = false;
  private inFlightAt = 0;
  /** Watchdog clock for the frame in flight. Separate from inFlightAt (the
   *  capture time results are stamped with) so a pause can restart it. */
  private watchSince = 0;
  private workerErrs = 0;
  private submitTs = 0;
  /** Reused createImageBitmap options; null once a browser has rejected them. */
  private resize: (ImageBitmapOptions & { resizeWidth: number; resizeHeight: number }) | null = {
    resizeWidth: 0, resizeHeight: 0, resizeQuality: 'low',
  };
  private resizing = false;
  private reply:
    | { type: FromWorker['type']; resolve: (m: FromWorker) => void; reject: (e: Error) => void }
    | undefined;

  // One reusable detection buffer per pose slot, filled from the flattened
  // result — the only place a MediaPipe result is read.
  private people: PersonFrame[] = [];
  private detsOut: PersonFrame[] = [];
  private flat = new Float32Array(LANDMARK_COUNT * LM_STRIDE * 4);

  constructor(opts: MediaPipeOpts) {
    this.o = opts;
    this.now = opts.now ?? clock;
    this.config = opts.config ?? detectCapability({ maxPlayers: opts.maxPlayers ?? 1 });
    this.delegate = this.config.delegate;
    const view = opts.view();
    this.calib = opts.calib ?? defaultCalibration(view.w, view.h);
    this.identity = new PoseIdentity({
      maxPlayers: opts.maxPlayers ?? 2,
      calib: this.calib,
      filter: opts.filter,
      slowFactor: this.config.slowFactor,
    });
    this.autoCalibration = new AutoCalibrator({
      view,
      fps: this.config.targetHz,
      mirrored: this.calib.mirrored,
    });
    for (let i = 0; i < 4; i++) {
      this.people.push({
        lm: new Float32Array(LANDMARK_COUNT * 2),
        vis: new Float32Array(LANDMARK_COUNT),
      });
    }
    this.info = { kind: 'camera', fps: 0, tier: this.config.tier };
    if (this.config.warningKo) this.info.warning = this.config.warningKo;
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.running) return;
    this.disposed = false;
    const video = this.o.video;

    if (!video.srcObject) {
      const get = this.o.getStream ?? ((cfg: PoseTierConfig) =>
        navigator.mediaDevices.getUserMedia(cameraConstraints(cfg)));
      this.stream = await get(this.config);
      video.srcObject = this.stream;
    } else {
      this.stream = video.srcObject as MediaStream;
    }
    this.watchTracks();

    video.muted = true;
    video.playsInline = true;
    // Bounded: on a stream that never produces a frame play() never settles,
    // and an unbounded await here is a setup screen that hangs forever.
    await Promise.race([
      video.play().catch(() => {
        // Autoplay can still be blocked; the shell shows a tap-to-start button.
        this.warn('카메라를 시작하려면 화면을 한 번 눌러 주세요.');
      }),
      new Promise<void>((r) => setTimeout(r, PLAY_TIMEOUT_MS)),
    ]);
    // A slow first frame is not a reason to refuse to start. The pump below
    // waits for real frames anyway, and a camera that is merely slow to warm
    // up must not look to the player like a camera that failed.
    try {
      await waitForVideo(video);
    } catch (e) {
      this.o.onWarning?.(`[pose] 카메라 영상이 늦게 와요 (${errText(e)})`);
    }

    if (this.o.worker !== false && workerSupported()) {
      try {
        await this.startWorker();
      } catch (e) {
        this.killWorker();
        this.o.onWarning?.(`[pose] worker unavailable, inferring on the main thread (${errText(e)})`);
      }
    }
    if (!this.worker && !this.disposed) await this.startMainThread();
    if (this.disposed) {
      // stop() ran while we were starting: release what start() just built
      // instead of resurrecting a source the shell has already closed.
      this.killWorker();
      this.landmarker?.close();
      this.landmarker = undefined;
      return;
    }
    this.info.tier = `${this.config.tier} · ${this.delegate} · ${this.worker ? 'worker' : 'main'}`;

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibility);
    }

    this.running = true;
    this.pump();

    // Resolve once a first frame really is available, but never hang the UI on
    // a camera that is producing nothing.
    const deadline = this.now() + 2500;
    while (this.lastInferT < 0 && this.now() < deadline && !this.disposed) {
      await new Promise<void>((r) => setTimeout(r, 30));
    }
    if (this.lastInferT < 0) this.warn('카메라에서 아직 사람이 보이지 않아요.');
  }

  stop(): void {
    this.running = false;
    this.disposed = true;
    this.cancelPump();
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibility);
    }
    // Every teardown path stops the tracks: the camera indicator staying lit
    // after a party has finished is both a battery and a trust problem.
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = undefined;
    if (this.o.video.srcObject) this.o.video.srcObject = null;
    this.killWorker();
    this.landmarker?.close();
    this.landmarker = undefined;
    this.identity.reset();
    this.captureReject?.(new Error('[pose] stopped during calibration'));
    this.clearCapture();
  }

  pause(): void {
    this.paused = true;
    this.cancelPump();
  }

  resume(): void {
    if (!this.running) return;
    this.paused = false;
    // Reset the dedupe and the time base: the camera kept running while we
    // were not looking, so the next frame is "new" and dt is meaningless.
    this.resetTimeBase();
    this.identity.teleport();
    this.pump();
  }

  // ── frames ───────────────────────────────────────────────────────────────

  sample(tSec: number): PoseFrame {
    const view = this.o.view();
    // Staleness is measured on OUR OWN wall clock, never against `tSec`.
    //
    // `tSec` is the caller's logical round time (PoseFrame.t is documented as
    // "seconds since the round started") while inferences are stamped with
    // performance.now(). Subtracting one from the other is a bug that hides
    // itself: the difference is enormous and negative, clamps to 0, and the
    // camera path silently stops extrapolating while the replay path — which
    // has only one clock — keeps working perfectly.
    const age =
      this.paused || this.lastInferMs <= 0
        ? 0
        : Math.min(MAX_EXTRAPOLATE_SEC, Math.max(0, (this.now() - this.lastInferMs) / 1000));
    // A camera that has stopped delivering frames altogether produces no
    // inferences, so nothing ages out and the body just freezes. Say so:
    // "the game stopped responding" is the worst possible failure mode in a
    // room full of children (Jumping Jack shows its banner after 1.2s).
    if (this.running && !this.paused && this.lastInferMs > 0) {
      const stalled = this.now() - this.lastInferMs > 1500;
      if (stalled && !this.stalled) {
        this.stalled = true;
        this.warn('카메라가 멈춘 것 같아요. 잠깐만요!');
      } else if (!stalled && this.stalled) {
        this.stalled = false;
        this.info.warning = undefined;
      }
    }
    this.info.fps = this.fpsMeter.fps;
    return this.identity.project(tSec, age, this.fpsMeter.fps, view.w, view.h);
  }

  setCalibration(c: CalibrationProfile): void {
    this.calib = c;
    this.identity.setCalibration(c);
  }

  calibrate(ms: number): Promise<CalibrationProfile> {
    this.clearCapture();
    this.capture = new CalibrationCapture({ ms, mirrored: this.calib.mirrored });
    return new Promise<CalibrationProfile>((resolve, reject) => {
      this.captureResolve = resolve;
      this.captureReject = reject;
      // Hard deadline: a child who wandered off must not hang the session.
      setTimeout(() => {
        if (!this.capture) return;
        this.finishCapture(true);
      }, ms + 2500);
    });
  }

  /** 0..1 for the calibration progress ring. */
  get calibrationProgress(): number {
    return this.capture?.progress ?? 0;
  }

  get trackStates(): PoseIdentity['trackStates'] {
    return this.identity.trackStates;
  }

  // ── backends ─────────────────────────────────────────────────────────────

  private async startWorker(): Promise<void> {
    // The literal `new Worker(new URL(...), {type:'module'})` shape is what
    // Vite looks for to bundle the worker; do not factor it out.
    const w = new Worker(new URL('./pose.worker.ts', import.meta.url), { type: 'module' });
    this.worker = w;
    w.onmessage = this.onWorkerMessage;
    w.onerror = this.onWorkerError;

    const ready = (await this.request(
      {
        type: 'init',
        wasmBase: this.o.wasmPath ?? '/wasm',
        modelPath: this.o.modelPath ?? MODEL_PATHS[this.config.model],
        delegate: this.config.delegate,
        numPoses: this.config.numPoses,
      },
      'ready',
      WORKER_INIT_TIMEOUT_MS,
    )) as Extract<FromWorker, { type: 'ready' }>;
    this.delegate = ready.delegate;
    if (ready.gpuError !== undefined) {
      this.warn(`그래픽 가속을 쓸 수 없어 느릴 수 있어요. (${diagnoseGpuFailure(new Error(ready.gpuError))})`);
    }

    if (this.o.warmup === false) return;
    // NON-FATAL: see startMainThread(). In the worker a timeout costs nothing
    // either — the compile finishes there and the first frames queue behind it.
    try {
      const m = (await this.request({ type: 'warmup' }, 'warmed', WORKER_WARMUP_TIMEOUT_MS)) as
        Extract<FromWorker, { type: 'warmed' }>;
      this.warmupResult = m.result;
      if (!m.result.poseFound) this.o.onWarning?.(`[pose] ${m.result.message}`);
    } catch (e) {
      this.o.onWarning?.(`[pose] 미리 준비를 건너뛰었어요 (${errText(e)})`);
    }
  }

  private async startMainThread(): Promise<void> {
    this.landmarker = await this.createLandmarker();
    if (this.o.warmup === false) return;
    // Shader compile: the landmark subgraph only compiles when a body first
    // appears, and that pass has been measured at ~20s on a cold cache.
    //
    // NON-FATAL, deliberately. Warmup is an optimisation — it pre-pays a
    // stall that would otherwise land mid-round. If it throws (no
    // OffscreenCanvas, a GPU that rejects the synthetic frame, a timeout),
    // the game still works; the stall simply gets paid later, behind the
    // calibration screen where a real body is in frame. Letting it fail the
    // whole start told a player who had just granted camera permission that
    // their camera did not work, which is both wrong and unactionable.
    try {
      this.warmupResult = await warmupLandmarker(this.landmarker as unknown as {
        detectForVideo: (i: unknown, t: number) => PoseLandmarkerResult;
      }, { startTimestampMs: this.lastTimestampMs + 1 });
      this.lastTimestampMs = Math.max(this.lastTimestampMs, this.warmupResult.lastTimestampMs);
      if (!this.warmupResult.poseFound) {
        this.o.onWarning?.(`[pose] ${this.warmupResult.message}`);
      }
    } catch (e) {
      this.o.onWarning?.(`[pose] 미리 준비를 건너뛰었어요 (${errText(e)})`);
    }
  }

  private async createLandmarker(): Promise<PoseLandmarker> {
    const vision = await import('@mediapipe/tasks-vision');
    // CLASSIC loader: on the main thread tasks-vision injects it as a plain
    // <script>. See visionWasmPaths().
    const fileset = visionWasmPaths(this.o.wasmPath ?? '/wasm', false);
    const modelAssetPath = this.o.modelPath ?? MODEL_PATHS[this.config.model];
    const base = {
      runningMode: 'VIDEO' as const,
      numPoses: this.config.numPoses,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
      outputSegmentationMasks: false,
    };
    try {
      const lm = await vision.PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath, delegate: this.config.delegate },
        ...base,
      });
      this.delegate = this.config.delegate;
      return lm;
    } catch (err) {
      if (this.config.delegate === 'CPU') throw err;
      // GPU -> CPU, with a diagnosis. delegate:"CPU" is NOT a universal escape
      // hatch (the wasm module still wants an offscreen WebGL2 context), so say
      // what went wrong either way.
      const why = diagnoseGpuFailure(err);
      this.warn(`그래픽 가속을 쓸 수 없어 느릴 수 있어요. (${why})`);
      const lm = await vision.PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath, delegate: 'CPU' },
        ...base,
      });
      this.delegate = 'CPU';
      return lm;
    }
  }

  /** One request to the worker, answered by a reply of type `expect`. */
  private request(msg: ToWorker, expect: FromWorker['type'], timeoutMs: number): Promise<FromWorker> {
    return new Promise<FromWorker>((resolve, reject) => {
      const to = setTimeout(() => {
        this.reply = undefined;
        reject(new Error(`${msg.type} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.reply = {
        type: expect,
        resolve: (m) => { clearTimeout(to); resolve(m); },
        reject: (e) => { clearTimeout(to); reject(e); },
      };
      this.worker!.postMessage(msg);
    });
  }

  private onWorkerMessage = (e: MessageEvent<FromWorker>): void => {
    const m = e.data;
    if (m.type === 'result') {
      this.inFlight = false;
      this.workerErrs = 0;
      if (this.disposed) return;
      this.ingest(m.data, m.n, this.inFlightAt);
      // The camera usually delivered a newer frame while this one was being
      // inferred. Send it now instead of idling until the next frame callback:
      // an inference just over 33 ms otherwise waits for the frame AFTER next,
      // which halves a 30 fps camera to 15 Hz.
      if (this.running && !this.paused && !(typeof document !== 'undefined' && document.hidden)) {
        const nowMs = this.now();
        this.submit(nowMs, this.lastTimestampMs + (nowMs - this.lastSubmitMs));
      }
      return;
    }
    if (m.type === 'detectError') {
      this.inFlight = false;
      if (++this.workerErrs >= WORKER_MAX_ERRORS) {
        this.failOver(`${WORKER_MAX_ERRORS} detect errors in a row: ${m.message}`);
      } else {
        this.warn(`카메라 인식에 문제가 있어요. (${m.message})`);
      }
      return;
    }
    const r = this.reply;
    if (!r) return; // a late reply to a request we already gave up on
    if (m.type === 'initError') {
      this.reply = undefined;
      r.reject(new Error(m.message));
    } else if (m.type === r.type) {
      this.reply = undefined;
      r.resolve(m);
    }
  };

  private onWorkerError = (e: ErrorEvent): void => {
    e.preventDefault();
    const why = e.message || 'worker failed to load';
    const r = this.reply;
    if (r) {
      this.reply = undefined;
      r.reject(new Error(why));
      return;
    }
    this.failOver(`worker crashed (${why})`);
  };

  /** The worker died or wedged mid-session. A frozen body is the worst
   *  outcome, so take over on the main thread rather than leave the round
   *  without a camera. */
  private failOver(why: string): void {
    if (!this.worker) return;
    this.killWorker();
    this.workerErrs = 0;
    if (this.disposed) return;
    this.o.onWarning?.(`[pose] ${why}; inferring on the main thread`);
    this.createLandmarker().then(
      (lm) => {
        if (this.disposed) lm.close();
        else {
          this.landmarker = lm;
          this.info.tier = `${this.config.tier} · ${this.delegate} · main`;
        }
      },
      (err) => this.warn(`카메라 인식을 다시 시작할 수 없어요. (${errText(err)})`),
    );
  }

  private killWorker(): void {
    const r = this.reply;
    this.reply = undefined;
    r?.reject(new Error('[pose] stopped'));
    this.worker?.terminate();
    this.worker = undefined;
    this.inFlight = false;
  }

  private sendBitmap = (bmp: ImageBitmap): void => {
    const w = this.worker;
    if (!w || this.disposed) {
      bmp.close();
      this.inFlight = false;
      return;
    }
    const msg: ToWorker = { type: 'detect', bitmap: bmp, ts: this.submitTs };
    w.postMessage(msg, [bmp]);
  };

  private dropBitmap = (e?: unknown): void => {
    this.inFlight = false;
    if (this.resizing && this.resize) {
      // A browser that rejects the resize options would otherwise never infer
      // again: fall back to full-size copies, which always worked.
      this.resize = null;
      this.o.onWarning?.(`[pose] frame downscale unavailable, sending full frames (${errText(e)})`);
    }
  };

  // ── frames, internals ────────────────────────────────────────────────────

  private pump = (): void => {
    // Never two callback chains: resume() and the visibility handler can both
    // re-arm, and each extra chain inferred every frame once more.
    this.cancelPump();
    if (!this.running || this.paused || this.disposed) return;
    const video = this.o.video;
    const useRvfc = typeof video.requestVideoFrameCallback === 'function';
    if (useRvfc) {
      this.rvfcHandle = video.requestVideoFrameCallback(this.onVideoFrame);
    } else {
      // Firefox has lagged on rVFC; the currentTime dedupe does all the work.
      this.rafHandle = requestAnimationFrame(() => this.onVideoFrame(this.now()));
    }
  };

  private cancelPump(): void {
    const video = this.o.video;
    if (this.rvfcHandle && typeof video.cancelVideoFrameCallback === 'function') {
      video.cancelVideoFrameCallback(this.rvfcHandle);
    }
    if (this.rafHandle) cancelAnimationFrame(this.rafHandle);
    this.rvfcHandle = 0;
    this.rafHandle = 0;
  }

  private onVideoFrame = (_now: number, meta?: VideoFrameCallbackMetadata): void => {
    this.rvfcHandle = 0;
    this.rafHandle = 0;
    if (!this.running || this.paused || this.disposed) return;
    const nowMs = this.now();
    if (this.worker && this.inFlight && nowMs - this.watchSince > WORKER_STALL_MS) {
      this.failOver(`no reply from the worker for ${WORKER_STALL_MS} ms`);
      this.pump();
      return;
    }
    this.submit(nowMs, meta ? meta.mediaTime * 1000 : nowMs);
    this.pump();
  };

  /** Infer the frame the video is showing now, if it is new and the rate
   *  allows. `frameMs` is that frame's time on the detector's clock. */
  private submit(nowMs: number, frameMs: number): void {
    const video = this.o.video;
    const onWorker = this.worker !== undefined;
    const lm = this.landmarker;

    // Throttle to the tier's rate, and never infer the same camera frame twice.
    const hz = onWorker ? this.config.targetHz : Math.min(this.config.targetHz, MAIN_THREAD_MAX_HZ);
    const minGap = 1000 / Math.max(1, hz);
    const fresh = video.currentTime !== this.lastVideoTime;
    const ready = onWorker ? !this.inFlight : lm !== undefined;
    if (ready && fresh && nowMs >= this.nextDueMs - 2 && video.videoWidth > 0) {
      this.lastVideoTime = video.currentTime;
      this.lastSubmitMs = nowMs;
      // Pace by the AVERAGE rate, not by the gap to the last frame: a strict
      // 40 ms gap (25 Hz) refuses every other frame of a 30 fps camera, which
      // is 15 Hz. Lateness is never banked, so this cannot burst.
      this.nextDueMs = Math.max(this.nextDueMs + minGap, nowMs);
      // Strictly increasing, always. mediaTime is the honest frame clock, but
      // it repeats if the camera stalls, so clamp upward.
      const ts = nextTimestamp(frameMs, this.lastTimestampMs);
      this.lastTimestampMs = ts;
      if (onWorker) {
        // Off the main thread: a copy of the frame goes over, the result
        // comes back as a message. Nothing here waits for it.
        this.inFlight = true;
        this.inFlightAt = nowMs;
        this.watchSince = nowMs;
        this.submitTs = ts;
        const opts = this.resize && inferResize(video.videoWidth, video.videoHeight, this.resize);
        this.resizing = !!opts;
        (opts ? createImageBitmap(video, opts) : createImageBitmap(video)).then(
          this.sendBitmap,
          this.dropBitmap,
        );
      } else if (lm) {
        try {
          const res = lm.detectForVideo(video, ts);
          this.ingest(this.flat, flattenPoses(res?.landmarks, this.flat, LANDMARK_COUNT), nowMs);
        } catch (e) {
          this.warn(`카메라 인식에 문제가 있어요. (${errText(e)})`);
        }
      }
    }
  }

  /** One inference's worth of poses, flattened as [pose][joint][x, y, vis],
   *  stamped with the wall-clock ms the frame was CAPTURED — so the latency of
   *  the inference itself shows up in inferenceAgeMs and gets extrapolated. */
  private ingest(data: Float32Array, n: number, nowMs: number): void {
    const view = this.o.view();
    const tSec = nowMs / 1000;
    if (this.lastInferT >= 0) this.fpsMeter.sample(tSec - this.lastInferT);
    this.lastInferT = tSec;
    this.lastInferMs = nowMs;

    const out = this.detsOut;
    out.length = 0;
    const per = LANDMARK_COUNT * LM_STRIDE;
    for (let i = 0; i < n && i < this.people.length; i++) {
      const dst = this.people[i]!;
      const base = i * per;
      for (let j = 0; j < LANDMARK_COUNT; j++) {
        const k = base + j * LM_STRIDE;
        dst.lm[j * 2] = data[k]!;
        dst.lm[j * 2 + 1] = data[k + 1]!;
        dst.vis[j] = data[k + 2]!;
      }
      out.push(dst);
    }
    this.identity.update(out, tSec, view.w, view.h);

    // Calibrators see the un-extrapolated pose at inference rate. project()
    // writes into the shared frame, so put back the clock fields sample() owns:
    // a game holding the frame between steps must not see wall-clock seconds.
    const f = this.identity.frame;
    const keepT = f.t;
    const keepAge = f.inferenceAgeMs;
    this.identity.project(tSec, 0, this.fpsMeter.fps, view.w, view.h);
    f.t = keepT;
    f.inferenceAgeMs = keepAge;
    const p = f.p1;
    this.autoCalibration.setView(view.w, view.h);
    this.autoCalibration.feed(p, tSec);
    if (this.capture) {
      if (p?.present) this.capture.feed(p, tSec, view.h);
      if (this.capture.done) this.finishCapture(false);
    }
  }

  private finishCapture(timedOut: boolean): void {
    const cap = this.capture;
    if (!cap) return;
    try {
      const profile = cap.finish(this.now());
      this.setCalibration(profile);
      this.captureResolve?.(profile);
    } catch (e) {
      const why = timedOut
        ? '카메라에 몸이 충분히 보이지 않았어요. 한 걸음 뒤로 가 볼까요?'
        : errText(e);
      this.captureReject?.(new Error(why));
    }
    this.clearCapture();
  }

  private clearCapture(): void {
    this.capture = undefined;
    this.captureResolve = undefined;
    this.captureReject = undefined;
  }

  private resetTimeBase(): void {
    // Time spent paused or hidden is not the worker stalling.
    this.watchSince = this.now();
    this.lastVideoTime = -1;
    this.lastInferT = -1;
    this.lastInferMs = 0;
    this.lastSubmitMs = 0;
    this.nextDueMs = 0;
    this.fpsMeter.reset();
  }

  private onVisibility = (): void => {
    if (typeof document === 'undefined') return;
    if (document.hidden) {
      this.cancelPump();
    } else if (this.running && !this.paused) {
      this.resetTimeBase();
      this.pump();
    }
  };

  /** iOS interrupts the camera on calls, Control Center, app switch and screen
   *  lock; the track goes muted or ended and never recovers on its own. */
  private watchTracks(): void {
    for (const track of this.stream?.getVideoTracks() ?? []) {
      track.onmute = () => this.warn('카메라가 잠깐 멈췄어요. 다시 연결할게요.');
      track.onunmute = () => {
        this.info.warning = undefined;
        this.lastVideoTime = -1;
      };
      track.onended = () => void this.reacquire();
    }
  }

  private async reacquire(): Promise<void> {
    if (this.reacquiring || this.disposed) return;
    this.reacquiring = true;
    try {
      for (const t of this.stream?.getTracks() ?? []) t.stop();
      const get = this.o.getStream ?? ((cfg: PoseTierConfig) =>
        navigator.mediaDevices.getUserMedia(cameraConstraints(cfg)));
      this.stream = await get(this.config);
      this.o.video.srcObject = this.stream;
      this.watchTracks();
      await this.o.video.play().catch(() => {});
      this.resetTimeBase();
      this.identity.teleport();
      this.info.warning = undefined;
      // A frame callback registered on the old stream may never fire again.
      if (this.running && !this.paused) this.pump();
    } catch (e) {
      this.warn(`카메라를 다시 켤 수 없어요. (${errText(e)})`);
    } finally {
      this.reacquiring = false;
    }
  }

  private warn(msg: string): void {
    this.info.warning = msg;
    this.o.onWarning?.(msg);
  }
}

/** `detectForVideo` on a zero-dimension video throws or produces garbage. */
export function waitForVideo(video: HTMLVideoElement, timeoutMs = 8000): Promise<void> {
  if (video.readyState >= 2 && video.videoWidth > 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const to = setTimeout(() => {
      cleanup();
      reject(new Error('[pose] camera gave no frames'));
    }, timeoutMs);
    const onReady = (): void => {
      if (video.videoWidth === 0) return;
      cleanup();
      resolve();
    };
    const cleanup = (): void => {
      clearTimeout(to);
      video.removeEventListener('loadeddata', onReady);
      video.removeEventListener('canplay', onReady);
    };
    video.addEventListener('loadeddata', onReady);
    video.addEventListener('canplay', onReady);
  });
}
