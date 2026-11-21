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
//  * ONE landmarker, reused, close() on every teardown path. Browsers cap live
//    WebGL contexts at ~16 per domain; a landmarker per mini-game loses the
//    context somewhere around game nine.
//  * rVFC drives detection, with the `video.currentTime` dedupe, so a camera
//    frame is never inferred twice. rAF drives the render loop elsewhere.
//  * Timestamps STRICTLY monotonically increase. A repeated or decreasing
//    timestamp makes detectForVideo throw or silently return garbage.
//  * Inference is throttled to the tier's target rate. The model downsamples to
//    256x256 internally, so running faster than the camera buys nothing.
//  * sample() EXTRAPOLATES from the last inference using filtered velocity and
//    reports inferenceAgeMs. Decoupling 25Hz inference from the 60Hz game loop
//    is the highest-value decision in the engine: 12fps inference still feels
//    fine when the game itself is smooth.
//  * Every failure says something a person can act on. "The game stopped
//    responding" is the worst possible failure mode in a room full of children.
//
// The library is imported dynamically so that merely importing this module
// costs the lobby nothing (and so this file stays importable in Node).
import type { PoseLandmarker, PoseLandmarkerResult } from '@mediapipe/tasks-vision';
import type { CalibrationProfile, PoseFrame } from '../types';
import type { PersonFrame } from '../testing/synth';
import { LANDMARK_COUNT } from './landmarks';
import { CalibrationCapture } from './calibration';
import { FpsMeter, MAX_EXTRAPOLATE_SEC } from './frame';
import { PoseIdentity } from './identity';
import { detectCapability, diagnoseGpuFailure, type PoseTierConfig } from './capability';
import { warmupLandmarker, type WarmupResult } from './warmup';
import type { OneEuroConfig } from './oneEuro';
import { defaultCalibration, type PoseSource, type PoseSourceInfo } from './source';

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

const clock = (): number => (typeof performance !== 'undefined' ? performance.now() : 0);

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

export class MediaPipePoseSource implements PoseSource {
  readonly info: PoseSourceInfo;
  readonly config: PoseTierConfig;
  /** Set once warmup has run, so the shell can decide whether to absorb the
   *  shader compile behind the calibration screen instead. */
  warmupResult: WarmupResult | undefined;

  private o: MediaPipeOpts;
  private identity: PoseIdentity;
  private calib: CalibrationProfile;
  private landmarker: PoseLandmarker | undefined;
  private stream: MediaStream | undefined;
  private fpsMeter = new FpsMeter();
  private now: () => number;

  private lastVideoTime = -1;
  private lastTimestampMs = 0;
  /** Wall-clock seconds of the last inference, for the fps meter only. */
  private lastInferT = -1;
  /** Wall-clock ms of the last inference, for `inferenceAgeMs`. */
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

  // One reusable detection buffer per pose slot: the MediaPipe result is an
  // array of objects, and this is the only place it gets flattened.
  private people: PersonFrame[] = [];
  private detsOut: PersonFrame[] = [];

  constructor(opts: MediaPipeOpts) {
    this.o = opts;
    this.now = opts.now ?? clock;
    this.config = opts.config ?? detectCapability({ maxPlayers: opts.maxPlayers ?? 1 });
    const view = opts.view();
    this.calib = opts.calib ?? defaultCalibration(view.w, view.h);
    this.identity = new PoseIdentity({
      maxPlayers: opts.maxPlayers ?? 2,
      calib: this.calib,
      filter: opts.filter,
      slowFactor: this.config.slowFactor,
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
    await video.play().catch(() => {
      // Autoplay can still be blocked; the shell shows a tap-to-start button.
      this.warn('카메라를 시작하려면 화면을 한 번 눌러 주세요.');
    });
    // A slow first frame is not a reason to refuse to start. The pump below
    // waits for real frames anyway, and a camera that is merely slow to warm
    // up must not look to the player like a camera that failed.
    try {
      await waitForVideo(video);
    } catch (e) {
      this.o.onWarning?.(
        `[pose] 카메라 영상이 늦게 와요 (${e instanceof Error ? e.message : String(e)})`,
      );
    }

    this.landmarker = await this.createLandmarker();

    if (this.o.warmup !== false) {
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
        this.o.onWarning?.(
          `[pose] 미리 준비를 건너뛰었어요 (${e instanceof Error ? e.message : String(e)})`,
        );
      }
    }

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
    this.lastVideoTime = -1;
    this.lastInferT = -1;
    this.lastInferMs = 0;
    this.fpsMeter.reset();
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

  // ── internals ────────────────────────────────────────────────────────────

  private async createLandmarker(): Promise<PoseLandmarker> {
    const vision = await import('@mediapipe/tasks-vision');
    const fileset = await vision.FilesetResolver.forVisionTasks(
      this.o.wasmPath ?? '/wasm',
      true, // ES-module loader; required inside a module worker and harmless here
    );
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
      return await vision.PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath, delegate: this.config.delegate },
        ...base,
      });
    } catch (err) {
      // GPU -> CPU, with a diagnosis. delegate:"CPU" is NOT a universal escape
      // hatch (the wasm module still wants an offscreen WebGL2 context), so say
      // what went wrong either way.
      const why = diagnoseGpuFailure(err);
      this.warn(`그래픽 가속을 쓸 수 없어 느릴 수 있어요. (${why})`);
      return await vision.PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath, delegate: 'CPU' },
        ...base,
      });
    }
  }

  private pump = (): void => {
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
    const video = this.o.video;
    const lm = this.landmarker;
    const nowMs = this.now();

    // Throttle to the tier's rate, and never infer the same camera frame twice.
    const minGap = 1000 / Math.max(1, this.config.targetHz);
    const fresh = video.currentTime !== this.lastVideoTime;
    if (lm && fresh && nowMs - this.lastInferMs >= minGap - 2 && video.videoWidth > 0) {
      this.lastVideoTime = video.currentTime;
      // Strictly increasing, always. mediaTime is the honest frame clock, but
      // it repeats if the camera stalls, so clamp upward.
      const raw = meta ? meta.mediaTime * 1000 : nowMs;
      const ts = raw > this.lastTimestampMs ? raw : this.lastTimestampMs + 1;
      this.lastTimestampMs = ts;
      try {
        const res = lm.detectForVideo(video, ts);
        this.consume(res, nowMs);
      } catch (e) {
        this.warn(`카메라 인식에 문제가 있어요. (${String((e as Error).message ?? e)})`);
      }
    }
    this.pump();
  };

  private consume(res: PoseLandmarkerResult | undefined, nowMs: number): void {
    const view = this.o.view();
    const tSec = nowMs / 1000;
    if (this.lastInferT >= 0) this.fpsMeter.sample(tSec - this.lastInferT);
    this.lastInferT = tSec;
    this.lastInferMs = nowMs;

    const out = this.detsOut;
    out.length = 0;
    const poses = res?.landmarks ?? [];
    for (let i = 0; i < poses.length && i < this.people.length; i++) {
      const src = poses[i]!;
      const dst = this.people[i]!;
      for (let j = 0; j < LANDMARK_COUNT; j++) {
        const p = src[j];
        if (!p) continue;
        dst.lm[j * 2] = p.x;
        dst.lm[j * 2 + 1] = p.y;
        // visibility is undefined on tasks-vision <= 0.10.10; present now.
        dst.vis[j] = p.visibility ?? 1;
      }
      out.push(dst);
    }
    this.identity.update(out, tSec, view.w, view.h);

    if (this.capture) {
      const f = this.identity.project(tSec, 0, this.fpsMeter.fps, view.w, view.h);
      const p = f.p1;
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
        : String((e as Error).message ?? e);
      this.captureReject?.(new Error(why));
    }
    this.clearCapture();
  }

  private clearCapture(): void {
    this.capture = undefined;
    this.captureResolve = undefined;
    this.captureReject = undefined;
  }

  private onVisibility = (): void => {
    if (typeof document === 'undefined') return;
    if (document.hidden) {
      this.cancelPump();
    } else if (this.running && !this.paused) {
      this.lastVideoTime = -1;
      this.lastInferT = -1;
      this.lastInferMs = 0;
      this.fpsMeter.reset();
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
      this.lastVideoTime = -1;
      this.lastInferT = -1;
      this.lastInferMs = 0;
      this.identity.teleport();
      this.info.warning = undefined;
    } catch (e) {
      this.warn(`카메라를 다시 켤 수 없어요. (${String((e as Error).message ?? e)})`);
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
