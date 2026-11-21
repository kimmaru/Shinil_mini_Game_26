# NEEDS: a per-game "steady" filter hint for precision aim/trace games

The brief for this batch asks for `ctx.gestures.use('reach', { ... })` tuned
to the `steady` One Euro preset (low `beta`) that `src/engine/pose/oneEuro.ts`
documents: "Aim / trace / hold-pose games: a hand parked on a target must not
wobble." That preset exists in the engine, but there is no hook that lets one
game ask for it: `ReachOpts` exposes only `side`, and the filter is selected
once, globally, inside `PoseNormalizer`, before any per-game code sees a
landmark.

What this game does instead (the honest version without the feature):
- Target radius is 9% of view width, never smaller (the engine floor is 8%).
  Difficulty comes from a shorter hold, moving targets and a bomb decoy, not
  from shrinking.
- A small local `approach()` low-pass (`SMOOTH_RATE`, ~90 ms) on the aim
  point only, never on a scoring edge.
- The dwell gauge drains at 1.2x instead of resetting when the hand slips
  out, and the hit test has a dead zone (enter at r, leave at 1.2 r), so a
  jittery hand on the rim neither strobes nor loses its progress.

Ask for the next wave: something like `ctx.gestures.filterHint('steady' |
'snappy')`, callable once in `init()`, so aim/trace/hold-pose games do not
each re-derive this workaround.
