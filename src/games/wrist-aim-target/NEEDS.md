# NEEDS: a per-game "steady" filter hint for precision aim/trace games

The brief for this batch asks for `ctx.gestures.use('reach', { ... })` tuned
to the `steady` One Euro preset (low `beta`) that `src/engine/pose/oneEuro.ts`
documents: "Aim / trace / hold-pose games: a hand parked on a target must not
wobble." That preset exists in the engine, but there is no hook that lets one
game ask for it.

`ReachOpts` (src/engine/gestures/index.ts) exposes only `side`. The actual
`OneEuroConfig`/`beta` selection happens once, globally, inside
`PoseNormalizer` (src/engine/pose/normalize.ts), before any per-game code ever
sees a landmark — there is nothing on `GameContext`, `Detector<'reach'>`, or
any other game-facing surface that varies it per game. Two games wanting
`steady` and `snappy` at the same time is simply not expressible today.

What I did instead (the honest version without the feature):
- Target radii start at 15% of view width and shrink only to 8.5% — above the
  8%-of-view-width floor the catalogue's own threshold table sets, and well
  above the engine's measured landmark jitter.
- An additional `approach()`-based low-pass (`src/engine/math.ts`) on top of
  the already-filtered `reach.leftPalm`/`rightPalm`, local to this file
  (`SMOOTH_RATE`, ~90ms time constant), used only for the aim point — never
  for a scoring edge or a velocity gate.
- A dead-zone margin on the dwell hit test (shrink-to-enter, grow-to-exit),
  the same trick `ZoneDetector` uses internally, so a hand resting on the rim
  cannot strobe the gauge.

Ask for the next wave: something like `ctx.gestures.filterHint('steady' |
'snappy')`, callable once in `init()`, or a `GameContext`-level pose preset
the shell applies before the round starts — any aim/trace/hold-pose game
after this one will want the same thing and should not have to re-derive this
workaround.
