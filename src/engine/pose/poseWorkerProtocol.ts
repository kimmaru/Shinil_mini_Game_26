// The seam between MediaPipePoseSource (main thread) and pose.worker.ts.
//
// Message shapes plus the small pure helpers both sides share. No DOM and no
// tasks-vision import, so it is testable in Node and costs the lobby nothing.
import type { WarmupResult } from './warmup';

/** Floats per landmark in a flattened result: x, y, visibility. */
export const LM_STRIDE = 3;

export interface WasmPaths {
  wasmLoaderPath: string;
  wasmBinaryPath: string;
}

/**
 * The tasks-vision wasm fileset, built explicitly so the loader choice is
 * visible and testable (this is all FilesetResolver.forVisionTasks does).
 *
 * `module` MUST match where the landmarker is created:
 *  - main thread: tasks-vision injects the loader as a CLASSIC <script>. The
 *    ES-module loader (`export default`, `import.meta`) is a SyntaxError there,
 *    the script never defines ModuleFactory, and createFromOptions fails with
 *    "ModuleFactory not set." on the GPU attempt and the CPU retry alike.
 *  - module worker: importScripts() throws, tasks-vision falls back to
 *    import(), and only the module build works.
 */
export function visionWasmPaths(base: string, module: boolean): WasmPaths {
  const b = base.replace(/\/+$/, '');
  const name = module ? 'vision_wasm_module_internal' : 'vision_wasm_internal';
  return { wasmLoaderPath: `${b}/${name}.js`, wasmBinaryPath: `${b}/${name}.wasm` };
}

export interface LandmarkLike {
  x: number;
  y: number;
  visibility?: number;
}

/**
 * Flatten `result.landmarks` into `out` as [pose][joint][x, y, vis]. Returns
 * the number of poses written (capped by what `out` can hold).
 */
export function flattenPoses(
  poses: readonly (readonly (LandmarkLike | undefined)[])[] | undefined,
  out: Float32Array,
  joints: number,
): number {
  if (!poses) return 0;
  const per = joints * LM_STRIDE;
  const n = Math.min(poses.length, Math.floor(out.length / per));
  for (let i = 0; i < n; i++) {
    const src = poses[i]!;
    const base = i * per;
    for (let j = 0; j < joints; j++) {
      const p = src[j];
      const k = base + j * LM_STRIDE;
      out[k] = p ? p.x : 0;
      out[k + 1] = p ? p.y : 0;
      // visibility is undefined on tasks-vision <= 0.10.10; present now.
      out[k + 2] = p ? (p.visibility ?? 1) : 0;
    }
  }
  return n;
}

/** detectForVideo needs STRICTLY increasing timestamps: a repeated or
 *  decreasing one throws or silently returns garbage. */
export function nextTimestamp(wanted: number, last: number): number {
  return wanted > last ? wanted : last + 1;
}

export type ToWorker =
  | { type: 'init'; wasmBase: string; modelPath: string; delegate: 'GPU' | 'CPU'; numPoses: number }
  | { type: 'warmup' }
  | { type: 'detect'; bitmap: ImageBitmap; ts: number };

export type FromWorker =
  | { type: 'ready'; delegate: 'GPU' | 'CPU'; gpuError?: string }
  | { type: 'initError'; message: string }
  | { type: 'warmed'; result: WarmupResult }
  | { type: 'result'; n: number; data: Float32Array }
  | { type: 'detectError'; message: string };
