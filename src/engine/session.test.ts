import { describe, expect, it } from 'vitest';
import {
  cameraErrorKind, cameraShouldRun, isGuestPhase, isRoundActive, needsPose,
  showsSkeleton, type Phase,
} from './session';

const ALL_PHASES: Phase[] = [
  'boot', 'setup', 'setupHelp', 'attract', 'roulette', 'countdown',
  'play', 'paused', 'results',
];

describe('camera lifecycle', () => {
  it('holds the camera off until the operator has finished setup', () => {
    // A kiosk runs its camera all day by necessity — it has to notice a guest
    // arriving. What is still asserted here is that nothing opens the camera
    // BEFORE setup has succeeded, which is where the permission and the
    // capability probe live.
    for (const p of ['boot', 'setupHelp'] as Phase[]) {
      expect(cameraShouldRun(p, 'camera'), p).toBe(false);
    }
  });

  it('never runs the camera in keyboard mode, in any phase', () => {
    for (const p of ALL_PHASES) {
      expect(cameraShouldRun(p, 'keyboard'), p).toBe(false);
    }
  });

  it('keeps the camera on across the whole guest loop', () => {
    // Dropping the track between rounds would mean the booth could not see
    // the next guest walk up, and re-acquiring takes long enough to be felt.
    for (const p of ALL_PHASES.filter(isGuestPhase)) {
      expect(cameraShouldRun(p, 'camera'), p).toBe(true);
    }
  });

  it('only consumes pose frames where a body is actually being read', () => {
    expect(needsPose('play')).toBe(true);
    // Presence detection and background auto-calibration both run here, which
    // is what removes the calibration screen from a stranger's path.
    expect(needsPose('attract')).toBe(true);
    expect(needsPose('boot')).toBe(false);
    expect(needsPose('results')).toBe(false);
  });

  it('shows the skeleton on the attract screen', () => {
    // Deliberate, and now doing double duty: it is the hook that makes a
    // passer-by stop, and the honest demonstration that the camera extracts
    // joints rather than a face.
    expect(showsSkeleton('attract')).toBe(true);
  });

  it('never shows a skeleton in a phase with no pose', () => {
    for (const p of ALL_PHASES) {
      if (showsSkeleton(p)) expect(needsPose(p), p).toBe(true);
    }
  });

  it('treats a paused round as still active, so it is resumable', () => {
    expect(isRoundActive('paused')).toBe(true);
    expect(isRoundActive('play')).toBe(true);
    expect(isRoundActive('attract')).toBe(false);
  });

  it('keeps setup out of the guest-visible flow', () => {
    // The whole point of the kiosk restructure: a walk-up stranger must never
    // land on a permission, warmup or calibration screen.
    for (const p of ['boot', 'setup', 'setupHelp'] as Phase[]) {
      expect(isGuestPhase(p), p).toBe(false);
    }
    for (const p of ['attract', 'roulette', 'play', 'results'] as Phase[]) {
      expect(isGuestPhase(p), p).toBe(true);
    }
  });
});

describe('cameraErrorKind', () => {
  it('distinguishes the failures that need different instructions', () => {
    expect(cameraErrorKind({ name: 'NotAllowedError' })).toBe('denied');
    expect(cameraErrorKind({ name: 'NotFoundError' })).toBe('notFound');
    expect(cameraErrorKind({ name: 'NotReadableError' })).toBe('inUse');
    // getUserMedia missing entirely means an insecure context — telling this
    // user to "press 허용" would be useless advice.
    expect(cameraErrorKind({ name: 'TypeError' })).toBe('insecure');
    // The camera opened but the pose engine did not: a separate failure with a
    // separate fix, and the one actually seen on this machine.
    expect(cameraErrorKind({ name: 'EngineStartError' })).toBe('engine');
  });

  it('never throws on junk', () => {
    for (const junk of [null, undefined, 0, '', {}, [], new Error('x')]) {
      expect(() => cameraErrorKind(junk)).not.toThrow();
    }
    expect(cameraErrorKind(null)).toBe('unknown');
  });
});
