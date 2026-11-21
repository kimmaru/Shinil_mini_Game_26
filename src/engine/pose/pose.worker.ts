// PoseLandmarker off the main thread.
//
// detectForVideo is synchronous and blocks its thread for the whole inference
// (13-45 ms; more on a 2015 Iris Pro). On the main thread that lands inside a
// rendered frame 20-30 times a second, so the game can never hold 60fps no
// matter how cheap it draws. Here it only blocks this worker. The main thread
// sends one ImageBitmap at a time and never waits (RESEARCH-POSE §4.3).
import { PoseLandmarker, type PoseLandmarkerResult } from '@mediapipe/tasks-vision';
import { LANDMARK_COUNT } from './landmarks';
import { warmupLandmarker } from './warmup';
import {
  flattenPoses, LM_STRIDE, nextTimestamp, visionWasmPaths, type FromWorker, type ToWorker,
} from './poseWorkerProtocol';

interface Scope {
  postMessage(m: FromWorker, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<ToWorker>) => void) | null;
  ModuleFactory?: unknown;
}
const scope = self as unknown as Scope;

let task: PoseLandmarker | undefined;
let lastTs = 0;
let scratch = new Float32Array(LANDMARK_COUNT * LM_STRIDE * 2);

const msg = (e: unknown): string => String((e as Error | undefined)?.message ?? e);

async function init(m: Extract<ToWorker, { type: 'init' }>): Promise<void> {
  const fileset = visionWasmPaths(m.wasmBase, true);
  scratch = new Float32Array(LANDMARK_COUNT * LM_STRIDE * Math.max(1, m.numPoses));
  const opts = (delegate: 'GPU' | 'CPU') => ({
    baseOptions: { modelAssetPath: m.modelPath, delegate },
    runningMode: 'VIDEO' as const,
    numPoses: m.numPoses,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
    outputSegmentationMasks: false,
  });
  try {
    task = await PoseLandmarker.createFromOptions(fileset, opts(m.delegate));
    scope.postMessage({ type: 'ready', delegate: m.delegate });
    return;
  } catch (e) {
    if (m.delegate === 'CPU') throw e;
    // GPU -> CPU. tasks-vision clears self.ModuleFactory once the wasm is
    // instantiated, and in a module worker it re-loads the loader with
    // import(), which is cached and does not re-run — so the retry would die
    // with "ModuleFactory not set." unless we re-arm it from the module's
    // default export ourselves.
    const mod = (await import(/* @vite-ignore */ fileset.wasmLoaderPath)) as { default?: unknown };
    scope.ModuleFactory ??= mod.default;
    task = await PoseLandmarker.createFromOptions(fileset, opts('CPU'));
    scope.postMessage({ type: 'ready', delegate: 'CPU', gpuError: msg(e) });
  }
}

async function warmup(): Promise<void> {
  if (!task) throw new Error('warmup before init');
  const r = await warmupLandmarker(task as unknown as {
    detectForVideo: (i: unknown, t: number) => PoseLandmarkerResult;
  }, { startTimestampMs: lastTs + 1 });
  lastTs = Math.max(lastTs, r.lastTimestampMs);
  scope.postMessage({ type: 'warmed', result: r });
}

function detect(m: Extract<ToWorker, { type: 'detect' }>): void {
  let n = 0;
  try {
    if (task) {
      const ts = nextTimestamp(m.ts, lastTs);
      lastTs = ts;
      const res = task.detectForVideo(m.bitmap, ts);
      n = flattenPoses(res?.landmarks, scratch, LANDMARK_COUNT);
    }
  } finally {
    m.bitmap.close(); // a leaked ImageBitmap is a leaked video frame
  }
  const data = scratch.slice(0, n * LANDMARK_COUNT * LM_STRIDE);
  scope.postMessage({ type: 'result', n, data }, [data.buffer]);
}

scope.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'detect') {
    try {
      detect(m);
    } catch (err) {
      // Always answer: the main thread keeps one frame in flight and waits
      // for this reply before sending the next.
      scope.postMessage({ type: 'detectError', message: msg(err) });
    }
  } else if (m.type === 'init') {
    init(m).catch((err) => scope.postMessage({ type: 'initError', message: msg(err) }));
  } else if (m.type === 'warmup') {
    warmup().catch((err) => scope.postMessage({ type: 'initError', message: `warmup: ${msg(err)}` }));
  }
};
