// The camera source cannot be driven in Node — it needs a <video>, getUserMedia
// and a WebGL2 context. What IS testable here, and worth testing, is everything
// that decides whether the camera path behaves: the constraints, and the fact
// that importing this module does not drag 31MB of wasm bindings (or any DOM
// access) into the lobby bundle or into a Node test run.
//
// The behaviour that needs a browser — rVFC dedupe, monotonic timestamps,
// visibilitychange, track re-acquire, GPU->CPU fallback — is exercised by the
// lead's manual pass (`?debug=1`) and is called out in the hand-back as
// untested-in-CI. Pretending otherwise with a pile of DOM fakes would test the
// fakes, not the camera.
import { describe, expect, it } from 'vitest';
import { cameraConstraints, waitForVideo } from './mediapipe';
import { TIER_CONFIG } from './capability';

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
    expect(v.width).toEqual({ ideal: 1280 });
    expect(v.height).toEqual({ ideal: 720 });
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
