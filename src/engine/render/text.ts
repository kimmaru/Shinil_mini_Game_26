// Font stacks and Korean-safe text metrics.
//
// Three Korean-specific rules live here, because getting them wrong is the
// difference between "a Korean game" and "an English game with Korean in it":
//
//  1. `word-break: keep-all` semantics. The CSS default breaks a line inside a
//     어절 (a whitespace-delimited Korean word), which reads as broken Korean to
//     a native speaker. `wrapText` only breaks at whitespace and at a short list
//     of punctuation, and falls back to per-character breaking (the
//     `overflow-wrap: anywhere` escape hatch) ONLY when a single token cannot
//     fit on a line at all.
//  2. `letter-spacing: -0.02em` at display sizes. Hangul at 56px+ with default
//     tracking looks loose and fussy.
//  3. Tabular figures. Canvas2D has no `font-variant-numeric`, so a score
//     counter re-measured every frame visibly jitters as digits change. The fix
//     is to lay digits out on a fixed grid — see `tabularWidth` / the digit-grid
//     draw in canvas2d.ts.
//
// This module is pure math + strings: no canvas, no DOM. It is fully testable
// under `environment: 'node'`.

/** Self-hosted Pretendard Variable (public/fonts/fonts.css) first, then the
 *  platform Korean UI faces. Pretendard is the only webfont we ship. */
export const UI_STACK =
  '"Pretendard Variable", Pretendard, -apple-system, BlinkMacSystemFont, system-ui, ' +
  '"Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", sans-serif';

/** The chunky display face for titles and big numbers.
 *  NOTE: GmarketSansBold is NOT shipped (no font files beyond Pretendard), so in
 *  practice this resolves to Pretendard at weight 800+. That is deliberate — the
 *  stack is here so dropping the woff2 into public/fonts/ is the only change
 *  needed to upgrade the display face later. */
export const DISPLAY_STACK =
  '"GmarketSansBold", "Pretendard Variable", Pretendard, system-ui, ' +
  '"Apple SD Gothic Neo", "Malgun Gothic", sans-serif';

/** All "art" in this project is emoji, so this stack is the art pipeline. */
export const EMOJI_STACK =
  '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", "Twemoji Mozilla", ' +
  '"EmojiOne Color", "Android Emoji", sans-serif';

/**
 * Hard floor on drawn text size, in logical px.
 *
 * AGENTS.md: a child reads this standing ~2m from a 13" laptop. 18px is already
 * below the documented 24px floor; anything smaller is decoration the player
 * cannot read, so the renderer silently raises it rather than drawing a line
 * nobody can see. A game that wants small text wants a different design.
 */
export const MIN_TEXT_PX = 18;

/** TextOpts.weight is documented as "never below 500". Enforced, not trusted. */
export const MIN_TEXT_WEIGHT = 500;
export const MAX_TEXT_WEIGHT = 900;

/** Display sizes get tightened tracking. Below this, leave Hangul alone. */
export const TRACKING_FROM_PX = 34;
export const TRACKING_EM = -0.02;

export const clampTextSize = (size: number): number =>
  Number.isFinite(size) ? Math.max(MIN_TEXT_PX, size) : MIN_TEXT_PX;

export const clampTextWeight = (w: number): number =>
  !Number.isFinite(w) ? 700
    : w < MIN_TEXT_WEIGHT ? MIN_TEXT_WEIGHT
    : w > MAX_TEXT_WEIGHT ? MAX_TEXT_WEIGHT
    : Math.round(w);

// ─── Font strings ────────────────────────────────────────────────────────────
//
// `ctx.font = ...` is a parsed CSS property: building the string with a template
// literal every draw call allocates, and 58 games draw a lot of text. Cache it.

const FONT_CACHE = new Map<number, string>();
const FONT_CACHE_MAX = 512;

/** A CSS `font` shorthand for the canvas. Cached: callable in the hot path. */
export function fontString(size: number, weight: number, display = false): string {
  const px = clampTextSize(size);
  const w = clampTextWeight(weight);
  // key: display flag | weight | size at quarter-px resolution
  const key = (display ? 1 : 0) * 0x8000000 + w * 0x4000 + Math.round(px * 4);
  let f = FONT_CACHE.get(key);
  if (f === undefined) {
    if (FONT_CACHE.size > FONT_CACHE_MAX) FONT_CACHE.clear();
    f = `${w} ${px}px ${display ? DISPLAY_STACK : UI_STACK}`;
    FONT_CACHE.set(key, f);
  }
  return f;
}

const EMOJI_FONT_CACHE = new Map<number, string>();

/** A CSS `font` shorthand for an emoji glyph at `size` logical px. Cached. */
export function emojiFontString(size: number): string {
  const px = Math.max(8, Math.round(size));
  let f = EMOJI_FONT_CACHE.get(px);
  if (f === undefined) {
    if (EMOJI_FONT_CACHE.size > 256) EMOJI_FONT_CACHE.clear();
    f = `${px}px ${EMOJI_STACK}`;
    EMOJI_FONT_CACHE.set(px, f);
  }
  return f;
}

/** Tracking in px for a given size. Negative = tighter. */
export const trackingPx = (size: number): number =>
  size >= TRACKING_FROM_PX ? size * TRACKING_EM : 0;

/** The minimal shape of a 2D context this module touches. Lets the wrapping and
 *  measurement logic be unit-tested without a canvas. */
export interface TextCtxLike {
  font: string;
  letterSpacing?: string;
  measureText(s: string): { width: number };
}

let lsSupport: boolean | null = null;

/** Apply `letter-spacing: -0.02em` at display sizes, when the browser supports
 *  `ctx.letterSpacing` (Chrome 99+, Safari 17.4+). Degrades to default tracking
 *  everywhere else — looser, never broken. Also affects `measureText`, which is
 *  exactly what we want. */
export function applyTracking(ctx: TextCtxLike, size: number): void {
  if (lsSupport === null) lsSupport = 'letterSpacing' in ctx;
  if (!lsSupport) return;
  ctx.letterSpacing = size >= TRACKING_FROM_PX ? `${TRACKING_EM}em` : '0px';
}

// ─── Hangul ──────────────────────────────────────────────────────────────────

/** True for Hangul syllables, jamo and compatibility jamo. */
export function isHangul(ch: string): boolean {
  const c = ch.codePointAt(0);
  if (c === undefined) return false;
  return (
    (c >= 0xac00 && c <= 0xd7a3) || // syllables
    (c >= 0x1100 && c <= 0x11ff) || // jamo
    (c >= 0x3130 && c <= 0x318f) || // compatibility jamo
    (c >= 0xa960 && c <= 0xa97f) ||
    (c >= 0xd7b0 && c <= 0xd7ff)
  );
}

/** CJK and Hangul can break between any two characters in principle, but
 *  `keep-all` says Korean must not. These are the characters we still allow a
 *  break *after*, because Korean typography does. */
const BREAK_AFTER = new Set([
  '/', '·', '、', ',', '，', ')', ']', '}', '」', '』', '>', '》',
  '-', '–', '—', ':', ';', '?', '!', '…', '~',
]);
/** ...and *before*. */
const BREAK_BEFORE = new Set(['(', '[', '{', '「', '『', '<', '《']);

const isSpace = (ch: string): boolean => ch === ' ' || ch === '\t' || ch === ' ';

/**
 * Split `s` into tokens, each ending at a legal break opportunity.
 *
 * A Korean 어절 ("모기를") comes out as ONE token, so the greedy filler below can
 * never split it. Writes into `out` and returns it (reusable, no allocation
 * beyond the slices).
 */
export function tokenize(s: string, out: string[] = []): string[] {
  out.length = 0;
  if (!s) return out;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    let cut = false;
    if (isSpace(ch)) {
      while (i + 1 < s.length && isSpace(s[i + 1]!)) i++;
      cut = true;
    } else if (BREAK_AFTER.has(ch)) {
      const next = s[i + 1];
      if (next !== undefined && !isSpace(next)) cut = true;
    } else {
      const next = s[i + 1];
      if (next !== undefined && BREAK_BEFORE.has(next)) cut = true;
    }
    if (cut) {
      out.push(s.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < s.length) out.push(s.slice(start));
  return out;
}

/** Characters that must not start a line (Korean/Japanese 금칙 처리, trimmed to
 *  the few that actually show up in game copy). */
const NO_LINE_START = new Set(['.', ',', '!', '?', ')', ']', '}', '」', '』', '…', '%']);

function hardBreak(
  token: string,
  maxWidth: number,
  measure: (s: string) => number,
  out: string[],
): string {
  // `overflow-wrap: anywhere` — only reached when a single token cannot fit on a
  // line by itself, e.g. a 30-character ID or a number with no spaces.
  let line = '';
  for (const ch of token) {
    const cand = line + ch;
    if (line !== '' && measure(cand) > maxWidth) {
      out.push(line);
      line = ch;
    } else {
      line = cand;
    }
  }
  return line;
}

/**
 * Greedy line wrap with Korean `keep-all` semantics.
 *
 * ALLOCATES (slices + the out array): call it when the string or the width
 * changes, never every frame. The renderer's `text()` draws a single line and
 * does not wrap, so the hot path is unaffected.
 *
 * `measure` must measure in the same font the text will be drawn in.
 */
export function wrapText(
  text: string,
  maxWidth: number,
  measure: (s: string) => number,
  out: string[] = [],
): string[] {
  out.length = 0;
  if (!text) {
    out.push('');
    return out;
  }
  if (!(maxWidth > 0) || !Number.isFinite(maxWidth)) {
    out.push(text);
    return out;
  }
  const paras = text.split('\n');
  const toks: string[] = [];
  for (let pi = 0; pi < paras.length; pi++) {
    const para = paras[pi]!;
    if (para === '') {
      out.push('');
      continue;
    }
    tokenize(para, toks);
    let line = '';
    for (let i = 0; i < toks.length; i++) {
      let tk = toks[i]!;
      if (line === '') tk = tk.replace(/^[ \t ]+/, '');
      if (tk === '') continue;
      const cand = line + tk;
      if (line !== '' && measure(trimEnd(cand)) > maxWidth) {
        // Avoid orphaning a closing punctuation mark onto the next line.
        const first = tk[0]!;
        if (NO_LINE_START.has(first) && line.length > 1) {
          out.push(trimEnd(line + first));
          line = tk.slice(1);
        } else {
          out.push(trimEnd(line));
          line = tk;
        }
      } else {
        line = cand;
      }
      // The token alone is wider than the line: character-break it.
      if (measure(trimEnd(line)) > maxWidth && countTokens(line) <= 1) {
        line = hardBreak(trimEnd(line), maxWidth, measure, out);
      }
    }
    out.push(trimEnd(line));
  }
  return out;
}

const trimEnd = (s: string): string => s.replace(/[ \t ]+$/, '');
const countTokens = (s: string): number => {
  const t = trimEnd(s);
  if (t === '') return 0;
  let n = 1;
  for (let i = 0; i < t.length; i++) if (isSpace(t[i]!)) n++;
  return n;
};

// ─── Tabular figures ─────────────────────────────────────────────────────────

export const DIGITS: readonly string[] = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

export const isDigit = (ch: string): boolean => ch >= '0' && ch <= '9';

/**
 * Width of `s` laid out on a tabular digit grid: every digit occupies
 * `digitW`, everything else its natural advance.
 *
 * This is what stops "9" → "10" → "9" making a score counter twitch sideways
 * three times a second. Canvas2D cannot express `font-variant-numeric:
 * tabular-nums`, so we do the layout ourselves.
 */
export function tabularWidth(
  s: string,
  digitW: number,
  measureChar: (ch: string) => number,
): number {
  let w = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    w += isDigit(ch) ? digitW : measureChar(ch);
  }
  return w;
}
