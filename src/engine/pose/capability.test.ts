import { describe, expect, it } from 'vitest';
import {
  TIER_CONFIG,
  type CapabilityProbe,
  detectCapability,
  diagnoseGpuFailure,
  probeCapability,
} from './capability';

const probe = (over: Partial<CapabilityProbe> = {}): CapabilityProbe => ({
  webgl2: true,
  renderer: 'Apple M2',
  cores: 8,
  software: false,
  offscreenCanvas: true,
  videoFrameCallback: true,
  ...over,
});

describe('probeCapability', () => {
  it('is Node-safe and conservative with no DOM', () => {
    expect(typeof document).toBe('undefined');
    const p = probeCapability();
    expect(p.webgl2).toBe(false);
    expect(p.note).toBe('no DOM');
    expect(p.cores).toBeGreaterThan(0);
  });
});

describe('detectCapability', () => {
  it('8+ cores with real hardware gets the high tier', () => {
    const c = detectCapability({ maxPlayers: 2, probe: probe() });
    expect(c.tier).toBe('high');
    expect(c.numPoses).toBe(2);
    expect(c.width).toBe(1280);
    expect(c.delegate).toBe('GPU');
    expect(c.warningKo).toBeUndefined();
  });

  it('a 4-core machine drops to one pose at 640x480 and says so', () => {
    const c = detectCapability({ maxPlayers: 2, probe: probe({ cores: 4 }) });
    expect(c.tier).toBe('low');
    expect(c.numPoses).toBe(1);
    expect(c.width).toBe(640);
    // The player asked for 2 and cannot have 2: never fail silently.
    expect(c.warningKo).toBeTruthy();
    expect(c.slowFactor).toBeGreaterThan(1);
  });

  it('detects SwiftShader — the locked-down school machine', () => {
    for (const renderer of [
      'Google SwiftShader',
      'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device))',
      'llvmpipe (LLVM 15.0.7, 256 bits)',
      'Microsoft Basic Render Driver',
      'Software Rasterizer',
    ]) {
      const c = detectCapability({ probe: probe({ renderer, software: /swift|soft|llvm|basic/i.test(renderer) }) });
      expect(c.tier, renderer).toBe('software');
      expect(c.delegate).toBe('CPU');
      expect(c.width).toBe(480);
      expect(c.targetHz).toBeLessThan(20);
      // To a child, 10fps looks like "the site is broken". Say something.
      expect(c.warningKo).toContain('느릴');
    }
  });

  it('no WebGL2 at all is still playable, just slow, and admits it', () => {
    const c = detectCapability({ probe: probe({ webgl2: false, note: 'WebGL2 unavailable' }) });
    expect(c.tier).toBe('unsupported');
    expect(c.warningKo).toBeTruthy();
    // It never returns a config a caller cannot use.
    expect(c.width).toBeGreaterThan(0);
    expect(c.numPoses).toBe(1);
  });

  it('never promises more poses than the game asked for', () => {
    const c = detectCapability({ maxPlayers: 1, probe: probe() });
    expect(c.numPoses).toBe(1);
  });

  it('every tier config is coherent', () => {
    for (const [tier, cfg] of Object.entries(TIER_CONFIG)) {
      expect(cfg.width, tier).toBeGreaterThan(0);
      expect(cfg.height, tier).toBeGreaterThan(0);
      expect(cfg.targetHz, tier).toBeGreaterThan(5);
      expect(cfg.targetHz, tier).toBeLessThanOrEqual(30);
      expect(cfg.slowFactor, tier).toBeGreaterThanOrEqual(1);
      expect(cfg.model, tier).toBe('lite');
    }
  });
});

describe('diagnoseGpuFailure', () => {
  it('turns a thrown error into something a person can act on', () => {
    expect(diagnoseGpuFailure(new Error('boom'), probe({ offscreenCanvas: false }))).toContain(
      'OffscreenCanvas',
    );
    expect(diagnoseGpuFailure(new Error('boom'), probe({ webgl2: false, note: 'WebGL2 off' }))).toBe(
      'WebGL2 off',
    );
    expect(
      diagnoseGpuFailure(new Error('boom'), probe({ software: true, renderer: 'SwiftShader' })),
    ).toContain('hardware acceleration is off');
    expect(
      diagnoseGpuFailure(new Error('emscripten_webgl_create_context() returned error 0'), probe()),
    ).toContain('close other tabs');
    expect(diagnoseGpuFailure(new Error('something else'), probe())).toBe('something else');
    expect(diagnoseGpuFailure(undefined, probe())).toBeTruthy();
  });
});
