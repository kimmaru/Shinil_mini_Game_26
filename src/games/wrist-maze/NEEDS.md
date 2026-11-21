# NEEDS: a per-game "steady" filter hint for precision trace games

Same gap as `wrist-aim-target/NEEDS.md`. This is the genre
`src/engine/pose/oneEuro.ts`'s `STEADY` preset is written for ("a hand parked
on a target must not wobble"), but `ReachOpts` only exposes `side` and the
filter config is chosen once, globally, inside `PoseNormalizer`.

What this game does instead:
- Corridor width is arm-length based and never under 8.5% of the view width,
  with a flat 12% collision slack on top.
- The same local `approach()` low-pass (`SMOOTH_RATE`, ~90 ms) on the orb
  position, used for the corridor test, never for a scoring edge.
- Leaving the corridor has a 0.3 s grace and then restarts from the last
  checkpoint, so a single jitter spike never costs a run.

Ask for the next wave: `ctx.gestures.filterHint('steady' | 'snappy')` in
`init()`, or an engine-applied pose preset per game.
