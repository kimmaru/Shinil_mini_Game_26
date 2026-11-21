// The camera source cannot be driven in Node — it needs a <video>, getUserMedia
// and a WebGL2 context. What IS testable here, and worth testing, is everything
// that decides whether the camera path behaves: the constraints, and the fact
// that importing this module does not drag 31MB of wasm bindings (or any DOM
// access) into the lobby bundle or into a Node test run.
//
// The behaviour that needs a browser — real inference, rVFC timing,
// visibilitychange, track re-acquire — is exercised by the lead's manual pass
// (`?debug=1`). What start() DECIDES when a backend fails (worker -> main
// thread, GPU -> CPU, which wasm loader) is plain control flow, and is tested
// below with the thinnest fakes that reach it.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Script } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cameraConstraints, MediaPipePoseSource, waitForVideo, workerSupported } from './mediapipe';
import { TIER_CONFIG } from './capability';
import { flattenPoses, LM_STRIDE, nextTimestamp, visionWasmPaths } from './poseWorkerProtocol';

describe('cameraConstraints', () => {
  it('is all `ideal`, never `exact`', () => {
    // `{exact: 640}` throws OverconstrainedError on Chromebook webcams that
    // only offer odd modes. This is the single most common way a camera app
    // fails on school hardware.
    const c = cameraConstraints({
      ...TIER_CONFIG.high,
      tier: 'high',
      renderer: '',
      cores: 8,
    });
    const v = c.video as MediaTrackConstraints;
    const json = JSON.stringify(v);
    expect(json).not.toContain('exact');
    expect(v.width).toEqual({ ideal: 960 });
    expect(v.height).toEqual({ ideal: 540 });
    expect(v.facingMode).toBe('user');
    expect(c.audio).toBe(false);
  });

  it('caps the frame rate at 30', () => {
    const c = cameraConstraints({ ...TIER_CONFIG.low, tier: 'low', renderer: '', cores: 4 });
    const v = c.video as MediaTrackConstraints;
    // A 60fps webcam doubles the frame budget for zero benefit: the model
    // downsamples to 256x256 internally.
    expect(v.frameRate).toEqual({ ideal: 30, max: 30 });
  });

  it('asks for less on a weak device', () => {
    const soft = cameraConstraints({
      ...TIER_CONFIG.software,
      tier: 'software',
      renderer: 'SwiftShader',
      cores: 2,
    });
    const v = soft.video as MediaTrackConstraints;
    expect(v.width).toEqual({ ideal: 480 });
  });
});

describe('module shape', () => {
  it('imports with no DOM present and without loading tasks-vision', async () => {
    // Node, so there is no document. If this module touched the DOM at import
    // time, or imported @mediapipe/tasks-vision statically, this would throw
    // or load 31MB. The library is behind a dynamic import inside start().
    expect(typeof document).toBe('undefined');
    const mod = await import('./mediapipe');
    expect(typeof mod.MediaPipePoseSource).toBe('function');
    expect(typeof mod.cameraConstraints).toBe('function');
    expect(typeof mod.waitForVideo).toBe('function');
  });

  it('waitForVideo resolves immediately for a ready video', async () => {
    const fake = { readyState: 4, videoWidth: 1280 } as unknown as HTMLVideoElement;
    await expect(waitForVideo(fake)).resolves.toBeUndefined();
  });

  it('waitForVideo rejects rather than hanging on a camera that gives nothing', async () => {
    const listeners: Record<string, () => void> = {};
    const fake = {
      readyState: 0,
      videoWidth: 0,
      addEventListener: (k: string, f: () => void) => {
        listeners[k] = f;
      },
      removeEventListener: () => {},
    } as unknown as HTMLVideoElement;
    const p = waitForVideo(fake, 30);
    // A 'loadeddata' with zero dimensions is the garbage case: detectForVideo
    // on a zero-dimension video throws or returns nonsense.
    listeners.loadeddata?.();
    await expect(p).rejects.toThrow('no frames');
  });
});

// ── start-up: the "카메라는 켜졌는데 준비에 실패했어요" regression ─────────────
//
// On the main thread tasks-vision injects the wasm loader as a CLASSIC
// <script>. This file used to pass useModule=true there, selecting the ES-module
// loader — a SyntaxError as a classic script, so ModuleFactory was never set and
// both the GPU attempt and the CPU retry failed. The vendored files themselves
// prove which loader works where.
const WASM_DIR = resolve(process.cwd(), 'node_modules/@mediapipe/tasks-vision/wasm');
const parsesAsClassicScript = (file: string): boolean => {
  try {
    new Script(readFileSync(resolve(WASM_DIR, file), 'utf8'));
    return true;
  } catch {
    return false;
  }
};

describe('wasm loader choice', () => {
  it('main thread gets the classic loader, which parses as a classic script', () => {
    expect(visionWasmPaths('/wasm', false)).toEqual({
      wasmLoaderPath: '/wasm/vision_wasm_internal.js',
      wasmBinaryPath: '/wasm/vision_wasm_internal.wasm',
    });
    expect(parsesAsClassicScript('vision_wasm_internal.js')).toBe(true);
  });

  it('the module loader cannot run as a classic script, which is why it is worker-only', () => {
    expect(visionWasmPaths('/wasm/', true).wasmLoaderPath).toBe('/wasm/vision_wasm_module_internal.js');
    expect(parsesAsClassicScript('vision_wasm_module_internal.js')).toBe(false);
  });
});

describe('worker protocol helpers', () => {
  it('flattens landmarks as x, y, visibility and defaults missing visibility to 1', () => {
    const out = new Float32Array(33 * LM_STRIDE * 2);
    const pose = Array.from({ length: 33 }, (_, j) => ({ x: j / 100, y: 0.5, visibility: 0.9 }));
    const bare = Array.from({ length: 33 }, () => ({ x: 0.25, y: 0.75 }));
    expect(flattenPoses([pose, bare], out, 33)).toBe(2);
    expect(out[3 * 5]).toBeCloseTo(0.05);
    expect(out[3 * 5 + 2]).toBeCloseTo(0.9);
    expect(out[33 * 3 + 2]).toBe(1);
    // More poses than the buffer holds are dropped, never overflowed.
    expect(flattenPoses([pose, pose, pose], out, 33)).toBe(2);
    expect(flattenPoses(undefined, out, 33)).toBe(0);
  });

  it('timestamps only ever go up', () => {
    expect(nextTimestamp(100, 50)).toBe(100);
    expect(nextTimestamp(50, 50)).toBe(51);
    expect(nextTimestamp(10, 50)).toBe(51);
  });

  it('reports no worker support in Node', () => {
    expect(workerSupported()).toBe(false);
  });
});

// Only the orchestration is faked: what start() does when a backend fails.
const created: { loader: string; delegate: string }[] = [];
let gpuFails = false;
vi.mock('@mediapipe/tasks-vision', () => ({
  PoseLandmarker: {
    createFromOptions: async (fs: { wasmLoaderPath: string }, o: { baseOptions: { delegate: string } }) => {
      created.push({ loader: fs.wasmLoaderPath, delegate: o.baseOptions.delegate });
      if (gpuFails && o.baseOptions.delegate === 'GPU') {
        throw new Error('emscripten_webgl_create_context() returned error 0');
      }
      return { detectForVideo: () => ({ landmarks: [] }), close: () => {} };
    },
  },
}));

class FakeWorker {
  static mode: 'ready' | 'crash' = 'ready';
  static last: FakeWorker | undefined;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: { message: string; preventDefault(): void }) => void) | null = null;
  posted: { msg: { type: string }; transfer?: unknown[] }[] = [];
  terminated = false;
  constructor() {
    FakeWorker.last = this;
  }
  postMessage(msg: { type: string }, transfer?: unknown[]): void {
    this.posted.push({ msg, transfer });
    if (msg.type !== 'init') return;
    setTimeout(() => {
      if (FakeWorker.mode === 'crash') {
        this.onerror?.({ message: 'Failed to fetch module script', preventDefault() {} });
      } else {
        this.onmessage?.({ data: { type: 'ready', delegate: 'GPU' } });
      }
    }, 0);
  }
  terminate(): void {
    this.terminated = true;
  }
}

function fakeVideo() {
  const cbs: ((now: number, meta?: { mediaTime: number }) => void)[] = [];
  const track = { stop: vi.fn() };
  const raw = {
    srcObject: { getTracks: () => [track], getVideoTracks: () => [track] } as unknown,
    muted: false,
    playsInline: false,
    readyState: 4,
    videoWidth: 960,
    currentTime: 0,
    play: async () => {},
    requestVideoFrameCallback: (cb: (typeof cbs)[number]) => cbs.push(cb),
    cancelVideoFrameCallback: () => {},
  };
  return { video: raw as unknown as HTMLVideoElement, cbs, raw };
}

function source(video: HTMLVideoElement, warnings: string[] = []): MediaPipePoseSource {
  let t = 0;
  return new MediaPipePoseSource({
    video,
    view: () => ({ w: 1280, h: 720 }),
    // Node's probe finds no WebGL2 and would pick the CPU tier.
    config: { ...TIER_CONFIG.high, tier: 'high', renderer: 'test', cores: 8 },
    warmup: false,
    now: () => (t += 1000), // ends start()'s first-frame wait immediately
    onWarning: (m) => warnings.push(m),
  });
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
};

describe('MediaPipePoseSource start-up fallbacks', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    created.length = 0;
    gpuFails = false;
    FakeWorker.mode = 'ready';
  });

  const stubWorkerEnv = (): void => {
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('OffscreenCanvas', class {});
    vi.stubGlobal('createImageBitmap', async () => ({ close() {} }));
  };

  it('a worker that cannot load falls back to the main thread with the CLASSIC loader', async () => {
    stubWorkerEnv();
    FakeWorker.mode = 'crash';
    const src = source(fakeVideo().video);
    await src.start();
    expect(FakeWorker.last?.terminated).toBe(true);
    expect(created).toEqual([{ loader: '/wasm/vision_wasm_internal.js', delegate: 'GPU' }]);
    expect(src.info.tier).toContain('main');
    src.stop();
  });

  it('GPU failure on the main thread retries on CPU and says so', async () => {
    gpuFails = true;
    const warnings: string[] = [];
    const src = source(fakeVideo().video, warnings);
    await src.start();
    expect(created.map((c) => c.delegate)).toEqual(['GPU', 'CPU']);
    expect(src.info.tier).toContain('CPU');
    expect(warnings.some((w) => w.includes('그래픽 가속'))).toBe(true);
    src.stop();
  });

  it('worker path keeps exactly one frame in flight and never blocks on it', async () => {
    stubWorkerEnv();
    const { video, cbs, raw } = fakeVideo();
    const src = source(video);
    await src.start();
    expect(src.info.tier).toContain('worker');
    expect(created).toEqual([]); // nothing was created on the main thread

    const w = FakeWorker.last!;
    raw.currentTime = 1;
    cbs.at(-1)!(0, { mediaTime: 1 });
    await flush();
    // A second camera frame while the first is still being inferred is skipped.
    raw.currentTime = 2;
    cbs.at(-1)!(0, { mediaTime: 2 });
    await flush();
    const detects = w.posted.filter((p) => p.msg.type === 'detect');
    expect(detects).toHaveLength(1);
    expect(detects[0]!.transfer).toHaveLength(1); // transferred, not copied

    src.stop();
    expect(w.terminated).toBe(true);
  });

  it('a worker that stops answering is replaced by the main thread', async () => {
    // e.g. its GPU context was lost across a laptop sleep: no crash event,
    // just silence. The body must not stay frozen.
    stubWorkerEnv();
    const { video, cbs, raw } = fakeVideo();
    let t = 0;
    let step = 1000; // big steps end start()'s first-frame wait at once
    const warnings: string[] = [];
    const src = new MediaPipePoseSource({
      video,
      view: () => ({ w: 1280, h: 720 }),
      config: { ...TIER_CONFIG.high, tier: 'high', renderer: 'test', cores: 8 },
      warmup: false,
      now: () => (t += step),
      onWarning: (m) => warnings.push(m),
    });
    await src.start();
    step = 1;
    const w = FakeWorker.last!;
    raw.currentTime = 1;
    cbs.at(-1)!(0, { mediaTime: 1 });
    await flush();
    expect(w.posted.filter((p) => p.msg.type === 'detect')).toHaveLength(1);

    // Under the stall limit: keep waiting.
    t += 1000;
    raw.currentTime = 2;
    cbs.at(-1)!(0, { mediaTime: 2 });
    await flush();
    expect(w.terminated).toBe(false);

    // Past it: the worker goes, the main thread takes over.
    t += 5000;
    raw.currentTime = 3;
    cbs.at(-1)!(0, { mediaTime: 3 });
    await flush();
    expect(w.terminated).toBe(true);
    expect(warnings.some((m) => m.includes('no reply'))).toBe(true);
    await vi.waitFor(() => expect(src.info.tier).toContain('main'));
    expect(created).toEqual([{ loader: '/wasm/vision_wasm_internal.js', delegate: 'GPU' }]);
    src.stop();
  });
});
