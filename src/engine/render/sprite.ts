// ══ FROZEN CONTRACT ══ imported by 58 game modules.
//
// Vector sprites, defined as SVG path strings and drawn through Path2D.
//
// WHY NOT EMOJI (the thing this replaces):
// an emoji renders as Apple Color Emoji on macOS, Segoe UI Emoji on Windows
// and Noto Color Emoji on Android. The same game is three different-looking
// products, we cannot control a single colour, and nothing can be made to
// match anything else. Unity of style is impossible by construction.
//
// Path strings are code, so this keeps the property that matters: there is
// still not one image file in the repo, parallel authors still have a merge
// surface of zero, and the page still makes no third-party request.
//
// Every sprite is authored in a 100x100 box. The renderer scales it, so a
// sprite is resolution-independent and an outline thickness written as `4`
// stays 4% of the sprite's size at every scale.
import type { Paint } from './renderer';

/** Where a layer's colour comes from, resolved at draw time.
 *
 *  Roles rather than literal colours are what let one sprite serve 58 games:
 *  the same star is gold in one game and the game's own hue in another, and
 *  neither game had to redefine the star. */
export type PaintRole =
  /** The game's own hue, from `manifest.theme.hue`. */
  | 'theme'
  /** A lighter tint of the theme hue, for highlights. */
  | 'themeLight'
  /** A darker shade of the theme hue, for shadow sides. */
  | 'themeDark'
  /** The near-black ink, for detail lines INSIDE a filled shape. Never for an
   *  outline against the canvas: measured 1.08:1 there, i.e. invisible. */
  | 'ink'
  /** The house outline: white on the dark game canvas, where near-black is
   *  invisible. Use this for every silhouette edge. */
  | 'keyline'
  | 'white'
  | 'accent'
  | 'success'
  | 'warn'
  | 'danger'
  /** Whatever the caller passed as `tint`. */
  | 'tint';

export interface SpriteLayer {
  /** SVG path data in the 100x100 author box. Only M/L/C/Q/A/Z are used;
   *  Path2D accepts the full SVG grammar. */
  d: string;
  fill?: PaintRole | string;
  stroke?: PaintRole | string;
  /** Stroke width in author units, so it scales with the sprite. */
  sw?: number;
}

export interface Sprite {
  layers: SpriteLayer[];
}

export interface SpriteOpts {
  /** Radians, about the sprite's centre. */
  rot?: number;
  /** Resolves the `tint` role, and `theme*` when no hue is given. */
  tint?: string;
  /** 0-360. Resolves the `theme*` roles. Defaults to the game's manifest hue. */
  hue?: number;
  /** Multiplies the whole sprite. Negative x mirrors it. */
  scaleX?: number;
  scaleY?: number;
  /** Outer glow radius in device px. */
  glow?: number;
  /** Overrides every layer's fill. For silhouettes and shadows. */
  flatten?: string;
  alpha?: number;
}

/**
 * Path2D instances are expensive to build and free to reuse, so every path
 * string is parsed exactly once for the life of the page.
 *
 * Keyed by the path string itself: two sprites that share a shape share the
 * compiled path for free.
 */
const pathCache = new Map<string, Path2D>();

export function compiledPath(d: string): Path2D {
  let p = pathCache.get(d);
  if (!p) {
    p = new Path2D(d);
    pathCache.set(d, p);
  }
  return p;
}

/** Dev-only: how many distinct paths have been compiled. */
export const compiledPathCount = (): number => pathCache.size;

// ─── Author helpers ──────────────────────────────────────────────────────────
//
// Hand-writing SVG path data is error-prone and unreadable in a diff. These
// build the shapes that actually recur, in the 100x100 author box.

/** Circle centred at (cx, cy). */
export const circlePath = (cx: number, cy: number, r: number): string =>
  `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${r * 2} 0a${r} ${r} 0 1 0 ${-r * 2} 0Z`;

/** Rounded rectangle from its top-left corner. */
export function roundRectPath(x: number, y: number, w: number, h: number, r: number): string {
  const k = Math.min(r, w / 2, h / 2);
  return (
    `M${x + k} ${y}h${w - k * 2}a${k} ${k} 0 0 1 ${k} ${k}` +
    `v${h - k * 2}a${k} ${k} 0 0 1 ${-k} ${k}` +
    `h${-(w - k * 2)}a${k} ${k} 0 0 1 ${-k} ${-k}` +
    `v${-(h - k * 2)}a${k} ${k} 0 0 1 ${k} ${-k}Z`
  );
}

/** Regular polygon. `rot` in radians; 0 points right. */
export function polyPath(cx: number, cy: number, r: number, sides: number, rot = -Math.PI / 2): string {
  let d = '';
  for (let i = 0; i < sides; i++) {
    const a = rot + (i / sides) * Math.PI * 2;
    d += `${i === 0 ? 'M' : 'L'}${(cx + Math.cos(a) * r).toFixed(2)} ${(cy + Math.sin(a) * r).toFixed(2)}`;
  }
  return `${d}Z`;
}

/** Star with `points` spikes. `inner` is the inner radius as a fraction of r. */
export function starPath(
  cx: number, cy: number, r: number, points = 5, inner = 0.42, rot = -Math.PI / 2,
): string {
  let d = '';
  for (let i = 0; i < points * 2; i++) {
    const rad = i % 2 === 0 ? r : r * inner;
    const a = rot + (i / (points * 2)) * Math.PI * 2;
    d += `${i === 0 ? 'M' : 'L'}${(cx + Math.cos(a) * rad).toFixed(2)} ${(cy + Math.sin(a) * rad).toFixed(2)}`;
  }
  return `${d}Z`;
}

/** Open polyline through the given points: `[x0,y0, x1,y1, ...]`. */
export function linePath(pts: readonly number[]): string {
  let d = '';
  for (let i = 0; i + 1 < pts.length; i += 2) {
    d += `${i === 0 ? 'M' : 'L'}${pts[i]} ${pts[i + 1]}`;
  }
  return d;
}

/** The registry a game draws from. Filled in by `sprites/index.ts`. */
export type SpriteId = string;

const registry = new Map<SpriteId, Sprite>();

export function defineSprites(defs: Record<SpriteId, Sprite>): void {
  for (const [id, sp] of Object.entries(defs)) {
    if (registry.has(id)) throw new Error(`[sprite] duplicate id "${id}"`);
    registry.set(id, sp);
  }
}

export const getSprite = (id: SpriteId): Sprite | undefined => registry.get(id);
export const spriteIds = (): SpriteId[] => [...registry.keys()].sort();
export const hasSprite = (id: SpriteId): boolean => registry.has(id);

/**
 * Resolve a layer's palette role to a concrete colour.
 *
 * Shared by the canvas renderer and the DOM icon component, so a sprite is
 * the SAME artwork in a lobby card and in the game — which is the entire
 * point of having one definition.
 */
export function resolveRole(
  r: PaintRole | string | undefined,
  o?: { hue?: number; tint?: string },
): string | undefined {
  if (r === undefined) return undefined;
  const h = o?.hue ?? 210;
  switch (r) {
    case 'theme': return `hsl(${h} 78% ${roleL(h)}%)`;
    case 'themeLight': return `hsl(${h} 85% ${Math.min(92, roleL(h) + 14)}%)`;
    case 'themeDark': return `hsl(${h} 72% ${roleL(h) - 14}%)`;
    case 'keyline': return '#171A2B';
    case 'ink': return '#0B0F20';
    case 'white': return '#FFFFFF';
    case 'accent': return '#FFB300';
    case 'success': return '#16C47F';
    case 'warn': return '#FF9F1C';
    case 'danger': return '#FF4D4D';
    case 'tint': return o?.tint ?? `hsl(${h} 78% ${roleL(h)}%)`;
    default: return r;
  }
}

/** Mirrors `palette.baseL`: HSL lightness is not perceptual, so the
 *  yellow-green band must come down to stay visible on a light ground. */
const roleL = (h: number): number => {
  const n = ((h % 360) + 360) % 360;
  if (n >= 40 && n <= 95) return 38;
  if (n > 95 && n <= 190) return 42;
  return 50;
};

/**
 * Render a sprite as a standalone SVG string, for the DOM shell.
 *
 * The lobby card, the roulette slice and the intro screen all show a game's
 * icon. Drawing those with a different system than the game itself uses is
 * how a product starts looking like two products.
 *
 * `on: 'light'` swaps the white keyline for a same-hue dark one, because the
 * lobby card is a white panel and white-on-white is invisible.
 */
export function spriteToSvg(
  id: SpriteId,
  o: { hue?: number; tint?: string; size?: number; on?: 'dark' | 'light' } = {},
): string {
  const sp = registry.get(id);
  if (!sp) return '';
  // The canvas is light, so ink is the default keyline. `on: 'dark'` is for
  // the few surfaces that are still dark — the debug overlay, for instance.
  const keyline = o.on === 'dark' ? 'rgb(255 255 255 / 0.92)' : '#171A2B';
  const paints = o.on === 'light' ? { ...o, keyline } : o;
  const body = sp.layers.map((l) => {
    const fill = resolveRole(l.fill, paints) ?? 'none';
    const stroke = l.stroke === 'keyline'
      ? keyline
      : resolveRole(l.stroke, paints);
    const strokeAttr = stroke
      ? ` stroke="${stroke}" stroke-width="${l.sw ?? 4}" stroke-linejoin="round" stroke-linecap="round"`
      : '';
    return `<path d="${l.d}" fill="${fill}"${strokeAttr}/>`;
  }).join('');
  const size = o.size ?? 100;
  return (
    `<svg viewBox="0 0 100 100" width="${size}" height="${size}" ` +
    `xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">${body}</svg>`
  );
}

/** Dev-only guard so a typo surfaces as a loud error rather than a blank
 *  patch of screen nobody notices until a child is playing. */
export function requireSprite(id: SpriteId): Sprite {
  const sp = registry.get(id);
  if (!sp) {
    throw new Error(
      `[sprite] unknown id "${id}". Known ids: ${spriteIds().join(', ')}`,
    );
  }
  return sp;
}

export type { Paint };
