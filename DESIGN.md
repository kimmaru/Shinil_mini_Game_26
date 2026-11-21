# DESIGN.md — 몸으로 놀자! 미니게임 파티

The design system for a Korean webcam motion mini-game party site for
elementary schoolers (7–12), read standing ~2 m from the screen, with a parent
watching over their shoulder.

**Source of truth is `src/styles/tokens.css`.** This document explains the
values and the rules; the CSS holds them. If the two disagree, the CSS is right
and this file is stale — fix it.

Canvas-side mirror: `src/engine/render/palette.ts`. Change a colour that lives
in both and the DOM and the canvas drift apart, which is how a site with 58
authors starts looking like 58 sites.

---

## 1. The direction in one sentence

**A casual party game (미니게임천국, Mario Party — all art our own): a saturated
gradient backdrop with one drifting pattern, white display type with a thick
ink outline and a drop shadow, chunky ink-edged slabs you can press, overshoot
springs on everything that arrives, and celebrate everything.**
(docs/GAME-DESIGN-PLAN.md §3 is the brief.)

One colour — the **ink** `--c-ink #1D1442` — draws every outline, slab edge,
text stroke and drop shadow. That single shared line is what makes a dozen
saturated hues read as one product instead of a flea market.

Each game gets exactly one hue (`manifest.theme.hue`) that tints its roulette
tile, its countdown title and its results card. That is how 58 games feel
distinct without 58 palettes, and it is the only colour decision a game author
makes.

### What we stole, and from whom

| Source | What we took |
|---|---|
| **Mario Party** | The board: upright tiles in a ring, a highlight that hops tile to tile and decelerates, the winner popping and flying to the centre. Results stars on an arc, middle one raised. |
| **미니게임천국 / WarioWare** | One command word per game, shouted ("짝!", "점프!"), white-with-black-outline lettering over a loud backdrop. |
| **Duolingo** | Chunky display weights; a solid bottom edge on every interactive element so it reads as a 3D slab waiting to be pressed. |
| **Kahoot** | Colour paired with **shape**: ▲ ◆ ● ■ plus a slot number. Colour-blind players get the same information. |
| **Nintendo Switch home** | Enormous focus states; a distinct sound for every navigation event; every state change animated, never cut. |

---

## 2. Colour

### Party (DOM chrome only — no canvas twin)

| Token | Value | Use |
|---|---|---|
| `--c-ink` | `#1D1442` | every outline, slab edge, text stroke, drop shadow; body text |
| `--c-sun` `--c-tangerine` `--c-bubblegum` | `#FFD23F` `#FF8A3D` `#FF5C9A` | the attract backdrop; `.btn--go` |
| `--c-sky` `--c-grape` `--c-mint` | `#35C6FF` `#7B5CFF` `#2FD8A5` | roulette/countdown backdrops, logo ribbon, timer ring, "시작!" |
| `--c-gold` | `#FFC21A` | the roulette highlight frame, the record banner |
| `--bg-1/2/3` | per phase | the 3-stop backdrop gradient, set on `.app[data-phase]` |
| `--bg-pattern` | `rgb(255 255 255 / .18)` | the drifting dots (stripes on the roulette) |

Backdrops by phase: attract sun → tangerine → bubblegum; roulette sky → blue →
grape with diagonal stripes; countdown mint → sky → blue; results yellow →
orange → pink; setup/help blue → violet. `play` has no backdrop (the game
canvas owns the screen). There is **no white screen anywhere**: running text
that has to sit on a backdrop sits on a white slab (`.card`, `.panel`,
`.slab-note`, `.screen__lead`).

### Brand / semantic (hue-stable; mirrored in render/palette.ts)

| Token | Light | Use |
|---|---|---|
| `--c-primary-500` | `#4C6FFF` | the primary action, progress, focus-adjacent fills |
| `--c-primary-600` | `#2F4FE0` | primary **text** on light surfaces, and the pressed edge |
| `--c-secondary-500` | `#A259FF` | special rounds, boss games |
| `--c-accent-500` | `#FFB300` | **stars and rewards only**, under 5 % of pixels |
| `--c-accent2-500` | `#FF4D8D` | combos, "지금!" cues |
| `--c-success-500` | `#16C47F` | confirmations, armed states |
| `--c-warn-500` | `#FF9F1C` | gentle problems (toasts) |
| `--c-danger-500` | `#FF4D4D` | destructive actions, last 5 seconds |
| `--c-p1..p4` | `#2FA8FF` `#FF7A45` `#39D98A` `#C77DFF` | player slots |

### Surfaces

The product is played in ONE bright look. The dark blocks exist (structure
rule 5 below) but keep the party look: they only deepen the backdrop with
`--bg-veil` and soften `--bg-pattern`.

| Token | Value |
|---|---|
| canvas (body fallback under the gradient) | `#FF8A3D` |
| surface / surface-2 / surface-3 | `#FFFFFF` / `#FFF6E5` / `#FFE7BF` |
| **game canvas** (`--c-game-bg`) | `#FFF8EC` |
| text / text-2 / text-3 | `#1D1442` / `#4A3F72` / `#6B6390` (16.9 / 9.1 / 5.6 : 1 on white) |

### Hard colour rules

1. **The game canvas ground is one cream in both themes** (`--c-game-bg`,
   mirrored in render/palette.ts): the sprites' ink keyline assumes a light
   ground. The attract reel frame and the `play` phase use the same colour so
   the hand-off to a game never flashes the backdrop.
2. **Amber never carries white text.** `--c-on-accent` is `#3A2600`.
   **White text on a saturated fill always carries the ink outline**
   (`-webkit-text-stroke` + `paint-order: stroke fill`) — that outline, not
   the fill, is what gives it contrast.
3. **`--c-primary-500` is a fill, not a text colour** on light surfaces (~4.0:1).
   Blue *text* uses `--c-primary-600`.
4. **Hue is never the only cue.** Every player-coloured element carries a 3 px
   `--c-p-outline` stroke, a slot number and a shape badge.
5. **No colour may have its only definition inside a media query.** The full
   light palette lives on bare `:root`; dark is applied twice — once under
   `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) }` and
   once under `:root[data-theme="dark"]` — so the in-app toggle wins in both
   directions. **The two dark blocks must stay in sync.**

### Per-game hue

```css
.card { --hue-tint: hsl(var(--hue, 230) 90% 60% / .12); }
.tile { background: linear-gradient(hsl(var(--hue) 95% 72%), hsl(var(--hue) 80% 54%)); }
```
Set `--hue` from `manifest.theme.hue` on the card, tile or screen root. Games
without a declared hue get a stable one hashed from their id, so two cards never
collide by accident.

---

## 3. Typography

```css
--font-ui:      'Pretendard Variable', Pretendard, -apple-system, …
--font-display: var(--font-ui);
--font-num:     var(--font-ui);
```

**One face, self-hosted.** Pretendard Variable (weights 45–920) from
`/fonts/fonts.css`, generated by the build and linked from `index.html`. The
display register is **weight 800–900 plus the outline**, not a second font.
**Never add a CDN `@font-face` or `<link>`** — it breaks the
`connect-src 'self'` CSP that makes the privacy claim auditable.

### The party voice: outlined display text

```css
.display-1, .display-2, .h1, .h2, .outlined {
  color: #fff;
  -webkit-text-stroke: var(--outline-w) var(--c-ink);   /* 0.15em */
  paint-order: stroke fill;                              /* stroke BEHIND the fill */
  text-shadow: var(--outline-drop);                      /* 0 .06em 0 ink + soft drop */
}
.ink { color: var(--c-text); -webkit-text-stroke: 0; text-shadow: none; }
```
`paint-order: stroke fill` is what lets the stroke be thick without eating the
glyph: only the outer half shows, as an outline. Tile names, the command word,
the countdown numbers, HUD goal/announce/combo and `.btn--go` labels all use
the same recipe. Use `.ink` for a plain dark heading inside a white panel.

### Three Korean rules that matter more than the font choice

```css
body { word-break: keep-all; overflow-wrap: anywhere; line-height: 1.55; }
.num, .score, .timer { font-variant-numeric: tabular-nums; }
.display-1 { letter-spacing: -0.03em; }
```
1. **`word-break: keep-all`.** The browser default splits 어절 mid-word and
   Korean copy looks broken. `overflow-wrap: anywhere` is the escape hatch.
2. **`line-height ≥ 1.5` for body.** Hangul needs more leading than Latin.
3. **`tabular-nums` on every counter**, so a score does not jitter as digits change.
   Tighten tracking to `-0.02em` at display sizes; Hangul at 56 px+ looks loose.

### Type scale — 10-foot UI

```css
html { font-size: clamp(16px, 0.55vw + 0.45vh + 9px, 28px); }
html[data-text-size="large"] { font-size: clamp(20px, 0.7vw + 0.6vh + 11px, 34px); }
```

| Token | rem (px @16) | weight | Use |
|---|---|---|---|
| `--fs-display-1` | 6 (96) | 900 | 결과 점수 |
| `--fs-display-2` | 4.5 (72) | 900 | 룰렛 제목, 기록 |
| `--fs-title-1` | 3.5 (56) | 800 | 화면 제목, 게임 이름 slam-in |
| `--fs-title-2` | 2.75 (44) | 800 | START 라벨 |
| `--fs-heading` | 2.125 (34) | 800 | **the 2 m reaction floor**: tile names, command caption, HUD goal |
| `--fs-body-lg` | 1.75 (28) | 500 | default body on game screens |
| `--fs-body` | 1.5 (24) | 500 | **the 2 m reading floor** |
| `--fs-label` | 1.25 (20) | 600 | buttons, chips |
| `--fs-caption` | 1.125 (18) | 500 | setup screens only |
| `--fs-legal` | 1 (16) | 400 | 개인정보 안내 body, read up close |

**Hard rule.** On any screen a child reads while standing, the minimum is 24 px;
instruction text is 28 px; anything they must *react* to is ≥ 34 px / weight 700.
**16–18 px is permitted only on the setup and privacy screens.** Never a thin
weight (100–300) at body size — thin strokes vanish at distance.

On short viewports (`@media (max-height: 52rem)`) only the DISPLAY sizes shrink.
`--fs-heading` and below never move: they are the accessibility floor. Anything
a child reacts to is additionally written `max(34px, …)` so a viewport-relative
size can never take it under the floor.

The old exception (roulette slice labels at 18 px) is gone with the wheel:
roulette tile names are upright and `max(34px, …)` at every size.

---

## 4. Space, radius, depth

```
--sp-1..11   4 8 12 16 24 32 40 48 64 80 120   (4px base, 8pt rhythm above 16)
--r-xs..2xl  8 12 16 24 32 40      --r-pill 999   (kid UI leans BIG radius)
--bw-1 2px   --bw-2 3px   --bw-focus 4px
--hit-min 56px   --hit-primary 72px   --hit-huge 96px
--press-depth 6px
--slab-bw 4px   --slab-edge 6px   --slab-hi inset 0 4px 0 rgb(255 255 255 / .55)
```

44 px is the *adult* minimum; children need more. Nothing interactive ships
below 56 px, the primary action is 72 px, START is 96 px+. Radius is never
below 24 px on anything a child presses or reads.

### The pressable slab

```css
.btn {
  border: var(--slab-bw) solid var(--c-ink);
  box-shadow: var(--slab-hi), 0 var(--press-depth) 0 var(--btn-edge);  /* edge = ink */
}
.btn:active  { transform: translateY(var(--press-depth)); box-shadow: var(--slab-hi), 0 0 0 var(--btn-edge); }
.btn:focus-visible { box-shadow: var(--slab-hi), 0 var(--press-depth) 0 var(--btn-edge), var(--sh-focus); }
```
Ink border, ink bottom edge, a white top highlight, and a 40 ms `ui.click`.
Cards, panels, tiles, the HUD pills and the reel bezel are the same slab.
`--press-depth` goes to `0px` under reduced motion.

Variants: `.btn--go` (the party slab: sun → tangerine, white outlined label —
START, 다시 하기; once per screen), `--primary` (blue, outlined label),
`--accent` (rewards, dark text), `--success`, `--danger`, `--ghost` (white
slab — never transparent: it sits on a backdrop), `--link` (white pill,
underlined). Sizes: `--sm` (56), default (72), `--huge` (96, weight 900).
The START button pulses on the `scale` property (1 → 1.08 over `--t-pulse`
1.2 s), not `transform`, so the pulse and the `:active` press compose.

Every interactive element has `:hover`, `:focus-visible`, `:active` and
`:disabled` states. No hover-only affordances — this product is played at 2 m
with no mouse.

---

## 5. Motion

```
--dur-instant 80ms   --dur-fast 140ms    --dur-base 220ms
--dur-slow 360ms     --dur-slower 560ms  --dur-celebrate 900ms  --dur-wheel 3400ms

--ease-out-quint cubic-bezier(.22,1,.36,1)     default exit
--ease-out-back  cubic-bezier(.34,1.56,.64,1)  pop-in: buttons, stars, badges
--ease-in-out    cubic-bezier(.4,0,.2,1)
--ease-wheel     cubic-bezier(.12,.76,.06,1)   (kept for the canvas mirror)

--t-pulse 1200ms   --t-drift 14s     DOM-only ambience. NOT --dur-*: every
                                     --dur-* token must have a canvas mirror
                                     in engine/motion/tokens.ts (a test checks).
```

Rules: feedback within `--dur-fast`; never animate a child's *wait* longer than
`--dur-slower`; `--ease-out-back` (overshoot spring) on everything that should
feel alive — buttons, stars, badges, tiles, the winner card; everything that
enters does so with scale plus opacity. Nothing cuts, and no screen is ever
completely still (the backdrop drifts, the logo breathes, START pulses).

**The backdrop** is one fixed `.app::before` layer moved only by `transform`
(composited, no repaint): a 96 px dot tile (stripes on the roulette) drifting
exactly one tile per `--t-drift`, so the loop is seamless.

**The roulette** (`components/RouletteBoard.tsx`, schedule in `shell/hops.ts`,
tested in `roulette.test.ts`): the winner is decided first; the highlight then
hops tile to tile, clockwise, never skipping one, for 3 full laps plus the
offset that ends on the winner (24–31 hops on 8 tiles). Intervals grow
geometrically ×4.5 from first to last regular hop, then the last three stretch
×1.5, ×2.2, ×3.0; the whole run is scaled to land at exactly 4000 ms (first hop
≈ 42–50 ms, last ≈ 680 ms). `ui.tick` on every hop. Then 380 ms of silence,
then the pop (1.15×, an 80 ms white flash on that one tile, `fanfare`), then
the winner card flies from its tile to the centre (ease-out-back, 560 ms) and
holds 1.5 s. 건너뛰기 jumps straight to the pop on the same winner.

**The countdown**: 2.4 s intro (icon + name slam-in, the command word, the
demo loop, `whoosh`), then 3 · 2 · 1 at 700 ms each (1.6 → 1 scale with
overshoot, `count.beep` rising), then 시작! + `count.go` for 600 ms.

**Results**: stars 400 ms apart with overshoot and `star.1/2/3`; the score
counts up over 1.2 s; the record banner (crown) and confetti arrive after the
last star. Confetti is 28 CSS pieces for 3 stars or a record.

**Reduced motion is honoured twice**, for the same reason as the dark palette:
the OS preference must work before JS runs, and the in-app
**"화면 효과 줄이기"** toggle must work when the OS preference is off.
Reduced mode: the backdrop stops drifting, no shake, confetti becomes one
static burst, score counters snap, the attract reel becomes a still featured
icon that changes on the same 3 s clock, and the roulette becomes a **450 ms
crossfade** (`.rm-fade`, the one animation exempted from the global 1 ms
clamp — a fade is not vestibular motion) straight to the same winner.

**WCAG 2.3.1**: at most 3 full-viewport flashes per second, flashing region
under 25 % of the viewport, never a saturated red. The engine's `fx.flash()`
enforces it in games; the shell's only flash is the roulette pop (one tile,
once, white). The urgent timer pulses in scale, never in colour.

---

## 6. Accessibility contract

- `<html lang="ko">`, `:focus-visible` rings at 4 px amber plus a 3 px ink
  halo (`--sh-focus`): amber alone vanishes on the yellow/orange backdrop, ink
  alone on an ink slab; together they read on everything.
- Full keyboard navigation. `Space`/`Enter` start a round from the attract
  screen; `Esc` closes an overlay, then pauses.
- `aria-live="assertive"` **only** for the 3·2·1 countdown and for error states
  that change what the player must do. Everything else is `polite`.
- `prefers-contrast: more` **and** an in-app "진하게 보기": gradients off,
  borders thickened, `--c-text-3` folded into `--c-text-2`.
- **"글자 크게"** raises the root clamp ceiling to 34 px.
- 설정 (the gear on attract) holds exactly: 소리, 화면 효과 줄이기, 글자 크게,
  진하게 보기, 개인정보 안내, and 기록 지우기 (two presses). The classroom-era
  rows (별명, 인원, 말로 읽어주기, 자동 넘기기) are gone: a kiosk guest plays
  one round, and nothing in the kiosk flow read the last two.
- While 설정 is open nothing behind it can start a round (Space, Enter and the
  jump are all blocked); focus moves into the dialog; `Esc` closes it.
- Audio is never load-bearing: every voice prompt is mirrored as on-screen
  Korean through `hud.announce()`, every beat cue has a visual pulse ring, and
  there is a master mute.
- No time limits anywhere in the lobby.

---

## 7. Privacy, as a design constraint

Three things on screen are load-bearing promises, not decoration:

1. **`🔴 카메라 켜짐 · [끄기]`** — fixed, always visible while a track is live,
   with a one-press off switch. A camera indicator you cannot find does not count.
2. **The live skeleton in the "나" mirror on attract** (and in the countdown) —
   the honest "the camera sees only this" demonstration, captioned
   "카메라는 점과 선만 봐요. 녹화하지 않아요." Face-mesh points are deliberately
   absent (`POSE_EDGES` omits them): eleven dots on a child's face looks like
   surveillance. Drawn at 1× backing store, ~30 Hz.
3. **개인정보 안내** — inside 설정 (the separate screen is gone).
   `docs/RESEARCH-ARCH.md` §7.2 close to verbatim, at a 초등 3–4학년 reading
   level, because 개인정보보호법 제22조의2 ③ requires it for notices aimed at
   under-14s.

Every claim there is enforced by a build step, not by good intentions:
`connect-src 'self'`, self-hosted fonts/wasm/model, and
`scripts/check-privacy.mjs` grepping `dist/` for `toDataURL`, `toBlob`,
`MediaRecorder` and cross-origin fetch. **Do not print a claim the build does
not enforce.**

`localStorage` is namespaced `mg:` (today's best scores, settings — nothing
else) with a single two-press **전체 삭제**, which also clears the in-memory
records so the next round is not compared against a ghost.

The attract reel runs real games on synthetic pose clips: no camera frame,
landmark or video is involved in it at all.

---

## 8. Writing for this audience

- Misses are **quiet** (break the combo, nothing more). Successes are **loud**.
  Repeated failure indicators make 7-to-12-year-olds quit inside a minute.
- Zero stars reads "다음엔 더 잘할 수 있어요!", never "실패".
- Instructions are imperative and ≤ 3 lines a 2nd-grader can follow.
- `nameKo` ≤ 20 characters; `taglineKo` ≤ 18 wraps best.
- A disabled button is a fight; a visible countdown is a wait. Prefer the
  countdown (see the safety screen).
- Every error screen offers the thing that works *right now* as its first
  button — usually the keyboard. The page must never look frozen or dead-ended.

---

## 9. The class vocabulary

`src/styles/base.css` holds a deliberately short set. Use it before inventing
anything; the whole point is that fifteen screens look like one product.

| Group | Classes |
|---|---|
| type | `.display-1` `.display-2` `.h1` `.h2` `.h3` `.body-lg` `.body` `.label` `.caption` `.legal` `.num` `.dim` `.faint` `.center` `.outlined` `.ink` |
| layout | `.screen` (`--read`, `--full`) `.stack` `.row` `.actions` `.grow` |
| surface | `.card` (`--flat`, `--tinted`) `.panel` `.slab-note` `.chip` (`--live`, `--hint`, `--ok`) `.track > .fill` `.bullets` (`--legal`) `.field` `.overlay > .overlay__panel` |
| action | `.btn` + `--go --primary --accent --success --danger --ghost --link --sm --huge --block` |
| motion | `.pop-in` `.slam-in` `.breathe` `.rm-fade` (the reduced-motion crossfade) |
| a11y | `.sr-only` |

Components live in `src/shell/components/`: `Button`, `Screen`,
`RouletteBoard` (replaced `Wheel`), `GameReel`, `StarRow`, `PlayerChip`,
`CameraChip`, `ProgressRing`, `DwellRing`, `SkeletonPreview`, `Toast`.
Screen-specific blocks in base.css: `.attract__*` `.logo__*` `.me` `.reel*`
`.parade*`, `.board*` `.tile*`, `.cd__*` `.demo--<gesture>`, `.hud__*`,
`.results__*` `.confetti`, `.setup__*`, `.setrow*`.

A legacy block at the end of base.css (`.calib`, `.intro__*`, `.promise*`,
`.move*`, and `.stage-wrap` / `.pause-veil` / `.summary__*` in place) is not
rendered by any component; it is kept until someone removes it on purpose.

---

## 10. Reviewing a screen

1. Stand back 2 m — literally, or shrink the window until the root clamp hits
   16 px. Can you read every instruction? Is the thing you must react to ≥ 34 px?
2. Does any Korean line break mid-어절? (`word-break: keep-all` missing.)
3. Does every counter use `.num`?
4. Toggle `data-theme="light"` and `"dark"` on `<html>`. Both must still be
   the party look; any colour that only exists in one of them is a bug.
   Then check it at 1440×900 (the Mac) and 1280×720.
5. Toggle `data-motion="reduced"`. Does anything still move, spin, or count?
6. Tab through. Is every ring visible at 4 px? Is anything hover-only?
7. Is the smallest hit target ≥ 56 px?
8. If the camera is live, is the 🔴 chip visible on this screen?
