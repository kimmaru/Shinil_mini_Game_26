# AGENTS.md — read this first, every time

You are working on **몸으로 놀자! 미니게임 파티**: a Korean webcam motion
mini-game party site for elementary schoolers (7–12). Players stand in front of
a laptop camera and play with their body — no controller, no touch, no mouse.

58 mini-games are authored by many agents working in parallel on this one repo.
Everything below exists to make that possible.

## The one rule

**The engine is a frozen contract. Your game folder is yours. Nothing else is.**

`npm run check:frozen` compares a sha256 of every contract file against
`.frozen.json`. If you edit one, the build fails and your whole batch is
rejected. This is not bureaucracy — one engine edit silently changes behaviour
in 20 games written by people who are not in this conversation.

## What you own

```
src/games/<your-id>/
  manifest.ts   data only; imports ONLY @/engine/types
  index.ts      default-exports a MiniGameFactory
  locale.ts     this game's Korean strings (never a shared i18n file)
```

Nothing else. No assets directory — there are no image, audio or font files in
`src/games/**`, by design (see "No assets" below).

## Hard prohibitions

A violation fails `npm run gate` and the batch is rejected without negotiation.

- Do not create, edit, rewrite or **reformat** any file outside your folders.
- Import only from `@/engine/*` and `./*`. `manifest.ts` imports only
  `@/engine/types`.
- No `Math.random()` → use `ctx.rng()`. No `Date.now()` / `performance.now()` →
  use the `dt` and `frame.t` you are given. A round that cannot be reproduced
  from a seed cannot be tested.
- **No allocation in `update()` or `render()`.** Allocate in `init()`. No
  object literals, no array methods that allocate, no template strings in the
  hot path. Pre-allocate `Pt` scratch objects and pass them to `palm()`,
  `jointPx()` etc.
- No raw `CanvasRenderingContext2D`, no `document`, no `window`. The `Renderer`
  interface is the whole drawing vocabulary and has no escape hatch.
- No new sound ids. Only members of `SFX_IDS` (`src/engine/audio/sfx.ts`).
- **Never threshold on raw landmark pixels.** Use normalized units (shoulder
  widths) via `nx()/ny()`, or a rented detector. A pixel threshold makes your
  game unfair to short children and broken at a different camera distance.
- **Never fire a scoring event from a single frame.** Use a rented `Detector`,
  or hysteresis plus a ≥250 ms cooldown of your own.
- Ship `enabled: false` in your manifest. The lead flips it after playing it.

## If you need an engine feature that does not exist

Stop. Do not add it to the engine. Do not work around it with a 300-line local
copy of what the engine should provide.

Write `src/games/<id>/NEEDS.md` saying what signal you need and why, implement
the simplest honest version of the game without it, and say so in your
hand-back. Anything two or more authors ask for becomes an engine service in
the next wave.

## Design constraints that are not negotiable

**Audience.** 7–12 years old, standing ~2 m from the screen, reading Korean.
- Minimum readable size is 24 px; anything a child must *react* to is ≥ 34 px,
  weight 700. Use `g.s` (= min(w,h)/1000) to scale, never hard pixel sizes.
- Misses are **quiet** (break the combo, nothing more). Successes are **loud**.
  Repeated failure indicators make this age group quit within a minute.
- Korean copy: `nameKo` ≤ 20 chars, `taglineKo` ≤ 18 chars reads best,
  `howToKo` is 1–3 imperative lines a 2nd-grader can follow.

**Fairness.** Height, arm length and stamina must not decide the score. Place
targets relative to the player's own calibration (`ctx.profiles`,
`ReachSignal.leftExtend`), not at fixed screen positions, whenever the game is
about reaching, jumping or ducking.

**Safety.** Never require: more than ~10 jumps per round, arms held overhead
for more than ~10 s, spinning, or floor contact. `intensity: 3` means the
scheduler will not serve yours back-to-back with another hard game.

**No assets.** All art is shapes + emoji (`g.emoji('🦟', x, y, size)`), all
audio is synthesized from the closed `SFX_IDS` list. This is why 58 parallel
authors have a merge surface of exactly zero, and why the page has no
third-party requests at all.

**Privacy.** There is no network path out of this app and there must never be
one. Never store or transmit landmark data. `toDataURL`, `toBlob`,
`MediaRecorder` and `fetch` are grep-banned from the production bundle.

## Verify before handing back — all four

```bash
npx tsc --noEmit
npm run gate
npx vitest run src/games/__tests__ -t "<your-id>"
npm run shot -- <your-id>          # look at the PNG; a black image is a bug
```

## Hand back

For each game, one paragraph: what the player does, which detector and
thresholds you used and **why**, what score a competent 9-year-old gets, what
you could not make work, and any `NEEDS.md` you wrote. Do not write a report
file.

## Where to look

| Need | File |
|---|---|
| Types for everything | `src/engine/types.ts` |
| Drawing vocabulary | `src/engine/render/renderer.ts`, `render/palette.ts` |
| Gestures + signals | `src/engine/gestures/index.ts` |
| Joint access, palms | `src/engine/pose/landmarks.ts` |
| Collision, easing, angles | `src/engine/math.ts` |
| Object pools, spawn ramps | `src/engine/entities.ts`, `spawn.ts` |
| Sound ids | `src/engine/audio/sfx.ts` |
| Authoring guide + thresholds | `docs/GAME_AUTHORING.md` |
| Worked references | `src/games/mosquito-clap/`, `candy-rain-catch/`, `wave-jump/` |
| Research (pose stack, catalogue) | `docs/RESEARCH-POSE.md`, `docs/PLAN.md` |
