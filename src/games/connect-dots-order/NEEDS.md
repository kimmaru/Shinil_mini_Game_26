# NEEDS: a per-game "steady" filter hint for precision aim games

Same gap as the other two games in this batch (`wrist-aim-target/NEEDS.md`,
`wrist-maze/NEEDS.md`). `ctx.gestures.use('reach', { ... })` only exposes
`side`; one game cannot ask the pose pipeline for the `steady` One Euro preset
(`src/engine/pose/oneEuro.ts`) while another keeps the default.

What this game does instead: a hit radius of 5.6% of view width (dots are
drawn at ~4.3%, diameter above the 8% floor), the same local `approach()`
low-pass (`SMOOTH_RATE`, ~90 ms) on the aim point, a 0.25 s touch time per dot
(which also stops an arm-windmill from farming dots) and a 0.3 s lock-out
after each dot.

Same ask as the sibling files: `ctx.gestures.filterHint('steady' | 'snappy')`
in `init()`, or an engine-applied pose preset per game.
