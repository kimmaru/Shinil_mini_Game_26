// Device tier detection: WebGL2, software-renderer sniffing, core count.
//
// The case that matters is the locked-down school machine. Chrome with
// hardware acceleration disabled by policy still reports a working WebGL2
// context — it is SwiftShader, it runs MediaPipe at roughly 10fps, and to a
// child that does not look like a slow computer, it looks like "the site is
// broken". Detect it, drop the capture resolution, and say so out loud.
//
// MediaPipe's `delegate:"GPU"` on the web is WebGL2, not WebGPU, so
// `navigator.gpu` tells us nothing useful here (RESEARCH-POSE §3 / §7).
// `delegate:"CPU"` is also not a universal escape hatch: the WASM module wants
// an offscreen WebGL2 context either way.

export type PoseTier = 'high' | 'low' | 'software' | 'unsupported';

export interface PoseTierConfig {
  tier: PoseTier;
  model: 'lite' | 'full';
  /** Chosen at round start and never changed mid-round: setOptions() rebuilds
   *  the graph and re-triggers shader compilation. */
  numPoses: 1 | 2;
  /** Capture request, always as `ideal` — `exact` throws OverconstrainedError
   *  on Chromebook webcams that only offer odd modes. */
  width: number;
  height: number;
  delegate: 'GPU' | 'CPU';
  /** Target inference rate. The model downsamples to 256x256 internally, so
   *  past ~30Hz we would be paying upload cost for nothing. */
  targetHz: number;
  /** Stretch probation/drop windows by this much, so players do not flicker
   *  in and out on a slow device. */
  slowFactor: number;
  /** Raw UNMASKED_RENDERER_WEBGL string, for the debug overlay. */
  renderer: string;
  cores: number;
  /** Human-readable, Korean, shown as a gentle toast. Never fail silently. */
  warningKo?: string;
}

export const TIER_CONFIG: Record<PoseTier, Omit<PoseTierConfig, 'renderer' | 'cores' | 'tier'>> = {
  // 960x540, not 1280x720: the model sees 256x256 either way, and every extra
  // pixel is paid again in the per-frame copy to the inference worker. Still
  // 16:9, so a 720p laptop camera (FaceTime HD) scales rather than crops.
  high: { model: 'lite', numPoses: 2, width: 960, height: 540, delegate: 'GPU', targetHz: 30, slowFactor: 1 },
  low: { model: 'lite', numPoses: 1, width: 640, height: 480, delegate: 'GPU', targetHz: 25, slowFactor: 1.4 },
  software: { model: 'lite', numPoses: 1, width: 480, height: 360, delegate: 'CPU', targetHz: 15, slowFactor: 2.2 },
  unsupported: { model: 'lite', numPoses: 1, width: 480, height: 360, delegate: 'CPU', targetHz: 12, slowFactor: 2.5 },
};

export interface CapabilityProbe {
  webgl2: boolean;
  renderer: string;
  cores: number;
  software: boolean;
  offscreenCanvas: boolean;
  /** rVFC: without it we fall back to rAF and the currentTime dedupe does all
   *  the work of not inspecting the same camera frame twice. */
  videoFrameCallback: boolean;
  /** Reason WebGL2 was unavailable, if it was. */
  note?: string;
}

const SOFTWARE_HINTS = ['swiftshader', 'software', 'llvmpipe', 'basic render', 'microsoft basic'];

/** Probe the environment. Node-safe: returns a conservative probe with no DOM. */
export function probeCapability(): CapabilityProbe {
  const cores =
    typeof navigator !== 'undefined' && typeof navigator.hardwareConcurrency === 'number'
      ? navigator.hardwareConcurrency
      : 4;
  const offscreenCanvas = typeof OffscreenCanvas !== 'undefined';
  const videoFrameCallback =
    typeof HTMLVideoElement !== 'undefined' &&
    typeof HTMLVideoElement.prototype.requestVideoFrameCallback === 'function';

  if (typeof document === 'undefined') {
    return {
      webgl2: false,
      renderer: '',
      cores,
      software: false,
      offscreenCanvas,
      videoFrameCallback,
      note: 'no DOM',
    };
  }

  let gl: WebGL2RenderingContext | null = null;
  let note: string | undefined;
  let canvas: HTMLCanvasElement | undefined;
  try {
    canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    gl = canvas.getContext('webgl2');
    if (!gl) note = 'WebGL2 unavailable — hardware acceleration may be disabled';
  } catch (e) {
    note = `WebGL2 threw: ${String(e)}`;
  }

  let renderer = '';
  if (gl) {
    try {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      if (dbg) renderer = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) ?? '');
      // Release the context immediately: browsers cap live WebGL contexts at
      // ~16 per domain and this probe runs before the landmarker takes one.
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    } catch {
      /* renderer info is a privacy-gated extension; absence is not an error */
    }
  }
  const low = renderer.toLowerCase();
  const software = SOFTWARE_HINTS.some((h) => low.includes(h));

  const probe: CapabilityProbe = {
    webgl2: !!gl,
    renderer,
    cores,
    software,
    offscreenCanvas,
    videoFrameCallback,
  };
  if (note) probe.note = note;
  return probe;
}

/**
 * Pick a tier and the config that goes with it.
 *
 * `maxPlayers` caps numPoses: a 1-player game pays nothing for the second
 * pose, but a Chromebook at numPoses 2 is not a 30fps experience, so the tier
 * caps it back down.
 */
export function detectCapability(opts: { maxPlayers?: 1 | 2 | 3 | 4; probe?: CapabilityProbe } = {}): PoseTierConfig {
  const probe = opts.probe ?? probeCapability();
  const tier: PoseTier = !probe.webgl2
    ? 'unsupported'
    : probe.software
      ? 'software'
      : probe.cores >= 8
        ? 'high'
        : 'low';

  const base = TIER_CONFIG[tier];
  const wanted = opts.maxPlayers ?? 1;
  const numPoses: 1 | 2 = wanted >= 2 && base.numPoses === 2 ? 2 : 1;

  const cfg: PoseTierConfig = {
    tier,
    model: base.model,
    numPoses,
    width: base.width,
    height: base.height,
    delegate: base.delegate,
    targetHz: base.targetHz,
    slowFactor: base.slowFactor,
    renderer: probe.renderer,
    cores: probe.cores,
  };

  if (tier === 'software') {
    cfg.warningKo = '이 컴퓨터는 그래픽 가속이 꺼져 있어 조금 느릴 수 있어요.';
  } else if (tier === 'unsupported') {
    cfg.warningKo = '이 브라우저에서는 카메라 인식이 느릴 수 있어요. 키보드로도 놀 수 있어요!';
  } else if (wanted >= 2 && numPoses === 1) {
    cfg.warningKo = '이 컴퓨터에서는 한 명씩 번갈아 노는 것이 더 잘 돼요.';
  }
  return cfg;
}

/** Classify a landmarker creation failure into something a person can act on.
 *  Google's own sample does exactly this; a blank canvas is the worst possible
 *  failure mode. */
export function diagnoseGpuFailure(err: unknown, probe = probeCapability()): string {
  const msg = String((err as Error | undefined)?.message ?? err ?? '');
  if (!probe.offscreenCanvas) return 'OffscreenCanvas unsupported in this browser';
  if (!probe.webgl2) return probe.note ?? 'WebGL2 unsupported';
  if (probe.software) return `software renderer (${probe.renderer}) — hardware acceleration is off`;
  if (/context lost|too many|create_context/i.test(msg)) {
    return 'WebGL context lost — too many contexts open; close other tabs';
  }
  return msg || 'GPU delegate unavailable';
}
