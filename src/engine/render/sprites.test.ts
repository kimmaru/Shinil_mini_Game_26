// Every sprite must obey ART.md, checked mechanically.
//
// Fifty-odd icons drawn by several authors is exactly the situation where a
// style guide quietly stops being followed. These are the rules a machine can
// check; the rest is the review checklist in ART.md §7.
import { describe, expect, it } from 'vitest';
import { getSprite, spriteIds, spriteToSvg } from './sprite';
import './sprites';
import './sprites-ui';
import './sprites-games';

const ALL = spriteIds();

/** Author box is 100x100; live area is 84x84 with an optical overshoot to 92. */
const MIN_COORD = -2;
const MAX_COORD = 102;

/**
 * Walk an SVG path and return every point it actually reaches.
 *
 * Not a regex over the numbers: relative commands carry DELTAS, so `h-13`
 * contains a -13 that is not a coordinate at all. Tracking the pen position
 * is the only way to know where a path really goes.
 *
 * Control points are included — a curve bulges toward them, so a control
 * point far outside the box means the drawn shape leaves it too.
 */
function coords(d: string): number[] {
  const out: number[] = [];
  const tokens = d.match(/[MmLlHhVvCcSsQqTtAaZz]|-?\d*\.?\d+(?:e-?\d+)?/g) ?? [];
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  let cmd = '';
  let i = 0;
  const num = (): number => Number(tokens[i++]);
  const push = (px: number, py: number): void => { out.push(px, py); };

  while (i < tokens.length) {
    const t = tokens[i]!;
    if (/[A-Za-z]/.test(t)) { cmd = t; i++; }
    const rel = cmd === cmd.toLowerCase();
    const base = (v: number, axis: 'x' | 'y'): number => (rel ? (axis === 'x' ? x : y) + v : v);

    switch (cmd.toUpperCase()) {
      case 'M': {
        x = base(num(), 'x'); y = base(num(), 'y');
        startX = x; startY = y; push(x, y);
        cmd = rel ? 'l' : 'L'; // subsequent pairs are implicit line-tos
        break;
      }
      case 'L': { x = base(num(), 'x'); y = base(num(), 'y'); push(x, y); break; }
      case 'H': { x = base(num(), 'x'); push(x, y); break; }
      case 'V': { y = base(num(), 'y'); push(x, y); break; }
      case 'C': {
        const c1x = base(num(), 'x'), c1y = base(num(), 'y');
        const c2x = base(num(), 'x'), c2y = base(num(), 'y');
        x = base(num(), 'x'); y = base(num(), 'y');
        push(c1x, c1y); push(c2x, c2y); push(x, y);
        break;
      }
      case 'S': case 'Q': {
        const cx = base(num(), 'x'), cy = base(num(), 'y');
        x = base(num(), 'x'); y = base(num(), 'y');
        push(cx, cy); push(x, y);
        break;
      }
      case 'T': { x = base(num(), 'x'); y = base(num(), 'y'); push(x, y); break; }
      case 'A': {
        num(); num(); num(); num(); num(); // rx ry rot large-arc sweep
        x = base(num(), 'x'); y = base(num(), 'y');
        push(x, y);
        break;
      }
      case 'Z': { x = startX; y = startY; break; }
      default: i++; break;
    }
  }
  return out;
}

describe('the sprite set', () => {
  it('is not empty', () => {
    expect(ALL.length).toBeGreaterThan(20);
  });

  it.each(ALL)('%s has at least one layer', (id) => {
    expect(getSprite(id)!.layers.length).toBeGreaterThan(0);
  });

  it.each(ALL)('%s stays inside the author box', (id) => {
    // A path that strays outside 0-100 gets clipped when the sprite rotates,
    // which shows up as a corner mysteriously disappearing mid-game.
    for (const l of getSprite(id)!.layers) {
      for (const n of coords(l.d)) {
        expect(n, `${id}: coordinate ${n}`).toBeGreaterThanOrEqual(MIN_COORD);
        expect(n, `${id}: coordinate ${n}`).toBeLessThanOrEqual(MAX_COORD);
      }
    }
  });

  it.each(ALL)('%s respects the layer budget', (id) => {
    // ART.md §2.4: 3 for an ordinary object, 5 for a character, 6 absolute.
    // Past this an icon stops reading at 40px from 2m away.
    expect(getSprite(id)!.layers.length).toBeLessThanOrEqual(6);
  });

  it.each(ALL)('%s keeps each path short enough to stay legible', (id) => {
    for (const l of getSprite(id)!.layers) {
      expect(l.d.length, `${id}: path of ${l.d.length} chars`).toBeLessThanOrEqual(420);
    }
  });

  it.each(ALL)('%s uses palette roles, not literal colours', (id) => {
    // A literal hex cannot be recoloured per game, which defeats the point of
    // one sprite set serving 58 games. A handful of material colours (wood,
    // stone) are legitimately fixed and are listed explicitly.
    const ALLOWED_LITERALS = new Set(['#6B7390', '#C98B4B', '#4A5570', '#8A6A4A', '#5A6276']);
    for (const l of getSprite(id)!.layers) {
      for (const c of [l.fill, l.stroke]) {
        if (typeof c === 'string' && c.startsWith('#')) {
          expect(ALLOWED_LITERALS.has(c), `${id}: literal ${c} is not an allowed material colour`).toBe(true);
        }
      }
    }
  });

  it.each(ALL)('%s uses the house outline weight', (id) => {
    // 4% of the sprite, 5 for a hero object, 3 for an inner detail line.
    // A glyph made ONLY of strokes (a tick, an X, a ring) has no silhouette to
    // outline — the stroke IS the shape — so it legitimately runs heavier.
    const layers = getSprite(id)!.layers;
    const strokeOnly = layers.every((l) => !l.fill);
    const max = strokeOnly ? 14 : 8;
    for (const l of layers) {
      if (l.sw === undefined) continue;
      expect(l.sw, `${id}: sw ${l.sw}`).toBeGreaterThanOrEqual(2);
      expect(l.sw, `${id}: sw ${l.sw}`).toBeLessThanOrEqual(max);
    }
  });

  it.each(ALL)('%s does not draw its first layer in invisible ink', (id) => {
    // Near-black is 1.08:1 on the game canvas. `ink` is fine for a detail line
    // drawn ON TOP of a filled shape — it has a fill behind it — but the FIRST
    // layer has only the canvas behind it, so an ink stroke there is invisible.
    const first = getSprite(id)!.layers[0]!;
    if (!first.fill && first.stroke === 'ink') {
      expect.fail(
        `${id}: the base layer is stroked in 'ink' with nothing behind it — use 'keyline'`,
      );
    }
  });

  it.each(ALL)('%s renders to valid-looking SVG', (id) => {
    const svg = spriteToSvg(id, { hue: 210 });
    expect(svg).toMatch(/^<svg /);
    expect(svg).toContain('</svg>');
    expect(svg).toContain('<path');
    // Unresolved roles would appear verbatim as a colour and render nothing.
    for (const role of ['theme', 'keyline', 'accent', 'tint', 'themeDark', 'themeLight']) {
      expect(svg, `${id}: role "${role}" leaked into the output`).not.toContain(`"${role}"`);
    }
    expect(svg).not.toContain('undefined');
    expect(svg).not.toContain('NaN');
  });

  it('has no genuinely duplicated sprites', () => {
    // Two ids that are identical in BOTH geometry and paint mean someone drew
    // the same thing twice. Sharing geometry with different paint is the
    // opposite — it is the reuse the system is designed for (a filled star and
    // an empty star are one shape, two treatments).
    const seen = new Map<string, string>();
    for (const id of ALL) {
      const key = getSprite(id)!.layers
        .map((l) => `${l.d}|${String(l.fill)}|${String(l.stroke)}|${String(l.sw)}`)
        .join('||');
      const prev = seen.get(key);
      expect(prev, `${id} is identical to ${prev} in both shape and paint`).toBeUndefined();
      seen.set(key, id);
    }
  });
});
