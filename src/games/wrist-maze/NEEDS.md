# NEEDS: a per-game "steady" filter hint for precision trace games

Same gap as `wrist-aim-target/NEEDS.md`. This game is the batch's filtering
litmus test — docs/GAME_AUTHORING.md's own framing for this wave — and the
genre `src/engine/pose/oneEuro.ts`'s `STEADY` preset is written for: "a hand
parked on a target must not wobble." There is no per-game way to request it;
`ReachOpts` only exposes `side`, and the actual `OneEuroConfig` is selected
once, globally, inside `PoseNormalizer`.

What I did instead:
- Corridor half-width carries a flat 15% collision slack on top of an
  already-generous width (>=10% of view width, floor respected through every
  ramp step) — well clear of measured landmark jitter.
- The same local `approach()`-based low-pass as `wrist-aim-target`
  (`SMOOTH_RATE`, ~90ms time constant) on the aim point used for the
  corridor test, never on the wall-touch edge itself (that's a plain
  distance-vs-half-width compare, so there is nothing to double-fire).

Same ask as the sibling NEEDS.md: a `ctx.gestures.filterHint('steady' |
'snappy')` call in `init()`, or an engine-applied pose preset per game,
would let this kind of game skip the hand-rolled low-pass entirely.
