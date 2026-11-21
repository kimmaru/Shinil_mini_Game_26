
---

# Browser real-time pose tracking stack — technical brief (as of 2026-11-21)

## 0. TL;DR recommendation for a kids' webcam party site

| Players | Recommendation |
|---|---|
| 1 player per device | **`@mediapipe/tasks-vision@1.2.3` PoseLandmarker, `pose_landmarker_lite.task`, `delegate:"GPU"`, `runningMode:"VIDEO"`, `numPoses:1`** — in a module Web Worker, fed `ImageBitmap`s from `requestVideoFrameCallback` |
| 2 players, one camera | Same, `numPoses:2`, **plus your own identity tracker** (nearest-chest matching). Or the trick used by shipped games: split the frame left/right and run **two PoseLandmarker instances** on cropped halves via `imageProcessingOptions.regionOfInterest` |
| 3–5 players, one camera | MediaPipe is the wrong tool — BlazePose's model card lists multi-person as **out of scope**. Use **MoveNet MultiPose Lightning** (built-in bounding-box tracker, up to 6 people) but you must self-host the model because `tfhub.dev` now 404s |

Critical 2026 facts that change the old advice:
- MediaPipe web moved to a **1.x line** (1.2.3). **Non-SIMD WASM builds were removed in 1.1.0** — no fallback for ancient browsers.
- MediaPipe's web `delegate:"GPU"` is **WebGL2, not WebGPU**. WebGPU in MediaPipe web is only for `.litertlm` generative models.
- The **TensorFlow.js pose stack is effectively abandoned**: `@tensorflow/tfjs@4.22.0` (~2 years old), `@tensorflow-models/pose-detection@2.1.3` (published **2023-08-29**), and its hardcoded model URLs are dead.
- **WebGPU reached Baseline in Jan 2026** (Chrome/Edge 113+, Safari 26+, Firefox 141+ Win / 145+ macOS ARM64) — relevant for your renderer and for LiteRT.js, not for MediaPipe vision inference.

---

## 1. MediaPipe Tasks Vision `PoseLandmarker`

### 1.1 Versions

```
@mediapipe/tasks-vision
  latest   1.2.3        published 2026-11-11   (install size 31.4 MB, Apache-2.0)
  nightly  1.3.0-rc.20261120
```

Release timeline of the native repo (`google-ai-edge/mediapipe`):

| Version | Date | Web-relevant change |
|---|---|---|
| 1.0.0 | Jul 28 2026 | PoseLandmarker/FaceLandmarker/HandLandmarker migrated to the **MediaPipe Tasks C API**; WebGPU Instance management; ExternalGlTexture sync |
| 1.1.0 | Oct 7 2026 | **Removed non-SIMD WebAssembly builds for web tasks**; prevented overlapping WASM embedding calls; unified task naming across platforms (deprecated aliases kept) |
| 1.1.1 | Oct 14 2026 | LiteRT updates |
| 1.2.0 | Oct 28 2026 | **F16 support**, updated WASM binaries |
| 1.2.2 | Nov 3 2026 | status/abseil plumbing |
| 1.2.3 | Nov 11 2026 | iOS C API migrations; web audio cache option removed |

**No PoseLandmarker JS API changes across 1.0.0 → 1.2.3.** Code written against 0.10.x `PoseLandmarker` still compiles; the breakage risk is the wasm fileset (SIMD-only) and the landmark `visibility` field (undefined on ≤ 0.10.10, present now).

Pin the version. `@latest` on jsDelivr will silently jump you onto 1.3.x.

### 1.2 WASM fileset

`node_modules/@mediapipe/tasks-vision/wasm/` in 1.2.3 contains exactly **four** files (nosimd variants are gone):

| File | Size |
|---|---|
| `vision_wasm_internal.js` | 337 kB |
| `vision_wasm_internal.wasm` | 14.7 MB |
| `vision_wasm_module_internal.js` | 337 kB |
| `vision_wasm_module_internal.wasm` | 14.7 MB |

`FilesetResolver.forVisionTasks(basePath?: string, useModule?: boolean)` — `basePath` is the directory; `useModule` selects the **ES-module** loader (`vision_wasm_module_internal.*`). You need `useModule: true` inside a `type: "module"` Worker. SIMD detection is automatic.

```js
// CDN (pin!)
import { FilesetResolver, PoseLandmarker, DrawingUtils }
  from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3/vision_bundle.mjs";

const vision = await FilesetResolver.forVisionTasks(
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3/wasm"
);
```

Self-hosting (strongly recommended for a school/party site — 14.7 MB of wasm over a flaky CDN is your worst load-time risk; serve it with Brotli and a long `Cache-Control`):

```js
const vision = await FilesetResolver.forVisionTasks("/wasm", /* useModule */ true);
// copy node_modules/@mediapipe/tasks-vision/wasm/* -> /public/wasm/ in a prebuild step
```

### 1.3 Model files — exact URLs and sizes

New canonical home is HuggingFace `litert-community`; the legacy Google Storage paths still serve.

| Variant | URL | Size (bytes) |
|---|---|---|
| lite | `https://huggingface.co/litert-community/MediaPipe-PoseLandmarker-Lite/resolve/main/pose_landmarker_lite.task` | **5,777,746** (5.51 MiB) |
| full | `https://huggingface.co/litert-community/MediaPipe-PoseLandmarker-Full/resolve/main/pose_landmarker_full.task` | **9,398,198** (8.96 MiB) |
| heavy | `https://huggingface.co/litert-community/MediaPipe-PoseLandmarker-Heavy/resolve/main/pose_landmarker_heavy.task` | **30,664,242** (29.24 MiB) |

Legacy (still live):
```
https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task
https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task
https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/latest/pose_landmarker_heavy.task
```

Gotcha: Google's model card quotes 3 / 6 / 26 MB — those are the *landmark model alone*. The `.task` is a **bundle** (detector + landmarker + metadata), hence the larger real sizes above. Also: all three are float16, detector input 224×224×3, landmarker input 256×256×3 — accuracy differences come from model capacity, not resolution.

Accuracy (model card PDJ): lite 87.0%, full 91.8%, heavy 94.2%. Fitness PCK@0.2: yoga 90.2 / 95.5 / 96.4; HIIT 93.5 / 95.7 / 97.5. For a party game, lite→full is the only upgrade worth paying for; full→heavy is a steep cost for ~2.4 points.

Host the `.task` yourself too, and cache it in the **Cache API** keyed by URL (Google's own sample does exactly this, with a progress callback and a `MODEL_CACHED` message).

### 1.4 `createFromOptions` config

```ts
const landmarker = await PoseLandmarker.createFromOptions(vision, {
  baseOptions: {
    modelAssetPath: "/models/pose_landmarker_lite.task",  // or modelAssetBuffer: Uint8Array | ReadableStreamDefaultReader
    delegate: "GPU",                 // "CPU" (default) | "GPU"  -> GPU == WebGL2 on web
  },
  runningMode: "VIDEO",              // "IMAGE" (default) | "VIDEO"
  numPoses: 1,                       // default 1
  minPoseDetectionConfidence: 0.5,   // default 0.5
  minPosePresenceConfidence: 0.5,    // default 0.5
  minTrackingConfidence: 0.5,        // default 0.5
  outputSegmentationMasks: false,    // default false
  // canvas: offscreenCanvas,        // inherited from VisionTaskOptions; required if you want ImageBitmap in/out
});
```

Full class surface:

```ts
static POSE_CONNECTIONS: Connection[];               // index pairs for skeleton rendering
static createFromOptions(wasmFileset, options): Promise<PoseLandmarker>;
static createFromModelPath(wasmFileset, modelAssetPath: string): Promise<PoseLandmarker>;
static createFromModelBuffer(wasmFileset, buf: Uint8Array | ReadableStreamDefaultReader): Promise<PoseLandmarker>;

setOptions(options: PoseLandmarkerOptions): Promise<void>;   // partial update; await it
detect(image: ImageSource, ipo?, callback?): PoseLandmarkerResult | void;         // IMAGE mode only
detectForVideo(frame: ImageSource, timestamp: number, ipo?, callback?): PoseLandmarkerResult | void;  // VIDEO mode only
close(): void;
```

`ImageSource` = `HTMLVideoElement | HTMLImageElement | HTMLCanvasElement | ImageBitmap | ImageData | VideoFrame | OffscreenCanvas`.

Three things that bite:
- `detectForVideo` is **synchronous** and returns the result. It blocks the calling thread for the whole inference (13–45 ms) — that's the entire argument for the Worker.
- **Timestamps must be strictly monotonically increasing.** A repeated or decreasing timestamp throws or silently returns garbage. `performance.now()` is fine; `video.currentTime * 1000` is also fine but repeats when you poll faster than the camera.
- `setOptions` tears down and rebuilds part of the graph. Don't call it per frame; don't call it to toggle `numPoses` mid-round.

### 1.5 `detectForVideo` call pattern

```js
let lastVideoTime = -1;

function onFrame(now, metadata) {           // requestVideoFrameCallback
  if (video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    const ts = metadata ? metadata.mediaTime * 1000 : performance.now();
    const res = landmarker.detectForVideo(video, ts);
    if (res.landmarks.length) consume(res);
  }
  video.requestVideoFrameCallback(onFrame);
}
video.requestVideoFrameCallback(onFrame);
```

### 1.6 Result shape

```ts
interface PoseLandmarkerResult {
  landmarks: NormalizedLandmark[][];   // [pose][33]  x,y ∈ [0,1] image-relative; z relative to hip midpoint, roughly same scale as x
  worldLandmarks: Landmark[][];        // [pose][33]  metres, ORIGIN = midpoint of the hips
  segmentationMasks?: MPMask[];        // [pose], Float32 per-pixel person confidence, only if outputSegmentationMasks:true
}

interface NormalizedLandmark { x: number; y: number; z: number; visibility: number; presence: number; }
```

Real sample:
```js
{
  landmarks: [[ { x:0.6389, y:0.6712, z:0.1300, visibility:0.9999, presence:0.9999 }, /* …33 */ ]],
  worldLandmarks: [[ { x:0.0675, y:0.0311, z:0.0552, visibility:0.9999, presence:0.9999 }, /* …33 */ ]]
}
```

Semantics and measured caveats:
- `visibility` = "is this joint visible (not occluded/out of frame)". `presence` = "does this joint exist in the crop". In practice both track together; **gate on `visibility`** and treat `presence` as undocumented. `visibility` is `undefined` on tasks-vision ≤ 0.10.10 — if you support old pinned builds, use `lm.visibility ?? 1`.
- `y` grows **downward** (0 = top of frame). Everything "up" in your game is **negative** Δy.
- **`z` / `worldLandmarks` depth is unreliable.** One published measurement over 120 photos: elbow angles computed from raw `worldLandmarks` depth were off by **+34.1° on average**; scaling z by ~1/3 substantially improved it. Treat 3D as decoration, do your game logic in 2D.
- **`worldLandmarks` cannot measure a jump.** Origin is the hip midpoint, so hip world-y is always ≈0. Jump height must come from **normalized image y of the hips**, or from ankle-relative-to-hip distance.
- `segmentationMasks` adds real cost. With `delegate:"GPU"`, use `mask.getAsWebGLTexture()` and never `getAsFloat32Array()`/`getAsUint8Array()` (forces a GPU→CPU readback). Always `mask.close()`.

Rendering:
```js
const du = new DrawingUtils(ctx);
for (const lm of res.landmarks) {
  du.drawLandmarks(lm, { radius: d => DrawingUtils.lerp(d.from.z, -0.15, 0.1, 5, 1) });
  du.drawConnectors(lm, PoseLandmarker.POSE_CONNECTIONS);
}
```

### 1.7 The 33 landmarks, in order

| # | Name | | # | Name | | # | Name |
|---|---|---|---|---|---|---|---|
| 0 | nose | | 11 | left_shoulder | | 22 | right_thumb |
| 1 | left_eye_inner | | 12 | right_shoulder | | 23 | left_hip |
| 2 | left_eye | | 13 | left_elbow | | 24 | right_hip |
| 3 | left_eye_outer | | 14 | right_elbow | | 25 | left_knee |
| 4 | right_eye_inner | | 15 | left_wrist | | 26 | right_knee |
| 5 | right_eye | | 16 | right_wrist | | 27 | left_ankle |
| 6 | right_eye_outer | | 17 | left_pinky | | 28 | right_ankle |
| 7 | left_ear | | 18 | right_pinky | | 29 | left_heel |
| 8 | right_ear | | 19 | left_index | | 30 | right_heel |
| 9 | mouth_left | | 20 | right_index | | 31 | left_foot_index |
| 10 | mouth_right | | 21 | left_thumb | | 32 | right_foot_index |

```js
export const L = {
  NOSE:0, LEFT_EYE_INNER:1, LEFT_EYE:2, LEFT_EYE_OUTER:3,
  RIGHT_EYE_INNER:4, RIGHT_EYE:5, RIGHT_EYE_OUTER:6,
  LEFT_EAR:7, RIGHT_EAR:8, MOUTH_LEFT:9, MOUTH_RIGHT:10,
  LEFT_SHOULDER:11, RIGHT_SHOULDER:12, LEFT_ELBOW:13, RIGHT_ELBOW:14,
  LEFT_WRIST:15, RIGHT_WRIST:16, LEFT_PINKY:17, RIGHT_PINKY:18,
  LEFT_INDEX:19, RIGHT_INDEX:20, LEFT_THUMB:21, RIGHT_THUMB:22,
  LEFT_HIP:23, RIGHT_HIP:24, LEFT_KNEE:25, RIGHT_KNEE:26,
  LEFT_ANKLE:27, RIGHT_ANKLE:28, LEFT_HEEL:29, RIGHT_HEEL:30,
  LEFT_FOOT_INDEX:31, RIGHT_FOOT_INDEX:32,
};
```

Note "left"/"right" are **the subject's** left/right, so with a mirrored preview the player's visual left hand is `RIGHT_WRIST`. Decide this once and write it on the wall.

---

## 2. Multi-person: the honest answer

**`numPoses > 1` is not reliable, and there is no identity tracking.**

Evidence:
- The BlazePose GHUM model card states the model **"Tracks only one person on scene if multiple present"** and lists multiple people as **out of scope**.
- MediaPipe issue #5274 ("Multiple Person Pose Detection"): users report `num_poses = 2` simply **not detecting the second person**; a related issue (#5842) proposes *emitting a warning when `num_poses > 1`*. The issue was closed after a contributor posted a `num_poses=4` sample, with commenters still skeptical and some migrating away.
- Nothing in the API exposes a durable per-person id. The order of `result.landmarks[]` is not a stable identity.

What that means in practice (corroborated by shipped games):
- `numPoses: 2` **mostly works** when two people are well separated, both fully in frame, not overlapping. It degrades fast with occlusion, crossing, or someone partially out of frame.
- Array order **will** swap. The *Motion Gym* README documents it plainly: "Two players who walk through each other will swap identities at the crossing point," with a flip observed during lateral dodging.

### 2.1 Identity tracking you have to write

Pattern A — **spatial halves** (what Motion Gym ships): left half of the mirrored frame = P1, right half = P2. Position is the only identity. Zero code, zero drift, but players can't cross.

Pattern B — **nearest-chest matching** (what *Jumping Jack* ships, `js/body.js`): per frame, compute a chest anchor (shoulder midpoint) per detection, match to existing player slots by ascending distance, assign leftovers to free slots, drop a player after **0.6 s** without a match.

```js
// greedy nearest-anchor assignment with hysteresis
function assign(dets, players, dt) {
  const anchor = p => ({ x:(p[11].x+p[12].x)/2, y:(p[11].y+p[12].y)/2 });
  const pairs = [];
  dets.forEach((d,di) => players.forEach((p,pi) => {
    if (!p.alive) return;
    const a = anchor(d), b = p.anchor;
    pairs.push({ di, pi, d2: (a.x-b.x)**2 + (a.y-b.y)**2 });
  }));
  pairs.sort((u,v) => u.d2 - v.d2);
  const usedD = new Set(), usedP = new Set();
  for (const { di, pi, d2 } of pairs) {
    if (usedD.has(di) || usedP.has(pi)) continue;
    if (d2 > MAX_JUMP2) continue;           // ~ (0.25 * frameWidth)^2
    players[pi].feed(dets[di], dt); usedD.add(di); usedP.add(pi);
  }
  dets.forEach((d,di) => { if (!usedD.has(di)) spawnIntoFreeSlot(d); });
  players.forEach(p => { if (!usedP.has(p.i)) p.lostFor += dt; });
  players.forEach(p => { if (p.lostFor > 0.6) p.alive = false; });
}
```

Pattern C — **crop-and-run**: slice the frame into N regions-of-interest and run N instances (or one instance N times with `imageProcessingOptions.regionOfInterest`) at `numPoses:1`. Identity is the region. This is the most robust 2-player option and, because each pass sees a tighter crop, often *more accurate* than `numPoses:2` on the full frame.

Pattern D — **MoveNet MultiPose**, which has a real tracker (see §3).

Pattern E — the kid-proofing layer from `calum/camera-games`, which is the best idea in this whole brief for a classroom:
- **probation**: a new body must be observed ~**0.45 s** before it becomes a player (rejects pets, chairs, passers-by)
- **upright check**: must look like a standing person
- **opt-in join**: mid-game arrivals become players only after **holding arms out for 2 s**
- probation/dropout windows **stretch on slow devices** so players don't flicker
- re-identification by position + clothing colour

### 2.2 FPS cost — what to actually expect

Mechanism first, because it predicts the scaling: in `VIDEO` mode the pipeline is detector → landmarker, and **the detector only re-runs when tracking is lost**. Steady state cost ≈ `1 × (cheap ROI logic) + N × landmark_model`. So **cost is roughly linear in `numPoses`** for people actually present, and near-free for unfilled slots.

Measured data points I found:
- Web, desktop, per-frame median over 120 images: **lite 31 ms, full 33 ms, heavy 42 ms**
- `delegate:"CPU"` WASM: **10–15 FPS**; `delegate:"GPU"` (WebGL2): **60+ FPS on integrated graphics**
- lite via MediaPipe on a laptop CPU: **~17 ms/frame**
- M1 Pro MacBook, 30 s average: **27 FPS**
- Pixel 3 reference (2021): lite 44/49 FPS CPU/GPU, full 18/40, heavy 4/19
- MoveNet on WebGL, MacBook Pro i9: **Lightning 104 FPS, Thunder 77, MultiPose 54**

Engineering estimate table (GPU delegate, 640×480 input, single-person-per-pass; derived from the above, **not** a single measured matrix — validate on your own devices):

| Device | lite ×1 | lite ×2 | lite ×4 | full ×1 | full ×2 | full ×4 |
|---|---|---|---|---|---|---|
| MacBook M-series | 60 fps (cap) | 45–60 | 25–35 | 50–60 | 30–40 | 15–22 |
| Mid-range laptop (Iris Xe / Ryzen iGPU) | 35–50 | 22–32 | 12–18 | 28–38 | 16–24 | 8–13 |
| Chromebook (N100 / N4500 / ARM) | 18–28 | 10–16 | 5–9 | 12–20 | 7–11 | 3–6 |
| iPad (A14+/M-series, Safari) | 30–45 | 18–28 | 9–15 | 24–35 | 14–20 | 7–11 |

Design consequences:
- **Budget 2 players max per camera on a Chromebook, at lite.** Four people on a Chromebook is not a 30 fps experience with MediaPipe.
- **Decouple your render loop from detection.** `berad217/pose_detection` locks the game at **60 fps on a separate loop** while detection runs at camera rate (15–30 fps in dim light) — this is the single highest-value architectural decision, because 12 fps *detection* still feels fine if the *game* is smooth and you interpolate.
- Ship a **quality ladder** like `calum/camera-games`: full → lite → lite@half-res → lite without masks, stepping down when frame time degrades and back up after sustained speed, with phones starting one step down.

---

## 3. Alternatives

### 3.1 TensorFlow.js MoveNet (`@tensorflow-models/pose-detection`)

```
@tensorflow-models/pose-detection  2.1.3   published 2023-08-29   (3+ years stale)
@tensorflow/tfjs                   4.22.0  (~2 years stale)
```

**It is the only option with real built-in multi-person tracking**, which is exactly what your use case wants. And it is unmaintained. Both are true.

```js
import * as poseDetection from "@tensorflow-models/pose-detection";
import "@tensorflow/tfjs-backend-webgl";

const detector = await poseDetection.createDetector(
  poseDetection.SupportedModels.MoveNet,
  {
    modelType: poseDetection.movenet.modelType.MULTIPOSE_LIGHTNING,
    enableSmoothing: true,
    enableTracking: true,
    trackerType: poseDetection.TrackerType.BoundingBox,   // or .Keypoint
    multiPoseMaxDimension: 256,     // must be a multiple of 32
    modelUrl: "/models/movenet/multipose/model.json",     // REQUIRED in 2026, see below
  }
);
const poses = await detector.estimatePoses(video, { flipHorizontal: false });
// poses[i] = { keypoints: [{x,y,score,name} ×17], keypoints3D?, box?, id? }
```

Model variants and the library's own constants:

| `modelType` | Input res | Default URL baked into v2.1.3 |
|---|---|---|
| `SINGLEPOSE_LIGHTNING` | 192 | `https://tfhub.dev/google/tfjs-model/movenet/singlepose/lightning/4` |
| `SINGLEPOSE_THUNDER` | 256 | `https://tfhub.dev/google/tfjs-model/movenet/singlepose/thunder/4` |
| `MULTIPOSE_LIGHTNING` | 256 (`multiPoseMaxDimension`) | `https://tfhub.dev/google/tfjs-model/movenet/multipose/lightning/1` |

**🔴 Blocker:** `tfhub.dev` **404s as of Nov 2026** (TF Hub migrated to Kaggle Models; the redirect era ended). Out of the box `createDetector(MoveNet, …)` **fails**. Workarounds, in order of preference:
1. Self-host. Vendor `model.json` + shards into `/public/models/` and pass `modelUrl`. (Reference copies: `vladmandic/movenet` carries Lightning v3/v4, Thunder v3/v4, MultiPose v1.)
2. Point at the surviving bucket: `https://storage.googleapis.com/tfhub-tfjs-modules/google/tfjs-model/movenet/multipose/lightning/1/model.json`
3. Kaggle (`https://www.kaggle.com/models/google/movenet/...`) — CORS has been reported as a problem from some origins.

Output: **17 COCO keypoints** (`nose, left_eye, right_eye, left_ear, right_ear, left_shoulder, right_shoulder, left_elbow, right_elbow, left_wrist, right_wrist, left_hip, right_hip, left_knee, right_knee, left_ankle, right_ankle`) — **no feet, no hands, no z** (MoveNet has no 3D). MultiPose output layout is 56 floats per instance: 17×3 (y, x, score) + 5 box values (ymin, xmin, ymax, xmax, score).

The library's **default tracker and smoothing constants** are a free, well-tuned reference — steal them:

```
keypoint filter (One Euro):  frequency 30 Hz, minCutoff 2.5, beta 300.0,
                             thresholdCutoff 0.5, thresholdBeta 5.0
tracker:                     maxTracks 18, maxAge 1000 ms,
                             minSimilarity 0.2 (keypoint) / 0.15 (bounding box),
                             keypointConfidenceThreshold 0.3, minNumKeypoints 4
```

That `enableSmoothing: true` is a One Euro filter internally — which answers your §5 question about what the pros use.

### 3.2 BlazePose via tfjs (`SupportedModels.BlazePose`)

Two runtimes: `runtime: "mediapipe"` (loads the old `@mediapipe/pose` solution files — **deprecated legacy solution, do not start here in 2026**) or `runtime: "tfjs"` (tfjs graph models). Same GHUM 33-landmark output as PoseLandmarker but through a stale wrapper, single-person, and it adds the whole tfjs runtime to your bundle. **No reason to pick this over `@mediapipe/tasks-vision` today.**

### 3.3 Newer 2025/2026 options

**LiteRT.js** — `@litertjs/core`, latest **2.6.0 (2026-10-22)**, first release Aug 2025. Google's web runtime for `.tflite` with **WebGPU** (via ML Drift), **WebNN** (NPU), and CPU. Claimed up to 3× faster than tfjs, with a documented tfjs migration path. You can run the pose `.tflite` through it and get a genuine WebGPU path — but you then own the pre/post-processing (ROI crop, letterbox, heatmap/regression decode, detector→landmarker handoff, smoothing) that `.task` bundles give you for free. **Real option, real work. Not for v1.**

**rtmlib-ts** — `npm install rtmlib-ts`, Apache-2.0. RTMPose/RTMW + YOLO12 via onnxruntime-web, backends WASM and **WebGPU**, COCO-17, multi-person, plus 3D. Published benchmarks on M1 MacBook Pro: `PoseDetector` WASM **~85 ms**, `Pose3DDetector` WASM **~255 ms**, object detector 640² WebGPU ~30 ms. At 85 ms/frame on an M1 it is **too slow for a kids' game**; it's an analysis tool. Playground: `https://rtmlib-playground.vercel.app/`.

**RTMPose / DWPose direct via onnxruntime-web** — RTMPose-m is 75.8 COCO AP at ~11 ms/person on a desktop *native* CPU; the browser tax plus a required separate person detector (RTMDet-tiny) makes this a two-stage pipeline. DWPose gives 133 keypoints (body+feet+face+hands) in one pass. Best-in-class accuracy and genuine multi-person, but you own detection, tracking, and letterboxing. **YOLO26/YOLO11-pose ONNX on WebGPU** (e.g. `hwkim3330/yolo`, Transformers.js) is the same trade.

**Comparison for a kids' game in a classroom/living room:**

| Stack | Latency | Multi-person | Identity | Maintained | Verdict for you |
|---|---|---|---|---|---|
| MediaPipe tasks-vision 1.2.3 | **best** (13–33 ms, GPU) | poor (out of scope) | none | **yes, actively** | **Default choice.** 33 pts incl. feet, first-party JS, Apache-2.0 |
| MoveNet MultiPose (tfjs) | good (~54 fps i9) | **good (6 people)** | **built-in tracker + ids** | no (2023) | Use only if 3+ players on one camera is a hard requirement; self-host the model |
| BlazePose tfjs | medium | no | none | no | Skip |
| LiteRT.js + pose .tflite | potentially best (WebGPU) | you build it | you build it | **yes** | Phase 2 performance play |
| rtmlib-ts / RTMPose web | poor (~85 ms) | yes | you build it | yes | Too slow for gameplay |
| YOLO-pose ONNX WebGPU | medium | yes | you build it | yes | Heavy, overkill for 17 kpts |

**WebGPU status:** Baseline since **Jan 2026** — Chrome/Edge 113+, Safari 26+, Firefox 141+ (Windows) / 145+ (macOS Tahoe ARM64); >80% global. **But MediaPipe's vision tasks still use WebGL2 for `delegate:"GPU"`.** WebGPU in MediaPipe web is reserved for `.litertlm` generative/embedding models (check `navigator.gpu` before creating those). So: use WebGPU for your *renderer* and for LiteRT.js; expect WebGL2 for MediaPipe inference. If you require WebGL2 anywhere, note it's also what gates MediaPipe on old hardware.

---

## 4. Practical browser concerns

### 4.1 `getUserMedia`

```js
const stream = await navigator.mediaDevices.getUserMedia({
  audio: false,
  video: {
    facingMode: "user",                 // front camera; "environment" for rear
    width:     { ideal: 1280 },
    height:    { ideal: 720  },
    frameRate: { ideal: 30, max: 30 },
    resizeMode: "crop-and-scale",       // let the browser downscale, not you
  },
});
video.srcObject = stream;
video.muted = true;                     // required for autoplay
video.playsInline = true;               // 🔴 required on iOS or Safari goes fullscreen
await video.play();
```

Guidance, with the tension spelled out:
- **Never use `exact` constraints.** `{exact: 640}` throws `OverconstrainedError` on Chromebook webcams that only offer odd modes. Always `ideal`.
- **720p@30 is the documented sweet spot** for MediaPipe Pose, and it's what *Jumping Jack* requests (`1280×720, frameRate ideal 30`). For a 2-person wide shot you want the extra pixels so distant wrists still land; `game-cam` deliberately raises its input to **512 px** so "5 people across a 16:9 frame still get accurate wrists," and zooms the camera to its widest when `zoom` is supported.
- The counterweight: **the model downsamples to 256×256 internally**, so beyond ~720p you're paying upload/copy cost for nothing. On a Chromebook, drop to `{ideal: 640}×{ideal: 480}`. Make this part of the quality ladder.
- `frameRate: {max: 30}` matters — a 60 fps webcam doubles your frame budget for zero benefit.
- Two people full-body in one frame needs **a wide lens and several metres of distance**. Put a framing step in the UI ("step back until you see your feet") and detect it: require `visibility > 0.5` on both ankles before starting.

### 4.2 `requestVideoFrameCallback` vs `rAF`

Use **`requestVideoFrameCallback`** (rVFC). It fires at the lower of video frame rate and paint rate — a 25 fps stream in a 60 Hz browser fires at 25 Hz, so you don't inspect the same frame 2.4×. It also hands you metadata: `mediaTime` (use `× 1000` as your monotonic timestamp) and **`presentedFrames`** (a counter that lets you detect dropped frames). Support: **Safari 15.4+** (so all of Safari 26), Chrome/Edge long since; Firefox lagged, so keep a fallback. Known Safari bug: rVFC is broken during DRM playback — irrelevant for a camera stream, but it's why libraries like video.js feature-detect conditionally.

Belt-and-braces dedupe regardless of loop (this is exactly what *Jumping Jack* does):

```js
let lastVideoTime = -1;
if (video.currentTime === lastVideoTime) return;   // same frame, skip inference
lastVideoTime = video.currentTime;
```

`rAF` is still the right driver for your **render** loop (it's vsync-aligned), which is another reason to decouple: **rVFC drives detection, rAF drives drawing.**

### 4.3 Web Worker — yes, and Google ships it

`@mediapipe/tasks-vision` **does** work in a Worker in 2026. The historical blocker (`Can't find variable: document`, caused by a `typeof OffscreenCanvas !== 'undefined' && !isWebKit()` guard that forced DOM-canvas creation on Safari) was **fixed 2024-04-15** ("Update WebGL2 on OffscreenCanvas support check to include Safari 17+") and the issue closed 2024-06-06.

Google's own `mediapipe-samples-web` (on `@mediapipe/tasks-vision@^1.2.3`) runs **every** vision task in a Worker. The shape, condensed from their `BaseWorker`/`PoseLandmarkerWorker`:

```ts
// pose.worker.ts  (module worker)
import { FilesetResolver, PoseLandmarker } from "@mediapipe/tasks-vision";

let task: PoseLandmarker;

self.onmessage = async (e) => {
  const d = e.data;
  if (d.type === "INIT") {
    const fileset = await FilesetResolver.forVisionTasks(d.wasmPath, /* useModule */ true);
    const buf = new Uint8Array(await (await fetch(d.modelUrl)).arrayBuffer());
    try {
      task = await PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetBuffer: buf, delegate: "GPU" },
        runningMode: "VIDEO", numPoses: d.numPoses ?? 1,
        minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5, outputSegmentationMasks: false,
      });
    } catch (err) {
      // GPU -> CPU fallback, exactly as Google's sample does
      task = await PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetBuffer: buf, delegate: "CPU" },
        runningMode: "VIDEO", numPoses: d.numPoses ?? 1,
      });
      self.postMessage({ type: "DELEGATE_FALLBACK", ...diagnoseWebGL() });
    }
    self.postMessage({ type: "INIT_DONE" });
  }
  else if (d.type === "DETECT_VIDEO") {
    const t0 = performance.now();
    let result;
    try { result = task.detectForVideo(d.bitmap, d.timestampMs); }
    finally { d.bitmap.close(); }                 // 🔴 always close
    self.postMessage({ type: "DETECT_RESULT", result, inferenceTime: performance.now() - t0 });
  }
};
```

```js
// main thread — one frame in flight at a time (backpressure)
let busy = false, lastVideoTime = -1;
async function pump(now, md) {
  if (!busy && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    busy = true;
    const bitmap = await createImageBitmap(video);
    worker.postMessage({ type: "DETECT_VIDEO", bitmap, timestampMs: md.mediaTime * 1000 }, [bitmap]);
  }
  video.requestVideoFrameCallback(pump);
}
worker.onmessage = e => { if (e.data.type === "DETECT_RESULT") { busy = false; consume(e.data.result); } };
video.requestVideoFrameCallback(pump);
```

Caveats, all real:
- **`MediaStream`/`HTMLVideoElement` cannot cross into a Worker.** You must transfer per-frame `ImageBitmap` (via `createImageBitmap(video)`, transferable) or `VideoFrame` (MediaStreamTrackProcessor, Chromium-only). `createImageBitmap` is a copy — it is not free, but it's far cheaper than 30 ms of blocked main thread.
- **Converting to/from `ImageBitmap` requires the task to be initialized with an `OffscreenCanvas`** (`canvas` option) — this is automatic in a Worker.
- Pass `useModule: true` for module workers. If you use a **classic** worker, note `calum/camera-games` chose classic precisely "because MediaPipe uses `importScripts`" — the classic `vision_wasm_internal.js` loader path.
- **WebGL2-in-OffscreenCanvas on Safari**: 2D context landed in **16.4**; WebGL/WebGL2 inside OffscreenCanvas came in **later** releases (early 16.4 builds were buggy). It is fine on Safari 26.x. If you support anything older than ~Safari 17, ship a main-thread fallback — `camera-games` exposes `?worker=off` for exactly this.
- **MediaPipe's WASM wants an offscreen WebGL2 context even with `delegate:"CPU"`.** This is why `delegate:"CPU"` does not rescue you from `emscripten_webgl_create_context() returned error 0` (issue #5970, M1 MacBook Air, still open; one reporter found Firefox worked where Chrome failed). Detect and degrade, don't assume CPU is a universal escape hatch.
- Always include the GPU→CPU fallback **and** diagnostics. Google's sample classifies the failure: `OffscreenCanvas unsupported` / `WebGL disabled` / `WebGL 2.0 unsupported` / `WebGL context lost` (too many contexts for the domain — close tabs) / **`swiftshader`/`software` renderer** (hardware acceleration off in browser settings — very common on locked-down school machines, and it will drop you to ~10 fps). Surface a real message, not a blank canvas.

### 4.4 Mirroring ("magic mirror")

Mirror **both** the draw and the coordinates, from a single flag:

```js
// canvas
if (mirror) { ctx.translate(W, 0); ctx.scale(-1, 1); }
// landmarks
const pt = l => ({ x: (mirror ? 1 - l.x : l.x) * W, y: l.y * H, v: l.visibility ?? 1 });
```

Alternatively CSS `transform: scaleX(-1)` on the `<video>` and mirror only the landmark x. Either way: **do not** mirror the frame you feed the model — it costs a copy and buys nothing (the model is trained on both orientations), and it would double-flip your left/right semantics. Mirroring is non-negotiable UX: unmirrored, "raise your right hand" sends every 7-year-old the wrong way.

### 4.5 Secure context

`getUserMedia` requires a **secure context**: `https://` or `http://localhost` / `127.0.0.1`. **`http://192.168.x.x` does not work** — `berad217/pose_detection` calls this out explicitly as the #1 support question. For classroom testing on iPads over LAN you need real HTTPS (mkcert + trusted root on the device, or a tunnel). Permission is per-origin and persists; Safari is stricter about re-prompting than Chrome.

### 4.6 iOS Safari / iPad — read this before promising schools

- `getUserMedia` works in **Safari on iOS/iPadOS 11+**, and in third-party iOS browsers too since they're all WebKit.
- **`playsInline` + `muted` + `autoplay` are mandatory.** Without `playsInline`, iOS hijacks the video fullscreen. Without `muted`, autoplay is blocked.
- **Home-screen PWA camera is a minefield.** WebKit bug **#252465** — video element won't play a `getUserMedia` stream in a home-screen PWA; track stays `live` but `muted: true`, events stop at `suspend` and never reach `canplay`, `readyState` stuck at 0. Marked **RESOLVED FIXED** (Jul 2023) but users kept reporting it through **iOS 18.0.1 / 18.4.1 / 18.5**. Triggers: closing the PWA while the video is off-screen, keyboard pushing video off-screen, permission deny/allow cycles, screen timeout, opening Control Center while the camera is active. **No reliable fix; recovery often needs a device restart.** → **Ship as a normal Safari tab, not a home-screen PWA.** If you must support PWA, re-acquire the stream on `visibilitychange` and watch `track.muted`.
- iOS **interrupts the camera** on incoming calls, Control Center, app switch, and screen lock. Listen for `track.onmute` / `onunmute` / `onended` and re-acquire.
- WebGL2 is supported from **iOS/iPadOS 15**, so the GPU delegate is available — but Safari's WebGL2 has historically failed a meaningful share of the Khronos conformance suite, and profiling shows `glReadPixels` inside the MediaPipe WASM module is slow (one team measured the stock tasks-vision WASM at **8 ms vs 4 ms** for a custom-compiled module on the same work). Expect iPad to land below an equivalent-silicon Mac.
- **Low Power Mode** throttles aggressively and will halve your frame rate with no API to detect it. Add an on-screen fps readout so you can diagnose it in a classroom.
- Older/base iPads (A12-class) at `numPoses: 2` will not hold 30 fps. Plan for 1 player per iPad and use iPads as *controllers*, with a laptop/TV as the shared screen, if your party format allows.

### 4.7 Other gotchas

**Video not ready.** `detectForVideo` on a zero-dimension video throws or produces garbage. Gate properly:

```js
await new Promise(r => video.readyState >= 2 ? r() : video.addEventListener("loadeddata", r, {once:true}));
if (!video.videoWidth) throw new Error("camera gave no frames");
```

**Model warmup is worse than you think.** Two distinct costs:
1. Graph/WASM init + model parse: hundreds of ms.
2. **MediaPipe compiles GPU shaders lazily, per subgraph — the *landmark* stage only compiles the first time a body actually appears.** On a cold browser cache one team measured that pass at **~20 s**, which blew their worker timeouts. Typical shader-compile cost is 200–500 ms per shader, 1–5 s total.

   → **Warm up with a frame that contains a person** (a bundled 256×256 JPEG of a figure, run once through `detect()` in IMAGE mode, or one `detectForVideo` call), behind your loading screen, before the first round. Warming with a blank frame compiles the detector and *not* the landmarker, which is exactly the stall you were trying to avoid. Give the first-frame path a generous timeout (Google's sample allows 60 s for boot frames vs 5 s steady-state).

**Tab backgrounding.** `rAF` is **suspended**, not merely throttled, in hidden tabs; pending callbacks resume on return. rVFC follows paint, so it stops too. But the **camera keeps running and the WebGL context stays alive** — so a naive loop resumes with a huge `dt` and a timestamp jump. Handle it:

```js
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { pauseGame(); }
  else { lastVideoTime = -1; lastTs = performance.now(); resumeGame(); }  // reset dt + dedupe
});
const dt = Math.min(0.05, (now - last) / 1000);   // clamp dt always (Jumping Jack clamps 1/120..0.2 s)
```
Also pause audio and stop posting to the worker; and consider stopping tracks entirely to drop the camera indicator (poseplease keeps video active "only during active turns to conserve battery").

**WebGL context limit.** Browsers cap live WebGL contexts per domain (~16). A party site that creates a landmarker per mini-game and never calls `close()` will hit `WebGL context lost` mid-session. One landmarker, reused, `close()` on teardown.

**`setOptions` churn.** Changing `numPoses` or the model rebuilds the graph and re-triggers shader compilation. Choose model + numPoses at round start, not per frame.

---

## 5. Derived signals

### 5.1 Normalize first — this is the whole ballgame

Raw `x,y` depend on camera distance, player height, where they stand, and crop. Google's own pose-classification guidance does exactly two things before anything else: **normalize translation, then normalize torso size and vertical torso orientation.** Do the same, and every threshold below becomes device- and kid-independent.

```js
// body-relative frame: origin = hip midpoint, unit = torso length
function frame(lm) {
  const hip = mid(lm[23], lm[24]);
  const sho = mid(lm[11], lm[12]);
  const torso = Math.hypot(sho.x - hip.x, (sho.y - hip.y) * ASPECT);  // ASPECT = H/W if using normalized coords
  const u = Math.max(torso, 1e-3);
  return { hip, sho, u, shoulderW: dist(lm[11], lm[12]) };
}
const norm = (p, f) => ({ x: (p.x - f.hip.x) / f.u, y: (p.y - f.hip.y) / f.u });
```
`Jumping Jack` uses the same idea for its hit-zone scale: `Math.max(d(pts[11], pts[12]), torso * 0.7)`, clamped to **4%–50% of screen height** — the clamp is what stops a mis-detection from exploding the game's geometry.

### 5.2 Angles

Cross/dot form, numerically robust at the extremes (no `acos` domain blowups):

```js
function angleDeg(A, B, C) {            // angle at B, 0..180
  const bax = A.x - B.x, bay = A.y - B.y;
  const bcx = C.x - B.x, bcy = C.y - B.y;
  const dot = bax*bcx + bay*bcy;
  const crs = bax*bcy - bay*bcx;
  return Math.atan2(Math.abs(crs), dot) * 180 / Math.PI;
}
const kneeL  = angleDeg(lm[23], lm[25], lm[27]);
const elbowL = angleDeg(lm[11], lm[13], lm[15]);
```

Signed limb direction (for "arm angle", pointing, steering):
```js
// 0° = pointing right, 90° = straight up (y inverted), screen space
const limbAngle = (p, q) => Math.atan2(-(q.y - p.y), (q.x - p.x)) * 180 / Math.PI;
```

### 5.3 Smoothing: One Euro filter

This is what the professionals ship — tfjs's `enableSmoothing` is a One Euro filter, MediaPipe's own `pose_landmark_filtering` graph uses one, and `berad217/pose_detection` picked it because it "kills jitter without adding lag — fast motion passes through, resting shake gets damped."

Exact formulation:

$$\alpha = \frac{1}{1 + \tau/T_e}, \qquad \tau = \frac{1}{2\pi f_C}, \qquad \hat{X}_i = \alpha X_i + (1-\alpha)\hat{X}_{i-1}$$
$$\dot{X}_i = \frac{X_i - \hat{X}_{i-1}}{T_e}, \qquad f_C = f_{C_{min}} + \beta\,|\hat{\dot{X}}_i|$$

The derivative is smoothed with a **constant** cutoff ($f_{C_d}$, default 1.0); the signal is smoothed with the **speed-adaptive** cutoff. Tuning: *decreasing $f_{C_{min}}$ decreases slow-speed jitter; increasing $\beta$ decreases speed lag.*

```js
const smoothingFactor = (te, cutoff) => { const r = 2 * Math.PI * cutoff * te; return r / (r + 1); };

class OneEuro {
  constructor({ minCutoff = 1.0, beta = 0.02, dCutoff = 1.0 } = {})
    { Object.assign(this, { minCutoff, beta, dCutoff }); this.x = null; this.dx = 0; this.t = null; }
  filter(x, tSec) {
    if (this.t === null) { this.t = tSec; this.x = x; return x; }
    const te = Math.max(1e-3, tSec - this.t); this.t = tSec;
    const ad = smoothingFactor(te, this.dCutoff);
    const dx = (x - this.x) / te;
    this.dx = ad * dx + (1 - ad) * this.dx;
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    const a = smoothingFactor(te, cutoff);
    this.x = a * x + (1 - a) * this.x;
    return this.x;
  }
}

// one filter per coordinate per landmark; drive with REAL timestamps
class LandmarkSmoother {
  constructor(cfg) { this.f = Array.from({length: 33}, () => ({ x: new OneEuro(cfg), y: new OneEuro(cfg), z: new OneEuro(cfg) })); }
  apply(lms, tSec) {
    return lms.map((l, i) => ({
      ...l,
      x: this.f[i].x.filter(l.x, tSec),
      y: this.f[i].y.filter(l.y, tSec),
      z: this.f[i].z.filter(l.z, tSec),
    }));
  }
}
```

Starting parameters:
- **General landmark smoothing:** `minCutoff 1.0, beta 0.02, dCutoff 1.0`
- **tfjs MoveNet's shipped values** (normalized-coordinate space, 30 Hz): `minCutoff 2.5, beta 300.0` — far more responsive, tuned for exactly this job. Start here and back off if it jitters.

**Cheaper alternatives, and when each is right:**

| Filter | Use for | Code |
|---|---|---|
| **EMA / lerp** | positions when you already interpolate for rendering | `x = ALPHA*raw + (1-ALPHA)*x`, `ALPHA 0.2–0.4`. *Jumping Jack*: `lerp(this.x, x, 0.75)` for position, `lerp(this.vx, (nx-this.x)/dt, 0.6)` for velocity |
| **Median-of-3/5** | killing single-frame *outliers* (a wrist teleporting to a reflection). EMA smears a spike; median deletes it | apply median first, then EMA/One Euro |
| **One Euro** | anything where lag is perceptible — hands, jump detection | above |

Rule: **median → One Euro → threshold.** And never smooth a *boolean*; smooth the continuous signal and put hysteresis on the threshold.

### 5.4 Low-visibility landmarks

```js
const MIN_VIS = 0.5;                 // Jumping Jack uses VIS = 0.5
const ok = (...idx) => idx.every(i => (lm[i].visibility ?? 1) >= MIN_VIS);
```
Rules that survive contact with real rooms:
- **Gate, don't guess.** If the landmarks a gesture needs aren't visible, return `undefined` and leave the state machine alone. Don't feed a 0.1-visibility ankle into a jump detector.
- Start at **0.5**, tune in 0.6–0.7 for angle-based signals (they punish landmark error much harder than event detection does).
- Hold the last good value for a short grace window (*Jumping Jack*: hide a body part after **0.3 s** undetected, drop the whole player after **0.6 s**) rather than snapping to garbage.
- Build a **fallback ladder**: prefer hips, fall back to shoulders, fall back to nose. *Jumping Jack* even counts jumping-jack arms only if the feet aren't visible — degrading the *rule* instead of the *data*.

### 5.5 Event detectors

Shared scaffolding — **calibrate a baseline, use two thresholds, re-arm on exit.** Both the `dino-motion-controller` ("you stand in position and press S to lock in your standing height… the line stays fixed so movement can't drift it") and Motion Gym ("a three-second calibration captures player proportions… every rep against *your own* body") do exactly this.

```js
// 3-second calibration, median is robust to a wobble mid-capture
function calibrate(samples) {                     // samples: array of {hipY, torso, ankleY, shoulderW}
  const med = a => a.slice().sort((x,y)=>x-y)[a.length>>1];
  return {
    hipY0:   med(samples.map(s=>s.hipY)),
    torso0:  med(samples.map(s=>s.torso)),
    ankleY0: med(samples.map(s=>s.ankleY)),
    shoW0:   med(samples.map(s=>s.shoulderW)),
  };
}
```

**JUMP** — hip y-velocity primary, displacement as backup, re-arm on landing.
```js
// dt in seconds; all y in normalized image coords (y grows DOWN), u = torso length
const JUMP_V   = -1.8;   // torso-lengths per second, upward (negative)
const JUMP_D   = -0.12;  // 12% of torso above baseline (backup trigger)
const LAND_D   = -0.04;  // must return within 4% to re-arm
const MIN_GAP  = 0.25;   // s, refractory

function jumpStep(s, hipY, u, base, dt, t) {
  const yN = (hipY - base.hipY0) / u;            // 0 at standing, negative when higher
  const v  = (yN - s.prevY) / Math.max(dt, 1e-3);
  s.prevY = yN;
  let fired = false;
  if (s.armed && t - s.lastFire > MIN_GAP && (v < JUMP_V || yN < JUMP_D)) {
    fired = true; s.armed = false; s.lastFire = t;
  }
  if (!s.armed && yN > LAND_D) s.armed = true;   // landed -> re-arm
  return fired;
}
```
Notes: fire on the **first frame of upward velocity** (takeoff) — waiting for peak height adds 100–150 ms of perceived lag. For *scoring* jump height, use the flight-time method `h = g·t²/8` (t = airborne seconds), which is far more accurate than pixel displacement; pixel-to-metre conversion needs the player's real height. **Do not use `worldLandmarks` hips** — origin is the hip midpoint, so hip world-y is always ~0.

**SQUAT** — hip drop below a fixed duck line with separate press/release depths. The `dino-motion-controller` holds Down while hips are below the line and releases on standing, with "separate press and release depths [that] keep the key from flickering."
```js
const SQUAT_IN  = 0.18;   // hips 18% of a torso below baseline -> squatting
const SQUAT_OUT = 0.09;   // must rise to 9% to exit  (hysteresis gap ~2x)
function squatStep(s, hipY, u, base) {
  const yN = (hipY - base.hipY0) / u;
  if (!s.down && yN > SQUAT_IN)  s.down = true;
  if ( s.down && yN < SQUAT_OUT) { s.down = false; s.reps++; }
  return s.down;
}
```
Angle-based variant with published thresholds (fitness apps): standing ≥ **160°**, descent begins < **145°**, valid bottom ≤ **105°**, rep counts on return to ≥ **160°**. Knee angle is viewpoint-dependent — reliable from the side, poor head-on, which is why hip displacement is the better choice for a front-facing party game.

**Generic rep counter** (count on **one** edge only — "counting on both double-counts"):
```js
const ENTER_DOWN = 100, EXIT_UP = 160, MIN_VIS = 0.6, ALPHA = 0.3;
let state = "up", reps = 0, sm = null;
function updateReps(raw, lm) {
  const vis = Math.min(lm[23].visibility, lm[25].visibility, lm[27].visibility);
  if (vis < MIN_VIS) return;                                   // 1) confidence gate
  sm = sm == null ? raw : ALPHA*raw + (1-ALPHA)*sm;             // 2) EMA
  if (state === "up"   && sm < ENTER_DOWN) state = "down";      // 3) hysteresis
  else if (state === "down" && sm > EXIT_UP) { state = "up"; reps++; }
}
```

**ARMS RAISED**
```js
const wristsUp = ok(15,16,11,12) && lm[15].y < lm[11].y - 0.05 && lm[16].y < lm[12].y - 0.05;
const oneUp    = (lm[15].y < lm[11].y - 0.05) !== (lm[16].y < lm[12].y - 0.05);
// stricter "hands above head": wrist above the nose
const handsOverHead = lm[15].y < lm[0].y && lm[16].y < lm[0].y;
```
Use shoulder-relative (not nose-relative) for "raise your arms" so short kids and tall adults behave the same.

**T-POSE** — arms straight, horizontal, wide.
```js
function isTPose(lm, f) {
  if (!ok(11,12,13,14,15,16)) return false;
  const straightL = angleDeg(lm[11], lm[13], lm[15]) > 155;
  const straightR = angleDeg(lm[12], lm[14], lm[16]) > 155;
  const levelL = Math.abs(lm[15].y - lm[11].y) < 0.12 * f.u / 1; // within ~12% torso of shoulder height
  const levelR = Math.abs(lm[16].y - lm[12].y) < 0.12 * f.u / 1;
  const spanOK = dist(lm[15], lm[16]) > 1.6 * f.shoulderW;       // wider than 1.6 shoulder widths
  return straightL && straightR && levelL && levelR && spanOK;
}
```
Require it **held** (e.g. 0.3–0.5 s, or `camera-games`' 2 s for opt-in join) so a passing arm swing doesn't trigger it.

**ARM ANGLE / STEERING**
```js
const steer = limbAngle(mid(lm[11],lm[12]), mid(lm[15],lm[16]));   // -180..180
const tilt  = limbAngle(lm[15], lm[16]);                            // "handlebar" angle between wrists
```

**HAND POSITION** — put the hit zone on the *palm*, not the wrist. *Jumping Jack* pushes the hand circle **1.4×** beyond the wrist toward the finger centroid:
```js
const c = centroid(lm[17], lm[19], lm[21]);           // pinky, index, thumb
const palm = { x: lm[15].x + (c.x - lm[15].x) * 1.4,
               y: lm[15].y + (c.y - lm[15].y) * 1.4 };
```
And gate hits on speed so a resting hand doesn't score: `hit(x, y, r, names, minSpeed)`. *game-cam* measures hand velocity "between camera frames, not screen frames, so a fast swing really does hit harder."

**LEAN LEFT/RIGHT** — shoulder midpoint horizontally offset from hip midpoint, in torso units.
```js
const leanX = (f.sho.x - f.hip.x) / f.u;        // + = subject leans toward image-right
const LEAN_IN = 0.22, LEAN_OUT = 0.12;
// hysteresis -> {-1, 0, +1}; flip sign if your view is mirrored
```

**STEP LEFT/RIGHT** — whole-body translation, not lean. Track the hip midpoint against a slow baseline so the player can re-centre without the baseline drifting during a step:
```js
s.baseX = s.inZone ? s.baseX : s.baseX*0.98 + f.hip.x*0.02;   // freeze while triggered
const stepX = (f.hip.x - s.baseX) / f.u;
const STEP_IN = 0.45, STEP_OUT = 0.25;
```
For a jumping-jack-style "feet in/out", use ankle separation relative to shoulder width: `dist(lm[27],lm[28]) > 1.3 * f.shoulderW`.

**HEAD TILT**
```js
const headTilt = Math.atan2(lm[8].y - lm[7].y, lm[8].x - lm[7].x) * 180/Math.PI;  // ear-to-ear roll
const headYaw  = (lm[0].x - mid(lm[7],lm[8]).x) / dist(lm[7], lm[8]);             // nose offset between ears, ~[-1,1]
const headNod  = (lm[0].y - f.sho.y) / f.u;                                       // crude pitch
```
Roll is reliable; yaw is usable; **pitch is poor** — don't build a game on nodding.

**Pose matching** (for a "copy the pose" mini-game) — the Move Mirror method, and the right answer for a party site:
```js
// 1) take the keypoints you care about, 2) translate+scale by bounding box,
// 3) L2-normalize the flat vector, 4) cosine distance
const similarity = require("compute-cosine-similarity");
function cosineDistanceMatching(v1, v2) {
  const cos = similarity(v1, v2);
  return Math.sqrt(2 * (1 - cos));           // lower = closer
}
```
Weighted variant uses each keypoint's confidence as its weight (optionally with a custom per-joint multiplier, e.g. de-weight the face, up-weight wrists). `posenet-similarity` normalizes by (a) subtracting min x/y, (b) dividing by the max resulting value, then (c) L2-normalizing.

Google's documented alternative is a **k-NN classifier over a pose embedding of pairwise joint distances** (wrist↔shoulder, ankle↔hip, wrist↔wrist, …) after normalizing torso size and vertical orientation, with k-NN run **twice under different distance metrics** and ~**100 samples per pose class**. More work, more robust, and the right call if you want "is this a dab?" rather than "how close to this exact skeleton?". Score it as a **1-second rolling best** (what `poseplease` does) so a lucky single frame can't win a round.

---

## 6. Open-source web pose games worth reading

| Repo | What to steal |
|---|---|
| **[alecsharpie/jumpingjack](https://github.com/alecsharpie/jumpingjack)** | The closest match to your brief: EyeToy-style browser party games, 100% client-side. `js/body.js` is the gem — lerp smoothing (`0.75` pos, `0.6` vel), 10-frame trails, `VIS=0.5`, torso-scaled geometry clamped to 4–50% of screen height, palm hit-zones at 1.4× past the wrist, `hit(x,y,r,names,minSpeed)` speed-gated collisions. `Crowd` class does chest-anchor nearest-neighbour multi-player matching with a 0.6 s drop. `js/vision.js`: GPU-then-CPU try/catch, `numPoses=2`, full model default. `js/main.js`: 1280×720@30 `ideal`, `rAF` + `video.currentTime` dedupe, `?debug` fps overlay, mirror flag applied to both canvas and landmarks, "Can't see you" banner after 1.2 s. Extend to 4 with `?players=N`; `?model=lite`. Also combines PoseLandmarker with **GestureRecognizer** (`numHands=4`) for hand-sign games |
| **[calum/camera-games](https://github.com/calum/camera-games/pull/3)** | **The classroom-hardening playbook.** MediaPipe in a *classic* worker (because of `importScripts`) with `?worker=off` fallback. A `QUALITY` ladder in `tracker.js`: full → lite → lite@half-res → lite without masks, auto-downgrading on slow tracking and upgrading after sustained speed, phones starting one step down. `src/people.js` (14 unit tests): ~0.45 s probation before a body becomes a player, upright check, mid-game joiners must hold arms out 2 s, probation/dropout windows stretch on slow devices. `src/look.js` re-identifies players by position + clothing colour. Canvas capped at 1080p; cutout regenerated per *camera* frame not per paint |
| **[eyrockscript/game-cam](https://github.com/eyrockscript/game-cam)** | Kinect-style, **up to 5 players**, offline PWA. **MoveNet MultiPose Lightning** on tfjs/WebGL; poses matched frame-to-frame by **torso position** so each player keeps their colour. Input raised to **512 px** so 5 people across 16:9 still give accurate wrists. Camera zoomed to widest when `zoom` is supported; letterboxes rather than crops on aspect mismatch. Model (9.3 MB) + assets precached by a service worker. Hand velocity measured between *camera* frames |
| **[keyu-craft/pose-party](https://github.com/keyu-craft/pose-party)** | Copy-the-pose in 60 s, EN/中文. PoseLandmarker + FaceLandmarker, TypeScript + Vite, and explicitly **"Web Worker, OffscreenCanvas, and ImageBitmap"** for inference scheduling — the reference implementation of §4.3. Requires holding the matching pose for **1 second of valid tracking** |
| **[linuteresa/fun-AR-motion-game](https://github.com/linuteresa/fun-AR-motion-game)** (Motion Gym) | Two players on one camera, PoseLandmarker **v1.0.1**. Mirrored frame split left/right = P1/P2 — and the README honestly documents the failure: players who cross **swap identities**. 3 s calibration, all thresholds centralized in one `T` object, movements measured as a fraction of *that player's* torso. Candid about what detects well (squats, jacks, high knees, overhead reaches, dodges) vs. badly (boxing — single-camera depth) vs. removed (burpees, side lunges, skater hops) |
| **[berad217/pose_detection](https://github.com/berad217/pose_detection)** | Best-architected. **One Euro filter** with tunable `minCutoff`/`beta`; discrete events for **T-pose, hands-up, wave, squat, jump**; games at a locked **60 fps on a separate loop** from detection (15–30 fps). All three models vendored locally. Pipeline: Webcam → PoseDetector → FilterPipeline → DataBus → Display/Storage/REST. 445 tests, optional REST + SSE. Documents the `https`/`localhost`-only camera constraint |
| **[FamedChipmunk24/dino-motion-controller](https://github.com/FamedChipmunk24/dino-motion-controller)** | The cleanest jump/squat spec anywhere: hip midpoint; jump fires on **first frame of fast upward hip velocity** with a height threshold as backup; **fires once, re-arms on landing**; squat = hips below a **duck line** with separate press/release depths; explicit standing-height calibration keypress with a **fixed** line that movement can't drift. lite model, ~17 ms/frame |
| **[depstronaut/poseplease](https://github.com/depstronaut/poseplease)** | Networked architecture: Next.js + PoseLandmarker (WASM) + **Colyseus** WebSocket server, 8 players/room, turn-based with **video only during your turn** (battery), server scores the **best 1-second rolling average**, +15/+10/+5 round bonuses. Unit tests for joint angles, score tolerance, rolling averages, turn state machine |
| **[thelog5/pose-party](https://github.com/thelog5/pose-party)** | Body-charades: in-browser recognition + **authoritative multiplayer server** + P2P video |
| **[google-ai-edge/mediapipe-samples-web](https://github.com/google-ai-edge/mediapipe-samples-web)** | **Read this first.** Google's own Vite/TS sample on `@mediapipe/tasks-vision@^1.2.3`, every task in a Worker. `src/workers/base-worker.ts` has the production-grade `BaseWorker`: streamed model loading with progress + Cache API, `FilesetResolver.forVisionTasks(path, true)`, **GPU→CPU fallback with `diagnoseWebGLFailure()`** classifying OffscreenCanvas-unsupported / WebGL-disabled / WebGL2-unsupported / context-lost / **SwiftShader software renderer**, and lifecycle (`INIT`/`SET_OPTIONS`/`CLEANUP`). `pose-landmarker.worker.ts` takes `{bitmap, timestampMs}` and closes the bitmap. Playwright E2E incl. a `chromium-gpu` project |
| **[robinson-vidva/neokine](https://github.com/robinson-vidva/neokine)** | Client-side kinematics on top of landmarks: angles, velocity, left/right asymmetry |
| **[alx-sch/STRIKE_A_POSE](https://github.com/alx-sch/STRIKE_A_POSE)** | Pose *classification* game (dab / jump / squat) — Python/Pygame, but the class design ports directly |
| **[freshsomebody/posenet-similarity](https://github.com/freshsomebody/posenet-similarity)** + **[Move Mirror gist](https://gist.github.com/irealva/6d6b7cacda0bba2f41117142105cc6dd)** | Drop-in pose similarity: `cosineDistance`, `cosineSimilarity`, `weightedDistance` (default, weights = keypoint confidence, with `customWeight: {mode:'multiply', scores:{nose:0.5, …}}`) |
| **[vladmandic/movenet](https://github.com/vladmandic/movenet)** | Where to get MoveNet `model.json` + shards now that `tfhub.dev` 404s (Lightning v3/v4, Thunder v3/v4, MultiPose v1) |

---

## 7. Concrete starting config for your site

```js
// 1. detect capability, pick a tier
const tier = (() => {
  const gl = document.createElement("canvas").getContext("webgl2");
  if (!gl) return "unsupported";
  const dbg = gl.getExtension("WEBGL_debug_renderer_info");
  const r = (dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "").toLowerCase();
  if (r.includes("swiftshader") || r.includes("software")) return "software";   // warn the user
  return navigator.hardwareConcurrency >= 8 ? "high" : "low";
})();

const CONFIG = {
  high: { model: "lite", numPoses: 2, w: 1280, h: 720 },
  low:  { model: "lite", numPoses: 1, w: 640,  h: 480 },
  software: { model: "lite", numPoses: 1, w: 480, h: 360, delegate: "CPU" },
}[tier];
```
1. **Self-host** `wasm/` (Brotli, immutable cache) and the `.task` files; cache models in the Cache API.
2. **Module Worker**, `useModule: true`, GPU with CPU fallback + diagnostics, one frame in flight.
3. **Warm up with a bundled image of a person** behind the loading screen.
4. **rVFC** drives detection with `currentTime` dedupe; **rAF** drives rendering at 60 fps with interpolation.
5. **Median → One Euro (`minCutoff 1.0, beta 0.02`, or MoveNet's `2.5/300`) → hysteresis thresholds**, all in torso units off a 3-second calibration.
6. **Mirror** everything; gate on `visibility ≥ 0.5`; probation before a body becomes a player.
7. Ship an **fps/latency debug overlay** (`?debug`) — you will need it in a classroom, and so will the teacher.

Two things I'd validate on real hardware before committing: (a) `numPoses: 2` vs. **two cropped-ROI passes** for your 2-player mode — I expect crops to win on both accuracy and identity stability; (b) actual iPad frame rates on the oldest device the schools have, because that number decides whether iPads are players or just controllers.

---

**Sources:** [npm @mediapipe/tasks-vision](https://www.npmjs.com/package/@mediapipe/tasks-vision) · [npmx version/date](https://npmx.dev/package/@mediapipe/tasks-vision) · [registry metadata](https://registry.npmjs.org/@mediapipe/tasks-vision) · [MediaPipe releases](https://github.com/google-ai-edge/mediapipe/releases) · [Pose Landmarker guide (Web)](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker?tab=Web) · [PoseLandmarker class](https://developers.google.com/edge/api/mediapipe/js/tasks-vision.poselandmarker) · [PoseLandmarkerOptions](https://developers.google.com/edge/api/mediapipe/js/tasks-vision.poselandmarkeroptions) · [Web setup guide](https://developers.google.com/edge/mediapipe/solutions/setup_web) · [MPMask class](https://ai.google.dev/edge/api/mediapipe/js/tasks-vision.mpmask) · [unpkg wasm listing 1.2.3](https://app.unpkg.com/@mediapipe/tasks-vision@1.2.3/files/wasm) · [HF PoseLandmarker-Lite](https://huggingface.co/litert-community/MediaPipe-PoseLandmarker-Lite) · [HF PoseLandmarker-Full](https://huggingface.co/litert-community/MediaPipe-PoseLandmarker-Full) · [lite vs full vs heavy numbers](https://aifitnessapi.com/motion/mediapipe-pose-landmarker-models) · [33 landmarks + measured behavior](https://kabe-tech.com/blog/poseMirror/mediapipe-landmarks-en) · [AI workout tracking in JS](https://aifitnessapi.com/guides/ai-workout-tracking-web) · [Web AI Showcase: PoseLandmarker](https://webai.show/models/pose-landmarker/) · [issue #5274 multi-person](https://github.com/google/mediapipe/issues/5274) · [issue #5292 workers on iOS](https://github.com/google-ai-edge/mediapipe/issues/5292) · [issue #5950 browser requirements](https://github.com/google-ai-edge/mediapipe/issues/5950) · [issue #5970 GPU-less M1](https://github.com/google-ai-edge/mediapipe/issues/5970) · [issue #5826 WebGPU for vision tasks](https://github.com/google-ai-edge/mediapipe/issues/5826) · [mediapipe-samples-web](https://github.com/google-ai-edge/mediapipe-samples-web) · [base-worker.ts](https://github.com/google-ai-edge/mediapipe-samples-web/blob/main/src/workers/base-worker.ts) · [pose-landmarker.worker.ts](https://github.com/google-ai-edge/mediapipe-samples-web/blob/main/src/workers/pose-landmarker.worker.ts) · [npm @tensorflow-models/pose-detection](https://www.npmjs.com/package/@tensorflow-models/pose-detection) · [MoveNet README](https://github.com/tensorflow/tfjs-models/blob/master/pose-detection/src/movenet/README.md) · [MoveNet constants.ts](https://github.com/tensorflow/tfjs-models/blob/master/pose-detection/src/movenet/constants.ts) · [tfhub.dev 404 report](https://github.com/nathanaelhub/limber/issues/53) · [TF Hub → Kaggle](https://discuss.ai.google.dev/t/tensorflow-hub-is-moving-to-kaggle-models/31936) · [vladmandic/movenet](https://github.com/vladmandic/movenet) · [npm @litertjs/core](https://www.npmjs.com/package/@litertjs/core) · [LiteRT.js announcement](https://developers.googleblog.com/litertjs-googles-high-performance-web-ai-inference/) · [rtmlib-ts](https://dev.to/gohdev_1/rtmlib-ts-real-time-pose-estimation-object-detection-in-browser-with-typescript-yolo12-48ep) · [RTMPose vs MediaPipe vs OpenPose 2026](https://www.forasoft.com/learn/ai-for-video-engineering/articles-ai/openpose-mediapipe-rtmpose-pose-tracking) · [Frontier Web APIs 2026 (WebGPU Baseline)](https://www.utsubo.com/blog/frontier-web-apis-2026-production-ready) · [rVFC on MDN](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback) · [rVFC caniuse](https://caniuse.com/mdn-api_htmlvideoelement_requestvideoframecallback) · [web.dev rVFC](https://web.dev/articles/requestvideoframecallback-rvfc) · [rAF MDN](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame) · [MDN constraints](https://developer.mozilla.org/en-US/docs/Web/API/Media_Capture_and_Streams_API/Constraints) · [WebKit #252465 PWA camera](https://bugs.webkit.org/show_bug.cgi?id=252465) · [OffscreenCanvas on Safari](https://www.testmuai.com/web-technologies/offscreencanvas-safari/) · [One Euro filter derivation](https://jaantollander.com/post/noise-filtering-using-one-euro-filter/) · [MediaPipe pose_landmark_filtering](https://github.com/google-ai-edge/mediapipe/blob/master/mediapipe/modules/pose_landmark/pose_landmark_filtering.pbtxt) · [MediaPipe pose classification](https://github.com/google-ai-edge/mediapipe/blob/master/docs/solutions/pose_classification.md) · [ML Kit classifying poses](https://developers.google.com/ml-kit/vision/pose-detection/classifying-poses) · [Move Mirror](https://blog.tensorflow.org/2018/07/move-mirror-ai-experiment-with-pose-estimation-tensorflow-js.html) · [posenet-similarity algorithms](https://github.com/freshsomebody/posenet-similarity/wiki/Algorithms) · [jumpingjack](https://github.com/alecsharpie/jumpingjack) · [camera-games PR #3](https://github.com/calum/camera-games/pull/3) · [game-cam](https://github.com/eyrockscript/game-cam) · [pose-party (keyu-craft)](https://github.com/keyu-craft/pose-party) · [Motion Gym](https://github.com/linuteresa/fun-AR-motion-game) · [berad217/pose_detection](https://github.com/berad217/pose_detection) · [dino-motion-controller](https://github.com/FamedChipmunk24/dino-motion-controller) · [poseplease](https://github.com/depstronaut/poseplease) · [thelog5/pose-party](https://github.com/thelog5/pose-party) · [neokine](https://github.com/robinson-vidva/neokine) · [STRIKE_A_POSE](https://github.com/alx-sch/STRIKE_A_POSE)