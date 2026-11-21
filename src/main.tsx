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
import { MediaPipePoseSource } from './engine/pose/mediapipe';
import { detectCapability } from './engine/pose/capability';
import { createGestureService } from './engine/gestures/service';
import { createAudioService } from './engine/audio/service';
import { createFxService } from './engine/fx/service';
import { runRound } from './engine/host';

const params = new URLSearchParams(location.search);
/** `?pose=virtual` forces the keyboard-driven body — how every game is
 *  reviewed without a camera. */
const forceVirtual = params.get('pose') === 'virtual';

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
video.style.display = 'none';
document.body.appendChild(video);

let pose: PoseSource | null = null;
let camera: MediaPipePoseSource | null = null;

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
    '/wasm/vision_wasm_internal.wasm',
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

const services: ShellServices = {
  get pose() { return pose; },
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
    camera = new MediaPipePoseSource({
      video,
      view: () => ({ w: view.w, h: view.h }),
      config: detectCapability({ maxPlayers: 1 }),
      warmup: true,
    });
    // Rejects with the original DOMException, which the shell maps to the
    // right Korean copy — "press 허용" is useless advice to someone whose
    // laptop has no camera.
    await camera.start();
    pose = camera;
  },

  async warmup(onProgress) {
    // The shader compile happens inside start() above, behind this screen.
    onProgress(1, '준비 끝!');
  },

  closeCamera() {
    camera?.stop();
    camera = null;
    if (!forceVirtual) pose = null;
    if (video.srcObject instanceof MediaStream) {
      for (const t of video.srcObject.getTracks()) t.stop();
      video.srcObject = null;
    }
  },

  runRound: (r) => {
    if (!pose) pose = virtual();
    return runRound(r, { pose, audio, fx });
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
