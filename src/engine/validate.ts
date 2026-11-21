// Dev/test-only manifest validation. Tree-shaken out of production.
//
// This is the guard that keeps 58 independently-authored manifests coherent.
// The star-cut bands are the important part: without them every author awards
// three stars for showing up, and the whole reward system stops meaning
// anything.
import { z } from 'zod';
import type { MiniGameManifest } from './types';

const GESTURES = [
  'jump', 'squat', 'clap', 'swing', 'raise', 'lean', 'step', 'reach',
  'limbAngle', 'zone', 'holdPose', 'rep', 'stillness', 'balance',
  'stroke', 'poseMatch', 'jointTargets',
] as const;

const GROUPS = ['head', 'arms', 'hands', 'torso', 'legs', 'feet', 'fullBody'] as const;

export const ManifestSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'id must be kebab-case'),
    nameKo: z.string().min(1).max(20),
    taglineKo: z.string().min(1).max(24),
    howToKo: z.array(z.string().min(1).max(40)).min(1).max(3),
    icon: z.string().min(1).max(8),
    theme: z.object({ hue: z.number().min(0).max(360) }).optional(),

    difficulty: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    intensity: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    space: z.enum(['seated', 'standing', 'room']),
    players: z.object({
      min: z.number().int().min(1).max(4),
      max: z.number().int().min(1).max(4),
      mode: z.enum(['solo', 'coop', 'versus', 'hotseat']),
    }),

    requiredLandmarks: z.array(z.enum(GROUPS)).min(1),
    gestures: z.array(z.enum(GESTURES)).min(1),

    durationMs: z.number().int().min(20_000).max(90_000),
    scoring: z.object({
      kind: z.enum(['count', 'time', 'accuracy', 'survival']),
      maxScore: z.number().positive(),
      starCuts: z.tuple([z.number(), z.number(), z.number()]),
    }),

    a11y: z.object({
      keyboardFallback: z.boolean(),
      noFlashing: z.boolean(),
      colorBlindSafe: z.boolean(),
      audioOptional: z.boolean(),
    }),
    tags: z.array(z.string().min(1)).min(1).max(6),
    version: z.number().int().positive(),
    author: z.string().optional(),
    enabled: z.boolean().optional(),
    dev: z.object({ clip: z.string().optional(), notes: z.string().optional() }).optional(),
  })
  .superRefine((m, ctx) => {
    if (m.players.max < m.players.min) {
      ctx.addIssue({ code: 'custom', message: 'players.max < players.min' });
    }
    const [a, b, c] = m.scoring.starCuts;
    if (!(a < b && b < c)) {
      ctx.addIssue({ code: 'custom', message: `starCuts must ascend: ${a},${b},${c}` });
    }
    // Sanity bands. Outside these, stars stop discriminating.
    if (a < 0.15 || a > 0.42) {
      ctx.addIssue({ code: 'custom', message: `starCuts[0]=${a} outside [0.15,0.42] — 1 star should mean "you played"` });
    }
    if (b < 0.42 || b > 0.72) {
      ctx.addIssue({ code: 'custom', message: `starCuts[1]=${b} outside [0.42,0.72]` });
    }
    if (c < 0.7 || c > 0.95) {
      ctx.addIssue({ code: 'custom', message: `starCuts[2]=${c} outside [0.70,0.95] — 3 stars must be reachable` });
    }
    // Legs/feet games are hidden when the lower body is not visible, so they
    // must not also claim to be seated-playable.
    const lower = m.requiredLandmarks.some((g) => g === 'legs' || g === 'feet');
    if (lower && m.space === 'seated') {
      ctx.addIssue({ code: 'custom', message: 'space:seated cannot require legs/feet' });
    }
    if (m.intensity >= 2 && m.space === 'seated') {
      ctx.addIssue({ code: 'custom', message: 'space:seated implies intensity 1' });
    }
    if (m.players.max > 1 && m.players.mode === 'solo') {
      ctx.addIssue({ code: 'custom', message: 'players.max > 1 but mode is solo' });
    }
  });

export function validateManifest(m: MiniGameManifest, where = m?.id ?? '?'): void {
  const r = ManifestSchema.safeParse(m);
  if (!r.success) {
    const lines = r.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`[manifest] ${where} is invalid:\n${lines.join('\n')}`);
  }
}
