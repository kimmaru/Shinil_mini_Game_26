import { describe, expect, it } from 'vitest';
import {
  cameraErrorKind, cameraShouldRun, isRoundActive, needsPose, showsSkeleton, type Phase,
} from './session';

const ALL_PHASES: Phase[] = [
  'boot', 'priming', 'prePrompt', 'cameraRequest', 'cameraHelp', 'warmup',
  'calibration', 'safety', 'attract', 'roulette', 'intro', 'countdown',
  'play', 'paused', 'results', 'breakPrompt', 'partySummary',
];

describe('camera lifecycle', () => {
  it('releases the camera in every phase that is not using it', () => {
    // This is the property the privacy copy rests on, so it is asserted
    // directly rather than left to code review.
    const mustBeOff: Phase[] = [
      'boot', 'priming', 'prePrompt', 'cameraRequest', 'cameraHelp', 'safety',
      'paused', 'breakPrompt', 'partySummary',
    ];
    for (const p of mustBeOff) {
      expect(cameraShouldRun(p, 'camera'), p).toBe(false);
    }
  });

  it('never runs the camera in keyboard mode, in any phase', () => {
    for (const p of ALL_PHASES) {
      expect(cameraShouldRun(p, 'keyboard'), p).toBe(false);
    }
  });

  it('runs the camera while a round is in flight', () => {
    for (const p of ['warmup', 'calibration', 'attract', 'play'] as Phase[]) {
      expect(cameraShouldRun(p, 'camera'), p).toBe(true);
    }
  });

  it('only consumes pose frames where a body is actually being read', () => {
    expect(needsPose('play')).toBe(true);
    expect(needsPose('attract')).toBe(true);
    expect(needsPose('priming')).toBe(false);
    expect(needsPose('partySummary')).toBe(false);
  });

  it('shows the skeleton on the attract screen', () => {
    // Deliberate: it is the honest demonstration of what the camera extracts,
    // for the parent standing behind the child.
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
});

describe('cameraErrorKind', () => {
  it('distinguishes the failures that need different instructions', () => {
    expect(cameraErrorKind({ name: 'NotAllowedError' })).toBe('denied');
    expect(cameraErrorKind({ name: 'NotFoundError' })).toBe('notFound');
    expect(cameraErrorKind({ name: 'NotReadableError' })).toBe('inUse');
    // getUserMedia missing entirely means an insecure context — telling this
    // user to "press 허용" would be useless advice.
    expect(cameraErrorKind({ name: 'TypeError' })).toBe('insecure');
  });

  it('never throws on junk', () => {
    for (const junk of [null, undefined, 0, '', {}, [], new Error('x')]) {
      expect(() => cameraErrorKind(junk)).not.toThrow();
    }
    expect(cameraErrorKind(null)).toBe('unknown');
  });
});
