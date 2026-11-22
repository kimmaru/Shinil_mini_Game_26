// Entry point: composes the engine's services and hands them to the shell.
//
// This is the only file that knows about both halves. Everything the shell
// needs is optional — with `{}` it still boots, renders every screen and
// completes the keyboard flow, so a half-built engine never shows a child a
// frozen page.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/base.css';
import { App } from './shell/App';
import type { ShellServices } from './shell/useSession';
import type { PoseSource } from './engine/pose/source';
import { VirtualPoseSource } from './engine/pose/virtual';
import { cameraConstraints, MediaPipePoseSource } from './engine/pose/mediapipe';
import { detectCapability } from './engine/pose/capability';
import { visionWasmPaths } from './engine/pose/poseWorkerProtocol';
import type { AutoCalibrator } from './engine/pose/calibration';
import { createGestureService } from './engine/gestures/service';
import { createAudioService } from './engine/audio/service';
import { createFxService } from './engine/fx/service';
import { runRound } from './engine/host';
import { BACKDROP_SKY_ALPHA } from './engine/render/sky';

const params = new URLSearchParams(location.search);
/** `?pose=virtual` forces the keyboard-driven body — how every game is
 *  reviewed without a camera. */
const forceVirtual = params.get('pose') === 'virtual';
/** `?worker=off` runs pose inference on the main thread — the escape hatch if
 *  the worker path misbehaves on some machine. */
const useWorker = params.get('worker') !== 'off';

/** Live view size. Mutated in place so everything holding the ref sees resizes. */
const view = { w: window.innerWidth, h: window.innerHeight };
window.addEventListener('resize', () => {
  view.w = window.innerWidth;
  view.h = window.innerHeight;
});

const audio = createAudioService();
const fx = createFxService({ reducedMotion: null });

/**
 * The camera `<video>`.
 *
 * Owned here rather than by the pose source so there is exactly one of them for
 * the life of the page. `playsInline` and `muted` are mandatory on iOS: without
 * playsInline Safari takes the video fullscreen, and without muted it refuses
 * to autoplay at all.
 */
const video = document.createElement('video');
video.playsInline = true;
video.muted = true;
video.autoplay = true;
// NOT `display: none`. A hidden video element is allowed to stop decoding
// frames entirely, which strands `waitForVideo()` and surfaces as "the camera
// would not start" even though permission was granted. Keep it in the layout,
// one pixel, invisible and untouchable.
video.style.cssText =
  'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0.01;pointer-events:none;z-index:-1';
document.body.appendChild(video);

// Body-only play never touches the keyboard or mouse, so the OS would dim and
// sleep the display mid-game (Windows after a few minutes). Hold a screen wake
// lock while the game is visible; the browser drops it when hidden, so take
// it again on return. (On macOS play.mjs also runs `caffeinate`.)
const holdScreenAwake = (): void => {
  if (document.visibilityState !== 'visible' || !('wakeLock' in navigator)) return;
  navigator.wakeLock.request('screen').catch(() => { /* refused: harmless */ });
};
document.addEventListener('visibilitychange', holdScreenAwake);
holdScreenAwake();

let pose: PoseSource | null = null;
let camera: MediaPipePoseSource | null = null;
/** Bumped by closeCamera(). An openCamera() still awaiting getUserMedia or the
 *  engine when the camera is closed sees the change and backs out, instead of
 *  bringing a camera back to life that nobody asked for. */
let cameraGen = 0;

function cancelled(): Error {
  const e = new Error('camera closed while it was starting');
  e.name = 'AbortError';
  return e;
}

function virtual(): VirtualPoseSource {
  const v = new VirtualPoseSource({ view });
  void v.start();
  return v;
}

/**
 * Warm the HTTP cache for the wasm runtime and the pose model while the child
 * reads the privacy screen.
 *
 * ~20MB is the slowest thing in this app and the worst first-run experience on
 * school wifi, so it must overlap with the reading rather than follow it. Needs
 * no camera and no user gesture, and a failure here is not fatal — the real
 * load will simply be slower.
 */
async function prefetchVisionAssets(onProgress: (p: number) => void): Promise<void> {
  const urls = [
    // The worker loads the module build of the wasm, the main thread the
    // classic one: warm the one that will actually be used.
    visionWasmPaths('/wasm', useWorker).wasmBinaryPath,
    '/models/pose_landmarker_lite.task',
  ];
  let done = 0;
  await Promise.all(urls.map(async (u) => {
    try {
      const res = await fetch(u, { cache: 'force-cache' });
      await res.arrayBuffer();
    } catch {
      // Offline, or the file is not vendored yet. The round still works; it
      // just loads later.
    } finally {
      done++;
      onProgress(done / urls.length);
    }
  }));
}

const services: ShellServices & {
  /** Continuous kiosk calibration for whoever is in front of the camera; null
   *  without a camera. Not on ShellServices yet — the shell opts in. */
  readonly calibration: AutoCalibrator | null;
} = {
  get pose() { return pose; },
  get calibration() { return camera?.autoCalibration ?? null; },
  gestures: createGestureService(
    () => pose?.sample(performance.now() / 1000),
    view,
  ),
  audio,

  async prefetchAssets(onProgress) {
    if (forceVirtual) { onProgress(1, '준비 끝!'); return; }
    await prefetchVisionAssets((p) => onProgress(p, '게임을 준비하고 있어요'));
  },

  async openCamera() {
    if (forceVirtual) { pose = virtual(); return; }
    // A retry must not leave the previous stream, worker and WebGL context
    // alive behind the new ones.
    services.closeCamera?.();
    const gen = cameraGen;
    const config = detectCapability({ maxPlayers: 1 });

    // Two distinct failures, two distinct messages.
    //
    // Asking for the camera and starting the pose engine were one call, so a
    // model that failed to load reported itself as "we could not turn the
    // camera on" — to someone who had just granted permission. That is a dead
    // end: nothing they can do fixes it, and the message points them at the
    // wrong thing.
    let stream: MediaStream;
    try {
      // The tier's constraints: 16:9 at a size the model can use, capped at
      // 30fps so the camera never doubles the frame budget.
      stream = await navigator.mediaDevices.getUserMedia(cameraConstraints(config));
    } catch (e) {
      throw e; // a real permission/device problem: the shell knows these
    }
    if (gen !== cameraGen) {
      for (const t of stream.getTracks()) t.stop();
      throw cancelled();
    }
    video.srcObject = stream;

    const cam = new MediaPipePoseSource({
      video,
      view: () => ({ w: view.w, h: view.h }),
      config,
      warmup: true,
      worker: useWorker,
      // Engine-internal detail (worker fallback, warmup misses) for whoever
      // opens devtools on the real machine; child-facing text goes to info.warning.
      onWarning: (m) => console.warn(m),
    });
    camera = cam;
    try {
      await cam.start();
    } catch (e) {
      // The camera is fine; the engine is not. Say so, and say what broke.
      // stop() releases the tracks, the worker and any half-built landmarker.
      cam.stop();
      if (camera === cam) camera = null;
      if (gen !== cameraGen) throw cancelled();
      const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      const err = new Error(detail);
      err.name = 'EngineStartError';
      throw err;
    }
    // closeCamera() ran while we were starting: do not resurrect it.
    if (gen !== cameraGen) {
      cam.stop();
      throw cancelled();
    }
    pose = cam;
  },

  async warmup(onProgress) {
    // The shader compile happens inside start() above, behind this screen.
    onProgress(1, '준비 끝!');
  },

  closeCamera() {
    cameraGen++;
    camera?.stop();
    // A keyboard-mode body made by runRound holds window key/pointer
    // listeners: stop it, or every camera on/off leaks one.
    if (!forceVirtual && pose && pose !== camera) pose.stop();
    camera = null;
    if (!forceVirtual) pose = null;
    if (video.srcObject instanceof MediaStream) {
      for (const t of video.srcObject.getTracks()) t.stop();
      video.srcObject = null;
    }
  },

  // The same stream the pose engine reads, for the shell's dimmed backdrop:
  // one getUserMedia for the life of the page. Null in keyboard mode (no
  // stream was ever attached) and after closeCamera() detaches it.
  cameraStream: () => (video.srcObject instanceof MediaStream ? video.srcObject : null),

  runRound: (r) => {
    if (!pose) pose = virtual();
    fx.setReducedMotion(r.reducedMotion ?? null);
    return runRound(r, {
      pose,
      audio,
      fx,
      ...(r.backdrop ? { skyAlpha: BACKDROP_SKY_ALPHA } : {}),
    });
  },
};

// Keyboard mode needs a body from the start: the attract screen's jump
// detector reads the same PoseSource a camera would provide.
if (forceVirtual) pose = virtual();

const host = document.getElementById('root');
if (!host) throw new Error('#root is missing from index.html');

createRoot(host).render(
  <StrictMode>
    <App services={services} />
  </StrictMode>,
);
