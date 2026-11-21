# NEEDS: a per-game "steady" filter hint for precision aim games

Same gap as the other two games in this batch
(`wrist-aim-target/NEEDS.md`, `wrist-maze/NEEDS.md`). `ctx.gestures.use('reach',
{ ... })` only exposes `side`; there is no way for one game to ask the pose
pipeline for the `steady` One Euro preset (`src/engine/pose/oneEuro.ts`)
while another keeps the default or `snappy` one — the filter config is
chosen once, globally, inside `PoseNormalizer`.

What I did instead: dot radii at or above the 8%-of-view-width floor, and
the same local `approach()`-based low-pass (`SMOOTH_RATE`, ~90ms time
constant) on the aim point used for the proximity test. The hit test itself
is a single distance-vs-radius compare with no hysteresis needed (advancing
to the next dot is a one-way step, not a toggle), so there is nothing here
that could double-fire even without the extra smoothing — it only exists to
stop the dot ring from strobing visually.

Same ask as the sibling files: a `ctx.gestures.filterHint('steady' |
'snappy')` call in `init()`, or an engine-applied pose preset per game.
